// Where things are on the board, read from the DOM: the zone under a screen point, a screen point
// in board coordinates, and the board rectangles of images (for Fit and for search's jump).
import type { DOMRectLike } from '../canvas/usePanZoom.ts';

/** The zone under a screen point; `keep` stays chosen while the point is still on it, so a zone
    growing or shrinking under the hand does not flicker (as the board preview's drag does). */
export function zoneUnder(root: ParentNode, x: number, y: number, keep: string | null): HTMLElement | null {
  const els = [...root.querySelectorAll<HTMLElement>('.zone[data-zone-id]')];
  const inside = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; };
  const kept = keep === null ? undefined : els.find((el) => el.dataset.zoneId === keep);
  return kept && inside(kept) ? kept : els.reverse().find(inside) ?? null;
}

/** A screen point on the board (canvas px); the board's origin is canvas (0, 0). */
export function toBoard(board: HTMLElement, x: number, y: number, k: number): { x: number; y: number } {
  const o = board.getBoundingClientRect();
  return { x: (x - o.left) / k, y: (y - o.top) / k };
}

const rectOf = (board: HTMLElement, el: HTMLElement, k: number): DOMRectLike => {
  const o = board.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: (r.left - o.left) / k, y: (r.top - o.top) / k, width: r.width / k, height: r.height / k };
};

/** An image's rectangle on the board, or null when it is not drawn. */
export function itemRect(board: HTMLElement, id: string, k: number): DOMRectLike | null {
  const el = board.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
  return el ? rectOf(board, el, k) : null;
}

/** The rectangles of the images free on the board (those in zones are inside their zone's). */
export const freeItemRects = (board: HTMLElement, k: number): DOMRectLike[] =>
  [...board.querySelectorAll<HTMLElement>('.board-item-free > [data-item-id]')].map((el) => rectOf(board, el, k));
