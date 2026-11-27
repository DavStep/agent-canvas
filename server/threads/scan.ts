// The scan: read the conversations that changed, find the loops the owner left open, ask the small
// model about the ones not seen before, and keep the answers. Everything here is built to stay
// cheap — an unchanged conversation is not read, a candidate is judged once ever, and one run
// makes at most a handful of model calls.
import { isAgentDirectory } from '../../shared/agentConnection.ts';
import type { OpenThread } from '../../shared/threads.ts';
import { threadKey } from '../../shared/threads.ts';
import { folderOf } from '../activity.ts';
import { looksAnswered, openLoops } from './detect.ts';
import type { Judge } from './judge.ts';
import { claudeFiles, codexFiles, readChat, shortName, type ChatFile } from './sources.ts';
import type { ThreadStore } from './store.ts';

const MIN = 60_000;
/** How long a chat must have been quiet before an unanswered ask counts as forgotten. */
export const DEFAULT_IDLE_MS = 30 * MIN;
/** How often the scan runs. */
export const DEFAULT_EVERY_MS = 6 * MIN;
const DEFAULT_MAX_JUDGE = 5;
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * MIN;
/** A conversation shorter than this is not a discussion worth a ticket. */
const DEFAULT_MIN_TURNS = 4;

export interface ScanOptions {
  store: ThreadStore;
  /** <claudeHome>/projects: Claude Code's transcripts, the canvas agent's chat among them. */
  claudeProjects: string;
  /** Codex's home, for its rollout files; null or absent: no Codex chats are read. */
  codexHome?: string | null;
  /** null: nothing is confirmed, so no tickets are made (signed out, say); they are tried again later. */
  judge?: Judge | null;
  now?: () => number;
  idleMs?: number;
  /** Model calls one run may make (5 by default). */
  maxJudge?: number;
  /** Conversations read per provider, newest first (40 by default). */
  maxFiles?: number;
  /** Conversations untouched for longer than this are left alone (14 days by default). */
  maxAgeMs?: number;
  minTurns?: number;
  /** The canvas agent's folder: its own chat is read like any other, and named as itself. */
  agentCwd?: string | null;
  /** A card's name as the canvas shows it, when it is on the canvas. */
  nameOf?: (cardId: string) => string | undefined;
}

export interface ScanResult {
  /** Tickets made. */
  added: number;
  /** Model calls spent. */
  judged: number;
  /** Threads the source chat took up again. */
  resolved: number;
  /** Conversations read (an unchanged one is not). */
  read: number;
}

const ago = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/** One pass over the conversations on disk. */
export async function scanOnce(opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? Date.now;
  const store = opts.store;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const minTurns = opts.minTurns ?? DEFAULT_MIN_TURNS;
  let budget = opts.maxJudge ?? DEFAULT_MAX_JUDGE;
  const result: ScanResult = { added: 0, judged: 0, resolved: 0, read: 0 };

  const files: ChatFile[] = [
    ...await claudeFiles(opts.claudeProjects, maxFiles),
    ...(opts.codexHome ? await codexFiles(opts.codexHome, maxFiles) : []),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files) {
    const at = now();
    if (at - file.mtimeMs > maxAgeMs) continue;
    const cursor = store.cursor(file.id);
    if (cursor !== undefined && cursor.mtimeMs === file.mtimeMs && cursor.size === file.size) continue;
    const chat = await readChat(file);
    result.read++;
    if (chat.turns.length < minTurns) {
      store.setCursor(file.id, { mtimeMs: file.mtimeMs, size: file.size });
      continue;
    }

    // A thread the source chat has since taken up again closes itself.
    for (const open of store.list()) {
      if (open.sessionId !== file.id) continue;
      const later = chat.turns.filter((t) => t.role === 'user' && t.at > open.askedAt).map((t) => t.text);
      if (later.length > 0 && looksAnswered(open.question, later)) {
        store.markDone(open.id);
        result.resolved++;
      }
    }

    const isAgentChat = isAgentDirectory(opts.agentCwd ?? undefined, chat.cwd);
    const name = opts.nameOf?.(file.id) ?? (isAgentChat ? 'Canvas agent' : chat.name);
    let allDecided = true;
    for (const loop of openLoops(chat.turns, { now: at, idleMs })) {
      const id = threadKey(file.id, loop.askedAt, loop.question);
      if (store.known(id)) continue;
      const seen = store.judgement(id);
      if (seen !== undefined) continue; // asked once already, and the answer was no
      if (!opts.judge || budget <= 0) {
        allDecided = false; // read again on a later scan, when there is budget (or access)
        continue;
      }
      budget--;
      result.judged++;
      const verdict = await opts.judge({
        folder: chat.cwd,
        sessionName: name,
        provider: file.provider,
        excerpt: loop.excerpt,
        question: loop.question,
        after: loop.after,
        ago: ago(at - loop.askedAt),
      });
      if (verdict === null) {
        allDecided = false; // could not tell (no access, a timeout): asked again later
        continue;
      }
      store.noteJudged(id, verdict.open, at);
      if (!verdict.open) continue;
      const thread: OpenThread = {
        id,
        title: verdict.title || shortName(name) || 'Open question',
        summary: verdict.summary || loop.question,
        question: verdict.question || loop.question,
        sessionId: file.id,
        sessionName: name,
        provider: file.provider,
        cwd: chat.cwd,
        folder: folderOf(chat.cwd),
        askedAt: loop.askedAt,
        foundAt: at,
        excerpt: loop.excerpt,
        state: 'open',
      };
      result.added += store.add([thread]);
    }
    if (allDecided) store.setCursor(file.id, { mtimeMs: file.mtimeMs, size: file.size });
  }
  return result;
}

export interface ScannerOptions extends ScanOptions {
  everyMs?: number;
  /** How long after start() the first scan runs (20 s by default), so start-up stays quiet. */
  firstDelayMs?: number;
}

/** Runs the scan on a timer, one at a time. */
export class ThreadScanner {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<ScanResult> | null = null;
  private stopped = false;

  constructor(private readonly opts: ScannerOptions) {}

  start(): void {
    if (this.timer !== null || this.stopped) return;
    // Start-up stays quiet: the first scan waits, and never runs after stop().
    this.first = setTimeout(() => { this.first = null; void this.run(); }, this.opts.firstDelayMs ?? 20_000);
    this.first.unref?.();
    this.timer = setInterval(() => { void this.run(); }, this.opts.everyMs ?? DEFAULT_EVERY_MS);
    this.timer.unref?.();
  }

  /** Scans now (or joins the scan in flight). */
  run(): Promise<ScanResult> {
    if (this.running !== null) return this.running;
    this.running = scanOnce(this.opts)
      .catch((err: unknown): ScanResult => {
        process.stderr.write(`agent-canvas: open threads scan failed: ${(err as Error).message}\n`);
        return { added: 0, judged: 0, resolved: 0, read: 0 };
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  /** Stops the timer, lets a scan in flight finish, then writes what is waiting. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.first !== null) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
    await this.running?.catch(() => {});
    await this.opts.store.flush();
  }
}
