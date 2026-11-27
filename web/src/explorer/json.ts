// JSON for the explorer's preview: parsed strictly, or (for tsconfig-style files) with comments
// and trailing commas allowed; when neither works, where it broke.

export type Parsed =
  | { ok: true; value: unknown; loose: boolean }
  | { ok: false; error: string; line: number | null; column: number | null };

/** The text without // and /* *\/ comments and trailing commas, strings left alone. */
export function stripLoose(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      // Keep the line breaks, so an error's line number still points into the file.
      const skipped = text.slice(i, end === -1 ? text.length : end + 2);
      out += skipped.replace(/[^\n]/g, '');
      i = end === -1 ? text.length : end + 2;
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The line and column (1-based) of a character offset. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

/** Where a JSON.parse error says it broke, if it says ("at position 12", or "line 2 column 5"). */
function errorPlace(message: string, text: string): { line: number | null; column: number | null } {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  if (pos) return lineColumn(text, Number(pos[1]));
  // Cut short: it broke where the text ends.
  if (/end of JSON input/i.test(message)) return lineColumn(text, text.trimEnd().length);
  return { line: null, column: null };
}

export function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text), loose: false };
  } catch (strict) {
    const stripped = stripLoose(text);
    if (stripped !== text) {
      try {
        return { ok: true, value: JSON.parse(stripped), loose: true };
      } catch { /* report the strict error: it points at the file as written */ }
    }
    const message = strict instanceof Error ? strict.message : String(strict);
    const where = errorPlace(message, text);
    // V8 quotes the whole text after a bad token; the preview shows the text already.
    const error = message.replace(/\s*\(line \d+ column \d+\)$/, '').replace(/ in JSON at position \d+$/, '').replace(/, "[\s\S]*" is not valid JSON$/, '');
    return { ok: false, error, ...where };
  }
}

/** How a value is drawn. */
export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export function kindOf(v: unknown): JsonKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'object' ? 'object' : t === 'string' ? 'string' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'null';
}

/** A container's folded summary: `{ 3 keys }`, `[ 12 items ]`. */
export function summary(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  const n = Object.keys(v as object).length;
  return `${n} ${n === 1 ? 'key' : 'keys'}`;
}

/** Children shown before "Show more". */
export const JSON_PAGE = 200;
