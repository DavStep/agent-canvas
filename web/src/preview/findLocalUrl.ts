// The local address a session's command printed (a dev server's "Local: http://localhost:5173/"),
// which the Browser tab opens by itself. Only loopback http with a port qualifies, as the main
// process allows nothing else to open without the owner typing it.
import { TRIMMED } from '../../../server/engines/chatLog.ts';

/** Escape sequences terminals draw with: CSI (colours, cursor moves), OSC (titles, links), and
    the two-character ones. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Host and port, then optionally a path; the port must end at a character no address continues with. */
const LOCAL = /http:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})(?![\w-]|\.\w)((?:[/?#][^\s'"<>`]*)?)/g;
// Fetch restricted ports. Skip incidental addresses
// such as SSH or port 1 in test output and keep scanning for the actual web app.
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** The first local address in `text`, and whether it runs to the very end (so more output may
    still lengthen it). */
function firstLocal(text: string): { url: string; atEnd: boolean } | null {
  const clean = stripAnsi(text);
  for (const m of clean.matchAll(LOCAL)) {
    const port = Number(m[1]);
    if (port < 1 || port > 65_535 || BLOCKED_PORTS.has(port)) continue;
    return { url: m[0].replace(TRAILING, ''), atEnd: m.index + m[0].length === clean.length };
  }
  return null;
}

export function findLocalUrl(text: string): string | null {
  return firstLocal(text)?.url ?? null;
}

/** Characters of each output read again on the next look, so an address split across chunks
    (even inside its escape codes) is still found whole. */
const OVERLAP = 1024;

/**
 * Finds a session's local address as command output streams in: each look reads only what is
 * new in each output (plus a small overlap), never the whole output again, and the first address
 * found is kept for the session. An address that reaches the end of a still-running output waits
 * for the next chunk, which may continue it.
 *
 * Past the chat log's 256 KB cap the kept output stays about the same length while its content
 * moves, so progress is counted in characters ever streamed (outputDropped + the kept part), not
 * in the current length. The overlap read last time must still be where that count puts it;
 * otherwise the output was replaced (a final output over what streamed) and is read from the start.
 */
export class LocalUrlScanner {
  /** Per output: how many characters of it had streamed when it was read, its last OVERLAP
      characters then, and whether it had finished by then. */
  private readonly read = new Map<string, { total: number; tail: string; finished: boolean }>();
  private found: string | null = null;
  /** Characters examined so far (for tests). */
  charsRead = 0;

  scan(outputs: { id: string; output: string | null; status: string; outputDropped?: number }[]): string | null {
    if (this.found !== null) return this.found;
    for (const o of outputs) {
      const out = o.output ?? '';
      const dropped = o.outputDropped ?? 0;
      // Where the kept part starts: after the chat log's marker once it has dropped anything.
      const head = dropped > 0 && out.startsWith(TRIMMED) ? TRIMMED.length : 0;
      const total = dropped + out.length - head;
      const running = o.status === 'running' || o.status === 'waiting';
      const before = this.read.get(o.id);
      // Nothing new, unless it just finished: an address at its very end now counts.
      if (before && before.total === total && (running || before.finished)) continue;
      const from = before && total >= before.total ? this.resume(out, head, dropped, before) : 0;
      const text = out.slice(from);
      this.charsRead += text.length;
      this.read.set(o.id, { total, tail: out.slice(Math.max(head, out.length - OVERLAP)), finished: !running });
      const hit = firstLocal(text);
      if (hit && (!hit.atEnd || !running)) {
        this.found = hit.url;
        return hit.url;
      }
    }
    return null;
  }

  /** Where to read on from in `out`: the start of last time's overlap, if it is still there (as
      much of it as the cap kept), else 0 (replaced, so read it all). */
  private resume(out: string, head: number, dropped: number, before: { total: number; tail: string }): number {
    const end = head + before.total - dropped; // last look's end, in this output
    if (end < head) return head; // all of it dropped since: everything kept is new
    const start = end - before.tail.length;
    const from = Math.max(head, start);
    return out.slice(from, end) === before.tail.slice(from - start) ? from : 0;
  }
}
