/**
 * Salesforce sync worker — drains salesforce_sync_jobs.
 * Idempotent: once a job has a salesforce_task_id stored on the call, we
 * mark it succeeded and skip recreation.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { normalize } from '../phone.js';
import { loadConfig } from '../config.js';
import { buildRecordingPublicUrl } from '../telephony/recording-links.js';
import {
  createCallTask,
  findByPhone,
  postChatterFeedItem,
  SalesforceUnauthorizedError,
  soqlEscape,
  soqlQuery,
  updateCallTask,
} from './client.js';
import { salesforceUserId } from './current-user.js';
import { fetchOwnership, gatedIds, mayCreateTaskOn, objectTypeForId } from './ownership.js';
import { AUTO_DISPOSITION, buildCallSubject } from './call-subject.js';

// Re-exported so routes/calls.ts's existing `import { AUTO_DISPOSITION } from
// '../salesforce/sync.js'` keeps working — the value itself now lives in
// call-subject.ts (see the comment there for why).
export { AUTO_DISPOSITION };

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
// Grace period before an unstamped recording link becomes sweep-eligible.
// Keeps sweepUnpushedRecordingLinks from racing the two live push paths
// (the recording-completed webhook and syncOne's create-time push), both of
// which bump `updated_at` when they touch the row.
const RECORDING_LINK_SWEEP_GRACE_MS = 2 * 60_000;

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
      const result = await syncOne(job.callId);
      await db
        .update(schema.salesforceSyncJobs)
        .set({
          status: 'succeeded',
          // Why no Task exists, when that was a decision rather than a failure
          // (today: the ownership gate). GET /calls surfaces it as `syncError`.
          lastError: syncJobLastError(result),
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
  // Runs AFTER the job drain, never before (Fix 3, 2026-08-26 review): the
  // recording-link sweep makes up to 10 sequential Salesforce round-trips, so
  // repair work must never sit in front of live Task creation.
  await runRecordingLinkSweepSafely();
  return { processed };
}

/**
 * Isolation wrapper around `sweepUnpushedRecordingLinks` for `runSyncTick`:
 * the sweep is repair work, not the primary job, so a wholesale throw (e.g.
 * the SELECT itself failing) must never propagate and skip/abort the job
 * drain that already ran this tick. Per-call failures inside the sweep are
 * already isolated (see `sweepUnpushedRecordingLinks`); this only guards
 * against the sweep failing as a whole. Takes the sweep as a parameter so the
 * isolation is unit-testable without a database.
 */
export async function runRecordingLinkSweepSafely(
  sweep: () => Promise<void> = sweepUnpushedRecordingLinks,
): Promise<void> {
  try {
    await sweep();
  } catch (err) {
    console.error('[sf-sync] recording link sweep failed wholesale', {
      err: (err as Error).message,
    });
  }
}

/**
 * Everything `syncOne` reaches outside its own module. Injected so the ownership
 * gate — the one branch that decides a call gets NO Salesforce Task — is
 * testable without a database or a live Salesforce org. `runSyncTick` passes
 * nothing and gets the live modules.
 */
export interface SyncOneDeps {
  db: ReturnType<typeof getDb>;
  salesforceUserId: typeof salesforceUserId;
  fetchOwnership: typeof fetchOwnership;
  findByPhone: typeof findByPhone;
  createCallTask: typeof createCallTask;
  recordName: (userId: string, recordId: string) => Promise<string | null>;
  postChatterFeedItem: typeof postChatterFeedItem;
  updateCallTask: typeof updateCallTask;
}

function liveSyncOneDeps(): SyncOneDeps {
  return {
    db: getDb(),
    salesforceUserId,
    fetchOwnership,
    findByPhone,
    createCallTask,
    recordName: fetchRecordName,
    postChatterFeedItem,
    updateCallTask,
  };
}

/**
 * The OTHER party on a call: who we called (outbound) or who called us
 * (inbound). Exported because the late-disposition correction in
 * routes/calls.ts has to rebuild the same Subject this worker wrote — two
 * copies of this derivation would be two subjects that can disagree.
 * Inbound falls back to the raw `fromNumber` when it isn't normalizable
 * (e.g. 'anonymous').
 */
export function counterpartyE164(call: {
  direction: string;
  fromNumber: string;
  normalizedToNumber: string;
}): string {
  return call.direction === 'inbound'
    ? (normalize(call.fromNumber).value?.e164 ?? call.fromNumber)
    : call.normalizedToNumber;
}

/**
 * Best-effort record name for the call-log subject's "/ Name" suffix. The
 * name is purely cosmetic, so this NEVER throws — any lookup failure (record
 * type we don't recognize, the org missing Deal__c, a transient SF error)
 * resolves to null rather than failing the sync.
 */
export async function fetchRecordName(userId: string, recordId: string): Promise<string | null> {
  const type = objectTypeForId(recordId);
  const sobject = type === 'other' ? (recordId.startsWith('a0') ? 'Deal__c' : null) : type;
  if (!sobject) return null;
  try {
    const rows = await soqlQuery<{ Name?: string | null }>(
      userId,
      `SELECT Name FROM ${sobject} WHERE Id = '${soqlEscape(recordId)}' LIMIT 1`,
    );
    return rows[0]?.Name ?? null;
  } catch {
    return null;
  }
}

/**
 * What a SUCCEEDED sync job records as its reason. A deliberate skip is not a
 * failure — the job is done and there is nothing to retry — but the rep still
 * has to be able to see why their call has no Task (GET /calls surfaces this as
 * `syncError`). A normal sync leaves the column null.
 */
export function syncJobLastError(result: { skipped: 'not-owner' } | void): string | null {
  return result?.skipped ?? null;
}

/**
 * Log one call to Salesforce. Resolves to `{ skipped }` when the call was
 * deliberately NOT written as a Task (the job still succeeds — there is nothing
 * to retry); `void` on a normal sync.
 */
export async function syncOne(
  callId: string,
  deps: SyncOneDeps = liveSyncOneDeps(),
): Promise<{ skipped: 'not-owner' } | void> {
  const db = deps.db;
  const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) });
  if (!call) return;
  if (call.salesforceTaskId) return; // already synced

  const audit = call.preCallAuditId
    ? await db.query.preCallAudits.findFirst({ where: eq(schema.preCallAudits.id, call.preCallAuditId) })
    : null;

  const inbound = call.direction === 'inbound';
  const counterparty = counterpartyE164(call);

  // Resolve a record match if the click-to-dial / inbound lookup didn't already
  // set one. Match against the counterparty number, never our own DID.
  let whoId = call.salesforceWhoId ?? undefined;
  let whatId = call.salesforceWhatId ?? undefined;
  // Name for the subject's "/ Name" suffix, straight off the SOSL match — no
  // extra round-trip when we already have it.
  let matchName: string | null = null;
  if (!whoId && !whatId) {
    const match = await deps.findByPhone(call.userId, counterparty);
    if (match?.whoId) whoId = match.whoId;
    if (match?.whatId) whatId = match.whatId;
    matchName = match?.name ?? null;
  }

  // Ownership gate — OUTBOUND ONLY. Never write a Task on a record the caller
  // doesn't own/manage. The Task attaches to BOTH ids, so BOTH have to pass —
  // gating only the WhoId would let an unowned Opportunity in through the
  // WhatId. `gatedIds` first so a pair of custom objects costs no round-trip at
  // all, not even /users/me. The call stays fully logged in the CTI; the job
  // records why no Task exists.
  //
  // INBOUND CALLS ARE EXEMPT. The owner rule exists to stop reps creating
  // outbound activity on records they do not own; an inbound call is the
  // customer choosing to contact THIS rep, so logging it is a record of what
  // actually happened, not activity the rep manufactured on someone else's
  // record. A callback from another rep's lead still gets its Task.
  if (!inbound && gatedIds([whoId, whatId]).length > 0) {
    const me = await deps.salesforceUserId(call.userId);
    const allowed = await mayCreateTaskOn([whoId, whatId], me, (id) => deps.fetchOwnership(call.userId, id));
    if (!allowed) return { skipped: 'not-owner' as const };
  }

  // Name precedence: the SOSL match's name → else look up the attached record
  // (a whoId/whatId that was already on the call row, so findByPhone never ran)
  // → else no name at all. The lookup is cosmetic, so a throwing dep never
  // fails the sync — it just means the subject renders number-only.
  let recordName = matchName;
  if (!recordName) {
    const targetId = whoId ?? whatId;
    if (targetId) {
      try {
        recordName = await deps.recordName(call.userId, targetId);
      } catch {
        recordName = null;
      }
    }
  }

  const subject = buildCallSubject({
    inbound,
    disposition: call.disposition,
    counterpartyE164: counterparty,
    recordName,
  });

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

  const { taskId, degradedFields } = await deps.createCallTask(call.userId, {
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

  // Chatter feed post (ruling 2026-08-26): every DISPOSITIONED call ALSO gets
  // ONE Chatter feed item on its related record, additive to the Task write
  // above, never a replacement for it. whoId/whatId here are the SAME ids the
  // Task was just attached to, so "related record" means exactly what it
  // means for the Task. No related record → nothing to post to → skip
  // silently (this is normal, not an error).
  //
  // `call.disposition != null` gates this on "dispositioned" precisely: an
  // inbound call (never dispositioned — no wrap-up form) or an
  // ensure-logged outbound call synced before the rep set one must NOT post.
  // A call later swept into AUTO_DISPOSITION and synced then DOES post with
  // that label — by then it IS its disposition, and `call` (loaded at the
  // top of this fn) already reflects that value.
  //
  // Idempotent across sync retries via chatter_feed_element_id: once set,
  // never posted again. This also covers late-disposition corrections — the
  // routes/calls.ts correction path patches the existing Task's
  // Subject/Description directly and never calls back into syncOne — so a
  // corrected call still shows only the FIRST disposition's feed item.
  // First disposition wins; no edits or deletes here.
  //
  // Failure posture: Chatter is additive, the Task is the system of record,
  // so a failed post must never fail the Task sync. The SF POST and the
  // id-persist DB write are guarded SEPARATELY (not one try/catch) so a POST
  // failure and a persist failure log distinct messages: a post that
  // actually succeeded but never got its id saved needs its own diagnosis —
  // otherwise a future retry sweep can't tell it apart from "never posted"
  // and would double-post blind.
  if (!call.chatterFeedElementId && call.disposition != null) {
    const chatterSubjectId = whoId ?? whatId;
    if (chatterSubjectId) {
      let feedElementId: string | null = null;
      try {
        feedElementId = await deps.postChatterFeedItem(
          call.userId,
          chatterSubjectId,
          buildChatterText(subject, call.notes),
        );
      } catch (err) {
        console.error('[sf-sync] chatter post failed', {
          callId: call.id,
          err: (err as Error).message,
        });
      }
      if (feedElementId) {
        try {
          await db
            .update(schema.calls)
            .set({ chatterFeedElementId: feedElementId, updatedAt: new Date() })
            .where(eq(schema.calls.id, call.id));
        } catch (err) {
          console.error('[sf-sync] chatter posted but id persist failed', {
            callId: call.id,
            feedElementId,
            err: (err as Error).message,
          });
        }
      }
    }
  }

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
    // Stamped ONLY on a successful PATCH (2026-08-26 incident: this push was
    // fire-and-forget with nothing recording whether it actually landed). A
    // failed PATCH leaves recordingLinkSyncedAt null, and
    // sweepUnpushedRecordingLinks retries it from the sync tick. The PATCH and
    // the stamp write are guarded SEPARATELY (not one try/catch), same as the
    // Chatter post/persist split above — a PATCH that succeeded but whose
    // stamp failed to persist must log distinctly from a PATCH that actually
    // failed, or a future retry can't tell "never landed" from "landed, just
    // not marked" and would PATCH again blind (harmless, but confusing logs).
    let patched = false;
    try {
      const { updated } = await deps.updateCallTask(call.userId, taskId, { tdc_cti__Recording_URL__c: recUrl });
      // INVALID_FIELD (Fix 1, 2026-08-26 review): a configuration fact, not a
      // transient failure — retrying can't fix a field missing from the org
      // or hidden from this rep by field-level security. Still stamped below
      // (leaving it unstamped would clog the sweep forever), but logged
      // distinctly so a false "success" doesn't hide silently in the stamp.
      if (!updated) {
        console.error('[sf-sync] recording link field rejected (INVALID_FIELD)', { callId: call.id, taskId });
      }
      patched = true;
    } catch (err) {
      console.error('[sf-sync] recording attach failed', {
        callId: call.id,
        err: (err as Error).message,
      });
    }
    if (patched) {
      try {
        await db
          .update(schema.calls)
          .set({ recordingLinkSyncedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.calls.id, call.id));
      } catch (err) {
        console.error('[sf-sync] recording attached but sync-stamp persist failed', {
          callId: call.id,
          err: (err as Error).message,
        });
      }
    }
  }
}

/** Everything `pushRecordingLinkToTask` reaches outside its own module, injected
 *  the same way as `SyncOneDeps` so its stamp-on-success contract is testable
 *  without a database or a live Salesforce org. Real callers pass nothing. */
export interface PushRecordingLinkDeps {
  db: ReturnType<typeof getDb>;
  updateCallTask: typeof updateCallTask;
}

function livePushRecordingLinkDeps(): PushRecordingLinkDeps {
  return { db: getDb(), updateCallTask };
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
  deps: PushRecordingLinkDeps = livePushRecordingLinkDeps(),
): Promise<'patched' | 'pending' | 'skipped'> {
  const db = deps.db;
  const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) });
  if (!call) return 'skipped';
  const url = recordingPublicUrl(call);
  if (!url) return 'skipped';
  if (!call.salesforceTaskId) return 'pending';
  // A PATCH failure propagates uncaught — the caller (the recording-completed
  // webhook, or sweepUnpushedRecordingLinks below) is the one that logs it and
  // decides whether/when to retry. recordingLinkSyncedAt is stamped ONLY once
  // the PATCH above has actually succeeded (2026-08-26 incident: this push used
  // to be fire-and-forget with nothing recording whether it landed).
  const { updated } = await deps.updateCallTask(call.userId, call.salesforceTaskId, { tdc_cti__Recording_URL__c: url });
  // INVALID_FIELD (Fix 1, 2026-08-26 review): same handling as syncOne's
  // create-time push above — still stamped below, but logged distinctly so a
  // configuration-rejected PATCH doesn't look identical to a real success.
  if (!updated) {
    console.error('[sf-sync] recording link field rejected (INVALID_FIELD)', {
      callId,
      taskId: call.salesforceTaskId,
    });
  }
  try {
    await db
      .update(schema.calls)
      .set({ recordingLinkSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.calls.id, callId));
  } catch (err) {
    // Same split as the PATCH/stamp write in syncOne: the PATCH already
    // succeeded, so this must log distinctly rather than look like a failed
    // attach — a future sweep just retries the (harmless, idempotent) PATCH.
    console.error('[sf-sync] recording attached but sync-stamp persist failed', {
      callId,
      err: (err as Error).message,
    });
  }
  return 'patched';
}

/**
 * Retry sweep for the recording-link PATCH (2026-08-26 incident: 29/128
 * recorded calls' Tasks lost their link because both push paths — this
 * sweep's `push` and syncOne's create-time push — are fire-and-forget). Picks
 * up to 10 calls that have a recording AND a Task but are still unstamped and
 * past the 2-minute grace (keeps this from racing the two live push paths,
 * which both bump `updated_at` when they touch the row), and retries each
 * through `pushRecordingLinkToTask`, which stamps `recordingLinkSyncedAt` on
 * success. No `created_at` filter, so this also naturally repairs every
 * historical miss (recordingLinkSyncedAt is null on every pre-existing row) —
 * no separate backfill script needed.
 *
 * Per-call failures are isolated: one throw must not stop the rest of this
 * sweep, and must not kill the tick it runs in. A call whose push keeps
 * failing simply stays unstamped and is picked up again on the next tick.
 */
export async function sweepUnpushedRecordingLinks(
  db: ReturnType<typeof getDb> = getDb(),
  push: (callId: string) => Promise<'patched' | 'pending' | 'skipped'> = pushRecordingLinkToTask,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - RECORDING_LINK_SWEEP_GRACE_MS);
  const rows = await db
    .select({ id: schema.calls.id })
    .from(schema.calls)
    .where(
      and(
        isNotNull(schema.calls.recordingUrl),
        isNotNull(schema.calls.salesforceTaskId),
        isNull(schema.calls.recordingLinkSyncedAt),
        lt(schema.calls.updatedAt, cutoff),
      ),
    )
    // Freshest misses first (Fix 2, 2026-08-26 review): without this, a
    // stable set of rows that fail every retry (e.g. a legitimate
    // INVALID_FIELD miss — see Fix 1) can fill all 10 slots every tick and
    // starve a fresh miss from ever being picked up.
    .orderBy(desc(schema.calls.updatedAt))
    .limit(10);
  for (const row of rows) {
    try {
      const result = await push(row.id);
      // 'pending'/'skipped' (Fix 2, 2026-08-26 review): the row changed
      // between this select and push's re-read (e.g. the Task hadn't been
      // created yet after all). Not an error, but today these cycle forever
      // silently — warn with a distinct code so a permanently-non-patching
      // row is visible.
      if (result === 'pending' || result === 'skipped') {
        console.warn('[sf-sync] recording link sweep non-patched', { callId: row.id, result });
      }
    } catch (err) {
      console.error('[sf-sync] recording link sweep failed', {
        callId: row.id,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Text for the Chatter feed item syncOne posts alongside the Task (ruling
 * 2026-08-26): the SAME subject line the Task gets — so the feed item and the
 * Task always agree on the disposition and the record — plus the rep's notes
 * as a second paragraph when present. No notes → the subject line alone.
 */
export function buildChatterText(subject: string, notes: string | null | undefined): string {
  const trimmedNotes = notes?.trim();
  return trimmedNotes ? `${subject}\n\n${trimmedNotes}` : subject;
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
