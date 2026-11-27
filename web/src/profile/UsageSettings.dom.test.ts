// @vitest-environment jsdom
// Settings → Usage: the headline, the table by source, the chart's bars and the period picker,
// over the demo's summary.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CanvasBridge } from '../../../shared/bridge.ts';
import { demoUsageSummary } from '../../../server/usage/demo.ts';
import { layoutChart, niceMax, segmentPath, tickLabel, CHART } from './usageChart.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse('2026-11-27T09:00:00.000Z');
const usage = vi.fn<CanvasBridge['usage']>(async (period) => demoUsageSummary(period, NOW, '/demo/agent'));
let UsageSettings: typeof import('./UsageSettings.tsx').UsageSettings;

beforeAll(async () => {
  (window as { canvas?: Partial<CanvasBridge> }).canvas = { usage };
  ({ UsageSettings } = await import('./UsageSettings.tsx'));
});

let host: HTMLElement | null = null;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });

async function mount(props: Parameters<typeof UsageSettings>[0] = {}) {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(UsageSettings, props)); });
  return host;
}

describe('UsageSettings', () => {
  it('leads with the overhead for the last 7 days, then the chart and the table by source', async () => {
    const el = await mount();
    expect(usage).toHaveBeenLastCalledWith('7d');
    expect(el.querySelector('.us-headline')!.textContent).toMatch(/^Agent canvas overhead: [\d.]+[KMB]? tokens \(≈ \$[\d.,]+ · [\d.]+% of all usage\) in the last 7 days$/);
    expect(el.querySelectorAll('.us-chart path.us-bar.is-overhead')).toHaveLength(7);
    const rows = [...el.querySelectorAll('.us-table tbody tr')].map(r => r.querySelector('th')!.textContent);
    expect(rows).toEqual([
      'Agent canvas overhead', 'Canvas agent/demo/agent · plan usage', 'Orchestrator · storefrontplan usage', 'Orchestrator · billing-apiplan usage',
      'Work sessions, for context', 'Claude sessions', 'Codex sessions',
    ].map(t => t.replace('/demo/agent', 'Claude login')));
    expect(el.querySelector('.us-table thead')!.textContent).toBe('SourceTurnsInputOutputCache readCache writeEst. cost% of total');
    expect(el.querySelector('.us-note')!.textContent).toContain('share of plan usage');
  });

  it('reads another period when one is picked, and leaves the chart out for today', async () => {
    const el = await mount();
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Usage period"]')!;
    await act(async () => {
      select.value = 'today';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(usage).toHaveBeenLastCalledWith('today');
    expect(el.querySelector('.us-headline')!.textContent).toMatch(/today$/);
    expect(el.querySelector('.us-chart')).toBeNull();
  });

  it('opens a costliest turn whose chat is a card, and only those', async () => {
    const opened: string[] = [];
    const el = await mount({ canOpen: (id) => id.startsWith('demo-orch'), onOpenChat: (id) => opened.push(id) });
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button.us-turn')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(el.querySelectorAll('.us-turn').length).toBe(5);
    await act(async () => { buttons[0]!.click(); });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^demo-orch/);
  });
});

describe('the usage chart', () => {
  const days = [{ day: '2026-11-25', overhead: 1, work: 9 }, { day: '2026-11-26', overhead: 0, work: 0 }, { day: '2026-11-27', overhead: 2, work: 0 }];

  it('stacks work on overhead from one baseline, a 2px gap between, bars at most 24px', () => {
    const c = layoutChart(days, 'day', 712);
    expect(c.max).toBe(10);
    const [a, b, d] = c.bars;
    expect(a!.width).toBe(24);
    expect(a!.overhead.y + a!.overhead.h).toBe(c.baseline);
    expect(a!.work.y + a!.work.h + CHART.gap).toBeCloseTo(a!.overhead.y);
    expect(b!.overhead.h + b!.work.h).toBe(0);
    // A lone segment touches nothing, so it keeps its whole height.
    expect(d!.work.h).toBe(0);
    expect(d!.overhead.h).toBeCloseTo((2 / 10) * (CHART.height - CHART.bottom - CHART.top));
    expect(c.bars.map(x => x.label)).toEqual(['Wed', 'Thu', 'Fri']);
  });

  it('labels a long run by date, about one label per 56px, always the last', () => {
    const month = Array.from({ length: 30 }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, overhead: 1, work: 1 }));
    const labels = layoutChart(month, 'day', 712).bars.map(b => b.label).filter(Boolean);
    expect(labels.at(-1)).toBe('30 Nov');
    const last = layoutChart(month, 'day', 712).bars.at(-1)!;
    expect(last).toMatchObject({ labelAnchor: 'end', labelX: last.x + last.width });
    expect(labels.length).toBeGreaterThan(5);
    expect(labels.length).toBeLessThan(15);
  });

  it('rounds the scale and its ticks', () => {
    expect([niceMax(0), niceMax(0.3), niceMax(7), niceMax(23), niceMax(2524)]).toEqual([1, 0.5, 10, 25, 5000]);
    expect([tickLabel(0), tickLabel(0.25), tickLabel(12.5), tickLabel(2500)]).toEqual(['$0', '$0.25', '$13', '$2.5K']);
  });

  it('rounds only the top of a bar', () => {
    expect(segmentPath(0, 10, 20, 30, false)).toBe('M0,40V10H20V40Z');
    expect(segmentPath(0, 10, 20, 30, true)).toBe('M0,40V14Q0,10 4,10H16Q20,10 20,14V40Z');
    expect(segmentPath(0, 10, 20, 0, true)).toBe('');
  });
});
