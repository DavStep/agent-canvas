import { describe, expect, it } from 'vitest';
import type { ChatItem, ChatState, ChatUpdate } from '../../../shared/chat.ts';
import { applyUpdate } from '../chatLog.ts';
import { fixture } from './fakeSdk.ts';
import { classifyClaudeTool, claudeUpdates, freshStream, settleTool, type ClaudeSignal } from './map.ts';
import type { SDKMessage } from './sdk.ts';

const NOW = 1795000400000;

const empty = (): ChatState => ({
  sessionId: 's', provider: 'claude', owner: 'here', title: '', cwd: '/work/demo', items: [], hasOlder: false, turn: 'running',
  model: null, models: [], mode: 'default', modes: [], banner: null,
});

/** Feeds SDK messages through the mapper the way the engine does. */
function play(messages: unknown[], start: ChatState = empty()) {
  let state = start;
  let stream = freshStream();
  const updates: ChatUpdate[] = [];
  const signals: ClaudeSignal[] = [];
  const after: ChatState[] = [];
  for (const m of messages) {
    if (typeof m === 'object' && m !== null && 'fake' in m) continue; // canUseTool: the engine's part
    const out = claudeUpdates(m as SDKMessage, { find: (id) => state.items.find((i) => i.id === id), now: NOW, stream });
    stream = out.stream;
    for (const u of out.updates) state = applyUpdate(state, u);
    updates.push(...out.updates);
    if (out.signal) signals.push(out.signal);
    after.push(state);
  }
  const item = (id: string): ChatItem | undefined => state.items.find((i) => i.id === id);
  return { state, updates, signals, after, item };
}

describe('claudeUpdates', () => {
  it('stream_event text_delta → append to the assistant item', () => {
    const { updates, after } = play(fixture('stream-text.json'));
    expect(updates).toContainEqual({ op: 'append', id: 'msg_live01', field: 'text', chunk: 'Hel' });
    expect(updates).toContainEqual({ op: 'append', id: 'msg_live01', field: 'text', chunk: 'lo' });
    // After the second delta, before the assistant message: streaming, text so far.
    expect(after[8]!.items.find((i) => i.id === 'msg_live01')).toEqual({ kind: 'assistant', id: 'msg_live01', at: NOW, text: 'Hello', streaming: true });
  });

  it('assistant message closes streaming', () => {
    const { item } = play(fixture('stream-text.json'));
    expect(item('msg_live01')).toEqual({ kind: 'assistant', id: 'msg_live01', at: NOW, text: 'Hello', streaming: false });
  });

  it('thinking delta → reasoning', () => {
    const { updates, after, item } = play(fixture('stream-text.json'));
    expect(updates).toContainEqual({ op: 'append', id: 'msg_live01:thinking', field: 'text', chunk: 'Checking ' });
    expect(after[3]!.items.find((i) => i.id === 'msg_live01:thinking')).toMatchObject({ kind: 'reasoning', text: 'Checking the files.', streaming: true });
    expect(item('msg_live01:thinking')).toEqual({
      kind: 'reasoning', id: 'msg_live01:thinking', at: NOW, text: 'Checking the files.', streaming: false, durationMs: 0,
    });
  });

  it('a message with two text blocks joins them as history does', () => {
    const text = fixture('stream-text.json').filter((m) => !('fake' in m) && (m.type !== 'stream_event' || m.event.type !== 'message_stop'));
    const again = [
      { type: 'stream_event', parent_tool_use_id: null, uuid: 'x1', session_id: 's', event: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', parent_tool_use_id: null, uuid: 'x2', session_id: 's', event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'World' } } },
      { type: 'assistant', parent_tool_use_id: null, uuid: 'x3', session_id: 's', message: { id: 'msg_live01', content: [{ type: 'text', text: 'World' }] } },
    ];
    const { item } = play([...text.slice(0, 11), ...again]);
    expect(item('msg_live01')).toMatchObject({ text: 'Hello\n\nWorld', streaming: false });
  });

  it('tool_use then tool_result → tool item running then done with output', () => {
    const { after, item } = play(fixture('stream-tool.json'));
    expect(after[1]!.items.find((i) => i.id === 'toolu_live01')).toMatchObject({ kind: 'tool', tool: 'command', name: 'Bash', status: 'running', target: '' });
    expect(after[4]!.items.find((i) => i.id === 'toolu_live01')).toMatchObject({ status: 'running', target: 'npm test', output: null });
    expect(item('toolu_live01')).toEqual({
      kind: 'tool', id: 'toolu_live01', at: NOW, tool: 'command', name: 'Bash', target: 'npm test',
      status: 'done', output: '1 passing', exitCode: 0, diffs: [],
    });
    expect(item('msg_live03')).toMatchObject({ kind: 'assistant', text: 'Tests pass.', streaming: false });
  });

  it('result with is_error → error notice', () => {
    const { item, signals, state } = play([{
      type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Something broke'], uuid: 'r-1', session_id: 's',
      terminal_reason: 'model_error', queued_turn_count: 0,
    }]);
    expect(state.items).toEqual([{ kind: 'notice', id: 'notice-r-1', at: NOW, level: 'error', text: 'Something broke' }]);
    expect(item('notice-r-1')).toBeTruthy();
    expect(signals).toEqual([{ kind: 'turnEnd', queued: 0, failed: true, signedOut: false }]);
  });

  it('an interrupted turn says Stopped, not an error', () => {
    const { state } = play([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], uuid: 'r-2', session_id: 's', terminal_reason: 'aborted_streaming' }]);
    expect(state.items).toEqual([{ kind: 'notice', id: 'notice-r-2', at: NOW, level: 'info', text: 'Stopped' }]);
  });

  it('signed out: the synthetic error message makes no item; the result is an error notice and says signed out', () => {
    const { state, signals } = play(fixture('stream-signed-out.json'));
    expect(state.items).toEqual([expect.objectContaining({
      kind: 'notice', level: 'error', text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    })]);
    expect(signals).toEqual([{ kind: 'signedOut' }, { kind: 'turnEnd', queued: 0, failed: true, signedOut: true }]);
  });

  it('rate_limit_event → account refresh hint (no chat item)', () => {
    const info = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.91, resetsAt: 1795010000 };
    const { updates, signals } = play([{ type: 'rate_limit_event', rate_limit_info: info, uuid: 'rl-1', session_id: 's' }]);
    expect(updates).toEqual([]);
    expect(signals).toEqual([{ kind: 'rateLimit', info }]);
  });

  it('system init → init signal with session id, model, mode and plugins', () => {
    const { signals, updates } = play([{
      type: 'system', subtype: 'init', session_id: 'sid-1', cwd: '/work/demo', model: 'claude-demo-large', permissionMode: 'plan',
      plugins: [{ name: 'superpowers', path: '/p' }], uuid: 'i-1',
    }]);
    expect(updates).toEqual([]);
    expect(signals).toEqual([{
      kind: 'init', sessionId: 'sid-1', cwd: '/work/demo', model: 'claude-demo-large', mode: 'plan', plugins: [{ name: 'superpowers', path: '/p' }],
    }]);
  });

  it('subagent messages (parent_tool_use_id set) are not shown', () => {
    const sub = fixture('stream-text.json').map((m) => ('fake' in m ? m : { ...m, parent_tool_use_id: 'toolu_task' }));
    const { state } = play(sub.filter((m) => !('fake' in m) && m.type !== 'result'));
    expect(state.items).toEqual([]);
  });

  it('system status carrying a permission mode → mode signal (the picker follows a plan approval)', () => {
    const { signals, updates } = play([
      { type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits', uuid: 'st-1', session_id: 's' },
      { type: 'system', subtype: 'status', status: 'requesting', uuid: 'st-2', session_id: 's' },
    ]);
    expect(updates).toEqual([]);
    expect(signals).toEqual([{ kind: 'mode', mode: 'acceptEdits' }]);
  });
});

describe('tools with their own content', () => {
  const plan = `# Fix the login bug\n\n1. Reproduce it\n2. ${'Write the failing test, then the fix. '.repeat(20)}\n\n- Ship it`;

  it('ExitPlanMode: the whole plan, uncut, is the row\'s body; the target is its title', () => {
    expect(classifyClaudeTool('ExitPlanMode', { plan })).toEqual({ tool: 'other', target: 'Fix the login bug', diffs: [], output: plan });
  });

  it('ExitPlanMode streamed: the plan survives the placeholder row and the result', () => {
    const { item } = play([
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } }, uuid: 'e1', session_id: 's' },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'ExitPlanMode', input: {} } }, uuid: 'e2', session_id: 's' },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-demo', content: [{ type: 'tool_use', id: 'tu1', name: 'ExitPlanMode', input: { plan } }] }, uuid: 'a1', session_id: 's' },
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'User has approved your plan. You can now start coding.' }] }, uuid: 'u1', session_id: 's' },
    ]);
    expect(item('tu1')).toMatchObject({ kind: 'tool', name: 'ExitPlanMode', status: 'done', target: 'Fix the login bug', output: plan });
  });

  it('TodoWrite: a readable list, done / in progress / to do', () => {
    const todos = [
      { content: 'Write the test', status: 'completed', activeForm: 'Writing the test' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      { content: 'Update the docs', status: 'pending', activeForm: 'Updating the docs' },
    ];
    expect(classifyClaudeTool('TodoWrite', { todos })).toEqual({
      tool: 'other', target: '3 to-dos, 1 done', diffs: [], output: '✓ Write the test\n▸ Fixing the bug\n○ Update the docs',
    });
    const shape = classifyClaudeTool('TodoWrite', { todos });
    const row = { kind: 'tool' as const, id: 't', at: 0, name: 'TodoWrite', status: 'running' as const, exitCode: null, ...shape, output: shape.output ?? null };
    expect(settleTool(row, { content: 'Todos have been modified successfully.' }).output).toBe('✓ Write the test\n▸ Fixing the bug\n○ Update the docs');
  });

  it('Task and Agent: the description, then the head of the prompt', () => {
    const input = { description: 'Find the flaky test', prompt: `Look through the test suite for flaky tests.\nThen report.${' More.'.repeat(50)}`, subagent_type: 'general-purpose' };
    for (const name of ['Task', 'Agent']) {
      expect(classifyClaudeTool(name, input)).toEqual({ tool: 'other', target: 'Find the flaky test — Look through the test suite for flaky tests.', diffs: [] });
    }
    // The subagent's report is the row's output.
    const row = { kind: 'tool' as const, id: 't', at: 0, name: 'Agent', status: 'running' as const, output: null, exitCode: null, ...classifyClaudeTool('Agent', input) };
    expect(settleTool(row, { content: [{ type: 'text', text: 'Found two.' }] }).output).toBe('Found two.');
  });
});

