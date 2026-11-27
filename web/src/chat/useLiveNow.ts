// A clock that ticks every second until `until` (a usage limit's reset), so a countdown runs
// live and its banner turns to "Limit reset" on time; the app's own clock ticks far slower.
// It runs on from the `base` it is given (the app's clock), never jumping ahead of it.
import { useEffect, useRef, useState } from 'react';

const SECOND = 1000;

export function useLiveNow(base: number, until: number | null): number {
  const [, setTicks] = useState(0);
  const anchor = useRef({ base, at: Date.now() });
  if (anchor.current.base !== base) anchor.current = { base, at: Date.now() };
  const live = until !== null && until + SECOND > base;
  const current = (): number => anchor.current.base + Math.max(0, Date.now() - anchor.current.at);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      setTicks((n) => n + 1);
      if (current() > until! + SECOND) clearInterval(t);
    }, SECOND);
    return () => clearInterval(t);
  }, [live, until]);
  return live ? current() : base;
}
