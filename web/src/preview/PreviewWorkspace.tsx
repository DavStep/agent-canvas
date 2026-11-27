// One preview follows the open chat until the user places it. A placed preview keeps its
// session subscription and live browser while the conversation is closed or another opens.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ChatItem } from '../../../shared/chat.ts';
import { glideFrom, holdItem } from '../canvas/dragItem.ts';
import { zoneUnder } from '../board/geometry.ts';
import { trackDrag } from '../canvas/drag.ts';
import type { PanZoom } from '../canvas/usePanZoom.ts';
import { MediaSession } from '../chat/ChatMedia.tsx';
import { useChat } from '../chat/useChat.ts';
import { LocalUrlScanner } from './findLocalUrl.ts';
import { shownTool, turnTools } from './LiveWork.tsx';
import { PreviewPane, type PreviewTab } from './PreviewPane.tsx';

import { BOARD_MAX, BOARD_MIN, type BoardPreview } from './boardPreviews.ts';
import { tileLive } from './boardTile.ts';
import type { ZoneLayout } from '../../../shared/types.ts';
import { pageOf, sessionPages } from './sessionPages.ts';

const EMPTY: ChatItem[] = [];
type Place = 'left' | 'canvas' | 'right';
type Point = { x: number; y: number };
type Size = { width: number; height: number };
export type ToolSelection = { session: string; id: string | null } | null;

export function usePreviewActivity(session: string, items: ChatItem[]) {
  const calls = useMemo(() => turnTools(items), [items]);
  const scanner = useMemo(() => new LocalUrlScanner(), [session]);
  const localUrl = useMemo(() => scanner.scan(calls.filter(t => t.tool === 'command')), [calls, scanner]);
  return { calls, localUrl };
}

interface Props {
  session: string;
  title: string;
  workspace: HTMLElement;
  area: HTMLElement;
  fullSlot: HTMLElement | null;
  boardSlot: HTMLElement | null;
  boardPin?: BoardPreview;
  zones: ZoneLayout[];
  onAddToBoard(pin: BoardPreview): void;
  onBoardSize(size: Size): void;
  /** The board preview was dropped in a zone's slot (zoneFlow.ts). */
  onBoardSlot(zone: string, col: number, top: number): void;
  onBoardAddress(url: string): void;
  onBoardTab(tab: PreviewTab): void;
  view: PanZoom;
  selection: ToolSelection;
  onSelect(value: ToolSelection): void;
  onPlace(): void;
  onHide(): void;
  /** Closed already and only playing its exit (useLingering). */
  closing?: boolean;
}

/** One-shot animations on an element (its entrance), as opposed to loops. */
const entrances = (el: HTMLElement): Animation[] =>
  el.getAnimations?.().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime as number)) ?? [];

const placeLabel = { left: 'Dock left', canvas: 'Place on canvas', right: 'Dock right' };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export function PreviewWorkspace({ session, title, workspace, area, fullSlot, boardSlot, boardPin, zones, onAddToBoard, onBoardSize, onBoardSlot, onBoardTab, onBoardAddress, view, selection, onSelect, onPlace, onHide, closing }: Props) {
  const { state } = useChat(session);
  const items = state?.items ?? EMPTY;
  const { localUrl } = usePreviewActivity(session, items);
  const follow = selection?.session !== session;
  const shown = shownTool(items, follow, follow ? null : selection.id);
  const [wide, setWide] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [choice, setChoice] = useState<PreviewTab | null>(() => pageOf(sessionPages, session).tab ?? null);
  const [place, setPlace] = useState<Place>('right');
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const [size, setSize] = useState<Size>({ width: 380, height: 416 });
  // The board tile in the hand: moved or resized by writing its style each frame, not by
  // rendering; where it was on screen when let go, for its glide into the slot.
  const [held, setHeld] = useState(false);
  const flip = useRef<DOMRect | null>(null);
  const [dropped, setDropped] = useState(0);
  const [dockWidth, setDockWidth] = useState(340);
  const [target, setTarget] = useState<{ place: Place; point: Point; zone?: ZoneLayout } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [arriving, setArriving] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const embedded = !!boardPin && !!boardSlot && !fullSlot;
  const floating = !embedded && !fullSlot && place === 'canvas';
  const docked = !embedded && !fullSlot && !floating;
  // Docked beside the chat it keeps its whole width and slides out from under the chat's edge
  // (chat.css), so its page is only ever cropped, never laid out narrower: the native view
  // follows it each frame (BrowserTab) instead of waiting for it to stand still.
  const sliding = docked && place === 'right';

  const returnToPanel = () => {
    restoreFocus.current = true;
    setWide(false);
  };
  useLayoutEffect(() => {
    if (wide && dialog.current) {
      dialog.current.showModal();
      dialog.current.querySelector<HTMLButtonElement>('.pv-view-size')?.focus();
      dialog.current.dispatchEvent(new Event('preview-layout'));
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      shell.current?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.focus({ preventScroll: true });
    }
  }, [wide]);

  // The free tile lives outside the transformed board. Apply its camera transform before
  // measuring the native page. Embedded tiles follow the board itself (BrowserTab).
  useLayoutEffect(() => {
    if (!floating) { shell.current?.dispatchEvent(new Event('preview-layout')); return; }
    if (!shell.current) return;
    const el = shell.current;
    return view.watch(({ x, y, k }) => {
      el.style.setProperty('--preview-transform', `translate(${x + position.x * k}px, ${y + position.y * k}px) scale(${k})`);
      el.dispatchEvent(new Event('preview-layout'));
    });
  }, [embedded, boardSlot, floating, place, position, view.watch]);

  const pointInArea = (x: number, y: number) => {
    const a = area.getBoundingClientRect();
    return { x: x - a.left, y: y - a.top };
  };
  const destination = (p: Point): Place => {
    const edge = Math.min(80, area.clientWidth / 5);
    return p.x < edge ? 'left' : p.x >= area.clientWidth - edge ? 'right' : 'canvas';
  };
  const tileOrigin = (p: Point, grip: Point) => ({
    x: clamp(p.x - grip.x * view.transform.k, 0, Math.max(0, area.clientWidth - 64)),
    y: clamp(p.y - grip.y * view.transform.k, 0, Math.max(0, area.clientHeight - 40)),
  });
  const moveTo = (next: Place, origin = tileOrigin({ x: area.clientWidth / 2, y: 52 }, { x: size.width / 2, y: 16 })) => {
    view.hold();
    if (next === 'canvas') {
      // Removing a dock expands the workspace to the area's origin.
      const { x, y, k } = view.transform;
      setPosition({ x: (origin.x - workspace.clientLeft - x) / k, y: (origin.y - workspace.clientTop - y) / k });
    }
    setPlace(next);
    onPlace();
    setTarget(null);
  };
  const addToZone = (zone: string) => {
    const page = pageOf(sessionPages, session);
    const automatic = localUrl && !fullSlot ? 'browser' : state?.browserCapture ? 'capture' : 'live';
    const tab = boardPin?.tab ?? choice ?? automatic;
    // Another zone: its first slot, as a preview has always arrived.
    const slot = boardPin?.zone === zone ? { col: boardPin.col, top: boardPin.top } : { col: 0, top: 0 };
    onAddToBoard({ session, title, zone, tab, width: boardPin?.width ?? size.width, height: boardPin?.height ?? size.height,
      address: page.typed ? page.url : null, ...slot });
    setExpanded(false);
  };
  const dropAt = (event: PointerEvent, grip: Point) => {
    const point = pointInArea(event.clientX, event.clientY);
    const place = destination(point);
    const zoneEl = place === 'canvas' && document.elementsFromPoint(event.clientX, event.clientY)
      .find(el => el instanceof HTMLElement && el.hasAttribute('data-zone-id') && workspace.contains(el));
    const zone = zoneEl ? zones.find(z => z.id === zoneEl.getAttribute('data-zone-id')) : undefined;
    return { place, point: tileOrigin(point, grip), zone };
  };
  // Both the free window and a zone tile follow the same grab point. Only a change of
  // destination updates the labels. The native browser follows the painted element each frame.
  const dragTile = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = shell.current!;
    const board = workspace.querySelector<HTMLElement>('.board');
    if (!board) return;
    const pin = embedded ? boardPin : undefined;
    let zone = pin?.zone ?? null;
    let destinationKey = '';
    const notifyBrowser = () => el.dispatchEvent(new Event('preview-layout'));
    const end = () => {
      setHeld(false);
      setTarget(null);
      if (pin) tileLive.set(null);
    };
    e.preventDefault();
    holdItem(e.nativeEvent, e.currentTarget, el, {
      board, view, screenTranslation: floating,
      canPanAt: e => destination(pointInArea(e.clientX, e.clientY)) === 'canvas',
      onLift: () => setHeld(true),
      onFrame: ({ event, grip, zoom }) => {
        const point = pointInArea(event.clientX, event.clientY);
        const place = destination(point);
        const zoneEl = place === 'canvas' ? zoneUnder(workspace, event.clientX, event.clientY, zone) : null;
        zone = zoneEl?.dataset.zoneId ?? null;
        if (pin && (zone || tileLive.get()?.over !== null)) {
          const cards = zoneEl?.querySelector(':scope > .cards')?.getBoundingClientRect();
          tileLive.set({ home: pin.zone, over: zone && cards ? {
            zone, x: (event.clientX - cards.left) / zoom - grip.x, y: (event.clientY - cards.top) / zoom - grip.y,
            width: pin.width, height: pin.height,
          } : null });
        }
        const key = `${place} ${zone}`;
        if (key !== destinationKey) {
          destinationKey = key;
          setTarget({ place, point, zone: zones.find(z => z.id === zone) });
        }
      },
      afterPaint: notifyBrowser,
      onDrop: ({ event, at }) => {
        const place = destination(pointInArea(event.clientX, event.clientY));
        const slot = zone && workspace.querySelector<HTMLElement>(`.zone[data-zone-id="${CSS.escape(zone)}"] > .cards > .board-tile-slot:not(.board-item-slot)`);
        const from = el.getBoundingClientRect();
        end();
        if (pin && zone && slot) {
          flip.current = from;
          onBoardSlot(zone, Number(slot.dataset.col), Number(slot.dataset.top));
          setDropped(n => n + 1);
        } else {
          el.style.translate = '';
          if (!pin && zone) addToZone(zone);
          else if (place === 'canvas') { setPosition(at); setPlace(place); onPlace(); }
          else moveTo(place);
        }
      },
      onCancel: () => { end(); notifyBrowser(); },
    });
  };
  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button,select,label')) return;
    if ((embedded || floating) && shell.current) { dragTile(e); return; }
    e.preventDefault();
    setResizing(true);
    const r = shell.current!.getBoundingClientRect();
    const k = floating || embedded ? view.transform.k : 1;
    const grip = { x: Math.min(size.width - 24, (e.clientX - r.x) / k), y: (e.clientY - r.y) / k };
    trackDrag(e.nativeEvent, e.currentTarget, {
      onMove: (_, __, event) => {
        setTarget(dropAt(event, grip));
      },
      onDrop: (_, __, event) => {
        const drop = dropAt(event, grip);
        setResizing(false);
        setTarget(null);
        if (drop.zone) addToZone(drop.zone.id); else moveTo(drop.place, drop.point);
      },
      onCancel: () => { setTarget(null); setResizing(false); },
    });
  };
  const boardSize = (dx: number, dy: number) => ({
    width: Math.round(clamp(boardPin!.width + dx / view.transform.k, BOARD_MIN.width, BOARD_MAX.width)),
    height: Math.round(clamp(boardPin!.height + dy / view.transform.k, BOARD_MIN.height, BOARD_MAX.height)),
  });
  const resize = (dx: number, dy: number, initialWidth = shell.current?.offsetWidth ?? dockWidth) => {
    if (embedded && boardPin) {
      onBoardSize(boardSize(dx, dy));
    } else if (floating) {
      const k = view.transform.k;
      setSize({ width: clamp(size.width + dx / k, 280, 1600), height: clamp(size.height + dy / k, 200, 1200) });
    } else {
      setDockWidth(clamp(initialWidth + dx * (place === 'left' ? 1 : -1), 252, Math.max(252, area.clientWidth - 100)));
    }
  };
  // The board tile resizes live: its box (and so the page's own viewport, through the frame's
  // ResizeObserver) follows each frame, and its zone re-flows around the size it has now.
  const resizeTile = (e: ReactPointerEvent<HTMLElement>, axes: 'xy' | 'x' | 'y') => {
    const el = shell.current!;
    const pin = boardPin!;
    let next = { width: pin.width, height: pin.height };
    let frameId = 0;
    const step = () => {
      frameId = 0;
      el.style.width = `${next.width}px`;
      el.style.height = `${next.height}px`;
      tileLive.set({ home: pin.zone, size: next });
    };
    const end = () => { cancelAnimationFrame(frameId); setHeld(false); tileLive.set(null); };
    setHeld(true);
    trackDrag(e.nativeEvent, e.currentTarget, {
      onMove: (dx, dy) => {
        next = boardSize(axes === 'y' ? 0 : dx, axes === 'x' ? 0 : dy);
        if (!frameId) frameId = requestAnimationFrame(step);
      },
      onDrop: (dx, dy) => { next = boardSize(axes === 'y' ? 0 : dx, axes === 'x' ? 0 : dy); step(); end(); onBoardSize(next); },
      onCancel: () => { end(); el.style.width = `${pin.width}px`; el.style.height = `${pin.height}px`; },
    });
  };
  const startResize = (e: ReactPointerEvent<HTMLElement>, axes: 'xy' | 'x' | 'y' = 'xy') => {
    if (e.button !== 0) return;
    e.preventDefault();
    view.hold();
    if (embedded && boardPin && shell.current) { resizeTile(e, axes); return; }
    setResizing(true);
    const initialWidth = shell.current?.offsetWidth ?? dockWidth;
    trackDrag(e.nativeEvent, e.currentTarget, {
      onMove: (dx, dy) => resize(dx, dy, initialWidth),
      onDrop: (dx, dy) => { resize(dx, dy, initialWidth); setResizing(false); },
      onCancel: () => setResizing(false),
    });
  };

  const handle = (views: ReactNode) => (
    <div className="pv-handle" onPointerDown={wide ? undefined : drag} title={wide ? undefined : embedded ? `Drag ${title} anywhere on the board` : `Drag ${title} to dock or place on canvas`}>
        {!wide && <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">{[4, 8, 12].map(y =>
          <g key={y}><circle cx="4" cy={y} r="1"/><circle cx="8" cy={y} r="1"/></g>)}</svg>}
        {views}
        <span className="pv-grab-space" />
        {(expanded || wide) && <button type="button" className="pv-icon pv-view-size"
          aria-label={wide ? 'Return to panel' : 'Expand preview'} title={wide ? 'Return to panel' : 'Expand preview'}
          onClick={() => { if (wide) returnToPanel(); else { setExpanded(false); setWide(true); } }}>
          <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d={wide ? 'M2 6h4V2m8 8h-4v4' : 'M2 6V2h4m8 8v4h-4M3 3l3.5 3.5M13 13l-3.5-3.5'} />
          </svg>
        </button>}
        {expanded && !wide && <label className="pv-placement" title="Move preview">
          <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M9.5 3v10"/></svg>
          <select aria-label="Move preview" value="" onChange={e => moveTo(e.target.value as Place)}>
            <option value="" disabled>Move preview</option>
            {(['left', 'canvas', 'right'] as const).map(p => <option key={p} value={p}>{placeLabel[p]}</option>)}
          </select>
        </label>}
        <button type="button" className="pv-icon" aria-expanded={expanded} aria-controls="pv-views pv-options" aria-label="Preview controls"
          title={expanded ? 'Collapse controls' : 'More controls'} onClick={() => setExpanded(!expanded)}>
          {expanded ? <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg> :
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/></svg>}
        </button>
        {!fullSlot && !wide && <button className="cs-icon" aria-label={embedded ? 'Collapse board preview' : 'Hide preview'} title={embedded ? 'Collapse board preview' : 'Hide preview'} onClick={onHide}>×</button>}
      </div>
  );

  const pane = (
    <MediaSession.Provider value={session}>
        <PreviewPane onTypedAddress={boardPin ? onBoardAddress : undefined} handle={handle} expanded={expanded} onCollapse={() => setExpanded(false)} onExpand={() => setExpanded(true)} sessionId={session} choice={boardPin ? boardPin.tab : choice} onChoose={tab => { setChoice(tab); pageOf(sessionPages, session).tab = tab; if (boardPin) onBoardTab(tab); }}
          boardPicker={!wide && zones.length > 0 && <select className="pv-board-picker" aria-label="Add to board" value=""
            onChange={e => addToZone(e.target.value)}>
            <option value="" disabled>{boardPin ? 'Move to board…' : 'Add to board…'}</option>
            {zones.map(z => <option key={z.id} value={z.id} disabled={z.id === boardPin?.zone}>{z.name}</option>)}
          </select>} localUrl={localUrl} preferBrowser={!fullSlot}
          capture={state?.browserCapture ?? null} plan={state?.plan} items={items} cwd={state?.cwd ?? ''} shown={shown}
          follow={follow} onFollow={on => onSelect(on ? null : { session, id: shown?.id ?? null })} onPick={id => onSelect({ session, id })}
          moving={!sliding && (arriving || closing)}/>
      </MediaSession.Provider>
  );

  const dropArea = target ? area.getBoundingClientRect() : null;
  const host = fullSlot ?? boardSlot ?? (floating ? workspace : area);
  // Let go over a slot: the tile glides from where the hand left it (FLIP, as cards do in
  // cardGlide.ts), drawn again in a new element if it changed zone, and its page follows each frame.
  useLayoutEffect(() => {
    const el = shell.current;
    const from = flip.current;
    // Moved to another zone, the tile is drawn in its new slot one commit later.
    if (!el || !from || !el.isConnected) return;
    flip.current = null;
    el.dataset.moved = '';
    const glide = glideFrom(el, from, view.transform.k);
    el.dispatchEvent(new Event('preview-layout'));
    if (!glide) return;
    let frameId = requestAnimationFrame(function follow() {
      el.dispatchEvent(new Event('preview-layout'));
      if (glide.playState === 'running') frameId = requestAnimationFrame(follow);
    });
    void glide.finished.then(() => el.dispatchEvent(new Event('preview-layout')), () => {});
    return () => cancelAnimationFrame(frameId);
  }, [dropped, host]);
  // While the window plays its entrance (docs/motion.md) the native page waits, then is placed
  // where the window came to rest: it cannot fade or grow with the page around it. A tile that
  // only moved to another zone has no entrance; it glides (above).
  useLayoutEffect(() => {
    const el = shell.current;
    const playing = el && !sliding && el.dataset.moved === undefined ? entrances(el) : [];
    if (!el || playing.length === 0) return;
    let live = true;
    setArriving(true);
    void Promise.allSettled(playing.map(a => a.finished)).then(() => {
      if (!live) return;
      setArriving(false);
      el.dispatchEvent(new Event('preview-layout'));
    });
    return () => { live = false; setArriving(false); };
  }, [host, place, sliding]);
  const style = embedded && boardPin ? { width: boardPin.width, height: boardPin.height } : floating ? size : docked ? { '--pv-width': dockWidth + 'px' } as CSSProperties : undefined;
  return <>{createPortal(
    <div ref={shell} className={`preview-window pv-${fullSlot ? 'full' : embedded ? 'board' : place}${closing ? ' is-closing' : ''}${held ? ' is-held' : ''}`} style={style} inert={closing}
      data-board-x={floating ? position.x : undefined} data-board-y={floating ? position.y : undefined}
      data-no-pan="" onLostPointerCapture={() => setResizing(false)} data-resizing={resizing || (target && !embedded) ? '' : undefined}>
      {wide ? createPortal(
        <dialog ref={dialog} className="preview-full-view preview-window" aria-label="Expanded preview"
          onCancel={e => { e.preventDefault(); returnToPanel(); }}>
          {pane}
        </dialog>, document.body) : pane}
      {!fullSlot && <button type="button" className="pv-size" aria-label="Resize preview" title="Drag to resize or use arrow keys"
        onPointerDown={startResize} onKeyDown={e => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          resize(e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0, e.key === 'ArrowUp' ? -16 : e.key === 'ArrowDown' ? 16 : 0);
        }}/>}
      {/* On the board the right and bottom edges resize too (the corner button keeps the keys). */}
      {embedded && <>
        <span className="pv-edge pv-edge-x" aria-hidden="true" onPointerDown={e => startResize(e, 'x')} />
        <span className="pv-edge pv-edge-y" aria-hidden="true" onPointerDown={e => startResize(e, 'y')} />
      </>}
    </div>, host)}
    {target && dropArea && createPortal(<div className="pv-drop-layer" aria-hidden="true" style={{ left: dropArea.left, top: dropArea.top, width: dropArea.width, height: dropArea.height }}>
      {!held && target.place === 'canvas' && !target.zone && <i className="pv-drop-outline" style={{
        left: target.point.x, top: target.point.y,
        width: size.width * view.transform.k, height: size.height * view.transform.k,
      }}/>}
      <span className={target.place === 'left' ? 'active' : ''}>Dock left</span>
      <span className={target.place === 'canvas' ? 'active' : ''}>{target.zone ? `${target.zone.id === boardPin?.zone ? 'Place in' : 'Move to'} ${target.zone.name}` : 'Place on canvas'}</span>
      <span className={target.place === 'right' ? 'active' : ''}>Dock right</span>
    </div>, document.body)}
  </>;
}
