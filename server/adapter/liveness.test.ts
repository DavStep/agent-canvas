import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { defaultProbe, isAlive, parseStart, whichAlive, type Probe } from './liveness.ts';
import type { RawSession } from './sessionFiles.ts';

function raw(procStart: string | null, pid = 4242): RawSession {
  return {
    pid, sessionId: 's', hostSessionId: null, cwd: '', name: '', status: 'idle',
    waitingFor: null, startedAt: 0, statusUpdatedAt: 0, procStart, nameSource: null,
  };
}

const probe = (alive: boolean, start: string | null): Probe => ({
  pidAlive: () => alive,
  startTimes: async (pids) => new Map(start === null ? [] : pids.map((p) => [p, start])),
});

describe('parseStart', () => {
  it('reads the UTC lstart form, with or without the weekday and padded days', () => {
    expect(parseStart('Thu Nov 19 12:20:42 2026')).toBe(Date.UTC(2026, 10, 19, 12, 20, 42));
    expect(parseStart('Thu Nov  5 09:01:02 2026  \n')).toBe(Date.UTC(2026, 10, 5, 9, 1, 2));
    expect(parseStart('Nov 5 09:01:02 2026')).toBe(Date.UTC(2026, 10, 5, 9, 1, 2));
  });

  it('reads ISO 8601 with a zone', () => {
    expect(parseStart('2026-11-19T12:20:42Z')).toBe(Date.UTC(2026, 10, 19, 12, 20, 42));
    expect(parseStart('2026-11-19T13:20:42.500+01:00')).toBe(Date.UTC(2026, 10, 19, 12, 20, 42, 500));
  });

  it('gives null for anything else', () => {
    for (const s of ['', 'yesterday', 'Thu Foo 19 12:20:42 2026', 'Thu Nov 19 25:20:42 2026', '2026-11-19T12:20:42', '1790000000000']) {
      expect(parseStart(s), s).toBeNull();
    }
  });
});

describe('isAlive', () => {
  it('is false when the pid is dead', async () => {
    expect(await isAlive(raw('Thu Nov 19 12:20:42 2026'), probe(false, 'Thu Nov 19 12:20:42 2026'))).toBe(false);
  });

  it('is true when the start times are within 2 s of each other, in either direction', async () => {
    expect(await isAlive(raw('Thu Nov 19 12:20:42 2026'), probe(true, 'Thu Nov 19 12:20:44 2026'))).toBe(true);
    expect(await isAlive(raw('Thu Nov 19 12:20:42 2026'), probe(true, 'Thu Nov 19 12:20:40 2026'))).toBe(true);
    expect(await isAlive(raw('2026-11-19T12:20:42Z'), probe(true, 'Thu Nov 19 12:20:43 2026'))).toBe(true);
  });

  it('is false when they are more than 2 s apart (a reused pid)', async () => {
    expect(await isAlive(raw('Thu Nov 19 12:20:42 2026'), probe(true, 'Thu Nov 19 12:20:45 2026'))).toBe(false);
    expect(await isAlive(raw('Thu Nov 19 12:20:42 2026'), probe(true, 'Fri Nov 20 12:20:42 2026'))).toBe(false);
  });

  it('is true when they match after normalising whitespace', async () => {
    expect(await isAlive(raw('Thu Nov  5 09:01:02 2026'), probe(true, 'Thu Nov 5 09:01:02 2026   \n'))).toBe(true);
  });

  it('is true for a live pid when either start time is missing or cannot be read', async () => {
    expect(await isAlive(raw(null), probe(true, 'Thu Nov 19 12:20:42 2026'))).toBe(true);
    expect(await isAlive(raw('Thu Nov 19 12:20:42 2026'), probe(true, null))).toBe(true);
    expect(await isAlive(raw('not a date'), probe(true, 'Thu Nov 19 12:20:42 2026'))).toBe(true);
    expect(await isAlive(raw('Thu Nov 19 12:20:42 2026'), probe(true, 'garbled'))).toBe(true);
  });

  it('is false for a pid that is not a positive integer, without asking the probe', async () => {
    const p = probe(true, null);
    const pidAlive = vi.spyOn(p, 'pidAlive');
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(await isAlive(raw(null, pid), p), String(pid)).toBe(false);
    expect(pidAlive).not.toHaveBeenCalled();
  });
});

describe('whichAlive', () => {
  it('asks for every start time in one call, once per pid, and only for live pids with a readable procStart', async () => {
    const startTimes = vi.fn(async (pids: number[]) => new Map(pids.map((p) => [p, 'Thu Nov 19 12:20:42 2026'])));
    const p: Probe = { pidAlive: (pid) => pid !== 3, startTimes };
    const raws = [
      raw('Thu Nov 19 12:20:42 2026', 1), raw('Thu Nov 19 12:20:42 2026', 1), raw('Thu Nov 19 12:20:42 2026', 2),
      raw('Thu Nov 19 12:20:42 2026', 3), raw(null, 4), raw('junk', 5), raw('Thu Nov 19 13:00:00 2026', 6),
    ];
    expect(await whichAlive(raws, p)).toEqual([true, true, true, false, true, true, false]);
    expect(startTimes).toHaveBeenCalledTimes(1);
    expect(startTimes).toHaveBeenCalledWith([1, 2, 6]);
  });

  it('does not ask at all when no session needs a start time', async () => {
    const startTimes = vi.fn(async () => new Map<number, string>());
    expect(await whichAlive([raw(null, 1)], { pidAlive: () => true, startTimes })).toEqual([true]);
    expect(startTimes).not.toHaveBeenCalled();
  });
});

describe('defaultProbe', () => {
  it('sees this process as alive with a UTC lstart close to its real start', async () => {
    expect(defaultProbe.pidAlive(process.pid)).toBe(true);
    const times = await defaultProbe.startTimes([process.pid]);
    const text = times.get(process.pid);
    expect(text).toMatch(/^\w{3} \w{3} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/);
    const started = Date.now() - process.uptime() * 1000;
    expect(Math.abs(parseStart(text!)! - started)).toBeLessThan(3000);
  });

  it('sees an exited child as dead with no start time, and still reports the live pids asked with it', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'exit');
    const pid = child.pid!;
    expect(defaultProbe.pidAlive(pid)).toBe(false);
    const times = await defaultProbe.startTimes([pid, process.pid]);
    expect(times.has(pid)).toBe(false);
    expect(times.has(process.pid)).toBe(true);
  });
});
