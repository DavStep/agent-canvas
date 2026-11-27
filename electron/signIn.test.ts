import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccount } from '../shared/account.ts';
import { SIGNED_OUT_BANNER } from '../shared/banners.ts';
import type { Engine } from '../server/engines/engine.ts';
import { Store } from '../server/store.ts';
import { ReplyTracker } from '../server/state.ts';
import { SignInWatch } from './signIn.ts';

const account = (signedIn: boolean): ProviderAccount =>
  ({ provider: 'claude', signedIn, email: signedIn ? 'me@example.com' : null, plan: null, windows: [], note: signedIn ? null : SIGNED_OUT_BANNER });

/** A Claude engine stand-in that is signed out until `signIn()`; account() reports and clears it as the real one does. */
function fakeClaude() {
  let signedOut = true;
  let loggedIn = false;
  const engine = {
    provider: 'claude' as const,
    get banner() { return signedOut ? SIGNED_OUT_BANNER : null; },
    account: vi.fn(async () => { signedOut = !loggedIn; return account(loggedIn); }),
    owned: () => new Set<string>(), releasing: () => new Set<string>(), lost: () => {}, busy: () => [],
  };
  return { engine, signIn: () => { loggedIn = true; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('SignInWatch: a signed-out Claude is looked at again until it is signed in', () => {
  it('on window focus, while signed out: account() again; once it says signed in, the banner goes and accounts are pushed', async () => {
    const { engine, signIn } = fakeClaude();
    const changed = vi.fn();
    const watch = new SignInWatch({ engine, visible: () => true, onSignedIn: changed, everyMs: 30_000 });
    await watch.focus();
    expect(engine.account).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(engine.banner).toBe(SIGNED_OUT_BANNER);
    signIn();
    await watch.focus();
    expect(engine.account).toHaveBeenCalledTimes(2);
    expect(engine.banner).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    // Signed in: nothing more is asked.
    await watch.focus();
    expect(engine.account).toHaveBeenCalledTimes(2);
  });

  it('every 30 s while the window is visible, and never while it is hidden', async () => {
    vi.useFakeTimers();
    const { engine, signIn } = fakeClaude();
    let visible = false;
    const changed = vi.fn();
    const watch = new SignInWatch({ engine, visible: () => visible, onSignedIn: changed, everyMs: 30_000 });
    watch.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.account).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.account).toHaveBeenCalledTimes(1);
    signIn();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.account).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(engine.account).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it('one look at a time: a focus while a look is under way asks nothing more', async () => {
    const { engine } = fakeClaude();
    let release!: () => void;
    engine.account.mockImplementationOnce(() => new Promise((r) => { release = () => r(account(false)); }));
    const watch = new SignInWatch({ engine, visible: () => true, onSignedIn: () => {}, everyMs: 30_000 });
    const first = watch.focus();
    await watch.focus();
    expect(engine.account).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('a look that fails leaves the banner and tries again next time', async () => {
    const { engine } = fakeClaude();
    engine.account.mockRejectedValueOnce(new Error('boom'));
    const watch = new SignInWatch({ engine, visible: () => true, onSignedIn: () => {}, everyMs: 30_000 });
    await watch.focus();
    await watch.focus();
    expect(engine.account).toHaveBeenCalledTimes(2);
  });

  it('with the store: signed out, then signed in → the published snapshot loses the banner', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-signin-'));
    try {
      await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
      const { engine, signIn } = fakeClaude();
      const store = new Store({
        claudeHome: home, layout: { version: 1, zones: [], assignments: {} }, replies: new ReplyTracker(),
        engines: { claude: engine as unknown as Engine }, minGapMs: 0,
      });
      await store.poll();
      expect(store.snapshot().banners.claude).toEqual({ text: SIGNED_OUT_BANNER, blocking: true });
      const published = vi.fn();
      store.onChange(published);
      const watch = new SignInWatch({ engine, visible: () => true, onSignedIn: () => store.poll(), everyMs: 30_000 });
      signIn();
      await watch.focus();
      expect(store.snapshot().banners.claude).toBeNull();
      expect(published).toHaveBeenCalled();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
