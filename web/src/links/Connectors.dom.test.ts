// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Connectors } from './Connectors.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('offers a new session only on empty canvas or zone space and preserves card drops and cancellation', () => {
  const workspace = document.body.appendChild(document.createElement('main'));
  const board = workspace.appendChild(document.createElement('div'));
  board.innerHTML = '<div class="zone" data-zone-id="z"><div class="card" data-card-id="a"></div><div class="card" data-card-id="b"></div><button>Files</button></div>';
  const root = createRoot(board.appendChild(document.createElement('div')));
  const onNewSession = vi.fn();
  const onLink = vi.fn();
  const hit = vi.fn();
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  vi.stubGlobal('CSS', { escape: (id: string) => id });
  try {
    act(() => root.render(createElement(Connectors, { board: { current: board }, scale: () => 1, lines: [], nameOf: id => id, onLink, onNewSession, onUnlink: vi.fn() })));
    const [source, target] = board.querySelectorAll<HTMLElement>('.card');
    const port = board.querySelector<HTMLButtonElement>('.link-port')!;
    port.setPointerCapture = vi.fn();
    const pointer = (el: Element, name: string) => act(() => {
      el.dispatchEvent(new PointerEvent(name, { pointerId: 1, isPrimary: true, bubbles: true, button: 0 }));
    });
    const drop = (at: Element, cancel = false) => {
      pointer(source!, 'pointerover');
      pointer(port, 'pointerdown');
      hit.mockReturnValue(at);
      pointer(port, 'pointermove');
      if (cancel) act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
      pointer(port, 'pointerup');
    };
    drop(port);
    drop(source!);
    drop(document.body);
    drop(board.querySelector('.zone button')!);
    drop(workspace, true);
    expect(onNewSession).not.toHaveBeenCalled();
    expect(onLink).not.toHaveBeenCalled();

    drop(target!);
    expect(onLink.mock.calls).toEqual([['a', 'b']]);
    drop(workspace);
    drop(board.querySelector('.zone')!);
    expect(onNewSession.mock.calls).toEqual([['a', undefined], ['a', 'z']]);
  } finally {
    act(() => root.unmount());
    workspace.remove();
    Reflect.deleteProperty(document, 'elementFromPoint');
    vi.unstubAllGlobals();
  }
});
