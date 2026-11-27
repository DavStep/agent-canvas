// Elements by id, all watched by one ResizeObserver that lives as long as the component.
import { useLayoutEffect, useRef } from 'react';

type RefCallback = (el: HTMLElement | null) => void;
type Watcher = Pick<ResizeObserver, 'observe' | 'unobserve'>;

export interface ElementMap {
  /** The mounted elements, by id. */
  els: Map<string, HTMLElement>;
  /** A ref callback for one id; the same function on every render, so React never re-attaches it. */
  refFor(id: string): RefCallback;
}

/** The bookkeeping behind useElementMap, without React: elements by id and stable ref callbacks
    that start and stop watching through whatever observer `watcher()` returns at the time. */
export function elementMap(watcher: () => Watcher | null): ElementMap {
  const els = new Map<string, HTMLElement>();
  const refs = new Map<string, RefCallback>();
  const refFor = (id: string): RefCallback => {
    let ref = refs.get(id);
    if (ref === undefined) {
      // Each callback lets go of only the element it attached, so a card that remounts
      // elsewhere under the same id is never dropped by its old callback.
      let mine: HTMLElement | null = null;
      ref = (el) => {
        if (mine) {
          watcher()?.unobserve(mine);
          if (els.get(id) === mine) els.delete(id);
        }
        mine = el;
        if (el) {
          els.set(id, el);
          watcher()?.observe(el);
        } else if (refs.get(id) === ref) {
          // Only the registered callback forgets itself. A callback React is swapping out must
          // not unregister its replacement, or every render hands out yet another one.
          refs.delete(id);
        }
      };
      refs.set(id, ref);
    }
    return ref;
  };
  return { els, refFor };
}

export function useElementMap(onResize: () => void): ElementMap {
  const observer = useRef<ResizeObserver | null>(null);
  const map = useRef<ElementMap | null>(null);
  map.current ??= elementMap(() => observer.current);
  const latest = useRef(onResize);
  useLayoutEffect(() => { latest.current = onResize; });

  // Created once per mount (twice under StrictMode's rehearsal), never per render.
  useLayoutEffect(() => {
    const o = new ResizeObserver(() => latest.current());
    for (const el of map.current!.els.values()) o.observe(el);
    observer.current = o;
    return () => { o.disconnect(); observer.current = null; };
  }, []);

  return map.current;
}
