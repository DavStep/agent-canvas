// Staying a moment after being closed. A side panel (the chat, the preview) is drawn only while
// the page's state says it is open, so by the time it should leave React has nothing to draw.
// `useLingering` keeps the last element it was given, with `closing` set, for as long as the exit
// in motion.css takes; its props are the ones it closed with. `useArriving` says the opposite: a
// side has just opened, so its entrance should play (and not when its content is only swapped).
// With reduced motion nothing lingers and nothing arrives. See docs/motion.md.
import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { instant } from './useClosing.ts';

/** How long a side panel's exit runs (--t-panel-exit in theme.css). */
export const PANEL_EXIT_MS = 200;
/** How long its entrance runs (--t-panel), with a frame or two to spare. */
export const PANEL_ENTER_MS = 360;

/**
 * The element to draw: `el` while there is one, then the last one with `closing` for `ms`.
 * An element that comes back within that time (same key) is the same one, no longer closing.
 */
export function useLingering<P extends { closing?: boolean }>(el: ReactElement<P> | null, ms: number): ReactElement<P> | null {
  const open = el !== null;
  const last = useRef<ReactElement<P> | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const [leaving, setLeaving] = useState<ReactElement<P> | null>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    setLeaving(open || instant() ? null : last.current);
  }
  if (el !== null) last.current = el;
  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setLeaving(null), ms);
    return () => clearTimeout(timer);
  }, [leaving, ms]);
  if (el !== null) return el;
  return leaving === null ? null : cloneElement(leaving, { closing: true } as Partial<P>);
}

/** True from the render in which `on` turns true, for `ms`. */
export function useArriving(on: boolean, ms: number): boolean {
  const [was, setWas] = useState(on);
  const [arriving, setArriving] = useState(false);
  if (on !== was) {
    setWas(on);
    setArriving(on && !instant());
  }
  useEffect(() => {
    if (!arriving) return;
    const timer = setTimeout(() => setArriving(false), ms);
    return () => clearTimeout(timer);
  }, [arriving, ms]);
  return arriving;
}

/** Draws the first of its children there is, and lets it linger once there is none. Each child
    keeps the identity of its own place in the list, as it would without this around it. */
export function Lingering({ ms, children }: { ms: number; children?: ReactNode }): ReactElement | null {
  const first = Children.toArray(children).find((c) => isValidElement(c)) as ReactElement<{ closing?: boolean }> | undefined;
  return useLingering(first ?? null, ms);
}
