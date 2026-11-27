import { memo, useEffect, useRef } from 'react';
import type { CreatureState, PortraitKind } from './generate.ts';
import { watchPortrait } from './livePortrait.ts';
import coral from './claude-dot.png';
import coralWorking from './claude-dot-typing.png';
import violet from './sebastian-violet.png';
import violetWorking from './sebastian-violet-typing.png';

import azure from './orchestrator.png';
import azureWorking from './orchestrator-typing.png';

export type CreatureSize = 20 | 24 | 40 | 72;

export interface CreatureProps {
  provider: PortraitKind;
  state: CreatureState;
  size: CreatureSize;
  /** 'agent': a configured ACP agent with the generic icon; the portrait is tinted. */
  variant?: 'agent';
  /** The accessible name, when it isn't the provider's (an ACP agent's name). */
  label?: string;
}

const PORTRAITS = {
  claude: { label: 'Claude Code', still: coral, working: coralWorking },
  codex: { label: 'Codex', still: violet, working: violetWorking },
  orchestrator: { label: 'Project orchestrator', still: azure, working: azureWorking },
};

export const Creature = memo(function Creature({ provider, state, size, variant, label }: CreatureProps) {
  const icon = useRef<HTMLSpanElement>(null);
  const working = state === 'working';
  const quiet = state === 'idle' || state === 'unknown';
  const portrait = PORTRAITS[provider];
  useEffect(() => {
    if (icon.current && typeof matchMedia === 'function') return watchPortrait(icon.current);
  }, []);
  return (
    <span ref={icon} className={`cr cr-${size}${quiet ? ' is-quiet' : ''}`} style={{ width: size, height: size }}
      data-provider={provider} data-variant={variant} data-state={state} role="img" aria-label={label ?? portrait.label}>
      <img className="cr-still" src={working ? portrait.working : portrait.still} alt="" draggable={false} />
      <span className="cr-gaze" aria-hidden="true" />
      <svg className="cr-question" viewBox="0 0 12 17" aria-hidden="true" focusable="false">
        <path d="M2 5a4 4 0 0 1 8 0c0 3-4 3.3-4 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="6" cy="15" r="1.35" fill="currentColor" />
      </svg>
      {state === 'needs_you' && <i className="cr-attention" />}
    </span>
  );
});
