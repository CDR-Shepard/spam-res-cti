/**
 * `campaign.refresh`: re-runs each due campaign's membership query, syncs the records
 * whose Salesforce `LastModifiedDate` moved, marks records that got a Task since the last
 * refresh for triage again (when AI triage is on), enrolls new eligible members, and exits
 * enrollments whose record left the query, closed, or lost every channel.
 */
import { and, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { FieldMap, SfObject } from '@cti/contracts';
import { schema, type CampaignRow, type CrmRecordRow, type Db } from '@cti/db';
import { blockedTargets, type ConsentBlock } from '@cti/firewall';
import { SalesforceApiError, SalesforceAuthError, soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { contactKeys, skipReasonFor } from './eligibility.js';
import { CAMPAIGN_ARCHIVED_EXIT_REASON, chunk, enrollRecords, exitEnrollment, TERMINAL_ENROLLMENT_STATUSES, upsertRecords, type ExitableStatus } from './enroll.js';
import { campaignSource } from './member-cache.js';
import { pauseOrgCampaigns, RUNNING_CAMPAIGN_STATUSES } from './pause.js';
import { DESELECTED_EXIT_REASON, reenrollDeselected } from './reenroll.js';
import { fetchRecords, type SfRecordSnapshot } from './records.js';
import { allSelectedIds } from './selection.js';
import { fetchMemberIds, MAX_CAMPAIGN_RECORDS, membershipSoql } from './source.js';
import { flagRecordsWithNewTasks } from './task-activity.js';

/**
 * A tick stops starting new campaigns after this long. pg-boss fails the job at 15 minutes
 * (`expireInSeconds: 900`) but cannot stop the handler, so a tick must wind down on its own.
 */
export const REFRESH_TICK_BUDGET_MS = 12 * 60_000;
/** A refresh claim older than this is taken to belong to a crashed or timed-out tick. */
export const REFRESH_CLAIM_STALE_MINUTES = 30;
/** Ids per `WHERE Id IN (...)` Salesforce query. */
const SF_ID_BATCH = 200;
/** Values per Postgres `IN (...)` list (well under the 65,535 bind-parameter limit). */
const PG_IN_BATCH = 5_000;
/**
 * Enrollment statuses a refresh may end. A `conversing` or `handed_off` person belongs to a
 * rep; a `needs_review` person waits for a human decision on a do-not-contact flag, and an
 * exit would drop the item from Needs Review and free the person's keys (spec §7.3).
 */
const EXITABLE_STATUSES: ReadonlySet<string> = new Set(['active']);
/** Statuses an archived campaign keeps: finished ones, and a do-not-contact flag still waiting for a person. */
const KEPT_WHEN_ARCHIVED = [...TERMINAL_ENROLLMENT_STATUSES, 'needs_review'] as const;
/** The open statuses an archived campaign releases: everything but needs_review. */
const RELEASED_WHEN_ARCHIVED: readonly ExitableStatus[] = ['active', 'conversing', 'handed_off'];
/** Archived campaigns release at most this many enrollments per tick. */
const ARCHIVE_RELEASE_BATCH = 1_000;
const MAX_ERROR_LENGTH = 1_000;
export { DESELECTED_EXIT_REASON };

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
 * No connection, or Salesforce refused the tenant's token (A5 marks the connection broken).
 * A `SalesforceApiError` (an outage or a bad query) is not one: it is recorded and retried.
 */
function isConnectionFailure(err: unknown): boolean {
  return err instanceof CrmNotConnectedError || err instanceof SalesforceAuthError;
}

/**
 * Marks the records that got a Task since the cursor (`tasks_checked_at`, else the last
 * refresh) for triage. A first refresh only starts the cursor: every record is new and
 * owed a triage anyway. The cursor moves to `now` only when the check succeeds. A failure
 * other than an unusable connection is logged and the refresh carries on (exits and new
 * enrollments must not wait on Task access); the window is checked again next time.
 */
async function checkTaskActivity(db: Db, client: SalesforceClient, campaign: CampaignRow, now: Date, log?: RunnerLogger): Promise<void> {
  const ids = { orgId: campaign.orgId, campaignId: campaign.id };
  const since = campaign.tasksCheckedAt ?? campaign.lastRefreshedAt;
  const setCursor = (at: Date) => db.update(schema.campaigns).set({ tasksCheckedAt: at }).where(eq(schema.campaigns.id, campaign.id));
  if (!since) {
    await setCursor(now);
    return;
  }
  try {
    const flagged = await flagRecordsWithNewTasks(db, client, { campaignId: campaign.id, since });
    if (flagged > 0) log?.info({ ...ids, flagged }, 'records with new Tasks marked for triage');
  } catch (err) {
    if (isConnectionFailure(err)) throw err;
    const status = err instanceof SalesforceApiError ? err.status : undefined;
    const errName = err instanceof Error ? err.name : typeof err;
    log?.warn({ ...ids, errName, status }, 'Task check failed; the refresh carries on and the same window is checked next time');
    // Pin the window's start: the fallback (last refresh) is about to move.
    if (!campaign.tasksCheckedAt) await setCursor(since);
    return;
  }
  await setCursor(now);
}

/**
 * One campaign, one refresh. Throws on any Salesforce or database failure; the caller
 * (`refreshDueCampaigns`) decides between pausing the tenant and recording the error.
 */
export async function refreshCampaign(
  deps: {
    db: Db;
    client: SalesforceClient;
    fieldMap: FieldMap;
    now: Date;
    log?: RunnerLogger;
    /** AI triage is configured: records that got a Task since the last refresh are triaged again. */
    triage?: boolean;
  },
  campaign: CampaignRow,
): Promise<{ members: number; enrolled: number; exited: number }> {
  const { db, client, fieldMap, now, log } = deps;
  const sfObject = SfObject.parse(campaign.sfObject);
  const soql = await membershipSoql(client, { sfObject, source: campaignSource(campaign) });
  const ids = await fetchMemberIds(client, soql, MAX_CAMPAIGN_RECORDS);
  const aiCall = campaign.mode === 'ai_call';
  // An ai_call campaign reads and enrolls only the leads an admin picked; the query only bounds them.
  const selected = aiCall ? await allSelectedIds(db, campaign.orgId, campaign.id) : null;
  const relevant = selected ? ids.filter((id) => selected.has(id)) : ids;

  const fetchIds = await idsToFetch(db, client, campaign.orgId, sfObject, relevant);
  if (fetchIds.length > 0) {
    await upsertRecords(db, campaign.orgId, await fetchRecords(client, sfObject, fetchIds, fieldMap[sfObject]));
  }
  // Triage skips AI call campaigns (their call.prepare research reads Tasks itself), so a Task flag would feed nothing.
  if (deps.triage && !aiCall) await checkTaskActivity(db, client, campaign, now, log);

  const members = await loadRecords(db, campaign.orgId, relevant);
  const bySfId = new Map(members.map((r) => [r.sfRecordId, r]));
  const blocks = await blocksFor(db, campaign.orgId, members.flatMap((r) => r.phones.map((p) => p.e164)));
  const memberIds = new Set(ids);

  const enrollments = await db
    .select({ id: schema.campaignEnrollments.id, status: schema.campaignEnrollments.status, exitReason: schema.campaignEnrollments.exitReason, sfRecordId: schema.crmRecords.sfRecordId })
    .from(schema.campaignEnrollments)
    .innerJoin(schema.crmRecords, eq(schema.crmRecords.id, schema.campaignEnrollments.crmRecordId))
    .where(eq(schema.campaignEnrollments.campaignId, campaign.id));

  let exited = 0;
  for (const e of enrollments) {
    if (!EXITABLE_STATUSES.has(e.status)) continue;
    const record = bySfId.get(e.sfRecordId);
    const reason = !memberIds.has(e.sfRecordId)
      ? 'left_query'
      : selected && !selected.has(e.sfRecordId)
        ? DESELECTED_EXIT_REASON
        : record ? skipReasonFor(toSnapshot(record), blocks, false) : null;
    if (!reason) continue;
    // Guarded on `active`: the triage tick may have flagged the person since the read above.
    if (await exitEnrollment(db, e.id, { from: ['active'], reason, onlyIfDeselected: reason === DESELECTED_EXIT_REASON })) exited += 1;
  }

  const alreadyEnrolled = new Set(enrollments.map((e) => e.sfRecordId));
  const candidates = relevant.flatMap((id) => {
    const record = bySfId.get(id);
    if (!record || alreadyEnrolled.has(id)) return [];
    const snapshot = toSnapshot(record);
    if (skipReasonFor(snapshot, blocks, false) !== null) return [];
    return [{ crmRecordId: record.id, keys: contactKeys(snapshot), sfRecordId: id }];
  });
  const { enrolled, skippedInOtherCampaign, skippedNoKeys } = await enrollRecords(db, {
    orgId: campaign.orgId,
    campaignId: campaign.id,
    touchDays: campaign.touchDays,
    now,
    records: candidates,
    callStage: aiCall ? 'research' : null,
  });
  // A lead ticked again after it was deselected comes back as the same enrollment, if it is still eligible.
  const back = await reenrollDeselected(db, {
    campaignId: campaign.id,
    touchDays: campaign.touchDays,
    now,
    candidates: enrollments.flatMap((e) => {
      const record = bySfId.get(e.sfRecordId);
      if (!selected?.has(e.sfRecordId) || e.status !== 'exited' || e.exitReason !== DESELECTED_EXIT_REASON || !record) return [];
      const snapshot = toSnapshot(record);
      return skipReasonFor(snapshot, blocks, false) === null ? [{ enrollmentId: e.id, sfRecordId: e.sfRecordId, keys: contactKeys(snapshot) }] : [];
    }),
  });
  const skipped = { skippedInOtherCampaign: skippedInOtherCampaign + back.skippedInOtherCampaign, skippedNoKeys: skippedNoKeys + back.skippedNoKeys };
  if (skipped.skippedInOtherCampaign > 0 || skipped.skippedNoKeys > 0) {
    log?.info(
      { orgId: campaign.orgId, campaignId: campaign.id, ...skipped },
      'members not enrolled: already in another active campaign, or no contact key',
    );
  }

  await db
    .update(schema.campaigns)
    .set({ memberCount: ids.length, lastRefreshedAt: now, lastRefreshError: null, updatedAt: now })
    .where(eq(schema.campaigns.id, campaign.id));
  return { members: ids.length, enrolled: enrolled + back.reenrolled, exited };
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
}

/**
 * Archived campaigns hold no one: end their open enrollments so the people's keys free up.
 * A `needs_review` enrollment stays until a person decides it (a dismissal then exits it).
 */
async function releaseArchivedEnrollments(db: Db, log: RunnerLogger): Promise<void> {
  const rows = await db
    .select({ id: schema.campaignEnrollments.id })
    .from(schema.campaignEnrollments)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignEnrollments.campaignId))
    .where(
      and(
        eq(schema.campaigns.status, 'archived'),
        notInArray(schema.campaignEnrollments.status, [...KEPT_WHEN_ARCHIVED]),
      ),
    )
    .limit(ARCHIVE_RELEASE_BATCH);
  let released = 0;
  for (const row of rows) {
    // Every open status but needs_review, re-checked at the update (a flag may have landed since the read).
    if (await exitEnrollment(db, row.id, { from: RELEASED_WHEN_ARCHIVED, reason: CAMPAIGN_ARCHIVED_EXIT_REASON })) released += 1;
  }
  if (released > 0) log.info({ released }, 'released enrollments of archived campaigns');
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

type RefreshDeps = {
  db: Db;
  clients: SalesforceClientFactory;
  now: Date;
  log: RunnerLogger;
  /** AI triage is configured (the `record.triage` tick runs): new Tasks re-trigger triage. */
  triage?: boolean;
  /** Wall clock in ms for the tick budget; injected by tests. Defaults to `Date.now`. */
  clock?: () => number;
};

/** The campaign is still running and due, as of `now` (the same test the tick's selection uses). */
function dueCondition(now: Date) {
  return and(
    inArray(schema.campaigns.status, [...RUNNING_CAMPAIGN_STATUSES]),
    or(
      isNull(schema.campaigns.lastRefreshedAt),
      lte(
        schema.campaigns.lastRefreshedAt,
        sql`${now.toISOString()}::timestamptz - make_interval(mins => ${schema.campaigns.refreshMinutes})`,
      ),
    ),
  );
}

/**
 * Takes the campaign's refresh claim. pg-boss fails a tick at 15 minutes but the handler
 * keeps running, so the next 5-minute tick can select the same campaign; the database
 * decides who works on it. Returns the claim's timestamp, or null when another tick holds a
 * fresh claim, or when the campaign was refreshed, paused or archived since this tick
 * selected it. A claim older than
 * `REFRESH_CLAIM_STALE_MINUTES` belongs to a dead tick and is taken over.
 */
async function claimCampaign(db: Db, campaign: CampaignRow, now: Date): Promise<Date | null> {
  const claimed = await db
    .update(schema.campaigns)
    // Truncated to milliseconds so the value read back as a JS Date is exactly what the row holds.
    .set({ refreshStartedAt: sql`date_trunc('milliseconds', now())` })
    .where(
      and(
        eq(schema.campaigns.id, campaign.id),
        eq(schema.campaigns.orgId, campaign.orgId),
        dueCondition(now),
        or(
          isNull(schema.campaigns.refreshStartedAt),
          lt(schema.campaigns.refreshStartedAt, sql`now() - make_interval(mins => ${REFRESH_CLAIM_STALE_MINUTES})`),
        ),
      ),
    )
    .returning({ refreshStartedAt: schema.campaigns.refreshStartedAt });
  return claimed[0]?.refreshStartedAt ?? null;
}

/** Clears the claim this tick took (`claimedAt`); a claim another tick took over since is left alone. */
async function releaseClaim(db: Db, campaign: CampaignRow, claimedAt: Date): Promise<void> {
  await db
    .update(schema.campaigns)
    .set({ refreshStartedAt: null })
    .where(
      and(
        eq(schema.campaigns.id, campaign.id),
        eq(schema.campaigns.orgId, campaign.orgId),
        eq(schema.campaigns.refreshStartedAt, claimedAt),
      ),
    );
}

async function refreshOrg(deps: RefreshDeps, orgId: string, due: CampaignRow[], outOfTime: () => boolean): Promise<void> {
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
    if (outOfTime()) return;
    const claimedAt = await claimCampaign(db, campaign, now);
    if (!claimedAt) {
      log.info({ orgId, campaignId: campaign.id }, 'campaign refresh skipped: another tick holds it, or it is no longer due');
      continue;
    }
    try {
      const result = await refreshCampaign({ db, client, fieldMap, now, log, triage: deps.triage }, campaign);
      log.info({ orgId, campaignId: campaign.id, ...result }, 'campaign refreshed');
    } catch (err) {
      if (isConnectionFailure(err)) return pauseForBrokenCrm(db, log, orgId, err);
      await recordFailure(db, log, campaign, now, err);
    } finally {
      await releaseClaim(db, campaign, claimedAt);
    }
  }
}

/**
 * The `campaign.refresh` tick (every 5 minutes): refreshes each `dry_run`/`active`
 * campaign whose last successful refresh is older than its `refresh_minutes` (or that never
 * refreshed), tenant by tenant. Each campaign is claimed (`refresh_started_at`) for the
 * duration of its refresh, so overlapping ticks never refresh it twice, and the tick stops
 * starting campaigns after `REFRESH_TICK_BUDGET_MS`; the rest wait for the next tick.
 * `CrmNotConnectedError` or `SalesforceAuthError` pauses that tenant's running campaigns
 * (`pause_reason = 'crm_broken'`); any other failure is stored in `last_refresh_error` and
 * retried on the next tick.
 */
export async function refreshDueCampaigns(deps: RefreshDeps): Promise<void> {
  const { db, now } = deps;
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + REFRESH_TICK_BUDGET_MS;
  let budgetLogged = false;
  const outOfTime = (): boolean => {
    if (clock() < deadline) return false;
    if (!budgetLogged) {
      budgetLogged = true;
      deps.log.warn({ budgetMs: REFRESH_TICK_BUDGET_MS }, 'campaign refresh tick out of time; remaining campaigns wait for the next tick');
    }
    return true;
  };
  await releaseArchivedEnrollments(db, deps.log);
  const due = await db.select().from(schema.campaigns).where(dueCondition(now)).orderBy(schema.campaigns.orgId, schema.campaigns.createdAt);
  const byOrg = new Map<string, CampaignRow[]>();
  for (const c of due) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c]);
  for (const [orgId, list] of byOrg) {
    if (outOfTime()) return;
    await refreshOrg(deps, orgId, list, outOfTime);
  }
}
