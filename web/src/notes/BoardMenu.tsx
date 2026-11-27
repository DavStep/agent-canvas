// The board's own menu: right-click on empty canvas (or Shift+F10 or the menu key with nothing on
// the board focused, opening at the canvas's middle) offers a new note there, a new zone there
// (named at once), a new session, and a note of the image on the clipboard when it holds one.
// Cards, zones, images and notes keep their own menus; this one is only for the empty desk.
// Fixed to the window like the zone and card menus, in the same shape (.menu, .menu-item).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { NoteImage } from '../../../shared/boardNotes.ts';
import type { Layout, LayoutOp } from '../../../shared/types.ts';
import { notesBridge } from '../bridge.ts';
import type { PanZoom } from '../canvas/usePanZoom.ts';
import { toBoard } from '../board/geometry.ts';
import { clampMenu } from '../components/ZoneMenu.tsx';

/** What on the canvas has a menu of its own, or is not the empty desk. */
const NOT_EMPTY = '.card, .zone, [data-item-id], .board-preview, .board-tile, button, a, input, textarea, select, [contenteditable], .menu, dialog, .undo-toast, .agent-button, .orb';
const NEW_ZONE_NAME = 'New zone';

export interface BoardMenuProps {
  workspace: RefObject<HTMLElement | null>;
  /** False while a chat covers the canvas, or a dialog is open. */
  enabled: boolean;
  onNewNote(clientX: number, clientY: number, images?: NoteImage[]): void;
  onNewZone(clientX: number, clientY: number): void;
  onNewSession(): void;
}

export function BoardMenu({ workspace, enabled, onNewNote, onNewZone, onNewSession }: BoardMenuProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const ws = workspace.current;
    if (!ws || !enabled) return;
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented || !(e.target instanceof Element) || e.target.closest(NOT_EMPTY)) return;
      e.preventDefault();
      setAt({ x: e.clientX, y: e.clientY });
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
      if (document.querySelector('dialog[open]')) return;
      const active = document.activeElement;
      const onDesk = active === null || active === document.body || active === ws || (ws.contains(active) && !active.closest(NOT_EMPTY));
      if (!onDesk) return;
      e.preventDefault();
      const r = ws.getBoundingClientRect();
      setAt({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    };
    ws.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKey);
    return () => { ws.removeEventListener('contextmenu', onContext); window.removeEventListener('keydown', onKey); };
  }, [enabled, workspace]);
  useEffect(() => { if (!enabled) setAt(null); }, [enabled]);

  const close = useCallback(() => setAt(null), []);
  return at === null ? null : (
    <DeskMenu at={at} onClose={close}
      onNewNote={() => onNewNote(at.x, at.y)}
      onNewZone={() => onNewZone(at.x, at.y)}
      onNewSession={onNewSession}
      onPasteNote={async () => {
        const img = await notesBridge.importClipboardImage().catch(() => null);
        if (img) onNewNote(at.x, at.y, [img]);
      }} />
  );
}

function DeskMenu({ at, onClose, onNewNote, onNewZone, onNewSession, onPasteNote }: {
  at: { x: number; y: number }; onClose(): void;
  onNewNote(): void; onNewZone(): void; onNewSession(): void; onPasteNote(): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [canPaste, setCanPaste] = useState(false);

  useEffect(() => {
    let live = true;
    notesBridge.clipboardHasImage().then((has) => { if (live) setCanPaste(has); }, () => {});
    return () => { live = false; };
  }, []);
  useLayoutEffect(() => {
    const el = panel.current!;
    setPos(clampMenu(at.x, at.y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
  }, [at.x, at.y, canPaste]);
  useLayoutEffect(() => { panel.current?.querySelector<HTMLElement>('.menu-item')?.focus(); }, []);

  // Focus goes back where it was; a press outside, a wheel, or leaving the window closes it.
  useLayoutEffect(() => {
    const back = document.activeElement;
    return () => { if (back instanceof HTMLElement && back.isConnected && !document.activeElement?.closest('.board-note, .zone')) back.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const outside = (e: Event) => { if (e.target instanceof Node && !panel.current?.contains(e.target)) onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', outside, { capture: true, passive: true });
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', outside, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === 'Tab') { e.preventDefault(); onClose(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...panel.current!.querySelectorAll<HTMLElement>('.menu-item')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const pick = (fn: () => void) => () => { onClose(); fn(); };

  return createPortal(
    <div ref={panel} className="menu desk-menu" role="menu" aria-label="Canvas" style={{ left: pos.x, top: pos.y } as CSSProperties}
      onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitem" className="menu-item" onClick={pick(onNewNote)}>
        <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h9a1 1 0 0 1 1 1v6l-4 4h-6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" /><path d="M13.5 9.5h-3a1 1 0 0 0-1 1v3" /></svg>
        <span className="name">New note</span>
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={pick(onNewZone)}>
        <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" strokeDasharray="2.4 1.8" /><path d="M8 6v4M6 8h4" /></svg>
        <span className="name">New zone</span>
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={pick(onNewSession)}>
        <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="m5 7 2 1.5L5 10M8.5 10.5H11" /></svg>
        <span className="name">New session…</span>
      </button>
      {canPaste && (
        <button type="button" role="menuitem" className="menu-item" onClick={pick(onPasteNote)}>
          <svg className="i" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3" width="9" height="11" rx="1.5" /><path d="M6 3V2.5h4V3" /><path d="m5 11.5 2-2 1.5 1.5 1-1 1.5 1.5" /></svg>
          <span className="name">Paste image as a note</span>
        </button>
      )}
    </div>,
    document.body,
  );
}

/** "New zone" from the board's menu: a custom zone made where the owner asked, then named at once
    (its label opens for renaming, as a double-click does). */
export function useNewZoneAt({ layout, send, workspace, view }: {
  layout: Layout | null; send(op: LayoutOp): Promise<void>; workspace: RefObject<HTMLElement | null>; view: PanZoom;
}): (clientX: number, clientY: number) => void {
  const [pending, setPending] = useState<{ before: Set<string>; x: number; y: number } | null>(null);
  const latest = useRef(layout);
  latest.current = layout;

  useEffect(() => {
    if (!pending || !layout) return;
    const zone = layout.zones.find((z) => z.kind === 'custom' && !pending.before.has(z.id));
    if (!zone) return;
    setPending(null);
    send({ type: 'moveZone', id: zone.id, x: pending.x, y: pending.y }).catch(() => {});
    // Once it is drawn there, its name opens for typing.
    let tries = 0;
    const rename = () => {
      const label = workspace.current?.querySelector<HTMLElement>(`.zone[data-zone-id="${CSS.escape(zone.id)}"] .zone-label`);
      if (!label) { if (++tries < 30) requestAnimationFrame(rename); return; }
      label.focus({ preventScroll: true });
      label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      requestAnimationFrame(() => workspace.current?.querySelector<HTMLInputElement>(`.zone[data-zone-id="${CSS.escape(zone.id)}"] .zone-label input`)?.select());
    };
    requestAnimationFrame(rename);
  }, [layout, pending, send, workspace]);

  return useCallback((clientX: number, clientY: number) => {
    const board = workspace.current?.querySelector<HTMLElement>(':scope .board');
    const p = board ? toBoard(board, clientX, clientY, view.transform.k) : { x: 0, y: 0 };
    // Its label sits under the pointer.
    setPending({ before: new Set(latest.current?.zones.map((z) => z.id) ?? []), x: Math.round(p.x - 24), y: Math.round(p.y - 18) });
    send({ type: 'createZone', name: NEW_ZONE_NAME }).catch(() => setPending(null));
  }, [send, view, workspace]);
}
