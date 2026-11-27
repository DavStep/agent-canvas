import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../../shared/chat.ts';
import { finishedTurn, FOLLOW_SLACK, followsNewest, threadBlocks, tookLabel } from './Thread.tsx';

describe('followsNewest', () => {
  const at = (fromBottom: number) => followsNewest({ scrollTop: 1000 - 400 - fromBottom, scrollHeight: 1000, clientHeight: 400 });

  it('follows at the bottom and within 80 px of it', () => {
    expect(FOLLOW_SLACK).toBe(80);
    expect(at(0)).toBe(true);
    expect(at(80)).toBe(true);
  });

  it('stops once the owner scrolls up more than 80 px', () => {
    expect(at(81)).toBe(false);
    expect(at(500)).toBe(false);
  });

  it('follows when everything fits', () => {
    expect(followsNewest({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });
});

describe('finishedTurn', () => {
  const user: ChatItem = { kind: 'user', id: 'u', at: 1000, text: 'Go', images: [] };
  const answer: ChatItem = { kind: 'assistant', id: 'a', at: 126_000, text: 'Done', streaming: false };

  it('marks a thread that ends on a complete answer, timed from its prompt', () => {
    expect(finishedTurn([user, answer])).toEqual({ tookMs: 125_000 });
    expect(finishedTurn([answer])).toEqual({ tookMs: null });
  });

  it('marks nothing while the answer streams, or when the thread ends on anything else', () => {
    expect(finishedTurn([user, { ...answer, streaming: true }])).toBeNull();
    expect(finishedTurn([answer, user])).toBeNull();
    expect(finishedTurn([])).toBeNull();
  });

  it('words the time a turn took', () => {
    expect([tookLabel(42_000), tookLabel(125_000), tookLabel(4_320_000)]).toEqual(['42s', '2m 05s', '1h 12m']);
  });
});

describe('threadBlocks', () => {
  const day = new Date(2026, 10, 23, 17, 56).getTime();
  const user: ChatItem = { kind: 'user', id: 'u', at: day, text: 'Go', images: [] };
  const answer: ChatItem = { kind: 'assistant', id: 'a', at: day + 60_000, text: 'Done', streaming: false };
  const read: ChatItem = { kind: 'tool', id: 't1', at: day + 61_000, tool: 'read', name: 'Read', target: 'a', status: 'done', output: null, exitCode: null, diffs: [] };
  const bash: ChatItem = { kind: 'tool', id: 't2', at: day + 62_000, tool: 'command', name: 'Bash', target: 'ls', status: 'waiting', output: null, exitCode: null, diffs: [] };
  const ask: ChatItem = { kind: 'approval', id: 'p', at: day + 62_000, toolItemId: 't2', title: 'Allow?', detail: 'ls', alwaysLabel: null, status: 'pending' };

  it('starts with the day, puts the speaker before the reply, and groups tool rows', () => {
    const blocks = threadBlocks([user, answer, read], day + 120_000);
    expect(blocks.map((b) => b.type)).toEqual(['day', 'item', 'who', 'item', 'tools']);
  });

  it('folds completed commentary and tool calls while keeping the answer and failures visible', () => {
    const commentary = { ...answer, id: 'progress', commentary: true };
    const blocks = threadBlocks([user, commentary, read, answer], day);
    expect(blocks.map(b => b.type)).toEqual(['day', 'item', 'who', 'work', 'item']);
    expect(threadBlocks([user, commentary, { ...read, status: 'failed' }, answer], day).some(b => b.type === 'work')).toBe(false);
  });

  it('moves the tool a pending approval is about into the approval card', () => {
    const blocks = threadBlocks([user, read, bash, ask], day + 120_000);
    const tools = blocks.find((b) => b.type === 'tools');
    expect(tools?.type === 'tools' && tools.items.map((t) => t.id)).toEqual(['t1']);
    const card = blocks.find((b) => b.type === 'approval');
    expect(card?.type === 'approval' && card.tool?.id).toBe('t2');
  });

  it('leaves the tool in the log once the approval is answered', () => {
    const blocks = threadBlocks([user, read, { ...bash, status: 'done' }, { ...ask, status: 'allowed' }], day + 120_000);
    const tools = blocks.find((b) => b.type === 'tools');
    expect(tools?.type === 'tools' && tools.items.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});
