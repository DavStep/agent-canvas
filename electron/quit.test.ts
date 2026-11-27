import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuitFlow, type BusySession, type QuitDeps } from './quit.ts';

afterEach(() => {
  vi.useRealTimers();
});

/** A quit flow over recorded fakes; `busy` may be changed between checks. */
function setup(initial: BusySession[], opts: { stop?: () => Promise<void>; stopTimeoutMs?: number } = {}) {
  const calls: string[] = [];
  const notified: BusySession[] = [];
  const state = { busy: initial };
  const deps: QuitDeps = {
    busy: () => state.busy,
    hide: () => { calls.push('hide'); },
    show: () => { calls.push('show'); },
    notify: (b) => { notified.push(b); },
    stop: async () => {
      calls.push('stop');
      await (opts.stop ?? (async () => {}))();
      calls.push('stopped');
    },
    exit: () => { calls.push('exit'); },
  };
  const flow = new QuitFlow(deps, { checkMs: 1000, ...(opts.stopTimeoutMs !== undefined ? { stopTimeoutMs: opts.stopTimeoutMs } : {}) });
  return { flow, calls, notified, state };
}

const RUNNING: BusySession = { title: 'Fix the parser', reason: 'turn' };
const WAITING: BusySession = { title: 'Ship the release', reason: 'approval' };

describe('QuitFlow', () => {
  it('no busy sessions → quits at once: engines stopped, then exit, nothing hidden', async () => {
    const { flow, calls } = setup([]);
    await flow.request();
    expect(calls).toEqual(['stop', 'stopped', 'exit']);
  });

  it('a running turn is never stopped by a quit: the app hides and exits once the turn is done', async () => {
    vi.useFakeTimers();
    const { flow, calls, state } = setup([RUNNING]);
    await flow.request();
    expect(calls).toEqual(['hide']);
    expect(flow.phase).toBe('finishing');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual(['hide']); // still running
    state.busy = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(['hide', 'stop', 'stopped', 'exit']);
  });

  it('a session waiting for the owner notifies once, and keeps the app running', async () => {
    vi.useFakeTimers();
    const { flow, calls, notified, state } = setup([RUNNING]);
    await flow.request();
    state.busy = [WAITING];
    await vi.advanceTimersByTimeAsync(5000);
    expect(notified).toEqual([WAITING]);
    expect(calls).toEqual(['hide']);
    // Answered elsewhere, then waiting again: told again.
    state.busy = [RUNNING];
    await vi.advanceTimersByTimeAsync(1000);
    state.busy = [WAITING];
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toEqual([WAITING, WAITING]);
  });

  it('opening the app again while finishing brings it back and cancels the exit', async () => {
    vi.useFakeTimers();
    const { flow, calls, state } = setup([RUNNING]);
    await flow.request();
    flow.reopened();
    expect(flow.phase).toBe('idle');
    state.busy = [];
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual(['hide', 'show']);
  });

  it('a second quit while finishing hides nothing more', async () => {
    const { flow, calls } = setup([RUNNING]);
    await flow.request();
    await flow.request();
    expect(calls).toEqual(['hide']);
    await flow.request({ force: true });
  });

  it('a forced quit (signal, shutdown) stops busy sessions at once, also while finishing, and exits once', async () => {
    const { flow, calls } = setup([RUNNING]);
    await flow.request();
    await Promise.all([flow.request({ force: true }), flow.request({ force: true })]);
    expect(calls).toEqual(['hide', 'stop', 'stopped', 'exit']);
  });

  it('re-entry while stopping: no second stop or exit', async () => {
    let release!: () => void;
    const { flow, calls } = setup([], { stop: () => new Promise<void>((r) => { release = r; }) });
    const first = flow.request();
    await vi.waitFor(() => expect(calls).toEqual(['stop']));
    void flow.request();
    release();
    await first;
    expect(calls).toEqual(['stop', 'stopped', 'exit']);
  });

  it('a stop() that throws still exits', async () => {
    const { flow, calls } = setup([], { stop: async () => { throw new Error('engine broke'); } });
    await flow.request();
    expect(calls).toEqual(['stop', 'exit']);
  });

  it('a stop() that never settles exits after the stop timeout', async () => {
    vi.useFakeTimers();
    const { flow, calls } = setup([], { stop: () => new Promise<void>(() => {}), stopTimeoutMs: 10_000 });
    const done = flow.request();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toEqual(['stop']);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls).toEqual(['stop', 'exit']);
  });
});
