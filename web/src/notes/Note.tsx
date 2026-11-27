// One note on the board: what the owner wrote, drawn with a little Markdown, and its pictures as
// thumbnails under it. Click the text (or press Enter) to write in it; it saves as you type and
// grows to fit. Drag it to move it (into a zone, out of one, onto a chat's message field to send
// it); drag its corner to resize it. Pictures come by drop, paste or the attach button; a
// thumbnail opens the viewer. Delete or its × takes it off the board, with an undo.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { MAX_NOTE_IMAGES, MAX_NOTE_TEXT, MAX_NOTE_TITLE, NOTE_HUES, NOTE_MAX, NOTE_PLAIN, noteImageUrl, noteTitle, toggleTask, type NoteItem } from '../../../shared/boardNotes.ts';
import { glideFrom } from '../canvas/dragItem.ts';
import { ImageViewer } from '../chat/images.tsx';
import { dropFrom } from '../board/itemLive.ts';
import { hueToken } from '../components/ZoneMark.tsx';
import { useClosing } from '../useClosing.ts';
import { NoteBody } from './NoteBody.tsx';

/** How long typing rests before it is saved. */
const SAVE_MS = 400;
const HUE_NAMES = ['Purple', 'Teal', 'Amber', 'Rose', 'Blue', 'Green', 'Plain'];

export interface NoteProps {
  note: NoteItem;
  /** ` is-hit` (and ` is-hit-active`) while a search finds it. */
  searchClass?: string;
  /** Just made: it opens for writing, with the caret in it. */
  fresh?: boolean;
  onFreshDone?(): void;
  onMoveStart(e: PointerEvent<HTMLElement>, el: HTMLElement): void;
  onResizeStart(e: PointerEvent<HTMLElement>, el: HTMLElement): void;
  onRemove(): void;
  onDuplicate(): void;
  onTitle(title: string): void;
  onText(text: string): void;
  onHue(hueIndex: number): void;
  /** Grown to fit what it holds (canvas px), never shrunk by itself. */
  onGrow(height: number): void;
  onAddFiles(files: File[]): void;
  onRemoveImage(id: string): void;
}

const imageFiles = (list: FileList | null | undefined): File[] => [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
const hasFiles = (dt: DataTransfer | null): boolean => !!dt && [...dt.types].includes('Files');

export const noteHue = (hueIndex: number): string => `var(${hueToken(hueIndex)})`;

export function Note({ note, searchClass = '', fresh = false, onFreshDone, onMoveStart, onResizeStart, onRemove, onDuplicate, onTitle, onText, onHue, onGrow, onAddFiles, onRemoveImage }: NoteProps) {
  const el = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const titleButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(fresh);
  const [draft, setDraft] = useState(note.text);
  const [viewing, setViewing] = useState<number | null>(null);
  const [swatches, setSwatches] = useState(false);
  const { closing, close } = useClosing(onRemove);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const latest = useRef({ onText, onGrow });
  latest.current = { onText, onGrow };

  // What is typed is saved when typing rests, and at once when the note stops being written in.
  const flush = useCallback(() => {
    if (saveTimer.current !== null) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (pending.current !== null) { latest.current.onText(pending.current); pending.current = null; }
  }, []);
  useEffect(() => flush, [flush]);
  const type = (text: string) => {
    setDraft(text);
    pending.current = text;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_MS);
  };
  // Not being written in, it shows what is saved (the canvas agent may have changed it).
  useEffect(() => { if (!editing) setDraft(note.text); }, [editing, note.text]);

  useEffect(() => {
    if (!fresh) return;
    setEditing(true);
    onFreshDone?.();
  }, [fresh, onFreshDone]);
  useLayoutEffect(() => {
    if (!editing) return;
    const f = field.current;
    if (!f) return;
    f.focus({ preventScroll: true });
    f.setSelectionRange(f.value.length, f.value.length);
  }, [editing]);
  const finish = () => {
    flush();
    setEditing(false);
    el.current?.focus({ preventScroll: true });
  };

  // It grows to hold what it has; dragging its corner is how it gets smaller.
  const grownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const node = el.current;
    const f = field.current;
    if (f) { f.style.height = '0px'; f.style.height = `${f.scrollHeight}px`; }
    if (!node) return;
    const want = Math.min(NOTE_MAX, node.scrollHeight);
    if (want > node.clientHeight + 1) {
      node.style.height = `${want}px`;
      if (grownTimer.current !== null) clearTimeout(grownTimer.current);
      grownTimer.current = setTimeout(() => { grownTimer.current = null; latest.current.onGrow(want); }, SAVE_MS);
    }
  }, [draft, editing, note.images, note.width, note.height, note.text, renaming]);
  useEffect(() => () => { if (grownTimer.current !== null) clearTimeout(grownTimer.current); }, []);
  // A saved size the note now has (resized, or grown and saved) is its size again.
  useLayoutEffect(() => { if (el.current && grownTimer.current === null) el.current.style.height = `${note.height}px`; }, [note.height]);

  // Just dropped: it glides from where the hand left it (FLIP, as cards do), and does not arrive again.
  useLayoutEffect(() => {
    const node = el.current;
    const from = dropFrom.get(note.id);
    if (!node || !from) return;
    dropFrom.delete(note.id);
    node.dataset.moved = '';
    const board = node.closest('.board');
    const zoom = board ? new DOMMatrixReadOnly(getComputedStyle(board).transform).a : 1;
    glideFrom(node, from, zoom);
  });

  // Pictures dropped or pasted on the note are the note's, not new images on the board: these
  // listeners are on the note itself, so they answer before the canvas's own.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const over = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      node.classList.add('is-file-over');
    };
    const leave = (e: DragEvent) => { if (!(e.relatedTarget instanceof Node && node.contains(e.relatedTarget))) node.classList.remove('is-file-over'); };
    const drop = (e: DragEvent) => {
      node.classList.remove('is-file-over');
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const files = imageFiles(e.dataTransfer?.files);
      if (files.length > 0) onAddFiles(files);
    };
    const paste = (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData?.files);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      onAddFiles(files);
    };
    node.addEventListener('dragover', over);
    node.addEventListener('dragleave', leave);
    node.addEventListener('drop', drop);
    node.addEventListener('paste', paste);
    return () => {
      node.removeEventListener('dragover', over);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
      node.removeEventListener('paste', paste);
    };
  }, [onAddFiles]);

  const images = note.images ?? [];
  const title = noteTitle(note);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'd') { e.preventDefault(); onDuplicate(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter') { e.preventDefault(); setEditing(true); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); close(); }
  };
  const stopPress = (e: PointerEvent) => e.stopPropagation();
  const full = images.map((img) => ({ mime: 'image/png', dataUrl: noteImageUrl(note.id, img.id, 'full') }));

  return (
    <article
      ref={el}
      className={`board-note${editing ? ' is-editing' : ''}${closing ? ' is-closing' : ''}${searchClass}`}
      data-item-id={note.id}
      data-note-id={note.id}
      data-tinted={note.hueIndex !== NOTE_PLAIN || undefined}
      data-no-pan=""
      tabIndex={0}
      aria-roledescription="note"
      aria-label={`Note: ${title}`}
      style={{ width: note.width, height: note.height, '--note-hue': noteHue(note.hueIndex) } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <header className="bn-header" onPointerDown={(e) => {
        if (e.button !== 0 || !el.current || (e.target as Element).closest('input, .bn-tools')) return;
        onMoveStart(e, el.current);
      }}>
        {renaming ? (
          <input className="bn-title-field" aria-label="Note title" placeholder="Untitled" maxLength={MAX_NOTE_TITLE}
            defaultValue={note.title} autoFocus onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              const value = e.currentTarget.value.trim();
              if (value !== note.title) onTitle(value);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key !== 'Escape' && e.key !== 'Enter') return;
              e.preventDefault();
              if (e.key === 'Escape') e.currentTarget.value = note.title;
              e.currentTarget.blur();
              requestAnimationFrame(() => titleButton.current?.focus({ preventScroll: true }));
            }} />
        ) : (
          <button ref={titleButton} type="button" className="bn-title" aria-label={`Edit note title: ${title}`}
            title={title} onClick={() => setRenaming(true)}>{title}</button>
        )}
        <div className="bn-tools">
          <button type="button" className="bi-tool bn-hue-btn" aria-label="Note colour" aria-expanded={swatches} title="Colour"
            onPointerDown={stopPress} onClick={() => setSwatches((s) => !s)}>
            <i className="bn-dot" aria-hidden="true" />
          </button>
          <button type="button" className="bi-tool" aria-label="Attach a picture" title={images.length >= MAX_NOTE_IMAGES ? 'This note is full' : 'Attach a picture'}
            disabled={images.length >= MAX_NOTE_IMAGES} onPointerDown={stopPress} onClick={() => picker.current?.click()}>
            <svg className="i" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="m3 11.5 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5" /><circle cx="10.5" cy="6" r="1" /></svg>
          </button>
          <button type="button" className="bi-tool" aria-label="Duplicate note" title="Duplicate (⌘D)" onPointerDown={stopPress} onClick={onDuplicate}>
            <svg className="i" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M11 3.5V3a.5.5 0 0 0-.5-.5h-7A.5.5 0 0 0 3 3v7.5a.5.5 0 0 0 .5.5H4" /></svg>
          </button>
          <button type="button" className="bi-tool" aria-label="Delete note" title="Delete (Delete)" onPointerDown={stopPress} onClick={close}>
            <svg className="i" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
          </button>
        </div>
      </header>
      <div className="bn-content" onClick={(e) => {
        if (!editing && !window.getSelection()?.toString() && !(e.target as Element).closest('button, a, label, input, .bn-pics')) setEditing(true);
      }}>
        {editing ? (
          <textarea ref={field} className="bn-field" value={draft} maxLength={MAX_NOTE_TEXT} aria-label="Note text"
            placeholder="Write a note…  # heading, **bold**, - list, - [ ] to do" spellCheck
            onChange={(e) => type(e.target.value)}
            onBlur={() => { flush(); setEditing(false); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); finish(); }
            }} />
        ) : note.text.trim() === '' && images.length === 0 ? (
          <p className="bn-empty">Write a note…</p>
        ) : (
          <NoteBody text={note.text} onToggle={(n) => onText(toggleTask(note.text, n))} />
        )}
        {images.length > 0 && (
          <div className="bn-pics" role="list" aria-label="Pictures">
            {images.map((img, i) => (
              <div key={img.id} className="bn-pic" role="listitem" style={img.natural ? { aspectRatio: `${img.natural.width} / ${img.natural.height}` } : undefined}>
                <button type="button" className="bn-pic-open" aria-label={`Open ${img.name}`} title={img.name}
                  onPointerDown={stopPress} onClick={() => setViewing(i)}>
                  <img src={noteImageUrl(note.id, img.id, 'thumb')} alt="" draggable={false} decoding="async" referrerPolicy="no-referrer" />
                </button>
                <button type="button" className="bn-pic-remove bi-tool" aria-label={`Remove ${img.name} from the note`} title="Remove picture"
                  onPointerDown={stopPress} onClick={() => onRemoveImage(img.id)}>
                  <svg className="i" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {swatches && (
        <div className="bn-swatches" role="radiogroup" aria-label="Note colour"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSwatches(false); } }}>
          {Array.from({ length: NOTE_HUES }, (_, i) => (
            <button key={i} type="button" role="radio" aria-checked={note.hueIndex === i} aria-label={HUE_NAMES[i]} title={HUE_NAMES[i]}
              className={`bn-swatch${note.hueIndex === i ? ' is-on' : ''}`} style={{ '--note-hue': noteHue(i) } as CSSProperties}
              onClick={() => { onHue(i); setSwatches(false); }} />
          ))}
        </div>
      )}
      <span className="bn-resize" aria-hidden="true" title="Drag to resize"
        onPointerDown={(e) => {
          if (e.button !== 0 || !el.current) return;
          e.stopPropagation();
          e.preventDefault();
          onResizeStart(e, el.current);
        }} />
      <input ref={picker} type="file" accept="image/*" multiple hidden
        onChange={(e) => { const files = imageFiles(e.target.files); e.target.value = ''; if (files.length > 0) onAddFiles(files); }} />
      {viewing !== null && full[viewing] && (
        <ImageViewer images={full} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
    </article>
  );
}
