import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TriageResult } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { spentTodayMicros } from '../ai/budget.js';
import { costMicros, TRIAGE_MODEL, TriageOutputError, type TriageModel } from '../ai/model.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { campaignById, leadId, seedCampaign, seedConnection, seedEnrollment, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { notesFingerprint, type NotesBundle } from './notes.js';
import { triageDueRecords } from './run.js';

const NOW = new Date('2026-10-05T15:00:00.000Z');
const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
const NOTES = 'Prefers text, works nights.';
/** What the fake Salesforce returns for every record: TEST_FIELD_MAP.Lead.notes is ['Notes__c', 'Description']. */
const BUNDLE: NotesBundle = { fields: [{ name: 'Notes__c', value: NOTES }], tasks: [] };

const PLAIN: TriageResult = {
  summary: 'Owner prefers texts because she works nights.',
  channels: [{ channel: 'sms', reason: '"Prefers text"' }],
  timing: null,
  tags: ['prefers_text'],
  doNotContact: null,
};
const SOLD: TriageResult = { ...PLAIN, channels: [], tags: [], doNotContact: { category: 'sold', quote: 'sold the house last month' } };

function fakeSalesforce(): SalesforceClient {
  return {
    query: vi.fn(async (soql: string) => (soql.includes('FROM Task') ? [] : [{ Notes__c: NOTES, Description: null }])),
  } as unknown as SalesforceClient;
}

function fakeModel(result: TriageResult = PLAIN): TriageModel & { triage: ReturnType<typeof vi.fn> } {
  return { triage: vi.fn(async () => ({ result, inputTokens: 812, outputTokens: 143, model: TRIAGE_MODEL })) };
}

describe.skipIf(!pgLane)('triageDueRecords (real Postgres, fake model and Salesforce)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  });
  afterAll(async () => {
    await drop?.();
  });
  beforeEach(async () => {
    log.warn.mockReset();
    log.error.mockReset();
    // The tick scans every tenant: retire the records earlier tests left pending.
    await db.update(schema.crmRecords).set({ triageNeeded: false });
  });

  /** A tenant with a connection, one dry-run campaign, and one enrolled record needing triage. */
  async function tenant(opts: { settings?: Record<string, unknown>; notesHash?: string | null; n?: number } = {}) {
    const orgId = await seedOrg(db, opts.settings ?? {});
    await seedConnection(db, orgId);
    const campaign = await seedCampaign(db, orgId, { status: 'dry_run' });
    const recordId = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(opts.n ?? 1) }), { notesHash: opts.notesHash ?? null });
    const enrollmentId = await seedEnrollment(db, orgId, campaign.id, recordId);
    return { orgId, campaign, recordId, enrollmentId };
  }

  async function record(id: string) {
    const [row] = await db.select().from(schema.crmRecords).where(eq(schema.crmRecords.id, id));
    return row!;
  }
  async function triageRows(recordId: string) {
    return db.select().from(schema.recordTriage).where(eq(schema.recordTriage.crmRecordId, recordId));
  }

  it('skips the model when the notes fingerprint is unchanged, and clears triage_needed', async () => {
    const t = await tenant({ notesHash: notesFingerprint(BUNDLE) });
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).not.toHaveBeenCalled();
    expect((await record(t.recordId)).triageNeeded).toBe(false);
    expect(await triageRows(t.recordId)).toEqual([]);
  });

  it('calls the model for changed notes, stores the result, and records the spend in micro-dollars', async () => {
    const t = await tenant();
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).toHaveBeenCalledTimes(1);
    expect(model.triage.mock.calls[0]![0].user).toContain(NOTES);
    const [row] = await triageRows(t.recordId);
    expect(row).toMatchObject({ orgId: t.orgId, notesHash: notesFingerprint(BUNDLE), model: TRIAGE_MODEL, result: PLAIN, inputTokens: 812, outputTokens: 143 });
    expect(await record(t.recordId)).toMatchObject({ notesHash: notesFingerprint(BUNDLE), triageNeeded: false });
    expect(await spentTodayMicros(db, t.orgId, NOW)).toBe(costMicros(TRIAGE_MODEL, 812, 143));
  });

  it('skips a tenant whose budget is spent and pauses its running campaigns with ai_budget', async () => {
    const t = await tenant();
    await db.insert(schema.aiUsageDays).values({ orgId: t.orgId, day: '2026-10-05', costMicros: 25_000_000 });
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).not.toHaveBeenCalled();
    expect(await campaignById(db, t.campaign.id)).toMatchObject({ status: 'paused', pauseReason: 'ai_budget', pausedFrom: 'dry_run' });
    expect((await record(t.recordId)).triageNeeded).toBe(true);
  });

  it('stops a tenant mid-batch once the spend reaches its budget', async () => {
    // $0.001 budget = 1,000 micro-dollars; one call costs 812 + 143 * 5 = 1,527.
    const t = await tenant({ settings: { aiDailyBudgetUsd: 0.001 } });
    const second = await seedRecord(db, t.orgId, snapshot({ sfRecordId: leadId(2) }));
    await seedEnrollment(db, t.orgId, t.campaign.id, second);
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).toHaveBeenCalledTimes(1);
    expect(await campaignById(db, t.campaign.id)).toMatchObject({ status: 'paused', pauseReason: 'ai_budget' });
  });

  it('holds a do-not-contact flag for review: active enrollments → needs_review, open touches skipped', async () => {
    const t = await tenant();
    const otherCampaign = await seedCampaign(db, t.orgId, { status: 'active', name: 'Other' });
    const exitedId = await seedEnrollment(db, t.orgId, otherCampaign.id, t.recordId, { status: 'exited', exitReason: 'left_query' });
    await db.insert(schema.touches).values([
      { orgId: t.orgId, enrollmentId: t.enrollmentId, seq: 1, channel: 'rep_call', status: 'sent', dueAt: NOW },
      { orgId: t.orgId, enrollmentId: t.enrollmentId, seq: 2, channel: 'rep_call', status: 'planned', dueAt: NOW },
    ]);
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model: fakeModel(SOLD), now: NOW, log });
    const enrollments = await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.crmRecordId, t.recordId));
    const byId = new Map(enrollments.map((e) => [e.id, e]));
    expect(byId.get(t.enrollmentId)).toMatchObject({ status: 'needs_review', reviewCategory: 'sold', reviewQuote: 'sold the house last month', nextTouchAt: null });
    expect(byId.get(t.enrollmentId)!.flaggedAt?.toISOString()).toBe(NOW.toISOString());
    expect(byId.get(exitedId)).toMatchObject({ status: 'exited', reviewCategory: null });
    const touches = await db.select().from(schema.touches).where(eq(schema.touches.enrollmentId, t.enrollmentId)).orderBy(schema.touches.seq);
    expect(touches.map((x) => [x.status, x.skipReason])).toEqual([
      ['sent', null],
      ['skipped', 'needs_review'],
    ]);
  });

  it('records the spend of an invalid model answer and does not retry it until the record changes', async () => {
    const t = await tenant();
    const model: TriageModel = {
      triage: vi.fn(async () => {
        throw new TriageOutputError('invalid triage output: tags.0: Invalid enum value', { inputTokens: 700, outputTokens: 100, model: TRIAGE_MODEL });
      }),
    };
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(await spentTodayMicros(db, t.orgId, NOW)).toBe(700 + 500);
    expect(await record(t.recordId)).toMatchObject({ triageNeeded: false, notesHash: null });
    expect(await triageRows(t.recordId)).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ crmRecordId: t.recordId }), 'triage: model output rejected');
  });

  it('stops the whole tick when the model API fails, leaving every record for the next tick', async () => {
    const a = await tenant({ n: 1 });
    const b = await tenant({ n: 2 });
    const model: TriageModel = { triage: vi.fn(async () => { throw new Error('529 overloaded'); }) };
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).toHaveBeenCalledTimes(1);
    expect((await record(a.recordId)).triageNeeded).toBe(true);
    expect((await record(b.recordId)).triageNeeded).toBe(true);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: '529 overloaded' }), 'triage: model call failed; stopping this tick');
  });

  it('ignores records whose only enrollment is not active or whose campaign is not running', async () => {
    const t = await tenant();
    await db.update(schema.campaigns).set({ status: 'draft' }).where(eq(schema.campaigns.id, t.campaign.id));
    const u = await tenant({ n: 2 });
    await db.update(schema.campaignEnrollments).set({ status: 'exited' }).where(eq(schema.campaignEnrollments.id, u.enrollmentId));
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).not.toHaveBeenCalled();
    expect((await record(t.recordId)).triageNeeded).toBe(true);
  });
});
