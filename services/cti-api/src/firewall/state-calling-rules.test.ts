import { describe, expect, it } from 'vitest';
import {
  FEDERAL_BASELINE,
  STATE_CALLING_RULES,
  UNKNOWN_STATE_RULE,
  effectiveCallingWindow,
  resolveStateRule,
  todayIsoWeekday,
} from './state-calling-rules.js';

/**
 * 2026-08-31 ruling (Evren): weekend dialing is enabled GLOBALLY, except where
 * a state restricts it. This table is the per-state overlay — an engineering
 * default compiled from compliance vendors (kixie, LeadCompliant, tcpaguide,
 * 2026 tables), conservative where sources conflict. It is verbatim per the
 * brief: no creative additions or removals of rows.
 */
const TABLE_STATES = [
  'AL', 'MS', 'LA', 'RI', 'SD', 'ME', 'CO', 'OR', 'TX', 'NY', 'FL', 'OK', 'MD', 'MA', 'MO', 'WY', 'MI', 'ID', 'IN',
];

describe('STATE_CALLING_RULES — table sanity', () => {
  it('has exactly the 19 verbatim rows, no more, no fewer', () => {
    expect(Object.keys(STATE_CALLING_RULES).sort()).toEqual([...TABLE_STATES].sort());
  });

  it.each(TABLE_STATES)('%s parses: Mon-Fri (days 1-5) all have windows', (state) => {
    const rule = STATE_CALLING_RULES[state];
    expect(rule).toBeDefined();
    for (const day of [1, 2, 3, 4, 5] as const) {
      expect(rule!.days[day]).toBeDefined();
    }
  });

  it.each(['AL', 'MS', 'LA', 'RI', 'SD', 'ME', 'CO', 'OR'])('%s has no day 7 (Sunday banned)', (state) => {
    expect(STATE_CALLING_RULES[state]!.days[7]).toBeUndefined();
  });

  it('ME has no day 6 either (Saturday also banned — strictest row)', () => {
    expect(STATE_CALLING_RULES.ME!.days[6]).toBeUndefined();
  });

  it('TX day 7 starts 12:00 (Sunday noon)', () => {
    expect(STATE_CALLING_RULES.TX!.days[7]).toEqual({ start: '12:00', end: '21:00' });
  });

  it('NY day 7 starts 13:00 (no Sunday before 1 PM)', () => {
    expect(STATE_CALLING_RULES.NY!.days[7]).toEqual({ start: '13:00', end: '21:00' });
  });

  it('FL has the same 08:00-20:00 window all 7 days', () => {
    for (const day of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(STATE_CALLING_RULES.FL!.days[day]).toEqual({ start: '08:00', end: '20:00' });
    }
  });
});

describe('resolveStateRule', () => {
  it('returns UNKNOWN_STATE_RULE (Mon-Sat only, no Sunday) for a null state', () => {
    expect(resolveStateRule(null)).toBe(UNKNOWN_STATE_RULE);
    expect(resolveStateRule(null).days[7]).toBeUndefined();
    expect(resolveStateRule(null).days[6]).toBeDefined();
  });

  it('returns FEDERAL_BASELINE (all 7 days, 08:00-21:00) for a known state absent from the table', () => {
    expect(resolveStateRule('CA')).toBe(FEDERAL_BASELINE);
    expect(resolveStateRule('CA').days[7]).toEqual({ start: '08:00', end: '21:00' });
  });

  it('is case-insensitive for a listed state', () => {
    expect(resolveStateRule('al')).toBe(STATE_CALLING_RULES.AL);
  });
});

describe('effectiveCallingWindow — campaign ∩ state', () => {
  const campaign = { days: [1, 2, 3, 4, 5, 6, 7], start: '08:00', end: '20:00' };

  it('campaign 08-20 ∩ FL 08-20 = 08-20', () => {
    expect(effectiveCallingWindow(campaign, STATE_CALLING_RULES.FL!, 3)).toEqual({ start: '08:00', end: '20:00' });
  });

  it('campaign 08-20 ∩ RI Sat 10-17 = 10-17', () => {
    expect(effectiveCallingWindow(campaign, STATE_CALLING_RULES.RI!, 6)).toEqual({ start: '10:00', end: '17:00' });
  });

  it('campaign 08-20 ∩ TX Sun 12-21 = 12-20', () => {
    expect(effectiveCallingWindow(campaign, STATE_CALLING_RULES.TX!, 7)).toEqual({ start: '12:00', end: '20:00' });
  });

  it('banned day (state has no entry, e.g. AL Sunday) → null', () => {
    expect(effectiveCallingWindow(campaign, STATE_CALLING_RULES.AL!, 7)).toBeNull();
  });

  it('banned day (campaign itself excludes the day) → null', () => {
    const mfOnly = { days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00' };
    expect(effectiveCallingWindow(mfOnly, FEDERAL_BASELINE, 6)).toBeNull();
  });

  it('empty intersection (non-overlapping windows) → null', () => {
    const lateCampaign = { days: [1, 2, 3, 4, 5, 6, 7], start: '18:00', end: '19:00' };
    // ME Monday window is 09:00-17:00 — entirely before 18:00-19:00.
    expect(effectiveCallingWindow(lateCampaign, STATE_CALLING_RULES.ME!, 1)).toBeNull();
  });
});

describe('todayIsoWeekday', () => {
  it('resolves the ISO weekday (1=Mon..7=Sun) in a given timezone', () => {
    // 2026-07-13T17:00:00Z is Monday 10:00 America/Los_Angeles (PDT, UTC-7).
    expect(todayIsoWeekday(new Date('2026-07-13T17:00:00Z'), 'America/Los_Angeles')).toBe(1);
    // 2026-07-12 is a Sunday; 17:00Z is Sunday 10:00 PDT.
    expect(todayIsoWeekday(new Date('2026-07-12T17:00:00Z'), 'America/Los_Angeles')).toBe(7);
    // 2026-07-18 is a Saturday.
    expect(todayIsoWeekday(new Date('2026-07-18T17:00:00Z'), 'America/Los_Angeles')).toBe(6);
  });
});
