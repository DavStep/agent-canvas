// @vitest-environment jsdom
// A Claude session waiting on a prompt in its own terminal: the card says so, and its chat says
// where it runs, why it is empty and read-only, and offers to show that app.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasBridge, PreviewState } from '../../shared/bridge.ts';
import type { ChatState } from '../../shared/chat.ts';
import type { Snapshot } from '../../shared/types.ts';
import { session } from './testSession.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const READ_ONLY = 'Open in another app — read-only here';
const SNAPSHOT: Snapshot = {
  generatedAt: 1, demo: false,
  sessions: [
    session({
      id: 'term', name: 'me', folder: 'alpha', cwd: '/work/alpha', hostId: null,
      state: 'needs_you', need: 'terminal', activity: 'Waiting on a prompt in its terminal', rawStatus: 'waiting',
      owner: 'elsewhere', host: { app: 'Terminal', tty: 'ttys006', showable: true },
    }),
    session({ id: 'tmux', name: 'In tmux', folder: 'alpha', cwd: '/work/alpha', owner: 'elsewhere', state: 'working', host: { app: null, tty: 'ttys009', showable: false } }),
    session({ id: 'codex:t1', provider: 'codex', name: 'Codex elsewhere', folder: 'alpha', cwd: '/work/alpha', owner: 'elsewhere', state: 'working' }),
    session({ id: 'fresh', stateSince: Date.now(), name: 'Fresh chat', folder: 'alpha', cwd: '/work/alpha', owner: 'here' }),
  ],
  layout: { version: 1, zones: [{ id: 'folder:alpha', name: 'alpha', kind: 'folder', folder: 'alpha', x: 0, y: 0, hueIndex: 0 }], assignments: {} },
  banners: { claude: null, codex: null },
};

const chatState = (id: string): ChatState => {
  const card = SNAPSHOT.sessions.find((s) => s.id === id)!;
  const elsewhere = card.owner === 'elsewhere';
  return {
    sessionId: id, provider: card.provider, owner: card.owner, title: card.name, cwd: '/work/alpha',
    items: id === 'term' || id === 'fresh' ? [] : [{ kind: 'user', id: `${id}-u1`, text: 'Hello', images: [], at: 0 }],
    hasOlder: false, turn: 'idle',
    model: 'm', models: [{ id: 'm', label: 'Model M', isDefault: true }], mode: 'default', modes: [{ id: 'default', label: 'Ask' }],
    banner: elsewhere ? READ_ONLY : null,
  };
};

const NO_PAGE: PreviewState = { url: null, canGoBack: false, loading: false, error: null };
let showHost: ReturnType<typeof vi.fn<CanvasBridge['showHost']>>;
let App: typeof import('./App.tsx').App;

beforeAll(async () => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  showHost = vi.fn<CanvasBridge['showHost']>(async () => {});
  (window as { canvas?: Partial<CanvasBridge> }).canvas = {
    onSnapshot: (cb) => { queueMicrotask(() => cb(SNAPSHOT)); return () => {}; },
    layoutOp: async () => {}, markSeen: async () => {},
    openChat: async (id) => chatState(id), closeChat: () => {}, onChat: () => () => {},
    permissions: async () => ({ notifications: 'on' }),
    accounts: () => Promise.reject(new Error('not signed in')),
    onAccountsChanged: () => () => {},
    onOpenSession: () => () => {},
    preview: async () => NO_PAGE, onPreview: () => () => {}, onPreviewZoom: () => () => {}, canOpenInEditor: async () => false,
    showHost,
  };
  ({ App } = await import('./App.tsx'));
});

let root: Root | null = null;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  showHost.mockClear();
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
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/ /g, ' ');
const card = (name: string) => [...document.querySelectorAll<HTMLElement>('.card')].find((c) => c.textContent?.includes(name))!;
const buttonsNamed = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].filter((b) => text(b).trim() === name);
const click = async (el: HTMLElement | null) => { await act(async () => { el!.click(); }); };
async function openChat(name: string) {
  await render();
  await click(card(name));
  return q('.chat-screen')!;
}

describe('a Claude session waiting on a prompt in its terminal', () => {
  it('its card reads "Terminal prompt"', async () => {
    await render();
    expect(text(card('me').querySelector('.request-state'))).toBe('Terminal prompt');
  });

  it('the chat names where it runs, explains the empty thread, and offers to show Terminal', async () => {
    const screen = await openChat('me');
    const meta = text(screen.querySelector('.cs-meta'));
    expect(meta).toContain('in Terminal · ttys006');
    expect(meta).not.toContain('another app');
    const thread = screen.querySelector('.thread')!;
    expect(text(thread)).not.toContain('No messages yet.');
    expect(text(thread.querySelector('.t-empty'))).toContain(
      "This Claude session is waiting on a prompt in its terminal (ttys006) and hasn't been sent a message yet. Answer it there, or close it if you don't need it.");
    expect(buttonsNamed('Show in Terminal', thread)).toHaveLength(1);
    // The header has it too, beside Copy resume command.
    const header = screen.querySelector('.cs-bar')!;
    expect(buttonsNamed('Show in Terminal', header)).toHaveLength(1);
    expect(buttonsNamed('Copy resume command', header)).toHaveLength(1);
    await click(buttonsNamed('Show in Terminal', header)[0]!);
    await click(buttonsNamed('Show in Terminal', thread)[0]!);
    expect(showHost.mock.calls).toEqual([['term'], ['term']]);
  });

  it('the banner, Move here and the composer say where to answer it', async () => {
    const screen = await openChat('me');
    expect(text(screen.querySelector('.cs-banner.is-readonly span'))).toBe('Running in Terminal (ttys006) — read-only here');
    const move = buttonsNamed('Move here', screen)[0]!;
    expect(move.disabled).toBe(true);
    expect(move.title).toBe('Close it in Terminal first');
    const field = screen.querySelector<HTMLTextAreaElement>('.cp-field')!;
    expect(field.disabled).toBe(true);
    expect(field.placeholder).toBe('Read-only — open in Terminal to reply');
  });
});

describe('other read-only and empty chats', () => {
  it('a host it cannot name keeps the generic words, with no Show in button', async () => {
    const screen = await openChat('In tmux');
    expect(text(screen.querySelector('.cs-meta'))).toContain('another app');
    expect(text(screen.querySelector('.cs-banner.is-readonly span'))).toBe(READ_ONLY);
    expect(buttonsNamed('Move here', screen)[0]!.title).toBe('Close it in the other app first');
    expect(screen.querySelector<HTMLTextAreaElement>('.cp-field')!.placeholder).toBe('Read-only — open it in the other app to reply');
    expect(text(screen)).not.toContain('Show in');
  });

  it('lets the user queue in an externally owned Codex chat while its turn controls stay disabled', async () => {
    const screen = await openChat('Codex elsewhere');
    const field = screen.querySelector<HTMLTextAreaElement>('.cp-field')!;
    expect(field.disabled).toBe(false);
    expect(field.placeholder).toBe('Queue a message in Codex…');
    expect(text(screen.querySelector('.cs-banner'))).toContain('queue a message');
    expect(screen.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.disabled).toBe(true);
  });

  it('any other empty chat says "No messages yet."', async () => {
    const screen = await openChat('Fresh chat');
    expect(text(screen.querySelector('.thread .t-empty'))).toBe('No messages yet.');
    expect(screen.querySelector<HTMLTextAreaElement>('.cp-field')!.placeholder).toBe('Message Claude…');
  });
});
