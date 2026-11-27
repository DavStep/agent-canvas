// Dependency links between sessions ("B runs after A"): a queued run is a prompt waiting to be
// sent to a session (or to start a new one, or to hand to a project's orchestrator) once the
// sessions it waits for have finished their turns. Shared by the main process (server/runs), the
// page (web/src/links) and the agents' tools. See docs/links.md.
import type { SessionProvider } from './chat.ts';

/** What a queued run does when it starts. */
export type RunTarget =
  /** Sends the prompt to a session on the canvas. */
  | { kind: 'session'; id: string }
  /** Starts a new session (a "planned" card until then). */
  | {
    kind: 'new'; cwd: string; provider: SessionProvider; model: string | null; effort: string | null; mode: string | null;
    title: string | null; agent?: string;
  }
  /** Hands the prompt to the project orchestrator for `cwd` (the canvas agent's start_task). */
  | {
    kind: 'handoff'; cwd: string;
    /** 'claude', 'codex' or acp:<id>, as start_task takes it; null: the orchestrator chooses. */
    provider: string | null; model: string | null; effort?: string; mode: string | null;
  };

/** A file handed on with a run, already copied into the app's attachments folder. */
export interface RunAttachment { path: string; name: string; mime: string | null }

export type RunMode = 'all' | 'any';
/** Who queued it. */
export type RunBy = 'owner' | 'agent' | 'orchestrator';

/** A run as it is stored (runs.json). `state` is what happened to it; RunView says why it waits. */
export interface QueuedRun {
  id: string;
  target: RunTarget;
  /** The sessions it waits for: card ids, or `plan:<run id>` for a planned session not created yet. */
  after: string[];
  /** 'all' (default): every one of them must finish; 'any': the first to finish starts it. */
  mode: RunMode;
  prompt: string;
  /** Appends each finished upstream's last answer to the prompt ("Upstream result from …"). */
  handOff: boolean;
  /** Images and files sent with the prompt. */
  attachments?: RunAttachment[];
  by: RunBy;
  createdAt: number;
  /** waiting: not sent yet. starting: being sent now (an app quit then leaves it failed, never
      sent twice). started: sent. failed: the send or start threw (`error`). */
  state: 'waiting' | 'starting' | 'started' | 'failed';
  startedAt?: number;
  /** The session it was sent to or started (for 'new' and 'handoff', the one created or used). */
  startedId?: string;
  error?: string;
}

/** How one upstream stands, for its connector line. */
export type EdgeState = 'working' | 'pending' | 'done' | 'interrupted';

/** What the canvas and the tools are told about a run. */
export interface RunView {
  id: string;
  target: RunTarget;
  /** The card the connector lines end on: the session, `plan:<id>` for a planned one, or the
      orchestrator's card id (or null when the project has none yet) for a handoff. */
  node: string | null;
  /** The folder key (folderOf) the run counts against for the project's max running. */
  folder: string;
  edges: { from: string; state: EdgeState }[];
  mode: RunMode;
  /** Names of files kept with the queued first message, for its waiting chat. */
  attachmentNames?: string[];
  /** At most 2000 characters. */
  prompt: string;
  handOff: boolean;
  by: RunBy;
  createdAt: number;
  /** waiting: for its upstreams. queued: they are done, and it waits for a free slot or for its
      session to be free. blocked: an upstream was interrupted (or the run failed). */
  status: 'waiting' | 'queued' | 'blocked' | 'starting' | 'started';
  /** One line for the card and the tools: "Waiting for Fix login", "Blocked: Fix login was interrupted". */
  reason: string;
  startedAt?: number;
  startedId?: string;
  error?: string;
}

/** The page's (and the tools') changes to the queue; main checks each (parseRunOp). */
export type RunOp =
  /** `to` runs after every session in `from`. A run already waiting for `to` gains them, and
      takes the prompt when one is given; otherwise a prompt is needed. */
  | { type: 'link'; from: string[]; to: string; prompt?: string; mode?: RunMode; handOff?: boolean }
  /** Takes one line away; a run left with nothing to wait for is removed. */
  | { type: 'unlink'; from: string; to: string }
  | { type: 'cancelRun'; id: string }
  | { type: 'editRun'; id: string; prompt?: string; mode?: RunMode; handOff?: boolean }
  /** A failed run waits again (and starts when it can). */
  | { type: 'retryRun'; id: string }
  /** At most `max` sessions working at once in a project folder (its zone's folder key); null: no limit. */
  | { type: 'setMaxRunning'; folder: string; max: number | null };

export const PLAN_PREFIX = 'plan:';
export const planId = (runId: string): string => PLAN_PREFIX + runId;
export const isPlanId = (id: string): boolean => id.startsWith(PLAN_PREFIX);
/** The run a planned card stands for. */
export const runOfPlan = (id: string): string => id.slice(PLAN_PREFIX.length);

export const MAX_PROMPT = 100_000;
export const MAX_AFTER = 50;
export const MAX_RUNNING_LIMIT = 50;
/** The prompt as views carry it. */
export const VIEW_PROMPT = 2000;

/** The id a run's card answers to before it starts: its session, or its planned card. */
export function targetNode(run: Pick<QueuedRun, 'id' | 'target'>): string | null {
  if (run.target.kind === 'session') return run.target.id;
  if (run.target.kind === 'new') return planId(run.id);
  return null;
}

const pending = (r: QueuedRun): boolean => r.state !== 'started';

/**
 * Whether making `to` wait for `from` closes a loop among the runs not sent yet: `to` would end
 * up waiting, through some chain, on itself. Sent runs are history and never count.
 */
export function wouldCycle(runs: readonly QueuedRun[], from: readonly string[], to: string): boolean {
  if (from.includes(to)) return true;
  // waitsOn: node -> what it waits for.
  const waitsOn = new Map<string, string[]>();
  for (const r of runs) {
    const node = targetNode(r);
    if (node === null || !pending(r)) continue;
    waitsOn.set(node, [...(waitsOn.get(node) ?? []), ...r.after]);
  }
  // Does any of `from` (transitively) wait on `to`?
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(waitsOn.get(id) ?? []));
  }
  return false;
}

// ── Checking ops from the page ───────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= 512;
const isMode = (v: unknown): v is RunMode => v === 'all' || v === 'any';

/** A fresh RunOp holding only the known fields, or a TypeError. */
export function parseRunOp(value: unknown): RunOp {
  if (!isRecord(value)) throw new TypeError('a run op must be an object');
  const v = value;
  const prompt = v.prompt === undefined ? undefined : typeof v.prompt === 'string' && v.prompt.length <= MAX_PROMPT ? v.prompt : null;
  if (prompt === null) throw new TypeError('a prompt must be text');
  if (v.mode !== undefined && !isMode(v.mode)) throw new TypeError('mode must be all or any');
  if (v.handOff !== undefined && typeof v.handOff !== 'boolean') throw new TypeError('handOff must be true or false');
  const extras = {
    ...(prompt !== undefined ? { prompt } : {}),
    ...(v.mode !== undefined ? { mode: v.mode as RunMode } : {}),
    ...(v.handOff !== undefined ? { handOff: v.handOff as boolean } : {}),
  };
  switch (v.type) {
    case 'link':
      if (!Array.isArray(v.from) || v.from.length > MAX_AFTER || !v.from.every(isId) || !isId(v.to)) break;
      return { type: 'link', from: [...new Set(v.from as string[])], to: v.to, ...extras };
    case 'unlink':
      if (isId(v.from) && isId(v.to)) return { type: 'unlink', from: v.from, to: v.to };
      break;
    case 'cancelRun':
    case 'retryRun':
      if (isId(v.id)) return { type: v.type, id: v.id };
      break;
    case 'editRun':
      if (isId(v.id)) return { type: 'editRun', id: v.id, ...extras };
      break;
    case 'setMaxRunning': {
      const max = v.max;
      const okMax = max === null || (typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= MAX_RUNNING_LIMIT);
      if (typeof v.folder === 'string' && v.folder.length <= 512 && okMax) return { type: 'setMaxRunning', folder: v.folder, max: max as number | null };
      break;
    }
  }
  throw new TypeError('not a run op');
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────

/** "Fix login", "Fix login and Tests", "Fix login and 2 more"; "any of" for mode any. */
export function namesLine(names: string[], mode: RunMode): string {
  if (names.length === 0) return '';
  const joined = names.length === 1 ? names[0]!
    : names.length === 2 ? `${names[0]} ${mode === 'any' ? 'or' : 'and'} ${names[1]}`
      : `${names[0]} ${mode === 'any' ? 'or' : 'and'} ${names.length - 1} more`;
  return mode === 'any' && names.length > 1 ? `any of ${joined}` : joined;
}
