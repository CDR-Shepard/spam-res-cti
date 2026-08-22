import { describe, expect, it, vi } from 'vitest';
import { followUpTasksSoql, pickRolloverDay } from './followup-day.js';

const weekdays = new Set([1, 2, 3, 4, 5]);
const none = new Set<string>();
// 2026-08-21 is a Friday.
describe('pickRolloverDay', () => {
  it('takes the next business day when it has room', async () => {
    const countOn = vi.fn(async () => 30);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-21');
    expect(countOn).toHaveBeenCalledWith('2026-08-21');
  });
  it('skips a full day and lands on the following business day (weekend skipped)', async () => {
    const counts: Record<string, number> = { '2026-08-21': 100, '2026-08-24': 70 };
    const countOn = vi.fn(async (d: string) => counts[d] ?? 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
  });
  it('treats exactly-at-cap as full', async () => {
    const countOn = vi.fn(async (d: string) => (d === '2026-08-21' ? 100 : 0));
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
  });
  it('skips holidays', async () => {
    const countOn = vi.fn(async () => 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: new Set(['2026-08-21']), countOn })).resolves.toBe('2026-08-24');
  });
  it('returns null when every day within the bound is full', async () => {
    const countOn = vi.fn(async () => 999);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: none, countOn, maxBusinessDays: 3 })).resolves.toBeNull();
    expect(countOn).toHaveBeenCalledTimes(3);
  });
});

describe('followUpTasksSoql', () => {
  it('fetches the owner\'s OPEN tasks due that day (subjects are matched in code — SOQL cannot express the FU rule)', () => {
    const q = followUpTasksSoql('005ABC', '2026-08-21');
    expect(q).toMatch(/^SELECT Id, Subject FROM Task WHERE /);
    expect(q).toContain("OwnerId = '005ABC'"); expect(q).toContain('IsClosed = false'); expect(q).toContain('ActivityDate = 2026-08-21');
    expect(q).toMatch(/LIMIT 500$/); expect(q).not.toMatch(/LIKE/);
  });
  it('escapes the owner id', () => {
    expect(followUpTasksSoql("005'x", '2026-08-21')).toContain("OwnerId = '005\\'x'");
  });
});
