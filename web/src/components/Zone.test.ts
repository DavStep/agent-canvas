import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ZoneLayout } from '../../../shared/types.ts';
import { session } from '../testSession.ts';
import { Zone } from './Zone.tsx';

const zone: ZoneLayout = { id: 'z', name: 'Zone', kind: 'custom', folder: null, x: null, y: null, hueIndex: 0 };
const render = (at: { x: number; y: number } | null) => renderToStaticMarkup(createElement(Zone, {
  zone, sessions: [session({ id: 'a' })], at, selectedId: null, now: 0, onSelect: () => {},
}));
const classOf = (html: string) => html.match(/<section class="([^"]*)"/)?.[1]?.split(' ') ?? [];

/** The declarations of every top-level app.css rule whose selector list includes `selector`. */
function rule(selector: string): string {
  const css = readFileSync(path.resolve(import.meta.dirname, '../app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return css.split('}').map((chunk) => chunk.split('{'))
    .filter((parts) => parts.length === 2 && parts[0]!.split(',').some((s) => s.trim() === selector))
    .map((parts) => parts[1]).join(';');
}

describe('Zone placement', () => {
  it('waits hidden at the origin until placed', () => {
    expect(classOf(render(null))).toContain('is-unplaced');
    expect(render(null)).toContain('translate:0px 0px');
  });

  it('draws a zone placed from the start at its position, without the placing flag', () => {
    const cls = classOf(render({ x: 40, y: 80 }));
    expect(cls).not.toContain('is-unplaced');
    expect(cls).not.toContain('is-placing');
    expect(render({ x: 40, y: 80 })).toContain('translate:40px 80px');
  });

  it('does not glide in from the origin: no transition while unplaced or on the first placed frame', () => {
    expect(rule('.zone.is-unplaced')).toMatch(/transition:\s*none/);
    expect(rule('.zone.is-placing')).toMatch(/transition:\s*none/);
  });
});

describe('Zone cards', () => {
  it('pins the coordinator once above the workers and preserves its approval state', () => {
    const sessions = [session({ id: 'worker' }), session({ id: 'coordinator', state: 'needs_you', need: 'permission' })];
    const html = renderToStaticMarkup(createElement(Zone, { zone, sessions, projectChatId: 'coordinator',
      hasProjectChat: true, onSelect: () => {}, selectedId: 'coordinator', now: 0, at: null }));
    expect(html).toContain('Project orchestrator');
    expect(html).toContain('Approval requested');
    expect(html).toMatch(/<div class="cards"><div class="col"><article class="card is-needs project-chat-card is-selected"/);
    expect(html.match(/data-card-id="coordinator"/g)).toHaveLength(1);
    expect(html.indexOf('data-card-id="coordinator"')).toBeLessThan(html.indexOf('data-card-id="worker"'));
  });

  it('sit straight in their columns, with no wrapper that could take a lead', () => {
    const sessions = [
      session({ id: 'a', state: 'working', rawStatus: 'busy', activity: 'Running tests' }),
      session({ id: 'b', state: 'needs_you', need: 'permission', rawStatus: 'waiting', activity: 'Wants to run: npm run migrate' }),
    ];
    const html = renderToStaticMarkup(createElement(Zone, { zone, sessions, at: { x: 0, y: 0 }, selectedId: null, now: 0, onSelect: () => {} }));
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toMatch(/padding-top/);
    expect(html).toMatch(/<div class="col"><article/);
  });
});

describe('Zone Files button', () => {
  const render = (props: { onExplore?(): void; exploring?: boolean }) => renderToStaticMarkup(createElement(Zone, {
    zone, sessions: [], at: { x: 0, y: 0 }, selectedId: null, now: 0, onSelect: () => {}, ...props,
  }));

  it('shows only for a zone with a folder, named for it, and pressed while its explorer is open', () => {
    expect(render({})).not.toContain('zone-files');
    const closed = render({ onExplore: () => {} });
    expect(closed).toMatch(/<button type="button" class="zone-files" aria-pressed="false" aria-label="Files in Zone"/);
    expect(render({ onExplore: () => {}, exploring: true })).toContain('aria-pressed="true"');
  });
});
