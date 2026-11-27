import { describe, expect, it } from 'vitest';
import { clampWidth, DESK_MIN, PANELS, parseWidths } from './panelWidths.ts';

describe('clampWidth', () => {
  it('keeps a width inside the panel limits', () => {
    expect(clampWidth('rail', 50, 380, 1600)).toBe(PANELS.rail.min);
    expect(clampWidth('rail', 5000, 380, 1600)).toBe(PANELS.rail.max);
    expect(clampWidth('preview', 500.4, 240, 1600)).toBe(500);
  });

  it('leaves the chat column its minimum', () => {
    expect(clampWidth('preview', 760, 240, 1200)).toBe(1200 - 240 - DESK_MIN);
  });

  it('never goes under the panel minimum, even in a narrow window', () => {
    expect(clampWidth('rail', 300, 380, 700)).toBe(PANELS.rail.min);
  });
});

describe('parseWidths', () => {
  it('falls back to the defaults', () => {
    expect(parseWidths(null)).toEqual({ rail: 240, preview: 380 });
    expect(parseWidths('not json')).toEqual({ rail: 240, preview: 380 });
    expect(parseWidths('{"rail":"wide"}')).toEqual({ rail: 240, preview: 380 });
  });

  it('reads saved widths and clamps them to the limits', () => {
    expect(parseWidths('{"rail":300,"preview":9999}')).toEqual({ rail: 300, preview: PANELS.preview.max });
  });
});
