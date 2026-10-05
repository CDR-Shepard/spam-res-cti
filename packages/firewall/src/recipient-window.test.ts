import { describe, expect, it } from 'vitest';
import * as firewall from './index.js';
import {
  CALLING_HOURS_END_HHMM_EXCLUSIVE,
  CALLING_HOURS_START_HHMM,
  effectiveCallingWindow,
  resolveStateRule,
  stateForAreaCode,
  timezoneForNumber,
  todayIsoWeekday,
} from './index.js';
import {
  CALL_WINDOW,
  EMAIL_WINDOW,
  TEXT_WINDOW,
  nextWindowOpening,
  withinCallingHours,
  withinRecipientWindow,
} from './recipient-window.js';

/**
 * ORACLE: the dialer's pre-filter exactly as it stood in
 * services/cti-api/src/dialer/pick-did.ts before it moved here (origin/main
 * fa78987, lines 49-143), copied verbatim minus comments. The parity tests
 * below pin the moved code to it, so "moved verbatim" is checked by a
 * machine, not by a reviewer's eye.
 */
function legacyCurrentHHMM(nowUtc: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(nowUtc);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return hour === '24' ? `00:${minute}` : `${hour}:${minute}`;
}
const LEGACY_NON_GEOGRAPHIC_NPAS = new Set(['800', '833', '844', '855', '866', '877', '888', '900']);
const LEGACY_NANP_E164 = /^\+1(\d{3})\d{7}$/;
function legacyWithinEffectiveWindow(tz: string, state: string | null, nowUtc: Date): boolean {
  const stateRule = resolveStateRule(state);
  const isoWeekday = todayIsoWeekday(nowUtc, tz);
  const window = effectiveCallingWindow(
    { days: [1, 2, 3, 4, 5, 6, 7], start: CALLING_HOURS_START_HHMM, end: CALLING_HOURS_END_HHMM_EXCLUSIVE },
    stateRule,
    isoWeekday,
  );
  if (!window) return false;
  const nowHHMM = legacyCurrentHHMM(nowUtc, tz);
  return nowHHMM >= window.start && nowHHMM < window.end;
}
function legacyWithinCallingHours(toE164: string, nowUtc: Date): boolean {
  const resolved = timezoneForNumber(toE164);
  if (resolved) {
    const state = stateForAreaCode(resolved.matched);
    return legacyWithinEffectiveWindow(resolved.timezone, state, nowUtc);
  }
  const npa = LEGACY_NANP_E164.exec(toE164)?.[1];
  if (npa && !LEGACY_NON_GEOGRAPHIC_NPAS.has(npa)) {
    return legacyWithinEffectiveWindow('America/Chicago', null, nowUtc);
  }
  return true;
}

const NUMBERS = {
  CA: '+16195551234', // 619 → America/Los_Angeles, CA (federal baseline, all 7 days)
  FL: '+13055551234', // 305 → America/New_York, FL (08:00-20:00 every day)
  TX: '+12145551234', // 214 → America/Chicago, TX (09:00 weekdays, Sunday from 12:00)
  AL: '+12055551234', // 205 → America/Chicago, AL (Sunday banned)
  ME: '+12075551234', // 207 → America/New_York, ME (Mon-Fri 09:00-17:00 only)
  CANADA: '+14165551234', // 416 → America/New_York, no US state → unknown-state rule
  TOLL_FREE: '+18005551234', // non-geographic → fails open
  INTERNATIONAL: '+442071838750', // non-NANP → fails open
  UNMAPPED_NANP: '+15555551234', // NANP-shaped, not in the maps → Chicago approximation (FIX-9)
} as const;

/** UTC offset in hours during July 2026 (all daylight time). */
const JULY_OFFSET: Record<string, number> = {
  'America/Los_Angeles': 7,
  'America/Chicago': 5,
  'America/New_York': 4,
};

/** A local wall-clock time on a July 2026 date for the given zone, as a UTC instant. */
function localAt(tz: keyof typeof JULY_OFFSET, isoDate: string, hour: number, minute = 0, second = 0): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour + JULY_OFFSET[tz]!, minute, second));
}

const SUNDAY = '2026-07-12';
const TUESDAY = '2026-07-14';
const FRIDAY = '2026-07-17';
const SATURDAY = '2026-07-18';

/** Every 15 minutes from `fromIso` (inclusive) for `hours` hours. */
function quarterHours(fromIso: string, hours: number): Date[] {
  const start = new Date(fromIso).getTime();
  return Array.from({ length: hours * 4 }, (_, i) => new Date(start + i * 15 * 60_000));
}

describe('withinRecipientWindow(…, CALL_WINDOW) is the dialer rule, unchanged', () => {
  it('CALL_WINDOW is built from the calling-window constants (08:00 through 20:59)', () => {
    expect(CALL_WINDOW).toEqual({ start: '08:00', endExclusive: '21:00' });
    expect(CALL_WINDOW).toEqual({ start: CALLING_HOURS_START_HHMM, endExclusive: CALLING_HOURS_END_HHMM_EXCLUSIVE });
  });

  it('is exported from the package index (cti-api re-exports it from @cti/firewall)', () => {
    expect(firewall.withinCallingHours).toBe(withinCallingHours);
    expect(firewall.withinRecipientWindow).toBe(withinRecipientWindow);
    expect(firewall.nextWindowOpening).toBe(nextWindowOpening);
    expect(firewall.CALL_WINDOW).toBe(CALL_WINDOW);
  });

  it('the window constants are frozen', () => {
    expect(Object.isFrozen(CALL_WINDOW)).toBe(true);
    expect(Object.isFrozen(TEXT_WINDOW)).toBe(true);
    expect(Object.isFrozen(EMAIL_WINDOW)).toBe(true);
  });

  // A full summer week (Sun 2026-07-12 00:00Z → Sun 2026-07-19 00:00Z) and the
  // weekend the clocks fall back (Sun 2026-11-01), every 15 minutes.
  const INSTANTS = [...quarterHours('2026-07-12T00:00:00Z', 7 * 24), ...quarterHours('2026-10-31T00:00:00Z', 72)];

  it.each(Object.entries(NUMBERS))('%s (%s) agrees with the legacy dialer rule at every quarter hour', (_label, n) => {
    for (const at of INSTANTS) {
      const legacy = legacyWithinCallingHours(n, at);
      expect([at.toISOString(), withinRecipientWindow(n, at, CALL_WINDOW)]).toEqual([at.toISOString(), legacy]);
      expect([at.toISOString(), withinCallingHours(n, at)]).toEqual([at.toISOString(), legacy]);
    }
  });

  it.each([
    // [label, number, instant, expected]
    ['CA Tue 07:59', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 7, 59), false],
    ['CA Tue 08:00', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 8, 0), true],
    ['CA Tue 20:59', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 20, 59), true],
    ['CA Tue 21:00', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 21, 0), false],
    ['CA Sun 10:00 (federal baseline allows Sunday)', NUMBERS.CA, localAt('America/Los_Angeles', SUNDAY, 10), true],
    ['FL Tue 07:59', NUMBERS.FL, localAt('America/New_York', TUESDAY, 7, 59), false],
    ['FL Tue 08:00', NUMBERS.FL, localAt('America/New_York', TUESDAY, 8, 0), true],
    ['FL Tue 19:59 (FL closes at 20:00)', NUMBERS.FL, localAt('America/New_York', TUESDAY, 19, 59), true],
    ['FL Tue 20:00', NUMBERS.FL, localAt('America/New_York', TUESDAY, 20, 0), false],
    ['FL Tue 20:59', NUMBERS.FL, localAt('America/New_York', TUESDAY, 20, 59), false],
    ['TX Tue 08:00 (TX opens at 09:00)', NUMBERS.TX, localAt('America/Chicago', TUESDAY, 8, 0), false],
    ['TX Tue 20:59', NUMBERS.TX, localAt('America/Chicago', TUESDAY, 20, 59), true],
    ['TX Tue 21:00', NUMBERS.TX, localAt('America/Chicago', TUESDAY, 21, 0), false],
    ['TX Sun 11:59', NUMBERS.TX, localAt('America/Chicago', SUNDAY, 11, 59), false],
    ['TX Sun 12:00', NUMBERS.TX, localAt('America/Chicago', SUNDAY, 12, 0), true],
    ['AL Sun 10:00 (Sunday banned)', NUMBERS.AL, localAt('America/Chicago', SUNDAY, 10), false],
    ['ME Sat 10:00 (weekend banned)', NUMBERS.ME, localAt('America/New_York', SATURDAY, 10), false],
    ['Canada Sun 10:00 (unknown-state rule bans Sunday)', NUMBERS.CANADA, localAt('America/New_York', SUNDAY, 10), false],
    ['Canada Tue 10:00', NUMBERS.CANADA, localAt('America/New_York', TUESDAY, 10), true],
    ['toll-free at 23:00 CT (fails open)', NUMBERS.TOLL_FREE, localAt('America/Chicago', TUESDAY, 23), true],
    ['international at 23:00 CT (fails open)', NUMBERS.INTERNATIONAL, localAt('America/Chicago', TUESDAY, 23), true],
    ['unmapped NANP Sun 10:00 CT (FIX-9)', NUMBERS.UNMAPPED_NANP, localAt('America/Chicago', SUNDAY, 10), false],
    ['unmapped NANP Tue 07:59 CT', NUMBERS.UNMAPPED_NANP, localAt('America/Chicago', TUESDAY, 7, 59), false],
    ['unmapped NANP Tue 08:00 CT', NUMBERS.UNMAPPED_NANP, localAt('America/Chicago', TUESDAY, 8, 0), true],
  ] as const)('%s → %s', (_label, n, at, expected) => {
    expect(withinRecipientWindow(n, at, CALL_WINDOW)).toBe(expected);
    expect(withinCallingHours(n, at)).toBe(expected);
    expect(legacyWithinCallingHours(n, at)).toBe(expected);
  });
});

describe('TEXT_WINDOW — 09:00 through 19:59 recipient-local, inside the state overlay', () => {
  it.each([
    ['CA Tue 08:59', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 8, 59), false],
    ['CA Tue 09:00', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 9, 0), true],
    ['CA Tue 19:59', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 19, 59), true],
    ['CA Tue 20:00', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 20, 0), false],
    ['FL Tue 09:00', NUMBERS.FL, localAt('America/New_York', TUESDAY, 9, 0), true],
    ['FL Tue 20:00', NUMBERS.FL, localAt('America/New_York', TUESDAY, 20, 0), false],
    ['TX Sun 11:59 (TX Sunday opens at noon)', NUMBERS.TX, localAt('America/Chicago', SUNDAY, 11, 59), false],
    ['TX Sun 12:00', NUMBERS.TX, localAt('America/Chicago', SUNDAY, 12, 0), true],
    ['ME Sat 12:00 (weekend banned)', NUMBERS.ME, localAt('America/New_York', SATURDAY, 12), false],
    ['toll-free at 03:00 CT (fails open)', NUMBERS.TOLL_FREE, localAt('America/Chicago', TUESDAY, 3), true],
  ] as const)('%s → %s', (_label, n, at, expected) => {
    expect(withinRecipientWindow(n, at, TEXT_WINDOW)).toBe(expected);
  });
});

describe('EMAIL_WINDOW — 08:00 through 17:59 recipient-local', () => {
  it.each([
    ['CA Tue 07:59', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 7, 59), false],
    ['CA Tue 08:00', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 8, 0), true],
    ['CA Tue 17:59', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 17, 59), true],
    ['CA Tue 18:00', NUMBERS.CA, localAt('America/Los_Angeles', TUESDAY, 18, 0), false],
  ] as const)('%s → %s', (_label, n, at, expected) => {
    expect(withinRecipientWindow(n, at, EMAIL_WINDOW)).toBe(expected);
  });

  it('no number (an email-only record) uses the Chicago approximation with the unknown-state rule', () => {
    expect(withinRecipientWindow(null, localAt('America/Chicago', TUESDAY, 8, 0), EMAIL_WINDOW)).toBe(true);
    expect(withinRecipientWindow(null, localAt('America/Chicago', TUESDAY, 7, 59), EMAIL_WINDOW)).toBe(false);
    expect(withinRecipientWindow(null, localAt('America/Chicago', SUNDAY, 10), EMAIL_WINDOW)).toBe(false);
  });
});

describe('nextWindowOpening', () => {
  it('inside the window → now, to the millisecond', () => {
    const now = new Date(localAt('America/Los_Angeles', TUESDAY, 10, 17, 42).getTime() + 123);
    expect(nextWindowOpening(NUMBERS.CA, now, CALL_WINDOW)).toEqual(now);
  });

  it('before the opening → that day’s opening', () => {
    const now = localAt('America/Los_Angeles', TUESDAY, 6, 10);
    expect(nextWindowOpening(NUMBERS.CA, now, CALL_WINDOW)).toEqual(localAt('America/Los_Angeles', TUESDAY, 8, 0));
  });

  it('seconds before the opening → exactly the opening, not the next quarter hour after it', () => {
    const now = localAt('America/Los_Angeles', TUESDAY, 7, 59, 30);
    expect(nextWindowOpening(NUMBERS.CA, now, CALL_WINDOW)).toEqual(localAt('America/Los_Angeles', TUESDAY, 8, 0));
  });

  it('after the close → the next day’s opening', () => {
    const now = localAt('America/Los_Angeles', TUESDAY, 21, 30);
    expect(nextWindowOpening(NUMBERS.CA, now, CALL_WINDOW)).toEqual(localAt('America/Los_Angeles', '2026-07-15', 8, 0));
  });

  it('uses the window it is given (texts open at 09:00)', () => {
    const now = localAt('America/Los_Angeles', TUESDAY, 6, 10);
    expect(nextWindowOpening(NUMBERS.CA, now, TEXT_WINDOW)).toEqual(localAt('America/Los_Angeles', TUESDAY, 9, 0));
  });

  it('a state with a weekend restriction skips to the next allowed day (ME: Friday evening → Monday 09:00)', () => {
    const now = localAt('America/New_York', FRIDAY, 17, 30);
    expect(nextWindowOpening(NUMBERS.ME, now, CALL_WINDOW)).toEqual(localAt('America/New_York', '2026-07-20', 9, 0));
  });

  it('a Sunday ban skips Sunday (AL: Saturday night → Monday 08:00)', () => {
    const now = localAt('America/Chicago', SATURDAY, 21, 30);
    expect(nextWindowOpening(NUMBERS.AL, now, CALL_WINDOW)).toEqual(localAt('America/Chicago', '2026-07-20', 8, 0));
  });

  it('a Sunday late start is honored (TX texts: Sunday 10:00 → Sunday 12:00)', () => {
    const now = localAt('America/Chicago', SUNDAY, 10, 0);
    expect(nextWindowOpening(NUMBERS.TX, now, TEXT_WINDOW)).toEqual(localAt('America/Chicago', SUNDAY, 12, 0));
  });

  it('crosses the fall-back DST change (CA: Sat 2026-10-31 22:00 PDT → Sun 08:00 PST = 16:00Z)', () => {
    const now = new Date('2026-11-01T05:00:00Z'); // Sat 22:00 PDT
    expect(nextWindowOpening(NUMBERS.CA, now, CALL_WINDOW)).toEqual(new Date('2026-11-01T16:00:00Z'));
  });

  it('a number that fails open → now', () => {
    const now = localAt('America/Chicago', TUESDAY, 23, 0);
    expect(nextWindowOpening(NUMBERS.TOLL_FREE, now, CALL_WINDOW)).toEqual(now);
  });

  it('no number → the Chicago approximation (Sunday banned → Monday 08:00 CT)', () => {
    const now = localAt('America/Chicago', SUNDAY, 10, 0);
    expect(nextWindowOpening(null, now, EMAIL_WINDOW)).toEqual(localAt('America/Chicago', '2026-07-13', 8, 0));
  });

  it('a window that never opens → now + 8 days', () => {
    const now = localAt('America/Los_Angeles', TUESDAY, 10, 0);
    const never = { start: '10:00', endExclusive: '10:00' };
    expect(nextWindowOpening(NUMBERS.CA, now, never)).toEqual(new Date(now.getTime() + 8 * 24 * 60 * 60_000));
  });
});
