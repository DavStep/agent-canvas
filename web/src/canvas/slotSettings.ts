// How the canvas keeps its cards (web/src/canvas/cardSlots.ts): whether zones tidy themselves
// while the owner is away (off unless chosen), and after how long idle cards fold into "Earlier"
// (a day unless chosen; null never). Kept per window in localStorage, as Snap to grid is.
import { useSyncExternalStore } from 'react';
import { DEFAULT_FOLD_HOURS } from './cardSlots.ts';

export interface SlotSettings { autoTidy: boolean; foldAfterHours: number | null }

export const DEFAULT_SLOT_SETTINGS: SlotSettings = { autoTidy: false, foldAfterHours: DEFAULT_FOLD_HOURS };
/** The fold choices Settings offers, in hours; null is Never. */
export const FOLD_CHOICES: readonly (number | null)[] = [12, 24, 72, 168, null];

const KEY = 'agent-canvas.card-slots';
const listeners = new Set<() => void>();

const isFold = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 24 * 365);

/** The settings from their stored text; anything damaged reads as the default. */
export function parseSlotSettings(raw: string | null): SlotSettings {
  if (raw === null) return DEFAULT_SLOT_SETTINGS;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof SlotSettings, unknown>> | null;
    return {
      autoTidy: v?.autoTidy === true,
      foldAfterHours: v && 'foldAfterHours' in v && isFold(v.foldAfterHours) ? v.foldAfterHours : DEFAULT_FOLD_HOURS,
    };
  } catch {
    return DEFAULT_SLOT_SETTINGS;
  }
}

let cache: { raw: string | null; value: SlotSettings } | null = null;
export function readSlotSettings(): SlotSettings {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { /* none kept */ }
  if (cache?.raw !== raw) cache = { raw, value: parseSlotSettings(raw) };
  return cache.value;
}

export function setSlotSettings(patch: Partial<SlotSettings>): void {
  const next = { ...readSlotSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not kept */ }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** The settings, re-rendering when they change. */
export const useSlotSettings = (): SlotSettings => useSyncExternalStore(subscribe, readSlotSettings);
