// A JSON value as a foldable, coloured outline. The first two levels start open; a long object
// or array shows its first JSON_PAGE children and a "Show more".
import { useState } from 'react';
import { JSON_PAGE, kindOf, summary } from './json.ts';

function Scalar({ value }: { value: unknown }) {
  const kind = kindOf(value);
  const text = kind === 'string' ? JSON.stringify(value) : String(value);
  return <span className={`jv-${kind}`}>{text}</span>;
}

function Node({ name, value, depth, last }: { name: string | number | null; value: unknown; depth: number; last: boolean }) {
  const kind = kindOf(value);
  const container = kind === 'object' || kind === 'array';
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(JSON_PAGE);
  const label = name === null ? null : typeof name === 'number'
    ? <span className="jv-index">{name}</span>
    : <span className="jv-key">{JSON.stringify(name)}</span>;
  const comma = last ? null : <span className="jv-punct">,</span>;
  if (!container) {
    return <div className="jv-row" style={{ paddingLeft: depth * 14 + 16 }}>
      {label}{label && <span className="jv-punct">: </span>}<Scalar value={value} />{comma}
    </div>;
  }
  const entries: [string | number, unknown][] = kind === 'array'
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const [l, r] = kind === 'array' ? ['[', ']'] : ['{', '}'];
  const empty = entries.length === 0;
  return <>
    <div className="jv-row" style={{ paddingLeft: depth * 14 }}>
      <button type="button" className="jv-toggle" aria-expanded={empty ? undefined : open} disabled={empty}
        aria-label={`${open ? 'Fold' : 'Unfold'} ${name === null ? 'value' : String(name)}`}
        onClick={() => setOpen((o) => !o)}>
        <svg className="i" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="m3.5 2 3 3-3 3" /></svg>
      </button>
      {label}{label && <span className="jv-punct">: </span>}
      <span className="jv-punct">{l}</span>
      {(!open || empty) && <>
        {!empty && <button type="button" className="jv-fold" onClick={() => setOpen(true)}>{summary(value)}</button>}
        <span className="jv-punct">{r}</span>{comma}
      </>}
    </div>
    {open && !empty && <>
      {entries.slice(0, shown).map(([k, v], i) => (
        <Node key={k} name={k} value={v} depth={depth + 1} last={i === entries.length - 1} />
      ))}
      {entries.length > shown && (
        <div className="jv-row" style={{ paddingLeft: (depth + 1) * 14 + 16 }}>
          <button type="button" className="jv-more" onClick={() => setShown((n) => n + JSON_PAGE)}>
            Show {Math.min(JSON_PAGE, entries.length - shown)} more of {entries.length - shown}
          </button>
        </div>
      )}
      <div className="jv-row" style={{ paddingLeft: depth * 14 + 16 }}><span className="jv-punct">{r}</span>{comma}</div>
    </>}
  </>;
}

export function JsonView({ value }: { value: unknown }) {
  return <div className="jv" role="group" aria-label="JSON outline"><Node name={null} value={value} depth={0} last /></div>;
}
