import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeLine, claudeState, codexLine, codexState, type UsageDelta } from './parse.ts';
import { costOf, isLong, modelKey, priceFor, PRICES } from './pricing.ts';
import { classify, periodStart, summarize, type UsageBucket } from './summary.ts';
import { UsageStore } from './store.ts';
import { usageReport } from './report.ts';
import { compact, percent, usd } from '../../shared/usage.ts';
import { demoUsageSummary } from './demo.ts';

const FIXTURES = path.join(import.meta.dirname, '../../fixtures');
const lines = (file: string): Buffer[] =>
  readFileSync(path.join(FIXTURES, file), 'utf8').split('\n').filter(Boolean).map(l => Buffer.from(l));
const NOW = Date.parse('2026-11-27T09:00:00.000Z');

function sum(ds: UsageDelta[]) {
  return ds.reduce((t, d) => ({ input: t.input + d.input, output: t.output + d.output, cacheRead: t.cacheRead + d.cacheRead,
    cacheWrite: t.cacheWrite + d.cacheWrite, cacheWrite1h: t.cacheWrite1h + d.cacheWrite1h, calls: t.calls + d.calls }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, calls: 0 });
}

describe('Claude transcript usage', () => {
  const parseAll = () => {
    const s = claudeState('from-file-name', '');
    return lines('claude/usage-session.jsonl').map(l => claudeLine(l, s, NOW)).filter((d): d is UsageDelta => d !== null);
  };

  it('counts one API call once, adding only what grew when its lines repeat it', () => {
    const p1 = parseAll().filter(d => d.turn === 'p1');
    expect(sum(p1)).toEqual({ input: 5, output: 140, cacheRead: 11_000, cacheWrite: 1_200, cacheWrite1h: 1_000, calls: 2 });
  });

  it('takes the turn from promptId and the session and folder from the lines', () => {
    const ds = parseAll();
    expect(new Set(ds.map(d => d.turn))).toEqual(new Set(['p1', 'p2']));
    expect(ds.every(d => d.session === 's-1' && d.cwd === '/work/app' && d.provider === 'claude')).toBe(true);
    expect(ds[0]!.at).toBe(Date.parse('2026-11-26T10:00:05.000Z'));
  });

  it('skips synthetic error messages and "usage" text inside a tool result', () => {
    const ds = parseAll();
    expect(ds.some(d => d.model === '<synthetic>')).toBe(false);
    expect(ds.some(d => d.input === 999)).toBe(false);
    expect(ds).toHaveLength(4);
  });

  it('marks a call over the long-prompt threshold', () => {
    const haiku = parseAll().find(d => d.model === 'claude-haiku-5-5')!;
    expect(haiku).toMatchObject({ long: true, input: 10, cacheRead: 150_000, output: 50, turn: 'p2' });
    expect(parseAll().filter(d => d.model === 'claude-opus-5-5').every(d => !d.long)).toBe(true);
  });

  it("puts a subagent's own transcript in the parent session, in a turn of its own", () => {
    const s = claudeState('s-1', '', 'agent-a1b2');
    const ds = lines('claude/usage-subagent.jsonl').map(l => claudeLine(l, s, NOW)).filter((d): d is UsageDelta => d !== null);
    expect(ds).toEqual([expect.objectContaining({ session: 's-1', turn: 'sub:agent-a1b2', model: 'claude-haiku-4-5-20251001', input: 5, cacheRead: 2000, output: 30 })]);
  });

  it('continues across reads from its saved state', () => {
    const all = lines('claude/usage-session.jsonl');
    const s = claudeState('x', '');
    const first = all.slice(0, 2).map(l => claudeLine(l, s, NOW));
    const restored = JSON.parse(JSON.stringify(s));
    const rest = all.slice(2).map(l => claudeLine(l, restored, NOW));
    const ds = [...first, ...rest].filter((d): d is UsageDelta => d !== null);
    expect(sum(ds.filter(d => d.turn === 'p1')).output).toBe(140);
  });
});

describe('Codex rollout usage', () => {
  const parseAll = () => {
    const s = codexState('codex:from-file-name');
    return { s, ds: lines('codex/usage-rollout.jsonl').map(l => codexLine(l, s, NOW)).filter((d): d is UsageDelta => d !== null) };
  };

  it('splits input into uncached, cache read and cache write, and skips a repeated total', () => {
    const { ds } = parseAll();
    const t1 = ds.filter(d => d.turn === 'turn-1');
    expect(sum(t1)).toEqual({ input: 250, output: 150, cacheRead: 1_000, cacheWrite: 100, cacheWrite1h: 0, calls: 2 });
    expect(sum(ds.filter(d => d.turn === 'turn-2'))).toMatchObject({ input: 30, cacheRead: 450, output: 20, calls: 1 });
  });

  it('names the thread, folder and model from session_meta and turn_context', () => {
    const { ds } = parseAll();
    expect(ds.every(d => d.session === 'codex:019a0000-0000-7000-8000-00000000c0de' && d.cwd === '/work/api' && d.model === 'gpt-6.2-sol')).toBe(true);
    expect(ds[0]!.at).toBe(Date.parse('2026-11-26T12:00:05.000Z'));
  });

  it("files a subagent thread under its parent's chat", () => {
    const s = codexState('codex:x');
    codexLine(Buffer.from(JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 'child', cwd: '/w', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } })), s, NOW);
    expect(s.session).toBe('codex:parent');
  });
});

describe('pricing', () => {
  it('prices every token kind, with the 1-hour cache write apart', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 5m write, $8 1h write per million.
    expect(costOf('claude-opus-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 2e6, cacheWrite1h: 1e6 })).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
    expect(costOf('gpt-6.2-sol', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 })).toBeCloseTo(2 + 10 + 0.1 + 2.5);
  });

  it("uses Haiku 5.5's long-prompt prices past 100K", () => {
    expect(isLong('claude-haiku-5-5', 100_001)).toBe(true);
    expect(isLong('claude-haiku-5-5', 100_000)).toBe(false);
    expect(isLong('claude-opus-5-5', 900_000)).toBe(false);
    expect(costOf('claude-haiku-5-5', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, true)).toBeCloseTo(0.5);
  });

  it('knows a model by its id without a date suffix, context tag or provider prefix', () => {
    expect(modelKey('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(modelKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(priceFor('anthropic.claude-sonnet-5-5')).toBe(PRICES['claude-sonnet-5-5']);
    expect(costOf('some-future-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});

const bucket = (b: Partial<UsageBucket>): UsageBucket => ({
  provider: 'claude', session: 's', cwd: '/work/app', model: 'claude-opus-5-5', turn: 't', long: false, at: NOW - 3_600_000, last: NOW,
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, calls: 1, ...b,
});
const ctx = { agentCwd: '/home/.agent-canvas/agent', roles: { 'orch-1': { folder: '/work/app', connection: 'claude-login' as const }, 'codex:orch-2': { folder: '/work/api', connection: 'codex-api' as const } } };

describe('overhead or work', () => {
  it('tells the canvas agent by its folder, with the connection its subfolder names', () => {
    expect(classify(bucket({ cwd: '/home/.agent-canvas/agent' }), ctx)).toMatchObject({ group: 'overhead', kind: 'agent', rowId: 'agent:claude-login', billing: 'plan' });
    expect(classify(bucket({ cwd: '/home/.agent-canvas/agent/claude-api' }), ctx)).toMatchObject({ kind: 'agent', rowId: 'agent:claude-api', billing: 'api' });
    expect(classify(bucket({ provider: 'codex', cwd: '/home/.agent-canvas/agent/codex-api' }), ctx)).toMatchObject({ kind: 'agent', rowId: 'agent:codex-api' });
    expect(classify(bucket({ cwd: '/home/.agent-canvas/agentic' }), ctx).group).toBe('work');
  });

  it('tells an orchestrator by its chat id, though it works in the project folder', () => {
    expect(classify(bucket({ session: 'orch-1' }), ctx)).toMatchObject({ group: 'overhead', kind: 'orchestrator', label: 'Orchestrator · app', detail: '/work/app', billing: 'plan' });
    expect(classify(bucket({ session: 'codex:orch-2', provider: 'codex' }), ctx)).toMatchObject({ kind: 'orchestrator', billing: 'api' });
    expect(classify(bucket({ session: 'worker' }), ctx)).toMatchObject({ group: 'work', kind: 'work', rowId: 'work:claude' });
  });

  it('counts internal calls as overhead, by their label', () => {
    expect(classify(bucket({ kind: 'internal', label: 'Title generation' }), ctx)).toMatchObject({ group: 'overhead', kind: 'internal', rowId: 'internal:Title generation' });
  });
});

describe('summarize', () => {
  const M = 1_000_000;
  const buckets = [
    // Canvas agent: one turn over two models → 1 turn. $4 in + $20 out.
    bucket({ cwd: ctx.agentCwd, session: 'a', turn: 'x', input: M }),
    bucket({ cwd: ctx.agentCwd, session: 'a', turn: 'x', output: M }),
    // Orchestrator: 2 turns, $8.
    bucket({ session: 'orch-1', turn: 'o1', input: M }),
    bucket({ session: 'orch-1', turn: 'o2', input: M }),
    // Work: $72, one turn plus a subagent's (not a turn of its own).
    bucket({ session: 'w', turn: 'w1', output: 3 * M }),
    bucket({ session: 'w', turn: 'sub:agent-1', output: 0.6 * M }),
    // Codex work at an unknown model: tokens counted, no cost.
    bucket({ provider: 'codex', session: 'codex:z', model: 'gpt-unknown', turn: 'z1', input: 500 }),
    // Too old for 7 days.
    bucket({ session: 'w', turn: 'old', at: NOW - 40 * 86_400_000, output: M }),
  ];
  const s = summarize(buckets, { ...ctx, period: '7d', now: NOW });

  it('sums overhead and work apart, with the share of estimated cost', () => {
    expect(s.overhead).toMatchObject({ turns: 3, input: 3 * M, output: M, cost: 32 });
    expect(s.work).toMatchObject({ turns: 2, output: 3.6 * M, cost: 72, unpriced: 500 });
    expect(s.share).toBeCloseTo(32 / 104);
  });

  it('lists the canvas agent, then orchestrators, then work, each with its share', () => {
    expect(s.rows.map(r => [r.id, r.turns, Math.round(r.cost)])).toEqual([
      ['agent:claude-login', 1, 24], ['orchestrator:/work/app', 2, 8], ['work:claude', 1, 72], ['work:codex', 1, 0],
    ]);
    expect(s.rows.reduce((t, r) => t + r.share, 0)).toBeCloseTo(1);
  });

  it('keeps the period to it, and all of history when asked', () => {
    const all = summarize(buckets, { ...ctx, period: 'all', now: NOW });
    expect(all.work.cost).toBeCloseTo(92);
    expect(all.since).toBe(NOW - 40 * 86_400_000);
    expect(periodStart('today', NOW)).toBe(new Date(NOW).setHours(0, 0, 0, 0));
    expect(periodStart('all', NOW)).toBeNull();
  });

  it('gives a bar per day of the period, and a bar per week past two months', () => {
    expect(s.days).toHaveLength(7);
    expect(s.dayUnit).toBe('day');
    const today = s.days.at(-1)!;
    expect(today.overhead + today.work).toBeCloseTo(104);
    const long = summarize([bucket({ at: NOW - 200 * 86_400_000, output: 1 }), bucket({ output: 1 })], { ...ctx, period: 'all', now: NOW });
    expect(long.dayUnit).toBe('week');
    expect(long.days.length).toBeGreaterThan(28);
    expect(long.days.length).toBeLessThan(32);
  });

  it('lists the costliest overhead turns', () => {
    expect(s.top.map(t => [t.session, Math.round(t.cost)])).toEqual([['a', 24], ['orch-1', 4], ['orch-1', 4]]);
  });

  it('answers an empty period with zeroes', () => {
    const empty = summarize([], { ...ctx, period: 'today', now: NOW });
    expect(empty).toMatchObject({ share: 0, rows: [], top: [], since: null });
    expect(empty.days).toHaveLength(1);
  });
});

describe('UsageStore', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });

  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-'));
    dirs.push(root);
    const claudeHome = path.join(root, 'claude');
    const codexHome = path.join(root, 'codex');
    const project = path.join(claudeHome, 'projects', '-work-app');
    await fs.mkdir(path.join(project, 's-1', 'subagents'), { recursive: true });
    await fs.copyFile(path.join(FIXTURES, 'claude/usage-session.jsonl'), path.join(project, 's-1.jsonl'));
    await fs.copyFile(path.join(FIXTURES, 'claude/usage-subagent.jsonl'), path.join(project, 's-1', 'subagents', 'agent-a1b2.jsonl'));
    const day = path.join(codexHome, 'sessions', '2026', '11', '26');
    await fs.mkdir(day, { recursive: true });
    const rollout = path.join(day, 'rollout-2026-11-26T12-00-00-019a0000-0000-7000-8000-00000000c0de.jsonl');
    await fs.copyFile(path.join(FIXTURES, 'codex/usage-rollout.jsonl'), rollout);
    const opts = { dir: path.join(root, 'data'), claudeHome, codexHome, agentCwd: '/home/.agent-canvas/agent', roles: () => ({ 's-1': { folder: '/work/app', connection: 'claude-login' as const } }), now: () => NOW };
    return { root, project, codexHome, rollout, opts };
  }

  it('backfills from the transcripts, then reads only what they gain', async () => {
    const { project, opts } = await setup();
    const store = new UsageStore(opts);
    let s = await store.summary('all');
    expect(s.backfilling).toBe(false);
    expect(s.rows.find(r => r.id === 'orchestrator:/work/app')).toMatchObject({ turns: 2, output: 220, cacheRead: 163_000 });
    expect(s.rows.find(r => r.id === 'work:codex')).toMatchObject({ turns: 2, input: 280, output: 170 });

    // A new call, then half of another line still being written.
    const more = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', id: 'msg_9', usage: { input_tokens: 7, output_tokens: 1 } }, timestamp: '2026-11-26T12:00:00.000Z', sessionId: 's-1', cwd: '/work/app' });
    await fs.appendFile(path.join(project, 's-1.jsonl'), `${more}\n{"type":"assistant","mess`);
    s = await store.summary('all');
    // The main transcript's 5 + 10, the subagent's 5, and the new call's 7.
    expect(s.rows.find(r => r.kind === 'orchestrator')!.input).toBe(5 + 10 + 5 + 7);
    // Rescanning an unchanged folder adds nothing.
    s = await store.summary('all');
    expect(s.rows.find(r => r.kind === 'orchestrator')!.input).toBe(27);
  });

  it('keeps its counts and read positions across restarts, and remembers replaced orchestrators', async () => {
    const { opts } = await setup();
    await new UsageStore(opts).summary('all');
    const again = new UsageStore({ ...opts, roles: () => ({}) });
    const s = await again.summary('all');
    expect(s.rows.find(r => r.kind === 'orchestrator')).toMatchObject({ turns: 2, input: 20 });
    expect(s.overhead.turns + s.work.turns).toBe(4);
  });

  it('does not count an archived rollout twice', async () => {
    const { codexHome, rollout, opts } = await setup();
    const store = new UsageStore(opts);
    await store.summary('all');
    await fs.mkdir(path.join(codexHome, 'archived_sessions'), { recursive: true });
    await fs.rename(rollout, path.join(codexHome, 'archived_sessions', path.basename(rollout)));
    const s = await store.summary('all');
    expect(s.rows.find(r => r.id === 'work:codex')).toMatchObject({ input: 280 });
  });

  it('adds live records of internal calls as overhead', async () => {
    const { opts } = await setup();
    const store = new UsageStore({ ...opts, claudeHome: null, codexHome: null });
    store.record({ provider: 'claude', session: 'internal', cwd: '', model: 'claude-haiku-5-5', turn: 'n1', at: NOW - 1000, long: false,
      input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, calls: 1, kind: 'internal', label: 'Open threads' });
    await new Promise(r => setTimeout(r, 20));
    const s = await store.summary('today');
    expect(s.rows).toEqual([expect.objectContaining({ id: 'internal:Open threads', group: 'overhead', turns: 1, input: 100 })]);
  });
});

describe('the report and its numbers', () => {
  it('writes compact numbers, dollars and shares', () => {
    expect([compact(950), compact(12_345), compact(4_200_000), compact(12_900_000_000)]).toEqual(['950', '12K', '4.2M', '13B']);
    expect([usd(0), usd(0.004), usd(3.456), usd(1234.5)]).toEqual(['$0', '<$0.01', '$3.46', '$1,235']);
    expect([percent(0), percent(0.0004), percent(0.046), percent(0.31)]).toEqual(['0%', '<0.1%', '4.6%', '31%']);
  });

  it('answers get_usage_summary in plain lines, saying the costs are estimates', () => {
    const text = usageReport(demoUsageSummary('7d', NOW, '/demo/agent'));
    expect(text).toMatch(/^Agent canvas overhead in the last 7 days: [\d.]+[KMB]? tokens, about \$[\d.,]+, [\d.]+% of all estimated usage\./);
    expect(text).toContain('- Canvas agent (Claude login):');
    expect(text).toContain('- Orchestrator · storefront:');
    expect(text).toContain('estimates at API prices checked');
  });
});

describe('get_usage_summary', () => {
  it('answers with the report for the period asked, 7 days by default, without asking the owner', async () => {
    const { CANVAS_TOOLS } = await import('../agent/tools.ts');
    const tool = CANVAS_TOOLS.find(t => t.name === 'get_usage_summary')!;
    expect(tool).toMatchObject({ safe: true, readOnly: true });
    const asked: string[] = [];
    const api = { usageSummary: async (p: UsagePeriodArg) => { asked.push(p); return demoUsageSummary(p, NOW, '/demo/agent'); } } as unknown as Parameters<typeof tool.handler>[0];
    const week = await tool.handler(api, {});
    expect(week.isError).toBe(false);
    expect(week.text).toMatch(/^Agent canvas overhead in the last 7 days:/);
    expect((await tool.handler(api, { period: 'all' })).text).toMatch(/^Agent canvas overhead in all recorded history:/);
    expect(asked).toEqual(['7d', 'all']);
    expect((await tool.handler(api, { period: 'year' })).isError).toBe(true);
    expect((await tool.handler({} as Parameters<typeof tool.handler>[0], {})).isError).toBe(true);
  });
});
type UsagePeriodArg = import('../../shared/usage.ts').UsagePeriod;

describe('internal calls from an SDK result', () => {
  it('records each model of a one-shot query as overhead under its label', async () => {
    const { internalUsage } = await import('./live.ts');
    const ds = internalUsage({ session_id: 'q1', modelUsage: {
      'claude-haiku-5-5': { inputTokens: 1200, outputTokens: 80, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      'claude-opus-5-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    } }, 'Open threads', NOW);
    expect(ds).toEqual([expect.objectContaining({ kind: 'internal', label: 'Open threads', model: 'claude-haiku-5-5', input: 1200, output: 80, turn: 'Open threads:q1', at: NOW })]);
    const s = summarize(ds.map(d => ({ ...d, last: d.at })), { ...ctx, period: 'today', now: NOW });
    expect(s.rows).toEqual([expect.objectContaining({ id: 'internal:Open threads', kind: 'internal', group: 'overhead', turns: 1 })]);
  });
});
