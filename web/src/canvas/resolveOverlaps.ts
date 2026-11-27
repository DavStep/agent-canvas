// Where zones are drawn when they have grown into each other: a display-time adjustment of the
// saved positions, never saved itself. A zone that overlaps one above it moves straight down.

export interface ZoneBox { id: string; x: number; y: number; w: number; h: number }

const DEFAULT_GAP = 32;

const intersects = (a: ZoneBox, b: ZoneBox): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Drawn positions for zones at their saved positions. Zones are taken in order of saved `y`,
 * then `x`, then id. Each keeps its saved position unless it overlaps a zone already resolved;
 * then it moves straight down until it sits `gap` below every resolved zone it overlapped
 * (repeated until clear). Never up, never sideways; nothing moves when nothing overlaps.
 *
 * Only a real overlap moves a zone: zones the owner (or the mockup) set closer than `gap`
 * apart stay where they were put. Once a zone has to move, it clears by the full `gap`.
 */
export function resolveOverlaps(zones: ZoneBox[], gap = DEFAULT_GAP): Map<string, { x: number; y: number }> {
  const order = [...zones].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const resolved: ZoneBox[] = [];
  const out = new Map<string, { x: number; y: number }>();
  for (const zone of order) {
    const box = { ...zone };
    for (;;) {
      const hits = resolved.filter((r) => intersects(box, r));
      if (hits.length === 0) break;
      box.y = Math.max(...hits.map((r) => r.y + r.h + gap));
    }
    resolved.push(box);
    out.set(box.id, { x: box.x, y: box.y });
  }
  return out;
}
