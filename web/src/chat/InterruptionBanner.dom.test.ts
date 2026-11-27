// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInterruption } from '../../../shared/types.ts';
import { InterruptionBanner } from './InterruptionBanner.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 17, 19, 50).getTime();
const limit: SessionInterruption = { kind: 'limit', reason: "You've hit your 5-hour limit · resets 9pm", at: NOW - 60_000, resetsAt: new Date(2026, 10, 17, 21, 0).getTime() };
const killed: SessionInterruption = { kind: 'killed', reason: 'Its process ended mid-turn, while running Bash', at: NOW - 60_000, resetsAt: null };

let host: HTMLElement | null = null;
afterEach(() => { host?.remove(); host = null; });

function mount(interruption: SessionInterruption, now = NOW, blocked: string | null = null) {
  const calls: string[] = [];
  host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const render = (at: number, next = interruption) => act(() => root.render(createElement(InterruptionBanner, {
    interruption: next, now: at, blocked,
    onContinue: async () => { calls.push('continue'); },
    onAbort: async () => { calls.push('abort'); },
  })));
  render(now);
  const el = host;
  const button = (name: string) => [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith(name))!;
  const banner = el.querySelector<HTMLElement>('.cs-banner.is-interrupted')!;
  const key = async (target: HTMLElement, k: string) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
  };
  return { el, calls, button, banner, key, render };
}

describe('InterruptionBanner', () => {
  it('says what happened, in the banner', () => {
    const { banner } = mount(killed);
    expect(banner.textContent).toContain('Cut off mid-turn');
    expect(banner.textContent).toContain('Its process ended mid-turn, while running Bash');
  });

  it('Continue sends; Abort dismisses without sending', async () => {
    const { calls, button } = mount(killed);
    await act(async () => { button('Continue').click(); });
    expect(calls).toEqual(['continue']);
    await act(async () => { button('Abort').click(); });
    expect(calls).toEqual(['continue', 'abort']);
  });

  it('Continue waits, with a countdown, until the limit resets', async () => {
    const { calls, button, banner, key, render } = mount(limit);
    expect(banner.textContent).toContain('Limit hit · resets 21:00 · in 1h 10m');
    expect(banner.classList.contains('is-reset')).toBe(false);
    expect(button('Continue').textContent).toBe('Continue in 1h 10m');
    expect(button('Continue').disabled).toBe(true);
    await key(banner, 'Enter');
    expect(calls).toEqual([]);
    render(limit.resetsAt! + 1000);
    // Reset: calm green, Continue ready.
    expect(banner.textContent).toContain('Limit reset · you can continue');
    expect(banner.classList.contains('is-reset')).toBe(true);
    expect(banner.querySelector('.alert-dot')).toBeNull();
    expect(button('Continue').textContent).toBe('Continue');
    expect(button('Continue').disabled).toBe(false);
    await key(banner, 'Enter');
    expect(calls).toEqual(['continue']);
  });

  it('counts down by the second on its own, and turns to Limit reset on time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      vi.setSystemTime(limit.resetsAt! - 65_000);
      const { button, banner } = mount(limit, limit.resetsAt! - 65_000);
      expect(button('Continue').textContent).toBe('Continue in 2m');
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(button('Continue').textContent).toBe('Continue in 55s');
      await act(async () => { vi.advanceTimersByTime(56_000); });
      expect(banner.textContent).toContain('Limit reset · you can continue');
      expect(button('Continue').disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an external reset enables Continue in the open banner without sending a turn', async () => {
    const { banner, button, calls, key, render } = mount(limit);
    expect(button('Continue').disabled).toBe(true);
    render(NOW, { ...limit, codexUsage: 'available', resetsAt: null, reason: 'Continue the interrupted turn when you’re ready.' });
    expect(banner.textContent).toContain('Codex usage is available again');
    expect(button('Continue').disabled).toBe(false);
    expect(calls).toEqual([]);
    await key(banner, 'Enter');
    expect(calls).toEqual(['continue']);
  });

  it('Enter on the focused banner continues and Esc aborts, as on a permission card', async () => {
    const { calls, banner, key, button } = mount(killed);
    expect(document.activeElement).toBe(banner);
    await key(banner, 'Enter');
    await key(button('Abort'), 'Escape');
    expect(calls).toEqual(['continue', 'abort']);
  });

  it('a blocked session cannot continue from here', () => {
    const { button } = mount(killed, NOW, 'Claude is signed out');
    expect(button('Continue').disabled).toBe(true);
    expect(button('Continue').title).toBe('Claude is signed out');
  });
});
