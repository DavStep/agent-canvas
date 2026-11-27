import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../../shared/chat.ts';
import { ToolRow, toolRowLabel, toolRowText } from './items/ToolRow.tsx';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
const tool = (patch: Partial<ToolItem>): ToolItem => ({
  kind: 'tool', id: 't1', at: 0, tool: 'other', name: 'Other', target: '', status: 'done', output: null, exitCode: null, diffs: [], ...patch,
});

describe('toolRowLabel', () => {
  it('names a read by its file', () => {
    expect(toolRowText(tool({ tool: 'read', name: 'Read', target: 'deploy/api.env' }))).toBe('Read deploy/api.env');
  });

  it('counts the lines a read returned', () => {
    expect(toolRowLabel(tool({ tool: 'read', name: 'Read', target: 'a.txt', output: 'one\ntwo\nthree\n' })).meta).toBe('3 lines');
  });

  it('gives an edit its added and removed counts over every file', () => {
    const edit = tool({
      tool: 'edit', name: 'Edit', target: 'deploy/api.env',
      diffs: [{ path: 'deploy/api.env', unified: '', added: 1, removed: 1 }],
    });
    expect(toolRowText(edit)).toBe('Edit deploy/api.env +1 −1');
    expect(toolRowLabel(edit)).toMatchObject({ name: 'Edit', target: 'deploy/api.env', added: 1, removed: 1 });
  });

  it('calls a Codex patch an edit and a Codex shell command Bash', () => {
    expect(toolRowLabel(tool({ tool: 'edit', name: 'apply_patch', target: 'a.ts' })).name).toBe('Edit');
    expect(toolRowLabel(tool({ tool: 'command', name: 'shell', target: 'ls' })).name).toBe('Bash');
  });

  it('shows a command whole when it is short', () => {
    expect(toolRowText(tool({ tool: 'command', name: 'Bash', target: 'ssh hostly systemctl restart api' }))).toBe('Bash ssh hostly systemctl restart api');
  });

  it('cuts a long command at 80 characters, on a word', () => {
    const words = 'npm run build && npm run test -- --reporter=verbose --coverage && node scripts/after-test.js --upload results';
    const label = toolRowLabel(tool({ tool: 'command', name: 'Bash', target: words }));
    expect(label.target.endsWith('…')).toBe(true);
    expect(label.target.length).toBeLessThanOrEqual(81);
    const kept = label.target.slice(0, -1);
    expect(words.startsWith(kept)).toBe(true);
    expect(words[kept.length]).toBe(' ');
  });

  it('cuts hard when the first word alone is longer than 80 characters', () => {
    const label = toolRowLabel(tool({ tool: 'command', name: 'Bash', target: 'x'.repeat(120) }));
    expect(label.target).toBe(`${'x'.repeat(80)}…`);
  });

  it('puts a multi-line command on one line', () => {
    expect(toolRowLabel(tool({ tool: 'command', name: 'Bash', target: 'cd app\n  && npm test' })).target).toBe('cd app && npm test');
  });

  it('gives a failed command its exit code', () => {
    expect(toolRowLabel(tool({ tool: 'command', name: 'Bash', target: 'npm test', status: 'failed', exitCode: 1 })).meta).toBe('exit 1');
  });

  it('says when a tool waits for the owner', () => {
    expect(toolRowLabel(tool({ tool: 'command', name: 'Bash', target: 'npm test', status: 'waiting' })).meta).toBe('waiting for you');
  });

  it('shows an MCP tool by its server and tool, not the mcp__ prefix', () => {
    expect(toolRowLabel(tool({ tool: 'mcp', name: 'mcp__github__search', target: 'q' })).name).toBe('github search');
  });
});

describe('ToolRow', () => {
  const render = (item: ToolItem, open: boolean, selected = false) =>
    renderToStaticMarkup(createElement(ToolRow, { item, open, selected, onToggle: () => {} }));
  const edit = tool({
    tool: 'edit', name: 'Edit', target: 'deploy/api.env',
    diffs: [{ path: 'deploy/api.env', unified: '@@ -13,1 +13,1 @@\n-DELETE_APPROVAL=0\n+DELETE_APPROVAL=1', added: 1, removed: 1 }],
  });

  it('is one line when closed: name, target and counts, no diff', () => {
    const out = render(edit, false);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-label="Edit deploy/api.env +1 −1"');
    expect(out).toContain('<span class="plus">+1</span><span class="minus">−1</span>');
    expect(out).not.toContain('t-diff');
  });

  it('opens in place to its diff, and marks the selected row', () => {
    const out = render(edit, true, true);
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('class="t-tool is-selected is-done"');
    expect(out).toContain('<div class="ln del"><span class="no">13</span><span class="sg">−</span>');
    expect(out).toContain('<div class="ln add"><span class="no">13</span><span class="sg">+</span>');
  });

  it('opens a command to its output', () => {
    const out = render(tool({ tool: 'command', name: 'Bash', target: 'npm test', output: '✓ 42 tests passed\n' }), true);
    expect(out).toContain('<pre class="t-output">✓ 42 tests passed\n</pre>');
    const coloured = render(tool({ tool: 'command', name: 'Bash', target: 'npm test', output: '\u001b[32m✓\u001b[39m 42 tests passed\n' }), true);
    expect(coloured).toContain('<pre class="t-output">✓ 42 tests passed\n</pre>');
  });

  it('has nothing to open without a diff or output', () => {
    const out = render(tool({ tool: 'read', name: 'Read', target: 'a.txt' }), true);
    expect(out).not.toContain('aria-expanded');
    expect(out).not.toContain('t-output');
  });

  describe('state: one small dot and word, and a plain row once done', () => {
    const task = (status: ToolItem['status']) => tool({ tool: 'mcp', name: 'mcp__canvas__start_task', target: '/work/demo', status });

    it('a running call has a green dot and "running"', () => {
      const out = render(task('running'), false);
      expect(out).toContain('class="t-tool is-running"');
      expect(out).toContain('<span class="m"><i class="dot working"></i>running</span>');
    });

    it('a call waiting on the owner has an amber dot and "waiting for you"', () => {
      const out = render(task('waiting'), false);
      expect(out).toContain('<span class="m is-waiting"><i class="dot needs"></i>waiting for you</span>');
    });

    it('once its result arrives the same call is a plain row: no dot, no word', () => {
      const out = render({ ...task('done'), output: 'Handed the task to the project orchestrator.' }, false);
      expect(out).toContain('class="t-tool is-done"');
      expect(out).toContain('<span class="m"></span>');
      expect(out).not.toContain('dot');
    });

    it('an answered question\'s call has no attention style', () => {
      const out = render(tool({ name: 'AskUserQuestion', status: 'done', output: 'Your questions have been answered' }), false);
      expect(out).not.toMatch(/is-waiting|is-selected|dot needs|waiting for you/);
    });
  });
});
