import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../../shared/chat.ts';
import { editorUrl, LiveWork, shownTool, turnTools, type LiveWorkProps } from './LiveWork.tsx';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
const tool = (id: string, patch: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', id, at: 0, tool: 'other', name: 'Other', target: '', status: 'done', output: null, exitCode: null, diffs: [], ...patch,
});
const user = (id: string): ChatItem => ({ kind: 'user', id, at: 0, text: 'go', images: [] });
const reply = (id: string): ChatItem => ({ kind: 'assistant', id, at: 0, text: 'ok', streaming: false });

const DIFF = ['--- a/deploy/api.env', '+++ b/deploy/api.env', '@@ -11,4 +11,4 @@', ' # Accounts', ' ACCOUNT_DELETION=enabled', '-DELETE_APPROVAL=0', '+DELETE_APPROVAL=1', ' DELETE_APPROVAL_TIMEOUT=72h'].join('\n');
const read = tool('r', { tool: 'read', name: 'Read', target: 'deploy/api.env', output: 'A=1\nB=2\n' });
const edit = tool('e', { tool: 'edit', name: 'Edit', target: 'deploy/api.env', diffs: [{ path: 'deploy/api.env', unified: DIFF, added: 1, removed: 1 }] });
const bash = tool('b', { tool: 'command', name: 'Bash', target: 'ssh hostly systemctl restart api', status: 'waiting' });

describe('turnTools', () => {
  it("lists the current turn's tool calls in order: those after the owner's last message", () => {
    const items: ChatItem[] = [user('u1'), tool('old'), reply('a1'), user('u2'), read, reply('a2'), edit, bash];
    expect(turnTools(items).map((t) => t.id)).toEqual(['r', 'e', 'b']);
  });

  it('is empty when the owner has just written', () => {
    expect(turnTools([tool('old'), user('u2')])).toEqual([]);
  });

  it('takes every tool when no message of the owner is loaded', () => {
    expect(turnTools([tool('a'), reply('x'), tool('b')]).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('shownTool', () => {
  const items: ChatItem[] = [user('u0'), tool('old'), user('u1'), read, edit, bash];
  it('follows the newest call of the turn', () => {
    expect(shownTool(items, true, 'r')?.id).toBe('b');
    expect(shownTool([user('u1')], true, null)).toBeNull();
  });

  it('shows the picked call when not following, wherever it is in the thread', () => {
    expect(shownTool(items, false, 'e')?.id).toBe('e');
    expect(shownTool(items, false, 'old')?.id).toBe('old');
    expect(shownTool(items, false, null)).toBeNull();
    expect(shownTool(items, false, 'gone')).toBeNull();
  });
});

describe('editorUrl', () => {
  it('opens absolute paths as they are and relative ones from the session folder', () => {
    expect(editorUrl('/Users/demo/app/a.ts', '/elsewhere')).toBe('vscode://file/Users/demo/app/a.ts');
    expect(editorUrl('deploy/api.env', '/Users/demo/Documents/garden-sim')).toBe('vscode://file/Users/demo/Documents/garden-sim/deploy/api.env');
    expect(editorUrl('./src/a.ts', '/w/')).toBe('vscode://file/w/src/a.ts');
  });

  it('escapes what would read as a query or fragment, and spaces', () => {
    expect(editorUrl('/w/My Folder/a?b#c.ts', '/')).toBe('vscode://file/w/My%20Folder/a%3Fb%23c.ts');
  });

  it('gives nothing for a path that climbs out or has no folder to start from', () => {
    expect(editorUrl('../x.ts', '/w')).toBeNull();
    expect(editorUrl('a.ts', '')).toBeNull();
    expect(editorUrl('', '/w')).toBeNull();
  });
});

describe('LiveWork', () => {
  const base: LiveWorkProps = {
    items: [user('u1'), read, edit, bash], cwd: '/Users/demo/Documents/garden-sim', shown: edit, canOpenInEditor: true,
    onPick: () => {}, onOpenInEditor: () => {},
  };
  const render = (p: Partial<LiveWorkProps> = {}) => renderToStaticMarkup(createElement(LiveWork, { ...base, ...p }));

  it('lists the turn with its count and marks the shown call', () => {
    const html = render();
    expect(html).toContain('This turn');
    expect(html).toContain('3 calls');
    expect(html.match(/class="pv-call[^"]*is-selected/g)).toHaveLength(1);
    expect(html).toMatch(/is-selected[^>]*aria-label="Edit deploy\/api.env \+1 −1"/);
    expect(html).toContain('waiting for you');
    expect(render({ items: [user('u1'), read] })).toContain('1 call<');
  });

  it("shows an edit's full diff with old and new line numbers and the hunk", () => {
    const html = render();
    expect(html).toContain('@@ -11,4 +11,4 @@');
    expect(html).toMatch(/<div class="ln del"><span class="no">13<\/span><span class="no"><\/span>/);
    expect(html).toMatch(/<div class="ln add"><span class="no"><\/span><span class="no">13<\/span>/);
    expect(html).toContain('Open in editor');
  });

  it('a long diff is not cut', () => {
    const body = Array.from({ length: 500 }, (_, i) => `+line ${i}`).join('\n');
    const big = tool('big', { tool: 'edit', name: 'Write', target: 'a.ts', diffs: [{ path: 'a.ts', unified: `@@ -0,0 +1,500 @@\n${body}`, added: 500, removed: 0 }] });
    const html = render({ items: [user('u'), big], shown: big });
    expect(html.match(/class="ln add"/g)).toHaveLength(500);
    expect(html).not.toContain('more lines');
  });

  it('hides "Open in editor" when VS Code is not there', () => {
    expect(render({ canOpenInEditor: false })).not.toContain('Open in editor');
  });

  it("shows a command's output in monospace with ANSI codes stripped", () => {
    const run = tool('c', { tool: 'command', name: 'Bash', target: 'npm test', output: '\u001b[32m✓\u001b[39m 42 tests passed\n', exitCode: 0 });
    const html = render({ items: [user('u'), run], shown: run });
    expect(html).toMatch(/<pre class="pv-output">✓ 42 tests passed\n<\/pre>/);
    expect(html).not.toContain('\u001b');
    expect(html).not.toContain('Open in editor');
  });

  it('shows the excerpt a read returned', () => {
    const html = render({ shown: read });
    expect(html).toMatch(/<pre class="pv-output">A=1\nB=2\n<\/pre>/);
  });

  it('says so when the turn has no calls yet', () => {
    expect(render({ items: [user('u1')], shown: null })).toContain('No calls this turn yet');
  });
});
