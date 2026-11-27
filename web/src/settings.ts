// The owner's settings as the page knows them: read once, shared by every model menu, and read
// again after a change from the Settings section, so the menus follow at once.
import { useEffect, useState } from 'react';
import type { AppSettings, SettingsPatch } from '../../shared/bridge.ts';
import { profileBridge } from './bridge.ts';

let current: AppSettings | null = null;
let reading: Promise<AppSettings> | null = null;
const listeners = new Set<(s: AppSettings) => void>();

function publish(s: AppSettings): AppSettings {
  current = s;
  for (const l of listeners) l(s);
  return s;
}

/** The settings, read from main (once, unless `fresh`). */
export function readSettings(fresh = false): Promise<AppSettings> {
  if (!fresh && current) return Promise.resolve(current);
  if (!fresh && reading) return reading;
  // A page with no settings call (a test's stand-in) just has none.
  const r = Promise.resolve().then(() => profileBridge.getSettings()).then(publish);
  reading = r;
  r.finally(() => { if (reading === r) reading = null; }).catch(() => {});
  return r;
}

/** Saves a change, then shares what main now holds. */
export async function saveSettings(patch: SettingsPatch): Promise<AppSettings> {
  await profileBridge.setSettings(patch);
  return readSettings(true);
}

/** The settings, or null until they have been read (or when they cannot be). */
export function useSettings(): AppSettings | null {
  const [s, setS] = useState<AppSettings | null>(current);
  useEffect(() => {
    listeners.add(setS);
    readSettings().catch(() => {});
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}
