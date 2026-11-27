// Reads local Codex thread metadata and turn history through read-only SQLite connections.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ActivityEntry, RunStep, SessionInterruption, SessionView } from '../../shared/types.ts';
import { codexCutOff, codexFailure } from '../interruptions.ts';
import { unwrapShell } from '../engines/codex/map.ts';
import { folderOf } from '../activity.ts';
import { readWindow } from './transcript.ts';
import { promptLine } from '../../shared/attachments.ts';

const THREAD_LIMIT = 40;
const ACTIVE_WINDOW_MS = 15 * 60_000;
const MAX_TEXT = 2000;

interface Thread {
  id: string;
  cwd: string;
  projectRoot: string | null;
  rolloutPath: string;
  name: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  branch: string | null;
  model: string | null;
  effort?: string | null;
}

interface History {
  recentSteps?: RunStep[];
  commentary?: string | null;
  status: string;
  /** The limit or error a failed turn ended on. */
  interruption?: SessionInterruption | null;
  startedAt: number | null;
  completedAt: number | null;
  lastPrompt: string | null;
  lastAnswer: string | null;
  /** A question Codex asked that no user message has followed yet: its title, or '' when it has none. */
  question: string | null;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_TEXT) : null;
/** What the owner said, without the block of files attached to it. */
const said = (value: unknown): string | null => {
  const t = text(value);
  return t === null ? null : promptLine(t) || null;
};

/** The title of the first question an agent message asks, '' when it asks untitled ones, else null.
    Codex asks with `request_user_input_async`: the turn runs on, and only this message tells it. */
function questionOf(questions: unknown): string | null {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const first = questions[0] as Record<string, unknown> | null;
  return text(first?.title) ?? text(first?.question) ?? '';
}

function databasePath(home: string, files: string[], prefix: string): string | null {
  const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`);
  const found = files.flatMap((file) => {
    const match = pattern.exec(file);
    return match ? [{ file, version: Number(match[1]) }] : [];
  }).sort((a, b) => b.version - a.version)[0];
  return found ? path.join(home, found.file) : null;
}

function readThreads(db: DatabaseSync, active: string[]): Thread[] {
  const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => column.name));
  const tables = new Set(db.prepare('SELECT name FROM sqlite_schema WHERE type = ?').all('table').map((table) => table.name));
  const name = columns.has('name') ? "coalesce(nullif(name, ''), title)" : 'title';
  const preview = columns.has('preview') ? 'preview' : columns.has('first_user_message') ? 'first_user_message' : 'title';
  const created = columns.has('created_at_ms') ? 'coalesce(created_at_ms, created_at * 1000)' : 'created_at * 1000';
  const updated = columns.has('updated_at_ms') ? 'coalesce(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000';
  const model = columns.has('model') ? 'model' : 'NULL';
  const effort = columns.has('reasoning_effort') ? 'reasoning_effort' : 'NULL';
  const projectRoot = columns.has('project_id') && tables.has('project_roots')
    ? '(SELECT path FROM project_roots WHERE project_id = threads.project_id ORDER BY position LIMIT 1)'
    : 'NULL';
  const userThreads = columns.has('thread_source')
    ? "AND (thread_source IS NULL OR thread_source IN ('user', 'agent_created_thread'))"
    : '';
  const fields = `id, cwd, rollout_path AS rolloutPath, ${projectRoot} AS projectRoot,
           substr(${name}, 1, ${MAX_TEXT}) AS name, substr(${preview}, 1, ${MAX_TEXT}) AS preview,
           ${created} AS createdAt, ${updated} AS updatedAt, git_branch AS branch, ${model} AS model, ${effort} AS effort`;
  const visible = `archived = 0 AND source IN ('cli', 'vscode') AND (has_user_event = 1 OR ${preview} <> '') ${userThreads}`;
  const select = `SELECT ${fields} FROM threads WHERE ${visible}`;
  // Sorting on coalesce scans the entire thread archive every second. Walk Codex's time index
  // for the modern rows, merge any older second-resolution rows, then fetch just the winners.
  const indexed = columns.has('updated_at_ms') && db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'threads' AND name = 'idx_threads_updated_at_ms'",
  ).get();
  const latest = indexed ? `
    WITH newest AS (
      SELECT id, updated_at_ms AS stamp FROM threads INDEXED BY idx_threads_updated_at_ms
        WHERE updated_at_ms IS NOT NULL AND ${visible}
      UNION ALL
      SELECT id, updated_at * 1000 AS stamp FROM threads INDEXED BY idx_threads_updated_at_ms
        WHERE updated_at_ms IS NULL AND ${visible}
      ORDER BY stamp DESC, id DESC LIMIT ?
    )
    SELECT ${fields} FROM threads WHERE id IN (SELECT id FROM newest) ORDER BY updatedAt DESC, id DESC`
    : `${select} ORDER BY updatedAt DESC, id DESC LIMIT ?`;
  const recent = db.prepare(latest).all(THREAD_LIMIT) as unknown as Thread[];
  const missing = active.filter(id => !recent.some(t => t.id === id));
  if (!missing.length) return recent;
  const extra = db.prepare(`${select} AND id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(missing)) as unknown as Thread[];
  return recent.concat(extra);
}

/** Completions from before the log was installed or while the app was closed, including
    previous turns of a chat that is already working on something else. */
export async function recentCodexCompletions(home: string, limit: number): Promise<ActivityEntry[]> {
  const files = await fs.readdir(home).catch(() => []);
  const stateFile = databasePath(home, files, 'state');
  const historyFile = databasePath(home, files, 'thread_history');
  if (!stateFile || !historyFile) return [];
  const state = new DatabaseSync(stateFile, { readOnly: true });
  let threads: Thread[];
  try { threads = readThreads(state, []); } finally { state.close(); }
  const byId = new Map(threads.map(t => [t.id, t]));
  const db = new DatabaseSync(historyFile, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT thread_id, completed_at FROM thread_turns
      WHERE thread_id IN (SELECT value FROM json_each(?)) AND status = 'completed' AND completed_at > 0
      ORDER BY completed_at DESC, thread_id, rollout_ordinal DESC LIMIT ?`).all(JSON.stringify([...byId.keys()]), limit);
    return rows.map(row => {
      const t = byId.get(String(row.thread_id))!;
      const at = Number(row.completed_at) * 1000;
      return { sessionId: `codex:${t.id}`, kind: 'reply', name: (text(t.name) ?? said(t.preview) ?? '').slice(0, 240),
        folder: folderOf(t.projectRoot || t.cwd), at, sourceAt: at };
    });
  } finally { db.close(); }
}

function historyReader(db: DatabaseSync): (id: string) => History | null {
  const turnColumns = new Set(db.prepare('PRAGMA table_info(thread_turns)').all().map((column) => column.name));
  const errorColumn = turnColumns.has('error_json') ? 'CASE WHEN json_valid(error_json) THEN error_json END' : 'NULL';
  const latest = db.prepare(`
    SELECT status, started_at AS startedAt, completed_at AS completedAt, ${errorColumn} AS error
    FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1
  `);
  const prompt = db.prepare(`
    WITH last_message AS (
      SELECT item_json FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage'
      ORDER BY rollout_ordinal DESC LIMIT 1
    )
    SELECT substr(group_concat(json_extract(part.value, '$.text'), char(10)), 1, ${MAX_TEXT}) AS message
    FROM last_message, json_each(last_message.item_json, '$.content') AS part
    WHERE json_extract(part.value, '$.type') = 'text'
  `);
  const answer = db.prepare(`
    SELECT substr(json_extract(item_json, '$.text'), 1, ${MAX_TEXT}) AS message
    FROM thread_items WHERE thread_id = ? AND item_type = 'agentMessage'
      AND coalesce(json_extract(item_json, '$.phase'), 'final_answer') = 'final_answer'
    ORDER BY rollout_ordinal DESC LIMIT 1
  `);
  const commentary = db.prepare(`
    SELECT substr(json_extract(item_json, '$.text'), 1, ${MAX_TEXT}) AS message
    FROM thread_items WHERE thread_id = ?1 AND item_type = 'agentMessage' AND json_extract(item_json, '$.phase') = 'commentary'
      AND rollout_ordinal > coalesce((SELECT max(rollout_ordinal) FROM thread_items WHERE thread_id = ?1 AND item_type = 'userMessage'), -1)
    ORDER BY rollout_ordinal DESC LIMIT 1
  `);
  const question = db.prepare(`
    SELECT json_extract(item_json, '$.questions') AS questions
    FROM thread_items WHERE thread_id = ?1 AND item_type = 'agentMessage'
      AND json_array_length(item_json, '$.questions') > 0
      AND rollout_ordinal > coalesce((SELECT max(rollout_ordinal) FROM thread_items
        WHERE thread_id = ?1 AND item_type = 'userMessage'), -1)
    ORDER BY rollout_ordinal DESC LIMIT 1
  `);
  // Project just the short tool metadata. A file change's diff or a command's output can be large.
  const steps = db.prepare(`
    SELECT item_type AS type, json_extract(item_json, '$.status') AS status,
           substr(json_extract(item_json, '$.command'), 1, 240) AS command,
           substr(json_extract(item_json, '$.changes[0].path'), 1, 500) AS file,
           coalesce(json_extract(item_json, '$.appContext.actionName'), json_extract(item_json, '$.tool')) AS tool,
           json_extract(item_json, '$.durationMs') AS durationMs
    FROM thread_items WHERE thread_id = ?1 AND item_type IN ('commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall')
      AND rollout_ordinal > coalesce((SELECT max(rollout_ordinal) FROM thread_items
        WHERE thread_id = ?1 AND item_type = 'userMessage'), -1)
    ORDER BY rollout_ordinal DESC LIMIT 2
  `);
  return (id) => {
    const row = latest.get(id) as (Pick<History, 'status' | 'startedAt' | 'completedAt'> & { error: string | null }) | undefined;
    if (row === undefined) return null;
    const { error, ...turn } = row;
    const asked = question.get(id)?.questions;
    return {
      ...turn,
      interruption: turn.status === 'failed'
        ? codexFailure(error === null ? null : JSON.parse(error), (turn.completedAt ?? turn.startedAt ?? 0) * 1000) : null,
      commentary: turn.status === 'inProgress' ? text(commentary.get(id)?.message) : null,
      recentSteps: turn.status !== 'inProgress' ? [] : steps.all(id).reverse().flatMap((row): RunStep[] => {
        const status = row.status === 'completed' ? 'done' : row.status === 'inProgress' ? 'running'
          : row.status === 'failed' || row.status === 'declined' ? 'failed' : null;
        if (!status) return [];
        const kind = row.type === 'fileChange' ? 'edit' : row.type === 'commandExecution' ? 'command' : 'tool';
        const label = kind === 'edit' ? `Edit ${path.basename(text(row.file) ?? '')}`
          : kind === 'command' ? unwrapShell(text(row.command) ?? 'Shell command') : text(row.tool) ?? 'Tool call';
        return [{ kind, label: label.trim().replace(/\s+/g, ' ').slice(0, 160), status,
          ...(typeof row.durationMs === 'number' && row.durationMs >= 0 ? { durationMs: row.durationMs } : {}) }];
      }),
      lastPrompt: said(prompt.get(id)?.message), lastAnswer: text(answer.get(id)?.message),
      question: typeof asked === 'string' ? questionOf(JSON.parse(asked)) : null,
    };
  };
}

async function rolloutHistory(file: string): Promise<History | null> {
  const history: History = { status: '', startedAt: null, completedAt: null, lastPrompt: null, lastAnswer: null, question: null };
  for (const line of (await readWindow(file)).split('\n')) {
    const record = parseRecord(line);
    if (record?.type !== 'event_msg' || record.payload == null) continue;
    const event = record.payload;
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) / 1000 : NaN;
    const timestamp = Number.isFinite(at) ? at : null;
    switch (event.type) {
      case 'task_started':
        history.status = 'inProgress';
        history.interruption = null;
        history.commentary = null;
        history.question = null;
        history.startedAt = timestamp;
        history.completedAt = null;
        break;
      case 'task_complete':
      case 'turn_aborted':
        history.status = event.type === 'task_complete' ? (history.interruption ? 'failed' : 'completed') : 'interrupted';
        // An abort is left alone: it is as likely the owner's own Stop.
        if (event.type === 'turn_aborted') history.interruption = null;
        history.completedAt = timestamp;
        history.lastAnswer = text(event.last_agent_message) ?? history.lastAnswer;
        break;
      case 'error':
        // The error a turn failed on (a usage limit, say): task_complete or nothing follows.
        history.interruption = codexFailure({ message: event.message, codexErrorInfo: event.codex_error_info }, (timestamp ?? 0) * 1000);
        break;
      case 'user_message':
        history.lastPrompt = said(event.message);
        history.question = null; // An answer arrives as a user message.
        break;
      case 'item_completed': {
        const item = event.item as Record<string, unknown> | null | undefined;
        if (!item) break;
        const content = Array.isArray(item.content) ? item.content.flatMap(part => typeof part?.text === 'string' ? [part.text] : []).join('\n') : '';
        if (item.type === 'UserMessage') {
          history.lastPrompt = said(content) ?? history.lastPrompt;
          history.question = null;
        } else if (item.type === 'AgentMessage') {
          if (item.phase === 'commentary') history.commentary = text(content);
          else history.lastAnswer = text(content) ?? history.lastAnswer;
          history.question = questionOf(item.questions) ?? history.question;
        }
        break;
      }
      case 'agent_message':
        if (event.phase === 'commentary') history.commentary = text(event.message);
        else history.lastAnswer = text(event.message) ?? history.lastAnswer;
        break;
    }
  }
  return history.status || history.lastPrompt || history.lastAnswer ? history : null;
}

function parseRecord(line: string): { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> } | null {
  try {
    return JSON.parse(line);
  } catch {
    return null; // A partially written line will be read again after the file changes.
  }
}

export class CodexReader {
  private readonly rollouts = new Map<string, { mtime: number; history: History | null }>();

  private activeIndex: { file: string; at: number; ids: string[] } | null = null;

  constructor(private readonly home: string) {}

  async read(now: number): Promise<SessionView[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.home);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const stateFile = databasePath(this.home, files, 'state');
    if (stateFile === null) return [];
    const historyFile = databasePath(this.home, files, 'thread_history');
    const historyDb = historyFile === null ? null : new DatabaseSync(historyFile, { readOnly: true });
    try {
      // The history limit is for idle cards. A long-running turn may have started before
      // dozens of newer sessions and still be writing its rollout.
      if (historyDb && historyFile && (!this.activeIndex || this.activeIndex.file !== historyFile || now - this.activeIndex.at >= 30_000)) {
        const active = historyDb.prepare(`SELECT thread_id FROM thread_turns t WHERE status = 'inProgress'
          AND NOT EXISTS (SELECT 1 FROM thread_turns newer WHERE newer.thread_id=t.thread_id AND newer.rollout_ordinal>t.rollout_ordinal)`).all();
        this.activeIndex = { file: historyFile, at: now, ids: active.map(row => String(row.thread_id)) };
      }
      const stateDb = new DatabaseSync(stateFile, { readOnly: true });
      let threads: Thread[];
      try { threads = readThreads(stateDb, historyDb ? this.activeIndex?.ids ?? [] : []); }
      finally { stateDb.close(); }
      const readHistory = historyDb === null ? () => null : historyReader(historyDb);
      const rolloutPaths = new Set(threads.map((thread) => thread.rolloutPath));
      for (const file of this.rollouts.keys()) if (!rolloutPaths.has(file)) this.rollouts.delete(file);
      const views = await Promise.all(threads.map((thread) => this.toView(thread, readHistory(thread.id), now)));
      return views.filter((view, i) => i < THREAD_LIMIT || view.state === 'working' || view.state === 'needs_you');
    } finally {
      historyDb?.close();
    }
  }

  private async toView(thread: Thread, stored: History | null, now: number): Promise<SessionView> {
    let history = stored;
    let lastWrite = thread.updatedAt;
    if (thread.rolloutPath !== '' && (!stored || stored.status === 'inProgress' || now - thread.updatedAt <= ACTIVE_WINDOW_MS)) {
      try {
        const { mtimeMs } = await fs.stat(thread.rolloutPath);
        lastWrite = Math.max(lastWrite, mtimeMs);
        const indexedAt = (stored?.completedAt ?? stored?.startedAt ?? 0) * 1000;
        if (!stored || (now - mtimeMs <= ACTIVE_WINDOW_MS && mtimeMs > indexedAt + 1000)) {
          let cached = this.rollouts.get(thread.rolloutPath);
          if (cached?.mtime !== mtimeMs) {
            cached = { mtime: mtimeMs, history: await rolloutHistory(thread.rolloutPath) };
            this.rollouts.set(thread.rolloutPath, cached);
          }
          const tail = cached.history;
          if (!stored) history = tail;
          else if (tail?.status && (tail.completedAt ?? tail.startedAt ?? 0) * 1000 > indexedAt + 999) {
            history = { ...stored, ...tail, lastPrompt: tail.lastPrompt ?? stored.lastPrompt, lastAnswer: tail.lastAnswer ?? stored.lastAnswer };
          }
        }
      } catch {
        // A rollout can be moved or pruned while its index row still exists.
      }
    }
    const working = history?.status === 'inProgress' && now - lastWrite <= ACTIVE_WINDOW_MS;
    const asking = history?.question != null;
    const state = asking ? 'needs_you' : working ? 'working' : history?.status === 'inProgress' ? 'unknown' : 'idle';
    const at = working ? history?.startedAt : history?.completedAt;
    // A failed turn's limit or error; a turn left in progress that nothing writes to any more was
    // cut off (its process is gone). The store makes it the card's state.
    const interruption = asking || working || !history ? null
      : history.status === 'inProgress' ? (history.startedAt != null ? codexCutOff(history.startedAt * 1000) : null)
      : history.interruption ?? null;
    return {
      id: `codex:${thread.id}`,
      provider: 'codex',
      hostId: thread.id,
      name: text(thread.name) ?? said(thread.preview) ?? '',
      cwd: thread.cwd,
      folder: folderOf(thread.projectRoot || thread.cwd),
      state,
      need: asking ? 'question' : null,
      activity: asking ? history?.question || 'Has a question' : working ? history?.commentary ?? null : null,
      ...(history?.recentSteps?.length ? { recentSteps: history.recentSteps } : {}),
      ...(interruption ? { interruption } : {}),
      rawStatus: history?.status ?? '',
      stateSince: at == null ? thread.updatedAt : at * 1000,
      startedAt: thread.createdAt,
      branch: thread.branch === 'HEAD' ? null : thread.branch,
      model: thread.model,
      ...(thread.effort ? { effort: thread.effort } : {}),
      lastPrompt: history?.lastPrompt ?? said(thread.preview),
      lastAnswer: history?.lastAnswer ?? null,
      subagents: [],
      // The store decides who holds it.
      owner: 'nobody',
      ownerNote: null,
      host: null,
    };
  }
}
