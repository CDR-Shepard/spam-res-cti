/**
 * Salesforce sync worker — drains salesforce_sync_jobs.
 * Idempotent: once a job has a salesforce_task_id stored on the call, we
 * mark it succeeded and skip recreation.
 */
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { normalize } from '../phone.js';
import { createCallTask, findByPhone, SalesforceUnauthorizedError } from './client.js';

const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 30_000; // 30s, 60s, 2m, 4m, ...
// A job sits in 'in_flight' only while a tick is actively syncing it (SF calls
// take seconds). If it's been in_flight longer than this, the tick that owned
// it died (crash / Railway redeploy) and the job is orphaned — reap it back to
// 'pending' so its call still gets a Salesforce Task.
const STUCK_AFTER_MS = 2 * 60_000;
// Grace period before a terminal call with no Task is auto-logged. Long enough
// that a rep filling out a wrap-up isn't swept out from under them; short enough
// that an abandoned (tab-closed / crashed) call still lands in Salesforce.
const LOG_GRACE_MS = 10 * 60_000;
// Terminal statuses that represent a real dial the rep should have a Task for.
const LOGGABLE_TERMINAL_STATUSES: schema.Call['status'][] = ['completed', 'no_answer', 'busy', 'canceled'];

export async function enqueueSyncForCall(callId: string): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.salesforceSyncJobs)
    .values({ callId, status: 'pending' })
    .onConflictDoNothing();
}

/**
 * Reset orphaned 'in_flight' jobs (owner tick died) back to 'pending'. Runs at
 * the start of every tick; ticks are single-flight so a live sync can't be
 * mistaken for an orphan within the 2-minute window.
 */
async function reapStuckJobs(): Promise<void> {
  const db = getDb();
  await db
    .update(schema.salesforceSyncJobs)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(
      and(
        eq(schema.salesforceSyncJobs.status, 'in_flight'),
        lte(schema.salesforceSyncJobs.updatedAt, new Date(Date.now() - STUCK_AFTER_MS)),
      ),
    );
}

/**
 * Guarantee every real call becomes a Salesforce Task even if the rep never
 * dispositions it (closed the tab, crash). Any terminal call with no Task,
 * older than the grace window, gets a default disposition (so it's labeled and
 * the "disposition before next call" gate clears) and is queued for sync.
 * Idempotent: enqueue no-ops if a job already exists; syncOne skips a call that
 * already has a Task.
 */
async function sweepUnloggedCalls(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - LOG_GRACE_MS);
  const stale = await db
    .select({ id: schema.calls.id, disposition: schema.calls.disposition })
    .from(schema.calls)
    .where(
      and(
        isNull(schema.calls.salesforceTaskId),
        inArray(schema.calls.status, LOGGABLE_TERMINAL_STATUSES),
        sql`coalesce(${schema.calls.endedAt}, ${schema.calls.updatedAt}) < ${cutoff}`,
      ),
    )
    .limit(50);
  for (const c of stale) {
    if (!c.disposition) {
      await db
        .update(schema.calls)
        .set({ disposition: 'Not dispositioned', updatedAt: new Date() })
        .where(eq(schema.calls.id, c.id));
    }
    await enqueueSyncForCall(c.id);
  }
}

export async function runSyncTick(): Promise<{ processed: number }> {
  const db = getDb();
  await reapStuckJobs();
  await sweepUnloggedCalls();
  const now = new Date();
  const jobs = await db
    .select()
    .from(schema.salesforceSyncJobs)
    .where(
      and(
        eq(schema.salesforceSyncJobs.status, 'pending'),
        lte(schema.salesforceSyncJobs.nextAttemptAt, now),
      ),
    )
    .limit(10);

  let processed = 0;
  for (const job of jobs) {
    await db
      .update(schema.salesforceSyncJobs)
      .set({ status: 'in_flight', updatedAt: new Date() })
      .where(eq(schema.salesforceSyncJobs.id, job.id));

    try {
      await syncOne(job.callId);
      await db
        .update(schema.salesforceSyncJobs)
        .set({
          status: 'succeeded',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.salesforceSyncJobs.id, job.id));
    } catch (err) {
      const attempts = job.attempts + 1;
      const fatal = err instanceof SalesforceUnauthorizedError || attempts >= MAX_ATTEMPTS;
      const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
      await db
        .update(schema.salesforceSyncJobs)
        .set({
          status: fatal ? 'failed' : 'pending',
          attempts,
          lastError: (err as Error).message.slice(0, 2000),
          nextAttemptAt: new Date(Date.now() + delayMs),
          updatedAt: new Date(),
        })
        .where(eq(schema.salesforceSyncJobs.id, job.id));
    }
    processed++;
  }
  return { processed };
}

async function syncOne(callId: string): Promise<void> {
  const db = getDb();
  const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) });
  if (!call) return;
  if (call.salesforceTaskId) return; // already synced

  const audit = call.preCallAuditId
    ? await db.query.preCallAudits.findFirst({ where: eq(schema.preCallAudits.id, call.preCallAuditId) })
    : null;

  const inbound = call.direction === 'inbound';
  // The other party: who we called (outbound) or who called us (inbound).
  const counterparty = inbound
    ? (normalize(call.fromNumber).value?.e164 ?? call.fromNumber)
    : call.normalizedToNumber;

  // Resolve a record match if the click-to-dial / inbound lookup didn't already
  // set one. Match against the counterparty number, never our own DID.
  let whoId = call.salesforceWhoId ?? undefined;
  let whatId = call.salesforceWhatId ?? undefined;
  if (!whoId && !whatId) {
    const match = await findByPhone(call.userId, counterparty);
    if (match?.whoId) whoId = match.whoId;
    if (match?.whatId) whatId = match.whatId;
  }

  const subject = `${inbound ? 'Inbound' : 'Outbound'} Call - ${counterparty}`;

  const customFields: Record<string, string | number | null> = {
    External_Call_Id__c: call.id,
    Provider_Call_Id__c: call.providerCallId ?? null,
    From_Number__c: call.fromNumber,
    To_Number__c: call.toNumber,
    Normalized_To_Number__c: call.normalizedToNumber,
    Recording_URL__c: call.recordingUrl ?? null,
    Transcript_URL__c: call.transcriptUrl ?? null,
    Call_Start_Time__c: call.startedAt?.toISOString() ?? null,
    Call_End_Time__c: call.endedAt?.toISOString() ?? null,
    CTI_Provider__c: call.provider,
    Precall_Decision__c: audit?.decision ?? null,
    Precall_Block_Reason__c: audit?.blockReason ?? null,
    // The DID involved in the call (our caller ID outbound; the dialed line inbound).
    Outbound_Caller_ID__c: inbound ? call.normalizedToNumber : call.fromNumber,
  };

  // The Salesforce Task Description stays lean (rep notes + call time) so org
  // Chatter automations that repost the disposition/description don't publish CTI
  // diagnostics. The complete record lives in our DB (calls.sync_detail).
  const description = buildTaskDescription(call);
  const fullDetail = buildFullDetail(call, audit ?? null, customFields);

  const { taskId, degradedFields } = await createCallTask(call.userId, {
    subject,
    callType: inbound ? 'Inbound' : 'Outbound',
    callDisposition: call.disposition ?? undefined,
    callDurationInSeconds: call.durationSeconds ?? undefined,
    whoId,
    whatId,
    description,
    customFields,
  });

  await db
    .update(schema.calls)
    .set({
      salesforceTaskId: taskId,
      salesforceWhoId: whoId ?? null,
      salesforceWhatId: whatId ?? null,
      syncDetail: fullDetail,
      updatedAt: new Date(),
      metadata: degradedFields
        ? sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ salesforceDegradedFields: degradedFields })}::jsonb`
        : undefined,
    })
    .where(eq(schema.calls.id, call.id));

  await db
    .update(schema.salesforceSyncJobs)
    .set({ salesforceTaskId: taskId, updatedAt: new Date() })
    .where(eq(schema.salesforceSyncJobs.callId, call.id));
}

/**
 * Salesforce Task Description = ONLY the rep's notes (empty when there are none).
 * GG Homes' "Task - After Create or Update" flow posts to Chatter only when the
 * Description is populated, so we must NOT put anything else here (call time,
 * diagnostics) — otherwise every no-note dial trips the flow and spams Chatter.
 * The call time lives on the Task's ActivityDate/CallObject fields and the full
 * record is in our DB (calls.sync_detail); createCallTask omits an empty
 * Description so the field stays null.
 */
export function buildTaskDescription(call: typeof schema.calls.$inferSelect): string {
  return call.notes?.trim() ?? '';
}

/**
 * FULL human-readable call record kept in our DB (calls.sync_detail): rep notes,
 * numbers, provider ids, durations, the firewall decision + reasons, and the
 * extended custom-field metadata. This is the complete detail that used to bloat
 * the Salesforce Task Description.
 */
export function buildFullDetail(
  call: typeof schema.calls.$inferSelect,
  audit: typeof schema.preCallAudits.$inferSelect | null,
  customFields: Record<string, string | number | null>,
): string {
  const lines: string[] = [];
  if (call.notes) {
    lines.push('Rep notes:', call.notes, '');
  }
  lines.push('--- Caller Reputation CTI ---');
  lines.push(`To: ${call.normalizedToNumber}`);
  lines.push(`From: ${call.fromNumber}`);
  lines.push(`Provider: ${call.provider}`);
  if (call.providerCallId) lines.push(`Provider call id: ${call.providerCallId}`);
  if (call.durationSeconds != null) lines.push(`Duration: ${call.durationSeconds}s`);
  if (call.disposition) lines.push(`Disposition: ${call.disposition}`);
  if (audit) {
    lines.push(`Pre-call decision: ${audit.decision}`);
    if (audit.blockReason) lines.push(`Block reason: ${audit.blockReason}`);
    const reasons = (audit.reasons as string[]) ?? [];
    if (reasons.length) lines.push(`Reasons: ${reasons.join(', ')}`);
  }
  lines.push('', '--- Extended metadata ---');
  for (const [k, v] of Object.entries(customFields)) {
    if (v !== null && v !== undefined) lines.push(`${k}: ${v}`);
  }
  return lines.join('\n');
}

// Drive the loop from server.ts
export function startSyncLoop(intervalMs = 5000): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runSyncTick()
      .catch((err) => console.error('[sf-sync] tick error', err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
