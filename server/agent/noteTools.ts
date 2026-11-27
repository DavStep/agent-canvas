// The canvas agent's tools for the owner's notes (shared/boardNotes.ts): list them, write a new
// one, change one's words, colour or pictures, and take one off the board. A picture comes in by
// its absolute path and is copied into the app's data folder (electron/noteImages.ts), so the
// note keeps it when the original moves. tools.ts adds these to CANVAS_TOOLS and notesOverview to
// canvas_overview. Only types come from tools.ts, so importing this file never runs tools.ts first.
import path from 'node:path';
import { z } from 'zod';
import type { ItemPlace } from '../../shared/boardItems.ts';
import {
  isNoteTitle, MAX_NOTE_IMAGES, MAX_NOTE_TEXT, MAX_NOTE_TITLE, NOTE_HEIGHT, NOTE_HUES, NOTE_WIDTH, newNote, noteById, noteTitle,
  type NoteImage, type NoteItem, type NotePatch,
} from '../../shared/boardNotes.ts';
import type { Layout, ZoneLayout } from '../../shared/types.ts';
import type { CanvasApi, CanvasTool, define as Define, ToolResult } from './tools.ts';

const ok = (text: string): ToolResult => ({ text, isError: false });
const fail = (text: string): ToolResult => ({ text, isError: true });

/** What the agent needs to keep a picture for a note. */
export interface NotesApi {
  /** Copies an image file into the app's data folder; throws a one-line reason when it cannot. */
  importFile(file: string): Promise<NoteImage>;
}

/** Pulled up to just below the cards of the zone's first column (web/src/board/flowItems.ts). */
const BELOW_CARDS = 20_000;

/** Where a note the agent writes goes: below a zone's cards, or free above the zones' top left. */
export function agentNotePlace(layout: Layout, zone: string | null): ItemPlace {
  if (zone !== null) return { zone, col: 0, top: BELOW_CARDS };
  const placed = layout.zones.filter((z) => z.x !== null && z.y !== null);
  const free = (layout.notes ?? []).filter((n) => n.place.zone === null).length;
  if (placed.length === 0) return { zone: null, x: 40 + 32 * free, y: 40 + 32 * free };
  const left = Math.min(...placed.map((z) => z.x!));
  const top = Math.min(...placed.map((z) => z.y!));
  // Each further free note steps along a little, so none hides another.
  return { zone: null, x: left + 32 * free, y: top - NOTE_HEIGHT - 48 - 24 * (free % 4) };
}

/** The notes on the board, for canvas_overview; nothing when there are none. */
export function notesOverview(layout: Layout): { notes?: object[] } {
  const notes = layout.notes ?? [];
  if (notes.length === 0) return {};
  return { notes: notes.map((n) => ({ id: n.id, title: noteTitle(n), zone: n.place.zone, pictures: n.images?.length ?? 0 })) };
}

const zoneIn = (layout: Layout, id: string): ZoneLayout | undefined => layout.zones.find((z) => z.id === id);

const titleArg = z.string().max(MAX_NOTE_TITLE).refine(isNoteTitle, 'Use a single line').optional()
  .describe('The title shown in the note header (empty clears it)');
const imagesArg = z.array(z.string()).max(MAX_NOTE_IMAGES).optional();
const colorArg = z.number().int().min(0).max(NOTE_HUES - 1).optional()
  .describe('Its colour: 0-5 are the zone colours in order, 6 is a quiet grey');

/** Copies each path in, or says which one could not be. */
async function keepPictures(api: CanvasApi, paths: string[]): Promise<NoteImage[] | string> {
  if (!api.notes) return 'Pictures in notes are not available here.';
  const out: NoteImage[] = [];
  for (const p of paths) {
    if (!p.startsWith('/')) return `${p} is not an absolute path.`;
    try {
      out.push(await api.notes.importFile(path.resolve(p)));
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return out;
}

const describe = (note: NoteItem, layout: Layout): string => {
  const where = note.place.zone === null ? 'free on the canvas' : `in the zone "${zoneIn(layout, note.place.zone)?.name ?? note.place.zone}"`;
  const pics = note.images?.length ? `, ${note.images.length} picture${note.images.length === 1 ? '' : 's'}` : '';
  return `"${noteTitle(note)}" (id ${note.id}, ${where}${pics})`;
};

export function noteTools(define: typeof Define): CanvasTool[] {
  return [
    define({
      name: 'list_notes',
      description: "The owner's notes on the canvas: each one's id, title, where it is, its pictures' names and its full text (plain paragraphs with a little Markdown: headings, bold, lists, `- [ ]` checkboxes). Read-only.",
      shape: { id: z.string().optional().describe('Just this note') },
      safe: true, readOnly: true,
      handler: async (api, { id }) => {
        const layout = api.snapshot().layout;
        const notes = id === undefined ? layout.notes ?? [] : (layout.notes ?? []).filter((n) => n.id === id);
        if (id !== undefined && notes.length === 0) return fail(`No note has the id ${id}. list_notes lists them.`);
        if (notes.length === 0) return ok('There are no notes on the canvas.');
        return ok(JSON.stringify(notes.map((n) => ({
          id: n.id, title: n.title, zone: n.place.zone, color: n.hueIndex,
          ...(n.editedAt ? { editedAt: new Date(n.editedAt).toISOString() } : {}),
          ...(n.images?.length ? { pictures: n.images.map((img) => img.name) } : {}),
          text: n.text,
        })), null, 1));
      },
    }),
    define({
      name: 'create_note',
      description: 'Writes a new note on the canvas, for the owner to read and edit: plain paragraphs with a little Markdown (# headings, **bold**, - lists, - [ ] checkboxes, links). With zoneId it goes into that zone below its cards; without, it floats free above the zones. Pictures come by absolute path and are copied into the note. Answers with the note id.',
      shape: {
        title: titleArg,
        text: z.string().max(MAX_NOTE_TEXT).describe("The note's text"),
        zoneId: z.string().optional().describe('The zone to put it in; leave out for a free note'),
        color: colorArg,
        images: imagesArg.describe('Absolute paths of image files to attach (PNG, JPEG, GIF, WebP, AVIF, SVG or BMP)'),
      },
      safe: true,
      handler: async (api, args) => {
        const layout = api.snapshot().layout;
        if (args.zoneId !== undefined && !zoneIn(layout, args.zoneId)) return fail(`No zone has the id ${args.zoneId}. canvas_overview lists the zones.`);
        const pictures = await keepPictures(api, args.images ?? []);
        if (typeof pictures === 'string') return fail(pictures);
        const note = newNote(agentNotePlace(layout, args.zoneId ?? null), {
          ...(args.title !== undefined ? { title: args.title } : {}), text: args.text, ...(args.color !== undefined ? { hueIndex: args.color } : {}), images: pictures, editedAt: api.now(),
          width: NOTE_WIDTH, height: NOTE_HEIGHT,
        });
        api.applyLayout({ type: 'addNote', note });
        const added = noteById(api.snapshot().layout, note.id);
        if (!added) return fail('The note could not be added (the canvas may hold as many notes as it can).');
        return ok(`Wrote the note ${describe(added, api.snapshot().layout)}.`);
      },
    }),
    define({
      name: 'update_note',
      description: "Changes a note: its title, its whole text (send the full new text; list_notes shows the current one), its colour, pictures to add by absolute path, or pictures to take off by name. Leave out what stays.",
      shape: {
        id: z.string().describe('The note id'),
        title: titleArg,
        text: z.string().max(MAX_NOTE_TEXT).optional().describe('The new full text'),
        color: colorArg,
        addImages: imagesArg.describe('Absolute paths of image files to attach'),
        removeImages: z.array(z.string()).max(MAX_NOTE_IMAGES).optional().describe('Names of pictures in the note to take off'),
      },
      safe: true,
      handler: async (api, args) => {
        const note = noteById(api.snapshot().layout, args.id);
        if (!note) return fail(`No note has the id ${args.id}. list_notes lists them.`);
        const patch: NotePatch = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.text !== undefined) patch.text = args.text;
        if (args.color !== undefined) patch.hueIndex = args.color;
        if (args.addImages?.length || args.removeImages?.length) {
          const gone = new Set(args.removeImages ?? []);
          const missing = [...gone].filter((name) => !note.images?.some((img) => img.name === name));
          if (missing.length > 0) return fail(`The note has no picture named ${missing.join(', ')}.`);
          const kept = (note.images ?? []).filter((img) => !gone.has(img.name));
          if (kept.length + (args.addImages?.length ?? 0) > MAX_NOTE_IMAGES) return fail(`A note holds at most ${MAX_NOTE_IMAGES} pictures.`);
          const added = await keepPictures(api, args.addImages ?? []);
          if (typeof added === 'string') return fail(added);
          patch.images = [...kept, ...added];
        }
        if (Object.keys(patch).length === 0) return fail('Nothing to change: give title, text, color, addImages or removeImages.');
        patch.editedAt = api.now();
        api.applyLayout({ type: 'editNote', id: note.id, patch });
        const now = noteById(api.snapshot().layout, note.id) ?? note;
        return ok(`Updated the note ${describe(now, api.snapshot().layout)}.`);
      },
    }),
    define({
      name: 'delete_note',
      description: "Takes a note off the canvas, with its text and pictures. The owner may be asked first.",
      shape: { id: z.string().describe('The note id') },
      safe: false,
      handler: async (api, { id }) => {
        const layout = api.snapshot().layout;
        const note = noteById(layout, id);
        if (!note) return fail(`No note has the id ${id}. list_notes lists them.`);
        api.applyLayout({ type: 'removeNote', id });
        return ok(`Deleted the note "${noteTitle(note)}".`);
      },
    }),
  ];
}
