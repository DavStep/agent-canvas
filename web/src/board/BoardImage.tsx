// One image on the board: the picture in a thin frame, with its caption under it when it has one.
// Drag it to move it (into a zone, out of one, onto a chat's message field to attach it); drag
// its corner to resize it, keeping its shape (Shift: any shape); double-click or Enter opens it
// full size; Delete or its × takes it off the board (with an undo). A file it refers to that is
// gone draws as a placeholder until it is back.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { boardImageUrl, MAX_CAPTION, type ImageItem } from '../../../shared/boardItems.ts';
import { ImageViewer } from '../chat/images.tsx';
import { glideFrom } from '../canvas/dragItem.ts';
import { useClosing } from '../useClosing.ts';
import { dropFrom } from './itemLive.ts';

/** The caption's line under the picture, canvas px. */
export const CAPTION_H = 26;
/** Frames this wide or narrower draw the thumbnail (it has 1024 px on its longest side). */
const THUMB_MAX_WIDTH = 512;

/** The room an image takes on the board: its picture and its caption line. */
export const itemBox = (item: ImageItem): { width: number; height: number } =>
  ({ width: item.width, height: item.height + (item.caption ? CAPTION_H : 0) });

export interface BoardImageProps {
  item: ImageItem;
  /** ` is-hit` (and ` is-hit-active`) while a search finds it. */
  searchClass?: string;
  onMoveStart(e: PointerEvent<HTMLElement>, el: HTMLElement): void;
  onResizeStart(e: PointerEvent<HTMLElement>, el: HTMLElement): void;
  onRemove(): void;
  onCaption(text: string | null): void;
  /** The picture's own size, read the first time it is drawn. */
  onNatural(size: { width: number; height: number }): void;
}


function CaptionField({ value, onDone }: { value: string; onDone(text: string | null): void }) {
  const done = useRef(false);
  const finish = (text: string | null) => { if (!done.current) { done.current = true; onDone(text); } };
  return (
    <input className="bi-caption-field" type="text" defaultValue={value} maxLength={MAX_CAPTION} aria-label="Caption" placeholder="Caption"
      spellCheck={false} autoComplete="off" autoFocus
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      }}
      onBlur={(e) => finish(e.currentTarget.value)} />
  );
}

export function BoardImage({ item, searchClass = '', onMoveStart, onResizeStart, onRemove, onCaption, onNatural }: BoardImageProps) {
  const el = useRef<HTMLElement>(null);
  const [viewing, setViewing] = useState(false);
  const [editing, setEditing] = useState(false);
  // A failed draw is tried once more (the board may have asked before main had the item), then shown as broken.
  const [tries, setTries] = useState(0);
  const { closing, close } = useClosing(onRemove);
  const missing = item.missing === true || tries > 1;

  // Just dropped: it glides from where the hand left it (FLIP, as cards do), and does not arrive again.
  useLayoutEffect(() => {
    const node = el.current;
    const from = dropFrom.get(item.id);
    if (!node || !from) return;
    dropFrom.delete(item.id);
    node.dataset.moved = '';
    const board = node.closest('.board');
    const zoom = board ? new DOMMatrixReadOnly(getComputedStyle(board).transform).a : 1;
    glideFrom(node, from, zoom);
  });

  const src = `${boardImageUrl(item, item.width <= THUMB_MAX_WIDTH ? 'thumb' : 'full')}${tries > 0 ? '&retry=1' : ''}`;
  const label = `${item.name}${item.caption ? `: ${item.caption}` : ''}`;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!missing) setViewing(true); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); close(); }
  };
  const stopPress = (e: PointerEvent) => e.stopPropagation();

  return (
    <figure
      ref={el}
      className={`board-image${missing ? ' is-missing' : ''}${closing ? ' is-closing' : ''}${searchClass}`}
      data-item-id={item.id}
      data-no-pan=""
      tabIndex={0}
      role="group"
      aria-roledescription="image"
      aria-label={missing ? `${label} (missing)` : label}
      title={item.src.kind === 'path' ? item.src.path : item.name}
      style={{ width: item.width, height: item.height + (item.caption ? CAPTION_H : 0) }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest('button, input, .bi-resize')) return;
        e.currentTarget.focus({ preventScroll: true });
        onMoveStart(e, e.currentTarget);
      }}
      onDoubleClick={(e) => { if (!(e.target as Element).closest('button, input, .bi-resize') && !missing) setViewing(true); }}
      onKeyDown={onKeyDown}
    >
      <div className="bi-pic" style={{ height: item.height }}>
        {missing ? (
          <div className="bi-missing">
            <svg className="i" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="m3 11.5 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5" /><path d="M2 2l12 12" /></svg>
            <span className="bi-missing-name">{item.name}</span>
            <span>{item.missing ? 'File not found' : 'Can’t be drawn'}</span>
          </div>
        ) : (
          <img src={src} alt="" draggable={false} decoding="async" referrerPolicy="no-referrer"
            onLoad={(e) => {
              const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
              // Only its shape matters (a thumbnail has the file's shape): read once, and again if the file changed shape.
              const known = item.natural ? item.natural.width / item.natural.height : null;
              if (width > 0 && height > 0 && (known === null || Math.abs(width / height - known) / known > 0.01)) onNatural({ width, height });
            }}
            onError={() => { if (tries < 2) setTimeout(() => setTries((t) => t + 1), tries === 0 ? 400 : 0); }} />
        )}
        {editing && <CaptionField value={item.caption ?? ''} onDone={(text) => { setEditing(false); el.current?.focus({ preventScroll: true }); if (text !== null && text.trim() !== (item.caption ?? '')) onCaption(text.trim() === '' ? null : text); }} />}
      </div>
      {item.caption && <figcaption className="bi-caption" title={item.caption}>{item.caption}</figcaption>}
      <div className="bi-tools">
        <button type="button" className="bi-tool" aria-label={item.caption ? `Edit caption of ${item.name}` : `Add a caption to ${item.name}`} title={item.caption ? 'Edit caption' : 'Add caption'}
          onPointerDown={stopPress} onClick={() => setEditing(true)}>
          <svg className="i" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
        </button>
        <button type="button" className="bi-tool" aria-label={`Remove ${item.name} from the board`} title="Remove (Delete)"
          onPointerDown={stopPress} onClick={close}>
          <svg className="i" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
        </button>
      </div>
      <span className="bi-resize" aria-hidden="true" title="Drag to resize · Shift for any shape"
        onPointerDown={(e) => {
          if (e.button !== 0 || !el.current) return;
          e.stopPropagation();
          e.preventDefault();
          onResizeStart(e, el.current);
        }} />
      {viewing && !missing && (
        <ImageViewer images={[{ mime: 'image/png', dataUrl: boardImageUrl(item, 'full') }]} index={0} onIndex={() => {}} onClose={() => setViewing(false)} />
      )}
    </figure>
  );
}
