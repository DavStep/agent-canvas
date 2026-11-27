// The canvas agent's orb (the briefing's dot-matrix planet, here showing the agent's state) and
// the round button on the canvas that carries it. The state is in the button's name and badge
// too: colour and motion only repeat it.
import type { OrbKind, OrbState } from './agent.ts';

export function AgentOrb({ kind, size }: { kind: OrbKind; size: number }) {
  return (
    <span className={`agent-orb is-${kind}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="agent-globe" />
    </span>
  );
}

export interface AgentButtonProps {
  orb: OrbState;
  /** The agent's panel is open. */
  open: boolean;
  /** Opens the panel, or closes it when open. `keyboard`: pressed with a key, not the pointer. */
  onToggle(keyboard: boolean): void;
}

/** The orb as the canvas's own control, pinned to the workspace's bottom-left corner (it stays put
    while the board pans and zooms). A waiting state adds a badge, "!" for needs you and a tick for
    replied, so it reads without colour; at work the orb's ring breathes. */
export function AgentButton({ orb, open, onToggle }: AgentButtonProps) {
  return (
    <button
      type="button"
      className={`canvas-corner-button agent-btn is-${orb.kind}${open ? ' is-open' : ''}`}
      data-testid="agent-orb"
      data-state={orb.kind}
      aria-label={orb.name}
      aria-expanded={open}
      aria-keyshortcuts="Meta+J"
      title={`${orb.name} (⌘J)`}
      onClick={(e) => onToggle(e.detail === 0)}
    >
      <AgentOrb kind={orb.kind} size={30} />
      {(orb.kind === 'needs' || orb.kind === 'done') && (
        <span className="agent-badge" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 12 12">
            <path d={orb.kind === 'needs' ? 'M6 2v5M6 9.6v.4' : 'M2.5 6.5 5 9l4.5-5.5'} />
          </svg>
        </span>
      )}
    </button>
  );
}
