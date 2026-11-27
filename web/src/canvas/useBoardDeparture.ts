// Preserve the last painted box when a zone or an open thread disappears.
// A thread that moved with its source card instead glides into its new slot.
import { useLayoutEffect, type RefObject } from 'react';
import { instant, EXIT_MS } from '../useClosing.ts';
import { glideFrom } from './dragItem.ts';

export function useBoardDeparture(ref: RefObject<HTMLElement | null>, kind: 'zone' | 'thread', id: string) {
  useLayoutEffect(() => {
    const selector = `[data-${kind}-id="${CSS.escape(id)}"]`;
    const el = ref.current?.closest<HTMLElement>(selector);
    const board = el?.closest<HTMLElement>('.board');
    if (!el || !board) return;
    const key = `${kind}:${id}`;
    board.querySelector(`.board-departure[data-departure-for="${CSS.escape(key)}"]`)?.remove();
    return () => {
      if (instant() || !el.isConnected) return;
      const box = el.getBoundingClientRect();
      const origin = board.getBoundingClientRect();
      const zoom = new DOMMatrixReadOnly(getComputedStyle(board).transform).a;
      if (!box.width || !box.height || !zoom) return;
      const rim = kind === 'zone' ? getComputedStyle(el, '::after') : null;
      const width = rim ? parseFloat(rim.width) : box.width / zoom;
      const height = rim ? parseFloat(rim.height) : box.height / zoom;
      // React has finished any reparenting by the end of the commit.
      queueMicrotask(() => {
        if (!board.isConnected || el.isConnected) return;
        const replacement = board.querySelector<HTMLElement>(selector);
        if (replacement) {
          if (kind === 'thread') {
            replacement.dataset.moved = '';
            glideFrom(replacement, box, zoom);
          }
          return;
        }
        const ghost = document.createElement('div');
        ghost.className = 'board-departure';
        ghost.dataset.departureFor = key;
        ghost.inert = true;
        ghost.setAttribute('aria-hidden', 'true');
        ghost.style.left = `${(box.left - origin.left) / zoom}px`;
        ghost.style.top = `${(box.top - origin.top) / zoom}px`;
        // Cards and tiles have their own destinations. Only the named surface retires.
        const face = el.cloneNode(kind === 'thread') as HTMLElement;
        face.removeAttribute(`data-${kind}-id`);
        face.removeAttribute('data-item-id');
        if (kind === 'zone') {
          face.style.removeProperty('--zone-w');
          face.style.removeProperty('--zone-h');
          face.style.removeProperty('--earlier-height');
          face.style.removeProperty('translate');
          const label = el.querySelector('.zone-label');
          if (label) face.append(label.cloneNode(true));
        }
        face.style.width = `${width}px`;
        face.style.height = `${height}px`;
        ghost.append(face);
        board.append(ghost);
        setTimeout(() => ghost.remove(), EXIT_MS);
      });
    };
  }, [ref, kind, id]);
}
