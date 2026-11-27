// How an interrupted session is told: the card's state label, the chat banner, the prompt that
// continues it, and the countdown until a usage limit resets. Shared by the page and the tools.
import type { SessionInterruption, SessionView } from './types.ts';

export const isInterrupted = (s: Pick<SessionView, 'state' | 'need'>): boolean => s.state === 'needs_you' && s.need === 'interrupted';

/** "21:00" today, "Thu 21:00" within a week, else "Sep 16, 21:00": in the owner's time zone, 24-hour. */
export function resetClock(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  if (at > now && at - now < 6 * 86_400_000) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** A limit that has not reset yet: Continue would hit it again. */
export const limitPending = (i: SessionInterruption, now: number): boolean => i.kind === 'limit' && i.resetsAt !== null && i.resetsAt > now;

/** A limit that has reset (its time has passed, or Codex says usage is available again): the
    session is no longer held, only waiting for the owner to continue it. */
export const limitReady = (i: SessionInterruption, now: number): boolean =>
  i.codexUsage === 'available' || (i.kind === 'limit' && i.codexUsage !== 'blocked' && i.resetsAt !== null && i.resetsAt <= now);

/** A limit still holding the session: its reset is ahead, or Codex has not lifted it yet. */
export const limitActive = (i: SessionInterruption, now: number): boolean =>
  i.kind === 'limit' && !limitReady(i, now) && (limitPending(i, now) || i.codexUsage === 'blocked');

/** The divider's and the banner's line: "Limit hit · resets 16:00 · in 1h 12m", then
    "Limit reset · you can continue" once it has. Other interruptions keep the card's label. */
export function limitLine(i: SessionInterruption, now: number): string {
  if (limitReady(i, now)) return 'Limit reset · you can continue';
  if (limitPending(i, now)) return `Limit hit · resets ${resetClock(i.resetsAt!, now)} · in ${countdown(i.resetsAt!, now)}`;
  return interruptionLabel(i, now);
}

/** "1h 12m", "4m", "30s": how long until `at`. */
export function countdown(at: number, now: number): string {
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  return `${Math.round(h / 24)}d`;
}

/** The card's state label: "Limit hit · resets 21:00", "Error" or "Cut off". */
export function interruptionLabel(i: SessionInterruption, now: number): string {
  if (limitReady(i, now)) return 'Ready to continue';
  if (i.kind === 'limit') return limitPending(i, now) ? `Limit hit · resets ${resetClock(i.resetsAt!, now)}` : 'Limit hit';
  return i.kind === 'error' ? 'Error' : 'Cut off';
}

/** The chat banner's sentence. */
export function interruptionHeadline(i: SessionInterruption, now: number): string {
  if (i.codexUsage === 'available') return 'Codex usage is available again';
  if (i.kind === 'limit') {
    if (limitReady(i, now) || limitPending(i, now)) return limitLine(i, now);
    return i.resetsAt !== null ? 'Hit the usage limit · it has reset' : 'Hit a usage or rate limit';
  }
  return i.kind === 'error' ? 'Stopped by an error' : 'Cut off mid-turn';
}

/** The top bar's note while any usage limit holds sessions: the soonest reset (null when none is
    known), how many it holds, and the first card to jump to. Null once every limit has reset. */
export interface ActiveLimit { resetsAt: number | null; count: number; firstId: string }
export function activeLimit(views: readonly SessionView[], now: number): ActiveLimit | null {
  const held = views.filter((v) => v.interruption && isInterrupted(v) && limitActive(v.interruption, now));
  if (held.length === 0) return null;
  const times = held.map((v) => v.interruption!.resetsAt).filter((t): t is number => t !== null && t > now);
  const resetsAt = times.length > 0 ? Math.min(...times) : null;
  const first = resetsAt === null ? held[0]! : held.find((v) => v.interruption!.resetsAt === resetsAt)!;
  return { resetsAt, count: held.length, firstId: first.id };
}

/** "Limit · resets 16:00", or "Limit" when the reset time is unknown. */
export const activeLimitLabel = (l: ActiveLimit, now: number): string => (l.resetsAt !== null ? `Limit · resets ${resetClock(l.resetsAt, now)}` : 'Limit');

/** The words sent by Continue. */
export function continuePrompt(i: SessionInterruption): string {
  const why = i.kind === 'limit' ? 'a usage limit' : i.kind === 'error' ? `an error: ${oneLine(i.reason, 160)}` : 'its process ended mid-turn';
  return `Your previous turn was interrupted (${why}). Continue where you left off.`;
}

/** The canvas agent's state word: interrupted:<limit|error|killed>. */
export const interruptionState = (i: SessionInterruption): string => `interrupted:${i.kind}`;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
