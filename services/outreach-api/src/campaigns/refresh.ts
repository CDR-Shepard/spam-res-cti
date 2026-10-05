/**
 * `campaign.refresh`: re-runs each due campaign's membership query, syncs the records
 * whose Salesforce `LastModifiedDate` moved, enrolls new eligible members, and exits
 * enrollments whose record left the query, closed, or lost every channel.
 */
import { and, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { FieldMap, SfObject, type CampaignSource } from '@cti/contracts';
import { schema, type CampaignRow, type CrmRecordRow, type Db } from '@cti/db';
import { blockedTargets, type ConsentBlock } from '@cti/firewall';
import { SalesforceAuthError, soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { contactKeys, skipReasonFor } from './eligibility.js';
import { chunk, enrollRecords, exitEnrollment, TERMINAL_ENROLLMENT_STATUSES, upsertRecords } from './enroll.js';
import { pauseOrgCampaigns, RUNNING_CAMPAIGN_STATUSES } from './pause.js';
import { fetchRecords, type SfRecordSnapshot } from './records.js';
import { fetchMemberIds, membershipSoql } from './source.js';

/** Spec §6.1: a campaign holds at most 50,000 records. */
export const CAMPAIGN_MAX_MEMBERS = 50_000;
/** Ids per `WHERE Id IN (...)` Salesforce query. */
const SF_ID_BATCH = 200;
/** Values per Postgres `IN (...)` list (well under the 65,535 bind-parameter limit). */
const PG_IN_BATCH = 5_000;
/** Enrollment statuses a refresh may end. A `conversing` or `handed_off` person belongs to a rep. */
const EXITABLE_STATUSES: ReadonlySet<string> = new Set(['active', 'needs_review']);
/** Archived campaigns release at most this many enrollments per tick. */
const ARCHIVE_RELEASE_BATCH = 1_000;
const MAX_ERROR_LENGTH = 1_000;

function campaignSource(c: CampaignRow): CampaignSource {
  return c.sourceKind === 'list_view' && c.listViewId
    ? { kind: 'list_view', listViewId: c.listViewId }
    : { kind: 'soql', soql: c.soql };
}

function toSnapshot(r: CrmRecordRow): SfRecordSnapshot {
  return {
    sfObject: SfObject.parse(r.sfObject),
    sfRecordId: r.sfRecordId,
    name: r.name,
    ownerSfUserId: r.ownerSfUserId,
    ownerName: r.ownerName,
    leadManagerSfUserId: r.leadManagerSfUserId,
    phones: r.phones,
    email: r.email,
    state: r.state,
    webFormSource: r.webFormSource,
    consentAiCall: r.consentAiCall,
    sfDoNotCall: r.sfDoNotCall,
    sfEmailOptOut: r.sfEmailOptOut,
    skipOnDialer: r.skipOnDialer,
    isClosed: r.isClosed,
    lastModifiedAt: r.sfLastModifiedAt,
  };
}

/** `LastModifiedDate` per Id, 200 Ids per query. An Id Salesforce no longer returns is absent. */
async function lastModifiedStamps(
  client: SalesforceClient,
  sfObject: 'Lead' | 'Opportunity',
  ids: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const batch of chunk(ids, SF_ID_BATCH)) {
    const list = batch.map((id) => `'${soqlEscape(id)}'`).join(',');
    const rows = await client.queryAll<{ Id?: unknown; LastModifiedDate?: unknown }>(
      `SELECT Id, LastModifiedDate FROM ${sfObject} WHERE Id IN (${list})`,
    );
    for (const row of rows) {
      if (typeof row.Id !== 'string') continue;
      out.set(row.Id, typeof row.LastModifiedDate === 'string' ? Date.parse(row.LastModifiedDate) : null);
    }
  }
  return out;
}

async function loadRecords(db: Db, orgId: string, sfRecordIds: string[]): Promise<CrmRecordRow[]> {
  const out: CrmRecordRow[] = [];
  for (const batch of chunk(sfRecordIds, PG_IN_BATCH)) {
    const rows = await db
      .select()
      .from(schema.crmRecords)
      .where(and(eq(schema.crmRecords.orgId, orgId), inArray(schema.crmRecords.sfRecordId, batch)));
    out.push(...rows);
  }
  return out;
}

async function blocksFor(db: Db, orgId: string, numbers: string[]): Promise<Map<string, ConsentBlock>> {
  const merged = new Map<string, ConsentBlock>();
  for (const batch of chunk([...new Set(numbers)], PG_IN_BATCH)) {
    for (const [e164, block] of await blockedTargets(db, orgId, batch)) merged.set(e164, block);
  }
  return merged;
}

/** Which member Ids need a field fetch: new to this tenant, or modified in Salesforce since the last sync. */
async function idsToFetch(db: Db, client: SalesforceClient, orgId: string, sfObject: 'Lead' | 'Opportunity', ids: string[]): Promise<string[]> {
  const known = new Map<string, number | null>();
  for (const batch of chunk(ids, PG_IN_BATCH)) {
    const rows = await db
      .select({ sfRecordId: schema.crmRecords.sfRecordId, lastModified: schema.crmRecords.sfLastModifiedAt })
      .from(schema.crmRecords)
      .where(and(eq(schema.crmRecords.orgId, orgId), inArray(schema.crmRecords.sfRecordId, batch)));
    for (const r of rows) known.set(r.sfRecordId, r.lastModified?.getTime() ?? null);
  }
  const stamps = await lastModifiedStamps(client, sfObject, ids.filter((id) => known.has(id)));
  return ids.filter((id) => !known.has(id) || (stamps.has(id) && stamps.get(id) !== known.get(id)));
}

/**
 * One campaign, one refresh. Throws on any Salesforce or database failure; the caller
 * (`refreshDueCampaigns`) decides between pausing the tenant and recording the error.
 */
export async function refreshCampaign(
  deps: { db: Db; client: SalesforceClient; fieldMap: FieldMap; now: Date },
  campaign: CampaignRow,
): Promise<{ members: number; enrolled: number; exited: number }> {
  const { db, client, fieldMap, now } = deps;
  const sfObject = SfObject.parse(campaign.sfObject);
  const soql = await membershipSoql(client, { sfObject, source: campaignSource(campaign) });
  const ids = await fetchMemberIds(client, soql, CAMPAIGN_MAX_MEMBERS);

  const fetchIds = await idsToFetch(db, client, campaign.orgId, sfObject, ids);
  if (fetchIds.length > 0) {
    await upsertRecords(db, campaign.orgId, await fetchRecords(client, sfObject, fetchIds, fieldMap[sfObject]));
  }

  const members = await loadRecords(db, campaign.orgId, ids);
  const bySfId = new Map(members.map((r) => [r.sfRecordId, r]));
  const blocks = await blocksFor(db, campaign.orgId, members.flatMap((r) => r.phones.map((p) => p.e164)));
  const memberIds = new Set(ids);

  const enrollments = await db
    .select({ id: schema.campaignEnrollments.id, status: schema.campaignEnrollments.status, sfRecordId: schema.crmRecords.sfRecordId })
    .from(schema.campaignEnrollments)
    .innerJoin(schema.crmRecords, eq(schema.crmRecords.id, schema.campaignEnrollments.crmRecordId))
    .where(eq(schema.campaignEnrollments.campaignId, campaign.id));

  let exited = 0;
  for (const e of enrollments) {
    if (!EXITABLE_STATUSES.has(e.status)) continue;
    const record = bySfId.get(e.sfRecordId);
    const reason = !memberIds.has(e.sfRecordId) ? 'left_query' : record ? skipReasonFor(toSnapshot(record), blocks, false) : null;
    if (!reason) continue;
    await exitEnrollment(db, e.id, reason);
    exited += 1;
  }

  const alreadyEnrolled = new Set(enrollments.map((e) => e.sfRecordId));
  const candidates = ids.flatMap((id) => {
    const record = bySfId.get(id);
    if (!record || alreadyEnrolled.has(id)) return [];
    const snapshot = toSnapshot(record);
    if (skipReasonFor(snapshot, blocks, false) !== null) return [];
    return [{ crmRecordId: record.id, keys: contactKeys(snapshot) }];
  });
  const { enrolled } = await enrollRecords(db, {
    orgId: campaign.orgId,
    campaignId: campaign.id,
    touchDays: campaign.touchDays,
    now,
    records: candidates,
  });

  await db
    .update(schema.campaigns)
    .set({ memberCount: ids.length, lastRefreshedAt: now, lastRefreshError: null, updatedAt: now })
    .where(eq(schema.campaigns.id, campaign.id));
  return { members: ids.length, enrolled, exited };
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
}

/**
 * No connection, or Salesforce refused the tenant's token (A5 marks the connection broken).
 * A `SalesforceApiError` (an outage or a bad query) is not one: it is recorded and retried.
 */
function isConnectionFailure(err: unknown): boolean {
  return err instanceof CrmNotConnectedError || err instanceof SalesforceAuthError;
}

/** Archived campaigns hold no one: end their open enrollments so the people's keys free up. */
async function releaseArchivedEnrollments(db: Db, log: RunnerLogger): Promise<void> {
  const rows = await db
    .select({ id: schema.campaignEnrollments.id })
    .from(schema.campaignEnrollments)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignEnrollments.campaignId))
    .where(
      and(
        eq(schema.campaigns.status, 'archived'),
        notInArray(schema.campaignEnrollments.status, [...TERMINAL_ENROLLMENT_STATUSES]),
      ),
    )
    .limit(ARCHIVE_RELEASE_BATCH);
  for (const row of rows) await exitEnrollment(db, row.id, 'campaign_archived');
  if (rows.length > 0) log.info({ released: rows.length }, 'released enrollments of archived campaigns');
}

/**
 * Any failure other than an unusable connection (a Salesforce outage, an invalid query, a
 * deleted list view) is shown on the campaign. `last_refreshed_at` keeps the last success,
 * so the campaign stays due and the next tick retries it.
 */
async function recordFailure(db: Db, log: RunnerLogger, campaign: CampaignRow, now: Date, err: unknown): Promise<void> {
  const message = errorMessage(err);
  await db
    .update(schema.campaigns)
    .set({ lastRefreshError: message, updatedAt: now })
    .where(eq(schema.campaigns.id, campaign.id));
  log.warn({ orgId: campaign.orgId, campaignId: campaign.id, err: message }, 'campaign refresh failed');
}

async function pauseForBrokenCrm(db: Db, log: RunnerLogger, orgId: string, err: unknown): Promise<void> {
  const paused = await pauseOrgCampaigns(db, orgId, 'crm_broken');
  log.warn({ orgId, paused, err: errorMessage(err) }, 'salesforce connection unusable; paused the tenant campaigns');
}

type RefreshDeps = { db: Db; clients: SalesforceClientFactory; now: Date; log: RunnerLogger };

async function refreshOrg(deps: RefreshDeps, orgId: string, due: CampaignRow[]): Promise<void> {
  const { db, log, now } = deps;
  let client: SalesforceClient;
  let fieldMap: FieldMap;
  try {
    client = await deps.clients(orgId);
    const parsed = FieldMap.safeParse((await loadConnection(db, orgId))?.fieldMap);
    if (!parsed.success) throw new Error('the Salesforce field map is missing or invalid; reconnect Salesforce');
    fieldMap = parsed.data;
  } catch (err) {
    if (isConnectionFailure(err)) return pauseForBrokenCrm(db, log, orgId, err);
    for (const campaign of due) await recordFailure(db, log, campaign, now, err);
    return;
  }
  for (const campaign of due) {
    try {
      const result = await refreshCampaign({ db, client, fieldMap, now }, campaign);
      log.info({ orgId, campaignId: campaign.id, ...result }, 'campaign refreshed');
    } catch (err) {
      if (isConnectionFailure(err)) return pauseForBrokenCrm(db, log, orgId, err);
      await recordFailure(db, log, campaign, now, err);
    }
  }
}

/**
 * The `campaign.refresh` tick (every 5 minutes): refreshes each `dry_run`/`active`
 * campaign whose last successful refresh is older than its `refresh_minutes` (or that never
 * refreshed), tenant by tenant. `CrmNotConnectedError` or `SalesforceAuthError` pauses that
 * tenant's running campaigns (`pause_reason = 'crm_broken'`); any other failure is stored in
 * `last_refresh_error` and retried on the next tick.
 */
export async function refreshDueCampaigns(deps: RefreshDeps): Promise<void> {
  const { db, now } = deps;
  await releaseArchivedEnrollments(db, deps.log);
  const due = await db
    .select()
    .from(schema.campaigns)
    .where(
      and(
        inArray(schema.campaigns.status, [...RUNNING_CAMPAIGN_STATUSES]),
        or(
          isNull(schema.campaigns.lastRefreshedAt),
          lte(
            schema.campaigns.lastRefreshedAt,
            sql`${now.toISOString()}::timestamptz - make_interval(mins => ${schema.campaigns.refreshMinutes})`,
          ),
        ),
      ),
    )
    .orderBy(schema.campaigns.orgId, schema.campaigns.createdAt);
  const byOrg = new Map<string, CampaignRow[]>();
  for (const c of due) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c]);
  for (const [orgId, list] of byOrg) await refreshOrg(deps, orgId, list);
}
