// Card slots: where each session card sits in its zone, kept in the saved layout so a card stays
// put through state changes and new activity. A zone's slots are its columns, each the card ids
// from top to bottom, and the "Earlier" fold: idle cards folded away at the end of the zone.
// An id whose session is not in the zone now is a hole: nothing is drawn there, a new card may
// take it, and the session reclaims it if it comes back first. The page decides the slots
// (web/src/canvas/cardSlots.ts); the reader only keeps them, through the setSlots layout op.
// Pure, and safe for the sandboxed preload: no `node:` imports.
import type { Layout } from './types.ts';

export interface ZoneSlots {
  /** The zone's columns, left to right; each its card ids top to bottom. */
  columns: string[][];
  /** Cards folded into "Earlier" at the end of the zone, in the order they were folded. */
  earlier: string[];
}

export type SlotOp = { type: 'setSlots'; zoneId: string; slots: ZoneSlots | null };

/** As many columns as a zone draws, with room to spare. */
export const MAX_SLOT_COLUMNS = 12;
/** Ids kept per zone, holes included. */
export const MAX_ZONE_SLOTS = 600;
const MAX_ID = 512;
const MAX_ZONES = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_ID;
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_ZONE_SLOTS && v.every(isId);

/** A sent or saved zone's slots, or null when malformed. */
export function isZoneSlots(v: unknown): v is ZoneSlots {
  return isRecord(v) && Array.isArray(v.columns) && v.columns.length <= MAX_SLOT_COLUMNS
    && v.columns.every(isIdList) && isIdList(v.earlier);
}

/** Each id once (its first place wins), within the limits; trailing empty columns dropped. */
export function cleanZoneSlots(slots: ZoneSlots): ZoneSlots {
  const seen = new Set<string>();
  const keep = (id: string): boolean => {
    if (seen.has(id) || seen.size >= MAX_ZONE_SLOTS) return false;
    seen.add(id);
    return true;
  };
  const columns = slots.columns.slice(0, MAX_SLOT_COLUMNS).map((col) => col.filter(keep));
  while (columns.length > 0 && columns[columns.length - 1]!.length === 0) columns.pop();
  return { columns, earlier: slots.earlier.filter(keep) };
}

export const sameSlots = (a: ZoneSlots | undefined, b: ZoneSlots | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A sent op as the reader takes it, or null when it is malformed. */
export function parseSlotOp(v: Record<string, unknown>): SlotOp | null {
  if (v.type !== 'setSlots' || !isId(v.zoneId)) return null;
  if (v.slots === null) return { type: 'setSlots', zoneId: v.zoneId, slots: null };
  if (!isZoneSlots(v.slots)) return null;
  return { type: 'setSlots', zoneId: v.zoneId, slots: { columns: v.slots.columns.map((c) => [...c]), earlier: [...v.slots.earlier] } };
}

/** setSlots on a layout: a zone's slots replaced, or (null) forgotten. */
export function applySlotOp(layout: Layout, op: SlotOp): Layout {
  if (!isId(op.zoneId)) return layout;
  const all = layout.slots ?? {};
  if (op.slots === null) {
    if (!(op.zoneId in all)) return layout;
    const { [op.zoneId]: _gone, ...rest } = all;
    return { ...layout, slots: rest };
  }
  if (!isZoneSlots(op.slots)) return layout;
  const next = cleanZoneSlots(op.slots);
  if (sameSlots(all[op.zoneId], next)) return layout;
  if (!(op.zoneId in all) && Object.keys(all).length >= MAX_ZONES) return layout;
  return { ...layout, slots: { ...all, [op.zoneId]: next } };
}

/** A layout as loaded from disk, with its slots cleaned: a damaged zone's slots are dropped, never the layout. */
export function withCleanSlots(layout: Layout): Layout {
  if (layout.slots === undefined) return layout;
  const slots: Record<string, ZoneSlots> = {};
  if (isRecord(layout.slots)) {
    for (const [id, s] of Object.entries(layout.slots).slice(0, MAX_ZONES)) if (isId(id) && isZoneSlots(s)) slots[id] = cleanZoneSlots(s);
  }
  return { ...layout, slots };
}

/** A deleted zone's slots go with it. */
export function dropSlots(layout: Layout, zoneId: string): Layout {
  if (!layout.slots || !(zoneId in layout.slots)) return layout;
  const { [zoneId]: _gone, ...rest } = layout.slots;
  return { ...layout, slots: rest };
}
