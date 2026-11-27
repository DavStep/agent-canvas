import { Creature } from '../creature/Creature.tsx';
// One open chat, in either of two layouts. As a panel docked right of the canvas: a compact
// header (title, meta, actions, Close, Full screen) over the conversation and its composer. Full
// screen: the title bar, the rail of sessions, the conversation, and the preview (Live work and
// Browser) on the right, with the rail and the preview resizable. The conversation is the same
// element in both, so switching keeps the open chat and the composer's draft. App handles Esc:
// full screen → panel → canvas.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import type { AccountsView } from '../../../shared/account.ts';
import { busyElsewhere, type ProviderBanner } from '../../../shared/banners.ts';
import type { ChatItem, ChatState, Provider } from '../../../shared/chat.ts';
import type { Layout, SessionView, ZoneLayout } from '../../../shared/types.ts';
import { dismissInterruption, openExternal, showHost } from '../bridge.ts';
import { continuePrompt, isInterrupted } from '../../../shared/interruption.ts';
import { InterruptionBanner } from './InterruptionBanner.tsx';
import { AGENT_TITLE, agentMeta, type AgentInfo } from '../agent/agent.ts';
import { AgentOrb } from '../agent/AgentOrb.tsx';
import { titleOf } from '../briefing.ts';
import { usePreviewActivity, type ToolSelection } from '../preview/PreviewWorkspace.tsx';
import { MediaSession } from './ChatMedia.tsx';
import { Avatar } from '../profile/ProfilePage.tsx';
import { resumeCommand } from '../resume.ts';
import { Composer } from './Composer.tsx';
import { alongsideText, hostMeta, moveHereTip, readOnlyPlaceholder, readOnlyText, showLabel, terminalNote } from './host.ts';
import { PanelEdge } from './PanelEdge.tsx';
import { usePanelWidths } from './panelWidths.ts';
import { Rail } from './Rail.tsx';
import { ResizeHandle } from './ResizeHandle.tsx';
import { Thread } from './Thread.tsx';
import { chatBlocks, useChat } from './useChat.ts';
import { modelLabel } from '../../../shared/modelLabel.ts';

export const PLUGIN_NOTE = "Desktop-app plugins aren't loaded here";
const NO_ITEMS: ChatItem[] = [];
const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };
const OWNER_WORD = { here: 'here', nobody: 'not open' } as const;

/** The provider's desktop-app link for a session, as the canvas detail panel had it. */
export function openUrlFor(s: Pick<SessionView, 'provider' | 'hostId'>): string | null {
  // An ACP agent has no desktop app to hand the session to.
  if (s.hostId === null || s.provider === 'acp') return null;
  const id = encodeURIComponent(s.hostId);
  return s.provider === 'codex' ? `codex://threads/${id}` : `claude://code/continue?session=${id}`;
}

/** The header's model: the chat's own when open (its menu names aliases), else the card's. */
function headerModel(state: ChatState | null, session: SessionView | undefined | null): string | null {
  const label = state && state.model !== null
    ? modelLabel(state.provider, state.model, state.effort ?? session?.effort, { models: state.models })
    : session ? modelLabel(session.provider, session.model, session.effort) : '';
  return label === '' ? null : label;
}

/** "Show in Terminal": main brings the app the session runs in to the front. */
function ShowInButton({ sessionId, label }: { sessionId: string; label: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [sessionId]);
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => setFailed(false), 1600);
    return () => clearTimeout(t);
  }, [failed]);
  return (
    <button type="button" className="cs-act" onClick={() => { showHost(sessionId).catch(() => setFailed(true)); }}>
      {failed ? 'Could not show it' : label}
    </button>
  );
}

function HeaderActions({ session }: { session: SessionView }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => { setCopied('idle'); }, [session.id]);
  useEffect(() => {
    if (copied === 'idle') return;
    const t = setTimeout(() => setCopied('idle'), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const url = openUrlFor(session);
  const show = session.owner === 'elsewhere' ? showLabel(session.host) : null;
  const copy = () => {
    navigator.clipboard.writeText(resumeCommand(session)).then(() => setCopied('done'), () => setCopied('failed'));
  };
  return (
    <div className="cs-actions">
      {show !== null && <ShowInButton sessionId={session.id} label={show} />}
      {url !== null && (
        // The app hands the link to macOS; the page itself never navigates away.
        <a className="cs-act" href={url} onClick={(e) => { e.preventDefault(); openExternal(url).catch(() => {}); }}>
          Open in {session.provider === 'acp' ? session.acp?.name : PROVIDER_NAME[session.provider]}
        </a>
      )}
      {session.provider !== 'acp' && <button type="button" className="cs-act" onClick={copy}>
        {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy resume command'}
      </button>}
    </div>
  );
}

export type ChatMode = 'panel' | 'full';

const ExpandIcon = () => (
  <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>
);
const CollapseIcon = () => (
  <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14" /></svg>
);
const CloseIcon = () => (
  <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
);
/** A window with a pane at its side: the preview that opens beside the chat. */
const PreviewIcon = () => (
  <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M7 2.5v11" /></svg>
);

/** ⇧⌘P shows or hides the open chat's preview, from anywhere on the page (a message field too). */
export function isPreviewShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'p';
}
export const NO_PREVIEW_TIP = 'No preview yet: it appears once this chat runs a command or opens a page';

/** The header's preview toggle: pressed while this chat's preview is open; dimmed, and still
    focusable with its reason, while the chat has nothing to show yet. */
function PreviewToggle({ open, available, onToggle }: { open: boolean; available: boolean; onToggle(open: boolean): void }) {
  const off = !open && !available;
  return (
    <button type="button" className="cs-icon cs-preview-toggle" aria-label="Preview" aria-pressed={open} aria-disabled={off || undefined}
      aria-keyshortcuts="Shift+Meta+P" title={off ? NO_PREVIEW_TIP : `${open ? 'Hide' : 'Show'} preview (⇧⌘P)`}
      onClick={() => { if (!off) onToggle(!open); }}>
      <PreviewIcon />
    </button>
  );
}

/** The docked panel's header: the title with Close (and Full screen, when the chat has one), then
    the meta line and the actions. The canvas agent's empty state wears it too. */
export function PanelHeader({ heading, title, mark, meta, actions, tools, onClose, onFull }: {
  heading?: Ref<HTMLHeadingElement>;
  title: string;
  /** Drawn before the title (the agent's orb). */
  mark?: ReactNode;
  meta: ReactNode;
  actions?: ReactNode;
  /** Icon buttons before Close (the preview toggle). */
  tools?: ReactNode;
  onClose(): void;
  onFull?(): void;
}) {
  return (
    <header className="cs-bar">
      <div className="cs-panel-row">
        <div className="cs-heading">{mark}<h1 ref={heading} tabIndex={-1} title={title}>{title}</h1></div>
        <div className="cs-window">
          {tools}
          <button type="button" className="cs-icon" aria-label="Close chat" title="Close" onClick={onClose}><CloseIcon /></button>
          {onFull && <button type="button" className="cs-icon" aria-label="Full screen" title="Full screen" onClick={onFull}><ExpandIcon /></button>}
        </div>
      </div>
      <div className="cs-panel-row">
        <div className="cs-meta">{meta}</div>
        {actions}
      </div>
    </header>
  );
}

/** The meta line's parts, with dots between them. */
export function MetaLine({ parts }: { parts: string[] }) {
  return <>{parts.map((m, i) => <span key={i}>{i > 0 && <span className="sep">·</span>}{m}</span>)}</>;
}

/** What makes an open chat the canvas agent's: its session (kept out of `sessions`), what it is
    connected to, and "New conversation". Its chat is the panel only: the full screen's rail and
    preview belong to a project's session. */
export interface AgentChat {
  session: SessionView | null;
  info: AgentInfo | null;
  onNewConversation(): void;
}

export interface ChatScreenProps {
  /** Set when the chat is the canvas agent's rather than a card's. */
  agent?: AgentChat;
  projectIds?: ReadonlySet<string>;
  preview?: {
    slot(el: HTMLDivElement | null): void;
    /** The owner opened this chat's preview (collapsed until they do). */
    chosen: boolean;
    pinned: string | null;
    /** The header's toggle: open shows this chat's preview beside it, closed hides it. */
    onToggle(open: boolean): void;
    selection: ToolSelection;
    onSelect(value: ToolSelection): void;
  };
  /** A fresh request when the chat is opened from a keyboard-focused canvas control. */
  focusHeading?: { id: string } | null;
  sessionId: string;
  /** Docked right of the canvas, or the whole window. */
  mode: ChatMode;
  onMode(mode: ChatMode): void;
  /** The panel's width the owner dragged it to, or null for the default. */
  panelWidth: number | null;
  onPanelResize(width: number | null, done: boolean): void;
  /** Every session, in card order. */
  sessions: SessionView[];
  layout: Layout;
  banners: Record<Provider, ProviderBanner | null>;
  now: number;
  onOpen(id: string): void;
  /** Closes the chat: "Back to canvas" in full screen, × in the panel. */
  onBack(): void;
  onNewSession(zone: ZoneLayout | null): void;
  /** For the avatar's initial. */
  accounts: AccountsView | null;
  onProfile(): void;
  /** Closed already and only playing its exit (useLingering): unreachable, and marked for motion.css. */
  closing?: boolean;
  /** A text for the composer (an open thread dropped on this chat); a new object fills again. */
  fill?: { text: string; append?: boolean } | null;
}

export function ChatScreen({
  sessionId, agent, projectIds, preview, focusHeading, mode, onMode, panelWidth, onPanelResize, sessions, layout, banners, now, onOpen, onBack, onNewSession, accounts, onProfile, closing, fill,
}: ChatScreenProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (focusHeading) heading.current?.focus({ preventScroll: true });
  }, [focusHeading]);
  const projectOrchestrator = projectIds?.has(sessionId);
  const chat = useChat(sessionId);
  const { state } = chat;
  const panels = usePanelWidths();
  const columns = { '--rail-w': `${panels.widths.rail}px`, '--preview-w': `${panels.widths.preview}px` } as CSSProperties;
  const session = agent ? (agent.session?.id === sessionId ? agent.session : null) : sessions.find((s) => s.id === sessionId) ?? null;
  // The tool call the owner picked, in the thread or in Live work. Until then (and after "Follow
  // newest") Live work follows the turn's newest call; the thread marks only a picked one.
  const picked = preview?.selection;
  const follow = picked?.session !== sessionId;
  const selectedTool = follow ? null : picked.id;
  const [moveNote, setMoveNote] = useState<string | null>(null);
  useEffect(() => { setMoveNote(null); }, [sessionId]);
  // Continue sent for this interruption (its `at`): hidden until the snapshot shows the new turn.
  const [continued, setContinued] = useState<number | null>(null);
  // Aborted just now: a short-lived Undo in its place.
  const [aborted, setAborted] = useState<string | null>(null);
  useEffect(() => { setContinued(null); setAborted(null); }, [sessionId]);
  useEffect(() => {
    if (aborted === null) return;
    const t = setTimeout(() => setAborted(null), 8000);
    return () => clearTimeout(t);
  }, [aborted]);
  const pick = (id: string) => preview?.onSelect({ session: sessionId, id });

  const provider = state?.provider ?? session?.provider ?? 'claude';
  const busyThere = busyElsewhere(session);
  const blocks = state ? chatBlocks(state, state.apiKeyAuth || provider === 'acp' ? null : banners[provider], busyThere) : null;
  const acp = state?.acp ?? session?.acp;
  const providerName = provider === 'acp' ? acp?.name ?? 'ACP agent' : PROVIDER_NAME[provider];
  const alongside = blocks !== null && blocks.readOnly && blocks.blocked === null && provider === 'claude';
  const queuesInCodex = provider === 'codex' && blocks?.readOnly === true;
  const owner = state?.owner ?? session?.owner ?? 'nobody';
  const title = agent ? AGENT_TITLE : state && state.title.trim() !== '' ? state.title : session ? titleOf(session) : 'Untitled session';
  const model = headerModel(state, session);
  const folder = session ? (session.folder === '' ? 'No folder' : session.folder) : state?.cwd ?? '';
  const pending = state?.items.some((i) => i.kind === 'approval' && i.status === 'pending') ?? false;
  // The turn was cut off (a limit, an error, its process ending) and nothing has resumed it yet:
  // a card's chat and the canvas agent's alike.
  const interruption = session?.interruption && isInterrupted(session) && state?.turn !== 'running'
    && continued !== session.interruption.at ? session.interruption : null;
  const canMove = session?.owner === 'nobody';
  const host = session?.host ?? null;
  const show = owner === 'elsewhere' ? showLabel(host) : null;
  const emptyNote = session?.need === 'terminal' ? (
    <>
      <p>{terminalNote(host)}</p>
      {show !== null && <ShowInButton sessionId={sessionId} label={show} />}
    </>
  ) : undefined;

  const moveHere = () => {
    setMoveNote(null);
    chat.moveHere().then((ok) => { if (!ok) setMoveNote(host?.app ? `Still open in ${host.app}` : 'Still open in the other app'); },
      (err: unknown) => setMoveNote(err instanceof Error ? err.message : String(err)));
  };

  const full = mode === 'full' && !agent;
  const items = state?.items ?? NO_ITEMS;
  const { calls, localUrl } = usePreviewActivity(sessionId, items);
  const active = session?.state === 'working' || state?.turn === 'running';
  const portraitState = session?.state === 'needs_you' ? (session.need === 'reply' ? 'done' : 'needs_you') : active ? 'working' : 'idle';
  const otherPreview = !!preview?.pinned && preview.pinned !== sessionId;
  // Collapsed until the owner opens it with the header's toggle (or ⇧⌘P).
  const dockOpen = !agent && !otherPreview && (preview?.pinned === sessionId || preview?.chosen === true);
  // Something to show: a page, a capture, or work in this turn.
  const hasPreview = active || !!localUrl || !!state?.browserCapture || calls.length > 0;
  const toggle = !full && !agent && preview ? preview.onToggle : null;
  const latestToggle = useRef({ toggle, dockOpen, hasPreview });
  latestToggle.current = { toggle, dockOpen, hasPreview };
  useEffect(() => {
    if (closing || !toggle) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPreviewShortcut(e) || (e.target instanceof Element && e.target.closest('dialog'))) return;
      e.preventDefault();
      const now = latestToggle.current;
      if (now.toggle && (now.dockOpen || now.hasPreview)) now.toggle(!now.dockOpen);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closing, toggle === null]);
  const connection = state?.provider === 'codex' ? 'codex-api' : state?.apiKeyAuth ? 'claude-api' : 'claude-login';
  const metaParts = agent ? <MetaLine parts={agentMeta(agent.info, connection)} /> : (
    <>
      <MetaLine parts={[folder, providerName, model, owner === 'elsewhere' ? hostMeta(host) : OWNER_WORD[owner]].filter((m): m is string => m !== null && m !== '')} />
      {session?.ownerNote && <span className="quiet"><span className="sep">·</span>{session.ownerNote}</span>}
      {provider === 'claude' && owner === 'here' && <span className="quiet"><span className="sep">·</span>{PLUGIN_NOTE}</span>}
    </>
  );

  // Children keep their places in both layouts (the rail and the preview leave holes), so React
  // keeps the conversation and its composer when the layout changes.
  return (
    <MediaSession.Provider value={sessionId}><div className={`chat-screen ${full ? 'is-full' : 'is-panel'}${agent ? ' is-agent' : ''}${closing ? ' is-closing' : ''}`} style={full ? columns : undefined} aria-label={full ? undefined : 'Chat panel'} role={full ? undefined : 'complementary'} inert={closing} aria-hidden={closing || undefined}>
      {full ? (
        <header className="cs-bar">
          <button type="button" className="cs-back" aria-label="Back to canvas" onClick={onBack}>
            <svg className="i" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
            Canvas
          </button>
          <div className="cs-heading">{projectOrchestrator && <Creature provider="orchestrator" state={portraitState} size={24} />}<div className="cs-heading-col">
            <h1 ref={heading} tabIndex={-1} title={title}>{title}</h1>
            <div className="cs-meta">{metaParts}</div>
          </div></div>
          <div className="cs-account">
            {session && <HeaderActions session={session} />}
            <Avatar accounts={accounts} onOpen={onProfile} />
            <button type="button" className="cs-icon" aria-label="Exit full screen" title="Exit full screen" onClick={() => onMode('panel')}>
              <CollapseIcon />
            </button>
          </div>
        </header>
      ) : (
        <PanelHeader
          key={sessionId}
          heading={heading}
          title={title}
          mark={projectOrchestrator ? <Creature provider="orchestrator" state={portraitState} size={24} /> : agent && <AgentOrb kind="idle" size={18} />}
          meta={metaParts}
          actions={agent ? (
            <div className="cs-actions">
              <button type="button" className="cs-act" data-testid="agent-new" onClick={agent.onNewConversation}>New conversation</button>
            </div>
          ) : session && <HeaderActions session={session} />}
          tools={toggle && <PreviewToggle open={dockOpen} available={hasPreview} onToggle={toggle} />}
          onClose={onBack}
          onFull={agent ? undefined : () => onMode('full')}
        />
      )}

      {full && <Rail projectIds={projectIds} sessions={sessions} layout={layout} currentId={sessionId} now={now} onOpen={onOpen} onNewSession={onNewSession} />}

      {full && <ResizeHandle panel="rail" width={panels.widths.rail} onResize={panels.set} />}

      {/* Keyed by the chat: another chat in the same panel is a new conversation swapping in
          (motion.css), while panel ↔ full screen keeps this one, its thread and its draft. */}
      <section className="desk" key={`desk-${sessionId}`} aria-label="Chat">
        {chat.error !== null ? (
          <p className="desk-note" role="alert">Could not open this chat: {chat.error}</p>
        ) : state === null || blocks === null ? (
          <p className="desk-note">Opening…</p>
        ) : (
          <>
            <Thread
              key={`thread-${sessionId}`}
              sessionId={sessionId}
              provider={provider}
              acp={acp}
              projectOrchestrator={projectOrchestrator}
              creatureState={session?.state ?? 'idle'}
              items={state.items}
              hasOlder={state.hasOlder}
              now={now}
              resting={state.turn === 'idle' && session?.state !== 'working'}
              pickedTool={follow ? null : selectedTool}
              onSelectTool={pick}
              onLoadOlder={chat.loadOlder}
              onAnswerApproval={chat.answerApproval}
              onAnswerQuestion={chat.answerQuestion}
              emptyNote={emptyNote}
              interruption={interruption}
              footer={interruption ? (
                <InterruptionBanner
                  key={interruption.at}
                  interruption={interruption}
                  now={now}
                  blocked={blocks.blocked}
                  onContinue={async () => {
                    await chat.send(continuePrompt(interruption), []);
                    setContinued(interruption.at);
                  }}
                  onAbort={async () => {
                    await dismissInterruption(sessionId);
                    setAborted(sessionId);
                  }}
                />
              ) : aborted === sessionId ? (
                <div className="cs-banner is-dismissed" role="status">
                  <span>Interruption dismissed. Nothing was sent.</span>
                  <button type="button" className="t-btn outline" onClick={() => {
                    setAborted(null);
                    dismissInterruption(sessionId, true).catch(() => {});
                  }}>Undo</button>
                </div>
              ) : null}
            />
            {alongside && (
              <div className="cs-banner is-alongside" role="status"><span>{alongsideText(host)}</span></div>
            )}
            {blocks.readOnly && !alongside && (
              <div className="cs-banner is-readonly" role="status">
                <span>{queuesInCodex ? 'Open in another app. Send here to queue a message in Codex.' : readOnlyText(host)}{session?.ownerNote ? ` · ${session.ownerNote}` : ''}</span>
                {moveNote !== null && <span className="note">{moveNote}</span>}
                <button type="button" className="t-btn outline" disabled={!canMove} onClick={moveHere}
                  title={canMove ? undefined : moveHereTip(host)}>Move here</button>
              </div>
            )}
            {blocks.provider !== null && <div className="cs-banner is-provider" role="alert"><span>{blocks.provider}</span></div>}
            {blocks.warning !== null && <div className="cs-banner is-warning" role="status"><span>{blocks.warning}</span></div>}
            <Composer
              key={sessionId}
              provider={provider}
              name={projectOrchestrator ? 'the project orchestrator' : agent ? 'the canvas agent' : acp?.name}
              models={state.models}
              effort={state.effort}
              model={state.model}
              modes={state.modes}
              mode={state.mode}
              running={state.turn === 'running' && !blocks.readOnly}
              queueInCodex={queuesInCodex}
              blocked={blocks.blocked}
              offHint={blocks.readOnly && !alongside && !queuesInCodex ? readOnlyPlaceholder(host) : undefined}
              autoFocus={!pending && !focusHeading && !interruption}
              onSend={chat.send}
              onStop={chat.interrupt}
              onModel={chat.setModel}
              onMode={chat.setMode}
              fill={fill}
            />
          </>
        )}
      </section>

      {full && <ResizeHandle panel="preview" width={panels.widths.preview} onResize={panels.set} />}

      {(full || dockOpen) && <div className="preview-slot" ref={preview?.slot} />}
      {!full && <PanelEdge width={panelWidth} onResize={onPanelResize} />}
    </div></MediaSession.Provider>
  );
}
