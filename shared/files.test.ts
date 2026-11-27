import { describe, expect, it } from 'vitest';
import { extOf, formatSize, isIgnored, looksLikeText, parseGitignore, previewKindOf, relativeSteps, rootOfCwd } from './files.ts';

describe('previewKindOf', () => {
  it('knows images, JSON and text by name, and leaves the rest to the bytes', () => {
    expect(previewKindOf('logo.PNG')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(previewKindOf('a.jpeg')).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(previewKindOf('icon.svg')).toEqual({ kind: 'image', mime: 'image/svg+xml' });
    expect(previewKindOf('anim.gif').kind).toBe('image');
    expect(previewKindOf('photo.webp').kind).toBe('image');
    expect(previewKindOf('package.json')).toEqual({ kind: 'json' });
    expect(previewKindOf('tsconfig.jsonc')).toEqual({ kind: 'json' });
    expect(previewKindOf('App.tsx')).toEqual({ kind: 'text' });
    expect(previewKindOf('Dockerfile')).toEqual({ kind: 'text' });
    expect(previewKindOf('.gitignore')).toEqual({ kind: 'text' });
    expect(previewKindOf('model.glb')).toEqual({ kind: 'unknown' });
    expect(previewKindOf('noext')).toEqual({ kind: 'unknown' });
  });

  it('reads the extension after the last dot', () => {
    expect(extOf('a.test.TS')).toBe('ts');
    expect(extOf('Makefile')).toBe('');
  });
});

describe('looksLikeText', () => {
  it('takes UTF-8 and plain ASCII, refuses NULs and control noise', () => {
    expect(looksLikeText(new TextEncoder().encode('héllo\n\twörld'))).toBe(true);
    expect(looksLikeText(new Uint8Array([]))).toBe(true);
    expect(looksLikeText(new Uint8Array([104, 0, 105]))).toBe(false);
    expect(looksLikeText(new Uint8Array(Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 2 : 65))))).toBe(false);
  });
});

describe('relativeSteps', () => {
  it('splits a clean relative path, and refuses anything that could climb or escape', () => {
    expect(relativeSteps('')).toEqual([]);
    expect(relativeSteps('src/app/main.ts')).toEqual(['src', 'app', 'main.ts']);
    expect(relativeSteps('.github/workflows')).toEqual(['.github', 'workflows']);
    for (const bad of ['/etc/passwd', '..', 'a/../b', './a', 'a/./b', 'a//b', 'a/', 'a\0', 'a\\b']) {
      expect(() => relativeSteps(bad), bad).toThrow();
    }
    expect(() => relativeSteps(7 as unknown as string)).toThrow();
  });
});

describe('gitignore', () => {
  const rules = parseGitignore([
    '# comment', '', 'node_modules/', '/dist', '*.log', '!keep.log', 'docs/**/draft.md', 'tmp?', '\\#hash', 'cache/',
  ].join('\n'));
  const ig = (p: string, dir = false) => isIgnored(rules, p, dir);

  it('matches unanchored names at any depth, anchored ones at the root only', () => {
    expect(ig('node_modules', true)).toBe(true);
    expect(ig('packages/a/node_modules', true)).toBe(true);
    expect(ig('dist', true)).toBe(true);
    expect(ig('packages/dist', true)).toBe(false);
    expect(ig('server.log')).toBe(true);
    expect(ig('logs/today.log')).toBe(true);
  });

  it('lets a later negation win, keeps dir-only rules to folders, and handles ** and ?', () => {
    expect(ig('keep.log')).toBe(false);
    expect(ig('cache', true)).toBe(true);
    expect(ig('cache', false)).toBe(false);
    expect(ig('docs/draft.md')).toBe(true);
    expect(ig('docs/a/b/draft.md')).toBe(true);
    expect(ig('tmp1')).toBe(true);
    expect(ig('tmp12')).toBe(false);
    expect(ig('#hash')).toBe(true);
    expect(ig('src/app.ts')).toBe(false);
  });
});

describe('helpers', () => {
  it('takes a worktree back to its repository', () => {
    expect(rootOfCwd('/w/app/.claude/worktrees/fix-1')).toBe('/w/app');
    expect(rootOfCwd('/w/app')).toBe('/w/app');
  });

  it('formats sizes', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(1_500)).toBe('1.5 KB');
    expect(formatSize(12_000)).toBe('12 KB');
    expect(formatSize(2_000_000)).toBe('2 MB');
    expect(formatSize(1_400_000)).toBe('1.4 MB');
  });
});
