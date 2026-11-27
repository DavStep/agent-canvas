// @vitest-environment jsdom
// Checking a finished session off: its "Done" clears when its chat is left, and as soon as the
// owner turns back to the canvas with the chat still open.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasBridge, PreviewState } from '../../shared/bridge.ts';
import type { ChatState } from '../../shared/chat.ts';
import type { Snapshot } from '../../shared/types.ts';
import { session } from './testSession.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SNAPSHOT: Snapshot = {
  generatedAt: 1, demo: true,
  sessions: [
    session({ id: 'done', name: 'Finished chat', folder: 'alpha', cwd: '/work/alpha', state: 'needs_you', need: 'reply' }),
    session({ id: 'asked', name: 'Asking chat', folder: 'alpha', cwd: '/work/alpha', state: 'needs_you', need: 'question' }),
  ],
  layout: { version: 1, zones: [{ id: 'folder:alpha', name: 'alpha', kind: 'folder', folder: 'alpha', x: 0, y: 0, hueIndex: 0 }], assignments: {} },
  banners: { claude: null, codex: null },
};

const chatState = (id: string): ChatState => ({
  sessionId: id, provider: 'claude', owner: 'here', title: id, cwd: '/work/alpha',
  items: [{ kind: 'user', id: `${id}-u1`, text: `Hello from ${id}`, images: [], at: 0 } as unknown as ChatState['items'][number]],
  hasOlder: false, turn: 'idle',
  model: 'm', models: [{ id: 'm', label: 'Model M', isDefault: true }], mode: 'default', modes: [{ id: 'default', label: 'Ask' }],
  banner: null,
});

const NO_PAGE: PreviewState = { url: null, canGoBack: false, loading: false, error: null };

let markSeen: ReturnType<typeof vi.fn<CanvasBridge['markSeen']>>;
let App: typeof import('./App.tsx').App;

beforeAll(async () => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  markSeen = vi.fn<CanvasBridge['markSeen']>(async () => {});
  // The page reads window.canvas when bridge.ts loads, so the stand-in comes first.
  (window as { canvas?: Partial<CanvasBridge> }).canvas = {
    onSnapshot: (cb) => { queueMicrotask(() => cb(SNAPSHOT)); return () => {}; },
    layoutOp: async () => {}, markSeen,
    openChat: async (id) => chatState(id), closeChat: () => {}, onChat: () => () => {},
    permissions: async () => ({ notifications: 'on' }),
    accounts: () => Promise.reject(new Error('not signed in')),
    onAccountsChanged: () => () => {},
    onOpenSession: () => () => {},
    preview: async () => NO_PAGE, onPreview: () => () => {}, onPreviewZoom: () => () => {}, canOpenInEditor: async () => false,
  };
  ({ App } = await import('./App.tsx'));
});

let root: Root | null = null;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  markSeen.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render() {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(App)); });
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const card = (name: string) => [...document.querySelectorAll<HTMLElement>('.card')].find((c) => c.textContent?.includes(name))!;
const click = async (el: HTMLElement | null) => { await act(async () => { el!.click(); }); };
/** A press and release, as a pointer makes it (jsdom has no PointerEvent). */
const pressOn = async (el: EventTarget, button = 0) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { button, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { button, bubbles: true }));
  });
};

describe('a finished session\'s Done', () => {
  it('is checked off by a press on the canvas, with the chat still open', async () => {
    await render();
    await click(card('Finished chat'));
    expect(markSeen).not.toHaveBeenCalled();
    await pressOn(q('.workspace')!);
    expect(markSeen).toHaveBeenCalledWith(['done']);
    // Reading it goes on: the chat is still open on the same session.
    expect(q('.chat-screen .cs-heading h1')?.textContent).toBe('done');
  });

  it('clears once, however many times the canvas is pressed or the chat is then closed', async () => {
    await render();
    await click(card('Finished chat'));
    await pressOn(q('.workspace')!);
    await pressOn(q('.board')!);
    await click(q('button[aria-label="Close chat"]'));
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it('waits for the release, so a card picked up to be moved does not re-sort under the pointer', async () => {
    await render();
    await click(card('Finished chat'));
    await act(async () => {
      card('Finished chat').dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    });
    expect(markSeen).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true })); });
    expect(markSeen).toHaveBeenCalledWith(['done']);
  });

  it('ignores a press that is not the primary button, and stays until the chat is left', async () => {
    await render();
    await click(card('Finished chat'));
    await pressOn(q('.workspace')!, 2);
    expect(markSeen).not.toHaveBeenCalled();
    await click(q('button[aria-label="Close chat"]'));
    expect(markSeen).toHaveBeenCalledWith(['done']);
  });

  it('stays on a session that is waiting for an answer, pressed canvas or not', async () => {
    await render();
    await click(card('Asking chat'));
    await pressOn(q('.workspace')!);
    await click(q('button[aria-label="Close chat"]'));
    expect(markSeen).not.toHaveBeenCalled();
  });
});
