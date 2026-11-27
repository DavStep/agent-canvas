import { describe, expect, it } from 'vitest';
import { appBundle, hostOf, parsePs, type ProcInfo } from './host.ts';

/** A fake `ps -A -o pid=,ppid=,tty=,comm=` listing, as macOS prints it. */
const PS = `
    1     0 ??       /sbin/launchd
79646     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
79695 79646 ttys006  login
79696 79695 ttys006  -zsh
79800 79696 ttys006  /Users/demo/.local/bin/claude
`;

/** One chain: the session's process (with its tty) under the given ancestors, nearest first. */
function chain(ancestors: string[], tty: string | null = 'ttys003'): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  const top = 500 + ancestors.length;
  ancestors.forEach((comm, i) => {
    const pid = 501 + i;
    table.set(pid, { ppid: pid === top ? 1 : pid + 1, tty: i === ancestors.length - 1 ? null : tty, comm });
  });
  table.set(500, { ppid: 501, tty, comm: '/Users/demo/.local/bin/claude' });
  return table;
}

describe('parsePs', () => {
  it('reads pid, ppid, tty and the whole command, spaces and all; no tty is null', () => {
    const table = parsePs(`${PS}  23305 23259 ??       /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)\nnot a line\n`);
    expect(table.get(79800)).toEqual({ ppid: 79696, tty: 'ttys006', comm: '/Users/demo/.local/bin/claude' });
    expect(table.get(79646)).toEqual({ ppid: 1, tty: null, comm: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' });
    expect(table.get(23305)?.comm).toBe('/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)');
    expect(table.size).toBe(6);
  });
});

describe('appBundle', () => {
  it('is the outermost .app folder of an executable path, or null', () => {
    expect(appBundle('/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal')).toBe('/System/Applications/Utilities/Terminal.app');
    expect(appBundle('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'))
      .toBe('/Applications/Visual Studio Code.app');
    expect(appBundle('/opt/homebrew/bin/kitty')).toBeNull();
    expect(appBundle('-zsh')).toBeNull();
    expect(appBundle('relative/X.app/Contents/MacOS/X')).toBeNull();
    expect(appBundle('/Applications/../Evil.app/Contents/MacOS/Evil')).toBeNull();
  });
});

describe('hostOf', () => {
  it("the owner's own terminal: Terminal, with the session's tty, and Terminal's bundle to show", () => {
    expect(hostOf(79800, parsePs(PS))).toEqual({
      host: { app: 'Terminal', tty: 'ttys006', showable: true },
      bundle: '/System/Applications/Utilities/Terminal.app',
    });
  });

  it.each([
    ['/Applications/iTerm.app/Contents/MacOS/iTerm2', 'iTerm', '/Applications/iTerm.app'],
    ['/Applications/Warp.app/Contents/MacOS/stable', 'Warp', '/Applications/Warp.app'],
    ['/Applications/Ghostty.app/Contents/MacOS/ghostty', 'Ghostty', '/Applications/Ghostty.app'],
    ['/Applications/kitty.app/Contents/MacOS/kitty', 'kitty', '/Applications/kitty.app'],
    ['/Applications/WezTerm.app/Contents/MacOS/wezterm-gui', 'WezTerm', '/Applications/WezTerm.app'],
    ['/Applications/Alacritty.app/Contents/MacOS/alacritty', 'Alacritty', '/Applications/Alacritty.app'],
    ['/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)', 'VS Code', '/Applications/Visual Studio Code.app'],
    ['/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)', 'Cursor', '/Applications/Cursor.app'],
  ])('%s → %s', (comm, app, bundle) => {
    expect(hostOf(500, chain(['-zsh', 'login', comm]))).toEqual({ host: { app, tty: 'ttys003', showable: true }, bundle });
  });

  it('the Claude desktop app is named but not shown (it has its own link); its own CLI bundle is not it', () => {
    const t = chain([
      '/Users/demo/Library/Application Support/Claude/claude-code/2.1.326/c4434d650cb3/claude.app/Contents/MacOS/claude',
      '/Applications/Claude.app/Contents/Helpers/disclaimer',
      '/Applications/Claude.app/Contents/MacOS/Claude',
    ], null);
    expect(hostOf(500, t)).toEqual({ host: { app: 'Claude app', tty: null, showable: false }, bundle: null });
  });

  it('a terminal binary outside any app bundle is named but cannot be shown', () => {
    expect(hostOf(500, chain(['-zsh', '/opt/homebrew/bin/kitty']))).toEqual({ host: { app: 'kitty', tty: 'ttys003', showable: false }, bundle: null });
  });

  it('nothing recognised (say, tmux under launchd): another app, still with its tty', () => {
    expect(hostOf(500, chain(['-zsh', 'tmux']))).toEqual({ host: { app: null, tty: 'ttys003', showable: false }, bundle: null });
  });

  it('a pid ps does not list → null; a loop in the table ends the walk', () => {
    expect(hostOf(4242, parsePs(PS))).toBeNull();
    const loop = new Map<number, ProcInfo>([[10, { ppid: 11, tty: 'ttys001', comm: 'claude' }], [11, { ppid: 12, tty: 'ttys001', comm: '-zsh' }], [12, { ppid: 11, tty: null, comm: 'x' }]]);
    expect(hostOf(10, loop)).toEqual({ host: { app: null, tty: 'ttys001', showable: false }, bundle: null });
  });
});
