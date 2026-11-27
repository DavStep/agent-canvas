import { describe, expect, it } from 'vitest';
import { applyUpdate, MAX_OUTPUT, TRIMMED } from '../../../server/engines/chatLog.ts';
import type { ChatItem, ChatState } from '../../../shared/chat.ts';
import { findLocalUrl, LocalUrlScanner, stripAnsi } from './findLocalUrl.ts';

describe('findLocalUrl', () => {
  it('skips a restricted port and keeps looking for a working web port', () => {
    const scan = new LocalUrlScanner();
    expect(scan.scan([{ id: 'a', status: 'done', output: 'Test endpoint http://127.0.0.1:1/' }])).toBeNull();
    expect(scan.scan([{ id: 'b', status: 'done', output: 'http://localhost:22/ then http://localhost:5173/' }])).toBe('http://localhost:5173/');
  });

  it('finds a Vite-style localhost address in command output', () => {
    const out = '\n  VITE v8.3.8  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n';
    expect(findLocalUrl(out)).toBe('http://localhost:5173/');
  });

  it('finds a 127.0.0.1 address with a port and no path', () => {
    expect(findLocalUrl('reader listening on http://127.0.0.1:4747')).toBe('http://127.0.0.1:4747');
  });

  it('ignores addresses that are not this machine, and https ones', () => {
    expect(findLocalUrl('docs at https://example.com and http://example.com:8080/')).toBeNull();
    expect(findLocalUrl('https://localhost:5173/')).toBeNull();
    expect(findLocalUrl('no address here')).toBeNull();
  });

  it('needs a port: only a printed dev server address opens by itself', () => {
    expect(findLocalUrl('http://localhost/ is not it')).toBeNull();
    expect(findLocalUrl('see http://localhost/, then http://localhost:3000/app')).toBe('http://localhost:3000/app');
  });

  it('strips ANSI codes first (Vite prints the port in bold)', () => {
    const out = '  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n';
    expect(findLocalUrl(out)).toBe('http://localhost:5173/');
  });

  it('returns the first address and leaves trailing punctuation off', () => {
    expect(findLocalUrl('Open (http://localhost:8080/admin). Also http://127.0.0.1:9000')).toBe('http://localhost:8080/admin');
    expect(findLocalUrl("served at 'http://127.0.0.1:4173/',")).toBe('http://127.0.0.1:4173/');
    expect(findLocalUrl('listening on http://127.0.0.1:4747.')).toBe('http://127.0.0.1:4747');
  });

  it('does not take a host that merely starts with localhost', () => {
    expect(findLocalUrl('http://localhost.evil.test:80/ and http://127.0.0.1.nip.io:8080/')).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes colour, cursor and OSC sequences and keeps the text', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b[2K\u001b[1Gdone \u001b]8;;http://x\u0007link\u001b]8;;\u0007')).toBe('red done link');
  });
});

describe('LocalUrlScanner: finding the address as output streams, without rescanning it all', () => {
  const cmd = (id: string, output: string, status: 'running' | 'done' = 'running') => ({ id, output, status });

  it('finds an address split across two chunks (even its port)', () => {
    const scan = new LocalUrlScanner();
    let out = '  VITE ready\n  ➜  Local:   http://localhost:51';
    expect(scan.scan([cmd('c1', out)])).toBeNull();
    out += '73/\n  ➜  Network: use --host\n';
    expect(scan.scan([cmd('c1', out)])).toBe('http://localhost:5173/');
  });

  it('an address at the very end of a finished command counts', () => {
    const scan = new LocalUrlScanner();
    expect(scan.scan([cmd('c1', 'listening on http://127.0.0.1:4747')])).toBeNull();
    expect(scan.scan([cmd('c1', 'listening on http://127.0.0.1:4747', 'done')])).toBe('http://127.0.0.1:4747');
  });

  it('keeps the first address found for the session, and reads each chunk only once more than its overlap', () => {
    const scan = new LocalUrlScanner();
    let out = '';
    for (let n = 0; n < 200; n++) {
      out += `${'noise '.repeat(200)}\n`;
      expect(scan.scan([cmd('c1', out)])).toBeNull();
    }
    // Read ≈ the output once, plus a bounded overlap per look, not the whole output on every chunk.
    expect(scan.charsRead).toBeLessThan(out.length + 200 * 1100);
    out += 'Local: http://localhost:3000/\n';
    expect(scan.scan([cmd('c1', out)])).toBe('http://localhost:3000/');
    expect(scan.scan([cmd('c1', out), cmd('c2', 'http://localhost:9999/\n')])).toBe('http://localhost:3000/');
  });

  it('an output that was replaced (shorter now) is read again from the start', () => {
    const scan = new LocalUrlScanner();
    expect(scan.scan([cmd('c1', 'x'.repeat(5000))])).toBeNull();
    expect(scan.scan([cmd('c1', 'at http://localhost:8080/ now\n')])).toBe('http://localhost:8080/');
  });

  describe('past the 256 KB cap, where the chat log keeps only the tail', () => {
    type Tool = Extract<ChatItem, { kind: 'tool' }>;
    /** A command whose output streams through the real chat log, cap and all. */
    const stream = () => {
      let state: ChatState = {
        sessionId: 's1', provider: 'codex', owner: 'here', title: 'T', cwd: '/w', items: [
          { kind: 'tool', id: 'c1', at: 1, tool: 'command', name: 'Bash', target: 'npm run dev', status: 'running', output: null, exitCode: null, diffs: [] },
        ], hasOlder: false, turn: 'running', model: null, models: [], mode: 'auto', modes: [], banner: null,
      };
      let appended = 0;
      return {
        append(chunk: string) {
          appended += chunk.length;
          state = applyUpdate(state, { op: 'append', id: 'c1', field: 'output', chunk });
        },
        /** An upsert over what streamed, as a final output is. */
        replace(output: string, status: Tool['status'] = 'done') {
          state = applyUpdate(state, { op: 'upsert', item: { ...(state.items[0] as Tool), output, status } });
        },
        tool: () => state.items[0] as Tool,
        appended: () => appended,
      };
    };
    /** A 1025-character line (or `width`), ending in a newline. */
    const line = (n: number, width = 1025) => `${'noise '.repeat(200)}`.slice(0, width - 5) + `${String(n).padStart(4, '0')}\n`;
    /** The characters one look examined. */
    const look = (scan: LocalUrlScanner, s: ReturnType<typeof stream>) => {
      const before = scan.charsRead;
      const url = scan.scan([s.tool()]);
      return { url, read: scan.charsRead - before };
    };

    it('an address printed once the output is being trimmed is found', () => {
      const scan = new LocalUrlScanner();
      const s = stream();
      for (let n = 0; n < 400; n++) {
        s.append(line(n));
        expect(scan.scan([s.tool()])).toBeNull();
      }
      expect(s.tool().output!.startsWith(TRIMMED)).toBe(true);
      expect(s.appended()).toBeGreaterThan(MAX_OUTPUT + 100_000);
      // A chunk the same size as the ones before: the kept output's length does not change.
      const address = '  ➜  Local:   http://localhost:5173/ ';
      s.append(`${address}${line(400, 1025 - address.length)}`);
      const { url, read } = look(scan, s);
      expect(url).toBe('http://localhost:5173/');
      expect(read).toBeLessThan(1025 + 1100);
    });

    it('reads each chunk once plus its overlap, not the whole kept 256 KB on every chunk', () => {
      const scan = new LocalUrlScanner();
      const s = stream();
      for (let n = 0; n < 600; n++) {
        s.append(line(n, 1024)); // lines that make the kept output shorter every other chunk
        const { url, read } = look(scan, s);
        expect(url).toBeNull();
        expect(read).toBeLessThan(1024 + 1100);
      }
      expect(s.tool().output!.startsWith(TRIMMED)).toBe(true);
      expect(scan.charsRead).toBeLessThan(s.appended() + 600 * 1100);
    });

    it('an address split across the chunk boundary right after a trim is still found', () => {
      const scan = new LocalUrlScanner();
      const s = stream();
      let n = 0;
      // Up to just under the cap, so the next chunk is the one that makes the log trim.
      while (s.appended() + 1025 <= MAX_OUTPUT) s.append(line(n++));
      expect(scan.scan([s.tool()])).toBeNull();
      expect(s.tool().output!.startsWith(TRIMMED)).toBe(false);
      s.append(`${line(n++)}  ➜  Local:   http://local`);
      expect(s.tool().output!.startsWith(TRIMMED)).toBe(true);
      const first = look(scan, s);
      expect(first.url).toBeNull();
      expect(first.read).toBeLessThan(1100 + 1100);
      s.append('host:5173/\n  ➜  Network: use --host\n');
      const second = look(scan, s);
      expect(second.url).toBe('http://localhost:5173/');
      expect(second.read).toBeLessThan(1100 + 100);
    });

    it('a final output over 256 KB that replaces a trimmed streamed one is read afresh', () => {
      const scan = new LocalUrlScanner();
      const s = stream();
      for (let n = 0; n < 400; n++) {
        s.append(line(n));
        scan.scan([s.tool()]);
      }
      // Longer than what streamed, and different from its first character: the address sits early in what is kept.
      s.replace(`${'other '.repeat(30_000)}\nLocal: http://localhost:4321/\n${'tail '.repeat(40_000)}\n`);
      expect(s.tool().output!.startsWith(TRIMMED)).toBe(true);
      expect(scan.scan([s.tool()])).toBe('http://localhost:4321/');
    });

    it('a final output that replaces a trimmed streamed one is still read from the start', () => {
      const scan = new LocalUrlScanner();
      const s = stream();
      for (let n = 0; n < 300; n++) {
        s.append(line(n));
        scan.scan([s.tool()]);
      }
      // Codex's aggregated output, upserted over what streamed: shorter, and new from its first character.
      expect(scan.scan([{ id: 'c1', output: 'served at http://127.0.0.1:4173/ for you\n', status: 'done' }])).toBe('http://127.0.0.1:4173/');
    });
  });
});
