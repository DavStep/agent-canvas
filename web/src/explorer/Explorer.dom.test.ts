// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CanvasBridge } from '../../../shared/bridge.ts';
import type { GitStatus } from '../../../shared/projectGit.ts';
import type { DirListing, FilePreview } from '../../../shared/files.ts';
import type { ZoneLayout } from '../../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LISTINGS: Record<string, DirListing> = {
  '': { truncated: false, entries: [
    { name: 'node_modules', kind: 'dir', size: 0, ignored: true },
    { name: 'src', kind: 'dir', size: 0, ignored: false },
    { name: 'broken.json', kind: 'file', size: 9, ignored: false },
    { name: 'logo.png', kind: 'file', size: 68, ignored: false },
    { name: 'package.json', kind: 'file', size: 30, ignored: false },
  ] },
  src: { truncated: false, entries: [{ name: 'main.ts', kind: 'file', size: 12, ignored: false }] },
};
const PREVIEWS: Record<string, FilePreview> = {
  'package.json': { kind: 'json', size: 30, text: '{"name":"demo","scripts":{"dev":"vite"},"private":true}' },
  'broken.json': { kind: 'json', size: 9, text: '{"name":' },
  'logo.png': { kind: 'image', size: 68, mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
  'src/main.ts': { kind: 'text', size: 12, text: 'export {};\n' },
};
const list = vi.fn(async (_root: string, dir: string) => LISTINGS[dir] ?? Promise.reject(new Error("Error invoking remote method 'canvas:listFiles': Error: This folder can’t be read.")));
const preview = vi.fn(async (_root: string, f: string) => PREVIEWS[f]!);
const revealFile = vi.fn(async () => {});

const gitStatus = vi.fn<() => Promise<GitStatus>>();
const gitAction = vi.fn(async () => {});
const gitDiff = vi.fn(async () => 'Working tree\n+incoming');
const projectTask = vi.fn(async () => 'project-chat');
const onOpenChat = vi.fn();

let Explorer: typeof import('./Explorer.tsx').Explorer;
beforeAll(async () => {
  // The bridge reads window.canvas once, when first imported.
  window.canvas = { gitStatus, gitDiff, gitAction, projectTask, listFiles: list, previewFile: preview, revealFile, canOpenInEditor: async () => false } as unknown as CanvasBridge;
  ({ Explorer } = await import('./Explorer.tsx'));
});

const zone: ZoneLayout = { id: 'folder:demo', name: 'demo', kind: 'folder', folder: 'demo', path: '/Users/sam/demo', x: null, y: null, hueIndex: 0 };
let host: HTMLElement | null = null;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = null; root = null; vi.clearAllMocks(); });

async function mount(onClose = () => {}) {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => root!.render(createElement(Explorer, { zone, onOpenChat, root: '/Users/sam/demo', onClose })));
  const el = host;
  const row = (path: string) => el.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
  const click = async (target: Element) => { await act(async () => { (target as HTMLElement).click(); }); };
  const key = async (target: Element, k: string) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
  };
  return { el, row, click, key };
}

describe('Explorer', () => {
  it('lists the root once, folders first, the noisy ones quiet, and says where it is', async () => {
    const { el, row } = await mount();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('/Users/sam/demo', '');
    expect([...el.querySelectorAll('[role="treeitem"]')].map((r) => r.getAttribute('data-path'))).toEqual(['node_modules', 'src', 'broken.json', 'logo.png', 'package.json']);
    expect(row('node_modules').className).toContain('is-ignored');
    expect(el.querySelector('.ex-root')!.textContent).toBe('~/demo');
    expect(el.getAttribute('aria-label') ?? el.querySelector('aside')!.getAttribute('aria-label')).toBe('Files in demo');
  });

  it('lists a folder only when it is opened, and folds it again without asking twice', async () => {
    const { row, click } = await mount();
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    await click(row('src'));
    expect(list).toHaveBeenLastCalledWith('/Users/sam/demo', 'src');
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    expect(row('src/main.ts').getAttribute('aria-level')).toBe('2');
    await click(row('src'));
    expect(row('src/main.ts')).toBeNull();
    await click(row('src'));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('previews JSON as a foldable outline, with Text for the raw file', async () => {
    const { el, row, click } = await mount();
    await click(row('package.json'));
    expect(preview).toHaveBeenCalledWith('/Users/sam/demo', 'package.json');
    expect(row('package.json').getAttribute('aria-selected')).toBe('true');
    const outline = el.querySelector('.jv')!;
    expect(outline.querySelector('.jv-key')!.textContent).toBe('"name"');
    expect(outline.querySelector('.jv-string')!.textContent).toBe('"demo"');
    expect(outline.querySelector('.jv-boolean')!.textContent).toBe('true');
    const fold = [...outline.querySelectorAll<HTMLButtonElement>('.jv-toggle')].find((b) => b.getAttribute('aria-label') === 'Fold scripts')!;
    await click(fold);
    expect(outline.querySelector('.jv-fold')!.textContent).toBe('1 key');
    await click([...el.querySelectorAll('.ex-seg button')].find((b) => b.textContent === 'Text')!);
    expect(el.querySelector('.ex-text')!.textContent).toContain('"scripts"');
  });

  it('shows invalid JSON as its text, with the parse error', async () => {
    const { el, row, click } = await mount();
    await click(row('broken.json'));
    expect(el.querySelector('.ex-parse-error')!.textContent).toContain('Not valid JSON');
    expect(el.querySelector('.ex-text')!.textContent).toBe('{"name":');
  });

  it('previews an image with its size and type, and a text file as it is', async () => {
    const { el, row, click } = await mount();
    await click(row('logo.png'));
    expect(el.querySelector<HTMLImageElement>('.ex-image img')!.src).toBe('data:image/png;base64,AAAA');
    expect(el.querySelector('.ex-image-facts')!.textContent).toContain('68 B');
    expect(el.querySelector('.ex-image-facts')!.textContent).toContain('PNG');
    await click(row('src'));
    await click(row('src/main.ts'));
    expect(el.querySelector('.ex-text')!.textContent).toBe('export {};\n');
    expect(el.querySelector('.ex-pv-path')!.textContent).toBe('src · 12 B');
  });

  it('opens a file in its own panel beside the tree, which Esc and × close', async () => {
    const { el, row, click, key } = await mount();
    await click(row('package.json'));
    const viewer = el.querySelector<HTMLElement>('section.ex-viewer')!;
    expect(viewer.getAttribute('aria-label')).toBe('Preview of package.json');
    expect(viewer.closest('aside')).toBeNull();
    expect(el.querySelector('aside')!.nextElementSibling).toBe(viewer);
    expect(row('package.json').getAttribute('aria-selected')).toBe('true');
    // Another file takes the same panel's place.
    await click(row('logo.png'));
    expect(el.querySelectorAll('.ex-viewer')).toHaveLength(1);
    expect(el.querySelector('.ex-viewer')!.getAttribute('aria-label')).toBe('Preview of logo.png');
    await key(el.querySelector('.ex-viewer [aria-label="Show in Finder"]')!, 'Escape');
    expect(el.querySelector('.ex-viewer')).toBeNull();
    await click(row('package.json'));
    await click(el.querySelector('[aria-label="Close preview"]')!);
    expect(el.querySelector('.ex-viewer')).toBeNull();
  });

  it('Show in Finder selects the file by its full path', async () => {
    const { el, row, click } = await mount();
    await click(row('logo.png'));
    await click(el.querySelector('[aria-label="Show in Finder"]')!);
    expect(revealFile).toHaveBeenCalledWith('/Users/sam/demo/logo.png');
  });

  it('Esc closes the preview first, then the explorer; × closes it too', async () => {
    const onClose = vi.fn();
    const { el, row, click, key } = await mount(onClose);
    await click(row('package.json'));
    await key(row('package.json'), 'Escape');
    expect(el.querySelector('.ex-viewer')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await key(row('package.json'), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(el.querySelector('[aria-label="Close files"]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('the arrow keys move along the rows and open and close folders', async () => {
    const { row, key } = await mount();
    row('node_modules').focus();
    await key(row('node_modules'), 'ArrowDown');
    expect(document.activeElement).toBe(row('src'));
    await key(row('src'), 'ArrowRight');
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    await key(row('src'), 'ArrowRight');
    expect(document.activeElement).toBe(row('src/main.ts'));
    await key(row('src/main.ts'), 'ArrowLeft');
    expect(document.activeElement).toBe(row('src'));
    await key(row('src'), 'ArrowLeft');
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    expect(row('src').tabIndex).toBe(0);
    expect(row('node_modules').tabIndex).toBe(-1);
  });

  it('says why a folder cannot be shown, without Electron\'s wrapping', async () => {
    const { el, row, click } = await mount();
    list.mockImplementationOnce(async () => { throw new Error("Error invoking remote method 'canvas:listFiles': Error: That link leads outside the project folder."); });
    await click(row('src'));
    expect(el.querySelector('.ex-sub.is-error')!.textContent).toBe('That link leads outside the project folder.');
  });
});

it('opens a conflict diff and hands the checkout to its project orchestrator', async () => {
  gitStatus.mockResolvedValue({ branch: 'main', head: 'abc', indexVersion: 'v', conflicts: true, stagedOutside: false,
    pushTo: null, ahead: null, files: [{ path: 'src/config', index: 'U', worktree: 'U' }] });
  const { el, click, key } = await mount();
  await key(el.querySelector('[role="tab"]')!, 'ArrowRight');
  expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Git');
  await click(el.querySelector('[aria-label="View diff for src/config"]')!);
  expect(el.querySelector('pre')?.textContent).toContain('+incoming');
  const merge = Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'Merge with AI');
  await click(merge!);
  expect(projectTask).toHaveBeenCalledWith('/Users/sam/demo', expect.stringContaining('conflicts'), []);
  expect(onOpenChat).toHaveBeenCalledWith('project-chat');
});

it('bulk selection respects the issues filter, partial staging, and unresolved conflicts', async () => {
  const modified = { path: 'src/a', index: ' ', worktree: 'M' };
  const partial = { path: 'src/b', index: 'M', worktree: 'M' };
  const conflict = { path: 'src/c', index: 'U', worktree: 'D' };
  const state = { branch: 'main', head: 'abc', indexVersion: 'v', conflicts: true, stagedOutside: false,
    pushTo: null, ahead: null, files: [modified, { ...partial, issues: [{ staged: false, line: 8, message: 'trailing whitespace.' }] }, conflict] };
  gitStatus.mockResolvedValue(state);
  const { el, click } = await mount();
  const button = (text: string) => Array.from(el.querySelectorAll('button')).find(b => b.textContent === text)!;
  await click(button('Git'));
  await click(button('Select all'));
  expect(gitAction).toHaveBeenLastCalledWith('/Users/sam/demo', { type: 'stage', branch: 'main', head: 'abc',
    indexVersion: 'v', files: [modified, partial] });
  await click(button('Review 2 files with issues'));
  expect(el.querySelector('[aria-label="View diff for src/a"]')).toBeNull();
  expect(el.textContent).toContain('Deleted by them');
  await click(button('Deselect shown'));
  expect(gitAction).toHaveBeenLastCalledWith('/Users/sam/demo', expect.objectContaining({ type: 'unstage', files: [partial] }));
  await click(el.querySelector('[aria-label="View diff for src/b"]')!);
  expect(el.querySelector('.git-findings')?.textContent).toContain('Unstaged · Line 8 trailing whitespace.');
});

it('push shows what it would send, refuses an empty push, and reads Git again when the pointer returns', async () => {
  const base = { branch: 'main', head: 'abc', indexVersion: 'v', conflicts: false, stagedOutside: false,
    pushTo: { remote: 'origin', branch: 'main' }, files: [{ path: 'src/a', index: ' ', worktree: 'M' }] };
  gitStatus.mockResolvedValue({ ...base, ahead: 0 });
  const { el, click } = await mount();
  const push = () => Array.from(el.querySelectorAll<HTMLButtonElement>('.git-action')).find(b => b.textContent?.startsWith('Push'))!;
  await click(Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'Git')!);
  expect(push().disabled).toBe(true);
  expect(push().title).toContain('Nothing to push');
  // An agent commits twice while the tab is open; the window never lost focus.
  gitStatus.mockResolvedValue({ ...base, head: 'def', ahead: 2 });
  await act(async () => { el.querySelector('.git-panel')!.dispatchEvent(new Event('pointerover', { bubbles: true })); });
  expect(push().textContent).toBe('Push (2)');
  expect(push().disabled).toBe(false);
  await click(push());
  expect(gitAction).toHaveBeenLastCalledWith('/Users/sam/demo', { type: 'push', branch: 'main', head: 'def', remote: 'origin', destination: 'main' });
  expect(el.textContent).toContain('Pushed 2 commits to origin/main.');
});

it('Git stands on its frame while the first read is out, keeps a diff while Git is read again, and comes back with the status it last showed', async () => {
  const status: GitStatus = { branch: 'main', head: 'abc', indexVersion: 'v', conflicts: false, stagedOutside: false, pushTo: null, ahead: null,
    files: [{ path: 'src/a', index: ' ', worktree: 'M' }] };
  let answer!: (s: GitStatus) => void;
  gitStatus.mockImplementationOnce(() => new Promise<GitStatus>((r) => { answer = r; }));
  const { el, click } = await mount();
  const tab = (name: string) => Array.from(el.querySelectorAll('[role="tab"]')).find(b => b.textContent === name)!;
  const row = () => el.querySelector('[aria-label="View diff for src/a"]');
  await click(tab('Git'));
  // The read is out: the composer is already in place, and one line says what the panel waits for.
  expect(el.querySelector('.git-panel')!.getAttribute('aria-busy')).toBe('true');
  expect(el.querySelector('[role="status"]')!.textContent).toBe('Reading Git changes…');
  expect(el.querySelector('[aria-label="Commit message"]')).not.toBeNull();
  expect(Array.from(el.querySelectorAll<HTMLButtonElement>('.git-action')).every(b => b.disabled)).toBe(true);
  expect(row()).toBeNull();
  await act(async () => answer(status));
  expect(row()).not.toBeNull();
  expect(el.querySelector('.git-panel')!.getAttribute('aria-busy')).toBe('false');
  expect(el.querySelector('[role="status"]')).toBeNull();

  // Git is read again with a diff open: its lines stay until the new ones are back.
  gitStatus.mockResolvedValue({ ...status });
  await click(row()!);
  expect(el.querySelector('.git-patches pre')!.textContent).toContain('+incoming');
  gitDiff.mockImplementationOnce(() => new Promise<string>(() => {}));
  await act(async () => { el.querySelector('.git-panel')!.dispatchEvent(new Event('pointerover', { bubbles: true })); });
  expect(gitDiff).toHaveBeenCalledTimes(2);
  expect(el.querySelector('.git-patches pre')!.textContent).toContain('+incoming');
  expect(el.textContent).not.toContain('Loading diff…');

  // Files and back while the next read is still out: the last status is there at once.
  gitStatus.mockImplementationOnce(() => new Promise<GitStatus>(() => {}));
  await click(tab('Files'));
  expect(row()).toBeNull();
  await click(tab('Git'));
  expect(row()).not.toBeNull();
  expect(el.querySelector('.git-panel')!.getAttribute('aria-busy')).toBe('false');
});
