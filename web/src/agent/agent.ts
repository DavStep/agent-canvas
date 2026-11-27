// The canvas agent's page-side rules: what its orb says for each state, which conversation its
// panel shows, the example prompts of its empty state, and its shortcut. The agent is a
// session the app runs above every zone; it is never a card, so the page keeps its place here.
import { AGENT_CONNECTIONS, type AgentConnection } from '../../../shared/agentConnection.ts';
import type { CanvasBridge } from '../../../shared/bridge.ts';
import type { SessionView } from '../../../shared/types.ts';

/** What agentInfo() answers: whether the agent can run, and why not. */
export type AgentInfo = Awaited<ReturnType<CanvasBridge['agentInfo']>>;

/** The agent panel's place in the URL hash and the page's history. No session id starts with "@". */
export const AGENT_ID = '@agent';
/** An address for the pinned project chat before the provider gives it a session id. */
export const projectDraftId = (zoneId: string) => `@project:${zoneId}`;
export const AGENT_TITLE = 'Canvas agent';

export type OrbKind = 'idle' | 'working' | 'needs' | 'done';
export interface OrbState {
  kind: OrbKind;
  /** The word beside the orb. */
  label: string;
  /** The button's accessible name: the agent and its state. */
  name: string;
}

const ORB: Record<OrbKind, OrbState> = {
  idle: { kind: 'idle', label: 'Agent', name: AGENT_TITLE },
  working: { kind: 'working', label: 'Working', name: `${AGENT_TITLE}, working` },
  needs: { kind: 'needs', label: 'Needs you', name: `${AGENT_TITLE}, needs you` },
  done: { kind: 'done', label: 'Replied', name: `${AGENT_TITLE}, replied` },
};

/** The orb for the agent's session: quiet before its first message and while the reader is
    unreachable; amber only when it is stopped on the owner (an approval or a question), and
    "Replied" when it has finished and its chat has not been opened since. */
export function orbState(agent: Pick<SessionView, 'state' | 'need'> | null | undefined, connected = true): OrbState {
  if (!agent || !connected) return ORB.idle;
  if (agent.state === 'working') return ORB.working;
  if (agent.state === 'needs_you') return agent.need === 'reply' ? ORB.done : ORB.needs;
  return ORB.idle;
}

/** The page's own part of the agent panel: `fresh` after "New conversation" (the empty state is
    shown over the conversation there is), and the session the last first message started, which
    is known before the snapshot shows it. */
export interface AgentPanelState { fresh: boolean; startedId: string | null }
export const AGENT_PANEL: AgentPanelState = { fresh: false, startedId: null };

/** The chat the agent panel shows, or null for the empty state (no conversation yet, or a new one asked for). */
export function agentChatId(panel: AgentPanelState, agent: Pick<SessionView, 'id'> | null | undefined): string | null {
  if (panel.fresh) return null;
  return panel.startedId ?? agent?.id ?? null;
}

/** After the first message of a conversation went through: the panel shows the session it started. */
export const afterStart = (id: string): AgentPanelState => ({ fresh: false, startedId: id });
/** "New conversation": the empty state, whose send starts another session. */
export const newConversation = (): AgentPanelState => ({ fresh: true, startedId: null });
/** The panel closed: a new conversation that was never started is forgotten. */
export const afterClose = (panel: AgentPanelState): AgentPanelState => (panel.fresh ? { ...panel, fresh: false } : panel);

/** Why the agent cannot be sent to, or null. Not knowing yet blocks nothing: a send that cannot
    go through says so itself. */
export function agentBlocked(info: AgentInfo | null): string | null {
  if (info === null || info.available) return null;
  return info.reason ?? 'The canvas agent is not available right now.';
}

/** The current conversation's connection, or the selected connection on the start screen. */
export function agentMeta(info: AgentInfo | null, connection: AgentConnection | undefined = info?.connection): string[] {
  return connection ? [AGENT_CONNECTIONS[connection]] : [];
}

export const AGENT_LEAD = 'One agent for the whole canvas. It makes zones, finds folders on this Mac, starts sessions and reports on what is running.';

/** The empty state's examples. A chip puts its text in the message field; nothing is sent. */
export const AGENT_PROMPTS: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'What needs me right now?', text: 'What needs me right now?' },
  { label: 'Give me a report by zone', text: 'Give me a report by zone' },
  { label: 'Find my garden-sim folder and make a zone', text: 'Find my garden-sim folder and make a zone' },
  { label: 'Start a task in agent-canvas to …', text: 'Start a task in agent-canvas to ' },
];

/** ⌘J opens and closes the agent from anywhere on the page, a message field included. */
export function isAgentShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j';
}
