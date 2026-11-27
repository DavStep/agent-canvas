// Images on the board, for the page (App.tsx): what each zone and the free layer draw, images
// arriving by drop (Finder and other apps, a web page, the project explorer) or by paste (⌘V on
// the canvas), moving and resizing them by hand, attaching one to a chat by dropping it on a
// message field, and taking one off with an undo. Every change is a layout op, so it shows at once
// and is saved by the reader with the rest of the layout.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { frameFor, ITEM_MAX, ITEM_MIN, newItemId, boardImageUrl, type BoardItem, type ImageItem, type ItemPlace } from '../../../shared/boardItems.ts';
import type { Layout, LayoutOp } from '../../../shared/types.ts';
import { boardImagesBridge } from '../bridge.ts';
import { trackDrag } from '../canvas/drag.ts';
import { moveBoardItem } from './moveBoardItem.ts';
import type { PanZoom } from '../canvas/usePanZoom.ts';
import { COLUMN_STEP, COLUMN_W } from '../canvas/zoneFlow.ts';
import type { SearchHits } from '../components/JumpBox.tsx';
import { searchClass } from '../components/Zone.tsx';
import { BoardImage, CAPTION_H, itemBox } from './BoardImage.tsx';
import { toBoard, zoneUnder } from './geometry.ts';
import { incomingFrom, mayBringImage, naturalSize, type Incoming } from './imports.ts';
import { dropFrom, itemLive } from './itemLive.ts';
import type { ZoneItem } from './ZoneItems.tsx';

/** How long a removed image can be brought back. */
export const ITEM_UNDO_MS = 30_000;
/** A new free image's width; one in a zone starts one card column wide. */
const FREE_WIDTH = 320;
/** Images dropped together step this far apart, so none hides another. */
const STEP = 24;

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
const clampSize = (n: number): number => Math.round(Math.min(ITEM_MAX, Math.max(ITEM_MIN, n)));
const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(e));

/** A new image's frame: as wide as its slot wants (never wider than the picture itself), with its shape. */
export function newFrame(natural: { width: number; height: number } | undefined, inZone: boolean): { width: number; height: number } {
  const want = inZone ? COLUMN_W : FREE_WIDTH;
  return frameFor(natural, natural ? Math.max(ITEM_MIN * 2, Math.min(want, natural.width)) : want);
}

/** The frame after a corner drag by (dx, dy) canvas px: its shape kept, unless `free` (Shift). */
export function resized(start: { width: number; height: number }, aspect: number, dx: number, dy: number, free: boolean): { width: number; height: number } {
  const width = clampSize(start.width + dx);
  return { width, height: free ? clampSize(start.height + dy) : clampSize(width / aspect) };
}

/** What the board gives an item it draws: moving it by hand, resizing it by a corner, taking it
    off (with the undo), and how search lights it. Images use them in BoardImage; another kind of
    item (a note) gets the same through `renderItem`. */
export interface ItemControls {
  onMoveStart(e: ReactPointerEvent<HTMLElement>, el: HTMLElement): void;
  onResizeStart(e: ReactPointerEvent<HTMLElement>, el: HTMLElement): void;
  onRemove(): void;
  searchClass: string;
}

export interface BoardItemsOptions {
  layout: Layout | null;
  send(op: LayoutOp): Promise<void>;
  workspace: RefObject<HTMLElement | null>;
  view: PanZoom;
  search: SearchHits | null;
  /** Draws an item of another kind than an image (a note), with the board's controls; one it
      gives nothing for is not drawn. */
  renderItem?(item: BoardItem, controls: ItemControls): ReactNode | null;
}

/** The room an item takes on the board: an image's picture and caption line, or its frame. */
export const boxOf = (item: BoardItem): { width: number; height: number } =>
  item.kind === 'image' ? itemBox(item) : { width: item.width, height: item.height };

export interface BoardItems {
  items: BoardItem[];
  /** The images kept in a zone, for the zone to draw and flow its cards around. */
  zoneItems(zoneId: string): readonly ZoneItem[];
  /** The images free on the board. */
  freeItems: ReactNode;
  /** Zones that hold an image: drawn even with no session in them, so their images stay on the board. */
  zoneIds: ReadonlySet<string>;
  /** The zone an image dragged in from outside would land in. */
  dropZone: string | null;
  /** The undo toast and any note about an image that could not be added. */
  overlay: ReactNode;
  /** Adds images where a screen point is (a zone there, or free); for the canvas menu's "Add image…". */
  addAt(incoming: Incoming[], clientX: number, clientY: number): Promise<void>;
}

const NO_ITEMS: readonly ZoneItem[] = [];

export function useBoardItems({ layout, send, workspace, view, search, renderItem }: BoardItemsOptions): BoardItems {
  const items = useMemo(() => layout?.items ?? [], [layout?.items]);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [removed, setRemoved] = useState<BoardItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef({ items, send });
  latest.current = { items, send };
  const sendOp = useCallback((op: LayoutOp) => { latest.current.send(op).catch(() => {}); }, []);
  const boardEl = () => workspace.current?.querySelector<HTMLElement>(':scope .board') ?? null;

  // ---------- arriving: a drop or a paste ----------

  /** Where an image of this frame lands for a screen point: the slot under it in a zone, or free
      with its middle there. `i` steps images dropped together apart. */
  const placeAt = useCallback((clientX: number, clientY: number, inZone: HTMLElement | null, box: { width: number; height: number }, i: number): ItemPlace => {
    const k = view.transform.k;
    const cards = inZone?.querySelector<HTMLElement>(':scope > .cards')?.getBoundingClientRect();
    if (inZone && cards) {
      const x = (clientX - cards.left) / k - box.width / 2;
      return { zone: inZone.dataset.zoneId!, col: Math.max(0, Math.round(x / COLUMN_STEP)), top: Math.max(0, Math.round((clientY - cards.top) / k - box.height / 2 + i * STEP)) };
    }
    const board = boardEl();
    const p = board ? toBoard(board, clientX, clientY, k) : { x: 0, y: 0 };
    return { zone: null, x: Math.round(p.x - box.width / 2 + i * STEP), y: Math.round(p.y - box.height / 2 + i * STEP) };
  }, [view]);

  const addAt = useCallback(async (incoming: Incoming[], clientX: number, clientY: number) => {
    const ws = workspace.current;
    if (!ws || incoming.length === 0) return;
    // The target is read at the moment of the drop; copies and fetches may take a while.
    const zoneEl = zoneUnder(ws, clientX, clientY, null);
    const errors: string[] = [];
    await Promise.all(incoming.map(async (inc, i) => {
      try {
        let src: ImageItem['src'];
        let name: string;
        let natural: { width: number; height: number } | undefined;
        if (inc.kind === 'path') {
          src = { kind: 'path', path: inc.path };
          name = inc.name;
        } else if (inc.kind === 'file') {
          natural = (await naturalSize(inc.file)) ?? undefined;
          const copy = await boardImagesBridge.import({ kind: 'bytes', name: inc.file.name, data: new Uint8Array(await inc.file.arrayBuffer()) });
          src = { kind: 'copy', file: copy.file };
          name = copy.name;
        } else {
          const copy = await boardImagesBridge.import({ kind: 'url', url: inc.url });
          src = { kind: 'copy', file: copy.file };
          name = copy.name;
        }
        const size = newFrame(natural, zoneEl !== null);
        const item: ImageItem = {
          id: newItemId(), kind: 'image', place: placeAt(clientX, clientY, zoneEl, size, i), ...size, src, name,
          ...(natural ? { natural } : {}),
        };
        await latest.current.send({ type: 'addItem', item });
      } catch (err) {
        errors.push(errorText(err));
      }
    }));
    setNotice(errors.length > 0 ? [...new Set(errors)].join(' · ') : null);
  }, [placeAt, workspace]);

  // Dragged over the canvas: the zone it would land in is ringed, as for a card.
  const over = useRef<string | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const ws = workspace.current;
    if (!ws) return;
    const show = (z: string | null) => { if (over.current !== z) { over.current = z; setDropZone(z); } };
    const onOver = (e: DragEvent) => {
      if (!mayBringImage(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      show(zoneUnder(ws, e.clientX, e.clientY, over.current)?.dataset.zoneId ?? null);
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget instanceof Node && ws.contains(e.relatedTarget)) return;
      show(null);
    };
    const onDrop = (e: DragEvent) => {
      show(null);
      if (!e.dataTransfer || !mayBringImage(e.dataTransfer)) return;
      e.preventDefault();
      void addAt(incomingFrom(e.dataTransfer), e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) => { pointer.current = { x: e.clientX, y: e.clientY }; };
    const onOut = () => { pointer.current = null; };
    ws.addEventListener('dragover', onOver);
    ws.addEventListener('dragleave', onLeave);
    ws.addEventListener('drop', onDrop);
    ws.addEventListener('pointermove', onMove);
    ws.addEventListener('pointerleave', onOut);
    return () => {
      ws.removeEventListener('dragover', onOver);
      ws.removeEventListener('dragleave', onLeave);
      ws.removeEventListener('drop', onDrop);
      ws.removeEventListener('pointermove', onMove);
      ws.removeEventListener('pointerleave', onOut);
    };
  }, [addAt, workspace]);

  // ⌘V with the canvas in front (not a field, a chat, the explorer or a dialog): the pasted image
  // lands under the pointer, or in the middle of the canvas.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const ws = workspace.current;
      if (e.defaultPrevented || !e.clipboardData || !ws || isTyping(e.target)) return;
      if (e.target instanceof Element && e.target.closest('.chat-screen, .explorer, dialog, .composer')) return;
      if (document.querySelector('dialog[open]')) return;
      const incoming = incomingFrom(e.clipboardData).filter((i) => i.kind !== 'path');
      if (incoming.length === 0) return;
      e.preventDefault();
      const r = ws.getBoundingClientRect();
      const p = pointer.current ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      void addAt(incoming, p.x, p.y);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addAt, workspace]);

  // ---------- moving by hand ----------

  const startMove = useCallback((item: BoardItem, e: ReactPointerEvent<HTMLElement>, el: HTMLElement) => {
    const ws = workspace.current;
    if (!ws) return;
    moveBoardItem(e.nativeEvent, el, el, ws, view, {
      id: item.id, home: item.place.zone, ...boxOf(item),
      createGhost: () => {
        const ghost = document.createElement('div');
        if (item.kind === 'image') {
          const img = document.createElement('img');
          img.src = boardImageUrl(item, 'thumb');
          img.alt = '';
          ghost.append(img);
        }
        return ghost;
      },
      ...(item.kind === 'image' ? { onComposer: (target: HTMLElement) => {
        void attachTo(target, item).catch((err: unknown) => setNotice(errorText(err)));
      } } : {}),
      onPlace: (place) => sendOp({ type: 'placeItem', id: item.id, place }),
    });
  }, [sendOp, view, workspace]);

  // ---------- resizing by its corner ----------

  const startResize = useCallback((item: BoardItem, e: ReactPointerEvent<HTMLElement>, el: HTMLElement) => {
    const k = view.transform.k;
    const start = { width: item.width, height: item.height };
    const image = item.kind === 'image' ? item : null;
    const aspect = image?.natural ? image.natural.width / image.natural.height : item.width / item.height;
    const cap = image?.caption ? CAPTION_H : 0;
    const pic = el.querySelector<HTMLElement>('.bi-pic');
    let next = start;
    let frame = 0;
    const paint = () => {
      frame = 0;
      el.style.width = `${next.width}px`;
      el.style.height = `${next.height + cap}px`;
      if (pic) pic.style.height = `${next.height}px`;
      if (item.place.zone !== null) itemLive.set({ id: item.id, home: item.place.zone, size: { width: next.width, height: next.height + cap } });
    };
    const reset = () => {
      el.style.width = `${start.width}px`;
      el.style.height = `${start.height + cap}px`;
      if (pic) pic.style.height = `${start.height}px`;
    };
    el.classList.add('is-resizing');
    view.hold();
    trackDrag(e.nativeEvent, e.currentTarget, {
      onMove: (dx, dy, ev) => {
        next = resized(start, aspect, dx / k, dy / k, ev.shiftKey || image === null);
        if (!frame) frame = requestAnimationFrame(paint);
      },
      onDrop: (dx, dy, ev) => {
        cancelAnimationFrame(frame);
        next = resized(start, aspect, dx / k, dy / k, ev.shiftKey || image === null);
        paint();
        el.classList.remove('is-resizing');
        itemLive.set(null);
        sendOp({ type: 'resizeItem', id: item.id, ...next });
      },
      onCancel: () => { cancelAnimationFrame(frame); el.classList.remove('is-resizing'); itemLive.set(null); reset(); },
    });
    // A press with no drag (a click on the corner) leaves it as it was.
    const release = () => { el.classList.remove('is-resizing'); };
    window.addEventListener('pointerup', release, { once: true });
  }, [sendOp, view]);

  // ---------- taking off, with an undo ----------

  const remove = useCallback((item: BoardItem) => {
    sendOp({ type: 'removeItem', id: item.id });
    setRemoved(item);
  }, [sendOp]);
  const undo = useCallback(() => {
    setRemoved((item) => {
      if (item) sendOp({ type: 'addItem', item });
      return null;
    });
  }, [sendOp]);
  useEffect(() => {
    if (removed === null) return;
    const timer = setTimeout(() => setRemoved(null), ITEM_UNDO_MS);
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

  const nodeFor = useCallback((item: BoardItem): ReactNode | null => item.kind !== 'image'
    ? renderItem?.(item, {
      onMoveStart: (e, el) => startMove(item, e, el),
      onResizeStart: (e, el) => startResize(item, e, el),
      onRemove: () => remove(item),
      searchClass: searchClass(search, item.id, search?.items),
    }) ?? null
    : (
    <BoardImage
      key={item.id}
      item={item}
      searchClass={searchClass(search, item.id, search?.items)}
      onMoveStart={(e, el) => startMove(item, e, el)}
      onResizeStart={(e, el) => startResize(item, e, el)}
      onRemove={() => remove(item)}
      onCaption={(caption) => sendOp({ type: 'editItem', id: item.id, patch: { caption } })}
      onNatural={(natural) => {
        sendOp({ type: 'editItem', id: item.id, patch: { natural } });
        // Its frame takes the picture's shape at the width it has.
        const height = clampSize((item.width * natural.height) / natural.width);
        if (height !== item.height) sendOp({ type: 'resizeItem', id: item.id, width: item.width, height });
      }}
    />
  ), [remove, renderItem, search, sendOp, startMove, startResize]);

  const byZone = useMemo(() => {
    const map = new Map<string, ZoneItem[]>();
    for (const item of items) {
      const p = item.place;
      if (p.zone === null) continue;
      const node = nodeFor(item);
      if (node === null) continue;
      const list = map.get(p.zone) ?? [];
      list.push({ id: item.id, col: p.col, top: p.top, ...boxOf(item), node });
      map.set(p.zone, list);
    }
    return map;
  }, [items, nodeFor]);
  const zoneIds = useMemo(() => new Set(byZone.keys()), [byZone]);
  const zoneItems = useCallback((zoneId: string) => byZone.get(zoneId) ?? NO_ITEMS, [byZone]);

  const free = items.flatMap((it) => {
    if (it.place.zone !== null) return [];
    const node = nodeFor(it);
    return node === null ? [] : [{ id: it.id, x: it.place.x, y: it.place.y, node }];
  });
  const freeItems = free.length === 0 ? null : (
    <div className="board-items" aria-label="Images on the canvas">
      {free.map((it) => (
        <div key={it.id} className={`board-item-free${dropFrom.has(it.id) ? ' is-dropped' : ''}`} style={{ translate: `${it.x}px ${it.y}px` }}>
          {it.node}
        </div>
      ))}
    </div>
  );

  const overlay = <>
    {removed !== null && (
      <div className="undo-toast board-undo" role="status">
        <span>{removed.kind === 'image' ? 'Image removed' : 'Note removed'}</span>
        <button className="menu-btn" type="button" onClick={undo} aria-keyshortcuts="Meta+Z" title="Undo (⌘Z)">Undo<kbd>⌘Z</kbd></button>
        <button className="undo-close" type="button" onClick={() => setRemoved(null)} aria-label="Dismiss">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
        </button>
      </div>
    )}
    {notice !== null && removed === null && (
      <div className="undo-toast board-notice" role="alert">
        <span>{notice}</span>
        <button className="undo-close" type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg>
        </button>
      </div>
    )}
  </>;

  return { items, zoneItems, freeItems, zoneIds, dropZone, overlay, addAt };
}

/** Drops an image on a chat's message field as a file dropped from Finder would be: the composer's
    own attachment code (chat/images.tsx) takes it from there. */
async function attachTo(composer: HTMLElement, item: BoardItem): Promise<void> {
  const { name, mime, data } = await boardImagesBridge.chatImage(item.id);
  const transfer = new DataTransfer();
  transfer.items.add(new File([new Uint8Array(data)], name, { type: mime }));
  composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
}
