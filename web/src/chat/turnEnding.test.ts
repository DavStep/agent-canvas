import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../../shared/chat.ts';
import { countdown, resetClock } from '../../../shared/interruption.ts';
import type { SessionInterruption } from '../../../shared/types.ts';
import { turnEnding } from './Thread.tsx';

const NOW = new Date(2026, 10, 17, 19, 50).getTime();
const user: ChatItem = { kind: 'user', id: 'u', at: NOW - 600_000, text: 'Fix it', images: [] };
const answer = (text: string): ChatItem => ({ kind: 'assistant', id: 'a', at: NOW - 60_000, text, streaming: false });

describe('turnEnding: the divider says how the turn really ended', () => {
  it('Done only for a normal finish', () => {
    expect(turnEnding([user, answer('All tests pass.')], null, NOW)).toEqual({ kind: 'done', label: 'Done', tookMs: 540_000 });
  });

  it('Answered when the turn answered a question and edited nothing', () => {
    const asked: ChatItem = { ...user, text: 'Where do the ad offers appear?' };
    const edit: ChatItem = { kind: 'tool', id: 't', at: NOW - 300_000, tool: 'edit', name: 'Edit', target: 'Mine.tsx', status: 'done', output: null, exitCode: null, diffs: [] };
    expect(turnEnding([asked, answer('In the Mine, in this order…')], null, NOW)?.label).toBe('Answered');
    expect(turnEnding([asked, edit, answer('Moved them.')], null, NOW)?.label).toBe('Done');
  });

  it("a limit message (an ordinary answer, stop_sequence) is a limit, with its reset", () => {
    // 11:10pm in Yerevan (UTC+4), shown in the owner's own zone, with the time left.
    const resetsAt = Date.UTC(2026, 10, 17, 19, 10);
    const now = Date.UTC(2026, 10, 17, 15, 50);
    const hit: ChatItem[] = [{ ...user, at: now - 600_000 }, { ...answer("You've hit your 5-hour limit · resets 11:10pm (Asia/Yerevan)"), at: now - 60_000 }];
    expect(turnEnding(hit, null, now))
      .toEqual({ kind: 'limit', label: `Limit hit · resets ${resetClock(resetsAt, now)} · in 3h 20m`, tookMs: null, resetsAt });
    expect(countdown(resetsAt, now)).toBe('3h 20m');
    // Once it has passed: calm, ready to continue.
    expect(turnEnding(hit, null, resetsAt + 1))
      .toEqual({ kind: 'reset', label: 'Limit reset · you can continue', tookMs: null });
    expect(turnEnding([user, answer("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:04 PM.")], null, NOW)?.kind).toBe('limit');
  });

  it("the session's limit: a countdown to its reset, then Limit reset", () => {
    const limit: SessionInterruption = { kind: 'limit', reason: "You've hit your 5-hour limit · resets 9pm", at: NOW - 60_000, resetsAt: new Date(2026, 10, 17, 21, 0).getTime() };
    expect(turnEnding([user, answer(limit.reason)], limit, NOW))
      .toEqual({ kind: 'limit', label: 'Limit hit · resets 21:00 · in 1h 10m', tookMs: null, resetsAt: limit.resetsAt });
    expect(turnEnding([user, answer(limit.reason)], limit, limit.resetsAt!)).toEqual({ kind: 'reset', label: 'Limit reset · you can continue', tookMs: null });
  });

  it('an error, a manual Stop', () => {
    expect(turnEnding([user, answer("API Error: Can't reach the API server")], null, NOW)?.label).toBe('Error');
    expect(turnEnding([user, { kind: 'notice', id: 'n', at: NOW, level: 'error', text: 'Codex stopped unexpectedly' }], null, NOW)?.label).toBe('Error');
    expect(turnEnding([user, { kind: 'notice', id: 'n', at: NOW, level: 'info', text: 'Stopped' }], null, NOW)).toMatchObject({ kind: 'stopped', label: 'Stopped' });
    expect(turnEnding([user, { kind: 'user', id: 'u2', at: NOW, text: '[Request interrupted by user]', images: [] }], null, NOW)?.kind).toBe('stopped');
  });

  it("the session's interruption wins: a killed turn is Cut off", () => {
    const tool: ChatItem = { kind: 'tool', id: 't', at: NOW, tool: 'command', name: 'Bash', target: 'npm test', status: 'running', output: null, exitCode: null, diffs: [] };
    expect(turnEnding([user, tool], { kind: 'killed', reason: 'Its process ended mid-turn', at: NOW, resetsAt: null }, NOW))
      .toEqual({ kind: 'killed', label: 'Cut off', tookMs: null });
    expect(turnEnding([user, tool], null, NOW)).toBeNull();
  });
});
