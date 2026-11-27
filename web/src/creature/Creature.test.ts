import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Creature, type CreatureProps } from './Creature.tsx';

const render = (props: Partial<CreatureProps>) =>
  renderToStaticMarkup(createElement(Creature, { provider: 'claude', state: 'working', size: 40, ...props }));

describe('Creature', () => {
  it('uses each provider’s portrait and motion assets at every size', () => {
    for (const [provider, portrait] of [['codex', 'sebastian-violet'], ['claude', 'claude-dot'], ['orchestrator', 'orchestrator']] as const) {
      for (const size of [20, 40, 72] as const) {
        const working = render({ provider, size, state: 'working' });
        expect(working).toContain(`${portrait}-typing.png`);
        expect(working).toContain('class="cr-gaze"');
        expect(render({ provider, size, state: 'done' })).toContain(`${portrait}.png`);
      }
      for (const state of ['idle', 'unknown'] as const) {
        expect(render({ provider, state })).toContain('is-quiet');
      }
    }
  });

  it('names its provider for screen readers', () => {
    expect(render({ provider: 'claude' })).toContain('aria-label="Claude Code"');
    expect(render({ provider: 'codex' })).toContain('aria-label="Codex"');
  });

  it('adds an amber attention dot only while waiting', () => {
    expect(render({ state: 'needs_you' })).toContain('class="cr-attention"');
    for (const state of ['working', 'idle', 'unknown', 'done'] as const) {
      expect(render({ state })).not.toContain('class="cr-attention"');
    }
  });
});
