// When a usage limit resets: one notification for the sessions it freed, never repeated, and
// with "Continue cut-off sessions automatically" a queued Continue each, which the run queue
// sends at most the project's max running at a time.
import { describe, expect, it } from 'vitest';
import type { SessionInterruption, SessionView } from '../shared/types.ts';
import { LimitResets, resetNotice, type LimitResetChoice } from './limitResets.ts';
import { evaluate } from './runs/evaluate.ts';
import { RunStore, type RunDraft } from './runs/store.ts';

const RESET = Date.UTC(2026, 10, 27, 12, 0);
const limit = (at = RESET - 3 * 3_600_000): SessionInterruption => ({ kind: 'limit', reason: "You've hit your 5-hour limit · resets 4pm (Asia/Yerevan)", at, resetsAt: RESET });

function card(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id, provider: 'claude', hostId: null, name: id, cwd: '/work/app', folder: 'app', state: 'needs_you', need: 'interrupted', interruption: limit(),
    activity: null, rawStatus: 'idle', stateSince: RESET - 3 * 3_600_000, startedAt: 0, branch: null, model: null, lastPrompt: null, lastAnswer: null,
    subagents: [], owner: 'nobody', ownerNote: null, host: null, ...over,
  } as SessionView;
}

function watcher(choice: LimitResetChoice = 'ask', queue: (d: RunDraft) => unknown = () => {}) {
  let now = RESET - 60_000;
  const notices: number[] = [];
  const w = new LimitResets({ notify: (n) => notices.push(n), choice: () => choice, queue, now: () => now });
  return { w, notices, at: (t: number) => { now = t; } };
}

describe('LimitResets', () => {
  it('one notification when the limit resets, for every session it freed, and never again', () => {
    const { w, notices, at } = watcher();
    const cards = [card('a'), card('b'), card('c', { interruption: { ...limit(), kind: 'error', resetsAt: null } })];
    expect(w.update(cards)).toEqual([]);
    expect(notices).toEqual([]);
    at(RESET);
    expect(w.update(cards)).toEqual(['a', 'b']);
    expect(notices).toEqual([2]);
    at(RESET + 60_000);
    w.update(cards);
    w.update(cards);
    expect(notices).toEqual([2]);
    expect(resetNotice(2).title).toBe('Usage limit reset: 2 sessions can continue');
    expect(resetNotice(1).title).toBe('Usage limit reset: 1 session can continue');
  });

  it("the canvas agent's conversation counts; a limit that reset before the app saw it does not notify", () => {
    const { w, notices, at } = watcher();
    w.update([], card('agent'));
    at(RESET);
    w.update([card('old', { interruption: limit(RESET - 8 * 3_600_000) })], card('agent'));
    expect(notices).toEqual([1]);
  });

  it('a session continued by hand or aborted before the reset is not told', () => {
    const { w, notices, at } = watcher();
    w.update([card('a')]);
    w.update([card('a', { state: 'working', need: null, interruption: undefined })]);
    at(RESET);
    w.update([card('a', { state: 'idle', need: null, interruption: undefined })]);
    expect(notices).toEqual([]);
  });

  it('a Codex account limit counts once its usage is available again', () => {
    const { w, notices } = watcher();
    const blocked = { ...limit(), resetsAt: null, codexUsage: 'blocked' as const };
    w.update([card('x', { provider: 'codex', interruption: blocked })]);
    w.update([card('x', { provider: 'codex', interruption: { ...blocked, codexUsage: 'available' } })]);
    expect(notices).toEqual([1]);
  });

  it('Ask (the default) queues nothing', () => {
    const queued: RunDraft[] = [];
    const { w, at } = watcher('ask', (d) => queued.push(d));
    w.update([card('a')]);
    at(RESET);
    w.update([card('a')]);
    expect(queued).toEqual([]);
  });

  it('auto-continue queues a Continue each, and the queue starts only max running at a time', async () => {
    const store = await RunStore.load(null, () => RESET);
    const { w, at } = watcher('continue', (d) => store.queue(d));
    store.apply({ type: 'setMaxRunning', folder: 'app', max: 2 }, 'owner');
    const cards = ['a', 'b', 'c', 'd'].map((id) => card(id));
    // Another session already works in the project: one slot is left.
    const busy = card('busy', { state: 'working', need: null, interruption: undefined });
    // The agent's conversation and a session open in another app are not queued.
    const elsewhere = card('far', { owner: 'elsewhere' });
    w.update([...cards, busy, elsewhere], card('agent'));
    at(RESET + 1000);
    w.update([...cards, busy, elsewhere], card('agent'));
    expect(store.runs().map((r) => r.target.kind === 'session' && r.target.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(store.runs()[0]).toMatchObject({ after: [], by: 'owner', prompt: 'Your previous turn was interrupted (a usage limit). Continue where you left off.' });

    const first = evaluate({ runs: store.runs(), sessions: [...cards, busy, elsewhere], maxRunning: store.maxRunning(), now: RESET + 1000 });
    expect(first.ready).toHaveLength(1);
    expect(first.views.filter((v) => v.status === 'queued').map((v) => v.reason)).toEqual(Array(3).fill('Queued: 2 of 2 running in app'));
    // The busy one finishes: one more starts.
    const done = card('busy', { state: 'idle', need: null, interruption: undefined });
    const second = evaluate({ runs: store.runs(), sessions: [...cards, done, elsewhere], maxRunning: store.maxRunning(), now: RESET + 2000 });
    expect(second.ready).toHaveLength(2);
    // A second reset pass queues nothing twice.
    w.update([...cards, busy, elsewhere]);
    expect(store.runs()).toHaveLength(4);
  });
});
