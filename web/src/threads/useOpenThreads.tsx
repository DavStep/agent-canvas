// Open threads on the board: each is a note beside the card of the chat it came from (in that
// card's zone; in its folder's zone when the chat is gone; free on the board when there is
// neither). Continued or dropped on a chat, it opens that chat with the message in its composer;
// dropped on a zone or the empty canvas, it starts a session there with the message as its first
// prompt (as the New session dialog would, with the provider's default model and permission
// mode). Done and Abort can be undone.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { OpenThread, ThreadOp } from '../../../shared/threads.ts';
import type { Layout, SessionView, ZoneLayout } from '../../../shared/types.ts';
import type { ZoneItem } from '../board/ZoneItems.tsx';
import { newSessionBridge, threadOp } from '../bridge.ts';
import { UndoToast } from '../components/UndoToast.tsx';
import { zoneFolder } from '../newSession/form.ts';
import { THREAD_NOTE_H, THREAD_NOTE_W, ThreadNote, useThreadDrops } from './OpenThreads.tsx';
import { dropLabel, threadMessage, type ThreadDrop } from './threads.ts';

export interface ThreadFill { sessionId: string; text: string; append: boolean }

export interface UseOpenThreadsOptions {
  threads: OpenThread[] | undefined;
  sessions: SessionView[] | undefined;
  layout: Layout | undefined;
  /** The zones drawn and the cards in each: a thread goes in the zone of its chat's card. */
  groups: readonly { zone: ZoneLayout; cards: SessionView[] }[];
  now: number;
  /** The canvas agent's session id, when it has one: its threads open its panel. */
  agentSessionId: string | null;
  /** The chat whose composer is on screen (a card's, or the agent's), if any. */
  openChatId: string | null;
  openCard(id: string): void;
  openAgent(): void;
  /** A session started from a ticket: its chat opens, as after the New session dialog. */
  onStarted(cardId: string): void;
}

type Undo = { message: string; op: ThreadOp };
/** As long as the canvas's other undo toasts stay. */
const UNDO_MS = 30_000;

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

export interface OpenThreadsOnBoard {
  /** The thread notes a zone draws, each beside its card. */
  zoneItems(zoneId: string): readonly ZoneItem[];
  /** Thread notes with no zone to go in, free on the board. */
  freeItems: ReactNode;
  toast: ReactNode;
  fill: ThreadFill | null;
}

const NO_ITEMS: readonly ZoneItem[] = [];
/** Free thread notes stand left of the leftmost zone, this far apart. */
const FREE_GAP = 24;

export function useOpenThreads(o: UseOpenThreadsOptions): OpenThreadsOnBoard {
  const [fill, setFill] = useState<ThreadFill | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<ThreadDrop | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const { sessions, layout, groups, now, agentSessionId, openChatId, openCard, openAgent, onStarted } = o;

  // ⌘Z, as the toast says, while focus is not in a field, a chat or a dialog.
  useEffect(() => {
    if (undo === null) return;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      if (isTyping(e.target) || (e.target instanceof Element && e.target.closest('.chat-screen, .explorer, dialog'))) return;
      e.preventDefault();
      threadOp(undo.op).catch(() => {});
      setUndo(null);
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [undo]);

  // A fill is for the one opening of its chat: once that chat has shown it and been left, a later
  // opening starts from the composer's own (empty) state again.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (fill === null) return;
    if (openChatId === fill.sessionId) setFilled(true);
    else if (filled) { setFill(null); setFilled(false); }
  }, [fill, filled, openChatId]);

  const isAgent = useCallback((t: OpenThread) => agentSessionId !== null && t.sessionId === agentSessionId, [agentSessionId]);
  const canOpen = useCallback((t: OpenThread) => isAgent(t) || (sessions?.some((s) => s.id === t.sessionId) ?? false), [isAgent, sessions]);

  const apply = useCallback((op: ThreadOp, message: string | null, back: ThreadOp | null) => {
    threadOp(op).then(() => {
      setNote(null);
      setUndo(message !== null && back !== null ? { message, op: back } : null);
    }).catch((err: unknown) => {
      setUndo(null);
      setNote(err instanceof Error ? err.message : String(err));
    });
  }, []);
  const done = useCallback((t: OpenThread, message = 'Thread marked done') => apply({ type: 'done', id: t.id }, message, { type: 'restore', id: t.id }), [apply]);
  const abort = useCallback((t: OpenThread) => apply({ type: 'dismiss', id: t.id }, 'Thread aborted', { type: 'restore', id: t.id }), [apply]);

  /** Opens a chat with the message in its composer. */
  const into = useCallback((t: OpenThread, sessionId: string, append: boolean) => {
    if (sessionId === agentSessionId) openAgent(); else if (sessionId !== openChatId) openCard(sessionId);
    setFilled(false);
    setFill({ sessionId, text: threadMessage(t, Date.now()), append });
    done(t, 'Thread moved to the message');
  }, [agentSessionId, openAgent, openCard, openChatId, done]);

  /** Starts a session in a folder with the message as its first prompt. */
  const startIn = useCallback(async (t: OpenThread, cwd: string) => {
    if (cwd === '') { setNote('That thread has no folder to start a session in.'); return; }
    setNote('Starting a session…');
    try {
      const opts = await newSessionBridge.options(t.provider);
      const cardId = await newSessionBridge.start({ provider: t.provider, cwd, model: opts.model, effort: opts.effort, mode: opts.mode, text: threadMessage(t, Date.now()), images: [] });
      setNote(null);
      done(t, 'Thread started as a new session');
      onStarted(cardId);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  }, [done, onStarted]);

  const onContinue = useCallback((t: OpenThread) => {
    if (canOpen(t)) into(t, t.sessionId, false);
    else void startIn(t, t.cwd);
  }, [canOpen, into, startIn]);

  const onDrop = useCallback((t: OpenThread, drop: ThreadDrop) => {
    setDragging(null);
    setNote(null);
    if (drop.kind === 'composer') {
      if (openChatId !== null) into(t, openChatId, true);
      return;
    }
    if (drop.kind === 'card') { into(t, drop.id, openChatId === drop.id); return; }
    if (drop.kind === 'zone') {
      const zone = layout?.zones.find((z) => z.id === drop.id);
      void startIn(t, (zone && sessions ? zoneFolder(zone, sessions) : null) ?? t.cwd);
      return;
    }
    void startIn(t, t.cwd);
  }, [into, layout, openChatId, sessions, startIn]);

  const onOpenSource = useCallback((t: OpenThread) => {
    if (isAgent(t)) openAgent(); else openCard(t.sessionId);
  }, [isAgent, openAgent, openCard]);

  const threads = useMemo(() => o.threads ?? [], [o.threads]);
  useThreadDrops(threads, onDrop, setHover);

  const measured = useCallback((id: string, h: number) => {
    setHeights((was) => (h > 0 && Math.abs((was[id] ?? 0) - h) >= 1 ? { ...was, [id]: Math.round(h) } : was));
  }, []);
  const nodeFor = useCallback((t: OpenThread): ReactNode => (
    <ThreadNote key={t.id} thread={t} now={now} dragging={dragging === t.id} canOpen={canOpen(t)}
      onOpenSource={() => onOpenSource(t)} onContinue={() => onContinue(t)} onDone={() => done(t)} onAbort={() => abort(t)}
      onDragStart={() => { setNote(null); setDragging(t.id); }} onDragEnd={() => setDragging(null)}
      onHeight={(h) => measured(t.id, h)} />
  ), [abort, canOpen, done, dragging, measured, now, onContinue, onOpenSource]);

  // Where each goes: its card's zone, beside the card; else its folder's zone; else free.
  const { byZone, free } = useMemo(() => {
    const zoneOfCard = new Map<string, string>();
    for (const g of groups) for (const c of g.cards) zoneOfCard.set(c.id, g.zone.id);
    const byZone = new Map<string, ZoneItem[]>();
    const free: OpenThread[] = [];
    for (const t of threads) {
      const height = heights[t.id] ?? THREAD_NOTE_H;
      const cardZone = zoneOfCard.get(t.sessionId);
      const zoneId = cardZone ?? groups.find((g) => g.zone.folder !== null && g.zone.folder === t.folder)?.zone.id;
      if (zoneId === undefined) { free.push(t); continue; }
      const list = byZone.get(zoneId) ?? [];
      // Without a card it shares the first column with the other unanchored notes.
      list.push({ id: `thread:${t.id}`, col: 0, top: 0, width: THREAD_NOTE_W, height, node: nodeFor(t),
        ...(cardZone !== undefined ? { beside: t.sessionId } : {}) });
      byZone.set(zoneId, list);
    }
    return { byZone, free };
  }, [groups, heights, nodeFor, threads]);
  const zoneItems = useCallback((zoneId: string) => byZone.get(zoneId) ?? NO_ITEMS, [byZone]);

  let freeItems: ReactNode = null;
  if (free.length > 0) {
    const placed = (layout?.zones ?? []).filter((z) => z.x !== null && z.y !== null);
    const x = placed.length > 0 ? Math.min(...placed.map((z) => z.x!)) - THREAD_NOTE_W - 48 : 0;
    let y = placed.length > 0 ? Math.min(...placed.map((z) => z.y!)) : 0;
    freeItems = (
      <div className="board-items board-threads" aria-label="Open threads">
        {free.map((t) => {
          const at = y;
          y += (heights[t.id] ?? THREAD_NOTE_H) + FREE_GAP;
          return <div key={t.id} className="board-item-free" style={{ translate: `${x}px ${at}px` }}>{nodeFor(t)}</div>;
        })}
      </div>
    );
  }

  const hint = dragging !== null ? dropLabel(hover) : note;
  const toast = <>
    {undo !== null && dragging === null && (
      <UndoToast message={undo.message} onDismiss={() => setUndo(null)}
        onUndo={() => { threadOp(undo.op).catch(() => {}); setUndo(null); }} />
    )}
    {hint !== null && (undo === null || dragging !== null) && (
      <div className="undo-toast board-notice thread-hint" role="status" aria-live="polite"><span>{hint}</span></div>
    )}
  </>;
  return { zoneItems, freeItems, toast, fill };
}
