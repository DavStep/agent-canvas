import { describe, expect, it } from 'vitest';
import type { OpenThread } from '../../shared/threads.ts';
import { ThreadStore } from '../threads/store.ts';
import { CANVAS_TOOLS, type CanvasApi } from './tools.ts';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const tiles: OpenThread = {
  id: 'b8fd#1', title: 'Tile Merger events', summary: 'Four event ideas, Stack Race first.',
  question: 'Gate by location or by Coins; bots or real players?', sessionId: 'b8fd', sessionName: 'Canvas agent', provider: 'claude',
  cwd: '/Users/owner/.agent-canvas/agent', folder: 'agent', askedAt: NOW - 26 * HOUR, foundAt: NOW - 25 * HOUR, excerpt: '…', state: 'open',
};

async function fakeApi(withThreads = true) {
  const store = await ThreadStore.load(null, [tiles]);
  const api = {
    snapshot: () => { throw new Error('unused'); },
    applyLayout: () => {},
    startSession: async () => 'x',
    keepAttachments: async () => [],
    findFolders: async () => [],
    folderKind: async () => 'missing' as const,
    openSession: () => {},
    ...(withThreads ? { threads: { list: () => store.list(), apply: (op) => store.apply(op) } } : {}),
    now: () => NOW,
  } as CanvasApi;
  return { api, store };
}

const run = (api: CanvasApi, name: string, args: Record<string, unknown> = {}) => CANVAS_TOOLS.find((t) => t.name === name)!.handler(api, args);

describe('open thread tools', () => {
  it('list_open_threads shows each with its question, project and source', async () => {
    const { api } = await fakeApi();
    const result = await run(api, 'list_open_threads');
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual([{
      id: 'b8fd#1', title: 'Tile Merger events', summary: 'Four event ideas, Stack Race first.', question: 'Gate by location or by Coins; bots or real players?',
      project: '/Users/owner/.agent-canvas/agent', session: { id: 'b8fd', name: 'Canvas agent', provider: 'claude' }, asked: '1d ago',
    }]);
  });

  it('dismiss_open_thread marks one done by default, or dismisses it for good', async () => {
    const { api, store } = await fakeApi();
    expect((await run(api, 'dismiss_open_thread', { id: 'b8fd#1' })).text).toBe('Marked done: Tile Merger events.');
    expect(store.list()).toEqual([]);
    expect(store.all()[0]!.state).toBe('done');

    const again = await fakeApi();
    expect((await run(again.api, 'dismiss_open_thread', { id: 'b8fd#1', reason: 'dismiss' })).text).toBe('Dismissed: Tile Merger events.');
    expect(again.store.add([tiles])).toBe(0);
  });

  it('answers a line for an unknown id, an empty board, or an app without threads', async () => {
    const { api, store } = await fakeApi();
    expect((await run(api, 'dismiss_open_thread', { id: 'nope' })).isError).toBe(true);
    store.apply({ type: 'done', id: 'b8fd#1' });
    expect((await run(api, 'list_open_threads')).text).toBe('No open threads.');
    const bare = await fakeApi(false);
    expect((await run(bare.api, 'list_open_threads')).isError).toBe(true);
  });
});
