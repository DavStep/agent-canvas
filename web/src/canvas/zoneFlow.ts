// A zone's cards flowing around a preview tile kept on the board. The tile takes a place in the
// zone's grid of 232 px columns: a first column and a top (canvas px inside the cards area), and
// spans as many columns as its width needs. Cards still fill the shortest column first, as
// stackCards does, but a card that would overlap the tile goes below it. The tile's top is
// pulled up to the bottom of the cards above it, so it never floats with a gap over its slot.

import { CARD_GAP, columnsFor, stackCards, type StackItem } from './stackCards.ts';

export const COLUMN_W = 232;
/** From one column's left edge to the next one's. */
export const COLUMN_STEP = COLUMN_W + CARD_GAP;
const MAX_COLUMNS = 5;

/** The tile's place in its zone: its first column and its top. */
export interface TileSlot { col: number; top: number }
export interface TileBox extends TileSlot { width: number; height: number }

/** One thing in a column: a card, or the room the tile takes there. */
export type FlowEntry = { id: string } | { gap: number };
export interface ZoneFlow {
  columns: FlowEntry[][];
  /** Where the tile is drawn (its slot, snapped), and how many columns it covers. */
  tile: (TileSlot & { span: number }) | null;
}

/** How many columns cards use, as stackCards lays them out. */
export const cardColumns = (n: number): number => (n === 0 ? 0 : Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(n))));

/** Columns a tile this wide covers, keeping a gap before the next column's cards. */
export const tileSpan = (width: number): number => Math.max(1, Math.ceil((width + CARD_GAP) / COLUMN_STEP - 1e-9));

/** The column a tile whose left edge is at `x` lands in; columns past the cards' are allowed
    only right beside them. */
export const columnAt = (x: number, n: number): number => Math.max(0, Math.min(cardColumns(n), Math.round(x / COLUMN_STEP)));

interface Placed { id: string; y: number; h: number }

/** Every card into its column, around the tile at `top`. */
function place(items: StackItem[], count: number, cols: number, tile: TileBox & { span: number }): Placed[][] {
  const columns: Placed[][] = Array.from({ length: cols }, () => []);
  const next = new Array<number>(cols).fill(0);
  const blocked = (j: number) => j >= tile.col && j < tile.col + tile.span;
  const below = tile.top + tile.height + CARD_GAP;
  for (const item of items) {
    let best = -1;
    let bestY = Infinity;
    // A card with a slot stays in its column; the others take the shortest.
    for (let j = item.col ?? 0; j < (item.col === undefined ? count : item.col + 1); j++) {
      let y = next[j]!;
      // It would not end a gap above the tile, and does not start below it: it goes below.
      if (blocked(j) && y < below && y + item.cardH + CARD_GAP > tile.top) y = below;
      if (y < bestY) { best = j; bestY = y; }
    }
    columns[best]!.push({ id: item.id, y: bestY, h: item.cardH });
    next[best] = bestY + item.cardH + CARD_GAP;
  }
  return columns;
}

/**
 * The zone's columns with the tile placed in them, or stackCards' columns when there is no tile.
 * The tile's column is kept within reach of the cards (at most one past their last column).
 */
export function flowCards(items: StackItem[], tile: TileBox | null): ZoneFlow {
  if (tile === null) return { columns: stackCards(items).map((c) => c.map((id) => ({ id }))), tile: null };
  const count = columnsFor(items);
  const span = tileSpan(tile.width);
  const col = Math.max(0, Math.min(count, Math.round(tile.col)));
  const cols = Math.max(count, col + span);
  const raw = { ...tile, col, span, top: Math.max(0, tile.top) };
  // Snap: the top of the tile meets the lowest card above it in the columns it covers.
  const above = (columns: Placed[][], top: number) => {
    let edge = 0;
    for (let j = col; j < col + span; j++) {
      for (const c of columns[j]!) if (c.y + c.h + CARD_GAP <= top) edge = Math.max(edge, c.y + c.h + CARD_GAP);
    }
    return edge;
  };
  const top = above(place(items, count, cols, raw), raw.top);
  const placed = place(items, count, cols, { ...raw, top });
  const columns = placed.map((column, j): FlowEntry[] => {
    if (j < col || j >= col + span) return column.map(({ id }) => ({ id }));
    const over = column.filter((c) => c.y < top);
    const under = column.filter((c) => c.y >= top);
    const last = over[over.length - 1];
    const start = last ? last.y + last.h + CARD_GAP : 0;
    return [...over.map(({ id }) => ({ id })), { gap: top + tile.height - start }, ...under.map(({ id }) => ({ id }))];
  });
  return { columns, tile: { col, top, span } };
}
