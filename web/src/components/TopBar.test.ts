import { describe, expect, it } from 'vitest';
import { focusLeaves } from './TopBar.tsx';

/** A stand-in for the menu's wrapper element: it contains the nodes listed. */
const menu = (...inside: object[]) => ({ contains: (n: unknown) => inside.includes(n as object) });

describe('focusLeaves', () => {
  const item = {};
  const outside = {};

  it('is true when focus moves to an element outside the menu', () => {
    expect(focusLeaves(menu(item), outside as EventTarget)).toBe(true);
  });

  it('is false when focus moves within the menu', () => {
    expect(focusLeaves(menu(item), item as EventTarget)).toBe(false);
  });

  it('is false when focus goes nowhere (an item replaced under it, or the window losing focus)', () => {
    expect(focusLeaves(menu(item), null)).toBe(false);
    expect(focusLeaves(null, outside as EventTarget)).toBe(false);
  });
});
