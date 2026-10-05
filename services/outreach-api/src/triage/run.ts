/**
 * `record.triage` (every minute): triages up to `batch` records that need it and are
 * enrolled (status `active`) in a `dry_run` or `active` campaign. Per tenant the daily AI
 * budget is checked first; a spent budget pauses the tenant's running campaigns
 * (`ai_budget`). Per record: fetch the notes, skip the model when the fingerprint is
 * unchanged, otherwise call the model, record the spend, and store the result. A
 * `doNotContact` result moves every active enrollment of the record to `needs_review`.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { FieldMap, SfObject, type TriageResult } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceAuthError, type SalesforceClient } from '@cti/salesforce';
import { addSpend, budgetMicros, spentTodayMicros } from '../ai/budget.js';
import { costMicros, TriageOutputError, type TriageModel } from '../ai/model.js';
import { OPEN_TOUCH_STATUSES } from '../campaigns/enroll.js';
import { pauseOrgCampaigns } from '../campaigns/pause.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { outreachSettings } from '../settings.js';
import { buildTriagePrompt, fetchNotesBundle, notesFingerprint, type NotesBundle } from './notes.js';

export const TRIAGE_BATCH = 20;
const HISTORY_LIMIT = 10;

export interface TriageDeps {
  db: Db;
  clients: SalesforceClientFactory;
  model: TriageModel;
  now: Date;
  log: RunnerLogger;
  batch?: number;
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

async function dueRecords(db: Db, batch: number): Promise<DueRecord[]> {
  const r = schema.crmRecords;
  const e = schema.campaignEnrollments;
  const c = schema.campaigns;
  return db
    .select({ id: r.id, orgId: r.orgId, sfObject: r.sfObject, sfRecordId: r.sfRecordId, notesHash: r.notesHash })
    .from(r)
    .where(
      and(
        eq(r.triageNeeded, true),
        sql`EXISTS (SELECT 1 FROM ${e} JOIN ${c} ON ${c.id} = ${e.campaignId}
                    WHERE ${e.crmRecordId} = ${r.id} AND ${e.status} = 'active' AND ${c.status} IN ('dry_run', 'active'))`,
      ),
    )
    .orderBy(r.orgId, r.syncedAt)
    .limit(batch);
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

async function clearTriageNeeded(db: Db, crmRecordId: string): Promise<void> {
  await db.update(schema.crmRecords).set({ triageNeeded: false }).where(eq(schema.crmRecords.id, crmRecordId));
}

/** Stores the result and, for a do-not-contact flag, holds the person for review — one transaction. */
async function storeTriage(
  db: Db,
  args: { orgId: string; crmRecordId: string; notesHash: string; model: string; result: TriageResult; inputTokens: number; outputTokens: number; now: Date },
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.insert(schema.recordTriage).values({
      orgId: args.orgId,
      crmRecordId: args.crmRecordId,
      notesHash: args.notesHash,
      model: args.model,
      result: args.result,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      createdAt: args.now,
    });
    await tx
      .update(schema.crmRecords)
      .set({ notesHash: args.notesHash, triageNeeded: false })
      .where(eq(schema.crmRecords.id, args.crmRecordId));
    const flag = args.result.doNotContact;
    if (!flag) return 0;
    const flagged = await tx
      .update(schema.campaignEnrollments)
      .set({ status: 'needs_review', reviewCategory: flag.category, reviewQuote: flag.quote, flaggedAt: args.now, nextTouchAt: null, updatedAt: args.now })
      .where(and(eq(schema.campaignEnrollments.crmRecordId, args.crmRecordId), eq(schema.campaignEnrollments.status, 'active')))
      .returning({ id: schema.campaignEnrollments.id });
    if (flagged.length > 0) {
      await tx
        .update(schema.touches)
        .set({ status: 'skipped', skipReason: 'needs_review', updatedAt: args.now })
        .where(
          and(
            inArray(schema.touches.enrollmentId, flagged.map((f) => f.id)),
            inArray(schema.touches.status, [...OPEN_TOUCH_STATUSES]),
          ),
        );
    }
    return flagged.length;
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
    await clearTriageNeeded(db, rec.id);
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
      await clearTriageNeeded(db, rec.id);
      log.warn({ orgId: rec.orgId, crmRecordId: rec.id, err: err.message }, 'triage: model output rejected');
      return { kind: 'done', costMicros: cost };
    }
    log.error({ orgId: rec.orgId, err: message(err) }, 'triage: model call failed; stopping this tick');
    return { kind: 'stop' };
  }

  const cost = costMicros(out.model, out.inputTokens, out.outputTokens);
  // Spend first: the call is paid for even if storing the result fails.
  await addSpend(db, rec.orgId, now, cost);
  const flagged = await storeTriage(db, { orgId: rec.orgId, crmRecordId: rec.id, notesHash: fingerprint, now, ...out });
  if (flagged > 0) log.info({ orgId: rec.orgId, crmRecordId: rec.id, flagged }, 'triage: do-not-contact flag held for review');
  return { kind: 'done', costMicros: cost };
}

async function pauseForBudget(deps: TriageDeps, orgId: string, spent: number, budget: number): Promise<void> {
  const paused = await pauseOrgCampaigns(deps.db, orgId, 'ai_budget');
  deps.log.warn({ orgId, spentMicros: spent, budgetMicros: budget, paused }, 'daily AI budget spent; paused the tenant campaigns');
}

/** Returns false when the whole tick must stop (the model API is failing). */
async function triageOrg(deps: TriageDeps, orgId: string, records: DueRecord[]): Promise<boolean> {
  const { db, log, now } = deps;
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
    if (spent >= budget) {
      await pauseForBudget(deps, orgId, spent, budget);
      return true;
    }
    const step = await triageOne(deps, client, fieldMap, rec);
    if (step.kind === 'stop') return false;
    if (step.kind === 'skip_org') return true;
    spent += step.costMicros;
  }
  return true;
}

export async function triageDueRecords(deps: TriageDeps): Promise<void> {
  const due = await dueRecords(deps.db, deps.batch ?? TRIAGE_BATCH);
  const byOrg = new Map<string, DueRecord[]>();
  for (const rec of due) byOrg.set(rec.orgId, [...(byOrg.get(rec.orgId) ?? []), rec]);
  for (const [orgId, records] of byOrg) {
    if (!(await triageOrg(deps, orgId, records))) return;
  }
}
