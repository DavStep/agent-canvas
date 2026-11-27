import { describe, expect, it } from 'vitest';
import type { NeedKind } from '../shared/types.ts';
import { describeActivity, folderOf } from './activity.ts';
import type { RawSession } from './adapter/sessionFiles.ts';
import type { TranscriptTail } from './adapter/transcript.ts';

const raw = (patch: Partial<RawSession> = {}): RawSession => ({
  pid: 1, sessionId: 's1', hostSessionId: null, cwd: '/work/alpha', name: '', status: 'busy',
  waitingFor: null, startedAt: 0, statusUpdatedAt: 0, procStart: null, nameSource: null, ...patch,
});
const tail = (patch: Partial<TranscriptTail> = {}): TranscriptTail => ({
  lastPrompt: null, lastAnswer: null, branch: null, model: null, pendingTool: null, lastBlock: null, ...patch,
});
const pending = (name: string, input: Record<string, unknown> = {}) => tail({ pendingTool: { name, input } });
const act = (r: Partial<RawSession>, t: TranscriptTail | null, need: NeedKind | null = null) => describeActivity(raw(r), t, need);

describe('folderOf', () => {
  it('uses the last segment of a plain path', () => {
    expect(folderOf('/Users/me/Documents/agent-canvas')).toBe('agent-canvas');
    expect(folderOf('/Users/me/Documents/agent-canvas/')).toBe('agent-canvas');
  });
  it('uses the project folder of a worktree path', () => {
    expect(folderOf('/Users/me/code/shop/.claude/worktrees/fix-cart')).toBe('shop');
  });
  it('gives no folder for a scratch workspace', () => {
    expect(folderOf('/Users/me/Library/Application Support/Claude/scratch-workspaces/abc/x')).toBe('');
  });
});

describe('describeActivity', () => {
  const waiting = { status: 'waiting', waitingFor: 'permission prompt' };

  it('permission with a pending Bash shows the command', () => {
    expect(act(waiting, pending('Bash', { command: 'npm test' }), 'permission')).toBe('Wants to run: npm test');
  });
  it('permission with a pending Bash and no command names the tool', () => {
    expect(act(waiting, pending('Bash'), 'permission')).toBe('Wants to use Bash');
  });
  it('permission with another pending tool names it', () => {
    expect(act(waiting, pending('Edit', { file_path: '/a/b.ts' }), 'permission')).toBe('Wants to use Edit');
  });
  it('permission with no pending tool', () => {
    expect(act(waiting, tail(), 'permission')).toBe('Wants permission');
    expect(act(waiting, null, 'permission')).toBe('Wants permission');
  });
  it('question with a pending question tool shows the question', () => {
    const t = pending('AskUserQuestion', { questions: [{ question: 'Which colour?' }] });
    expect(act({ status: 'waiting', waitingFor: 'input needed' }, t, 'question')).toBe('Which colour?');
  });
  it('question otherwise shows an unfamiliar waitingFor, else a generic line', () => {
    expect(act({ status: 'waiting', waitingFor: 'plan approval' }, tail(), 'question')).toBe('plan approval');
    expect(act({ status: 'waiting', waitingFor: 'input needed' }, tail(), 'question')).toBe('Has a question');
    expect(act({ status: 'waiting', waitingFor: null }, null, 'question')).toBe('Has a question');
  });
  it('terminal: waiting on a prompt in its terminal', () => {
    expect(act({ status: 'waiting', waitingFor: 'dialog open' }, null, 'terminal')).toBe('Waiting on a prompt in its terminal');
  });
  it('reply shows the first non-empty line of the answer, else Finished', () => {
    expect(act({ status: 'idle' }, tail({ lastAnswer: '\n\n  Done: all tests pass.\nMore' }), 'reply')).toBe('Done: all tests pass.');
    expect(act({ status: 'idle' }, tail(), 'reply')).toBe('Finished');
    expect(act({ status: 'idle' }, null, 'reply')).toBe('Finished');
  });
  it('shell', () => {
    expect(act({ status: 'shell' }, pending('Bash', { command: 'ls' }))).toBe('A shell is still running');
  });
  it('busy editing a file', () => {
    for (const name of ['Edit', 'Write', 'MultiEdit']) {
      expect(act({}, pending(name, { file_path: '/repo/src/app.ts' }))).toBe('Editing app.ts');
    }
    expect(act({}, pending('NotebookEdit', { notebook_path: '/repo/n.ipynb', file_path: '/repo/n.ipynb' }))).toBe('Editing n.ipynb');
  });
  it('busy reading', () => {
    expect(act({}, pending('Read', { file_path: '/repo/README.md' }))).toBe('Reading README.md');
  });
  it('busy running Bash shows the description, else the command', () => {
    expect(act({}, pending('Bash', { command: 'npm test', description: 'Run the tests' }))).toBe('Run the tests');
    expect(act({}, pending('Bash', { command: 'npm test' }))).toBe('Running: npm test');
  });
  it('busy Bash with no command or description falls back to the tool name', () => {
    expect(act({}, pending('Bash'))).toBe('Using Bash');
    expect(act({}, pending('Bash', { command: '   ', description: '' }))).toBe('Using Bash');
  });
  it('busy searching the code', () => {
    expect(act({}, pending('Grep'))).toBe('Searching the code');
    expect(act({}, pending('Glob'))).toBe('Searching the code');
  });
  it('busy searching the web', () => {
    expect(act({}, pending('WebSearch'))).toBe('Searching the web');
    expect(act({}, pending('WebFetch'))).toBe('Searching the web');
  });
  it('busy delegating', () => {
    expect(act({}, pending('Agent', { description: 'Review the diff' }))).toBe('Delegating: Review the diff');
    expect(act({}, pending('Task', { description: 'Find tests' }))).toBe('Delegating: Find tests');
  });
  it('busy delegating with no description falls back to the tool name', () => {
    expect(act({}, pending('Agent'))).toBe('Using Agent');
    expect(act({}, pending('Task', { description: ' ' }))).toBe('Using Task');
  });
  it('busy with another tool', () => {
    expect(act({}, pending('TodoWrite'))).toBe('Using TodoWrite');
  });
  it('busy thinking', () => {
    expect(act({}, tail({ lastBlock: 'thinking' }))).toBe('Thinking');
  });
  it('busy writing a reply', () => {
    expect(act({}, tail({ lastBlock: 'text' }))).toBe('Writing a reply');
  });
  it('busy otherwise', () => {
    expect(act({}, tail({ lastBlock: 'tool_use' }))).toBe('Working');
    expect(act({}, null)).toBe('Working');
  });
  it('idle or unknown gives null', () => {
    expect(act({ status: 'idle' }, tail({ lastAnswer: 'hi' }))).toBeNull();
    expect(act({ status: 'compacting' }, tail())).toBeNull();
  });
  it('cuts to 80 characters on one line, a word too long to fit on its own cut hard with an ellipsis', () => {
    const line = act({}, pending('Bash', { command: `echo one\necho ${'x'.repeat(200)}` }));
    expect(line).not.toContain('\n');
    expect(line).toHaveLength(80);
    expect(line?.startsWith('Running: echo one echo x')).toBe(true);
    expect(line?.endsWith('x…')).toBe(true);
  });
  it('cuts a long line at a word boundary and ends it with an ellipsis', () => {
    // Character 80 falls inside "here", a word that would fit on its own: it is left out whole.
    const answer = `Done: ${'word '.repeat(10)}boundary sits right here and then some more`;
    const line = act({ status: 'idle' }, tail({ lastAnswer: answer }), 'reply');
    expect(answer.length).toBeGreaterThan(80);
    expect(line).toBe(`Done: ${'word '.repeat(10)}boundary sits right…`);
    expect(line!.length).toBeLessThanOrEqual(80);
  });
  it('keeps a line of exactly 80 characters whole', () => {
    const answer = 'y'.repeat(70) + ' 123456789';
    expect(act({ status: 'idle' }, tail({ lastAnswer: answer }), 'reply')).toBe(answer);
  });
});
