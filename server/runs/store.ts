// The queue of runs (shared/runs.ts) and each project's max running, kept in runs.json in the
// app's data folder so a relaunch picks them up again. Changes from the owner and the agents come
// as RunOps; the scheduler moves a run through starting and started, and each of those is on
// disk before the run is sent, so a run is never sent twice (docs/links.md).
import { randomUUID } from 'node:crypto';
import {
  isPlanId, MAX_AFTER, MAX_PROMPT, MAX_RUNNING_LIMIT, planId, runOfPlan, targetNode, wouldCycle,
  type QueuedRun, type RunAttachment, type RunBy, type RunMode, type RunOp, type RunTarget,
} from '../../shared/runs.ts';
import { loadJson, saveJsonAtomic } from '../persist.ts';

export interface RunsFile { version: 1; runs: QueuedRun[]; maxRunning: Record<string, number> }

/** A run the app was sending when it closed: it may or may not have arrived, so it is not sent again. */
export const CLOSED_WHILE_STARTING = 'Agent canvas closed while this was being sent. Check the session, then try again or remove it.';
/** Sent runs older than this are forgotten when the file is read. */
const KEEP_STARTED_MS = 2 * 24 * 60 * 60 * 1000;

const log = (message: string): void => { process.stderr.write(`agent-canvas: ${message}\n`); };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNullStr = (v: unknown): v is string | null => v === null || typeof v === 'string';

function isTarget(v: unknown): v is RunTarget {
  if (!isRecord(v)) return false;
  if (v.kind === 'session') return isStr(v.id) && v.id !== '';
  if (v.kind === 'new') {
    return isStr(v.cwd) && (v.provider === 'claude' || v.provider === 'codex' || v.provider === 'acp')
      && isNullStr(v.model) && isNullStr(v.effort) && isNullStr(v.mode) && isNullStr(v.title) && (v.agent === undefined || isStr(v.agent));
  }
  if (v.kind === 'handoff') {
    return isStr(v.cwd) && isNullStr(v.provider) && isNullStr(v.model) && isNullStr(v.mode);
  }
  return false;
}

/** One stored run, checked field by field: a damaged one is dropped, never the whole file. */
export function isRun(v: unknown): v is QueuedRun {
  return isRecord(v) && isStr(v.id) && v.id !== '' && isTarget(v.target)
    && Array.isArray(v.after) && v.after.every((a) => isStr(a) && a !== '')
    && (v.mode === 'all' || v.mode === 'any') && isStr(v.prompt) && typeof v.handOff === 'boolean'
    && (v.attachments === undefined || (Array.isArray(v.attachments) && v.attachments.every((a) => isRecord(a) && isStr(a.path) && isStr(a.name) && isNullStr(a.mime))))
    && (v.by === 'owner' || v.by === 'agent' || v.by === 'orchestrator')
    && typeof v.createdAt === 'number' && Number.isFinite(v.createdAt)
    && (v.state === 'waiting' || v.state === 'starting' || v.state === 'started' || v.state === 'failed')
    && (v.startedAt === undefined || typeof v.startedAt === 'number') && (v.startedId === undefined || isStr(v.startedId))
    && (v.error === undefined || isStr(v.error));
}

function isRunsFile(v: unknown): v is RunsFile {
  return isRecord(v) && v.version === 1 && Array.isArray(v.runs) && isRecord(v.maxRunning);
}

/** What a run read from disk becomes: one caught mid-send fails (it is not sent again). */
export function afterRelaunch(runs: unknown[], maxRunning: Record<string, unknown>, now: number): RunsFile {
  const kept: QueuedRun[] = [];
  for (const r of runs) {
    if (!isRun(r)) { log('runs.json: dropped a damaged run'); continue; }
    if (r.state === 'started' && now - (r.startedAt ?? r.createdAt) > KEEP_STARTED_MS) continue;
    kept.push(r.state === 'starting' ? { ...r, state: 'failed', error: CLOSED_WHILE_STARTING } : r);
  }
  const limits: Record<string, number> = {};
  for (const [folder, max] of Object.entries(maxRunning)) {
    if (typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= MAX_RUNNING_LIMIT) limits[folder] = max;
  }
  return { version: 1, runs: kept, maxRunning: limits };
}

/** A new run's fields, before it has an id and a state. */
export interface RunDraft {
  target: RunTarget; after: string[]; mode?: RunMode; prompt: string; handOff?: boolean; by: RunBy;
  attachments?: RunAttachment[];
}

/** A refused change, in words for the owner or the agent. */
export class RunError extends Error {}

const newRunId = (): string => `run-${randomUUID().slice(0, 8)}`;
const pending = (r: QueuedRun): boolean => r.state !== 'started';

export class RunStore {
  private list: QueuedRun[];
  private limits: Record<string, number>;
  private readonly listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string | null, data: RunsFile, private readonly now: () => number) {
    this.list = data.runs;
    this.limits = data.maxRunning;
  }

  /** The queue in `file`, or an empty one kept in memory only (file null: the demo). */
  static async load(file: string | null, now: () => number = Date.now): Promise<RunStore> {
    if (file === null) return new RunStore(null, { version: 1, runs: [], maxRunning: {} }, now);
    const raw = await loadJson<RunsFile>(file, { version: 1, runs: [], maxRunning: {} }, isRunsFile);
    const data = afterRelaunch(raw.runs, raw.maxRunning, now());
    const store = new RunStore(file, data, now);
    // Runs caught mid-send are failed on disk at once.
    if (data.runs.length !== raw.runs.length || data.runs.some((r, i) => r !== raw.runs[i])) await store.save();
    return store;
  }

  runs(): readonly QueuedRun[] { return this.list; }
  run(id: string): QueuedRun | undefined { return this.list.find((r) => r.id === id); }
  maxRunning(): Readonly<Record<string, number>> { return this.limits; }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** The run not sent yet whose card is `node` (a session id or a planned card's id). */
  pendingFor(node: string): QueuedRun | undefined {
    if (isPlanId(node)) {
      const r = this.run(runOfPlan(node));
      return r && pending(r) ? r : undefined;
    }
    return this.list.find((r) => pending(r) && r.target.kind === 'session' && r.target.id === node);
  }

  /** Adds a run (a planned session, a handoff, or a prompt for a session). */
  queue(draft: RunDraft): QueuedRun {
    const prompt = draft.prompt.trim();
    if (prompt === '' && !draft.attachments?.length) throw new RunError('A queued run needs a prompt: what to send when it starts.');
    if (prompt.length > MAX_PROMPT) throw new RunError('That prompt is too long.');
    const after = [...new Set(draft.after)];
    if (after.length > MAX_AFTER) throw new RunError(`A run can wait for at most ${MAX_AFTER} sessions.`);
    if (draft.target.kind === 'session') {
      if (this.pendingFor(draft.target.id)) throw new RunError('That session already has a queued run; link to it to add more to wait for.');
      if (wouldCycle(this.list, after, draft.target.id)) throw new RunError(loopText);
    }
    for (const a of after) if (isPlanId(a) && !this.run(runOfPlan(a))) throw new RunError(`No planned session is ${a}.`);
    const run: QueuedRun = {
      id: newRunId(), target: draft.target, after, mode: draft.mode ?? 'all', prompt, handOff: draft.handOff ?? false,
      ...(draft.attachments && draft.attachments.length > 0 ? { attachments: draft.attachments } : {}),
      by: draft.by, createdAt: this.now(), state: 'waiting',
    };
    this.list = [...this.list, run];
    this.changed();
    return run;
  }

  /** The owner's or an agent's change. Throws a RunError with a sentence when it cannot be done. */
  apply(op: RunOp, by: RunBy): QueuedRun | null {
    switch (op.type) {
      case 'link': {
        const from = [...new Set(op.from)];
        if (from.includes(op.to)) throw new RunError('A session cannot wait for itself.');
        const existing = this.pendingFor(op.to);
        if (!existing) {
          if (isPlanId(op.to)) throw new RunError(`No planned session is ${op.to}.`);
          return this.queue({ target: { kind: 'session', id: op.to }, after: from, mode: op.mode, prompt: op.prompt ?? '', handOff: op.handOff, by });
        }
        if (existing.state === 'starting') throw new RunError('That run is being sent.');
        const node = targetNode(existing) ?? op.to;
        const added = from.filter((f) => !existing.after.includes(f));
        if (wouldCycle(this.list.filter((r) => r !== existing), [...existing.after, ...added], node)) throw new RunError(loopText);
        if (existing.after.length + added.length > MAX_AFTER) throw new RunError(`A run can wait for at most ${MAX_AFTER} sessions.`);
        const prompt = op.prompt?.trim();
        return this.replace(existing.id, {
          after: [...existing.after, ...added],
          ...(prompt ? { prompt } : {}),
          ...(op.mode ? { mode: op.mode } : {}),
          ...(op.handOff !== undefined ? { handOff: op.handOff } : {}),
          // A failed run linked again waits again.
          ...(existing.state === 'failed' ? { state: 'waiting' as const, error: undefined } : {}),
        });
      }
      case 'unlink': {
        const run = this.pendingFor(op.to) ?? this.list.find((r) => r.state === 'started' && (r.startedId === op.to || targetNode(r) === op.to) && r.after.includes(op.from));
        if (!run || !run.after.includes(op.from)) throw new RunError('There is no such link.');
        if (run.state === 'starting') throw new RunError('That run is being sent.');
        const after = run.after.filter((a) => a !== op.from);
        if (after.length === 0) { this.remove(run.id); return null; }
        return this.replace(run.id, { after });
      }
      case 'cancelRun':
        if (!this.run(op.id)) throw new RunError(`No queued run is ${op.id}.`);
        if (this.run(op.id)?.state === 'starting') throw new RunError('That run is being sent.');
        this.remove(op.id);
        return null;
      case 'editRun': {
        const run = this.run(op.id);
        if (!run) throw new RunError(`No queued run is ${op.id}.`);
        if (!pending(run) || run.state === 'starting') throw new RunError('That run has already started.');
        const prompt = op.prompt?.trim();
        if (op.prompt !== undefined && !prompt) throw new RunError('A queued run needs a prompt.');
        return this.replace(op.id, { ...(prompt ? { prompt } : {}), ...(op.mode ? { mode: op.mode } : {}), ...(op.handOff !== undefined ? { handOff: op.handOff } : {}) });
      }
      case 'retryRun': {
        const run = this.run(op.id);
        if (!run) throw new RunError(`No queued run is ${op.id}.`);
        if (run.state !== 'failed') throw new RunError('Only a run that failed can be tried again.');
        return this.replace(op.id, { state: 'waiting', error: undefined });
      }
      case 'setMaxRunning': {
        const next = { ...this.limits };
        if (op.max === null) delete next[op.folder];
        else next[op.folder] = op.max;
        this.limits = next;
        this.changed();
        return null;
      }
    }
  }

  // ── The scheduler's moves; each resolves once it is on disk ────────────────────────────────

  /** Marked before it is sent, and on disk before that send begins. */
  markStarting(id: string): Promise<void> {
    this.replace(id, { state: 'starting' });
    return this.chain;
  }

  /** Sent: a planned session's waiters now wait for the session it became. */
  markStarted(id: string, startedId: string): Promise<void> {
    const plan = planId(id);
    this.list = this.list.map((r) => {
      if (r.id === id) return { ...r, state: 'started' as const, startedAt: this.now(), startedId, error: undefined };
      return r.after.includes(plan) ? { ...r, after: [...new Set(r.after.map((a) => (a === plan ? startedId : a)))] } : r;
    });
    this.changed();
    return this.chain;
  }

  markFailed(id: string, error: string): Promise<void> {
    this.replace(id, { state: 'failed', error: error.slice(0, 300) });
    return this.chain;
  }

  /** Not sent after all (its session turned out busy): it waits again. */
  markWaiting(id: string): Promise<void> {
    this.replace(id, { state: 'waiting' });
    return this.chain;
  }

  /** Sent runs whose session has finished with them: their lines go. */
  retire(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    this.list = this.list.filter((r) => !gone.has(r.id));
    this.changed();
  }

  /** Resolves when every save asked for so far is written. */
  flush(): Promise<void> { return this.chain; }

  private replace(id: string, patch: Partial<QueuedRun>): QueuedRun {
    let found: QueuedRun | null = null;
    this.list = this.list.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, ...patch };
      for (const k of Object.keys(next) as (keyof QueuedRun)[]) if (next[k] === undefined) delete next[k];
      found = next;
      return next;
    });
    if (found === null) throw new RunError(`No queued run is ${id}.`);
    this.changed();
    return found;
  }

  private remove(id: string): void {
    this.list = this.list.filter((r) => r.id !== id);
    this.changed();
  }

  private changed(): void {
    void this.save().catch((err: unknown) => log(`runs.json not saved: ${(err as Error).message}`));
    for (const cb of [...this.listeners]) {
      try { cb(); } catch (err) { log(`run listener failed: ${(err as Error).message}`); }
    }
  }

  /** Writes the queue as it is when the write begins; writes never overlap. */
  private save(): Promise<void> {
    if (this.file === null) return Promise.resolve();
    const file = this.file;
    this.chain = this.chain
      .catch(() => {}) // A later write retries the whole current queue.
      .then(() => saveJsonAtomic(file, { version: 1, runs: this.list, maxRunning: this.limits } satisfies RunsFile));
    return this.chain;
  }
}

const loopText = 'That would make a loop: one of those sessions already waits, through others, for this one.';
