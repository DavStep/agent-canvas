// The canvas agent's link tools over a real run store in memory: link_sessions, unlink_sessions,
// set_max_running, start_task with `after`, and what canvas_overview and read_session say.
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionView, Snapshot } from '../../shared/types.ts';
import { ensureFolderZones } from '../layoutOps.ts';
import type { RunsApi } from '../runs/api.ts';
import { evaluate } from '../runs/evaluate.ts';
import { RunStore } from '../runs/store.ts';
import { CANVAS_TOOLS, type CanvasApi, type TaskRequest } from './tools.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const CWD = '/Users/me/Documents/garden-sim';

function session(id: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id, provider: 'claude', hostId: null, name: `Session ${id}`, cwd: CWD, folder: 'garden-sim', state: 'idle', need: null, activity: null,
    rawStatus: 'idle', stateSince: NOW - 5 * MIN, startedAt: NOW - 60 * MIN, branch: 'main', model: 'claude-demo', lastPrompt: null, lastAnswer: null,
    subagents: [], owner: 'nobody', ownerNote: null, host: null, ...patch,
  };
}

let store: RunStore;
let sessions: SessionView[];
let started: TaskRequest[];
let api: CanvasApi;

beforeEach(async () => {
  store = await RunStore.load(null, () => NOW);
  sessions = [session('a', { state: 'working', activity: 'Editing' }), session('b'), session('c')];
  started = [];
  const views = () => evaluate({ runs: store.runs(), sessions, maxRunning: store.maxRunning(), now: NOW }).views;
  const runs: RunsApi = { views, maxRunning: () => store.maxRunning(), apply: (op, by) => store.apply(op, by), queue: (d) => store.queue(d) };
  const layout = ensureFolderZones({ version: 1, zones: [], assignments: {} }, ['garden-sim']);
  api = {
    snapshot: (): Snapshot => ({ generatedAt: NOW, demo: false, sessions, layout, banners: { claude: null, codex: null }, runs: views(), maxRunning: { ...store.maxRunning() } }),
    applyLayout: () => {},
    startSession: async (req) => { started.push(req); return `new-${started.length}`; },
    findFolders: async () => [],
    folderKind: async (p) => (p === CWD ? 'dir' : 'missing'),
    openSession: () => {},
    keepAttachments: async () => [],
    runs,
    now: () => NOW,
  };
});

const call = (name: string, args: Record<string, unknown> = {}) => {
  const tool = CANVAS_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.handler(api, args);
};

describe('link_sessions', () => {
  it('makes a session wait for another with a queued prompt, and the overview lists it', async () => {
    const res = await call('link_sessions', { to: 'b', after: ['a'], prompt: 'Install the app' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('"Session b" now waits for "Session a"');
    expect(store.runs()).toHaveLength(1);
    expect(store.runs()[0]).toMatchObject({ target: { kind: 'session', id: 'b' }, after: ['a'], prompt: 'Install the app', by: 'agent', state: 'waiting' });

    const overview = JSON.parse((await call('canvas_overview')).text);
    expect(overview.queue).toEqual([expect.objectContaining({ waits: { session: 'b', name: '"Session b"' }, for: [{ id: 'a', state: 'working' }], status: 'waiting', prompt: 'Install the app' })]);
  });

  it('refuses an unknown session, a missing prompt and a loop', async () => {
    expect((await call('link_sessions', { to: 'b', after: ['nope'], prompt: 'x' })).text).toContain('No session has the id nope');
    expect((await call('link_sessions', { to: 'b', after: ['a'] })).isError).toBe(true);
    await call('link_sessions', { to: 'b', after: ['a'], prompt: 'next' });
    const loop = await call('link_sessions', { to: 'a', after: ['b'], prompt: 'back' });
    expect(loop.isError).toBe(true);
    expect(store.runs()).toHaveLength(1);
  });

  it('linking the same session again adds to what it waits for', async () => {
    await call('link_sessions', { to: 'c', after: ['a'], prompt: 'Merge' });
    await call('link_sessions', { to: 'c', after: ['b'] });
    expect(store.runs()).toHaveLength(1);
    expect(store.runs()[0]!.after).toEqual(['a', 'b']);
    expect(store.runs()[0]!.prompt).toBe('Merge');
  });
});

describe('unlink_sessions', () => {
  it('takes one line away, or the whole queued prompt', async () => {
    await call('link_sessions', { to: 'c', after: ['a', 'b'], prompt: 'Merge' });
    expect((await call('unlink_sessions', { to: 'c', from: 'a' })).isError).toBe(false);
    expect(store.runs()[0]!.after).toEqual(['b']);
    expect((await call('unlink_sessions', { to: 'c' })).text).toContain('Removed the queued prompt');
    expect(store.runs()).toHaveLength(0);
    expect((await call('unlink_sessions', { to: 'c' })).isError).toBe(true);
  });
});

describe('set_max_running', () => {
  it('caps a project by folder or zone, and null takes it away', async () => {
    expect((await call('set_max_running', { folder: CWD, max: 4 })).text).toContain('At most 4 sessions');
    // Caps are kept by folder key, the same key a run counts against (folderOf).
    expect(store.maxRunning()).toEqual({ 'garden-sim': 4 });
    expect(JSON.parse((await call('canvas_overview')).text).maxRunning).toEqual({ 'garden-sim': 4 });
    await call('set_max_running', { folder: CWD, max: null });
    expect(store.maxRunning()).toEqual({});
    expect((await call('set_max_running', { max: 2 })).isError).toBe(true);
    expect((await call('set_max_running', { folder: 'relative', max: 2 })).isError).toBe(true);
  });
});

describe('start_task with after', () => {
  it('queues a handoff instead of starting now', async () => {
    const res = await call('start_task', { folder: CWD, prompt: 'Install the app', after: ['a'] });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Queued the task');
    expect(started).toHaveLength(0);
    expect(store.runs()[0]).toMatchObject({ target: { kind: 'handoff', cwd: CWD }, after: ['a'], prompt: 'Install the app' });
  });
});

describe('read_session', () => {
  it('says what a session waits for and what waits on it', async () => {
    await call('link_sessions', { to: 'b', after: ['a'], prompt: 'Next' });
    const b = JSON.parse((await call('read_session', { id: 'b' })).text);
    expect(b.waitsFor).toMatchObject({ for: [{ id: 'a', state: 'working' }], status: 'waiting', queuedPrompt: 'Next' });
    const a = JSON.parse((await call('read_session', { id: 'a' })).text);
    expect(a.unblocks).toEqual([expect.objectContaining({ session: 'b', status: 'waiting' })]);
  });
});
