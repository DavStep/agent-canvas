// @vitest-environment jsdom
// The dialog in the DOM, under <StrictMode> as main.tsx renders it: development React mounts,
// cleans up and mounts again, and the dialog must still hear back from its start.
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CanvasBridge, ProviderOptions } from '../../../shared/bridge.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: ProviderOptions = {
  models: [{ id: 'default', label: 'Default', isDefault: true }], model: 'default', effort: null, modes: [{ id: 'default', label: 'Ask' }], mode: 'default',
};

const acpAgent = (id: string, name: string, command: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, command, args: [], env: {}, icon: 'agent', path: `/usr/local/bin/${command}`, install: null, ...extra });
/** Settings with three ACP agents: Gemini (shown by default), the Claude adapter (hidden by
    default) and the Codex adapter the owner chose to show. */
const SETTINGS = {
  agentConnection: 'claude-login', defaults: {}, shownModels: { claude: null, codex: null }, acpPresets: [],
  acpAgents: [
    acpAgent('gemini', 'Gemini CLI', 'gemini'),
    acpAgent('claude-acp', 'Claude Code (ACP)', 'claude-agent-acp'),
    acpAgent('codex-acp', 'Codex (ACP)', 'codex-acp', { showInNewSession: true }),
  ],
};

const projectTask = vi.fn<CanvasBridge['projectTask']>();
let newSession: ReturnType<typeof vi.fn<CanvasBridge['newSession']>>;
let NewSessionDialog: typeof import('./NewSessionDialog.tsx').NewSessionDialog;

beforeAll(async () => {
  // jsdom has <dialog> but no modal API.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  newSession = vi.fn<CanvasBridge['newSession']>();
  // The page reads window.canvas when bridge.ts loads, so the stand-in comes first.
  (window as { canvas?: Partial<CanvasBridge> }).canvas = {
    options: async () => OPTIONS, pickFolder: async () => null, newSession, projectTask,
    getSettings: async () => SETTINGS as unknown as Awaited<ReturnType<CanvasBridge['getSettings']>>,
  };
  ({ NewSessionDialog } = await import('./NewSessionDialog.tsx'));
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render(onStarted = vi.fn(), onClose = vi.fn(), after?: { id: string; name: string }) {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(StrictMode, null, createElement(NewSessionDialog, {
      sessions: [], layout: { version: 1, zones: [], assignments: {} }, cwd: '/work/alpha', onClose, onStarted, after,
    })));
  });
  return { onStarted, onClose };
}

/** Types into the message field as a person would (React listens for input events). */
function type(text: string): void {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="First message"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;

describe('NewSessionDialog under StrictMode', () => {
  it('can still send to the orchestrator from the manual New session dialog', async () => {
    projectTask.mockResolvedValue('new-coordinator');
    const { onStarted } = await render();
    await act(async () => { button('Orchestrator').click(); });
    await act(async () => { type('Route this task'); });
    await act(async () => { button('Send to orchestrator').click(); });
    expect(projectTask).toHaveBeenCalledWith('/work/alpha', 'Route this task', []);
    expect(onStarted).toHaveBeenCalledWith('new-coordinator');
  });

  it('a refused start shows its reason inline and the dialog stays open', async () => {
    newSession.mockRejectedValueOnce(new Error("Error invoking remote method 'canvas:newSession': Error: The folder /work/alpha no longer exists"));
    const { onStarted, onClose } = await render();
    await act(async () => { type('Fix the build'); });
    expect(button('Start').disabled).toBe(false);
    await act(async () => { button('Start').click(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('The folder /work/alpha no longer exists');
    expect(button('Start').disabled).toBe(false);
    expect(document.querySelector('dialog[open]')).not.toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a start that succeeds hands its card id on', async () => {
    newSession.mockResolvedValueOnce('card-1');
    const { onStarted } = await render();
    await act(async () => { type('Fix the build'); });
    await act(async () => { button('Start').click(); });
    expect(onStarted).toHaveBeenCalledWith('card-1');
    expect(newSession).toHaveBeenLastCalledWith({ provider: 'claude', cwd: '/work/alpha', model: null, effort: null, mode: 'default', text: 'Fix the build', images: [] }, undefined);
  });

  it('queues the first message after the source and opens the linked card', async () => {
    newSession.mockResolvedValueOnce('plan:run-1');
    const { onStarted } = await render(vi.fn(), vi.fn(), { id: 'source', name: 'Fix login' });
    expect(document.querySelector('dialog')?.textContent).toContain('after “Fix login” finishes');
    await act(async () => { type('Test login'); });
    await act(async () => { button('Queue session').click(); });
    expect(newSession).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/work/alpha', text: 'Test login' }), 'source');
    expect(onStarted).toHaveBeenCalledWith('plan:run-1');
  });

  it('offers Claude, Codex and the ACP agents shown in New session; the Claude and Codex adapters only when turned on', async () => {
    await render();
    await act(async () => { await Promise.resolve(); });
    const tabs = [...document.querySelectorAll('[aria-label="Start with"] [role="radio"]')].map((b) => b.textContent);
    expect(tabs).toEqual(['Claude', 'Codex', 'Gemini CLI', 'Codex (ACP)', 'Orchestrator']);
  });

  it('Cancel closes while a start is pending, and its late answer opens nothing', async () => {
    let settle!: (id: string) => void;
    newSession.mockReturnValueOnce(new Promise<string>((r) => { settle = r; }));
    const { onStarted, onClose } = await render();
    await act(async () => { type('Fix the build'); });
    await act(async () => { button('Start').click(); });
    expect(button('Starting…').disabled).toBe(true);
    await act(async () => { button('Cancel').click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { settle('card-2'); });
    expect(onStarted).not.toHaveBeenCalled();
  });
});
