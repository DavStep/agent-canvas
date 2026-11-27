// A Claude transcript → pages of ChatItems, newest first. Transcripts pass 100 MB, so a page reads
// backwards from its end in chunks and stops once it holds enough items; nothing reads a whole file.
import fs from 'node:fs/promises';
import type { ChatItem, ImageRef } from '../../../shared/chat.ts';
import { classifyClaudeTool, settleTool } from './map.ts';

const CHUNK = 256 * 1024;

export interface HistoryPage { items: ChatItem[]; hasOlder: boolean; cursor: string | null }

type Block = {
  type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown;
  tool_use_id?: unknown; content?: unknown; is_error?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown };
};
type Rec = {
  type?: unknown; uuid?: unknown; timestamp?: unknown; isSidechain?: unknown; isMeta?: unknown; isCompactSummary?: unknown;
  message?: { id?: unknown; content?: unknown };
};
interface Line { offset: number; rec: Rec }

/** An item with the byte offsets of the first and last record it came from. */
interface Built { item: ChatItem; first: number; last: number }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const time = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const blocksOf = (content: unknown): Block[] =>
  Array.isArray(content) ? content.filter((b): b is Block => typeof b === 'object' && b !== null) : [];

/** Slash commands are recorded as tags; their output and caveats are not the owner's words. */
function typedText(text: string): string | null {
  if (text.startsWith('<local-command-')) return null;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (name === undefined) return text;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

function userItem(rec: Rec, id: string, at: number): ChatItem | null {
  if (rec.isCompactSummary === true) return { kind: 'notice', id, at, level: 'info', text: 'Earlier conversation compacted' };
  const content = rec.message?.content;
  const texts: string[] = [];
  const images: ImageRef[] = [];
  if (typeof content === 'string') texts.push(content);
  for (const b of blocksOf(content)) {
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') {
      const mime = str(b.source.media_type) ?? 'image/png';
      images.push({ mime, dataUrl: `data:${mime};base64,${b.source.data}` });
    }
  }
  const text = typedText(texts.join('\n\n'));
  if (text === null || (text === '' && images.length === 0)) return null; // tool results only, or command output
  return { kind: 'user', id, at, text, images };
}

/** Records in file order → items. Records of one assistant message (one per block) share message.id.
    A record whose uuid was taken already (earlier in the window, or by a newer page) is a copy the
    CLI re-appended: it is skipped. `orphan` is the last result whose call is not in the window. */
function buildItems(lines: Line[], atStart: boolean, taken: ReadonlySet<string>): { built: Built[]; taint: number; orphan: number; kept: Line[] } {
  const out: Built[] = [];
  const texts = new Map<string, Built>();
  const tools = new Map<string, Built>();
  const add = (item: ChatItem, offset: number): Built => {
    const built = { item, first: offset, last: offset };
    out.push(built);
    return built;
  };
  /** Appends a block's text to this message's item of that kind, or starts one. */
  const addText = (id: string, kind: 'assistant' | 'reasoning', text: string, at: number, offset: number): void => {
    const open = texts.get(id);
    if (open && (open.item.kind === 'assistant' || open.item.kind === 'reasoning')) {
      open.item.text += `\n\n${text}`;
      open.last = offset;
      return;
    }
    const item: ChatItem = kind === 'assistant'
      ? { kind, id, at, text, streaming: false }
      : { kind, id, at, text, streaming: false, durationMs: null };
    texts.set(id, add(item, offset));
  };

  // Records that may belong to an item begun before the window: no page may start at or before them.
  let taint = -1;
  let orphan = -1;
  let firstMessage: string | null = null;
  let sawPrompt = atStart;
  const seen = new Set<string>();
  const kept: Line[] = [];
  for (const line of lines) {
    const { offset, rec } = line;
    const uuid = str(rec.uuid);
    if (uuid !== null) {
      if (seen.has(uuid) || taken.has(uuid)) continue;
      seen.add(uuid);
      kept.push(line);
    }
    if (rec.isSidechain === true || rec.isMeta === true) continue;
    const at = time(rec.timestamp);
    if (rec.type === 'assistant') {
      const messageId = str(rec.message?.id) ?? str(rec.uuid) ?? `assistant@${offset}`;
      // Messages follow one another, so only the window's first one can have blocks before it
      // (unless a prompt came first, which starts a fresh message).
      if (!sawPrompt && firstMessage === null) firstMessage = messageId;
      for (const b of blocksOf(rec.message?.content)) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') addText(messageId, 'assistant', b.text, at, offset);
        else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
          addText(`${messageId}:thinking`, 'reasoning', b.thinking, at, offset);
        } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          const { tool, target, diffs, output } = classifyClaudeTool(b.name, b.input);
          tools.set(b.id, add({
            kind: 'tool', id: b.id, at, tool, name: b.name, target, status: 'running', output: output ?? null, exitCode: null, diffs,
          }, offset));
        }
      }
    } else if (rec.type === 'user') {
      for (const b of blocksOf(rec.message?.content)) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const call = tools.get(b.tool_use_id);
        if (call?.item.kind === 'tool') {
          call.item = settleTool(call.item, b);
          call.last = offset;
        } else if (!atStart) {
          orphan = Math.max(orphan, offset); // its call is before the window: the older page owns it
        }
      }
      const prompt = userItem(rec, str(rec.uuid) ?? `user@${offset}`, at);
      if (prompt) {
        add(prompt, offset);
        if (prompt.kind === 'user') sawPrompt = true;
      }
    }
  }
  if (firstMessage !== null) {
    for (const id of [firstMessage, `${firstMessage}:thinking`]) taint = Math.max(taint, texts.get(id)?.last ?? -1);
  }
  return { built: out, taint, orphan, kept };
}

/** With a page's worth of items but no safe cut, past this much window a short page beats reading on. */
const FULL_PAGE_BYTES = 2 * 1024 * 1024;
/** A result whose call is not in the window holds the page back until the window reaches this far:
    a call up to 8 MB back still gets its result; one never found stops costing a whole-file read. */
const ORPHAN_CAP_BYTES = 8 * 1024 * 1024;

/** The page's items, or null when the window must grow to be sure of them. */
function page(lines: Line[], limit: number, atStart: boolean, windowBytes: number, taken: Set<string>): HistoryPage | null {
  const { built, taint, orphan, kept } = buildItems(lines, atStart, taken);
  if (built.length === 0) return atStart ? { items: [], hasOlder: false, cursor: null } : null;
  if (built.length < limit && !atStart) return null; // too few items yet: read further back
  // A page may start at item k only if no older item has a record at or after it (a call whose
  // result comes later, a message whose blocks continue) and nothing tainted lies at or after it.
  const olderLast: number[] = [];
  let max = -1;
  for (const b of built) {
    olderLast.push(max);
    max = Math.max(max, b.last);
  }
  const k0 = Math.max(0, built.length - limit);
  const cut = (tainted: number): number | null => {
    const safe = (k: number): boolean => built[k]!.first > tainted && olderLast[k]! < built[k]!.first;
    let k = k0;
    while (k >= 0 && !safe(k)) k--;
    if (k >= 0) return k;
    // Enough items, but an item spans every cut (a call whose result is far later, say). Read on
    // a little in case it fits, then settle for a short page of the newer items it does not span.
    if (windowBytes < FULL_PAGE_BYTES) return null;
    k = k0 + 1;
    while (k < built.length && !safe(k)) k++;
    return k === built.length ? null : k;
  };
  let k = cut(Math.max(taint, orphan));
  // An orphan result whose call is not within 8 MB (or nowhere: then it would read to the file
  // start) no longer holds the page back: it is left unowned and its call, if older, stays running.
  if (k === null && windowBytes >= ORPHAN_CAP_BYTES) k = cut(taint);
  if (k === null) return null;
  // Every item in the window is on the page: read on, so hasOlder is true only if something older
  // yields an item (a file may start with records that make none, such as a large summary).
  if (k === 0 && !atStart && windowBytes < FULL_PAGE_BYTES) return null;
  const first = built[k]!; // at the file start item 0 is always safe
  // Records from the cut on are this page's: an older page skips any other copy of them.
  for (const line of kept) if (line.offset >= first.first) taken.add(str(line.rec.uuid)!);
  return { items: built.slice(k).map((b) => b.item), hasOlder: k > 0 || !atStart, cursor: String(first.first) };
}

function parseLines(data: Buffer, from: number, base: number): Line[] {
  const lines: Line[] = [];
  let at = from;
  while (at < data.length) {
    const nl = data.indexOf(0x0a, at);
    const end = nl === -1 ? data.length : nl;
    if (end > at) {
      try {
        const rec = JSON.parse(data.toString('utf8', at, end)) as unknown;
        if (typeof rec === 'object' && rec !== null) lines.push({ offset: base + at, rec: rec as Rec });
      } catch {
        // a torn last line while the CLI writes, or a stray non-JSON line
      }
    }
    at = end + 1;
  }
  return lines;
}

function endOf(before: string | null, size: number): number {
  if (before === null) return size;
  const n = Number(before);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Bad history cursor: ${before}`);
  return Math.min(n, size);
}

/** The `limit` newest items before `before` (a cursor from an earlier page; null for the newest).
    `taken` collects the uuids of records shown so far: pass one set for all pages of a chat, so a
    record the CLI re-appended appears once however the pages fall. */
export async function claudeHistory(
  file: string, opts: { limit: number; before: string | null; taken?: Set<string> },
): Promise<HistoryPage> {
  const taken = opts.taken ?? new Set<string>();
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const end = endOf(opts.before, size);
    let pos = end; // bytes from pos on are parsed already, or held in carry
    let carry = Buffer.alloc(0); // the end of a line that starts before pos
    let lines: Line[] = [];
    for (;;) {
      const start = Math.max(0, pos - CHUNK);
      const buf = Buffer.alloc(pos - start);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await handle.read(buf, got, buf.length - got, start + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const data = Buffer.concat([buf.subarray(0, got), carry]);
      let from = 0;
      if (start > 0) {
        const nl = data.indexOf(0x0a);
        if (nl === -1) { // one line longer than a chunk: keep reading back to its start
          carry = data;
          pos = start;
          continue;
        }
        from = nl + 1;
      }
      carry = data.subarray(0, from);
      lines = parseLines(data, from, start).concat(lines);
      pos = start;
      const result = page(lines, Math.max(1, opts.limit), start === 0, end - start, taken);
      if (result) return result;
    }
  } finally {
    await handle.close();
  }
}
