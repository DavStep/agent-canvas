// Where each card sits in its zone, kept as the zone's slots (shared/cardSlots.ts) so cards stay
// put: a state change, new activity or a card growing taller never moves a card to another slot.
// What does move them, and how little:
// - A new card takes the first free slot (a hole a card that left behind, in reading order),
//   else the end of the shortest column, or a new column when the zone is due one. Nothing else
//   moves, except the cards under a filled hole, by one card.
// - A card that leaves leaves a hole: the cards under it in its column close up, the rest stay.
// - Only while the owner is away (the window unfocused or hidden for a while) are holes and empty
//   columns cleared, idle cards untouched for long folded into "Earlier", and, when the owner
//   asked for it, the zone tidied. On app start idle cards are folded too, nothing else.
// - Tidy (on demand, with undo) re-orders a zone by recent activity; a drag puts a card in a slot.
// Layouts saved before slots existed keep the order they showed: it is frozen as the slots.
import type { SessionView } from '../../../shared/types.ts';
import { cleanZoneSlots, sameSlots, type ZoneSlots } from '../../../shared/cardSlots.ts';
import { sortCards } from '../order.ts';
import { stackCards } from './stackCards.ts';

export type { ZoneSlots };

/** As many columns as a zone's cards take (stackCards). */
export const MAX_COLUMNS = 5;
/** Folding after a day idle, unless the owner chose otherwise. */
export const DEFAULT_FOLD_HOURS = 24;

/** The columns a zone of n cards is given: about √n, at most five. */
export const columnsWanted = (n: number): number => (n === 0 ? 0 : Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(n))));

/** An idle session untouched for longer than `foldAfterMs` (null: never folds). */
export const isAged = (s: Pick<SessionView, 'state' | 'stateSince'>, now: number, foldAfterMs: number | null): boolean =>
  foldAfterMs !== null && s.state === 'idle' && now - s.stateSince > foldAfterMs;

/** Newest first: the latest start, then id, so equal starts keep one order. */
const newestFirst = (a: SessionView, b: SessionView): number =>
  b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** The latest activity first: the latest state change, then the latest start, then id. */
const recentFirst = (a: SessionView, b: SessionView): number => b.stateSince - a.stateSince || newestFirst(a, b);

/** A layout from before slots: the order it showed (state, then recency, in shortest-column
    stacks), frozen. `heightOf` is the card height the zone first draws with. */
export function migrateSlots(cards: SessionView[], heightOf: (s: SessionView) => number): ZoneSlots {
  return cleanZoneSlots({ columns: stackCards(sortCards(cards).map((s) => ({ id: s.id, cardH: heightOf(s) }))), earlier: [] });
}

/** Puts `id` in the first free slot of `columns` (changed in place); `present` is who is here now. */
export function placeCard(columns: string[][], id: string, present: ReadonlySet<string>): void {
  const rows = columns.reduce((n, c) => Math.max(n, c.length), 0);
  for (let r = 0; r < rows; r++) {
    for (const col of columns) {
      if (r < col.length && !present.has(col[r]!)) { col[r] = id; return; }
    }
  }
  const total = columns.reduce((n, c) => n + c.length, 0);
  if (columns.length < columnsWanted(total + 1)) { columns.push([id]); return; }
  let target = 0;
  for (let j = 1; j < columns.length; j++) if (columns[j]!.length < columns[target]!.length) target = j;
  columns[target]!.push(id);
}

export interface ArrangeContext {
  now: number;
  /** Fold idle cards untouched this long (ms); null never folds. */
  foldAfterMs: number | null;
  /** The owner has been away: holes and empty columns may be cleared, idle cards folded. */
  away: boolean;
  /** The zone's first arrangement since the app started: idle cards may be folded. */
  startup: boolean;
  /** While away, tidy the zone by recent activity too (the owner's setting). */
  autoTidy?: boolean;
  /** Cards never folded now (the open chat's). */
  keep?: ReadonlySet<string>;
  /** The height a card is first drawn at, for a layout from before slots. */
  heightOf(s: SessionView): number;
}

/**
 * The zone's slots for these cards: the saved ones with new cards placed and, when the context
 * allows it, holes cleared and idle cards folded. Returns `saved` itself when nothing changed.
 */
export function arrangeZone(saved: ZoneSlots | undefined, cards: SessionView[], ctx: ArrangeContext): ZoneSlots {
  const base = saved ?? migrateSlots(cards, ctx.heightOf);
  const byId = new Map(cards.map((s) => [s.id, s]));
  const present = new Set(byId.keys());
  const aged = (id: string): boolean => {
    const s = byId.get(id);
    return s !== undefined && !ctx.keep?.has(id) && isAged(s, ctx.now, ctx.foldAfterMs);
  };
  const folding = ctx.away || ctx.startup;
  if (ctx.away && ctx.autoTidy) return keepSame(saved, tidyZone(base, cards, ctx));

  let columns = base.columns.map((c) => [...c]);
  // A folded card that wakes (works, needs the owner, or is touched) leaves the fold, as a new card.
  let earlier = base.earlier.filter((id) => !present.has(id) || aged(id));
  if (folding) {
    const folded = new Set<string>();
    const rows = columns.reduce((n, c) => Math.max(n, c.length), 0);
    for (let r = 0; r < rows; r++) for (const col of columns) if (r < col.length && aged(col[r]!)) folded.add(col[r]!);
    if (folded.size > 0) {
      columns = columns.map((c) => c.filter((id) => !folded.has(id)));
      earlier = [...earlier, ...folded];
    }
  }
  if (ctx.away) {
    columns = columns.map((c) => c.filter((id) => present.has(id))).filter((c) => c.length > 0);
    earlier = earlier.filter((id) => present.has(id));
  }
  const placed = new Set([...columns.flat(), ...earlier]);
  for (const s of cards.filter((c) => !placed.has(c.id)).sort(newestFirst)) {
    if (folding && aged(s.id)) earlier.push(s.id);
    else placeCard(columns, s.id, present);
  }
  return keepSame(saved, cleanZoneSlots({ columns, earlier }));
}

const keepSame = (saved: ZoneSlots | undefined, next: ZoneSlots): ZoneSlots =>
  saved !== undefined && sameSlots(saved, next) ? saved : next;

/** Tidy: the zone's cards by recent activity, read left to right, row by row; idle cards
    untouched for long folded (when folding is on). Holes go. */
export function tidyZone(slots: ZoneSlots, cards: SessionView[], ctx: Pick<ArrangeContext, 'now' | 'foldAfterMs' | 'keep'>): ZoneSlots {
  const aged = (s: SessionView): boolean => !ctx.keep?.has(s.id) && isAged(s, ctx.now, ctx.foldAfterMs);
  const present = new Set(cards.map((s) => s.id));
  const shown = cards.filter((s) => !aged(s)).sort(recentFirst);
  const cols = columnsWanted(shown.length);
  const columns: string[][] = Array.from({ length: cols }, () => []);
  shown.forEach((s, i) => columns[i % cols]!.push(s.id));
  const folded = new Set(cards.filter(aged).map((s) => s.id));
  const earlier = [...slots.earlier.filter((id) => folded.has(id)), ...cards.filter((s) => folded.has(s.id) && !slots.earlier.includes(s.id)).sort(recentFirst).map((s) => s.id)];
  return cleanZoneSlots({ columns, earlier: earlier.filter((id) => present.has(id)) });
}

/** A card dragged to column `col`, before the card `before` (null: the column's end). A column
    past the last opens a new one, up to five. */
export function moveCard(slots: ZoneSlots, id: string, col: number, before: string | null): ZoneSlots {
  const columns = slots.columns.map((c) => c.filter((x) => x !== id));
  const earlier = slots.earlier.filter((x) => x !== id);
  const to = Math.max(0, Math.min(col, columns.length, MAX_COLUMNS - 1));
  if (to === columns.length) columns.push([]);
  const target = columns[to]!;
  const at = before === null ? -1 : target.indexOf(before);
  target.splice(at < 0 ? target.length : at, 0, id);
  return cleanZoneSlots({ columns, earlier });
}

/** What a zone draws from its slots: each column's cards here now (holes skipped; an emptied
    column keeps its place unless it is the last), and the folded cards here now. */
export function shownSlots(slots: ZoneSlots, present: ReadonlySet<string>): ZoneSlots {
  const columns = slots.columns.map((c) => c.filter((id) => present.has(id)));
  while (columns.length > 0 && columns[columns.length - 1]!.length === 0) columns.pop();
  return { columns, earlier: slots.earlier.filter((id) => present.has(id)) };
}
