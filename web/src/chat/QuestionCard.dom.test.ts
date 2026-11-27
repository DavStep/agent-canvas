// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatItem, Question } from '../../../shared/chat.ts';
import { QuestionCard, SKIPPED } from './QuestionCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type QuestionItem = Extract<ChatItem, { kind: 'question' }>;
const db: Question = { id: 'db', header: 'Storage', text: 'Where?', multiSelect: false, allowOther: true,
  options: [{ label: 'Postgres (Recommended)', description: '' }, { label: 'SQLite', description: '' }] };
const scope: Question = { id: 'scope', header: 'Scope', text: 'Which zones?', multiSelect: true, allowOther: true,
  options: [{ label: 'All', description: '' }, { label: 'Open', description: '' }] };

let host: HTMLElement | null = null;
afterEach(() => { host?.remove(); host = null; });

function mount(questions: Question[]) {
  const sent: Record<string, string>[] = [];
  const item: QuestionItem = { kind: 'question', id: 'q', at: 0, questions, status: 'pending', answers: null };
  host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  act(() => root.render(createElement(QuestionCard, { item, onAnswer: async (a) => { sent.push(a); } })));
  const el = host;
  const button = (name: string) => [...el.querySelectorAll<HTMLButtonElement>('fieldset:not([hidden]) button, .t-ask-actions button, .t-q-pager button')]
    .find((b) => (b.hasAttribute('aria-label') ? b.getAttribute('aria-label') === name : (b.textContent ?? '').trim().startsWith(name)))!;
  const click = async (name: string) => { await act(async () => { button(name).click(); }); };
  const type = async (text: string) => {
    const input = el.querySelector<HTMLInputElement>('fieldset:not([hidden]) input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  return { el, sent, button, click, type };
}

describe('QuestionCard, in use', () => {
  it('answers with the recommended option in one press, the full label sent back', async () => {
    const c = mount([db]);
    await c.click('Use Postgres');
    expect(c.sent).toEqual([{ db: 'Postgres (Recommended)' }]);
  });

  it('Skip on a single question answers that it was skipped', async () => {
    const c = mount([db]);
    await c.click('Skip');
    expect(c.sent).toEqual([{ db: SKIPPED }]);
  });

  it('Other opens a field whose text is the answer', async () => {
    const c = mount([db]);
    expect(c.button('Answer').disabled).toBe(true);
    await c.click('Other');
    expect(c.button('Answer').disabled).toBe(true);
    await c.type('Redis');
    await c.click('Answer');
    expect(c.sent).toEqual([{ db: 'Redis' }]);
  });

  it('walks several questions a page at a time: pick, Next, then Skip on the last sends both', async () => {
    const c = mount([db, scope]);
    expect(c.button('Next').disabled).toBe(true);
    await c.click('SQLite');
    expect(c.el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('SQLite');
    await c.click('Next');
    expect(c.el.querySelector('.t-q-pager')!.textContent).toContain('2 of 2');
    await c.click('Skip');
    expect(c.sent).toEqual([{ db: 'SQLite', scope: SKIPPED }]);
  });

  it('skipping the first question moves on; the last one answers with several picks and Other', async () => {
    const c = mount([db, scope]);
    await c.click('Skip');
    await c.click('All');
    await c.click('Open');
    await c.click('Other');
    await c.type('Pinned');
    await c.click('Answer');
    expect(c.sent).toEqual([{ db: SKIPPED, scope: 'All, Open, Pinned' }]);
  });

  it('going back to a skipped question and answering it replaces the skip', async () => {
    const c = mount([db, scope]);
    await c.click('Skip');
    await c.click('Previous question');
    await c.click('SQLite');
    await c.click('Next');
    await c.click('All');
    await c.click('Answer');
    expect(c.sent).toEqual([{ db: 'SQLite', scope: 'All' }]);
  });
});
