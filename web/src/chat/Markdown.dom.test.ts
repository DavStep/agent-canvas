// @vitest-environment jsdom
// Pressing a link in a reply: the app hands it to the owner's browser and the page itself stays put.
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opened: string[] = [];
// The preload's bridge, read once when bridge.ts loads, so it is set before the import below.
(window as unknown as { canvas: { openExternal: (url: string) => Promise<void> } }).canvas = {
  openExternal: async (url) => { opened.push(url); },
};
const { LinkedText, Markdown } = await import('./Markdown.tsx');

let host: HTMLElement | null = null;
afterEach(() => { host?.remove(); host = null; opened.length = 0; });

function mount(node: ReactElement) {
  host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  act(() => root.render(node));
  return host;
}

/** A real press, so the anchor's own default (navigating the window) can be seen or stopped. */
function press(el: HTMLElement, type: 'click' | 'auxclick', button = 0): MouseEvent {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, button });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}

describe('pressing a link', () => {
  it('opens a bare URL in the browser and never navigates the window', () => {
    const el = mount(createElement(Markdown, { text: 'The ticket is https://tickets.example.com/t/4576 for this.' }));
    const a = el.querySelector<HTMLAnchorElement>('a.md-link')!;
    expect(a.title).toBe('https://tickets.example.com/t/4576');
    expect(a.textContent).toBe('https://tickets.example.com/t/4576');
    const ev = press(a, 'click');
    expect(opened).toEqual(['https://tickets.example.com/t/4576']);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('opens a Markdown link by its target, and a middle click the same way', () => {
    const el = mount(createElement(Markdown, { text: 'See [the docs](https://example.test/a?b=1).' }));
    const a = el.querySelector<HTMLAnchorElement>('a.md-link')!;
    expect(a.textContent).toBe('the docs');
    press(a, 'click');
    const aux = press(a, 'auxclick', 1);
    expect(opened).toEqual(['https://example.test/a?b=1', 'https://example.test/a?b=1']);
    expect(aux.defaultPrevented).toBe(true);
  });

  it('opens a URL in the message the owner sent', () => {
    const el = mount(createElement(LinkedText, { text: 'look at https://example.test/x, thanks' }));
    press(el.querySelector<HTMLAnchorElement>('a.md-link')!, 'click');
    expect(opened).toEqual(['https://example.test/x']);
  });

  it('leaves no link to press for a blocked scheme', () => {
    const el = mount(createElement(Markdown, { text: 'Run [this](javascript:alert(1)) or file:///etc/passwd' }));
    expect(el.querySelectorAll('a')).toHaveLength(0);
    expect(el.textContent).toContain('file:///etc/passwd');
  });
});
