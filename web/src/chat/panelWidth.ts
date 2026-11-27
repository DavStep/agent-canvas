// The chat panel's width: the default until the owner drags its left edge, then that width,
// remembered in localStorage. The page's CSS clamps it again as the window changes size.

export const PANEL_MIN = 380;
/** The canvas beside the panel never gets narrower than this. */
export const CANVAS_MIN = 320;
/** The page's gutters on that row: left of the canvas, between canvas and panel, right of the panel. */
export const GUTTERS = 24;
export const PANEL_DEFAULT_CSS = 'min(560px, 45vw)';
export const PANEL_WIDTH_KEY = 'agent-canvas:panel-width';
/** One arrow key press on the panel's edge. */
export const PANEL_STEP = 16;

/** A width the panel can take in a window `viewport` px wide; the panel's minimum wins when both cannot fit. */
export function clampPanelWidth(w: number, viewport: number): number {
  return Math.round(Math.max(PANEL_MIN, Math.min(w, viewport - CANVAS_MIN - GUTTERS)));
}

/** A remembered width, or null when there is none or it is not one. */
export function parsePanelWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** The value of the page's --panel-w. */
export function panelWidthCss(w: number | null): string {
  return w === null ? PANEL_DEFAULT_CSS : `${w}px`;
}

export function loadPanelWidth(): number | null {
  try { return parsePanelWidth(window.localStorage.getItem(PANEL_WIDTH_KEY)); } catch { return null; }
}

/** Remembers a width; null forgets it (back to the default). */
export function savePanelWidth(w: number | null): void {
  try {
    if (w === null) window.localStorage.removeItem(PANEL_WIDTH_KEY);
    else window.localStorage.setItem(PANEL_WIDTH_KEY, String(w));
  } catch { /* storage blocked: the width is just not remembered */ }
}
