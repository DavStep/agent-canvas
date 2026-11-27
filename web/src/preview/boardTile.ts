// The board preview while it is in the hand: where it is over, and its size while resized. Kept
// outside React state so the pointer moving re-renders only the zones involved, not the app.
import { useSyncExternalStore } from 'react';

export interface TileLive {
  /** The zone the tile belongs to. */
  home: string;
  /** While moved: the zone it is over and its top-left in that zone's cards area (canvas px),
      or null over no zone. Absent while not moved. */
  over?: { zone: string; x: number; y: number; width: number; height: number } | null;
  /** While resized: its size now. */
  size?: { width: number; height: number };
}

let live: TileLive | null = null;
const listeners = new Set<() => void>();

export const tileLive = {
  get: (): TileLive | null => live,
  set(next: TileLive | null): void {
    live = next;
    for (const l of listeners) l();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** The live tile when it concerns this zone (its home, or the zone it is over), else null. */
export function useTileLive(zone: string): TileLive | null {
  return useSyncExternalStore(tileLive.subscribe, () => {
    const t = live;
    return t && (t.home === zone || t.over?.zone === zone) ? t : null;
  }, () => null);
}
