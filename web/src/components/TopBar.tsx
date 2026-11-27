// The slim top bar: name, counts, link state, the jump box, the zones menu and the view controls.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import type { PanZoom } from '../canvas/usePanZoom.ts';
import type { AccountsView } from '../../../shared/account.ts';
import type { ZoneLayout } from '../../../shared/types.ts';
import { Avatar } from '../profile/ProfilePage.tsx';
import { MARK_DOTS } from './dots.ts';
import { JumpBox, type SearchHits, type ZoneGroup } from './JumpBox.tsx';
import type { BoardItem } from '../../../shared/boardItems.ts';
import type { NoteItem } from '../../../shared/boardNotes.ts';
import { titleOf } from '../briefing.ts';
import { zoneHue, ZoneMark } from './ZoneMark.tsx';
import { removeNote } from './Zone.tsx';
import { activeLimitLabel, type ActiveLimit } from '../../../shared/interruption.ts';

export interface TopBarProps {
  projectIds?: ReadonlySet<string>;
  /** Images on the board, for search (by file name or caption), and the view travelling to one. */
  boardItems?: readonly BoardItem[];
  /** The owner's notes, for search (by what is written in them); picking one travels there as for an image. */
  notes?: readonly NoteItem[];
  onCentreItem?(id: string): void;
  /** False while a chat covers the canvas. */
  active?: boolean;
  total: number | null;
  working: number;
  waiting: number;
  connected: boolean;
  /** Zones on the canvas with their cards in canvas order, for the search box. */
  groups: ZoneGroup[];
  onJump(id: string): void;
  /** What the search box finds, for the canvas to light up; null when nothing is typed. */
  onSearchHits?(hits: SearchHits | null): void;
  /** Zones on the canvas, for the zones menu. */
  zones: ZoneLayout[];
  /** Folder zones the owner removed that are off the canvas now: the menu can bring them back. */
  removedZones: ZoneLayout[];
  onCentreZone(id: string): void;
  onCreateZone(name: string): void;
  /** Deletes a custom zone, or takes a folder zone off the canvas. */
  onDeleteZone(id: string): void;
  onRestoreZone(id: string): void;
  onMarkAllSeen(): void;
  /** Packs every zone into tidy rows (after the menu's confirm); an undo follows on the canvas. */
  onTidy(): void;
  /** Current zoom; the control shows it as a percentage and resets it to 100%. */
  view: PanZoom;
  onResetZoom(): void;
  onFit(): void;
  /** "+ New session" (⌘N). */
  onNewSession(): void;
  /** For the avatar's initial. */
  accounts: AccountsView | null;
  onProfile(): void;
  /** A usage limit holding sessions now ("Limit · resets 16:00"); null once it has reset. */
  limit?: ActiveLimit | null;
  now?: number;
}

function Mark() {
  return (
    <svg className="sp is-done mark" width="23" height="20" viewBox="0 0 23 20" shapeRendering="crispEdges" aria-hidden="true">
      {MARK_DOTS.map(([cls, x, y]) => <rect key={`${x},${y}`} className={cls} x={x} y={y} width="2" height="2" />)}
    </svg>
  );
}

/**
 * Whether focus moving to `next` leaves the menu. Focus going nowhere does not count: the browser
 * reports that when a focused item is replaced (New zone becoming the name field) or the window
 * loses focus, and the menu stays open for both.
 */
export function focusLeaves(menu: { contains(node: Node | null): boolean } | null, next: EventTarget | null): boolean {
  return menu !== null && next !== null && !menu.contains(next as Node);
}

interface ZonesMenuProps {
  zones: ZoneLayout[];
  removed: ZoneLayout[];
  onCentre(id: string): void;
  onCreate(name: string): void;
  onDelete(id: string): void;
  onRestore(id: string): void;
  onMarkAllSeen(): void;
  onTidy(): void;
}

/** The menu's confirm for Tidy canvas; zone ids all carry a "folder:" or "custom:" prefix, so it never meets one. */
const TIDY = 'tidy';
export const TIDY_NOTE = 'Lines every zone up in rows, in the order they sit now. Cards stay in their zones. You can undo for 30 seconds.';

function ZonesMenu({ zones, removed, onCentre, onCreate, onDelete, onRestore, onMarkAllSeen, onTidy }: ZonesMenuProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    setCreating(false);
    setConfirming(null);
    if (refocus) button.current?.focus();
  };

  // A press anywhere outside the menu closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrap.current?.contains(e.target)) close(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Focus follows the menu's state: the first item on open, the field when naming, Cancel when confirming.
  useEffect(() => {
    if (!open) return;
    const target = panel.current?.querySelector<HTMLElement>(creating ? 'input' : confirming ? '.menu-confirm .cancel' : 'button');
    target?.focus();
  }, [open, creating, confirming]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    if (creating) setCreating(false);
    else if (confirming) setConfirming(null);
    else close(true);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = new FormData(e.currentTarget).get('name');
    if (typeof name !== 'string' || name.trim() === '') return;
    onCreate(name);
    close(true);
  };

  return (
    <div
      className="menu-wrap"
      ref={wrap}
      onKeyDown={onKeyDown}
      // Tabbing out of the menu closes it, as a press outside does.
      onBlur={(e) => { if (open && focusLeaves(wrap.current, e.relatedTarget)) close(false); }}
    >
      <button
        ref={button}
        className={`tool${open ? ' is-open' : ''}`}
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        Zones
      </button>
      {open && (
        <div ref={panel} className="menu zones-menu" aria-label="Zones">
          {creating ? (
            <form className="menu-new" onSubmit={submit}>
              <input name="name" type="text" maxLength={60} placeholder="Zone name" aria-label="New zone name" autoComplete="off" spellCheck={false} />
              <button className="menu-btn" type="submit">Create</button>
            </form>
          ) : (
            <button className="menu-item" type="button" onClick={() => setCreating(true)}>New zone</button>
          )}
          <div className="menu-sep" role="separator" />
          <div className="menu-zones">
            {zones.map((z) => {
              const hue = { '--zone-hue': zoneHue(z) } as CSSProperties;
              if (confirming === z.id) {
                return (
                  <div className="menu-confirm" key={z.id} role="group" aria-label={`Remove ${z.name}`}>
                    <p>{removeNote(z, 'this menu')}</p>
                    <div>
                      <button className="menu-btn danger" type="button" onClick={() => { onDelete(z.id); setConfirming(null); }}>
                        {z.kind === 'custom' ? 'Delete' : 'Remove'}
                      </button>
                      <button className="menu-btn cancel" type="button" onClick={() => setConfirming(null)}>Cancel</button>
                    </div>
                  </div>
                );
              }
              return (
                <div className="menu-row" key={z.id} style={hue}>
                  <button className="menu-item" type="button" title={`Show ${z.name}`} onClick={() => { onCentre(z.id); close(false); }}>
                    <ZoneMark icon={z.icon} /><span className="name">{z.name}</span>
                  </button>
                  <button className="menu-item del" type="button" aria-label={`Remove ${z.name}`} title="Remove from the canvas"
                    onClick={() => setConfirming(z.id)}>Remove</button>
                </div>
              );
            })}
          </div>
          {removed.length > 0 && <>
            <div className="menu-sep" role="separator" />
            <p className="menu-label">Removed</p>
            <div className="menu-zones is-removed">
              {removed.map((z) => (
                <div className="menu-row is-removed" key={z.id} style={{ '--zone-hue': zoneHue(z) } as CSSProperties}>
                  <span className="menu-item is-static"><ZoneMark icon={z.icon} /><span className="name">{z.name}</span></span>
                  <button className="menu-item del restore" type="button" aria-label={`Show ${z.name}`} onClick={() => onRestore(z.id)}>Show</button>
                </div>
              ))}
            </div>
          </>}
          <div className="menu-sep" role="separator" />
          {confirming === TIDY ? (
            <div className="menu-confirm" role="group" aria-label="Tidy canvas">
              <p>{TIDY_NOTE}</p>
              <div>
                <button className="menu-btn" type="button" onClick={() => { onTidy(); close(true); }}>Tidy</button>
                <button className="menu-btn cancel" type="button" onClick={() => setConfirming(null)}>Cancel</button>
              </div>
            </div>
          ) : zones.length > 0 && (
            <button className="menu-item" type="button" onClick={() => setConfirming(TIDY)}>Tidy canvas</button>
          )}
          <button className="menu-item" type="button" onClick={() => { onMarkAllSeen(); close(true); }}>Mark all seen</button>
        </div>
      )}
    </div>
  );
}

function ZoomButton({ view, onReset }: { view: PanZoom; onReset(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  const percent = Math.round(view.transform.k * 100);
  useLayoutEffect(() => {
    const el = button.current;
    if (!el) return;
    let shown = el.textContent;
    return view.watch(({ k }) => {
      const next = `${Math.round(k * 100)}%`;
      if (next === shown) return;
      shown = next;
      el.textContent = next;
      el.setAttribute('aria-label', `Zoom ${next}, reset to 100%`);
    });
  }, [view.watch]);
  return (
    <button ref={button} className="tool mono" type="button" onClick={onReset} title="Reset zoom to 100%" aria-label={`Zoom ${percent}%, reset to 100%`}>
      {`${percent}%`}
    </button>
  );
}

export function TopBar(props: TopBarProps) {
  const { total, working, waiting, connected } = props;
  return (
    <header className="topbar">
      <div className="brand"><Mark />Agent canvas</div>
      {total !== null && (
        <div className="counts">
          <span>{total} {total === 1 ? 'session' : 'sessions'}</span>
          <span className="sep">·</span>
          <button className="working-count" type="button" popoverTarget="running-sessions" disabled={!working} aria-label={`Show ${working} running sessions`}>{working} working</button>
          <aside id="running-sessions" popover="auto" className="running-sessions" aria-label="Running sessions">
            <h2>Running sessions</h2>
            {props.groups.flatMap(g => g.cards).filter(s => s.state === 'working').map(s =>
              <button type="button" key={s.id} onClick={e => { e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover(); props.onJump(s.id); }}>
                <strong>{titleOf(s)}</strong><span>{s.recentSteps?.findLast(t => t.status === 'running')?.label || s.activity || s.folder}</span>
              </button>)}
            {!working && <p>No running sessions</p>}
          </aside>
          {waiting > 0 && <>
            <span className="sep">·</span>
            <span className="wait" key={waiting}><i />{waiting} {waiting === 1 ? 'needs' : 'need'} you</span>
          </>}
        </div>
      )}
      {props.limit && (
        // Opens the session it holds, the soonest to reset first.
        <button type="button" className="limit-note" data-testid="limit-note" onClick={() => props.onJump(props.limit!.firstId)}
          title={`${props.limit.count === 1 ? 'A session is' : `${props.limit.count} sessions are`} waiting for a usage limit to reset`}>
          <i aria-hidden="true">!</i>{activeLimitLabel(props.limit, props.now ?? Date.now())}
        </button>
      )}
      {!connected && <span className="conn" role="status"><i />Reconnecting…</span>}
      <div className="tools">
        <JumpBox projectIds={props.projectIds} groups={props.groups} onPick={props.onJump} onPickZone={props.onCentreZone} onHits={props.onSearchHits} enabled={props.active ?? true}
          items={props.boardItems} notes={props.notes} onPickItem={props.onCentreItem} />
        <ZonesMenu
          zones={props.zones}
          removed={props.removedZones}
          onCentre={props.onCentreZone}
          onCreate={props.onCreateZone}
          onDelete={props.onDeleteZone}
          onRestore={props.onRestoreZone}
          onMarkAllSeen={props.onMarkAllSeen}
          onTidy={props.onTidy}
        />
        <button className="tool" type="button" onClick={props.onFit} aria-keyshortcuts="F" title="Fit all zones (F)">Fit</button>
        <ZoomButton view={props.view} onReset={props.onResetZoom} />
        <span className="tools-sep" aria-hidden="true" />
        <button className="tool new-session" type="button" onClick={props.onNewSession} aria-keyshortcuts="Meta+N" title="New session (⌘N)">
          <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
          New session<kbd>⌘N</kbd>
        </button>
        <Avatar accounts={props.accounts} onOpen={props.onProfile} />
      </div>
    </header>
  );
}
