import { describe, expect, it } from 'vitest';
import { isNonUsNumber, usOnlyPair } from './us-only.js';

// User ruling 2026-10-12: the power dialer skips non-US numbers. "US" is the
// region libphonenumber assigns — the US and its territories — not our own
// area-code map, which is missing real US codes (239 SW Florida, 659, 686, 943).
describe('isNonUsNumber', () => {
  it.each([
    ['+526634580000', 'Mexico'],
    ['+917780700000', 'India'],
    ['+14162340000', 'Canada (Toronto)'],
    ['+17422340000', 'Canada (Ontario overlay)'],
    ['+18762340000', 'Jamaica (shares +1)'],
    ['+14412340000', 'Bermuda (shares +1)'],
  ])('%s (%s) is non-US', (n) => {
    expect(isNonUsNumber(n)).toBe(true);
  });

  it.each([
    ['+16192340000', 'San Diego'],
    ['+12393341000', 'SW Florida (absent from our area-code map)'],
    ['+19432340000', 'Georgia overlay (absent from our area-code map)'],
    ['+17872340000', 'Puerto Rico'],
    ['+16712340000', 'Guam'],
    ['+18002752273', 'toll-free'],
  ])('%s (%s) is US', (n) => {
    expect(isNonUsNumber(n)).toBe(false);
  });

  it('a +1 number libphonenumber cannot place is left alone (not skipped as non-US)', () => {
    // Twilio has the last word on those (engine.ts's refused-destination skip).
    expect(isNonUsNumber('+10000000000')).toBe(false);
  });
});

describe('usOnlyPair', () => {
  const US1 = '+16192340000';
  const US2 = '+18582340000';
  const MX = '+526634580000';
  const CA = '+14162340000';

  it('a US pair is untouched', () => {
    expect(usOnlyPair(US1, US2)).toEqual({ toNumber: US1, secondNumber: US2, nonUs: false });
  });

  it('a non-US first number with a US second dials the US one, with nothing left for the retry', () => {
    expect(usOnlyPair(MX, US2)).toEqual({ toNumber: US2, secondNumber: null, nonUs: false });
  });

  it('a non-US second number is dropped, so the end-of-run retry can never dial it', () => {
    expect(usOnlyPair(US1, CA)).toEqual({ toNumber: US1, secondNumber: null, nonUs: false });
  });

  it('no US number at all: non-US, the first number kept so the row still shows it', () => {
    expect(usOnlyPair(MX, null)).toEqual({ toNumber: MX, secondNumber: null, nonUs: true });
    expect(usOnlyPair(MX, CA)).toEqual({ toNumber: MX, secondNumber: null, nonUs: true });
  });

  it('no number is not non-US (it is unreachable, decided elsewhere)', () => {
    expect(usOnlyPair(null, null)).toEqual({ toNumber: null, secondNumber: null, nonUs: false });
  });
});
