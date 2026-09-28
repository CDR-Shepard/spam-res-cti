import { describe, expect, it, vi } from 'vitest';
import { firstLandingDay, followUpTasksSoql, pickRolloverDay, rolloverBase } from './followup-day.js';

const weekdays = new Set([1, 2, 3, 4, 5]);
const none = new Set<string>();
// 2026-08-20 is a Thursday, 2026-08-21 a Friday; 2026-09-27 a Sunday.
describe('pickRolloverDay', () => {
  it('takes the next business day when it has room', async () => {
    const countOn = vi.fn(async () => 30);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-21');
    expect(countOn).toHaveBeenCalledWith('2026-08-21');
  });
  it('skips a full day and lands on the following business day (weekend skipped)', async () => {
    const counts: Record<string, number> = { '2026-08-21': 100, '2026-08-24': 70 };
    const countOn = vi.fn(async (d: string) => counts[d] ?? 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
  });
  it('treats exactly-at-cap as full', async () => {
    const countOn = vi.fn(async (d: string) => (d === '2026-08-21' ? 100 : 0));
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
  });
  it('skips holidays', async () => {
    const countOn = vi.fn(async () => 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: new Set(['2026-08-21']), countOn })).resolves.toBe('2026-08-24');
  });
  it('returns null when every day within the bound is full', async () => {
    const countOn = vi.fn(async () => 999);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: none, countOn, maxBusinessDays: 3 })).resolves.toBeNull();
    expect(countOn).toHaveBeenCalledTimes(3);
  });
  it('in 2 business days starts at the SECOND business day, over the weekend', async () => {
    const countOn = vi.fn(async () => 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 2, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
    expect(countOn).toHaveBeenCalledTimes(1);
    expect(countOn).toHaveBeenCalledWith('2026-08-24');
  });
  it('in 2 business days: a full start day still pushes on one business day at a time (the cap loop is unchanged)', async () => {
    const countOn = vi.fn(async (d: string) => (d === '2026-08-24' ? 100 : 0));
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 2, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-25');
  });
  it('the 30-business-day bound counts candidates from the start day, whatever businessDays is', async () => {
    const countOn = vi.fn(async (_d: string) => 999);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 2, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBeNull();
    expect(countOn).toHaveBeenCalledTimes(30);
    expect(countOn.mock.calls[0]![0]).toBe('2026-08-24');
  });
});

describe("rolloverBase — the later of the dial day and the task's own due date", () => {
  it('due in the future: the due date', () => {
    expect(rolloverBase('2026-09-27', '2026-09-28')).toBe('2026-09-28');
  });
  it('due today: the dial day', () => {
    expect(rolloverBase('2026-09-28', '2026-09-28')).toBe('2026-09-28');
  });
  it('overdue: the dial day', () => {
    expect(rolloverBase('2026-09-28', '2026-09-14')).toBe('2026-09-28');
  });
  it('no due date: the dial day', () => {
    expect(rolloverBase('2026-09-28', null)).toBe('2026-09-28');
    expect(rolloverBase('2026-09-28', undefined)).toBe('2026-09-28');
  });
  it('a due date in a shape we do not recognise: the dial day', () => {
    expect(rolloverBase('2026-09-28', '9/30/2026')).toBe('2026-09-28');
    expect(rolloverBase('2026-09-28', '2026-09-30T00:00:00Z')).toBe('2026-09-28');
  });
});

describe('firstLandingDay', () => {
  it('1 is exactly the next business day', () => {
    expect(firstLandingDay('2026-08-21', 1, weekdays, none)).toBe('2026-08-24');
  });
  it('2 is the business day after that', () => {
    expect(firstLandingDay('2026-08-21', 2, weekdays, none)).toBe('2026-08-25');
  });
  it('skips a holiday on the way', () => {
    expect(firstLandingDay('2026-08-20', 2, weekdays, new Set(['2026-08-21']))).toBe('2026-08-25');
  });
  it("Garrett's Sunday: a Monday task dialed on Sunday lands Tuesday (1) or Wednesday (2) — never back on Monday", () => {
    const base = rolloverBase('2026-09-27', '2026-09-28');
    expect(firstLandingDay(base, 1, weekdays, none)).toBe('2026-09-29');
    expect(firstLandingDay(base, 2, weekdays, none)).toBe('2026-09-30');
  });
});

describe('followUpTasksSoql', () => {
  it('can omit CTI_Origin__c, for a rep who cannot read it', () => {
    expect(followUpTasksSoql('005ABC', '2026-08-21', false)).toMatch(/^SELECT Id, Subject FROM Task WHERE /);
  });

  it('fetches the owner\'s OPEN tasks due that day (subjects are matched in code — SOQL cannot express the FU rule)', () => {
    const q = followUpTasksSoql('005ABC', '2026-08-21');
    // CTI_Origin__c is what the cap counts now that every dialed task rolls —
    // subject no longer identifies the dialer's own output.
    expect(q).toMatch(/^SELECT Id, Subject, CTI_Origin__c FROM Task WHERE /);
    expect(q).toContain("OwnerId = '005ABC'"); expect(q).toContain('IsClosed = false'); expect(q).toContain('ActivityDate = 2026-08-21');
    expect(q).toMatch(/LIMIT 500$/); expect(q).not.toMatch(/LIKE/);
  });
  it('escapes the owner id', () => {
    expect(followUpTasksSoql("005'x", '2026-08-21')).toContain("OwnerId = '005\\'x'");
  });
});
