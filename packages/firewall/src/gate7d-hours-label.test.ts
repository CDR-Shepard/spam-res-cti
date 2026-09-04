import { describe, expect, it } from 'vitest';
import { enforcedStateHoursLabel } from './index.js';

/**
 * FIX-4 (weekend-calling fix wave): gate 7d ("state-specific calling rules")
 * used to print the per-state hours straight from the legacy
 * `state_calling_rules` DB table (seeded in 0005_spam_resistance.sql), which
 * has DRIFTED from the enforced `STATE_CALLING_RULES` code table the
 * weekend-calling overlay actually applies at gate 6 — e.g. the DB seed has
 * OK at 08:00-20:00, but `STATE_CALLING_RULES.OK` (the table gate 6 enforces)
 * is 09:00-20:00. A rep reading gate 7d's detail was told a window the
 * firewall doesn't actually allow. `enforcedStateHoursLabel` is the
 * corrected source: today's weekday window from the ENFORCED table, via the
 * same `resolveStateRule`/`todayIsoWeekday` helpers gate 6 uses. Pure and
 * exported so it's directly testable without standing up the whole
 * `evaluate()` pipeline (db, SF client), same pattern as `callingWindowFor`.
 */
describe('enforcedStateHoursLabel — gate 7d renders from the ENFORCED table, not the legacy DB row', () => {
  it('OK detail shows 09:00-20:00 (the enforced table), not the DB seed\'s 08:00-20:00', () => {
    const wednesday = new Date('2026-07-15T17:00:00Z'); // Wed 12:00 America/Chicago (CDT, UTC-5)
    expect(enforcedStateHoursLabel('OK', wednesday, 'America/Chicago')).toBe('09:00-20:00');
  });

  it('reflects the enforced table for a day-narrowed state (RI Saturday 10:00-17:00)', () => {
    const saturday = new Date('2026-07-18T17:00:00Z'); // Sat noon America/New_York-ish; use ET explicitly below
    expect(enforcedStateHoursLabel('RI', saturday, 'America/New_York')).toBe('10:00-17:00');
  });

  it('falls back to a day-ban label when the enforced table bans the state on this weekday (AL Sunday)', () => {
    const sunday = new Date('2026-07-12T17:00:00Z');
    expect(enforcedStateHoursLabel('AL', sunday, 'America/Chicago')).toBe('no calling today');
  });
});
