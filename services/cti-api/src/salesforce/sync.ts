/**
 * Salesforce sync worker — drains salesforce_sync_jobs.
 * Idempotent: once a job has a salesforce_task_id stored on the call, we
 * mark it succeeded and skip recreation.
 */
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { normalize } from '../phone.js';
import { loadConfig } from '../config.js';
import { buildRecordingPublicUrl } from '../telephony/recording-links.js';
import { createCallTask, findByPhone, SalesforceUnauthorizedError, updateCallTask } from './client.js';

/** Public no-login recording link for a call, or null when nothing is recorded. */
function recordingPublicUrl(call: typeof schema.calls.$inferSelect): string | null {
  if (!call.recordingUrl) return null;
  const cfg = loadConfig();
  return buildRecordingPublicUrl(call.id, { apiPublicUrl: cfg.API_PUBLIC_URL, secret: cfg.SESSION_SECRET });
}

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
// An inbound call is inserted 'in_progress' and only advances to a terminal
// status via the /dial-result (or voicemail /recording) callback. If Twilio
// drops that callback, the row is stranded 'in_progress' forever — never
// terminal, so sweepUnloggedCalls (terminal-only) never logs it. Age such rows
// to a terminal status after this window so they still reach Salesforce.
const INBOUND_STALE_MS = 10 * 60_000;
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
/** Disposition stamped by the sweep on a truly-abandoned call. The disposition
 *  endpoint treats this as the one value a rep may still return to correct. */
export const AUTO_DISPOSITION = 'Not dispositioned';

async function sweepUnloggedCalls(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - LOG_GRACE_MS);
  const stale = await db
    .select({ id: schema.calls.id })
    .from(schema.calls)
    .where(
      and(
        isNull(schema.calls.salesforceTaskId),
        // ONLY truly-abandoned calls (never dispositioned). A call the rep already
        // dispositioned is either enqueued for backend sync or logged via Open CTI
        // — sweeping it here would create a DUPLICATE Salesforce Task.
        isNull(schema.calls.disposition),
        inArray(schema.calls.status, LOGGABLE_TERMINAL_STATUSES),
        sql`coalesce(${schema.calls.endedAt}, ${schema.calls.updatedAt}) < ${cutoff}`,
      ),
    )
    .limit(50);
  for (const c of stale) {
    await db
      .update(schema.calls)
      .set({ disposition: AUTO_DISPOSITION, updatedAt: new Date() })
      .where(eq(schema.calls.id, c.id));
    await enqueueSyncForCall(c.id);
  }
}

/**
 * Rescue inbound calls stranded in 'in_progress' by a dropped /dial-result
 * callback. After the stale window the true outcome is unknowable, so we mark
 * them 'no_answer' (conservative — we never confirmed a connect) and enqueue a
 * Salesforce sync so the call is still logged. If a late dial-result/recording
 * callback does arrive it overwrites the status + real duration, and the sync
 * job (keyed by callId, onConflictDoNothing) stays idempotent.
 */
async function reapStaleInboundCalls(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - INBOUND_STALE_MS);
  // startedAt is always set at insert for inbound rows, so it's a safe cutoff key.
  const reaped = await db
    .update(schema.calls)
    .set({ status: 'no_answer', endedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.calls.direction, 'inbound'),
        eq(schema.calls.status, 'in_progress'),
        lte(schema.calls.startedAt, cutoff),
      ),
    )
    .returning({ id: schema.calls.id });
  for (const c of reaped) {
    await enqueueSyncForCall(c.id);
  }
}

export async function runSyncTick(): Promise<{ processed: number }> {
  const db = getDb();
  await reapStuckJobs();
  await reapStaleInboundCalls();
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
    // NOTE: the recording link (tdc_cti__Recording_URL__c) is NOT set here —
    // createCallTask blanket-strips ALL custom fields when the org is missing any
    // of the generic ones above, which would drop a valid recording field too.
    // It's attached via a dedicated single-field PATCH after the Task exists
    // (see the tdc_cti__Recording_URL__c push below and pushRecordingLinkToTask).
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

  // Attach the recording link if it already arrived. Re-read recordingUrl FRESH
  // (not the stale `call` snapshot from the top of this fn): the recording
  // webhook may have written it while createCallTask was in flight. Because
  // salesforceTaskId is now committed above, any webhook that raced us and saw no
  // Task (returned 'pending') is covered here — closing the lost-link window.
  const fresh = await db.query.calls.findFirst({
    columns: { recordingUrl: true },
    where: eq(schema.calls.id, call.id),
  });
  if (fresh?.recordingUrl) {
    const cfg = loadConfig();
    const recUrl = buildRecordingPublicUrl(call.id, {
      apiPublicUrl: cfg.API_PUBLIC_URL,
      secret: cfg.SESSION_SECRET,
    });
    try {
      await updateCallTask(call.userId, taskId, { tdc_cti__Recording_URL__c: recUrl });
    } catch (err) {
      console.error('[sf-sync] recording attach failed', {
        callId: call.id,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Attach a call's public recording link to its Salesforce Task. Called by the
 * recording-completed webhook once Twilio finishes the recording.
 *   - 'patched'  → Task exists and was updated.
 *   - 'pending'  → Task not created yet; syncOne will attach it on create.
 *   - 'skipped'  → nothing recorded for this call.
 */
export async function pushRecordingLinkToTask(
  callId: string,
): Promise<'patched' | 'pending' | 'skipped'> {
  const db = getDb();
  const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) });
  if (!call) return 'skipped';
  const url = recordingPublicUrl(call);
  if (!url) return 'skipped';
  if (!call.salesforceTaskId) return 'pending';
  await updateCallTask(call.userId, call.salesforceTaskId, { tdc_cti__Recording_URL__c: url });
  return 'patched';
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
