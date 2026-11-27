// What a provider's chat engine offers the main process: ChatEngine for any (Claude, Codex and
// ACP agents), Engine for a built-in provider, which also has an account.
import type { ProviderAccount } from '../../shared/account.ts';
import type { NewSessionRequest, ProviderOptions } from '../../shared/bridge.ts';
import type { ApprovalAnswer, ChatState, ChatUpdate, ImageRef, Provider, SessionProvider } from '../../shared/chat.ts';
import type { SessionInterruption, SessionView } from '../../shared/types.ts';

/** What a session this engine runs is doing that the owner should know of: a turn running, or
    an approval or a question waiting on the owner. */
export interface BusySession { sessionId: string; reason: 'turn' | 'approval' | 'question' }

export interface StartOptions {
  title?: string;
  project?: import('../agent/project.ts').ProjectProfile;
}

export interface ChatEngine {
  readonly provider: SessionProvider;
  /** Turns this engine saw cut off (a limit, an error, its process ending) that the owner did not
      stop, by session id. It clears one when a new turn starts there; the store when the owner aborts. */
  readonly interruptions?: Map<string, SessionInterruption>;
  /** Why this provider's cards and chats cannot work fully right now (missing, signed out…), or null. */
  readonly banner: string | null;
  open(sessionId: string, emit: (u: ChatUpdate) => void): Promise<ChatState>;
  close(sessionId: string): void;
  loadOlder(sessionId: string): Promise<void>;
  send(sessionId: string, text: string, images: ImageRef[]): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  answerApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): Promise<void>;
  answerQuestion(sessionId: string, questionId: string, answers: Record<string, string>): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  setModelProfile?(sessionId: string, model: string, effort: string): Promise<void>;
  setMode(sessionId: string, mode: string): Promise<void>;
  moveHere(sessionId: string): Promise<boolean>;
  rename?(sessionId: string, title: string): Promise<void>;
  start(req: NewSessionRequest, options?: StartOptions): Promise<string>;
  /** The models and modes a new session may start with, and the defaults; never starts a session.
      `agent`: the ACP agent's id (the ACP engine runs many agents; the others ignore it). */
  options(agent?: string): Promise<ProviderOptions>;
  /** Another program opened a session this engine may be running or showing: stop this app's own
      process (never the other program's), mark the chat elsewhere with a warning, and refuse
      sends until moveHere() succeeds. A session with no chat open here is ignored. */
  lost(sessionId: string): void;
  owned(): Set<string>;                      // session ids this engine is running now
  /** Of owned(), the sessions the owner chose to write to while another program has them open:
      lost() is not called for them. */
  shared?(): Set<string>;
  /** Owned sessions let go here that the provider's process still holds for a while (Codex keeps a
      closed thread, and its writer lock, until it unloads it about a minute later). */
  releasing(): Set<string>;
  /** For the quit dialog, and the cards' "Needs you" (an approval or question waiting here). */
  busy(): BusySession[];
  stop(): Promise<void>;
  /** The cards of an engine whose sessions no provider file tells of (ACP: only the sessions
      started here, from its own records), by card id. */
  views?(): SessionView[];
}

/** A built-in provider's engine (Claude, Codex): a chat engine with an account. */
export interface Engine extends ChatEngine {
  readonly provider: Provider;
  /** Start of the latest account read that confirmed ordinary Codex usage is available. */
  readonly usageAllowedAt?: number | null;
  account(): Promise<ProviderAccount>;
}
