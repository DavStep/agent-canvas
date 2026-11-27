// Everything links add to the board: the lines and the port (Connectors), a card's menu
// (right-click or the menu key: "Run after…"), the "Run after…" dialog, and planned cards, which
// open that dialog rather than a chat. Canvas.tsx mounts it inside the board. See docs/links.md.
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref, type RefObject } from 'react';
import type { RunView } from '../../../shared/runs.ts';
import type { SessionView } from '../../../shared/types.ts';
import { runOp } from '../bridge.ts';
import { titleOf } from '../briefing.ts';
import { CardMenu } from './CardMenu.tsx';
import { Connectors, type ConnectorsHandle } from './Connectors.tsx';
import { LinkDialog } from './LinkDialog.tsx';
import { cardWaits, isPlanned, linesOf, plannedName } from './links.ts';

export interface CanvasLinksProps {
  board: RefObject<HTMLDivElement | null>;
  scale(): number;
  runs: readonly RunView[] | undefined;
  /** The cards drawn, planned ones included. */
  sessions: SessionView[];
  onNewSession?(from: string, zoneId?: string): void;
  ref?: Ref<ConnectorsHandle>;
}

type Menu = { id: string; x: number; y: number };
type Dialog = { to: string; from: string[] };

export function CanvasLinks({ board, scale, runs, sessions, onNewSession, ref }: CanvasLinksProps) {
  const connectors = useRef<ConnectorsHandle>(null);
  useImperativeHandle(ref, () => ({ kick: (ms?: number) => connectors.current?.kick(ms) }), []);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const lines = useMemo(() => linesOf(runs), [runs]);
  const waits = useMemo(() => cardWaits(runs), [runs]);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const nameOf = useCallback((id: string): string => {
    const s = byId.get(id);
    if (s) return titleOf(s);
    if (id.startsWith('@project:')) return 'Project orchestrator';
    const run = runs?.find((r) => r.node === id);
    return run ? plannedName(run) : 'a session';
  }, [byId, runs]);
  const runFor = (id: string): RunView | null => runs?.find((r) => r.node === id && r.status !== 'started') ?? null;

  // Right-click or the menu key on a card opens its menu (not the zone's); a planned card opens
  // its dialog when clicked, and is never dragged.
  const ownerPlans = useMemo(() => new Set(runs?.filter(r => r.by === 'owner' && r.target.kind === 'new').map(r => r.node)), [runs]);
  useEffect(() => {
    const host = board.current;
    if (!host) return;
    const cardOf = (e: Event): HTMLElement | null => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>('.card[data-card-id]') : null;
      return el && host.contains(el) ? el : null;
    };
    const linkable = (id: string) => !id.startsWith('@project:');
    const onContext = (e: MouseEvent) => {
      const card = cardOf(e);
      const id = card?.dataset.cardId;
      if (!id || !linkable(id)) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ id, x: e.clientX, y: e.clientY });
    };
    const onKey = (e: KeyboardEvent) => {
      const card = cardOf(e);
      const id = card?.dataset.cardId;
      if (!card || !id || e.target !== card) return;
      if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && linkable(id)) {
        e.preventDefault();
        e.stopPropagation();
        const r = card.getBoundingClientRect();
        setMenu({ id, x: r.left + 12, y: r.bottom - 8 });
      } else if (isPlanned(id) && !ownerPlans.has(id) && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
        setDialog({ to: id, from: [] });
      }
    };
    const onClick = (e: MouseEvent) => {
      const id = cardOf(e)?.dataset.cardId;
      if (!id || !isPlanned(id) || ownerPlans.has(id)) return;
      e.preventDefault();
      e.stopPropagation();
      setDialog({ to: id, from: [] });
    };
    const onPress = (e: PointerEvent) => {
      const id = cardOf(e)?.dataset.cardId;
      if (id && isPlanned(id)) e.stopPropagation();
    };
    host.addEventListener('contextmenu', onContext, true);
    host.addEventListener('keydown', onKey, true);
    host.addEventListener('click', onClick, true);
    host.addEventListener('pointerdown', onPress, true);
    return () => {
      host.removeEventListener('contextmenu', onContext, true);
      host.removeEventListener('keydown', onKey, true);
      host.removeEventListener('click', onClick, true);
      host.removeEventListener('pointerdown', onPress, true);
    };
  }, [board, ownerPlans]);

  const menuWait = menu ? waits.get(menu.id) ?? null : null;
  const menuRun = menu ? runFor(menu.id) : null;
  const failed = !!menuRun?.error && menuRun.status === 'blocked' && !menuRun.edges.some((e) => e.state === 'interrupted');
  return (
    <>
      <Connectors
        ref={connectors}
        board={board}
        scale={scale}
        lines={lines}
        nameOf={nameOf}
        canLink={(id) => !isPlanned(id) && !id.startsWith('@project:')}
        onNewSession={onNewSession}
        onLink={(from, to) => setDialog({ to, from: [from] })}
        onUnlink={(from, to) => { runOp({ type: 'unlink', from, to }).catch(() => {}); }}
      />
      {menu && (
        <CardMenu
          key={menu.id}
          name={nameOf(menu.id)}
          at={menu}
          wait={menuWait}
          failed={failed}
          onRunAfter={() => setDialog({ to: menu.id, from: [] })}
          onRemoveWait={() => { if (menuRun) runOp({ type: 'cancelRun', id: menuRun.id }).catch(() => {}); }}
          onRetry={() => { if (menuRun) runOp({ type: 'retryRun', id: menuRun.id }).catch(() => {}); }}
          onClose={closeMenu}
        />
      )}
      {dialog && createPortal(
        <LinkDialog
          key={`${dialog.to}:${dialog.from.join(',')}`}
          to={dialog.to}
          from={dialog.from}
          run={runFor(dialog.to)}
          sessions={sessions}
          nameOf={nameOf}
          onClose={() => setDialog(null)}
        />,
        document.body,
      )}
    </>
  );
}
