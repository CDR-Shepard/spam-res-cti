import { describe, expect, it } from 'vitest';
import { callingWindowFor, isWithinCallingHours } from './index.js';
import {
  CALLING_HOURS_END_HHMM_EXCLUSIVE,
  CALLING_HOURS_START_HHMM,
  CALLING_HOUR_END_INCLUSIVE,
  CALLING_HOUR_START,
  withinCallingHours,
} from '../dialer/pick-did.js';

/**
 * The calling window has TWO enforcement sites: the firewall's per-call gate
 * (click-to-dial) and the power dialer's per-lead pre-filter. They used to
 * carry independent numbers — 8am–8pm vs 8am–9pm — so a call the firewall
 * BLOCKED at 8:10pm local could still be attempted by the dialer at that same
 * instant, and nothing in CI would have noticed them drifting further apart
 * (spam-defense audit §5, gap 1).
 *
 * This file is the interlock: it imports BOTH functions and asserts they give
 * the same verdict at the boundary hours. It fails if either site's comparator
 * changes, if the exported constant pair moves, or if the HH:MM derivation
 * stops lining up with the hour comparison.
 */
const SD_NUMBER = '+16195551234'; // 619 → America/Los_Angeles
const TZ = 'America/Los_Angeles';
const WEEKDAYS = [1, 2, 3, 4, 5];

/** A Pacific weekday (Mon 2026-07-13 is PDT, UTC-7) at `hour:minute` local. */
function localPacific(hour: number, minute = 0): Date {
  const utcHour = hour + 7;
  const day = 13 + Math.floor(utcHour / 24);
  const h = utcHour % 24;
  return new Date(`2026-07-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
}

/** The firewall's verdict for the SHARED window — a campaign row that has not
 *  narrowed anything (the schema-default case after the clamp). */
function firewallSays(at: Date): boolean {
  const w = callingWindowFor({ callingHoursStart: null, callingHoursEnd: null });
  return isWithinCallingHours(at, TZ, w.start, w.end, WEEKDAYS);
}

describe('calling window — the two enforcement sites cannot drift', () => {
  it('the exported pair is the documented TCPA-safe window: local hour in [8, 20]', () => {
    expect([CALLING_HOUR_START, CALLING_HOUR_END_INCLUSIVE]).toEqual([8, 20]);
    // The firewall's comparator wants an EXCLUSIVE end, so the whole of hour 20
    // (through 20:59) has to be inside it — 21:00, not 20:00.
    expect(CALLING_HOURS_START_HHMM).toBe('08:00');
    expect(CALLING_HOURS_END_HHMM_EXCLUSIVE).toBe('21:00');
  });

  it.each([
    [7, false], // an hour before the window opens
    [8, true], // the opening boundary
    [20, true], // the last dialable hour — the one that used to disagree
    [21, false], // the closing boundary
  ])('agrees at %i:00 local (dialable = %s)', (hour, dialable) => {
    const at = localPacific(hour);
    expect(withinCallingHours(SD_NUMBER, at)).toBe(dialable);
    expect(firewallSays(at)).toBe(dialable);
  });

  it('agrees through the whole of the last hour, including 20:59', () => {
    const at = localPacific(20, 59);
    expect(withinCallingHours(SD_NUMBER, at)).toBe(true);
    expect(firewallSays(at)).toBe(true);
  });

  it('agrees at every hour of the day, not just the boundaries', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = localPacific(hour);
      expect([hour, firewallSays(at)]).toEqual([hour, withinCallingHours(SD_NUMBER, at)]);
    }
  });
});

describe('callingWindowFor — a campaign may narrow, never widen', () => {
  it('defaults to the shared window when the campaign has no values', () => {
    expect(callingWindowFor({ callingHoursStart: null, callingHoursEnd: null }))
      .toEqual({ start: '08:00', end: '21:00' });
  });

  it('keeps a narrower org window exactly as configured (this org runs 08:00-20:00)', () => {
    expect(callingWindowFor({ callingHoursStart: '09:00', callingHoursEnd: '20:00' }))
      .toEqual({ start: '09:00', end: '20:00' });
  });

  it('clamps a campaign row that would push past the TCPA-safe bound', () => {
    // 07:00-22:00 is outside 8am-9pm on both ends — the row cannot buy itself
    // an earlier open or a later close.
    expect(callingWindowFor({ callingHoursStart: '07:00', callingHoursEnd: '22:00' }))
      .toEqual({ start: '08:00', end: '21:00' });
  });
});
