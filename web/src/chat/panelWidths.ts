// The chat screen's side columns (the rail and the preview) can be dragged wider or narrower.
// Widths are kept per window in localStorage and always leave the chat itself room.
import { useCallback, useEffect, useState } from 'react';

export type Panel = 'rail' | 'preview';
export interface PanelSpec { min: number; max: number; initial: number }

export const PANELS: Record<Panel, PanelSpec> = {
  rail: { min: 180, max: 480, initial: 240 },
  preview: { min: 280, max: 760, initial: 380 },
};
/** The narrowest the chat column may get while a side column grows. */
export const DESK_MIN = 380;
const KEY = 'agent-canvas.panel-widths';

export type Widths = Record<Panel, number>;

/** `want` for `panel`, inside its limits and leaving the desk room next to `other` in `viewport`. */
export function clampWidth(panel: Panel, want: number, other: number, viewport: number): number {
  const { min, max } = PANELS[panel];
  const room = viewport - other - DESK_MIN;
  return Math.round(Math.max(min, Math.min(max, room, want)));
}

/** Saved widths, or the defaults for anything missing or malformed. */
export function parseWidths(raw: string | null): Widths {
  const out: Widths = { rail: PANELS.rail.initial, preview: PANELS.preview.initial };
  if (raw === null) return out;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return out;
    for (const p of ['rail', 'preview'] as const) {
      const n = (v as Record<string, unknown>)[p];
      if (typeof n === 'number' && Number.isFinite(n)) out[p] = Math.max(PANELS[p].min, Math.min(PANELS[p].max, n));
    }
  } catch { /* defaults */ }
  return out;
}

function load(): Widths {
  try { return parseWidths(localStorage.getItem(KEY)); } catch { return parseWidths(null); }
}

export function usePanelWidths() {
  const [widths, setWidths] = useState<Widths>(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(widths)); } catch { /* not kept */ }
  }, [widths]);
  const set = useCallback((panel: Panel, want: number) => {
    setWidths((w) => {
      const other = panel === 'rail' ? w.preview : w.rail;
      const next = clampWidth(panel, want, other, window.innerWidth);
      return next === w[panel] ? w : { ...w, [panel]: next };
    });
  }, []);
  return { widths, set };
}
