// @vitest-environment jsdom
// The whole page in the DOM: the canvas orb opens the canvas agent in the chat panel. Before a
// conversation it shows the empty state, whose first message starts the agent's session and
// moves the panel to that chat; "New conversation" returns to the empty state.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasBridge } from '../../shared/bridge.ts';
import type { ChatState } from '../../shared/chat.ts';
import type { Snapshot } from '../../shared/types.ts';
import { session } from './testSession.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: Snapshot = {
  generatedAt: 1, demo: true,
  sessions: [session({ id: 'one', stateSince: Date.now(), name: 'First chat', folder: 'alpha', cwd: '/work/alpha' })],
  layout: { version: 1, zones: [{ id: 'folder:alpha', name: 'alpha', kind: 'folder', folder: 'alpha', x: 0, y: 0, hueIndex: 0 }], assignments: {} },
  banners: { claude: null, codex: null },
};

const chatState = (id: string): ChatState => ({
  sessionId: id, provider: 'claude', owner: 'here', title: 'Some generated title', cwd: '/Users/me',
  items: [{ kind: 'user', id: `${id}-u1`, text: `Hello from ${id}`, images: [], at: 0 }],
  hasOlder: false, turn: 'idle',
  model: 'm', models: [{ id: 'm', label: 'Model M', isDefault: true }], mode: 'default', modes: [{ id: 'default', label: 'Ask' }],
  banner: null,
});

type Info = Awaited<ReturnType<CanvasBridge['agentInfo']>>;
const READY: Info = { connection: 'claude-login', available: true, reason: null };
let info: Info = READY;
let pushSnapshot: (s: Snapshot) => void = () => {};
let first: Snapshot = BASE;
const projectChat = vi.fn<CanvasBridge['projectChat']>();
const projectTask = vi.fn<CanvasBridge['projectTask']>();
let openChat: ReturnType<typeof vi.fn<CanvasBridge['openChat']>>;
let startAgent: ReturnType<typeof vi.fn<CanvasBridge['startAgent']>>;
let send: ReturnType<typeof vi.fn<CanvasBridge['send']>>;
let App: typeof import('./App.tsx').App;

beforeAll(async () => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  openChat = vi.fn<CanvasBridge['openChat']>(async (id) => chatState(id));
  startAgent = vi.fn<CanvasBridge['startAgent']>(async () => 'agent-1');
  send = vi.fn<CanvasBridge['send']>(async () => {});
  // The page reads window.canvas when bridge.ts loads, so the stand-in comes first.
  (window as { canvas?: Partial<CanvasBridge> }).canvas = {
    onSnapshot: (cb) => { pushSnapshot = cb; queueMicrotask(() => cb(first)); return () => {}; },
    layoutOp: async () => {}, markSeen: async () => {},
    openChat, closeChat: () => {}, onChat: () => () => {}, send,
    permissions: async () => ({ notifications: 'on' }),
    accounts: () => Promise.reject(new Error('not signed in')),
    onAccountsChanged: () => () => {},
    onOpenSession: () => () => {},
    preview: async () => ({ url: null, canGoBack: false, loading: false, error: null }), onPreview: () => () => {}, onPreviewZoom: () => () => {}, canOpenInEditor: async () => false,
    agentInfo: async () => info, projectChat, projectTask,
    startAgent,
  };
  ({ App } = await import('./App.tsx'));
});

let root: Root | null = null;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  info = READY;
  first = BASE;
  openChat.mockClear();
  projectChat.mockReset().mockResolvedValue(null);
  projectTask.mockReset().mockResolvedValue('coordinator');
  startAgent.mockClear();
  send.mockClear();
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
const orb = () => q<HTMLButtonElement>('[data-testid="agent-orb"]')!;
const click = async (el: HTMLElement | null) => { await act(async () => { el!.click(); }); };
const press = async (init: KeyboardEventInit, target: EventTarget = document.body) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
};
const field = () => q<HTMLTextAreaElement>('.cp-field')!;
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const chips = () => [...document.querySelectorAll<HTMLButtonElement>('.agent-chip')];

describe('the pinned project chat', () => {
  it('opens in the dock, accepts the first message, and continues in the provider chat', async () => {
    await render();
    await click(q('.cards .project-chat-card'));
    expect(q('dialog')).toBeNull();
    expect(q('.chat-screen.is-panel .cs-heading h1')?.textContent).toBe('Project orchestrator');
    expect(q('.project-chat-card.is-selected')).not.toBeNull();
    expect(projectTask).not.toHaveBeenCalled();
    await type('Find the chat that worked on the parser');
    const depth = window.history.state.depth;
    await click(q('button[aria-label="Send"]'));
    expect(projectTask).toHaveBeenCalledWith('/work/alpha', 'Find the chat that worked on the parser', []);
    expect(window.location.hash).toBe('#coordinator');
    expect(window.history.state.depth).toBe(depth);
    expect(q('.thread')?.textContent).toContain('Hello from coordinator');
    await type('Continue there');
    await click(q('button[aria-label="Send"]'));
    expect(send).toHaveBeenCalledWith('coordinator', 'Continue there', []);
  });

  it('resumes an existing chat found through a checkout without sending a message', async () => {
    projectChat.mockResolvedValue('existing');
    await render();
    await click(q('.project-chat-card'));
    expect(openChat).toHaveBeenCalledWith('existing');
    expect(projectTask).not.toHaveBeenCalled();
  });

  it('does not pull the owner back after they leave a pending handoff', async () => {
    let finish!: (id: string) => void;
    projectTask.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render();
    await click(q('.project-chat-card'));
    await type('Review the tests');
    await click(q('button[aria-label="Send"]'));
    await click(q('[data-card-id="one"]'));
    await act(async () => finish('later'));
    expect(window.location.hash).toBe('#one');
    expect(openChat).not.toHaveBeenCalledWith('later');
  });
});

describe('the canvas agent', () => {
  it('the orb is a button on the canvas, not in the top bar, that names the agent and its state', async () => {
    await render();
    expect(orb().closest('.workspace')).not.toBeNull();
    expect(q('.topbar [data-testid="agent-orb"]')).toBeNull();
    expect(orb().title).toBe('Canvas agent (⌘J)');
    expect(orb().getAttribute('aria-label')).toBe('Canvas agent');
    expect(orb().getAttribute('aria-expanded')).toBe('false');
    expect(orb().dataset.state).toBe('idle');
    await act(async () => { pushSnapshot({ ...BASE, generatedAt: 2, agent: session({ id: 'agent-1', state: 'needs_you', need: 'permission' }) }); });
    expect(orb().getAttribute('aria-label')).toBe('Canvas agent, needs you');
    expect(orb().dataset.state).toBe('needs');
    expect(orb().querySelector('.agent-badge')).not.toBeNull();
    // The agent is never a card, and the counts are the cards' own.
    expect(q('[data-card-id="agent-1"]')).toBeNull();
    expect(q('.counts')?.textContent).toContain('1 session');
    expect(q('.counts')?.textContent).not.toContain('need');
  });

  it('opens on the empty state in the chat panel: a line, examples that fill the field, no card selected', async () => {
    await render();
    await click(orb());
    const panel = q('.chat-screen')!;
    expect(panel.classList.contains('is-panel')).toBe(true);
    expect(panel.getAttribute('role')).toBe('complementary');
    expect(panel.querySelector('.cs-heading h1')?.textContent).toBe('Canvas agent');
    expect(panel.querySelector('.cs-meta')?.textContent).toBe('Claude Code login');
    expect(q('[data-testid="agent-start"] .agent-lead')?.textContent).toMatch(/whole canvas/);
    expect(chips().length).toBeGreaterThanOrEqual(3);
    // A project session's things are not here: no full screen, no resume command, no pickers.
    expect(q('button[aria-label="Full screen"]')).toBeNull();
    expect(panel.textContent).not.toContain('Copy resume command');
    expect(panel.querySelector('.picker')).toBeNull();
    expect(q('.card.is-selected')).toBeNull();
    expect(q('.app')?.classList.contains('has-panel')).toBe(true);
    expect(orb().getAttribute('aria-expanded')).toBe('true');
    expect(window.location.hash).toBe('#%40agent');
    expect(field().getAttribute('aria-label')).toBe('Message the canvas agent');
    expect(document.activeElement).toBe(field());
    // A chip fills the field and sends nothing.
    await click(chips()[0]!);
    expect(field().value).toBe('What needs me right now?');
    expect(startAgent).not.toHaveBeenCalled();
    expect(openChat).not.toHaveBeenCalled();
  });

  it('the first message starts the agent and the panel moves to its chat; later ones are ordinary sends', async () => {
    await render();
    await click(orb());
    await type('Give me a report by zone');
    await click(q('button[aria-label="Send"]'));
    expect(startAgent).toHaveBeenCalledWith('Give me a report by zone', []);
    expect(q('[data-testid="agent-start"]')).toBeNull();
    expect(openChat).toHaveBeenCalledWith('agent-1');
    const panel = q('.chat-screen')!;
    expect(panel.querySelector('.thread')?.textContent).toContain('Hello from agent-1');
    // Titled as the agent whatever the session calls itself; no folder, provider or owner word.
    expect(panel.querySelector('.cs-heading h1')?.textContent).toBe('Canvas agent');
    expect(panel.querySelector('.cs-meta')?.textContent).toBe('Claude Code login');
    expect(q('button[aria-label="Full screen"]')).toBeNull();
    expect(panel.textContent).not.toContain('Copy resume command');
    await type('and then?');
    await click(q('button[aria-label="Send"]'));
    expect(send).toHaveBeenCalledWith('agent-1', 'and then?', []);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it('"New conversation" returns to the empty state, whose send starts another; "Back to conversation" undoes it', async () => {
    first = { ...BASE, agent: session({ id: 'agent-0', state: 'idle' }) };
    await render();
    await click(orb());
    expect(openChat).toHaveBeenCalledWith('agent-0');
    await click(q('[data-testid="agent-new"]'));
    expect(q('[data-testid="agent-start"]')).not.toBeNull();
    await click(q('[data-testid="agent-resume"]'));
    expect(q('.thread')?.textContent).toContain('Hello from agent-0');
    await click(q('[data-testid="agent-new"]'));
    await type('start over');
    await click(q('button[aria-label="Send"]'));
    expect(startAgent).toHaveBeenCalledWith('start over', []);
    expect(q('.thread')?.textContent).toContain('Hello from agent-1');
  });

  it('says why when the agent cannot run, and sending is off', async () => {
    info = { connection: 'claude-login', available: false, reason: 'Claude Code is signed out on this Mac. Run claude, then /login.' };
    await render();
    await click(orb());
    expect(q('[data-testid="agent-unavailable"]')?.textContent).toBe(info.reason);
    expect(q('[data-testid="agent-unavailable"]')?.getAttribute('role')).toBe('alert');
    expect(field().disabled).toBe(true);
    expect(q<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(true);
    expect(chips().every((c) => c.disabled)).toBe(true);
    expect(q('.chat-screen .cs-meta')?.textContent).toBe('Claude Code login');
  });

  it('⌘J opens and closes it, Esc closes it, and focus returns to the orb', async () => {
    await render();
    await press({ key: 'j', metaKey: true });
    expect(q('[data-testid="agent-start"]')).not.toBeNull();
    // From the message field too.
    await press({ key: 'j', metaKey: true }, field());
    expect(q('.chat-screen')).toBeNull();
    expect(window.location.hash).toBe('');
    expect(document.activeElement).toBe(orb());
    await click(orb());
    await press({ key: 'Escape' }, q('.chat-screen')!);
    expect(q('.chat-screen')).toBeNull();
    await click(orb());
    await click(q('button[aria-label="Close chat"]'));
    expect(q('.chat-screen')).toBeNull();
  });

  it('a card click moves the panel from the agent to that card’s chat', async () => {
    await render();
    await click(orb());
    await click(q('[data-card-id="one"]'));
    expect(q('.chat-screen .cs-heading h1')?.textContent).toBe('Some generated title');
    expect(q('button[aria-label="Full screen"]')).not.toBeNull();
    expect(orb().getAttribute('aria-expanded')).toBe('false');
  });
});
