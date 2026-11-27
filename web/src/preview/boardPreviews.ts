import type { PreviewTab } from './PreviewPane.tsx';

export interface BoardPreview {
  session: string;
  zone: string;
  title: string;
  tab: PreviewTab | null;
  address: string | null;
  width: number;
  height: number;
  /** Its place in the zone's grid (zoneFlow.ts): first column and top. Saved before these
      existed, a preview takes the first slot, where it always sat. */
  col: number;
  top: number;
  open?: boolean;
}

export const BOARD_MIN = { width: 248, height: 200 };
export const BOARD_MAX = { width: 1600, height: 1200 };

const KEY = 'agent-canvas:board-previews';

/** A saved slot, or the first one for a preview saved without (or with a broken) slot. */
function slotOf(p: { col?: unknown; top?: unknown }): { col: number; top: number } {
  const ok = Number.isInteger(p.col) && (p.col as number) >= 0 && (p.col as number) <= 12
    && typeof p.top === 'number' && Number.isFinite(p.top) && p.top >= 0 && p.top <= 20_000;
  return ok ? { col: p.col as number, top: Math.round(p.top as number) } : { col: 0, top: 0 };
}

export function readBoardPreviews(): BoardPreview[] {
  try {
    const pins: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(pins)) return [];
    return pins.filter((p): p is Omit<BoardPreview, 'col' | 'top'> & Partial<BoardPreview> => p && typeof p.session === 'string' && typeof p.zone === 'string'
      && typeof p.title === 'string' && [null, 'browser', 'live', 'capture'].includes(p.tab)
      && (p.address === null || typeof p.address === 'string' && /^https?:\/\//i.test(p.address))
      && Number.isFinite(p.width) && p.width >= 248 && p.width <= 1600
      && Number.isFinite(p.height) && p.height >= 200 && p.height <= 1200)
      .map(p => ({ ...p, ...slotOf(p) }));
  } catch { return []; }
}

export function writeBoardPreviews(pins: BoardPreview[], open: string | null) {
  try { localStorage.setItem(KEY, JSON.stringify(pins.map(p => ({ ...p, open: p.session === open })))); } catch { /* Still usable for this window. */ }
}
