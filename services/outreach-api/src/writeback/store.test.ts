/** Real Postgres: the write-back rows' claim, backoff, progress and CF-1 ids (Task 25). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { seedAiCall } from '../test/ai-call-seed.js';
import { seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { createTestDb, pgLane } from '../test/pg.js';
import {
  claimWritebacks,
  deferWriteback,
  finishWriteback,
  retryWriteback,
  saveProgress,
  WRITEBACK_BACKOFF_MS,
  WRITEBACK_LEASE_MS,
  WRITEBACK_MAX_ATTEMPTS,
  writebackActivityIds,
  writeTarget,
  type WritebackRow,
} from './store.js';

const NOW = new Date('2026-10-06T22:30:00.000Z');
const LEAD = '00Q8X00000AbCdEUAV';
const OPP = '0068X00000Oppt1QAA';

describe('writeTarget', () => {
  const row = { sfObject: 'Lead', sfRecordId: LEAD, convertedOpportunityId: null } as WritebackRow;
  it('is the call\'s record until a conversion is saved, then the new Opportunity', () => {
    expect(writeTarget(row)).toEqual({ sobject: 'Lead', id: LEAD });
    expect(writeTarget({ ...row, convertedOpportunityId: OPP })).toEqual({ sobject: 'Opportunity', id: OPP });
  });
});

describe.skipIf(!pgLane)('write-back store (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let orgId: string;
  let userId: string;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    ({ orgId } = await seedAiCallCampaign(db, 'active'));
    userId = await seedUser(db, orgId);
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });
  beforeEach(async () => {
    await db.execute(sql`delete from ai_call_writebacks`);
  });

  async function seedRow(over: Partial<typeof schema.aiCallWritebacks.$inferInsert> = {}): Promise<string> {
    const aiCallId = await seedAiCall(db, orgId, userId, { status: 'completed', outcome: 'appointment_set' });
    const [row] = await db
      .insert(schema.aiCallWritebacks)
      .values({ orgId, aiCallId, sfObject: 'Lead', sfRecordId: LEAD, outcome: 'appointment_set', nextAttemptAt: NOW, ...over })
      .returning({ id: schema.aiCallWritebacks.id });
    return row!.id;
  }
  const rowById = async (id: string) => (await db.select().from(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.id, id)))[0]!;

  it('a claim takes due rows only, skips leased ones, and takes an expired lease back', async () => {
    const due = await seedRow();
    await seedRow({ nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    await seedRow({ status: 'running', lockedUntil: new Date(NOW.getTime() + 60_000) });
    const expired = await seedRow({ status: 'running', lockedUntil: new Date(NOW.getTime() - 1), attempts: 2 });
    await seedRow({ status: 'done' });
    const claimed = await claimWritebacks(db, NOW, 10);
    expect(claimed.map((r) => r.id).sort()).toEqual([due, expired].sort());
    expect(claimed.find((r) => r.id === expired)).toMatchObject({ status: 'running', attempts: 3, steps: {}, plan: null, sfObject: 'Lead', sfRecordId: LEAD });
    expect((await rowById(due)).lockedUntil).toEqual(new Date(NOW.getTime() + WRITEBACK_LEASE_MS));
    expect(await claimWritebacks(db, NOW, 10)).toEqual([]);
  });

  it('two concurrent claims never return the same row', async () => {
    for (let i = 0; i < 12; i += 1) await seedRow();
    const [a, b] = await Promise.all([claimWritebacks(db, NOW, 8), claimWritebacks(db, NOW, 8)]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(12);
  });

  it('retryWriteback steps through the backoff, then fails at attempt 6', async () => {
    const id = await seedRow();
    for (let attempts = 1; attempts < WRITEBACK_MAX_ATTEMPTS; attempts += 1) {
      expect(await retryWriteback(db, id, attempts, NOW, 'SalesforceApiError 503')).toBe('retry');
      expect(await rowById(id)).toMatchObject({
        status: 'pending',
        nextAttemptAt: new Date(NOW.getTime() + WRITEBACK_BACKOFF_MS[attempts - 1]!),
        lockedUntil: null,
        lastError: 'SalesforceApiError 503',
        completedAt: null,
      });
    }
    expect(await retryWriteback(db, id, WRITEBACK_MAX_ATTEMPTS, NOW, 'still down')).toBe('failed');
    expect(await rowById(id)).toMatchObject({ status: 'failed', completedAt: NOW, lastError: 'still down', lockedUntil: null });
  });

  it('finishWriteback sets the status, completed_at and last_error', async () => {
    const id = await seedRow({ status: 'running', lockedUntil: NOW });
    await finishWriteback(db, id, 'partial', NOW, 'FIELD_CUSTOM_VALIDATION_EXCEPTION');
    expect(await rowById(id)).toMatchObject({ status: 'partial', completedAt: NOW, lastError: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', lockedUntil: null });
    await finishWriteback(db, id, 'done', NOW);
    expect(await rowById(id)).toMatchObject({ status: 'done', lastError: null });
  });

  it('deferWriteback waits until the given time and gives the attempt back', async () => {
    const id = await seedRow({ status: 'running', attempts: 2, lockedUntil: NOW });
    const midnight = new Date('2026-10-07T00:00:00.000Z');
    await deferWriteback(db, id, midnight, NOW, 'daily AI budget spent');
    expect(await rowById(id)).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: midnight, lockedUntil: null, lastError: 'daily AI budget spent' });
  });

  it('saveProgress merges steps, sets ids, and never replaces a saved conversion', async () => {
    const id = await seedRow();
    await saveProgress(db, id, { steps: { convert: { status: 'done', detail: 'converted' } }, convertedOpportunityId: OPP, convertedAccountId: '0018X00000Acct1QAA', convertedContactId: '0038X00000Cont1QAA' }, NOW);
    await saveProgress(db, id, { steps: { plan: { status: 'done' } }, convertedOpportunityId: '0068X00000Oppt2QAA', sfEventId: '00U8X00000Evnt1QAA', model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5 }, NOW);
    expect(await rowById(id)).toMatchObject({
      steps: { convert: { status: 'done', detail: 'converted' }, plan: { status: 'done' } },
      convertedOpportunityId: OPP,
      sfEventId: '00U8X00000Evnt1QAA',
      model: 'claude-sonnet-5-5',
      inputTokens: 10,
      outputTokens: 5,
      updatedAt: NOW,
    });
  });

  it('writebackActivityIds: the Event and Task ids from the columns and from the steps, by record or converted Opportunity (15-character cores)', async () => {
    await seedRow({ sfEventId: '00U8X00000Evnt1QAA', sfTaskId: '00T8X00000Task1QAA', steps: { appointment: { status: 'done', eventId: '00U8X00000Hold1QAA', taskId: '00T8X00000Task2QAA' } } });
    await seedRow({ sfRecordId: '00Q8X00000Other1AA', convertedOpportunityId: OPP, sfEventId: '00U8X00000Evnt2QAA', steps: 'not an object' as unknown as object });
    await seedRow({ sfRecordId: '00Q8X00000Third1AA', sfEventId: '00U8X00000Evnt3QAA' });
    const ids = await writebackActivityIds(db, orgId, [LEAD, OPP]);
    expect([...ids].sort()).toEqual(['00T8X00000Task1', '00T8X00000Task2', '00U8X00000Evnt1', '00U8X00000Evnt2', '00U8X00000Hold1']);
    expect(await writebackActivityIds(db, orgId, [])).toEqual(new Set());
  });
});
