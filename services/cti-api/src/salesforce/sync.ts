/**
 * Salesforce sync worker — drains salesforce_sync_jobs.
 * Idempotent: once a job has a salesforce_task_id stored on the call, we
 * mark it succeeded and skip recreation.
 */
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { createCallTask, findByPhone, SalesforceUnauthorizedError } from './client.js';

const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 30_000; // 30s, 60s, 2m, 4m, ...

export async function enqueueSyncForCall(callId: string): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.salesforceSyncJobs)
    .values({ callId, status: 'pending' })
    .onConflictDoNothing();
}

export async function runSyncTick(): Promise<{ processed: number }> {
  const db = getDb();
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
      .set({ status: 'in_flight' })
      .where(eq(schema.salesforceSyncJobs.id, job.id));

    try {
      await syncOne(job.callId);
      await db
        .update(schema.salesforceSyncJobs)
        .set({
          status: 'succeeded',
          completedAt: new Date(),
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

  // Resolve match if not already set
  let whoId = call.salesforceWhoId ?? undefined;
  let whatId = call.salesforceWhatId ?? undefined;
  if (!whoId) {
    const match = await findByPhone(call.userId, call.normalizedToNumber);
    if (match?.whoId) whoId = match.whoId;
    if (match?.whatId) whatId = match.whatId;
  }

  const subject = `Outbound Call - ${call.normalizedToNumber}`;
  const description = buildDescription(call, audit ?? null);

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
    Outbound_Caller_ID__c: call.fromNumber,
  };

  const { taskId, degradedFields } = await createCallTask(call.userId, {
    subject,
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
      updatedAt: new Date(),
      metadata: degradedFields
        ? sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ salesforceDegradedFields: degradedFields })}::jsonb`
        : undefined,
    })
    .where(eq(schema.calls.id, call.id));

  await db
    .update(schema.salesforceSyncJobs)
    .set({ salesforceTaskId: taskId })
    .where(eq(schema.salesforceSyncJobs.callId, call.id));
}

function buildDescription(call: typeof schema.calls.$inferSelect, audit: typeof schema.preCallAudits.$inferSelect | null): string {
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
