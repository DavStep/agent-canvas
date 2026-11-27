import { describe, expect, it } from 'vitest';
import { sortCards } from './order.ts';
import { session } from './testSession.ts';

describe('sortCards', () => {
  it('puts needs-you first (permission, question, reply), then working, idle, unknown', () => {
    const input = [
      session({ id: 'unknown', state: 'unknown' }),
      session({ id: 'idle', state: 'idle' }),
      session({ id: 'reply', state: 'needs_you', need: 'reply' }),
      session({ id: 'working', state: 'working' }),
      session({ id: 'question', state: 'needs_you', need: 'question' }),
      session({ id: 'permission', state: 'needs_you', need: 'permission' }),
    ];
    expect(sortCards(input).map((s) => s.id)).toEqual(['permission', 'question', 'reply', 'working', 'idle', 'unknown']);
  });

  it('puts the most recent first within a state (latest state change, then latest start) and does not mutate its input', () => {
    const input = [
      session({ id: 'old', state: 'idle', stateSince: 100, startedAt: 50 }),
      session({ id: 'new', state: 'idle', stateSince: 300, startedAt: 10 }),
      session({ id: 'tieOlder', state: 'idle', stateSince: 200, startedAt: 20 }),
      session({ id: 'tieNewer', state: 'idle', stateSince: 200, startedAt: 40 }),
    ];
    expect(sortCards(input).map((s) => s.id)).toEqual(['new', 'tieNewer', 'tieOlder', 'old']);
    expect(input.map((s) => s.id)).toEqual(['old', 'new', 'tieOlder', 'tieNewer']);
  });
});
