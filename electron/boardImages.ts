// Board images in the main process: copies kept in the app's data folder (dropped from another app,
// pasted, or fetched once from a dropped web address), files on disk the board refers to by path,
// thumbnails for small frames, and the `canvas-media://board/<item id>` responses the page draws.
// Only an item on the board is ever served, and only as an image; a copy's name is random hex.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COPY_FILE, imageMimeOf, isImageSource, isImagePath, type BoardItem, type ImageItem, type ImageSource } from '../shared/boardItems.ts';

/** Largest image the board keeps a copy of, or fetches. */
export const MAX_BOARD_IMAGE_BYTES = 40_000_000;
/** A thumbnail's longest side; frames up to half this wide draw it (two device px per canvas px). */
export const THUMB_SIDE = 1024;
/** What a chat accepts as an image (web/src/chat/images.tsx): bigger ones go resized. */
const CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FETCH_TIMEOUT_MS = 20_000;
/** A copy no item names any more is removed once it is this old (an undo may still want it). */
const SWEEP_AGE_MS = 60 * 60 * 1000;
const THUMB_DIR = '.thumbs';

export interface ImageTools {
  /** The image re-encoded (`png` keeps transparency), resized so its longest side is at most
      `max`; null when it cannot be read. `onlyIfLarger`: null too when it is no larger than `max`. */
  encode(file: string, max: number, format: 'png' | 'jpg', onlyIfLarger: boolean): Buffer | null;
}

export interface BoardImagesOptions {
  /** The app's data folder for board images (the demo's lives in its throwaway profile). */
  dir: string;
  items(): BoardItem[];
  /** The network, for a dropped web address (net.fetch). */
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** A file:// response (net.fetch), so large images stream. */
  fetchFile(url: string, init: RequestInit): Promise<Response>;
  image: ImageTools;
  /** Where a referenced file is on disk; the demo points its invented folders at a real one. */
  onDisk?(file: string): string;
}

export interface ImportedImage { file: string; name: string; mime: string }

/** The image type of these bytes, by their first bytes alone (never by a name or a header). */
export function sniffImage(bytes: Uint8Array): { ext: string; mime: string } | null {
  const b = bytes;
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' };
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { ext: 'webp', mime: 'image/webp' };
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return { ext: 'avif', mime: 'image/avif' };
  if (ascii(0, 'BM') && b.length > 26) return { ext: 'bmp', mime: 'image/bmp' };
  // SVG is text: an XML prolog or comment may come first.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 2048)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<') && /<svg[\s>]/i.test(head)) return { ext: 'svg', mime: 'image/svg+xml' };
  return null;
}

/** A file name for an image fetched from `url`: the address's last step, or "image". */
export function nameFromUrl(url: URL, ext: string): string {
  let last = '';
  try { last = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? ''); } catch { /* not decodable */ }
  last = last.replace(/[\0/\\]/g, '').slice(0, 120);
  if (last === '') return `image.${ext}`;
  return imageMimeOf(last) ? last : `${last}.${ext}`;
}

/** The page's name for a dropped or pasted image, kept to a plain file name. */
const cleanName = (name: string, ext: string): string => {
  const n = name.replace(/[\0/\\]/g, '').trim().slice(0, 200);
  return n === '' ? `Pasted image.${ext}` : n;
};

const refuse = (message: string): Error => new Error(message);

/** Every picture an item draws: an image's own, or each one another kind of item carries (a note's `images`). */
export function picturesOf(item: BoardItem): ImageSource[] {
  if (item.kind === 'image') return [item.src];
  const images = (item as { images?: unknown }).images;
  return Array.isArray(images) ? images.flatMap((img: { src?: unknown }) => (isImageSource(img?.src) ? [img.src] : [])) : [];
}

/** Reads a response's body, refusing one larger than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw refuse('That image is too large for the board.');
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw refuse('That image is too large for the board.'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

export interface BoardImages {
  /** Keeps a copy of dropped or pasted bytes. Refuses anything that is not an image the board draws. */
  importBytes(name: unknown, data: unknown): Promise<ImportedImage>;
  /** Fetches a dropped http(s) address once (no redirect, no cookies) and keeps a copy. */
  importUrl(url: unknown): Promise<ImportedImage>;
  /** The `canvas-media://board/<id>` response: the item's image, or its thumbnail. */
  serve(request: Request): Promise<Response>;
  /** An item's image as a chat takes one (PNG, JPEG, GIF or WebP up to 5 MB), resized if need be. */
  chatImage(id: unknown): Promise<{ name: string; mime: string; data: Uint8Array }>;
  /** Where an image's bytes are on disk. */
  fileOf(src: ImageSource): string;
  /** Removes copies no item names any more (older than an hour), and old thumbnails. */
  sweep(): Promise<void>;
}

export function createBoardImages(opts: BoardImagesOptions): BoardImages {
  const { dir } = opts;
  const fileOf = (src: ImageSource): string => (src.kind === 'copy' ? path.join(dir, src.file) : opts.onDisk?.(src.path) ?? src.path);

  const keep = async (name: string, bytes: Uint8Array): Promise<ImportedImage> => {
    if (bytes.byteLength === 0) throw refuse('That image is empty.');
    if (bytes.byteLength > MAX_BOARD_IMAGE_BYTES) throw refuse('That image is too large for the board.');
    const kind = sniffImage(bytes);
    if (!kind) throw refuse('That isn’t an image the board can show (PNG, JPEG, GIF, WebP, AVIF, SVG or BMP).');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = `${randomBytes(16).toString('hex')}.${kind.ext}`;
    await fs.writeFile(path.join(dir, file), bytes, { mode: 0o600 });
    return { file, name: cleanName(name, kind.ext), mime: kind.mime };
  };

  const imageFor = (id: string): ImageItem | undefined => opts.items().find((it): it is ImageItem => it.id === id && it.kind === 'image');

  /** A cached thumbnail of `file`, made on first use; null when the file is small enough already. */
  const thumbOf = async (file: string): Promise<{ file: string; mime: string } | null> => {
    const mime = imageMimeOf(file);
    // A GIF keeps its animation, an SVG its sharpness: both are drawn as they are.
    if (!mime || mime === 'image/gif' || mime === 'image/svg+xml') return null;
    const stat = await fs.stat(file);
    const format = mime === 'image/jpeg' ? 'jpg' : 'png';
    const key = createHash('sha1').update(`${file}\0${stat.mtimeMs}\0${stat.size}\0${THUMB_SIDE}`).digest('hex');
    const thumb = path.join(dir, THUMB_DIR, `${key}.${format}`);
    const thumbMime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    try {
      await fs.access(thumb);
      return { file: thumb, mime: thumbMime };
    } catch { /* not made yet */ }
    const data = opts.image.encode(file, THUMB_SIDE, format, true);
    if (data === null) return null;
    await fs.mkdir(path.dirname(thumb), { recursive: true, mode: 0o700 });
    await fs.writeFile(thumb, data, { mode: 0o600 });
    return { file: thumb, mime: thumbMime };
  };

  const missing = () => new Response(null, { status: 404 });

  return {
    fileOf,

    importBytes: async (name, data) => {
      if (!(data instanceof Uint8Array)) throw new TypeError('image bytes must be a Uint8Array');
      return keep(typeof name === 'string' ? name : '', data);
    },

    importUrl: async (value) => {
      if (typeof value !== 'string' || value.length > 4096) throw new TypeError('not a web address');
      let url: URL;
      try { url = new URL(value); } catch { throw new TypeError('not a web address'); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw refuse('Only web images (http or https) can be fetched.');
      if (url.username || url.password) throw refuse('That address carries a password; save the image and drop the file instead.');
      let res: Response;
      try {
        // The dropped address itself, once: a redirect elsewhere is refused, and nothing is sent but the request.
        res = await opts.fetch(url.href, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'image/*' } });
      } catch {
        throw refuse('That image could not be fetched. Save it and drop the file instead.');
      }
      if (!res.ok) throw refuse(`That image could not be fetched (${res.status}).`);
      const bytes = await readCapped(res, MAX_BOARD_IMAGE_BYTES);
      const kind = sniffImage(bytes);
      if (!kind) throw refuse('That address is not an image the board can show.');
      return keep(nameFromUrl(url, kind.ext), bytes);
    },

    serve: async (request) => {
      if (!['GET', 'HEAD'].includes(request.method)) return missing();
      let url: URL;
      try { url = new URL(request.url); } catch { return missing(); }
      let id: string;
      try { id = decodeURIComponent(url.pathname.slice(1)); } catch { return missing(); }
      const item = imageFor(id);
      if (!item) return missing();
      if (item.src.kind === 'copy' ? !COPY_FILE.test(item.src.file) : !isImagePath(item.src.path)) return missing();
      const file = fileOf(item.src);
      const mime = imageMimeOf(file);
      try {
        if (!mime || !(await fs.stat(file)).isFile()) return missing();
        const thumb = url.searchParams.get('size') === 'thumb' ? await thumbOf(file).catch(() => null) : null;
        const shown = thumb ?? { file, mime };
        const range = request.headers.get('Range');
        const res = await opts.fetchFile(pathToFileURL(shown.file).href, { method: request.method, headers: range ? { Range: range } : {} });
        const headers = new Headers(res.headers);
        headers.set('Content-Type', shown.mime);
        headers.set('X-Content-Type-Options', 'nosniff');
        // An SVG is drawn as an image only; nothing in it may run or load.
        headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        // The address names the file's version, so a copy (never changed) and a versioned file keep.
        headers.set('Cache-Control', item.src.kind === 'copy' || url.searchParams.get('v') !== '0' ? 'private, max-age=31536000, immutable' : 'no-store');
        return new Response(res.body, { status: res.status, headers });
      } catch {
        return missing();
      }
    },

    chatImage: async (id) => {
      const item = typeof id === 'string' ? imageFor(id) : undefined;
      if (!item) throw refuse('That image is no longer on the board.');
      const file = fileOf(item.src);
      const mime = imageMimeOf(file);
      let stat;
      try { stat = await fs.stat(file); } catch { throw refuse(`${item.name} is missing.`); }
      const base = item.name.replace(/\.[^.]+$/, '') || 'image';
      if (mime && CHAT_IMAGE_TYPES.has(mime) && stat.size <= CHAT_IMAGE_BYTES) {
        return { name: item.name, mime, data: new Uint8Array(await fs.readFile(file)) };
      }
      // Too large, or a type a chat does not take: a resized copy goes instead.
      for (const side of [2048, 1400, 1000]) {
        const data = opts.image.encode(file, side, 'jpg', false);
        if (data === null) break;
        if (data.byteLength <= CHAT_IMAGE_BYTES) return { name: `${base}.jpg`, mime: 'image/jpeg', data: new Uint8Array(data) };
      }
      throw refuse(`${item.name} can’t be attached as an image.`);
    },

    sweep: async () => {
      // A copy any item still names (an image, or a picture in a note) stays.
      const named = new Set(opts.items().flatMap((it) => picturesOf(it).flatMap((src) => (src.kind === 'copy' ? [src.file] : []))));
      const now = Date.now();
      let names: string[];
      try { names = await fs.readdir(dir); } catch { return; }
      for (const name of names) {
        if (!COPY_FILE.test(name) || named.has(name)) continue;
        const file = path.join(dir, name);
        try {
          if (now - (await fs.stat(file)).mtimeMs > SWEEP_AGE_MS) await fs.rm(file, { force: true });
        } catch { /* gone already */ }
      }
      // Thumbnails are made again when wanted; those of files long unchanged or gone go.
      try {
        for (const name of await fs.readdir(path.join(dir, THUMB_DIR))) {
          const file = path.join(dir, THUMB_DIR, name);
          const stat = await fs.stat(file).catch(() => null);
          if (stat && now - stat.atimeMs > 60 * 24 * 3600 * 1000) await fs.rm(file, { force: true }).catch(() => {});
        }
      } catch { /* no thumbnails yet */ }
    },
  };
}

// ---------- files the board refers to by path: drawn again when they change ----------

export interface FileWatchOptions {
  items(): BoardItem[];
  /** Records a change on the board (a layout op, so it is saved and pushed). */
  edit(id: string, patch: { version?: number; missing?: boolean }): void;
  /** fs.watchFile and fs.unwatchFile, or stand-ins in a test. */
  watch(file: string, onChange: (mtimeMs: number) => void): void;
  unwatch(file: string): void;
  /** The file's modification time, or null when it is gone. */
  stat(file: string): Promise<number | null>;
}

export interface BoardFileWatch {
  /** Watches exactly the files the board's items name now; call it whenever the board changes. */
  sync(): void;
  stop(): void;
}

/** What a referenced file's state means for its items: the patches that bring each up to date. */
export function filePatches(items: BoardItem[], file: string, mtimeMs: number | null): { id: string; patch: { version?: number; missing?: boolean } }[] {
  const out: { id: string; patch: { version?: number; missing?: boolean } }[] = [];
  for (const it of items) {
    if (it.kind !== 'image' || it.src.kind !== 'path' || it.src.path !== file) continue;
    if (mtimeMs === null) { if (!it.missing) out.push({ id: it.id, patch: { missing: true } }); continue; }
    const patch: { version?: number; missing?: boolean } = {};
    if (it.version !== mtimeMs) patch.version = mtimeMs;
    if (it.missing) patch.missing = false;
    if (Object.keys(patch).length > 0) out.push({ id: it.id, patch });
  }
  return out;
}

export function watchBoardFiles(opts: FileWatchOptions): BoardFileWatch {
  const watched = new Set<string>();
  const update = (file: string, mtimeMs: number | null) => {
    for (const { id, patch } of filePatches(opts.items(), file, mtimeMs)) opts.edit(id, patch);
  };
  return {
    sync() {
      const wanted = new Set(opts.items().flatMap((it) => (it.kind === 'image' && it.src.kind === 'path' ? [it.src.path] : [])));
      for (const file of watched) {
        if (!wanted.has(file)) { opts.unwatch(file); watched.delete(file); }
      }
      for (const file of wanted) {
        if (watched.has(file)) continue;
        watched.add(file);
        // A file watched for the first time is looked at now: it may have changed, or gone, meanwhile.
        void opts.stat(file).then((m) => { if (watched.has(file)) update(file, m); }, () => {});
        opts.watch(file, (m) => update(file, m > 0 ? m : null));
      }
    },
    stop() {
      for (const file of watched) opts.unwatch(file);
      watched.clear();
    },
  };
}
