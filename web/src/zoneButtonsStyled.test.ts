// Guard: no zone control ships as a raw browser button.
//
// The Tidy button and the "Earlier" fold once reached the installed app with their JSX but
// without their CSS: a grey system button, and an icon whose stroke-only path rendered as
// nothing (Tidy) or as a black filled triangle (Earlier). This checks, for every <button> in the
// zone components, that one of its static classes has a stylesheet rule resetting the UA
// background, and that an `svg.i` inside it is drawn as a stroke (fill: none) by some rule.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const COMPONENTS = ['components/Zone.tsx', 'components/ZoneMenu.tsx'];
/** Every stylesheet under web/src (components import theirs from several folders). */
const STYLESHEETS = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.css'));

type Button = { file: string; classes: string[]; hasIcon: boolean };
type Rule = { selector: string; body: string };

/** Each <button …>…</button> in a TSX source, with its static class names. */
export function buttonsIn(file: string, src: string): Button[] {
  const out: Button[] = [];
  let at = 0;
  while ((at = src.indexOf('<button', at)) !== -1) {
    // The opening tag ends at the first `>` outside a JSX expression.
    let i = at + 7;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0 && src[i - 1] !== '=') break;
    }
    const tag = src.slice(at, i);
    const close = src.indexOf('</button>', i);
    const body = src.slice(i, close === -1 ? i : close);
    const m = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(tag);
    const raw = (m?.[1] ?? m?.[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    out.push({ file, classes: raw.split(/\s+/).filter(Boolean), hasIcon: /<svg[^>]*className="i"/.test(body) });
    at = i;
  }
  return out;
}

/** Innermost rules only (good enough for @media-wrapped rules too). */
export function rulesIn(css: string): Rule[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" }));
}

const hasClass = (selector: string, cls: string) => new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}(?![\\w-])`).test(selector);

/** What is wrong with a button given the stylesheets' rules, or null when it is styled. */
export function problemWith(b: Button, rules: Rule[]): string | null {
  if (b.classes.length === 0) return 'has no class';
  const own = rules.filter((r) => b.classes.some((c) => hasClass(r.selector, c)));
  if (!own.some((r) => /(^|;)\s*(background(-color)?|all|appearance)\s*:/.test(r.body)))
    return `.${b.classes.join('.')} has no rule resetting its background, so it renders as a grey system button`;
  if (b.hasIcon) {
    const drawn = rules.some((r) => /svg\.i/.test(r.selector) && /fill\s*:\s*none/.test(r.body)
      && (r.selector.split(',').some((s) => /^svg\.i\b|^\.i\b/.test(s.trim())) || b.classes.some((c) => hasClass(r.selector, c))));
    if (!drawn) return `.${b.classes.join('.')} holds an svg.i that no rule strokes (fill: none), so the icon is invisible or a black blob`;
  }
  return null;
}

const rules = STYLESHEETS.flatMap((f) => rulesIn(readFileSync(join(SRC, f), 'utf8')));
const buttons = COMPONENTS.flatMap((f) => buttonsIn(f, readFileSync(join(SRC, f), 'utf8')));

describe('zone buttons are styled', () => {
  it('finds the zone buttons, Tidy and Earlier among them', () => {
    const classes = buttons.flatMap((b) => b.classes);
    expect(classes).toEqual(expect.arrayContaining(['zone-tidy', 'zone-earlier-toggle', 'zone-files', 'zone-new']));
  });

  it.each(buttons.map((b) => [`${b.file}: .${b.classes.join('.') || '(no class)'}`, b] as const))('%s', (_, b) => {
    expect(problemWith(b, rules)).toBeNull();
  });

  it('catches a button whose CSS never landed (the installed-build regression)', () => {
    const without = rules.filter((r) => !/zone-tidy|zone-earlier/.test(r.selector));
    const tidy = buttons.find((b) => b.classes.includes('zone-tidy'))!;
    const earlier = buttons.find((b) => b.classes.includes('zone-earlier-toggle'))!;
    expect(problemWith(tidy, without)).toMatch(/grey system button/);
    expect(problemWith(earlier, without)).toMatch(/grey system button/);
  });
});
