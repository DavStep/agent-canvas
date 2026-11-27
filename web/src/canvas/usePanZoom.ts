// The view onto the canvas: one translate-and-scale transform over the board.
// Drag on empty canvas pans, and so does scrolling: a plain wheel moves the view up and down, a
// two-finger scroll moves it either way, and Shift + wheel moves it sideways. A pinch, or ⌘/Ctrl +
// wheel, zooms about the pointer. Holding Space turns any press on the canvas, on a card or a zone
// label too, into a pan, and nothing else. The view (never the layout) is remembered in this browser only.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { trackDrag } from './drag.ts';

export interface Transform { x: number; y: number; k: number }
export interface DOMRectLike { x: number; y: number; width: number; height: number }
type Size = { width: number; height: number };
type Point = { x: number; y: number };

export const MIN_K = 0.3;
export const MAX_K = 2;
export const FIT_MARGIN = 48;
/** The page's own first framing keeps the mockup's 16 px edge, so the mockup's board shows at 100%. */
const FRAME_MARGIN = 16;
const STORAGE_KEY = 'agent-canvas:view';
const SAVE_MS = 200;
/** A wheel notch from a mouse is about 100; a pinch frame is a few. Capped so one notch is a step, not a leap. */
const WHEEL_ZOOM = 0.01;
const MAX_WHEEL_DELTA = 25;
const LINE_PX = 16;

/** Presses that start here belong to something else (cards, zone labels, controls), not to panning. */
const NOT_PAN = '.card, .zone-label, button, input, textarea, a, [data-no-pan]';

/** Space typed into these is text or a control's own activation, never the pan key. */
const OWNS_SPACE = 'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"])';

/** Whether a Space press with focus on `target` holds the pan key: focus is on nothing, or on the canvas (and not in a control there). */
export function spacePans(target: EventTarget | null, canvas: Element): boolean {
  if (!(target instanceof Element) || target === document.body || target === document.documentElement) return true;
  return canvas.contains(target) && target.closest(OWNS_SPACE) === null;
}

export const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k));

/** Zoom to `k` (clamped) keeping the canvas point under screen point `p` where it is. */
export function zoomAbout(t: Transform, k: number, p: Point): Transform {
  const next = clampK(k);
  const ratio = next / t.k;
  return { x: p.x - (p.x - t.x) * ratio, y: p.y - (p.y - t.y) * ratio, k: next };
}

export interface Wheel { dx: number; dy: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

/** The view after one wheel event (deltas already in pixels) with the pointer at screen point `p`. */
export function wheelView(t: Transform, w: Wheel, p: Point): Transform {
  if (!w.ctrlKey && !w.metaKey) {
    // macOS turns a shift-scroll of a mouse wheel into deltaX; elsewhere it stays in deltaY.
    if (w.shiftKey) return { ...t, x: t.x - (w.dx !== 0 ? w.dx : w.dy) };
    return { ...t, x: t.x - w.dx, y: t.y - w.dy };
  }
  // A trackpad pinch arrives as a wheel with ctrlKey set.
  const step = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, w.dy));
  return zoomAbout(t, t.k * Math.exp(-step * WHEEL_ZOOM), p);
}

function union(rects: DOMRectLike[]): DOMRectLike | null {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The transform that shows every rect, centred, with a 48 px margin (by default) on the binding side. */
export function fitTransform(rects: DOMRectLike[], viewport: Size, maxK = MAX_K, margin = FIT_MARGIN): Transform | null {
  const box = union(rects);
  if (box === null) return null;
  const kx = (viewport.width - 2 * margin) / Math.max(box.width, 1);
  const ky = (viewport.height - 2 * margin) / Math.max(box.height, 1);
  const k = Math.min(clampK(Math.min(kx, ky)), maxK);
  return {
    x: (viewport.width - box.width * k) / 2 - box.x * k,
    y: (viewport.height - box.height * k) / 2 - box.y * k,
    k,
  };
}

/** The transform at zoom `k` that puts the middle of `rect` in the middle of the viewport. */
export function centerTransform(rect: DOMRectLike, viewport: Size, k: number): Transform {
  return {
    x: viewport.width / 2 - (rect.x + rect.width / 2) * k,
    y: viewport.height / 2 - (rect.y + rect.height / 2) * k,
    k,
  };
}

/** How long the view takes to travel to a place it was sent (Fit, a jump, the zoom reset). */
export const GLIDE_MS = 360;

/**
 * The view `p` (0 to 1, already eased) of the way from `from` to `to`. Zoom moves geometrically
 * and the offset follows it, so a canvas point that sits at the same screen point at both ends
 * (the middle of the viewport in a zoom reset) stays there the whole way.
 */
export function glideView(from: Transform, to: Transform, p: number): Transform {
  if (p >= 1) return to;
  if (from.k === to.k || from.k <= 0 || to.k <= 0) {
    return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p, k: to.k };
  }
  const k = from.k * Math.pow(to.k / from.k, p);
  const s = (k - from.k) / (to.k - from.k);
  return { x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s, k };
}

/** Fast out of the gate, long soft landing. */
const easeOutQuint = (p: number): number => 1 - Math.pow(1 - p, 5);

/** Whether the view should jump instead of travel: reduced motion, or a page nobody is looking at. */
const jumps = (): boolean =>
  typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  || document.visibilityState !== 'visible';

/** A remembered view, or null when there is none or it is not one. */
export function parseView(raw: string | null): Transform | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Transform>;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (!ok(v.x) || !ok(v.y) || !ok(v.k)) return null;
    return { x: v.x, y: v.y, k: clampK(v.k) };
  } catch {
    return null;
  }
}

function loadView(): Transform | null {
  try { return parseView(window.localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

function saveView(t: Transform): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(t)); } catch { /* storage blocked: the view is just not remembered */ }
}

export interface PanZoom {
  readonly transform: Transform;
  /** Pan while a held board item is just inside the viewport edge. */
  panAtEdge(pointer: PointerEvent, elapsedMs: number): void;
  /** Paint the current view on attachment and on each subsequent move. */
  watch(paint: (view: Transform) => void): () => void;
  /** Show every rect (canvas coordinates) with a 48 px margin. */
  fit(bounds: DOMRectLike[]): void;
  /** Zoom about the middle of the viewport. */
  zoomTo(k: number): void;
  /** Centre a rect (canvas coordinates) at the current zoom. */
  centerOn(rect: DOMRectLike): void;
  /** True until the owner moves the view and when none was remembered: the page frames the board itself. */
  pristine: boolean;
  /** The page's own framing while pristine: fit with a 16 px edge, never above 100%. Leaves `pristine` set. */
  frame(bounds: DOMRectLike[]): void;
  /** The owner is rearranging the board: the page stops framing it, so nothing else moves. */
  hold(): void;
}

export function usePanZoom(ref: RefObject<HTMLElement | null>): PanZoom {
  // View movement has only three consumers: the board transform, grid and zoom readout.
  // Keep it independent of React's session tree, including during animated Fit and jump.
  const [view] = useState(() => {
    const stored = loadView();
    const listeners = new Set<(t: Transform) => void>();
    const camera = {
      transform: stored ?? { x: 0, y: 0, k: 1 },
      pristine: stored === null,
      watch(paint: (t: Transform) => void) {
        listeners.add(paint);
        paint(camera.transform);
        return () => { listeners.delete(paint); };
      },
      paint(t: Transform) {
        camera.transform = t;
        for (const listener of listeners) listener(t);
      },
    };
    return camera;
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastMove = useRef(0);
  const remember = () => {
    lastMove.current = performance.now();
    if (saveTimer.current !== undefined) return;
    const saveWhenStill = () => {
      const remaining = SAVE_MS - (performance.now() - lastMove.current);
      if (remaining > 1) {
        saveTimer.current = setTimeout(saveWhenStill, remaining);
        return;
      }
      saveTimer.current = undefined;
      ref.current?.classList.remove('is-navigating');
      saveView(view.transform);
    };
    saveTimer.current = setTimeout(saveWhenStill, SAVE_MS);
  };
  useEffect(() => () => { clearTimeout(saveTimer.current); saveTimer.current = undefined; }, []);
  const set = (t: Transform) => {
    view.pristine = false;
    if (!ref.current?.classList.contains('is-navigating')) ref.current?.classList.add('is-navigating');
    view.paint(t);
    remember();
  };

  // Wheel and pointer input can arrive several times between two display refreshes.
  // Keep every delta, then publish the latest translation once before the frame paints.
  const pendingPan = useRef<Transform | null>(null);
  const panFrame = useRef<number | null>(null);
  const flushPan = () => {
    if (panFrame.current !== null) cancelAnimationFrame(panFrame.current);
    panFrame.current = null;
    if (pendingPan.current === null) return;
    const t = pendingPan.current;
    pendingPan.current = null;
    set(t);
  };
  const queuePan = (t: Transform) => {
    pendingPan.current = t;
    view.pristine = false;
    panFrame.current ??= requestAnimationFrame(flushPan);
  };

  // A view sent somewhere travels there. Where it is going is kept, so a second request made on
  // the way (zoom reset right after Fit) starts from the destination's zoom, and the owner's own
  // wheel or drag stops the trip where it is.
  const trip = useRef<{ frame: number; timer: ReturnType<typeof setTimeout>; to: Transform } | null>(null);
  const stop = useRef(() => {
    if (!trip.current) return;
    cancelAnimationFrame(trip.current.frame);
    clearTimeout(trip.current.timer);
    trip.current = null;
  }).current;
  useEffect(() => () => {
    stop();
    if (panFrame.current !== null) cancelAnimationFrame(panFrame.current);
    if (pendingPan.current) saveView(pendingPan.current);
    pendingPan.current = null;
    panFrame.current = null;
  }, [stop]);
  /** Where the view is, or where it is on its way to. */
  const heading = (): Transform => trip.current?.to ?? pendingPan.current ?? view.transform;
  const glide = (to: Transform) => {
    flushPan();
    stop();
    const from = view.transform;
    if (jumps() || (from.x === to.x && from.y === to.y && from.k === to.k)) { set(to); return; }
    const t0 = performance.now();
    const land = () => { stop(); set(to); };
    const step = (now: number) => {
      const p = (now - t0) / GLIDE_MS;
      if (p >= 1) { land(); return; }
      set(glideView(from, to, easeOutQuint(Math.max(0, p))));
      if (trip.current) trip.current.frame = requestAnimationFrame(step);
    };
    // Frames stop in a window that goes out of view; the timer lands the view regardless.
    trip.current = { frame: requestAnimationFrame(step), timer: setTimeout(land, GLIDE_MS + 120), to };
  };
  const viewport = (): Size => ({ width: ref.current?.clientWidth ?? 0, height: ref.current?.clientHeight ?? 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }): Point => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    // The page never scrolls or browser-zooms under the canvas: every wheel here is ours.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && e.target instanceof Element && e.target.closest('.preview-window .pv-panel')) return;
      e.preventDefault();
      const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientHeight : 1;
      const w = { dx: e.deltaX * scale, dy: e.deltaY * scale, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey };
      const p = w.ctrlKey || w.metaKey ? local(e) : { x: 0, y: 0 };
      stop();
      if (w.ctrlKey || w.metaKey) {
        flushPan();
        set(wheelView(view.transform, w, p));
      } else {
        queuePan(wheelView(pendingPan.current ?? view.transform, w, p));
      }
    };
    // Safari's own pinch gestures would zoom the page.
    const stopGesture = (e: Event) => e.preventDefault();

    // Space held: every press here pans, before a card or zone label can take it.
    let spaceHeld = false;
    let pannedWhileHeld = false;
    let spaceOn: Element | null = null;
    const showSpace = (on: boolean) => el.classList.toggle('is-space-pan', on);
    const release = () => {
      spaceHeld = false;
      showSpace(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!spaceHeld && (e.repeat || !spacePans(e.target, el))) return;
      // Keeps a focused card from opening on keydown; it opens on release if nothing panned.
      e.preventDefault();
      e.stopPropagation();
      if (spaceHeld) return;
      spaceHeld = true;
      pannedWhileHeld = false;
      spaceOn = e.target instanceof Element ? e.target : null;
      showSpace(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceHeld) return;
      e.preventDefault();
      e.stopPropagation();
      release();
      // A tap of Space on a focused card still opens it, as the card's own Space key did.
      if (!pannedWhileHeld && spaceOn instanceof HTMLElement && spaceOn.matches('.card') && el.contains(spaceOn)) spaceOn.click();
    };

    const pan = (e: PointerEvent) => {
      stop();
      const start = view.transform;
      el.classList.add('is-panning');
      const done = () => {
        flushPan();
        el.classList.remove('is-panning');
      };
      trackDrag(e, el, {
        onMove: (dx, dy) => queuePan({ ...start, x: start.x + dx, y: start.y + dy }),
        onDrop: (dx, dy) => {
          queuePan({ ...start, x: start.x + dx, y: start.y + dy });
          done();
        },
        onCancel: done,
      });
      // A press that never became a drag ends without onDrop.
      window.addEventListener('pointerup', done, { once: true });
    };
    const onPointerDownCapture = (e: PointerEvent) => {
      flushPan();
      if (!spaceHeld || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pannedWhileHeld = true;
      pan(e);
    };
    // A click while Space is held selects nothing.
    const onClickCapture = (e: MouseEvent) => {
      if (!spaceHeld) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (spaceHeld || e.button !== 0 || !(e.target instanceof Element) || e.target.closest(NOT_PAN)) return;
      pan(e);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', stopGesture);
    el.addEventListener('gesturechange', stopGesture);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerdown', onPointerDownCapture, true);
    el.addEventListener('click', onClickCapture, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', release);
    return () => {
      el.removeEventListener('pointerdown', onPointerDownCapture, true);
      el.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', release);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', stopGesture);
      el.removeEventListener('gesturechange', stopGesture);
      el.removeEventListener('pointerdown', onPointerDown);
    };
  }, [ref]);

  return {
    get transform() { return view.transform; },
    get pristine() { return view.pristine; },
    watch: view.watch,
    fit(bounds) {
      const t = fitTransform(bounds, viewport());
      if (t) glide(t);
    },
    frame(bounds) {
      const t = fitTransform(bounds, viewport(), 1, FRAME_MARGIN);
      if (!t || !view.pristine) return;
      stop();
      view.paint(t);
    },
    hold() {
      flushPan();
      stop();
      if (view.pristine) {
        view.pristine = false;
        remember();
      }
    },
    panAtEdge({ clientX, clientY }, elapsedMs) {
      flushPan();
      const bounds = ref.current?.getBoundingClientRect();
      if (!bounds || clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return;
      const edge = 32;
      const speed = (p: number, low: number, high: number) =>
        Math.max(0, 1 - (p - low) / edge) - Math.max(0, 1 - (high - p) / edge);
      // Screen pixels per millisecond. A delayed frame must not leap across the board.
      const step = 0.55 * Math.min(32, elapsedMs);
      const dx = speed(clientX, bounds.left, bounds.right) * step;
      const dy = speed(clientY, bounds.top, bounds.bottom) * step;
      if (dx || dy) set({ ...view.transform, x: view.transform.x + dx, y: view.transform.y + dy });
    },
    zoomTo(k) {
      const { width, height } = viewport();
      glide(zoomAbout(heading(), k, { x: width / 2, y: height / 2 }));
    },
    centerOn(rect) {
      glide(centerTransform(rect, viewport(), heading().k));
    },
  };
}
