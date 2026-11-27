import type { ItemPlace } from '../../../shared/boardItems.ts';
import { holdItem } from '../canvas/dragItem.ts';
import { readSnap, snapToGrid } from '../canvas/snap.ts';
import type { PanZoom } from '../canvas/usePanZoom.ts';
import { zoneUnder } from './geometry.ts';
import { dropFrom, itemLive } from './itemLive.ts';

interface MoveOptions {
  id: string;
  home: string | null;
  width: number;
  height: number;
  createGhost(): HTMLElement;
  onComposer?(target: HTMLElement): void;
  onPlace(place: ItemPlace): void;
}

export function moveBoardItem(down: PointerEvent, capture: Element, el: HTMLElement, ws: HTMLElement, view: PanZoom, o: MoveOptions): void {
  const board = ws.querySelector<HTMLElement>('.board');
  if (!board) return;
  const tile = el.closest<HTMLElement>('.board-item-tile');
  const rest = tile ? { col: Number(tile.dataset.col), top: Number(tile.dataset.top) } : undefined;
  let zone = o.home;
  let ghost: HTMLElement | undefined;
  let composer: HTMLElement | null = null;
  let inside = true;

  function end() {
    ws.classList.remove('is-item-dragging');
    composer?.classList.remove('is-board-drop');
    ghost?.remove();
    el.style.visibility = '';
    if (itemLive.get()?.id === o.id) itemLive.set(null);
  }
  holdItem(down, capture, el, {
    board, view,
    onLift: () => ws.classList.add('is-item-dragging'),
    onFrame: ({ event, grip, zoom }) => {
      const { clientX: x, clientY: y } = event;
      const bounds = ws.getBoundingClientRect();
      inside = x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
      const zoneEl = inside ? zoneUnder(ws, x, y, zone) : null;
      zone = zoneEl?.dataset.zoneId ?? null;
      const cards = zoneEl?.querySelector(':scope > .cards')?.getBoundingClientRect();
      const next = !inside && o.onComposer ? document.elementFromPoint(x, y)?.closest<HTMLElement>('.composer') ?? null : null;
      if (composer !== next) {
        composer?.classList.remove('is-board-drop');
        composer = next;
        composer?.classList.add('is-board-drop');
      }
      if (!inside && !ghost) {
        ghost = o.createGhost();
        ghost.classList.add('board-item-ghost');
        ghost.setAttribute('aria-hidden', 'true');
        document.body.append(ghost);
      }
      if (ghost) {
        ghost.hidden = inside;
        if (!inside) ghost.style.translate = `${x + 12}px ${y + 12}px`;
        el.style.visibility = inside ? '' : 'hidden';
      }
      if (zone !== null || o.home !== null) {
        itemLive.set({ id: o.id, home: o.home, rest, over: zone && cards
          ? { zone, x: (x - cards.left) / zoom - grip.x, y: (y - cards.top) / zoom - grip.y, width: o.width, height: o.height }
          : null });
      } else if (itemLive.get()?.id === o.id) itemLive.set(null);
    },
    onDrop: ({ at }) => {
      const slot = zone && ws.querySelector<HTMLElement>(`.zone[data-zone-id="${CSS.escape(zone)}"] > .cards > .board-item-slot`);
      const from = el.getBoundingClientRect();
      end();
      if (!inside) {
        el.style.translate = '';
        if (composer) o.onComposer?.(composer);
        return;
      }
      const round = readSnap() ? snapToGrid : Math.round;
      const place = zone && slot ? { zone, col: Number(slot.dataset.col), top: Number(slot.dataset.top) }
        : { zone: null, x: round(at.x), y: round(at.y) };
      dropFrom.set(o.id, from);
      o.onPlace(place);
      // A no-op drop may never cause a React commit.
      requestAnimationFrame(() => {
        if (dropFrom.get(o.id) === from) { dropFrom.delete(o.id); el.style.translate = ''; }
      });
    },
    onCancel: end,
  });
}
