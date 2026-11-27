// Board objects keep their local grab point through zoom, pan and zone reflow.
// Translations are temporary. Only the drop handler changes the saved placement.
import { flushSync } from 'react-dom';
import { CARD_GLIDE_EASING, CARD_GLIDE_MS } from './cardGlide.ts';
import { trackDrag } from './drag.ts';
import type { PanZoom } from './usePanZoom.ts';

interface Point { x: number; y: number }
interface Corner { left: number; top: number }

export function localPoint(pointer: Point, origin: Corner, zoom: number): Point {
  return { x: (pointer.x - origin.left) / zoom, y: (pointer.y - origin.top) / zoom };
}

export function heldAt(pointer: Point, board: Corner, zoom: number, grip: Point): Point {
  const point = localPoint(pointer, board, zoom);
  return { x: point.x - grip.x, y: point.y - grip.y };
}

interface HeldFrame { event: PointerEvent; grip: Point; at: Point; zoom: number }
interface HoldOptions {
  board: HTMLElement;
  view: PanZoom;
  // Floating preview windows are in the workspace, outside the scaled board.
  screenTranslation?: boolean;
  canPanAt?(event: PointerEvent): boolean;
  onLift?(): void;
  onFrame(frame: HeldFrame): void;
  afterPaint?(): void;
  onDrop(frame: HeldFrame): void;
  onCancel(): void;
}

const glideId = 'board-item-glide';

export function holdItem(down: PointerEvent, capture: Element, el: HTMLElement, options: HoldOptions): void {
  const { board, view } = options;
  const rect = el.getBoundingClientRect();
  const grip = localPoint({ x: down.clientX, y: down.clientY }, rect, rect.width / el.offsetWidth || view.transform.k);
  let last = down;
  let previousFrame = down.timeStamp;
  let frame = 0;
  let unwatch: (() => void) | undefined;
  let offset: Point = { x: 0, y: 0 };

  function paint(event: PointerEvent): HeldFrame {
    const zoom = view.transform.k;
    const pointer = { x: event.clientX, y: event.clientY };
    const origin = board.getBoundingClientRect();
    const at = heldAt(pointer, origin, zoom, grip);
    const current = el.getBoundingClientRect();
    const scale = options.screenTranslation ? 1 : zoom;
    // The parent may itself have moved since the last frame. Correct from the drawn corner.
    offset = {
      x: offset.x + (pointer.x - grip.x * zoom - current.left) / scale,
      y: offset.y + (pointer.y - grip.y * zoom - current.top) / scale,
    };
    const held = { event, grip, at, zoom };
    options.onFrame(held);
    el.style.translate = `${offset.x}px ${offset.y}px`;
    options.afterPaint?.();
    return held;
  }
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(now => {
      frame = 0;
      // A camera move schedules the next frame via watch, even when the pointer stays still.
      if (el.isConnected && options.canPanAt?.(last) !== false) view.panAtEdge(last, Math.max(1, now - previousFrame));
      previousFrame = now;
      paint(last);
    });
  }
  function finish() {
    cancelAnimationFrame(frame);
    unwatch?.();
    el.classList.remove('is-lifted');
  }
  trackDrag(down, capture, {
    onMove: (_dx, _dy, event) => {
      last = event;
      if (!unwatch) {
        for (const a of el.getAnimations()) if (a.id === glideId) a.cancel();
        el.dataset.moved = '';
        el.style.translate = '';
        el.classList.add('is-lifted');
        view.hold();
        options.onLift?.();
        unwatch = view.watch(schedule);
      }
      schedule();
    },
    onDrop: (_dx, _dy, event) => {
      // A fast release can cross a zone after the last animation frame. Draw its final
      // slot before the drop handler reads it. Only release flushes React.
      const held = flushSync(() => paint(event));
      finish();
      options.onDrop(held);
    },
    onCancel: () => { finish(); el.style.translate = ''; options.onCancel(); },
  });
}

/** Clear the hand's offset before measuring its new slot, including under reduced motion. */
export function glideFrom(el: HTMLElement, from: Corner, zoom: number): Animation | null {
  el.style.translate = '';
  if (!el.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const to = el.getBoundingClientRect();
  const dx = (from.left - to.left) / zoom;
  const dy = (from.top - to.top) / zoom;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  return el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }],
    { id: glideId, duration: CARD_GLIDE_MS, easing: CARD_GLIDE_EASING });
}
