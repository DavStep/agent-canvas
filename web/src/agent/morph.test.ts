import { describe, expect, it } from 'vitest';
import { FLIGHT_MS, flightFrames, frameAt, orbKeyframes, shapeKeyframes, type FlightPlan } from './morph.ts';

// The demo window: the orb in the canvas's bottom-left corner, the panel docked right.
const plan: FlightPlan = {
  orb: { x: 24, y: 828, width: 48, height: 48 },
  glyph: 30,
  panel: { x: 872, y: 116, width: 560, height: 776 },
  mark: { x: 889, y: 127, width: 18, height: 18 },
  radius: 14,
};
const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const near = (a: number, b: number, by = 0.01) => expect(Math.abs(a - b)).toBeLessThan(by);

describe('frameAt', () => {
  it('is the round button at one end and the panel at the other', () => {
    const start = frameAt(plan, 0, 0);
    expect(start.box).toEqual(plan.orb);
    expect(start.radius).toBe(24);
    expect(start.orb).toEqual({ x: 48, y: 852, scale: 1, opacity: 1 });
    const end = frameAt(plan, 1, 1);
    near(end.box.x, plan.panel.x); near(end.box.y, plan.panel.y);
    near(end.box.width, plan.panel.width); near(end.box.height, plan.panel.height);
    near(end.radius, 14);
    // The orb ends on the mark beside the panel's title, at the mark's size.
    near(end.orb.x, 898); near(end.orb.y, 136); near(end.orb.scale, 18 / 30);
  });

  it('stays round while it is small and squares off as it grows', () => {
    const early = frameAt(plan, 0.3, 0.1);
    near(early.radius, Math.min(early.box.width, early.box.height) / 2, 8);
    const late = frameAt(plan, 1, 0.9);
    expect(late.radius).toBeLessThan(30);
    expect(late.radius).toBeLessThan(Math.min(late.box.width, late.box.height) / 4);
  });

  it('without a mark on the panel, the orb fades on the surface instead of travelling to one', () => {
    const f = frameAt({ ...plan, mark: null }, 1, 1);
    expect(f.orb.opacity).toBe(0);
    near(f.orb.x, centre(plan.panel).x);
  });
});

describe('flightFrames', () => {
  it('opening: leaves from the button, lands exactly on the panel, and only ever grows', () => {
    const frames = flightFrames('open', plan);
    expect(frames[0]!.offset).toBe(0);
    expect(frames.at(-1)!.offset).toBe(1);
    expect(frames[0]!.box).toEqual(plan.orb);
    near(frames.at(-1)!.box.width, plan.panel.width);
    near(frames.at(-1)!.box.x, plan.panel.x);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.offset).toBeGreaterThan(frames[i - 1]!.offset);
      expect(frames[i]!.box.width).toBeGreaterThanOrEqual(frames[i - 1]!.box.width);
    }
  });

  it('flies a bowed path, above the straight line between the two', () => {
    const frames = flightFrames('open', plan);
    const a = centre(plan.orb);
    const b = centre(plan.panel);
    const off = frames.map((f) => {
      const c = centre(f.box);
      // Signed distance from the straight line; positive is the upper side.
      return ((b.x - a.x) * (a.y - c.y) - (a.x - c.x) * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y);
    });
    expect(Math.max(...off)).toBeGreaterThan(60);
    expect(Math.min(...off)).toBeGreaterThan(-0.01);
  });

  it('closing: starts as the panel, lands a little small, and ends as the button', () => {
    const frames = flightFrames('close', plan);
    near(frames[0]!.box.width, plan.panel.width);
    near(frames[0]!.box.height, plan.panel.height);
    const last = frames.at(-1)!;
    near(last.box.x, plan.orb.x); near(last.box.y, plan.orb.y); near(last.box.width, 48); near(last.radius, 24);
    near(last.orb.scale, 1);
    const smallest = Math.min(...frames.map((f) => f.box.width));
    expect(smallest).toBeLessThan(46);
    expect(smallest).toBeGreaterThan(36);
    // While the panel's content fades on it, the surface has barely moved.
    const early = frames.find((f) => f.offset * FLIGHT_MS.close >= 60)!;
    expect(early.box.width).toBeGreaterThan(plan.panel.width * 0.85);
  });

  it('both ways fit the time a morph may take', () => {
    expect(FLIGHT_MS.open).toBeGreaterThanOrEqual(380);
    expect(FLIGHT_MS.open).toBeLessThanOrEqual(520);
    expect(FLIGHT_MS.close).toBeLessThan(FLIGHT_MS.open);
    expect(FLIGHT_MS.close).toBeGreaterThanOrEqual(380);
  });
});

describe('keyframes', () => {
  it('the surface is only transformed: at the button it is the panel scaled down, its corners and border undone by the scale', () => {
    const [first] = shapeKeyframes(flightFrames('open', plan), plan.panel);
    expect(first).toEqual({
      offset: 0,
      transform: 'translate(24px, 828px) scale(0.086, 0.062)',
      borderRadius: '280px / 388px',
      borderWidth: '16.17px 11.67px',
    });
    const last = shapeKeyframes(flightFrames('open', plan), plan.panel).at(-1)!;
    expect(last.transform).toBe('translate(872px, 116px) scale(1, 1)');
    expect(last.borderRadius).toBe('14px / 14px');
    expect(last.borderWidth).toBe('1px 1px');
  });

  it('the orb is moved by its centre', () => {
    const frames = orbKeyframes(flightFrames('open', plan), 30);
    expect(frames[0]).toEqual({ offset: 0, transform: 'translate(33px, 837px) scale(1)', opacity: '1' });
    expect(frames.at(-1)).toEqual({ offset: 1, transform: 'translate(883px, 121px) scale(0.6)', opacity: '1' });
  });
});
