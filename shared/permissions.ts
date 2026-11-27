/** on: allowed. off: turned off in System Settings. not-asked: macOS has not asked yet.
    unavailable: this build cannot post notifications (macOS delivers them only for a code-signed
    app). unknown: could not tell. */
export type NotificationState = 'on' | 'off' | 'not-asked' | 'unavailable' | 'unknown';

export interface PermissionsView { notifications: NotificationState; claudeCliInstalled?: boolean }

export type PermissionKind = 'notifications';
export const PERMISSION_KINDS: readonly PermissionKind[] = ['notifications'];
export const isPermissionKind = (v: unknown): v is PermissionKind => typeof v === 'string' && (PERMISSION_KINDS as readonly string[]).includes(v);

const NOTIFICATION_STATES: readonly NotificationState[] = ['on', 'off', 'not-asked', 'unavailable', 'unknown'];

/** A PermissionsView from untrusted JSON (the e2e test's AGENT_CANVAS_DEMO_PERMISSIONS), or null. */
export function parsePermissionsView(text: string | undefined): PermissionsView | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<PermissionsView>;
    if (!NOTIFICATION_STATES.includes(v.notifications as NotificationState)) return null;
    return { notifications: v.notifications!, claudeCliInstalled: v.claudeCliInstalled !== false };
  } catch {
    return null;
  }
}
