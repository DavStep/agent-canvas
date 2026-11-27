// The chat panel's left edge: drag it (or use the arrow keys on it) to change the panel's width;
// a double click goes back to the default width.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampPanelWidth, PANEL_MIN, PANEL_STEP } from './panelWidth.ts';

export interface PanelEdgeProps {
  /** The width the owner chose, or null for the default. */
  width: number | null;
  /** A new width (null: the default). `done` once a drag or key press is over, to be remembered. */
  onResize(width: number | null, done: boolean): void;
}

export function PanelEdge({ width, onResize }: PanelEdgeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; w: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The panel's width as drawn now, and the page's (the window's) it must leave the canvas room in. */
  const drawn = () => ref.current?.parentElement?.getBoundingClientRect().width ?? PANEL_MIN;
  const page = () => ref.current?.closest('.app')?.clientWidth || window.innerWidth;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const w = drawn();
    drag.current = { id: e.pointerId, x: e.clientX, w, last: w };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // The edge is on the panel's left: moving left widens it.
    const next = clampPanelWidth(d.w + d.x - e.clientX, page());
    if (next === d.last) return;
    d.last = next;
    onResize(next, false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (d.last !== d.w) onResize(d.last, true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? PANEL_STEP : e.key === 'ArrowRight' ? -PANEL_STEP : 0;
    if (step === 0) return;
    e.preventDefault();
    onResize(clampPanelWidth(drawn() + step, page()), true);
  };

  return (
    <div
      ref={ref}
      className={`panel-edge${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      aria-valuemin={PANEL_MIN}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      title="Drag to resize · double-click for the default width"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(null, true)}
    />
  );
}
