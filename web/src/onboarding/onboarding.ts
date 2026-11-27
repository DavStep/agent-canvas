// The permissions sheet's rows: what Agent canvas needs from macOS and from the agents' own tools,
// each with why, a state and at most one button. Only what the app really uses is listed, and
// only what is required opens the sheet by itself (web/src/onboarding/PermissionsSheet.tsx).
import type { AccountsView, ProviderAccount } from '../../../shared/account.ts';
import type { AcpAgentView } from '../../../shared/acp.ts';
import type { PermissionKind, PermissionsView } from '../../../shared/permissions.ts';

export type RowId = 'notifications' | 'claude' | 'codex' | 'acp';
/** ready: nothing to do. missing: needed and not there. optional: worth having, not needed.
    unavailable: cannot be had in this build. checking: not read yet. */
export type RowState = 'ready' | 'missing' | 'optional' | 'unavailable' | 'checking';
export type RowAction = { kind: 'ask'; permission: PermissionKind; label: string };

export interface Row {
  id: RowId;
  group: 'mac' | 'agents';
  title: string;
  why: string;
  state: RowState;
  /** The state as a word or two, beside the dot. */
  status: string;
  /** What to do, when there is something to do here rather than in a terminal. */
  action: RowAction | null;
  /** A terminal command that sets it up (`claude` then /login…), shown when not ready. */
  how: string | null;
}

function notificationsRow(p: PermissionsView | null): Row {
  const base = {
    id: 'notifications' as const, group: 'mac' as const, title: 'Notifications', how: null,
    why: 'Get an alert when a session needs your answer or a usage limit resets while you’re away from the canvas.',
  };
  switch (p?.notifications ?? null) {
    case null: return { ...base, state: 'checking', status: 'Checking…', action: null };
    case 'on': return { ...base, state: 'ready', status: 'Allowed', action: null };
    case 'not-asked': return { ...base, state: 'missing', status: 'Not asked yet', action: { kind: 'ask', permission: 'notifications', label: 'Allow notifications' } };
    case 'off': return { ...base, state: 'missing', status: 'Turned off', action: { kind: 'ask', permission: 'notifications', label: 'Open Notifications settings' } };
    case 'unavailable': return {
      ...base, state: 'unavailable', status: 'Not available in this build', action: null,
      why: 'Use the Dock icon or the canvas to see sessions that need you.',
    };
    default: return { ...base, state: 'optional', status: 'Could not check', action: { kind: 'ask', permission: 'notifications', label: 'Open Notifications settings' } };
  }
}

const SIGN_IN = { claude: 'Run `claude`, then type `/login`', codex: 'Run `codex login`' } as const;
const WHY = {
  claude: 'Uses your Claude Code login for Claude sessions.',
  codex: 'Uses your local Codex CLI and its account for Codex chats.',
} as const;
const INSTALL = {
  claude: 'Install Claude Code (docs.anthropic.com/claude-code), run `claude`, then type `/login`',
  codex: 'Install Codex (`npm install -g @openai/codex`), then run `codex login`',
} as const;

/** "Not found" notes the engines write when the program is missing. */
const notInstalled = (a: ProviderAccount): boolean => a.note !== null && /not (found|installed)/i.test(a.note);

function agentRow(provider: 'claude' | 'codex', accounts: AccountsView | null, otherReady: boolean, cliMissing = false): Row {
  const title = provider === 'claude' ? 'Claude Code' : 'Codex';
  const base = { id: provider, group: 'agents' as const, title, why: WHY[provider], action: null };
  const a = accounts?.[provider] ?? null;
  if (a === null) return { ...base, state: 'checking', status: 'Checking…', how: null };
  if (a.signedIn) return { ...base, state: 'ready', status: a.email ? `Signed in as ${a.email}` : 'Signed in', how: null };
  const missing = cliMissing || notInstalled(a);
  if (!missing && a.note && !/signed out|not signed in/i.test(a.note)) {
    return { ...base, state: 'optional', status: 'Could not check', how: a.note };
  }
  // One provider is enough to use the app: the other is optional once one is ready.
  return {
    ...base, state: otherReady ? 'optional' : 'missing', status: missing ? 'Not installed' : 'Not signed in',
    how: missing ? INSTALL[provider] : `${SIGN_IN[provider]} in a terminal`,
  };
}

function acpRow(agents: AcpAgentView[] | null): Row {
  const base = {
    id: 'acp' as const, group: 'agents' as const, title: 'Other agents (ACP)', action: null, how: null,
    why: 'Add Gemini CLI or another compatible agent in Profile → ACP agents.',
  };
  if (agents === null) return { ...base, state: 'optional', status: 'Checking…' };
  const found = agents.filter((a) => a.path !== null).length;
  if (agents.length === 0) return { ...base, state: 'optional', status: 'None added' };
  return found === agents.length
    ? { ...base, state: 'ready', status: `${found} ready` }
    : { ...base, state: 'optional', status: `${found} of ${agents.length} found` };
}

export function buildRows(perms: PermissionsView | null, accounts: AccountsView | null, acp: AcpAgentView[] | null): Row[] {
  const claudeReady = accounts?.claude.signedIn === true;
  const codexReady = accounts?.codex.signedIn === true;
  const hasAcp = acp?.some(agent => agent.path !== null) === true;
  return [
    notificationsRow(perms),
    agentRow('claude', accounts, codexReady || hasAcp, perms?.claudeCliInstalled === false),
    agentRow('codex', accounts, claudeReady || hasAcp),
    acpRow(acp),
  ];
}

/** The rows that are needed and missing: what opens the sheet by itself. */
export const missingIds = (rows: Row[]): RowId[] => rows.filter((r) => r.state === 'missing').map((r) => r.id);

/** What the owner chose last time: never open by itself, or skipped while these were missing. */
export interface Dismissal { never: boolean; skipped: RowId[] }
export const NO_DISMISSAL: Dismissal = { never: false, skipped: [] };

/** Opens by itself only when something needed is missing that was not missing when the owner
    last skipped, and never after "Don't show again". Rows still being read never count. */
export function shouldAutoOpen(rows: Row[], dismissal: Dismissal): boolean {
  if (dismissal.never || rows.some((r) => r.state === 'checking')) return false;
  return missingIds(rows).some((id) => !dismissal.skipped.includes(id));
}

const KEY = 'agent-canvas:permissions-sheet';
const ROW_IDS: readonly RowId[] = ['notifications', 'claude', 'codex', 'acp'];

export function parseDismissal(text: string | null): Dismissal {
  if (!text) return NO_DISMISSAL;
  try {
    const v = JSON.parse(text) as Partial<Dismissal>;
    return {
      never: v.never === true,
      skipped: Array.isArray(v.skipped) ? v.skipped.filter((id): id is RowId => ROW_IDS.includes(id as RowId)) : [],
    };
  } catch {
    return NO_DISMISSAL;
  }
}

export function loadDismissal(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): Dismissal {
  try { return parseDismissal(storage?.getItem(KEY) ?? null); } catch { return NO_DISMISSAL; }
}

export function saveDismissal(d: Dismissal, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null): void {
  try { storage?.setItem(KEY, JSON.stringify(d)); } catch { /* not kept */ }
}
