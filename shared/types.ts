import type { OpenThread } from './threads.ts';
import type { ZoneIcon } from './zoneAppearance.ts';
import type { ProviderBanner } from './banners.ts';
import type { AcpBadge } from './acp.ts';
import type { Owner, Provider, SessionProvider } from './chat.ts';
import type { BoardItem, ItemOp } from './boardItems.ts';
import type { NoteItem, NoteOp } from './boardNotes.ts';
import type { RunView } from './runs.ts';
import type { SlotOp, ZoneSlots } from './cardSlots.ts';

export type SessionState = 'working' | 'needs_you' | 'idle' | 'unknown';
/** 'terminal': a CLI sitting on a dialog in its own terminal (a startup or login prompt), with
    no permission or question pending in its transcript. */
export type NeedKind = 'permission' | 'question' | 'reply' | 'terminal' | 'interrupted';
/** Why a session's last turn stopped before it finished, when the owner did not stop it: a usage
    or rate limit, an error (an API or network failure, a crash), or the process gone mid-turn. */
export interface SessionInterruption {
  kind: 'limit' | 'error' | 'killed';
  /** What happened, in the provider's words when it gave some. */
  reason: string;
  /** When it stopped (epoch ms). An Abort dismisses it up to this time. */
  at: number;
  /** When a usage limit resets (epoch ms), when known. */
  resetsAt: number | null;
  /** Ordinary Codex account quota, distinct from transient rate or capacity errors. */
  codexUsage?: 'blocked' | 'available';
}
export interface SubagentView { id: string; type: string; description: string; state: 'working' | 'done' }
/** Where a session another program runs lives, told from `ps` alone (its process's ancestors):
    the app's name ("Terminal", "iTerm", "VS Code", "Claude app"…), or null when none is known;
    the session's tty; and whether "Show in <app>" can bring that app to the front. */
export interface SessionHost { app: string | null; tty: string | null; showable: boolean }
export interface RunStep {
  kind: 'read' | 'search' | 'edit' | 'command' | 'tool';
  label: string;
  status: 'done' | 'failed' | 'running';
  durationMs?: number;
}
export interface SessionView {
  id: string;              // canvas identity, namespaced for Codex
  provider: SessionProvider;
  /** The ACP agent running it (provider 'acp'): the card's badge and creature. */
  acp?: AcpBadge;
  hostId: string | null;   // provider's desktop link target
  name: string;            // '' when the app gave none
  cwd: string;
  folder: string;          // zone key from folderOf(cwd); '' means "No folder"
  state: SessionState;
  need: NeedKind | null;   // non-null exactly when state is 'needs_you'
  /** Set exactly when need is 'interrupted' (shared/interruption.ts). */
  interruption?: SessionInterruption;
  activity: string | null;
  recentSteps?: RunStep[];    // up to two tool calls from the latest turn, oldest first
  rawStatus: string;
  /** Latest completed Claude turn confirmed by its transcript. */
  completedAt?: number;
  stateSince: number;      // epoch ms
  startedAt: number;       // epoch ms
  branch: string | null;
  model: string | null;
  /** The thinking level it runs at, when known (saved chat settings, Codex's thread); absent: unknown. */
  effort?: string | null;
  lastPrompt: string | null;   // at most 2000 chars
  lastAnswer: string | null;   // at most 2000 chars
  subagents: SubagentView[];
  owner: Owner;            // 'elsewhere' for live sessions not run here; 'nobody' for recent idle ones
  ownerNote: string | null;   // e.g. "Released in about a minute" while a session let go here is still held
  host: SessionHost | null;   // set for a Claude session owned elsewhere whose process could be traced
}
export interface ZoneLayout {
  id: string; name: string; kind: 'folder' | 'custom';
  folder: string | null;       // set for kind 'folder'
  x: number | null; y: number | null;   // null until the page places it
  hueIndex: number;            // 0-5 chart tokens in creation order, 6 = quiet grey, never reassigned
  color?: string;              // hex override of the assigned chart color
  icon?: ZoneIcon;             // square on older layouts
  /** A folder zone the owner removed, and when (epoch ms): its sessions stay off the canvas until
      one of them is working, needs the owner, or changes state after this. */
  hiddenAt?: number;
  /** The folder on disk a folder zone stands for, when known (the canvas agent added it, or a task
      was started in it): such a zone is drawn even before any session has run there. */
  path?: string;
}
export interface Layout {
  version: 1; zones: ZoneLayout[]; assignments: Record<string, string>; // sessionId -> zoneId
  /** Images (and other things) kept on the board, free or in a zone (shared/boardItems.ts); absent on older layouts. */
  items?: BoardItem[];
  /** Each zone's card slots, by zone id (shared/cardSlots.ts); absent on older layouts. */
  slots?: Record<string, ZoneSlots>;
  /** The owner's notes, free on the board or in a zone (shared/boardNotes.ts); absent on older layouts. */
  notes?: NoteItem[];
}
export interface ActivityEntry {
  sessionId: string;
  name: string;
  folder: string;
  kind: NeedKind;
  at: number;
  /** Provider state timestamp, which can precede an engine's observed request. */
  sourceAt: number;
}
export interface Snapshot {
  activityLog?: ActivityEntry[];
  generatedAt: number; demo: boolean; sessions: SessionView[]; layout: Layout;
  /** Why a provider's cards cannot work fully now (e.g. "Codex not found", signed out), or null;
      `blocking` tells a reason that stops sending from a warning. */
  banners: Record<Provider, ProviderBanner | null>;
  /** The canvas agent's session, kept out of `sessions`; absent before its first message. */
  agent?: SessionView | null;
  /** Project folder to persistent orchestrator chat, including chats outside the recent session list. */
  projectChats?: Record<string, string>;
  /** Queued runs and the links they wait on ("B runs after A", shared/runs.ts); absent: none. */
  runs?: RunView[];
  /** A project folder's (folder key's) most sessions working at once, where the owner set one. */
  maxRunning?: Record<string, number>;
  /** Questions left open in chats the owner moved on from, newest first (shared/threads.ts); absent: none. */
  openThreads?: OpenThread[];
}
export type LayoutOp =
  | { type: 'moveZone'; id: string; x: number; y: number }
  | { type: 'createZone'; name: string }
  | { type: 'renameZone'; id: string; name: string }
  | { type: 'editZone'; id: string; name: string; color: string; icon: ZoneIcon }
  | { type: 'deleteZone'; id: string }
  /** Removes a folder zone from the canvas at `at` (epoch ms), or brings it back with null. */
  | { type: 'hideZone'; id: string; at: number | null }
  /** A zone for a folder on disk (an absolute path), before any session has run there: creates
      `folder:<name>`, or brings a removed one back, and records the path on it. */
  | { type: 'addFolderZone'; path: string }
  | { type: 'assign'; sessionId: string; zoneId: string | null }
  | ItemOp
  | SlotOp
  | NoteOp;
