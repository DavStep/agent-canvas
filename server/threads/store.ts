// ~/.agent-canvas/openThreads.json: the open threads the detector found, the ones the owner
// dismissed (never made again), what the judge said about each candidate (so it is asked once),
// and how far each conversation has been read. Written atomically; without a file (demo mode) it
// lives in memory only.
import type { OpenThread, ThreadOp } from '../../shared/threads.ts';
import { createDebouncedSave, loadJson, saveJsonAtomic, type DebouncedSave } from '../persist.ts';

interface Cursor { mtimeMs: number; size: number }
interface Judged { open: boolean; at: number }

interface ThreadsData {
  version: 1;
  threads: OpenThread[];
  /** Thread id to when the owner dismissed it (epoch ms). Kept so it is never made again. */
  dismissed: Record<string, number>;
  /** Candidate key to what the judge said, so one model call settles it for good. */
  judged: Record<string, Judged>;
  /** Card id to the state of its file when it was last read. */
  cursors: Record<string, Cursor>;
}

const SAVE_DEBOUNCE_MS = 400;
/** The newest kept of each list, so the file cannot grow without end. */
const MAX_THREADS = 200;
const MAX_DISMISSED = 2000;
const MAX_JUDGED = 2000;
const MAX_CURSORS = 600;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

function isThread(v: unknown): v is OpenThread {
  return isRecord(v)
    && typeof v.id === 'string' && v.id !== ''
    && typeof v.title === 'string' && typeof v.summary === 'string' && typeof v.question === 'string'
    && typeof v.sessionId === 'string' && typeof v.sessionName === 'string'
    && (v.provider === 'claude' || v.provider === 'codex')
    && typeof v.cwd === 'string' && typeof v.folder === 'string'
    && isTime(v.askedAt) && isTime(v.foundAt)
    && typeof v.excerpt === 'string'
    && (v.state === 'open' || v.state === 'done');
}

function isThreadsData(v: unknown): v is ThreadsData {
  return isRecord(v)
    && v.version === 1
    && Array.isArray(v.threads) && v.threads.every(isThread)
    && isRecord(v.dismissed) && Object.values(v.dismissed).every(isTime)
    && isRecord(v.judged) && Object.values(v.judged).every((j) => isRecord(j) && typeof j.open === 'boolean' && isTime(j.at))
    && isRecord(v.cursors) && Object.values(v.cursors).every((c) => isRecord(c) && isTime(c.mtimeMs) && isTime(c.size));
}

/** The newest `max` entries of a id-to-time map (by time, then id). */
function trim<T>(map: Record<string, T>, max: number, timeOf: (v: T) => number): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= max) return map;
  return Object.fromEntries(entries.sort((a, b) => timeOf(b[1]) - timeOf(a[1])).slice(0, max));
}

/** Newest question first. */
const byAsked = (a: OpenThread, b: OpenThread): number => b.askedAt - a.askedAt || (a.id < b.id ? -1 : 1);

export class ThreadStore {
  private readonly listeners = new Set<() => void>();
  private readonly saver: DebouncedSave;

  private constructor(private readonly file: string | null, private data: ThreadsData) {
    this.saver = createDebouncedSave(async () => {
      if (this.file !== null) await saveJsonAtomic(this.file, this.data);
    }, SAVE_DEBOUNCE_MS);
  }

  /** `file` null: in memory only (demo mode), seeded with `seed` if given. */
  static async load(file: string | null, seed: OpenThread[] = []): Promise<ThreadStore> {
    const empty: ThreadsData = { version: 1, threads: seed, dismissed: {}, judged: {}, cursors: {} };
    return new ThreadStore(file, file === null ? empty : await loadJson(file, empty, isThreadsData));
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** What the canvas shows: open threads, newest question first. */
  list(): OpenThread[] {
    return this.data.threads.filter((t) => t.state === 'open' && this.data.dismissed[t.id] === undefined).sort(byAsked);
  }

  /** Every thread kept, dismissed and done ones included (for the agent's tools and tests). */
  all(): OpenThread[] {
    return [...this.data.threads].sort(byAsked);
  }

  thread(id: string): OpenThread | undefined {
    return this.data.threads.find((t) => t.id === id);
  }

  /** Whether this loop has been seen before, however it ended: it is never made again. */
  known(id: string): boolean {
    return this.data.dismissed[id] !== undefined || this.data.threads.some((t) => t.id === id);
  }

  /** What the judge said about a candidate before, if it was ever asked. */
  judgement(key: string): Judged | undefined {
    return this.data.judged[key];
  }

  noteJudged(key: string, open: boolean, at: number): void {
    this.data = { ...this.data, judged: trim({ ...this.data.judged, [key]: { open, at } }, MAX_JUDGED, (j) => j.at) };
    this.saver.schedule();
  }

  cursor(id: string): Cursor | undefined {
    return this.data.cursors[id];
  }

  setCursor(id: string, cursor: Cursor): void {
    this.data = { ...this.data, cursors: trim({ ...this.data.cursors, [id]: cursor }, MAX_CURSORS, () => 0) };
    this.saver.schedule();
  }

  /** Adds threads the store has not seen; returns how many were new. */
  add(threads: readonly OpenThread[]): number {
    const fresh = threads.filter((t) => !this.known(t.id));
    if (fresh.length === 0) return 0;
    const next = [...this.data.threads, ...fresh].sort(byAsked).slice(0, MAX_THREADS);
    this.data = { ...this.data, threads: next };
    this.changed();
    return fresh.length;
  }

  /** The source chat took the question up again: the thread closes itself. */
  markDone(id: string): boolean {
    return this.apply({ type: 'done', id });
  }

  /** Dismiss (with `restore` as its undo) and done. False when no such thread is kept. */
  apply(op: ThreadOp): boolean {
    const thread = this.thread(op.id);
    if (thread === undefined) return false;
    if (op.type === 'dismiss') {
      if (this.data.dismissed[op.id] !== undefined) return false;
      this.data = { ...this.data, dismissed: trim({ ...this.data.dismissed, [op.id]: Date.now() }, MAX_DISMISSED, (t) => t) };
    } else if (op.type === 'restore') {
      if (this.data.dismissed[op.id] === undefined && thread.state === 'open') return false;
      const { [op.id]: _gone, ...dismissed } = this.data.dismissed;
      this.data = { ...this.data, dismissed, threads: this.data.threads.map((t) => (t.id === op.id ? { ...t, state: 'open' } : t)) };
    } else {
      if (thread.state === 'done') return false;
      this.data = { ...this.data, threads: this.data.threads.map((t) => (t.id === op.id ? { ...t, state: 'done' } : t)) };
    }
    this.changed();
    return true;
  }

  /** Writes any save still waiting (on the way out). */
  flush(): Promise<void> {
    return this.saver.flush();
  }

  private changed(): void {
    this.saver.schedule();
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        process.stderr.write(`agent-canvas: open threads listener failed: ${(err as Error).message}\n`);
      }
    }
  }
}
