// The canvas agent's view of board images (tools.ts: add_image, remove_image, canvas_overview):
// a new image item for a file, and the images as the overview lists them.
import { frameFor, MAX_CAPTION, newItemId, type BoardItem, type ImageItem, type ItemPlace } from '../../shared/boardItems.ts';
import type { Layout } from '../../shared/types.ts';

/** A free image's width, and a zone image's (one card column). */
const FREE_WIDTH = 320;
const ZONE_WIDTH = 232;
/** Pulled up to just below the cards of the zone's first column (web/src/board/flowItems.ts). */
const BELOW_CARDS = 20_000;

/** Where an image the agent adds goes: below a zone's cards, or free left of the zones. */
export function agentPlace(layout: Layout, zone: string | null): ItemPlace {
  if (zone !== null) return { zone, col: 0, top: BELOW_CARDS };
  const placed = layout.zones.filter((z) => z.x !== null && z.y !== null);
  const free = (layout.items ?? []).filter((it) => it.place.zone === null).length;
  if (placed.length === 0) return { zone: null, x: 40 * free, y: 40 * free };
  const left = Math.min(...placed.map((z) => z.x!));
  const top = Math.min(...placed.map((z) => z.y!));
  // Each further free image steps down a little, so none hides another.
  return { zone: null, x: left - FREE_WIDTH - 48, y: top + 40 * free };
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export function agentImage(layout: Layout, file: string, zone: string | null, caption?: string): ImageItem {
  const size = frameFor(undefined, zone === null ? FREE_WIDTH : ZONE_WIDTH);
  const text = caption?.trim().slice(0, MAX_CAPTION);
  return {
    id: newItemId(), kind: 'image', place: agentPlace(layout, zone), ...size,
    src: { kind: 'path', path: file }, name: baseName(file),
    ...(text ? { caption: text } : {}),
  };
}

/** The images on the board, for canvas_overview; nothing when there are none. */
export function imagesOverview(layout: Layout): { images?: object[] } {
  const items = (layout.items ?? []).filter((it: BoardItem): it is ImageItem => it.kind === 'image');
  if (items.length === 0) return {};
  return {
    images: items.map((it) => ({
      id: it.id, name: it.name, zone: it.place.zone,
      ...(it.src.kind === 'path' ? { path: it.src.path } : { copy: true }),
      ...(it.caption ? { caption: it.caption } : {}),
      ...(it.missing ? { missing: true } : {}),
    })),
  };
}
