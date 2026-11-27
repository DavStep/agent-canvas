// The reset time read from a limit message: the next such clock time after it was written, in
// the zone it names (else the owner's), rolling over to the next day once today's has passed.
import { describe, expect, it } from 'vitest';
import { resetFromText } from './resetTime.ts';

const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

describe('resetFromText', () => {
  it('"4pm" and "11:10pm": later today, in the owner\'s zone', () => {
    const at = local(27, 12, 3);
    expect(resetFromText("You've hit your 5-hour limit · resets 4pm", at)).toBe(local(27, 16));
    expect(resetFromText("You've hit your 5-hour limit · resets 11:10pm", at)).toBe(local(27, 23, 10));
    expect(resetFromText('resets 12am', at)).toBe(local(28, 0));
    expect(resetFromText('resets 12pm', local(27, 9))).toBe(local(27, 12));
  });

  it('rolls over to the next day when the time has passed today', () => {
    expect(resetFromText('resets 4pm', local(27, 16, 30))).toBe(local(28, 16));
    expect(resetFromText('resets 11:10pm', local(27, 23, 10))).toBe(local(28, 23, 10));
    expect(resetFromText('resets 7:20am', local(30, 22))).toBe(new Date(2026, 11, 1, 7, 20).getTime());
  });

  it('"resets 4:20pm (Asia/Yerevan)": in Yerevan (UTC+4), wherever the Mac is', () => {
    expect(resetFromText("You've hit your 5-hour limit · resets 4:20pm (Asia/Yerevan)", Date.UTC(2026, 10, 27, 8, 3))).toBe(Date.UTC(2026, 10, 27, 12, 20));
    expect(resetFromText('resets 4pm (Asia/Yerevan)', Date.UTC(2026, 10, 27, 9, 9, 56))).toBe(Date.UTC(2026, 10, 27, 12, 0));
    // Past 4:20pm in Yerevan: tomorrow's.
    expect(resetFromText('resets 4:20pm (Asia/Yerevan)', Date.UTC(2026, 10, 27, 12, 30))).toBe(Date.UTC(2026, 10, 28, 12, 20));
    // Past midnight UTC but not in Yerevan: the Yerevan day decides.
    expect(resetFromText('resets 1am (Asia/Yerevan)', Date.UTC(2026, 10, 27, 20, 30))).toBe(Date.UTC(2026, 10, 27, 21, 0));
    // A zone with daylight saving, on either side of it.
    expect(resetFromText('resets 9am (America/New_York)', Date.UTC(2026, 6, 1, 10))).toBe(Date.UTC(2026, 6, 1, 13));
    expect(resetFromText('resets 9am (America/New_York)', Date.UTC(2026, 11, 1, 10))).toBe(Date.UTC(2026, 11, 1, 14));
  });

  it('an unknown zone falls back to the owner\'s; the epoch form; Codex\'s dated form; none', () => {
    expect(resetFromText('resets 4pm (Nowhere/Atlantis)', local(27, 12))).toBe(local(27, 16));
    expect(resetFromText('Claude AI usage limit reached|1795780800', 0)).toBe(1795780800 * 1000);
    expect(resetFromText('try again at Sep 16th, 2027 4:21 PM.', local(27, 12))).toBe(new Date(2027, 8, 16, 16, 21).getTime());
    expect(resetFromText('resets 13pm', local(27, 12))).toBeNull();
    expect(resetFromText('Something broke', local(27, 12))).toBeNull();
  });
});
