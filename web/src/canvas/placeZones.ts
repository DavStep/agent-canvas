// First placement for zones the layout has no position for yet.
import type { ZoneLayout } from '../../../shared/types.ts';

const GAP = 32;
const ROW_WIDTH = 1400;

type Size = { w: number; h: number };
/** All placement reads of a zone: its id and saved position. */
type Placeable = Pick<ZoneLayout, 'id' | 'x' | 'y'>;

const isPlaced = (z: Placeable) => z.x !== null && z.y !== null;

/**
 * A row width that packs the unplaced, measured zones into roughly the canvas's own shape
 * (`aspect` is its width over its height), so Fit can show many zones at a readable zoom.
 * Never narrower than 1400 px or the widest of those zones.
 */
export function rowWidthFor(zones: Placeable[], sizes: Map<string, Size>, aspect: number): number {
  let area = 0;
  let widest = 0;
  for (const zone of zones) {
    const size = sizes.get(zone.id);
    if (isPlaced(zone) || size === undefined) continue;
    area += (size.w + GAP) * (size.h + GAP);
    widest = Math.max(widest, size.w);
  }
  return Math.max(ROW_WIDTH, widest, Math.round(Math.sqrt(area * aspect)));
}

/**
 * Positions for zones whose `x` or `y` is null, packed in rows up to `rowWidth` (1400 px unless
 * given) below every zone that already has a position, so they never overlap one. Zones not yet
 * measured are skipped.
 */
export function placeZones(zones: Placeable[], sizes: Map<string, Size>, rowWidth = ROW_WIDTH): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const placed = zones.filter(isPlaced);
  let y = placed.length === 0 ? 0 : Math.max(...placed.map((z) => z.y! + (sizes.get(z.id)?.h ?? 0))) + GAP;
  let x = 0;
  let rowHeight = 0;
  for (const zone of zones) {
    if (isPlaced(zone)) continue;
    const size = sizes.get(zone.id);
    if (size === undefined) continue;
    if (x > 0 && x + size.w > rowWidth) {
      y += rowHeight + GAP;
      x = 0;
      rowHeight = 0;
    }
    out.set(zone.id, { x, y });
    x += size.w + GAP;
    rowHeight = Math.max(rowHeight, size.h);
  }
  return out;
}
