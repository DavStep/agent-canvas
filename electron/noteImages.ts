// A note's pictures in the main process: copies kept in the app's data folder (`note-images/`),
// made smaller once on the way in when they are huge, thumbnails for the note itself, the
// `canvas-media://note/<note id>?img=<picture id>` responses the page draws, and a picture as a
// chat takes one (a note dragged into a message). Only a picture a note on the board names is
// ever served, and only as an image; a copy's name is random hex.
// Kept apart from board images (boardImages.ts), whose sweep keeps only what board items name.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COPY_FILE, imageMimeOf, isImagePath } from '../shared/boardItems.ts';
import { newNoteImageId, type NoteImage, type NoteItem } from '../shared/boardNotes.ts';
import { MAX_BOARD_IMAGE_BYTES, sniffImage, type ImageTools } from './boardImages.ts';

/** A picture kept longer than this on its longest side is stored at this size: a note shows a
    thumbnail, and the viewer fits the window, so nothing larger is ever drawn. */
export const NOTE_IMAGE_SIDE = 2560;
/** The note's own thumbnails: two device px per canvas px of a wide note's picture. */
export const NOTE_THUMB_SIDE = 640;
/** What a chat accepts as an image (web/src/chat/images.tsx): bigger ones go resized. */
const CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** A copy no note names any more is removed once it is this old (an undo may still want it). */
const SWEEP_AGE_MS = 60 * 60 * 1000;
const THUMB_DIR = '.thumbs';

export interface NoteImagesOptions {
  /** The app's data folder for note pictures (the demo's lives in its throwaway profile). */
  dir: string;
  notes(): NoteItem[];
  /** A file:// response (net.fetch), so large pictures stream. */
  fetchFile(url: string, init: RequestInit): Promise<Response>;
  image: ImageTools;
}

export interface NoteImages {
  /** Keeps a copy of dropped, pasted or picked bytes as a new picture (not yet in any note). */
  importBytes(name: unknown, data: unknown): Promise<NoteImage>;
  /** Keeps a copy of an image file on disk (the canvas agent's paths). */
  importFile(file: string): Promise<NoteImage>;
  /** The `canvas-media://note/<note id>?img=<picture id>` response: the picture, or its thumbnail. */
  serve(request: Request): Promise<Response>;
  /** A note's picture as a chat takes one (PNG, JPEG, GIF or WebP up to 5 MB), resized if need be. */
  chatImage(noteId: unknown, imageId: unknown): Promise<{ name: string; mime: string; data: Uint8Array }>;
  /** Removes copies no note names any more (older than an hour), and old thumbnails. */
  sweep(): Promise<void>;
}

const refuse = (message: string): Error => new Error(message);

/** The page's name for a picture, kept to a plain file name. */
const cleanName = (name: string, ext: string): string => {
  const n = name.replace(/[\0/\\]/g, '').trim().slice(0, 200);
  return n === '' ? `Pasted image.${ext}` : n;
};

export function createNoteImages(opts: NoteImagesOptions): NoteImages {
  const { dir } = opts;

  const keep = async (name: string, bytes: Uint8Array): Promise<NoteImage> => {
    if (bytes.byteLength === 0) throw refuse('That image is empty.');
    if (bytes.byteLength > MAX_BOARD_IMAGE_BYTES) throw refuse('That image is too large for a note.');
    const kind = sniffImage(bytes);
    if (!kind) throw refuse('That isn’t an image a note can show (PNG, JPEG, GIF, WebP, AVIF, SVG or BMP).');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stem = randomBytes(16).toString('hex');
    let file = `${stem}.${kind.ext}`;
    await fs.writeFile(path.join(dir, file), bytes, { mode: 0o600 });
    // A huge photo or screenshot is kept at a size the note can ever draw; a GIF keeps its
    // animation and an SVG its sharpness, so both stay as they came.
    if (kind.mime !== 'image/gif' && kind.mime !== 'image/svg+xml') {
      const format = kind.mime === 'image/jpeg' ? 'jpg' : 'png';
      const smaller = opts.image.encode(path.join(dir, file), NOTE_IMAGE_SIDE, format, true);
      if (smaller !== null && smaller.byteLength > 0) {
        const next = `${stem}.${format}`;
        await fs.writeFile(path.join(dir, next), smaller, { mode: 0o600 });
        if (next !== file) await fs.rm(path.join(dir, file), { force: true });
        file = next;
      }
    }
    return { id: newNoteImageId(), src: { kind: 'copy', file }, name: cleanName(name, kind.ext) };
  };

  const pictureOf = (noteId: string, imageId: string): NoteImage | undefined =>
    opts.notes().find((n) => n.id === noteId)?.images?.find((img) => img.id === imageId);
  const fileOf = (img: NoteImage): string | null =>
    img.src.kind === 'copy' && COPY_FILE.test(img.src.file) ? path.join(dir, img.src.file) : null;

  const thumbOf = async (file: string): Promise<{ file: string; mime: string } | null> => {
    const mime = imageMimeOf(file);
    if (!mime || mime === 'image/gif' || mime === 'image/svg+xml') return null;
    const stat = await fs.stat(file);
    const format = mime === 'image/jpeg' ? 'jpg' : 'png';
    const key = createHash('sha1').update(`${file}\0${stat.mtimeMs}\0${stat.size}\0${NOTE_THUMB_SIDE}`).digest('hex');
    const thumb = path.join(dir, THUMB_DIR, `${key}.${format}`);
    const thumbMime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    try {
      await fs.access(thumb);
      return { file: thumb, mime: thumbMime };
    } catch { /* not made yet */ }
    const data = opts.image.encode(file, NOTE_THUMB_SIDE, format, true);
    if (data === null) return null;
    await fs.mkdir(path.dirname(thumb), { recursive: true, mode: 0o700 });
    await fs.writeFile(thumb, data, { mode: 0o600 });
    return { file: thumb, mime: thumbMime };
  };

  const missing = () => new Response(null, { status: 404 });

  return {
    importBytes: async (name, data) => {
      if (!(data instanceof Uint8Array)) throw new TypeError('image bytes must be a Uint8Array');
      return keep(typeof name === 'string' ? name : '', data);
    },

    importFile: async (file) => {
      if (!isImagePath(file)) throw refuse(`${file} is not an image file a note can show (PNG, JPEG, GIF, WebP, AVIF, SVG or BMP).`);
      let stat;
      try { stat = await fs.stat(file); } catch { throw refuse(`${file} does not exist.`); }
      if (!stat.isFile()) throw refuse(`${file} is not a file.`);
      if (stat.size > MAX_BOARD_IMAGE_BYTES) throw refuse(`${file} is too large for a note.`);
      return keep(path.basename(file), new Uint8Array(await fs.readFile(file)));
    },

    serve: async (request) => {
      if (!['GET', 'HEAD'].includes(request.method)) return missing();
      let url: URL;
      try { url = new URL(request.url); } catch { return missing(); }
      let noteId: string;
      try { noteId = decodeURIComponent(url.pathname.slice(1)); } catch { return missing(); }
      const img = pictureOf(noteId, url.searchParams.get('img') ?? '');
      const file = img && fileOf(img);
      if (!file) return missing();
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
        // A copy never changes, so its address may be kept.
        headers.set('Cache-Control', 'private, max-age=31536000, immutable');
        return new Response(res.body, { status: res.status, headers });
      } catch {
        return missing();
      }
    },

    chatImage: async (noteId, imageId) => {
      const img = typeof noteId === 'string' && typeof imageId === 'string' ? pictureOf(noteId, imageId) : undefined;
      const file = img && fileOf(img);
      if (!img || !file) throw refuse('That picture is no longer in the note.');
      const mime = imageMimeOf(file);
      let stat;
      try { stat = await fs.stat(file); } catch { throw refuse(`${img.name} is missing.`); }
      const base = img.name.replace(/\.[^.]+$/, '') || 'image';
      if (mime && CHAT_IMAGE_TYPES.has(mime) && stat.size <= CHAT_IMAGE_BYTES) {
        return { name: img.name, mime, data: new Uint8Array(await fs.readFile(file)) };
      }
      // Too large, or a type a chat does not take: a resized copy goes instead.
      for (const side of [2048, 1400, 1000]) {
        const data = opts.image.encode(file, side, 'jpg', false);
        if (data === null) break;
        if (data.byteLength <= CHAT_IMAGE_BYTES) return { name: `${base}.jpg`, mime: 'image/jpeg', data: new Uint8Array(data) };
      }
      throw refuse(`${img.name} can’t be attached as an image.`);
    },

    sweep: async () => {
      const named = new Set(opts.notes().flatMap((n) => (n.images ?? []).flatMap((img) => (img.src.kind === 'copy' ? [img.src.file] : []))));
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
