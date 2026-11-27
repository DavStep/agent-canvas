import { describe, expect, it } from 'vitest';
import type { AccountsView, ProviderAccount } from '../../../shared/account.ts';
import type { AcpAgentView } from '../../../shared/acp.ts';
import { MISSING_BANNER } from '../../../shared/banners.ts';
import { buildRows, loadDismissal, missingIds, NO_DISMISSAL, parseDismissal, saveDismissal, shouldAutoOpen, type Row } from './onboarding.ts';

const account = (provider: 'claude' | 'codex', signedIn: boolean, note: string | null = null): ProviderAccount =>
  ({ provider, signedIn, email: signedIn ? 'me@example.com' : null, plan: null, windows: [], note });
const accounts = (claude: boolean, codex: boolean, codexNote: string | null = null): AccountsView =>
  ({ claude: account('claude', claude), codex: account('codex', codex, codexNote) });
const row = (rows: Row[], id: Row['id']) => rows.find((r) => r.id === id)!;
const ALL_GOOD = { notifications: 'on' } as const;

describe('buildRows', () => {
  it('lists only what the app uses, in order', () => {
    expect(buildRows(null, null, null).map((r) => r.id)).toEqual(['notifications', 'claude', 'codex', 'acp']);
  });

  it('asks for notifications in context, and sends a turned-off switch to System Settings', () => {
    const notAsked = row(buildRows({ notifications: 'not-asked' }, accounts(true, true), []), 'notifications');
    expect(notAsked).toMatchObject({ state: 'missing', action: { kind: 'ask', permission: 'notifications', label: 'Allow notifications' } });
    const off = row(buildRows({ notifications: 'off' }, accounts(true, true), []), 'notifications');
    expect(off).toMatchObject({ state: 'missing', status: 'Turned off', action: { label: 'Open Notifications settings' } });
    expect(row(buildRows(ALL_GOOD, null, null), 'notifications')).toMatchObject({ state: 'ready', action: null });
  });

  it('never counts notifications as missing when this build cannot post them', () => {
    const r = row(buildRows({ notifications: 'unavailable' }, accounts(true, true), []), 'notifications');
    expect(r).toMatchObject({ state: 'unavailable', action: null });
    expect(r.why).toMatch(/Dock/);
  });

  it('needs at least one of Claude Code and Codex, not both', () => {
    const neither = buildRows(ALL_GOOD, accounts(false, false), []);
    expect([row(neither, 'claude').state, row(neither, 'codex').state]).toEqual(['missing', 'missing']);
    const claudeOnly = buildRows(ALL_GOOD, accounts(true, false), []);
    expect([row(claudeOnly, 'claude').state, row(claudeOnly, 'codex').state]).toEqual(['ready', 'optional']);
    expect(row(claudeOnly, 'claude').status).toBe('Signed in as me@example.com');
  });

  it('tells a missing program from a missing login', () => {
    const rows = buildRows(ALL_GOOD, accounts(false, false, MISSING_BANNER), []);
    expect(row(rows, 'codex')).toMatchObject({ status: 'Not installed' });
    expect(row(rows, 'codex').how).toMatch(/codex login/);
    expect(row(rows, 'claude')).toMatchObject({ status: 'Not signed in', how: 'Run `claude`, then type `/login` in a terminal' });
  });

  it('offers the Claude CLI installation only when needed for login', () => {
    const permissions = { ...ALL_GOOD, claudeCliInstalled: false };
    expect(row(buildRows(permissions, accounts(false, false), []), 'claude').status).toBe('Not installed');
    expect(row(buildRows(permissions, accounts(true, false), []), 'claude').state).toBe('ready');
  });

  it('keeps an account lookup failure distinct from a signed-out account', () => {
    const rows = buildRows(ALL_GOOD, accounts(true, false, 'Codex did not answer within 10 s'), []);
    expect(row(rows, 'codex').status).toBe('Could not check');
  });

  it('counts ACP agents found', () => {
    const agent = (path: string | null) => ({ id: 'x', name: 'X', command: 'x', args: [], icon: 'generic', path, install: null }) as unknown as AcpAgentView;
    expect(row(buildRows(null, null, []), 'acp')).toMatchObject({ state: 'optional', status: 'None added' });
    expect(row(buildRows(null, null, [agent('/bin/x')]), 'acp')).toMatchObject({ state: 'ready', status: '1 ready' });
    expect(row(buildRows(null, null, [agent('/bin/x'), agent(null)]), 'acp')).toMatchObject({ state: 'optional', status: '1 of 2 found' });
  });
});

describe('shouldAutoOpen', () => {
  const missingNotifications = buildRows({ notifications: 'not-asked' }, accounts(true, false), []);
  it('opens on first run when something needed is missing', () => {
    expect(missingIds(missingNotifications)).toEqual(['notifications']);
    expect(shouldAutoOpen(missingNotifications, NO_DISMISSAL)).toBe(true);
  });
  it('stays shut when all is granted, even with optional rows open', () => {
    expect(shouldAutoOpen(buildRows({ notifications: 'on' }, accounts(true, false), []), NO_DISMISSAL)).toBe(false);
    expect(shouldAutoOpen(buildRows({ notifications: 'unavailable' }, accounts(true, false), []), NO_DISMISSAL)).toBe(false);
  });
  it('stays shut after a skip until something new goes missing', () => {
    expect(shouldAutoOpen(missingNotifications, { never: false, skipped: ['notifications'] })).toBe(false);
    const alsoSignedOut = buildRows({ notifications: 'not-asked' }, accounts(false, false), []);
    expect(shouldAutoOpen(alsoSignedOut, { never: false, skipped: ['notifications'] })).toBe(true);
  });
  it('never opens after "Don’t show again"', () => {
    expect(shouldAutoOpen(missingNotifications, { never: true, skipped: [] })).toBe(false);
  });
  it('waits until every row is read', () => {
    expect(shouldAutoOpen(buildRows(null, accounts(false, false), []), NO_DISMISSAL)).toBe(false);
  });
});

describe('dismissal storage', () => {
  it('round-trips and drops anything unknown', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    saveDismissal({ never: false, skipped: ['notifications', 'claude'] }, storage);
    expect(loadDismissal(storage)).toEqual({ never: false, skipped: ['notifications', 'claude'] });
    expect(parseDismissal('{"never":true,"skipped":["camera","codex"]}')).toEqual({ never: true, skipped: ['codex'] });
    expect(parseDismissal('{')).toEqual(NO_DISMISSAL);
    expect(loadDismissal(null)).toEqual(NO_DISMISSAL);
    expect(loadDismissal({ getItem: () => { throw new Error('denied'); } })).toEqual(NO_DISMISSAL);
  });
});
