// The Store's part in interruptions: a cut-off turn makes its card "Needs you · interrupted", an
// Abort dismisses it for good (across restarts), and a new turn clears it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from './engines/engine.ts';
import type { SessionInterruption } from '../shared/types.ts';
import { ReplyTracker } from './state.ts';
import { Store } from './store.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/interruptions');
const sid = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const temps: string[] = [];
const stores: Store[] = [];
/** The fixture's limit resets at 2026-11-17 23:10 in Yerevan (19:10 UTC). */
const RESETS_AT = 1794942000000;
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((s) => s.stop()));
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** A CLAUDE_HOME whose recent transcripts are the given fixtures (session n = fixture n), no live process. */
async function home(fixtures: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-interrupt-'));
  temps.push(dir);
  await fs.mkdir(path.join(dir, 'sessions'));
  await fs.mkdir(path.join(dir, 'projects', '-work-demo'), { recursive: true });
  await Promise.all(fixtures.map((f, i) => fs.copyFile(path.join(FIXTURES, f), path.join(dir, 'projects', '-work-demo', `${sid(i + 1)}.jsonl`))));
  return dir;
}

function engine(owned: string[] = [], busy: { sessionId: string; reason: 'turn' }[] = [], interruptions = new Map<string, SessionInterruption>()) {
  return { provider: 'claude', banner: null, owned: () => new Set(owned), releasing: () => new Set(), lost: () => {}, busy: () => busy, interruptions } as unknown as Engine;
}

function store(claudeHome: string, opts: { dismissed?: Record<string, number>; claude?: Engine; onPersist?: (d: Record<string, number>) => void } = {}) {
  const s = new Store({
    claudeHome, layout: { version: 1, zones: [], assignments: {} }, replies: new ReplyTracker(), minGapMs: 0, recentLimit: 40,
    dismissed: opts.dismissed, engines: opts.claude ? { claude: opts.claude } : {},
    onPersist: (_l, _r, dismissed) => opts.onPersist?.(dismissed),
  });
  stores.push(s);
  return s;
}

const card = (s: Store, n: number) => s.snapshot().sessions.find((v) => v.id === sid(n));

describe('Store: interrupted sessions', () => {
  it('limit, error and cut-off turns need the owner; a manual stop and a finished turn do not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(RESETS_AT - 3_600_000);
    const s = store(await home(['claude-limit.jsonl', 'claude-api-error.jsonl', 'claude-killed-tool.jsonl', 'claude-manual-stop.jsonl', 'claude-finished.jsonl']));
    await s.poll();
    expect(card(s, 1)).toMatchObject({ state: 'needs_you', need: 'interrupted', interruption: { kind: 'limit', resetsAt: 1794942000000 },
      activity: "You've hit your 5-hour limit · resets 11:10pm (Asia/Yerevan)" });
    expect(card(s, 2)).toMatchObject({ state: 'needs_you', need: 'interrupted', interruption: { kind: 'error' } });
    expect(card(s, 3)).toMatchObject({ state: 'needs_you', need: 'interrupted', interruption: { kind: 'killed' } });
    for (const n of [4, 5]) {
      expect(card(s, n)).toMatchObject({ state: 'idle', need: null });
      expect(card(s, n)?.interruption).toBeUndefined();
    }
  });

  it('when the limit resets the card turns "Ready to continue", rebuilt on time without a poll', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(RESETS_AT - 60_000);
    const s = store(await home(['claude-limit.jsonl']));
    let changes = 0;
    s.onChange(() => { changes++; });
    await s.poll();
    expect(card(s, 1)?.activity).toBe("You've hit your 5-hour limit · resets 11:10pm (Asia/Yerevan)");
    const before = changes;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(changes).toBeGreaterThan(before);
    expect(card(s, 1)).toMatchObject({ state: 'needs_you', need: 'interrupted', interruption: { kind: 'limit', resetsAt: RESETS_AT }, activity: 'Limit reset · you can continue' });
  });

  it('Abort makes it a normal idle card, persisted, so a restart (a rescan) does not bring it back', async () => {
    const dir = await home(['claude-limit.jsonl']);
    let saved: Record<string, number> = {};
    const s = store(dir, { onPersist: (d) => { saved = d; } });
    await s.poll();
    s.dismissInterruption(sid(1));
    expect(card(s, 1)).toMatchObject({ state: 'idle', need: null });
    expect(card(s, 1)?.interruption).toBeUndefined();
    expect(saved).toEqual({ [sid(1)]: Date.parse('2026-11-17T15:47:58.481Z') });
    await s.poll();
    expect(card(s, 1)?.state).toBe('idle');

    const again = store(dir, { dismissed: saved });
    await again.poll();
    expect(card(again, 1)?.state).toBe('idle');
    // Undo brings it back.
    again.dismissInterruption(sid(1), true);
    expect(card(again, 1)?.need).toBe('interrupted');
  });

  it('a later interruption of the same session shows again after an Abort', async () => {
    const s = store(await home(['claude-api-error.jsonl']), { dismissed: { [sid(1)]: Date.parse('2026-11-01T00:00:00Z') } });
    await s.poll();
    expect(card(s, 1)?.need).toBe('interrupted');
  });

  it('a session this app runs is no cut-off, and a new turn here clears an interruption (Continue)', async () => {
    const dir = await home(['claude-killed-tool.jsonl', 'claude-limit.jsonl']);
    const owned = store(dir, { claude: engine([sid(1)]) });
    await owned.poll();
    expect(card(owned, 1)?.state).toBe('idle');
    const running = store(dir, { claude: engine([sid(2)], [{ sessionId: sid(2), reason: 'turn' }]) });
    await running.poll();
    expect(card(running, 2)).toMatchObject({ state: 'working', need: null });
    expect(card(running, 2)?.interruption).toBeUndefined();
  });

  it("an interruption the engine saw shows (a crash), and Abort clears the engine's too", async () => {
    const witnessed = new Map<string, SessionInterruption>([[sid(1), { kind: 'error', reason: 'Claude Code stopped unexpectedly (exit 1)', at: Date.parse('2026-11-17T13:00:00Z'), resetsAt: null }]]);
    const s = store(await home(['claude-finished.jsonl']), { claude: engine([], [], witnessed) });
    await s.poll();
    expect(card(s, 1)).toMatchObject({ need: 'interrupted', activity: 'Claude Code stopped unexpectedly (exit 1)' });
    s.dismissInterruption(sid(1));
    expect(witnessed.size).toBe(0);
    expect(card(s, 1)?.state).toBe('idle');
  });
});
