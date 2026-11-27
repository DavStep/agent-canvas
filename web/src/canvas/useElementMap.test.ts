import { describe, expect, it } from 'vitest';
import { elementMap } from './useElementMap.ts';

const el = (name: string) => ({ name }) as unknown as HTMLElement;

function watcher() {
  const watched = new Set<HTMLElement>();
  return {
    watched,
    observe: (e: Element) => { watched.add(e as HTMLElement); },
    unobserve: (e: Element) => { watched.delete(e as HTMLElement); },
  };
}

describe('elementMap', () => {
  it('hands out the same ref callback for an id on every render', () => {
    const w = watcher();
    const map = elementMap(() => w);
    const ref = map.refFor('a');
    ref(el('a'));
    expect(map.refFor('a')).toBe(ref);
    expect(map.refFor('b')).not.toBe(ref);
  });

  it('watches an element while it is mounted, and lets go when it unmounts', () => {
    const w = watcher();
    const map = elementMap(() => w);
    const a = el('a');
    map.refFor('a')(a);
    expect(map.els.get('a')).toBe(a);
    expect(w.watched.has(a)).toBe(true);
    map.refFor('a')(null);
    expect(map.els.has('a')).toBe(false);
    expect(w.watched.has(a)).toBe(false);
  });

  it('keeps a card that remounted under the same id when its old callback lets go', () => {
    const w = watcher();
    const map = elementMap(() => w);
    const first = el('first');
    const old = map.refFor('a');
    old(first);
    old(null);
    const second = el('second');
    old(second); // React re-attaches the callback it rendered with
    const fresh = map.refFor('a'); // the next render hands out a new one: React swaps them
    expect(fresh).not.toBe(old);
    old(null);
    fresh(second);
    expect(map.els.get('a')).toBe(second);
    expect([...w.watched]).toEqual([second]);
  });

  it('settles on one callback after a swap, so React stops re-attaching refs every render', () => {
    // React's StrictMode detaches and re-attaches every ref once after mount (dev only).
    const map = elementMap(() => watcher());
    const a = el('a');
    const old = map.refFor('a');
    old(a);
    old(null);
    old(a);
    const fresh = map.refFor('a'); // next render
    old(null); // React swaps the callbacks: the old one lets go...
    fresh(a); // ...and the new one attaches
    expect(map.refFor('a')).toBe(fresh); // the render after that must not ask for another swap
    expect(map.els.get('a')).toBe(a);
  });

  it('works before the observer exists and leaves the elements for it to pick up', () => {
    const map = elementMap(() => null);
    const a = el('a');
    map.refFor('a')(a);
    expect([...map.els.values()]).toEqual([a]);
  });
});
