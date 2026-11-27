import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../../shared/chat.ts';
import type { Turn } from './protocol/v2/Turn.ts';
import { codexItem, codexItems, itemUpdates } from './map.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/codex/thread-read-basic.json');
const turns = (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { thread: { turns: Turn[] } }).thread.turns;
const items = codexItems(turns);
const byId = (id: string): ChatItem | undefined => items.find((i) => i.id === id);
const AT = 1795000000 * 1000;

describe('codexItems', () => {
  it('keeps the order of turns and items', () => {
    expect(items.map((i) => i.id)).toEqual([
      'item-u1', 'item-r1', 'item-c1', 'item-f1', 'item-m1', 'item-w1', 'item-a1', 'item-u2', 'item-x1',
    ]);
  });

  it('userMessage with localImage → user item with image', () => {
    expect(byId('item-u1')).toEqual({
      kind: 'user', id: 'item-u1', at: AT, text: 'Add a health check',
      images: [{ mime: 'image/png', dataUrl: 'file:///tmp/demo/screen.png' }],
    });
    expect(byId('item-u2')).toMatchObject({
      text: 'Does this match?', images: [{ mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' }],
    });
  });

  it('preserves the message when Codex supplies an image file ID without a preview URL', () => {
    expect(codexItem({
      type: 'userMessage', id: 'user', clientId: null,
      content: [{ type: 'text', text: 'Screenshot', text_elements: [] }, { type: 'image', fileId: 'file-1' }],
    }, AT, 'fallback')).toMatchObject({ kind: 'user', text: 'Screenshot\n[Image preview unavailable]', images: [] });
  });

  it('commandExecution → command tool, output = aggregatedOutput, exitCode', () => {
    expect(byId('item-c1')).toEqual({
      kind: 'tool', id: 'item-c1', at: AT, tool: 'command', name: 'shell', target: 'rg -n listen src', action: { name: 'Search', target: 'listen in src' },
      status: 'done', output: 'src/server.ts:12:app.listen(3000)\n', exitCode: 0, diffs: [],
    });
  });

  it('fileChange → edit tool with diffs from changes[].diff', () => {
    const item = byId('item-f1');
    expect(item).toMatchObject({ kind: 'tool', tool: 'edit', status: 'done', target: '/work/demo/src/server.ts (+1 more)' });
    if (item?.kind !== 'tool') throw new Error('not a tool');
    expect(item.diffs).toEqual([
      { path: '/work/demo/src/server.ts', unified: expect.stringContaining('+app.get("/health"'), added: 1, removed: 0 },
      { path: '/work/demo/src/health.md', unified: expect.stringContaining('+# Health'), added: 2, removed: 0 },
    ]);
  });

  it('reasoning summary → reasoning', () => {
    expect(byId('item-r1')).toEqual({
      kind: 'reasoning', id: 'item-r1', at: AT, text: 'Looking for the server entry point.\n\nIt is src/server.ts.',
      streaming: false, durationMs: null,
    });
  });

  it('agentMessage → assistant', () => {
    expect(byId('item-a1')).toEqual({ kind: 'assistant', id: 'item-a1', at: AT, text: 'Added a /health route.', streaming: false });
  });

  it('mcpToolCall → mcp tool', () => {
    expect(byId('item-m1')).toMatchObject({
      kind: 'tool', tool: 'mcp', name: 'docs/search', target: 'express health', status: 'done', output: 'Use app.get for a route.',
    });
  });

  it('webSearch → web tool', () => {
    expect(byId('item-w1')).toMatchObject({ kind: 'tool', tool: 'web', target: 'express health check', status: 'done' });
  });

  it('unknown item type → notice "Unsupported item: <type>"', () => {
    expect(byId('item-x1')).toEqual({
      kind: 'notice', id: 'item-x1', at: 1795000100 * 1000, level: 'info', text: 'Unsupported item: futureThing',
    });
  });
});

describe('known Codex item types never show as unsupported', () => {
  const one = (item: unknown) => codexItem(item as never, 1000, 'fallback');

  it('dynamicToolCall → an other tool row with its arguments and text output', () => {
    expect(one({
      type: 'dynamicToolCall', id: 'd1', namespace: 'browser', tool: 'open_tab', arguments: { url: 'http://localhost:3000' }, status: 'completed',
      contentItems: [{ type: 'inputText', text: 'Opened.' }, { type: 'inputImage', imageUrl: 'data:x' }], success: true, durationMs: 12,
    })).toEqual({ kind: 'tool', id: 'd1', at: 1000, tool: 'other', name: 'browser/open_tab', target: 'http://localhost:3000', status: 'done', output: 'Opened.', exitCode: null, diffs: [] });
    expect(one({ type: 'dynamicToolCall', id: 'd2', namespace: null, tool: 'x', arguments: {}, status: 'completed', contentItems: null, success: false, durationMs: null }))
      .toMatchObject({ name: 'x', status: 'failed', output: null });
  });

  it('retains displayable media from Codex and connector tools', () => {
    const src = 'data:image/png;base64,AAAA';
    expect(one({ type: 'dynamicToolCall', arguments: {}, contentItems: [{ type: 'inputImage', imageUrl: src }] })).toMatchObject({ media: [{ kind: 'image', src }] });
    expect(one({ type: 'mcpToolCall', arguments: {}, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] } })).toMatchObject({ media: [{ kind: 'image', src }] });
    expect(one({ type: 'imageGeneration', result: 'AAAA', status: 'completed' })).toMatchObject({ media: [{ kind: 'image', src }] });
  });

  it('collabAgentToolCall → an agent row naming what it does and its prompt', () => {
    expect(one({
      type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'interrupted', senderThreadId: 't', receiverThreadIds: ['t2'],
      prompt: 'Look for flaky tests\nand report', model: null, reasoningEffort: null, agentsStates: {},
    })).toEqual({ kind: 'tool', id: 'c1', at: 1000, tool: 'other', name: 'Agent: spawnAgent', target: 'Look for flaky tests', status: 'failed', output: null, exitCode: null, diffs: [] });
  });

  it('sleep, imageGeneration → rows; review mode and subagent starts and ends → notes', () => {
    expect(one({ type: 'sleep', id: 's1', durationMs: 90_000 })).toMatchObject({ kind: 'tool', name: 'sleep', target: '90 s', status: 'done' });
    expect(one({ type: 'imageGeneration', id: 'i1', status: 'completed', revisedPrompt: 'A red fox', result: 'b64', failure: null }))
      .toMatchObject({ kind: 'tool', tool: 'other', name: 'image_generation', target: 'A red fox', status: 'done', output: null });
    expect(one({ type: 'imageGeneration', id: 'i2', status: 'failed', revisedPrompt: null, result: '', failure: { message: 'no' } })).toMatchObject({ status: 'failed' });
    expect(one({ type: 'enteredReviewMode', id: 'r1', review: 'current changes' })).toEqual({ kind: 'notice', id: 'r1', at: 1000, level: 'info', text: 'Review started: current changes' });
    expect(one({ type: 'exitedReviewMode', id: 'r2', review: 'current changes' })).toEqual({ kind: 'notice', id: 'r2', at: 1000, level: 'info', text: 'Review finished' });
    expect(one({ type: 'subAgentActivity', id: 'a1', kind: 'started', agentThreadId: 't2', agentPath: 'reviewer' })).toEqual({ kind: 'notice', id: 'a1', at: 1000, level: 'info', text: 'Subagent reviewer started' });
    expect(one({ type: 'subAgentActivity', id: 'a2', kind: 'interacted', agentThreadId: 't2', agentPath: 'reviewer' })).toBeNull();
    expect(one({ type: 'hookPrompt', id: 'h1', fragments: [{ text: 'Remember the style guide.', hookRunId: 'r' }] }))
      .toEqual({ kind: 'notice', id: 'h1', at: 1000, level: 'info', text: 'A hook added: Remember the style guide.' });
    expect(one({ type: 'functionCallOutput', id: 'f1', name: 'x', namespace: null, output: 'raw' })).toBeNull();
  });
});

describe('item/completed for a command', () => {
  const streamed: ChatItem = { kind: 'tool', id: 'c9', at: 5, tool: 'command', name: 'shell', target: 'npm test', status: 'running', output: '1 passing\n', exitCode: null, diffs: [] };
  const done = (aggregatedOutput: string | null) => itemUpdates('item/completed', {
    item: { type: 'commandExecution', id: 'c9', command: 'npm test', cwd: '/w', processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput, exitCode: 0, durationMs: 3 },
    completedAtMs: 9,
  }, (id) => (id === 'c9' ? streamed : undefined), 9);

  it('aggregatedOutput null keeps the output that streamed', () => {
    expect(done(null)).toEqual([{ op: 'upsert', item: { ...streamed, status: 'done', exitCode: 0 } }]);
  });

  it('aggregatedOutput null keeps what the cap dropped from the streamed output too', () => {
    const trimmed: ChatItem = { ...streamed, output: '… earlier output trimmed\n9 passing\n', outputDropped: 300_000 };
    const updates = itemUpdates('item/completed', {
      item: { type: 'commandExecution', id: 'c9', command: 'npm test', cwd: '/w', processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: null, exitCode: 0, durationMs: 3 },
      completedAtMs: 9,
    }, (id) => (id === 'c9' ? trimmed : undefined), 9);
    expect(updates).toEqual([{ op: 'upsert', item: { ...trimmed, status: 'done', exitCode: 0 } }]);
  });

  it('a final aggregatedOutput still replaces it', () => {
    expect(done('1 passing\n2 passing\n')).toEqual([{ op: 'upsert', item: { ...streamed, status: 'done', exitCode: 0, output: '1 passing\n2 passing\n' } }]);
  });
});

