import { describe, expect, it } from 'vitest';
import { CALLBACK_MAX_AHEAD_MS, callbackAtFromLocal, localTimeFor, recipientTimeZone, wallTimeToDate } from './local-time.js';

const NOW = new Date('2026-10-05T18:00:00Z'); // Monday

describe('localTimeFor', () => {
  it('says the recipient-local weekday, date, year and time, from the area code', () => {
    expect(localTimeFor('+16195550100', NOW)).toBe('Monday, October 5, 2026, 11:00 AM'); // San Diego, PDT
    expect(localTimeFor('+12125550100', NOW)).toBe('Monday, October 5, 2026, 2:00 PM'); // New York, EDT
  });

  it('the date is the local one, not the UTC one', () => {
    expect(localTimeFor('+16195550100', new Date('2026-10-06T03:00:00Z'))).toBe('Monday, October 5, 2026, 8:00 PM');
  });

  it('falls back to Central time for an unmapped number or a browser test client', () => {
    expect(localTimeFor('+442071234567', NOW)).toBe('Monday, October 5, 2026, 1:00 PM');
    expect(localTimeFor('client:aitest_x', NOW)).toBe('Monday, October 5, 2026, 1:00 PM');
  });
});

describe('recipientTimeZone', () => {
  it('maps a US number by area code, else Central', () => {
    expect(recipientTimeZone('+16195550100')).toBe('America/Los_Angeles');
    expect(recipientTimeZone('+442071234567')).toBe('America/Chicago');
  });
});

describe('wallTimeToDate', () => {
  it('reads a local date and time in the given zone', () => {
    expect(wallTimeToDate('2026-10-08T17:00', 'America/Los_Angeles')?.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    expect(wallTimeToDate('2026-10-08T09:30', 'America/New_York')?.toISOString()).toBe('2026-10-08T13:30:00.000Z');
  });

  it('uses the offset on that day, across a DST change', () => {
    // LA leaves daylight time on 2026-11-01: 17:00 is UTC-7 before and UTC-8 after.
    expect(wallTimeToDate('2026-10-31T17:00', 'America/Los_Angeles')?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(wallTimeToDate('2026-11-02T17:00', 'America/Los_Angeles')?.toISOString()).toBe('2026-11-03T01:00:00.000Z');
  });

  it('is null for a time the clocks skip, a day that does not exist, or anything not YYYY-MM-DDTHH:MM', () => {
    expect(wallTimeToDate('2027-03-14T02:30', 'America/Los_Angeles')).toBeNull();
    expect(wallTimeToDate('2026-02-30T10:00', 'America/Los_Angeles')).toBeNull();
    for (const bad of ['', 'Thursday after 5', '2026-10-08', '2026-10-08T5:00', '2026-10-08T17:00Z', '2026-10-08T17:00:00', '2026-13-01T10:00', '2026-10-08T24:00', '2026-10-08T17:60']) {
      expect(wallTimeToDate(bad, 'America/Los_Angeles')).toBeNull();
    }
  });
});

describe('callbackAtFromLocal', () => {
  it('turns the agreed local time into an instant in the seller zone', () => {
    expect(callbackAtFromLocal('2026-10-08T17:00', 'America/Los_Angeles', NOW)?.toISOString()).toBe('2026-10-09T00:00:00.000Z');
  });

  it('allows a time earlier today (they said "this morning" late), but not a past day or a guessed year', () => {
    expect(callbackAtFromLocal('2026-10-05T10:30', 'America/Los_Angeles', NOW)?.toISOString()).toBe('2026-10-05T17:30:00.000Z');
    expect(callbackAtFromLocal('2026-10-04T17:00', 'America/Los_Angeles', NOW)).toBeNull();
    expect(callbackAtFromLocal('2025-10-08T17:00', 'America/Los_Angeles', NOW)).toBeNull();
  });

  it('allows next year, but nothing further out than CALLBACK_MAX_AHEAD_MS', () => {
    expect(callbackAtFromLocal('2027-10-04T09:00', 'America/Los_Angeles', NOW)).not.toBeNull();
    const tooFar = new Date(NOW.getTime() + CALLBACK_MAX_AHEAD_MS + 86_400_000);
    expect(callbackAtFromLocal(`${tooFar.toISOString().slice(0, 10)}T09:00`, 'America/Los_Angeles', NOW)).toBeNull();
  });

  it('is null for words', () => {
    expect(callbackAtFromLocal('Thursday after 5 PM', 'America/Los_Angeles', NOW)).toBeNull();
  });
});
