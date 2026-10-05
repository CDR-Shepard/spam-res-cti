/**
 * AI call campaign refresh against the lead picker, on real Postgres: the picker is edited
 * while a refresh is mid-flight (Salesforce reads take seconds), so the refresh's enroll
 * and exit statements re-check the selection themselves instead of trusting the Ids it read
 * at the start.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { createTestDb, pgLane } from '../test/pg.js';
import { campaignById, enrollmentsOf, leadId, seedCampaign, seedOrg, snapshot, TEST_FIELD_MAP } from '../test/outreach-fixtures.js';
import { fetchRecords, type SfRecordSnapshot } from './records.js';
import { contactKeys } from './eligibility.js';
import { enrollRecords } from './enroll.js';
import { deselectRecords, selectRecords } from './selection.js';
import { DESELECTED_EXIT_REASON, refreshCampaign } from './refresh.js';

vi.mock('./records.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./records.js')>()),
  fetchRecords: vi.fn(),
}));

const NOW = new Date('2026-10-05T15:00:00.000Z');
const LATER = new Date('2026-10-05T19:30:00.000Z');
const STAMP = '2026-10-01T12:00:00.000+0000';

const reachable = (n: number, over: Partial<SfRecordSnapshot> = {}) =>
  snapshot({ sfRecordId: leadId(n), phones: [{ field: 'MobilePhone', e164: `+1512555${2000 + n}` }], lastModifiedAt: new Date(STAMP.replace('+0000', 'Z')), ...over });

/** A stand-in Salesforce. `onStamps` runs inside the LastModifiedDate query, which is after the refresh read the selection. */
function fakeSalesforce(members: number[], hooks: { onStamps?: () => Promise<void> } = {}) {
  const client = {
    listViewSoql: vi.fn(async () => "SELECT Id, Name FROM Lead WHERE Status = 'Open'"),
    queryAll: vi.fn(async (q: string) => {
      if (q.startsWith('SELECT Id, LastModifiedDate FROM Lead WHERE Id IN (')) {
        await hooks.onStamps?.();
        const ids = [...q.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
        return ids.map((Id) => ({ Id, LastModifiedDate: STAMP }));
      }
      return members.map((n) => ({ attributes: { type: 'Lead', url: '' }, Id: leadId(n) }));
    }),
  } as unknown as SalesforceClient;
  return { client };
}

describe.skipIf(!pgLane)('AI call refresh vs the lead picker (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  });
  afterAll(async () => {
    await drop?.();
  });
  beforeEach(() => {
    vi.mocked(fetchRecords).mockReset();
  });

  const pick = (orgId: string, campaignId: string, ...ns: number[]) => selectRecords(db, { orgId, campaignId, userId: null, sfRecordIds: ns.map(leadId) });
  const unpick = (orgId: string, campaignId: string, ...ns: number[]) => deselectRecords(db, orgId, campaignId, ns.map(leadId));
  const serve = (...records: SfRecordSnapshot[]) =>
    vi.mocked(fetchRecords).mockImplementation(async (_c, _o, ids) => records.filter((r) => ids.includes(r.sfRecordId)));
  const refresh = async (campaignId: string, client: SalesforceClient, now = NOW) =>
    refreshCampaign({ db, client, fieldMap: TEST_FIELD_MAP, now }, await campaignById(db, campaignId));
  const statusOf = async (campaignId: string) => {
    const rows = await db
      .select({ sf: schema.crmRecords.sfRecordId, e: schema.campaignEnrollments })
      .from(schema.campaignEnrollments)
      .innerJoin(schema.crmRecords, eq(schema.crmRecords.id, schema.campaignEnrollments.crmRecordId))
      .where(eq(schema.campaignEnrollments.campaignId, campaignId));
    return new Map(rows.map((r) => [r.sf, r.e]));
  };

  it('does not enroll a lead that was deselected after the refresh read the selection', async () => {
    const orgId = await seedOrg(db);
    const c = await seedCampaign(db, orgId, { mode: 'ai_call', status: 'dry_run' });
    await pick(orgId, c.id, 1, 2);
    // The field fetch happens after the selection read: an admin unticks lead 2 meanwhile.
    vi.mocked(fetchRecords).mockImplementation(async (_c, _o, ids) => {
      await unpick(orgId, c.id, 2);
      return [reachable(1), reachable(2)].filter((r) => ids.includes(r.sfRecordId));
    });
    const sf = fakeSalesforce([1, 2]);
    const out = await refresh(c.id, sf.client);
    expect(out.enrolled).toBe(1);
    expect([...(await statusOf(c.id)).keys()]).toEqual([leadId(1)]);
  });

  it('does not exit a lead that was re-selected after the refresh read the selection', async () => {
    const orgId = await seedOrg(db);
    const c = await seedCampaign(db, orgId, { mode: 'ai_call', status: 'dry_run' });
    await pick(orgId, c.id, 1, 2);
    serve(reachable(1), reachable(2));
    await refresh(c.id, fakeSalesforce([1, 2]).client);

    // Lead 1 is unticked, then ticked again while the refresh is checking lead 2 in Salesforce.
    await unpick(orgId, c.id, 1);
    const sf = fakeSalesforce([1, 2], { onStamps: async () => { await pick(orgId, c.id, 1); } });
    const out = await refresh(c.id, sf.client, LATER);
    expect(sf.client.queryAll).toHaveBeenCalledWith(expect.stringContaining(' IN ('));
    expect(out.exited).toBe(0);
    expect((await statusOf(c.id)).get(leadId(1))).toMatchObject({ status: 'active', exitReason: null });
  });

  it('still exits a lead that stays deselected (the guard does not block the exit)', async () => {
    const orgId = await seedOrg(db);
    const c = await seedCampaign(db, orgId, { mode: 'ai_call', status: 'dry_run' });
    await pick(orgId, c.id, 1);
    serve(reachable(1));
    await refresh(c.id, fakeSalesforce([1]).client);
    await unpick(orgId, c.id, 1);
    expect((await refresh(c.id, fakeSalesforce([1]).client, LATER)).exited).toBe(1);
    expect((await statusOf(c.id)).get(leadId(1))).toMatchObject({ status: 'exited', exitReason: DESELECTED_EXIT_REASON });
    expect(await enrollmentsOf(db, c.id)).toHaveLength(1);
  });

  it('does not look for new Salesforce Tasks for an AI call campaign (its research reads them itself)', async () => {
    const orgId = await seedOrg(db);
    const c = await seedCampaign(db, orgId, { mode: 'ai_call', status: 'dry_run', lastRefreshedAt: new Date('2026-10-05T14:00:00Z'), tasksCheckedAt: new Date('2026-10-05T14:00:00Z') });
    await pick(orgId, c.id, 1);
    serve(reachable(1));
    const sf = fakeSalesforce([1]);
    await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW, triage: true }, await campaignById(db, c.id));
    expect(vi.mocked(sf.client.queryAll).mock.calls.some(([q]) => String(q).includes('FROM Task'))).toBe(false);
    expect((await campaignById(db, c.id)).tasksCheckedAt?.toISOString()).toBe('2026-10-05T14:00:00.000Z');
  });

  it('still looks for them in a sequence campaign (triage reads them)', async () => {
    const orgId = await seedOrg(db);
    const c = await seedCampaign(db, orgId, { status: 'dry_run', lastRefreshedAt: new Date('2026-10-05T14:00:00Z'), tasksCheckedAt: new Date('2026-10-05T14:00:00Z') });
    serve(reachable(1));
    const sf = fakeSalesforce([1]);
    await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW, triage: true }, await campaignById(db, c.id));
    expect((await campaignById(db, c.id)).tasksCheckedAt?.toISOString()).toBe(NOW.toISOString());
  });

  describe('re-selecting a lead whose enrollment exited as deselected', () => {
    /** Lead 1 enrolled, then unticked and exited by a refresh; lead 2 stays enrolled (so later refreshes still read Salesforce). */
    async function exitedLead() {
      const orgId = await seedOrg(db);
      const c = await seedCampaign(db, orgId, { mode: 'ai_call', status: 'dry_run' });
      await pick(orgId, c.id, 1, 2);
      serve(reachable(1), reachable(2));
      await refresh(c.id, fakeSalesforce([1, 2]).client);
      await unpick(orgId, c.id, 1);
      expect((await refresh(c.id, fakeSalesforce([1, 2]).client, NOW)).exited).toBe(1);
      const before = (await statusOf(c.id)).get(leadId(1))!;
      expect(before).toMatchObject({ status: 'exited', exitReason: DESELECTED_EXIT_REASON });
      return { orgId, c, id: before.id };
    }
    const keysOf = async (enrollmentId: string) =>
      (await db.select().from(schema.enrollmentContactKeys).where(eq(schema.enrollmentContactKeys.enrollmentId, enrollmentId))).map((k) => `${k.key}:${k.active}`).sort();

    it('reactivates the SAME enrollment: active, call_stage research, keys claimed again', async () => {
      const { orgId, c, id } = await exitedLead();
      await db.update(schema.campaignEnrollments).set({ callStage: 'review', callPrepareError: 'old error', callPrepareAttemptedAt: NOW, callPrepareFailures: 3 }).where(eq(schema.campaignEnrollments.id, id));
      await pick(orgId, c.id, 1);
      const out = await refresh(c.id, fakeSalesforce([1, 2]).client, LATER);
      expect(out).toMatchObject({ enrolled: 1, exited: 0 });
      const after = (await statusOf(c.id)).get(leadId(1))!;
      expect(after).toMatchObject({ id, status: 'active', exitReason: null, callStage: 'research', callPrepareError: null, callPrepareAttemptedAt: null, callPrepareFailures: 0 });
      expect(await keysOf(id)).toEqual(['+15125552001:true']);
      expect(await enrollmentsOf(db, c.id)).toHaveLength(2);
      // And the next refresh leaves it alone.
      expect(await refresh(c.id, fakeSalesforce([1, 2]).client, LATER)).toMatchObject({ enrolled: 0, exited: 0 });
    });

    it('claims the keys of the record as it is now, not as it was when the lead was enrolled', async () => {
      const { orgId, c, id } = await exitedLead();
      serve(reachable(1, { phones: [{ field: 'MobilePhone', e164: '+15125559999' }], lastModifiedAt: new Date('2026-10-04T00:00:00Z') }), reachable(2));
      await pick(orgId, c.id, 1);
      await db.update(schema.crmRecords).set({ sfLastModifiedAt: new Date('2026-09-01T00:00:00Z') }).where(eq(schema.crmRecords.sfRecordId, leadId(1)));
      await refresh(c.id, fakeSalesforce([1, 2]).client, LATER);
      expect(await keysOf(id)).toEqual(['+15125559999:true']);
    });

    it('does not reactivate an exit for any other reason, even when the lead is selected', async () => {
      const { orgId, c, id } = await exitedLead();
      await db.update(schema.campaignEnrollments).set({ exitReason: 'closed' }).where(eq(schema.campaignEnrollments.id, id));
      await pick(orgId, c.id, 1);
      expect((await refresh(c.id, fakeSalesforce([1, 2]).client, LATER)).enrolled).toBe(0);
      expect((await statusOf(c.id)).get(leadId(1))).toMatchObject({ status: 'exited', exitReason: 'closed' });
    });

    it('behaves like a fresh enrollment conflict when another active enrollment holds the key: stays exited', async () => {
      const { orgId, c, id } = await exitedLead();
      const other = await seedCampaign(db, orgId, { mode: 'ai_call', status: 'dry_run' });
      const [record] = await db.select().from(schema.crmRecords).where(eq(schema.crmRecords.sfRecordId, leadId(1)));
      const taken = await enrollRecords(db, { orgId, campaignId: other.id, touchDays: [0], now: NOW, records: [{ crmRecordId: record!.id, keys: contactKeys(reachable(1)) }] });
      expect(taken.enrolled).toBe(1);
      await pick(orgId, c.id, 1);
      const out = await refresh(c.id, fakeSalesforce([1, 2]).client, LATER);
      expect(out.enrolled).toBe(0);
      expect((await statusOf(c.id)).get(leadId(1))).toMatchObject({ id, status: 'exited', exitReason: DESELECTED_EXIT_REASON });
      expect(await keysOf(id)).toEqual(['+15125552001:false']);
    });

    it('does not reactivate a lead that is no longer eligible (closed in Salesforce)', async () => {
      const { orgId, c } = await exitedLead();
      serve(reachable(1, { isClosed: true, lastModifiedAt: new Date('2026-10-04T00:00:00Z') }), reachable(2));
      await db.update(schema.crmRecords).set({ sfLastModifiedAt: new Date('2026-09-01T00:00:00Z') }).where(eq(schema.crmRecords.sfRecordId, leadId(1)));
      await pick(orgId, c.id, 1);
      expect((await refresh(c.id, fakeSalesforce([1, 2]).client, LATER)).enrolled).toBe(0);
      expect((await statusOf(c.id)).get(leadId(1))).toMatchObject({ status: 'exited' });
    });

    it('does not reactivate a lead that was unticked again after the refresh read the selection', async () => {
      const { orgId, c } = await exitedLead();
      await pick(orgId, c.id, 1);
      const sf = fakeSalesforce([1, 2], { onStamps: async () => { await unpick(orgId, c.id, 1); } });
      expect((await refresh(c.id, sf.client, LATER)).enrolled).toBe(0);
      expect((await statusOf(c.id)).get(leadId(1))).toMatchObject({ status: 'exited', exitReason: DESELECTED_EXIT_REASON });
    });
  });
});
