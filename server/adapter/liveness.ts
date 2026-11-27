// Decides whether the process behind a session file is still the one that wrote it.
// A pid can be reused, so a live pid only counts when its start time matches procStart.
// procStart is written as the UTC `ps -o lstart` form, e.g. "Thu Nov 19 12:20:42 2026"; both it
// and the probed start time are compared as instants, within a small tolerance.
import { execFile } from 'node:child_process';
import type { RawSession } from './sessionFiles.ts';

/** How far apart procStart and the probed start time may be and still name the same process. */
const START_TOLERANCE_MS = 2000;

export interface Probe {
  pidAlive(pid: number): boolean;
  /** Start times as `ps` prints them in UTC, for those of the pids that are running. One call for all. */
  startTimes(pids: number[]): Promise<Map<number, string>>;
}

export const defaultProbe: Probe = {
  pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  startTimes(pids) {
    if (pids.length === 0) return Promise.resolve(new Map());
    return new Promise((resolve) => {
      execFile(
        'ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')],
        { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000 },
        // ps exits non-zero when any pid is gone, but still prints the others.
        (_err, stdout) => {
          const times = new Map<number, string>();
          for (const line of String(stdout ?? '').split('\n')) {
            const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
            if (m) times.set(Number(m[1]), m[2]!);
          }
          resolve(times);
        },
      );
    });
  },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART = /^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/;
/** ISO 8601 with an explicit zone; one without a zone would be read as local time. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** A start time in epoch ms: the UTC lstart form (as ps prints it), or ISO 8601 with a zone. Else null. */
export function parseStart(text: string): number | null {
  const s = text.trim();
  const m = LSTART.exec(s.replace(/\s+/g, ' '));
  if (m) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 1).toUpperCase() + m[1]!.slice(1).toLowerCase());
    if (month === -1) return null;
    const [day, h, min, sec, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
    if (day < 1 || day > 31 || h > 23 || min > 59 || sec > 60) return null;
    return Date.UTC(year, month, day, h, min, sec);
  }
  if (ISO_WITH_ZONE.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0;

/** For each session file, whether its process is alive; one `ps` call covers every pid that needs a start time. */
export async function whichAlive(raws: RawSession[], probe: Probe = defaultProbe): Promise<boolean[]> {
  const pidAlive = raws.map((r) => validPid(r.pid) && probe.pidAlive(r.pid));
  const expected = raws.map((r) => (r.procStart === null ? null : parseStart(r.procStart)));
  const toProbe = [...new Set(raws.filter((r, i) => pidAlive[i] && expected[i] !== null).map((r) => r.pid))];
  const times = toProbe.length === 0 ? new Map<number, string>() : await probe.startTimes(toProbe);
  return raws.map((r, i) => {
    if (!pidAlive[i]) return false;
    const want = expected[i];
    if (want === null || want === undefined) return true; // no procStart, or one we cannot read: the pid decides
    const text = times.get(r.pid);
    const got = text === undefined ? null : parseStart(text);
    if (got === null) return true;
    return Math.abs(got - want) <= START_TOLERANCE_MS;
  });
}

export async function isAlive(raw: RawSession, probe: Probe = defaultProbe): Promise<boolean> {
  return (await whichAlive([raw], probe))[0]!;
}
