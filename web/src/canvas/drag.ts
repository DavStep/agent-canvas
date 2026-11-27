// Dragging on the canvas: pointer tracking with a click threshold, the zone under a dropped card,
// and layout ops shown before the reader confirms them (so nothing snaps back on release).
import type { Layout, LayoutOp } from '../../../shared/types.ts';
import { applyLayoutOp } from '../../../server/layoutOps.ts';

/** A press that moves less than this far (screen px) is a click. */
export const DRAG_THRESHOLD = 4;

export const isDrag = (dx: number, dy: number): boolean => Math.hypot(dx, dy) >= DRAG_THRESHOLD;

export interface DragHandlers {
  /** Card and zone drags only need the latest hit test and translation per display frame. */
  frameMoves?: boolean;
  /** Screen-pixel offset from the press, once the press has become a drag. */
  onMove(dx: number, dy: number, e: PointerEvent): void;
  onDrop(dx: number, dy: number, e: PointerEvent): void;
  onCancel?(): void;
}

/** Swallows the click the browser sends after a drag ends, so a dragged card is not also selected. */
function swallowNextClick(): void {
  const stop = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

/** Follows one pointer from `down` until release, capturing it on `el`. */
export function trackDrag(down: PointerEvent, el: Element, h: DragHandlers): void {
  const id = down.pointerId;
  let dragging = false;
  let pending: PointerEvent | null = null;
  let frame: number | null = null;
  try { el.setPointerCapture(id); } catch { /* the pointer is already gone */ }

  const offset = (e: PointerEvent) => [e.clientX - down.clientX, e.clientY - down.clientY] as const;
  const paint = (e: PointerEvent) => {
    const [dx, dy] = offset(e);
    h.onMove(dx, dy, e);
  };
  const end = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    pending = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', abandon);
    el.removeEventListener('lostpointercapture', lost);
    try { el.releasePointerCapture(id); } catch { /* released already */ }
  };
  function move(e: PointerEvent) {
    if (e.pointerId !== id) return;
    const [dx, dy] = offset(e);
    if (!dragging && !isDrag(dx, dy)) return;
    if (!dragging || !h.frameMoves) {
      dragging = true;
      h.onMove(dx, dy, e);
      return;
    }
    pending = e;
    frame ??= requestAnimationFrame(() => {
      frame = null;
      if (pending) paint(pending);
      pending = null;
    });
  }
  function up(e: PointerEvent) {
    if (e.pointerId !== id) return;
    end();
    if (!dragging) return;
    swallowNextClick();
    const [dx, dy] = offset(e);
    h.onDrop(dx, dy, e);
  }
  function cancel(e: PointerEvent) {
    if (e.pointerId !== id) return;
    abandon();
  }
  function abandon() {
    end();
    if (dragging) h.onCancel?.();
  }
  function lost(e: Event) {
    if ((e as PointerEvent).pointerId === id) abandon();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', abandon);
  el.addEventListener('lostpointercapture', lost);
}

export interface ZoneRect { id: string; x: number; y: number; width: number; height: number }

/** The zone under a canvas point; where zones overlap, the one drawn last (on top). */
export function zoneAt(p: { x: number; y: number }, rects: ZoneRect[]): string | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]!;
    if (p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height) return r.id;
  }
  return null;
}

/** A layout op sent to the reader and shown at once. `settled` once the reader has answered. */
export interface PendingOp { seq: number; op: LayoutOp; settled: boolean }

export function layoutWithPending(layout: Layout, pending: PendingOp[]): Layout {
  return pending.reduce((l, p) => applyLayoutOp(l, p.op), layout);
}

const shows = (layout: Layout, op: LayoutOp): boolean =>
  JSON.stringify(applyLayoutOp(layout, op)) === JSON.stringify(layout);

/**
 * The ops still worth showing after a new snapshot: drop those the snapshot already shows, and
 * those the reader had answered before it came (it changed nothing, or something else won).
 */
export function reconcilePending(pending: PendingOp[], layout: Layout): PendingOp[] {
  const next = pending.filter((p) => !p.settled && !shows(layout, p.op));
  return next.length === pending.length ? pending : next;
}
