import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LinkedText, Markdown, linkify, markdownToSafe, parseInline, safeHref, splitRow, trimUrl } from './Markdown.tsx';

const html = (src: string) => renderToStaticMarkup(createElement(Markdown, { text: src }));

describe('markdownToSafe', () => {
  it('keeps raw HTML as text, never as markup', () => {
    const out = html('Hello <script>alert(1)</script> and <img src="https://evil.example/x.png">');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('drops javascript: and other non-web links, keeping their text', () => {
    const blocks = markdownToSafe('Click [here](javascript:alert(1)) or [there](file:///etc/passwd)');
    expect(JSON.stringify(blocks)).not.toContain('javascript:');
    expect(JSON.stringify(blocks)).not.toContain('file:');
    const out = html('Click [here](javascript:alert(1))');
    expect(out).not.toContain('href');
    expect(out).toContain('here');
  });

  it('keeps http(s) links', () => {
    const out = html('See [the docs](https://example.com/a?b=1).');
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('JavaScript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
  });

  it('keeps fenced code with its language, untouched inside', () => {
    const blocks = markdownToSafe('Before\n\n```ts\nconst a = <b>1</b>;\n**not bold**\n```\nAfter');
    expect(blocks).toContainEqual({ type: 'code', lang: 'ts', text: 'const a = <b>1</b>;\n**not bold**' });
    const out = html('```ts\nconst a = 1;\n```');
    expect(out).toContain('data-lang="ts"');
  });

  it('reads headings, lists, emphasis and inline code', () => {
    const out = html('## Plan\n\n- **one** item\n- `two`\n\n1. first\n2. *second*');
    expect(out).toContain('<h4');
    expect(out).toContain('<ul><li><strong>one</strong> item</li><li><code>two</code></li></ul>');
    expect(out).toContain('<ol><li>first</li><li><em>second</em></li></ol>');
  });

  it('leaves snake_case words alone', () => {
    expect(html('set DELETE_APPROVAL_TIMEOUT and some_value_here')).not.toContain('<em>');
  });

  it('closes an unfinished fence at the end (streaming)', () => {
    expect(markdownToSafe('```sh\nnpm test')).toEqual([{ type: 'code', lang: 'sh', text: 'npm test' }]);
  });
});

const hrefs = (src: string) => [...html(src).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const linkHtml = (src: string) => renderToStaticMarkup(createElement(LinkedText, { text: src }));

describe('links', () => {
  it('links a bare URL and shows it as written', () => {
    const out = html('The ticket is https://tickets.example.com/t/4576 for this.');
    expect(out).toContain('<a href="https://tickets.example.com/t/4576" title="https://tickets.example.com/t/4576" class="md-link" rel="noreferrer">https://tickets.example.com/t/4576</a> for this.');
  });

  it('leaves trailing punctuation out of a bare URL', () => {
    expect(hrefs('See https://x.test/a.')).toEqual(['https://x.test/a']);
    expect(hrefs('See https://x.test/a, then https://y.test/b; done!')).toEqual(['https://x.test/a', 'https://y.test/b']);
    expect(hrefs('Is it https://x.test/a?')).toEqual(['https://x.test/a']);
    expect(hrefs('"https://x.test/q"')).toEqual(['https://x.test/q']);
    expect(trimUrl('https://x.test/a).')).toBe('https://x.test/a');
  });

  it('keeps balanced brackets in a URL and drops an unopened one', () => {
    expect(hrefs('(see https://x.test/a)')).toEqual(['https://x.test/a']);
    expect(hrefs('https://en.wikipedia.org/wiki/Foo_(bar) here')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(hrefs('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(hrefs('https://x.test/?q=a&b=c#frag')).toEqual(['https://x.test/?q=a&amp;b=c#frag']);
  });

  it('keeps underscores and asterisks in a URL out of emphasis', () => {
    expect(hrefs('at https://x.test/_a_b_/c')).toEqual(['https://x.test/_a_b_/c']);
    expect(html('at https://x.test/_a_b_/c')).not.toContain('<em>');
  });

  it('links inside list items, bold and emphasis', () => {
    expect(html('- **see https://x.test/a**\n- *or [docs](https://y.test)*')).toContain(
      '<ul><li><strong>see <a href="https://x.test/a"');
    expect(hrefs('- **see https://x.test/a**\n- *or [docs](https://y.test)*')).toEqual(['https://x.test/a', 'https://y.test']);
    expect(hrefs('> quoted https://q.test/x')).toEqual(['https://q.test/x']);
    expect(hrefs('## Heading https://h.test')).toEqual(['https://h.test']);
  });

  it('shows a Markdown link by its text, and no second link inside it', () => {
    expect(parseInline('[the ticket](https://x.test/1)')).toEqual([
      { type: 'link', href: 'https://x.test/1', children: [{ type: 'text', text: 'the ticket' }] },
    ]);
    expect(hrefs('[https://x.test/shown](https://x.test/real)')).toEqual(['https://x.test/real']);
  });

  it('reads <autolinks> without their brackets', () => {
    expect(parseInline('go <https://x.test/a>.')).toEqual([
      { type: 'text', text: 'go ' },
      { type: 'link', href: 'https://x.test/a', children: [{ type: 'text', text: 'https://x.test/a' }] },
      { type: 'text', text: '.' },
    ]);
  });

  it('leaves code spans and code blocks alone', () => {
    expect(hrefs('run `curl https://x.test/a` now')).toEqual([]);
    expect(html('run `curl https://x.test/a` now')).toContain('<code>curl https://x.test/a</code>');
    expect(hrefs('```sh\ncurl https://x.test/a\n```')).toEqual([]);
    // A table's cells are prose, so a URL in one is a link; one in a cell's code span is not.
    expect(hrefs('| a | https://x.test |\n| - | - |\n| `https://y.test` | b |')).toEqual(['https://x.test']);
  });

  it('links mailto and blocks every other scheme, bare or in Markdown', () => {
    expect(hrefs('mail mailto:me@x.test or [me](mailto:me@x.test)')).toEqual(['mailto:me@x.test', 'mailto:me@x.test']);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'vbscript:x', 'ftp://x.test', 'claude://x']) {
      expect(hrefs(`a ${bad} b [t](${bad})`)).toEqual([]);
      expect(safeHref(bad)).toBeNull();
    }
    expect(safeHref('https://')).toBeNull();
    expect(safeHref('mailto:')).toBeNull();
    expect(hrefs('<javascript:alert(1)>')).toEqual([]);
  });

  it('does not link a URL glued to a word or a path', () => {
    expect(hrefs('xhttps://x.test')).toEqual([]);
    expect(hrefs('src/https://x.test')).toEqual([]);
  });

  it('keeps file references as plain text', () => {
    expect(hrefs('see path/to/file.ts:42 and server/main.ts')).toEqual([]);
  });

  it('linkifies plain text (the owner message), escaping the rest', () => {
    expect(linkify('a <b> https://x.test/a. c')).toEqual([
      { type: 'text', text: 'a <b> ' },
      { type: 'link', href: 'https://x.test/a', children: [{ type: 'text', text: 'https://x.test/a' }] },
      { type: 'text', text: '. c' },
    ]);
    expect(linkHtml('a <b> https://x.test/a. c')).toBe('a &lt;b&gt; <a href="https://x.test/a" title="https://x.test/a" class="md-link" rel="noreferrer">https://x.test/a</a>. c');
    expect(linkHtml('no javascript:alert(1) here')).not.toContain('href');
  });
});

describe('tables', () => {
  const offers = [
    'On a fresh run, the Mine shows the ad offers in this order:',
    '| Offer | First appears at |',
    '|---|---|',
    '| **×2 Hit Damage** | **80 Stone** earned this run |',
    '| **×2 Stone** | **100 Stone** earned this run |',
    '| **Auto Tap** | **150 Stone** earned across runs |',
    '',
    'Spending Stone still counts toward all three unlocks.',
  ].join('\n');

  it('reads a GFM table into a header and rows, even right after a paragraph', () => {
    const blocks = markdownToSafe(offers);
    expect(blocks.map((b) => b.type)).toEqual(['para', 'table', 'para']);
    const table = blocks[1] as Extract<(typeof blocks)[number], { type: 'table' }>;
    expect(table.head).toEqual([[{ type: 'text', text: 'Offer' }], [{ type: 'text', text: 'First appears at' }]]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[2]![1]).toEqual([{ type: 'strong', children: [{ type: 'text', text: '150 Stone' }] }, { type: 'text', text: ' earned across runs' }]);
  });

  it('renders a real table with formatted cells, never the raw pipes', () => {
    const out = html(offers);
    expect(out).toContain('<div class="md-table" role="region" aria-label="Table" tabindex="0"><table>');
    expect(out).toContain('<th scope="col">Offer</th>');
    expect(out).toContain('<td><strong>Auto Tap</strong></td>');
    expect(out).not.toContain('|');
    expect(out).not.toContain('**');
  });

  it('keeps column alignment', () => {
    const blocks = markdownToSafe('| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |');
    expect(blocks[0]).toMatchObject({ type: 'table', align: ['left', 'center', 'right', null] });
    expect(html('| n |\n|--:|\n| 1 |')).toContain('<td class="is-right">1</td>');
  });

  it('reads tables without outer pipes, and pads or trims rows to the header', () => {
    const blocks = markdownToSafe('a | b\n--|--\n1 |\n2 | 3 | 4');
    expect(blocks).toHaveLength(1);
    const table = blocks[0] as Extract<(typeof blocks)[number], { type: 'table' }>;
    expect(table.rows.map((r) => r.length)).toEqual([2, 2]);
  });

  it('splits on pipes but not escaped ones or those in code', () => {
    expect(splitRow('| a \\| b | `x | y` | c |')).toEqual(['a | b', '`x | y`', 'c']);
    expect(splitRow('| `` a`|`b `` | z |')).toEqual(['`` a`|`b ``', 'z']);
  });

  it('keeps pipe rows with no delimiter row as written text', () => {
    expect(markdownToSafe('| a | b |\n| 1 | 2 |')).toEqual([{ type: 'pre', text: '| a | b |\n| 1 | 2 |' }]);
  });

  it('does not take a plain sentence with a pipe over a rule for a table', () => {
    expect(markdownToSafe('either a | b\n---').map((b) => b.type)).not.toContain('table');
  });

  it('ends a table at a blank line or a line with no pipe', () => {
    const blocks = markdownToSafe('| a |\n|---|\n| 1 |\nAfter the table');
    expect(blocks.map((b) => b.type)).toEqual(['table', 'para']);
  });
});
