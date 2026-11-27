// Where things are: the data folders, the `codex` program, and the environment children get.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Variables a provider's child process may see: the basics, the ssh agent (git over ssh),
    proxies and extra CA certificates (MCP servers and tools behind a proxy). Nothing starting
    CLAUDE_CODE_ or ANTHROPIC_, and not CLAUDECODE, is passed, so this app's own environment never
    steers the child. PATH is set separately (see childEnv). */
const CHILD_ENV = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
] as const;

/** Where tools are usually installed, added to the app's own PATH when the login shell's is not known. */
const usualBins = (home: string) => ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin')];

/** The environment children get. A Dock launch has launchd's PATH (/usr/bin:/bin:…), so the
    login shell's PATH (asked once at start, see loginShellFacts) is used when known, else the
    app's own PATH plus the usual install folders: npx, uvx, Homebrew and nvm tools then work. */
export function childEnv(env: NodeJS.ProcessEnv, loginPath: string | null = null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  if (loginPath) {
    out.PATH = loginPath;
  } else {
    const parts = (env.PATH ?? '').split(':').filter((p) => p !== '');
    for (const bin of usualBins(env.HOME || os.homedir())) if (!parts.includes(bin)) parts.push(bin);
    out.PATH = parts.join(':');
  }
  return out;
}

export interface FindCodexDeps {
  /** What `command -v codex` prints in the owner's login shell, or null. */
  loginShell(): Promise<string | null>;
  exists(p: string): boolean;
  /** What `<p> --version` prints, or null when it cannot be run (codexVersion by default). */
  version?(p: string): Promise<string | null>;
  home?: string;
}

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
/** How long after execFile's own timeout the shell is given up on regardless (see loginShellFacts). */
const LOGIN_SHELL_MARGIN_MS = 500;

/** execFile, as far as loginShellFacts uses it: the child it returns may be ended and killed. */
type ExecFile = (
  file: string, args: string[], options: { timeout: number; killSignal: NodeJS.Signals; env: Record<string, string> },
  callback: (err: Error | null, stdout: string) => void,
) => { stdin?: { end(): unknown } | null; kill?(signal?: NodeJS.Signals): unknown } | void;

/** What the owner's login shell says: its PATH, and where `codex` is; null where it could not tell. */
export interface ShellFacts { path: string | null; codex: string | null }

const PATH_MARK = '@@AC_PATH=';
const CODEX_MARK = '@@AC_CODEX=';
const SHELL_SCRIPT = `printf '\\n${PATH_MARK}%s\\n' "$PATH"; printf '${CODEX_MARK}%s\\n' "$(command -v codex)"`;

/** Asks the owner's shell once, so a Dock launch (minimal PATH) still sees what the terminal sees.
    Interactive as well as login (`-ilc`): zsh reads ~/.zshrc only for interactive shells, and that
    is where PATH is often set. The answers are marked lines, as rc files may print first.
    Startup waits on this, so it always ends: stdin is closed at once (an rc file reading input
    gets EOF), the timeout kills with SIGKILL (an interactive zsh ignores SIGTERM), and a timer of
    its own gives up a little later even if the callback never comes (a grandchild holding stdout
    open), killing the shell. Nothing known then, and childEnv's fallback PATH applies. */
export async function loginShellFacts(
  exec: ExecFile = execFile, shell = process.env.SHELL || '/bin/zsh', timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
): Promise<ShellFacts> {
  return new Promise((resolve) => {
    let done = false;
    let child: ReturnType<ExecFile> = undefined;
    const finish = (facts: ShellFacts) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(facts);
    };
    const timer = setTimeout(() => {
      if (done) return;
      try { child?.kill?.('SIGKILL'); } catch { /* gone already */ }
      finish({ path: null, codex: null });
    }, timeoutMs + LOGIN_SHELL_MARGIN_MS);
    timer.unref?.();
    try {
      child = exec(shell, ['-ilc', SHELL_SCRIPT], { timeout: timeoutMs, killSignal: 'SIGKILL', env: childEnv(process.env) }, (err, stdout) => {
        if (err) return finish({ path: null, codex: null });
        const lines = String(stdout ?? '').split('\n').map((l) => l.trim());
        const marked = (mark: string) => {
          const line = lines.findLast((l) => l.startsWith(mark));
          return line ? line.slice(mark.length).trim() || null : null;
        };
        finish({ path: marked(PATH_MARK), codex: marked(CODEX_MARK) });
      });
      child?.stdin?.end();
    } catch {
      finish({ path: null, codex: null });
    }
  });
}

const realDeps: FindCodexDeps = { loginShell: async () => (await loginShellFacts()).codex, exists: existsSync };

/** The Codex the ChatGPT app ships and keeps up to date (its codex-package.json entrypoint). */
const CHATGPT_CODEX = 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const VERSION_TIMEOUT_MS = 5_000;

/** What `<program> --version` prints, or null when it fails, is killed at the timeout, or prints nothing. */
export function codexVersion(program: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(program, ['--version'], { timeout: timeoutMs, killSignal: 'SIGKILL', env: childEnv(process.env) },
        (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

interface Version { parts: number[]; pre: string | null }

/** `codex-cli 0.171.0-alpha.13` → [0, 171, 0] and "alpha.13"; null for anything else. */
function parseVersion(line: string | null): Version | null {
  const m = line?.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}

/** Above 0 when a is newer. A release is newer than its own pre-releases; pre-releases compare
    with their numbers as numbers (alpha.13 after alpha.9). */
function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i]! - b.parts[i]!;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre.localeCompare(b.pre, 'en', { numeric: true });
}

/** Installed candidates in tie-break order, without spawning any programs. */
export function installedCodexPaths(fromShell: string | null, home = os.homedir(), exists: (p: string) => boolean = existsSync): string[] {
  const candidates = [
    // An alias or function prints a bare name; only an absolute path is a program we can run.
    ...(fromShell !== null && path.isAbsolute(fromShell) ? [fromShell] : []),
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local/bin/codex'),
    path.join('/', CHATGPT_CODEX), path.join(home, CHATGPT_CODEX),
  ];
  return [...new Set(candidates)].filter((p) => exists(p));
}

/** The `codex` program to run: of the login shell's answer, the usual install folders and the
    ChatGPT app's own copy, the newest that says its version (the earlier one in that order on a
    tie). The ChatGPT app updates its copy itself, and newer models (and the config.toml naming
    one) need a newer Codex. If none says its version, the first that exists; null if none does. */
export async function findCodex(deps: FindCodexDeps = realDeps): Promise<string | null> {
  const present = installedCodexPaths(await deps.loginShell(), deps.home, deps.exists);
  const version = deps.version ?? codexVersion;
  const versions = await Promise.all(present.map(async (p) => parseVersion(await version(p).catch(() => null))));
  let best: { program: string; version: Version } | null = null;
  for (let i = 0; i < present.length; i++) {
    const v = versions[i];
    if (v && (best === null || compareVersions(v, best.version) > 0)) best = { program: present[i]!, version: v };
  }
  return best?.program ?? present[0] ?? null;
}

export interface DataPaths { dataHome: string; claudeHome: string; codexHome: string }

/** This app's folder and the two providers' folders, with the AGENT_CANVAS_HOME, CLAUDE_HOME and
    CODEX_HOME overrides. */
export function dataPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): DataPaths {
  return {
    dataHome: env.AGENT_CANVAS_HOME || path.join(home, '.agent-canvas'),
    claudeHome: env.CLAUDE_HOME || path.join(home, '.claude'),
    codexHome: env.CODEX_HOME || path.join(home, '.codex'),
  };
}

/** The file under `root` an app:// page URL names, or null when it names nothing there: the URL
    cannot be read, or its decoded path (where %2e%2e and %2f become .. and /) leaves the folder. */
export function resolveAppFile(root: string, url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  return file.startsWith(root + path.sep) ? file : null;
}

/** VITE_DEV_URL (set by `npm run dev`), only for a Vite server on this Mac's loopback over plain
    http, and never in a packaged app. */
export function devPageUrl(value: string | undefined, isPackaged: boolean): string | null {
  if (isPackaged || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  return url.protocol === 'http:' && loopback && url.username === '' && url.password === '' ? value : null;
}

const DEMO_PREFIX = 'agent-canvas-demo-';
const DEMO_OWNER = 'agent-canvas-demo-owner';
/** An unmarked demo folder younger than this may be one whose demo is starting right now. */
const UNMARKED_GRACE_MS = 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes `dir` once process `pid` has ended: Chromium writes its last profile files as it exits. */
function removeAfterExit(pid: number, dir: string): void {
  const child = spawn('/bin/sh', ['-c', 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; rm -rf -- "$1"', String(pid), dir], {
    detached: true, stdio: 'ignore',
  });
  child.on('error', () => { /* best effort: the next demo sweeps it */ });
  child.unref();
}

/** Demo folders left by demos that are gone (a crash, or a removal that lost to Chromium's last write). */
function sweepDemoProfiles(root: string, alive: (pid: number) => boolean): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(DEMO_PREFIX)) continue;
    const dir = path.join(root, name);
    try {
      let owner: number | null = null;
      try { owner = Number(readFileSync(path.join(dir, DEMO_OWNER), 'utf8')); } catch { /* unmarked */ }
      const stale = owner !== null && Number.isInteger(owner) && owner > 0
        ? !alive(owner)
        : Date.now() - statSync(dir).mtimeMs > UNMARKED_GRACE_MS;
      if (stale) rmSync(dir, { recursive: true, force: true });
    } catch {
      // not ours to judge (gone already, or not readable)
    }
  }
}

/** The demo's own Chromium profile (localStorage, caches, cookies): a fresh folder under the
    system's temp folder each run, so the demo never reads or writes the real app's. It is marked
    with its process id; remove() takes it away now and again once the process has ended, and a
    new demo sweeps up any a gone demo left behind. */
export function demoProfile(
  root: string = os.tmpdir(),
  opts: { pid?: number; alive?: (pid: number) => boolean; removeAfterExit?: (pid: number, dir: string) => void } = {},
): { dir: string; remove(): void } {
  const pid = opts.pid ?? process.pid;
  sweepDemoProfiles(root, opts.alive ?? pidAlive);
  const dir = mkdtempSync(path.join(root, DEMO_PREFIX));
  writeFileSync(path.join(dir, DEMO_OWNER), String(pid));
  let scheduled = false;
  return {
    dir,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
      if (scheduled) return;
      scheduled = true;
      (opts.removeAfterExit ?? removeAfterExit)(pid, dir);
    },
  };
}
