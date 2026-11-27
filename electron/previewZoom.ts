// Zoom over the Browser tab's page belongs to the canvas. The page is a native view of its own, so
// a ⌘/Ctrl wheel or a pinch over it never reaches the canvas page, and ⌘= / ⌘- / ⌘0 with it focused
// would zoom the page itself. Its only preload (previewPreload.cts) catches the wheels and stops them
// there; the keys are stopped here before the page or the menu sees them. Both go to the canvas page
// in its own coordinates, where the canvas zooms as it does over itself. The page never zooms.

import type { Rect } from './preview.ts';

/** The guest preload's one message: a ⌘/Ctrl (or pinch) wheel, in the page's CSS pixels. */
export const PREVIEW_ZOOM_WHEEL = 'preview:zoomWheel';

export interface GuestWheel { x: number; y: number; dx: number; dy: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

/** Where the page sits: its view's bounds in window points, its zoom factor, and the canvas page's. */
export interface Placement extends Rect { zoom: number; hostZoom: number; visible?: Rect }

export type HostZoom =
  | ({ kind: 'wheel' } & GuestWheel)
  | { kind: 'key'; key: 'in' | 'out' | 'reset'; x: number; y: number };

const finite = (n: unknown, limit: number): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit;

/** The page's message, or null when it is not one (the page itself cannot send it, but checked anyway). */
export function parseGuestWheel(value: unknown): GuestWheel | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (![v.x, v.y].every((n) => finite(n, 1e6)) || ![v.dx, v.dy].every((n) => finite(n, 1e5))) return null;
  if (typeof v.ctrlKey !== 'boolean' || typeof v.metaKey !== 'boolean' || typeof v.shiftKey !== 'boolean') return null;
  if (!v.ctrlKey && !v.metaKey) return null;
  return { x: v.x as number, y: v.y as number, dx: v.dx as number, dy: v.dy as number, ctrlKey: v.ctrlKey, metaKey: v.metaKey, shiftKey: v.shiftKey };
}

/** The wheel in the canvas page's CSS pixels: page pixels are `zoom` window points, the canvas's `hostZoom`. */
export function hostWheel(w: GuestWheel, p: Placement): HostZoom {
  const k = p.zoom / p.hostZoom;
  return { ...w, kind: 'wheel', x: (p.x + w.x * p.zoom) / p.hostZoom, y: (p.y + w.y * p.zoom) / p.hostZoom, dx: w.dx * k, dy: w.dy * k };
}

interface Key { type: string; key: string; meta: boolean; control: boolean; alt: boolean }

/** ⌘/Ctrl with =, +, -, _ or 0 (the menu's zoom keys), as a canvas zoom; null for anything else. */
export function zoomKey(input: Key): 'in' | 'out' | 'reset' | null {
  if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return null;
  if (input.key === '=' || input.key === '+') return 'in';
  if (input.key === '-' || input.key === '_') return 'out';
  if (input.key === '0') return 'reset';
  return null;
}

/** The part of a WebContents this needs (a fake stands in for it in tests). */
export interface ZoomGuest {
  setVisualZoomLevelLimits(min: number, max: number): Promise<void>;
  on(event: 'before-input-event', listener: (e: { preventDefault(): void }, input: Key) => void): unknown;
  ipc: { on(channel: string, listener: (e: unknown, value: unknown) => void): unknown };
}

/** Wires one preview page: no pinch zoom of its own, its zoom keys and wheels to the canvas. */
export function forwardPreviewZoom(guest: ZoomGuest, placement: () => Placement | null, send: (z: HostZoom) => void): void {
  guest.setVisualZoomLevelLimits(1, 1).catch(() => {});
  guest.on('before-input-event', (e, input) => {
    const key = zoomKey(input);
    if (key === null) return;
    e.preventDefault();
    const p = placement();
    if (p) {
      const rect = p.visible ?? p;
      send({ kind: 'key', key, x: (rect.x + rect.width / 2) / p.hostZoom, y: (rect.y + rect.height / 2) / p.hostZoom });
    }
  });
  // WebContents.ipc hears this page only.
  guest.ipc.on(PREVIEW_ZOOM_WHEEL, (_e, value) => {
    const w = parseGuestWheel(value);
    const p = placement();
    if (w && p) send(hostWheel(w, p));
  });
}
