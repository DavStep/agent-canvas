// The page's side of card slots (cardSlots.ts): every drawn zone's slots worked out from the
// saved ones and the cards here now, saved back with a setSlots op whenever they change (a new
// card placed, a layout from before slots frozen), and the owner's Tidy and drag. Whether the
// owner is away (the window unfocused or hidden for a while) decides what may move by itself.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Layout, LayoutOp, SessionView, ZoneLayout } from '../../../shared/types.ts';
import { sameSlots, type ZoneSlots } from '../../../shared/cardSlots.ts';
import { estimateCard } from '../components/Zone.tsx';
import { arrangeZone, moveCard, shownSlots, tidyZone } from './cardSlots.ts';
import { useSlotSettings } from './slotSettings.ts';

/** Unfocused or hidden this long counts as away. */
export const AWAY_MS = 2 * 60_000;
const HOUR = 3_600_000;

/** Whether the owner is looking: the window shown and focused. */
const looking = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

/** True once the window has been unfocused or hidden for `ms`; false again as soon as it is back. */
export function useAway(ms = AWAY_MS): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      if (looking()) setAway(false);
      else timer = setTimeout(() => setAway(!looking()), ms);
    };
    check();
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [ms]);
  return away;
}

export interface CardTidy { zoneId: string; before: ZoneSlots; after: ZoneSlots }

export interface CardSlotsArgs {
  groups: { zone: ZoneLayout; cards: SessionView[] }[];
  layout: Layout | null;
  send(op: LayoutOp): Promise<void>;
  now: number;
  /** Cards the board needs to show, including open threads’ source chats. */
  keep: ReadonlySet<string>;
}

export interface CardSlots {
  /** What a zone draws: its columns of cards and its folded cards (undefined: no slots yet). */
  shown(zoneId: string): ZoneSlots | undefined;
  /** Tidy a zone by recent activity; the tidy, for an undo, or null when nothing moved. */
  tidy(zoneId: string): CardTidy | null;
  /** Put the tidied zone back as it was. */
  undo(t: CardTidy): void;
  /** A card dragged within its zone (or into another) to column `col`, before card `before`. */
  move(zoneId: string, id: string, col: number, before: string | null): void;
}

export function useCardSlots({ groups, layout, send, now, keep }: CardSlotsArgs): CardSlots {
  const settings = useSlotSettings();
  const away = useAway();
  // Zones arranged since the app started: their first arrangement may fold idle cards.
  const started = useRef(new Set<string>());
  // What was last sent per zone, so a refused op is not sent again on every render.
  const sent = useRef(new Map<string, string>());
  const foldAfterMs = settings.foldAfterHours === null ? null : settings.foldAfterHours * HOUR;
  const saved = layout?.slots;
  const arranged = useMemo(() => {
    const out = new Map<string, ZoneSlots>();
    for (const { zone, cards } of groups) {
      const mine = saved?.[zone.id];
      if (mine === undefined && cards.length === 0) continue;
      out.set(zone.id, arrangeZone(mine, cards, {
        now, foldAfterMs, away, startup: !started.current.has(zone.id),
        autoTidy: settings.autoTidy, keep, heightOf: estimateCard,
      }));
    }
    return out;
  }, [groups, saved, now, foldAfterMs, away, settings.autoTidy, keep]);

  useEffect(() => {
    for (const [zoneId, slots] of arranged) {
      started.current.add(zoneId);
      if (sameSlots(saved?.[zoneId], slots)) { sent.current.delete(zoneId); continue; }
      const text = JSON.stringify(slots);
      if (sent.current.get(zoneId) === text) continue;
      sent.current.set(zoneId, text);
      send({ type: 'setSlots', zoneId, slots }).catch(() => {});
    }
  }, [arranged]);

  const cardsOf = useMemo(() => new Map(groups.map((g) => [g.zone.id, g.cards])), [groups]);
  const latest = useRef({ arranged, cardsOf, now, foldAfterMs, keep });
  latest.current = { arranged, cardsOf, now, foldAfterMs, keep };

  const shown = useCallback((zoneId: string) => {
    const slots = arranged.get(zoneId);
    if (!slots) return undefined;
    return shownSlots(slots, new Set((cardsOf.get(zoneId) ?? []).map((s) => s.id)));
  }, [arranged, cardsOf]);

  const tidy = useCallback((zoneId: string): CardTidy | null => {
    const { arranged: all, cardsOf: cards, now: at, foldAfterMs: fold, keep: open } = latest.current;
    const before = all.get(zoneId);
    if (!before) return null;
    const after = tidyZone(before, cards.get(zoneId) ?? [], { now: at, foldAfterMs: fold, keep: open });
    if (sameSlots(before, after)) return null;
    send({ type: 'setSlots', zoneId, slots: after }).catch(() => {});
    return { zoneId, before, after };
  }, [send]);

  const undo = useCallback((t: CardTidy) => {
    send({ type: 'setSlots', zoneId: t.zoneId, slots: t.before }).catch(() => {});
  }, [send]);

  const move = useCallback((zoneId: string, id: string, col: number, before: string | null) => {
    const slots = latest.current.arranged.get(zoneId) ?? { columns: [], earlier: [] };
    const next = moveCard(slots, id, col, before);
    if (!sameSlots(slots, next)) send({ type: 'setSlots', zoneId, slots: next }).catch(() => {});
  }, [send]);

  return { shown, tidy, undo, move };
}
