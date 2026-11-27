// What the queue should do now, decided from the runs and the cards alone (no clock or I/O of
// its own): each run's status and reason for the canvas and the tools, the runs to start now,
// and the sent runs whose lines can go. RunScheduler (scheduler.ts) acts on it.
import { folderOf } from '../activity.ts';
import { isInterrupted } from '../../shared/interruption.ts';
import {
  isPlanId, namesLine, planId, runOfPlan, targetNode, VIEW_PROMPT,
  type EdgeState, type QueuedRun, type RunView,
} from '../../shared/runs.ts';
import type { SessionView } from '../../shared/types.ts';

/** A link made against a card that reads finished counts it as finished only after this long, so
    a turn the agent sent it a moment ago has time to show (the reader polls about every second). */
export const SETTLE_MS = 3000;
/** A session just sent a run counts as running for this long even before a poll shows it working. */
export const START_GRACE_MS = 15_000;
/** A sent run's line stays at most this long when its session never shows up. */
export const LOST_MS = 60 * 60 * 1000;

export interface EvalInput {
  runs: readonly QueuedRun[];
  sessions: readonly SessionView[];
  maxRunning: Readonly<Record<string, number>>;
  /** The project orchestrator's card id for a folder, when it has one (a handoff's card). */
  orchestrator?(cwd: string): string | null;
  now: number;
}

export interface EvalResult {
  views: RunView[];
  /** Runs to send now, oldest first. */
  ready: string[];
  /** Sent runs whose session has finished with them and been looked at. */
  retire: string[];
}

/** A turn that ended on its own: idle, or a reply not looked at yet. */
export const finished = (s: SessionView): boolean => s.state === 'idle' || (s.state === 'needs_you' && s.need === 'reply');

const nameOf = (s: SessionView | undefined, fallback: string): string => (s?.name.trim() ? s.name.trim() : fallback);

function plannedName(run: QueuedRun | undefined): string {
  if (!run) return 'a planned session';
  if (run.target.kind === 'new' && run.target.title) return run.target.title;
  const line = run.prompt.split('\n', 1)[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'a planned session';
}

export function evaluate({ runs, sessions, maxRunning, orchestrator, now }: EvalInput): EvalResult {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  // Cards that wait themselves: they have not finished anything a downstream waits on.
  const waitingNodes = new Set(runs.filter((r) => r.state !== 'started').map(targetNode).filter((n): n is string => n !== null));
  // Sessions a run was just sent to, by when.
  const sentAt = new Map<string, number>();
  for (const r of runs) if (r.state === 'started' && r.startedId) sentAt.set(r.startedId, Math.max(sentAt.get(r.startedId) ?? 0, r.startedAt ?? 0));

  const name = (id: string): string => (isPlanId(id) ? plannedName(runById.get(runOfPlan(id))) : nameOf(byId.get(id), 'a session not on the canvas'));

  const edgeState = (run: QueuedRun, from: string): EdgeState => {
    if (isPlanId(from)) return 'pending';
    const s = byId.get(from);
    if (!s) return 'pending';
    if (isInterrupted(s)) return 'interrupted';
    if (s.state === 'working') return 'working';
    if (waitingNodes.has(from) || !finished(s)) return 'pending';
    const sent = sentAt.get(from);
    if (sent !== undefined && s.stateSince <= sent) return 'working';
    if (s.stateSince <= run.createdAt && now - run.createdAt < SETTLE_MS) return 'pending';
    return 'done';
  };

  const folderFor = (run: QueuedRun): string => {
    if (run.target.kind === 'session') {
      const s = byId.get(run.target.id);
      return s ? s.folder : '';
    }
    return folderOf(run.target.cwd);
  };

  // Running per folder: working cards, runs being sent, and sessions sent one a moment ago.
  const running = new Map<string, Set<string>>();
  const count = (folder: string, key: string) => {
    const set = running.get(folder) ?? new Set<string>();
    set.add(key);
    running.set(folder, set);
  };
  for (const s of sessions) if (s.state === 'working') count(s.folder, s.id);
  for (const r of runs) {
    if (r.state === 'starting') count(folderFor(r), r.target.kind === 'session' ? r.target.id : `run:${r.id}`);
    if (r.state === 'started' && r.startedId && now - (r.startedAt ?? 0) < START_GRACE_MS) {
      const s = byId.get(r.startedId);
      if (!s || s.stateSince <= (r.startedAt ?? 0)) count(s?.folder ?? folderFor(r), r.startedId);
    }
  }

  const views: RunView[] = [];
  const ready: string[] = [];
  const retire: string[] = [];
  for (const run of [...runs].sort((a, b) => a.createdAt - b.createdAt)) {
    const folder = folderFor(run);
    const edges = run.after.map((from) => ({ from, state: edgeState(run, from) }));
    const base = {
      id: run.id, target: run.target, folder, edges, mode: run.mode, prompt: run.prompt.slice(0, VIEW_PROMPT), handOff: run.handOff,
      by: run.by, createdAt: run.createdAt,
      ...(run.attachments?.length ? { attachmentNames: run.attachments.map(a => a.name) } : {}),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.startedId !== undefined ? { startedId: run.startedId } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
    const pendingNode = run.target.kind === 'session' ? run.target.id
      : run.target.kind === 'new' ? planId(run.id)
        : orchestrator?.(run.target.cwd) ?? null;

    if (run.state === 'started') {
      const s = run.startedId ? byId.get(run.startedId) : undefined;
      const at = run.startedAt ?? run.createdAt;
      // Done with it once its turn is over and has been looked at (or it never showed up).
      if ((s && s.state === 'idle' && s.stateSince > at) || (!s && now - at > LOST_MS)) retire.push(run.id);
      views.push({ ...base, node: run.startedId ?? pendingNode, status: 'started', reason: `Started after ${namesLine(run.after.map(name), run.mode) || 'its queue'}` });
      continue;
    }
    if (run.state === 'starting') {
      views.push({ ...base, node: pendingNode, status: 'starting', reason: 'Starting…' });
      continue;
    }
    if (run.state === 'failed') {
      views.push({ ...base, node: pendingNode, status: 'blocked', reason: `Did not start: ${run.error ?? 'unknown error'}` });
      continue;
    }

    const done = edges.filter((e) => e.state === 'done');
    const cut = edges.filter((e) => e.state === 'interrupted');
    const open = edges.filter((e) => e.state !== 'done');
    const satisfied = run.mode === 'any' ? edges.length === 0 || done.length > 0 : open.length === 0;
    const blocked = run.mode === 'any' ? edges.length > 0 && cut.length === edges.length : cut.length > 0;
    if (!satisfied) {
      const reason = blocked
        ? `Blocked: ${name(cut[0]!.from)} was interrupted`
        : `Waiting for ${namesLine((run.mode === 'any' ? edges : open).map((e) => name(e.from)), run.mode)}`;
      views.push({ ...base, node: pendingNode, status: blocked ? 'blocked' : 'waiting', reason });
      continue;
    }

    // Its upstreams are done: is its session free, and is there room in the project?
    let held: string | null = null;
    if (run.target.kind === 'session') {
      const s = byId.get(run.target.id);
      const label = nameOf(s, 'This session');
      if (!s) held = 'Its session is not on the canvas';
      else if (s.owner === 'elsewhere') held = `${label} is open in another app`;
      else if (s.state === 'working') held = `Waiting for ${label} to finish its turn`;
      // A permission, question or terminal prompt waits on the owner; an interrupted session takes
      // its queued prompt (resuming cut-off sessions is what a queued "Continue" is for).
      else if (s.state === 'needs_you' && (s.need === 'permission' || s.need === 'question' || s.need === 'terminal')) held = `${label} needs you first`;
    }
    const max = maxRunning[folder];
    const busy = running.get(folder)?.size ?? 0;
    if (held === null && max !== undefined && busy >= max) held = `Queued: ${busy} of ${max} running in ${folder || 'No folder'}`;
    if (held !== null) {
      views.push({ ...base, node: pendingNode, status: 'queued', reason: held });
      continue;
    }
    ready.push(run.id);
    count(folder, run.target.kind === 'session' ? run.target.id : `run:${run.id}`);
    views.push({ ...base, node: pendingNode, status: 'starting', reason: 'Starting…' });
  }
  return { views, ready, retire };
}

/** The prompt a run sends: its own, then each finished upstream's last answer when it hands them on. */
export function promptFor(run: QueuedRun, sessions: readonly SessionView[]): string {
  if (!run.handOff) return run.prompt;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const parts = [run.prompt];
  for (const id of run.after) {
    const s = byId.get(id);
    if (!s?.lastAnswer?.trim() || !finished(s)) continue;
    parts.push(`Upstream result from ${s.name.trim() ? `"${s.name.trim()}"` : id}:\n${s.lastAnswer.trim()}`);
  }
  return parts.join('\n\n');
}
