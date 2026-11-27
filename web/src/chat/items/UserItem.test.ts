import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { withFiles } from '../../../../shared/attachments.ts';
import { UserItem } from './UserItem.tsx';

const html = (text: string) => renderToStaticMarkup(createElement(UserItem, { item: { kind: 'user', id: 'u', at: 0, text, images: [] } }));

describe('UserItem', () => {
  it('shows attached files as chips and only the request as text', () => {
    const out = html(withFiles('codex', 'Summarise it', [{ name: 'report.pdf', path: '/Users/me/report.pdf' }]));
    expect(out).toContain('report.pdf');
    expect(out).toContain('title="/Users/me/report.pdf"');
    expect(out).toContain('<div class="t-you-text">Summarise it</div>');
    expect(out).not.toContain('Files mentioned');
  });

  it('shows a plain message as it is', () => {
    expect(html('@not a mention')).toContain('<div class="t-you-text">@not a mention</div>');
  });
});
