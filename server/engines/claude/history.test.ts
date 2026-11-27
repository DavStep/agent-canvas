import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../../../shared/chat.ts';
import { claudeHistory, type HistoryPage } from './history.ts';

const BASIC = path.resolve(import.meta.dirname, '../../../fixtures/claude/history-basic.jsonl');

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-history-'));
  tempDirs.push(dir);
  return path.join(dir, 't.jsonl');
}

/** One exchange as the CLI writes it: a user record, then one assistant record per block. */
function turn(n: number, pad = ''): string {
  const at = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  return [
    { type: 'user', uuid: `u${n}`, timestamp: at, message: { role: 'user', content: `question ${n}` } },
    { type: 'assistant', uuid: `a${n}`, timestamp: at, message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'text', text: `answer ${n}${pad}` }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
}

async function writeTurns(file: string, count: number): Promise<void> {
  let text = '';
  for (let n = 0; n < count; n++) text += turn(n);
  await fs.writeFile(file, text);
}

const byId = (items: ChatItem[], id: string): ChatItem | undefined => items.find((i) => i.id === id);

/** Every page from the newest back to the start, newest first. One `taken` set serves the walk,
    as the engine keeps one per chat. */
async function pages(file: string, limit: number): Promise<HistoryPage[]> {
  const taken = new Set<string>();
  const out = [await claudeHistory(file, { limit, before: null, taken })];
  for (let guard = 0; out.at(-1)!.hasOlder; guard++) {
    if (guard > 10_000) throw new Error('cursor does not move');
    out.push(await claudeHistory(file, { limit, before: out.at(-1)!.cursor, taken }));
  }
  return out;
}

/** Every page from the newest back to the start, joined oldest first. */
async function walk(file: string, limit: number): Promise<ChatItem[]> {
  return (await pages(file, limit)).reverse().flatMap((p) => p.items);
}

/** Counts the bytes claudeHistory reads (it reads through fs.open handles only). */
function spyReads(): { bytes: () => number } {
  let bytesRead = 0;
  const realOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const h = await realOpen(...args);
    const read = h.read.bind(h) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
    h.read = (async (...a: unknown[]) => {
      const r = await read(...a);
      bytesRead += r.bytesRead;
      return r;
    }) as typeof h.read;
    return h;
  });
  vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('whole-file read'));
  return { bytes: () => bytesRead };
}

/** What a test compares: id, kind, text or output, and a tool's status. */
const shape = (i: ChatItem): string[] =>
  i.kind === 'tool' ? [i.kind, i.id, i.status, i.output ?? '<null>']
    : i.kind === 'user' || i.kind === 'assistant' || i.kind === 'reasoning' ? [i.kind, i.id, i.text]
      : [i.kind, i.id];

const rec = (r: object): string => JSON.stringify(r);
const prompt = (id: string, text: string) => rec({ type: 'user', uuid: id, message: { role: 'user', content: text } });
const block = (messageId: string, b: object) => rec({ type: 'assistant', message: { id: messageId, role: 'assistant', content: [b] } });
const call = (messageId: string, id: string, note = '') => block(messageId, { type: 'tool_use', id, name: 'Read', input: { file_path: `/${id}`, note } });
const result = (id: string, content: string) => rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

/** A deterministic random source, so a failing transcript can be regenerated. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Over 1 MB of turns with thinking, split text blocks and parallel calls whose results arrive out of
 * order, multibyte padding everywhere, 600 KB records (longer than two chunks), and no newline after
 * the last record.
 */
function bigTranscript(seed: number): { text: string; expected: string[][] } {
  const random = seeded(seed);
  const int = (n: number) => Math.floor(random() * n);
  const pad = (units: number) => 'é漢😀 '.repeat(units); // 10 bytes a unit, chars of 2, 3 and 4 bytes
  const lines: string[] = [];
  const expected: string[][] = [];
  let bytes = 0;
  const emit = (line: string) => {
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  };
  for (let t = 0; bytes < 1.5 * 1024 * 1024; t++) {
    const ask = `prompt ${t} ${pad(int(600))}`;
    emit(prompt(`u${t}`, ask));
    expected.push(['user', `u${t}`, ask]);
    for (let m = 0, messages = 1 + int(3); m < messages; m++) {
      const id = `msg_${t}_${m}`;
      if (random() < 0.5) {
        const thought = `thought ${t}.${m} ${pad(int(300))}`;
        emit(block(id, { type: 'thinking', thinking: thought, signature: 'c2ln' }));
        expected.push(['reasoning', `${id}:thinking`, thought]);
      }
      const texts = Array.from({ length: 1 + int(2) }, (_, n) => `text ${t}.${m}.${n} ${pad(int(300))}`);
      for (const text of texts) emit(block(id, { type: 'text', text }));
      expected.push(['assistant', id, texts.join('\n\n')]);
      const pending: string[] = [];
      const settle = (toolId: string) => {
        const output = t === 2 && toolId.endsWith('_0') ? `huge ${pad(60_000)}` : `out ${toolId} ${pad(int(300))}`;
        emit(result(toolId, output));
        expected.find((e) => e[1] === toolId)!.splice(3, 1, output);
      };
      for (let n = 0, calls = t === 2 ? 2 : int(4); n < calls; n++) {
        const toolId = `toolu_${t}_${m}_${n}`;
        emit(call(id, toolId));
        expected.push(['tool', toolId, 'done', '']);
        while (pending.length > 0 && random() < 0.4) settle(pending.splice(int(pending.length), 1)[0]!);
        pending.push(toolId);
      }
      while (pending.length > 0) settle(pending.splice(int(pending.length), 1)[0]!);
    }
  }
  return { text: lines.join('\n'), expected };
}

describe('claudeHistory', () => {
  it('user text and images become one user item', async () => {
    const { items } = await claudeHistory(BASIC, { limit: 200, before: null });
    const users = items.filter((i) => i.kind === 'user');
    expect(users).toEqual([{
      kind: 'user', id: expect.any(String), at: Date.UTC(2026, 10, 1, 9, 0, 2), text: 'Make the button blue',
      images: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    }]);
  });

  it('assistant blocks sharing message.id become one assistant item', async () => {
    const { items } = await claudeHistory(BASIC, { limit: 200, before: null });
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      expect.stringMatching(/^user:/),
      'reasoning:msg_demo01:thinking',
      'assistant:msg_demo01',
      'tool:toolu_demo01',
      'tool:toolu_demo02',
      'tool:toolu_demo03',
      'tool:toolu_demo04',
      'assistant:msg_demo05',
    ]);
    expect(byId(items, 'msg_demo05')).toMatchObject({ text: 'Done.\n\nThe button is blue now.', streaming: false });
  });

  it('thinking becomes reasoning', async () => {
    const { items } = await claudeHistory(BASIC, { limit: 200, before: null });
    expect(byId(items, 'msg_demo01:thinking')).toMatchObject({
      kind: 'reasoning', text: 'The button colour lives in styles.css.', streaming: false, durationMs: null,
    });
  });

  it('Bash tool_use + tool_result → command tool with output and exitCode', async () => {
    const { items } = await claudeHistory(BASIC, { limit: 200, before: null });
    expect(byId(items, 'toolu_demo01')).toMatchObject({
      kind: 'tool', tool: 'command', name: 'Bash', target: 'ls src', status: 'done', output: 'App.tsx\nstyles.css', exitCode: 0, diffs: [],
    });
  });

  it('Edit input → edit tool with one FileDiff (+1 −1)', async () => {
    const { items } = await claudeHistory(BASIC, { limit: 200, before: null });
    const edit = byId(items, 'toolu_demo02');
    expect(edit).toMatchObject({ kind: 'tool', tool: 'edit', name: 'Edit', target: '/work/demo/src/styles.css', status: 'done' });
    if (edit?.kind !== 'tool') throw new Error('not a tool');
    expect(edit.diffs).toHaveLength(1);
    expect(edit.diffs[0]).toMatchObject({ path: '/work/demo/src/styles.css', added: 1, removed: 1 });
    expect(edit.diffs[0]?.unified).toContain('-  color: red;');
    expect(edit.diffs[0]?.unified).toContain('+  color: blue;');
  });

  it('Write of a new file → diff of all lines added', async () => {
    const { items } = await claudeHistory(BASIC, { limit: 200, before: null });
    const write = byId(items, 'toolu_demo03');
    if (write?.kind !== 'tool') throw new Error('not a tool');
    expect(write.tool).toBe('edit');
    expect(write.diffs).toEqual([expect.objectContaining({ path: '/work/demo/src/theme.ts', added: 2, removed: 0 })]);
  });

  it('is_error tool_result → status failed', async () => {
    const { items } = await claudeHistory(BASIC, { limit: 200, before: null });
    expect(byId(items, 'toolu_demo04')).toMatchObject({
      status: 'failed', exitCode: 1, output: 'Exit code 1\nFAIL src/App.test.tsx',
    });
  });

  it('sidechain (subagent) records are skipped', async () => {
    const { items } = await claudeHistory(BASIC, { limit: 200, before: null });
    expect(byId(items, 'msg_side01')).toBeUndefined();
    expect(items.some((i) => i.kind === 'user' && i.text === 'Subagent prompt')).toBe(false);
  });

  it('limit 200 returns the last 200 items and hasOlder true', async () => {
    const file = await tempFile();
    await writeTurns(file, 300); // 600 items
    const page = await claudeHistory(file, { limit: 200, before: null });
    expect(page.items).toHaveLength(200);
    expect(page.items[0]).toMatchObject({ kind: 'user', text: 'question 200' });
    expect(page.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'answer 299' });
    expect(page.hasOlder).toBe(true);
    expect(page.cursor).toBe(String(Buffer.byteLength(Array.from({ length: 200 }, (_, n) => turn(n)).join(''))));
  });

  it('pages backwards from the cursor until the start', async () => {
    const file = await tempFile();
    await writeTurns(file, 300);
    const first = await claudeHistory(file, { limit: 200, before: null });
    const second = await claudeHistory(file, { limit: 200, before: first.cursor });
    expect(second.items[0]).toMatchObject({ text: 'question 100' });
    expect(second.items.at(-1)).toMatchObject({ text: 'answer 199' });
    expect(second.hasOlder).toBe(true);
    const third = await claudeHistory(file, { limit: 200, before: second.cursor });
    expect(third.items).toHaveLength(200);
    expect(third.items[0]).toMatchObject({ text: 'question 0' });
    expect(third.hasOlder).toBe(false);
  });

  it('a page never splits a tool call from its result', async () => {
    const file = await tempFile();
    const rec = (r: object) => JSON.stringify(r) + '\n';
    const call = (id: string) => rec({ type: 'assistant', message: { id: 'msg_par', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/${id}` } }] } });
    const res = (id: string) => rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `body of ${id}` }] } });
    await fs.writeFile(file, rec({ type: 'user', message: { content: 'go' } }) + call('t1') + call('t2') + res('t1') + res('t2'));
    const page = await claudeHistory(file, { limit: 1, before: null });
    expect(page.items.map((i) => i.id)).toEqual(['t1', 't2']);
    expect(page.items.map((i) => i.kind === 'tool' && i.output)).toEqual(['body of t1', 'body of t2']);
    const older = await claudeHistory(file, { limit: 1, before: page.cursor });
    expect(older.items).toEqual([expect.objectContaining({ kind: 'user', text: 'go' })]);
    expect(older.hasOlder).toBe(false);
  });

  it('a result whose call is before the window stays with its call', async () => {
    // [T1][T2][r2][T3][r1][r3], with the first 256 KB window starting inside T1.
    const tail = (r1Pad: number) => [call('msg_par', 't2'), result('t2', 'body 2'), call('msg_par', 't3'),
      result('t1', `body 1 ${'x'.repeat(r1Pad)}`), result('t3', 'body 3')].map((l) => `${l}\n`).join('');
    const r1Pad = 256 * 1024 - 2000 - Buffer.byteLength(tail(0));
    const file = await tempFile();
    await fs.writeFile(file, `${prompt('u0', 'go')}\n${call('msg_par', 't1', 'n'.repeat(4000))}\n${tail(r1Pad)}`);
    expect((await fs.stat(file)).size - 256 * 1024).toBeGreaterThan(Buffer.byteLength(`${prompt('u0', 'go')}\n`));

    for (const limit of [1, 2, 3]) {
      const items = await walk(file, limit);
      expect(items.map(shape)).toEqual([
        ['user', 'u0', 'go'],
        ['tool', 't1', 'done', `body 1 ${'x'.repeat(r1Pad)}`],
        ['tool', 't2', 'done', 'body 2'],
        ['tool', 't3', 'done', 'body 3'],
      ]);
    }
  });

  it('pages through a multi-chunk transcript with nothing lost or repeated', { timeout: 30_000 }, async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { text, expected } = bigTranscript(seed);
      expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
      expect(text.endsWith('\n')).toBe(false);
      const file = await tempFile();
      await fs.writeFile(file, text);
      // Limits near a 256 KB window's item count put cuts near the window start, where orphans sit.
      for (const limit of [1, 7, 25, 40, 60, 200]) {
        expect((await walk(file, limit)).map(shape), `seed ${seed}, limit ${limit}`).toEqual(expected);
      }
    }
  });

  it('a call whose result comes 2.5 MB later gives a short page, then one page holding it whole', async () => {
    const pad = 'é漢😀 '.repeat(1000);
    const lines = [prompt('u0', 'go'), call('msg_0', 't0')];
    const expected = [['user', 'u0', 'go'], ['tool', 't0', 'done', 'late']];
    for (let n = 1; n <= 250; n++) {
      lines.push(call(`msg_${n}`, `t${n}`), result(`t${n}`, `${n} ${pad}`));
      expected.push(['tool', `t${n}`, 'done', `${n} ${pad}`]);
    }
    lines.push(result('t0', 'late'), prompt('u1', 'after'), block('msg_z', { type: 'text', text: 'ok' }));
    expected.push(['user', 'u1', 'after'], ['assistant', 'msg_z', 'ok']);
    const file = await tempFile();
    await fs.writeFile(file, lines.join('\n'));

    const first = await claudeHistory(file, { limit: 5, before: null });
    expect(first.items.map(shape)).toEqual(expected.slice(-2)); // nothing older can be cut before t0
    expect(first.hasOlder).toBe(true);
    expect((await walk(file, 5)).map(shape)).toEqual(expected);
  });

  it('a tool_result with no call anywhere does not make an older page read past 8 MB', { timeout: 60_000 }, async () => {
    const pad = ' lorem ipsum'.repeat(80);
    // Byte count kept as it grows: measuring the whole string each turn made building it the slow part.
    let text = '';
    for (let n = 0, bytes = 0; bytes < 10 * 1024 * 1024; n++) {
      const t = turn(n, pad);
      text += t;
      bytes += Buffer.byteLength(t);
    }
    text += `${result('t-orphan', 'from nowhere')}\n${prompt('u-last', 'last')}\n${block('msg_last', { type: 'text', text: 'bye' })}\n`;
    const file = await tempFile();
    await fs.writeFile(file, text);

    const first = await claudeHistory(file, { limit: 5, before: null });
    expect(first.items.map(shape)).toEqual([['user', 'u-last', 'last'], ['assistant', 'msg_last', 'bye']]);
    const reads = spyReads();
    const older = await claudeHistory(file, { limit: 5, before: first.cursor });
    expect(older.items.length).toBeGreaterThanOrEqual(5);
    expect(older.hasOlder).toBe(true);
    // Orphan taint holds up to 8 MB (a call that far back still gets its result), then lets go.
    expect(reads.bytes()).toBeGreaterThan(2.5 * 1024 * 1024);
    expect(reads.bytes()).toBeLessThanOrEqual(8 * 1024 * 1024 + 256 * 1024);
  });

  it('nothing older that yields an item → hasOlder false (no empty page later)', async () => {
    const file = await tempFile();
    const summary = rec({ type: 'summary', summary: 's'.repeat(300 * 1024), leafUuid: 'x' });
    let text = `${summary}\n`;
    for (let n = 0; n < 4; n++) text += turn(n);
    await fs.writeFile(file, text);
    const page = await claudeHistory(file, { limit: 8, before: null });
    expect(page.items).toHaveLength(8);
    expect(page.hasOlder).toBe(false);
    for (const limit of [1, 3, 8]) {
      const walked = await pages(file, limit);
      expect(walked.every((p) => p.items.length > 0), `limit ${limit}`).toBe(true);
      expect(walked.flatMap((p) => p.items)).toHaveLength(8);
    }
  });

  describe('records re-appended with the same uuid', () => {
    const r = (uuid: string, body: object) => rec({ uuid, ...body });
    /** A turn whose every record has a uuid: prompt, a call, its result, an answer. */
    const fullTurn = (n: number, pad = ''): string[] => [
      r(`u${n}`, { type: 'user', message: { role: 'user', content: `question ${n}${pad}` } }),
      r(`c${n}`, { type: 'assistant', message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: `/f${n}` } }] } }),
      r(`r${n}`, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: `body ${n}` }] } }),
      r(`a${n}`, { type: 'assistant', message: { id: `msg_${n}b`, role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] } }),
    ];
    const expectedTurn = (n: number, pad = ''): string[][] => [
      ['user', `u${n}`, `question ${n}${pad}`], ['tool', `t${n}`, 'done', `body ${n}`], ['assistant', `msg_${n}b`, `answer ${n}`],
    ];

    it('within one page the first copy is kept', async () => {
      const file = await tempFile();
      const original = [...fullTurn(0), ...fullTurn(1)];
      await fs.writeFile(file, [...original, ...original, ...fullTurn(2)].join('\n'));
      const { items, hasOlder } = await claudeHistory(file, { limit: 200, before: null });
      expect(items.map(shape)).toEqual([...expectedTurn(0), ...expectedTurn(1), ...expectedTurn(2)]);
      expect(hasOlder).toBe(false);
    });

    it('across pages nothing is lost or repeated', { timeout: 30_000 }, async () => {
      const pad = ' lorem ipsum'.repeat(200);
      const lines: string[] = [];
      const expected: string[][] = [];
      // 40 turns, 120 newer turns (about 1 MB), the first 40 again, then 10 more.
      for (let n = 0; n < 160; n++) {
        lines.push(...fullTurn(n, pad));
        expected.push(...expectedTurn(n, pad));
      }
      for (let n = 0; n < 40; n++) lines.push(...fullTurn(n, pad));
      for (let n = 160; n < 170; n++) {
        lines.push(...fullTurn(n, pad));
        expected.push(...expectedTurn(n, pad));
      }
      const file = await tempFile();
      await fs.writeFile(file, lines.join('\n'));
      const sorted = (rows: string[][]) => rows.map((row) => JSON.stringify(row)).sort();
      for (const limit of [1, 7, 50, 200]) {
        const items = await walk(file, limit);
        const ids = items.map((i) => i.id);
        expect(new Set(ids).size, `limit ${limit}: repeated ids`).toBe(ids.length);
        expect(sorted(items.map(shape)), `limit ${limit}`).toEqual(sorted(expected));
      }
    });
  });

  it('a 150 MB transcript opens reading at most 2 MB', { timeout: 60_000 }, async () => {
    const file = await tempFile();
    const handle = await fs.open(file, 'w');
    const pad = ' lorem ipsum'.repeat(80);
    let n = 0;
    try {
      while ((await handle.stat()).size < 150 * 1024 * 1024) {
        let chunk = '';
        for (let i = 0; i < 2000; i++) chunk += turn(n++, pad);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }

    const reads = spyReads();
    const started = performance.now();
    const page = await claudeHistory(file, { limit: 200, before: null });
    const elapsed = performance.now() - started;
    expect(page.items).toHaveLength(200);
    expect(page.items.at(-1)).toMatchObject({ text: `answer ${n - 1}${pad}` });
    expect(page.hasOlder).toBe(true);
    expect(reads.bytes()).toBeGreaterThan(0);
    expect(reads.bytes()).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(elapsed).toBeLessThan(1000);
  });
});
