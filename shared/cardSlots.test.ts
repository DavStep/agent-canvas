import { describe, expect, it } from 'vitest';
import type { Layout } from './types.ts';
import { applySlotOp, cleanZoneSlots, MAX_SLOT_COLUMNS, parseSlotOp, withCleanSlots } from './cardSlots.ts';
import { applyLayoutOp } from '../server/layoutOps.ts';
import { isLayout } from '../server/persist.ts';
import { validate } from '../electron/ipc.ts';

const empty = (): Layout => ({ version: 1, zones: [], assignments: {} });

describe('card slots in the saved layout', () => {
  it('setSlots keeps a zone\'s slots, cleaned, and null forgets them', () => {
    const one = applyLayoutOp(empty(), { type: 'setSlots', zoneId: 'folder:a', slots: { columns: [['x', 'y'], ['x', 'z'], []], earlier: ['y', 'old'] } });
    // Each id once, its first place winning; a trailing empty column goes.
    expect(one.slots).toEqual({ 'folder:a': { columns: [['x', 'y'], ['z']], earlier: ['old'] } });
    // The same slots again change nothing (the same layout comes back).
    expect(applyLayoutOp(one, { type: 'setSlots', zoneId: 'folder:a', slots: { columns: [['x', 'y'], ['z']], earlier: ['old'] } })).toBe(one);
    expect(applyLayoutOp(one, { type: 'setSlots', zoneId: 'folder:a', slots: null }).slots).toEqual({});
  });

  it('a malformed op or saved entry is refused without costing the layout', () => {
    const l = empty();
    expect(applySlotOp(l, { type: 'setSlots', zoneId: 'z', slots: { columns: 'no', earlier: [] } as never })).toBe(l);
    expect(applySlotOp(l, { type: 'setSlots', zoneId: 'z', slots: { columns: Array.from({ length: MAX_SLOT_COLUMNS + 1 }, () => ['a']), earlier: [] } })).toBe(l);
    expect(parseSlotOp({ type: 'setSlots', zoneId: '', slots: null })).toBeNull();
    expect(parseSlotOp({ type: 'setSlots', zoneId: 'z', slots: { columns: [[1]], earlier: [] } })).toBeNull();
    expect(parseSlotOp({ type: 'setSlots', zoneId: 'z', slots: { columns: [['a']], earlier: [], extra: 1 } }))
      .toEqual({ type: 'setSlots', zoneId: 'z', slots: { columns: [['a']], earlier: [] } });
    const loaded = withCleanSlots({ ...empty(), slots: { good: { columns: [['a', 'a']], earlier: [] }, bad: { columns: 3 } as never } });
    expect(loaded.slots).toEqual({ good: { columns: [['a']], earlier: [] } });
    expect(isLayout({ ...empty(), slots: { good: { columns: [], earlier: [] } } })).toBe(true);
    expect(isLayout({ ...empty(), slots: [] })).toBe(false);
  });

  it('the bridge passes a setSlots op on, checked, and refuses a broken one', () => {
    expect(validate.layoutOp({ type: 'setSlots', zoneId: 'folder:a', slots: { columns: [['s1']], earlier: [] } }))
      .toEqual({ type: 'setSlots', zoneId: 'folder:a', slots: { columns: [['s1']], earlier: [] } });
    expect(() => validate.layoutOp({ type: 'setSlots', zoneId: 'folder:a', slots: { columns: [[{}]], earlier: [] } })).toThrow();
  });

  it('a deleted zone takes its slots with it', () => {
    let l = applyLayoutOp(empty(), { type: 'createZone', name: 'Mine' });
    const id = l.zones[0]!.id;
    l = applyLayoutOp(l, { type: 'setSlots', zoneId: id, slots: { columns: [['a']], earlier: [] } });
    expect(l.slots?.[id]).toBeDefined();
    expect(applyLayoutOp(l, { type: 'deleteZone', id }).slots).toEqual({});
  });

  it('cleaning keeps an emptied column in the middle, so the columns after it stay put', () => {
    expect(cleanZoneSlots({ columns: [['a'], [], ['b']], earlier: [] })).toEqual({ columns: [['a'], [], ['b']], earlier: [] });
  });
});
