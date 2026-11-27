import { describe, expect, it } from 'vitest';
import { resolveOverlaps, type ZoneBox } from './resolveOverlaps.ts';

const box = (id: string, x: number, y: number, w: number, h: number): ZoneBox => ({ id, x, y, w, h });
const asObject = (m: Map<string, { x: number; y: number }>) => Object.fromEntries(m);
const overlaps = (a: ZoneBox, b: ZoneBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('resolveOverlaps', () => {
  it('returns the saved positions unchanged when nothing overlaps', () => {
    const zones = [box('a', 0, 0, 752, 327), box('b', 40, 400, 508, 328), box('c', 800, 0, 264, 138)];
    expect(asObject(resolveOverlaps(zones))).toEqual({ a: { x: 0, y: 0 }, b: { x: 40, y: 400 }, c: { x: 800, y: 0 } });
  });

  it('leaves the mockup zones, set less than 32 px apart but not overlapping, where they are', () => {
    // The demo's saved positions with the sizes the browser measures for them.
    const zones = [box('garden', 0, 0, 752, 327), box('dashboard', 40, 356, 508, 328),
      box('sailcloth', 572, 344, 264, 138), box('none', 604, 500, 264, 216)];
    const out = resolveOverlaps(zones);
    for (const z of zones) expect(out.get(z.id)).toEqual({ x: z.x, y: z.y });
  });

  it('pushes only the lower zone, by exactly the overlap plus 32, when a zone grows into it', () => {
    // a grew to 300 high; b was saved at 280, so they overlap by 20.
    const zones = [box('a', 0, 0, 500, 300), box('b', 100, 280, 300, 200), box('side', 600, 0, 300, 200)];
    const out = resolveOverlaps(zones);
    expect(out.get('a')).toEqual({ x: 0, y: 0 });
    expect(out.get('side')).toEqual({ x: 600, y: 0 });
    expect(out.get('b')).toEqual({ x: 100, y: 280 + 20 + 32 });
  });

  it('follows a chain: a pushes b, and b then pushes c', () => {
    const zones = [box('c', 0, 520, 400, 100), box('a', 0, 0, 400, 300), box('b', 0, 280, 400, 200)];
    const out = resolveOverlaps(zones);
    expect(out.get('b')).toEqual({ x: 0, y: 332 });
    // b now ends at 532, over c's saved 520: c clears it by 32.
    expect(out.get('c')).toEqual({ x: 0, y: 564 });
  });

  it('does not move side-by-side zones when a neighbour grows downward without reaching them', () => {
    const zones = [box('left', 0, 0, 500, 900), box('right', 532, 0, 500, 200), box('right-below', 532, 232, 500, 200)];
    expect(asObject(resolveOverlaps(zones))).toEqual({
      left: { x: 0, y: 0 }, right: { x: 532, y: 0 }, 'right-below': { x: 532, y: 232 },
    });
  });

  it('clears every resolved zone it lands on, never moving anything up or sideways', () => {
    const zones = [box('a', 0, 0, 300, 300), box('b', 310, 0, 300, 600), box('c', 100, 250, 400, 100)];
    const out = resolveOverlaps(zones);
    expect(out.get('c')).toEqual({ x: 100, y: 632 });
    const drawn = zones.map((z) => ({ ...z, ...out.get(z.id)! }));
    for (const z of drawn) {
      const saved = zones.find((s) => s.id === z.id)!;
      expect(z.x).toBe(saved.x);
      expect(z.y).toBeGreaterThanOrEqual(saved.y);
    }
    expect(overlaps(drawn[0]!, drawn[2]!) || overlaps(drawn[1]!, drawn[2]!)).toBe(false);
  });

  it('keeps moving down when clearing one zone lands it on another already moved', () => {
    // b is pushed below a; c, cleared below a, then lands on b and clears that too.
    const zones = [box('a', 0, 0, 400, 300), box('b', 300, 100, 200, 100), box('c', 0, 150, 350, 50)];
    const out = resolveOverlaps(zones);
    expect(out.get('b')).toEqual({ x: 300, y: 332 });
    expect(out.get('c')).toEqual({ x: 0, y: 464 });
  });

  it('is deterministic for zones with the same saved y, whatever order they come in', () => {
    // Two zones overlap at the same y: the one further left (then the lower id) stays.
    const zones = [box('m', 100, 0, 300, 200), box('k', 100, 0, 300, 200), box('j', 50, 0, 100, 100)];
    const first = asObject(resolveOverlaps(zones));
    expect(asObject(resolveOverlaps([...zones].reverse()))).toEqual(first);
    expect(first).toEqual({ j: { x: 50, y: 0 }, k: { x: 100, y: 132 }, m: { x: 100, y: 364 } });
  });
});
