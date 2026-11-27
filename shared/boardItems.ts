// Things kept on the board besides sessions: board items. Each has a kind (images for now; a note
// can join as another kind of the same union) and a place: free on the canvas at a board point,
// or in a zone's grid at a column and a top, where the zone's cards flow around it as they do
// around a board preview (web/src/board/flowItems.ts). Items are part of the saved layout, so the
// page, the reader and the canvas agent change them with layout ops like any zone.
// Pure, and safe for the sandboxed preload: no `node:` imports.
import type { Layout } from './types.ts';

/** Where an image's bytes are. */
export type ImageSource =
  /** A copy in the app's data folder (`board-images/<file>`): dropped from another app, pasted,
      or fetched once from a dropped web address. */
  | { kind: 'copy'; file: string }
  /** A file on disk by its absolute path (the project explorer, the canvas agent): drawn as it is
      now, so an edit shows, and as a placeholder while it is missing. */
  | { kind: 'path'; path: string };

/** Free on the board at a board point (its top-left corner), or in a zone at a column and a top
    inside the zone's cards area (canvas px), as a board preview's slot is. */
export type ItemPlace = { zone: null; x: number; y: number } | { zone: string; col: number; top: number };

export interface ImageItem {
  id: string;
  kind: 'image';
  place: ItemPlace;
  /** Its frame on the board, canvas px. */
  width: number;
  height: number;
  src: ImageSource;
  /** The file's name: shown when the image cannot be, and what search finds. */
  name: string;
  caption?: string;
  /** The image's own size in pixels, once known: resizing keeps its shape. */
  natural?: { width: number; height: number };
  /** A referenced file's modification time: changes when the file does, so the board draws it again. */
  version?: number;
  /** A referenced file that is gone (or unreadable): drawn as a placeholder until it is back. */
  missing?: boolean;
}

export type BoardItem = ImageItem;

export type ItemOp =
  | { type: 'addItem'; item: BoardItem }
  | { type: 'placeItem'; id: string; place: ItemPlace }
  | { type: 'resizeItem'; id: string; width: number; height: number }
  /** `caption: null` (or '') takes the caption off. */
  | { type: 'editItem'; id: string; patch: ItemPatch }
  | { type: 'removeItem'; id: string };
export interface ItemPatch {
  caption?: string | null;
  natural?: { width: number; height: number };
  version?: number;
  missing?: boolean;
}

export const MAX_ITEMS = 500;
export const ITEM_MIN = 48;
export const ITEM_MAX = 2400;
export const MAX_CAPTION = 200;
const MAX_NAME = 255;
const MAX_PATH = 4096;
/** Far above any board; zones live within a few thousand px of the origin. */
const MAX_COORD = 1_000_000;
/** As a board preview's slot (web/src/preview/boardPreviews.ts). */
const MAX_COL = 12;
const MAX_TOP = 20_000;

/** The image types the board draws, by extension. */
export const BOARD_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
};
/** A file's extension, lower case, '' for none. */
export const extOfName = (name: string): string => {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
};
/** The MIME type of an image file the board draws, or null for any other file. */
export const imageMimeOf = (name: string): string | null => BOARD_IMAGE_TYPES[extOfName(name)] ?? null;
/** The extension a copy of this MIME type is saved with, or null when the board does not draw it. */
export function extForMime(mime: string): string | null {
  const m = mime.toLowerCase().split(';', 1)[0]!.trim();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  const found = Object.entries(BOARD_IMAGE_TYPES).find(([, t]) => t === m);
  return found ? found[0] : null;
}

/** A copy's file name: random hex and the image's extension, nothing a path could hide in. */
export const COPY_FILE = /^[a-f0-9]{16,64}\.(?:png|jpg|jpeg|gif|webp|avif|svg|bmp)$/;
const ITEM_ID = /^item:[a-z0-9]{6,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isSize = (v: unknown): v is number => isNum(v) && v >= ITEM_MIN && v <= ITEM_MAX;
const isNatural = (v: unknown): v is { width: number; height: number } =>
  isRecord(v) && isNum(v.width) && isNum(v.height) && v.width > 0 && v.height > 0 && v.width <= 100_000 && v.height <= 100_000;
export const isItemId = (v: unknown): v is string => typeof v === 'string' && ITEM_ID.test(v);

/** An absolute path to an image file: no NUL, no `.` or `..` step, an image extension. */
export function isImagePath(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_PATH || !v.startsWith('/') || v.includes('\0')) return false;
  if (v.split('/').some((s) => s === '.' || s === '..')) return false;
  return imageMimeOf(v) !== null;
}

export function isImageSource(v: unknown): v is ImageSource {
  if (!isRecord(v)) return false;
  if (v.kind === 'copy') return typeof v.file === 'string' && COPY_FILE.test(v.file);
  if (v.kind === 'path') return isImagePath(v.path);
  return false;
}

export function isItemPlace(v: unknown): v is ItemPlace {
  if (!isRecord(v)) return false;
  if (v.zone === null) return isNum(v.x) && isNum(v.y) && Math.abs(v.x) <= MAX_COORD && Math.abs(v.y) <= MAX_COORD;
  return typeof v.zone === 'string' && v.zone !== '' && v.zone.length <= MAX_NAME * 4
    && Number.isInteger(v.col) && (v.col as number) >= 0 && (v.col as number) <= MAX_COL
    && isNum(v.top) && v.top >= 0 && v.top <= MAX_TOP;
}

export function isBoardItem(v: unknown): v is BoardItem {
  return isRecord(v) && v.kind === 'image' && isItemId(v.id) && isItemPlace(v.place)
    && isSize(v.width) && isSize(v.height) && isImageSource(v.src)
    && typeof v.name === 'string' && v.name.length <= MAX_NAME
    && (v.caption === undefined || (typeof v.caption === 'string' && v.caption.length <= MAX_CAPTION))
    && (v.natural === undefined || isNatural(v.natural))
    && (v.version === undefined || isNum(v.version))
    && (v.missing === undefined || typeof v.missing === 'boolean');
}

/** The valid items of a saved or sent list, each id once: a damaged item is dropped, never the layout. */
export function cleanItems(v: unknown): BoardItem[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: BoardItem[] = [];
  for (const item of v) {
    if (!isBoardItem(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** A layout as loaded from disk, with its items cleaned (absent stays absent). */
export function withCleanItems(layout: Layout): Layout {
  if (layout.items === undefined) return layout;
  return { ...layout, items: cleanItems(layout.items) };
}

/** A sent op as the reader takes it, or null when it is malformed. */
export function parseItemOp(v: Record<string, unknown>): ItemOp | null {
  switch (v.type) {
    case 'addItem':
      return isBoardItem(v.item) ? { type: 'addItem', item: v.item } : null;
    case 'placeItem':
      return isItemId(v.id) && isItemPlace(v.place) ? { type: 'placeItem', id: v.id, place: v.place } : null;
    case 'resizeItem':
      return isItemId(v.id) && isSize(v.width) && isSize(v.height) ? { type: 'resizeItem', id: v.id, width: v.width, height: v.height } : null;
    case 'editItem': {
      if (!isItemId(v.id) || !isRecord(v.patch)) return null;
      const p = v.patch;
      const patch: ItemPatch = {};
      if (p.caption !== undefined) {
        if (p.caption !== null && (typeof p.caption !== 'string' || p.caption.length > MAX_CAPTION)) return null;
        patch.caption = p.caption;
      }
      if (p.natural !== undefined) { if (!isNatural(p.natural)) return null; patch.natural = { width: p.natural.width, height: p.natural.height }; }
      if (p.version !== undefined) { if (!isNum(p.version)) return null; patch.version = p.version; }
      if (p.missing !== undefined) { if (typeof p.missing !== 'boolean') return null; patch.missing = p.missing; }
      return { type: 'editItem', id: v.id, patch };
    }
    case 'removeItem':
      return isItemId(v.id) ? { type: 'removeItem', id: v.id } : null;
    default:
      return null;
  }
}

export const isItemOpType = (t: unknown): t is ItemOp['type'] =>
  t === 'addItem' || t === 'placeItem' || t === 'resizeItem' || t === 'editItem' || t === 'removeItem';

const clampSize = (n: number): number => Math.round(Math.min(ITEM_MAX, Math.max(ITEM_MIN, n)));

function replaceItem(layout: Layout, id: string, update: (item: BoardItem) => BoardItem): Layout {
  const items = layout.items ?? [];
  const i = items.findIndex((it) => it.id === id);
  if (i < 0) return layout;
  const next = update(items[i]!);
  if (JSON.stringify(next) === JSON.stringify(items[i])) return layout;
  return { ...layout, items: items.map((it, j) => (j === i ? next : it)) };
}

/** One item op on a layout; anything malformed or unknown leaves it as it is. */
export function applyItemOp(layout: Layout, op: ItemOp): Layout {
  const items = layout.items ?? [];
  switch (op.type) {
    case 'addItem':
      if (!isBoardItem(op.item) || items.some((it) => it.id === op.item.id) || items.length >= MAX_ITEMS) return layout;
      return { ...layout, items: [...items, op.item] };
    case 'placeItem':
      if (!isItemPlace(op.place)) return layout;
      return replaceItem(layout, op.id, (it) => ({
        ...it, place: op.place.zone === null
          ? { zone: null, x: Math.round(op.place.x), y: Math.round(op.place.y) }
          : { zone: op.place.zone, col: op.place.col, top: Math.round(op.place.top) },
      }));
    case 'resizeItem':
      if (!isNum(op.width) || !isNum(op.height)) return layout;
      return replaceItem(layout, op.id, (it) => ({ ...it, width: clampSize(op.width), height: clampSize(op.height) }));
    case 'editItem':
      return replaceItem(layout, op.id, (it) => {
        const next: BoardItem = { ...it };
        const { caption, natural, version, missing } = op.patch;
        if (caption !== undefined) {
          const text = caption === null ? '' : caption.trim().slice(0, MAX_CAPTION);
          if (text === '') delete next.caption; else next.caption = text;
        }
        if (natural !== undefined && isNatural(natural)) next.natural = { width: natural.width, height: natural.height };
        if (version !== undefined && isNum(version)) next.version = version;
        if (missing === true) next.missing = true;
        if (missing === false) delete next.missing;
        return next;
      });
    case 'removeItem':
      if (!items.some((it) => it.id === op.id)) return layout;
      return { ...layout, items: items.filter((it) => it.id !== op.id) };
    default:
      return layout;
  }
}

/** A deleted zone's items stay on the board, free, at about the zone's place (its corner when known). */
export function releaseItems(layout: Layout, zone: { id: string; x: number | null; y: number | null }): Layout {
  const items = layout.items;
  if (!items?.some((it) => it.place.zone === zone.id)) return layout;
  const x0 = zone.x ?? 0;
  const y0 = zone.y ?? 0;
  return {
    ...layout,
    items: items.map((it) => it.place.zone !== zone.id ? it
      : { ...it, place: { zone: null, x: Math.round(x0 + 16 + it.place.col * 244), y: Math.round(y0 + 40 + it.place.top) } }),
  };
}

/** A fresh item id. */
export function newItemId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `item:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** What search matches an item by: its file name and its caption. */
export function itemMatches(item: BoardItem, words: string[]): boolean {
  const text = `${item.name} ${item.caption ?? ''}`.toLowerCase();
  return words.length > 0 && words.every((w) => text.includes(w));
}

/** A frame for an image of this natural size, `width` wide (its shape kept, within the limits). */
export function frameFor(natural: { width: number; height: number } | undefined, width: number): { width: number; height: number } {
  const w = clampSize(width);
  if (!natural) return { width: w, height: clampSize(w * 0.75) };
  return { width: w, height: clampSize((w * natural.height) / natural.width) };
}

/** Where the board asks main for an item's image: `thumb` for a small frame, the file for the viewer. */
export function boardImageUrl(item: { id: string; version?: number }, size: 'thumb' | 'full'): string {
  return `canvas-media://board/${encodeURIComponent(item.id)}?v=${item.version ?? 0}&size=${size}`;
}
