// @vitest-environment jsdom
// The whole page in the DOM: a card opens its chat in a panel beside the canvas, Full screen
// gives the full layout, and Esc steps back one level at a time.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasBridge, PreviewState } from '../../shared/bridge.ts';
import type { ChatState } from '../../shared/chat.ts';
import type { Snapshot } from '../../shared/types.ts';
import { session } from './testSession.ts';
import { RunStore } from '../../server/runs/store.ts';
import { evaluate } from '../../server/runs/evaluate.ts';
import { planId } from '../../shared/runs.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SNAPSHOT: Snapshot = {
  generatedAt: 1, demo: true,
  sessions: [
    session({ id: 'one', stateSince: Date.now(), name: 'First chat', folder: 'alpha', cwd: '/work/alpha' }),
    session({ id: 'two', stateSince: Date.now(), name: 'Second chat', folder: 'alpha', cwd: '/work/alpha' }),
  ],
  layout: { version: 1, zones: [{ id: 'folder:alpha', name: 'alpha', kind: 'folder', folder: 'alpha', x: 0, y: 0, hueIndex: 0 }], assignments: {} },
  banners: { claude: null, codex: null },
};

const chatState = (id: string): ChatState => ({
  sessionId: id, provider: 'claude', owner: 'here', title: id === 'one' ? 'First chat' : 'Second chat', cwd: '/work/alpha',
  items: [{ kind: 'user', id: `${id}-u1`, text: `Hello from ${id}`, images: [], at: 0 } as unknown as ChatState['items'][number]],
  hasOlder: false, turn: 'idle',
  model: 'm', models: [{ id: 'm', label: 'Model M', isDefault: true }], mode: 'default', modes: [{ id: 'default', label: 'Ask' }],
  banner: null,
});

const NO_PAGE: PreviewState = { url: null, canGoBack: false, loading: false, error: null };

let publishSnapshot: (s: Snapshot) => void;
const newSession = vi.fn<CanvasBridge['newSession']>();
let openChat: ReturnType<typeof vi.fn<CanvasBridge['openChat']>>;
let closeChat: ReturnType<typeof vi.fn<CanvasBridge['closeChat']>>;
let preview: ReturnType<typeof vi.fn<CanvasBridge['preview']>>;
let App: typeof import('./App.tsx').App;
let isPreviewShortcut: typeof import('./chat/ChatScreen.tsx').isPreviewShortcut;
let NO_PREVIEW_TIP: string;

beforeAll(async () => {
  // jsdom lays nothing out and has no ResizeObserver; the page only needs one that never reports.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  openChat = vi.fn<CanvasBridge['openChat']>(async (id) => chatState(id));
  closeChat = vi.fn<CanvasBridge['closeChat']>();
  preview = vi.fn<CanvasBridge['preview']>(async () => NO_PAGE);
  // The page reads window.canvas when bridge.ts loads, so the stand-in comes first.
  (window as { canvas?: Partial<CanvasBridge> }).canvas = {
    onSnapshot: (cb) => { publishSnapshot = cb; queueMicrotask(() => cb(SNAPSHOT)); return () => {}; },
    layoutOp: async () => {}, markSeen: async () => {},
    newSession, options: async () => ({ models: [], model: null, effort: null, modes: [], mode: '' }),
    openChat, closeChat, onChat: () => () => {},
    permissions: async () => ({ notifications: 'on' }),
    accounts: () => Promise.reject(new Error('not signed in')),
    onAccountsChanged: () => () => {},
    onOpenSession: () => () => {},
    preview, onPreview: () => () => {}, onPreviewZoom: () => () => {}, canOpenInEditor: async () => false,
  };
  ({ App } = await import('./App.tsx'));
  ({ isPreviewShortcut, NO_PREVIEW_TIP } = await import('./chat/ChatScreen.tsx'));
});

let root: Root | null = null;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  openChat.mockClear();
  closeChat.mockClear();
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
const button = (label: string) => q<HTMLButtonElement>(`button[aria-label="${label}"]`);
const card = (name: string) => [...document.querySelectorAll<HTMLElement>('.card')].find((c) => c.textContent?.includes(name))!;
const click = async (el: HTMLElement | null) => { await act(async () => { el!.click(); }); };
const press = async (key: string, target: EventTarget = document.body) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
};
/** Types into the composer as a person would (React listens for input events). */
async function type(text: string) {
  const field = q<HTMLTextAreaElement>('.cp-field')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the chat panel', () => {
  it('a card click opens the chat in a panel beside the canvas, which stays usable', async () => {
    await render();
    await click(card('First chat'));
    const panel = q('.chat-screen');
    expect(panel?.classList.contains('is-panel')).toBe(true);
    expect(panel?.querySelector('.cs-heading h1')?.textContent).toBe('First chat');
    expect(panel?.querySelector('.thread')?.textContent).toContain('Hello from one');
    expect(panel?.querySelector('.cp-field')).not.toBeNull();
    // Full screen at the right end of the header, after Close.
    const full = button('Full screen')!;
    expect(full.title).toBe('Full screen');
    expect(full.parentElement?.lastElementChild).toBe(full);
    expect(button('Close chat')).not.toBeNull();
    // No rail, no preview, and the canvas is neither covered nor inert.
    expect(q('.rail')).toBeNull();
    expect(q('.cs-preview')).toBeNull();
    expect(q('.workspace')?.closest('[inert]')).toBeNull();
    expect(q('.workspace')?.closest('[aria-hidden="true"]')).toBeNull();
    expect(q('.app')?.classList.contains('has-panel')).toBe(true);
    expect(q('.app')?.classList.contains('is-under')).toBe(false);
    // The selected card keeps its look; the hash names the chat.
    expect(card('First chat').classList.contains('is-selected')).toBe(true);
    expect(window.location.hash).toBe('#one');
  });

  it('opens New session on an empty drop and follows the linked card into its live chat', async () => {
    const store = await RunStore.load(null);
    const publish = () => publishSnapshot({ ...SNAPSHOT, runs: evaluate({
      runs: store.runs(), sessions: SNAPSHOT.sessions, maxRunning: {}, now: Date.now(),
    }).views });
    newSession.mockImplementationOnce(async ({ text, images, ...settings }, after) => {
      const run = store.queue({ target: { kind: 'new', ...settings, title: null }, after: [after!], prompt: text, by: 'owner' });
      publish();
      return planId(run.id);
    });
    await render();
    const pointer = (el: Element, name: string) => act(() => {
      el.dispatchEvent(new PointerEvent(name, { pointerId: 1, isPrimary: true, bubbles: true, button: 0 }));
    });
    pointer(card('First chat'), 'pointerover');
    const port = q<HTMLButtonElement>('.link-port')!;
    port.setPointerCapture = vi.fn();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => q('.workspace') });
    try {
      pointer(port, 'pointerdown');
      pointer(port, 'pointerup');
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
    expect(q('dialog[open]')?.textContent).toContain('after “First chat” finishes');
    await type('Run the login tests');
    await click(q('dialog .ns-start'));
    const [run] = store.runs();
    expect(run?.after).toEqual(['one']);
    const waiting = q('.chat-screen');
    expect(waiting?.querySelector('.thread')?.textContent).toContain('Run the login tests');
    expect(waiting?.querySelector('[role=status]')?.textContent).toContain('First chat');
    expect(q(`.card[data-card-id="${planId(run!.id)}"]`)).not.toBeNull();
    expect(q(`.link-line[data-from="one"][data-to="${planId(run!.id)}"]`)).not.toBeNull();
    expect(openChat).not.toHaveBeenCalled();

    await act(async () => { await store.markStarted(run!.id, 'live'); publish(); });
    expect(openChat.mock.calls).toEqual([['live']]);
    expect(window.location.hash).toBe('#live');
    expect(q('.chat-screen .thread')?.textContent).toContain('Hello from live');
  });

  it('pans and zooms beside an open chat without measuring card positions', async () => {
    await render();
    await click(card('First chat'));
    const workspace = q('.workspace')!;
    const board = q('.board')!;
    const before = board.style.transform;
    const positions = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get');
    try {
      for (const ctrlKey of [false, true]) {
        await act(async () => {
          workspace.dispatchEvent(new WheelEvent('wheel', { deltaY: 8, ctrlKey, cancelable: true }));
        });
      }
      expect(board.style.transform).not.toBe(before);
      expect(positions).not.toHaveBeenCalled();
      expect(q('.chat-screen .cs-heading h1')?.textContent).toBe('First chat');
    } finally {
      positions.mockRestore();
    }
  });

  it('paints a burst of pan input once and keeps every delta', async () => {
    await render();
    const workspace = q('.workspace')!, board = q('.board')!;
    const initial = board.style.transform;
    const translation = /translate\(([-.\d]+)px(?:, ([-.\d]+)px)?\)/;
    const before = translation.exec(initial)!;
    let writes = 0;
    const observer = new MutationObserver(records => { writes += records.length; });
    observer.observe(board, { attributes: true, attributeFilter: ['style'] });
    try {
      await act(async () => {
        for (let i = 0; i < 12; i++) {
          workspace.dispatchEvent(new WheelEvent('wheel', { deltaX: 3, deltaY: -2, cancelable: true }));
        }
        await new Promise(requestAnimationFrame);
      });
      expect(writes).toBe(1);
      const after = translation.exec(board.style.transform)!;
      expect(Number(after[1])).toBeCloseTo(Number(before[1]) - 36);
      expect(Number(after[2])).toBeCloseTo(Number(before[2] ?? 0) + 24);
    } finally {
      observer.disconnect();
    }
  });

  it('reuses the painted grid during a pinch and keeps its spacing and zoom readout exact', async () => {
    await render();
    const workspace = q('.workspace')!, grid = q('.workspace-grid')!, board = q('.board')!;
    const painted = new Set<string>();
    const scale = (el: HTMLElement) => Number(/scale\(([^)]+)\)/.exec(el.style.transform)?.[1]);
    await act(async () => {
      for (let i = 0; i < 60; i++) {
        workspace.dispatchEvent(new WheelEvent('wheel', { deltaY: -.2, ctrlKey: true, cancelable: true }));
        painted.add(grid.style.backgroundSize);
        const zoom = scale(board);
        expect(parseFloat(grid.style.backgroundSize) * scale(grid)).toBeCloseTo(20 * zoom * (zoom < .5 ? 2 : 1), 3);
        expect(q('button[title="Reset zoom to 100%"]')?.textContent).toBe(`${Math.round(zoom * 100)}%`);
      }
    });
    expect(painted.size).toBeLessThanOrEqual(3);
  });

  it('another card switches the panel; empty canvas leaves it open', async () => {
    await render();
    await click(card('First chat'));
    await click(card('Second chat'));
    expect(q('.chat-screen .cs-heading h1')?.textContent).toBe('Second chat');
    expect(q('.chat-screen')?.classList.contains('is-panel')).toBe(true);
    await click(q('.workspace'));
    expect(q('.chat-screen')).not.toBeNull();
  });

  it('Full screen gives the rail and the preview; Exit full screen returns to the panel without reopening the chat', async () => {
    await render();
    await click(card('First chat'));
    await type('half a thought');
    await click(button('Full screen'));
    const screen = q('.chat-screen')!;
    expect(screen.classList.contains('is-full')).toBe(true);
    expect(q('.rail')).not.toBeNull();
    expect(q('.cs-preview')).not.toBeNull();
    expect(button('Back to canvas')).not.toBeNull();
    expect(button('Full screen')).toBeNull();
    const exit = button('Exit full screen')!;
    expect(exit.title).toBe('Exit full screen');
    expect(exit.parentElement?.lastElementChild).toBe(exit);
    // The canvas underneath is out of reach while the chat fills the window.
    expect(q('.workspace')?.closest('[inert]')).not.toBeNull();

    await click(exit);
    expect(q('.chat-screen')?.classList.contains('is-panel')).toBe(true);
    expect(q('.rail')).toBeNull();
    expect(q('.cs-preview')).toBeNull();
    // One open for the whole visit, no close, and the draft is still there.
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(closeChat).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>('.cp-field')?.value).toBe('half a thought');
  });

  it('exposes preview options on demand and collapses them without losing the browser', async () => {
    await render();
    await click(card('First chat'));
    await click(button('Full screen'));
    const toggle = button('Preview controls')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(q('#pv-views')!.hidden).toBe(true);
    await click(toggle);
    await click(q('#pv-tab-browser'));
    const frame = q('.pv-frame')!;
    expect(frame).not.toBeNull();
    expect(q('#pv-options')!.hidden).toBe(false);
    await press('Escape', toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(q('#pv-options')!.hidden).toBe(true);
    expect(q('.pv-frame')).toBe(frame);
    expect(q('.chat-screen.is-full')).not.toBeNull();
  });

  it('adds a preview inside a project board and restores it after reopening the canvas', async () => {
    await render();
    await click(card('First chat'));
    await click(button('Full screen'));
    await click(button('Preview controls'));
    const picker = q<HTMLSelectElement>('select[aria-label="Add to board"]')!;
    await act(async () => {
      picker.value = 'folder:alpha';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const saved = '.zone[data-zone-id="folder:alpha"] .pv-board';
    expect(q(saved)).not.toBeNull();
    await act(async () => { root!.unmount(); });
    window.history.replaceState(null, '', '/');
    await render();
    expect(q(saved)).not.toBeNull();
    await click(button('Collapse board preview'));
    expect(q(saved)).toBeNull();
    await click(button('Open preview for First chat'));
    expect(q(saved)).not.toBeNull();
    await click(button('Collapse board preview'));
    await click(button('Remove preview for First chat from board'));
    expect(q('.board-preview')).toBeNull();
  });

  it('expands just the preview and returns to the same view with controls reachable', async () => {
    await render();
    await click(card('First chat'));
    await click(button('Full screen'));
    await click(button('Preview controls'));
    await click(q('#pv-tab-browser'));
    await click(button('Expand preview'));
    expect(q('dialog[open] .pv-frame')).not.toBeNull();
    expect(q('#pv-options')!.hidden).toBe(true);
    await click(button('Return to panel'));
    expect(q('dialog.preview-full-view')).toBeNull();
    expect(q('.preview-slot .pv-frame')).not.toBeNull();
    expect(document.activeElement).toBe(button('Preview controls'));
  });

  it('Esc in full screen goes to the panel; Esc in the panel closes the chat', async () => {
    await render();
    await click(card('First chat'));
    await click(button('Full screen'));
    await press('Escape');
    expect(q('.chat-screen')?.classList.contains('is-panel')).toBe(true);
    await press('Escape');
    expect(q('.chat-screen')).toBeNull();
    expect(closeChat).toHaveBeenCalledWith('one');
    expect(window.location.hash).toBe('');
  });

  it('Esc typed in the composer is the field\'s own', async () => {
    await render();
    await click(card('First chat'));
    await press('Escape', q('.cp-field')!);
    expect(q('.chat-screen')).not.toBeNull();
  });

  it('the full-screen choice lasts while switching chats, and each new open starts as a panel', async () => {
    await render();
    await click(card('First chat'));
    await click(button('Full screen'));
    await click([...document.querySelectorAll<HTMLElement>('.rail-row')].find((r) => r.textContent?.includes('Second chat'))!);
    expect(q('.chat-screen .cs-heading h1')?.textContent).toBe('Second chat');
    expect(q('.chat-screen')?.classList.contains('is-full')).toBe(true);
    // "Back to canvas" closes the chat outright.
    await click(button('Back to canvas'));
    expect(q('.chat-screen')).toBeNull();
    await click(card('First chat'));
    expect(q('.chat-screen')?.classList.contains('is-panel')).toBe(true);
    await click(button('Close chat'));
    expect(q('.chat-screen')).toBeNull();
  });

  it('full screen keeps the resizable rail and preview columns; the panel has neither handle', async () => {
    await render();
    await click(card('First chat'));
    expect(q('.cs-resize')).toBeNull();
    expect(q('.chat-screen')?.style.getPropertyValue('--rail-w')).toBe('');
    await click(button('Full screen'));
    const screen = q('.chat-screen')!;
    expect(q('[role="separator"][aria-label="Resize sessions list"]')).not.toBeNull();
    expect(q('[role="separator"][aria-label="Resize preview"]')).not.toBeNull();
    expect(q('[aria-label="Resize chat panel"]')).toBeNull();
    expect(screen.style.getPropertyValue('--rail-w')).toMatch(/^\d+px$/);
    expect(screen.style.getPropertyValue('--preview-w')).toMatch(/^\d+px$/);
    // The rail handle's arrow keys widen the rail in full screen.
    const before = Number.parseInt(screen.style.getPropertyValue('--rail-w'), 10);
    await press('ArrowRight', q('.cs-resize.is-rail')!);
    expect(Number.parseInt(screen.style.getPropertyValue('--rail-w'), 10)).toBe(before + 16);
    await press('ArrowLeft', q('.cs-resize.is-rail')!);
    await click(button('Exit full screen'));
    expect(q('.cs-resize')).toBeNull();
  });

  it('opening, switching and closing a chat are history steps; panel ↔ full screen is not', async () => {
    await render();
    const start = window.history.length;
    await click(card('First chat'));
    expect(window.history.length).toBe(start + 1);
    await click(button('Full screen'));
    await click(button('Exit full screen'));
    expect(window.history.length).toBe(start + 1);
    await click(card('Second chat'));
    expect(window.history.length).toBe(start + 2);
    expect(window.location.hash).toBe('#two');
    await click(button('Close chat'));
    expect(window.history.length).toBe(start + 3);
    expect(window.location.hash).toBe('');
    expect(q('.chat-screen')).toBeNull();
  });

  it('the mouse\'s Back on a chat the window opened on (nothing before it) closes the chat', async () => {
    window.history.replaceState(null, '', '/#one');
    await render();
    expect(q('.chat-screen .cs-heading h1')?.textContent).toBe('First chat');
    await click(button('Full screen'));
    await act(async () => { window.dispatchEvent(new MouseEvent('mouseup', { button: 3, cancelable: true })); });
    expect(q('.chat-screen')).toBeNull();
    expect(window.location.hash).toBe('');
    // The next open is the panel again.
    await click(card('First chat'));
    expect(q('.chat-screen')?.classList.contains('is-panel')).toBe(true);
  });

  it('the panel\'s width comes from the remembered drag, and the default otherwise', async () => {
    window.localStorage.removeItem('agent-canvas:panel-width');
    await render();
    await click(card('First chat'));
    expect(q('.app')?.style.getPropertyValue('--panel-w')).toBe('min(560px, 45vw)');
    const edge = q('[role="separator"][aria-label="Resize chat panel"]')!;
    expect(edge).not.toBeNull();
    // The keyboard moves the edge too: left widens the panel.
    await press('ArrowLeft', edge);
    const w = Number.parseInt(q('.app')!.style.getPropertyValue('--panel-w'), 10);
    expect(w).toBeGreaterThanOrEqual(380);
    expect(window.localStorage.getItem('agent-canvas:panel-width')).toBe(String(w));
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    await render();
    await click(card('First chat'));
    expect(q('.app')?.style.getPropertyValue('--panel-w')).toBe(`${w}px`);
    window.localStorage.removeItem('agent-canvas:panel-width');
  });
});

describe('the header\'s preview toggle', () => {
  /** A chat whose turn is running: it has live work to show. */
  const working = (id: string): ChatState => ({ ...chatState(id), turn: 'running' });
  const toggle = () => q<HTMLButtonElement>('.chat-screen .cs-window button[aria-label="Preview"]')!;
  const shortcut = async () => {
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })); });
  };
  afterEach(() => { openChat.mockImplementation(async (id) => chatState(id)); });

  it('sits just before Close, and is dimmed with its reason while the chat has nothing to show', async () => {
    await render();
    await click(card('First chat'));
    const t = toggle();
    expect(t.nextElementSibling).toBe(button('Close chat'));
    expect(t.getAttribute('aria-pressed')).toBe('false');
    expect(t.getAttribute('aria-disabled')).toBe('true');
    expect(t.title).toBe(NO_PREVIEW_TIP);
    await click(t);
    await shortcut();
    expect(q('.preview-window')).toBeNull();
    expect(t.getAttribute('aria-pressed')).toBe('false');
  });

  it('starts collapsed; a press opens the preview beside the chat, another closes it, and a quick double press leaves nothing behind', async () => {
    openChat.mockImplementation(async (id) => working(id));
    await render();
    await click(card('First chat'));
    expect(q('.preview-window')).toBeNull();
    const t = toggle();
    expect(t.getAttribute('aria-disabled')).toBeNull();
    expect(t.title).toBe('Show preview (⇧⌘P)');

    await click(t);
    expect(q('.preview-window.pv-right')).not.toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().title).toBe('Hide preview (⇧⌘P)');

    await click(toggle());
    expect(q('.preview-window')).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    // Presses in quick succession (each its own event, as a person's are).
    await click(toggle()); await click(toggle());
    expect(q('.preview-window')).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await click(toggle()); await click(toggle()); await click(toggle());
    expect(document.querySelectorAll('.preview-window')).toHaveLength(1);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('⇧⌘P toggles it too, and the pane\'s own × closes it and releases the button', async () => {
    openChat.mockImplementation(async (id) => working(id));
    await render();
    await click(card('First chat'));
    await shortcut();
    expect(q('.preview-window.pv-right')).not.toBeNull();
    await shortcut();
    expect(q('.preview-window')).toBeNull();
    await click(toggle());
    await click(q('.preview-window button[aria-label="Hide preview"]'));
    expect(q('.preview-window')).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('is per session: another chat opens collapsed, and the first keeps its choice for this run', async () => {
    openChat.mockImplementation(async (id) => working(id));
    await render();
    await click(card('First chat'));
    await click(toggle());
    expect(q('.preview-window')).not.toBeNull();
    await click(card('Second chat'));
    expect(q('.chat-screen .cs-heading h1')?.textContent).toBe('Second chat');
    expect(q('.preview-window')).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await click(card('First chat'));
    expect(q('.preview-window.pv-right')).not.toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('full screen has its own preview column and no toggle; the agent\'s panel has none either', async () => {
    openChat.mockImplementation(async (id) => working(id));
    await render();
    await click(card('First chat'));
    await click(button('Full screen'));
    expect(q('.cs-preview')).not.toBeNull();
    expect(q('.chat-screen button[aria-label="Preview"]')).toBeNull();
  });
});

describe('isPreviewShortcut', () => {
  const key = (k: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ key: 'p', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k });
  it('is ⇧⌘P only', () => {
    expect(isPreviewShortcut(key({ key: 'P', metaKey: true, shiftKey: true }))).toBe(true);
    expect(isPreviewShortcut(key({ key: 'p', metaKey: true, shiftKey: true }))).toBe(true);
    expect(isPreviewShortcut(key({ metaKey: true }))).toBe(false);
    expect(isPreviewShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPreviewShortcut(key({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });
});
