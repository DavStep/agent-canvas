// A zone's cards flowing around several tiles at once: the board preview (zoneFlow.ts) and the
// images kept in the zone. The rules are zoneFlow's, for more than one tile: each tile has a
// first column and a top in the zone's grid and spans the columns its width needs; a card that
// would overlap a tile goes below it; a tile's top is pulled up to the bottom of whatever is above
// it in its columns; and tiles never overlap each other (a later one goes below). With no image
// the zone flows exactly as zoneFlow's flowCards has it.
import { CARD_GAP, columnsFor, type StackItem } from '../canvas/stackCards.ts';
import { COLUMN_STEP, flowCards, tileSpan, type FlowEntry, type TileBox, type TileSlot, type ZoneFlow } from '../canvas/zoneFlow.ts';

/** A thread names its source card so the two are placed together in adjacent columns. */
export interface ItemTile extends TileBox { id: string; beside?: string }
export type PlacedTile = TileSlot & { span: number };

interface Tile { id: string; col: number; span: number; top: number; height: number }
interface Placed { id: string; y: number; h: number }

const covers = (t: Tile, j: number): boolean => j >= t.col && j < t.col + t.span;
const shareColumns = (a: Tile, b: Tile): boolean => a.col < b.col + b.span && b.col < a.col + a.span;
// A collision moves the pair to a tile’s bottom. Scanning in bottom-edge order means that
// even overlapping obstacles in adjacent columns can never move it back into a checked tile.
const byBottom = (a: Tile, b: Tile): number => (a.top + a.height) - (b.top + b.height);
const byTop = (a: Tile, b: Tile): number => a.top - b.top || a.col - b.col;

/** Every card into the shortest of the card columns, below any tile it would overlap. */
function place(items: StackItem[], count: number, cols: number, tiles: Tile[], threads = new Map<string, ItemTile[]>()): Placed[][] {
  const columns: Placed[][] = Array.from({ length: cols }, () => []);
  const next = new Array<number>(cols).fill(0);
  const sorted = [...tiles].sort(byBottom);
  for (const item of items) {
    const notes = threads.get(item.id) ?? [];
    const stackHeight = notes.reduce((sum, note, i) => sum + note.height + (i ? CARD_GAP : 0), 0);
    let best = -1;
    let bestY = Infinity;
    // A card with a slot stays in its column; the others take the shortest.
    for (let j = item.col ?? 0; j < (item.col === undefined ? count : item.col + 1); j++) {
      const start = next[j]!;
      let y = notes.length ? Math.max(start, next[j + 1] ?? 0) : start;
      // A spacer before the card has its own CSS gap, even at zero height.
      if (y > start) y = Math.max(y, start + CARD_GAP);
      for (const t of sorted) {
        const clearance = Math.max(covers(t, j) ? item.cardH : 0, covers(t, j + 1) ? stackHeight : 0);
        if (clearance <= 0) continue;
        const below = t.top + t.height + CARD_GAP;
        if (y < below && y + clearance + CARD_GAP > t.top) y = Math.max(below, start + CARD_GAP);
      }
      if (y < bestY) { best = j; bestY = y; }
    }
    columns[best]!.push({ id: item.id, y: bestY, h: item.cardH });
    next[best] = bestY + item.cardH + CARD_GAP;
    if (notes.length) {
      const col = best + 1;
      columns[col] ??= [];
      let top = bestY;
      for (const note of notes) {
        const tile = { id: note.id, col, span: 1, top, height: note.height };
        tiles.push(tile);
        sorted.push(tile);
        top += note.height + CARD_GAP;
      }
      // Later cards may still fit above the stack in its column.
      sorted.sort(byBottom);
    }
  }
  return columns;
}

/** Tiles pushed down below earlier ones they would overlap. */
function separate(tiles: Tile[]): Tile[] {
  const out: Tile[] = [];
  for (const t of [...tiles].sort(byTop)) {
    let top = t.top;
    for (let moved = true; moved;) {
      moved = false;
      for (const o of out) {
        if (!shareColumns(t, o)) continue;
        const clear = o.top + o.height + CARD_GAP;
        if (top < clear && top + t.height + CARD_GAP > o.top) { top = clear; moved = true; }
      }
    }
    out.push({ ...t, top });
  }
  return out;
}

/**
 * The zone's columns with every tile placed, and where each tile is drawn. A tile's column is kept
 * within reach of what is already there: at most one past the last column cards or tiles use.
 */
export function flowTiles(items: StackItem[], boxes: ItemTile[]): { columns: FlowEntry[][]; tiles: Map<string, PlacedTile> } {
  const count = columnsFor(items);
  let reach = count;
  const raw: Tile[] = [];
  const threads = new Map<string, ItemTile[]>();
  const sources = new Set(items.map((item) => item.id));
  for (const b of [...boxes].sort((a, c) => a.col - c.col || a.top - c.top)) {
    if (b.beside && sources.has(b.beside)) {
      const stack = threads.get(b.beside) ?? [];
      stack.push(b);
      threads.set(b.beside, stack);
      continue;
    }
    const span = tileSpan(b.width);
    const col = Math.max(0, Math.min(reach, Math.round(b.col)));
    reach = Math.max(reach, col + span);
    raw.push({ id: b.id, col, span, top: Math.max(0, b.top), height: b.height });
  }
  const cols = Math.max(count, ...raw.map((t) => t.col + t.span));
  // Snap: each tile's top meets the lowest card or tile above it in the columns it covers.
  const first = place(items, count, cols, separate(raw));
  const snapped: Tile[] = [];
  for (const t of separate(raw)) {
    let edge = 0;
    for (let j = t.col; j < t.col + t.span; j++) {
      for (const c of first[j]!) if (c.y + c.h + CARD_GAP <= t.top) edge = Math.max(edge, c.y + c.h + CARD_GAP);
    }
    for (const o of snapped) {
      if (shareColumns(t, o) && o.top + o.height + CARD_GAP <= t.top) edge = Math.max(edge, o.top + o.height + CARD_GAP);
    }
    snapped.push({ ...t, top: edge });
  }
  const tiles = separate(snapped);
  const placed = place(items, count, cols, tiles, threads);
  const columns = placed.map((column, j): FlowEntry[] => {
    const mine = tiles.filter((t) => covers(t, j)).sort(byTop);
    const out: FlowEntry[] = [];
    // `cursor`: where the next entry would start; a gap before it makes the room a tile takes.
    let cursor = 0;
    for (const c of column) {
      if (c.y > cursor) out.push({ gap: Math.max(0, c.y - cursor - CARD_GAP) });
      out.push({ id: c.id });
      cursor = c.y + c.h + CARD_GAP;
    }
    const bottom = Math.max(...mine.map((t) => t.top + t.height));
    if (bottom > cursor - CARD_GAP) out.push({ gap: Math.max(0, bottom - cursor) });
    return out;
  });
  return { columns, tiles: new Map(tiles.map((t) => [t.id, { col: t.col, top: t.top, span: t.span }])) };
}

const PREVIEW = '\0preview';

/** zoneFlow's flow with the zone's images as further tiles: the preview's tile where flowCards
    would put it, and each image's place. Without images it is flowCards itself. */
export function flowZone(items: StackItem[], preview: TileBox | null, images: ItemTile[]): ZoneFlow & { items: Map<string, PlacedTile> } {
  if (images.length === 0) return { ...flowCards(items, preview), items: new Map() };
  const { columns, tiles } = flowTiles(items, preview ? [{ ...preview, id: PREVIEW }, ...images] : images);
  const tile = tiles.get(PREVIEW) ?? null;
  tiles.delete(PREVIEW);
  return { columns, tile, items: tiles };
}

/** The column a tile whose left edge is at `x` (in the cards area) lands in, given how many columns the zone draws now. */
export const itemColumnAt = (x: number, columns: number): number => Math.max(0, Math.min(columns, Math.round(x / COLUMN_STEP)));
