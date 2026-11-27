// Claude's most recently used sessions, from the transcripts in <CLAUDE_HOME>/projects/<folder>/.
// Only each transcript's first and last 32 KB are read (they can be over 100 MB): the head gives
// the folder and the first prompt, head and tail the title records, the tail the branch and model.
import fs from 'node:fs/promises';
import path from 'node:path';
import { promptLine } from '../../shared/attachments.ts';
import type { SessionInterruption } from '../../shared/types.ts';
import { ClaudeTurnTracker } from '../interruptions.ts';

export interface RecentSession {
  completedAt?: number;
  id: string;
  cwd: string;
  name: string;
  /** The first record's time, else lastActive. */
  startedAt: number;
  /** When the transcript was last written (epoch ms). */
  lastActive: number;
  branch: string | null;
  model: string | null;
  /** How its last turn was cut off (a limit, an error, or no process left mid-turn), else absent. */
  interruption?: SessionInterruption;
}

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 32 * 1024;
const MAX_NAME = 60;

interface Candidate { id: string; file: string; mtimeMs: number; size: number }
interface Parsed { mtimeMs: number; size: number; session: RecentSession | null }

/** What was read from each transcript, so an unchanged one is not read again next poll. */
const cache = new Map<string, Parsed>();

type Rec = {
  subtype?: unknown; isApiErrorMessage?: unknown; error?: unknown; apiErrorStatus?: unknown; quotaLimits?: unknown; apiErrorParams?: unknown;
  isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown;
  type?: unknown; isSidechain?: unknown; isMeta?: unknown; cwd?: unknown; timestamp?: unknown; gitBranch?: unknown;
  customTitle?: unknown; aiTitle?: unknown; summary?: unknown; message?: { model?: unknown; content?: unknown; stop_reason?: unknown };
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Cut at MAX_NAME characters on a word, the cut marked with an ellipsis. */
export function shortName(text: string): string {
  // A prompt's attached files block is not its name: its words are, or the files' names.
  const flat = promptLine(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_NAME) return flat;
  const cut = flat.slice(0, MAX_NAME - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A prompt the owner typed: plain text, not a slash-command echo or other injected markup. */
function promptText(r: Rec): string | null {
  if (r.type !== 'user' || r.isMeta === true) return null;
  const content = r.message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n') : '';
  const t = text.trim();
  return t === '' || t.startsWith('<') ? null : t;
}

function records(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (typeof r === 'object' && r !== null) out.push(r as Rec);
    } catch {
      // a line cut by the window edge, or one being written
    }
  }
  return out;
}

/** The head and tail windows (or the whole file when it is small), cut at line ends. */
async function readEnds(file: string, size: number): Promise<{ head: string; tail: string }> {
  const handle = await fs.open(file, 'r');
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buf, 0, size, 0);
      return { head: buf.subarray(0, bytesRead).toString('utf8'), tail: '' };
    }
    const head = Buffer.alloc(HEAD_BYTES);
    const tail = Buffer.alloc(TAIL_BYTES);
    const h = await handle.read(head, 0, HEAD_BYTES, 0);
    const t = await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    const headText = head.subarray(0, h.bytesRead).toString('utf8');
    const tailText = tail.subarray(0, t.bytesRead).toString('utf8');
    const nl = tailText.indexOf('\n');
    return { head: headText.slice(0, Math.max(0, headText.lastIndexOf('\n'))), tail: nl === -1 ? '' : tailText.slice(nl + 1) };
  } finally {
    await handle.close();
  }
}

async function parse(c: Candidate): Promise<RecentSession | null> {
  const { head, tail } = await readEnds(c.file, c.size);
  const first = records(head);
  const all = [...first, ...records(tail)];
  // A transcript that is all sidechain is a subagent's.
  if (first.length > 0 && first.every((r) => r.isSidechain === true)) return null;
  const main = all.filter((r) => r.isSidechain !== true);
  const title = main.findLast((r) => r.type === 'custom-title' && str(r.customTitle))?.customTitle as string | undefined;
  const aiTitle = main.findLast((r) => r.type === 'ai-title' && str(r.aiTitle))?.aiTitle as string | undefined;
  const summary = main.findLast((r) => r.type === 'summary' && str(r.summary))?.summary as string | undefined;
  let prompt: string | null = null;
  for (const r of main) if ((prompt = promptText(r)) !== null) break;
  const cwd = main.map((r) => str(r.cwd)).find((v) => v !== null) ?? '';
  const started = main.map((r) => (typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN)).find((t) => Number.isFinite(t));
  const branch = main.map((r) => str(r.gitBranch)).findLast((v) => v !== null) ?? null;
  const model = main.map((r) => (r.type === 'assistant' ? str(r.message?.model) : null)).findLast((m) => m !== null && m !== '<synthetic>') ?? null;
  // How the last turn ended, from the end of the file: no process runs it now. A tail window with
  // no whole record (one huge line) says nothing.
  const end = tail === '' ? first : records(tail);
  const turn = new ClaudeTurnTracker();
  for (const record of end) turn.add(record);
  const interruption = turn.result(false);
  return {
    ...(interruption ? { interruption } : {}),
    ...(turn.completedAt !== undefined ? { completedAt: turn.completedAt } : {}),
    id: c.id, cwd, name: shortName(title ?? aiTitle ?? summary ?? prompt ?? ''), startedAt: started ?? c.mtimeMs, lastActive: c.mtimeMs,
    branch: branch === 'HEAD' ? null : branch, model,
  };
}

async function candidates(projectsDir: string): Promise<Candidate[]> {
  let folders: string[];
  try {
    folders = await fs.readdir(projectsDir);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(projectsDir, folder));
    } catch {
      continue; // not a folder
    }
    for (const name of names) {
      // Subagent transcripts live in <session>/subagents/ (never listed here) or, in older
      // versions, beside the sessions as agent-<id>.jsonl.
      if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;
      const file = path.join(projectsDir, folder, name);
      try {
        const st = await fs.stat(file);
        if (st.isFile()) out.push({ id: name.slice(0, -'.jsonl'.length), file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // removed meanwhile
      }
    }
  }
  return out;
}

/** The `limit` most recently written Claude sessions, newest first. */
export async function recentClaude(projectsDir: string, limit = 40): Promise<RecentSession[]> {
  if (limit <= 0) return [];
  const all = (await candidates(projectsDir)).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
  const out: RecentSession[] = [];
  const kept = new Set<string>();
  for (const c of all) {
    if (out.length >= limit) break;
    kept.add(c.file);
    let parsed = cache.get(c.file);
    if (parsed?.mtimeMs !== c.mtimeMs || parsed.size !== c.size) {
      let session: RecentSession | null = null;
      try {
        session = await parse(c);
      } catch {
        session = null; // unreadable now; tried again when it changes
      }
      parsed = { mtimeMs: c.mtimeMs, size: c.size, session };
      cache.set(c.file, parsed);
    }
    if (parsed.session) out.push(parsed.session);
  }
  for (const file of cache.keys()) if (file.startsWith(projectsDir + path.sep) && !kept.has(file)) cache.delete(file);
  return out;
}
