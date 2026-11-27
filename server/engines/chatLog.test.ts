import { describe, expect, it } from 'vitest';
import type { ChatItem, ChatState } from '../../shared/chat.ts';
import { applyUpdate, MAX_OUTPUT, TRIMMED } from './chatLog.ts';

const state = (items: ChatItem[] = []): ChatState => ({
  sessionId: 's1', provider: 'claude', owner: 'here', title: 'T', cwd: '/w',
  items, hasOlder: false, turn: 'idle', model: null, models: [], mode: 'default', modes: [], banner: null,
});
const assistant = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, at: 1, text, streaming: true });
const tool = (id: string, output: string | null): ChatItem => ({
  kind: 'tool', id, at: 1, tool: 'command', name: 'Bash', target: 'ls', status: 'running', output, exitCode: null, diffs: [],
});

describe('applyUpdate', () => {
  it('upsert replaces by id and keeps order', () => {
    let s = state([assistant('a', 'one'), assistant('b', 'two')]);
    s = applyUpdate(s, { op: 'upsert', item: assistant('a', 'ONE') });
    s = applyUpdate(s, { op: 'upsert', item: assistant('c', 'three') });
    expect(s.items.map((i) => [i.id, i.kind === 'assistant' ? i.text : null])).toEqual([
      ['a', 'ONE'], ['b', 'two'], ['c', 'three'],
    ]);
  });

  it('append adds to text of assistant and to output of tool', () => {
    let s = state([assistant('a', 'Hel'), tool('t', null)]);
    s = applyUpdate(s, { op: 'append', id: 'a', field: 'text', chunk: 'lo' });
    s = applyUpdate(s, { op: 'append', id: 't', field: 'output', chunk: 'out' });
    s = applyUpdate(s, { op: 'append', id: 't', field: 'output', chunk: 'put' });
    expect(s.items[0]).toMatchObject({ text: 'Hello' });
    expect(s.items[1]).toMatchObject({ output: 'output' });
  });

  it('append to an unknown id is ignored', () => {
    const s = state([assistant('a', 'x')]);
    expect(applyUpdate(s, { op: 'append', id: 'nope', field: 'text', chunk: 'y' })).toEqual(s);
  });

  it('older prepends and sets hasOlder', () => {
    const s = applyUpdate({ ...state([assistant('c', '3')]), hasOlder: true }, {
      op: 'older', items: [assistant('a', '1'), assistant('b', '2')], hasOlder: false,
    });
    expect(s.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(s.hasOlder).toBe(false);
  });

  it('command output keeps only its last 256 KB, after a marker, however many chunks arrive', () => {
    expect(MAX_OUTPUT).toBe(256 * 1024);
    let s = state([tool('t', null)]);
    const line = `${'x'.repeat(1023)}\n`;
    for (let n = 0; n < 300; n++) s = applyUpdate(s, { op: 'append', id: 't', field: 'output', chunk: `${line.slice(0, -5)}${String(n).padStart(4, '0')}\n` });
    const out = (s.items[0] as Extract<ChatItem, { kind: 'tool' }>).output!;
    expect(out.startsWith(TRIMMED)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(TRIMMED.length + MAX_OUTPUT);
    expect(out.endsWith('0299\n')).toBe(true);
    // One marker only, and the kept part starts at a line.
    expect(out.split(TRIMMED)).toHaveLength(2);
    expect(out.slice(TRIMMED.length, TRIMMED.length + 1)).toBe('x');
  });

  it('the cap counts what it drops: outputDropped + the kept part is every character streamed', () => {
    let s = state([tool('t', null)]);
    let streamed = 0;
    for (let n = 0; n < 700; n++) {
      const chunk = `${'z'.repeat(n % 7 === 0 ? 3000 : 997)}\n`;
      streamed += chunk.length;
      s = applyUpdate(s, { op: 'append', id: 't', field: 'output', chunk });
      const t = s.items[0] as Extract<ChatItem, { kind: 'tool' }>;
      const kept = t.output!.startsWith(TRIMMED) ? t.output!.length - TRIMMED.length : t.output!.length;
      expect((t.outputDropped ?? 0) + kept).toBe(streamed);
    }
    expect((s.items[0] as Extract<ChatItem, { kind: 'tool' }>).outputDropped).toBeGreaterThan(0);
    // A status change keeps the count with the output it describes.
    const t = s.items[0] as Extract<ChatItem, { kind: 'tool' }>;
    s = applyUpdate(s, { op: 'upsert', item: { ...t, status: 'done' } });
    expect(s.items[0]).toMatchObject({ outputDropped: t.outputDropped, output: t.output });
  });

  it('an output replaced by an upsert counts only its own drops, not those of the output it replaced', () => {
    let s = state([tool('t', null)]);
    for (let n = 0; n < 400; n++) s = applyUpdate(s, { op: 'append', id: 't', field: 'output', chunk: `${'z'.repeat(1023)}\n` });
    const streamed = s.items[0] as Extract<ChatItem, { kind: 'tool' }>;
    expect(streamed.outputDropped).toBeGreaterThan(100_000);
    // Rebuilt from the streamed item with a new output (as Claude's settleTool spreads it): the old count goes.
    const settled = applyUpdate(s, { op: 'upsert', item: { ...streamed, status: 'done', output: 'final result\n' } });
    expect(settled.items[0]).toMatchObject({ output: 'final result\n' });
    expect(settled.items[0]).not.toHaveProperty('outputDropped');
    // A huge final output over it counts only what its own cap drops.
    const big = applyUpdate(s, { op: 'upsert', item: { ...streamed, status: 'done', output: 'y'.repeat(MAX_OUTPUT + 10) } });
    expect(big.items[0]).toMatchObject({ outputDropped: 10 });
    // The same output with only a status change keeps its count.
    const done = applyUpdate(s, { op: 'upsert', item: { ...streamed, status: 'done' } });
    expect(done.items[0]).toMatchObject({ outputDropped: streamed.outputDropped });
  });

  it('a tool upserted with a huge output is capped the same way', () => {
    const big = 'y'.repeat(MAX_OUTPUT + 10);
    const s = applyUpdate(state(), { op: 'upsert', item: tool('t', big) });
    const out = (s.items[0] as Extract<ChatItem, { kind: 'tool' }>).output!;
    expect(out.startsWith(TRIMMED)).toBe(true);
    expect(out.length).toBe(TRIMMED.length + MAX_OUTPUT);
    expect(s.items[0]).toMatchObject({ outputDropped: 10 });
  });

  it('unchanged items keep their identity across upsert and append (so memoised rows skip them)', () => {
    const a = assistant('a', 'one');
    const t = tool('t', 'out');
    let s = state([a, t]);
    s = applyUpdate(s, { op: 'append', id: 't', field: 'output', chunk: 'put' });
    expect(s.items[0]).toBe(a);
    s = applyUpdate(s, { op: 'upsert', item: assistant('b', 'two') });
    expect(s.items[0]).toBe(a);
    s = applyUpdate(s, { op: 'append', id: 'b', field: 'text', chunk: '!' });
    expect(s.items[0]).toBe(a);
    expect(s.items[1]).toBe(s.items[1]);
  });

  it('meta never touches items', () => {
    const items = [assistant('a', '1')];
    const patch = { turn: 'running', items: [] } as unknown as Partial<Omit<ChatState, 'items'>>;
    const s = applyUpdate(state(items), { op: 'meta', patch });
    expect(s.turn).toBe('running');
    expect(s.items).toEqual(items);
  });
});
