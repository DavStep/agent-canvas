import { Creature } from '../creature/Creature.tsx';
// A zone: a tinted region with a label, a project marker, a count and its cards in tidy columns.
// The label is the zone's handle: drag it to move the zone, double-click it (or Enter) to rename.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import type { SessionView, ZoneLayout } from '../../../shared/types.ts';
import { columnAt, COLUMN_STEP, type TileBox } from '../canvas/zoneFlow.ts';
import { useTileLive } from '../preview/boardTile.ts';
import { flowZone } from '../board/flowItems.ts';
import { useItemLive } from '../board/itemLive.ts';
import { itemTilesFor, ZoneItemsLayer, type ZoneItem } from '../board/ZoneItems.tsx';
import { useBoardDeparture } from '../canvas/useBoardDeparture.ts';
import { useElementMap } from '../canvas/useElementMap.ts';
import { zoneHue, ZoneMark } from './ZoneMark.tsx';
import { newSessionBridge } from '../bridge.ts';
import { projectDraftId } from '../agent/agent.ts';
import { Card } from './Card.tsx';
import { instant } from '../useClosing.ts';
import { PANEL_EXIT_MS } from '../useLingering.ts';
import type { CardWait } from '../links/links.ts';
import type { SearchHits } from './JumpBox.tsx';
import type { ZoneSlots } from '../../../shared/cardSlots.ts';

/** A zone's or card's class while a search is typed: ` is-hit` (` is-hit-active` too for the one
    the arrows are on), or nothing when it does not match or no search is on. */
export const searchClass = (search: SearchHits | null, id: string, hits: ReadonlySet<string> | undefined): string =>
  search === null || hits === undefined || !hits.has(id) ? '' : search.active === id ? ' is-hit is-hit-active' : ' is-hit';

/** What removing a zone does, said before it happens. `restoreFrom` names where a removed folder
    zone can be brought back. */
export const removeNote = (z: ZoneLayout, restoreFrom: string): string => z.kind === 'custom'
  ? `Delete “${z.name}”? Its cards go back to their folder zones.`
  : `Remove “${z.name}” from the canvas? Its sessions come back if one of them runs again, or from ${restoreFrom}.`;

/** Heights used until the browser has measured the real ones (first frame only). */
export function estimateCard(s: SessionView): number {
  if (s.state === 'idle' || s.state === 'unknown') return 82;
  const subRows = Math.ceil(Math.min(s.subagents.length, 4) / 2);
  return 120 + (subRows === 0 ? 0 : 24 + subRows * 60 + (subRows - 1) * 24);
}

type Heights = Record<string, number>;
const sameHeights = (a: Heights, b: Heights) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** The open board preview kept in this zone: its saved slot and size, and what to draw there. */
export interface BoardTile extends TileBox { node: ReactNode }

export interface ZoneProps {
  zone: ZoneLayout;
  measuredSize?: { w: number; h: number };
  previews?: ReactNode;
  /** The open board preview, when it belongs here; cards flow around it (zoneFlow.ts). */
  tile?: BoardTile | null;
  /** Images kept in this zone (web/src/board): cards flow around them too. */
  boardItems?: readonly ZoneItem[];
  sessions: SessionView[];
  /** Position on the board, or null while the zone waits for first placement. */
  at: { x: number; y: number } | null;
  selectedId: string | null;
  now: number;
  onSelect(id: string, trigger: HTMLElement, keyboard: boolean): void;
  /** A press on the label: the start of a zone drag. */
  onLabelPointerDown?(e: PointerEvent<HTMLElement>): void;
  onRename?(name: string): void;
  /** A right-click on the zone (or the menu key on its label): open its menu at this screen point. */
  onMenu?(at: { x: number; y: number }): void;
  /** The label's "+": a new session in this zone's folder (folder zones only). */
  onNewSession?(): void;
  /** The label's Files button: open (or close) the project explorer on this zone's folder. */
  onExplore?(): void;
  /** This zone's explorer is open: its Files button stays lit. */
  exploring?: boolean;
  projectChatId?: string;
  sessionsById?: ReadonlyMap<string, SessionView>;
  unresolvedFolder?: string;
  registryKey?: string;
  hasProjectChat?: boolean;
  /** A press on one of the zone's cards. */
  onCardPointerDown?(id: string, e: PointerEvent<HTMLElement>): void;
  /** The id of the card being dragged from this zone. */
  dragCard?: string | null;
  /** A dragged card from another zone is over this one. */
  dropTarget?: boolean;
  /** The zone itself is being dragged. */
  moving?: boolean;
  /** One of the zone's cards is being dragged: the zone rides above the others so the card does. */
  lifted?: boolean;
  /** The zone's place among the zones drawn: staggers its entrance (docs/motion.md). */
  index?: number;
  /** Report a local restack so cards can glide to their new slots before paint. */
  onRendered?(): void;
  /** The search box's matches while a query is typed: this zone and its cards lit or dimmed. */
  search?: SearchHits | null;
  /** Prompts queued for cards here, waiting on other sessions (web/src/links), by card id. */
  waits?: ReadonlyMap<string, CardWait>;
  /** Where the cards sit (web/src/canvas/cardSlots.ts): each column's cards here now, and the
      cards folded into "Earlier". Without it the cards stack shortest column first. */
  slots?: ZoneSlots;
  /** The label's Tidy: the zone's cards re-ordered by recent activity (with an undo). */
  onTidy?(): void;
  ref?: Ref<HTMLElement>;
}

function RenameField({ name, onDone }: { name: string; onDone(name: string | null): void }) {
  // Enter or Esc ends the edit; the blur that may follow the field's removal must not end it again.
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value); }
    // Handled here, so the page does not also close the detail panel.
    if (e.key === 'Escape') { e.preventDefault(); finish(null); }
  };
  return (
    <input
      className="zone-rename"
      type="text"
      defaultValue={name}
      maxLength={60}
      aria-label="Zone name"
      spellCheck={false}
      autoComplete="off"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

const NO_ITEMS: readonly ZoneItem[] = [];

export function Zone({
  zone, measuredSize, previews, tile = null, boardItems = NO_ITEMS, sessions, projectChatId, sessionsById, unresolvedFolder, registryKey, hasProjectChat, at, selectedId, now, onSelect, onLabelPointerDown, onRename, onMenu, onNewSession, onExplore, exploring = false, onCardPointerDown,
  dragCard = null, dropTarget = false, moving = false, lifted = false, index = 0, onRendered, search = null, slots, onTidy, waits, ref,
}: ZoneProps) {
  const [editing, setEditing] = useState(false);
  const [foldOpen, setFoldOpen] = useState(false);
  const label = useRef<HTMLElement>(null);
  useBoardDeparture(label, 'zone', zone.id);
  const [cardH, setCardH] = useState<Heights>({});

  // Card heights do not depend on which column a card lands in, so measuring after render and
  // stacking again settles in one pass.
  const measure = () => {
    const cards = Object.fromEntries([...cardEls.els].map(([id, el]) => [id, el.offsetHeight]));
    setCardH((prev) => (sameHeights(prev, cards) ? prev : cards));
  };
  // Fonts arriving or text changing reflows cards without a React render: the observer sees it.
  const cardEls = useElementMap(measure);
  // Cards coming and going: measure before the browser paints the estimates.
  const shown = sessions.map((s) => s.id).join(' ');
  useLayoutEffect(measure, [shown]);
  useLayoutEffect(() => { onRendered?.(); }, [cardH, onRendered]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const order = useMemo(() => new Map(sessions.map((s, i) => [s.id, i])), [sessions]);
  // A linked checkout can share its coordinator with a differently named zone. Resolve once
  // per folder/registry change, rather than spawning Git on every live session update.
  const [alias, setAlias] = useState<{ folder: string; key?: string; id: string } | null>(null);
  useEffect(() => {
    if (!unresolvedFolder) return;
    let live = true;
    newSessionBridge.projectChat(unresolvedFolder).then(id => {
      if (live && id) setAlias({ folder: unresolvedFolder, key: registryKey, id });
    }).catch(() => {});
    return () => { live = false; };
  }, [unresolvedFolder, registryKey]);
  const aliasId = alias && alias.folder === unresolvedFolder && alias.key === registryKey ? alias.id : undefined;
  const pinnedId = hasProjectChat ? projectChatId ?? aliasId : undefined;
  const coordinator = pinnedId ? byId.get(pinnedId) ?? sessionsById?.get(pinnedId) : undefined;
  const pinSlot = hasProjectChat ? projectDraftId(zone.id) : null;
  // With slots, each card keeps its column and its place in it; the orchestrator heads the first.
  const slotKey = slots && JSON.stringify(slots.columns);
  const items = useMemo(() => {
    const height = (s: SessionView) => cardH[s.id] ?? estimateCard(s);
    const list: { id: string; cardH: number; col?: number }[] = [];
    if (slots) {
      slots.columns.forEach((column, col) => {
        for (const id of column) { const s = byId.get(id); if (s && id !== pinnedId) list.push({ id, cardH: height(s), col }); }
      });
    } else {
      for (const s of sessions) if (s.id !== pinnedId) list.push({ id: s.id, cardH: height(s) });
    }
    if (pinSlot) list.unshift({ id: pinSlot, cardH: cardH[pinSlot] ?? (coordinator ? estimateCard(coordinator) : 82), ...(slots ? { col: 0 } : {}) });
    return list;
  }, [sessions, byId, slotKey, cardH, pinnedId, pinSlot, coordinator]);
  // The "Earlier" fold: idle cards folded away at the zone's end. A search that finds one opens it.
  const folded = slots?.earlier.filter((id) => id !== pinnedId && byId.has(id)) ?? [];
  const foldShown = folded.length > 0 && (foldOpen || (search?.cards !== undefined && folded.some((id) => search.cards!.has(id))));
  const foldCards = useRef<HTMLDivElement>(null);
  const [keepFold, setKeepFold] = useState(false);
  const drawFold = folded.length > 0 && (foldShown || keepFold);
  useLayoutEffect(() => {
    if (foldShown) { setKeepFold(true); return; }
    if (!keepFold) return;
    if (instant()) { setKeepFold(false); return; }
    const timer = window.setTimeout(() => setKeepFold(false), PANEL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [foldShown, keepFold]);

  // Measure the fold in canvas pixels once per size change. Only the painted rim and
  // the cards' clip move between states, so board placement never chases the animation.
  useLayoutEffect(() => {
    const cards = foldCards.current;
    const zoneEl = cards?.closest<HTMLElement>('.zone');
    if (!cards || !zoneEl) return;
    const measureFold = () => zoneEl.style.setProperty('--earlier-height', `${cards.offsetHeight}px`);
    measureFold();
    const observer = new ResizeObserver(measureFold);
    observer.observe(cards);
    return () => { observer.disconnect(); zoneEl.style.removeProperty('--earlier-height'); };
  }, [drawFold]);
  // The board preview: where it rests (its saved slot), and where the cards make room for it,
  // which while it is in the hand is the slot under it, here or in another zone.
  const live = useTileLive(zone.id);
  const home = tile;
  const size = home ? live?.size : undefined;
  const resting = home && { ...home, ...size };
  const held = live?.over !== undefined;
  const over = held && live.over?.zone === zone.id ? live.over : null;
  const room: TileBox | null = over
    ? { col: columnAt(over.x, items.length), top: over.y, width: over.width, height: over.height }
    : held ? null : resting;
  const roomKey = room && `${room.col} ${Math.round(room.top)} ${room.width} ${room.height}`;
  const restKey = resting && `${resting.col} ${resting.top} ${resting.width} ${resting.height}`;
  // Images kept here are tiles too (flowZone is flowCards when there are none).
  const hand = useItemLive(zone.id);
  // A thread note sits beside the card it came from (the orchestrator's by its pinned slot).
  const itemTiles = useMemo(() => itemTilesFor(boardItems, hand, zone.id).map((tile) =>
    tile.beside && tile.beside === pinnedId && pinSlot ? { ...tile, beside: pinSlot } : tile
  ), [boardItems, hand, zone.id, pinnedId, pinSlot]);
  const tilesKey = JSON.stringify(itemTiles);
  const flow = useMemo(() => flowZone(items, room, itemTiles), [items, roomKey, tilesKey]);
  const rest = useMemo(() => (held && resting ? flowZone(items, resting, itemTiles).tile : flow.tile), [items, held, restKey, flow, tilesKey]);
  const columns = flow.columns;
  // A change of room restacks cards: they glide to their new slots before paint.
  const flowKey = JSON.stringify(columns);
  useLayoutEffect(() => { onRendered?.(); }, [flowKey]);

  // A zone placed after it first rendered keeps `is-placing` (no transition) until two frames
  // later, so the browser has drawn its first position before the glide is switched on.
  const placed = at !== null;
  const [glides, setGlides] = useState(placed);
  useEffect(() => {
    if (!placed || glides) return;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setGlides(true)); });
    return () => cancelAnimationFrame(frame);
  }, [placed, glides]);

  const finishRename = (name: string | null) => {
    setEditing(false);
    // Keyboard focus goes back to the label rather than falling to the page.
    if (label.current?.contains(document.activeElement)) label.current.focus({ preventScroll: true });
    if (name !== null && name.trim() !== '' && name.trim() !== zone.name) onRename?.(name);
  };
  const onLabelKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!editing && (e.key === 'Enter' || e.key === 'F2')) { e.preventDefault(); setEditing(true); }
    if (!editing && onMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      onMenu({ x: r.left, y: r.bottom + 4 });
    }
  };
  const flags = `${placed ? (glides ? '' : ' is-placing') : ' is-unplaced'}${dropTarget ? ' is-drop' : ''}${moving ? ' is-moving' : ''}${lifted || (held && home) || (hand?.home === zone.id && (hand.over !== undefined || hand.size !== undefined)) ? ' is-lifted' : ''}${searchClass(search, zone.id, search?.zones)}`;

  return (
    <section
      ref={ref}
      className={`zone${flags}${foldShown ? ' is-earlier-open' : ''}`}
      // Positioned by the translate property, so a zone pushed down by a neighbour glides there,
      // and scale (entrance, lift) stays about the zone's own middle.
      style={{ '--zone-w': measuredSize && `${measuredSize.w}px`, '--zone-h': measuredSize && `${measuredSize.h}px`,
        '--zone-hue': zoneHue(zone), '--i': index, translate: `${at?.x ?? 0}px ${at?.y ?? 0}px` } as CSSProperties}
      aria-label={zone.name}
      data-zone-id={zone.id}
      data-live-resize={hand?.size || live?.size ? '' : undefined}
      onContextMenu={onMenu && !editing ? (e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); } : undefined}
    >
      <header
        ref={label}
        className="zone-label"
        tabIndex={editing ? -1 : 0}
        title="Drag to move, double-click to rename"
        aria-label={`${zone.name}, ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}. Press Enter to rename.`}
        onPointerDown={editing ? undefined : onLabelPointerDown}
        onDoubleClick={() => setEditing(true)}
        onKeyDown={onLabelKeyDown}
      >
        {onMenu && !editing ? (
          <button type="button" className="zone-edit" aria-haspopup="dialog" aria-label={`Edit ${zone.name} zone`} title="Edit zone"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onMenu({ x: rect.left, y: rect.bottom + 4 });
            }}>
            <ZoneMark icon={zone.icon} />
          </button>
        ) : <ZoneMark icon={zone.icon} />}
        {editing
          ? <RenameField name={zone.name} onDone={finishRename} />
          : <span className="name" title={zone.name}>{zone.name}</span>}
        <span className="n" key={sessions.length}>{sessions.length}</span>
        {onTidy && !editing && (
          <button
            type="button"
            className="zone-tidy"
            aria-label={`Tidy ${zone.name}`}
            title="Tidy zone"
            // As the "+": no zone drag, no rename.
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={onTidy}
          >
            <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h7M3 11.5h4" /></svg>
          </button>
        )}
        {onExplore && !editing && (
          <button
            type="button"
            className="zone-files"
            aria-pressed={exploring}
            aria-label={`Files in ${zone.name}`}
            title={exploring ? `Close files in ${zone.name}` : `Files in ${zone.name}`}
            // As the "+": no zone drag, no rename.
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={onExplore}
          >
            <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" /><path d="M2 7h12" /></svg>
          </button>
        )}
        {onNewSession && !editing && (
          <button
            type="button"
            className="zone-new"
            aria-label={`New session in ${zone.name}`}
            title={`New session in ${zone.name}`}
            // The label drags the zone and renames it on double-click; the button does neither.
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={onNewSession}
          >
            <svg className="i" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.5v7M2.5 6h7" /></svg>
          </button>
        )}
      </header>
      {previews}
      <div className="cards">
        {/* At its static place (the cards area's corner), moved to its slot by translate. */}
        <ZoneItemsLayer items={boardItems} placed={flow.items} hand={hand} />
        {home && rest && (
          <div className="board-tile" style={{ translate: `${rest.col * COLUMN_STEP}px ${rest.top}px` }}>{home.node}</div>
        )}
        {held && over && flow.tile && room && (
          <i className="board-tile-slot" aria-hidden="true" data-col={flow.tile.col} data-top={flow.tile.top}
            style={{ translate: `${flow.tile.col * COLUMN_STEP}px ${flow.tile.top}px`, width: room.width, height: room.height }} />
        )}
        {columns.map((column, col) => (
          <div className="col" key={col}>
            {column.map((entry, n) => {
              if (!('id' in entry)) return <div key={`gap-${n}`} className="board-tile-room" style={{ height: entry.gap }} aria-hidden="true" />;
              const id = entry.id;
              const pinned = id === pinSlot;
              const s = pinned ? coordinator : byId.get(id);
              if (!s && pinned) {
                const selected = selectedId === (pinnedId ?? pinSlot);
                return <button type="button" key={id} ref={cardEls.refFor(id)}
                  className={`card project-chat-card${selected ? ' is-selected' : ''}`} data-card-id={id}
                  aria-label={`Project orchestrator in ${zone.name}`} aria-current={selected || undefined}
                  onClick={e => onSelect(pinnedId ?? id, e.currentTarget, e.detail === 0)}>
                  <span className="card-head"><strong className="title">Project orchestrator</strong><Creature provider="orchestrator" state="idle" size={40} /></span>
                  <span className="meta">{pinnedId ? 'Open conversation' : 'Start a conversation'}</span>
                </button>;
              }
              if (!s) return null;
              return (
                <Card
                  key={id}
                  session={s}
                  orchestrator={pinned}
                  canvasId={pinned && !byId.has(s.id) ? id : s.id}
                  selected={s.id === selectedId}
                  now={now}
                  onSelect={onSelect}
                  onPointerDown={!pinned && onCardPointerDown ? (e) => onCardPointerDown(id, e) : undefined}
                  dragging={dragCard === id}
                  index={order.get(id) ?? 0}
                  searchClass={searchClass(search, s.id, search?.cards)}
                  wait={waits?.get(s.id) ?? null}
                  ref={cardEls.refFor(id)}
                />
              );
            })}
          </div>
        ))}
      </div>
      {folded.length > 0 && (
        <div className={`zone-earlier${foldShown ? ' is-open' : ''}`}>
          <button type="button" className="zone-earlier-toggle" aria-expanded={foldShown}
            title={foldShown ? 'Fold idle sessions away' : 'Show idle sessions untouched for a while'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setFoldOpen(!foldShown)}>
            <svg className="i" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" /></svg>
            Earlier<span className="sep" aria-hidden="true">·</span><span className="n">{folded.length}</span>
          </button>
          {drawFold && (
            <div className="cards zone-earlier-cards" ref={foldCards} inert={!foldShown}>
              {Array.from({ length: Math.max(1, Math.min(folded.length, items.reduce((n, it) => Math.max(n, (it.col ?? 0) + 1), 0))) }).map((_, col, all) => (
                <div className="col" key={col}>
                  {folded.filter((_, i) => i % all.length === col).map((id) => (
                    <Card
                      key={id}
                      session={byId.get(id)!}
                      selected={id === selectedId}
                      now={now}
                      onSelect={onSelect}
                      onPointerDown={onCardPointerDown ? (e) => onCardPointerDown(id, e) : undefined}
                      dragging={dragCard === id}
                      index={0}
                      searchClass={searchClass(search, id, search?.cards)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
