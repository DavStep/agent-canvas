// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampPanelWidth, loadPanelWidth, PANEL_DEFAULT_CSS, PANEL_MIN, PANEL_WIDTH_KEY, panelWidthCss, parsePanelWidth, savePanelWidth,
} from './panelWidth.ts';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('clampPanelWidth', () => {
  it('keeps the panel at least 380 px and leaves the canvas at least 320 px', () => {
    expect(clampPanelWidth(600, 1440)).toBe(600);
    expect(clampPanelWidth(200, 1440)).toBe(PANEL_MIN);
    // 1440 wide: 320 for the canvas and 24 for the gutters leave 1096.
    expect(clampPanelWidth(1300, 1440)).toBe(1096);
    expect(clampPanelWidth(900, 1100)).toBe(756);
  });

  it('gives the panel its minimum even when the window cannot fit both', () => {
    expect(clampPanelWidth(500, 600)).toBe(PANEL_MIN);
  });
});

describe('parsePanelWidth', () => {
  it('reads a stored width, and nothing from anything else', () => {
    expect(parsePanelWidth('512')).toBe(512);
    expect(parsePanelWidth('512.6')).toBe(513);
    expect(parsePanelWidth(null)).toBeNull();
    expect(parsePanelWidth('')).toBeNull();
    expect(parsePanelWidth('wide')).toBeNull();
    expect(parsePanelWidth('-4')).toBeNull();
    expect(parsePanelWidth('Infinity')).toBeNull();
  });
});

describe('panelWidthCss', () => {
  it('is the default until the owner drags the edge', () => {
    expect(PANEL_DEFAULT_CSS).toBe('min(560px, 45vw)');
    expect(panelWidthCss(null)).toBe('min(560px, 45vw)');
    expect(panelWidthCss(480)).toBe('480px');
  });
});

describe('the remembered width', () => {
  it('is saved, read back and forgotten', () => {
    savePanelWidth(470);
    expect(window.localStorage.getItem(PANEL_WIDTH_KEY)).toBe('470');
    expect(loadPanelWidth()).toBe(470);
    savePanelWidth(null);
    expect(window.localStorage.getItem(PANEL_WIDTH_KEY)).toBeNull();
    expect(loadPanelWidth()).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadPanelWidth()).toBeNull();
    expect(() => savePanelWidth(470)).not.toThrow();
    expect(() => savePanelWidth(null)).not.toThrow();
  });

  it('survives a page with no storage at all', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('denied'); });
    expect(loadPanelWidth()).toBeNull();
    expect(() => savePanelWidth(470)).not.toThrow();
  });
});
