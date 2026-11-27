import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatItem, Question } from '../../../shared/chat.ts';
import { optionLabel, QuestionCard, recommendedOf, shownAnswer, SKIPPED } from './QuestionCard.tsx';

type QuestionItem = Extract<ChatItem, { kind: 'question' }>;
const secret: Question = { id: 'token', header: 'Token', text: 'Paste the deploy token', options: [], multiSelect: false, allowOther: true, isSecret: true };
const plain: Question = { id: 'env', header: 'Env', text: 'Which environment?', options: [{ label: 'staging', description: '' }, { label: 'production', description: '' }], multiSelect: false, allowOther: false };
const item = (patch: Partial<QuestionItem> = {}): QuestionItem => ({
  kind: 'question', id: 'q1', at: 0, questions: [plain, secret], status: 'pending', answers: null, ...patch,
});
const render = (q: QuestionItem) => renderToStaticMarkup(createElement(QuestionCard, { item: q, onAnswer: async () => {} }));

describe('QuestionCard', () => {
  it('asks a secret question with a masked password field', () => {
    const out = render(item());
    expect(out).toMatch(/<input[^>]*type="password"/);
    expect(out).toMatch(/<input[^>]*type="password"[^>]*autoComplete="off"/);
  });

  it('never shows a secret answer in the thread, even if one comes back', () => {
    const out = render(item({ status: 'answered', answers: { env: 'staging', token: 'hunter2-secret' } }));
    expect(out).not.toContain('hunter2');
    expect(out).toContain('staging');
    expect(shownAnswer(secret, 'hunter2-secret')).toBe('Hidden');
    expect(shownAnswer(plain, 'staging')).toBe('staging');
  });

  it('offers the options of a plain question', () => {
    const out = render(item({ questions: [plain] }));
    expect(out).toContain('staging');
    expect(out).toContain('production');
    expect(out).not.toContain('type="password"');
  });

  it("marks the session's recommended option and offers it as one press", () => {
    const db: Question = { ...plain, id: 'db', options: [{ label: 'Postgres (Recommended)', description: 'Already in the stack' }, { label: 'SQLite', description: '' }] };
    expect(optionLabel('Postgres (Recommended)')).toEqual({ name: 'Postgres', recommended: true });
    expect(optionLabel('SQLite')).toEqual({ name: 'SQLite', recommended: false });
    expect(recommendedOf(db)).toBe('Postgres (Recommended)');
    const out = render(item({ questions: [db] }));
    expect(out).toMatch(/aria-checked="false"[^>]*>.*Postgres<em class="t-q-rec">Recommended<\/em>/);
    expect(out).toContain('>Use Postgres</span>');
    expect(out).not.toContain('(Recommended)');
    // No one-press answer when a question on the card has no recommendation.
    expect(render(item({ questions: [db, plain] }))).not.toContain('Use both recommendations');
    expect(render(item({ questions: [db, { ...db, id: 'db2' }] }))).toContain('>Use both recommendations</span>');
    expect(shownAnswer(db, 'Postgres (Recommended)')).toBe('Postgres');
  });

  it('asks several questions one at a time, with Next, Skip and a pager', () => {
    const out = render(item());
    expect(out).toContain('1 of 2');
    expect(out).toMatch(/<fieldset class="t-q">.*Which environment/);
    expect(out).toMatch(/<fieldset class="t-q" hidden="">.*Paste the deploy token/);
    expect(out).toContain('>Next<svg');
    expect(out).toContain('>Skip</button>');
    const one = render(item({ questions: [plain] }));
    expect(one).not.toContain('1 of 1');
    expect(one).toContain('>Answer</button>');
  });

  it('offers Other as the last option only where the question allows it', () => {
    expect(render(item({ questions: [plain] }))).not.toContain('>Other<');
    expect(render(item({ questions: [{ ...plain, allowOther: true }] }))).toMatch(/production.*>Other</);
  });

  it('sums up an answered card, a skipped question reading Skipped', () => {
    const out = render(item({ questions: [plain, { ...plain, id: 'region', header: 'Region' }], status: 'answered', answers: { env: 'staging', region: SKIPPED } }));
    expect(out).toContain('1/2 answered');
    expect(out).toContain('Skipped');
    expect(out).not.toContain(SKIPPED);
    expect(render(item({ questions: [plain], status: 'answered', answers: { env: 'staging' } }))).not.toContain('answered<');
  });

  it('shows an expired question without a way to answer', () => {
    const out = render(item({ status: 'expired' }));
    expect(out).toContain('Expired');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('<button');
  });
});
