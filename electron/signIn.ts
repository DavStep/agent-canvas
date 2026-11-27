// While Claude Code is signed out, the composer is blocked and new starts are refused, so nothing
// in the app would ever ask again. The owner signs in in a terminal (`claude`, then /login): main
// looks again when the window gains focus and every 30 s while it is visible, and once Claude says
// signed in the banner goes and the page is told the accounts changed.
import { SIGNED_OUT_BANNER } from '../shared/banners.ts';
import type { Engine } from '../server/engines/engine.ts';

export const SIGN_IN_CHECK_MS = 30_000;

export interface SignInWatchOptions {
  engine: Pick<Engine, 'banner' | 'account'>;
  /** Whether the window is on screen now. */
  visible(): boolean;
  /** Claude said signed in: republish the snapshot and push "accounts changed". */
  onSignedIn(): void | Promise<void>;
  everyMs?: number;
}

export class SignInWatch {
  private timer: NodeJS.Timeout | null = null;
  private looking: Promise<void> | null = null;

  constructor(private readonly opts: SignInWatchOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.opts.visible()) void this.check();
    }, this.opts.everyMs ?? SIGN_IN_CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The window gained focus. */
  focus(): Promise<void> {
    return this.check();
  }

  /** One look while signed out; a look under way is not doubled. */
  private check(): Promise<void> {
    if (this.opts.engine.banner !== SIGNED_OUT_BANNER) return Promise.resolve();
    if (this.looking) return Promise.resolve();
    this.looking = (async () => {
      try {
        await this.opts.engine.account(); // clears the engine's banner when signed in
        if (this.opts.engine.banner !== SIGNED_OUT_BANNER) await this.opts.onSignedIn();
      } catch {
        // Still signed out as far as anyone knows; the next look tries again.
      } finally {
        this.looking = null;
      }
    })();
    return this.looking;
  }
}
