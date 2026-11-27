import { expect, it } from 'vitest';
import { heldAt, localPoint } from './dragItem.ts';

it.each([0.53, 1, 1.5])('keeps the original grab point through pan and zoom from %s', zoom => {
  const grip = localPoint({ x: 230 + 80 * zoom, y: 90 + 12 * zoom }, { left: 230, top: 90 }, zoom);
  const pointer = { x: 377, y: 219 };
  for (const k of [0.53, 1.5]) {
    const board = { left: -125, top: 270 };
    const at = heldAt(pointer, board, k, grip);
    expect(board.left + (at.x + 80) * k).toBeCloseTo(pointer.x);
    expect(board.top + (at.y + 12) * k).toBeCloseTo(pointer.y);
  }
});
