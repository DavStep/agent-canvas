import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { session } from '../testSession.ts';
import { Briefing } from './Briefing.tsx';

const sessions = [
  session({ id: 'a', name: 'Fix the login', state: 'needs_you', need: 'question' }),
  session({ id: 'b', name: 'Tidy the docs', state: 'working', rawStatus: 'busy' }),
];
const render = (connected: boolean) =>
  renderToStaticMarkup(createElement(Briefing, { sessions, now: 0, onSelect: () => {}, connected }));

describe('Briefing', () => {
  it('shows the reason and a button per waiting session while connected', () => {
    const html = render(true);
    expect(html).toContain('Question');
    expect(html).toContain('Fix the login');
    expect(html).not.toContain('Tidy the docs');
    expect(html).toContain('class="brief-tag"');
  });

  it('shows "Reconnecting…" in place of the sentence and the chips while disconnected', () => {
    const html = render(false);
    expect(html).toContain('>Reconnecting…</p>');
    expect(html).not.toContain('waiting on you');
    expect(html).not.toContain('brief-tag');
  });
});
