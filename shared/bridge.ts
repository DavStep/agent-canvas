// The page's only way into the main process: exposed as `window.canvas` by electron/preload.cts.
import type { AcpAgentConfig, AcpAgentView } from './acp.ts';
import type { AgentConnection } from './agentConnection.ts';
import type { AccountsView } from './account.ts';
import type { ApprovalAnswer, ChatState, ChatUpdate, ImageRef, ModelOption, ModeOption, Provider, SessionProvider } from './chat.ts';
import type { DirListing, FilePreview } from './files.ts';
import type { LayoutOp, Snapshot } from './types.ts';
import type { NoteImage } from './boardNotes.ts';
import type { RunOp } from './runs.ts';
import type { ThreadOp } from './threads.ts';
import type { UsagePeriod, UsageSummary } from './usage.ts';

/** `effort`: the thinking level, or null for the model's own default. `agent`: the ACP agent's
    id, for provider 'acp' (absent otherwise). */
export interface NewSessionRequest {
  provider: SessionProvider; cwd: string; model: string | null; effort: string | null; mode: string | null; text: string; images: ImageRef[];
  agent?: string;
}
/** What the New session dialog offers for a provider before any chat exists, with its defaults
    (the owner's saved ones from Settings, where the provider still offers them). */
export interface ProviderOptions { models: ModelOption[]; model: string | null; effort: string | null; modes: ModeOption[]; mode: string }
/** A provider's model and thinking level for new sessions; null: the provider's own default. */
export interface SessionDefaults { model: string | null; effort: string | null }
export interface AppSettings {
  agentConnection: AgentConnection;
  agentKeys: Record<Provider, boolean>;
  openAtLogin: boolean;
  defaults: Record<Provider, SessionDefaults>;
  /** The models each provider's model menus list (ids); null: all of them. */
  shownModels: Record<Provider, string[] | null>;
  modelPermissions?: import("./modelPolicy.ts").ModelPermissions;
  availableModelProfiles?: Partial<Record<Provider, string[]>>;
  /** The ACP agents configured, with what was found on this Mac (docs/acp.md). */
  acpAgents: AcpAgentView[];
  /** The known ACP agents Settings offers to add, likewise checked. */
  acpPresets: AcpAgentView[];
  /** When a usage limit that cut sessions off resets: ask (the default), or continue them automatically. */
  limitReset?: 'ask' | 'continue';
}
/** What setSettings changes: only the parts given. */
export interface SettingsPatch {
  agentConnection?: AgentConnection;
  agentKey?: { provider: Provider; key: string };
  openAtLogin?: boolean;
  defaults?: Partial<Record<Provider, SessionDefaults>>;
  shownModels?: Partial<Record<Provider, string[] | null>>;
  modelPermissions?: import("./modelPolicy.ts").ModelPermissions;
  /** The whole list of ACP agents, replacing the saved one. */
  acpAgents?: AcpAgentConfig[];
  limitReset?: 'ask' | 'continue';
}
export interface CanvasBridge {
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  layoutOp(op: LayoutOp): Promise<void>;
  markSeen(ids: string[]): Promise<void>;
  /** Abort on an interrupted session: it becomes a normal card and stays so; `undo` brings it back. */
  dismissInterruption(sessionId: string, undo?: boolean): Promise<void>;
  openChat(sessionId: string): Promise<ChatState>;
  onChat(sessionId: string, cb: (u: ChatUpdate) => void): () => void;
  closeChat(sessionId: string): void;
  loadOlder(sessionId: string): Promise<void>;
  send(sessionId: string, text: string, images: ImageRef[]): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  answerApproval(sessionId: string, approvalId: string, answer: ApprovalAnswer): Promise<void>;
  answerQuestion(sessionId: string, questionId: string, answers: Record<string, string>): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  setMode(sessionId: string, mode: string): Promise<void>;
  moveHere(sessionId: string): Promise<boolean>;
  projectChat(cwd: string): Promise<string | null>;
  projectTask(cwd: string, text: string, images: ImageRef[]): Promise<string>;
  newSession(req: NewSessionRequest, after?: string): Promise<string>; // the new card's id, planned while waiting
  /** Whether the canvas agent can run, and what it is connected to. */
  agentInfo(): Promise<{ connection: AgentConnection; available: boolean; reason: string | null }>;
  /** The first message of a new conversation with the canvas agent: starts its session and returns the card id (later messages use send()). */
  startAgent(text: string, images: ImageRef[]): Promise<string>;
  /** The canvas agent's open_session: open this card as a click on it does, and travel to it. */
  onOpenSession(cb: (sessionId: string) => void): () => void;
  accounts(): Promise<AccountsView>;
  /** A provider's usage changed (a rate limit event): the profile page may ask accounts() again. */
  onAccountsChanged(cb: () => void): () => void;
  /** The provider's models and permission modes for a new session (for 'acp': the agent's, by id). */
  options(provider: SessionProvider, agent?: string): Promise<ProviderOptions>;
  /** The system folder picker, over the main window: the folder chosen, or null. */
  pickFolder(): Promise<string | null>;
  preview(cmd: PreviewCommand): Promise<PreviewState>;
  /** The preview's state whenever it changes on its own (a link followed, a load finished). */
  onPreview(cb: (s: PreviewState) => void): () => void;
  /** A zoom gesture or zoom key over the preview's page, for the canvas (the page never zooms itself). */
  onPreviewZoom(cb: (z: PreviewZoom) => void): () => void;
  openExternal(url: string): Promise<void>;                 // http(s), claude://, codex://, vscode://file/<absolute path>
  /** Whether a VS Code is registered for vscode:// links ("Open in editor"). */
  canOpenInEditor(): Promise<boolean>;
  getSettings(): Promise<AppSettings>;
  /** "Show in Terminal" (iTerm, VS Code…): brings the app a session owned elsewhere runs in to
      the front. Main finds the session's process and the app from the card id alone. */
  showHost(sessionId: string): Promise<void>;
  setSettings(s: SettingsPatch): Promise<void>;
  /** "Show in Finder" for a file sent with a message: selects it in a Finder window. */
  revealFile(path: string): Promise<void>;
  gitStatus(root: string): Promise<import('./projectGit.ts').GitStatus>;
  gitDiff(root: string, file: string): Promise<string>;
  gitAction(root: string, action: import('./projectGit.ts').GitAction): Promise<void>;
  /** The project explorer: one directory of a zone's folder (`root`, one the canvas shows), by a
      path relative to it ('' for the folder itself). Read-only, and confined to the folder. */
  listFiles(root: string, dir: string): Promise<DirListing>;
  /** The project explorer's preview of one file in a zone's folder, confined as listFiles is. */
  previewFile(root: string, file: string): Promise<FilePreview>;
  /** Keeps a copy of an image dropped or pasted on the board (its bytes), or fetched once from a
      dropped web address, in the app's data folder; answers with the copy's file name. */
  importBoardImage(source: BoardImageImport): Promise<{ file: string; name: string; mime: string }>;
  /** A board image as a chat takes one (PNG, JPEG, GIF or WebP up to 5 MB, resized if need be). */
  boardChatImage(itemId: string): Promise<{ name: string; mime: string; data: Uint8Array }>;
  /** Keeps a copy of a picture dropped, pasted or picked into a note (its bytes) in the app's
      data folder; answers with the picture, for the note's next editNote op. */
  importNoteImage(name: string, data: Uint8Array): Promise<NoteImage>;
  /** A note's picture as a chat takes one (a note dragged into a message). */
  noteChatImage(noteId: string, imageId: string): Promise<{ name: string; mime: string; data: Uint8Array }>;
  /** Whether the system clipboard holds an image now (the board menu's "Paste image as note"). */
  clipboardHasImage(): Promise<boolean>;
  /** The clipboard's image kept as a note picture, or null when it holds none. */
  importClipboardImage(): Promise<NoteImage | null>;
  /** Links between sessions and their queued prompts ("B runs after A", shared/runs.ts); a refused
      change (a loop, a missing prompt) rejects with the reason. */
  runOp(op: RunOp): Promise<void>;
  /** An open-threads ticket dismissed, restored (the undo) or marked done (shared/threads.ts). */
  threadOp(op: ThreadOp): Promise<void>;
  /** Settings → Usage: the tokens the canvas agent and orchestrators used against the work, for a period. */
  usage(period: UsagePeriod): Promise<UsageSummary>;
  /** What macOS has allowed the app (shared/permissions.ts), read without making macOS ask. */
  permissions(): Promise<import('./permissions.ts').PermissionsView>;
  /** The permissions sheet's button: a test notification (macOS asks on the first one), or the
      permission's System Settings pane when macOS will not ask again. Answers the state after. */
  askPermission(kind: import('./permissions.ts').PermissionKind): Promise<import('./permissions.ts').PermissionsView>;
}
export type BoardImageImport = { kind: 'bytes'; name: string; data: Uint8Array } | { kind: 'url'; url: string };
/** A dropped, pasted or picked file's path on disk ('' when it has none, like a pasted
    screenshot): `window.canvasFiles`, synchronous, read in the preload. */
export interface CanvasFiles { pathForFile(file: File): string }
export interface PreviewRect { x: number; y: number; width: number; height: number }
export type PreviewCommand =
  | { kind: 'show'; bounds: PreviewRect | null; clip?: PreviewRect; zoom?: number }
  // `typed`: the owner typed the address. Otherwise only http://localhost:<port> and
  // http://127.0.0.1:<port> open (the main process decides).
  // `fresh`: a switch to another session's page; it opens in a new view (no history), hidden until its first load stops.
  | { kind: 'navigate'; url: string; typed: boolean; fresh?: boolean } | { kind: 'back' } | { kind: 'reload' }
  // Empties the pane (the view is closed; the next page gets a new one) when the chat moves to a session with no page.
  | { kind: 'clear' };
export interface PreviewState { url: string | null; canGoBack: boolean; loading: boolean; error: string | null }
/** Zoom over the preview's page, in the canvas page's CSS pixels (client coordinates): a ⌘/Ctrl
    wheel or a pinch at a point, or ⌘= / ⌘- / ⌘0 with the page focused (at the page's middle). */
export type PreviewZoom =
  | { kind: 'wheel'; x: number; y: number; dx: number; dy: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
  | { kind: 'key'; key: 'in' | 'out' | 'reset'; x: number; y: number };
