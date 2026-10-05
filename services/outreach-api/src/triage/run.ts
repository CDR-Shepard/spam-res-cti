/**
 * `record.triage` (every minute): triages up to `batch` records that need it and are
 * enrolled (status `active`) in a `dry_run` or `active` campaign. Per tenant the daily AI
 * budget is checked first; a spent budget pauses the tenant's running campaigns
 * (`ai_budget`). Per record: fetch the notes, skip the model when the fingerprint is
 * unchanged, otherwise call the model, record the spend, and store the result. A
 * `doNotContact` result moves every active enrollment of the record to `needs_review`.
 *
 * Rows are claimed atomically (`triage_attempted_at = now`, FOR UPDATE SKIP LOCKED), so an
 * overlapping tick never takes the same record. Clearing `triage_needed` compares
 * `triage_attempted_at` with that claim, so a sync that changes the record mid-triage
 * (which resets it to NULL) is triaged again rather than lost. A claimed record whose triage did not finish
 * (a failed notes fetch) is skipped for `TRIAGE_BACKOFF_MS`; a claimed record the tick never
 * reached is released. At most `TRIAGE_PER_ORG_CAP` records per tenant go into one batch.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { FieldMap, SfObject, type TriageResult } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceAuthError, type SalesforceClient } from '@cti/salesforce';
import { addSpend, budgetMicros, spentTodayMicros } from '../ai/budget.js';
import { costMicros, isPricedModel, TriageOutputError, type TriageModel } from '../ai/model.js';
import { holdForReview } from '../campaigns/dnc-hold.js';
import { pauseOrgCampaigns } from '../campaigns/pause.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { outreachSettings } from '../settings.js';
import { buildTriagePrompt, fetchNotesBundle, notesFingerprint, type NotesBundle } from './notes.js';

export const TRIAGE_BATCH = 20;
/** Most records one tenant may take from a batch, so one tenant cannot starve the others. */
export const TRIAGE_PER_ORG_CAP = 5;
/** How long a claimed record whose triage did not finish waits before it is picked again. */
export const TRIAGE_BACKOFF_MS = 30 * 60 * 1000;
/** The tick stops starting new records after this long (the queue expires a job at 15 minutes). */
export const TRIAGE_DEADLINE_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 10;

export interface TriageDeps {
  db: Db;
  clients: SalesforceClientFactory;
  model: TriageModel;
  now: Date;
  log: RunnerLogger;
  batch?: number;
  /** Wall clock in ms for the tick deadline; tests inject one. Defaults to `Date.now`. */
  clock?: () => number;
}

interface DueRecord {
  id: string;
  orgId: string;
  sfObject: string;
  sfRecordId: string;
  notesHash: string | null;
}

/** What one record's triage did: its cost, or that the tenant (`skip_org`) or the whole tick (`stop`) must stop. */
type Step = { kind: 'done'; costMicros: number } | { kind: 'skip_org' } | { kind: 'stop' };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Claims up to `batch` due records, at most `TRIAGE_PER_ORG_CAP` per tenant, oldest first
 * and round-robin across tenants. Due: still owed a triage, enrolled in a running campaign,
 * and not claimed within the backoff. The window function cannot share a statement with
 * FOR UPDATE, so the ranked ids are locked in a second step that re-checks the due
 * condition (a concurrent claim makes the re-check fail and the row is skipped).
 */
async function claimDueRecords(db: Db, now: Date, batch: number): Promise<DueRecord[]> {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - TRIAGE_BACKOFF_MS).toISOString();
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT r.id, r.synced_at,
             ROW_NUMBER() OVER (PARTITION BY r.org_id ORDER BY r.synced_at, r.id) AS rn
      FROM crm_records r
      WHERE r.triage_needed
        AND (r.triage_attempted_at IS NULL OR r.triage_attempted_at < ${staleBefore}::timestamptz)
        AND EXISTS (SELECT 1 FROM campaign_enrollments e JOIN campaigns c ON c.id = e.campaign_id
                    WHERE e.crm_record_id = r.id AND e.status = 'active' AND c.status IN ('dry_run', 'active'))
    ), picked AS (
      SELECT id FROM ranked WHERE rn <= ${TRIAGE_PER_ORG_CAP} ORDER BY rn, synced_at LIMIT ${batch}
    ), locked AS (
      SELECT r.id FROM crm_records r
      WHERE r.id IN (SELECT id FROM picked)
        AND r.triage_needed
        AND (r.triage_attempted_at IS NULL OR r.triage_attempted_at < ${staleBefore}::timestamptz)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE crm_records r SET triage_attempted_at = ${nowIso}::timestamptz
    FROM locked
    WHERE r.id = locked.id
    RETURNING r.id, r.org_id, r.sf_object, r.sf_record_id, r.notes_hash, r.synced_at`);
  const rows = result.rows as Array<{
    id: string;
    org_id: string;
    sf_object: string;
    sf_record_id: string;
    notes_hash: string | null;
    synced_at: Date | string;
  }>;
  return rows
    .sort((a, b) => new Date(a.synced_at).getTime() - new Date(b.synced_at).getTime())
    .map((row) => ({ id: row.id, orgId: row.org_id, sfObject: row.sf_object, sfRecordId: row.sf_record_id, notesHash: row.notes_hash }));
}

/** Gives back the claim on records the tick never started, so they are not backed off. */
async function releaseClaims(db: Db, now: Date, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = schema.crmRecords;
  await db
    .update(r)
    .set({ triageAttemptedAt: null })
    .where(and(inArray(r.id, ids), eq(r.triageAttemptedAt, now)));
}

async function touchHistory(db: Db, crmRecordId: string): Promise<Array<{ channel: string; status: string; at: string }>> {
  const t = schema.touches;
  const rows = await db
    .select({ channel: t.channel, status: t.status, sentAt: t.sentAt, dueAt: t.dueAt })
    .from(t)
    .innerJoin(schema.campaignEnrollments, eq(schema.campaignEnrollments.id, t.enrollmentId))
    .where(eq(schema.campaignEnrollments.crmRecordId, crmRecordId))
    .orderBy(desc(sql`coalesce(${t.sentAt}, ${t.dueAt})`))
    .limit(HISTORY_LIMIT);
  return rows.map((row) => ({ channel: row.channel, status: row.status, at: (row.sentAt ?? row.dueAt).toISOString() }));
}

/**
 * The record is still exactly as this tick claimed it: `triage_attempted_at` is the claim's
 * time. A sync that changed the record since (enroll.ts upsert, or a newly logged Task)
 * reset it to NULL, and then the triage this tick ran is stale: `triage_needed` must stay set.
 */
function stillClaimed(crmRecordId: string, claimedAt: Date) {
  return and(eq(schema.crmRecords.id, crmRecordId), eq(schema.crmRecords.triageAttemptedAt, claimedAt));
}

async function clearTriageNeeded(db: Db, crmRecordId: string, claimedAt: Date): Promise<void> {
  await db.update(schema.crmRecords).set({ triageNeeded: false }).where(stillClaimed(crmRecordId, claimedAt));
}

/**
 * Stores the result and, for a do-not-contact flag, holds the person for review — one
 * transaction. The record's `notes_hash`/`triage_needed` move only while the claim still
 * stands (`claimedAt`); after a mid-triage sync the record is triaged again on the next
 * tick. A do-not-contact flag holds the person either way: the safe side.
 */
async function storeTriage(
  db: Db,
  args: { orgId: string; crmRecordId: string; claimedAt: Date; notesHash: string; model: string; result: TriageResult; inputTokens: number; outputTokens: number; now: Date },
): Promise<number> {
  return db.transaction(async (tx) => {
    const [stored] = await tx.insert(schema.recordTriage).values({
      orgId: args.orgId,
      crmRecordId: args.crmRecordId,
      notesHash: args.notesHash,
      model: args.model,
      result: args.result,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      createdAt: args.now,
    }).returning({ id: schema.recordTriage.id });
    await tx
      .update(schema.crmRecords)
      .set({ notesHash: args.notesHash, triageNeeded: false })
      .where(stillClaimed(args.crmRecordId, args.claimedAt));
    const flag = args.result.doNotContact;
    if (!flag) return 0;
    // An enrollment that left `active` meanwhile is not held here; the planner holds the
    // record's next enrollment from this stored row (campaigns/dnc-hold.ts).
    const held = await holdForReview(tx, { crmRecordId: args.crmRecordId }, { triageId: stored!.id, ...flag }, args.now);
    return held.length;
  });
}

async function triageOne(deps: TriageDeps, client: SalesforceClient, fieldMap: FieldMap, rec: DueRecord): Promise<Step> {
  const { db, log, now } = deps;
  const sfObject = SfObject.parse(rec.sfObject);
  let bundle: NotesBundle;
  try {
    bundle = await fetchNotesBundle(client, sfObject, rec.sfRecordId, fieldMap[sfObject]);
  } catch (err) {
    if (err instanceof SalesforceAuthError || err instanceof CrmNotConnectedError) {
      log.warn({ orgId: rec.orgId, err: message(err) }, 'triage: salesforce connection unusable; skipping tenant');
      return { kind: 'skip_org' };
    }
    // Left `triage_needed`; the next tick retries. A deleted record leaves the campaign at its next refresh.
    log.warn({ orgId: rec.orgId, crmRecordId: rec.id, err: message(err) }, 'triage: notes fetch failed');
    return { kind: 'done', costMicros: 0 };
  }

  const fingerprint = notesFingerprint(bundle);
  if (fingerprint === rec.notesHash) {
    await clearTriageNeeded(db, rec.id, now);
    return { kind: 'done', costMicros: 0 };
  }

  let out: Awaited<ReturnType<TriageModel['triage']>>;
  try {
    out = await deps.model.triage(buildTriagePrompt(bundle, await touchHistory(db, rec.id)));
  } catch (err) {
    if (err instanceof TriageOutputError) {
      // Paid for, but unusable. Not retried until the record changes again (`notes_hash` is left as it was).
      const cost = costMicros(err.usage.model, err.usage.inputTokens, err.usage.outputTokens);
      await addSpend(db, rec.orgId, now, cost);
      await clearTriageNeeded(db, rec.id, now);
      log.warn({ orgId: rec.orgId, crmRecordId: rec.id, err: err.message }, 'triage: model output rejected');
      return { kind: 'done', costMicros: cost };
    }
    log.error({ orgId: rec.orgId, err: message(err) }, 'triage: model call failed; stopping this tick');
    return { kind: 'stop' };
  }

  const cost = costMicros(out.model, out.inputTokens, out.outputTokens);
  // Spend first: the call is paid for even if storing the result fails.
  await addSpend(db, rec.orgId, now, cost);
  // The claim set triage_attempted_at = now (claimDueRecords).
  const flagged = await storeTriage(db, { orgId: rec.orgId, crmRecordId: rec.id, claimedAt: now, notesHash: fingerprint, now, ...out });
  if (flagged > 0) log.info({ orgId: rec.orgId, crmRecordId: rec.id, flagged }, 'triage: do-not-contact flag held for review');
  return { kind: 'done', costMicros: cost };
}

async function pauseForBudget(deps: TriageDeps, orgId: string, spent: number, budget: number): Promise<void> {
  const paused = await pauseOrgCampaigns(deps.db, orgId, 'ai_budget');
  deps.log.warn({ orgId, spentMicros: spent, budgetMicros: budget, paused }, 'daily AI budget spent; paused the tenant campaigns');
}

/** Where the tick stands: when it began and which claimed records it has started. */
interface TickState {
  startedAt: number;
  attempted: Set<string>;
}

/** Returns false when the whole tick must stop (the model API is failing, or the deadline passed). */
async function triageOrg(deps: TriageDeps, tick: TickState, orgId: string, records: DueRecord[]): Promise<boolean> {
  const { db, log, now } = deps;
  const clock = deps.clock ?? Date.now;
  const [org] = await db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  const budget = budgetMicros(outreachSettings({ settings: org?.settings ?? {} }));
  let spent = await spentTodayMicros(db, orgId, now);
  if (spent >= budget) {
    await pauseForBudget(deps, orgId, spent, budget);
    return true;
  }
  let client: SalesforceClient;
  let fieldMap: FieldMap;
  try {
    client = await deps.clients(orgId);
    const parsed = FieldMap.safeParse((await loadConnection(db, orgId))?.fieldMap);
    if (!parsed.success) throw new Error('the Salesforce field map is missing or invalid');
    fieldMap = parsed.data;
  } catch (err) {
    // The campaign.refresh tick pauses the tenant's campaigns for a broken connection.
    log.warn({ orgId, err: message(err) }, 'triage: no usable salesforce connection; skipping tenant');
    return true;
  }
  for (const rec of records) {
    if (clock() - tick.startedAt >= TRIAGE_DEADLINE_MS) {
      log.warn({ orgId }, 'triage: tick deadline reached; leaving the rest for the next tick');
      return false;
    }
    if (spent >= budget) {
      await pauseForBudget(deps, orgId, spent, budget);
      return true;
    }
    tick.attempted.add(rec.id);
    const step = await triageOne(deps, client, fieldMap, rec);
    if (step.kind === 'stop') return false;
    if (step.kind === 'skip_org') return true;
    spent += step.costMicros;
  }
  return true;
}

export async function triageDueRecords(deps: TriageDeps): Promise<void> {
  // Spend is priced per model; an unpriced one would pay for calls it could not record. Check before any claim.
  if (!isPricedModel(deps.model.modelId)) {
    deps.log.error({ model: deps.model.modelId }, 'triage: no price configured for the triage model; skipping triage this tick');
    return;
  }
  const tick: TickState = { startedAt: (deps.clock ?? Date.now)(), attempted: new Set() };
  const due = await claimDueRecords(deps.db, deps.now, deps.batch ?? TRIAGE_BATCH);
  const byOrg = new Map<string, DueRecord[]>();
  for (const rec of due) byOrg.set(rec.orgId, [...(byOrg.get(rec.orgId) ?? []), rec]);
  try {
    for (const [orgId, records] of byOrg) {
      if (!(await triageOrg(deps, tick, orgId, records))) return;
    }
  } finally {
    // Runs on the way out of an error too: a failure here is logged, never allowed to replace that error.
    try {
      await releaseClaims(deps.db, deps.now, due.filter((rec) => !tick.attempted.has(rec.id)).map((rec) => rec.id));
    } catch (err) {
      deps.log.error({ err: message(err) }, 'triage: releasing unstarted claims failed; they are retried after the backoff');
    }
  }
}
