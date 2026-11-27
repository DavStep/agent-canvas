// The profile page's words for plans and usage windows, in the owner's local time.
import type { AccountsView, UsageWindow } from '../../../shared/account.ts';

const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PLANS: Record<string, string> = { pro: 'Pro', max: 'Max', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };

const two = (n: number): string => String(n).padStart(2, '0');

/** "Thu 14:00" in local time; a week or more away it names the date too; a time already past is "now". */
export function resetLabel(at: number, now: number): string {
  if (at <= now) return 'now';
  const d = new Date(at);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const day = WEEKDAYS[d.getDay()]!;
  return at - now >= 6 * DAY ? `${day} ${d.getDate()} ${MONTHS[d.getMonth()]} ${time}` : `${day} ${time}`;
}

/** "10% used · resets Thu 14:00", or "Not reported" when the provider gave no number. */
export function usageLine(w: UsageWindow, now: number): string {
  if (w.usedPercent === null) return 'Not reported';
  const used = `${Math.round(w.usedPercent)}% used`;
  return w.resetsAt === null ? used : `${used} · resets ${resetLabel(w.resetsAt, now)}`;
}

/** The bar's filled share, 0–100. */
export function barPercent(p: number | null): number {
  return p === null ? 0 : Math.min(100, Math.max(0, p));
}

/** A plan as words: "pro" → "Pro", "claude_team" → "Claude team"; labels already written stay. */
export function planLabel(plan: string | null): string | null {
  if (plan === null || plan.trim() === '') return null;
  const known = PLANS[plan.toLowerCase()];
  if (known) return known;
  const words = plan.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The avatar's letter: the Claude email's initial, else Codex's, else none (a neutral glyph). */
export function avatarInitial(accounts: AccountsView | null): string | null {
  for (const email of [accounts?.claude.email, accounts?.codex.email]) {
    const first = email?.trim().charAt(0);
    if (first) return first.toUpperCase();
  }
  return null;
}
