import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { childEnv, codexVersion, dataPaths, demoProfile, devPageUrl, findCodex, loginShellFacts, resolveAppFile } from './paths.ts';

describe('childEnv', () => {
  it('env for children is allowlisted; nothing CLAUDE_CODE_*, ANTHROPIC_* or CLAUDECODE', () => {
    expect(childEnv({ PATH: '/a', HOME: '/h', CLAUDE_CODE_X: '1', CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k', SECRET: 's' }, '/login/bin'))
      .toEqual({ PATH: '/login/bin', HOME: '/h' });
  });

  it('passes ssh-agent, proxy and CA variables (both cases of the proxy ones)', () => {
    const env = {
      HOME: '/h', SSH_AUTH_SOCK: '/tmp/agent.sock', HTTP_PROXY: 'http://p:1', HTTPS_PROXY: 'http://p:2', NO_PROXY: 'localhost',
      http_proxy: 'http://p:3', https_proxy: 'http://p:4', no_proxy: '127.0.0.1', ALL_PROXY: 'socks5://p:5', all_proxy: 'socks5://p:6',
      NODE_EXTRA_CA_CERTS: '/ca.pem', SSL_CERT_FILE: '/cert.pem', SSL_CERT_DIR: '/certs', REQUESTS_CA_BUNDLE: '/bundle.pem',
    };
    expect(childEnv(env, '/bin')).toEqual({ ...env, PATH: '/bin' });
  });

  it("uses the login shell's PATH; without one, the app's PATH plus the usual install folders", () => {
    expect(childEnv({ PATH: '/usr/bin:/bin', HOME: '/h' }, '/opt/homebrew/bin:/h/.nvm/bin:/usr/bin').PATH).toBe('/opt/homebrew/bin:/h/.nvm/bin:/usr/bin');
    expect(childEnv({ PATH: '/usr/bin:/bin', HOME: '/h' }).PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/h/.local/bin');
    // Already there: not added twice.
    expect(childEnv({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/h' }, null).PATH).toBe('/opt/homebrew/bin:/usr/bin:/usr/local/bin:/h/.local/bin');
  });
});

describe('loginShellFacts', () => {
  it("asks one interactive login shell for its PATH and codex, under a timeout, past rc-file chatter", async () => {
    const calls: unknown[][] = [];
    const exec = (file: string, args: string[], options: { timeout: number }, cb: (err: Error | null, stdout: string) => void) => {
      calls.push([file, args[0], options.timeout]);
      expect(args[1]).toContain('$PATH');
      expect(args[1]).toContain('command -v codex');
      cb(null, 'welcome from .zshrc\n@@AC_PATH=/opt/homebrew/bin:/h/.nvm/bin:/usr/bin\n@@AC_CODEX=/opt/tools/bin/codex\n');
    };
    await expect(loginShellFacts(exec, '/bin/zsh')).resolves.toEqual({ path: '/opt/homebrew/bin:/h/.nvm/bin:/usr/bin', codex: '/opt/tools/bin/codex' });
    expect(calls).toEqual([['/bin/zsh', '-ilc', 5000]]);
  });

  it('no codex is null; a failed or timed-out shell gives nothing', async () => {
    const noCodex = (_f: string, _a: string[], _o: unknown, cb: (err: Error | null, stdout: string) => void) => cb(null, '@@AC_PATH=/usr/bin\n@@AC_CODEX=\n');
    await expect(loginShellFacts(noCodex, '/bin/zsh')).resolves.toEqual({ path: '/usr/bin', codex: null });
    const failing = (_f: string, _a: string[], _o: unknown, cb: (err: Error | null, stdout: string) => void) => cb(new Error('timed out'), '');
    await expect(loginShellFacts(failing, '/bin/zsh')).resolves.toEqual({ path: null, codex: null });
  });

  describe('a shell that never answers cannot hold up startup', () => {
    afterEach(() => { vi.useRealTimers(); });
    /** A shell that ignores SIGTERM, waits on stdin, or whose grandchild keeps stdout open: no callback until `answer()`. */
    const hung = () => {
      const seen = { options: null as null | Record<string, unknown>, stdinEnded: 0, kills: [] as unknown[], answer: (_err: Error | null, _out: string) => {} };
      const exec = (_f: string, _a: string[], options: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
        seen.options = options;
        seen.answer = cb;
        return { stdin: { end: () => { seen.stdinEnded++; } }, kill: (signal?: unknown) => { seen.kills.push(signal); return true; } };
      };
      return { exec, seen };
    };

    it("ends the shell's stdin at once and has execFile kill with SIGKILL", async () => {
      const { exec, seen } = hung();
      void loginShellFacts(exec, '/bin/zsh');
      expect(seen.options).toMatchObject({ timeout: 5000, killSignal: 'SIGKILL' });
      expect(seen.stdinEnded).toBe(1);
      seen.answer(null, '@@AC_PATH=/usr/bin\n');
    });

    it('resolves nothing known after the timeout plus a margin, and kills the shell', async () => {
      vi.useFakeTimers();
      const { exec, seen } = hung();
      let result: unknown = 'pending';
      void loginShellFacts(exec, '/bin/zsh').then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(5000);
      expect(result).toBe('pending'); // execFile's own timeout gets its turn first
      await vi.advanceTimersByTimeAsync(1000);
      expect(result).toEqual({ path: null, codex: null });
      expect(seen.kills).toEqual(['SIGKILL']);
    });

    it('a callback after the timer changes nothing, and the result comes once', async () => {
      vi.useFakeTimers();
      const { exec, seen } = hung();
      const results: unknown[] = [];
      const facts = loginShellFacts(exec, '/bin/zsh');
      void facts.then((r) => { results.push(r); });
      await vi.advanceTimersByTimeAsync(6000);
      seen.answer(null, '@@AC_PATH=/late/bin\n@@AC_CODEX=/late/codex\n');
      await vi.advanceTimersByTimeAsync(10);
      await expect(facts).resolves.toEqual({ path: null, codex: null });
      expect(results).toEqual([{ path: null, codex: null }]);
    });

    it('an answer in time clears the timer: nothing is killed later', async () => {
      vi.useFakeTimers();
      const { exec, seen } = hung();
      const facts = loginShellFacts(exec, '/bin/zsh');
      seen.answer(null, '@@AC_PATH=/usr/bin\n@@AC_CODEX=\n');
      await expect(facts).resolves.toEqual({ path: '/usr/bin', codex: null });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seen.kills).toEqual([]);
    });
  });
});

describe('findCodex', () => {
  const unknown = async () => null;
  const CHATGPT = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  /** Each path's `--version` line; a path not listed does not exist. */
  const installed = (versions: Record<string, string | null>, shell: string | null = null, home = '/h') => ({
    loginShell: async () => shell,
    exists: (p: string) => p in versions,
    version: async (p: string) => versions[p] ?? null,
    home,
  });

  it('finds codex off PATH', async () => {
    await expect(findCodex({ loginShell: async () => null, exists: (p) => p === '/opt/homebrew/bin/codex', version: unknown }))
      .resolves.toBe('/opt/homebrew/bin/codex');
    await expect(findCodex({ loginShell: async () => null, exists: () => false, version: unknown })).resolves.toBeNull();
  });

  it('prefers what the login shell finds, if it exists', async () => {
    await expect(findCodex({ loginShell: async () => '/x/bin/codex', exists: () => true, version: unknown })).resolves.toBe('/x/bin/codex');
    await expect(findCodex({ loginShell: async () => 'codex', exists: (p) => p === '/usr/local/bin/codex', version: unknown }))
      .resolves.toBe('/usr/local/bin/codex');
  });

  it('looks in ~/.local/bin after the usual folders', async () => {
    await expect(findCodex({ loginShell: async () => null, exists: (p) => p === '/h/.local/bin/codex', version: unknown, home: '/h' }))
      .resolves.toBe('/h/.local/bin/codex');
  });

  it("runs the newest of those installed, the ChatGPT app's own Codex included", async () => {
    await expect(findCodex(installed({
      '/opt/homebrew/bin/codex': 'codex-cli 0.154.0', [CHATGPT]: 'codex-cli 0.171.0-alpha.13',
    }, '/opt/homebrew/bin/codex'))).resolves.toBe(CHATGPT);
    await expect(findCodex(installed({
      '/opt/homebrew/bin/codex': 'codex-cli 0.172.0', [CHATGPT]: 'codex-cli 0.171.0-alpha.13',
    }))).resolves.toBe('/opt/homebrew/bin/codex');
    // In ~/Applications too.
    await expect(findCodex(installed({
      '/usr/local/bin/codex': 'codex-cli 0.154.0', [`/h${CHATGPT}`]: 'codex-cli 0.160.1',
    }))).resolves.toBe(`/h${CHATGPT}`);
  });

  it('orders versions by number, a release after its pre-releases, and keeps the earlier one on a tie', async () => {
    const pick = (a: string, b: string) => findCodex(installed({ '/opt/homebrew/bin/codex': a, '/usr/local/bin/codex': b }));
    await expect(pick('codex-cli 0.9.0', 'codex-cli 0.10.0')).resolves.toBe('/usr/local/bin/codex');
    await expect(pick('codex-cli 0.171.0-alpha.13', 'codex-cli 0.171.0')).resolves.toBe('/usr/local/bin/codex');
    await expect(pick('codex-cli 0.171.0-alpha.9', 'codex-cli 0.171.0-alpha.13')).resolves.toBe('/usr/local/bin/codex');
    await expect(pick('codex-cli 0.170.0', 'codex-cli 0.171.0-alpha.1')).resolves.toBe('/usr/local/bin/codex');
    await expect(pick('codex-cli 0.171.0', 'codex-cli 0.171.0')).resolves.toBe('/opt/homebrew/bin/codex');
  });

  it('passes over one that will not say its version, unless none will', async () => {
    await expect(findCodex(installed({ '/x/codex': null, [CHATGPT]: 'codex-cli 0.150.0' }, '/x/codex'))).resolves.toBe(CHATGPT);
    await expect(findCodex(installed({ '/x/codex': 'not a version', '/usr/local/bin/codex': null }, '/x/codex'))).resolves.toBe('/x/codex');
  });

  it('asks each program once, even when the login shell names a usual one', async () => {
    const asked: string[] = [];
    const deps = installed({ '/opt/homebrew/bin/codex': 'codex-cli 0.154.0' }, '/opt/homebrew/bin/codex');
    await findCodex({ ...deps, version: async (p) => { asked.push(p); return deps.version(p); } });
    expect(asked).toEqual(['/opt/homebrew/bin/codex']);
  });
});

describe('codexVersion', () => {
  it("reads a program's --version line, and gives null for one that cannot run", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-version-'));
    try {
      const fake = path.join(dir, 'codex');
      writeFileSync(fake, '#!/bin/sh\n[ "$1" = --version ] && echo "codex-cli 9.8.7"\n', { mode: 0o755 });
      await expect(codexVersion(fake)).resolves.toBe('codex-cli 9.8.7');
      await expect(codexVersion(path.join(dir, 'missing'))).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dataPaths', () => {
  it('honours the folder overrides', () => {
    expect(dataPaths({ AGENT_CANVAS_HOME: '/d', CLAUDE_HOME: '/c', CODEX_HOME: '/x' }, '/h'))
      .toEqual({ dataHome: '/d', claudeHome: '/c', codexHome: '/x' });
    expect(dataPaths({}, '/h')).toEqual({ dataHome: '/h/.agent-canvas', claudeHome: '/h/.claude', codexHome: '/h/.codex' });
  });
});

describe('resolveAppFile', () => {
  const root = '/app/web/dist';
  const inside = (p: string | null) => p === null || p.startsWith(root + path.sep);

  it('maps the page and its files into the web folder', () => {
    expect(resolveAppFile(root, 'app://canvas/')).toBe(`${root}/index.html`);
    expect(resolveAppFile(root, 'app://canvas/index.html')).toBe(`${root}/index.html`);
    expect(resolveAppFile(root, 'app://canvas/assets/app%20one.js?v=1')).toBe(`${root}/assets/app one.js`);
  });

  it('never leaves the web folder: .., %2e%2e and %2f', () => {
    for (const url of [
      'app://canvas/../../etc/passwd', 'app://canvas/assets/../../../etc/passwd',
      'app://canvas/%2e%2e/%2e%2e/etc/passwd', 'app://canvas/assets/%2E%2E/%2E%2E/%2E%2E/etc/passwd',
      'app://canvas/..%2f..%2f..%2fetc%2fpasswd', 'app://canvas/assets%2f..%2f..%2f..%2fetc%2fpasswd',
      'app://canvas/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ]) {
      const file = resolveAppFile(root, url);
      expect(inside(file), `${url} → ${file}`).toBe(true);
    }
    expect(resolveAppFile(root, 'app://canvas/..%2f..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(resolveAppFile(root, 'app://canvas/%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toBeNull();
  });

  it('refuses what it cannot decode, NUL bytes and the folder itself', () => {
    expect(resolveAppFile(root, 'app://canvas/%E0%A4%A')).toBeNull();
    expect(resolveAppFile(root, 'app://canvas/index.html%00.js')).toBeNull();
    expect(resolveAppFile(root, 'app://canvas/assets/%2e%2e%2f')).toBeNull();
    expect(resolveAppFile(root, 'not a url')).toBeNull();
  });
});

describe('devPageUrl', () => {
  it('honours only a loopback http address, and never in a packaged app', () => {
    expect(devPageUrl('http://127.0.0.1:5173/', false)).toBe('http://127.0.0.1:5173/');
    expect(devPageUrl('http://localhost:5173', false)).toBe('http://localhost:5173');
    expect(devPageUrl(undefined, false)).toBeNull();
    expect(devPageUrl('', false)).toBeNull();
    expect(devPageUrl('http://127.0.0.1:5173/', true)).toBeNull();
    for (const bad of ['https://localhost:5173', 'http://example.com:5173', 'http://localhost.evil.test:5173', 'http://127.0.0.2:5173',
      'file:///tmp/index.html', 'http://user@localhost:5173', 'not a url', 'http://[::1]:5173']) {
      expect(devPageUrl(bad, false), bad).toBeNull();
    }
  });
});

describe('demoProfile', () => {
  const opts = (alive: (pid: number) => boolean = () => true) => {
    const later: { pid: number; dir: string }[] = [];
    return { later, o: { pid: 4242, alive, removeAfterExit: (pid: number, dir: string) => { later.push({ pid, dir }); } } };
  };

  it('is a fresh folder of its own each run, marked with its owner, and remove() takes it away now and after exit', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ac-demo-test-'));
    try {
      const { later, o } = opts();
      const a = demoProfile(root, o);
      const b = demoProfile(root, o);
      expect(a.dir).not.toBe(b.dir);
      expect(path.dirname(a.dir)).toBe(root);
      expect(readFileSync(path.join(a.dir, 'agent-canvas-demo-owner'), 'utf8')).toBe('4242');
      writeFileSync(path.join(a.dir, 'Local Storage'), 'x');
      a.remove();
      a.remove(); // twice is harmless (quit may run it again)
      expect(existsSync(a.dir)).toBe(false);
      expect(existsSync(b.dir)).toBe(true);
      // Chromium writes its last files as the process ends, so the folder goes again once it has.
      expect(later).toEqual([{ pid: 4242, dir: a.dir }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a new demo sweeps up folders whose demo is gone, and leaves a running demo and other folders alone', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ac-demo-test-'));
    try {
      const mk = (name: string, owner: string | null, ageS = 0) => {
        const d = path.join(root, name);
        mkdirSync(d);
        if (owner !== null) writeFileSync(path.join(d, 'agent-canvas-demo-owner'), owner);
        const t = Date.now() / 1000 - ageS;
        utimesSync(d, t, t);
        return d;
      };
      const dead = mk('agent-canvas-demo-dead01', '111');
      const live = mk('agent-canvas-demo-live01', '222');
      const unmarkedOld = mk('agent-canvas-demo-old001', null, 3600);
      const unmarkedNew = mk('agent-canvas-demo-new001', null); // may be a demo starting this instant
      const other = mk('something-else', '111');
      const { o } = opts((pid) => pid === 222);
      demoProfile(root, o);
      expect([dead, live, unmarkedOld, unmarkedNew, other].map(existsSync)).toEqual([false, true, false, true, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
