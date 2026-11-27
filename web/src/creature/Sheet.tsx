// Dev-only contact sheet (/?sheet=1) for provider icons at each size and state.
import { Fragment } from 'react';
import type { CreatureState, Provider } from './generate.ts';
import { Creature, type CreatureSize } from './Creature.tsx';

const STATES: CreatureState[] = ['working', 'needs_you', 'idle', 'unknown', 'done'];
const PROVIDERS: Provider[] = ['claude', 'codex'];
const SIZES: CreatureSize[] = [20, 40, 72];
const CSS = `
.sheet { height: 100%; overflow: auto; padding: 24px; display: flex; flex-direction: column; gap: 32px; }
.sheet h2 { font-size: 13px; font-weight: 500; color: var(--muted); margin-bottom: 12px; }
.sheet .bob, .sheet .blink { animation-play-state: paused; }
.sheet-grid { display: grid; gap: 12px 16px; align-items: end; justify-items: start; padding: 16px; border-radius: var(--radius-card);
  background: var(--panel); border: 1px solid var(--card-border); width: max-content; }
.sheet-grid > span { font: 400 11px/16px var(--font-mono); color: var(--muted); align-self: center; }
.sheet-zone { display: flex; flex-wrap: wrap; gap: 12px; padding: 16px; border-radius: var(--radius-card); width: max-content;
  background: var(--surface); box-shadow: inset 0 0 0 1px var(--card-border); }
.sheet-card { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; width: 150px; padding: 12px; border-radius: var(--radius-card);
  background: var(--panel); border: 1px solid var(--card-border); font-size: 12px; color: var(--muted); }
.sheet-card.is-idle { background: var(--idle-fill); }
.sheet-card.is-needs { background: var(--needs-fill); border-color: var(--needs-edge); }
`;

const IDS = ['demo-reconnect', 'demo-hostly', 'demo-purchases', 'demo-preview', 'demo-codex', 'demo-dbviz', 'demo-mcp', 'demo-3d'];

export function Sheet() {
  return (
    <div className="sheet">
      <style>{CSS}</style>

      <section id="zone">
        <h2>One zone, mixed providers, as cards</h2>
        <div className="sheet-zone">
          {IDS.map((id, i) => {
            const state = STATES[i % 3]!;
            const provider: Provider = i % 3 === 1 ? 'codex' : 'claude';
            return (
              <div key={id} className={`sheet-card${state === 'idle' ? ' is-idle' : state === 'needs_you' ? ' is-needs' : ''}`}>
                <span>{id.slice(5)}</span>
                <Creature provider={provider} state={state} size={40} />
              </div>
            );
          })}
        </div>
      </section>

      <section id="states">
        <h2>Every state at 20, 40 and 72 px</h2>
        <div className="sheet-grid" style={{ gridTemplateColumns: `auto repeat(${STATES.length * SIZES.length}, auto)` }}>
          <span />
          {SIZES.map((size) => STATES.map((state) => <span key={`${size}-${state}`}>{size} {state}</span>))}
          {PROVIDERS.map((provider) => (
            <Fragment key={provider}>
              <span>{provider}</span>
              {SIZES.map((size) => STATES.map((state) => (
                <Creature key={`${size}-${state}`} provider={provider} state={state} size={size} />
              )))}
            </Fragment>
          ))}
        </div>
      </section>
    </div>
  );
}
