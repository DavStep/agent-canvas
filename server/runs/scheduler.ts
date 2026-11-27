// Starts queued runs when they are due: on every change of the cards or the queue, and on a slow
// tick (for settle times and freed slots). Each run is sent at most once: it is marked starting,
// and that is on disk, before the send begins; a send that cannot happen yet (its session turned
// busy) waits again, and one that throws fails the run, which then shows blocked.
import type { QueuedRun, RunView } from '../../shared/runs.ts';
import type { SessionView } from '../../shared/types.ts';
import { evaluate, promptFor } from './evaluate.ts';
import type { RunStore } from './store.ts';

/** Thrown by `launch` when the run cannot be sent yet: it waits again and is tried later. */
export class NotYet extends Error {}

const TICK_MS = 2000;
/** A run whose send was put off is not tried again for this long. */
const NOT_YET_MS = 10_000;

export interface SchedulerDeps {
  store: RunStore;
  /** The cards as the canvas shows them now. */
  sessions(): readonly SessionView[];
  /** The project orchestrator's card id for a folder, when there is one. */
  orchestrator?(cwd: string): string | null;
  /** Sends the run's prompt (or starts its session, or hands it to the orchestrator); resolves
      with the card id of the session it went to. Throws NotYet to be tried again later. */
  launch(run: QueuedRun, text: string): Promise<string>;
  now?(): number;
  tickMs?: number;
}

export class RunScheduler {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private latest: RunView[] = [];
  private shown = '[]';
  private readonly listeners = new Set<() => void>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly notBefore = new Map<string, number>();
  private queued = false;
  private stopped = false;
  private readonly offStore: () => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.offStore = deps.store.onChange(() => this.poke());
  }

  /** Evaluates now and then on every tick. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.poke(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    this.poke();
  }

  /** No more sends; resolves once the sends under way have finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offStore();
    await Promise.allSettled([...this.inFlight]);
    await this.deps.store.flush();
  }

  /** The runs as the canvas and the tools show them, as of the last evaluation. */
  views(): RunView[] { return this.latest; }

  /** Called when the views change. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Asks for an evaluation soon (several asks in one turn make one). */
  poke(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.tick();
    });
  }

  /** One evaluation: views updated, finished runs retired, due runs sent. Exposed for tests. */
  tick(): void {
    const { store } = this.deps;
    const sessions = this.deps.sessions();
    const now = this.now();
    const result = evaluate({ runs: store.runs(), sessions, maxRunning: store.maxRunning(), orchestrator: this.deps.orchestrator, now });
    const ready = this.stopped ? [] : result.ready.filter((id) => (this.notBefore.get(id) ?? 0) <= now);
    // A run put off for now shows queued, not starting.
    const views = result.views.map((v) => (v.status === 'starting' && result.ready.includes(v.id) && !ready.includes(v.id)
      ? { ...v, status: 'queued' as const, reason: 'Waiting to try again' } : v));
    this.publish(views);
    if (result.retire.length > 0) store.retire(result.retire);
    for (const id of ready) {
      const run = store.run(id);
      if (!run || run.state !== 'waiting') continue;
      const text = promptFor(run, sessions);
      const job = this.send(run, text).catch((err: unknown) => {
        process.stderr.write(`agent-canvas: could not save queued run: ${(err as Error).message}\n`);
      });
      this.inFlight.add(job);
      void job.finally(() => this.inFlight.delete(job));
    }
  }

  private async send(run: QueuedRun, text: string): Promise<void> {
    const { store } = this.deps;
    // On disk as starting before anything is sent: a quit now never sends it twice.
    try {
      await store.markStarting(run.id);
    } catch {
      await store.markFailed(run.id, 'Could not save the queue before sending. Check free space and try again.');
      return;
    }
    let startedId: string;
    try {
      startedId = await this.deps.launch(run, text);
    } catch (err) {
      if (err instanceof NotYet) {
        this.notBefore.set(run.id, this.now() + NOT_YET_MS);
        await store.markWaiting(run.id);
      } else {
        await store.markFailed(run.id, err instanceof Error ? err.message : String(err));
      }
      return;
    }
    this.notBefore.delete(run.id);
    await store.markStarted(run.id, startedId);
  }

  private publish(views: RunView[]): void {
    this.latest = views;
    const shown = JSON.stringify(views);
    if (shown === this.shown) return;
    this.shown = shown;
    for (const cb of [...this.listeners]) {
      try { cb(); } catch (err) { process.stderr.write(`agent-canvas: run view listener failed: ${(err as Error).message}\n`); }
    }
  }
}
