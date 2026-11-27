// Notes on the board: a card the owner writes in, with pictures attached. A note is kept in the
// saved layout beside the zones, so the page, the reader and the canvas agent change one with
// layout ops exactly as they change a zone, and a reload or a restart finds it where it was.
// A note floats free on the board at a point, or sits in a zone's grid at a column and a top,
// which is how board images are placed too (shared/boardItems.ts): a note reuses that place and
// its check, so the zone's cards flow around both the same way (web/src/board/flowItems.ts).
// A note's pictures are always copies in the app's data folder, never files on disk the board
// watches: a note keeps what was put in it even when the original is moved or deleted.
// Pure, and safe for the sandboxed preload: no `node:` imports.
import { isImageSource, isItemPlace, type ImageSource, type ItemPlace } from './boardItems.ts';
import type { Layout } from './types.ts';

/** A note's colour is an index into the chart tokens, as a zone's is; 6 is the quiet grey. */
export const NOTE_HUES = 7;
/** A new note's colour: the quiet grey, a plain sheet. */
export const NOTE_PLAIN = 6;
export const MAX_NOTES = 200;
export const MAX_NOTE_TITLE = 160;
export const MAX_NOTE_TEXT = 20_000;
export const MAX_NOTE_IMAGES = 12;
/** A note opens about a card wide, with room for a few lines. */
export const NOTE_WIDTH = 248;
export const NOTE_HEIGHT = 152;
/** A note can be dragged no smaller than a title and no larger than the board's other things. */
export const NOTE_MIN_W = 128;
export const NOTE_MIN_H = 64;
export const NOTE_MAX = 2400;
const MAX_NAME = 255;
const NOTE_ID = /^note:[a-f0-9]{8,40}$/;
const NOTE_IMAGE_ID = /^ni:[a-f0-9]{8,32}$/;

/** One picture in a note: a copy in the data folder, under the name it arrived with. */
export interface NoteImage {
  id: string;
  src: ImageSource;
  name: string;
  /** Its own size in pixels, once known, so its thumbnail keeps its shape. */
  natural?: { width: number; height: number };
}

export interface NoteItem {
  id: string;
  place: ItemPlace;
  /** Its frame on the board, canvas px. */
  width: number;
  height: number;
  title: string;
  /** Paragraphs with a little Markdown (web/src/notes/NoteBody.tsx). */
  text: string;
  hueIndex: number;
  images?: NoteImage[];
  /** When it was last written to (epoch ms), for the agent's list and for ordering. */
  editedAt?: number;
}

export interface NotePatch {
  title?: string;
  text?: string;
  hueIndex?: number;
  images?: NoteImage[];
  editedAt?: number;
}

export type NoteOp =
  | { type: 'addNote'; note: NoteItem }
  | { type: 'moveNote'; id: string; place: ItemPlace }
  | { type: 'resizeNote'; id: string; width: number; height: number }
  | { type: 'editNote'; id: string; patch: NotePatch }
  | { type: 'removeNote'; id: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isHue = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < NOTE_HUES;
const isNatural = (v: unknown): v is { width: number; height: number } =>
  isRecord(v) && isNum(v.width) && isNum(v.height) && v.width > 0 && v.height > 0 && v.width <= 100_000 && v.height <= 100_000;

export const isNoteId = (v: unknown): v is string => typeof v === 'string' && NOTE_ID.test(v);
export const isNoteText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NOTE_TEXT && !v.includes('\0');
export const isNoteTitle = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NOTE_TITLE && !/[\r\n\0]/.test(v);
const isW = (v: unknown): v is number => isNum(v) && v >= NOTE_MIN_W && v <= NOTE_MAX;
const isH = (v: unknown): v is number => isNum(v) && v >= NOTE_MIN_H && v <= NOTE_MAX;

export function isNoteImage(v: unknown): v is NoteImage {
  return isRecord(v) && typeof v.id === 'string' && NOTE_IMAGE_ID.test(v.id) && isImageSource(v.src)
    && typeof v.name === 'string' && v.name.length <= MAX_NAME
    && (v.natural === undefined || isNatural(v.natural));
}

/** The pictures of a saved or sent note, each id once: a damaged one is dropped, not the note. */
export function cleanNoteImages(v: unknown): NoteImage[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: NoteImage[] = [];
  for (const img of v) {
    if (!isNoteImage(img) || seen.has(img.id)) continue;
    seen.add(img.id);
    out.push(img.natural
      ? { id: img.id, src: img.src, name: img.name, natural: { width: img.natural.width, height: img.natural.height } }
      : { id: img.id, src: img.src, name: img.name });
    if (out.length >= MAX_NOTE_IMAGES) break;
  }
  return out;
}

export function isNoteItem(v: unknown): v is NoteItem {
  return isRecord(v) && isNoteId(v.id) && isItemPlace(v.place) && isW(v.width) && isH(v.height)
    && isNoteTitle(v.title) && isNoteText(v.text) && isHue(v.hueIndex)
    && (v.images === undefined || (Array.isArray(v.images) && v.images.length <= MAX_NOTE_IMAGES && v.images.every(isNoteImage)))
    && (v.editedAt === undefined || isNum(v.editedAt));
}

/** Older notes stored the heading in the body. Only promote a heading or a short label. */
function migrateNote(value: unknown): unknown {
  if (!isRecord(value) || value.title !== undefined || !isNoteText(value.text)) return value;
  const match = /^(?:[ \t]*\r?\n)*([^\r\n]+)(?:\r?\n|$)/.exec(value.text);
  const line = match?.[1]?.trim() ?? '';
  const heading = /^#{1,6}[ \t]+(.+)$/.exec(line);
  const shortLabel = line.length <= 64 && line.split(/\s+/).length <= 8
    && !/^(?:\s|[-*+>`~#|]|\d+[.)]\s|https?:\/\/|!?\[)/.test(match?.[1] ?? '') && !/[.!?]$/.test(line);
  const title = (heading?.[1] ?? (shortLabel ? line : '')).trim();
  if (!match || !title || !isNoteTitle(title)) return { ...value, title: '' };
  return { ...value, title, text: value.text.slice(match[0].length) };
}

/** The valid notes of a saved or sent list, each id once: a damaged note is dropped, never the layout. */
export function cleanNotes(v: unknown): NoteItem[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: NoteItem[] = [];
  for (const saved of v) {
    const note = migrateNote(saved);
    if (!isNoteItem(note) || seen.has(note.id)) continue;
    seen.add(note.id);
    out.push(note);
    if (out.length >= MAX_NOTES) break;
  }
  return out;
}

/** A layout as loaded from disk, with its notes cleaned (absent stays absent). */
export function withCleanNotes(layout: Layout): Layout {
  if (layout.notes === undefined) return layout;
  return { ...layout, notes: cleanNotes(layout.notes) };
}

const hex = (bytes: number): string => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
/** A fresh note id. */
export const newNoteId = (): string => `note:${hex(8)}`;
/** A fresh picture id, which belongs to its note (two notes may name the same copy). */
export const newNoteImageId = (): string => `ni:${hex(6)}`;

const clampW = (n: number): number => Math.round(Math.min(NOTE_MAX, Math.max(NOTE_MIN_W, n)));
const clampH = (n: number): number => Math.round(Math.min(NOTE_MAX, Math.max(NOTE_MIN_H, n)));

/** A new note, ready to go on the board with an addNote op. */
export function newNote(place: ItemPlace, opts: {
  id?: string; title?: string; text?: string; hueIndex?: number; width?: number; height?: number; images?: NoteImage[]; editedAt?: number;
} = {}): NoteItem {
  const images = cleanNoteImages(opts.images ?? []);
  return {
    id: opts.id && isNoteId(opts.id) ? opts.id : newNoteId(),
    place,
    width: clampW(opts.width ?? NOTE_WIDTH),
    height: clampH(opts.height ?? NOTE_HEIGHT),
    title: isNoteTitle(opts.title) ? opts.title.trim() : '',
    text: isNoteText(opts.text) ? opts.text! : '',
    hueIndex: isHue(opts.hueIndex) ? opts.hueIndex! : NOTE_PLAIN,
    ...(images.length > 0 ? { images } : {}),
    ...(opts.editedAt !== undefined && isNum(opts.editedAt) ? { editedAt: opts.editedAt } : {}),
  };
}

/** A copy of a note at another place, with a new id; its pictures are the same copies on disk. */
export function duplicateNote(note: NoteItem, place: ItemPlace, at?: number): NoteItem {
  const copy: NoteItem = { ...note, id: newNoteId(), place };
  if (note.images) copy.images = note.images.map((img) => ({ ...img }));
  if (at !== undefined) copy.editedAt = at;
  return copy;
}

/** A sent note op as the reader takes it, or null when it is malformed. */
export function parseNoteOp(v: Record<string, unknown>): NoteOp | null {
  switch (v.type) {
    case 'addNote': {
      const note = migrateNote(v.note);
      return isNoteItem(note) ? { type: 'addNote', note } : null;
    }
    case 'moveNote':
      return isNoteId(v.id) && isItemPlace(v.place) ? { type: 'moveNote', id: v.id, place: v.place } : null;
    case 'resizeNote':
      return isNoteId(v.id) && isNum(v.width) && isNum(v.height)
        ? { type: 'resizeNote', id: v.id, width: clampW(v.width), height: clampH(v.height) } : null;
    case 'editNote': {
      if (!isNoteId(v.id) || !isRecord(v.patch)) return null;
      const p = v.patch;
      const patch: NotePatch = {};
      if (p.title !== undefined) {
        if (!isNoteTitle(p.title)) return null;
        patch.title = p.title.trim();
      }
      if (p.text !== undefined) {
        if (!isNoteText(p.text)) return null;
        patch.text = p.text;
      }
      if (p.hueIndex !== undefined) {
        if (!isHue(p.hueIndex)) return null;
        patch.hueIndex = p.hueIndex;
      }
      if (p.images !== undefined) {
        if (!Array.isArray(p.images) || p.images.length > MAX_NOTE_IMAGES || !p.images.every(isNoteImage)) return null;
        patch.images = cleanNoteImages(p.images);
      }
      if (p.editedAt !== undefined) {
        if (!isNum(p.editedAt)) return null;
        patch.editedAt = p.editedAt;
      }
      return Object.keys(patch).length === 0 ? null : { type: 'editNote', id: v.id, patch };
    }
    case 'removeNote':
      return isNoteId(v.id) ? { type: 'removeNote', id: v.id } : null;
    default:
      return null;
  }
}

export const isNoteOpType = (t: unknown): t is NoteOp['type'] =>
  t === 'addNote' || t === 'moveNote' || t === 'resizeNote' || t === 'editNote' || t === 'removeNote';

function replaceNote(layout: Layout, id: string, update: (note: NoteItem) => NoteItem): Layout {
  const notes = layout.notes ?? [];
  const i = notes.findIndex((n) => n.id === id);
  if (i < 0) return layout;
  const next = update(notes[i]!);
  if (JSON.stringify(next) === JSON.stringify(notes[i])) return layout;
  return { ...layout, notes: notes.map((n, j) => (j === i ? next : n)) };
}

/** One note op on a layout; anything malformed or unknown leaves it as it is. */
export function applyNoteOp(layout: Layout, op: NoteOp): Layout {
  const notes = layout.notes ?? [];
  switch (op.type) {
    case 'addNote':
      if (!isNoteItem(op.note) || notes.some((n) => n.id === op.note.id) || notes.length >= MAX_NOTES) return layout;
      return { ...layout, notes: [...notes, op.note] };
    case 'moveNote':
      if (!isItemPlace(op.place)) return layout;
      return replaceNote(layout, op.id, (n) => ({
        ...n,
        place: op.place.zone === null
          ? { zone: null, x: Math.round(op.place.x), y: Math.round(op.place.y) }
          : { zone: op.place.zone, col: op.place.col, top: Math.round(op.place.top) },
      }));
    case 'resizeNote':
      if (!isNum(op.width) || !isNum(op.height)) return layout;
      return replaceNote(layout, op.id, (n) => ({ ...n, width: clampW(op.width), height: clampH(op.height) }));
    case 'editNote':
      return replaceNote(layout, op.id, (n) => {
        const next: NoteItem = { ...n };
        const { title, text, hueIndex, images, editedAt } = op.patch;
        if (isNoteTitle(title)) next.title = title.trim();
        if (text !== undefined && isNoteText(text)) next.text = text;
        if (hueIndex !== undefined && isHue(hueIndex)) next.hueIndex = hueIndex;
        if (images !== undefined) {
          const kept = cleanNoteImages(images);
          if (kept.length === 0) delete next.images; else next.images = kept;
        }
        if (editedAt !== undefined && isNum(editedAt)) next.editedAt = editedAt;
        return next;
      });
    case 'removeNote':
      if (!notes.some((n) => n.id === op.id)) return layout;
      return { ...layout, notes: notes.filter((n) => n.id !== op.id) };
    default:
      return layout;
  }
}

/** A deleted zone's notes stay on the board, free, at about where they were in the zone. */
export function releaseNotes(layout: Layout, zone: { id: string; x: number | null; y: number | null }): Layout {
  const notes = layout.notes;
  if (!notes?.some((n) => n.place.zone === zone.id)) return layout;
  const x0 = zone.x ?? 0;
  const y0 = zone.y ?? 0;
  return {
    ...layout,
    notes: notes.map((n) => (n.place.zone !== zone.id ? n
      : { ...n, place: { zone: null, x: Math.round(x0 + 16 + n.place.col * 244), y: Math.round(y0 + 40 + n.place.top) } })),
  };
}

/** The notes kept in a zone, and the notes free on the board. */
export const notesInZone = (layout: Layout, zoneId: string): NoteItem[] =>
  (layout.notes ?? []).filter((n) => n.place.zone === zoneId);
export const freeNotes = (layout: Layout): NoteItem[] => (layout.notes ?? []).filter((n) => n.place.zone === null);
export const noteById = (layout: Layout, id: string): NoteItem | undefined => (layout.notes ?? []).find((n) => n.id === id);

/** The name used in the board header, search and the drag ghost. */
export const noteTitle = (note: Pick<NoteItem, 'title'>): string => note.title || 'Untitled';

/** What search matches a note by: everything written in it, and its pictures' names. */
export function noteMatches(note: Pick<NoteItem, 'title' | 'text' | 'images'>, words: string[]): boolean {
  const text = `${note.title} ${note.text} ${(note.images ?? []).map((i) => i.name).join(' ')}`.toLowerCase();
  return words.length > 0 && words.every((w) => text.includes(w));
}

/** Where the board asks main for a note's picture: `thumb` in the note, the file for the viewer. */
export function noteImageUrl(noteId: string, imageId: string, size: 'thumb' | 'full'): string {
  return `canvas-media://note/${encodeURIComponent(noteId)}?img=${encodeURIComponent(imageId)}&size=${size}`;
}

/** A task line's parts: `- [ ] buy milk` is an unticked "buy milk". Null for any other line. */
export function taskLine(line: string): { checked: boolean; label: string; indent: string; bullet: string } | null {
  const m = /^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/.exec(line);
  return m ? { indent: m[1]!, bullet: m[2]!, checked: m[3]! !== ' ', label: m[4]! } : null;
}

/** The text with its `n`th task line (counted over the whole note) ticked or cleared. */
export function toggleTask(text: string, n: number): string {
  let seen = -1;
  return text.split('\n').map((line) => {
    const task = taskLine(line);
    if (task === null || ++seen !== n) return line;
    return `${task.indent}${task.bullet} [${task.checked ? ' ' : 'x'}] ${task.label}`;
  }).join('\n');
}

/** A note's text as a message carries it (dragged into a chat): its words, with the task marks
    kept, since they read as a list there too. */
export const noteMessageText = (note: Pick<NoteItem, 'title' | 'text'>): string =>
  [note.title, note.text.trim()].filter(Boolean).join('\n\n');
