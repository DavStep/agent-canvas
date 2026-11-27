// Settings → Usage's chart as numbers: a stacked bar per day (or week) of estimated cost, overhead
// on the baseline and work above it, with a clean y scale and the x labels that fit.
import type { UsageDay } from '../../../shared/usage.ts';

export const CHART = { height: 132, left: 44, right: 4, top: 8, bottom: 20, maxBar: 24, gap: 2, radius: 4 } as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** YYYY-MM-DD as a local date. */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/** "Thu 26 Nov", or "Week of 23 Nov". */
export function dayTitle(day: string, unit: 'day' | 'week'): string {
  const d = parseDay(day);
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return unit === 'week' ? `Week of ${date}` : `${WEEKDAYS[d.getDay()]} ${date}`;
}

/** A round top for the y axis: 1, 2 or 5 times a power of ten, at or above `max`. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

export const tickLabel = (v: number): string =>
  v === 0 ? '$0' : v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K` : v < 1 ? `$${v.toFixed(2).replace(/0$/, '')}` : `$${Math.round(v)}`;

export interface Bar {
  x: number; width: number;
  /** Overhead's segment on the baseline, and work's above it, after the surface gap. */
  overhead: { y: number; h: number };
  work: { y: number; h: number };
  label: string | null;
  /** Where the label hangs from: the bar's middle, or (the last one, near the edge) its right end. */
  labelX: number;
  labelAnchor: 'middle' | 'end';
}

export interface ChartLayout { width: number; max: number; ticks: { y: number; label: string }[]; bars: Bar[]; slot: number; baseline: number }

export function layoutChart(days: UsageDay[], unit: 'day' | 'week', width: number): ChartLayout {
  const { height, left, right, top, bottom, maxBar, gap } = CHART;
  const plotW = Math.max(1, width - left - right);
  const baseline = height - bottom;
  const plotH = baseline - top;
  const max = niceMax(Math.max(0, ...days.map(d => d.overhead + d.work)));
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(maxBar, slot * 0.62));
  // About one label per 56px, always the last; a week's or a long run's by date.
  const every = Math.max(1, Math.ceil(56 / slot));
  const scale = (v: number) => (v / max) * plotH;
  const bars = days.map((d, i): Bar => {
    const oh = scale(d.overhead);
    const wh = scale(d.work);
    const oy = baseline - oh;
    // The gap shows only between two segments that are both there.
    const sep = oh > 0 && wh > 0 ? gap : 0;
    const date = parseDay(d.day);
    const show = (days.length - 1 - i) % every === 0;
    const label = !show ? null : unit === 'day' && days.length <= 8 ? WEEKDAYS[date.getDay()]! : `${date.getDate()} ${MONTHS[date.getMonth()]}`;
    const x = left + slot * i + (slot - barW) / 2;
    // A date label is about 40px wide: the last one ends at its bar rather than past the chart.
    const nearEdge = label !== null && x + barW / 2 + 20 > width;
    return {
      x, width: barW, labelX: nearEdge ? x + barW : x + barW / 2, labelAnchor: nearEdge ? 'end' : 'middle',
      overhead: { y: oy, h: oh },
      work: { y: oy - sep - Math.max(0, wh - sep), h: Math.max(0, wh - sep) },
      label,
    };
  });
  const ticks = [0, max / 2, max].map(v => ({ y: baseline - scale(v), label: tickLabel(v) }));
  return { width, max, ticks, bars, slot, baseline };
}

/** A bar segment: square at the bottom, its top corners rounded when it ends the bar. */
export function segmentPath(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  if (h <= 0) return '';
  const r = roundTop ? Math.min(CHART.radius, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`;
}
