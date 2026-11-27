// Finds a session's transcript and reads facts from its tail only.
// Transcripts can be over 100 MB, so nothing here reads a whole file.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunStep } from '../../shared/types.ts';
import { promptLine } from '../../shared/attachments.ts';
import type { SessionInterruption } from '../../shared/types.ts';
import { ClaudeTurnTracker, type ClaudeRecord } from '../interruptions.ts';

export interface PendingTool { name: string; input: Record<string, unknown> }
export interface TranscriptTail {
  completedAt?: number;
  /** The session's title: one the owner gave (custom-title), else the app's own (ai-title). */
  title?: string;
  lastPrompt: string | null;
  lastAnswer: string | null;
  branch: string | null;
  model: string | null;
  pendingTool: PendingTool | null;
  recentSteps?: RunStep[];
  lastBlock: 'text' | 'thinking' | 'tool_use' | null;
  /** The usage limit or API error the last turn ended on (the process is alive, so an open turn is no cut-off). */
  interruption?: SessionInterruption | null;
}

const MAX_STRING = 2000;
const DEFAULT_MAX_BYTES = 400_000;

/** The last title read from each transcript: a long turn can push the title records out of the window. */
const titles = new Map<string, string>();

/** Hits only: a session whose transcript is not written yet is looked up again next time. */
const found = new Map<string, string>();

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function findTranscript(projectsDir: string, sessionId: string): Promise<string | null> {
  const key = `${projectsDir}\0${sessionId}`;
  const cached = found.get(key);
  if (cached) {
    if (await isFile(cached)) return cached;
    found.delete(key); // moved or removed: look it up again
  }
  let folders: string[];
  try {
    folders = (await fs.readdir(projectsDir)).sort();
  } catch {
    return null;
  }
  for (const folder of folders) {
    const candidate = path.join(projectsDir, folder, `${sessionId}.jsonl`);
    if (await isFile(candidate)) {
      found.set(key, candidate);
      return candidate;
    }
  }
  return null;
}

const cut = (s: string): string => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function cutInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? cut(v) : v]));
}

export async function readWindow(file: string, maxBytes: number = DEFAULT_MAX_BYTES): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } finally {
    await handle.close();
  }
}

type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown };
type Rec = { timestamp?: unknown; type?: unknown; isSidechain?: unknown; gitBranch?: unknown; lastPrompt?: unknown; customTitle?: unknown; aiTitle?: unknown; message?: { id?: unknown; model?: unknown; content?: unknown } };

const blocksOf = (r: Rec): Block[] =>
  Array.isArray(r.message?.content) ? (r.message.content as unknown[]).filter((b): b is Block => typeof b === 'object' && b !== null) : [];

/** A user record the owner typed: plain text, or blocks that are not all tool results. */
function isPrompt(r: Rec): boolean {
  const content = r.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && blocksOf(r).some((b) => b.type !== 'tool_result');
}

function finishedStep(block: Block, failed: boolean, durationMs: number): RunStep {
  const input = cutInput(block.input);
  const file = path.basename(str(input.file_path) ?? str(input.notebook_path) ?? '');
  const name = str(block.name) ?? 'Tool';
  let kind: RunStep['kind'] = 'tool';
  let target = '';
  switch (name) {
    case 'Read': kind = 'read'; target = file; break;
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': kind = 'edit'; target = file; break;
    case 'Glob': case 'Grep': case 'WebSearch': kind = 'search'; target = str(input.pattern) ?? str(input.query) ?? ''; break;
    case 'Bash': kind = 'command'; target = str(input.command) ?? ''; break;
  }
  return {
    kind, label: (target ? `${name} ${target}` : name).replace(/\s+/g, ' ').slice(0, 160),
    status: failed ? 'failed' : 'done',
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
  };
}

export async function readTail(file: string, maxBytes: number = DEFAULT_MAX_BYTES): Promise<TranscriptTail> {
  const tail: TranscriptTail = { lastPrompt: null, lastAnswer: null, branch: null, model: null, pendingTool: null, lastBlock: null };
  let text: string;
  try {
    text = await readWindow(file, maxBytes);
  } catch {
    return tail;
  }

  // The app streams one assistant message as several records, one content block each,
  // sharing message.id; parallel tool calls land in separate records.
  let finalAssistant: Rec | null = null;
  const answers: { messageId: string | null; texts: string[] }[] = [];
  const toolUses: { block: Block; at: number; time: number }[] = [];
  const lastResultAt = new Map<string, { at: number; time: number; failed: boolean }>();
  let lastPromptAt = 0;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let at = 0;
  const turn = new ClaudeTurnTracker();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: Rec;
    try {
      r = JSON.parse(line) as Rec;
    } catch {
      continue;
    }
    if (typeof r !== 'object' || r === null || r.isSidechain === true) continue;
    at++;
    turn.add(r as ClaudeRecord);
    const time = Date.parse(str(r.timestamp) ?? '');

    const branch = str(r.gitBranch);
    if (branch !== null) tail.branch = cut(branch);

    if (r.type === 'custom-title') {
      customTitle = str(r.customTitle)?.trim() || customTitle;
    } else if (r.type === 'ai-title') {
      aiTitle = str(r.aiTitle)?.trim() || aiTitle;
    } else if (r.type === 'last-prompt') {
      const p = str(r.lastPrompt);
      if (p !== null) tail.lastPrompt = cut(promptLine(p));
    } else if (r.type === 'assistant') {
      finalAssistant = r;
      const model = str(r.message?.model);
      if (model !== null) tail.model = cut(model);
      const blocks = blocksOf(r);
      const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
      answers.push({ messageId: str(r.message?.id), texts });
      for (const b of blocks) if (b.type === 'tool_use' && typeof b.name === 'string') toolUses.push({ block: b, at, time });
    } else if (r.type === 'user') {
      if (isPrompt(r)) lastPromptAt = at;
      for (const b of blocksOf(r)) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') lastResultAt.set(b.tool_use_id, { at, time, failed: b.is_error === true });
      }
    }
  }

  if (turn.completedAt !== undefined) tail.completedAt = turn.completedAt;
  const title = customTitle ?? aiTitle;
  if (title !== null) titles.set(file, cut(title));
  const known = titles.get(file);
  if (known !== undefined) tail.title = known;

  const answer = answers.findLast((a) => a.texts.length > 0);
  if (answer) {
    const texts = answer.messageId === null
      ? answer.texts
      : answers.filter((a) => a.messageId === answer.messageId).flatMap((a) => a.texts);
    tail.lastAnswer = cut(texts.join('\n\n'));
  }

  // A call from an earlier turn that never got a result (interrupted, say) is not pending now.
  const pending = toolUses.findLast(({ block, at: usedAt }) => {
    if (usedAt < lastPromptAt) return false;
    const resultAt = typeof block.id === 'string' ? lastResultAt.get(block.id)?.at : undefined;
    return resultAt === undefined || resultAt < usedAt;
  });
  if (pending) tail.pendingTool = { name: cut(pending.block.name as string), input: cutInput(pending.block.input) };

  const recent: RunStep[] = [];
  for (let i = toolUses.length - 1; i >= 0 && recent.length < 2; i--) {
    const use = toolUses[i]!;
    if (use.at < lastPromptAt) break;
    const result = typeof use.block.id === 'string' ? lastResultAt.get(use.block.id) : undefined;
    if (result && result.at > use.at) recent.unshift(finishedStep(use.block, result.failed, result.time - use.time));
  }
  if (recent.length) tail.recentSteps = recent;

  if (finalAssistant) {
    const last = blocksOf(finalAssistant).at(-1)?.type;
    tail.lastBlock = last === 'text' || last === 'thinking' || last === 'tool_use' ? last : null;
  }
  const interruption = turn.result(true);
  if (interruption) tail.interruption = interruption;
  return tail;
}
