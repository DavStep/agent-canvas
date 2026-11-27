// Leaving with a short exit: `close()` marks the surface as closing (its CSS plays the way out,
// see docs/motion.md) and calls `onClose` once that has played. With reduced motion, or where
// nothing animates, it closes at once.
import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the exit keyframes in motion.css run (--t-exit). */
export const EXIT_MS = 140;

/** Nothing may animate: reduced motion, or no page to animate on. */
export const instant = (): boolean =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useClosing(onClose: () => void): { closing: boolean; close(): void } {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const close = useCallback(() => {
    if (timer.current !== null) return;
    if (instant()) { latest.current(); return; }
    setClosing(true);
    timer.current = setTimeout(() => latest.current(), EXIT_MS);
  }, []);
  return { closing, close };
}
