import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newNote, type NoteItem } from '../shared/boardNotes.ts';
import { createNoteImages, NOTE_IMAGE_SIDE, NOTE_THUMB_SIDE, type NoteImagesOptions } from './noteImages.ts';

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');

let dir: string;
let notes: NoteItem[];
const encoded: string[] = [];
/** What encode answers: null leaves the copy as it came. */
let shrink: (max: number, onlyIfLarger: boolean) => Buffer | null;

const store = (patch: Partial<NoteImagesOptions> = {}) => createNoteImages({
  dir,
  notes: () => notes,
  fetchFile: async (url) => new Response(await readFile(fileURLToPath(url))),
  image: {
    encode: (file, max, format, onlyIfLarger) => {
      encoded.push(`${path.basename(file)} ${max} ${format} ${onlyIfLarger}`);
      return shrink(max, onlyIfLarger);
    },
  },
  ...patch,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'canvas-note-images-'));
  notes = [];
  encoded.length = 0;
  shrink = (_max, onlyIfLarger) => (onlyIfLarger ? null : Buffer.from('resized jpg'));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const files = async (): Promise<string[]> => (await readdir(dir)).filter((n) => !n.startsWith('.')).sort();

describe('keeping a picture', () => {
  it('keeps dropped bytes as a copy with a random name, under the name it came with', async () => {
    const img = await store().importBytes('Screen Shot.png', new Uint8Array(PNG));
    expect(img.id).toMatch(/^ni:[a-f0-9]{12}$/);
    expect(img.name).toBe('Screen Shot.png');
    expect(img.src.kind).toBe('copy');
    const file = img.src.kind === 'copy' ? img.src.file : '';
    expect(file).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(await files()).toEqual([file]);
    expect(await readFile(path.join(dir, file))).toEqual(PNG);
    // Asked to be made smaller only when it is larger than a note can draw.
    expect(encoded).toEqual([`${file} ${NOTE_IMAGE_SIDE} png true`]);
  });

  it('keeps a huge picture smaller, and the original is not left behind', async () => {
    shrink = () => Buffer.from('smaller');
    const img = await store().importBytes('huge.png', new Uint8Array(PNG));
    const file = img.src.kind === 'copy' ? img.src.file : '';
    expect(await files()).toEqual([file]);
    expect((await readFile(path.join(dir, file))).toString()).toBe('smaller');
  });

  it('leaves a GIF as it came, so it keeps moving', async () => {
    const img = await store().importBytes('', new Uint8Array(GIF));
    expect(img.name).toBe('Pasted image.gif');
    expect(encoded).toEqual([]);
  });

  it('refuses what is not an image, whatever its name says', async () => {
    await expect(store().importBytes('evil.png', new Uint8Array(Buffer.from('#!/bin/sh\necho hi')))).rejects.toThrow(/isn’t an image/);
    await expect(store().importBytes('empty.png', new Uint8Array())).rejects.toThrow(/empty/);
    await expect(store().importBytes('x.png', 'not bytes')).rejects.toThrow(TypeError);
    expect(await files()).toEqual([]);
  });

  it('copies an image file by its path, and refuses others', async () => {
    const src = path.join(dir, 'outside');
    await (await import('node:fs/promises')).mkdir(src);
    await writeFile(path.join(src, 'diagram.png'), PNG);
    await writeFile(path.join(src, 'notes.txt'), 'hi');
    const img = await store({ dir: path.join(dir, 'kept') }).importFile(path.join(src, 'diagram.png'));
    expect(img.name).toBe('diagram.png');
    await expect(store().importFile(path.join(src, 'notes.txt'))).rejects.toThrow(/not an image/);
    await expect(store().importFile(path.join(src, 'gone.png'))).rejects.toThrow(/does not exist/);
  });
});

describe('serving a picture', () => {
  const at = async () => {
    const s = store();
    const img = await s.importBytes('shot.png', new Uint8Array(PNG));
    const note = newNote({ zone: null, x: 0, y: 0 }, { images: [img] });
    notes = [note];
    return { s, img, note };
  };

  it('serves a picture a note names, as an image only', async () => {
    const { s, img, note } = await at();
    const res = await s.serve(new Request(`canvas-media://note/${encodeURIComponent(note.id)}?img=${img.id}&size=full`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('serves nothing a note does not name', async () => {
    const { s, img, note } = await at();
    expect((await s.serve(new Request(`canvas-media://note/${encodeURIComponent(note.id)}?img=ni:000000000000`))).status).toBe(404);
    expect((await s.serve(new Request(`canvas-media://note/note:ffffffffffffffff?img=${img.id}`))).status).toBe(404);
    expect((await s.serve(new Request(`canvas-media://note/${encodeURIComponent(note.id)}?img=${img.id}`, { method: 'POST' }))).status).toBe(404);
    // A copy name that is not plain hex is never read.
    notes = [{ ...note, images: [{ ...img, src: { kind: 'copy', file: '../../etc/passwd' } }] }];
    expect((await s.serve(new Request(`canvas-media://note/${encodeURIComponent(note.id)}?img=${img.id}`))).status).toBe(404);
  });

  it('makes a thumbnail once and serves it after', async () => {
    const { s, img, note } = await at();
    shrink = (max) => (max === NOTE_THUMB_SIDE ? Buffer.from('thumb') : null);
    const url = `canvas-media://note/${encodeURIComponent(note.id)}?img=${img.id}&size=thumb`;
    expect(Buffer.from(await (await s.serve(new Request(url))).arrayBuffer()).toString()).toBe('thumb');
    encoded.length = 0;
    expect(Buffer.from(await (await s.serve(new Request(url))).arrayBuffer()).toString()).toBe('thumb');
    expect(encoded).toEqual([]);
  });
});

describe('a picture for a chat', () => {
  it('hands a PNG on as it is', async () => {
    const s = store();
    const img = await s.importBytes('shot.png', new Uint8Array(PNG));
    notes = [newNote({ zone: null, x: 0, y: 0 }, { images: [img] })];
    const out = await s.chatImage(notes[0]!.id, img.id);
    expect(out).toMatchObject({ name: 'shot.png', mime: 'image/png' });
    expect(Buffer.from(out.data)).toEqual(PNG);
  });

  it('refuses a picture no note has', async () => {
    await expect(store().chatImage('note:0123456789abcdef', 'ni:000000000000')).rejects.toThrow(/no longer in the note/);
  });
});

describe('sweeping', () => {
  it('removes old copies no note names, keeps named ones and new ones', async () => {
    const s = store();
    const kept = await s.importBytes('kept.png', new Uint8Array(PNG));
    const old = await s.importBytes('old.png', new Uint8Array(PNG));
    const fresh = await s.importBytes('fresh.png', new Uint8Array(PNG));
    notes = [newNote({ zone: null, x: 0, y: 0 }, { images: [kept] })];
    const file = (img: typeof kept) => (img.src.kind === 'copy' ? img.src.file : '');
    const longAgo = new Date(Date.now() - 2 * 3600_000);
    await utimes(path.join(dir, file(kept)), longAgo, longAgo);
    await utimes(path.join(dir, file(old)), longAgo, longAgo);
    await s.sweep();
    expect(await files()).toEqual([file(kept), file(fresh)].sort());
  });
});
