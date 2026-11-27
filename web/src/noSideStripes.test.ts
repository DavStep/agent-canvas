// House rule: no left-edge (or right-edge) accent bars, anywhere in Agent canvas.
//
// The owner dislikes them ("remove the left weird purple thing, and please never do that in
// this project"). Selection, status and emphasis use a background fill on the rounded row, a
// :focus-visible ring, a dot, an icon or a word, never a coloured stripe down one side.
// See AGENTS.md ("No side stripes").
//
// This scans every stylesheet in web/src, CSS written inside .ts/.tsx files, inline style
// objects, and the mockups/ that future work copies from. It flags:
//   1. border-left / border-right / border-inline-start / border-inline-end (and their
//      -color / -width / -style longhands) with a visible value,
//   2. inset box-shadows with a sideways offset (`inset 2px 0 0 …`), the classic fake stripe,
//   3. ::before / ::after bars: a pseudo-element at most 4px wide that runs down the box,
//   4. borderLeft / borderInlineStart / … in inline style objects.
// Plain neutral dividers between regions and column-resize grips are allowed, one by one,
// in ALLOWED below, each with its reason.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

const RULE =
  'No side stripes: Agent canvas never uses a left- or right-edge accent bar (border-left, ' +
  'border-inline-start, an inset box-shadow with a sideways offset, or a thin ::before/::after bar) ' +
  'for selection, status or emphasis. The owner dislikes them. Use a background fill on the rounded ' +
  'row instead (selected: var(--sel-fill), hovered: var(--row-hover)), a :focus-visible outline ' +
  'with var(--ring) for keyboard focus, or a dot, icon or word for state. A neutral structural ' +
  'divider or a resize grip may be allow-listed in web/src/noSideStripes.test.ts with a reason.';

/** file (repo-relative) + a substring of the selector: why this one is not an accent. */
const ALLOWED: { file: string; selector: string; why: string }[] = [
  { file: 'web/src/app.css', selector: '.counts', why: 'a 1px neutral separator between the title and the counts in the top bar' },
  { file: 'mockups/nightdesk.html', selector: '.counts', why: 'the same top-bar separator in the mockup' },
  { file: 'mockups/nightdesk-v2.html', selector: '.counts', why: 'the same top-bar separator in the mockup' },
  { file: 'mockups/nightdesk.html', selector: '.panel', why: 'a 1px neutral line between the canvas and the side panel' },
  { file: 'mockups/daylight.html', selector: '.panel', why: 'a 1px neutral line between the canvas and the side panel' },
  { file: 'mockups/ledger.html', selector: '.panel', why: 'a 1px line between the canvas and the side panel' },
  { file: 'mockups/ledger.html', selector: '.ctrl span', why: '1px lines between segmented top-bar controls' },
  { file: 'mockups/ledger.html', selector: '.brand', why: 'a 1px line between top-bar segments' },
  { file: 'mockups/ledger.html', selector: '.needs-head', why: 'a 1px line between top-bar segments' },
  { file: 'web/src/app.css', selector: '.brief h2', why: 'a 1px neutral separator between the briefing title and its items' },
  { file: 'web/src/chat/chat.css', selector: '.cs-resize', why: 'the column resize grip: neutral on hover and drag, the focus ring colour on keyboard focus' },
  { file: 'web/src/chat/chat.css', selector: '.panel-edge', why: 'the docked panel resize grip' },
  { file: 'web/src/chat/chat.css', selector: '.pv-size', why: 'the preview resize grip' },
  { file: 'web/src/explorer/explorer.css', selector: '.ex-edge', why: 'the explorer resize grip' },
];

type Hit = { file: string; selector: string; text: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const SIDE_BORDER = /^border-(left|right|inline-start|inline-end)(-color|-width|-style)?$/;
const INVISIBLE = /^(0|0px|none|hidden|transparent|0 none|none 0|unset|initial)(\s*!important)?$/;

/** Does one CSS declaration draw a side stripe? */
function stripeDeclaration(prop: string, value: string): boolean {
  prop = prop.trim().toLowerCase();
  value = value.trim().toLowerCase();
  if (SIDE_BORDER.test(prop)) return !INVISIBLE.test(value);
  if (prop === 'box-shadow') {
    // Each shadow in the list: `inset <x> <y> …` with x ≠ 0 paints a bar down one side.
    for (const shadow of value.split(/,(?![^(]*\))/)) {
      const m = shadow.trim().match(/^inset\s+(-?[\d.]+)(px|rem|em)?\s+(-?[\d.]+)/) ?? shadow.trim().match(/^(-?[\d.]+)(px|rem|em)?\s+(-?[\d.]+)[^,]*\binset\b/);
      if (m && parseFloat(m[1] ?? '0') !== 0) return true;
    }
  }
  return false;
}

function declarations(body: string): [string, string][] {
  return body.split(';').map(d => d.split(/:(.*)/s)).filter(p => p.length >= 2 && p[0]?.trim()).map(p => [p[0] ?? '', p[1] ?? ''] as [string, string]);
}

/** A thin pseudo-element running down the box: ≤4px wide and taller than it is wide (or pinned top and bottom). */
function pseudoBar(selector: string, body: string): boolean {
  if (!/::?(before|after)/.test(selector)) return false;
  const d = new Map(declarations(body).map(([k, v]) => [k.trim().toLowerCase(), v.trim().toLowerCase()]));
  const px = (v?: string) => (v && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : undefined);
  const width = px(d.get('width')) ?? px(d.get('inline-size'));
  if (width === undefined || width > 4) return false;
  const height = px(d.get('height')) ?? px(d.get('block-size'));
  const pinned = d.has('top') && d.has('bottom');
  const filled = [...d.entries()].some(([k, v]) => /^(background|background-color|border)$/.test(k) && !INVISIBLE.test(v));
  return filled && (pinned || (height !== undefined && height >= 3 * width));
}

/** Innermost `selector { declarations }` blocks of a stylesheet (handles @media nesting). */
function rules(css: string): { selector: string; body: string }[] {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const head = (m[1] ?? '').trim();
    out.push({ selector: head.split(/[;\n]/).pop()?.trim() || head, body: m[2] ?? '' });
  }
  return out;
}

export function scanCss(file: string, css: string): Hit[] {
  const hits: Hit[] = [];
  for (const { selector, body } of rules(css)) {
    for (const [prop, value] of declarations(body)) {
      if (stripeDeclaration(prop, value)) hits.push({ file, selector, text: `${prop.trim()}: ${value.trim()}` });
    }
    if (pseudoBar(selector, body)) hits.push({ file, selector, text: 'a thin ::before/::after bar down one side' });
  }
  return hits;
}

/** .ts/.tsx: CSS inside template strings, and inline style objects. */
export function scanScript(file: string, src: string): Hit[] {
  const hits: Hit[] = [];
  src.split('\n').forEach((line, i) => {
    const at = `line ${i + 1}`;
    for (const m of line.matchAll(/\b(border-(?:left|right|inline-start|inline-end)(?:-color|-width|-style)?)\s*:\s*([^;}"'`]+)/g)) {
      if (stripeDeclaration(m[1] ?? '', m[2] ?? '')) hits.push({ file, selector: at, text: m[0] });
    }
    for (const m of line.matchAll(/box-shadow\s*:\s*([^;}"'`]+)/g)) {
      if (stripeDeclaration('box-shadow', m[1] ?? '')) hits.push({ file, selector: at, text: m[0] });
    }
    for (const m of line.matchAll(/\b(borderLeft|borderRight|borderInlineStart|borderInlineEnd)(Color|Width|Style)?\s*:\s*(['"`][^'"`]*['"`]|[\w.]+)/g)) {
      const value = (m[3] ?? '').replace(/^['"`]|['"`]$/g, '');
      if (!INVISIBLE.test(value)) hits.push({ file, selector: at, text: m[0] });
    }
    for (const m of line.matchAll(/boxShadow\s*:\s*['"`]([^'"`]+)['"`]/g)) {
      if (stripeDeclaration('box-shadow', m[1] ?? '')) hits.push({ file, selector: at, text: m[0] });
    }
  });
  return hits;
}

function allowed(hit: Hit): boolean {
  return ALLOWED.some(a => a.file === hit.file && hit.selector.includes(a.selector));
}

describe('no side stripes (house rule, see AGENTS.md)', () => {
  it('the scanner catches the stripes it is meant to catch', () => {
    expect(scanCss('x.css', '.row.is-open { box-shadow: inset 2px 0 0 var(--highlight); }')).toHaveLength(1);
    expect(scanCss('x.css', '.row { box-shadow: inset 0 0 0 1px var(--border), inset 3px 0 0 red; }')).toHaveLength(1);
    expect(scanCss('x.css', '@media (x) { .tool.is-running { border-left: 3px solid var(--highlight); } }')).toHaveLength(1);
    expect(scanCss('x.css', '.note { border-inline-start: 2px solid var(--border); }')).toHaveLength(1);
    expect(scanCss('x.css', '.item::before { content: ""; position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; background: var(--highlight); }')).toHaveLength(1);
    expect(scanScript('x.tsx', "<div style={{ borderLeft: '2px solid var(--highlight)' }} />")).toHaveLength(1);
    expect(scanScript('x.tsx', 'const css = `.a { box-shadow: inset 2px 0 0 red; }`;')).toHaveLength(1);
  });

  it('and leaves calm treatments alone', () => {
    const calm = [
      '.row.is-selected { background: var(--sel-fill); border-radius: 6px; box-shadow: inset 0 0 0 1px var(--sel-edge); }',
      '.row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }',
      '.card { border: 1px solid var(--card-border); border-left: 0; }',
      '.caret::after { content: ""; display: inline-block; width: 7px; height: 14px; background: var(--muted); }',
      '.live::after { content: ""; position: absolute; inset: 0; border-radius: 50%; }',
      '.zone::before { content: ""; box-shadow: inset 0 0 16px red; }',
    ].join('\n');
    expect(scanCss('x.css', calm)).toEqual([]);
  });

  it('no stylesheet, component or mockup draws a left- or right-edge accent bar', () => {
    const files = [...walk(join(ROOT, 'web', 'src')), ...walk(join(ROOT, 'mockups'))];
    const hits: Hit[] = [];
    for (const path of files) {
      const file = relative(ROOT, path).split('\\').join('/');
      if (file.endsWith('noSideStripes.test.ts')) continue;
      const text = readFileSync(path, 'utf8');
      if (file.endsWith('.css')) hits.push(...scanCss(file, text));
      else if (file.endsWith('.html')) for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) hits.push(...scanCss(file, m[1] ?? ''));
      else if (/\.(tsx?|jsx?)$/.test(file)) hits.push(...scanScript(file, text));
    }
    const bad = hits.filter(h => !allowed(h));
    const report = bad.map(h => `  ${h.file}  ${h.selector}  →  ${h.text}`).join('\n');
    expect(bad, `${RULE}\n\nFound:\n${report}\n`).toEqual([]);
  });
});
