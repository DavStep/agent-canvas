import { describe, expect, it } from 'vitest';
import { applyLayoutOp } from '../server/layoutOps.ts';
import {
  cleanNotes, duplicateNote, MAX_NOTE_IMAGES, MAX_NOTES, newNote, NOTE_MAX, NOTE_MIN_H, NOTE_MIN_W, NOTE_PLAIN, noteImageUrl,
  noteMatches, noteTitle, parseNoteOp, releaseNotes, taskLine, toggleTask, withCleanNotes, type NoteImage,
} from './boardNotes.ts';
import type { Layout } from './types.ts';

const empty = (): Layout => ({ version: 1, zones: [], assignments: {} });
const pic = (id: string, name = 'shot.png'): NoteImage => ({ id, src: { kind: 'copy', file: '0123456789abcdef0123456789abcdef.png' }, name });
const free = { zone: null, x: 10, y: 20 } as const;

describe('a new note', () => {
  it('opens a plain card wide with no text, at its place', () => {
    const note = newNote(free);
    expect(note.id).toMatch(/^note:[a-f0-9]{16}$/);
    expect(note).toMatchObject({ place: free, width: 248, height: 152, text: '', hueIndex: NOTE_PLAIN });
    expect(note.images).toBeUndefined();
  });

  it('keeps its size within bounds and drops bad pictures', () => {
    const note = newNote(free, { width: 5, height: 99_999, images: [pic('ni:aaaaaaaa'), { id: 'bad' } as unknown as NoteImage, pic('ni:aaaaaaaa')] });
    expect(note.width).toBe(NOTE_MIN_W);
    expect(note.height).toBe(NOTE_MAX);
    expect(note.images?.map((i) => i.id)).toEqual(['ni:aaaaaaaa']);
  });

  it('duplicates with a new id and the same pictures', () => {
    const note = newNote(free, { text: 'hi', images: [pic('ni:aaaaaaaa')] });
    const copy = duplicateNote(note, { zone: null, x: 40, y: 50 }, 7);
    expect(copy.id).not.toBe(note.id);
    expect(copy).toMatchObject({ text: 'hi', place: { x: 40, y: 50 }, editedAt: 7 });
    expect(copy.images).toEqual(note.images);
    expect(copy.images).not.toBe(note.images);
  });
});

describe('note ops', () => {
  it('add, edit, move, resize and remove a note through the one layout path', () => {
    const note = newNote(free);
    let layout = applyLayoutOp(empty(), { type: 'addNote', note });
    expect(layout.notes).toEqual([note]);
    // Adding the same id twice is a no-op.
    expect(applyLayoutOp(layout, { type: 'addNote', note })).toBe(layout);
    layout = applyLayoutOp(layout, { type: 'editNote', id: note.id, patch: { text: '# Plan\n- [ ] ship', hueIndex: 2, editedAt: 5 } });
    expect(layout.notes![0]).toMatchObject({ text: '# Plan\n- [ ] ship', hueIndex: 2, editedAt: 5 });
    layout = applyLayoutOp(layout, { type: 'moveNote', id: note.id, place: { zone: null, x: 100.4, y: -3.6 } });
    expect(layout.notes![0]!.place).toEqual({ zone: null, x: 100, y: -4 });
    layout = applyLayoutOp(layout, { type: 'resizeNote', id: note.id, width: 10_000, height: 10 });
    expect(layout.notes![0]).toMatchObject({ width: NOTE_MAX, height: NOTE_MIN_H });
    layout = applyLayoutOp(layout, { type: 'editNote', id: note.id, patch: { images: [pic('ni:bbbbbbbb')] } });
    expect(layout.notes![0]!.images).toHaveLength(1);
    layout = applyLayoutOp(layout, { type: 'editNote', id: note.id, patch: { images: [] } });
    expect(layout.notes![0]!.images).toBeUndefined();
    layout = applyLayoutOp(layout, { type: 'removeNote', id: note.id });
    expect(layout.notes).toEqual([]);
  });

  it('an unchanged note keeps the same layout object (no save)', () => {
    const note = newNote(free, { text: 'same' });
    const layout = applyLayoutOp(empty(), { type: 'addNote', note });
    expect(applyLayoutOp(layout, { type: 'editNote', id: note.id, patch: { text: 'same' } })).toBe(layout);
    expect(applyLayoutOp(layout, { type: 'removeNote', id: 'note:ffffffffffffffff' })).toBe(layout);
  });

  it('stops at the most notes a board keeps', () => {
    let layout = empty();
    for (let i = 0; i < MAX_NOTES + 3; i++) layout = applyLayoutOp(layout, { type: 'addNote', note: newNote(free) });
    expect(layout.notes).toHaveLength(MAX_NOTES);
  });

  it('a deleted zone lets its notes go free about where they were', () => {
    let layout: Layout = { ...empty(), zones: [{ id: 'z1', name: 'Z', kind: 'custom', folder: null, x: 100, y: 200, hueIndex: 0 }] };
    const inZone = newNote({ zone: 'z1', col: 1, top: 30 });
    layout = applyLayoutOp(layout, { type: 'addNote', note: inZone });
    layout = applyLayoutOp(layout, { type: 'deleteZone', id: 'z1' });
    expect(layout.notes![0]!.place).toEqual({ zone: null, x: 100 + 16 + 244, y: 200 + 40 + 30 });
    expect(releaseNotes(layout, { id: 'z1', x: 0, y: 0 })).toBe(layout);
  });
});

describe('what the page may send', () => {
  it('takes well-formed ops and refuses the rest', () => {
    const note = newNote(free);
    expect(parseNoteOp({ type: 'addNote', note })).toEqual({ type: 'addNote', note });
    expect(parseNoteOp({ type: 'addNote', note: { ...note, id: 'zone:x' } })).toBeNull();
    expect(parseNoteOp({ type: 'addNote', note: { ...note, text: 'a\0b' } })).toBeNull();
    expect(parseNoteOp({ type: 'editNote', id: note.id, patch: {} })).toBeNull();
    expect(parseNoteOp({ type: 'editNote', id: note.id, patch: { hueIndex: 9 } })).toBeNull();
    expect(parseNoteOp({ type: 'editNote', id: note.id, patch: { images: Array.from({ length: MAX_NOTE_IMAGES + 1 }, (_, i) => pic(`ni:${String(i).padStart(8, '0')}`)) } })).toBeNull();
    expect(parseNoteOp({ type: 'editNote', id: note.id, patch: { text: 'x', junk: 1 } })).toEqual({ type: 'editNote', id: note.id, patch: { text: 'x' } });
    expect(parseNoteOp({ type: 'resizeNote', id: note.id, width: 1, height: 1 })).toEqual({ type: 'resizeNote', id: note.id, width: NOTE_MIN_W, height: NOTE_MIN_H });
    expect(parseNoteOp({ type: 'moveNote', id: note.id, place: { zone: null, x: 'a', y: 0 } })).toBeNull();
    expect(parseNoteOp({ type: 'removeNote', id: '../x' })).toBeNull();
    expect(parseNoteOp({ type: 'moveZone' })).toBeNull();
  });

  it('a saved layout keeps its good notes and drops damaged ones', () => {
    const good = newNote(free, { text: 'ok' });
    const layout = withCleanNotes({ ...empty(), notes: [good, { id: 'note:zz' }, good] as never });
    expect(layout.notes).toEqual([good]);
    expect(withCleanNotes(empty()).notes).toBeUndefined();
    expect(cleanNotes('nope')).toEqual([]);
  });
});

describe('reading a note', () => {
  it('moves a legacy heading or short label into the title only once', () => {
    const { title: _, ...legacy } = newNote(free);
    for (const first of ['# Stuff to add', 'Stuff to add']) {
      const [note] = cleanNotes([{ ...legacy, text: first + '\r\nNext line\n- [ ] task' }]);
      expect(note).toMatchObject({ title: 'Stuff to add', text: 'Next line\n- [ ] task' });
      expect(cleanNotes([note])).toEqual([note]);
    }
    for (const text of ['A sentence.\nBody', '- [ ] buy milk', '    indented code', '#'.repeat(200)]) {
      expect(cleanNotes([{ ...legacy, text }])[0]).toMatchObject({ title: '', text });
    }
    expect(cleanNotes([{ ...legacy, title: '', text: 'Keep in body' }])[0]?.text).toBe('Keep in body');
    expect(noteTitle({ title: '' })).toBe('Untitled');
  });

  it('is found by its words and its pictures’ names', () => {
    const note = { title: 'Shopping', text: 'Buy milk\nand eggs', images: [pic('ni:aaaaaaaa', 'receipt.jpg')] };
    expect(noteMatches(note, ['shopping', 'milk'])).toBe(true);
    expect(noteMatches(note, ['milk', 'eggs'])).toBe(true);
    expect(noteMatches(note, ['receipt'])).toBe(true);
    expect(noteMatches(note, ['bread'])).toBe(false);
    expect(noteMatches(note, [])).toBe(false);
  });

  it('ticks the nth checkbox of the whole note', () => {
    const text = '- [ ] one\nplain\n  * [x] two\n- [ ] three';
    expect(taskLine('  * [x] two')).toEqual({ indent: '  ', bullet: '*', checked: true, label: 'two' });
    expect(taskLine('- not a task')).toBeNull();
    expect(toggleTask(text, 0)).toBe('- [x] one\nplain\n  * [x] two\n- [ ] three');
    expect(toggleTask(text, 1)).toBe('- [ ] one\nplain\n  * [ ] two\n- [ ] three');
    expect(toggleTask(text, 5)).toBe(text);
  });

  it('asks main for its pictures by note and picture', () => {
    expect(noteImageUrl('note:abcdef0123456789', 'ni:aaaaaaaa', 'thumb')).toBe('canvas-media://note/note%3Aabcdef0123456789?img=ni%3Aaaaaaaaa&size=thumb');
  });
});
