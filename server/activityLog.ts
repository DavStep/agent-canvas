// The reader keeps this history even when the renderer is closed or Done is cleared.
import type { ActivityEntry, NeedKind, SessionView, Snapshot } from '../shared/types.ts';

export const ACTIVITY_LIMIT = 200;
const kinds: NeedKind[] = ['reply', 'permission', 'question', 'terminal', 'interrupted'];

export function isActivityLog(value: unknown): value is ActivityEntry[] {
  return Array.isArray(value) && value.every(e => e && typeof e.sessionId === 'string'
    && typeof e.name === 'string' && typeof e.folder === 'string' && kinds.includes(e.kind)
    && Number.isFinite(e.at) && Number.isFinite(e.sourceAt));
}

function kindOf(s: SessionView): NeedKind | null {
  if (s.state === 'needs_you') return s.need;
  if (s.state === 'idle' && (s.completedAt !== undefined || s.rawStatus === 'completed')) return 'reply';
  return null;
}

export class ActivityLog {
  private previous = new Map<string, NeedKind | null>();
  entries: ActivityEntry[];

  constructor(saved: ActivityEntry[], backfill: ActivityEntry[] = []) {
    const merged = [...saved];
    for (const e of backfill) {
      if (!merged.some(old => old.kind === e.kind && old.sessionId === e.sessionId && old.sourceAt === e.sourceAt)) merged.push(e);
    }
    this.entries = merged.sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT);
  }

  observe(snapshot: Snapshot): boolean {
    const next = new Map<string, NeedKind | null>();
    const added: ActivityEntry[] = [];
    const sessions = snapshot.agent ? [...snapshot.sessions, snapshot.agent] : snapshot.sessions;
    for (const s of sessions) {
      const kind = kindOf(s);
      next.set(s.id, kind);
      if (!kind) continue;
      // Codex's rollout has milliseconds while its durable index records the same turn in seconds.
      const sourceAt = kind === 'reply' && s.provider === 'codex' ? Math.floor(s.stateSince / 1000) * 1000
        : kind === 'reply' ? s.completedAt ?? s.stateSince : s.stateSince;
      const previous = this.previous.get(s.id);
      const latest = this.entries.find(e => e.sessionId === s.id);
      // Polled requests can acquire a newer file timestamp while still waiting on the same action.
      if (kind !== 'reply' && previous === kind) continue;
      const sameEvent = this.entries.some(e => e.sessionId === s.id && e.kind === kind && e.sourceAt === sourceAt);
      // An engine may ask again before the provider changes its state timestamp.
      if (sameEvent && (kind === 'reply' || previous === undefined || previous === kind)) continue;
      // A confirmed transcript can arrive just after the card announced the same completion.
      if (kind === 'reply' && previous === kind && latest?.kind === kind && s.completedAt !== undefined
        && latest.sourceAt === s.stateSince) continue;
      const at = previous !== undefined && previous !== kind && kind !== 'reply'
        ? Math.max(sourceAt, snapshot.generatedAt) : sourceAt;
      added.push({ sessionId: s.id, name: s === snapshot.agent ? 'Canvas agent' : s.name.trim().slice(0, 240),
        folder: s.folder, kind, sourceAt, at });
    }
    this.previous = next;
    if (!added.length) return false;
    const entries = [...added, ...this.entries].sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT);
    if (entries.every((e, i) => e === this.entries[i])) return false;
    this.entries = entries;
    return true;
  }
}
