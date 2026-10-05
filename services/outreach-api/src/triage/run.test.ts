import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TriageResult } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceAuthError, type SalesforceClient } from '@cti/salesforce';
import { spentTodayMicros } from '../ai/budget.js';
import { costMicros, TRIAGE_MODEL, TriageOutputError, type TriageModel } from '../ai/model.js';
import { createTestDb, pgLane } from '../test/pg.js';
import type { FieldMap } from '@cti/contracts';
import { campaignById, leadId, seedCampaign, seedConnection, seedEnrollment, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { notesFingerprint, type NotesBundle } from './notes.js';
import { TRIAGE_BACKOFF_MS, TRIAGE_DEADLINE_MS, TRIAGE_PER_ORG_CAP, triageDueRecords } from './run.js';

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

/** `failFor` returns an error to throw for a query (or undefined to let it through). */
function fakeSalesforce(failFor: (soql: string) => Error | undefined = () => undefined): SalesforceClient {
  return {
    query: vi.fn(async (soql: string) => {
      const err = failFor(soql);
      if (err) throw err;
      return soql.includes('FROM Task') ? [] : [{ Notes__c: NOTES, Description: null }];
    }),
  } as unknown as SalesforceClient;
}

function fakeModel(result: TriageResult = PLAIN, modelId: string = TRIAGE_MODEL): TriageModel & { triage: ReturnType<typeof vi.fn> } {
  return { modelId, triage: vi.fn(async () => ({ result, inputTokens: 812, outputTokens: 143, model: TRIAGE_MODEL })) };
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
    await db.update(schema.crmRecords).set({ triageNeeded: false, triageAttemptedAt: null });
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

  /** More enrolled records for a tenant made by `tenant()`: sfRecordIds leadId(from)…leadId(to), oldest first. */
  async function moreRecords(t: { orgId: string; campaign: { id: string } }, from: number, to: number): Promise<string[]> {
    const ids: string[] = [];
    for (let n = from; n <= to; n++) {
      const id = await seedRecord(db, t.orgId, snapshot({ sfRecordId: leadId(n) }), { syncedAt: new Date(NOW.getTime() - (100 - n) * 60_000) });
      await seedEnrollment(db, t.orgId, t.campaign.id, id);
      ids.push(id);
    }
    return ids;
  }
  const failsFor = (n: number) => (soql: string) => (soql.includes(`Id = '${leadId(n)}'`) ? new Error('503 from Salesforce') : undefined);

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
      modelId: TRIAGE_MODEL,
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
    const model: TriageModel = { modelId: TRIAGE_MODEL, triage: vi.fn(async () => { throw new Error('529 overloaded'); }) };
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).toHaveBeenCalledTimes(1);
    expect((await record(a.recordId)).triageNeeded).toBe(true);
    expect((await record(b.recordId)).triageNeeded).toBe(true);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: '529 overloaded' }), 'triage: model call failed; stopping this tick');
  });

  it('skips the whole tick, before any claim or paid call, when the configured model has no price', async () => {
    const t = await tenant();
    const model = fakeModel(PLAIN, 'claude-not-in-the-price-table');
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).not.toHaveBeenCalled();
    expect(await record(t.recordId)).toMatchObject({ triageNeeded: true, triageAttemptedAt: null });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-not-in-the-price-table' }), expect.stringContaining('no price'));
  });

  it('a failure while releasing claims is logged and never masks the error that ended the tick', async () => {
    await tenant();
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'update') return () => { throw new Error('release failed'); };
        if (prop === 'select') return () => { throw new Error('settings read failed'); };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(triageDueRecords({ db: failing, clients: async () => fakeSalesforce(), model: fakeModel(), now: NOW, log })).rejects.toThrow('settings read failed');
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: 'release failed' }), expect.stringContaining('releasing'));
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

  it('leaves a record whose notes fetch failed pending and backed off, and carries on with the next records', async () => {
    const t = await tenant({ n: 1 });
    const [second, third] = await moreRecords(t, 2, 3);
    await db.update(schema.crmRecords).set({ syncedAt: new Date(NOW.getTime() - 99 * 60_000) }).where(eq(schema.crmRecords.id, t.recordId));
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(failsFor(1)), model, now: NOW, log });
    expect(model.triage).toHaveBeenCalledTimes(2);
    expect(await record(t.recordId)).toMatchObject({ triageNeeded: true, triageAttemptedAt: NOW });
    expect(await record(second!)).toMatchObject({ triageNeeded: false });
    expect(await record(third!)).toMatchObject({ triageNeeded: false });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ crmRecordId: t.recordId, err: '503 from Salesforce' }), 'triage: notes fetch failed');

    // Inside the backoff window the record is not picked again; once it has passed, it is.
    const soon = new Date(NOW.getTime() + TRIAGE_BACKOFF_MS - 1000);
    const later = new Date(NOW.getTime() + TRIAGE_BACKOFF_MS + 1000);
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: soon, log });
    expect(model.triage).toHaveBeenCalledTimes(2);
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: later, log });
    expect(model.triage).toHaveBeenCalledTimes(3);
    expect(await record(t.recordId)).toMatchObject({ triageNeeded: false });
  });

  it('skips the rest of a tenant on a SalesforceAuthError, releases its unstarted records, and triages other tenants', async () => {
    const a = await tenant({ n: 1 });
    const [a2] = await moreRecords(a, 2, 2);
    const b = await tenant({ n: 1 });
    await db.update(schema.crmRecords).set({ syncedAt: new Date(NOW.getTime() - 99 * 60_000) }).where(eq(schema.crmRecords.id, a.recordId));
    const model = fakeModel();
    const clients = async (orgId: string) => fakeSalesforce(orgId === a.orgId ? () => new SalesforceAuthError() : undefined);
    await triageDueRecords({ db, clients, model, now: NOW, log });
    expect(model.triage).toHaveBeenCalledTimes(1);
    expect(await record(b.recordId)).toMatchObject({ triageNeeded: false });
    expect(await record(a.recordId)).toMatchObject({ triageNeeded: true, triageAttemptedAt: NOW });
    expect(await record(a2!)).toMatchObject({ triageNeeded: true, triageAttemptedAt: null });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ orgId: a.orgId }), 'triage: salesforce connection unusable; skipping tenant');
  });

  it('skips a tenant whose Salesforce field map is invalid, leaving its records unclaimed', async () => {
    const orgId = await seedOrg(db);
    await seedConnection(db, orgId, { Lead: { notes: 'not an array' } } as unknown as FieldMap);
    const campaign = await seedCampaign(db, orgId, { status: 'dry_run' });
    const bad = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(1) }));
    await seedEnrollment(db, orgId, campaign.id, bad);
    const good = await tenant({ n: 2 });
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    expect(model.triage).toHaveBeenCalledTimes(1);
    expect(await record(good.recordId)).toMatchObject({ triageNeeded: false });
    expect(await record(bad)).toMatchObject({ triageNeeded: true, triageAttemptedAt: null });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId, err: 'the Salesforce field map is missing or invalid' }),
      'triage: no usable salesforce connection; skipping tenant',
    );
  });

  it('stops starting records once the deadline has passed and releases the rest', async () => {
    const t = await tenant({ n: 1 });
    const [second] = await moreRecords(t, 2, 2);
    await db.update(schema.crmRecords).set({ syncedAt: new Date(NOW.getTime() - 99 * 60_000) }).where(eq(schema.crmRecords.id, t.recordId));
    // start, then the check before record 1, then the check before record 2.
    const clock = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValue(1_000 + TRIAGE_DEADLINE_MS);
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log, clock });
    expect(model.triage).toHaveBeenCalledTimes(1);
    expect(await record(t.recordId)).toMatchObject({ triageNeeded: false });
    expect(await record(second!)).toMatchObject({ triageNeeded: true, triageAttemptedAt: null });
    expect(log.warn).toHaveBeenCalledWith({ orgId: t.orgId }, 'triage: tick deadline reached; leaving the rest for the next tick');
  });

  it('caps each tenant at its share of a batch, so a flood from one tenant cannot starve another', async () => {
    const flood = await tenant({ n: 1 });
    await moreRecords(flood, 2, 12);
    const small = await tenant({ n: 1 });
    await moreRecords(small, 2, 3);
    const model = fakeModel();
    await triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    const pending = async (orgId: string) =>
      (await db.select().from(schema.crmRecords).where(eq(schema.crmRecords.orgId, orgId))).filter((r) => r.triageNeeded).length;
    expect(TRIAGE_PER_ORG_CAP).toBe(5);
    expect(model.triage).toHaveBeenCalledTimes(TRIAGE_PER_ORG_CAP + 3);
    expect(await pending(flood.orgId)).toBe(12 - TRIAGE_PER_ORG_CAP);
    expect(await pending(small.orgId)).toBe(0);
  });

  it('backs off failing records so they cannot fill every batch', async () => {
    const flood = await tenant({ n: 1 });
    const floodIds = [flood.recordId, ...(await moreRecords(flood, 2, 5))];
    const other = await tenant({ n: 1 });
    // Every record of the first tenant fails its notes fetch, forever.
    const clients = async (orgId: string) => fakeSalesforce(orgId === flood.orgId ? () => new Error('500') : undefined);
    const model = fakeModel();
    await triageDueRecords({ db, clients, model, now: NOW, log });
    expect(await record(other.recordId)).toMatchObject({ triageNeeded: false });
    for (const id of floodIds) expect(await record(id)).toMatchObject({ triageNeeded: true, triageAttemptedAt: NOW });

    const newcomer = (await moreRecords(flood, 6, 6))[0]!;
    await triageDueRecords({ db, clients, model, now: new Date(NOW.getTime() + 60_000), log });
    // Only the record that had not yet been tried was picked; the five backed-off ones were left alone.
    expect(await record(newcomer)).toMatchObject({ triageAttemptedAt: new Date(NOW.getTime() + 60_000) });
    for (const id of floodIds) expect(await record(id)).toMatchObject({ triageAttemptedAt: NOW });
    await triageDueRecords({ db, clients, model, now: new Date(NOW.getTime() + TRIAGE_BACKOFF_MS + 1000), log });
    for (const id of floodIds) expect((await record(id)).triageAttemptedAt?.getTime()).toBe(NOW.getTime() + TRIAGE_BACKOFF_MS + 1000);
  });

  it('claims rows atomically: two overlapping ticks never triage the same record', async () => {
    const t = await tenant({ n: 1 });
    await moreRecords(t, 2, 5);
    const model = fakeModel();
    const run = () => triageDueRecords({ db, clients: async () => fakeSalesforce(), model, now: NOW, log });
    await Promise.all([run(), run()]);
    expect(model.triage).toHaveBeenCalledTimes(5);
    const rows = await db.select().from(schema.recordTriage).where(eq(schema.recordTriage.orgId, t.orgId));
    expect(new Set(rows.map((r) => r.crmRecordId)).size).toBe(5);
    expect(rows).toHaveLength(5);
  });
});
