// "Snap to grid": a dragged zone moves in whole grid steps, its corner landing in the middle of
// four dots. Kept per window in localStorage; the profile switch and the canvas share one store.
import { useSyncExternalStore } from 'react';

/** The dot grid's step in canvas px. Dots sit at 10 + 20n, so multiples of 20 lie between four. */
export const GRID = 20;

/** `v` (canvas px) to the nearest cell middle. */
export const snapToGrid = (v: number): number => Math.round(v / GRID) * GRID;

const KEY = 'agent-canvas.snap-to-grid';
const listeners = new Set<() => void>();

export function readSnap(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setSnap(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* not kept */ }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** Whether zones snap to the grid, re-rendering when the switch changes. */
export const useSnap = (): boolean => useSyncExternalStore(subscribe, readSnap);
