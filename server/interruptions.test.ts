import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTail } from './adapter/transcript.ts';
import { recentClaude } from './engines/recent.ts';
import { claudeInterruption, codexFailure, resetFromText, type ClaudeRecord } from './interruptions.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/interruptions');
const records = (name: string): ClaudeRecord[] =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ClaudeRecord);

describe('Claude transcripts: how the last turn ended', () => {
  it('a usage limit: the limit, its words and its reset from quotaLimits', () => {
    expect(claudeInterruption(records('claude-limit.jsonl'), false)).toEqual({
      kind: 'limit', reason: "You've hit your 5-hour limit · resets 11:10pm (Asia/Yerevan)",
      at: Date.parse('2026-11-17T15:47:58.481Z'), resetsAt: 1794942000 * 1000,
    });
    // The process still running does not change a limit.
    expect(claudeInterruption(records('claude-limit.jsonl'), true)?.kind).toBe('limit');
  });

  it('a limit still holds when only a task notification came after it', () => {
    expect(claudeInterruption(records('claude-limit-then-notification.jsonl'), false)?.kind).toBe('limit');
  });

  it('an API error that ended the turn', () => {
    expect(claudeInterruption(records('claude-api-error.jsonl'), false)).toMatchObject({
      kind: 'error', reason: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", resetsAt: null,
    });
  });

  it('killed mid tool call: cut off, naming the tool, only when no process runs it', () => {
    expect(claudeInterruption(records('claude-killed-tool.jsonl'), false)).toEqual({
      kind: 'killed', reason: 'Its process ended mid-turn, while running Bash', at: Date.parse('2026-11-17T12:00:05.000Z'), resetsAt: null,
    });
    expect(claudeInterruption(records('claude-killed-tool.jsonl'), true)).toBeNull();
  });

  it('a prompt with no reply and no process is cut off', () => {
    expect(claudeInterruption(records('claude-killed-no-reply.jsonl'), false)).toMatchObject({ kind: 'killed', reason: 'Its process ended mid-turn' });
  });

  it("the owner's own Stop is not an interruption", () => {
    expect(claudeInterruption(records('claude-manual-stop.jsonl'), false)).toBeNull();
    // Stop pressed while a tool ran: the tool's result, then the marker, as real transcripts write it.
    const midTool = [
      ...records('claude-killed-tool.jsonl'),
      { type: 'user', timestamp: '2026-11-17T12:00:09.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'interrupted' }] } },
      { type: 'user', timestamp: '2026-11-17T12:00:09.001Z', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    ] as ClaudeRecord[];
    expect(claudeInterruption(midTool, false)).toBeNull();
  });

  it('a normal finish is not one, local command output after it neither', () => {
    expect(claudeInterruption(records('claude-finished.jsonl'), false)).toBeNull();
  });

  it('a later answer clears an earlier error', () => {
    const recs = [...records('claude-api-error.jsonl'), ...records('claude-finished.jsonl')];
    expect(claudeInterruption(recs, false)).toBeNull();
  });

  it('readTail (live process) and recentClaude (none) read the fixtures the same way', async () => {
    expect((await readTail(path.join(FIXTURES, 'claude-limit.jsonl'))).interruption?.kind).toBe('limit');
    expect((await readTail(path.join(FIXTURES, 'claude-killed-tool.jsonl'))).interruption).toBeUndefined();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interruptions-'));
    dirs.push(home);
    const folder = path.join(home, '-work-demo');
    fs.mkdirSync(folder);
    const names = ['claude-limit.jsonl', 'claude-api-error.jsonl', 'claude-killed-tool.jsonl', 'claude-manual-stop.jsonl', 'claude-finished.jsonl'];
    names.forEach((name, i) => fs.copyFileSync(path.join(FIXTURES, name), path.join(folder, `cccccccc-0000-4000-8000-00000000000${i}.jsonl`)));
    const found = new Map((await recentClaude(home)).map((r) => [r.id.at(-1), r.interruption?.kind ?? null]));
    expect(Object.fromEntries(found)).toEqual({ 0: 'limit', 1: 'error', 2: 'killed', 3: null, 4: null });
  });
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('Codex turn errors', () => {
  const at = new Date(2026, 8, 16, 10, 0).getTime();

  it('usageLimitExceeded is a limit, its reset read from the message', () => {
    const i = codexFailure({ message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 16th, 2026 4:21 PM.", codexErrorInfo: 'usageLimitExceeded' }, at);
    expect(i).toMatchObject({ kind: 'limit', at });
    expect(i.resetsAt).toBe(new Date(2026, 8, 16, 16, 21).getTime());
  });

  it('429 after retries and an overloaded server are limits; anything else is an error', () => {
    expect(codexFailure({ message: 'exceeded retry limit, last status: 429 Too Many Requests', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }, at).kind).toBe('limit');
    expect(codexFailure({ message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded' }, at).kind).toBe('limit');
    expect(codexFailure({ message: 'stream disconnected before completion: Transport error', codexErrorInfo: 'other' }, at)).toEqual({
      kind: 'error', reason: 'stream disconnected before completion: Transport error', at, resetsAt: null,
    });
  });
});

describe('resetFromText', () => {
  const at = new Date(2026, 10, 17, 19, 47).getTime();
  it.each([
    ['resets 11:10pm', new Date(2026, 10, 17, 23, 10)],
    ['resets 10pm', new Date(2026, 10, 17, 22, 0)],
    ['resets 7:20am', new Date(2026, 10, 18, 7, 20)],
    ['try again at 12:04 PM.', new Date(2026, 10, 18, 12, 4)],
  ])('%s', (text, when) => {
    expect(resetFromText(`You've hit your limit · ${text}`, at)).toBe(when.getTime());
  });
  it('the old "limit reached|<epoch>" form, and none', () => {
    expect(resetFromText('Claude AI usage limit reached|1794942000', at)).toBe(1794942000 * 1000);
    expect(resetFromText('Something broke', at)).toBeNull();
  });
});
