// The banners the engines show, and which of them stop work. Shared by main (new-session checks,
// the snapshot) and the page (the composer), so both agree on what blocks.

/** Another program has the session: read only here (joined to a provider reason with " · "). */
export const READ_ONLY_BANNER = 'Open in another app — read-only here';
/** Said once in a Claude chat the owner writes to while another program has it open. */
export const WRITING_ALONGSIDE = 'Also open in another app. It shows what you send here only after you reopen the session there.';
/** Why a send to a Claude chat open elsewhere waits: the other program is in the middle of a turn. */
export const BUSY_ELSEWHERE = 'Still working in the other app. Send when it finishes.';

/** Whether another program is in the middle of a turn in a card's session: working, or waiting
    on an approval, a question or a terminal prompt of its own. A finished reply is not a turn. */
export function busyElsewhere(card: { owner: string; state: string; need: string | null } | null | undefined): boolean {
  if (!card || card.owner !== 'elsewhere') return false;
  return card.state === 'working' || (card.state === 'needs_you' && card.need !== 'reply');
}
export const SIGNED_OUT_BANNER = 'Claude Code is signed out on this Mac. Run claude, then /login.';
export const MISSING_BANNER = 'Codex not found';
export const NOT_STARTED_BANNER = "Codex didn't start";
/** A Codex request went unanswered for a long while; later requests may still work. */
export const NO_ANSWER_BANNER = "Codex didn't answer";

/** A provider's banner as the snapshot carries it: its text, and whether it stops sending and
    new sessions (missing, didn't start, signed out) or is a warning only. */
export interface ProviderBanner { text: string; blocking: boolean }

const BLOCKING = new Set([SIGNED_OUT_BANNER, MISSING_BANNER, NOT_STARTED_BANNER]);

export function isBlockingBanner(text: string): boolean {
  return BLOCKING.has(text);
}

export function providerBanner(text: string | null): ProviderBanner | null {
  return text === null ? null : { text, blocking: isBlockingBanner(text) };
}
