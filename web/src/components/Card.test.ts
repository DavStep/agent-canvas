import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionView } from '../../../shared/types.ts';
import { session } from '../testSession.ts';
import { Card, hasActivity, StateLine } from './Card.tsx';

const render = (s: SessionView) => renderToStaticMarkup(createElement(Card, {
  session: s, selected: false, now: 0, onSelect: () => {},
}));

const working = (patch: Partial<SessionView> = {}) =>
  session({ id: 'w', state: 'working', rawStatus: 'busy', activity: 'Editing app.ts', ...patch });

describe('Card provider', () => {
  it('uses the creature to identify the provider', () => {
    const claude = render(session({ id: '1', name: 'Same title' }));
    const codex = render(session({ id: 'codex:1', provider: 'codex', name: 'Same title' }));
    expect(claude).toMatch(/data-provider="claude"[^>]+aria-label="Claude Code"/);
    expect(codex).toMatch(/data-provider="codex"[^>]+aria-label="Codex"/);
  });
});

describe('Card subagents', () => {
  it('labels each subagent with its description and keeps the type as the tooltip', () => {
    const html = render(working({ subagents: [{ id: 's1', type: 'schema-explorer', description: 'Map the database schema', state: 'working' }] }));
    expect(html).toContain('<span class="sub-name" title="schema-explorer">Map the database schema</span>');
  });

  it('falls back to the type when the description is empty', () => {
    const html = render(working({ subagents: [{ id: 's1', type: 'Explore', description: '  ', state: 'done' }] }));
    expect(html).toContain('<span class="sub-name" title="Explore">Explore</span>');
  });
});

describe('Card activity line', () => {
  it('has none for the generic "Working" line', () => {
    expect(hasActivity(working({ activity: 'Working' }))).toBe(false);
    expect(render(working({ activity: 'Working' }))).not.toContain('is-current');
  });

  it('has one for any other working line, and for needs you', () => {
    expect(hasActivity(working({ activity: 'Thinking' }))).toBe(true);
    expect(hasActivity(session({ id: 'n', state: 'needs_you', need: 'reply', activity: 'Finished' }))).toBe(true);
  });

  it('floats nothing over the canvas: no tooltip, whatever the state', () => {
    for (const s of [working(), session({ id: 'n', state: 'needs_you', need: 'reply', activity: 'Finished', lastAnswer: 'Done' })]) {
      const html = render(s);
      expect(html).not.toContain('role="tooltip"');
      expect(html).not.toContain('aria-describedby=');
    }
  });

  it('shows a finished session\'s reply as plain text, and says "Done" in green, not amber', () => {
    const html = render(session({
      id: 'n', state: 'needs_you', need: 'reply', activity: 'Finished',
      lastAnswer: 'Pushed to [DavStep/agent-canvas](https://github.com/DavStep/agent-canvas) as `f673eee`.',
    }));
    expect(html).toContain('Done');
    expect(html).not.toContain('Your turn');
    expect(html).toMatch(/class="card is-done/);
    expect(html).not.toContain('is-needs');
    expect(html).toContain('Pushed to DavStep/agent-canvas as f673eee.');
    expect(html).not.toContain('](https://');
  });

  it('names an MCP tool step without its server prefix', () => {
    const html = render(working({ recentSteps: [{ kind: 'tool', label: 'mcp__ccd_turn__update_plan', status: 'done', durationMs: 10 }] }));
    expect(html).toContain('<span>update plan</span>');
  });
});

describe('Card dot', () => {
  it('is gone: no card wears a dot, whatever its state', () => {
    for (const s of [
      working(), working({ activity: 'Working' }),
      session({ id: 'n', state: 'needs_you', need: 'question', activity: null }),
      session({ id: 'p', state: 'needs_you', need: 'permission', activity: 'Wants to run: ls' }),
      session({ id: 'i', state: 'idle' }), session({ id: 'u', state: 'unknown', rawStatus: 'x' }),
    ]) {
      expect(render(s)).not.toContain('card-dot');
    }
  });
});

describe('Unknown cards', () => {
  const unknown = session({ id: 'u', state: 'unknown', rawStatus: 'compacting' });

  it('show the raw status next to "Unknown"', () => {
    const html = render(unknown);
    expect(html).toMatch(/<span class="chip">Unknown<\/span><span class="chip raw"[^>]*>compacting<\/span>/);
  });

  it('show it in the state line too (the detail panel)', () => {
    expect(renderToStaticMarkup(createElement(StateLine, { session: unknown }))).toContain('>compacting</span>');
  });

  it('show no second chip when the raw status is empty, and idle cards never do', () => {
    expect(render(session({ id: 'u', state: 'unknown', rawStatus: '' }))).not.toContain('chip raw');
    expect(render(session({ id: 'i', state: 'idle', rawStatus: 'idle' }))).not.toContain('chip raw');
  });
});

/** The text of every top-level app.css block whose selector list includes `selector` (media blocks included whole). */
function cssBlocks(selector: string): string[] {
  const css = readFileSync(path.resolve(import.meta.dirname, '../app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return css.split('}').map((chunk) => chunk.split('{'))
    .filter((parts) => parts.length >= 2 && parts.at(-2)!.split(',').some((s) => s.trim() === selector))
    .map((parts) => parts.at(-1)!);
}

describe('live dot pulse', () => {
  const css = readFileSync(path.resolve(import.meta.dirname, '../app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('animates a pseudo-element by transform and opacity, never box-shadow', () => {
    expect(cssBlocks('.live').join(';')).not.toMatch(/animation/);
    expect(cssBlocks('.live::after').join(';')).toMatch(/animation:\s*live\b/);
    const keyframes = css.match(/@keyframes live\s*\{([\s\S]*?\}\s*)\}/)?.[1] ?? '';
    expect(keyframes).toMatch(/transform/);
    expect(keyframes).toMatch(/opacity/);
    expect(keyframes).not.toMatch(/box-shadow/);
  });

  it('is invisible when not animated, and stops under reduced motion and while disconnected', () => {
    expect(cssBlocks('.live::after').join(';')).toMatch(/opacity:\s*0/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.live::after[^{]*\{[^}]*animation:\s*none/);
    expect(cssBlocks('.app.is-stale .live::after').join(';')).toMatch(/animation:\s*none/);
  });
});
