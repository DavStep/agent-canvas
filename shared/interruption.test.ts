import { describe, expect, it } from 'vitest';
import type { SessionInterruption } from './types.ts';
import { activeLimit, activeLimitLabel, continuePrompt, countdown, interruptionLabel, interruptionState, limitActive, limitLine, limitPending, limitReady } from './interruption.ts';
import type { SessionView } from './types.ts';

const NOW = new Date(2026, 10, 17, 19, 50).getTime();
const limit: SessionInterruption = { kind: 'limit', reason: "You've hit your limit", at: NOW, resetsAt: new Date(2026, 10, 17, 21, 0).getTime() };

describe('interruption words', () => {
  it('card labels', () => {
    expect(interruptionLabel(limit, NOW)).toBe('Limit hit · resets 21:00');
    // Reset: no longer "hit", only waiting for Continue.
    expect(interruptionLabel(limit, limit.resetsAt! + 1)).toBe('Ready to continue');
    expect(interruptionLabel({ ...limit, resetsAt: null }, NOW)).toBe('Limit hit');
    expect(interruptionLabel({ ...limit, kind: 'error', resetsAt: null }, NOW)).toBe('Error');
    expect(interruptionLabel({ ...limit, kind: 'killed', resetsAt: null }, NOW)).toBe('Cut off');
  });

  it('the agent state, the countdown and whether the limit still holds', () => {
    expect(interruptionState(limit)).toBe('interrupted:limit');
    expect(countdown(limit.resetsAt!, NOW)).toBe('1h 10m');
    expect(countdown(NOW + 30_000, NOW)).toBe('30s');
    expect(limitPending(limit, NOW)).toBe(true);
    expect(limitPending({ ...limit, resetsAt: null }, NOW)).toBe(false);
  });

  it('the countdown: hours and minutes, minutes, then seconds', () => {
    expect(countdown(NOW + 72 * 60_000, NOW)).toBe('1h 12m');
    expect(countdown(NOW + 2 * 3_600_000, NOW)).toBe('2h');
    expect(countdown(NOW + 4 * 60_000 + 1, NOW)).toBe('5m');
    expect(countdown(NOW + 59_000, NOW)).toBe('59s');
    expect(countdown(NOW - 5_000, NOW)).toBe('0s');
  });

  it('the divider and banner line: the reset with a live countdown, then Limit reset', () => {
    expect(limitLine(limit, NOW)).toBe('Limit hit · resets 21:00 · in 1h 10m');
    expect(limitLine(limit, limit.resetsAt! - 30_000)).toBe('Limit hit · resets 21:00 · in 30s');
    expect(limitLine(limit, limit.resetsAt!)).toBe('Limit reset · you can continue');
    // The transition: holding until the reset, ready from it on.
    expect([limitActive(limit, limit.resetsAt! - 1), limitReady(limit, limit.resetsAt! - 1)]).toEqual([true, false]);
    expect([limitActive(limit, limit.resetsAt!), limitReady(limit, limit.resetsAt!)]).toEqual([false, true]);
    // Codex: held until its account says usage is available again.
    const codex: SessionInterruption = { ...limit, resetsAt: null, codexUsage: 'blocked' };
    expect([limitActive(codex, NOW), limitReady(codex, NOW)]).toEqual([true, false]);
    expect(limitReady({ ...codex, codexUsage: 'available' }, NOW)).toBe(true);
    expect(limitLine({ ...limit, kind: 'error', resetsAt: null }, NOW)).toBe('Error');
  });

  it('the top bar note: the soonest reset while any limit holds, gone once all have reset', () => {
    const view = (id: string, interruption: SessionInterruption): SessionView => ({ id, state: 'needs_you', need: 'interrupted', interruption } as SessionView);
    const later = { ...limit, resetsAt: limit.resetsAt! + 3_600_000 };
    const views = [view('a', later), view('b', limit), view('c', { ...limit, kind: 'error', resetsAt: null })];
    const note = activeLimit(views, NOW)!;
    expect(note).toEqual({ resetsAt: limit.resetsAt, count: 2, firstId: 'b' });
    expect(activeLimitLabel(note, NOW)).toBe('Limit · resets 21:00');
    expect(activeLimit(views, limit.resetsAt!)).toMatchObject({ resetsAt: later.resetsAt, count: 1, firstId: 'a' });
    expect(activeLimit(views, later.resetsAt!)).toBeNull();
  });

  it('the continuation prompt names what happened', () => {
    expect(continuePrompt(limit)).toBe('Your previous turn was interrupted (a usage limit). Continue where you left off.');
    expect(continuePrompt({ ...limit, kind: 'error', reason: 'API Error: overloaded' })).toContain('(an error: API Error: overloaded)');
  });
});
