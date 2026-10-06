/** Real Postgres: Test a record limits (plan 1E Task 4), counted under the per-admin advisory lock. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { addSpend } from '../ai/budget.js';
import { seedAiCall } from '../test/ai-call-seed.js';
import { seedUser } from '../test/call-plan-seed.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import {
  CALLS_PER_HOUR,
  PREVIEW_STALE_MS,
  PREVIEWS_PER_DAY,
  PREVIEWS_PER_HOUR,
  UNANSWERED_CALL_MS,
  withCallLimit,
  withPreviewLimit,
} from './limits.js';
import { insertRecordTest } from './store.js';

/** Tue Oct 6, 15:00 UTC. */
const NOW = new Date('2026-10-06T15:00:00.000Z');
const LEAD = '00Q8X00001AbCdEUAV';
const BUDGET = 5_000_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

describe.skipIf(!pgLane)('record test limits (real Postgres)', () => {
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
    const admin = await seedUser(db, orgId);
    return { orgId, admin };
  }
  /** A finished preview (ready) created at `createdAt`. */
  async function preview(orgId: string, userId: string, createdAt: Date, status: 'running' | 'ready' = 'ready'): Promise<string> {
    const id = await insertRecordTest(db, { orgId, requestedBy: userId, sfObject: 'Lead', sfRecordId: LEAD });
    await db.update(schema.aiRecordTests).set({ createdAt, status }).where(eq(schema.aiRecordTests.id, id));
    return id;
  }
  async function testCall(orgId: string, userId: string, createdAt: Date, aiCallId: string | null = null): Promise<void> {
    const recordTestId = await preview(orgId, userId, ago(5 * 60 * MIN));
    await db.insert(schema.aiRecordTestCalls).values({
      orgId, recordTestId, requestedBy: userId, mode: 'phone', toE164: '+15125550111', idempotencyKey: `rtest:${randomUUID()}`, aiCallId, createdAt,
    });
  }
  /** Inserts as the route does, but at the test's clock (never the DB default `now()`, which is the wall clock). */
  const previewLimit = (t: { orgId: string; admin: string }, over: { now?: Date; budgetMicros?: number } = {}) =>
    withPreviewLimit(db, { orgId: t.orgId, userId: t.admin, now: over.now ?? NOW, budgetMicros: over.budgetMicros ?? BUDGET }, async (tx) => {
      const [row] = await tx
        .insert(schema.aiRecordTests)
        .values({ orgId: t.orgId, requestedBy: t.admin, sfObject: 'Lead', sfRecordId: LEAD, createdAt: over.now ?? NOW })
        .returning({ id: schema.aiRecordTests.id });
      return row!.id;
    });
  const callLimit = (t: { orgId: string; admin: string }) => withCallLimit(db, { orgId: t.orgId, userId: t.admin, now: NOW }, async () => 'inserted');

  it('pins the numbers', () => {
    expect({ PREVIEWS_PER_HOUR, PREVIEWS_PER_DAY, CALLS_PER_HOUR, PREVIEW_STALE_MS, UNANSWERED_CALL_MS }).toEqual({
      PREVIEWS_PER_HOUR: 10, PREVIEWS_PER_DAY: 40, CALLS_PER_HOUR: 6, PREVIEW_STALE_MS: 360_000, UNANSWERED_CALL_MS: 120_000,
    });
  });

  it('1: 9 previews in the hour: the 10th is allowed; the 11th is RATE_LIMITED until the oldest is an hour old', async () => {
    const t = await tenant();
    await preview(t.orgId, t.admin, ago(65 * MIN)); // outside the hour
    for (let i = 0; i < 9; i++) await preview(t.orgId, t.admin, ago((50 - i) * MIN));
    const tenth = await previewLimit(t);
    expect(tenth.ok).toBe(true);
    await db.update(schema.aiRecordTests).set({ status: 'ready' }).where(eq(schema.aiRecordTests.orgId, t.orgId));
    expect(await previewLimit(t)).toEqual({ ok: false, refusal: { code: 'RATE_LIMITED', retryAt: new Date(ago(50 * MIN).getTime() + 60 * MIN), limit: 'previews_per_hour' } });
  });

  it('2: the hourly limit is per admin', async () => {
    const t = await tenant();
    const other = await seedUser(db, t.orgId);
    for (let i = 0; i < PREVIEWS_PER_HOUR; i++) await preview(t.orgId, other, ago((30 - i) * MIN));
    expect((await previewLimit(t)).ok).toBe(true);
  });

  it('3: 40 previews in the tenant today, across admins: RATE_LIMITED until the next UTC midnight', async () => {
    const t = await tenant();
    const admins = [t.admin, await seedUser(db, t.orgId), await seedUser(db, t.orgId), await seedUser(db, t.orgId), await seedUser(db, t.orgId)];
    for (let i = 0; i < PREVIEWS_PER_DAY; i++) await preview(t.orgId, admins[i % admins.length]!, ago((14 * 60 - i * 10) * MIN));
    const fresh = { orgId: t.orgId, admin: await seedUser(db, t.orgId) };
    expect(await previewLimit(fresh)).toEqual({ ok: false, refusal: { code: 'RATE_LIMITED', retryAt: new Date('2026-10-07T00:00:00.000Z'), limit: 'previews_per_day' } });
    // Yesterday's previews do not count.
    const u = await tenant();
    for (let i = 0; i < PREVIEWS_PER_DAY; i++) await preview(u.orgId, await seedUser(db, u.orgId), ago(16 * 60 * MIN + i * MIN));
    expect((await previewLimit(u)).ok).toBe(true);
  });

  it('4: a running preview 1 minute old is PREVIEW_RUNNING; one 7 minutes old no longer blocks', async () => {
    const t = await tenant();
    const id = await preview(t.orgId, t.admin, ago(1 * MIN), 'running');
    expect(await previewLimit(t)).toEqual({ ok: false, refusal: { code: 'PREVIEW_RUNNING' } });
    await db.update(schema.aiRecordTests).set({ createdAt: ago(7 * MIN) }).where(eq(schema.aiRecordTests.id, id));
    expect((await previewLimit(t)).ok).toBe(true);
  });

  it('5: a spent daily budget is AI_BUDGET_SPENT', async () => {
    const t = await tenant();
    await addSpend(db, t.orgId, NOW, BUDGET);
    expect(await previewLimit(t)).toEqual({ ok: false, refusal: { code: 'AI_BUDGET_SPENT' } });
    expect((await previewLimit(t, { budgetMicros: BUDGET + 1 })).ok).toBe(true);
  });

  it('6: two concurrent starts at 9 used: exactly one inserts', async () => {
    const t = await tenant();
    for (let i = 0; i < PREVIEWS_PER_HOUR - 1; i++) await preview(t.orgId, t.admin, ago((40 - i) * MIN));
    const results = await Promise.all([previewLimit(t), previewLimit(t)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const rows = await db.select().from(schema.aiRecordTests).where(eq(schema.aiRecordTests.orgId, t.orgId));
    expect(rows).toHaveLength(PREVIEWS_PER_HOUR);
  });

  it('a refusal inserts nothing', async () => {
    const t = await tenant();
    await preview(t.orgId, t.admin, ago(MIN), 'running');
    let ran = false;
    const r = await withPreviewLimit(db, { orgId: t.orgId, userId: t.admin, now: NOW, budgetMicros: BUDGET }, async () => {
      ran = true;
    });
    expect(r.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('7: a test call whose AI call is in progress is CALL_IN_PROGRESS; once completed it no longer blocks', async () => {
    const t = await tenant();
    const aiCallId = await seedAiCall(db, t.orgId, t.admin, { status: 'in_progress', createdAt: ago(3 * MIN) });
    await testCall(t.orgId, t.admin, ago(3 * MIN), aiCallId);
    expect(await callLimit(t)).toEqual({ ok: false, refusal: { code: 'CALL_IN_PROGRESS' } });
    await db.update(schema.aiCalls).set({ status: 'completed' }).where(eq(schema.aiCalls.id, aiCallId));
    expect(await callLimit(t)).toEqual({ ok: true, value: 'inserted' });
  });

  it('7b: a live AI call created over an hour ago (stuck) no longer blocks', async () => {
    const t = await tenant();
    const aiCallId = await seedAiCall(db, t.orgId, t.admin, { status: 'ringing', createdAt: ago(61 * MIN) });
    await testCall(t.orgId, t.admin, ago(61 * MIN), aiCallId);
    expect((await callLimit(t)).ok).toBe(true);
  });

  it('8: a call row with no AI call, 30 s old, is CALL_IN_PROGRESS; 3 minutes old it no longer blocks', async () => {
    const t = await tenant();
    await testCall(t.orgId, t.admin, ago(30_000));
    expect(await callLimit(t)).toEqual({ ok: false, refusal: { code: 'CALL_IN_PROGRESS' } });
    const u = await tenant();
    await testCall(u.orgId, u.admin, ago(3 * MIN));
    expect((await callLimit(u)).ok).toBe(true);
  });

  it('9: 6 test calls in the hour: the 7th is RATE_LIMITED until the oldest is an hour old', async () => {
    const t = await tenant();
    for (let i = 0; i < CALLS_PER_HOUR; i++) {
      const aiCallId = await seedAiCall(db, t.orgId, t.admin, { status: 'completed', createdAt: ago((55 - i * 5) * MIN) });
      await testCall(t.orgId, t.admin, ago((55 - i * 5) * MIN), aiCallId);
    }
    expect(await callLimit(t)).toEqual({ ok: false, refusal: { code: 'RATE_LIMITED', retryAt: new Date(ago(55 * MIN).getTime() + 60 * MIN), limit: 'calls_per_hour' } });
    const other = { orgId: t.orgId, admin: await seedUser(db, t.orgId) };
    expect((await callLimit(other)).ok).toBe(true);
  });
});
