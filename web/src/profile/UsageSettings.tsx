// Settings → Usage: what working through Agent canvas costs. The tokens the canvas agent and the
// project orchestrators used (the overhead), beside the sessions doing the work, for a period: a
// headline, a stacked bar per day, the table by source and the costliest overhead turns. Costs are
// estimates at API prices (server/usage/pricing.ts).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  compact, percent, totalTokens, usd, USAGE_PERIODS,
  type UsageDay, type UsagePeriod, type UsageRow, type UsageSummary, type UsageTotals,
} from '../../../shared/usage.ts';
import { profileBridge } from '../bridge.ts';
import { Picker } from '../chat/Composer.tsx';
import { errorText } from '../preview/BrowserTab.tsx';
import { CHART, dayTitle, layoutChart, segmentPath } from './usageChart.ts';

export const PERIOD_LABEL: Record<UsagePeriod, string> = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };
const PERIOD_WORDS: Record<UsagePeriod, string> = { today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days', all: 'since the first chat on record' };
const periods = USAGE_PERIODS.map(id => ({ id, label: PERIOD_LABEL[id] }));
const BACKFILL_POLL_MS = 3000;

/** The period's summary, read again while the first scan of the transcripts is still running. */
export function useUsage(period: UsagePeriod) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      profileBridge.usage(period).then((s) => {
        if (!live) return;
        setSummary(s);
        setError(null);
        if (s.backfilling) timer = setTimeout(read, BACKFILL_POLL_MS);
      }, (err: unknown) => { if (live) setError(errorText(err)); });
    };
    read();
    return () => { live = false; clearTimeout(timer); };
  }, [period]);
  return { summary: summary?.period === period ? summary : null, stale: summary, error };
}

const BILLING: Record<UsageRow['billing'], string> = { plan: 'plan usage', api: 'API key, billed', mixed: 'plan and API key' };

function rowMeta(r: UsageRow): string | null {
  if (r.kind === 'work') return null;
  if (r.kind === 'orchestrator') return BILLING[r.billing];
  return r.detail ? `${r.detail} · ${BILLING[r.billing]}` : BILLING[r.billing];
}

function Cells({ t, share }: { t: UsageTotals; share: number }) {
  return (<>
    <td>{t.turns.toLocaleString('en-US')}</td>
    <td>{compact(t.input)}</td>
    <td>{compact(t.output)}</td>
    <td>{compact(t.cacheRead)}</td>
    <td>{compact(t.cacheWrite)}</td>
    <td>{usd(t.cost)}{t.unpriced > 0 && <span className="us-unpriced" title={`${compact(t.unpriced)} tokens of models without a price are not in the cost`}>*</span>}</td>
    <td>{percent(share)}</td>
  </>);
}

function UsageTable({ s }: { s: UsageSummary }) {
  const all = s.overhead.cost + s.work.cost;
  const groups = [
    { key: 'overhead', name: 'Agent canvas overhead', totals: s.overhead, rows: s.rows.filter(r => r.group === 'overhead') },
    { key: 'work', name: 'Work sessions, for context', totals: s.work, rows: s.rows.filter(r => r.group === 'work') },
  ] as const;
  return (
    <table className="us-table">
      <thead>
        <tr>
          <th scope="col">Source</th><th scope="col">Turns</th><th scope="col">Input</th><th scope="col">Output</th>
          <th scope="col">Cache read</th><th scope="col">Cache write</th><th scope="col">Est. cost</th><th scope="col">% of total</th>
        </tr>
      </thead>
      {groups.map(g => (
        <tbody key={g.key} className={`us-${g.key}`}>
          <tr className="us-group">
            <th scope="rowgroup"><i className={`us-key is-${g.key}`} aria-hidden="true" />{g.name}</th>
            <Cells t={g.totals} share={all > 0 ? g.totals.cost / all : 0} />
          </tr>
          {g.rows.length === 0 ? (
            <tr className="us-none"><th scope="row" colSpan={8}>{g.key === 'overhead' ? 'The canvas agent and orchestrators used nothing in this period.' : 'No work sessions in this period.'}</th></tr>
          ) : g.rows.map(r => (
            <tr key={r.id}>
              <th scope="row">
                <span className="us-name" title={r.kind === 'orchestrator' ? r.detail ?? undefined : undefined}>{r.label}</span>
                {rowMeta(r) && <span className="us-meta">{rowMeta(r)}</span>}
              </th>
              <Cells t={r} share={r.share} />
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

/** A stacked bar per day of estimated cost: overhead on the baseline, work above it. */
export function UsageChart({ days, unit }: { days: UsageDay[]; unit: 'day' | 'week' }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(712);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { if (e) setWidth(Math.round(e.contentRect.width)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const chart = layoutChart(days, unit, width);
  const pick = useCallback((e: PointerEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left - CHART.left;
    const i = Math.floor(x / chart.slot);
    setActive(i >= 0 && i < days.length ? i : null);
  }, [chart.slot, days.length]);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const last = days.length - 1;
    setActive(a => e.key === 'Home' ? 0 : e.key === 'End' ? last
      : a === null ? last : Math.max(0, Math.min(last, a + (e.key === 'ArrowLeft' ? -1 : 1))));
  };
  const day = active === null ? null : days[active];
  const bar = active === null ? null : chart.bars[active];
  const total = days.reduce((t, d) => t + d.overhead + d.work, 0);
  return (
    <div className="us-chart" ref={box} tabIndex={0} onKeyDown={key} onBlur={() => setActive(null)}
      onFocus={(e) => { if (e.target === e.currentTarget && e.currentTarget.matches(':focus-visible')) setActive(days.length - 1); }}
      role="group" aria-label={`Estimated cost per ${unit}: overhead and work. Arrow keys read each ${unit}; the table below has the totals.`}>
      <ul className="us-legend" aria-hidden="true">
        <li><i className="us-key is-overhead" />Overhead</li>
        <li><i className="us-key is-work" />Work</li>
      </ul>
      <svg width={width} height={CHART.height} onPointerMove={pick} onPointerLeave={() => setActive(null)} aria-hidden="true">
        {chart.ticks.map(t => (
          <g key={t.label} className="us-tick">
            <line x1={CHART.left} x2={width - CHART.right} y1={t.y} y2={t.y} />
            <text x={CHART.left - 8} y={t.y} dy="0.32em" textAnchor="end">{t.label}</text>
          </g>
        ))}
        {total > 0 && chart.bars.map((b, i) => (
          <g key={days[i]!.day} className={active !== null && active !== i ? 'is-dim' : undefined}>
            <path className="us-bar is-overhead" d={segmentPath(b.x, b.overhead.y, b.width, b.overhead.h, b.work.h === 0)} />
            <path className="us-bar is-work" d={segmentPath(b.x, b.work.y, b.width, b.work.h, true)} />
            {b.label && <text className="us-x" x={b.labelX} y={CHART.height - 4} textAnchor={b.labelAnchor}>{b.label}</text>}
          </g>
        ))}
      </svg>
      {total === 0 && <p className="us-empty">No priced usage in this period.</p>}
      {day && bar && (
        <div className="us-tip" role="status" style={{ left: Math.min(width - 150, Math.max(0, bar.x + bar.width / 2 - 75)) }}>
          <span className="us-tip-title">{dayTitle(day.day, unit)}</span>
          <span><i className="us-line is-overhead" /><b>{usd(day.overhead)}</b> overhead</span>
          <span><i className="us-line is-work" /><b>{usd(day.work)}</b> work</span>
        </div>
      )}
    </div>
  );
}

function TopTurns({ s, canOpen, onOpen }: { s: UsageSummary; canOpen(id: string): boolean; onOpen?(id: string): void }) {
  if (s.top.length === 0) return null;
  const when = (at: number) => new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="us-top-turns">
      <h4 className="ms-label">Costliest overhead turns</h4>
      <ul>
        {s.top.map(t => {
          const body = (<>
            <span className="us-name">{t.label}</span>
            <span className="us-meta">{when(t.at)}</span>
            <span className="us-num">{compact(t.tokens)} tokens</span>
            <span className="us-num">{usd(t.cost)}</span>
          </>);
          return (
            <li key={`${t.session}-${t.at}`}>
              {onOpen && canOpen(t.session)
                ? <button type="button" className="us-turn" onClick={() => onOpen(t.session)} title="Open this chat">{body}</button>
                : <span className="us-turn" title={t.kind === 'agent' ? 'A canvas agent conversation: open it from the agent panel' : undefined}>{body}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface UsageSettingsProps {
  /** Whether a chat is a card the page can open; the canvas agent's conversations are not. */
  canOpen?(sessionId: string): boolean;
  onOpenChat?(sessionId: string): void;
}

export function UsageSettings({ canOpen = () => false, onOpenChat }: UsageSettingsProps) {
  const [period, setPeriod] = useState<UsagePeriod>('7d');
  const { summary, stale, error } = useUsage(period);
  const s = summary ?? stale;
  return (
    <section className="pf-setting us" aria-labelledby="us-title" aria-busy={summary === null}>
      <div className="us-head">
        <h3 className="pf-setting-name" id="us-title">Usage</h3>
        <Picker label="Usage period" value={period} options={periods} disabled={false} push
          onChange={(id) => { if ((USAGE_PERIODS as readonly string[]).includes(id)) setPeriod(id as UsagePeriod); }} />
      </div>
      {error !== null && <p className="pf-error" role="alert">Could not read the usage: {error}</p>}
      {s === null ? (error === null && <p className="pf-quiet">Reading the transcripts…</p>) : (<>
        <p className="us-headline">
          Agent canvas overhead: <strong>{compact(totalTokens(s.overhead))} tokens</strong>{' '}
          (≈ {usd(s.overhead.cost)} · {percent(s.share)} of all usage) {PERIOD_WORDS[s.period]}
        </p>
        <p className="pf-quiet">
          The canvas agent and the project orchestrators, beside {usd(s.work.cost)} of work in Claude and Codex sessions.
          {s.backfilling && ' Still reading history from the transcripts, so the totals are growing.'}
        </p>
        {s.period !== 'today' && <UsageChart days={s.days} unit={s.dayUnit} />}
        <UsageTable s={s} />
        <TopTurns s={s} canOpen={canOpen} onOpen={onOpenChat} />
        <p className="pf-quiet us-note">
          Estimates from per-model API prices checked {s.pricesChecked}. On a Claude or ChatGPT subscription nothing is billed per token:
          read the cost as the share of plan usage those tokens take. Work counts every Claude Code and Codex session on this Mac.
        </p>
      </>)}
    </section>
  );
}
