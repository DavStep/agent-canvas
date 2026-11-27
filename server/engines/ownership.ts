// Who may write each session: this app (here), another program (elsewhere) or nobody.
// Claude: a live session file for the session whose pid descends from this app is here; a live
// file positively traced to another process tree is elsewhere. When a file's parents cannot be
// told, a session this app runs keeps its last owner, and one it does not run is read-only.
// Codex: a thread this app's server holds is here; on cards, a thread with a turn in progress
// written by something else is elsewhere.
import type { Owner } from '../../shared/chat.ts';
import type { SessionView } from '../../shared/types.ts';
import { defaultProbe, whichAlive, type Probe } from '../adapter/liveness.ts';
import { readSessionFiles, type RawSession } from '../adapter/sessionFiles.ts';
import { processTable } from './host.ts';

/** The warning a chat shows when another program opens a session this app was running. */
export const OPENED_ELSEWHERE = 'Opened in another app — read-only here';
/** The card note while a session let go here is still held by this app's provider process. */
export const RELEASING_NOTE = 'Released in about a minute';

export interface OwnerContext {
  /** Every live Claude session file (more than one may name the same session). */
  claudeFiles: RawSession[];
  /** This app's main process, which the engines run in; null when no engine runs here. */
  appPid: number | null;
  /** A process's parent pid, or null when it cannot be told. */
  parentOf(pid: number): number | null;
  /** Card ids (Codex ones as `codex:<id>`) the engines run now. */
  engineOwned: Set<string>;
  /** The owner last shown for a card, kept while a session this app runs cannot be traced. */
  lastOwner?(id: string): Owner | null;
}

/** How far up the process tree a session file's pid is followed looking for this app. */
const MAX_DEPTH = 10;

/** Whether `pid` descends from this app ('ours'), from some other tree ('foreign'), or cannot be
    told ('unknown': its parent is not known, or the table loops). */
export function lineage(pid: number, ctx: Pick<OwnerContext, 'appPid' | 'parentOf'>): 'ours' | 'foreign' | 'unknown' {
  const first = ctx.parentOf(pid);
  if (first === null) return 'unknown';
  if (ctx.appPid === null) return 'foreign';
  const seen = new Set([pid]);
  let parent: number | null = first;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (parent === ctx.appPid) return 'ours';
    // The top of the tree, or an ancestor the full process table does not list (so not running):
    // either way this app is not above it.
    if (parent === null || parent <= 1) return 'foreign';
    if (seen.has(parent)) return 'unknown';
    seen.add(parent);
    parent = ctx.parentOf(parent);
  }
  return 'foreign';
}

/** True when a live file for the session is positively another process tree's. */
export function foreignFile(sessionId: string, ctx: OwnerContext): boolean {
  return ctx.claudeFiles.some((f) => f.sessionId === sessionId && lineage(f.pid, ctx) === 'foreign');
}

export function ownerOf(session: Pick<SessionView, 'id' | 'provider' | 'state'>, ctx: OwnerContext): Owner {
  if (session.provider === 'codex') {
    if (ctx.engineOwned.has(session.id)) return 'here';
    return session.state === 'working' ? 'elsewhere' : 'nobody';
  }
  const files = ctx.claudeFiles.filter((f) => f.sessionId === session.id);
  const kinds = files.map((f) => lineage(f.pid, ctx));
  // Never two writers: any other program's file makes it elsewhere.
  if (kinds.includes('foreign')) return 'elsewhere';
  if (kinds.includes('unknown')) {
    // A failed or slow process lookup must not take a running session away from this app; a
    // session nobody here runs is read-only when in doubt.
    if (!ctx.engineOwned.has(session.id)) return 'elsewhere';
    const last = ctx.lastOwner?.(session.id) ?? null;
    return last ?? 'here';
  }
  if (files.length > 0 || ctx.engineOwned.has(session.id)) return 'here';
  return 'nobody';
}

/** The parent pid of every running process (the whole table, so ancestors can be followed), with
    one `ps` call. Rejects when `ps` fails or times out, so callers can tell "unknown" from "none".
    `pids` are the ones of interest: with none there is nothing to ask. */
export async function parentPids(pids: number[]): Promise<Map<number, number>> {
  const table = await processTable(pids);
  return new Map([...table].map(([pid, info]) => [pid, info.ppid]));
}

/** Read from the session files now, not the last poll: whether another program has the Claude
    session open (a live file for it whose pid does not descend from this app). Asked just before
    a resume, so a session opened elsewhere in the second since the last poll is not written by two
    programs. Parents that cannot be told count as foreign: this app does not run the session. */
export async function foreignSessionFile(
  sessionsDir: string, sessionId: string, appPid: number,
  parents: (pids: number[]) => Promise<Map<number, number>> = parentPids, probe: Probe = defaultProbe,
): Promise<boolean> {
  const files = (await readSessionFiles(sessionsDir)).sessions.filter((f) => f.sessionId === sessionId);
  if (files.length === 0) return false;
  const alive = await whichAlive(files, probe);
  const live = files.filter((_, i) => alive[i]);
  if (live.length === 0) return false;
  let parentOf: Map<number, number>;
  try {
    parentOf = await parents(live.map((f) => f.pid));
  } catch {
    parentOf = new Map();
  }
  const ctx = { appPid, parentOf: (pid: number) => parentOf.get(pid) ?? null };
  return live.some((f) => lineage(f.pid, ctx) !== 'ours');
}
