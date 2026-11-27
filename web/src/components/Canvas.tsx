// The desk: zones at their layout positions on one board that pans and zooms. Zones move by
// their label, cards move between zones, and zones without a position are placed and saved.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type FocusEvent, type PointerEvent } from 'react';
import type { Layout, LayoutOp, SessionView, ZoneLayout } from '../../../shared/types.ts';
import type { SearchHits } from './JumpBox.tsx';
import { zoneIdFor } from '../../../server/layoutOps.ts';
import { createCardGlide } from '../canvas/cardGlide.ts';
import { trackDrag, zoneAt, type ZoneRect } from '../canvas/drag.ts';
import { placeZones, rowWidthFor } from '../canvas/placeZones.ts';
import { resolveOverlaps, type ZoneBox } from '../canvas/resolveOverlaps.ts';
import { tidyMoves, tidyOps, type ZoneMove } from '../canvas/tidyZones.ts';
import { readSnap, snapToGrid, useSnap } from '../canvas/snap.ts';
import { useElementMap } from '../canvas/useElementMap.ts';
import { zoneFolder } from '../newSession/form.ts';
import type { DOMRectLike, PanZoom } from '../canvas/usePanZoom.ts';
import { Zone, type BoardTile } from './Zone.tsx';
import { ZoneMenu } from './ZoneMenu.tsx';
import { freeItemRects, itemRect } from '../board/geometry.ts';
import type { ZoneItem } from '../board/ZoneItems.tsx';
import type { ZoneSlots } from '../../../shared/cardSlots.ts';
import type { RunView } from '../../../shared/runs.ts';
import { CanvasLinks } from '../links/CanvasLinks.tsx';
import type { ConnectorsHandle } from '../links/Connectors.tsx';
import { cardWaits } from '../links/links.ts';

/** First placement waits this long after the last size change, so it saves settled sizes. */
const SETTLE_MS = 300;

type Size = { w: number; h: number };
type Point = { x: number; y: number };

/** Something the page asked the view to show; done once the target is on the board. */
export type ViewRequest = { kind: 'fit' } | { kind: 'tidy' } | { kind: 'zone'; id: string } | { kind: 'card'; id: string; /** false: travel there, leave focus be. */ focus?: boolean } | { kind: 'item'; id: string };

type Drag =
  | { kind: 'zone'; id: string }
  | { kind: 'card'; id: string; from: string; over: string | null };

export interface CanvasProps {
  groups: ReturnType<typeof zonesWithCards>;
  sessions: SessionView[];
  layout: Layout;
  selectedId: string | null;
  now: number;
  onSelect(id: string, trigger: HTMLElement, keyboard: boolean): void;
  /** Sends a layout op to the reader; the layout passed in already shows it. */
  onLayoutOp(op: LayoutOp): Promise<void>;
  /** A zone label's "+": a new session in that zone's folder. Shown for zones that have one. */
  onNewSession?(zone: ZoneLayout): void;
  onNewLinkedSession?(from: string, zoneId?: string): void;
  /** A zone label's Files button: the project explorer on that zone's folder. Shown for zones that have one. */
  onExplore?(zone: ZoneLayout): void;
  /** The zone whose explorer is open. */
  exploringId?: string | null;
  boardPreviews?(zone: ZoneLayout): ReactNode;
  /** The open board preview, for the zone it belongs to. */
  boardTile?(zone: ZoneLayout): BoardTile | null;
  projectChats?: Record<string, string>;
  view: PanZoom;
  request: ViewRequest | null;
  onRequestDone(): void;
  /** When the snapshot being drawn was made; a request whose target is missing waits for one more. */
  generatedAt: number;
  /** A tidy request moved these zones (never called when nothing moved), for an undo. */
  onTidied?(moves: ZoneMove[]): void;
  /** The search box's matches: lit, with everything else dimmed, while a query is typed. */
  search?: SearchHits | null;
  /** Images kept in a zone (web/src/board): the zone's cards flow around them. */
  zoneItems?(zone: ZoneLayout): readonly ZoneItem[];
  /** Images free on the board, drawn above the zones. */
  freeItems?: ReactNode;
  /** The zone an image dragged in from outside (or from the explorer) would land in. */
  dropZone?: string | null;
  /** Where each zone's cards sit (web/src/canvas/useCardSlots.ts); without it cards stack as before. */
  cardSlots?(zoneId: string): ZoneSlots | undefined;
  /** A zone's Tidy (its label or its menu): cards re-ordered by recent activity. */
  onTidyZone?(zoneId: string): void;
  /** A card dropped in a zone at column `col`, before card `before` (null: the column's end). */
  onPlaceCard?(zoneId: string, cardId: string, col: number, before: string | null): void;
  /** Queued runs and their links ("B runs after A", web/src/links): lines, waiting cards, planned cards. */
  runs?: RunView[];
}

/** The slot under a screen point in a zone's columns, for a dropped card: the column nearest the
    point (one past the last when the point is right of it) and the card it goes before. */
export function slotAt(zone: HTMLElement, x: number, y: number, dragged: string): { col: number; before: string | null } {
  const cols = [...zone.querySelectorAll<HTMLElement>(':scope > .cards > .col')];
  if (cols.length === 0) return { col: 0, before: null };
  const last = cols[cols.length - 1]!.getBoundingClientRect();
  let col = 0;
  if (x > last.right + 12) col = cols.length;
  else {
    let best = Infinity;
    cols.forEach((c, j) => {
      const r = c.getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < best) { best = d; col = j; }
    });
  }
  let before: string | null = null;
  for (const card of cols[col]?.querySelectorAll<HTMLElement>(':scope > .card[data-card-id]:not(.project-chat-card)') ?? []) {
    if (card.dataset.cardId === dragged) continue;
    const r = card.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = card.dataset.cardId!; break; }
  }
  return { col, before };
}

/** Whether a session in a removed folder zone has come back: it is working, needs the owner, or
    changed state since the zone was removed. */
export const backFromHidden = (s: SessionView, hiddenAt: number): boolean =>
  s.state === 'working' || s.state === 'needs_you' || s.stateSince > hiddenAt;

/** Zones to draw, each with its cards in the given order. Folder zones without sessions are hidden,
    and so are removed ones until one of their sessions comes back. A folder zone that knows its
    folder on disk (`path`: the canvas agent made it) is drawn empty, as a custom zone is, so it is
    there before its first session; removing it takes it off like any other. */
export function zonesWithCards(sessions: SessionView[], layout: Layout, savedZoneIds?: ReadonlySet<string>): { zone: ZoneLayout; cards: SessionView[] }[] {
  const hidden = new Map(layout.zones.filter((z) => z.kind === 'folder' && z.hiddenAt !== undefined).map((z) => [z.id, z.hiddenAt!]));
  const cards = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const id = zoneIdFor(s, layout);
    const hiddenAt = hidden.get(id);
    if (hiddenAt !== undefined && !backFromHidden(s, hiddenAt)) continue;
    const list = cards.get(id);
    if (list) list.push(s);
    else cards.set(id, [s]);
  }
  const zones = layout.zones.filter((z) => z.kind === 'custom' || cards.has(z.id) || ((z.path !== undefined || savedZoneIds?.has(z.id)) && z.hiddenAt === undefined));
  // A session whose folder zone the reader has not created yet still gets a (quiet) zone.
  const drawnIds = new Set(zones.map((z) => z.id));
  for (const [id, list] of cards) {
    if (drawnIds.has(id)) continue;
    const folder = list[0]!.folder;
    zones.push({ id, name: folder === '' ? 'No folder' : folder, kind: 'folder', folder, x: null, y: null, hueIndex: 6 });
  }
  return zones.map((zone) => ({ zone, cards: cards.get(zone.id) ?? [] }));
}

/** Whether a zone or card request's target is among the zones drawn. */
export function hasTarget(request: { kind: 'zone' | 'card'; id: string }, groups: { zone: ZoneLayout; cards: SessionView[] }[]): boolean {
  return request.kind === 'zone'
    ? groups.some((g) => g.zone.id === request.id)
    : groups.some((g) => g.cards.some((s) => s.id === request.id));
}

/** A request whose target was missing, and the snapshot it was first missing from. */
export type MissingTarget = { request: ViewRequest; generatedAt: number } | null;

/**
 * A request whose target is not drawn waits for the next snapshot (it may bring the target);
 * if the target is still missing once that snapshot has rendered, the request is dropped, so it
 * never fires later when an unrelated change brings the target back.
 */
export function checkMissing(request: ViewRequest, generatedAt: number, missing: MissingTarget): { drop: boolean; missing: MissingTarget } {
  if (missing?.request !== request) return { drop: false, missing: { request, generatedAt } };
  return missing.generatedAt === generatedAt ? { drop: false, missing } : { drop: true, missing: null };
}

export function Canvas({ groups, sessions, layout, selectedId, now, onSelect, onLayoutOp, onNewSession, onNewLinkedSession, onExplore, exploringId = null, boardPreviews, boardTile, projectChats, view, request, onRequestDone, generatedAt, onTidied, search, zoneItems, freeItems, dropZone = null, cardSlots, onTidyZone, onPlaceCard, runs }: CanvasProps) {
  const waits = useMemo(() => cardWaits(runs), [runs]);
  const links = useRef<ConnectorsHandle>(null);
  const [sizes, setSizes] = useState<Map<string, Size>>(new Map());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const board = useRef<HTMLDivElement>(null);
  const snap = useSnap();

  useLayoutEffect(() => view.watch(({ x, y, k }) => {
    if (board.current) board.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  }), [view.watch]);

  const measure = () => {
    const next = new Map([...zoneEls.els].map(([id, el]) => [id, { w: el.offsetWidth, h: el.offsetHeight }]));
    setSizes((prev) => {
      const same = prev.size === next.size
        && [...next].every(([id, s]) => prev.get(id)?.w === s.w && prev.get(id)?.h === s.h);
      return same ? prev : next;
    });
  };
  // Zones coming and going, and zones re-rendering (a card arriving), are measured before the
  // browser paints; any other growth or shrinking (fonts, text) is seen by the observer.
  const zoneEls = useElementMap(measure);
  useLayoutEffect(measure, [groups.map((g) => g.zone.id).join('\n')]);
  // Fonts arriving reflow every card at once; measure then too, not only when the observer reports.
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => { if (live) measure(); });
    return () => { live = false; };
  }, []);

  const zones = groups.map((g) => g.zone);
  // Saved positions are drawn as saved unless a zone has grown into another: then the lower zone
  // is drawn further down (resolveOverlaps). That is display only; nothing here is ever saved,
  // so a zone that shrinks again lets its neighbours return by themselves. A zone being dragged
  // counts at its saved position until release, so the others stay where they are meanwhile.
  const savedBoxes: ZoneBox[] = [];
  for (const z of zones) {
    const s = sizes.get(z.id);
    if (z.x !== null && z.y !== null && s) savedBoxes.push({ id: z.id, x: z.x, y: z.y, w: s.w, h: s.h });
  }
  const shown = resolveOverlaps(savedBoxes);
  // Zones without a saved position are placed in memory below the zones as drawn, then saved (below).
  // Packed to the canvas's shape, read from the DOM of the last render (no zone is measured before one).
  const workspace = board.current?.parentElement;
  const aspect = workspace && workspace.clientHeight > 0 ? workspace.clientWidth / workspace.clientHeight : 16 / 9;
  const placed = placeZones(
    zones.map((z) => ({ ...z, ...shown.get(z.id) })), sizes, rowWidthFor(zones, sizes, aspect),
  );
  const drawn = placed.size === 0 ? shown : resolveOverlaps([
    ...savedBoxes,
    ...[...placed].map(([id, p]) => ({ id, ...p, w: sizes.get(id)!.w, h: sizes.get(id)!.h })),
  ]);
  const at = new Map<string, Point | null>(zones.map((z) => [
    z.id,
    drawn.get(z.id) ?? (z.x !== null && z.y !== null ? { x: z.x, y: z.y } : null),
  ]));
  const rects: ZoneRect[] = [];
  for (const z of zones) {
    const p = at.get(z.id);
    const s = sizes.get(z.id);
    if (p && s) rects.push({ id: z.id, x: p.x, y: p.y, width: s.w, height: s.h });
  }
  // Pointer handlers run long after this render; they read the latest geometry from here.
  const latest = useRef(rects);
  latest.current = rects;

  // Cards that stay on the canvas glide to their new slot (a new column, another zone) instead
  // of arriving again; run after every render of the canvas or of a zone, before the paint.
  const cardGlide = useRef<ReturnType<typeof createCardGlide>>(null);
  cardGlide.current ??= createCardGlide();
  const positions = useRef(at);
  positions.current = at;
  const heldCard = useRef<(Point & { id: string }) | null>(null);
  const heldZone = useRef<(Point & { id: string }) | null>(null);
  useLayoutEffect(() => {
    // An incoming layout update can write a new resting position while the label is held.
    const held = heldZone.current;
    const el = held && zoneEls.els.get(held.id);
    if (el) el.style.translate = `${held.x}px ${held.y}px`;
  });
  // A single commit can restack many zones. Read their final slots together before paint.
  const glidePending = useRef(false);
  const glideCards = useCallback(() => {
    if (glidePending.current) return;
    glidePending.current = true;
    queueMicrotask(() => {
      glidePending.current = false;
      if (board.current) cardGlide.current!.run(board.current, positions.current, heldCard.current);
      // The lines between linked cards follow the glides.
      links.current?.kick();
    });
  }, []);
  useLayoutEffect(glideCards);

  // First placement: once sizes have settled, save each placed zone with one moveZone op.
  // Zones the reader has not created yet are left in memory until it does.
  const saved = useRef(new Set<string>());
  const toSave = layout.zones.filter((z) => (z.x === null || z.y === null) && placed.has(z.id) && !saved.current.has(z.id));
  const saveKey = JSON.stringify([toSave.map((z) => [z.id, placed.get(z.id)]), [...sizes]]);
  useEffect(() => {
    if (toSave.length === 0) return;
    const timer = setTimeout(() => {
      for (const z of toSave) {
        const p = placed.get(z.id)!;
        saved.current.add(z.id);
        onLayoutOp({ type: 'moveZone', id: z.id, x: Math.round(p.x), y: Math.round(p.y) })
          .catch(() => saved.current.delete(z.id));
      }
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [saveKey]);

  // With no remembered view the page frames the board itself (at most 100%) until the owner moves it.
  const rectsKey = JSON.stringify(rects);
  useLayoutEffect(() => {
    if (view.pristine && rects.length > 0) view.frame(rects);
  }, [rectsKey, view.pristine]);

  // The canvas rect of a card: its zone's position plus where it sits inside the zone.
  const cardRect = (id: string): DOMRectLike | null => {
    const el = board.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
    const zoneId = el?.closest<HTMLElement>('.zone')?.dataset.zoneId;
    const zone = zoneId === undefined ? undefined : rects.find((r) => r.id === zoneId);
    if (!el || !zone) return null;
    return { x: zone.x + el.offsetLeft, y: zone.y + el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
  };

  // Requests wait until their target is measured and placed: a zone just created, say.
  const missing = useRef<MissingTarget>(null);
  useLayoutEffect(() => {
    if (request === null) return;
    if (request.kind === 'fit') {
      const tile = board.current?.parentElement?.querySelector<HTMLElement>('.pv-canvas');
      const withTile = tile ? [...rects, { x: Number(tile.dataset.boardX), y: Number(tile.dataset.boardY), width: tile.offsetWidth, height: tile.offsetHeight }] : rects;
      const bounds = board.current ? [...withTile, ...freeItemRects(board.current, view.transform.k)] : withTile;
      if (bounds.length > 0) view.fit(bounds);
      onRequestDone();
      return;
    }
    if (request.kind === 'tidy') {
      onRequestDone();
      const boxes = rects.map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.width, h: r.height }));
      const saved = new Map(zones.map((z) => [z.id, z.x !== null && z.y !== null ? { x: z.x, y: z.y } : null]));
      const moves = tidyMoves(boxes, saved, aspect);
      if (moves.length === 0) return;
      for (const op of tidyOps(moves)) onLayoutOp(op).catch(() => {});
      onTidied?.(moves);
      const to = new Map(moves.map((m) => [m.id, m.to]));
      view.fit(rects.map((r) => ({ ...r, ...to.get(r.id) })));
      return;
    }
    if (request.kind === 'item') {
      const rect = board.current && itemRect(board.current, request.id, view.transform.k);
      if (rect) {
        view.centerOn(rect);
        board.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(request.id)}"]`)?.focus({ preventScroll: true });
      }
      onRequestDone();
      return;
    }
    if (!hasTarget(request, groups)) {
      const next = checkMissing(request, generatedAt, missing.current);
      missing.current = next.missing;
      if (next.drop) onRequestDone();
      return;
    }
    missing.current = null;
    const rect = request.kind === 'zone' ? rects.find((r) => r.id === request.id) : cardRect(request.id);
    if (!rect) return;
    // Opened from the Needs you strip (focus: false): the view travels only to a card out of
    // sight; a card already in view stays exactly where the owner sees it.
    const cardEl = request.kind === 'card' && request.focus === false
      ? board.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(request.id)}"]`) : null;
    const box = board.current?.parentElement?.getBoundingClientRect();
    const seen = cardEl && box ? cardEl.getBoundingClientRect() : null;
    const inView = seen && box && seen.left >= box.left && seen.right <= box.right && seen.top >= box.top && seen.bottom <= box.bottom;
    if (!inView) view.centerOn(rect);
    if (request.kind === 'card' && request.focus !== false) {
      board.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(request.id)}"]`)?.focus({ preventScroll: true });
    }
    onRequestDone();
  });

  // A card or zone label reached by keyboard that is out of view is brought to the middle
  // (a click never moves the view).
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const el = e.target;
    const workspace = board.current?.parentElement;
    if (!(el instanceof HTMLElement) || !el.matches(':focus-visible') || !workspace) return;
    const r = el.getBoundingClientRect();
    const w = workspace.getBoundingClientRect();
    if (r.left >= w.left && r.right <= w.right && r.top >= w.top && r.bottom <= w.bottom) return;
    const zoneId = el.closest<HTMLElement>('.zone')?.dataset.zoneId;
    const rect = el.dataset.cardId ? cardRect(el.dataset.cardId ?? '')
      : el.matches('.zone-label') ? rects.find((z) => z.id === zoneId) : undefined;
    if (rect) view.centerOn(rect);
  };

  /** A pointer position in canvas coordinates. The board's origin is canvas (0, 0) on screen. */
  const toCanvas = (e: { clientX: number; clientY: number }): Point => {
    const origin = board.current!.getBoundingClientRect();
    const { k } = view.transform;
    return { x: (e.clientX - origin.left) / k, y: (e.clientY - origin.top) / k };
  };

  const startZoneDrag = (zone: ZoneLayout, e: PointerEvent<HTMLElement>) => {
    const start = at.get(zone.id);
    const el = zoneEls.els.get(zone.id);
    if (e.button !== 0 || !start || !el) return;
    const { k } = view.transform;
    // Snapping is read once per drag, so a switch flipped mid-drag waits for the next one.
    const round = readSnap() ? snapToGrid : Math.round;
    const to = (dx: number, dy: number) => ({ x: round(start.x + dx / k), y: round(start.y + dy / k) });
    const release = () => {
      heldZone.current = null;
      const rest = positions.current.get(zone.id) ?? start;
      el.style.translate = `${rest.x}px ${rest.y}px`;
      setDrag(null);
    };
    trackDrag(e.nativeEvent, e.currentTarget, {
      frameMoves: true,
      onMove: (dx, dy) => {
        if (!heldZone.current) { view.hold(); setDrag({ kind: 'zone', id: zone.id }); }
        const point = to(dx, dy);
        heldZone.current = { id: zone.id, ...point };
        el.style.translate = `${point.x}px ${point.y}px`;
        links.current?.kick(0);
      },
      onDrop: (dx, dy) => {
        release();
        onLayoutOp({ type: 'moveZone', id: zone.id, ...to(dx, dy) }).catch(() => {});
      },
      onCancel: release,
    });
  };

  const startCardDrag = (session: SessionView, from: string, e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const { k } = view.transform;
    const target = (ev: { clientX: number; clientY: number }) => {
      const id = zoneAt(toCanvas(ev), latest.current);
      return id !== null && id !== from ? id : null;
    };
    const el = e.currentTarget;
    let over: string | null = null;
    const release = () => {
      el.style.translate = '';
      heldCard.current = null;
      setDrag(null);
    };
    trackDrag(e.nativeEvent, el, {
      frameMoves: true,
      onMove: (dx, dy, ev) => {
        const next = target(ev);
        if (!heldCard.current || over !== next) {
          view.hold();
          over = next;
          setDrag({ kind: 'card', id: session.id, from, over });
        }
        const point = { id: session.id, x: dx / k, y: dy / k };
        heldCard.current = point;
        el.style.translate = `${point.x}px ${point.y}px`;
        links.current?.kick(0);
      },
      onDrop: (dx, dy, ev) => {
        cardGlide.current?.releasedAt(session.id, dx / k, dy / k);
        release();
        const to = target(ev);
        // Dropped in a zone (its own or another): it takes the slot under the pointer.
        const into = to ?? (zoneAt(toCanvas(ev), latest.current) === from ? from : null);
        const zoneEl = into === null ? null : board.current?.querySelector<HTMLElement>(`.zone[data-zone-id="${CSS.escape(into)}"]`);
        if (to !== null) {
          // Back in its own folder's zone: the session simply has no assignment.
          const zoneId = to === `folder:${session.folder}` ? null : to;
          onLayoutOp({ type: 'assign', sessionId: session.id, zoneId }).catch(() => {});
        }
        if (into !== null && zoneEl && onPlaceCard) {
          const slot = slotAt(zoneEl, ev.clientX, ev.clientY, session.id);
          onPlaceCard(into, session.id, slot.col, slot.before);
        }
      },
      onCancel: release,
    });
  };

  // The menu's zone, while it is still on the board.
  const sessionsById = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  const registryKey = projectChats && Object.keys(projectChats).length ? JSON.stringify(projectChats) : undefined;
  const menuZone = menu ? groups.find((g) => g.zone.id === menu.id)?.zone ?? null : null;
  return (
    <>
      {sessions.length === 0 && <p className="canvas-hint">Start a session in Claude Code or Codex to see it here.</p>}
      <div
        ref={board}
        className={`board${drag ? ' is-dragging' : ''}${snap ? ' is-snapping' : ''}${search ? ' is-searching' : ''}`}
        onFocus={onFocus}
      >
        {groups.map(({ zone, cards }, index) => {
          const cwd = zoneFolder(zone, sessions);
          const projectFolder = zone.kind === 'folder' ? zone.path ?? cwd : null;
          const projectChatId = projectFolder ? projectChats?.[projectFolder] : undefined;
          const bySession = new Map(cards.map((s) => [s.id, s]));
          return (
            <Zone
              key={zone.id}
              ref={zoneEls.refFor(zone.id)}
              zone={zone}
              index={index}
              measuredSize={sizes.get(zone.id)}
              previews={boardPreviews?.(zone)}
              tile={boardTile?.(zone) ?? null}
              boardItems={zoneItems?.(zone)}
              sessions={cards}
              at={at.get(zone.id) ?? null}
              selectedId={selectedId}
              now={now}
              onSelect={onSelect}
              onLabelPointerDown={(e) => startZoneDrag(zone, e)}
              onRename={(name) => { onLayoutOp({ type: 'renameZone', id: zone.id, name }).catch(() => {}); }}
              onMenu={drag ? undefined : (p) => setMenu({ id: zone.id, ...p })}
              onNewSession={onNewSession && cwd !== null ? () => onNewSession(zone) : undefined}
              onExplore={onExplore && cwd !== null ? () => onExplore(zone) : undefined}
              exploring={exploringId === zone.id}
              projectChatId={projectChatId}
              sessionsById={sessionsById}
              unresolvedFolder={registryKey && !projectChatId ? projectFolder ?? undefined : undefined}
              registryKey={registryKey}
              hasProjectChat={!!projectFolder}
              onCardPointerDown={(id, e) => startCardDrag(bySession.get(id)!, zone.id, e)}
              dragCard={drag?.kind === 'card' && drag.from === zone.id ? drag.id : null}
              dropTarget={(drag?.kind === 'card' && drag.over === zone.id) || dropZone === zone.id}
              moving={drag?.kind === 'zone' && drag.id === zone.id}
              lifted={drag?.kind === 'card' && drag.from === zone.id}
              onRendered={glideCards}
              search={search ?? null}
              waits={waits}
              slots={cardSlots?.(zone.id)}
              onTidy={onTidyZone && cards.length > 1 ? () => onTidyZone(zone.id) : undefined}
            />
          );
        })}
        {freeItems}
        <CanvasLinks onNewSession={onNewLinkedSession} board={board} scale={() => view.transform.k} runs={runs} sessions={sessions} ref={links} />
      </div>
      {menuZone && menu && (
        <ZoneMenu
          key={menuZone.id}
          zone={menuZone}
          onSave={(values) => onLayoutOp({ type: 'editZone', id: menuZone.id, ...values })}
          at={menu}
          onClose={closeMenu}
          onTidy={onTidyZone && (groups.find((g) => g.zone.id === menuZone.id)?.cards.length ?? 0) > 1 ? () => onTidyZone(menuZone.id) : undefined}
          // A custom zone is deleted; a folder zone is hidden until one of its sessions runs again.
          onDelete={() => {
            const op: LayoutOp = menuZone.kind === 'custom'
              ? { type: 'deleteZone', id: menuZone.id }
              : { type: 'hideZone', id: menuZone.id, at: Date.now() };
            onLayoutOp(op).catch(() => {});
          }}
        />
      )}
    </>
  );
}
