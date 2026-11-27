import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NotificationState } from '../shared/permissions.ts';

/** Notification Center's "Allow notifications" switch, in an app's `flags`. */
const ALLOW_BIT = 1 << 25;

/** The System Settings pane each permission is changed in. */
export function settingsPane(bundleId: string | null): string {
  return bundleId
    ? `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(bundleId)}`
    : 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
}

/** The top-level text of each `<dict>` directly inside the `apps` array, nested dicts left out. */
function appDicts(xml: string): string[] {
  const start = /<key>apps<\/key>\s*<array>/.exec(xml);
  if (!start) return [];
  const out: string[] = [];
  const tag = /<(\/?)dict(\/?)>|<\/array>/g;
  tag.lastIndex = start.index + start[0].length;
  let depth = 0;
  let body = '';
  let from = tag.lastIndex;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (depth === 1) body += xml.slice(from, m.index);
    from = m.index + m[0].length;
    if (m[0] === '</array>') {
      if (depth === 0) break;
      continue;
    }
    if (m[2] === '/') continue; // <dict/>
    if (m[1] === '/') {
      depth--;
      if (depth === 0) {
        out.push(body);
        body = '';
      }
    } else {
      depth++;
    }
  }
  return out;
}

/** The app's notification switch in `defaults export com.apple.ncprefs -`'s XML: on, off, or
    not-asked when macOS has no entry for it yet. */
export function notificationsFromPrefs(xml: string, bundleId: string): 'on' | 'off' | 'not-asked' {
  const id = (body: string) => /<key>bundle-id<\/key>\s*<string>([^<]*)<\/string>/.exec(body)?.[1];
  const entry = appDicts(xml).find((body) => id(body) === bundleId);
  if (entry === undefined) return 'not-asked';
  const flags = /<key>flags<\/key>\s*<integer>(-?\d+)<\/integer>/.exec(entry);
  if (!flags) return 'off';
  return (Number(flags[1]) & ALLOW_BIT) !== 0 ? 'on' : 'off';
}

export interface NotificationDeps {
  supported: boolean;
  bundleId: string | null;
  /** Notification Center's preferences as XML, or null when they cannot be read. */
  readPrefs(): Promise<string | null>;
  /** A test notification this run failed to post (macOS refused it: an unsigned build). */
  failed: boolean;
}

export async function notificationState(deps: NotificationDeps): Promise<NotificationState> {
  if (!deps.supported || deps.bundleId === null) return 'unavailable';
  const xml = await deps.readPrefs().catch(() => null);
  if (xml === null) return deps.failed ? 'unavailable' : 'unknown';
  const state = notificationsFromPrefs(xml, deps.bundleId);
  return state === 'not-asked' && deps.failed ? 'unavailable' : state;
}

export const readNotificationPrefs = (): Promise<string | null> => new Promise((resolve) => {
  execFile('/usr/bin/defaults', ['export', 'com.apple.ncprefs', '-'], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => resolve(err ? null : stdout));
});

/** The app's bundle id: from Launch Services, else the bundle's Info.plist; null when not in a bundle. */
export async function appBundleId(exePath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.__CFBundleIdentifier) return env.__CFBundleIdentifier;
  try {
    const plist = await readFile(path.join(path.dirname(exePath), '..', 'Info.plist'), 'utf8');
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}
