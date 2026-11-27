import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../../shared/chat.ts';
import { ApprovalCard, approvalKey } from './ApprovalCard.tsx';

type Approval = Extract<ChatItem, { kind: 'approval' }>;
const approval = (patch: Partial<Approval> = {}): Approval => ({
  kind: 'approval', id: 'p1', at: 0, toolItemId: null, title: 'Allow this command?', detail: 'npm test',
  alwaysLabel: null, status: 'pending', ...patch,
});

const keyOn = (key: string, patch: Partial<Parameters<typeof approvalKey>[0]> = {}) =>
  approvalKey({ key, onCard: true, within: true, pending: true, modifiers: false, ...patch });

describe('approval keyboard', () => {
  it('allows on Enter and denies on Esc on the focused pending card', () => {
    expect(keyOn('Enter')).toBe('allow');
    expect(keyOn('Escape')).toBe('deny');
  });

  it('does nothing when focus is not on the card', () => {
    expect(keyOn('Enter', { onCard: false, within: false })).toBeNull();
    expect(keyOn('Escape', { onCard: false, within: false })).toBeNull();
  });

  it('leaves Enter to a focused button inside the card, but Esc still denies', () => {
    expect(keyOn('Enter', { onCard: false })).toBeNull();
    expect(keyOn('Escape', { onCard: false })).toBe('deny');
  });

  it('does nothing once the approval is answered or expired', () => {
    expect(keyOn('Enter', { pending: false })).toBeNull();
    expect(keyOn('Escape', { pending: false })).toBeNull();
  });

  it('ignores Enter with a modifier', () => {
    expect(keyOn('Enter', { modifiers: true })).toBeNull();
  });
});

describe('ApprovalCard', () => {
  const render = (a: Approval) => renderToStaticMarkup(createElement(ApprovalCard, { item: a, tool: null, onAnswer: () => {} }));

  it('offers Always allow only with the engine\'s label, and names where it is saved', () => {
    expect(render(approval())).not.toContain('Always allow');
    const out = render(approval({ alwaysLabel: "this project's local settings" }));
    expect(out).toContain('Always allow');
    expect(out).toContain('this project&#x27;s local settings');
  });

  it('preserves a long multiline shell command alongside its reason', () => {
    const command = 'npm test -- ' + 'task-name '.repeat(24) + '\n&& npm run build';
    const tool = { kind: 'tool' as const, id: 'cmd', at: 0, tool: 'command' as const, name: 'Bash',
      target: command, status: 'waiting' as const, output: null, exitCode: null, diffs: [] };
    const out = renderToStaticMarkup(createElement(ApprovalCard, {
      item: approval({ detail: command + '\n\nCheck the build.' }), tool, onAnswer: () => {},
    }));
    expect(out).toContain('<code>' + command.replace('&&', '&amp;&amp;') + '</code>');
    expect(out).toContain('Check the build.');
    expect(out).not.toContain('class="i chev"');
  });

  it('a plan approval shows the whole plan as Markdown, not one cut line', () => {
    const plan = `# Fix the login bug\n\n1. Reproduce it\n2. ${'Write the failing test. '.repeat(30)}`;
    const tool = { kind: 'tool' as const, id: 'tu', at: 0, tool: 'other' as const, name: 'ExitPlanMode', target: 'Fix the login bug', status: 'waiting' as const, output: plan, exitCode: null, diffs: [] };
    const out = renderToStaticMarkup(createElement(ApprovalCard, { item: approval({ title: 'Approve this plan?', detail: plan }), tool, onAnswer: () => {} }));
    expect(out).toContain('<h3>Fix the login bug</h3>');
    expect(out).toContain('<ol>');
    expect(out).toContain('Write the failing test. '.repeat(30).trim());
  });

  it('shows an expired approval as expired, with no buttons', () => {
    const out = render(approval({ status: 'expired' }));
    expect(out).toContain('Expired');
    expect(out).not.toContain('<button');
  });
});
