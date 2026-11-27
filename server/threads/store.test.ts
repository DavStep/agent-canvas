import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenThread } from '../../shared/threads.ts';
import { ThreadStore } from './store.ts';

const thread = (id: string, askedAt: number, extra: Partial<OpenThread> = {}): OpenThread => ({
  id,
  title: `Thread ${id}`,
  summary: 'What was discussed.',
  question: 'Which one?',
  sessionId: 'session-1',
  sessionName: 'A chat',
  provider: 'claude',
  cwd: '/Users/owner/project',
  folder: 'project',
  askedAt,
  foundAt: askedAt + 1,
  excerpt: 'Which one?',
  state: 'open',
  ...extra,
});

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'threads-store-'));
  file = path.join(dir, 'openThreads.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ThreadStore', () => {
  it('lists open threads newest question first, and tells listeners', async () => {
    const store = await ThreadStore.load(file);
    let changes = 0;
    store.onChange(() => { changes++; });
    expect(store.add([thread('a', 1), thread('b', 3), thread('c', 2)])).toBe(3);
    expect(store.list().map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(store.add([thread('a', 1)])).toBe(0);
    expect(changes).toBe(1);
  });

  it('keeps everything across a restart', async () => {
    const store = await ThreadStore.load(file);
    store.add([thread('a', 1), thread('b', 2)]);
    store.apply({ type: 'dismiss', id: 'a' });
    store.noteJudged('x', false, 5);
    store.setCursor('session-1', { mtimeMs: 10, size: 20 });
    await store.flush();

    const again = await ThreadStore.load(file);
    expect(again.list().map((t) => t.id)).toEqual(['b']);
    expect(again.judgement('x')).toEqual({ open: false, at: 5 });
    expect(again.cursor('session-1')).toEqual({ mtimeMs: 10, size: 20 });
  });

  it('never makes a dismissed thread again, even after a restart', async () => {
    const store = await ThreadStore.load(file);
    store.add([thread('a', 1)]);
    store.apply({ type: 'dismiss', id: 'a' });
    await store.flush();
    const again = await ThreadStore.load(file);
    expect(again.known('a')).toBe(true);
    expect(again.add([thread('a', 1)])).toBe(0);
    expect(again.list()).toEqual([]);
  });

  it('undoes a dismissal, and a done thread leaves the list but stays known', async () => {
    const store = await ThreadStore.load(file);
    store.add([thread('a', 1), thread('b', 2)]);
    expect(store.apply({ type: 'dismiss', id: 'a' })).toBe(true);
    expect(store.apply({ type: 'dismiss', id: 'a' })).toBe(false);
    expect(store.apply({ type: 'restore', id: 'a' })).toBe(true);
    expect(store.list().map((t) => t.id)).toEqual(['b', 'a']);

    expect(store.markDone('b')).toBe(true);
    expect(store.list().map((t) => t.id)).toEqual(['a']);
    expect(store.known('b')).toBe(true);
    expect(store.all().find((t) => t.id === 'b')?.state).toBe('done');
    // Undo of done brings it back too.
    expect(store.apply({ type: 'restore', id: 'b' })).toBe(true);
    expect(store.list().map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('ignores an op for a thread it does not keep', async () => {
    const store = await ThreadStore.load(file);
    expect(store.apply({ type: 'done', id: 'nope' })).toBe(false);
  });

  it('starts empty over a file it cannot read', async () => {
    await fs.writeFile(file, '{"version": 9}');
    const store = await ThreadStore.load(file);
    expect(store.all()).toEqual([]);
  });

  it('lives in memory without a file, seeded', async () => {
    const store = await ThreadStore.load(null, [thread('demo', 1)]);
    expect(store.list().map((t) => t.id)).toEqual(['demo']);
    store.apply({ type: 'dismiss', id: 'demo' });
    await store.flush();
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
