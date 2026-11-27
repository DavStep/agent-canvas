import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { askIn, looksAnswered, openLoops, type Turn } from './detect.ts';
import { readClaudeChat, readCodexChat } from './sources.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/threads');
const MIN = 60_000;
const IDLE = 30 * MIN;
const at = (iso: string) => Date.parse(iso);

const turn = (role: Turn['role'], text: string, minute: number): Turn => ({ role, text, at: minute * MIN });
const LONG = 'I looked at both options and wrote down what each would take, including the tests it needs and the files it touches. ';

describe('askIn', () => {
  it('finds the question that ends a turn', () => {
    expect(askIn(`${LONG}\n\nShould I start with the first one, or do you want both?`)).toBe('Should I start with the first one, or do you want both?');
  });
  it('finds an offer that has no question mark', () => {
    expect(askIn(`${LONG}\n\nTell me which, and I'll start a session for it.`)).toBe("Tell me which, and I'll start a session for it.");
  });
  it('ignores a question asked earlier in a long answer that ends on a statement', () => {
    const text = `Why does it flicker? The textures reload on every hit.\n\n${LONG}\n\n${LONG}\n\nThe fix is in and the tests pass.`;
    expect(askIn(text)).toBeNull();
  });
  it('gives nothing for a plain report', () => {
    expect(askIn('I sent this to the orchestrator. It will tell you when it is ready to install.')).toBeNull();
  });
});

describe('looksAnswered', () => {
  const q = 'should events be gated by location or by Coins, and do you want bots or real players to start with?';
  it('takes a short reply that names one of the choices', () => {
    expect(looksAnswered(q, ['bots first'])).toBe(true);
    expect(looksAnswered(q, ['yes, do it'])).toBe(true);
  });
  it('takes a longer reply about the same things', () => {
    expect(looksAnswered(q, ['gate them by location, the Stone milestone feels too grindy, and start with players'])).toBe(true);
  });
  it('does not take a message about something else', () => {
    expect(looksAnswered(q, ['is this the newest version?'])).toBe(false);
  });
});

describe('openLoops', () => {
  it('finds a question the owner left when they came back to something else much later', () => {
    const turns = [turn('user', 'compare the two', 0), turn('assistant', `${LONG}\n\nWant me to build the cheaper one?`, 2), turn('user', 'can you check the logs?', 90)];
    const loops = openLoops(turns, { now: 100 * MIN, idleMs: IDLE });
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ askedAt: 2 * MIN, question: 'Want me to build the cheaper one?', after: ['can you check the logs?'] });
  });
  it('finds a question in a chat that went quiet, but only once it has been quiet a while', () => {
    const turns = [turn('user', 'compare the two', 0), turn('assistant', `${LONG}\n\nWhich do you prefer?`, 2)];
    expect(openLoops(turns, { now: 10 * MIN, idleMs: IDLE })).toEqual([]);
    expect(openLoops(turns, { now: 40 * MIN, idleMs: IDLE })).toHaveLength(1);
  });
  it('leaves a question the owner answered straight away, whatever they said', () => {
    const turns = [turn('user', 'compare the two', 0), turn('assistant', `${LONG}\n\nWhich do you prefer?`, 2), turn('user', 'hmm, show me the diff first', 4)];
    expect(openLoops(turns, { now: 200 * MIN, idleMs: IDLE })).toEqual([]);
  });
  it('leaves a question answered later, and a remark too short to be a discussion', () => {
    const answered = [turn('user', 'go', 0), turn('assistant', `${LONG}\n\nShould the coupons apply first?`, 2), turn('user', 'yes, coupons first', 80)];
    expect(openLoops(answered, { now: 200 * MIN, idleMs: IDLE })).toEqual([]);
    const short = [turn('user', 'go', 0), turn('assistant', 'Done. Anything else?', 2)];
    expect(openLoops(short, { now: 200 * MIN, idleMs: IDLE })).toEqual([]);
  });
  it('gives at most two per chat, newest first', () => {
    const turns: Turn[] = [turn('user', 'start', 0)];
    for (let i = 1; i <= 4; i++) turns.push(turn('assistant', `${LONG}\n\nShall I do part ${i}?`, i * 100), turn('user', `unrelated thing ${i}`, i * 100 + 60));
    const loops = openLoops(turns, { now: 1000 * MIN, idleMs: IDLE });
    expect(loops.map((l) => l.question)).toEqual(['Shall I do part 4?', 'Shall I do part 3?']);
  });
});

describe('fixture transcripts', () => {
  it('the Tile Merger events discussion in the canvas agent chat is an open loop', async () => {
    const chat = await readClaudeChat(path.join(FIXTURES, 'tile-events.jsonl'));
    expect(chat.cwd).toBe('/Users/owner/.agent-canvas/agent');
    expect(chat.name).toBe('Agent button placement on canvas');
    const loops = openLoops(chat.turns, { now: at('2026-11-26T17:00:00.000Z'), idleMs: IDLE });
    expect(loops).toHaveLength(1);
    const [loop] = loops;
    expect(loop!.askedAt).toBe(at('2026-11-26T15:14:51.669Z'));
    expect(loop!.question).toContain('gated by location or by Coins');
    expect(loop!.question).toContain('bots or real players');
    expect(loop!.excerpt).toContain('Stack Race');
    // The owner came back an hour later about something else.
    expect(loop!.after).toEqual(['is this the newest version?']);
  });

  it('a question the owner answered is not one', async () => {
    const chat = await readClaudeChat(path.join(FIXTURES, 'answered.jsonl'));
    expect(chat.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(openLoops(chat.turns, { now: at('2026-11-27T09:00:00.000Z'), idleMs: IDLE })).toEqual([]);
  });

  it('a Codex chat that stopped on an offer is one, read from its rollout', async () => {
    const chat = await readCodexChat(path.join(FIXTURES, 'rollout-2026-11-26T10-00-00-01a1c587-0000-7000-8000-000000000001.jsonl'));
    expect(chat.cwd).toBe('/Users/owner/Documents/trail-league');
    // Commentary is not the answer.
    expect(chat.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    const loops = openLoops(chat.turns, { now: at('2026-11-26T12:00:00.000Z'), idleMs: IDLE });
    expect(loops.map((l) => l.question)).toEqual(['Want me to reuse them, or give the challenge its own tickets?']);
  });
});
