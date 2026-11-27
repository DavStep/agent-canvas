// The images kept in a zone, for Zone.tsx: the tiles its cards flow around (flowItems.ts), and
// the layer that draws each image at its slot inside the cards area, with the dashed slot an image
// in the hand would land in. Drawn as the board preview's tile is: at the cards area's corner (its
// static place), moved to its slot by translate.
import type { ReactNode } from 'react';
import { COLUMN_STEP } from '../canvas/zoneFlow.ts';
import type { ItemTile, PlacedTile } from './flowItems.ts';
import { dropFrom, type ItemLive } from './itemLive.ts';

/** An image in a zone: its saved slot and size, and what to draw there. */
export interface ZoneItem extends ItemTile {
  node: ReactNode;
}

/** The id of the room an image in the hand takes in the zone it is over. */
export const SLOT_ID = '\0slot';

/** The tiles the zone's cards make room for: its images (one in the hand keeps no room in its
    own zone, and one being resized has its size now), and the slot of an image held over it. */
export function itemTilesFor(items: readonly ZoneItem[], hand: ItemLive | null, zone: string): ItemTile[] {
  const tiles: ItemTile[] = [];
  for (const it of items) {
    if (hand?.id === it.id && hand.over !== undefined) continue;
    const size = hand?.id === it.id ? hand.size : undefined;
    tiles.push({ id: it.id, col: it.col, top: it.top, width: size?.width ?? it.width, height: size?.height ?? it.height, beside: it.beside });
  }
  const over = hand?.over;
  if (over && over.zone === zone) {
    tiles.push({ id: SLOT_ID, col: Math.max(0, Math.round(over.x / COLUMN_STEP)), top: Math.max(0, over.y), width: over.width, height: over.height });
  }
  return tiles;
}

export function ZoneItemsLayer({ items, placed, hand }: { items: readonly ZoneItem[]; placed: ReadonlyMap<string, PlacedTile>; hand: ItemLive | null }) {
  const slot = placed.get(SLOT_ID);
  const over = hand?.over;
  return <>
    {items.map((it) => {
      // In the hand, it stays drawn where it rested; the hand's offset is on the image itself.
      const at = hand?.id === it.id && hand.over !== undefined ? hand.rest ?? { col: it.col, top: it.top } : placed.get(it.id);
      if (!at) return null;
      return (
        <div key={it.id} className={`board-item-tile${dropFrom.has(it.id) ? ' is-dropped' : ''}`} data-col={at.col} data-top={at.top}
          style={{ translate: `${at.col * COLUMN_STEP}px ${at.top}px` }}>{it.node}</div>
      );
    })}
    {slot && over && (
      <i className="board-tile-slot board-item-slot" aria-hidden="true" data-col={slot.col} data-top={slot.top}
        style={{ translate: `${slot.col * COLUMN_STEP}px ${slot.top}px`, width: over.width, height: over.height }} />
    )}
  </>;
}
