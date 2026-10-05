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
  const unpick = (campaignId: string, ...ns: number[]) => deselectRecords(db, campaignId, ns.map(leadId));
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
      await unpick(c.id, 2);
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
    await unpick(c.id, 1);
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
    await unpick(c.id, 1);
    expect((await refresh(c.id, fakeSalesforce([1]).client, LATER)).exited).toBe(1);
    expect((await statusOf(c.id)).get(leadId(1))).toMatchObject({ status: 'exited', exitReason: DESELECTED_EXIT_REASON });
    expect(await enrollmentsOf(db, c.id)).toHaveLength(1);
  });
});
