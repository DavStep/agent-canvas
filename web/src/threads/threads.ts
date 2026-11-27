// The page's side of open threads (shared/threads.ts): what a dragged ticket carries, where it can
// land, and the message it becomes. Pure, so the drop rules are tested without a window.
import { preparedMessage, type OpenThread } from '../../../shared/threads.ts';

/** The drag's own type, so no other drop target (images, notes, files) mistakes a ticket for its own. */
export const THREAD_MIME = 'application/x-agent-canvas-thread';

/** Where a ticket dropped: into an open chat's composer, onto a card, onto a zone, or the empty canvas. */
export type ThreadDrop =
  | { kind: 'composer' }
  | { kind: 'card'; id: string }
  | { kind: 'zone'; id: string }
  | { kind: 'canvas' };

/** What a drop here would do, said on the ticket while it is dragged and on the target. */
export function dropLabel(drop: ThreadDrop | null): string {
  switch (drop?.kind) {
    case 'composer': return 'Add to this message';
    case 'card': return 'Open this chat with it';
    case 'zone': return 'Start a session here';
    case 'canvas': return 'Start a session in its folder';
    default: return 'Drop on a chat, a card or a zone';
  }
}

/** The element under the pointer, read as a drop target; null where a ticket cannot land. */
export function dropAt(el: Element | null): { drop: ThreadDrop; target: Element } | null {
  if (el === null) return null;
  // A thread note is no target: one dropped back on itself (or another) stays.
  if (el.closest('.thread-note')) return null;
  const composer = el.closest('.composer');
  if (composer) return { drop: { kind: 'composer' }, target: composer };
  const card = el.closest<HTMLElement>('[data-card-id]');
  if (card?.dataset.cardId) return { drop: { kind: 'card', id: card.dataset.cardId }, target: card };
  const zone = el.closest<HTMLElement>('.zone[data-zone-id]');
  if (zone?.dataset.zoneId) return { drop: { kind: 'zone', id: zone.dataset.zoneId }, target: zone };
  const canvas = el.closest('.workspace');
  if (canvas) return { drop: { kind: 'canvas' }, target: canvas };
  return null;
}

/** "40 minutes", "3 hours", "2 days": how long ago, in words for a message. */
export function spokenAgo(from: number, now: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.round((now - from) / 60_000));
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  return hours < 48 ? unit(hours, 'hour') : unit(Math.round(hours / 24), 'day');
}

/** The message a ticket becomes in a composer or as a new session's first prompt. */
export const threadMessage = (t: OpenThread, now: number): string => preparedMessage(t, { ago: spokenAgo(t.askedAt, now) });

/** The project a ticket belongs to, as the ticket names it. */
export const projectLabel = (t: OpenThread): string => t.folder || (t.cwd === '' ? 'No folder' : t.cwd.split('/').filter(Boolean).at(-1) ?? t.cwd);

/** Reads a ticket back from a drag's data; null for anything that is not one. */
export function readDragged(raw: string, known: readonly OpenThread[]): OpenThread | null {
  try {
    const id = (JSON.parse(raw) as { id?: unknown }).id;
    return typeof id === 'string' ? known.find((t) => t.id === id) ?? null : null;
  } catch {
    return null;
  }
}
