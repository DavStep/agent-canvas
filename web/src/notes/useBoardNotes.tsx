// Notes on the board, for the page (App.tsx): what each zone and the free layer draw, a new note
// where the owner asked for one, moving and resizing them by hand (into a zone and out, as board
// images go: the zone's cards flow around them the same way), sending one to a chat by dropping it
// on a message field, pictures arriving in one, and taking one off with an undo. Every change is
// a layout op, so it shows at once and is saved by the reader with the rest of the layout.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import type { ItemPlace } from '../../../shared/boardItems.ts';
import {
  duplicateNote, MAX_NOTE_IMAGES, NOTE_HEIGHT, NOTE_MAX, NOTE_MIN_H, NOTE_MIN_W, NOTE_WIDTH, newNote, noteMessageText, noteTitle,
  type NoteImage, type NoteItem,
} from '../../../shared/boardNotes.ts';
import type { Layout, LayoutOp } from '../../../shared/types.ts';
import { notesBridge } from '../bridge.ts';
import { trackDrag } from '../canvas/drag.ts';
import { moveBoardItem } from '../board/moveBoardItem.ts';
import type { PanZoom } from '../canvas/usePanZoom.ts';
import { COLUMN_STEP } from '../canvas/zoneFlow.ts';
import type { SearchHits } from '../components/JumpBox.tsx';
import { UndoToast } from '../components/UndoToast.tsx';
import { searchClass } from '../components/Zone.tsx';
import { toBoard, zoneUnder } from '../board/geometry.ts';
import { naturalSize } from '../board/imports.ts';
import { dropFrom, itemLive } from '../board/itemLive.ts';
import type { ZoneItem } from '../board/ZoneItems.tsx';
import { Note } from './Note.tsx';

/** How long a deleted note can be brought back. */
export const NOTE_UNDO_MS = 30_000;
/** A duplicate lands this far from its original. */
const STEP = 24;

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
const clamp = (n: number, lo: number): number => Math.round(Math.min(NOTE_MAX, Math.max(lo, n)));
const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(e));

export interface BoardNotesOptions {
  layout: Layout | null;
  send(op: LayoutOp): Promise<void>;
  workspace: RefObject<HTMLElement | null>;
  view: PanZoom;
  search: SearchHits | null;
}

export interface BoardNotes {
  notes: NoteItem[];
  zoneItems(zoneId: string): readonly ZoneItem[];
  freeItems: ReactNode;
  /** Zones that hold a note: drawn even with no session in them. */
  zoneIds: ReadonlySet<string>;
  overlay: ReactNode;
  /** A new note where a screen point is (in the zone there, or free), opened for writing. */
  createAt(clientX: number, clientY: number, images?: NoteImage[]): void;
}

const NO_ITEMS: readonly ZoneItem[] = [];

export function useBoardNotes({ layout, send, workspace, view, search }: BoardNotesOptions): BoardNotes {
  const notes = useMemo(() => layout?.notes ?? [], [layout?.notes]);
  const [removed, setRemoved] = useState<NoteItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const latest = useRef({ notes, send });
  latest.current = { notes, send };
  const sendOp = useCallback((op: LayoutOp) => { latest.current.send(op).catch(() => {}); }, []);
  const boardEl = useCallback(() => workspace.current?.querySelector<HTMLElement>(':scope .board') ?? null, [workspace]);

  // ---------- a new note ----------

  const placeAt = useCallback((clientX: number, clientY: number, box: { width: number; height: number }): ItemPlace => {
    const ws = workspace.current;
    const k = view.transform.k;
    const zone = ws ? zoneUnder(ws, clientX, clientY, null) : null;
    const cards = zone?.querySelector<HTMLElement>(':scope > .cards')?.getBoundingClientRect();
    if (zone && cards) {
      const x = (clientX - cards.left) / k - box.width / 2;
      return { zone: zone.dataset.zoneId!, col: Math.max(0, Math.round(x / COLUMN_STEP)), top: Math.max(0, Math.round((clientY - cards.top) / k - 20)) };
    }
    const board = boardEl();
    const p = board ? toBoard(board, clientX, clientY, k) : { x: 0, y: 0 };
    // Its top-left corner at the point, as a note stuck down there would be.
    return { zone: null, x: Math.round(p.x), y: Math.round(p.y) };
  }, [boardEl, view, workspace]);

  const createAt = useCallback((clientX: number, clientY: number, images?: NoteImage[]) => {
    const note = newNote(placeAt(clientX, clientY, { width: NOTE_WIDTH, height: NOTE_HEIGHT }), { images, editedAt: Date.now() });
    setFreshId(note.id);
    sendOp({ type: 'addNote', note });
  }, [placeAt, sendOp]);

  // ---------- pictures ----------

  const addFiles = useCallback(async (id: string, files: File[]) => {
    const errors: string[] = [];
    const kept: NoteImage[] = [];
    for (const file of files) {
      try {
        const natural = await naturalSize(file);
        const img = await notesBridge.importImage(file.name, new Uint8Array(await file.arrayBuffer()));
        kept.push(natural ? { ...img, natural } : img);
      } catch (err) {
        errors.push(errorText(err));
      }
    }
    // The note as it is now: it may have changed while the copies were made.
    const now = latest.current.notes.find((n) => n.id === id);
    if (now && kept.length > 0) {
      const images = [...(now.images ?? []), ...kept];
      if (images.length > MAX_NOTE_IMAGES) errors.push(`A note holds at most ${MAX_NOTE_IMAGES} pictures.`);
      sendOp({ type: 'editNote', id, patch: { images: images.slice(0, MAX_NOTE_IMAGES), editedAt: Date.now() } });
    }
    setNotice(errors.length > 0 ? [...new Set(errors)].join(' · ') : null);
  }, [sendOp]);

  // ---------- moving by hand ----------

  const startMove = useCallback((note: NoteItem, e: ReactPointerEvent<HTMLElement>, el: HTMLElement) => {
    const ws = workspace.current;
    if (!ws) return;
    moveBoardItem(e.nativeEvent, e.target as Element, el, ws, view, {
      id: note.id, home: note.place.zone, width: note.width, height: el.offsetHeight || note.height,
      createGhost: () => {
        const ghost = document.createElement('div');
        ghost.className = 'note-ghost';
        const surface = getComputedStyle(el);
        ghost.style.setProperty('--sheet', surface.getPropertyValue('--sheet'));
        ghost.style.color = surface.color;
        ghost.textContent = noteTitle(note);
        return ghost;
      },
      onComposer: (target) => { void sendToComposer(target, note).catch((err: unknown) => setNotice(errorText(err))); },
      onPlace: (place) => sendOp({ type: 'moveNote', id: note.id, place }),
    });
  }, [sendOp, view, workspace]);

  // ---------- resizing by its corner ----------

  const startResize = useCallback((note: NoteItem, e: ReactPointerEvent<HTMLElement>, el: HTMLElement) => {
    const k = view.transform.k;
    const start = { width: note.width, height: el.offsetHeight || note.height };
    let next = start;
    let frame = 0;
    const paint = () => {
      frame = 0;
      el.style.width = `${next.width}px`;
      el.style.height = `${next.height}px`;
      if (note.place.zone !== null) itemLive.set({ id: note.id, home: note.place.zone, size: next });
    };
    const size = (dx: number, dy: number) => ({ width: clamp(start.width + dx / k, NOTE_MIN_W), height: clamp(start.height + dy / k, NOTE_MIN_H) });
    el.classList.add('is-resizing');
    view.hold();
    trackDrag(e.nativeEvent, e.currentTarget, {
      onMove: (dx, dy) => { next = size(dx, dy); if (!frame) frame = requestAnimationFrame(paint); },
      onDrop: (dx, dy) => {
        cancelAnimationFrame(frame);
        next = size(dx, dy);
        paint();
        el.classList.remove('is-resizing');
        itemLive.set(null);
        sendOp({ type: 'resizeNote', id: note.id, ...next });
      },
      onCancel: () => {
        cancelAnimationFrame(frame);
        el.classList.remove('is-resizing');
        itemLive.set(null);
        el.style.width = `${start.width}px`;
        el.style.height = `${start.height}px`;
      },
    });
    window.addEventListener('pointerup', () => el.classList.remove('is-resizing'), { once: true });
  }, [sendOp, view]);

  // ---------- duplicating, and deleting with an undo ----------

  const duplicate = useCallback((note: NoteItem) => {
    const p = note.place;
    const place: ItemPlace = p.zone === null
      ? { zone: null, x: p.x + STEP, y: p.y + STEP }
      : { zone: p.zone, col: p.col, top: p.top + note.height + 12 };
    const copy = duplicateNote(note, place, Date.now());
    sendOp({ type: 'addNote', note: copy });
    requestAnimationFrame(() => workspace.current?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(copy.id)}"]`)?.focus({ preventScroll: true }));
  }, [sendOp, workspace]);

  const remove = useCallback((note: NoteItem) => {
    sendOp({ type: 'removeNote', id: note.id });
    setRemoved(note);
  }, [sendOp]);
  const undo = useCallback(() => {
    setRemoved((note) => {
      if (note) sendOp({ type: 'addNote', note });
      return null;
    });
  }, [sendOp]);
  useEffect(() => {
    if (removed === null) return;
    const timer = setTimeout(() => setRemoved(null), NOTE_UNDO_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      if (isTyping(e.target) || (e.target instanceof Element && e.target.closest('.chat-screen, .explorer, dialog'))) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [removed, undo]);
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  // ---------- what is drawn ----------

  const freshDone = useCallback(() => setFreshId(null), []);
  const nodeFor = useCallback((note: NoteItem): ReactNode => (
    <Note
      key={note.id}
      note={note}
      fresh={note.id === freshId}
      onFreshDone={freshDone}
      searchClass={searchClass(search, note.id, search?.items)}
      onMoveStart={(e, el) => startMove(note, e, el)}
      onResizeStart={(e, el) => startResize(note, e, el)}
      onRemove={() => remove(note)}
      onDuplicate={() => duplicate(note)}
      onTitle={(title) => sendOp({ type: 'editNote', id: note.id, patch: { title, editedAt: Date.now() } })}
      onText={(text) => sendOp({ type: 'editNote', id: note.id, patch: { text, editedAt: Date.now() } })}
      onHue={(hueIndex) => sendOp({ type: 'editNote', id: note.id, patch: { hueIndex } })}
      onGrow={(height) => sendOp({ type: 'resizeNote', id: note.id, width: note.width, height })}
      onAddFiles={(files) => { void addFiles(note.id, files); }}
      onRemoveImage={(imageId) => {
        const now = latest.current.notes.find((n) => n.id === note.id) ?? note;
        sendOp({ type: 'editNote', id: note.id, patch: { images: (now.images ?? []).filter((img) => img.id !== imageId), editedAt: Date.now() } });
      }}
    />
  ), [addFiles, duplicate, freshDone, freshId, remove, search, sendOp, startMove, startResize]);

  const byZone = useMemo(() => {
    const map = new Map<string, ZoneItem[]>();
    for (const note of notes) {
      const p = note.place;
      if (p.zone === null) continue;
      const list = map.get(p.zone) ?? [];
      list.push({ id: note.id, col: p.col, top: p.top, width: note.width, height: note.height, node: nodeFor(note) });
      map.set(p.zone, list);
    }
    return map;
  }, [notes, nodeFor]);
  const zoneIds = useMemo(() => new Set(byZone.keys()), [byZone]);
  const zoneItems = useCallback((zoneId: string) => byZone.get(zoneId) ?? NO_ITEMS, [byZone]);

  const free = notes.filter((n) => n.place.zone === null);
  const freeItems = free.length === 0 ? null : (
    <div className="board-items board-notes" aria-label="Notes on the canvas">
      {free.map((n) => n.place.zone === null && (
        <div key={n.id} className={`board-item-free${dropFrom.has(n.id) ? ' is-dropped' : ''}`} style={{ translate: `${n.place.x}px ${n.place.y}px` }}>
          {nodeFor(n)}
        </div>
      ))}
    </div>
  );

  const overlay = <>
    {removed !== null && <UndoToast message="Note deleted" onUndo={undo} onDismiss={() => setRemoved(null)} />}
    {notice !== null && removed === null && (
      <div className="undo-toast board-notice" role="alert">
        <span>{notice}</span>
        <button className="undo-close" type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
        </button>
      </div>
    )}
  </>;

  return { notes, zoneItems, freeItems, zoneIds, overlay, createAt };
}

/** A note dropped on a chat's message field: its text goes in where the caret is, and its pictures
    are attached as files dropped from Finder would be (chat/images.tsx takes them from there). */
export async function sendToComposer(composer: HTMLElement, note: NoteItem): Promise<void> {
  const text = noteMessageText(note);
  const field = composer.querySelector<HTMLTextAreaElement>('textarea');
  if (text !== '' && field && !field.disabled) {
    field.focus();
    const before = field.value.slice(0, field.selectionStart);
    const lead = before !== '' && !before.endsWith('\n') ? '\n' : '';
    // As typing does, so the composer's own state follows (and ⌘Z can take it back).
    if (!document.execCommand('insertText', false, lead + text)) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(field, field.value + lead + text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  const images = note.images ?? [];
  if (images.length === 0) return;
  const transfer = new DataTransfer();
  for (const img of images) {
    const { name, mime, data } = await notesBridge.chatImage(note.id, img.id);
    transfer.items.add(new File([new Uint8Array(data)], name, { type: mime }));
  }
  composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
}
