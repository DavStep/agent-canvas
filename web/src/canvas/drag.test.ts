import { describe, expect, it } from 'vitest';
import type { Layout } from '../../../shared/types.ts';
import { isDrag, layoutWithPending, reconcilePending, zoneAt, type PendingOp } from './drag.ts';

const layout: Layout = {
  version: 1,
  zones: [
    { id: 'folder:a', name: 'a', kind: 'folder', folder: 'a', x: 0, y: 0, hueIndex: 0 },
    { id: 'custom:1', name: 'Later', kind: 'custom', folder: null, x: 400, y: 0, hueIndex: 1 },
  ],
  assignments: {},
};

describe('isDrag', () => {
  it('treats a press that moves less than 4 px as a click', () => {
    expect(isDrag(3, 0)).toBe(false);
    expect(isDrag(2, 2)).toBe(false);
    expect(isDrag(0, -4)).toBe(true);
    expect(isDrag(3, 3)).toBe(true);
  });
});

describe('zoneAt', () => {
  const rects = [
    { id: 'a', x: 0, y: 0, width: 300, height: 200 },
    { id: 'b', x: 250, y: 150, width: 300, height: 200 },
  ];
  it('finds the zone under a canvas point, the later one where two overlap', () => {
    expect(zoneAt({ x: 10, y: 10 }, rects)).toBe('a');
    expect(zoneAt({ x: 260, y: 160 }, rects)).toBe('b');
    expect(zoneAt({ x: 500, y: 20 }, rects)).toBeNull();
  });
});

describe('pending layout ops', () => {
  const move: PendingOp = { seq: 1, op: { type: 'moveZone', id: 'custom:1', x: 80, y: 520 }, settled: false };
  const assign: PendingOp = { seq: 2, op: { type: 'assign', sessionId: 's1', zoneId: 'custom:1' }, settled: false };

  it('shows the ops on top of the last snapshot', () => {
    const shown = layoutWithPending(layout, [move, assign]);
    expect(shown.zones.find((z) => z.id === 'custom:1')).toMatchObject({ x: 80, y: 520 });
    expect(shown.assignments).toEqual({ s1: 'custom:1' });
    expect(layoutWithPending(layout, [])).toBe(layout);
  });

  it('drops an op once a snapshot shows it, and keeps one the snapshot does not show yet', () => {
    const moved: Layout = { ...layout, zones: layout.zones.map((z) => (z.id === 'custom:1' ? { ...z, x: 80, y: 520 } : z)) };
    expect(reconcilePending([move, assign], moved)).toEqual([assign]);
  });

  it('drops an op that had settled before the snapshot came, even if the reader changed nothing', () => {
    expect(reconcilePending([{ ...move, settled: true }], layout)).toEqual([]);
  });
});
