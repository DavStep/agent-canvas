// "Tidy canvas": every zone drawn is packed again into rows shaped like the canvas, in the order
// the owner reads them now, and the positions they had are kept so the change can be undone.
import type { Layout, LayoutOp } from '../../../shared/types.ts';
import { placeZones, rowWidthFor } from './placeZones.ts';
import type { ZoneBox } from './resolveOverlaps.ts';

type Point = { x: number; y: number };
export interface ZoneMove { id: string; from: Point; to: Point }

/**
 * Zone ids top to bottom, and left to right within a row. A zone whose top is above the middle
 * of the first zone in the current row belongs to that row, so zones set roughly side by side
 * stay in left-to-right order even when their tops differ a little.
 */
export function readingOrder(boxes: ZoneBox[]): string[] {
  const byTop = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: string[] = [];
  let row: ZoneBox[] = [];
  const flush = () => { out.push(...row.sort((a, b) => a.x - b.x).map((b) => b.id)); row = []; };
  for (const box of byTop) {
    if (row.length > 0 && box.y >= row[0]!.y + row[0]!.h / 2) flush();
    row.push(box);
  }
  flush();
  return out;
}

/**
 * The moves that tidy the zones drawn at `boxes` (drawn positions and sizes): packed from the
 * canvas origin in reading order, rows as wide as `aspect` (the canvas's width over its height)
 * suggests. `saved` gives each zone's saved position, which an undo goes back to; a zone with
 * none goes back to where it was drawn. Zones already where they would go are left out.
 */
export function tidyMoves(boxes: ZoneBox[], saved: Map<string, Point | null>, aspect: number): ZoneMove[] {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const zones = readingOrder(boxes).map((id) => ({ id, x: null, y: null }));
  const sizes = new Map(boxes.map((b) => [b.id, { w: b.w, h: b.h }]));
  const placed = placeZones(zones, sizes, rowWidthFor(zones, sizes, aspect));
  const moves: ZoneMove[] = [];
  for (const { id } of zones) {
    const box = byId.get(id)!;
    const to = placed.get(id)!;
    const from = saved.get(id) ?? { x: box.x, y: box.y };
    if (from.x === to.x && from.y === to.y && box.x === to.x && box.y === to.y) continue;
    moves.push({ id, from, to });
  }
  return moves;
}

export const tidyOps = (moves: ZoneMove[]): LayoutOp[] =>
  moves.map((m) => ({ type: 'moveZone', id: m.id, x: m.to.x, y: m.to.y }));

/**
 * The ops that put tidied zones back. A zone the owner has moved since (or that is gone) keeps
 * where it is now, so an undo never throws away a later drag.
 */
export function undoOps(moves: ZoneMove[], layout: Layout): LayoutOp[] {
  const ops: LayoutOp[] = [];
  for (const m of moves) {
    const zone = layout.zones.find((z) => z.id === m.id);
    if (!zone || zone.x !== m.to.x || zone.y !== m.to.y) continue;
    ops.push({ type: 'moveZone', id: m.id, x: m.from.x, y: m.from.y });
  }
  return ops;
}
