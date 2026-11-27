// Zoom over a board preview's page zooms the canvas. The page is a native view over this one, so
// its ⌘/Ctrl wheels and pinches never reach the canvas here; the main process hands them over in
// this page's coordinates (see electron/previewZoom.ts), and they are replayed on whatever is under
// that point, where the canvas's own wheel handling zooms about the pointer. ⌘= / ⌘- / ⌘0 with
// the page focused zoom the canvas in and out a step, or back to 100%. A preview that is not on
// the canvas (the chat's column) zooms nothing: its page just does not zoom.
import { useEffect, useRef, type RefObject } from 'react';
import type { PreviewZoom } from '../../../shared/bridge.ts';
import { previewBridge } from '../bridge.ts';
import type { PanZoom } from './usePanZoom.ts';

/** One ⌘= or ⌘- step. */
export const KEY_ZOOM_STEP = 1.25;

/** Replays one forwarded zoom on the canvas `canvas` (when the point is on it). */
export function applyPreviewZoom(z: PreviewZoom, canvas: HTMLElement, view: Pick<PanZoom, 'transform' | 'zoomTo'>): boolean {
  const under = document.elementFromPoint(z.x, z.y);
  if (!under || !canvas.contains(under)) return false;
  if (z.kind === 'wheel') {
    under.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: z.x, clientY: z.y,
      deltaX: z.dx, deltaY: z.dy, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: z.ctrlKey, metaKey: z.metaKey, shiftKey: z.shiftKey,
    }));
  } else {
    const k = view.transform.k;
    view.zoomTo(z.key === 'reset' ? 1 : z.key === 'in' ? k * KEY_ZOOM_STEP : k / KEY_ZOOM_STEP);
  }
  return true;
}

export function usePreviewZoom(canvas: RefObject<HTMLElement | null>, view: PanZoom): void {
  const latest = useRef(view);
  latest.current = view;
  useEffect(() => previewBridge.onZoom((z) => {
    if (canvas.current) applyPreviewZoom(z, canvas.current, latest.current);
  }), [canvas]);
}
