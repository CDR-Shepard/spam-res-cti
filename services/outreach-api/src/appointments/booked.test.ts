/** Real Postgres: the times AI calls booked with the owner that no Salesforce Event shows yet (Fix 1, I-4). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type Db } from '@cti/db';
import { seedAiCall } from '../test/ai-call-seed.js';
import { seedUser } from '../test/call-plan-seed.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { BOOKED_LOOKBACK_DAYS, bookedNotOnCalendar } from './booked.js';

const NOW = new Date('2026-10-06T15:00:00.000Z');
const UNTIL = new Date('2026-10-21T15:00:00.000Z');
const DAY = 86_400_000;
const OWNER = '0058X00000Fsx39QAB';
const OTHER = '0058X00000Abcd1QAB';
const booked = (start: string, end: string, owner = OWNER) => ({
  slotId: 'p1', kind: 'phone', start, end, specialistSfUserId: owner, addressConfirmed: true, note: '', bookedAt: NOW.toISOString(),
});

describe.skipIf(!pgLane)('bookedNotOnCalendar (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function tenant() {
    const orgId = await seedOrg(db);
    const userId = await seedUser(db, orgId);
    const call = (appointment: unknown, over: Partial<typeof schema.aiCalls.$inferInsert> = {}) =>
      seedAiCall(db, orgId, userId, { status: 'completed', createdAt: new Date(NOW.getTime() - DAY), appointment, ...over });
    const read = () => bookedNotOnCalendar(db, { orgId, ownerSfUserId: OWNER, now: NOW, until: UNTIL });
    return { orgId, call, read };
  }

  it('the owner\'s booked times in [now, until) come back as timed busy items (15- and 18-character ids alike)', async () => {
    const t = await tenant();
    await t.call(booked('2026-10-07T17:00:00.000Z', '2026-10-07T17:15:00.000Z'));
    await t.call(booked('2026-10-08T16:00:00.000Z', '2026-10-08T17:00:00.000Z', OWNER.slice(0, 15)));
    const got = await t.read();
    expect(got).toHaveLength(2);
    expect(got).toEqual(expect.arrayContaining([
      { start: new Date('2026-10-07T17:00:00.000Z'), end: new Date('2026-10-07T17:15:00.000Z'), allDay: false },
      { start: new Date('2026-10-08T16:00:00.000Z'), end: new Date('2026-10-08T17:00:00.000Z'), allDay: false },
    ]));
  });

  it('leaves out: another owner, a test call, a time already over or past until, junk, a call older than the look-back, another tenant', async () => {
    const t = await tenant();
    await t.call(booked('2026-10-07T17:00:00.000Z', '2026-10-07T17:15:00.000Z', OTHER));
    await t.call(booked('2026-10-07T18:00:00.000Z', '2026-10-07T18:15:00.000Z'), { isTest: true });
    await t.call(booked('2026-10-06T14:00:00.000Z', '2026-10-06T15:00:00.000Z'));
    await t.call(booked('2026-10-21T15:00:00.000Z', '2026-10-21T16:00:00.000Z'));
    await t.call({ slotId: 'p1', start: 'soon' });
    await t.call(booked('2026-10-07T19:00:00.000Z', '2026-10-07T19:15:00.000Z'), { createdAt: new Date(NOW.getTime() - (BOOKED_LOOKBACK_DAYS + 1) * DAY) });
    await t.call(null);
    const other = await tenant();
    await other.call(booked('2026-10-07T20:00:00.000Z', '2026-10-07T20:15:00.000Z'));
    expect(await t.read()).toEqual([]);
  });

  it('a booking whose write-back created the Event is the calendar\'s; one with a write-back but no Event yet still counts', async () => {
    const t = await tenant();
    const withEvent = await t.call(booked('2026-10-07T17:00:00.000Z', '2026-10-07T17:15:00.000Z'));
    const noEvent = await t.call(booked('2026-10-07T18:00:00.000Z', '2026-10-07T18:15:00.000Z'));
    const row = { orgId: t.orgId, sfObject: 'Lead' as const, sfRecordId: '00Q8X00000AbCdEUAZ', outcome: 'appointment_set' };
    await db.insert(schema.aiCallWritebacks).values([
      { ...row, aiCallId: withEvent, status: 'done' as const, sfEventId: '00U8X00000AbCdEUAZ' },
      { ...row, aiCallId: noEvent, status: 'running' as const },
    ]);
    expect(await t.read()).toEqual([{ start: new Date('2026-10-07T18:00:00.000Z'), end: new Date('2026-10-07T18:15:00.000Z'), allDay: false }]);
  });
});
