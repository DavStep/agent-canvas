import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRunOp, planId, wouldCycle, type QueuedRun } from '../../shared/runs.ts';
import type { SessionView } from '../../shared/types.ts';
import { evaluate, promptFor, SETTLE_MS } from './evaluate.ts';
import { NotYet, RunScheduler } from './scheduler.ts';
import { CLOSED_WHILE_STARTING, RunError, RunStore } from './store.ts';

const tempDirs: string[] = [];
async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-runs-'));
  tempDirs.push(dir);
  return path.join(dir, 'runs.json');
}

beforeEach(() => { vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function card(patch: Partial<SessionView> & { id: string }): SessionView {
  return {
    provider: 'claude', hostId: null, name: patch.id, cwd: '/work/app', folder: 'app', state: 'idle', need: null,
    activity: null, rawStatus: 'idle', stateSince: 0, startedAt: 0, branch: 'main', model: null,
    lastPrompt: null, lastAnswer: null, subagents: [], owner: 'here', ownerNote: null, host: null, ...patch,
  };
}

/** A clock the tests move by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const T0 = 1_000_000;

describe('parseRunOp', () => {
  it('keeps only known fields and refuses bad ones', () => {
    expect(parseRunOp({ type: 'link', from: ['a', 'a', 'b'], to: 'c', prompt: 'go', extra: 1 })).toEqual({ type: 'link', from: ['a', 'b'], to: 'c', prompt: 'go' });
    expect(() => parseRunOp({ type: 'link', from: 'a', to: 'c' })).toThrow(TypeError);
    expect(() => parseRunOp({ type: 'setMaxRunning', folder: 'app', max: 0 })).toThrow(TypeError);
    expect(parseRunOp({ type: 'setMaxRunning', folder: 'app', max: null })).toEqual({ type: 'setMaxRunning', folder: 'app', max: null });
    expect(() => parseRunOp({ type: 'link', from: ['a'], to: 'b', mode: 'some' })).toThrow(TypeError);
    expect(() => parseRunOp(null)).toThrow(TypeError);
  });
});

describe('RunStore', () => {
  it('links, merges a second link into the same run, and unlinks down to nothing', async () => {
    const store = await RunStore.load(null);
    const run = store.apply({ type: 'link', from: ['a'], to: 'b', prompt: 'Ship it' }, 'owner')!;
    expect(run).toMatchObject({ target: { kind: 'session', id: 'b' }, after: ['a'], mode: 'all', state: 'waiting', by: 'owner' });
    // Many-to-one: a second link to B adds to what it waits for, keeping the prompt.
    store.apply({ type: 'link', from: ['c'], to: 'b' }, 'owner');
    expect(store.runs()).toHaveLength(1);
    expect(store.runs()[0]!.after).toEqual(['a', 'c']);
    expect(store.runs()[0]!.prompt).toBe('Ship it');
    store.apply({ type: 'unlink', from: 'a', to: 'b' }, 'owner');
    expect(store.runs()[0]!.after).toEqual(['c']);
    store.apply({ type: 'unlink', from: 'c', to: 'b' }, 'owner');
    expect(store.runs()).toEqual([]);
  });

  it('needs a prompt for a new run and refuses a session waiting for itself', async () => {
    const store = await RunStore.load(null);
    expect(() => store.apply({ type: 'link', from: ['a'], to: 'b' }, 'owner')).toThrow(RunError);
    expect(() => store.apply({ type: 'link', from: ['a'], to: 'a', prompt: 'x' }, 'owner')).toThrow(/itself/);
  });

  it('prevents cycles, direct and through others, among runs not sent yet', async () => {
    const store = await RunStore.load(null);
    store.apply({ type: 'link', from: ['a'], to: 'b', prompt: 'b' }, 'owner');
    store.apply({ type: 'link', from: ['b'], to: 'c', prompt: 'c' }, 'owner');
    expect(() => store.apply({ type: 'link', from: ['c'], to: 'a', prompt: 'a' }, 'owner')).toThrow(/loop/);
    expect(() => store.apply({ type: 'link', from: ['b'], to: 'a', prompt: 'a' }, 'owner')).toThrow(/loop/);
    // Through a planned session too.
    const planned = store.queue({ target: { kind: 'new', cwd: '/work/app', provider: 'claude', model: null, effort: null, mode: null, title: 'Docs' }, after: ['c'], prompt: 'docs', by: 'agent' });
    expect(wouldCycle(store.runs(), [planId(planned.id)], 'a')).toBe(true);
    expect(() => store.apply({ type: 'link', from: [planId(planned.id)], to: 'a', prompt: 'a' }, 'owner')).toThrow(/loop/);
  });

  it('a sent run is history: linking the other way round is no loop', async () => {
    const store = await RunStore.load(null);
    const run = store.apply({ type: 'link', from: ['a'], to: 'b', prompt: 'b' }, 'owner')!;
    await store.markStarting(run.id);
    await store.markStarted(run.id, 'b');
    expect(() => store.apply({ type: 'link', from: ['b'], to: 'a', prompt: 'a' }, 'owner')).not.toThrow();
  });

  it('a planned session that starts hands its waiters over to the session it became', async () => {
    const store = await RunStore.load(null);
    const planned = store.queue({ target: { kind: 'new', cwd: '/work/app', provider: 'claude', model: null, effort: null, mode: null, title: null }, after: ['a'], prompt: 'build', by: 'orchestrator' });
    const after = store.queue({ target: { kind: 'session', id: 'z' }, after: [planId(planned.id)], prompt: 'then', by: 'orchestrator' });
    await store.markStarting(planned.id);
    await store.markStarted(planned.id, 'new-session');
    expect(store.run(after.id)!.after).toEqual(['new-session']);
  });

  it('persists the queue and the limits, and a run caught mid-send fails instead of being sent again', async () => {
    const file = await tempFile();
    const store = await RunStore.load(file);
    const a = store.apply({ type: 'link', from: ['a'], to: 'b', prompt: 'B' }, 'owner')!;
    const c = store.apply({ type: 'link', from: ['a'], to: 'c', prompt: 'C' }, 'owner')!;
    store.apply({ type: 'setMaxRunning', folder: 'app', max: 4 }, 'owner');
    await store.markStarting(c.id);
    await store.flush();

    const again = await RunStore.load(file);
    expect(again.maxRunning()).toEqual({ app: 4 });
    expect(again.run(a.id)!.state).toBe('waiting');
    expect(again.run(c.id)).toMatchObject({ state: 'failed', error: CLOSED_WHILE_STARTING });
    // Written back at once, so a third start reads it failed too.
    const third = JSON.parse(await fs.readFile(file, 'utf8')) as { runs: QueuedRun[] };
    expect(third.runs.find((r) => r.id === c.id)!.state).toBe('failed');
    // Tried again by hand, it waits once more.
    again.apply({ type: 'retryRun', id: c.id }, 'owner');
    expect(again.run(c.id)!.state).toBe('waiting');
    await again.flush();
  });

  it('drops a damaged run, never the whole file', async () => {
    const file = await tempFile();
    await fs.writeFile(file, JSON.stringify({ version: 1, maxRunning: {}, runs: [{ id: 'bad' }, {
      id: 'run-1', target: { kind: 'session', id: 'b' }, after: ['a'], mode: 'all', prompt: 'p', handOff: false, by: 'owner', createdAt: 1, state: 'waiting',
    }] }));
    const store = await RunStore.load(file);
    expect(store.runs().map((r) => r.id)).toEqual(['run-1']);
  });
});

describe('evaluate', () => {
  const run = (patch: Partial<QueuedRun> & { id: string }): QueuedRun => ({
    target: { kind: 'session', id: 'b' }, after: ['a'], mode: 'all', prompt: 'Next', handOff: false, by: 'owner',
    createdAt: T0 - 60_000, state: 'waiting', ...patch,
  });

  it('waits while the upstream works, starts once it finishes', () => {
    const working = evaluate({ runs: [run({ id: 'r' })], sessions: [card({ id: 'a', name: 'Fix login', state: 'working' }), card({ id: 'b' })], maxRunning: {}, now: T0 });
    expect(working.ready).toEqual([]);
    expect(working.views[0]).toMatchObject({ status: 'waiting', reason: 'Waiting for Fix login', edges: [{ from: 'a', state: 'working' }] });

    const done = evaluate({ runs: [run({ id: 'r' })], sessions: [card({ id: 'a', state: 'needs_you', need: 'reply', stateSince: T0 - 1000 }), card({ id: 'b' })], maxRunning: {}, now: T0 });
    expect(done.ready).toEqual(['r']);
    expect(done.views[0]!.edges[0]!.state).toBe('done');
  });

  it('an interrupted upstream blocks it, and nothing starts', () => {
    const out = evaluate({
      runs: [run({ id: 'r' })],
      sessions: [card({ id: 'a', name: 'Fix login', state: 'needs_you', need: 'interrupted', interruption: { kind: 'limit', reason: 'limit', at: T0, resetsAt: null } }), card({ id: 'b' })],
      maxRunning: {}, now: T0,
    });
    expect(out.ready).toEqual([]);
    expect(out.views[0]).toMatchObject({ status: 'blocked', reason: 'Blocked: Fix login was interrupted', edges: [{ state: 'interrupted' }] });
  });

  it('many-to-one waits for all; any-of starts on the first', () => {
    const sessions = [card({ id: 'a1', name: 'One', state: 'idle', stateSince: T0 - 5000 }), card({ id: 'a2', name: 'Two', state: 'working' }), card({ id: 'b' })];
    const all = evaluate({ runs: [run({ id: 'r', after: ['a1', 'a2'] })], sessions, maxRunning: {}, now: T0 });
    expect(all.ready).toEqual([]);
    expect(all.views[0]!.reason).toBe('Waiting for Two');
    const any = evaluate({ runs: [run({ id: 'r', after: ['a1', 'a2'], mode: 'any' })], sessions, maxRunning: {}, now: T0 });
    expect(any.ready).toEqual(['r']);
    // Any-of is blocked only when every upstream was interrupted.
    const cut = card({ id: 'a2', state: 'needs_you', need: 'interrupted', interruption: { kind: 'killed', reason: '', at: T0, resetsAt: null } });
    const anyCut = evaluate({ runs: [run({ id: 'r', after: ['a1', 'a2'], mode: 'any' })], sessions: [card({ id: 'a1', state: 'working' }), cut, card({ id: 'b' })], maxRunning: {}, now: T0 });
    expect(anyCut.views[0]!.status).toBe('waiting');
  });

  it('a link to a card that already reads finished settles a moment before it starts', () => {
    const sessions = [card({ id: 'a', state: 'idle', stateSince: T0 - 10_000 }), card({ id: 'b' })];
    const fresh = evaluate({ runs: [run({ id: 'r', createdAt: T0 - 1000 })], sessions, maxRunning: {}, now: T0 });
    expect(fresh.ready).toEqual([]);
    const later = evaluate({ runs: [run({ id: 'r', createdAt: T0 - 1000 })], sessions, maxRunning: {}, now: T0 - 1000 + SETTLE_MS });
    expect(later.ready).toEqual(['r']);
  });

  it('a session still waiting itself has finished nothing: chains go in order', () => {
    const runs = [run({ id: 'r1', after: ['a'], target: { kind: 'session', id: 'b' } }), run({ id: 'r2', after: ['b'], target: { kind: 'session', id: 'c' } })];
    const out = evaluate({ runs, sessions: [card({ id: 'a', state: 'working' }), card({ id: 'b' }), card({ id: 'c' })], maxRunning: {}, now: T0 });
    expect(out.views.find((v) => v.id === 'r2')!.edges[0]!.state).toBe('pending');
    // Just sent, B still reads idle from before: not finished yet.
    const sent = [{ ...runs[0]!, state: 'started' as const, startedAt: T0 - 500, startedId: 'b' }, runs[1]!];
    const now = evaluate({ runs: sent, sessions: [card({ id: 'a' }), card({ id: 'b', stateSince: T0 - 9000 }), card({ id: 'c' })], maxRunning: {}, now: T0 });
    expect(now.ready).toEqual([]);
    const after = evaluate({ runs: sent, sessions: [card({ id: 'a' }), card({ id: 'b', state: 'needs_you', need: 'reply', stateSince: T0 + 5000 }), card({ id: 'c' })], maxRunning: {}, now: T0 + 6000 });
    expect(after.ready).toEqual(['r2']);
  });

  it('holds a ready run while its session is busy or elsewhere', () => {
    const a = card({ id: 'a', stateSince: T0 - 10_000 });
    expect(evaluate({ runs: [run({ id: 'r' })], sessions: [a, card({ id: 'b', name: 'Bee', state: 'working' })], maxRunning: {}, now: T0 }).views[0]).toMatchObject({ status: 'queued', reason: 'Waiting for Bee to finish its turn' });
    expect(evaluate({ runs: [run({ id: 'r' })], sessions: [a, card({ id: 'b', name: 'Bee', owner: 'elsewhere' })], maxRunning: {}, now: T0 }).views[0]!.reason).toBe('Bee is open in another app');
    // An interrupted target can be resumed: that is what a queued "Continue" is for.
    expect(evaluate({ runs: [run({ id: 'r' })], sessions: [a, card({ id: 'b', state: 'needs_you', need: 'interrupted' })], maxRunning: {}, now: T0 }).ready).toEqual(['r']);
  });

  it('max running: at most N at once in a project, the oldest first, the rest as slots free up', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`);
    const runs = ids.map((id, i) => run({ id: `r${i}`, target: { kind: 'session', id }, after: [], prompt: 'Continue', createdAt: T0 - 100_000 + i }));
    const sessions = ids.map((id) => card({ id, state: 'needs_you', need: 'interrupted' }));
    const first = evaluate({ runs, sessions, maxRunning: { app: 4 }, now: T0 });
    expect(first.ready).toEqual(['r0', 'r1', 'r2', 'r3']);
    expect(first.views.find((v) => v.id === 'r4')!.reason).toBe('Queued: 4 of 4 running in app');
    // Four working (one of them another session entirely): nothing more starts.
    const busy = [...sessions.slice(4), card({ id: 'x', state: 'working' }), ...ids.slice(0, 3).map((id) => card({ id, state: 'working' }))];
    const sent = runs.map((r, i) => (i < 4 ? { ...r, state: 'started' as const, startedAt: T0, startedId: r.target.kind === 'session' ? r.target.id : '' } : r));
    expect(evaluate({ runs: sent, sessions: busy, maxRunning: { app: 4 }, now: T0 + 60_000 }).ready).toEqual([]);
    // One finishes: the next in line starts.
    const freed = busy.map((s) => (s.id === 'x' ? { ...s, state: 'idle' as const } : s));
    expect(evaluate({ runs: sent, sessions: freed, maxRunning: { app: 4 }, now: T0 + 60_000 }).ready).toEqual(['r4']);
  });

  it('retires a sent run once its session has finished and been looked at', () => {
    const sent = run({ id: 'r', state: 'started', startedAt: T0, startedId: 'b' });
    expect(evaluate({ runs: [sent], sessions: [card({ id: 'a' }), card({ id: 'b', state: 'working' })], maxRunning: {}, now: T0 + 5000 }).retire).toEqual([]);
    expect(evaluate({ runs: [sent], sessions: [card({ id: 'a' }), card({ id: 'b', state: 'needs_you', need: 'reply', stateSince: T0 + 4000 })], maxRunning: {}, now: T0 + 5000 }).retire).toEqual([]);
    expect(evaluate({ runs: [sent], sessions: [card({ id: 'a' }), card({ id: 'b', state: 'idle', stateSince: T0 + 6000 })], maxRunning: {}, now: T0 + 7000 }).retire).toEqual(['r']);
  });

  it('hands on the upstream results when asked', () => {
    const r = run({ id: 'r', handOff: true, after: ['a'] });
    expect(promptFor(r, [card({ id: 'a', name: 'Research', lastAnswer: 'Use Postgres.' })])).toBe('Next\n\nUpstream result from "Research":\nUse Postgres.');
    expect(promptFor({ ...r, handOff: false }, [card({ id: 'a', lastAnswer: 'x' })])).toBe('Next');
  });
});

describe('RunScheduler', () => {
  type Launch = (run: QueuedRun, text: string) => Promise<string>;
  async function setup(sessions: SessionView[], launch = vi.fn<Launch>(async (run) => (run.target.kind === 'session' ? run.target.id : 'created'))) {
    const t = clock(T0);
    const store = await RunStore.load(null, t.now);
    const cards = { list: sessions };
    const scheduler = new RunScheduler({ store, sessions: () => cards.list, launch, now: t.now });
    const settle = async () => { scheduler.tick(); for (let i = 0; i < 10; i++) await Promise.resolve(); await store.flush(); };
    return { t, store, cards, scheduler, launch, settle };
  }

  it('finishing A sends B its queued prompt once, through launch', async () => {
    const { t, store, cards, launch, settle } = await setup([card({ id: 'a', state: 'working' }), card({ id: 'b' })]);
    store.apply({ type: 'link', from: ['a'], to: 'b', prompt: 'Install the app' }, 'owner');
    await settle();
    expect(launch).not.toHaveBeenCalled();
    t.advance(5000);
    cards.list = [card({ id: 'a', state: 'needs_you', need: 'reply', stateSince: t.now() }), card({ id: 'b' })];
    await settle();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![1]).toBe('Install the app');
    expect(store.runs()[0]).toMatchObject({ state: 'started', startedId: 'b' });
    await settle();
    await settle();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('a send that cannot happen yet waits again; one that throws fails and shows blocked', async () => {
    const launch = vi.fn<(run: QueuedRun, text: string) => Promise<string>>().mockRejectedValueOnce(new NotYet('busy')).mockRejectedValueOnce(new Error('Signed out'));
    const { t, store, scheduler, settle } = await setup([card({ id: 'a', stateSince: T0 - 10_000 }), card({ id: 'b' })], launch);
    const run = store.apply({ type: 'link', from: ['a'], to: 'b', prompt: 'go' }, 'owner')!;
    t.advance(SETTLE_MS);
    await settle();
    expect(store.run(run.id)!.state).toBe('waiting');
    await settle();
    expect(launch).toHaveBeenCalledTimes(1);
    t.advance(11_000);
    await settle();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(store.run(run.id)).toMatchObject({ state: 'failed', error: 'Signed out' });
    await settle();
    expect(scheduler.views()[0]).toMatchObject({ status: 'blocked', reason: 'Did not start: Signed out' });
  });

  it('after a relaunch the queue resumes by itself and never sends a run twice', async () => {
    const file = await tempFile();
    const first = await RunStore.load(file, () => T0);
    const b = first.apply({ type: 'link', from: ['a'], to: 'b', prompt: 'B next' }, 'owner')!;
    const c = first.apply({ type: 'link', from: ['a'], to: 'c', prompt: 'C next' }, 'owner')!;
    await first.markStarting(c.id); // the app quit while sending C
    await first.flush();

    // Relaunch: A finished while the app was closed.
    const store = await RunStore.load(file, () => T0 + 60_000);
    const launch = vi.fn(async (run: QueuedRun) => (run.target.kind === 'session' ? run.target.id : ''));
    const scheduler = new RunScheduler({ store, sessions: () => [card({ id: 'a', stateSince: T0 + 30_000 }), card({ id: 'b' }), card({ id: 'c' })], launch, now: () => T0 + 60_000 });
    scheduler.tick();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await scheduler.stop();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].id).toBe(b.id);
    expect(store.run(c.id)!.state).toBe('failed');

    // A third start sends nothing again.
    const third = await RunStore.load(file, () => T0 + 120_000);
    expect(third.run(b.id)!.state).toBe('started');
    const again = vi.fn(async () => 'b');
    const s3 = new RunScheduler({ store: third, sessions: () => [card({ id: 'a' }), card({ id: 'b', state: 'working' }), card({ id: 'c' })], launch: again, now: () => T0 + 120_000 });
    s3.tick();
    await s3.stop();
    expect(again).not.toHaveBeenCalled();
  });
});
