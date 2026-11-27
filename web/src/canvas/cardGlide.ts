// Cards that stay on the canvas move to their new place; they are never hidden and shown again.
// React remounts a card when it changes column or zone, so after every render the board is read
// once: a card seen before glides from where it was drawn (FLIP: first, last, invert, play) and
// skips its entrance; a card not seen before keeps its entrance; a card that is gone leaves a copy
// of itself behind just long enough to play its exit. See docs/motion.md.

export interface Point { x: number; y: number }

/** How long a card takes to reach its new slot. */
export const CARD_GLIDE_MS = 320;
/** The CSS form of `ease` below, close enough that a glide interrupted mid-way does not jump. */
const EASING = 'cubic-bezier(.22, 1, .36, 1)';
export const CARD_GLIDE_EASING = EASING;
const ease = (p: number): number => 1 - Math.pow(1 - p, 5);
/** How long the leaving copy stays (the exit keyframes run --t-exit, 140 ms). */
const LEAVE_MS = 180;

/** Where a card was last laid out, and the glide it may still be on. */
interface Seen {
  el: HTMLElement;
  zone: string;
  /** Its zone's place on the board, and its own place inside the zone. */
  zx: number; zy: number; ox: number; oy: number;
  /** The offset it was being dragged by, when it was last read. */
  dragX: number; dragY: number;
  /** A glide in flight: the offset it started from, and when. */
  anim: Animation | null; fromX: number; fromY: number; t0: number;
}

/** How far a glide that began `from` away at `t0` still is from its end at `now`. */
export function glideLeft(from: Point, t0: number, now: number, duration = CARD_GLIDE_MS): Point {
  const p = (now - t0) / duration;
  if (!(p < 1)) return { x: 0, y: 0 };
  const left = 1 - ease(Math.max(0, p));
  return { x: from.x * left, y: from.y * left };
}

/**
 * The offset a card must start from so that it appears not to have moved: its old place minus its
 * new one. Inside one zone only the place within the zone counts (the zone carries its cards when
 * it moves); across zones the zones' own places count too.
 */
export function glideFrom(
  was: { zone: string; zx: number; zy: number; ox: number; oy: number },
  now: { zone: string; zx: number; zy: number; ox: number; oy: number },
): Point {
  if (was.zone === now.zone) return { x: was.ox - now.ox, y: was.oy - now.oy };
  return { x: was.zx + was.ox - (now.zx + now.ox), y: was.zy + was.oy - (now.zy + now.oy) };
}

const reduced = (): boolean =>
  typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The one-shot cues a card plays for its state; a card that only moved must not play them again. */
const CUES: [cls: string, cue: string][] = [['is-needs', 'needs'], ['is-done', 'done']];
const cuesOf = (el: HTMLElement): string[] => CUES.filter(([cls]) => el.classList.contains(cls)).map(([, cue]) => cue);
/** Parts of a card with their own small entrance. */
const PARTS = '.request-state .card-icon, .run-step.is-current, .sub-state .tick';

/** A card drawn again in a new element: it has been here all along, so nothing about it arrives. */
function markMoved(el: HTMLElement): void {
  el.dataset.moved = '';
  const cues = cuesOf(el);
  if (cues.length > 0) el.dataset.quiet = cues.join(' ');
  for (const part of el.querySelectorAll<HTMLElement>(PARTS)) part.dataset.still = '';
}

/** Once a card leaves a state, that state's cue may play the next time it is entered. */
function refreshQuiet(el: HTMLElement): void {
  const quiet = el.dataset.quiet;
  if (quiet === undefined) return;
  const now = new Set(cuesOf(el));
  const kept = quiet.split(' ').filter((cue) => now.has(cue));
  if (kept.length === 0) delete el.dataset.quiet;
  else if (kept.length !== quiet.split(' ').length) el.dataset.quiet = kept.join(' ');
}

/** Leaves a lifeless copy of a removed card where it stood, to play the exit, then takes it away. */
function leave(board: HTMLElement, seen: Seen, at: Point): void {
  const ghost = seen.el;
  seen.anim?.cancel();
  ghost.removeAttribute('data-card-id');
  ghost.removeAttribute('data-moved');
  ghost.removeAttribute('data-quiet');
  ghost.removeAttribute('tabindex');
  ghost.removeAttribute('aria-current');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.classList.remove('is-selected', 'is-dragging');
  ghost.classList.add('is-leaving');
  ghost.style.translate = '';
  ghost.style.left = `${at.x}px`;
  ghost.style.top = `${at.y}px`;
  board.appendChild(ghost);
  setTimeout(() => ghost.remove(), LEAVE_MS);
}

export interface CardGlide {
  /** The final hand position for the glide into the new slot. */
  releasedAt(id: string, x: number, y: number): void;
  /**
   * Reads every card on the board and moves, quiets or sees off each as needed. Call it after
   * every render that may have changed the board, before the browser paints; calling it again
   * with nothing changed does nothing.
   * @param zoneAt each drawn zone's place on the board (null while it waits for its first place)
   * @param drag the card in the hand and its offset, or null
   */
  run(board: HTMLElement, zoneAt: ReadonlyMap<string, Point | null>, drag: { id: string; x: number; y: number } | null): void;
}

export function createCardGlide(): CardGlide {
  let seen = new Map<string, Seen>();
  return {
    releasedAt(id, x, y) {
      const card = seen.get(id);
      if (card) { card.dragX = x; card.dragY = y; }
    },
    run(board, zoneAt, drag) {
      const now = performance.now();
      const still = reduced();
      const next = new Map<string, Seen>();
      for (const el of board.querySelectorAll<HTMLElement>('.card[data-card-id]')) {
        const id = el.dataset.cardId!;
        const zone = el.closest<HTMLElement>('.zone')?.dataset.zoneId;
        const at = zone === undefined ? null : zoneAt.get(zone) ?? null;
        const was = seen.get(id);
        // In a zone still waiting for its place: it is not gone, and where it was still stands.
        if (zone === undefined || at === null) { if (was) next.set(id, was); continue; }
        const held = drag?.id === id;
        const cur: Seen = {
          el, zone, zx: at.x, zy: at.y, ox: el.offsetLeft, oy: el.offsetTop,
          dragX: held ? drag.x : 0, dragY: held ? drag.y : 0, anim: null, fromX: 0, fromY: 0, t0: 0,
        };
        next.set(id, cur);
        if (!was) continue;
        if (was.el !== el) markMoved(el); else refreshQuiet(el);
        const moved = was.zone !== zone || was.ox !== cur.ox || was.oy !== cur.oy;
        if (!moved && !held) {
          if (was.el === el) { cur.anim = was.anim; cur.fromX = was.fromX; cur.fromY = was.fromY; cur.t0 = was.t0; }
          continue;
        }
        // Where it is drawn right now: its last slot, plus what is left of a glide, plus the hand.
        const left = was.anim ? glideLeft({ x: was.fromX, y: was.fromY }, was.t0, now) : { x: 0, y: 0 };
        was.anim?.cancel();
        if (held || still) continue;
        const from = glideFrom(was, cur);
        const dx = from.x + left.x + was.dragX;
        const dy = from.y + left.y + was.dragY;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        cur.anim = el.animate?.(
          [{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }],
          { duration: CARD_GLIDE_MS, easing: EASING },
        ) ?? null;
        cur.fromX = dx; cur.fromY = dy; cur.t0 = now;
      }
      // Gone from the board altogether: one last look, unless its whole zone went with it.
      if (!still) {
        for (const [id, was] of seen) {
          const at = zoneAt.get(was.zone);
          // Folded cards have already left with their section.
          if (was.el.closest('.zone-earlier-cards[inert]')) continue;
          if (!next.has(id) && at && !was.el.isConnected) leave(board, was, { x: at.x + was.ox, y: at.y + was.oy });
        }
      }
      seen = next;
    },
  };
}
