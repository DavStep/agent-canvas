// A small Markdown subset, safe by construction: the text is parsed into plain blocks and
// inlines, and React writes them as text. Media is rendered with native controls, and
// only http(s) and mailto links exist, opened in the owner's browser or mail app.
// Supported: headings, paragraphs, bullet and numbered lists, block quotes, rules, fenced code
// with its language, GFM tables (with column alignment), **strong**, *em*, `code`, [links](https://…),
// <https://…> and bare URLs in the text (never inside code).
import { memo, type ReactNode } from 'react';
import { mediaLink, mediaLinkPattern, type ChatMedia } from '../../../shared/chatMedia.ts';
import { MediaPreview } from './ChatMedia.tsx';
import { openExternal } from '../bridge.ts';

export type Inline =
  | { type: 'media'; media: ChatMedia }
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'para'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'pre'; text: string }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };

export type Align = 'left' | 'center' | 'right' | null;

/** The link target if it is an absolute http(s) URL or a mailto: address, else null. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol === 'mailto:') return url.pathname !== '' ? href : null;
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? href : null;
  } catch {
    return null;
  }
}

// A bare URL starts at a word boundary and runs to whitespace or a character no URL in prose has.
const BARE_URL = /(?<![\w@/.:-])(?:https?:\/\/|mailto:)[^\s<>"'`]+/gi;
const TRAILING = /[.,:;!?'"*_~]$/;

/** Drops what prose put after a URL: a full stop or comma, and a closing bracket it never opened. */
export function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    if (TRAILING.test(u)) { u = u.slice(0, -1); continue; }
    const close = u.at(-1);
    const open = close === ')' ? '(' : close === ']' ? '[' : close === '}' ? '{' : null;
    if (open && u.split(open).length < u.split(close!).length) { u = u.slice(0, -1); continue; }
    return u;
  }
}

/** Plain text with its http(s) and mailto URLs as links; the rest stays text. */
export function linkify(src: string): Inline[] {
  const out: Inline[] = [];
  const text = (t: string) => {
    if (t === '') return;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += t;
    else out.push({ type: 'text', text: t });
  };
  let at = 0;
  for (const m of src.matchAll(BARE_URL)) {
    const raw = trimUrl(m[0]);
    const href = safeHref(raw);
    if (!href) continue;
    text(src.slice(at, m.index));
    out.push({ type: 'link', href, children: [{ type: 'text', text: raw }] });
    at = m.index + raw.length;
  }
  text(src.slice(at));
  return out;
}

// Code spans first, then links (<autolinks>, [text](url) and bare URLs), strong, em. `_em_` only
// between non-word characters, so snake_case stays. A URL found first is a link before any
// emphasis, so the underscores in https://x.test/a_b_ stay in it.
const INLINE = new RegExp([
  /(`+)([\s\S]*?[^`])\1(?!`)/.source,
  /<((?:https?:\/\/|mailto:)[^\s<>]+)>/.source,
  mediaLinkPattern.source,
  BARE_URL.source,
  /\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|\*(?=[^\s*])([^*\n]+?)\*|(?<![\w])_(?=[^\s_])([^_\n]+?)_(?![\w])/.source,
].join('|'), 'gi');

/** Inline Markdown. Inside a link's own text (`links` false) no URL becomes a second link. */
export function parseInline(src: string, links = true): Inline[] {
  const out: Inline[] = [];
  const text = (t: string) => {
    if (t === '') return;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += t;
    else out.push({ type: 'text', text: t });
  };
  // Its own copy: parseInline recurses, and a shared lastIndex would be lost.
  const re = new RegExp(INLINE);
  let at = 0;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    text(src.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] !== undefined) out.push({ type: 'code', text: m[2].replace(/^ (.*) $/s, '$1') });
    else if (m[3] !== undefined) {
      const href = links ? safeHref(m[3]) : null;
      if (href) out.push({ type: 'link', href, children: [{ type: 'text', text: m[3] }] });
      else text(m[0]);
    } else if (m[4] !== undefined) {
      const media = links ? mediaLink(m[5] ?? '', m[4]) : null;
      if (media) { out.push({ type: 'media', media }); continue; }
      const href = safeHref(m[5] ?? '');
      if (href && links) out.push({ type: 'link', href, children: parseInline(m[4], false) });
      else out.push(...parseInline(m[4], links));
    } else if (m[6] !== undefined || m[7] !== undefined) out.push({ type: 'strong', children: parseInline(m[6] ?? m[7]!, links) });
    else if (m[8] !== undefined || m[9] !== undefined) out.push({ type: 'em', children: parseInline(m[8] ?? m[9]!, links) });
    else {
      // A bare URL, without what the sentence put after it.
      const raw = trimUrl(m[0]);
      const href = links ? safeHref(raw) : null;
      if (href) out.push({ type: 'link', href, children: [{ type: 'text', text: raw }] });
      else text(raw);
      at = m.index + raw.length;
      re.lastIndex = at;
    }
  }
  text(src.slice(at));
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE = /^\s*\|/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A table row's cells: split on pipes, but not an escaped \| or one inside a `code span`. */
export function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let tick = 0; // the length of the backtick run that opened the code span we are in, else 0
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!;
    if (c === '\\' && row[i + 1] === '|') { cell += '|'; i++; continue; }
    if (c === '`') {
      let run = 1;
      while (row[i + run] === '`') run++;
      if (tick === 0 && row.indexOf('`'.repeat(run), i + run) !== -1) tick = run;
      else if (tick === run) tick = 0;
      cell += '`'.repeat(run);
      i += run - 1;
      continue;
    }
    if (c === '|' && tick === 0) { cells.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/** A GFM table starting at lines[i], if lines[i] is a header and the next line its delimiter. */
function readTable(lines: string[], i: number): { block: Block; end: number } | null {
  const header = lines[i]!;
  const delimiter = lines[i + 1];
  if (!header.includes('|') || delimiter === undefined || !DELIMITER.test(delimiter)) return null;
  if (!delimiter.includes('|') && !TABLE.test(header)) return null;
  const head = splitRow(header);
  const marks = splitRow(delimiter);
  if (head.length !== marks.length) return null;
  const width = head.length;
  const fit = (cells: string[]) => Array.from({ length: width }, (_, k) => parseInline(cells[k] ?? ''));
  const rows: Inline[][][] = [];
  let end = i + 1;
  for (; end + 1 < lines.length; end++) {
    const next = lines[end + 1]!;
    if (next.trim() === '' || !next.includes('|') || FENCE.test(next) || HEADING.test(next) || QUOTE.test(next)) break;
    rows.push(fit(splitRow(next)));
  }
  return { block: { type: 'table', align: marks.map(alignOf), head: fit(head), rows }, end };
}

/** Markdown → blocks. Never throws; anything it does not know is a paragraph of text. */
export function markdownToSafe(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ type: 'para', children: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      const close = new RegExp(`^\\s{0,3}${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}\\s*$`);
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') { flush(); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) }); continue; }
    if (RULE.test(line) && para.length === 0) { blocks.push({ type: 'rule' }); continue; }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]!);
      const items: string[] = [item[2]!];
      for (; i + 1 < lines.length; i++) {
        const next = lines[i + 1]!;
        const m = ITEM.exec(next);
        if (m && /\d/.test(m[1]!) === ordered) items.push(m[2]!);
        else if (next.trim() !== '' && /^\s+/.test(next) && !FENCE.test(next)) items[items.length - 1] += ` ${next.trim()}`;
        else break;
      }
      blocks.push({ type: 'list', ordered, items: items.map((text) => parseInline(text)) });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]!];
      for (; i + 1 < lines.length && QUOTE.test(lines[i + 1]!); i++) body.push(QUOTE.exec(lines[i + 1]!)![1]!);
      blocks.push({ type: 'quote', children: parseInline(body.join(' ')) });
      continue;
    }
    const table = readTable(lines, i);
    if (table) { flush(); blocks.push(table.block); i = table.end; continue; }
    // Pipe-led lines with no delimiter row under them stay as they were written.
    if (TABLE.test(line) && para.length === 0) {
      const body = [line];
      for (; i + 1 < lines.length && TABLE.test(lines[i + 1]!); i++) body.push(lines[i + 1]!);
      blocks.push({ type: 'pre', text: body.join('\n') });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** A link handed to the owner's browser (or mail app); the page itself never navigates. */
function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      className="md-link"
      rel="noreferrer"
      onClick={(e) => { e.preventDefault(); openExternal(href).catch(() => {}); }}
      // A middle click would ask for a new window; it opens in the browser the same way.
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openExternal(href).catch(() => {}); } }}
    >
      {children}
    </a>
  );
}

/** Plain text, such as the owner's own message, with its URLs clickable. */
export function LinkedText({ text }: { text: string }): ReactNode {
  return linkify(text).map((n, i) => (n.type === 'link'
    ? <Link key={i} href={n.href}>{(n.children[0] as { text: string }).text}</Link>
    : (n as { text: string }).text));
}

function Inlines({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'media': return <MediaPreview key={i} media={n.media} />;
      case 'text': return n.text;
      case 'code': return <code key={i}>{n.text}</code>;
      case 'strong': return <strong key={i}><Inlines nodes={n.children} /></strong>;
      case 'em': return <em key={i}><Inlines nodes={n.children} /></em>;
      case 'link': return <Link key={i} href={n.href}><Inlines nodes={n.children} /></Link>;
    }
  });
}

const alignClass = (a: Align) => (a ? `is-${a}` : undefined);

/** A reply's table. Wide ones scroll sideways inside their frame, reachable from the keyboard. */
function Table({ table }: { table: Extract<Block, { type: 'table' }> }) {
  return (
    <div className="md-table" role="region" aria-label="Table" tabIndex={0}>
      <table>
        <thead>
          <tr>{table.head.map((cell, k) => <th key={k} scope="col" className={alignClass(table.align[k] ?? null)}><Inlines nodes={cell} /></th>)}</tr>
        </thead>
        {table.rows.length > 0 && (
          <tbody>
            {table.rows.map((row, j) => (
              <tr key={j}>{row.map((cell, k) => <td key={k} className={alignClass(table.align[k] ?? null)}><Inlines nodes={cell} /></td>)}</tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

/** Headings stay small inside a reply: # is an h3, the rest h4. */
const headingTag = (level: number) => (level <= 1 ? 'h3' : 'h4');

/** Drawn again only when its props change: unchanged items keep their identity (applyUpdate),
    so a streaming chat redraws only the item that grows. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {markdownToSafe(text).map((b, i) => {
        switch (b.type) {
          case 'heading': {
            const H = headingTag(b.level);
            return <H key={i}><Inlines nodes={b.children} /></H>;
          }
          case 'para': return <p key={i}><Inlines nodes={b.children} /></p>;
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul';
            return <L key={i}>{b.items.map((item, j) => <li key={j}><Inlines nodes={item} /></li>)}</L>;
          }
          case 'quote': return <blockquote key={i}><Inlines nodes={b.children} /></blockquote>;
          case 'code':
            return <pre key={i} className="md-code" data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
          case 'pre': return <pre key={i} className="md-code"><code>{b.text}</code></pre>;
          case 'table': return <Table key={i} table={b} />;
          case 'rule': return <hr key={i} />;
        }
      })}
    </div>
  );
});
