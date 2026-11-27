import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexReader, recentCodexCompletions } from './codex.ts';

const NOW = 1795000000000;
const MIN = 60_000;

interface Row { id: string; updatedAt: number; archived?: number; source?: string; threadSource?: string | null }

/** A ~/.codex with the two databases the reader opens, shaped like codex 0.154.0's. */
interface Item { threadId: string; ordinal: number; type: string; json: unknown }

function codexHome(rows: Row[], turns: { threadId: string; status: string; startedAt: number }[] = [], items: Item[] = []): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER,
    source TEXT, thread_source TEXT, cwd TEXT, title TEXT, name TEXT, preview TEXT, archived INTEGER, git_branch TEXT,
    has_user_event INTEGER, model TEXT)`);
  const insert = state.prepare(`INSERT INTO threads VALUES (?, '', ?, ?, ?, ?, ?, ?, '/work/demo', ?, NULL, ?, ?, 'main', 1, 'demo-mini')`);
  for (const r of rows) {
    insert.run(r.id, Math.floor(r.updatedAt / 1000), Math.floor(r.updatedAt / 1000), r.updatedAt, r.updatedAt,
      r.source ?? 'vscode', r.threadSource ?? 'user', `Thread ${r.id}`, `Prompt ${r.id}`, r.archived ?? 0);
  }
  state.close();
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec(`CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT)`);
  const turn = history.prepare('INSERT INTO thread_turns VALUES (?, 1, ?, ?, NULL)');
  for (const t of turns) turn.run(t.threadId, t.status, t.startedAt);
  const item = history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?)');
  for (const i of items) item.run(i.threadId, i.ordinal, i.type, JSON.stringify(i.json));
  history.close();
  return home;
}

const homes: string[] = [];
const make = (...args: Parameters<typeof codexHome>) => {
  const home = codexHome(...args);
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe('CodexReader', () => {
  it('lists the 40 most recent unarchived user threads', async () => {
    const rows: Row[] = Array.from({ length: 45 }, (_, n) => ({ id: `t${String(n).padStart(2, '0')}`, updatedAt: NOW - n * MIN }));
    rows.push({ id: 'subagent', updatedAt: NOW, threadSource: 'subagent' }, { id: 'exec', updatedAt: NOW, source: 'exec' });
    const views = await new CodexReader(make(rows)).read(NOW);
    expect(views.map((v) => v.hostId)).toEqual(rows.slice(0, 40).map((r) => r.id));
    expect(views[0]).toMatchObject({ id: 'codex:t00', provider: 'codex', name: 'Thread t00', cwd: '/work/demo', branch: 'main', model: 'demo-mini' });
  });

  it('merges legacy timestamps into indexed recent threads before applying the limit', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, updatedAt: NOW - i * MIN }));
    const home = make(rows);
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    db.exec(`UPDATE threads SET updated_at_ms = NULL WHERE id IN ('t1', 't41');
      CREATE INDEX idx_threads_updated_at_ms ON threads(updated_at_ms DESC, id DESC)`);
    db.close();
    expect((await new CodexReader(home).read(NOW)).map(v => v.hostId)).toEqual(rows.slice(0, 40).map(r => r.id));
  });

  it('backfills previous completions of a busy chat in time order and skips archived chats', async () => {
    const home = make([{ id: 'chat', updatedAt: NOW }, { id: 'archived', updatedAt: NOW, archived: 1 }]);
    const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
    try {
      db.exec(`INSERT INTO thread_turns VALUES ('chat',1,'completed',1,2), ('chat',2,'failed',3,4),
        ('chat',3,'completed',5,6), ('chat',4,'inProgress',7,NULL), ('archived',1,'completed',4,5)`);
    } finally { db.close(); }
    expect((await recentCodexCompletions(home, 10)).map(e => [e.sessionId, e.at])).toEqual([['codex:chat', 6000], ['codex:chat', 2000]]);
  });

  it('in-progress turn written in the last 15 minutes is working', async () => {
    const home = make(
      [{ id: 'fresh', updatedAt: NOW - 5 * MIN }, { id: 'stale', updatedAt: NOW - 20 * MIN }, { id: 'done', updatedAt: NOW - MIN }],
      [
        { threadId: 'fresh', status: 'inProgress', startedAt: (NOW - 6 * MIN) / 1000 },
        { threadId: 'stale', status: 'inProgress', startedAt: (NOW - 21 * MIN) / 1000 },
        { threadId: 'done', status: 'completed', startedAt: (NOW - 2 * MIN) / 1000 },
      ],
    );
    const state = Object.fromEntries((await new CodexReader(home).read(NOW)).map((v) => [v.hostId, v.state]));
    expect(state).toEqual({ fresh: 'working', stale: 'unknown', done: 'idle' });
  });

  it('shows the last two tool calls since the user prompt in run order', async () => {
    const item = (ordinal: number, type: string, json: unknown) => ({ threadId: 'run', ordinal, type, json });
    const home = make([{ id: 'run', updatedAt: NOW }], [{ threadId: 'run', status: 'inProgress', startedAt: NOW / 1000 }], [
      item(1, 'commandExecution', { command: 'old', status: 'completed' }),
      item(2, 'userMessage', { content: [] }),
      item(3, 'fileChange', { status: 'completed', changes: [{ path: 'src/view.ts' }] }),
      item(4, 'commandExecution', { status: 'failed', command: "/bin/zsh -lc 'npm test'", durationMs: 3200 }),
    ]);
    expect((await new CodexReader(home).read(NOW))[0]?.recentSteps).toEqual([
      { kind: 'edit', label: 'Edit view.ts', status: 'done' },
      { kind: 'command', label: 'npm test', status: 'failed', durationMs: 3200 },
    ]);
  });

  it('keeps a running session outside the forty recent cards when its rollout is still fresh', async () => {
    const rows = Array.from({ length: 45 }, (_, n) => ({ id: `t${n}`, updatedAt: NOW - n * 1000 }));
    const home = make(rows, [{ threadId: 't44', status: 'inProgress', startedAt: NOW / 1000 - 60 }], [
      { threadId: 't44', ordinal: 1, type: 'agentMessage', json: { phase: 'commentary', text: 'Starting the app' } },
    ]);
    expect(await new CodexReader(home).read(NOW)).toContainEqual(expect.objectContaining({ hostId: 't44', state: 'working', activity: 'Starting the app' }));
  });

  it('archived threads are skipped', async () => {
    const home = make([{ id: 'kept', updatedAt: NOW }, { id: 'archived', updatedAt: NOW + 1, archived: 1 }]);
    expect((await new CodexReader(home).read(NOW)).map((v) => v.hostId)).toEqual(['kept']);
  });

  it("an unanswered question Codex asked (its async questions) makes the card \"Needs you\", even while the turn runs on", async () => {
    const asked = (threadId: string, ordinal: number): Item => ({
      threadId, ordinal, type: 'agentMessage',
      json: { type: 'agentMessage', text: 'Which pass?', phase: 'final_answer', delivery: 'async',
        questions: [{ title: 'Should the pass include boosts?', options: ['Yes', 'No'] }] },
    });
    const said = (threadId: string, ordinal: number, text: string): Item => ({
      threadId, ordinal, type: 'userMessage', json: { type: 'userMessage', content: [{ type: 'text', text }] },
    });
    const home = make(
      [{ id: 'asking', updatedAt: NOW - MIN }, { id: 'answered', updatedAt: NOW - MIN }, { id: 'plain', updatedAt: NOW - MIN }],
      [
        { threadId: 'asking', status: 'inProgress', startedAt: (NOW - 2 * MIN) / 1000 },
        { threadId: 'answered', status: 'inProgress', startedAt: (NOW - 2 * MIN) / 1000 },
        { threadId: 'plain', status: 'inProgress', startedAt: (NOW - 2 * MIN) / 1000 },
      ],
      [
        said('asking', 1, 'go'), asked('asking', 5),
        said('answered', 1, 'go'), asked('answered', 5), said('answered', 9, '<send_user_message_question_reply>[]</send_user_message_question_reply>'),
        said('plain', 1, 'go'),
      ],
    );
    const views = Object.fromEntries((await new CodexReader(home).read(NOW)).map((v) => [v.hostId, v]));
    expect(views.asking).toMatchObject({ state: 'needs_you', need: 'question', activity: 'Should the pass include boosts?' });
    expect(views.answered).toMatchObject({ state: 'working', need: null });
    expect(views.plain).toMatchObject({ state: 'working', need: null });
  });

  it('a question in a rollout without a history row also needs you, until a user message follows', async () => {
    const home = make([{ id: 'r1', updatedAt: NOW - MIN }, { id: 'r2', updatedAt: NOW - MIN }]);
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    const line = (payload: unknown) => JSON.stringify({ timestamp: new Date(NOW - MIN).toISOString(), type: 'event_msg', payload });
    const question = line({ type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', delivery: 'async',
      questions: [{ title: 'Keep the pass?', options: ['Yes', 'No'] }] } });
    const start = [line({ type: 'task_started' }), line({ type: 'user_message', message: 'go' }), question];
    for (const [id, lines] of [['r1', start], ['r2', [...start, line({ type: 'user_message', message: 'Yes' })]]] as const) {
      const file = path.join(home, `${id}.jsonl`);
      fs.writeFileSync(file, lines.join('\n') + '\n');
      db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(file, id);
    }
    db.close();
    const views = Object.fromEntries((await new CodexReader(home).read(NOW)).map((v) => [v.hostId, v]));
    expect(views.r1).toMatchObject({ state: 'needs_you', need: 'question', activity: 'Keep the pass?' });
    expect(views.r2).toMatchObject({ state: 'working', need: null });
  });
  it('a prompt with attached files shows without the files block', async () => {
    const home = make([{ id: 'r1', updatedAt: NOW - MIN }]);
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    const line = (payload: unknown) => JSON.stringify({ timestamp: new Date(NOW - MIN).toISOString(), type: 'event_msg', payload });
    const said = '# Files mentioned by the user:\n\n## report.pdf: /Users/me/report.pdf\n\n## My request:\nSummarise it';
    const file = path.join(home, 'r1.jsonl');
    fs.writeFileSync(file, [line({ type: 'task_started' }), line({ type: 'user_message', message: said })].join('\n') + '\n');
    db.prepare('UPDATE threads SET rollout_path = ?, preview = ? WHERE id = ?').run(file, said, 'r1');
    db.close();
    const [view] = await new CodexReader(home).read(NOW);
    expect(view).toMatchObject({ lastPrompt: 'Summarise it' });
  });
});
