// A board image while it is in the hand: the zone it is over (and where in that zone's cards
// area) or the board point it would land on, and its size while it is resized. Kept outside React
// state, as the board preview's tileLive is, so the pointer moving re-renders only the zones
// involved, not the app.
import { useSyncExternalStore } from 'react';

export interface ItemLive {
  id: string;
  /** The zone it belongs to now, or null for a free image. */
  home: string | null;
  /** While moved: the zone it is over, with its top-left in that zone's cards area (canvas px),
      or null over no zone. Absent while it is not moved. */
  over?: { zone: string; x: number; y: number; width: number; height: number } | null;
  /** Where it was drawn in its zone when picked up (its snapped slot), so it stays there meanwhile. */
  rest?: { col: number; top: number };
  /** While resized: its size now. */
  size?: { width: number; height: number };
}

let live: ItemLive | null = null;
const listeners = new Set<() => void>();

export const itemLive = {
  get: (): ItemLive | null => live,
  set(next: ItemLive | null): void {
    live = next;
    for (const l of listeners) l();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** The image in the hand when it concerns this zone (its home, or the zone it is over), else null. */
export function useItemLive(zone: string): ItemLive | null {
  return useSyncExternalStore(itemLive.subscribe, () => {
    const t = live;
    return t && (t.home === zone || t.over?.zone === zone) ? t : null;
  }, () => null);
}

/** The image in the hand, wherever it is. */
export function useAnyItemLive(): ItemLive | null {
  return useSyncExternalStore(itemLive.subscribe, () => live, () => null);
}

/** Where items just dropped were on screen, so they glide from there to their new place
    (FLIP, as cards do) instead of jumping. Taken once by the item drawn next. */
export const dropFrom = new Map<string, DOMRect>();
