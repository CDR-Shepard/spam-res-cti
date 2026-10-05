import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@cti/db';
import { createTestDb, pgLane } from '../test/pg.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { addSpend, budgetMicros, spentTodayMicros, utcDay } from './budget.js';

describe('budget (pure)', () => {
  it('utcDay is the UTC calendar day', () => {
    expect(utcDay(new Date('2026-10-05T23:30:00-05:00'))).toBe('2026-10-06');
    expect(utcDay(new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-05');
  });
  it('budgetMicros converts the daily USD budget to micro-dollars', () => {
    const base = { liveChannels: ['rep_call' as const], consentFromWebForms: false, consentFromInboundCalls: false };
    expect(budgetMicros({ ...base, aiDailyBudgetUsd: 25 })).toBe(25_000_000);
    expect(budgetMicros({ ...base, aiDailyBudgetUsd: 0.5 })).toBe(500_000);
  });
});

describe.skipIf(!pgLane)('budget (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  });
  afterAll(async () => {
    await drop?.();
  });

  it('adds spend per tenant per UTC day', async () => {
    const orgId = await seedOrg(db);
    const day1 = new Date('2026-10-05T12:00:00Z');
    const day2 = new Date('2026-10-06T00:30:00Z');
    expect(await spentTodayMicros(db, orgId, day1)).toBe(0);
    await addSpend(db, orgId, day1, 1_527);
    await addSpend(db, orgId, day1, 473);
    await addSpend(db, orgId, day1, 0);
    await addSpend(db, orgId, day2, 10);
    expect(await spentTodayMicros(db, orgId, day1)).toBe(2_000);
    expect(await spentTodayMicros(db, orgId, day2)).toBe(10);
    expect(await spentTodayMicros(db, await seedOrg(db), day1)).toBe(0);
  });

  it('is safe under concurrent callers', async () => {
    const orgId = await seedOrg(db);
    const now = new Date('2026-10-05T12:00:00Z');
    await Promise.all(Array.from({ length: 20 }, () => addSpend(db, orgId, now, 100)));
    expect(await spentTodayMicros(db, orgId, now)).toBe(2_000);
  });

  it('rejects a negative or fractional amount', async () => {
    const orgId = await seedOrg(db);
    await expect(addSpend(db, orgId, new Date(), -1)).rejects.toThrow(/invalid AI spend/);
    await expect(addSpend(db, orgId, new Date(), 1.5)).rejects.toThrow(/invalid AI spend/);
  });
});
