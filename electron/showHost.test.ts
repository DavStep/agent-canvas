import { describe, expect, it, vi } from 'vitest';
import type { ProcInfo } from '../server/engines/host.ts';
import { showHost, type ShowHostDeps } from './showHost.ts';

const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';

/** claude (79800) → -zsh → login → `top`, as a fresh `ps` lists them. */
const table = (top: string) => new Map<number, ProcInfo>([
  [79800, { ppid: 79696, tty: 'ttys006', comm: '/Users/demo/.local/bin/claude' }],
  [79696, { ppid: 79695, tty: 'ttys006', comm: '-zsh' }],
  [79695, { ppid: 79646, tty: 'ttys006', comm: 'login' }],
  [79646, { ppid: 1, tty: null, comm: top }],
]);

function deps(patch: { processes?: ShowHostDeps['processes'] } = {}) {
  return {
    pidOf: vi.fn<ShowHostDeps['pidOf']>((id) => (id === 'card-7b' ? 79800 : null)),
    processes: vi.fn<ShowHostDeps['processes']>(patch.processes ?? (async () => table(TERMINAL))),
    open: vi.fn<ShowHostDeps['open']>(async () => {}),
  };
}

describe('showHost', () => {
  it('looks up the pid itself, walks a fresh process table, and opens the app bundle it found', async () => {
    const d = deps();
    await showHost(['card-7b'], d);
    expect(d.pidOf).toHaveBeenCalledWith('card-7b');
    expect(d.processes).toHaveBeenCalledWith([79800]);
    expect(d.open.mock.calls).toEqual([['/System/Applications/Utilities/Terminal.app']]);
  });

  it('refuses anything but a card id, before looking anything up', async () => {
    const d = deps();
    await expect(showHost(['card-7b', '/Applications/Calculator.app'], d)).rejects.toThrow();
    await expect(showHost([{ path: '/Applications/Calculator.app' }], d)).rejects.toThrow();
    expect(d.pidOf).not.toHaveBeenCalled();
    expect(d.open).not.toHaveBeenCalled();
  });

  it('opens nothing for a card with no session elsewhere, or a host it cannot show', async () => {
    const none = deps();
    await expect(showHost(['card-here'], none)).rejects.toThrow(/not running in another app/);
    expect(none.processes).not.toHaveBeenCalled();
    const claudeApp = deps({ processes: vi.fn(async () => table('/Applications/Claude.app/Contents/MacOS/Claude')) });
    await expect(showHost(['card-7b'], claudeApp)).rejects.toThrow(/Could not tell/);
    const tmux = deps({ processes: vi.fn(async () => table('tmux')) });
    await expect(showHost(['card-7b'], tmux)).rejects.toThrow(/Could not tell/);
    // The process is gone since the last poll.
    const gone = deps({ processes: vi.fn(async () => new Map<number, ProcInfo>()) });
    await expect(showHost(['card-7b'], gone)).rejects.toThrow(/Could not tell/);
    for (const d of [claudeApp, tmux, gone]) expect(d.open).not.toHaveBeenCalled();
  });
});
