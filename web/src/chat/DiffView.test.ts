import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiffView, diffLines, MAX_LINES } from './DiffView.tsx';

const UNIFIED = [
  '--- a/deploy/api.env', '+++ b/deploy/api.env', '@@ -12,3 +12,3 @@',
  ' ACCOUNT_DELETION=enabled', '-DELETE_APPROVAL=0', '+DELETE_APPROVAL=1', ' DELETE_APPROVAL_TIMEOUT=72h',
  '\\ No newline at end of file',
].join('\n');

describe('diffLines', () => {
  it('numbers context, removed and added lines from the hunk header, skipping file headers', () => {
    expect(diffLines(UNIFIED)).toEqual([
      { kind: 'hunk', old: null, new: null, text: '@@ -12,3 +12,3 @@' },
      { kind: 'ctx', old: 12, new: 12, text: 'ACCOUNT_DELETION=enabled' },
      { kind: 'del', old: 13, new: null, text: 'DELETE_APPROVAL=0' },
      { kind: 'add', old: null, new: 13, text: 'DELETE_APPROVAL=1' },
      { kind: 'ctx', old: 14, new: 14, text: 'DELETE_APPROVAL_TIMEOUT=72h' },
    ]);
  });

  it('reads a diff with no hunk header as starting at line 1', () => {
    expect(diffLines('+a\n+b')).toEqual([
      { kind: 'add', old: null, new: 1, text: 'a' },
      { kind: 'add', old: null, new: 2, text: 'b' },
    ]);
  });
});

describe('DiffView', () => {
  const render = (unified: string, showPath = false) =>
    renderToStaticMarkup(createElement(DiffView, { diff: { path: 'deploy/api.env', unified, added: 1, removed: 1 }, showPath }));

  it('draws each line with its number and sign: old number for removed, new for the rest', () => {
    const out = render(UNIFIED);
    expect(out).toContain('<div class="ln ctx"><span class="no">12</span><span class="sg"> </span><span class="tx">ACCOUNT_DELETION=enabled</span></div>');
    expect(out).toContain('<div class="ln del"><span class="no">13</span><span class="sg">−</span><span class="tx">DELETE_APPROVAL=0</span></div>');
    expect(out).toContain('<div class="ln add"><span class="no">13</span><span class="sg">+</span><span class="tx">DELETE_APPROVAL=1</span></div>');
    expect(out).not.toContain('@@');
    expect(out).not.toContain('deploy/api.env</div>');
  });

  it('names the file when the tool changed several', () => {
    expect(render(UNIFIED, true)).toContain('<div class="t-diff-path">deploy/api.env</div>');
  });

  it('marks a later hunk with a gap row', () => {
    const out = render(`${UNIFIED}\n@@ -40,1 +40,1 @@\n-a\n+b`);
    expect(out.match(/class="ln gap"/g)).toHaveLength(1);
    expect(out).toContain('<span class="no">40</span><span class="sg">−</span><span class="tx">a</span>');
  });

  it('stops at 400 lines and says how many more there are', () => {
    const unified = Array.from({ length: 450 }, (_, i) => `+line ${i + 1}`).join('\n');
    const out = render(unified);
    expect(out.match(/class="ln add"/g)).toHaveLength(MAX_LINES);
    expect(out).toContain('line 400<');
    expect(out).not.toContain('line 401<');
    expect(out).toContain('<div class="t-diff-more">50 more lines</div>');
  });
});
