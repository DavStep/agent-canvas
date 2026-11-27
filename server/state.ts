// Card state from a raw session, and the "needs reply" tracker.
import type { Owner } from '../shared/chat.ts';
import type { NeedKind, SessionHost, SessionState, SessionView, SubagentView } from '../shared/types.ts';
import { describeActivity, folderOf } from './activity.ts';
import type { RawSession } from './adapter/sessionFiles.ts';
import type { TranscriptTail } from './adapter/transcript.ts';
import { shortName, type RecentSession } from './engines/recent.ts';

const PERMISSION_WAITS = new Set(['permission prompt', 'sandbox request', 'worker request']);
/** A CLI showing a dialog in its terminal ("dialog open"): a startup or login prompt, say. */
const DIALOG_WAIT = /\bdialog\b/i;

/** What a waiting session waits for. A dialog with nothing pending in the transcript is the
    CLI's own prompt in its terminal; with a tool call pending it is that call's permission (or,
    for AskUserQuestion, its question). */
function waitOf(raw: RawSession, tail: TranscriptTail | null): NeedKind {
  if (PERMISSION_WAITS.has(raw.waitingFor ?? '')) return 'permission';
  if (DIALOG_WAIT.test(raw.waitingFor ?? '')) {
    const tool = tail?.pendingTool ?? null;
    if (tool === null) return 'terminal';
    return tool.name === 'AskUserQuestion' ? 'question' : 'permission';
  }
  return 'question';
}

function stateOf(raw: RawSession, tail: TranscriptTail | null, needsReply: boolean): { state: SessionState; need: NeedKind | null } {
  switch (raw.status) {
    case 'busy':
    case 'shell':
      return { state: 'working', need: null };
    case 'waiting':
      return { state: 'needs_you', need: waitOf(raw, tail) };
    case 'idle':
      return needsReply ? { state: 'needs_you', need: 'reply' } : { state: 'idle', need: null };
    default:
      return { state: 'unknown', need: null };
  }
}

/** A session's name. The app's 'derived' name ("agent-canvas-d9") is a placeholder, so the
    transcript's title stands in for it, and the prompt until there is one. */
function nameOf(raw: RawSession, tail: TranscriptTail | null): string {
  if (raw.nameSource !== 'derived') return raw.name;
  return shortName(tail?.title ?? tail?.lastPrompt ?? '');
}

export function toView(
  raw: RawSession, tail: TranscriptTail | null, subagents: SubagentView[], needsReply: boolean, owner: Owner, host: SessionHost | null = null,
): SessionView {
  const { state, need } = stateOf(raw, tail, needsReply);
  return {
    id: raw.sessionId,
    provider: 'claude',
    hostId: raw.hostSessionId,
    name: nameOf(raw, tail),
    cwd: raw.cwd,
    folder: folderOf(raw.cwd),
    state,
    need,
    activity: describeActivity(raw, tail, need),
    ...(tail?.recentSteps ? { recentSteps: tail.recentSteps } : {}),
    // A limit or error the last turn ended on; the store makes it the card's state.
    ...(raw.status === 'idle' && tail?.interruption ? { interruption: tail.interruption } : {}),
    ...(tail?.completedAt !== undefined ? { completedAt: tail.completedAt } : {}),
    rawStatus: raw.status,
    stateSince: raw.statusUpdatedAt,
    startedAt: raw.startedAt,
    // A detached HEAD names no branch.
    branch: tail?.branch === 'HEAD' ? null : tail?.branch ?? null,
    model: tail?.model ?? null,
    lastPrompt: tail?.lastPrompt ?? null,
    lastAnswer: tail?.lastAnswer ?? null,
    subagents: state === 'working' ? subagents : [],
    owner,
    ownerNote: null,
    host,
  };
}

/** A Claude session with no live process: idle, known from its transcript's head and tail. */
export function recentView(r: RecentSession, owner: Owner): SessionView {
  return {
    id: r.id, provider: 'claude', hostId: null, name: r.name, cwd: r.cwd, folder: folderOf(r.cwd),
    state: 'idle', need: null, activity: null, rawStatus: '', stateSince: r.lastActive, startedAt: r.startedAt,
    branch: r.branch, model: r.model, lastPrompt: null, lastAnswer: null, subagents: [], owner, ownerNote: null, host: null,
    ...(r.interruption ? { interruption: r.interruption } : {}),
    ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
  };
}

const ACTIVE = new Set(['busy', 'shell', 'waiting']);

/**
 * A session needs a reply when this process saw it busy, shell or waiting and then idle.
 * Pending entries (sessionId -> when it became pending) are persisted; what was seen active is not.
 */
export class ReplyTracker {
  private pending: Map<string, number>;
  private wasActive = new Set<string>();

  constructor(initial: Record<string, number> = {}) {
    this.pending = new Map(Object.entries(initial));
  }

  observe(sessionId: string, status: string, at: number): void {
    if (status !== 'idle') {
      this.pending.delete(sessionId);
      if (ACTIVE.has(status)) this.wasActive.add(sessionId);
      return;
    }
    if (this.wasActive.delete(sessionId) && !this.pending.has(sessionId)) this.pending.set(sessionId, at);
  }

  needsReply(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  markSeen(ids: string[] | 'all'): void {
    if (ids === 'all') this.pending.clear();
    else for (const id of ids) this.pending.delete(id);
  }

  forget(liveIds: string[]): void {
    const live = new Set(liveIds);
    for (const id of this.pending.keys()) if (!live.has(id)) this.pending.delete(id);
    for (const id of this.wasActive) if (!live.has(id)) this.wasActive.delete(id);
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.pending);
  }
}
