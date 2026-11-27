// Cards inside a zone: tidy 232 px columns, each card dropped into the shortest column.
// Only the cards' own heights count. A card with a column of its own (its saved slot,
// web/src/canvas/cardSlots.ts) goes there instead, in the order given, whatever the heights.

export interface StackItem { id: string; cardH: number; col?: number }

export const CARD_GAP = 12;
const MAX_COLUMNS = 5;

/** How many columns the cards use: as their slots say when they have them, else about √n. */
export function columnsFor(items: readonly StackItem[]): number {
  let last = -1;
  for (const item of items) if (item.col !== undefined) last = Math.max(last, item.col);
  if (last >= 0) return last + 1;
  return items.length === 0 ? 0 : Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(items.length)));
}

/** The zone's columns, each its card ids from top to bottom. */
export function stackCards(items: StackItem[]): string[][] {
  if (items.length === 0) return [];
  if (items.some((item) => item.col !== undefined)) {
    const fixed: string[][] = Array.from({ length: columnsFor(items) }, () => []);
    for (const item of items) fixed[item.col ?? 0]!.push(item.id);
    return fixed;
  }
  const count = Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(items.length)));
  const firstRow = items.slice(0, count);

  const columns = firstRow.map((item) => [item.id]);
  const heights = firstRow.map((item) => item.cardH);
  for (const item of items.slice(count)) {
    let target = 0;
    for (let i = 1; i < heights.length; i++) if (heights[i]! < heights[target]!) target = i;
    columns[target]!.push(item.id);
    heights[target]! += CARD_GAP + item.cardH;
  }
  return columns;
}
