import { describe, expect, it } from 'vitest';
import { applyLayoutOp } from '../server/layoutOps.ts';
import { isLayout } from '../server/persist.ts';
import {
  applyItemOp, boardImageUrl, cleanItems, extForMime, frameFor, imageMimeOf, isBoardItem, isImagePath, itemMatches, newItemId,
  parseItemOp, releaseItems, withCleanItems, type ImageItem,
} from './boardItems.ts';
import type { Layout } from './types.ts';

const image = (patch: Partial<ImageItem> = {}): ImageItem => ({
  id: 'item:abc123', kind: 'image', place: { zone: null, x: 10, y: 20 }, width: 320, height: 240,
  src: { kind: 'copy', file: '0123456789abcdef0123456789abcdef.png' }, name: 'shot.png', ...patch,
});
const layout = (patch: Partial<Layout> = {}): Layout => ({
  version: 1, assignments: {},
  zones: [{ id: 'custom:a', name: 'Refs', kind: 'custom', folder: null, x: 400, y: 100, hueIndex: 0 }],
  ...patch,
});

describe('image paths and types', () => {
  it('takes an absolute path to an image file, and nothing else', () => {
    expect(isImagePath('/Users/me/shots/Hero shot.PNG')).toBe(true);
    expect(isImagePath('/Users/me/a.svg')).toBe(true);
    expect(isImagePath('shots/hero.png')).toBe(false);
    expect(isImagePath('/Users/me/../me/hero.png')).toBe(false);
    expect(isImagePath('/Users/me/./hero.png')).toBe(false);
    expect(isImagePath('/Users/me/hero.png\0.txt')).toBe(false);
    expect(isImagePath('/Users/me/.ssh/id_rsa')).toBe(false);
    expect(isImagePath('/Users/me/notes.txt')).toBe(false);
    expect(isImagePath('/Users/me/.png')).toBe(false);
    expect(isImagePath(`/${'a'.repeat(5000)}.png`)).toBe(false);
  });

  it('knows a type by extension, and the extension a copy of a type is saved with', () => {
    expect(imageMimeOf('a/b/c.JPEG')).toBe('image/jpeg');
    expect(imageMimeOf('c.heic')).toBeNull();
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png; charset=binary')).toBe('png');
    expect(extForMime('image/svg+xml')).toBe('svg');
    expect(extForMime('text/html')).toBeNull();
  });

  it('a copy is named by random hex with an image extension only', () => {
    expect(isBoardItem(image())).toBe(true);
    for (const file of ['../layout.json', 'shot.png', 'abcdef0123456789.exe', '0123456789abcdef/x.png']) {
      expect(isBoardItem(image({ src: { kind: 'copy', file } }))).toBe(false);
    }
    expect(isBoardItem(image({ src: { kind: 'path', path: '/Users/me/x.webp' } }))).toBe(true);
    expect(isBoardItem(image({ src: { kind: 'path', path: '/etc/passwd' } }))).toBe(false);
  });
});

describe('item ops', () => {
  it('adds, moves into a zone and out, resizes, captions and removes', () => {
    let l = applyLayoutOp(layout(), { type: 'addItem', item: image() });
    expect(l.items).toEqual([image()]);
    l = applyLayoutOp(l, { type: 'placeItem', id: 'item:abc123', place: { zone: 'custom:a', col: 1, top: 33.6 } });
    expect(l.items![0]!.place).toEqual({ zone: 'custom:a', col: 1, top: 34 });
    l = applyLayoutOp(l, { type: 'resizeItem', id: 'item:abc123', width: 9999, height: 10.4 });
    expect(l.items![0]).toMatchObject({ width: 2400, height: 48 });
    l = applyLayoutOp(l, { type: 'editItem', id: 'item:abc123', patch: { caption: '  Hero  ' } });
    expect(l.items![0]!.caption).toBe('Hero');
    l = applyLayoutOp(l, { type: 'editItem', id: 'item:abc123', patch: { caption: null, natural: { width: 800, height: 600 }, version: 5, missing: true } });
    expect(l.items![0]).toMatchObject({ natural: { width: 800, height: 600 }, version: 5, missing: true });
    expect(l.items![0]!.caption).toBeUndefined();
    l = applyLayoutOp(l, { type: 'editItem', id: 'item:abc123', patch: { missing: false } });
    expect(l.items![0]!.missing).toBeUndefined();
    l = applyLayoutOp(l, { type: 'removeItem', id: 'item:abc123' });
    expect(l.items).toEqual([]);
  });

  it('leaves the layout as it is for an op that changes nothing, a duplicate id or an unknown item', () => {
    const l = applyLayoutOp(layout(), { type: 'addItem', item: image() });
    expect(applyLayoutOp(l, { type: 'addItem', item: image({ name: 'other.png' }) })).toBe(l);
    expect(applyLayoutOp(l, { type: 'placeItem', id: 'item:abc123', place: { zone: null, x: 10, y: 20 } })).toBe(l);
    expect(applyLayoutOp(l, { type: 'removeItem', id: 'item:nothere' })).toBe(l);
    expect(applyLayoutOp(l, { type: 'resizeItem', id: 'item:nothere', width: 100, height: 100 })).toBe(l);
    expect(applyItemOp(l, { type: 'addItem', item: { ...image({ id: 'item:zzzzzz' }), width: Number.NaN } })).toBe(l);
  });

  it('a deleted zone leaves its images on the board, free about where the zone was', () => {
    let l = applyLayoutOp(layout(), { type: 'addItem', item: image({ place: { zone: 'custom:a', col: 1, top: 50 } }) });
    l = applyLayoutOp(l, { type: 'deleteZone', id: 'custom:a' });
    expect(l.zones).toEqual([]);
    expect(l.items![0]!.place).toEqual({ zone: null, x: 400 + 16 + 244, y: 100 + 40 + 50 });
    expect(releaseItems(l, { id: 'custom:a', x: 0, y: 0 })).toBe(l);
  });
});

describe('sent and saved items', () => {
  it('parses each op the page or the agent may send, and refuses a malformed one', () => {
    expect(parseItemOp({ type: 'addItem', item: image() })).toEqual({ type: 'addItem', item: image() });
    expect(parseItemOp({ type: 'addItem', item: { ...image(), kind: 'note' } })).toBeNull();
    expect(parseItemOp({ type: 'placeItem', id: 'item:abc123', place: { zone: 'z', col: 1.5, top: 0 } })).toBeNull();
    expect(parseItemOp({ type: 'placeItem', id: 'item:abc123', place: { zone: null, x: 1, y: 2 } })).not.toBeNull();
    expect(parseItemOp({ type: 'resizeItem', id: 'item:abc123', width: 10, height: 100 })).toBeNull();
    expect(parseItemOp({ type: 'editItem', id: 'item:abc123', patch: { caption: 'x'.repeat(201) } })).toBeNull();
    expect(parseItemOp({ type: 'editItem', id: 'item:abc123', patch: { caption: null, sneaky: 1 } })).toEqual({ type: 'editItem', id: 'item:abc123', patch: { caption: null } });
    expect(parseItemOp({ type: 'removeItem', id: '../x' })).toBeNull();
  });

  it('a damaged item is dropped on load, never the layout; a layout from before items is kept as it was', () => {
    const saved = { ...layout(), items: [image(), { id: 'item:bad000', kind: 'image' }, image(), image({ id: 'item:second' })] };
    expect(isLayout(saved)).toBe(true);
    expect(withCleanItems(saved as unknown as Layout).items!.map((it) => it.id)).toEqual(['item:abc123', 'item:second']);
    expect(isLayout({ ...layout(), items: 'nope' })).toBe(false);
    const old = layout();
    expect(withCleanItems(old)).toBe(old);
    expect(cleanItems(null)).toEqual([]);
  });
});

describe('helpers', () => {
  it('a fresh id is a valid one', () => {
    const id = newItemId();
    expect(isBoardItem(image({ id }))).toBe(true);
    expect(newItemId()).not.toBe(id);
  });

  it('search matches the file name and the caption, every word', () => {
    const it1 = image({ name: 'Hero-Banner.png', caption: 'Landing page, dark' });
    expect(itemMatches(it1, ['hero'])).toBe(true);
    expect(itemMatches(it1, ['landing', 'dark'])).toBe(true);
    expect(itemMatches(it1, ['light'])).toBe(false);
    expect(itemMatches(it1, [])).toBe(false);
  });

  it('a frame keeps the picture’s shape within the limits', () => {
    expect(frameFor({ width: 1600, height: 900 }, 320)).toEqual({ width: 320, height: 180 });
    expect(frameFor({ width: 100, height: 4000 }, 320)).toEqual({ width: 320, height: 2400 });
    expect(frameFor(undefined, 232)).toEqual({ width: 232, height: 174 });
  });

  it('the image address names the item, its version and the size wanted', () => {
    expect(boardImageUrl(image({ version: 12 }), 'thumb')).toBe('canvas-media://board/item%3Aabc123?v=12&size=thumb');
    expect(boardImageUrl(image(), 'full')).toBe('canvas-media://board/item%3Aabc123?v=0&size=full');
  });
});
