// A drag handle on the edge of a side column. Drag to resize, double-click to reset, or focus it
// and use the arrow keys.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { PANELS, type Panel } from './panelWidths.ts';

export interface ResizeHandleProps {
  panel: Panel;
  width: number;
  onResize(panel: Panel, width: number): void;
}

const STEP = 16;

export function ResizeHandle({ panel, width, onResize }: ResizeHandleProps) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // The rail grows to the right of its handle; the preview grows to the left.
  const sign = panel === 'rail' ? 1 : -1;
  const spec = PANELS[panel];

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    onResize(panel, start.current.width + sign * (e.clientX - start.current.x));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    start.current = null;
    setDragging(false);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowRight' ? STEP : e.key === 'ArrowLeft' ? -STEP : 0;
    if (d !== 0) { e.preventDefault(); onResize(panel, width + sign * d); }
    else if (e.key === 'Home') { e.preventDefault(); onResize(panel, spec.min); }
    else if (e.key === 'End') { e.preventDefault(); onResize(panel, spec.max); }
  };

  return (
    <div
      className={`cs-resize is-${panel}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={panel === 'rail' ? 'Resize sessions list' : 'Resize preview'}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuenow={width}
      tabIndex={0}
      // Hides the native browser view while dragging, so it can't swallow the pointer.
      data-resizing={dragging ? '' : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onResize(panel, spec.initial)}
      onKeyDown={key}
    />
  );
}
