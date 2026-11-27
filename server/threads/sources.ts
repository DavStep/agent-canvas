// Where the detector reads conversations from: Claude Code's transcripts (the canvas agent's own
// chat among them, since it is a Claude session) and Codex's rollout files. Only each file's ends
// are read — a transcript can be well over 100 MB — and nothing is written anywhere.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from '../../shared/chat.ts';
import { readWindow } from '../adapter/transcript.ts';
import type { Turn } from './detect.ts';

/** One conversation on disk, as the scanner lists it. */
export interface ChatFile {
  /** The card id the canvas knows it by ('codex:' prefixed for Codex). */
  id: string;
  provider: Provider;
  file: string;
  mtimeMs: number;
  size: number;
}

/** What one conversation holds, for the detector. */
export interface ChatSource {
  cwd: string;
  /** The chat's title where it has one, else its first prompt, shortened; '' when neither. */
  name: string;
  turns: Turn[];
}

/** How much of a transcript's end is read for its turns, and of its start for its folder. */
const TAIL_BYTES = 400_000;
const HEAD_BYTES = 64 * 1024;
const MAX_NAME = 60;
const CODEX_PREFIX = 'codex:';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** A name cut to MAX_NAME characters on a word, the cut marked. */
export function shortName(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_NAME) return flat;
  const head = flat.slice(0, MAX_NAME - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

function records(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === 'object' && value !== null) out.push(value as Record<string, unknown>);
    } catch {
      // A line the window cut, or one being written: the file is read again when it changes.
    }
  }
  return out;
}

/** Turns of the same role in a row are one turn (a streamed answer is written as many records). */
export function mergeTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const turn of turns) {
    const last = out.at(-1);
    if (last && last.role === turn.role) {
      out[out.length - 1] = { role: last.role, text: `${last.text}\n\n${turn.text}`.trim(), at: Math.max(last.at, turn.at) };
    } else {
      out.push(turn);
    }
  }
  return out;
}

const textBlocks = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n');
};

/** The transcripts under <claudeHome>/projects/, newest first. Subagent transcripts are left out. */
export async function claudeFiles(projectsDir: string, limit: number): Promise<ChatFile[]> {
  let folders: string[];
  try {
    folders = await fs.readdir(projectsDir);
  } catch {
    return [];
  }
  const out: ChatFile[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(projectsDir, folder));
    } catch {
      continue; // not a folder
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;
      const file = path.join(projectsDir, folder, name);
      try {
        const st = await fs.stat(file);
        if (st.isFile()) out.push({ id: name.slice(0, -'.jsonl'.length), provider: 'claude', file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // removed meanwhile
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1)).slice(0, limit);
}

/** One Claude transcript's turns, read from its end. */
export async function readClaudeChat(file: string, maxBytes = TAIL_BYTES): Promise<ChatSource> {
  let text: string;
  try {
    text = await readWindow(file, maxBytes);
  } catch {
    return { cwd: '', name: '', turns: [] };
  }
  const turns: Turn[] = [];
  let cwd = '';
  let title: string | null = null;
  let aiTitle: string | null = null;
  let firstPrompt = '';
  for (const r of records(text)) {
    if (r.isSidechain === true) continue;
    const at = Date.parse(str(r.timestamp) ?? '');
    cwd = str(r.cwd) ?? cwd;
    if (r.type === 'custom-title') {
      title = str(r.customTitle) ?? title;
      continue;
    }
    if (r.type === 'ai-title') {
      aiTitle = str(r.aiTitle) ?? aiTitle;
      continue;
    }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (r.isMeta === true) continue;
    const message = r.message as { content?: unknown } | undefined;
    const body = textBlocks(message?.content).trim();
    if (body === '') continue;
    // Slash-command echoes and other injected markup are not what the owner said.
    if (r.type === 'user' && body.startsWith('<')) continue;
    if (r.type === 'user' && firstPrompt === '') firstPrompt = body;
    turns.push({ role: r.type === 'user' ? 'user' : 'assistant', text: body, at: Number.isFinite(at) ? at : 0 });
  }
  return { cwd, name: shortName(title ?? aiTitle ?? firstPrompt), turns: mergeTurns(turns) };
}

/** Codex's rollout files under <codexHome>/sessions/<year>/<month>/<day>/, newest first. */
export async function codexFiles(codexHome: string, limit: number): Promise<ChatFile[]> {
  const root = path.join(codexHome, 'sessions');
  const out: ChatFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) await walk(file, depth + 1);
        continue;
      }
      const id = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(entry.name)?.[1];
      if (id === undefined) continue;
      try {
        const st = await fs.stat(file);
        if (st.isFile()) out.push({ id: CODEX_PREFIX + id, provider: 'codex', file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // removed meanwhile
      }
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1)).slice(0, limit);
}

/** One Codex rollout's turns. Its folder is in the first records, its turns in the last. */
export async function readCodexChat(file: string, maxBytes = TAIL_BYTES): Promise<ChatSource> {
  let head: Record<string, unknown>[] = [];
  let tail: string;
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      head = records(buf.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
    tail = await readWindow(file, maxBytes);
  } catch {
    return { cwd: '', name: '', turns: [] };
  }
  const meta = head.find((r) => r.type === 'session_meta')?.payload as { cwd?: unknown } | undefined;
  const turns: Turn[] = [];
  let firstPrompt = '';
  for (const r of records(tail)) {
    if (r.type !== 'event_msg') continue;
    const payload = r.payload as { type?: unknown; item?: Record<string, unknown>; message?: unknown; phase?: unknown } | undefined;
    if (payload === undefined) continue;
    const at = Date.parse(str(r.timestamp) ?? '');
    const when = Number.isFinite(at) ? at : 0;
    if (payload.type === 'item_completed') {
      const item = payload.item;
      if (item === undefined) continue;
      const body = (Array.isArray(item.content)
        ? item.content.flatMap((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : [])).join('\n')
        : '').trim();
      if (body === '') continue;
      if (item.type === 'UserMessage') {
        if (firstPrompt === '') firstPrompt = body;
        turns.push({ role: 'user', text: body, at: when });
      } else if (item.type === 'AgentMessage' && item.phase !== 'commentary') {
        turns.push({ role: 'assistant', text: body, at: when });
      }
      continue;
    }
    // Older rollouts write the same two things as their own events.
    const body = (str(payload.message) ?? '').trim();
    if (body === '') continue;
    if (payload.type === 'user_message') {
      if (firstPrompt === '') firstPrompt = body;
      turns.push({ role: 'user', text: body, at: when });
    } else if (payload.type === 'agent_message' && payload.phase !== 'commentary') {
      turns.push({ role: 'assistant', text: body, at: when });
    }
  }
  return { cwd: str(meta?.cwd) ?? '', name: shortName(firstPrompt), turns: mergeTurns(turns) };
}

/** Reads one listed conversation, whichever provider wrote it. */
export function readChat(chat: ChatFile, maxBytes?: number): Promise<ChatSource> {
  return chat.provider === 'codex' ? readCodexChat(chat.file, maxBytes) : readClaudeChat(chat.file, maxBytes);
}
