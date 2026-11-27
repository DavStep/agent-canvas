import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../../shared/files.ts';
import { lineColumn, parseJson, stripLoose, summary } from './json.ts';
import { homeOf, parentOf, shortPath, stepFocus, visibleRows, type Dirs } from './tree.ts';

const dir = (name: string, ignored = false): FileEntry => ({ name, kind: 'dir', size: 0, ignored });
const file = (name: string, size = 1): FileEntry => ({ name, kind: 'file', size, ignored: false });
const ok = (...entries: FileEntry[]) => ({ status: 'ok' as const, listing: { entries, truncated: false } });

describe('visibleRows', () => {
  const dirs: Dirs = {
    '': ok(dir('src'), dir('node_modules', true), file('package.json')),
    src: ok(dir('lib'), file('main.ts')),
    'src/lib': { status: 'loading' },
    node_modules: { status: 'error', message: 'This folder can’t be read.' },
  };

  it('shows the root, and each open folder\'s entries under it, depth first', () => {
    const rows = visibleRows(dirs, new Set(['src']));
    expect(rows.map((r) => `${r.depth}:${r.path}`)).toEqual(['0:src', '1:src/lib', '1:src/main.ts', '0:node_modules', '0:package.json']);
  });

  it('shows a folder still loading, a failure, an empty folder and a cut-short listing as notes', () => {
    const rows = visibleRows({ ...dirs, empty: ok(), '': { status: 'ok', listing: { entries: [dir('src'), dir('node_modules'), dir('empty')], truncated: true } } },
      new Set(['src', 'src/lib', 'node_modules', 'empty']));
    const notes = rows.filter((r) => r.kind === 'note').map((r) => r.kind === 'note' && `${r.tone}:${r.text}`);
    expect(notes).toEqual(['loading:Loading…', 'error:This folder can’t be read.', 'more:Empty folder', 'more:Showing the first 3 items']);
  });

  it('shows nothing for the root until it is listed (the panel says Loading)', () => {
    expect(visibleRows({}, new Set())).toEqual([]);
  });
});

describe('stepFocus', () => {
  const rows = visibleRows({ '': ok(dir('src'), file('a.json')), src: ok(file('main.ts')) }, new Set(['src']));
  it('walks down and up, to the ends, into an open folder and back to its parent', () => {
    expect(stepFocus(rows, 'src', 'ArrowDown')).toBe('src/main.ts');
    expect(stepFocus(rows, 'src/main.ts', 'ArrowDown')).toBe('a.json');
    expect(stepFocus(rows, 'a.json', 'ArrowDown')).toBeNull();
    expect(stepFocus(rows, 'a.json', 'ArrowUp')).toBe('src/main.ts');
    expect(stepFocus(rows, 'a.json', 'Home')).toBe('src');
    expect(stepFocus(rows, 'src', 'End')).toBe('a.json');
    expect(stepFocus(rows, 'src', 'ArrowRight')).toBe('src/main.ts');
    expect(stepFocus(rows, 'src/main.ts', 'ArrowLeft')).toBe('src');
    expect(stepFocus(rows, 'gone', 'ArrowDown')).toBe('src');
  });
});

describe('paths', () => {
  it('names a parent and shortens the home folder', () => {
    expect(parentOf('a/b/c.ts')).toBe('a/b');
    expect(parentOf('c.ts')).toBe('');
    expect(homeOf('/Users/sam/code/app')).toBe('/Users/sam');
    expect(shortPath('/Users/sam/code/app', '/Users/sam')).toBe('~/code/app');
    expect(shortPath('/opt/app', null)).toBe('/opt/app');
  });
});

describe('parseJson', () => {
  it('parses valid JSON strictly', () => {
    expect(parseJson('{"a":[1,true,null]}')).toEqual({ ok: true, value: { a: [1, true, null] }, loose: false });
  });

  it('allows comments and trailing commas (tsconfig), saying so, and keeps strings with // in them', () => {
    const text = '{\n  // the target\n  "url": "https://x.test/a", /* block */\n  "list": [1, 2,],\n}';
    expect(parseJson(text)).toEqual({ ok: true, value: { url: 'https://x.test/a', list: [1, 2] }, loose: true });
    expect(stripLoose('"a,]" ,]')).toBe('"a,]" ]');
  });

  it('reports where invalid JSON broke', () => {
    expect(parseJson('{\n  "a": 1 x}')).toMatchObject({ ok: false, line: 2, column: 10 });
    expect(parseJson('{\n  "name":\n')).toMatchObject({ ok: false, error: 'Unexpected end of JSON input', line: 2, column: 10 });
    const token = parseJson('{\n  "name": \n}');
    expect(token).toMatchObject({ ok: false, error: "Unexpected token '}'" });
  });

  it('counts lines and columns from 1, and summarises containers', () => {
    expect(lineColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
    expect(summary([1, 2])).toBe('2 items');
    expect(summary({ a: 1 })).toBe('1 key');
  });
});
