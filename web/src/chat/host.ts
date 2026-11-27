// The words a read-only chat uses for where its session runs: the app named from its process's
// ancestors ("Terminal", "iTerm", "VS Code"…), or the generic "other app" when none is known.
import { READ_ONLY_BANNER } from '../../../shared/banners.ts';
import type { SessionHost } from '../../../shared/types.ts';

type Host = SessionHost | null | undefined;
const named = (host: Host): string | null => host?.app ?? null;

/** The header's owner word: "in Terminal · ttys006", else "another app". */
export function hostMeta(host: Host): string {
  const app = named(host);
  if (app === null) return 'another app';
  return host?.tty ? `in ${app} · ${host.tty}` : `in ${app}`;
}

/** The read-only banner: "Running in Terminal (ttys006) — read-only here". */
export function readOnlyText(host: Host): string {
  const app = named(host);
  if (app === null) return READ_ONLY_BANNER;
  return `Running in ${app}${host?.tty ? ` (${host.tty})` : ''} — read-only here`;
}

/** The banner of a Claude chat another app has open, which the owner can still write to. */
export function alongsideText(host: Host): string {
  const app = named(host) ?? 'another app';
  return `Also open in ${app}. What you send here shows there after you reopen it.`;
}

/** Why Move here is off. */
export function moveHereTip(host: Host): string {
  const app = named(host);
  return app === null ? 'Close it in the other app first' : `Close it in ${app} first`;
}

/** The composer's placeholder while the chat is read-only. */
export function readOnlyPlaceholder(host: Host): string {
  const app = named(host);
  return app === null ? 'Read-only — open it in the other app to reply' : `Read-only — open in ${app} to reply`;
}

/** "Show in Terminal", when main can bring that app to the front; else null. */
export function showLabel(host: Host): string | null {
  const app = named(host);
  return app !== null && host?.showable ? `Show in ${app}` : null;
}

/** The empty thread of a session waiting on a prompt in its terminal. */
export function terminalNote(host: Host): string {
  const where = host?.tty ? `its terminal (${host.tty})` : 'its terminal';
  return `This Claude session is waiting on a prompt in ${where} and hasn't been sent a message yet. Answer it there, or close it if you don't need it.`;
}
