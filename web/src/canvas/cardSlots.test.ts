import { describe, expect, it } from 'vitest';
import type { SessionView } from '../../../shared/types.ts';
import { session } from '../testSession.ts';
import { arrangeZone, isAged, migrateSlots, moveCard, shownSlots, tidyZone, type ArrangeContext, type ZoneSlots } from './cardSlots.ts';
import { flowCards } from './zoneFlow.ts';
import { stackCards } from './stackCards.ts';

const H = 3_600_000;
const NOW = 1_000 * H;
const DAY = 24 * H;
const ctx = (patch: Partial<ArrangeContext> = {}): ArrangeContext =>
  ({ now: NOW, foldAfterMs: DAY, away: false, startup: false, heightOf: () => 82, ...patch });
const ids = (n: number, patch: (i: number) => Partial<SessionView> = () => ({})): SessionView[] =>
  Array.from({ length: n }, (_, i) => session({ id: `s${i}`, state: 'idle', stateSince: NOW - i * 60_000, startedAt: NOW - i * 60_000, ...patch(i) }));

describe('card slots: cards stay put', () => {
  it('migration freezes the order a layout without slots showed (state first, then recency)', () => {
    const cards = [
      session({ id: 'idle', state: 'idle', stateSince: NOW - 10 }),
      session({ id: 'ask', state: 'needs_you', need: 'permission', stateSince: NOW - 20 }),
      session({ id: 'work', state: 'working', stateSince: NOW - 30 }),
      session({ id: 'idle2', state: 'idle', stateSince: NOW - 5 }),
    ];
    const slots = migrateSlots(cards, () => 82);
    expect(slots).toEqual({ columns: [['ask', 'idle2'], ['work', 'idle']], earlier: [] });
    // With no saved slots, arranging freezes the same order.
    expect(arrangeZone(undefined, cards, ctx())).toEqual(slots);
  });

  it('a state change, new activity or a taller card moves no card', () => {
    const cards = ids(6);
    const saved = arrangeZone(undefined, cards, ctx());
    const changed = cards.map((s, i) => i === 4
      ? { ...s, state: 'needs_you' as const, need: 'permission' as const, stateSince: NOW, activity: 'Wants to run: rm' }
      : i === 1 ? { ...s, state: 'working' as const, stateSince: NOW, subagents: [{ id: 'x', type: 't', description: 'd', state: 'working' as const }] } : s);
    // The very same slots come back: nothing to save, nothing moved.
    expect(arrangeZone(saved, changed, ctx())).toBe(saved);
    expect(arrangeZone(saved, changed, ctx({ away: true }))).toBe(saved);
    // A taller card does not send the cards after it to another column.
    const items = (h: (id: string) => number) => saved.columns.flatMap((c, col) => c.map((id) => ({ id, cardH: h(id), col })));
    expect(stackCards(items(() => 82))).toEqual(stackCards(items((id) => (id === 's1' ? 400 : 82))));
  });

  it('a new card takes the first free slot, or the end of the shortest column, moving nobody else', () => {
    const saved: ZoneSlots = { columns: [['a', 'b'], ['c', 'd']], earlier: [] };
    const base = ['a', 'b', 'c', 'd'].map((id) => session({ id }));
    // No hole: four slots in two columns, so the fifth opens a third column.
    const added = arrangeZone(saved, [...base, session({ id: 'new' })], ctx());
    expect(added).toEqual({ columns: [['a', 'b'], ['c', 'd'], ['new']], earlier: [] });
    // `b` left a hole: the next new card takes it; the others keep their slots.
    const gone = base.filter((s) => s.id !== 'b');
    const hole = arrangeZone(saved, gone, ctx());
    expect(hole).toBe(saved);
    expect(shownSlots(hole, new Set(gone.map((s) => s.id))).columns).toEqual([['a'], ['c', 'd']]);
    expect(arrangeZone(saved, [...gone, session({ id: 'n2' })], ctx())).toEqual({ columns: [['a', 'n2'], ['c', 'd']], earlier: [] });
    // Several new ones: the newest gets the first free slot.
    const two = arrangeZone({ columns: [['a', 'x'], ['c', 'y']], earlier: [] }, [...['a', 'c'].map((id) => session({ id })),
      session({ id: 'older', startedAt: 1 }), session({ id: 'newer', startedAt: 2 })], ctx());
    expect(two.columns).toEqual([['a', 'newer'], ['c', 'older']]);
    // With nothing saved and nothing here there is nothing to keep.
    expect(shownSlots(arrangeZone(undefined, [], ctx()), new Set())).toEqual({ columns: [], earlier: [] });
  });

  it('a session that leaves and comes back while its slot is free reclaims it', () => {
    const saved: ZoneSlots = { columns: [['a', 'b'], ['c']], earlier: [] };
    const all = ['a', 'b', 'c'].map((id) => session({ id }));
    const away = arrangeZone(saved, all.filter((s) => s.id !== 'b'), ctx());
    expect(arrangeZone(away, all, ctx())).toEqual(saved);
  });

  it('holes and emptied columns clear only while the owner is away; a middle column emptied stays while looking', () => {
    const saved: ZoneSlots = { columns: [['a', 'x'], ['y'], ['c']], earlier: [] };
    const cards = ['a', 'c'].map((id) => session({ id, stateSince: NOW }));
    expect(arrangeZone(saved, cards, ctx())).toBe(saved);
    expect(shownSlots(saved, new Set(['a', 'c'])).columns).toEqual([['a'], [], ['c']]);
    expect(arrangeZone(saved, cards, ctx({ startup: true }))).toBe(saved);
    expect(arrangeZone(saved, cards, ctx({ away: true }))).toEqual({ columns: [['a'], ['c']], earlier: [] });
  });
});

describe('card slots: aging into Earlier', () => {
  it('folds idle sessions untouched past the limit, only on start or while away, never live', () => {
    const cards = [
      session({ id: 'fresh', state: 'idle', stateSince: NOW - H }),
      session({ id: 'old', state: 'idle', stateSince: NOW - 2 * DAY }),
      session({ id: 'oldWorking', state: 'working', stateSince: NOW - 2 * DAY }),
      session({ id: 'oldAsk', state: 'needs_you', need: 'question', stateSince: NOW - 2 * DAY }),
    ];
    const saved: ZoneSlots = { columns: [['fresh', 'old'], ['oldWorking', 'oldAsk']], earlier: [] };
    expect(arrangeZone(saved, cards, ctx())).toBe(saved);
    const folded = { columns: [['fresh'], ['oldWorking', 'oldAsk']], earlier: ['old'] };
    expect(arrangeZone(saved, cards, ctx({ startup: true }))).toEqual(folded);
    expect(arrangeZone(saved, cards, ctx({ away: true }))).toEqual(folded);
    // The limit is the owner's: never, or a longer one, folds nothing.
    expect(arrangeZone(saved, cards, ctx({ away: true, foldAfterMs: null }))).toBe(saved);
    expect(arrangeZone(saved, cards, ctx({ away: true, foldAfterMs: 3 * DAY }))).toBe(saved);
    // The open chat's card never folds.
    expect(arrangeZone(saved, cards, ctx({ away: true, keep: new Set(['old']) }))).toBe(saved);
    expect(isAged(session({ id: 'u', state: 'unknown', stateSince: 0 }), NOW, DAY)).toBe(false);
  });

  it('a folded session that wakes leaves the fold at once, taking a free slot like a new card', () => {
    const saved: ZoneSlots = { columns: [['fresh']], earlier: ['old'] };
    const woke = [session({ id: 'fresh', stateSince: NOW }), session({ id: 'old', state: 'working', stateSince: NOW })];
    expect(arrangeZone(saved, woke, ctx())).toEqual({ columns: [['fresh'], ['old']], earlier: [] });
    // Still asleep: it stays folded, and nothing changes.
    const asleep = [session({ id: 'fresh', stateSince: NOW }), session({ id: 'old', stateSince: NOW - 2 * DAY })];
    expect(arrangeZone(saved, asleep, ctx())).toBe(saved);
    expect(shownSlots(saved, new Set(['fresh', 'old'])).earlier).toEqual(['old']);
  });
});

describe('card slots: Tidy, undo, auto-tidy and drag', () => {
  it('Tidy orders a zone by recent activity, row by row, folding the long idle; undo is the slots before', () => {
    const cards = [
      session({ id: 'a', stateSince: NOW - 4 }), session({ id: 'b', stateSince: NOW - 1 }),
      session({ id: 'c', stateSince: NOW - 3 }), session({ id: 'd', stateSince: NOW - 2 }),
      session({ id: 'z', stateSince: NOW - 3 * DAY }),
    ];
    const before: ZoneSlots = { columns: [['a', 'z', 'gone'], ['c', 'b'], ['d']], earlier: [] };
    const after = tidyZone(before, cards, { now: NOW, foldAfterMs: DAY });
    expect(after).toEqual({ columns: [['b', 'c'], ['d', 'a']], earlier: ['z'] });
    // Undo is putting the slots back: arranging them again keeps them as they were.
    expect(arrangeZone(before, cards, ctx())).toBe(before);
    // A card that arrived after the tidy is still placed after an undo.
    expect(arrangeZone(before, [...cards, session({ id: 'late' })], ctx()).columns).toEqual([['a', 'z', 'late'], ['c', 'b'], ['d']]);
  });

  it('auto-tidy applies only while away, and only when the owner turned it on', () => {
    const cards = [session({ id: 'a', stateSince: NOW - 9 }), session({ id: 'b', stateSince: NOW })];
    const saved: ZoneSlots = { columns: [['a'], ['b']], earlier: [] };
    expect(arrangeZone(saved, cards, ctx({ autoTidy: true }))).toBe(saved);
    expect(arrangeZone(saved, cards, ctx({ away: true }))).toBe(saved);
    expect(arrangeZone(saved, cards, ctx({ away: true, autoTidy: true }))).toEqual({ columns: [['b'], ['a']], earlier: [] });
  });

  it('a drag puts a card in the slot under the pointer, moving only its old and new columns', () => {
    const slots: ZoneSlots = { columns: [['a', 'b'], ['c', 'd'], ['e']], earlier: ['f'] };
    expect(moveCard(slots, 'a', 1, 'd')).toEqual({ columns: [['b'], ['c', 'a', 'd'], ['e']], earlier: ['f'] });
    expect(moveCard(slots, 'e', 0, null)).toEqual({ columns: [['a', 'b', 'e'], ['c', 'd']], earlier: ['f'] });
    expect(moveCard(slots, 'f', 3, null)).toEqual({ columns: [['a', 'b'], ['c', 'd'], ['e'], ['f']], earlier: [] });
    // A card from another zone joins where it is dropped.
    expect(moveCard(slots, 'x', 2, 'e').columns[2]).toEqual(['x', 'e']);
  });

  it('the zone flow keeps each card in its slot column around a board tile', () => {
    const items = [{ id: 'a', cardH: 82, col: 0 }, { id: 'b', cardH: 300, col: 0 }, { id: 'c', cardH: 82, col: 1 }, { id: 'd', cardH: 82, col: 0 }];
    const flow = flowCards(items, { col: 1, top: 0, width: 232, height: 200 });
    const cols = flow.columns.map((c) => c.flatMap((e) => ('id' in e ? [e.id] : [])));
    expect(cols).toEqual([['a', 'b', 'd'], ['c']]);
  });
});
