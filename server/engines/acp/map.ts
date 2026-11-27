// ACP → the app's chat model, kept pure: a session/update becomes ChatUpdates on the chat's items
// (streamed messages and thoughts, tool rows, the plan, modes and models), and a permission
// request becomes an approval card. The engine holds the state; this only says what changes.
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { ChatItem, ChatState, ChatUpdate, FileDiff, ImageRef, ModelOption, ModeOption, ToolKind } from '../../../shared/chat.ts';
import type { RunStep } from '../../../shared/types.ts';
import { fileDiff } from '../diffs.ts';

type Tool = Extract<ChatItem, { kind: 'tool' }>;
type Approval = Extract<ChatItem, { kind: 'approval' }>;

export const toolItemId = (toolCallId: string): string => `tool-${toolCallId}`;

const KINDS: Record<acp.ToolKind, { tool: ToolKind; verb: string }> = {
  read: { tool: 'read', verb: 'Read' },
  edit: { tool: 'edit', verb: 'Edit' },
  delete: { tool: 'edit', verb: 'Delete' },
  move: { tool: 'edit', verb: 'Move' },
  search: { tool: 'search', verb: 'Search' },
  execute: { tool: 'command', verb: 'Run' },
  think: { tool: 'other', verb: 'Think' },
  fetch: { tool: 'web', verb: 'Fetch' },
  switch_mode: { tool: 'other', verb: 'Switch mode' },
  other: { tool: 'other', verb: 'Tool' },
};

export function toolStatus(status: acp.ToolCallStatus | null | undefined, fallback: Tool['status'] = 'running'): Tool['status'] {
  switch (status) {
    case 'pending':
    case 'in_progress': return 'running';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    default: return fallback;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A title as a row target: backticks gone, and a leading verb the row already says dropped
    ("Read src/a.ts" under Read → "src/a.ts"). */
export function targetOf(title: string, verb: string): string {
  const plain = title.replace(/`/g, '').trim();
  const lead = new RegExp(`^${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b:?\\s*`, 'i');
  const rest = plain.replace(lead, '');
  return rest === '' ? plain : rest;
}

/** A path as the chat shows it: relative to the session's folder when inside it. */
export function shownPath(p: string, cwd: string): string {
  if (cwd === '' || !path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

/** One content block as text: text as is, a resource by its text or link, media by its kind. */
export function blockText(block: acp.ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text;
    case 'resource_link': return `[${block.title ?? block.name}](${block.uri})`;
    case 'resource': return 'text' in block.resource ? block.resource.text : `[${block.resource.uri}]`;
    case 'image': return '[image]';
    case 'audio': return '[audio]';
    default: return '';
  }
}

/** The command a tool ran, from its raw input, when the agent gives one. */
function commandOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const c = raw.command ?? raw.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ');
  return null;
}

/** Raw output as text, for a tool that gave no text content: a string, or the usual fields. */
function rawOutputText(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  if (isRecord(raw)) {
    for (const key of ['output', 'stdout', 'formatted_output', 'aggregated_output', 'result', 'content']) {
      const v = raw[key];
      if (typeof v === 'string') return v;
    }
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return null;
  }
}

function exitCodeOf(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  for (const key of ['exit_code', 'exitCode', 'code']) if (typeof raw[key] === 'number') return raw[key];
  return null;
}

/** A tool row after a tool_call (prev absent, or a call announced again) or a tool_call_update.
    Only the fields the update carries change; `content` replaces the row's output and diffs,
    and an embedded terminal is named in `terminals` (the engine streams it into the row). */
export function toolItem(
  prev: Tool | undefined, u: acp.ToolCall | acp.ToolCallUpdate, at: number, cwd: string,
): { item: Tool; terminals: string[] } {
  const kind = u.kind ?? null;
  const known = kind !== null ? KINDS[kind] ?? KINDS.other : null;
  const tool = known?.tool ?? prev?.tool ?? 'other';
  const verb = known?.verb ?? prev?.action?.name ?? (u.name ?? 'Tool');
  const title = u.title ?? null;
  const command = tool === 'command' ? commandOf(u.rawInput) : null;
  const firstPath = u.locations?.[0]?.path ?? null;
  const target = command ?? (title !== null && title !== '' ? title : null) ?? (firstPath !== null ? shownPath(firstPath, cwd) : null) ?? prev?.target ?? '';
  const actionTarget = title !== null && title !== '' ? targetOf(title, verb) : prev?.action?.target ?? target;
  let output = prev?.output ?? null;
  let diffs: FileDiff[] = prev?.diffs ?? [];
  const terminals: string[] = [];
  if (u.content !== undefined && u.content !== null) {
    const texts: string[] = [];
    const nextDiffs: FileDiff[] = [];
    for (const c of u.content) {
      if (c.type === 'content') texts.push(blockText(c.content));
      else if (c.type === 'diff') nextDiffs.push(fileDiff(shownPath(c.path, cwd), c.oldText ?? '', c.newText));
      else if (c.type === 'terminal') terminals.push(c.terminalId);
    }
    diffs = nextDiffs;
    if (texts.length > 0) output = texts.join('\n');
    else if (terminals.length === 0) output = prev?.output ?? null;
  }
  if ((output === null || output === '') && u.rawOutput !== undefined && terminals.length === 0 && diffs.length === 0) {
    output = rawOutputText(u.rawOutput) ?? output;
  }
  const exitCode = exitCodeOf(u.rawOutput) ?? prev?.exitCode ?? null;
  // A row the owner denied stays denied whatever the agent reports next.
  const status = prev?.status === 'denied' ? 'denied' : prev?.status === 'waiting' && u.status == null ? 'waiting' : toolStatus(u.status, prev?.status ?? 'running');
  const name = u.name ?? prev?.name ?? verb;
  const item: Tool = {
    kind: 'tool', id: toolItemId(u.toolCallId), at: prev?.at ?? at, tool, name, target, status,
    output, exitCode, diffs, action: { name: verb, target: actionTarget },
    ...(prev?.outputDropped !== undefined && prev.output === output ? { outputDropped: prev.outputDropped } : {}),
  };
  return { item, terminals };
}

/** The plan strip from a plan's entries. */
export function planOf(entries: acp.PlanEntry[]): NonNullable<ChatState['plan']> {
  return entries.map((e) => ({
    step: e.content, status: e.status === 'in_progress' ? 'inProgress' : e.status === 'completed' ? 'completed' : 'pending',
  }));
}

/** The Permissions picker from the agent's modes. */
export function modesOf(state: acp.SessionModeState | null | undefined): { modes: ModeOption[]; mode: string } {
  if (!state) return { modes: [], mode: '' };
  return { modes: state.availableModes.map((m) => ({ id: m.id, label: m.name })), mode: state.currentModeId };
}

/** The Model picker from a config option of category "model" (a select), with its id. */
export function modelsOf(options: acp.SessionConfigOption[] | null | undefined): { configId: string; models: ModelOption[]; model: string } | null {
  const opt = options?.find((o) => o.category === 'model' && o.type === 'select');
  if (!opt || opt.type !== 'select') return null;
  const flat = opt.options.flatMap((x) => ('group' in x ? x.options : [x]));
  return {
    configId: opt.id, model: opt.currentValue,
    models: flat.map((m) => ({ id: m.value, label: m.name, isDefault: m.value === opt.currentValue })),
  };
}

/** What the turn's end says, beyond the turn going idle. */
export function stopNotice(reason: acp.StopReason, agent: string): { level: 'info' | 'warn'; text: string } | null {
  switch (reason) {
    case 'end_turn': return null;
    case 'cancelled': return { level: 'info', text: 'Stopped' };
    case 'max_tokens': return { level: 'warn', text: `${agent} stopped: the reply reached its length limit.` };
    case 'max_turn_requests': return { level: 'warn', text: `${agent} stopped: the turn reached its limit of model requests.` };
    case 'refusal': return { level: 'warn', text: `${agent} declined to continue this turn.` };
    default: return null;
  }
}

const TITLES: Partial<Record<acp.ToolKind, string>> = {
  execute: 'Allow this command?', edit: 'Allow these edits?', delete: 'Allow deleting this?', move: 'Allow moving this?',
  read: 'Allow reading this?', fetch: 'Allow web access?', search: 'Allow this search?', switch_mode: 'Allow switching modes?',
};

/** The options an approval card's three answers stand for, from the agent's own options. */
export interface Choices { allow: string | null; always: string | null; deny: string | null }

export function choicesOf(options: acp.PermissionOption[]): Choices {
  const first = (kind: acp.PermissionOptionKind) => options.find((o) => o.kind === kind)?.optionId ?? null;
  return {
    allow: first('allow_once') ?? first('allow_always'),
    always: first('allow_always'),
    deny: first('reject_once') ?? first('reject_always'),
  };
}

/** The approval card for session/request_permission. */
export function approvalItem(
  id: string, params: acp.RequestPermissionRequest, tool: Tool | undefined, agent: string, at: number, cwd: string,
): { item: Approval; choices: Choices } {
  const tc = params.toolCall;
  const kind = tc.kind ?? null;
  const title = (kind && TITLES[kind]) ?? `Allow ${agent} to continue?`;
  const command = commandOf(tc.rawInput);
  const paths = (tc.locations ?? []).map((l) => shownPath(l.path, cwd));
  const detail = [tc.title ? tc.title.replace(/`/g, '') : tool?.target ?? '', command && command !== tc.title ? command : '', ...paths]
    .filter((s, i, all) => s !== '' && all.indexOf(s) === i).join('\n\n');
  const choices = choicesOf(params.options);
  const alwaysName = params.options.find((o) => o.optionId === choices.always)?.name ?? null;
  return {
    item: {
      kind: 'approval', id, at, toolItemId: tool?.id ?? toolItemId(tc.toolCallId), title, detail,
      alwaysLabel: choices.always !== null ? `what ${agent} offers as “${alwaysName}”` : null, status: 'pending',
    },
    choices,
  };
}

/** The card's recent steps: the latest turn's last two tool calls, oldest first. */
export function recentSteps(items: ChatItem[]): RunStep[] {
  const lastUser = items.findLastIndex((i) => i.kind === 'user');
  const tools = items.slice(lastUser + 1).filter((i): i is Tool => i.kind === 'tool').slice(-2);
  const kind = (t: ToolKind): RunStep['kind'] => (t === 'read' || t === 'search' || t === 'edit' || t === 'command' ? t : 'tool');
  return tools.map((t) => ({
    kind: kind(t.tool), label: t.action?.target || t.target || t.name,
    status: t.status === 'done' ? 'done' : t.status === 'failed' || t.status === 'denied' ? 'failed' : 'running',
  }));
}

/** The streams one session's updates feed: the message or thought being written, which ends at a
    tool call, a new message id, or the turn's end. */
export class UpdateMapper {
  private open: { id: string; kind: 'assistant' | 'reasoning' | 'user'; messageId: string | null; startedAt: number } | null = null;
  private seq = 0;

  constructor(private readonly idPrefix: string, private readonly now: () => number) {}

  /** The ChatUpdates and the state patch for one session/update, given the chat's items. */
  apply(update: acp.SessionUpdate, items: ChatItem[], cwd: string): { updates: ChatUpdate[]; patch: Partial<ChatState> | null; terminals: Map<string, string> } {
    const updates: ChatUpdate[] = [];
    const terminals = new Map<string, string>();
    let patch: Partial<ChatState> | null = null;
    const find = (id: string) => items.find((i) => i.id === id);
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'user_message_chunk': {
        const kind = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'user';
        const messageId = update.messageId ?? null;
        const text = update.content.type === 'text' ? update.content.text : kind === 'user' && update.content.type === 'image' ? '' : blockText(update.content);
        const image: ImageRef | null = update.content.type === 'image' && kind === 'user'
          ? { mime: update.content.mimeType, dataUrl: `data:${update.content.mimeType};base64,${update.content.data}` } : null;
        const o = this.open;
        const same = o !== null && o.kind === kind && (messageId === null || o.messageId === null || o.messageId === messageId) && find(o.id) !== undefined;
        if (same && o) {
          if (kind === 'user') {
            const prev = find(o.id);
            if (prev?.kind === 'user') updates.push({ op: 'upsert', item: { ...prev, text: prev.text + text, images: image ? [...prev.images, image] : prev.images } });
          } else if (text !== '') {
            updates.push({ op: 'append', id: o.id, field: 'text', chunk: text });
          }
          if (messageId !== null) o.messageId = messageId;
          break;
        }
        updates.push(...this.close(items));
        const id = `${this.idPrefix}-${kind}-${++this.seq}`;
        const at = this.now();
        this.open = { id, kind, messageId, startedAt: at };
        if (kind === 'user') updates.push({ op: 'upsert', item: { kind: 'user', id, at, text, images: image ? [image] : [] } });
        else if (kind === 'assistant') updates.push({ op: 'upsert', item: { kind: 'assistant', id, at, text, streaming: true } });
        else updates.push({ op: 'upsert', item: { kind: 'reasoning', id, at, text, streaming: true, durationMs: null } });
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        updates.push(...this.close(items));
        const prev = find(toolItemId(update.toolCallId));
        const { item, terminals: ids } = toolItem(prev?.kind === 'tool' ? prev : undefined, update, this.now(), cwd);
        for (const t of ids) terminals.set(t, item.id);
        updates.push({ op: 'upsert', item });
        break;
      }
      case 'plan':
        patch = { plan: planOf(update.entries) };
        break;
      case 'plan_update':
        if (update.plan.type === 'items') patch = { plan: planOf(update.plan.entries) };
        break;
      case 'current_mode_update':
        patch = { mode: update.currentModeId };
        break;
      case 'config_option_update': {
        const m = modelsOf(update.configOptions);
        if (m) patch = { models: m.models, model: m.model };
        break;
      }
      case 'session_info_update':
        if (typeof update.title === 'string' && update.title.trim() !== '') patch = { title: update.title.trim() };
        break;
      case 'notice': {
        const level = update.severity === 'error' ? 'error' : update.severity === 'warning' ? 'warn' : 'info';
        const text = [update.title, update.description ?? ''].filter((s) => s !== '').join(': ');
        updates.push({ op: 'upsert', item: { kind: 'notice', id: `${this.idPrefix}-notice-${++this.seq}`, at: this.now(), level, text } });
        break;
      }
      default:
        // Commands, usage, compaction, subagents and kinds newer than this app: nothing to show.
        break;
    }
    return { updates, patch, terminals };
  }

  /** Ends the message or thought being streamed (at a tool call, or the turn's end). */
  close(items: ChatItem[]): ChatUpdate[] {
    const o = this.open;
    this.open = null;
    if (!o) return [];
    const item = items.find((i) => i.id === o.id);
    if (item?.kind === 'assistant' && item.streaming) return [{ op: 'upsert', item: { ...item, streaming: false } }];
    if (item?.kind === 'reasoning' && item.streaming) return [{ op: 'upsert', item: { ...item, streaming: false, durationMs: Math.max(0, this.now() - o.startedAt) } }];
    return [];
  }

  /** Forgets the stream (a reset: the history is about to be replayed). */
  reset(): void {
    this.open = null;
  }
}
