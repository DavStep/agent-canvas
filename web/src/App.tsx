// The page: top bar, briefing and canvas; opening a card opens its chat in a panel docked right
// of the canvas, which narrows and stays in use. The panel's Full screen gives the chat the whole
// window; the canvas stays mounted (hidden) under it, so going back finds the same pan and zoom.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Layout, LayoutOp, SessionView, ZoneLayout } from '../../shared/types.ts';
import { isPlanId, runOfPlan } from '../../shared/runs.ts';
import { plannedCards } from './links/links.ts';
import { PlannedChat } from './links/PlannedChat.tsx';
import type { SearchHits } from './components/JumpBox.tsx';
import type { ImageRef } from '../../shared/chat.ts';
import { AGENT_ID, AGENT_PANEL, afterClose, afterStart, agentChatId, isAgentShortcut, newConversation, orbState, projectDraftId } from './agent/agent.ts';
import { ActivityLogMenu } from './components/ActivityLogMenu.tsx';
import { AgentButton } from './agent/AgentOrb.tsx';
import { AgentStart } from './agent/AgentStart.tsx';
import { useAgentInfo } from './agent/useAgentInfo.ts';
import { useOrbFlight } from './agent/useOrbFlight.ts';
import { agentBridge, newSessionBridge, layoutOp, markSeen, useSnapshot } from './bridge.ts';
import { isDone, titleOf } from './briefing.ts';
import { layoutWithPending, reconcilePending, type PendingOp } from './canvas/drag.ts';
import { GRID } from './canvas/snap.ts';
import { undoOps, type ZoneMove } from './canvas/tidyZones.ts';
import { usePanZoom } from './canvas/usePanZoom.ts';
import { usePreviewZoom } from './canvas/previewZoom.ts';
import { Briefing } from './components/Briefing.tsx';
import { Canvas, zonesWithCards, type ViewRequest } from './components/Canvas.tsx';
import { useCardSlots, type CardTidy } from './canvas/useCardSlots.ts';
import { TopBar } from './components/TopBar.tsx';
import { UndoToast } from './components/UndoToast.tsx';
import { ChatScreen, type ChatMode } from './chat/ChatScreen.tsx';
import { loadPanelWidth, panelWidthCss, savePanelWidth } from './chat/panelWidth.ts';
import { zoneFolder } from './newSession/form.ts';
import { NewSessionDialog } from './newSession/NewSessionDialog.tsx';
import { Explorer } from './explorer/Explorer.tsx';
import { useBoardItems } from './board/useBoardItems.tsx';
import { readNoteAppearance, saveNoteAppearance } from './notes/appearance.ts';
import { useBoardNotes } from './notes/useBoardNotes.tsx';
import { BoardMenu, useNewZoneAt } from './notes/BoardMenu.tsx';
import { PreviewWorkspace, type ToolSelection } from './preview/PreviewWorkspace.tsx';
import { BoardPreviewRow } from './preview/BoardPreviewRow.tsx';
import { readBoardPreviews, writeBoardPreviews, type BoardPreview } from './preview/boardPreviews.ts';
import { pageOf, sessionPages } from './preview/sessionPages.ts';
import { PermissionsSheet } from './onboarding/PermissionsSheet.tsx';
import { ProfilePage } from './profile/ProfilePage.tsx';
import { useAccounts } from './profile/useAccounts.ts';
import { sortCards } from './order.ts';
import { Lingering, PANEL_ENTER_MS, PANEL_EXIT_MS, useArriving, useLingering } from './useLingering.ts';
import { useOpenThreads } from './threads/useOpenThreads.tsx';
import { activeLimit } from '../../shared/interruption.ts';

const TICK_MS = 15_000;

/** The clock the time labels read: every 15 s, and whenever a new snapshot arrives. */
function useNow(snapshotAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  const receivedAt = useMemo(() => Date.now(), [snapshotAt]);
  return Math.max(now, receivedAt);
}

/** The open chat lives in the URL hash, so a reload keeps it. A malformed hash opens nothing. */
export function idFromHash(hash: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  return id === '' ? null : id;
}

/** The mouse's side buttons: 3 is Back, 4 is Forward. Any other button is not a history step. */
export function historyStep(button: number): -1 | 1 | null {
  if (button === 3) return -1;
  if (button === 4) return 1;
  return null;
}

const hashFor = (id: string | null): string => (id === null ? '' : `#${encodeURIComponent(id)}`);
const urlWithHash = (hash: string): string => `${window.location.pathname}${window.location.search}${hash}`;
/** How many of this window's own history steps lie behind an entry (0 for the one it opened on). */
export function historyDepth(state: unknown): number {
  const d = (state as { depth?: unknown } | null)?.depth;
  return typeof d === 'number' && Number.isInteger(d) && d > 0 ? d : 0;
}

/** The window title: the waiting count, or no count at all while the reader is unreachable. */
export function pageTitle(waiting: number, connected: boolean): string {
  if (!connected) return 'Agent canvas (reconnecting)';
  return waiting > 0 ? `(${waiting}) Agent canvas` : 'Agent canvas';
}

/** Layout ops shown at once, on top of the last snapshot, until the reader's next snapshot shows them. */
function useLayoutOps(snapshotLayout: Layout | null) {
  const [pending, setPending] = useState<PendingOp[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    if (snapshotLayout) setPending((p) => reconcilePending(p, snapshotLayout));
  }, [snapshotLayout]);

  const send = useCallback((op: LayoutOp): Promise<void> => {
    const n = ++seq.current;
    // A new zone's id is the reader's to choose, so it appears with the next snapshot.
    if (op.type !== 'createZone') setPending((p) => [...p, { seq: n, op, settled: false }]);
    return layoutOp(op).then(
      () => setPending((p) => p.map((x) => (x.seq === n ? { ...x, settled: true } : x))),
      (err: unknown) => {
        setPending((p) => p.filter((x) => x.seq !== n));
        throw err;
      },
    );
  }, []);

  const layout = snapshotLayout ? layoutWithPending(snapshotLayout, pending) : null;
  return { layout, send };
}

/** How long a tidy can be undone. */
export const TIDY_UNDO_MS = 30_000;

/** The cards "Mark all seen" clears: those waiting only because they finished. */
export function replyIds(sessions: SessionView[]): string[] {
  return sessions.filter(isDone).map((s) => s.id);
}

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
/** A key pressed with focus in the chat (or the project explorer): the canvas's keys are not for it. */
const inChat = (t: EventTarget | null): boolean => t instanceof Element && t.closest('.chat-screen, .explorer') !== null;

function restoreBoardPage(pin: BoardPreview) {
  const page = pageOf(sessionPages, pin.session);
  if (!page.url && pin.address) { page.url = pin.address; page.typed = true; }
}

export function App() {
  const { snapshot, connected } = useSnapshot();
  const now = useNow(snapshot?.generatedAt);
  const [selectedId, setSelectedId] = useState<string | null>(() => idFromHash(window.location.hash));
  const { layout, send } = useLayoutOps(snapshot?.layout ?? null);
  const [opener, setOpener] = useState<{ id: string; trigger: HTMLElement; keyboard: boolean } | null>(null);
  const workspace = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [previewSlot, setPreviewSlot] = useState<HTMLDivElement | null>(null);
  const [pinnedPreview, setPinnedPreview] = useState<string | null>(null);
  const [boardPins, setBoardPins] = useState(readBoardPreviews);
  const [boardSession, setBoardSession] = useState<string | null>(() => {
    const pin = boardPins.find(p => p.open === true);
    if (!pin) return null;
    restoreBoardPage(pin);
    return pin.session;
  });
  const [boardSlot, setBoardSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => { writeBoardPreviews(boardPins, boardSession); }, [boardPins, boardSession]);
  const savedZones = useMemo(() => new Set(boardPins.map(p => p.zone)), [boardPins]);
  // The sessions whose preview the owner opened (the header's toggle, ⇧⌘P), for this run of the app.
  // Every other session's preview starts collapsed.
  const [previewOpen, setPreviewOpen] = useState<ReadonlySet<string>>(() => new Set());
  const choosePreview = useCallback((session: string, open: boolean) => setPreviewOpen(prev => {
    if (prev.has(session) === open) return prev;
    const next = new Set(prev);
    if (open) next.add(session); else next.delete(session);
    return next;
  }), []);
  const [previewSelection, setPreviewSelection] = useState<ToolSelection>(null);
  const view = usePanZoom(workspace);
  usePreviewZoom(workspace, view);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    let paintedStep = 0;
    return view.watch(({ x, y, k }) => {
      const step = GRID * k * (k < 0.5 ? 2 : 1);
      // Pinching between raster sizes scales the existing texture. A smaller base tile
      // keeps the layer covering the viewport, with at most 9% magnification of a dot.
      if (step < paintedStep || step >= paintedStep * 2 ** (1 / 8)) {
        paintedStep = GRID * 2 ** (Math.floor(Math.log2(step / GRID) * 8) / 8);
        el.style.backgroundSize = `${paintedStep}px ${paintedStep}px`;
      }
      const scale = step / paintedStep;
      const offset = (v: number) => ((v + 9 * k + 1 - scale) % step + step) % step - step;
      el.style.transform = `translate(${offset(x)}px, ${offset(y)}px) scale(${scale})`;
    });
  }, [view.watch]);
  const [request, setRequest] = useState<ViewRequest | null>(null);
  // Zone ids present when the owner asked for a new zone; the first custom zone not among them is it.
  const [zonesBeforeCreate, setZonesBeforeCreate] = useState<Set<string> | null>(null);
  // The New session dialog (with the folder it opened on) and the profile page, each mounted only while open.
  const [newSession, setNewSession] = useState<{ cwd: string | null; after?: { id: string; name: string } } | null>(null);
  const [noteAppearance, setNoteAppearance] = useState(readNoteAppearance);
  const [profileOpen, setProfileOpen] = useState(false);
  // The zone whose project explorer is docked left of the canvas, if any.
  const [explorerId, setExplorerId] = useState<string | null>(null);
  /** Closes the explorer; focus inside it goes back to its zone's Files button. */
  const closeExplorer = useCallback(() => {
    const inside = document.activeElement instanceof Element && document.activeElement.closest('.explorer, .ex-viewer') !== null;
    if (inside && explorerId !== null) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-zone-id="${CSS.escape(explorerId)}"] .zone-files`)?.focus({ preventScroll: true }));
    }
    setExplorerId(null);
  }, [explorerId]);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const accounts = useAccounts(profileOpen || permissionsOpen);
  // A session just started here: its chat opens before its card reaches the snapshot.
  const [startedId, setStartedId] = useState<string | null>(null);
  // Every open starts as the panel; Full screen lasts while the chat moves between sessions.
  const [mode, setMode] = useState<ChatMode>('panel');
  const [panelWidth, setPanelWidth] = useState<number | null>(loadPanelWidth);
  // The zones the last tidy moved, while it can still be undone.
  const [tidied, setTidied] = useState<ZoneMove[] | null>(null);
  useEffect(() => {
    if (tidied === null) return;
    const timer = setTimeout(() => setTidied(null), TIDY_UNDO_MS);
    return () => clearTimeout(timer);
  }, [tidied]);
  // Undo reads the layout of the moment, so a zone dragged after the tidy keeps its new place.
  const latest = useRef({ layout, tidied });
  latest.current = { layout, tidied };
  const undoTidy = useCallback(() => {
    const { layout: now, tidied: moves } = latest.current;
    if (moves === null || now === null) return;
    latest.current.tidied = null;   // a second ⌘Z before the next render does nothing
    setTidied(null);
    for (const op of undoOps(moves, now)) send(op).catch(() => {});
    setRequest({ kind: 'fit' });
  }, [send]);

  // What the search box finds while a query is typed: lit on the canvas, the rest dimmed.
  const [searchHits, setSearchHits] = useState<SearchHits | null>(null);
  const rawSessions = snapshot?.sessions;
  const sessions = useMemo(() => rawSessions ? sortCards(rawSessions) : null, [rawSessions]);
  const planned = useMemo(() => plannedCards(snapshot?.runs), [snapshot?.runs]);
  const boardSessions = useMemo(() => sessions && planned.length ? [...sessions, ...planned] : sessions, [sessions, planned]);
  const planId = selectedId && isPlanId(selectedId) ? selectedId : null;
  const openPlan = planId ? snapshot?.runs?.find(r => r.id === runOfPlan(planId)) : undefined;
  const planOpen = !!planId && (!!openPlan || startedId === planId);
  const waiting = sessions?.filter((s) => s.state === 'needs_you').length ?? 0;
  const selected = sessions?.find((s) => s.id === selectedId) ?? null;
  const projectIds = useMemo(() => new Set(Object.values(snapshot?.projectChats ?? {})), [snapshot?.projectChats]);
  const isProjectChat = selectedId !== null && projectIds.has(selectedId);
  const inLog = snapshot?.activityLog?.some(entry => entry.sessionId === selectedId);
  const chatId = selected?.id ?? (selectedId !== null && ((!planId && selectedId === startedId) || isProjectChat || inLog) ? selectedId : null);
  // The canvas agent's panel: open through its own place in the hash, showing the agent's
  // conversation or (before the first message, or after "New conversation") its empty state.
  const agent = snapshot?.agent ?? null;
  const agentOpen = snapshot !== null && selectedId === AGENT_ID;
  const [agentPanel, setAgentPanel] = useState(AGENT_PANEL);
  const agentId = agentOpen ? agentChatId(agentPanel, agent) : null;
  useEffect(() => { if (!agentOpen) setAgentPanel(afterClose); }, [agentOpen]);
  const startAgent = useCallback(async (text: string, images: ImageRef[]) => {
    setAgentPanel(afterStart(await agentBridge.start(text, images)));
  }, []);
  // Images on the board (web/src/board): free, or kept in a zone, which then stays drawn.
  const board = useBoardItems({ layout, send, workspace, view, search: searchHits });
  // The owner's notes (web/src/notes), placed as images are; a zone holding one stays drawn too.
  const notes = useBoardNotes({ layout, send, workspace, view, search: searchHits });
  const newZoneAt = useNewZoneAt({ layout, send, workspace, view });
  const threads = snapshot?.openThreads;
  const keptZones = useMemo(() => {
    const ids = new Set([...savedZones, ...board.zoneIds, ...notes.zoneIds]);
    const folders = new Set(threads?.map((t) => t.folder));
    for (const zone of layout?.zones ?? []) if (zone.folder !== null && folders.has(zone.folder)) ids.add(zone.id);
    return ids;
  }, [savedZones, board.zoneIds, notes.zoneIds, layout?.zones, threads]);
  const groups = useMemo(() => boardSessions && layout ? zonesWithCards(boardSessions, layout, keptZones) : [], [boardSessions, layout, keptZones]);
  // Cards keep their slots in their zones (web/src/canvas/cardSlots.ts): nothing re-sorts them.
  const keep = useMemo(() => {
    const ids = new Set(threads?.map((t) => t.sessionId));
    if (selectedId !== null) ids.add(selectedId);
    return ids;
  }, [threads, selectedId]);
  const cardSlots = useCardSlots({ groups, layout, send, now, keep });
  // The zone whose cards the last Tidy re-ordered, while it can still be undone.
  const [cardTidy, setCardTidy] = useState<CardTidy | null>(null);
  useEffect(() => {
    if (cardTidy === null) return;
    const timer = setTimeout(() => setCardTidy(null), TIDY_UNDO_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      if (isTyping(e.target) || inChat(e.target) || (e.target instanceof Element && e.target.closest('dialog'))) return;
      e.preventDefault();
      setCardTidy(null);
      cardSlots.undo(cardTidy);
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [cardTidy, cardSlots.undo]);
  const tidyZoneCards = (zoneId: string) => {
    const t = cardSlots.tidy(zoneId);
    if (t === null) return;
    setTidied(null);
    setCardTidy(t);
  };
  const zones = groups.map((g) => g.zone);
  const draftZone = selectedId?.startsWith('@project:') ? zones.find(z => projectDraftId(z.id) === selectedId && z.kind === 'folder') : undefined;
  const draftCwd = draftZone ? draftZone.path ?? zoneFolder(draftZone, sessions ?? []) : null;
  const projectDraftOpen = !!draftCwd;
  const agentInfo = useAgentInfo(agentOpen || projectDraftOpen);
  // Removed folder zones that are off the canvas now (the search box finds only what is on it).
  const removedZones = layout?.zones.filter((z) => z.kind === 'folder' && z.hiddenAt !== undefined && !zones.some((s) => s.id === z.id)) ?? [];

  useEffect(() => {
    document.title = pageTitle(waiting, connected);
  }, [waiting, connected]);

  // Opening a chat or going back to the canvas is a history step, so the mouse's Back and Forward
  // buttons walk it. A chat that is gone (or a malformed hash) is corrected in place, not added.
  const loaded = snapshot !== null;
  useEffect(() => {
    if (!loaded) return;
    const hash = hashFor(agentOpen || projectDraftOpen || planOpen ? selectedId : chatId);
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', urlWithHash(hash));
  }, [loaded, chatId, agentOpen, projectDraftOpen, planOpen, selectedId]);

  // Opening a finished session is seeing it: its "Done" clears. One that finishes while its chat
  // is open counts too, but only once the window is in front, so work done in the background
  // still announces itself. The clear waits until the chat is left (closed, or another opened) or
  // the canvas beside it is pressed, so the card does not re-sort or move while it is being read.
  // Approvals, questions and terminal prompts stay until answered.
  const shownSession = selected ?? (agent !== null && agent.id === agentId ? agent : null);
  const doneOpen = shownSession !== null && isDone(shownSession) ? shownSession.id : null;
  // The finished session whose Done clears when its chat is left (read when focus returns on close).
  const clearing = useRef<string | null>(null);
  useEffect(() => {
    if (doneOpen === null) return;
    let seen = false;
    // The Done is cleared already: the chat can stay open without the card announcing itself again.
    let checked = false;
    const look = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      seen = true;
      clearing.current = doneOpen;
    };
    look();
    // Turning back to the canvas with the chat still open is seeing it too: the press checks the
    // Done off, so the card is free to leave the queue and take its place among the quiet ones.
    // The clear waits for the release, so a card picked up to be moved does not re-sort mid-drag.
    const el = workspace.current;
    const check = () => {
      window.removeEventListener('pointerup', check);
      window.removeEventListener('pointercancel', check);
      if (checked) return;
      checked = true;
      markSeen([doneOpen]).catch(() => {});
    };
    const onPress = (e: PointerEvent) => {
      if (e.button !== 0 || checked) return;
      // Reading this session's own preview, on the board or beside it, is not turning away from it.
      if (e.target instanceof Element && e.target.closest('.board-preview, .preview-window, .log-button')) return;
      // The card this press lands on is the return target, as it is when the chat closes.
      clearing.current = doneOpen;
      window.addEventListener('pointerup', check, { once: true });
      window.addEventListener('pointercancel', check, { once: true });
    };
    el?.addEventListener('pointerdown', onPress, true);
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    return () => {
      el?.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('pointerup', check);
      window.removeEventListener('pointercancel', check);
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
      if (clearing.current === doneOpen) clearing.current = null;
      if (seen && !checked) markSeen([doneOpen]).catch(() => {});
    };
  }, [doneOpen]);

  /** Shows a chat (or the canvas with null). */
  const show = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);
  const go = useCallback((id: string | null) => {
    const hash = hashFor(id);
    if (window.location.hash !== hash) window.history.pushState({ depth: historyDepth(window.history.state) + 1 }, '', urlWithHash(hash));
    show(id);
  }, [show]);

  useEffect(() => {
    const onPop = () => show(idFromHash(window.location.hash));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [show]);

  // Replace the unsent chat's history entry with its durable provider id. A late reply
  // must never reopen a chat the owner has already left.
  const enterLiveChat = useCallback((id: string) => {
    if (!selectedId || idFromHash(window.location.hash) !== selectedId) return;
    window.history.replaceState(window.history.state, '', urlWithHash(hashFor(id)));
    setStartedId(id);
    setOpener(old => old?.id === selectedId ? { ...old, id } : old);
    show(id);
  }, [selectedId, show]);

  useEffect(() => {
    if (!draftCwd) return;
    let live = true;
    newSessionBridge.projectChat(draftCwd).then(id => {
      if (live && id) enterLiveChat(id);
    }).catch(() => {}); // The first send reports an unavailable folder in the composer.
    return () => { live = false; };
  }, [draftCwd, enterLiveChat]);

  // The canvas agent's open_session: what the search box's jump does, a click on the card plus the
  // view travelling to it. The panel's mode is kept, as when a chat moves between sessions.
  useEffect(() => agentBridge.onOpenSession((id) => { go(id); setRequest({ kind: 'card', id }); }), [go]);

  // A zone the owner just created is shown as soon as it arrives.
  useEffect(() => {
    if (!zonesBeforeCreate || !layout) return;
    const created = layout.zones.find((z) => z.kind === 'custom' && !zonesBeforeCreate.has(z.id));
    if (!created) return;
    setZonesBeforeCreate(null);
    setRequest({ kind: 'zone', id: created.id });
  }, [layout, zonesBeforeCreate]);

  useEffect(() => {
    if (openPlan?.startedId) enterLiveChat(openPlan.startedId);
    else if (openPlan && startedId === planId) setStartedId(null);
  }, [openPlan, planId, startedId, enterLiveChat]);

  const chatOpen = chatId !== null || agentOpen || projectDraftOpen || planOpen;
  // The agent's chat is the panel only, whatever layout the last card's chat was left in.
  const full = chatId !== null && !agentOpen && mode === 'full';
  // However the chat closed (Esc, ×, Back, its session gone), the next one opens as the panel.
  useEffect(() => { if (!chatOpen) setMode('panel'); }, [chatOpen]);
  // The panel's entrance plays when the panel opens (or comes back from full screen), not when
  // one chat takes another's place in it. The agent's panel arrives as its orb instead.
  const panelArriving = useArriving(chatOpen && !full, PANEL_ENTER_MS);
  const morph = useOrbFlight(agentOpen, chatOpen);
  useLayoutEffect(() => {
    if (chatOpen || !opener) return;
    // A finished reply leaves the queue as its chat closes. Its canvas card is still a return target.
    const target = opener.trigger.isConnected && clearing.current !== opener.id ? opener.trigger
      : workspace.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(opener.id)}"]`);
    (target ?? document.querySelector<HTMLElement>('button.jump'))?.focus({ preventScroll: true });
    setOpener(null);
  }, [chatOpen, opener]);
  // Closing is a history step back to the canvas, as opening is one; panel ↔ full screen never is.
  const closeChat = useCallback(() => { go(null); setMode('panel'); }, [go]);
  // Open threads: notes beside the chats that left a question open, dragged into a chat or onto a zone.
  const openThreadCard = useCallback((id: string) => { go(id); setRequest({ kind: 'card', id }); }, [go]);
  const openThreadAgent = useCallback(() => { setAgentPanel(AGENT_PANEL); setMode('panel'); go(AGENT_ID); }, [go]);
  const enterThreadSession = useCallback((id: string) => { setStartedId(id); setMode('panel'); go(id); }, [go]);
  const openThreads = useOpenThreads({
    threads, sessions: sessions ?? undefined, layout: layout ?? undefined, groups, now,
    agentSessionId: agent?.id ?? null,
    openChatId: agentOpen ? agentId : chatId,
    openCard: openThreadCard, openAgent: openThreadAgent, onStarted: enterThreadSession,
  });
  const zoneItems = useMemo(() => {
    const merged = new Map<string, ReturnType<typeof board.zoneItems>>();
    return (zone: ZoneLayout) => {
      let items = merged.get(zone.id);
      if (!items) {
        items = [...board.zoneItems(zone.id), ...notes.zoneItems(zone.id), ...openThreads.zoneItems(zone.id)];
        merged.set(zone.id, items);
      }
      return items;
    };
  }, [board.zoneItems, notes.zoneItems, openThreads.zoneItems]);
  /** The orb, or ⌘J: opens the agent's panel (focus goes back to the orb when it closes), or closes it. */
  const toggleAgent = useCallback((keyboard: boolean) => {
    if (agentOpen) { closeChat(); return; }
    const trigger = document.querySelector<HTMLElement>('button.agent-btn');
    if (trigger) setOpener({ id: AGENT_ID, trigger, keyboard });
    setMode('panel');
    go(AGENT_ID);
  }, [agentOpen, closeChat, go]);

  // ⌘N starts a session anywhere, and ⌘J opens or closes the canvas agent. Esc steps back: full screen → panel → canvas. F fits while
  // the canvas is in view, unless the key was pressed in the panel. Fields, open menus, a focused
  // approval card and an open dialog handle their own keys first.
  const modalOpen = newSession !== null || profileOpen || permissionsOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || modalOpen || (e.target instanceof Element && e.target.closest('dialog'))) return;
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setNewSession({ cwd: null });
        return;
      }
      if (isAgentShortcut(e)) {
        e.preventDefault();
        toggleAgent(true);
        return;
      }
      if (tidied !== null && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z'
        && !isTyping(e.target) && !inChat(e.target)) {
        e.preventDefault();
        undoTidy();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'Escape' && document.querySelector('[popover]:popover-open')) return;
      if (explorerId !== null && !chatOpen && e.key === 'Escape') {
        e.preventDefault();
        closeExplorer();
        return;
      }
      if (chatOpen && e.key === 'Escape') {
        e.preventDefault();
        if (full) setMode('panel'); else closeChat();
        return;
      }
      if (full || inChat(e.target)) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setRequest({ kind: 'fit' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatOpen, full, modalOpen, closeChat, toggleAgent, tidied, undoTidy, explorerId, closeExplorer]);

  const boardPin = boardPins.find(p => p.session === boardSession && zones.some(z => z.id === p.zone));
  const shownBoardPin = full && chatId !== boardPin?.session ? undefined : boardPin;
  const pinned = shownBoardPin?.session ?? pinnedPreview;
  // The chat's own preview shows while its slot is there and the chat wants it: full screen, or
  // opened with its toggle. Checked here too because the slot is the last chat's for one render
  // after a switch, and a collapsed chat's preview mounting even then would empty the live page.
  const previewId = pinned ?? (previewSlot && chatId !== null && (full || previewOpen.has(chatId)) ? chatId : null);
  const previewSession = sessions?.find(s => s.id === previewId);
  const openBoardPreview = (pin: BoardPreview) => {
    restoreBoardPage(pin);
    setPinnedPreview(null);
    setBoardSession(pin.session);
    setMode('panel');
  };
  const saveBoardPreview = (pin: BoardPreview) => {
    setBoardPins(prev => [...prev.filter(p => p.session !== pin.session), pin]);
    openBoardPreview(pin);
    setRequest({ kind: 'zone', id: pin.zone });
  };
  const resizePanel = (w: number | null, done: boolean) => {
    setPanelWidth(w);
    if (done) savePanelWidth(w);
  };

  // The mouse's Back and Forward buttons step through the chats opened, as in a browser. The press
  // is swallowed too, so nothing under the pointer takes it as a click. An open dialog keeps its place.
  useEffect(() => {
    const swallow = (e: MouseEvent) => { if (historyStep(e.button) !== null) e.preventDefault(); };
    const onUp = (e: MouseEvent) => {
      const step = historyStep(e.button);
      if (step === null) return;
      e.preventDefault();
      if (modalOpen) return;
      // Back from a chat with no earlier step here (the window opened on it) closes the chat.
      if (step < 0 && chatOpen && historyDepth(window.history.state) === 0) closeChat();
      else if (step < 0) window.history.back(); else window.history.forward();
    };
    window.addEventListener('mousedown', swallow);
    window.addEventListener('auxclick', swallow);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousedown', swallow);
      window.removeEventListener('auxclick', swallow);
      window.removeEventListener('mouseup', onUp);
    };
  }, [modalOpen, chatOpen, closeChat]);

  const selectFromCanvas = (id: string, trigger: HTMLElement, keyboard: boolean) => {
    setOpener({ id, trigger, keyboard });
    go(id);
  };
  /** A new session in a zone's folder (its "+", or the rail filtered to it), or in the latest folder. */
  // The project explorer: one zone's folder at a time; its Files button again, Esc or × closes it.
  const explorerZone = explorerId !== null ? zones.find((z) => z.id === explorerId) : undefined;
  const explorerRoot = explorerZone && sessions ? zoneFolder(explorerZone, sessions) : null;
  const toggleExplorer = (zone: ZoneLayout) => setExplorerId((id) => (id === zone.id ? null : zone.id));
  const startIn = (zone: ZoneLayout | null) => setNewSession({ cwd: zone && sessions ? zoneFolder(zone, sessions) : null });

  // The preview leaves as the panel does: it stays for its exit, with the props it closed with.
  const preview = useLingering(previewId && workspace.current && area.current ? (
    <PreviewWorkspace
      key={previewId} session={previewId} title={previewSession ? titleOf(previewSession) : boardPin?.title ?? 'Preview'}
      boardPin={shownBoardPin} boardSlot={shownBoardPin ? boardSlot : null} zones={zones} onAddToBoard={saveBoardPreview}
      onBoardSize={size => setBoardPins(prev => prev.map(p => p.session === previewId ? { ...p, ...size } : p))}
      onBoardSlot={(zone, col, top) => setBoardPins(prev => prev.map(p => p.session === previewId ? { ...p, zone, col, top } : p))}
      onBoardAddress={address => setBoardPins(prev => prev.map(p => p.session === previewId ? { ...p, address } : p))}
      onBoardTab={tab => setBoardPins(prev => prev.map(p => p.session === previewId ? { ...p, tab } : p))}
      workspace={workspace.current} area={area.current} fullSlot={full ? previewSlot : null}
      view={view} selection={previewSelection} onSelect={setPreviewSelection}
      onPlace={() => { setBoardSession(null); setPinnedPreview(previewId); setMode('panel'); }}
      onHide={() => { setBoardSession(null); setPinnedPreview(null); choosePreview(previewId, false); }}
    />
  ) : null, PANEL_EXIT_MS);
  const previewArriving = useArriving(previewId !== null, PANEL_ENTER_MS);
  const explorerArriving = useArriving(!!(explorerZone && explorerRoot), PANEL_ENTER_MS);
  // A board tile that is leaving keeps its place in the zone until it has gone.
  const leavingTile = preview?.props.closing && preview.props.boardPin ? preview.props.boardPin.session : null;

  // The chat sits in the page's grid beside the canvas (as the panel) or over everything (full
  // screen); either way it stays this element's child, so changing layout never remounts it.
  const appClass = `app${connected ? '' : ' is-stale'}${chatOpen ? ' has-panel' : ''}${full ? ' is-under' : ''}${panelArriving ? ' is-panel-opening' : ''}${previewArriving ? ' is-preview-opening' : ''}${explorerArriving ? ' is-explorer-opening' : ''}`;
  const morphBox = morph && { '--morph-x': `${morph.box.x}px`, '--morph-y': `${morph.box.y}px`, '--morph-w': `${morph.box.width}px`, '--morph-h': `${morph.box.height}px` };
  return (<>
    <div className={appClass} data-note-appearance={noteAppearance} data-morph={morph?.phase} style={{ '--panel-w': panelWidthCss(panelWidth), ...morphBox } as CSSProperties}>
      <div className="app-under" inert={full} aria-hidden={full || undefined}>
        <TopBar
          projectIds={projectIds}
          active={!full}
          total={sessions?.length ?? null}
          working={sessions?.filter((s) => s.state === 'working').length ?? 0}
          waiting={waiting}
          connected={connected}
          groups={groups}
          onJump={(id) => { go(id); setRequest({ kind: 'card', id }); }}
          onSearchHits={setSearchHits}
          zones={zones}
          onCentreZone={(id) => setRequest({ kind: 'zone', id })}
          boardItems={board.items}
          notes={notes.notes}
          onCentreItem={(id) => setRequest({ kind: 'item', id })}
          onCreateZone={(name) => {
            setZonesBeforeCreate(new Set(layout?.zones.map((z) => z.id) ?? []));
            send({ type: 'createZone', name }).catch(() => setZonesBeforeCreate(null));
          }}
          removedZones={removedZones}
          onDeleteZone={(id) => {
            const custom = layout?.zones.find((z) => z.id === id)?.kind === 'custom';
            send(custom ? { type: 'deleteZone', id } : { type: 'hideZone', id, at: Date.now() }).catch(() => {});
          }}
          onRestoreZone={(id) => { send({ type: 'hideZone', id, at: null }).catch(() => {}); }}
          onMarkAllSeen={() => { markSeen(replyIds(sessions ?? [])).catch(() => {}); }}
          onTidy={() => setRequest({ kind: 'tidy' })}
          view={view}
          onResetZoom={() => view.zoomTo(1)}
          onFit={() => setRequest({ kind: 'fit' })}
          onNewSession={() => startIn(null)}
          accounts={accounts.accounts}
          onProfile={() => setProfileOpen(true)}
          limit={activeLimit(agent ? [...(sessions ?? []), agent] : sessions ?? [], Math.max(now, Date.now()))}
          now={Math.max(now, Date.now())}
        />
        {/* A session that needs the owner shows here; its card stays where it is. Opening it is
            the canvas agent's open_session: the chat, and the view travelling to the card. */}
        <Briefing sessions={sessions} now={now} connected={connected}
          onSelect={(id, trigger, keyboard) => { selectFromCanvas(id, trigger, keyboard); setRequest({ kind: 'card', id, focus: false }); }} />
        <div className="canvas-area" ref={area}>
          <Lingering ms={PANEL_EXIT_MS}>
            {explorerZone && explorerRoot && <Explorer key={explorerRoot} zone={explorerZone} root={explorerRoot} onClose={closeExplorer}
              onOpenChat={id => { setStartedId(id); setMode('panel'); go(id); }} />}
          </Lingering>
          <main
          ref={workspace}
          className="workspace"
          aria-label="Canvas"
          // The board moves by transform only; a focused card must not scroll the workspace itself.
          onScroll={(e) => e.currentTarget.scrollTo(0, 0)}
        >
            <div ref={grid} className="workspace-grid" aria-hidden="true" />
            {snapshot && sessions && layout && (
              <Canvas
                groups={groups}
                sessions={boardSessions ?? sessions}
                layout={layout}
                selectedId={selectedId}
                now={now}
                onSelect={selectFromCanvas}
                onLayoutOp={send}
                onNewSession={startIn}
                onNewLinkedSession={(from, zoneId) => {
                  const source = sessions.find(s => s.id === from);
                  if (!source) return;
                  const zone = groups.find(g => g.zone.id === zoneId)?.zone;
                  const cwd = (zone && zoneFolder(zone, sessions)) || source.cwd || null;
                  setNewSession({ cwd, after: { id: from, name: titleOf(source) } });
                }}
                onExplore={toggleExplorer}
                exploringId={explorerZone && explorerRoot ? explorerZone.id : null}
                boardPreviews={zone => boardPins.filter(p => p.zone === zone.id && p.session !== boardPin?.session && p.session !== leavingTile).map(pin => (
                  <div className="board-preview" key={pin.session} data-no-pan="">
                    <BoardPreviewRow title={pin.title} onOpen={() => openBoardPreview(pin)}
                      onRemove={() => setBoardPins(prev => prev.filter(p => p.session !== pin.session))} />
                  </div>
                ))}
                // The open preview (or one playing its exit) takes a slot among the cards.
                boardTile={zone => {
                  const pin = boardPins.find(p => p.zone === zone.id && (p.session === boardPin?.session || p.session === leavingTile));
                  return pin ? { col: pin.col, top: pin.top, width: pin.width, height: pin.height, node: <div ref={setBoardSlot} data-no-pan="" /> } : null;
                }}
                projectChats={snapshot.projectChats}
                runs={snapshot.runs}
                view={view}
                request={request}
                onRequestDone={() => setRequest(null)}
                generatedAt={snapshot.generatedAt}
                onTidied={(moves) => { setCardTidy(null); setTidied(moves); }}
                cardSlots={cardSlots.shown}
                onTidyZone={tidyZoneCards}
                onPlaceCard={cardSlots.move}
                search={searchHits}
                zoneItems={zoneItems}
                freeItems={board.freeItems || notes.freeItems || openThreads.freeItems ? <>{board.freeItems}{notes.freeItems}{openThreads.freeItems}</> : null}
                dropZone={board.dropZone}
              />
            )}
            <ActivityLogMenu
              entries={snapshot?.activityLog ?? []}
              onOpen={(id, trigger, keyboard) => {
                const target = id === agent?.id ? AGENT_ID : id;
                if (target === AGENT_ID) setAgentPanel(AGENT_PANEL);
                setMode('panel');
                selectFromCanvas(target, trigger, keyboard);
                if (target !== AGENT_ID) setRequest({ kind: 'card', id, focus: false });
              }}
            />
            <AgentButton orb={orbState(agent, connected)} open={agentOpen} onToggle={toggleAgent} />
            {board.overlay}
            {notes.overlay}
            <BoardMenu workspace={workspace} enabled={!full && !modalOpen} onNewNote={notes.createAt} onNewZone={newZoneAt} onNewSession={() => startIn(null)} />
            {tidied !== null && (
              <UndoToast message="Canvas tidied" onUndo={undoTidy} onDismiss={() => setTidied(null)} />
            )}
            {cardTidy !== null && (
              <UndoToast message={`${zones.find((z) => z.id === cardTidy.zoneId)?.name ?? 'Zone'} tidied`}
                onUndo={() => { setCardTidy(null); cardSlots.undo(cardTidy); }} onDismiss={() => setCardTidy(null)} />
            )}
        </main>
          {openThreads.toast}
        </div>
      </div>
      {/* One panel at a time; the one that closes stays for its exit (docs/motion.md). */}
      <Lingering ms={PANEL_EXIT_MS}>
      {openPlan && <PlannedChat run={openPlan} onClose={closeChat} width={panelWidth} onResize={resizePanel} />}
      {draftZone && draftCwd && (
        <AgentStart key={draftCwd} project={draftZone} info={agentInfo}
          onStart={async (text, images) => enterLiveChat(await newSessionBridge.projectTask(draftCwd, text, images))}
          onClose={closeChat} panelWidth={panelWidth} onPanelResize={resizePanel} />
      )}
      {agentOpen && agentId === null && (
        <AgentStart
          info={agentInfo}
          onStart={startAgent}
          onResume={agent !== null ? () => setAgentPanel(AGENT_PANEL) : undefined}
          onClose={closeChat}
          panelWidth={panelWidth}
          onPanelResize={resizePanel}
        />
      )}
      {agentId !== null && snapshot && sessions && layout && (
        <ChatScreen
          sessionId={agentId}
          fill={openThreads.fill?.sessionId === agentId ? openThreads.fill : null}
          agent={{ session: agent, info: agentInfo, onNewConversation: () => setAgentPanel(newConversation()) }}
          mode="panel"
          onMode={setMode}
          panelWidth={panelWidth}
          onPanelResize={resizePanel}
          sessions={sessions}
          layout={layout}
          banners={snapshot.banners}
          now={now}
          onOpen={go}
          onBack={closeChat}
          onNewSession={startIn}
          accounts={accounts.accounts}
          onProfile={() => setProfileOpen(true)}
        />
      )}
      {chatId !== null && !agentOpen && snapshot && sessions && layout && (
        <ChatScreen
          sessionId={chatId}
          fill={openThreads.fill?.sessionId === chatId ? openThreads.fill : null}
          projectIds={projectIds}
          preview={{
            slot: setPreviewSlot, pinned, chosen: previewOpen.has(chatId),
            onToggle: (open) => { setBoardSession(null); setPinnedPreview(null); choosePreview(chatId, open); },
            selection: previewSelection, onSelect: setPreviewSelection,
          }}
          focusHeading={opener?.keyboard && opener.id === chatId ? opener : null}
          mode={mode}
          onMode={setMode}
          panelWidth={panelWidth}
          onPanelResize={resizePanel}
          sessions={sessions}
          layout={layout}
          banners={snapshot.banners}
          now={now}
          onOpen={go}
          onBack={closeChat}
          onNewSession={startIn}
          accounts={accounts.accounts}
          onProfile={() => setProfileOpen(true)}
        />
      )}
      </Lingering>
      {preview}
    </div>
    {newSession !== null && sessions && layout && (
      <NewSessionDialog
        sessions={sessions}
        layout={layout}
        cwd={newSession.cwd}
        after={newSession.after}
        onClose={() => setNewSession(null)}
        onStarted={(cardId) => { setNewSession(null); setStartedId(cardId); setMode('panel'); go(cardId); }}
      />
    )}
    {profileOpen && <ProfilePage onPermissions={() => setPermissionsOpen(true)} data={accounts} noteAppearance={noteAppearance}
      onNoteAppearanceChange={(value) => { setNoteAppearance(value); saveNoteAppearance(value); }} onClose={() => setProfileOpen(false)}
      canOpenChat={(id) => snapshot?.sessions.some((s) => s.id === id) ?? false}
      onOpenChat={(id) => { go(id); setRequest({ kind: 'card', id }); }} />}
    <PermissionsSheet accounts={accounts.accounts} open={permissionsOpen} setOpen={setPermissionsOpen}
      blocked={profileOpen || newSession !== null || !connected} />
  </>);
}
