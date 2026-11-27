// When a usage limit resets, read from the provider's own words: Claude's "resets 4pm",
// "resets 11:10pm", "resets 4:20pm (Asia/Yerevan)", "usage limit reached|<epoch s>", and Codex's
// "try again at 12:04 PM" or "try again at Sep 16th, 2026 4:21 PM". A clock time is the next one
// after the message: in the time zone the message names, else the owner's. Shared by the main
// process (server/interruptions.ts) and the chat's closing divider.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The 24-hour hour, or null for an impossible one. */
function hour24(hour: number, minute: number, meridiem: string | undefined): number | null {
  if (hour > 23 || minute > 59) return null;
  if (!meridiem) return hour;
  if (hour < 1 || hour > 12) return null;
  return (hour % 12) + (/p/i.test(meridiem) ? 12 : 0);
}

const zoneCheck = new Map<string, boolean>();
/** Whether this runtime knows the IANA zone ("Asia/Yerevan"). */
function knownZone(zone: string): boolean {
  let ok = zoneCheck.get(zone);
  if (ok === undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); ok = true; } catch { ok = false; }
    zoneCheck.set(zone, ok);
  }
  return ok;
}

/** The wall clock in `zone` at `t`, as if it were UTC (so differences give the zone's offset). */
function wallAsUtc(t: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
}

/** The instant whose wall clock in `zone` reads y-m-d h:mm. */
function zoned(y: number, m: number, d: number, h: number, minute: number, zone: string): number {
  const wall = Date.UTC(y, m, d, h, minute);
  // Two passes settle a guess that lands across a daylight-saving change.
  let t = wall - (wallAsUtc(wall, zone) - wall);
  t = wall - (wallAsUtc(t, zone) - t);
  return t;
}

/** The next h:mm after `after` (on `date`'s day when one is given): in `zone`, else the owner's. */
function clockAfter(after: number, h: number, minute: number, zone: string | null, date?: { y: number; m: number; d: number }): number {
  if (zone !== null) {
    const day = date ?? (() => { const w = new Date(wallAsUtc(after, zone)); return { y: w.getUTCFullYear(), m: w.getUTCMonth(), d: w.getUTCDate() }; })();
    let t = zoned(day.y, day.m, day.d, h, minute, zone);
    if (!date && t <= after) t = zoned(day.y, day.m, day.d + 1, h, minute, zone);
    return t;
  }
  const d = date ? new Date(date.y, date.m, date.d) : new Date(after);
  d.setHours(h, minute, 0, 0);
  if (!date && d.getTime() <= after) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** When a limit resets (epoch ms), from a message's words; `at` is when it was written. */
export function resetFromText(text: string, at: number): number | null {
  const epoch = /limit reached\|(\d{9,11})/i.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const named = /\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/.exec(text)?.[1] ?? null;
  const zone = named !== null && knownZone(named) ? named : null;
  const claude = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text);
  if (claude) {
    const h = hour24(Number(claude[1]), Number(claude[2] ?? 0), claude[3]);
    return h === null ? null : clockAfter(at, h, Number(claude[2] ?? 0), zone);
  }
  const codex = /try again (?:at|after)\s+(?:([A-Z][a-z]{2})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(text);
  if (codex) {
    const [, mon, day, year, hour, minute, meridiem] = codex;
    const h = hour24(Number(hour), Number(minute), meridiem);
    if (h === null) return null;
    const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1;
    const date = month >= 0 ? { y: Number(year), m: month, d: Number(day) } : undefined;
    return clockAfter(at, h, Number(minute), zone, date);
  }
  return null;
}
