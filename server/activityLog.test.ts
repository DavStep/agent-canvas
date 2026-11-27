import { describe, expect, it } from 'vitest';
import { ActivityLog } from './activityLog.ts';
import { demoSnapshot } from './demo.ts';
import type { SessionView } from '../shared/types.ts';

describe('activity log', () => {
  const board = demoSnapshot(1000000);
  const base = board.sessions[0]!;
  const snap = (at: number, card: Partial<SessionView>) => ({
    ...board, generatedAt: at, sessions: [{ ...base, stateSince: at, ...card }],
  });

  it('keeps separate requests and completions after reading, a new turn and a restart', () => {
    const log = new ActivityLog([]);
    const waiting = { state: 'needs_you', need: 'permission' } as const;
    const done = { state: 'needs_you', need: 'reply' } as const;
    log.observe(snap(1, waiting));
    log.observe(snap(2, waiting));
    log.observe(snap(3, done));
    log.observe(snap(4, { state: 'idle', need: null }));
    log.observe(snap(5, { state: 'working', need: null }));
    log.observe(snap(6, waiting));
    log.observe(snap(7, done));
    const reopened = new ActivityLog(log.entries);
    reopened.observe(snap(7, done));
    expect(reopened.entries.map(e => [e.kind, e.at])).toEqual([['reply', 7], ['permission', 6], ['reply', 3], ['permission', 1]]);
  });

  it('backfills confirmed completions without relabeling other idle cards or duplicating Codex index rows', () => {
    const live = new ActivityLog([]);
    live.observe(snap(5123, { provider: 'codex', state: 'idle', rawStatus: 'completed' }));
    const saved = live.entries;
    const log = new ActivityLog(saved, saved);
    log.observe(snap(5000, { provider: 'codex', state: 'idle', rawStatus: 'completed' }));
    log.observe(snap(6000, { state: 'idle', need: null }));
    log.observe(snap(8000, { state: 'idle', completedAt: 7000 }));
    expect(log.entries.map(e => e.at)).toEqual([7000, 5000]);
  });
});
