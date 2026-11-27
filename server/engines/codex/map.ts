// Codex thread items → ChatItems (history from thread/read and thread/turns/list), and the
// app server's item notifications → ChatUpdates for a chat that is running here.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatItem, ChatUpdate, FileDiff, ImageRef } from '../../../shared/chat.ts';
import { mediaKind, type ChatMedia } from '../../../shared/chatMedia.ts';
import { fileDiff, fromUnified } from '../diffs.ts';
import type { JsonValue } from './protocol/serde_json/JsonValue.ts';
import type { FileUpdateChange } from './protocol/v2/FileUpdateChange.ts';
import type { ThreadItem } from './protocol/v2/ThreadItem.ts';
import type { Turn } from './protocol/v2/Turn.ts';
import type { UserInput } from './protocol/v2/UserInput.ts';

type ToolStatus = Extract<ChatItem, { kind: 'tool' }>['status'];
const STATUS: Record<'inProgress' | 'completed' | 'failed' | 'declined', ToolStatus> = {
  inProgress: 'running', completed: 'done', failed: 'failed', declined: 'denied',
};

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

function image(input: UserInput): ImageRef | null {
  if (input.type === 'image' && 'url' in input) return { mime: /^data:([^;,]+)/.exec(input.url)?.[1] ?? 'image/png', dataUrl: input.url };
  // The page cannot load file: URLs; whoever shows this item inlines the file as data first.
  if (input.type === 'localImage') {
    return { mime: MIME[path.extname(input.path).toLowerCase()] ?? 'image/png', dataUrl: pathToFileURL(input.path).href };
  }
  return null;
}

/** `/bin/zsh -lc '<cmd>'` is how Codex wraps every command; the owner wants to see <cmd>. */
export function unwrapShell(command: string): string {
  const inner = /^(?:\S*\/)?(?:ba|z)?sh -lc '((?:[^']|'\\'')*)'$/s.exec(command)?.[1];
  return inner === undefined ? command : inner.replaceAll(`'\\''`, `'`);
}

/** Codex sends a unified diff for updates, but the whole text for added and deleted files. */
function changeDiff(change: FileUpdateChange): FileDiff {
  if (change.kind.type === 'add') return fileDiff(change.path, '', change.diff);
  if (change.kind.type === 'delete') return fileDiff(change.path, change.diff, '');
  return fromUnified(change.path, change.diff);
}

const DYNAMIC: Record<'inProgress' | 'completed' | 'failed', ToolStatus> = { inProgress: 'running', completed: 'done', failed: 'failed' };
const COLLAB: Record<'inProgress' | 'completed' | 'failed' | 'interrupted', ToolStatus> = {
  inProgress: 'running', completed: 'done', failed: 'failed', interrupted: 'failed',
};
const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

function firstString(value: JsonValue): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return typeof value === 'string' ? value : '';
  return Object.values(value).find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? '';
}

const contentText = (content: JsonValue[]): string =>
  content
    .map((c) => (typeof c === 'object' && c !== null && !Array.isArray(c) && typeof c.text === 'string' ? c.text : ''))
    .filter((t) => t !== '')
    .join('\n');

function mediaFields(items: ChatMedia[]): { media?: ChatMedia[] } {
  const media = items.filter(({ src, kind }) => !src.startsWith('data:') || mediaKind(src) === kind);
  return media.length ? { media } : {};
}

function resultMedia(content: JsonValue[]): ChatMedia[] {
  return content.flatMap((c): ChatMedia[] => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
    if ((c.type === 'image' || c.type === 'video') && typeof c.mimeType === 'string' && typeof c.data === 'string') {
      const src = `data:${c.mimeType};base64,${c.data}`;
      return mediaKind(src) === c.type ? [{ kind: c.type, src }] : [];
    }
    if (c.type === 'resource_link' && typeof c.uri === 'string') {
      const kind = mediaKind(c.uri);
      if (kind) return [{ kind, src: c.uri, ...(typeof c.name === 'string' ? { label: c.name } : {}) }];
    }
    if (c.type === 'resource' && c.resource && typeof c.resource === 'object' && !Array.isArray(c.resource)) {
      const { mimeType, blob, uri } = c.resource;
      const src = typeof blob === 'string' ? `data:${mimeType};base64,${blob}` : typeof uri === 'string' ? uri : '';
      const kind = mediaKind(src);
      if (kind) return [{ kind, src }];
    }
    return [];
  });
}

/** Async replies are persisted as a user message containing a small JSON envelope. */
function replyText(text: string): string {
  const body = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text)?.[1];
  if (!body) return text;
  try {
    const rows: unknown = JSON.parse(body);
    if (Array.isArray(rows) && rows.length && rows.every(row => typeof row?.answer === 'string')) {
      return rows.map(row => row.answer).join('\n');
    }
  } catch { /* Keep unrecognised content intact. */ }
  return text;
}

/** One thread item as a chat item; null for items with nothing to show. */
export function codexItem(item: ThreadItem, at: number, fallbackId: string): ChatItem | null {
  switch (item.type) {
    case 'userMessage':
      return {
        // A message this app sent carries our clientUserMessageId; keying on it lets the server's
        // copy replace the item shown when Send was pressed.
        kind: 'user', id: item.clientId ?? item.id, at,
        text: item.content.flatMap((c) => {
          if (c.type === 'text') return [replyText(c.text)];
          if (c.type === 'image' && 'fileId' in c) return ['[Image preview unavailable]'];
          return [];
        }).join('\n'),
        images: item.content.map(image).filter((i): i is ImageRef => i !== null),
      };
    case 'agentMessage': {
      const browser = /^::browser-complete\{title="([^"\n]+)"\}\s*$/.exec(item.text);
      if (browser) return { kind: 'notice', id: item.id, at, level: 'info', text: browser[1]! };
      const questions = (item.questions ?? []).map(q => q.title).filter(title => title && !item.text.includes(title));
      const text = [item.text, ...questions].filter(Boolean).join('\n\n');
      return { kind: 'assistant', id: item.id, at, text, streaming: false, ...(item.phase === 'commentary' && !item.questions?.length ? { commentary: true } : {}) };
    }
    case 'plan':
      return { kind: 'assistant', id: item.id, at, text: item.text, streaming: false };
    case 'reasoning': {
      const text = (item.summary.length > 0 ? item.summary : item.content).join('\n\n');
      return text === '' ? null : { kind: 'reasoning', id: item.id, at, text, streaming: false, durationMs: null };
    }
    case 'commandExecution': {
      const parsed = item.commandActions?.length === 1 ? item.commandActions[0] : null;
      let action;
      if (parsed?.type === 'read') action = { name: 'Read', target: parsed.path || parsed.name };
      if (parsed?.type === 'listFiles') action = { name: 'List files', target: parsed.path ?? '' };
      if (parsed?.type === 'search') action = { name: 'Search', target: [parsed.query, parsed.path].filter(Boolean).join(' in ') };
      return {
        kind: 'tool', id: item.id, at, tool: 'command', name: 'shell', target: unwrapShell(item.command),
        status: STATUS[item.status], output: item.aggregatedOutput, exitCode: item.exitCode, diffs: [], ...(action ? { action } : {}),
      };
    }
    case 'fileChange': {
      const first = item.changes[0]?.path ?? '';
      const more = item.changes.length > 1 ? ` (+${item.changes.length - 1} more)` : '';
      return {
        kind: 'tool', id: item.id, at, tool: 'edit', name: 'apply_patch', target: first + more,
        status: STATUS[item.status], output: null, exitCode: null, diffs: item.changes.map(changeDiff),
      };
    }
    case 'mcpToolCall': {
      const result = item.result;
      const media = resultMedia(result?.content ?? []);
      const text = result ? contentText(result.content) : '';
      const structured = !text && !media.length && result?.structuredContent != null ? JSON.stringify(result.structuredContent, null, 2) : null;
      const app = item.appContext;
      return {
        kind: 'tool', id: item.id, at, tool: 'mcp', name: `${item.server}/${item.tool}`, target: firstString(item.arguments),
        status: item.error ? 'failed' : STATUS[item.status], ...mediaFields(media),
        ...(app?.appName ? { action: { name: app.appName, target: app.actionName || item.tool } } : {}),
        output: item.error?.message ?? (text || structured), exitCode: null, diffs: [],
      };
    }
    case 'webSearch': {
      const action = item.action;
      const target = item.query || (action?.type === 'openPage' || action?.type === 'findInPage' ? action.url ?? '' : '');
      return { kind: 'tool', id: item.id, at, tool: 'web', name: 'web_search', target, status: 'done', output: null, exitCode: null, diffs: [] };
    }
    case 'imageView':
      return { kind: 'tool', id: item.id, at, tool: 'read', name: 'view_image', target: item.path, media: [{ kind: 'image', src: item.path }], status: 'done', output: null, exitCode: null, diffs: [] };
    case 'contextCompaction':
      return { kind: 'notice', id: item.id, at, level: 'info', text: 'Earlier conversation compacted' };
    case 'dynamicToolCall': {
      const text = (item.contentItems ?? []).flatMap((c) => (c.type === 'inputText' ? [c.text] : [])).join('\n');
      const status: ToolStatus = item.success === false ? 'failed' : DYNAMIC[item.status];
      return {
        kind: 'tool', id: item.id, at, tool: 'other', name: item.namespace ? `${item.namespace}/${item.tool}` : item.tool,
        ...mediaFields((item.contentItems ?? []).flatMap((c): ChatMedia[] => c.type === 'inputImage' ? [{ kind: 'image', src: c.imageUrl }] : [])),
        target: firstString(item.arguments), status, output: text === '' ? null : text, exitCode: null, diffs: [],
      };
    }
    case 'collabAgentToolCall':
      return {
        kind: 'tool', id: item.id, at, tool: 'other', name: `Agent: ${item.tool}`, target: firstLine(item.prompt ?? ''),
        status: COLLAB[item.status], output: null, exitCode: null, diffs: [],
      };
    case 'sleep':
      return { kind: 'tool', id: item.id, at, tool: 'other', name: 'sleep', target: `${Math.round(item.durationMs / 1000)} s`, status: 'done', output: null, exitCode: null, diffs: [] };
    case 'imageGeneration': {
      const src = item.savedPath || ('result' in item && item.result ? (item.result.startsWith('data:') ? item.result : `data:image/png;base64,${item.result}`) : '');
      return {
        kind: 'tool', id: item.id, at, tool: 'other', name: 'image_generation', target: item.revisedPrompt ?? '',
        status: item.failure || item.status === 'failed' ? 'failed' : item.status === 'inProgress' || item.status === 'generating' ? 'running' : 'done',
        output: item.failure ? 'Image generation limit reached' : null, exitCode: null, diffs: [],
        ...mediaFields(src && !item.failure ? [{ kind: 'image', src, label: 'Generated image' }] : []),
      };
    }
    case 'enteredReviewMode':
      return { kind: 'notice', id: item.id, at, level: 'info', text: `Review started: ${item.review}` };
    case 'exitedReviewMode':
      return { kind: 'notice', id: item.id, at, level: 'info', text: 'Review finished' };
    case 'subAgentActivity':
      // Its start and end are worth a line; each exchange with it is not.
      return item.kind === 'interacted' ? null : { kind: 'notice', id: item.id, at, level: 'info', text: `Subagent ${item.agentPath || 'agent'} ${item.kind}` };
    case 'hookPrompt': {
      const text = item.fragments.map((f) => f.text).join(' ').trim();
      return text === '' ? null : { kind: 'notice', id: item.id, at, level: 'info', text: `A hook added: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}` };
    }
    case 'functionCallOutput': {
      const media = Array.isArray(item.output) ? item.output.flatMap((part): ChatMedia[] =>
        part.type === 'input_image' && 'image_url' in part ? [{ kind: 'image', src: part.image_url }] : []) : [];
      if (media.length) return { kind: 'tool', id: item.id, at, tool: 'other', name: item.name, target: '', status: 'done', output: null, exitCode: null, diffs: [], media };
      return null;
    }
  }
  // Newer Codex versions add item types; say so rather than drop them silently.
  const unknown = item as unknown as { type?: unknown; id?: unknown };
  const id = typeof unknown.id === 'string' ? (unknown.id as string) : fallbackId;
  return {
    kind: 'notice', id, at, level: 'info',
    text: `Unsupported item: ${String(unknown.type)}`,
  };
}

export function codexItems(turns: Turn[]): ChatItem[] {
  return turns.flatMap((turn) => {
    const at = (turn.startedAt ?? 0) * 1000; // older items only have the turn time
    return turn.items.flatMap((item, n) => codexItem(item, item.startedAtMs ?? item.completedAtMs ?? at, `${turn.id}:${n}`) ?? []);
  });
}

type Lookup = (id: string) => ChatItem | undefined;
interface ItemEvent { item: ThreadItem; startedAtMs?: number; completedAtMs?: number }
interface Delta { itemId: string; delta: string }

/** item/started: the item as it begins. Streaming kinds start open; a tool an approval is already
    holding stays `waiting`; an item shown before (our own user message) keeps its time. */
function started(e: ItemEvent, find: Lookup): ChatUpdate[] {
  const at = e.startedAtMs ?? 0;
  const mapped = codexItem(e.item, at, e.item.id);
  const before = mapped ? find(mapped.id) : undefined;
  if (e.item.type === 'reasoning') {
    return [{ op: 'upsert', item: { kind: 'reasoning', id: e.item.id, at, text: mapped?.kind === 'reasoning' ? mapped.text : '', streaming: true, durationMs: null } }];
  }
  if (!mapped) return [];
  let item: ChatItem = { ...mapped, at: before?.at ?? at };
  if (item.kind === 'assistant') item = { ...item, streaming: true };
  if (item.kind === 'tool' && before?.kind === 'tool' && before.status === 'waiting') item = { ...item, status: 'waiting' };
  return [{ op: 'upsert', item }];
}

/** item/completed: the final item. Reasoning that streamed but completes empty keeps its text. */
function completed(e: ItemEvent, find: Lookup): ChatUpdate[] {
  const done = e.completedAtMs ?? 0;
  const mapped = codexItem(e.item, done, e.item.id);
  const before = find(mapped?.id ?? e.item.id);
  const at = before?.at ?? done;
  if (e.item.type === 'reasoning') {
    const text = mapped?.kind === 'reasoning' ? mapped.text : before?.kind === 'reasoning' ? before.text : '';
    if (text === '' && !before) return [];
    const durationMs = before ? Math.max(0, done - before.at) : null;
    return [{ op: 'upsert', item: { kind: 'reasoning', id: e.item.id, at, text, streaming: false, durationMs } }];
  }
  if (!mapped) return [];
  // A completed command may carry no aggregatedOutput: what streamed stays, with the count of
  // what the 256 KB cap dropped from it.
  if (mapped.kind === 'tool' && mapped.output === null && before?.kind === 'tool' && before.output !== null) {
    const dropped = before.outputDropped === undefined ? {} : { outputDropped: before.outputDropped };
    return [{ op: 'upsert', item: { ...mapped, at, output: before.output, ...dropped } }];
  }
  return [{ op: 'upsert', item: { ...mapped, at } }];
}

function textDelta(d: Delta, find: Lookup, now: number, kind: 'assistant' | 'reasoning'): ChatUpdate[] {
  if (find(d.itemId)) return [{ op: 'append', id: d.itemId, field: 'text', chunk: d.delta }];
  // A delta for an item we have not seen start: show it from here.
  const item: ChatItem = kind === 'assistant'
    ? { kind, id: d.itemId, at: now, text: d.delta, streaming: true }
    : { kind, id: d.itemId, at: now, text: d.delta, streaming: true, durationMs: null };
  return [{ op: 'upsert', item }];
}

/** One app-server notification about an item as chat updates; [] for anything else. */
export function itemUpdates(method: string, params: unknown, find: Lookup, now: number): ChatUpdate[] {
  const p = params as Record<string, unknown>;
  switch (method) {
    case 'item/started':
      return started(p as unknown as ItemEvent, find);
    case 'item/completed':
      return completed(p as unknown as ItemEvent, find);
    case 'item/agentMessage/delta':
    case 'item/plan/delta':
      return textDelta(p as unknown as Delta, find, now, 'assistant');
    // Only the summary streams: it is what history shows, and raw reasoning text rarely comes.
    case 'item/reasoning/summaryTextDelta':
      return textDelta(p as unknown as Delta, find, now, 'reasoning');
    case 'item/reasoning/summaryPartAdded': {
      const before = find(String(p.itemId));
      return before?.kind === 'reasoning' && before.text !== '' ? [{ op: 'append', id: before.id, field: 'text', chunk: '\n\n' }] : [];
    }
    case 'item/commandExecution/outputDelta': {
      const d = p as unknown as Delta;
      return find(d.itemId)?.kind === 'tool' ? [{ op: 'append', id: d.itemId, field: 'output', chunk: d.delta }] : [];
    }
    case 'item/fileChange/patchUpdated': {
      const before = find(String(p.itemId));
      const changes = p.changes as FileUpdateChange[];
      if (before?.kind !== 'tool' || !Array.isArray(changes)) return [];
      const more = changes.length > 1 ? ` (+${changes.length - 1} more)` : '';
      return [{ op: 'upsert', item: { ...before, target: (changes[0]?.path ?? '') + more, diffs: changes.map(changeDiff) } }];
    }
    default:
      return [];
  }
}
