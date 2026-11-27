import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../../shared/chat.ts';
import { ReasoningItem, reasoningLabel } from './items/ReasoningItem.tsx';

type Reasoning = Extract<ChatItem, { kind: 'reasoning' }>;
const item = (patch: Partial<Reasoning> = {}): Reasoning => ({
  kind: 'reasoning', id: 'r1', at: 0, text: 'Check the env file first.', streaming: false, durationMs: 6000, ...patch,
});

describe('reasoningLabel', () => {
  it('says Thinking… while it streams', () => {
    expect(reasoningLabel({ streaming: true, durationMs: null })).toBe('Thinking…');
  });

  it('gives seconds, rounded, at least one', () => {
    expect(reasoningLabel({ streaming: false, durationMs: 6000 })).toBe('Thought for 6s');
    expect(reasoningLabel({ streaming: false, durationMs: 6400 })).toBe('Thought for 6s');
    expect(reasoningLabel({ streaming: false, durationMs: 200 })).toBe('Thought for 1s');
  });

  it('gives minutes and seconds from a minute on', () => {
    expect(reasoningLabel({ streaming: false, durationMs: 60_000 })).toBe('Thought for 1m 0s');
    expect(reasoningLabel({ streaming: false, durationMs: 135_000 })).toBe('Thought for 2m 15s');
  });

  it('says only Thought when the duration is unknown', () => {
    expect(reasoningLabel({ streaming: false, durationMs: null })).toBe('Thought');
  });
});

describe('ReasoningItem', () => {
  const render = (r: Reasoning) => renderToStaticMarkup(createElement(ReasoningItem, { item: r }));

  it('starts as one closed line with its label, the text hidden', () => {
    const out = render(item());
    expect(out).toContain('class="t-thought"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('Thought for 6s');
    expect(out).not.toContain('Check the env file first.');
  });

  it('has nothing to open while the text is empty', () => {
    const out = render(item({ text: '', streaming: true, durationMs: null }));
    expect(out).toContain('Thinking…');
    expect(out).not.toContain('aria-expanded');
  });
});
