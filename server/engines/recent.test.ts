import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recentClaude, shortName } from './recent.ts';

const id = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (r: Record<string, unknown>) => JSON.stringify(r);
const prompt = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', cwd: '/work/alpha', timestamp: '2026-11-01T09:00:00.000Z', message: { role: 'user', content: text }, ...extra });

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function projects(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-recent-'));
  homes.push(dir);
  return dir;
}

async function transcript(dir: string, folder: string, name: string, lines: string[], mtimeS?: number): Promise<string> {
  await fs.mkdir(path.join(dir, folder), { recursive: true });
  const file = path.join(dir, folder, name);
  await fs.writeFile(file, lines.join('\n') + '\n');
  if (mtimeS !== undefined) await fs.utimes(file, mtimeS, mtimeS);
  return file;
}

describe('recentClaude', () => {
  it('40 most recently modified transcripts across project folders', async () => {
    const dir = await projects();
    for (let n = 1; n <= 45; n++) {
      await transcript(dir, n % 2 ? '-work-alpha' : '-work-beta', `${id(n)}.jsonl`, [prompt(`Task ${n}`)], 1_790_000_000 + n);
    }
    const recent = await recentClaude(dir);
    expect(recent).toHaveLength(40);
    expect(recent[0]).toMatchObject({ id: id(45), cwd: '/work/alpha', name: 'Task 45', lastActive: (1_790_000_000 + 45) * 1000 });
    expect(recent.map((r) => r.id)).toEqual(Array.from({ length: 40 }, (_, i) => id(45 - i)));
    expect(await recentClaude(dir, 3)).toHaveLength(3);
  });

  it('subagent transcripts excluded', async () => {
    const dir = await projects();
    await transcript(dir, '-work-alpha', `${id(1)}.jsonl`, [prompt('Main session')], 1_790_000_001);
    await transcript(dir, path.join('-work-alpha', id(1), 'subagents'), 'agent-a1b2.jsonl', [prompt('Sub task', { isSidechain: true })], 1_790_000_009);
    await transcript(dir, '-work-alpha', 'agent-c3d4.jsonl', [prompt('Old-style sub task', { isSidechain: true })], 1_790_000_008);
    await transcript(dir, '-work-alpha', `${id(2)}.jsonl`, [prompt('Sidechain only', { isSidechain: true })], 1_790_000_007);
    expect((await recentClaude(dir)).map((r) => r.id)).toEqual([id(1)]);
  });

  it('name from custom-title / summary record else first prompt, cut at 60 chars on a word', async () => {
    const dir = await projects();
    const long = 'Please look into why the reconnect dialog flickers whenever the socket drops briefly';
    await transcript(dir, '-work-alpha', `${id(1)}.jsonl`, [
      line({ type: 'summary', summary: 'Reconnect flicker investigation', leafUuid: 'x' }), prompt('first'),
      line({ type: 'custom-title', customTitle: 'Old title', sessionId: id(1) }),
      line({ type: 'custom-title', customTitle: 'Reconnect dialog', sessionId: id(1) }),
    ], 1_790_000_004);
    await transcript(dir, '-work-alpha', `${id(2)}.jsonl`, [line({ type: 'summary', summary: 'Purchases in production', leafUuid: 'y' }), prompt('first')], 1_790_000_003);
    await transcript(dir, '-work-alpha', `${id(3)}.jsonl`, [
      prompt('Caveat: generated while running local commands', { isMeta: true }),
      prompt('<command-name>/clear</command-name>'),
      line({ type: 'user', cwd: '/work/alpha', message: { role: 'user', content: [{ type: 'text', text: `${long}\nand more` }] } }),
    ], 1_790_000_002);
    await transcript(dir, '-work-alpha', `${id(4)}.jsonl`, [prompt('x'.repeat(80))], 1_790_000_001);
    const names = Object.fromEntries((await recentClaude(dir)).map((r) => [r.id, r.name]));
    expect(names[id(1)]).toBe('Reconnect dialog');
    expect(names[id(2)]).toBe('Purchases in production');
    expect(names[id(3)]).toBe('Please look into why the reconnect dialog flickers…');
    expect(names[id(3)]!.length).toBeLessThanOrEqual(60);
    expect(names[id(4)]).toBe(`${'x'.repeat(59)}…`);
  });

  it('reads at most 64 KB from each file', async () => {
    const dir = await projects();
    const filler = (n: number) => Array.from({ length: n }, (_, i) =>
      line({ type: 'assistant', cwd: '/work/alpha', message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(400) }] } }));
    // A title buried in the middle of a 1 MB transcript is never seen: only its head and tail are read.
    const file = await transcript(dir, '-work-alpha', `${id(1)}.jsonl`, [
      prompt('The first prompt'), ...filler(1200), line({ type: 'custom-title', customTitle: 'Buried', sessionId: id(1) }), ...filler(1200),
      line({ type: 'assistant', cwd: '/work/alpha', gitBranch: 'feat/x', message: { id: 'last', role: 'assistant', model: 'claude-demo', content: [] } }),
    ]);
    expect((await fs.stat(file)).size).toBeGreaterThan(1_000_000);
    let bytes = 0;
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const out = await read(...a);
        bytes += out.bytesRead;
        return out;
      };
      return handle;
    });
    const [recent] = await recentClaude(dir);
    expect(recent).toMatchObject({ id: id(1), name: 'The first prompt', cwd: '/work/alpha', branch: 'feat/x', model: 'claude-demo' });
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('shortName', () => {
  it('names a session by its words, not the files attached to its prompt', () => {
    expect(shortName('@"/Users/me/Quarterly report.pdf"\n\nSummarise this report')).toBe('Summarise this report');
    expect(shortName('@"/Users/me/Quarterly report.pdf"')).toBe('Quarterly report.pdf');
  });
});
