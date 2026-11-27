// Where a Claude session another program runs lives: the terminal or editor app above its
// process, told from `ps` alone (pid, ppid, tty, comm). Nothing of the other app's is read.
import { execFile } from 'node:child_process';
import type { SessionHost } from '../../shared/types.ts';

export interface ProcInfo { ppid: number; tty: string | null; comm: string }

const PS_TIMEOUT_MS = 2000;
/** How far up the tree the walk goes looking for an app it knows. */
const MAX_DEPTH = 16;

/** `ps -A -o pid=,ppid=,tty=,comm=` → pid → its parent, tty (null for none) and command. The
    command is last, as it may hold spaces. */
export function parsePs(stdout: string): Map<number, ProcInfo> {
  const out = new Map<number, ProcInfo>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const tty = m[3]!;
    out.set(Number(m[1]), { ppid: Number(m[2]), tty: /^(\?+|-)$/.test(tty) ? null : tty, comm: m[4]! });
  }
  return out;
}

/** Every running process with one `ps` call (the whole table, so ancestors can be followed).
    Rejects when `ps` fails or times out, so callers can tell "unknown" from "none". `pids` are
    the ones of interest: with none there is nothing to ask. */
export function processTable(pids: number[]): Promise<Map<number, ProcInfo>> {
  if (pids.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,tty=,comm='], { env: { ...process.env, LC_ALL: 'C' }, timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const out = parsePs(String(stdout ?? ''));
        if (out.size === 0) return reject(new Error('ps listed no processes'));
        resolve(out);
      });
  });
}

/** The outermost `.app` folder an absolute executable path lies in (a helper's own app is inside
    its parent's), or null. */
export function appBundle(exe: string): string | null {
  if (!exe.startsWith('/')) return null;
  const i = exe.indexOf('.app/');
  if (i === -1) return null;
  const bundle = exe.slice(0, i + '.app'.length);
  if (bundle.split('/').some((s) => s === '.' || s === '..')) return null;
  return bundle;
}

interface KnownApp {
  name: string;
  /** Bundle names (without .app), matched exactly. */
  bundles: string[];
  /** Executable names, for a binary outside any bundle (Homebrew's kitty, say). */
  exes: string[];
  /** A terminal or editor "Show in" may bring to the front. */
  showable: boolean;
}

const KNOWN: KnownApp[] = [
  { name: 'Terminal', bundles: ['Terminal'], exes: [], showable: true },
  { name: 'iTerm', bundles: ['iTerm', 'iTerm2'], exes: ['iTerm2'], showable: true },
  { name: 'Warp', bundles: ['Warp', 'WarpPreview'], exes: [], showable: true },
  { name: 'Ghostty', bundles: ['Ghostty'], exes: ['ghostty'], showable: true },
  { name: 'kitty', bundles: ['kitty'], exes: ['kitty'], showable: true },
  { name: 'WezTerm', bundles: ['WezTerm'], exes: ['wezterm-gui'], showable: true },
  { name: 'Alacritty', bundles: ['Alacritty'], exes: ['alacritty'], showable: true },
  { name: 'VS Code', bundles: ['Visual Studio Code', 'Visual Studio Code - Insiders'], exes: [], showable: true },
  { name: 'Cursor', bundles: ['Cursor'], exes: [], showable: true },
  // The desktop app has its own "Open in Claude" link. Its CLI lives in a lowercase claude.app,
  // which is not it.
  { name: 'Claude app', bundles: ['Claude'], exes: [], showable: false },
];

function recognise(comm: string): { app: KnownApp; bundle: string | null } | null {
  const bundle = appBundle(comm);
  if (bundle !== null) {
    const name = bundle.slice(bundle.lastIndexOf('/') + 1, -'.app'.length);
    const app = KNOWN.find((k) => k.bundles.includes(name));
    return app ? { app, bundle } : null;
  }
  const exe = comm.slice(comm.lastIndexOf('/') + 1);
  const app = KNOWN.find((k) => k.exes.includes(exe));
  return app ? { app, bundle: null } : null;
}

/** The first app this knows above `pid` (the session's own process is skipped), with the
    session's tty, and the bundle "Show in" opens when the app is a terminal or editor in one.
    Null when `pid` is not in the table. */
export function hostOf(pid: number, table: Map<number, ProcInfo>): { host: SessionHost; bundle: string | null } | null {
  const self = table.get(pid);
  if (!self) return null;
  const tty = self.tty;
  const seen = new Set([pid]);
  let parent = self.ppid;
  for (let depth = 0; depth < MAX_DEPTH && parent > 1 && !seen.has(parent); depth++) {
    seen.add(parent);
    const info = table.get(parent);
    if (!info) break;
    const known = recognise(info.comm);
    if (known) {
      const bundle = known.app.showable ? known.bundle : null;
      return { host: { app: known.app.name, tty, showable: bundle !== null }, bundle };
    }
    parent = info.ppid;
  }
  return { host: { app: null, tty, showable: false }, bundle: null };
}
