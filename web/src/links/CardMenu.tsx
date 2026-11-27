// A card's menu (right-click, or the menu key on a focused card): "Run after…", and for a card
// with a queued prompt, editing it, trying a failed one again, or taking the wait away. Fixed to
// the window like the zone menu, in the board menu's shape (.menu, .menu-item).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { clampMenu } from '../components/ZoneMenu.tsx';
import type { CardWait } from './links.ts';

export interface CardMenuProps {
  name: string;
  at: { x: number; y: number };
  wait: CardWait | null;
  /** A failed run (not one blocked by an interrupted session) can be tried again. */
  failed: boolean;
  /** Opens "Run after…" for this card (or edits what it waits for). */
  onRunAfter(): void;
  onRemoveWait(): void;
  onRetry(): void;
  onClose(): void;
}

export function CardMenu({ name, at, wait, failed, onRunAfter, onRemoveWait, onRetry, onClose }: CardMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  useLayoutEffect(() => {
    const el = panel.current!;
    setPos(clampMenu(at.x, at.y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
    el.querySelector<HTMLElement>('.menu-item')?.focus();
  }, [at.x, at.y]);

  // Focus goes back where it was (the card); a press outside or a wheel closes it.
  useLayoutEffect(() => {
    const back = document.activeElement;
    return () => { if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const outside = (e: Event) => { if (e.target instanceof Node && !panel.current?.contains(e.target)) onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', outside, { capture: true, passive: true });
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', outside, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...panel.current!.querySelectorAll<HTMLElement>('.menu-item')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const pick = (fn: () => void) => () => { onClose(); fn(); };

  return createPortal(
    <div ref={panel} className="menu card-menu" role="menu" aria-label={`${name} actions`} style={{ left: pos.x, top: pos.y } as CSSProperties}
      onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitem" className="menu-item" onClick={pick(onRunAfter)}>
        <QueueIcon /><span className="name">{wait ? 'Edit what it waits for…' : 'Run after…'}</span>
      </button>
      {wait && failed && (
        <button type="button" role="menuitem" className="menu-item" onClick={pick(onRetry)}><span className="name">Try again</span></button>
      )}
      {wait && (
        <button type="button" role="menuitem" className="menu-item" onClick={pick(onRemoveWait)}><span className="name">Remove the wait</span></button>
      )}
    </div>,
    document.body,
  );
}

/** A small queue glyph: three stacked rows, the top one leading. */
export function QueueIcon() {
  return <svg className="card-icon link-queue-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h7M2.5 8h11M2.5 12h11M12 2.5 13.5 4 12 5.5" /></svg>;
}
