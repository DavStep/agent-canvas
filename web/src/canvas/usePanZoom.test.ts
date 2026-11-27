// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { centerTransform, clampK, fitTransform, glideView, parseView, spacePans, wheelView, zoomAbout, type Transform } from './usePanZoom.ts';

/** Where a canvas point lands on screen under a transform. */
const toScreen = (t: Transform, p: { x: number; y: number }) => ({ x: t.x + p.x * t.k, y: t.y + p.y * t.k });

describe('zoomAbout', () => {
  it('keeps the canvas point under the pointer fixed', () => {
    const t = { x: 120, y: -40, k: 0.8 };
    const pointer = { x: 430, y: 275 };
    const under = { x: (pointer.x - t.x) / t.k, y: (pointer.y - t.y) / t.k };
    for (const k of [0.5, 1, 1.7]) {
      const next = zoomAbout(t, k, pointer);
      expect(next.k).toBe(k);
      const at = toScreen(next, under);
      expect(at.x).toBeCloseTo(pointer.x, 9);
      expect(at.y).toBeCloseTo(pointer.y, 9);
    }
  });

  it('clamps the zoom to 0.3 and 2 and still keeps the point fixed', () => {
    const t = { x: 0, y: 0, k: 1 };
    const pointer = { x: 200, y: 100 };
    expect(zoomAbout(t, 5, pointer).k).toBe(2);
    expect(zoomAbout(t, 0.1, pointer).k).toBe(0.3);
    const at = toScreen(zoomAbout(t, 5, pointer), pointer);
    expect(at).toEqual(pointer);
  });
});

describe('clampK', () => {
  it('holds the zoom between 0.3 and 2', () => {
    expect(clampK(0.29)).toBe(0.3);
    expect(clampK(2.01)).toBe(2);
    expect(clampK(1.25)).toBe(1.25);
  });
});

describe('fitTransform', () => {
  it('fits two rects into a 1000 x 600 viewport with a 48 px margin', () => {
    const rects = [{ x: 0, y: 0, width: 400, height: 200 }, { x: 600, y: 300, width: 400, height: 200 }];
    const t = fitTransform(rects, { width: 1000, height: 600 })!;
    const topLeft = toScreen(t, { x: 0, y: 0 });
    const bottomRight = toScreen(t, { x: 1000, y: 500 });
    // The wide box binds: 48 px each side horizontally, centred (and at least 48 px) vertically.
    expect(topLeft.x).toBeCloseTo(48, 9);
    expect(1000 - bottomRight.x).toBeCloseTo(48, 9);
    expect(topLeft.y).toBeGreaterThanOrEqual(48);
    expect(topLeft.y).toBeCloseTo(600 - bottomRight.y, 9);
  });

  it('centres a tall box with the margin above and below', () => {
    const t = fitTransform([{ x: -100, y: 50, width: 300, height: 1008 }], { width: 1000, height: 600 })!;
    expect(toScreen(t, { x: 0, y: 50 }).y).toBeCloseTo(48, 9);
    expect(600 - toScreen(t, { x: 0, y: 1058 }).y).toBeCloseTo(48, 9);
    const left = toScreen(t, { x: -100, y: 0 }).x;
    expect(left).toBeCloseTo(1000 - toScreen(t, { x: 200, y: 0 }).x, 9);
  });

  it('never zooms past the cap, and leaves the view alone with nothing to fit', () => {
    const tiny = fitTransform([{ x: 0, y: 0, width: 10, height: 10 }], { width: 1000, height: 600 })!;
    expect(tiny.k).toBe(2);
    expect(fitTransform([{ x: 0, y: 0, width: 10, height: 10 }], { width: 1000, height: 600 }, 1)!.k).toBe(1);
    expect(fitTransform([], { width: 1000, height: 600 })).toBeNull();
  });
});

describe('centerTransform', () => {
  it('puts the middle of the rect in the middle of the viewport at the current zoom', () => {
    const t = centerTransform({ x: 500, y: 300, width: 200, height: 100 }, { width: 1000, height: 600 }, 0.5);
    expect(t.k).toBe(0.5);
    expect(toScreen(t, { x: 600, y: 350 })).toEqual({ x: 500, y: 300 });
  });
});

describe('parseView', () => {
  it('accepts a remembered view and rejects anything else', () => {
    expect(parseView('{"x":10,"y":-4,"k":0.75}')).toEqual({ x: 10, y: -4, k: 0.75 });
    expect(parseView(null)).toBeNull();
    expect(parseView('not json')).toBeNull();
    expect(parseView('{"x":10,"y":"a","k":1}')).toBeNull();
    expect(parseView('{"x":10,"y":0,"k":9}')).toEqual({ x: 10, y: 0, k: 2 });
  });
});

describe('wheelView', () => {
  const t = { x: 120, y: -40, k: 1 };
  const pointer = { x: 430, y: 275 };
  const under = { x: (pointer.x - t.x) / t.k, y: (pointer.y - t.y) / t.k };
  const wheel = (dy: number, mods: Partial<{ dx: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
    ({ dx: 0, dy, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

  it('scrolls the view up and down on a plain wheel, and either way on a two-finger scroll', () => {
    expect(wheelView(t, wheel(100), pointer)).toEqual({ x: 120, y: -140, k: 1 });
    expect(wheelView(t, wheel(-100), pointer)).toEqual({ x: 120, y: 60, k: 1 });
    expect(wheelView(t, wheel(20, { dx: -15 }), pointer)).toEqual({ x: 135, y: -60, k: 1 });
  });

  it('zooms in and out about the pointer on Ctrl / Cmd + wheel', () => {
    const zoomIn = wheelView(t, wheel(-100, { metaKey: true }), pointer);
    const zoomOut = wheelView(t, wheel(100, { ctrlKey: true }), pointer);
    expect(zoomIn.k).toBeGreaterThan(1);
    expect(zoomOut.k).toBeLessThan(1);
    // One notch is a capped step, not a leap.
    expect(zoomIn.k).toBeCloseTo(Math.exp(0.25), 9);
    for (const next of [zoomIn, zoomOut]) {
      const at = toScreen(next, under);
      expect(at.x).toBeCloseTo(pointer.x, 9);
      expect(at.y).toBeCloseTo(pointer.y, 9);
    }
  });

  it('pans sideways on Shift + wheel, taking the vertical delta when the horizontal one is 0', () => {
    expect(wheelView(t, wheel(30, { shiftKey: true }), pointer)).toEqual({ x: 90, y: -40, k: 1 });
    // macOS turns a shift-scroll of a mouse wheel into deltaX.
    expect(wheelView(t, wheel(0, { shiftKey: true, dx: 30 }), pointer)).toEqual({ x: 90, y: -40, k: 1 });
  });

  it('still zooms about the pointer on Ctrl / Cmd + wheel and a pinch', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      const next = wheelView(t, wheel(-4, mods), pointer);
      expect(next.k).toBeCloseTo(Math.exp(0.04), 9);
      const at = toScreen(next, under);
      expect(at.x).toBeCloseTo(pointer.x, 9);
      expect(at.y).toBeCloseTo(pointer.y, 9);
    }
  });
});

describe('spacePans', () => {
  it('holds the pan key on the canvas and with nothing focused, never in a field or control', () => {
    document.body.innerHTML = `<main class="workspace"><article class="card" tabindex="0"><span>t</span></article>
      <input class="zone-input"><button>+</button></main><textarea></textarea><button id="top">Fit</button>`;
    const canvas = document.querySelector('.workspace')!;
    expect(spacePans(document.body, canvas)).toBe(true);
    expect(spacePans(canvas, canvas)).toBe(true);
    expect(spacePans(document.querySelector('.card'), canvas)).toBe(true);
    expect(spacePans(document.querySelector('.card span'), canvas)).toBe(true);
    expect(spacePans(document.querySelector('.zone-input'), canvas)).toBe(false);
    expect(spacePans(document.querySelector('main button'), canvas)).toBe(false);
    expect(spacePans(document.querySelector('textarea'), canvas)).toBe(false);
    expect(spacePans(document.querySelector('#top'), canvas)).toBe(false);
  });
});

describe('glideView', () => {
  it('starts at one view and lands exactly on the other', () => {
    const from = { x: 10, y: 20, k: 0.5 };
    const to = { x: -300, y: 80, k: 1.5 };
    expect(glideView(from, to, 0)).toEqual(from);
    expect(glideView(from, to, 1)).toBe(to);
  });

  it('keeps the middle of the viewport still through a zoom about it', () => {
    const from = { x: 120, y: -40, k: 0.6 };
    const centre = { x: 500, y: 300 };
    const to = zoomAbout(from, 1, centre);
    const under = { x: (centre.x - from.x) / from.k, y: (centre.y - from.y) / from.k };
    for (const p of [0.1, 0.4, 0.75, 0.99]) {
      const at = toScreen(glideView(from, to, p), under);
      expect(at.x).toBeCloseTo(centre.x, 6);
      expect(at.y).toBeCloseTo(centre.y, 6);
    }
  });

  it('slides in a straight line when the zoom does not change', () => {
    expect(glideView({ x: 0, y: 0, k: 1 }, { x: 100, y: -50, k: 1 }, 0.5)).toEqual({ x: 50, y: -25, k: 1 });
  });
});
