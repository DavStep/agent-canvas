// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Lingering, useArriving } from './useLingering.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Panel({ name, closing }: { name: string; closing?: boolean }) {
  return createElement('div', { className: `panel${closing ? ' is-closing' : ''}` }, name);
}
function Page({ a, b, open }: { a?: string; b?: string; open: boolean }) {
  const arriving = useArriving(open, 360);
  return createElement('div', { className: arriving ? 'page is-opening' : 'page' },
    createElement(Lingering, { ms: 200 }, a ? createElement(Panel, { name: a }) : null, b ? createElement(Panel, { name: b }) : null));
}

let host: HTMLElement;
let root: Root;
const render = (props: { a?: string; b?: string }) => act(() => { root.render(createElement(Page, { ...props, open: !!(props.a ?? props.b) })); });
const panel = () => host.querySelector<HTMLElement>('.panel');
const setMotion = (reduced: boolean | null) => {
  if (reduced === null) delete (window as { matchMedia?: unknown }).matchMedia;
  else window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce') })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  vi.useFakeTimers();
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  setMotion(false);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  setMotion(null);
});

describe('Lingering', () => {
  it('keeps a closed panel, marked closing with the props it closed with, for its exit and no longer', () => {
    render({ a: 'one' });
    const el = panel()!;
    expect(el.className).toBe('panel');
    render({});
    // The same element, not a copy: its scroll place and what was typed in it are as they were.
    expect(panel()).toBe(el);
    expect(panel()!.className).toBe('panel is-closing');
    expect(panel()!.textContent).toBe('one');
    act(() => { vi.advanceTimersByTime(199); });
    expect(panel()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(panel()).toBeNull();
  });

  it('a panel reopened while it leaves is the same one, no longer closing, and is not taken away', () => {
    render({ a: 'one' });
    const el = panel();
    render({});
    act(() => { vi.advanceTimersByTime(100); });
    render({ a: 'one' });
    expect(panel()).toBe(el);
    expect(panel()!.className).toBe('panel');
    act(() => { vi.advanceTimersByTime(500); });
    expect(panel()).toBe(el);
  });

  it('one panel taking another\'s place does not linger: the new one is there at once, as a new element', () => {
    render({ a: 'one' });
    const el = panel();
    render({ b: 'two' });
    expect(host.querySelectorAll('.panel')).toHaveLength(1);
    expect(panel()).not.toBe(el);
    expect(panel()!.textContent).toBe('two');
    // Another panel opened over one that was leaving ends its exit.
    render({});
    render({ a: 'three' });
    expect(host.querySelectorAll('.panel')).toHaveLength(1);
    expect(panel()!.className).toBe('panel');
  });

  it('with reduced motion, and where nothing animates, a closed panel is gone at once', () => {
    setMotion(true);
    render({ a: 'one' });
    render({});
    expect(panel()).toBeNull();
    setMotion(null);
    render({ a: 'one' });
    render({});
    expect(panel()).toBeNull();
  });
});

describe('useArriving', () => {
  const opening = () => host.querySelector('.page')!.classList.contains('is-opening');
  it('is true from the render that opens, for the entrance, and not when the content only changes', () => {
    render({});
    expect(opening()).toBe(false);
    render({ a: 'one' });
    expect(opening()).toBe(true);
    act(() => { vi.advanceTimersByTime(360); });
    expect(opening()).toBe(false);
    render({ b: 'two' });
    expect(opening()).toBe(false);
  });

  it('never with reduced motion', () => {
    setMotion(true);
    render({ a: 'one' });
    expect(opening()).toBe(false);
  });
});
