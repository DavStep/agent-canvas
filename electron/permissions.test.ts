import { describe, expect, it } from 'vitest';
import { appBundleId, notificationState, notificationsFromPrefs, settingsPane } from './permissions.ts';
import { isPermissionKind, parsePermissionsView } from '../shared/permissions.ts';

const ID = 'com.agent-canvas.desktop';
const app = (bundle: string, flags: number, nested = '') => `
		<dict>
			<key>bundle-id</key>
			<string>${bundle}</string>${nested}
			<key>flags</key>
			<integer>${flags}</integer>
			<key>path</key>
			<string>/Applications/X.app</string>
		</dict>`;
const prefs = (...apps: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>apps</key>
	<array>${apps.join('')}
	</array>
	<key>dnd_prefs</key>
	<data>AAAA</data>
</dict>
</plist>`;
// A nested dict with its own flags (as Notification Center keeps per-source settings) must not
// be read as the app's own switch.
const nested = `
			<key>req</key>
			<dict>
				<key>flags</key>
				<integer>${1 << 25}</integer>
				<key>list</key>
				<array><string>a</string></array>
			</dict>`;

describe('notificationsFromPrefs', () => {
  it('reads the allow switch of the app’s own entry', () => {
    expect(notificationsFromPrefs(prefs(app('com.other', 0x80200e), app(ID, 0x280200e)), ID)).toBe('on');
    expect(notificationsFromPrefs(prefs(app(ID, 0x80200e), app('com.other', 0x280200e)), ID)).toBe('off');
  });
  it('is not-asked when macOS has no entry for the app', () => {
    expect(notificationsFromPrefs(prefs(app('com.other', 0x280200e)), ID)).toBe('not-asked');
    expect(notificationsFromPrefs('<plist/>', ID)).toBe('not-asked');
  });
  it('ignores flags inside nested dicts', () => {
    expect(notificationsFromPrefs(prefs(app(ID, 0x80200e, nested)), ID)).toBe('off');
  });
  it('does not take a later app’s flags for an entry with none', () => {
    const noFlags = `<dict><key>bundle-id</key><string>${ID}</string></dict>`;
    expect(notificationsFromPrefs(prefs(noFlags, app('com.other', 0x280200e)), ID)).toBe('off');
  });
});

describe('notificationState', () => {
  const deps = (xml: string | null, failed = false) => ({ supported: true, bundleId: ID, readPrefs: async () => xml, failed });
  it('maps the preferences', async () => {
    expect(await notificationState(deps(prefs(app(ID, 0x280200e))))).toBe('on');
    expect(await notificationState(deps(prefs()))).toBe('not-asked');
  });
  it('is unavailable when a test notification failed and macOS never registered the app', async () => {
    expect(await notificationState(deps(prefs(), true))).toBe('unavailable');
    expect(await notificationState(deps(null, true))).toBe('unavailable');
  });
  it('is unavailable without notification support or outside an app bundle', async () => {
    expect(await notificationState({ ...deps(prefs()), supported: false })).toBe('unavailable');
    expect(await notificationState({ ...deps(prefs()), bundleId: null })).toBe('unavailable');
  });
  it('is unknown when the preferences cannot be read', async () => {
    expect(await notificationState(deps(null))).toBe('unknown');
    expect(await notificationState({ ...deps(null), readPrefs: () => Promise.reject(new Error('x')) })).toBe('unknown');
  });
});

describe('settingsPane', () => {
  it('names fixed System Settings panes', () => {
    expect(settingsPane(ID)).toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.agent-canvas.desktop');
    expect(settingsPane(null)).toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
  });
});

describe('appBundleId', () => {
  it('prefers Launch Services’ answer', async () => {
    expect(await appBundleId('/nowhere/MacOS/x', { __CFBundleIdentifier: 'a.b' })).toBe('a.b');
  });
  it('is null outside a bundle', async () => {
    expect(await appBundleId('/nowhere/MacOS/x', {})).toBeNull();
  });
});

describe('shared/permissions', () => {
  it('checks kinds', () => {
    expect(isPermissionKind('notifications')).toBe(true);
    expect(isPermissionKind('camera')).toBe(false);
    expect(isPermissionKind(1)).toBe(false);
  });
  it('parses a test view and refuses anything else', () => {
    expect(parsePermissionsView('{"notifications":"not-asked"}')).toEqual({ notifications: 'not-asked', claudeCliInstalled: true });
    expect(parsePermissionsView('{"notifications":"maybe"}')).toBeNull();
    expect(parsePermissionsView('nope')).toBeNull();
    expect(parsePermissionsView(undefined)).toBeNull();
  });
});
