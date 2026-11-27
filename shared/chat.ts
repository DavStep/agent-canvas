// The chat model shared by the main process and the page: items, state and the updates between them.
import type { AcpBadge } from './acp.ts';
import type { ChatMedia } from './chatMedia.ts';
/** The built-in providers: their own accounts, keys, defaults and session files. */
export type Provider = 'claude' | 'codex';
/** Who runs a session: a built-in provider, or an ACP agent the owner configured (docs/acp.md),
    named by the session's `acp` badge. */
export type SessionProvider = Provider | 'acp';
export type Owner = 'here' | 'elsewhere' | 'nobody';
export type ToolKind = 'command' | 'edit' | 'read' | 'search' | 'web' | 'mcp' | 'other';
export interface FileDiff { path: string; unified: string; added: number; removed: number }
export interface ImageRef { mime: string; dataUrl: string }
export type ChatItem =
  | { kind: 'user'; id: string; at: number; text: string; images: ImageRef[]; queued?: boolean }
  | { kind: 'assistant'; id: string; at: number; text: string; streaming: boolean; commentary?: boolean }
  | { kind: 'reasoning'; id: string; at: number; text: string; streaming: boolean; durationMs: number | null }
  | { kind: 'tool'; id: string; at: number; tool: ToolKind; name: string; target: string;
      status: 'running' | 'waiting' | 'done' | 'failed' | 'denied';
      output: string | null; exitCode: number | null; diffs: FileDiff[];
      /** Characters the 256 KB cap has dropped from the front of this `output` (absent: none).
          Where what streamed has got to is then outputDropped + the kept part's length. An
          output that replaces another (rather than being appended to) starts counting afresh. */
      outputDropped?: number;
      media?: ChatMedia[];
      /** Provider-supplied action label. The original command/arguments stay in target. */
      action?: { name: string; target: string }; }
  | { kind: 'approval'; id: string; at: number; toolItemId: string | null; title: string; detail: string;
      alwaysLabel: string | null; status: 'pending' | 'allowed' | 'allowedAlways' | 'denied' | 'expired' }
  | { kind: 'question'; id: string; at: number; questions: Question[];
      status: 'pending' | 'answered' | 'expired'; answers: Record<string, string> | null }
  | { kind: 'notice'; id: string; at: number; level: 'info' | 'warn' | 'error'; text: string };
export interface Question {
  id: string; header: string; text: string; options: { label: string; description: string }[]; multiSelect: boolean; allowOther: boolean;
  /** A password-like answer (Codex `isSecret`): typed masked, never shown or kept in the thread. */
  isSecret?: boolean;
}
export type ApprovalAnswer = 'allow' | 'allowAlways' | 'deny';
export interface ModelOption {
  id: string; label: string; isDefault: boolean;
  /** The thinking (reasoning effort) levels the model takes, lowest first; absent or empty: none to pick. */
  efforts?: string[];
  /** The level the provider uses when none is picked, when it says (Codex does; Claude does not). */
  defaultEffort?: string | null;
}

/** How a thinking level reads in a picker. */
export function effortLabel(effort: string): string {
  const known: Record<string, string> = {
    none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
  };
  return known[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}
export interface ModeOption { id: string; label: string }
export interface ChatState {
  /** This conversation authenticates independently of the provider login shown on the canvas. */
  apiKeyAuth?: boolean;
  sessionId: string; provider: SessionProvider; owner: Owner; title: string; cwd: string;
  /** The ACP agent running this chat (provider 'acp'). */
  acp?: AcpBadge;
  items: ChatItem[]; hasOlder: boolean; turn: 'idle' | 'running';
  browserCapture?: { id: string; src: string } | null;
  plan?: { step: string; status: 'pending' | 'inProgress' | 'completed' }[];
  model: string | null; effort?: string | null; models: ModelOption[]; mode: string; modes: ModeOption[];
  banner: string | null;          // e.g. signed out, read-only reason
}
export type ChatUpdate =
  | { op: 'reset'; state: ChatState }
  | { op: 'upsert'; item: ChatItem }                       // insert or replace by id
  | { op: 'append'; id: string; field: 'text' | 'output'; chunk: string }
  | { op: 'older'; items: ChatItem[]; hasOlder: boolean }   // prepend a page
  | { op: 'meta'; patch: Partial<Omit<ChatState, 'items'>> };
