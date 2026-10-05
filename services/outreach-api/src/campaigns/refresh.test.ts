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
function fakeSalesforce(state: {
  members: string[];
  stamps: Record<string, string>;
  records: Record<string, SfRecordSnapshot>;
  /** Tasks every Task query returns. */
  tasks?: Array<{ WhoId: string | null; WhatId: string | null }>;
  /** When set, every Task query throws it. */
  taskError?: Error;
}) {
  const soql: string[] = [];
  const client = {
    listViewSoql: vi.fn(async () => "SELECT Id, Name FROM Lead WHERE Status = 'Open'"),
    queryAll: vi.fn(async (q: string) => {
      soql.push(q);
      if (q.startsWith('SELECT Id, LastModifiedDate FROM Lead WHERE Id IN (')) {
        const ids = [...q.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
        return ids.filter((id) => id in state.stamps).map((Id) => ({ Id, LastModifiedDate: state.stamps[Id] }));
      }
      if (q.startsWith('SELECT WhoId, WhatId FROM Task ')) {
        if (state.taskError) throw state.taskError;
        return state.tasks ?? [];
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

    describe('Tasks logged since the last refresh (they do not move the record\'s LastModifiedDate)', () => {
      async function refreshedOnce(tasks: Array<{ WhoId: string | null; WhatId: string | null }>) {
        const orgId = await seedOrg(db);
        const campaign = await seedCampaign(db, orgId);
        const state = {
          members: [leadId(1), leadId(2)],
          stamps: {} as Record<string, string>,
          records: { [leadId(1)]: reachable(1), [leadId(2)]: reachable(2), [leadId(3)]: reachable(3) } as Record<string, SfRecordSnapshot>,
          tasks: [] as typeof tasks,
          taskError: undefined as Error | undefined,
        };
        const sf = fakeSalesforce(state);
        await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW, triage: true }, campaign);
        await db.update(schema.crmRecords).set({ triageNeeded: false, triageAttemptedAt: NOW }).where(eq(schema.crmRecords.orgId, orgId));
        state.stamps = { [leadId(1)]: STAMP_1, [leadId(2)]: STAMP_1 };
        state.tasks = tasks;
        return { orgId, sf, state, campaign: await campaignById(db, campaign.id) };
      }
      const taskQueries = (soql: string[]) => soql.filter((q) => q.startsWith('SELECT WhoId, WhatId FROM Task '));
      const triageState = async (orgId: string) =>
        new Map((await db.select().from(schema.crmRecords).where(eq(schema.crmRecords.orgId, orgId))).map((r) => [r.sfRecordId, { needed: r.triageNeeded, attempted: r.triageAttemptedAt }]));

      it('with AI triage on, marks an enrolled record that got a Task for triage again', async () => {
        const { orgId, sf, campaign } = await refreshedOnce([{ WhoId: leadId(2), WhatId: null }]);
        await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER, triage: true }, campaign);
        const taskQueries = sf.soql.filter((q) => q.startsWith('SELECT WhoId, WhatId FROM Task '));
        expect(taskQueries).toHaveLength(1);
        expect(taskQueries[0]).toContain('AND LastModifiedDate > 2026-10-05T14:55:00Z');
        const rows = await triageState(orgId);
        expect(rows.get(leadId(2))).toEqual({ needed: true, attempted: null });
        expect(rows.get(leadId(1))).toEqual({ needed: false, attempted: NOW });
      });

      it('with AI triage off, or on a first refresh, asks Salesforce for no Tasks', async () => {
        const { sf, campaign } = await refreshedOnce([{ WhoId: leadId(2), WhatId: null }]);
        await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
        expect(sf.soql.filter((q) => q.includes('FROM Task'))).toEqual([]);
        // refreshedOnce's first refresh ran with triage on, before the campaign had a last refresh.
      });

      it('a first refresh starts the Task cursor; a successful check moves it, and the next cutoff comes from it', async () => {
        const { sf, campaign } = await refreshedOnce([]);
        expect(campaign.tasksCheckedAt?.toISOString()).toBe(NOW.toISOString());
        const cursor = new Date('2026-10-05T16:00:00.000Z');
        await db.update(schema.campaigns).set({ tasksCheckedAt: cursor }).where(eq(schema.campaigns.id, campaign.id));
        await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER, triage: true }, await campaignById(db, campaign.id));
        expect(taskQueries(sf.soql).at(-1)).toContain('AND LastModifiedDate > 2026-10-05T15:55:00Z');
        expect((await campaignById(db, campaign.id)).tasksCheckedAt?.toISOString()).toBe(LATER.toISOString());
      });

      it('a failed Task check is logged and the refresh carries on: exits and enrollments happen, the cursor stays, and the window is checked next time', async () => {
        const { orgId, sf, state, campaign } = await refreshedOnce([{ WhoId: leadId(1), WhatId: null }]);
        log.warn.mockClear();
        state.taskError = new SalesforceApiError("INVALID_TYPE: sObject type 'Task' is not supported.", 400, null);
        state.members = [leadId(1), leadId(3)]; // leadId(2) left, leadId(3) joined
        const out = await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER, triage: true, log }, campaign);
        expect(out).toMatchObject({ enrolled: 1, exited: 1 });
        expect(log.warn).toHaveBeenCalledWith({ orgId, campaignId: campaign.id, errName: 'SalesforceApiError', status: 400 }, expect.stringContaining('Task check failed'));
        const after = await campaignById(db, campaign.id);
        expect(after.tasksCheckedAt?.toISOString()).toBe(NOW.toISOString());
        expect(after.lastRefreshedAt?.toISOString()).toBe(LATER.toISOString());

        state.taskError = undefined;
        const later = new Date(LATER.getTime() + 5 * 3_600_000);
        await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: later, triage: true, log }, after);
        expect(taskQueries(sf.soql).at(-1)).toContain('AND LastModifiedDate > 2026-10-05T14:55:00Z');
        expect((await triageState(orgId)).get(leadId(1))).toEqual({ needed: true, attempted: null });
      });

      it('a SalesforceAuthError from the Task check still fails the refresh (the tick pauses the tenant)', async () => {
        const { orgId, sf, state, campaign } = await refreshedOnce([]);
        state.taskError = new SalesforceAuthError();
        await expect(refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER, triage: true }, campaign)).rejects.toBeInstanceOf(SalesforceAuthError);
        await seedConnection(db, orgId);
        await refreshDueCampaigns({ db, clients: async () => sf.client, now: LATER, log, triage: true });
        expect(await campaignById(db, campaign.id)).toMatchObject({ status: 'paused', pauseReason: 'crm_broken' });
      });

      it('the tick passes the triage switch through to each campaign', async () => {
        const { orgId, sf } = await refreshedOnce([{ WhoId: leadId(1), WhatId: null }]);
        await seedConnection(db, orgId);
        await refreshDueCampaigns({ db, clients: async () => sf.client, now: LATER, log, triage: true });
        expect((await triageState(orgId)).get(leadId(1))).toEqual({ needed: true, attempted: null });
      });
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

      it('leaves a claim another tick took over mid-refresh in place', async () => {
        const orgId = await seedOrg(db);
        await seedConnection(db, orgId);
        const campaign = await seedCampaign(db, orgId, { status: 'active' });
        const takeover = new Date('2030-01-01T00:00:00.123Z');
        const client = {
          listViewSoql: vi.fn(async () => {
            // This tick ran past the stale limit and a later tick claimed the campaign again.
            await db.update(schema.campaigns).set({ refreshStartedAt: takeover }).where(eq(schema.campaigns.id, campaign.id));
            throw new Error('slow and failing');
          }),
        } as unknown as SalesforceClient;
        await refreshDueCampaigns({ db, clients: async () => client, now: NOW, log });
        expect((await claimOf(campaign.id))?.toISOString()).toBe(takeover.toISOString());
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

    it('keeps an archived campaign\'s needs_review enrollment held, keys and all, until a person decides', async () => {
      const orgId = await seedOrg(db);
      await seedConnection(db, orgId);
      const campaign = await seedCampaign(db, orgId, { status: 'dry_run' });
      const sf = fakeSalesforce({ members: [leadId(1)], stamps: {}, records: { [leadId(1)]: reachable(1) } });
      await refreshDueCampaigns({ db, clients: async () => sf.client, now: NOW, log });
      await db.update(schema.campaignEnrollments).set({ status: 'needs_review', reviewCategory: 'sold', reviewQuote: 'sold it' }).where(eq(schema.campaignEnrollments.campaignId, campaign.id));
      await db.update(schema.campaigns).set({ status: 'archived' }).where(eq(schema.campaigns.id, campaign.id));
      await refreshDueCampaigns({ db, clients: async () => sf.client, now: LATER, log });
      expect((await enrollmentsOf(db, campaign.id))[0]).toMatchObject({ status: 'needs_review', exitReason: null, reviewCategory: 'sold' });
      const keys = await db.select().from(schema.enrollmentContactKeys).where(eq(schema.enrollmentContactKeys.orgId, orgId));
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.active)).toBe(true);
    });
  });

  it('never exits a needs_review enrollment: left the query, closed, or skip-on-dialer, the flag still waits for a person', async () => {
    const orgId = await seedOrg(db);
    const campaign = await seedCampaign(db, orgId);
    const state = {
      members: [leadId(1), leadId(2), leadId(3)],
      stamps: {} as Record<string, string>,
      records: { [leadId(1)]: reachable(1), [leadId(2)]: reachable(2), [leadId(3)]: reachable(3) },
    };
    const sf = fakeSalesforce(state);
    await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: NOW }, campaign);
    await db.update(schema.campaignEnrollments).set({ status: 'needs_review', reviewCategory: 'attorney', reviewQuote: 'my lawyer' }).where(eq(schema.campaignEnrollments.campaignId, campaign.id));

    const moved = new Date(STAMP_2.replace('+0000', 'Z'));
    state.members = [leadId(2), leadId(3)];
    state.stamps = { [leadId(2)]: STAMP_2, [leadId(3)]: STAMP_2 };
    state.records[leadId(2)] = reachable(2, { isClosed: true, lastModifiedAt: moved });
    state.records[leadId(3)] = reachable(3, { skipOnDialer: true, lastModifiedAt: moved });
    const out = await refreshCampaign({ db, client: sf.client, fieldMap: TEST_FIELD_MAP, now: LATER }, campaign);
    expect(out.exited).toBe(0);
    const rows = await enrollmentsOf(db, campaign.id);
    expect(rows.map((e) => e.status)).toEqual(['needs_review', 'needs_review', 'needs_review']);
  });
});
