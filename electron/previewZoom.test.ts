import { describe, expect, it, vi } from 'vitest';
import { forwardPreviewZoom, hostWheel, parseGuestWheel, PREVIEW_ZOOM_WHEEL, zoomKey, type HostZoom, type Placement, type ZoomGuest } from './previewZoom.ts';

const wheel = { x: 10, y: 20, dx: 0, dy: -8, ctrlKey: false, metaKey: true, shiftKey: false };
const key = (k: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean }> = { meta: true }) =>
  ({ type: 'keyDown', key: k, meta: false, control: false, alt: false, ...mods });

function fakeGuest() {
  const handlers: Record<string, (...a: never[]) => void> = {};
  const guest: ZoomGuest = {
    setVisualZoomLevelLimits: vi.fn(() => Promise.resolve()),
    on: (event, listener) => { handlers[event] = listener as never; },
    ipc: { on: (channel, listener) => { handlers[`ipc:${channel}`] = listener as never; } },
  };
  return { guest, handlers };
}

describe('preview zoom forwarding', () => {
  it('takes only ⌘/Ctrl wheels with finite numbers', () => {
    expect(parseGuestWheel(wheel)).toEqual(wheel);
    expect(parseGuestWheel({ ...wheel, metaKey: false })).toBeNull();
    expect(parseGuestWheel({ ...wheel, dy: Number.NaN })).toBeNull();
    expect(parseGuestWheel({ ...wheel, x: '1' })).toBeNull();
    expect(parseGuestWheel(null)).toBeNull();
  });

  it("puts the page's point and deltas in the canvas page's pixels", () => {
    // View at window points (200, 100); the page drawn at 0.5 × 2 (canvas zoom × window zoom).
    const p: Placement = { x: 200, y: 100, width: 400, height: 300, zoom: 1, hostZoom: 2 };
    expect(hostWheel(wheel, p)).toEqual({ ...wheel, kind: 'wheel', x: 105, y: 60, dx: 0, dy: -4 });
  });

  it('reads ⌘/Ctrl =, +, -, _ and 0 as zoom keys, nothing else', () => {
    expect(zoomKey(key('='))).toBe('in');
    expect(zoomKey(key('+', { control: true }))).toBe('in');
    expect(zoomKey(key('-'))).toBe('out');
    expect(zoomKey(key('_'))).toBe('out');
    expect(zoomKey(key('0'))).toBe('reset');
    expect(zoomKey(key('=', {}))).toBeNull();
    expect(zoomKey(key('=', { meta: true, alt: true }))).toBeNull();
    expect(zoomKey(key('c'))).toBeNull();
    expect(zoomKey({ ...key('='), type: 'keyUp' })).toBeNull();
  });

  it('turns off pinch zoom, stops the zoom keys and sends both to the canvas', () => {
    const { guest, handlers } = fakeGuest();
    const sent: HostZoom[] = [];
    let placed: Placement | null = null;
    forwardPreviewZoom(guest, () => placed, (z) => sent.push(z));
    expect(guest.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);

    const press = (input: ReturnType<typeof key>) => {
      const e = { preventDefault: vi.fn() };
      (handlers['before-input-event'] as (e: unknown, i: unknown) => void)(e, input);
      return e.preventDefault.mock.calls.length > 0;
    };
    expect(press(key('='))).toBe(true); // stopped even before the page is placed
    expect(press(key('c'))).toBe(false);
    expect(sent).toEqual([]);

    placed = { x: 0, y: 0, width: 400, height: 200, zoom: 1, hostZoom: 1 };
    expect(press(key('0'))).toBe(true);
    (handlers[`ipc:${PREVIEW_ZOOM_WHEEL}`] as (e: unknown, v: unknown) => void)({}, wheel);
    (handlers[`ipc:${PREVIEW_ZOOM_WHEEL}`] as (e: unknown, v: unknown) => void)({}, { ...wheel, metaKey: false });
    expect(sent).toEqual([{ kind: 'key', key: 'reset', x: 200, y: 100 }, { ...wheel, kind: 'wheel' }]);
  });
});
