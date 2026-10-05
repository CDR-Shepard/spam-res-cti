import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { SalesforceApiError, SalesforceAuthError, type SalesforceClient } from '@cti/salesforce';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { createTestDb, pgLane } from '../test/pg.js';
import {
  campaignById,
  enrollmentsOf,
  leadId,
  seedCampaign,
  seedConnection,
  seedOrg,
  snapshot,
  TEST_FIELD_MAP,
} from '../test/outreach-fixtures.js';
import { fetchRecords, type SfRecordSnapshot } from './records.js';
import { refreshCampaign, refreshDueCampaigns, REFRESH_TICK_BUDGET_MS } from './refresh.js';

vi.mock('./records.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./records.js')>()),
  fetchRecords: vi.fn(),
}));

const NOW = new Date('2026-10-05T15:00:00.000Z');
const LATER = new Date('2026-10-05T19:30:00.000Z');
const STAMP_1 = '2026-10-01T12:00:00.000+0000';
const STAMP_2 = '2026-10-05T18:00:00.000+0000';
const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

/**
 * A stand-in Salesforce: `members` is what the list view returns, `stamps` each record's
 * LastModifiedDate, `records` what a field fetch returns. Every SOQL is recorded.
 */
function fakeSalesforce(state: { members: string[]; stamps: Record<string, string>; records: Record<string, SfRecordSnapshot> }) {
  const soql: string[] = [];
  const client = {
    listViewSoql: vi.fn(async () => "SELECT Id, Name FROM Lead WHERE Status = 'Open'"),
    queryAll: vi.fn(async (q: string) => {
      soql.push(q);
      if (q.startsWith('SELECT Id, LastModifiedDate FROM Lead WHERE Id IN (')) {
        const ids = [...q.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
        return ids.filter((id) => id in state.stamps).map((Id) => ({ Id, LastModifiedDate: state.stamps[Id] }));
      }
      return state.members.map((Id) => ({ attributes: { type: 'Lead', url: `/services/data/v60.0/sobjects/Lead/${Id}` }, Id }));
    }),
  } as unknown as SalesforceClient;
  vi.mocked(fetchRecords).mockImplementation(async (_client, _object, ids) =>
    ids.flatMap((id) => (state.records[id] ? [state.records[id]!] : [])),
  );
  return { client, soql };
}

describe.skipIf(!pgLane)('campaign refresh (real Postgres)', () => {
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
    log.warn.mockReset();
  });

  const reachable = (n: number, over: Partial<SfRecordSnapshot> = {}) =>
    snapshot({ sfRecordId: leadId(n), phones: [{ field: 'MobilePhone', e164: `+1512555${2000 + n}` }], lastModifiedAt: new Date(STAMP_1.replace('+0000', 'Z')), ...over });

  describe('refreshCampaign', () => {
    it('enrolls new eligible members, skips ineligible ones, and stamps the campaign', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const sf = fakeSalesforce({
        members: [leadId(1), leadId(2)],
        stamps: {},
        records: { [leadId(1)]: reachable(1), [leadId(2)]: reachable(2, { phones: [], email: null }) },
      });
      const out = await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW }, campaign);
      expect(out).toEqual({ members: 2, enrolled: 1, exited: 0 });
      expect(vi.mocked(fetchRecords)).toHaveBeenCalledWith(sf.client, 'Lead', [leadId(1), leadId(2)], TEST_FIELD_MAP.Lead);
      const enrollments = await enrollmentsOf(db, campaign.id);
      expect(enrollments).toHaveLength(1);
      expect(enrollments[0]!.nextTouchAt?.toISOString()).toBe(NOW.toISOString());
      const after = await campaignById(db, campaign.id);
      expect(after).toMatchObject({ memberCount: 2, lastRefreshError: null });
      expect(after.lastRefreshedAt?.toISOString()).toBe(NOW.toISOString());
    });

    it('does not re-fetch a member whose LastModifiedDate did not move, and re-fetches one that did', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const state = { members: [leadId(1), leadId(2)], stamps: {} as Record<string, string>, records: { [leadId(1)]: reachable(1), [leadId(2)]: reachable(2) } };
      const sf = fakeSalesforce(state);
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW }, campaign);
      vi.mocked(fetchRecords).mockClear();

      state.stamps = { [leadId(1)]: STAMP_1, [leadId(2)]: STAMP_1 };
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
      expect(vi.mocked(fetchRecords)).not.toHaveBeenCalled();
      expect(sf.soql.at(-1)).toBe(`SELECT Id, LastModifiedDate FROM Lead WHERE Id IN ('${leadId(1)}','${leadId(2)}')`);

      state.stamps = { [leadId(1)]: STAMP_1, [leadId(2)]: STAMP_2 };
      state.records[leadId(2)] = reachable(2, { lastModifiedAt: new Date(STAMP_2.replace('+0000', 'Z')) });
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
      expect(vi.mocked(fetchRecords)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetchRecords).mock.calls[0]![2]).toEqual([leadId(2)]);
    });

    it('exits a member who left the query with left_query, unless the enrollment is conversing', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const state = { members: [leadId(1), leadId(2)], stamps: {} as Record<string, string>, records: { [leadId(1)]: reachable(1), [leadId(2)]: reachable(2) } };
      const sf = fakeSalesforce(state);
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW }, campaign);
      const [first, second] = await enrollmentsOf(db, campaign.id);
      await db.update(schema.campaignEnrollments).set({ status: 'conversing' }).where(eq(schema.campaignEnrollments.id, second!.id));

      state.members = [];
      const out = await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
      expect(out).toEqual({ members: 0, enrolled: 0, exited: 1 });
      const rows = new Map((await enrollmentsOf(db, campaign.id)).map((e) => [e.id, e]));
      expect(rows.get(first!.id)).toMatchObject({ status: 'exited', exitReason: 'left_query' });
      expect(rows.get(second!.id)).toMatchObject({ status: 'conversing', exitReason: null });
    });

    it('exits a member whose record closed (Lead converted or Opportunity closed) with closed', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const state = { members: [leadId(1)], stamps: {} as Record<string, string>, records: { [leadId(1)]: reachable(1) } };
      const sf = fakeSalesforce(state);
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW }, campaign);

      state.stamps = { [leadId(1)]: STAMP_2 };
      state.records[leadId(1)] = reachable(1, { isClosed: true, lastModifiedAt: new Date(STAMP_2.replace('+0000', 'Z')) });
      const out = await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
      expect(out.exited).toBe(1);
      expect((await enrollmentsOf(db, campaign.id))[0]).toMatchObject({ status: 'exited', exitReason: 'closed' });
    });

    it('exits a member whose only number was opted out since the last refresh', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const state = { members: [leadId(1)], stamps: {} as Record<string, string>, records: { [leadId(1)]: reachable(1) } };
      const sf = fakeSalesforce(state);
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW }, campaign);
      await db.insert(schema.optOuts).values({ orgId, e164: '+15125552001', source: 'stop_keyword' });
      state.stamps = { [leadId(1)]: STAMP_1 };
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
      expect((await enrollmentsOf(db, campaign.id))[0]).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
    });

    it('does not re-enroll a person in the same campaign after they exited', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const state = { members: [leadId(1)], stamps: {} as Record<string, string>, records: { [leadId(1)]: reachable(1) } };
      const sf = fakeSalesforce(state);
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW }, campaign);
      state.members = [];
      await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
      state.members = [leadId(1)];
      state.stamps = { [leadId(1)]: STAMP_1 };
      const out = await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
      expect(out.enrolled).toBe(0);
      expect(await enrollmentsOf(db, campaign.id)).toHaveLength(1);
    });
  });

  describe('refreshDueCampaigns', () => {
    beforeEach(async () => {
      // The tick scans every tenant: park the campaigns earlier tests left running.
      await db.update(schema.campaigns).set({ status: 'draft' });
    });

    it('pauses every running campaign of a tenant whose Salesforce connection is unusable (crm_broken)', async () => {
      const orgId = await seedOrg(db);
      const other = await seedOrg(db);
      const dryRun = await seedCampaign(db, orgId, { status: 'dry_run' });
      const active = await seedCampaign(db, orgId, { status: 'active' });
      const draft = await seedCampaign(db, orgId, { status: 'draft' });
      const otherTenant = await seedCampaign(db, other, { status: 'active', lastRefreshedAt: NOW });
      const clients = vi.fn(async (id: string) => {
        if (id === orgId) throw new CrmNotConnectedError('no connection');
        throw new Error('not expected');
      });
      await refreshDueCampaigns({ db, clients, now: NOW, log });
      expect(await campaignById(db, dryRun.id)).toMatchObject({ status: 'paused', pauseReason: 'crm_broken', pausedFrom: 'dry_run' });
      expect(await campaignById(db, active.id)).toMatchObject({ status: 'paused', pauseReason: 'crm_broken', pausedFrom: 'active' });
      expect(await campaignById(db, draft.id)).toMatchObject({ status: 'draft', pauseReason: null });
      expect(await campaignById(db, otherTenant.id)).toMatchObject({ status: 'active', pauseReason: null });
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ orgId, paused: 2 }), expect.stringContaining('paused'));
    });

    it('treats a token that cannot be refreshed (SalesforceAuthError) mid-refresh the same way', async () => {
      const orgId = await seedOrg(db);
      await seedConnection(db, orgId);
      const campaign = await seedCampaign(db, orgId, { status: 'active' });
      const client = { listViewSoql: vi.fn(async () => { throw new SalesforceAuthError('refresh failed'); }) } as unknown as SalesforceClient;
      await refreshDueCampaigns({ db, clients: async () => client, now: NOW, log });
      expect(await campaignById(db, campaign.id)).toMatchObject({ status: 'paused', pauseReason: 'crm_broken' });
    });

    it('refreshes only campaigns that are due, and stores any other failure for a retry on the next tick', async () => {
      const orgId = await seedOrg(db);
      await seedConnection(db, orgId);
      const lastSuccess = new Date(NOW.getTime() - 241 * 60_000);
      const due = await seedCampaign(db, orgId, { status: 'active', lastRefreshedAt: lastSuccess });
      const fresh = await seedCampaign(db, orgId, { status: 'active', lastRefreshedAt: new Date(NOW.getTime() - 30 * 60_000) });
      const client = { listViewSoql: vi.fn(async () => { throw new Error('INVALID_FIELD: No such column Foo__c'); }) } as unknown as SalesforceClient;
      await refreshDueCampaigns({ db, clients: async () => client, now: NOW, log });
      expect(client.listViewSoql).toHaveBeenCalledTimes(1);
      const failed = await campaignById(db, due.id);
      expect(failed).toMatchObject({ status: 'active', pauseReason: null, lastRefreshError: 'INVALID_FIELD: No such column Foo__c' });
      // Still the last success, so the campaign stays due for the next tick.
      expect(failed.lastRefreshedAt?.toISOString()).toBe(lastSuccess.toISOString());
      expect((await campaignById(db, fresh.id)).lastRefreshedAt?.toISOString()).toBe(fresh.lastRefreshedAt!.toISOString());

      await refreshDueCampaigns({ db, clients: async () => client, now: new Date(NOW.getTime() + 5 * 60_000), log });
      expect(client.listViewSoql).toHaveBeenCalledTimes(2);
    });

    it('does not pause on a Salesforce outage (SalesforceApiError): it records the error and stays running', async () => {
      const orgId = await seedOrg(db);
      await seedConnection(db, orgId);
      const campaign = await seedCampaign(db, orgId, { status: 'dry_run' });
      const client = { listViewSoql: vi.fn(async () => { throw new SalesforceApiError('Service Unavailable', 503, null); }) } as unknown as SalesforceClient;
      await refreshDueCampaigns({ db, clients: async () => client, now: NOW, log });
      const after = await campaignById(db, campaign.id);
      expect(after).toMatchObject({ status: 'dry_run', pauseReason: null, lastRefreshedAt: null });
      expect(after.lastRefreshError).not.toBeNull();
    });

    it('clears the stored error on the next successful refresh', async () => {
      const orgId = await seedOrg(db);
      await seedConnection(db, orgId);
      const campaign = await seedCampaign(db, orgId, { status: 'active', lastRefreshError: 'Service Unavailable' });
      const sf = fakeSalesforce({ members: [], stamps: {}, records: {} });
      await refreshDueCampaigns({ db, clients: async () => sf.client, now: NOW, log });
      const after = await campaignById(db, campaign.id);
      expect(after).toMatchObject({ lastRefreshError: null, memberCount: 0 });
      expect(after.lastRefreshedAt?.toISOString()).toBe(NOW.toISOString());
    });

    it('runs a due campaign end to end with the connection field map', async () => {
      const orgId = await seedOrg(db);
      await seedConnection(db, orgId);
      const campaign = await seedCampaign(db, orgId, { status: 'dry_run' });
      const sf = fakeSalesforce({ members: [leadId(1)], stamps: {}, records: { [leadId(1)]: reachable(1) } });
      await refreshDueCampaigns({ db, clients: async () => sf.client, now: NOW, log });
      expect(await enrollmentsOf(db, campaign.id)).toHaveLength(1);
      expect(await campaignById(db, campaign.id)).toMatchObject({ memberCount: 1, lastRefreshError: null });
    });

    describe('claims', () => {
      const failing = (message = 'boom') =>
        ({ listViewSoql: vi.fn(async () => { throw new Error(message); }) }) as unknown as SalesforceClient;
      const claimOf = async (id: string) => (await campaignById(db, id)).refreshStartedAt;

      it('skips a campaign another tick holds, and leaves that tick\'s claim in place', async () => {
        const orgId = await seedOrg(db);
        await seedConnection(db, orgId);
        const campaign = await seedCampaign(db, orgId, { status: 'active' });
        await db.update(schema.campaigns).set({ refreshStartedAt: sql`now() - interval '2 minutes'` }).where(eq(schema.campaigns.id, campaign.id));
        const client = failing();
        await refreshDueCampaigns({ db, clients: async () => client, now: NOW, log });
        expect(client.listViewSoql).not.toHaveBeenCalled();
        expect(await claimOf(campaign.id)).not.toBeNull();
        expect((await campaignById(db, campaign.id)).lastRefreshError).toBeNull();
      });

      it('takes over a claim older than 30 minutes and clears it when the refresh succeeds', async () => {
        const orgId = await seedOrg(db);
        await seedConnection(db, orgId);
        const campaign = await seedCampaign(db, orgId, { status: 'active' });
        await db.update(schema.campaigns).set({ refreshStartedAt: sql`now() - interval '31 minutes'` }).where(eq(schema.campaigns.id, campaign.id));
        const sf = fakeSalesforce({ members: [leadId(1)], stamps: {}, records: { [leadId(1)]: reachable(1) } });
        await refreshDueCampaigns({ db, clients: async () => sf.client, now: NOW, log });
        expect(await enrollmentsOf(db, campaign.id)).toHaveLength(1);
        expect(await claimOf(campaign.id)).toBeNull();
      });

      it('clears the claim when the refresh fails', async () => {
        const orgId = await seedOrg(db);
        await seedConnection(db, orgId);
        const campaign = await seedCampaign(db, orgId, { status: 'active' });
        const client = failing('INVALID_FIELD');
        await refreshDueCampaigns({ db, clients: async () => client, now: NOW, log });
        expect(client.listViewSoql).toHaveBeenCalledTimes(1);
        expect(await claimOf(campaign.id)).toBeNull();
        expect((await campaignById(db, campaign.id)).lastRefreshError).toBe('INVALID_FIELD');
      });

      it('clears the claim when the connection turned out to be broken', async () => {
        const orgId = await seedOrg(db);
        await seedConnection(db, orgId);
        const campaign = await seedCampaign(db, orgId, { status: 'active' });
        const client = { listViewSoql: vi.fn(async () => { throw new SalesforceAuthError('revoked'); }) } as unknown as SalesforceClient;
        await refreshDueCampaigns({ db, clients: async () => client, now: NOW, log });
        expect(await campaignById(db, campaign.id)).toMatchObject({ status: 'paused', refreshStartedAt: null });
      });

      it('stops starting campaigns once the tick has used its time budget', async () => {
        const orgId = await seedOrg(db);
        await seedConnection(db, orgId);
        const first = await seedCampaign(db, orgId, { status: 'active', name: 'first' });
        const second = await seedCampaign(db, orgId, { status: 'active', name: 'second' });
        let t = 1_000;
        const client = {
          listViewSoql: vi.fn(async () => {
            t += REFRESH_TICK_BUDGET_MS; // the first campaign takes the whole budget
            throw new Error('slow and failing');
          }),
        } as unknown as SalesforceClient;
        await refreshDueCampaigns({ db, clients: async () => client, now: NOW, log, clock: () => t });
        expect(client.listViewSoql).toHaveBeenCalledTimes(1);
        expect((await campaignById(db, first.id)).lastRefreshError).toBe('slow and failing');
        expect(await campaignById(db, second.id)).toMatchObject({ lastRefreshError: null, lastRefreshedAt: null, refreshStartedAt: null });
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ budgetMs: REFRESH_TICK_BUDGET_MS }), expect.stringContaining('out of time'));
      });

      it('two overlapping ticks refresh a campaign once', async () => {
        const orgId = await seedOrg(db);
        await seedConnection(db, orgId);
        const campaign = await seedCampaign(db, orgId, { status: 'active' });
        const sf = fakeSalesforce({ members: [leadId(1)], stamps: {}, records: { [leadId(1)]: reachable(1) } });
        vi.mocked(sf.client.listViewSoql).mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return "SELECT Id, Name FROM Lead WHERE Status = 'Open'";
        });
        await Promise.all([
          refreshDueCampaigns({ db, clients: async () => sf.client, now: NOW, log }),
          refreshDueCampaigns({ db, clients: async () => sf.client, now: NOW, log }),
        ]);
        expect(sf.client.listViewSoql).toHaveBeenCalledTimes(1);
        expect(await enrollmentsOf(db, campaign.id)).toHaveLength(1);
        expect(await claimOf(campaign.id)).toBeNull();
      });
    });

    it('releases the open enrollments of an archived campaign so the people can join another', async () => {
      const orgId = await seedOrg(db);
      await seedConnection(db, orgId);
      const campaign = await seedCampaign(db, orgId, { status: 'dry_run' });
      const sf = fakeSalesforce({ members: [leadId(1)], stamps: {}, records: { [leadId(1)]: reachable(1) } });
      await refreshDueCampaigns({ db, clients: async () => sf.client, now: NOW, log });
      await db.update(schema.campaigns).set({ status: 'archived' }).where(eq(schema.campaigns.id, campaign.id));
      await refreshDueCampaigns({ db, clients: async () => sf.client, now: LATER, log });
      expect((await enrollmentsOf(db, campaign.id))[0]).toMatchObject({ status: 'exited', exitReason: 'campaign_archived' });
      const keys = await db.select().from(schema.enrollmentContactKeys).where(eq(schema.enrollmentContactKeys.orgId, orgId));
      expect(keys.every((k) => !k.active)).toBe(true);
    });
  });
});
