// "Search zones and sessions…": ⌘K / Ctrl+K opens it, typing filters zones by name and sessions
// by name, folder and zone, and lights up the matches on the canvas. Arrows and Enter pick one
// (the view travels there), Esc closes it.
import { useEffect, useLayoutEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { SessionView, ZoneLayout } from '../../../shared/types.ts';
import { itemMatches, type BoardItem } from '../../../shared/boardItems.ts';
import { noteMatches, noteTitle, type NoteItem } from '../../../shared/boardNotes.ts';
import { titleOf } from '../briefing.ts';
import { Creature } from '../creature/Creature.tsx';
import { creatureOf } from '../creature/generate.ts';
import { CardIcon } from './CardIcon.tsx';
import { isInterrupted } from '../../../shared/interruption.ts';
import { zoneHue, ZoneMark } from './ZoneMark.tsx';

const folderName = (s: SessionView): string => (s.folder === '' ? 'No folder' : s.folder);

/** A leading word that finds every session whose turn was cut off ("interrupted", "cut off", "limit"). */
const INTERRUPTED_WORDS = new Set(['interrupted', 'interrupt', 'cut', 'limit']);

function parse(query: string): { provider: string | undefined; interrupted: boolean; words: string[] } | null {
  const q = query.trim().toLowerCase();
  if (q === '') return null;
  const words = q.split(/\s+/);
  const interrupted = INTERRUPTED_WORDS.has(words[0]!);
  if (interrupted && words.shift() === 'cut' && words[0] === 'off') words.shift();
  const provider = words[0] === 'codex' || words[0] === 'claude' ? words.shift() : undefined;
  if (provider === 'claude' && words[0] === 'code') words.shift();
  // A filter narrows to sessions: no zones or images are found then.
  return { provider: provider ?? (interrupted ? '' : undefined), interrupted, words };
}

/** A leading provider name narrows the search, and a leading "interrupted" (or "cut off", "limit")
    to the sessions whose turn was cut off. Other words match the title, folder or the name of the
    zone the card sits in (`zoneOf`). */
export function filterSessions(sessions: SessionView[], query: string, zoneOf?: (id: string) => string | undefined): SessionView[] {
  const parsed = parse(query);
  if (parsed === null) return sessions;
  const { provider, words } = parsed;
  return sessions.filter((s) => {
    if (parsed.interrupted && !isInterrupted(s)) return false;
    if (provider !== undefined && provider !== '' && s.provider !== provider) return false;
    const searchable = `${titleOf(s)} ${folderName(s)} ${zoneOf?.(s.id) ?? ''}`.toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}

export interface ZoneGroup { zone: ZoneLayout; cards: SessionView[] }

/** What a query finds on the canvas: zones by name (not when a provider narrows it to sessions),
    then sessions in canvas order. An empty query finds no zones and every session. */
export function searchCanvas(groups: ZoneGroup[], query: string): { zones: ZoneGroup[]; sessions: SessionView[] } {
  const zoneName = new Map(groups.flatMap((g) => g.cards.map((s) => [s.id, g.zone.name] as const)));
  const sessions = filterSessions(groups.flatMap((g) => g.cards), query, (id) => zoneName.get(id));
  const parsed = parse(query);
  const zones = parsed === null || parsed.provider !== undefined ? [] : groups.filter((g) => {
    const name = g.zone.name.toLowerCase();
    return parsed.words.every((word) => name.includes(word));
  });
  return { zones, sessions };
}

/** The canvas side of a search: which cards and zones match, and the one the arrows are on. */
export interface SearchHits { cards: ReadonlySet<string>; zones: ReadonlySet<string>; active: string | null; items?: ReadonlySet<string> }

/** Images on the board a query finds, by file name or caption (not when a provider narrows it to sessions). */
export function searchItems(items: readonly BoardItem[], query: string): BoardItem[] {
  const parsed = parse(query);
  return parsed === null || parsed.provider !== undefined ? [] : items.filter((it) => itemMatches(it, parsed.words));
}

/** Notes a query finds, by what is written in them or their pictures' names. */
export function searchNotes(notes: readonly NoteItem[], query: string): NoteItem[] {
  const parsed = parse(query);
  return parsed === null || parsed.provider !== undefined ? [] : notes.filter((n) => noteMatches(n, parsed.words));
}

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export interface JumpBoxProps {
  projectIds?: ReadonlySet<string>;
  /** The zones on the canvas with their cards, in canvas order. */
  groups: ZoneGroup[];
  onPick(id: string): void;
  onPickZone(id: string): void;
  /** The matches to light up on the canvas while a query is typed; null when there is none. */
  onHits?(hits: SearchHits | null): void;
  /** False while a chat covers the canvas: the shortcut is then left alone. */
  enabled?: boolean;
  /** Images on the board, found by file name or caption; picking one travels to it. */
  items?: readonly BoardItem[];
  /** The owner's notes, found by their text; picking one travels to it (onPickItem). */
  notes?: readonly NoteItem[];
  onPickItem?(id: string): void;
}

type Hit = { kind: 'zone'; group: ZoneGroup } | { kind: 'item'; item: BoardItem } | { kind: 'note'; note: NoteItem } | { kind: 'session'; session: SessionView };
const hitId = (h: Hit): string => (h.kind === 'zone' ? `zone:${h.group.zone.id}` : h.kind === 'item' ? h.item.id : h.kind === 'note' ? h.note.id : h.session.id);
const NO_ITEMS: readonly BoardItem[] = [];
const NO_NOTES: readonly NoteItem[] = [];
/** How a board item reads in the results: an image by its caption or file name, a note by its first line. */
function itemTitle(item: BoardItem): string {
  if (item.kind === 'image') return item.caption ?? item.name;
  const text = (item as { text?: unknown }).text;
  return (typeof text === 'string' ? text.split('\n').map((l) => l.trim()).find((l) => l !== '')?.slice(0, 80) : undefined) ?? 'Note';
}

export function JumpBox({ projectIds, groups, onPick, onPickZone, onHits, enabled = true, items = NO_ITEMS, notes = NO_NOTES, onPickItem }: JumpBoxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const found = open ? searchCanvas(groups, query) : { zones: [], sessions: [] };
  const foundItems = open && onPickItem ? searchItems(items, query) : [];
  const foundNotes = open && onPickItem ? searchNotes(notes, query) : [];
  const hits: Hit[] = [
    ...found.zones.map((group) => ({ kind: 'zone' as const, group })),
    ...foundItems.map((item) => ({ kind: 'item' as const, item })),
    ...foundNotes.map((note) => ({ kind: 'note' as const, note })),
    ...found.sessions.map((session) => ({ kind: 'session' as const, session })),
  ];
  const current = Math.min(active, Math.max(0, hits.length - 1));

  const show = () => { setOpen(true); setQuery(''); setActive(0); };
  const close = () => { dialog.current?.close(); setOpen(false); };
  const pick = (hit: Hit) => {
    close();
    if (hit.kind === 'zone') onPickZone(hit.group.zone.id); else if (hit.kind === 'item') onPickItem?.(hit.item.id); else if (hit.kind === 'note') onPickItem?.(hit.note.id); else onPick(hit.session.id);
  };

  // The canvas lights up what the typed query finds. Keyed by content, so a new snapshot with the
  // same matches does not send them again.
  const searching = open && query.trim() !== '';
  const activeHit = hits[current];
  const activeId = activeHit === undefined ? null : activeHit.kind === 'zone' ? activeHit.group.zone.id : activeHit.kind === 'item' ? activeHit.item.id : activeHit.kind === 'note' ? activeHit.note.id : activeHit.session.id;
  const hitsKey = searching
    ? JSON.stringify([found.zones.map((g) => g.zone.id), found.sessions.map((s) => s.id), activeId, [...foundItems.map((it) => it.id), ...foundNotes.map((n) => n.id)]])
    : '';
  const onHitsRef = useRef(onHits);
  onHitsRef.current = onHits;
  useEffect(() => {
    if (hitsKey === '') { onHitsRef.current?.(null); return; }
    const [zones, cards, act, found] = JSON.parse(hitsKey) as [string[], string[], string | null, string[]];
    onHitsRef.current?.({ zones: new Set(zones), cards: new Set(cards), active: act, items: new Set(found) });
  }, [hitsKey]);
  useEffect(() => () => onHitsRef.current?.(null), []);

  // The shortcut works from anywhere on the page, and again while the box is open.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!open && document.querySelector('dialog[open]')) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) input.current?.select(); else show();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, enabled]);

  useLayoutEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    input.current?.focus();
  }, [open]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current, open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[current];
      if (hit) pick(hit);
    } else if (e.key === 'Escape') {
      // Handled here, so the page does not also close the detail panel.
      e.preventDefault();
      close();
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <>
      <button className="jump" type="button" onClick={show} aria-haspopup="dialog" aria-expanded={open}
        aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}>
        <span>Search zones, sessions…</span><kbd>{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {open && (
        <dialog ref={dialog} className="jump-dialog" aria-label="Search canvas"
          onCancel={e => { e.preventDefault(); close(); }}
          onClick={e => { if (e.target === e.currentTarget) close(); }}>
          <div className="jump-field">
            <CardIcon name="search" />
            <input
              ref={input}
              className="jump-input"
              type="text"
              role="combobox"
              aria-label="Search zones and sessions"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={hits.length > 0 ? optionId(current) : undefined}
              aria-autocomplete="list"
              placeholder="Search zones, sessions…"
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
            />
            <button type="button" className="jump-dismiss" onClick={close} aria-label="Close search">esc</button>
          </div>
          <ul ref={list} id={listId} className="jump-list" role="listbox" aria-label="Zones and sessions">
            {hits.map((hit, i) => (
              <li
                key={hitId(hit)}
                id={optionId(i)}
                role="option"
                aria-selected={i === current}
                className={`jump-hit${hit.kind === 'zone' ? ' is-zone' : ''}${i === current ? ' is-active' : ''}`}
                style={hit.kind === 'zone' ? { '--zone-hue': zoneHue(hit.group.zone) } as CSSProperties : undefined}
                // Keep the combobox focused while a result is pressed.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => { if (i !== current) setActive(i); }}
                onClick={() => pick(hit)}
              >
                {hit.kind === 'note' ? <>
                  <svg className="i jump-image" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h9a1 1 0 0 1 1 1v6l-4 4h-6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" /><path d="M13.5 9.5h-3a1 1 0 0 0-1 1v3" /><path d="M5 6h6M5 8.5h3" /></svg>
                  <span className="t">{noteTitle(hit.note)}</span>
                  <span className="f">Note</span>
                </> : hit.kind === 'item' ? <>
                  <svg className="i jump-image" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="m3 11.5 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5" /><circle cx="10.5" cy="6" r="1" /></svg>
                  <span className="t">{itemTitle(hit.item)}</span>
                  <span className="f">{hit.item.kind === 'image' ? (hit.item.caption ? hit.item.name : 'Image') : 'Note'}</span>
                </> : hit.kind === 'zone' ? <>
                  <ZoneMark icon={hit.group.zone.icon} />
                  <span className="t">{hit.group.zone.name}</span>
                  <span className="f">{hit.group.cards.length} {hit.group.cards.length === 1 ? 'session' : 'sessions'}</span>
                </> : <>
                  <Creature {...(projectIds?.has(hit.session.id) ? { provider: 'orchestrator' as const } : creatureOf(hit.session))} label={hit.session.acp?.name} state={hit.session.state} size={20} />
                  <span className="t">{titleOf(hit.session)}</span>
                  <span className="f">{folderName(hit.session)}</span>
                </>}
              </li>
            ))}
            {hits.length === 0 && <li className="menu-empty" role="presentation">Nothing matches</li>}
          </ul>
          <footer className="jump-footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span>
            {searching && found.sessions.length > 1 && <span className="jump-count">{found.sessions.length} sessions lit on the canvas</span>}
          </footer>
        </dialog>
      )}
    </>
  );
}
