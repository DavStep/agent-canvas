import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Judge, JudgeInput } from './judge.ts';
import { scanOnce } from './scan.ts';
import { ThreadStore } from './store.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/threads');
const TILES = 'b8fd0000-0000-4000-8000-000000000001';
const CODEX = '01a1c587-0000-7000-8000-000000000001';
const NOW = Date.parse('2026-11-26T17:00:00.000Z');

let root: string;
let projects: string;
let codexHome: string;

const copy = async (name: string, to: string): Promise<string> => {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(path.join(FIXTURES, name), to);
  // Recent enough to be read (the scan leaves chats older than two weeks alone).
  const when = new Date(NOW - 60_000);
  await fs.utimes(to, when, when);
  return to;
};

/** A judge that says yes and counts what it was asked. */
function stubJudge(open = true): Judge & { calls: JudgeInput[] } {
  const calls: JudgeInput[] = [];
  const judge = (async (input: JudgeInput) => {
    calls.push(input);
    return { open, title: 'Tile Merger events', summary: 'Four event ideas, Stack Race first.', question: 'Gate by location or Coins; bots or players?' };
  }) as Judge & { calls: JudgeInput[] };
  judge.calls = calls;
  return judge;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'threads-scan-'));
  projects = path.join(root, 'claude', 'projects');
  codexHome = path.join(root, 'codex');
  await copy('tile-events.jsonl', path.join(projects, '-Users-owner--agent-canvas-agent', `${TILES}.jsonl`));
  await copy('answered.jsonl', path.join(projects, '-Users-owner-shop', 'c0ffee00-0000-4000-8000-000000000002.jsonl'));
  await copy(`rollout-2026-11-26T10-00-00-${CODEX}.jsonl`, path.join(codexHome, 'sessions', '2026', '11', '26', `rollout-2026-11-26T10-00-00-${CODEX}.jsonl`));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const base = (store: ThreadStore, judge: Judge | null) => ({
  store,
  claudeProjects: projects,
  codexHome,
  judge,
  now: () => NOW,
  agentCwd: '/Users/owner/.agent-canvas/agent',
  minTurns: 2,
});

describe('scanOnce', () => {
  it('makes a ticket for the Tile Merger events and the Codex offer, and none for the answered chat', async () => {
    const store = await ThreadStore.load(null);
    const judge = stubJudge();
    const result = await scanOnce(base(store, judge));
    expect(result).toMatchObject({ added: 2, judged: 2, read: 3 });
    const [tiles, codex] = [store.list().find((t) => t.sessionId === TILES), store.list().find((t) => t.sessionId === `codex:${CODEX}`)];
    expect(tiles).toMatchObject({ title: 'Tile Merger events', sessionName: 'Canvas agent', provider: 'claude', cwd: '/Users/owner/.agent-canvas/agent' });
    expect(tiles!.excerpt).toContain('Stack Race');
    expect(codex).toMatchObject({ provider: 'codex', folder: 'trail-league' });
    expect(judge.calls.find((c) => c.provider === 'claude')!.after).toEqual(['is this the newest version?']);
  });

  it('reads nothing again until a chat changes, and never asks the judge twice', async () => {
    const store = await ThreadStore.load(null);
    const judge = stubJudge(false);
    await scanOnce(base(store, judge));
    expect(judge.calls).toHaveLength(2);
    expect(store.list()).toEqual([]);
    const again = await scanOnce(base(store, judge));
    expect(again).toMatchObject({ read: 0, judged: 0 });
    // Touching the file makes it read again, but the candidate is settled.
    const file = path.join(projects, '-Users-owner--agent-canvas-agent', `${TILES}.jsonl`);
    await fs.appendFile(file, '\n');
    const third = await scanOnce(base(store, judge));
    expect(third).toMatchObject({ read: 1, judged: 0 });
  });

  it('spends at most its budget, and picks the rest up on the next run', async () => {
    const store = await ThreadStore.load(null);
    const judge = stubJudge();
    expect(await scanOnce({ ...base(store, judge), maxJudge: 1 })).toMatchObject({ judged: 1, added: 1 });
    expect(await scanOnce({ ...base(store, judge), maxJudge: 1 })).toMatchObject({ judged: 1, added: 1 });
    expect(store.list()).toHaveLength(2);
  });

  it('makes no tickets without a judge, and leaves the chats to be read again', async () => {
    const store = await ThreadStore.load(null);
    expect(await scanOnce(base(store, null))).toMatchObject({ added: 0, judged: 0 });
    expect(await scanOnce(base(store, stubJudge()))).toMatchObject({ added: 2 });
  });

  it('never makes a dismissed ticket again', async () => {
    const store = await ThreadStore.load(null);
    await scanOnce(base(store, stubJudge()));
    for (const t of store.list()) store.apply({ type: 'dismiss', id: t.id });
    const file = path.join(projects, '-Users-owner--agent-canvas-agent', `${TILES}.jsonl`);
    await fs.appendFile(file, '\n');
    const judge = stubJudge();
    expect(await scanOnce(base(store, judge))).toMatchObject({ added: 0, judged: 0 });
    expect(store.list()).toEqual([]);
  });

  it('closes a ticket when the source chat takes the question up', async () => {
    const store = await ThreadStore.load(null);
    await scanOnce(base(store, stubJudge()));
    const file = path.join(projects, '-Users-owner--agent-canvas-agent', `${TILES}.jsonl`);
    const reply = { type: 'user', isSidechain: false, cwd: '/Users/owner/.agent-canvas/agent', sessionId: TILES, timestamp: '2026-11-26T16:50:00.000Z', message: { role: 'user', content: 'back to the events: gate them by location and start with bots' } };
    await fs.appendFile(file, `${JSON.stringify(reply)}\n`);
    const result = await scanOnce(base(store, stubJudge()));
    expect(result.resolved).toBe(1);
    expect(store.list().some((t) => t.sessionId === TILES)).toBe(false);
  });
});
