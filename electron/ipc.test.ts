import { describe, expect, it } from 'vitest';
import { BRIDGE_METHODS, CHANNELS, validate } from './ipc.ts';

describe('channels', () => {
  it('every bridge method has exactly one channel', () => {
    expect(Object.keys(CHANNELS).sort()).toEqual([...BRIDGE_METHODS].sort());
    expect(new Set(BRIDGE_METHODS).size).toBe(BRIDGE_METHODS.length);
    const names = Object.values(CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^canvas:/);
  });
});

describe('validate', () => {
  it('validators reject wrong shapes', () => {
    expect(() => validate.layoutOp({ op: 'nope' })).toThrow();
    expect(() => validate.layoutOp({ type: 'moveZone', id: 'z', x: 'a', y: 1 })).toThrow();
    expect(() => validate.layoutOp(null)).toThrow();
    expect(() => validate.openExternal('file:///etc/passwd')).toThrow();
    expect(() => validate.openExternal('javascript:alert(1)')).toThrow();
    expect(() => validate.openExternal('not a url')).toThrow();
    expect(() => validate.openExternal(42)).toThrow();
    expect(() => validate.openExternal('https://x.test')).not.toThrow();
    expect(() => validate.openExternal('mailto:someone@x.test')).not.toThrow();
    expect(() => validate.openExternal('data:text/html,hi')).toThrow();
    expect(() => validate.openExternal('claude://code/continue?session=a')).not.toThrow();
    expect(() => validate.markSeen('all')).toThrow();
    expect(() => validate.markSeen([1])).toThrow();
    expect(() => validate.settings({ openAtLogin: 'yes' })).toThrow();
  });

  it('passes well-formed values on, keeping only the known fields', () => {
    expect(validate.layoutOp({ type: 'moveZone', id: 'z', x: 1, y: 2, extra: true })).toEqual({ type: 'moveZone', id: 'z', x: 1, y: 2 });
    expect(validate.layoutOp({ type: 'assign', sessionId: 's', zoneId: null })).toEqual({ type: 'assign', sessionId: 's', zoneId: null });
    expect(validate.layoutOp({ type: 'hideZone', id: 'folder:a', at: 5, extra: 1 })).toEqual({ type: 'hideZone', id: 'folder:a', at: 5 });
    expect(validate.layoutOp({ type: 'hideZone', id: 'folder:a', at: null })).toEqual({ type: 'hideZone', id: 'folder:a', at: null });
    expect(() => validate.layoutOp({ type: 'hideZone', id: 'folder:a', at: 'now' })).toThrow();
    expect(validate.layoutOp({ type: 'addFolderZone', path: '/Users/me/code/gamma', extra: 1 })).toEqual({ type: 'addFolderZone', path: '/Users/me/code/gamma' });
    for (const bad of ['code/gamma', '', 42, null, '/a\0b', `/${'x'.repeat(5000)}`]) expect(() => validate.layoutOp({ type: 'addFolderZone', path: bad })).toThrow();
    expect(validate.markSeen(['a', 'b'])).toEqual(['a', 'b']);
    expect(validate.settings({ openAtLogin: true, other: 1 })).toEqual({ openAtLogin: true });
    expect(validate.settings({ defaults: { codex: { model: 'gpt-6.2-astra', effort: 'high', x: 1 } }, shownModels: { claude: ['opus', 'opus'], codex: null } }))
      .toEqual({ defaults: { codex: { model: 'gpt-6.2-astra', effort: 'high' } }, shownModels: { claude: ['opus'], codex: null } });
    expect(() => validate.settings({ defaults: { gemini: { model: null, effort: null } } })).toThrow();
    expect(() => validate.settings({ defaults: { claude: { model: '', effort: null } } })).toThrow();
    expect(() => validate.settings({ shownModels: { claude: 'opus' } })).toThrow();
    // The canvas's "Open in Codex" button links to the Codex app.
    expect(validate.openExternal('codex://threads/abc')).toBe('codex://threads/abc');
  });
});

describe('validate: chat calls', () => {
  const png = { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };

  it("the agent's first message: text, images or both, checked like any message, never nothing", () => {
    expect(validate.agentMessage('What is going on?', [])).toEqual({ text: 'What is going on?', images: [] });
    expect(validate.agentMessage('', [{ ...png, extra: 1 }])).toEqual({ text: '', images: [png] });
    expect(() => validate.agentMessage('  \n', [])).toThrow('the agent needs a first message');
    expect(() => validate.agentMessage(42, [])).toThrow();
    expect(() => validate.agentMessage('hi', undefined)).toThrow();
    expect(() => validate.agentMessage('hi', [{ mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,AA==' }])).toThrow();
    expect(() => validate.agentMessage('x'.repeat(200_001), [])).toThrow();
  });

  it('the agent has its channels: its own two, and open_session pushing a card to open', () => {
    expect(CHANNELS.agentInfo).toBe('canvas:agentInfo');
    expect(CHANNELS.startAgent).toBe('canvas:startAgent');
    expect(CHANNELS.onOpenSession).toBe('canvas:openSession');
  });

  it('session ids are non-empty strings', () => {
    expect(validate.sessionId('codex:t1')).toBe('codex:t1');
    for (const bad of ['', 42, null, 'x'.repeat(5000), ['a']]) expect(() => validate.sessionId(bad)).toThrow();
  });

  it('messages: text up to 200 000 characters and images as base64 data URLs of the four image types', () => {
    expect(validate.message('hi', [png])).toEqual({ text: 'hi', images: [png] });
    expect(validate.message('long '.repeat(10_000), []).text).toHaveLength(50_000);
    expect(validate.message('', [{ ...png, extra: 1 }]).images).toEqual([png]);
    expect(() => validate.message('x'.repeat(200_001), [])).toThrow();
    expect(() => validate.message(1, [])).toThrow();
    expect(() => validate.message('hi', 'nope')).toThrow();
    expect(() => validate.message('hi', [{ mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }])).toThrow();
    expect(() => validate.message('hi', [{ mime: 'image/png', dataUrl: 'file:///etc/passwd' }])).toThrow();
    expect(() => validate.message('hi', [{ mime: 'image/png', dataUrl: 'data:image/jpeg;base64,AAAA' }])).toThrow();
    expect(() => validate.message('hi', Array.from({ length: 21 }, () => png))).toThrow();
  });

  it('approval answers, question answers and picker choices', () => {
    for (const a of ['allow', 'allowAlways', 'deny']) expect(validate.approvalAnswer(a)).toBe(a);
    expect(() => validate.approvalAnswer('maybe')).toThrow();
    expect(validate.answers({ 'Which one?': 'B', extra: 'x' })).toEqual({ 'Which one?': 'B', extra: 'x' });
    expect(() => validate.answers({ q: 1 })).toThrow();
    expect(() => validate.answers(['B'])).toThrow();
    expect(validate.choice('opus')).toBe('opus');
    expect(() => validate.choice('')).toThrow();
  });

  it('new session requests', () => {
    const req = { provider: 'claude', cwd: '/work/a', model: null, mode: 'plan', text: 'Start', images: [], other: 1 };
    expect(validate.newSession(req)).toEqual({ provider: 'claude', cwd: '/work/a', model: null, effort: null, mode: 'plan', text: 'Start', images: [] });
    expect(validate.newSession({ ...req, effort: 'high' }).effort).toBe('high');
    expect(() => validate.newSession({ ...req, effort: 2 })).toThrow();
    expect(() => validate.newSession({ ...req, provider: 'gemini' })).toThrow();
    expect(() => validate.newSession({ ...req, cwd: 'relative/path' })).toThrow();
    expect(() => validate.newSession({ ...req, model: 3 })).toThrow();
    expect(() => validate.newSession({ ...req, mode: '' })).toThrow();
    expect(() => validate.newSession({ ...req, text: '' })).toThrow();
  });

  it('ACP: a new session names its agent; options take one; settings check each agent in full', () => {
    const req = { provider: 'acp', agent: 'gemini', cwd: '/work/a', model: null, mode: null, text: 'Start', images: [] };
    expect(validate.newSession(req)).toEqual({ provider: 'acp', agent: 'gemini', cwd: '/work/a', model: null, effort: null, mode: null, text: 'Start', images: [] });
    expect(() => validate.newSession({ ...req, agent: undefined })).toThrow();
    expect(() => validate.newSession({ ...req, agent: '../x' })).toThrow();
    expect(validate.newSession({ ...req, provider: 'claude' })).not.toHaveProperty('agent');
    expect(validate.options('acp', 'gemini')).toEqual({ provider: 'acp', agent: 'gemini' });
    expect(validate.options('codex', 'ignored')).toEqual({ provider: 'codex' });
    expect(() => validate.options('acp', 7)).toThrow();
    const gemini = { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'], env: {}, icon: 'agent' };
    expect(validate.settings({ acpAgents: [gemini] })).toEqual({ acpAgents: [gemini] });
    expect(() => validate.settings({ acpAgents: [{ ...gemini, command: '' }] })).toThrow();
    expect(() => validate.settings({ acpAgents: [gemini, gemini] })).toThrow();
    expect(() => validate.settings({ acpAgents: [{ ...gemini, id: 'claude' }] })).toThrow();
  });

  it("the new session dialog's calls: a provider's options, and the folder picker", () => {
    expect(validate.provider('claude')).toBe('claude');
    expect(validate.provider('codex')).toBe('codex');
    for (const bad of ['gemini', '', null, 1, ['claude'], { provider: 'claude' }]) expect(() => validate.provider(bad)).toThrow(/claude or codex/);
    // The picker takes nothing from the page, and hands back an absolute folder or nothing.
    expect(validate.noArgs([])).toBeUndefined();
    expect(() => validate.noArgs(['/etc'])).toThrow(/takes no arguments/);
    expect(validate.pickedFolder({ canceled: false, filePaths: ['/Users/me/work'] })).toBe('/Users/me/work');
    expect(validate.pickedFolder({ canceled: true, filePaths: ['/Users/me/work'] })).toBeNull();
    expect(validate.pickedFolder({ canceled: false, filePaths: [] })).toBeNull();
    expect(validate.pickedFolder({ canceled: false, filePaths: ['relative'] })).toBeNull();
  });

  it('the new calls each have a channel', () => {
    expect(CHANNELS.pickFolder).toBe('canvas:pickFolder');
    expect(CHANNELS.options).toBe('canvas:options');
    expect(CHANNELS.onAccountsChanged).toBe('canvas:accountsChanged');
  });

  it('"Show in Finder" takes an absolute file path and nothing else', () => {
    expect(CHANNELS.revealFile).toBe('canvas:revealFile');
    expect(validate.filePath('/Users/me/A folder/report "v2".pdf')).toBe('/Users/me/A folder/report "v2".pdf');
    for (const bad of ['', 'relative.txt', '/a/../b', '/a/./b', '/a\0b', 42, null, `/${'x'.repeat(5000)}`, '/']) {
      expect(() => validate.filePath(bad)).toThrow();
    }
  });

  it('"Show in Terminal" takes the card id and nothing else: never a path from the page', () => {
    expect(CHANNELS.showHost).toBe('canvas:showHost');
    expect(validate.showHost(['card-1'])).toBe('card-1');
    for (const bad of [[], [''], [42], [null], ['x'.repeat(5000)], [{ id: 'card-1' }]]) expect(() => validate.showHost(bad)).toThrow();
    expect(() => validate.showHost(['card-1', '/Applications/Terminal.app'])).toThrow(/only the card/);
  });

  it('the app bundle main opens is an absolute .app folder with no . or .. step', () => {
    expect(validate.appBundle('/System/Applications/Utilities/Terminal.app')).toBe('/System/Applications/Utilities/Terminal.app');
    expect(validate.appBundle('/Applications/Visual Studio Code.app')).toBe('/Applications/Visual Studio Code.app');
    for (const bad of ['Terminal.app', '/Applications/Terminal', '/Applications/../tmp/x.app', '/Applications/./X.app', '/bin/sh', '', 1, '/a\0.app']) {
      expect(() => validate.appBundle(bad)).toThrow();
    }
  });
});

describe('validate: preview and the editor link', () => {
  it('preview commands: show with bounds or null, navigate with typed, back, reload', () => {
    const bounds = { x: 1076, y: 120, width: 348, height: 700 };
    expect(validate.preview({ kind: 'show', bounds: { ...bounds, extra: 1 } })).toEqual({ kind: 'show', bounds });
    expect(validate.preview({ kind: 'show', bounds: null })).toEqual({ kind: 'show', bounds: null });
    expect(validate.preview({ kind: 'navigate', url: 'http://localhost:5173/', typed: false, other: 1 }))
      .toEqual({ kind: 'navigate', url: 'http://localhost:5173/', typed: false });
    expect(validate.preview({ kind: 'navigate', url: 'https://example.com/', typed: true })).toEqual({ kind: 'navigate', url: 'https://example.com/', typed: true });
    expect(validate.preview({ kind: 'back' })).toEqual({ kind: 'back' });
    expect(validate.preview({ kind: 'reload', x: 1 })).toEqual({ kind: 'reload' });
    expect(validate.preview({ kind: 'clear', url: 'file:///etc/passwd' })).toEqual({ kind: 'clear' });
    expect(validate.preview({ kind: 'navigate', url: 'http://localhost:5173/', typed: false, fresh: true }))
      .toEqual({ kind: 'navigate', url: 'http://localhost:5173/', typed: false, fresh: true });
    expect(() => validate.preview({ kind: 'navigate', url: 'http://localhost:5173/', typed: false, fresh: 'yes' })).toThrow(/fresh/);
  });

  it('preview commands: navigate must say whether the owner typed it; bounds must be sizes on screen', () => {
    expect(() => validate.preview({ kind: 'navigate', url: 'http://localhost:5173/' })).toThrow(/typed/);
    expect(() => validate.preview({ kind: 'navigate', url: 'http://localhost:5173/', typed: 'yes' })).toThrow(/typed/);
    expect(() => validate.preview({ kind: 'navigate', url: '', typed: true })).toThrow();
    expect(() => validate.preview({ kind: 'navigate', url: 'x'.repeat(5000), typed: true })).toThrow();
    expect(() => validate.preview({ kind: 'show', bounds: { x: 0, y: 0, width: -1, height: 10 } })).toThrow();
    expect(() => validate.preview({ kind: 'show', bounds: { x: 0, y: 0, width: Number.NaN, height: 10 } })).toThrow();
    expect(() => validate.preview({ kind: 'show', bounds: { x: 0, y: 0, width: 1e9, height: 10 } })).toThrow();
    expect(() => validate.preview({ kind: 'show' })).toThrow();
    expect(() => validate.preview({ kind: 'forward' })).toThrow();
    expect(() => validate.preview(null)).toThrow();
  });

  it('openExternal: vscode://file/ with an absolute path only, no query or fragment', () => {
    expect(validate.openExternal('vscode://file/Users/demo/Documents/app/src/a.ts')).toBe('vscode://file/Users/demo/Documents/app/src/a.ts');
    expect(validate.openExternal('vscode://file/Users/demo/My%20Folder/a.ts')).toBe('vscode://file/Users/demo/My%20Folder/a.ts');
    for (const bad of [
      'vscode://file/', 'vscode://file', 'vscode://file/Users/demo/a.ts?windowId=_blank', 'vscode://file/Users/demo/a.ts#L3',
      'vscode://file/Users/demo/a.ts?', 'vscode://file/Users/demo/../../etc/passwd', 'vscode://file/Users/demo/./a.ts',
      'vscode://settings/foo', 'vscode://vscode.git/clone?url=x', 'vscode:file/Users/a.ts', 'vscode://file/Users/demo/%2e%2e/a.ts',
    ]) {
      expect(() => validate.openExternal(bad), bad).toThrow();
    }
  });
});
