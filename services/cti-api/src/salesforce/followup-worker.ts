/**
 * Follow-up rollover worker — drains followup_rollover_jobs single-flight.
 *
 * Per job: find the rep's open Follow-up on the record → pick the first business
 * day under the org's daily cap (live COUNT in Salesforce) → CREATE the copy →
 * stamp created_task_id → COMPLETE the original. Create-before-complete means a
 * create failure leaves the original open (retryable) instead of lost; stamping
 * created_task_id before the PATCH means a crash in between is retried by
 * completing only — never a duplicate task.
 *
 * Single-flight makes the cap EXACT within one process: two rollovers in the same
 * tick can't both read 99. Across processes it is a ceiling we honor, not a lock
 * we hold — Railway runs the old and the new container side by side on every
 * deploy, so two replicas can each read the same count for DIFFERENT jobs and
 * both land on one day. That matches the spec's stance on hand-created tasks (a
 * human can always add one; the cap never blocks them). What we DO guarantee is
 * that no job is ever processed twice: the pending → in_flight claim below is
 * conditional (UPDATE ... WHERE status = 'pending' RETURNING), so exactly one
 * replica wins the row and the loser skips it instead of creating a second task.
 *
 * Mirrors salesforce/sync.ts (attempts, backoff, stuck-job reaper).
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { FollowupRolloverJob } from '../db/schema.js';
import { advanceSession } from '../dialer/engine.js';
import { buildEngineDeps } from '../dialer/live-deps.js';
import { nextBusinessDay } from '../dialer/next-business-day.js';
import { fetchBusinessCalendar } from './business-calendar.js';
import { SalesforceUnauthorizedError, sfFetch, soqlCount, soqlEscape, soqlQuery } from './client.js';
import { FOLLOWUP_DAILY_CAP_DEFAULT, followUpCountSoql, pickRolloverDay } from './followup-day.js';
import { followUpCopyFields, pickFollowUpTask, type FollowUpTask } from './followup.js';

export const MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 30_000;
export const STUCK_AFTER_MS = 2 * 60_000;
/** Ceiling on any single Salesforce call. Without it a hung socket pins the
 *  single-flight tick (and the whole rollover queue behind it) indefinitely. */
export const SF_CALL_TIMEOUT_MS = 30_000;
/** How recently the softphone must have polled a dialer session for the retry
 *  nudge to originate a call for it. See `nudgeDueRetries`. */
export const PRESENCE_WINDOW_MS = 30_000;

export interface WorkerDeps {
  db: ReturnType<typeof getDb>;
  sf: { soqlQuery: typeof soqlQuery; soqlCount: typeof soqlCount; sfFetch: typeof sfFetch };
  calendarFor: (userId: string) => Promise<{ workingWeekdays: ReadonlySet<number>; holidays: ReadonlySet<string> }>;
  capFor: (orgId: string) => Promise<number>;
  now: () => Date;
}

/**
 * True for any error that means the rep must reconnect Salesforce — retrying
 * cannot help. `SalesforceUnauthorizedError` alone is not enough: a REVOKED
 * connection surfaces as a plain Error from the token refresh
 * ("token refresh failed (400): ...invalid_grant..."), and sfFetch RETURNS a 401
 * (which we turn into a `... (401): ...` message) rather than throwing. Without
 * this the job burned all 8 retries (~63 min) and ended with the wrong message.
 */
export function isSalesforceAuthError(err: unknown): boolean {
  if (err instanceof SalesforceUnauthorizedError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /token refresh failed \(4\d\d\)|invalid_grant|INVALID_SESSION_ID|\(401\)/i.test(msg);
}

/** Reject if `p` hasn't settled within `ms`. A timeout is transient (backoff),
 *  never auth — `isSalesforceAuthError` does not match this message. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function patchJob(deps: WorkerDeps, id: string, patch: Partial<FollowupRolloverJob>): Promise<void> {
  await deps.db.update(schema.followupRolloverJobs).set({ ...patch, updatedAt: deps.now() }).where(eq(schema.followupRolloverJobs.id, id));
}

async function findOpenFollowUp(deps: WorkerDeps, job: FollowupRolloverJob): Promise<FollowUpTask | null> {
  const rid = soqlEscape(job.recordId);
  const owner = soqlEscape(job.sfOwnerId);
  const tasks = await withTimeout(
    deps.sf.soqlQuery<FollowUpTask>(
      job.userId,
      'SELECT Id, Subject, Type, Priority, OwnerId, WhoId, WhatId, ActivityDate FROM Task ' +
        `WHERE IsClosed = false AND OwnerId = '${owner}' AND (WhoId = '${rid}' OR WhatId = '${rid}') ` +
        "AND (Subject LIKE '%Follow-up%' OR Subject LIKE '%Followup%' OR Subject LIKE '%Follow up%') " +
        'ORDER BY ActivityDate ASC NULLS LAST LIMIT 50',
    ),
    SF_CALL_TIMEOUT_MS,
    'follow-up query',
  );
  return pickFollowUpTask(tasks);
}

/** Complete the SOURCE task and close the job out. */
async function completeSource(deps: WorkerDeps, job: FollowupRolloverJob, sourceTaskId: string | null): Promise<void> {
  const done = await withTimeout(
    deps.sf.sfFetch(job.userId, `/sobjects/Task/${sourceTaskId}`, { method: 'PATCH', body: { Status: 'Completed' } }),
    SF_CALL_TIMEOUT_MS,
    'complete task',
  );
  if (done.status >= 400) throw new Error(`complete failed (${done.status}): ${JSON.stringify(done.json)}`);
  await patchJob(deps, job.id, { status: 'succeeded', completedTaskId: sourceTaskId, completedAt: deps.now(), lastError: null });
}

function logFailed(job: FollowupRolloverJob, reason: string): void {
  console.error('[followup-worker] job failed', { jobId: job.id, userId: job.userId, recordId: job.recordId, reason });
}

export async function processRolloverJob(job: FollowupRolloverJob, deps: WorkerDeps): Promise<void> {
  try {
    // RETRY PATH: the copy already exists, so all that's left is completing the
    // source. Never re-resolve it — with a null-ActivityDate original the copy
    // (dated) now sorts FIRST, so a fresh lookup would complete the COPY and
    // leave the original open. completed_task_id is stamped at create time and
    // means "the source task we are completing".
    if (job.createdTaskId) {
      await completeSource(deps, job, job.completedTaskId);
      return;
    }

    const task = await findOpenFollowUp(deps, job);
    if (!task) {
      await patchJob(deps, job.id, { status: 'succeeded', lastError: 'no-task', completedAt: deps.now() });
      return;
    }

    const cal = await deps.calendarFor(job.userId);
    const cap = await deps.capFor(job.orgId);
    // The plain next business day (no cap applied) — stamped alongside the
    // actual target so the session-view summary can tell "moved" from
    // "pushed" without ever calling Salesforce itself.
    const nextDay = nextBusinessDay(job.fromDate, cal.workingWeekdays, cal.holidays);
    const targetDate = await pickRolloverDay({
      fromDate: job.fromDate, cap, workingWeekdays: cal.workingWeekdays, holidays: cal.holidays,
      countOn: (d) => withTimeout(deps.sf.soqlCount(job.userId, followUpCountSoql(job.sfOwnerId, d)), SF_CALL_TIMEOUT_MS, 'follow-up count'),
    });
    if (!targetDate) {
      logFailed(job, 'no business day with room within 30 days');
      await patchJob(deps, job.id, { status: 'failed', lastError: 'no business day with room within 30 days', completedAt: deps.now() });
      return;
    }

    const created = await withTimeout(
      deps.sf.sfFetch(job.userId, '/sobjects/Task', { method: 'POST', body: followUpCopyFields(task, targetDate) }),
      SF_CALL_TIMEOUT_MS,
      'create task',
    );
    // The status goes in the message so `isSalesforceAuthError` can see a 401.
    if (created.status >= 400) throw new Error(`create failed (${created.status}): ${JSON.stringify(created.json)}`);
    const createdId = (created.json as { id?: unknown })?.id;
    if (typeof createdId !== 'string' || !createdId) throw new Error(`create returned no id (${created.status})`);
    // Stamp BEFORE completing: a crash from here on is retried by completing only.
    await patchJob(deps, job.id, { createdTaskId: createdId, targetDate, completedTaskId: task.Id, nextDay });

    await completeSource(deps, job, task.Id);
  } catch (err) {
    if (isSalesforceAuthError(err)) {
      logFailed(job, 'reconnect Salesforce');
      await patchJob(deps, job.id, { status: 'failed', lastError: 'reconnect Salesforce', completedAt: deps.now() });
      return;
    }
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    if (job.attempts >= MAX_ATTEMPTS) {
      logFailed(job, msg);
      await patchJob(deps, job.id, { status: 'failed', lastError: msg, completedAt: deps.now() });
      return;
    }
    const delay = BACKOFF_BASE_MS * 2 ** (job.attempts - 1);
    await patchJob(deps, job.id, { status: 'pending', lastError: msg, nextAttemptAt: new Date(deps.now().getTime() + delay) });
  }
}

/**
 * Kick any active session whose earliest retry floor has passed (Task 2/3 leave
 * such sessions 'active' with nothing eligible until now).
 *
 * PRESENCE GATE: this ORIGINATES a real outbound call from a server timer, so it
 * only touches sessions the softphone polled within PRESENCE_WINDOW_MS — the
 * DialerPanel polls GET /dialer/sessions/:id every ~2s while mounted, so a recent
 * poll is the only evidence we have that a rep is actually at the phone. A closed
 * or asleep tab stops nudging instead of dialing a lead into an empty conference.
 * Sessions never polled (last_polled_at IS NULL) are excluded by the comparison —
 * correct, and the safe direction while the route write lands.
 */
export async function nudgeDueRetries(deps: WorkerDeps): Promise<number> {
  const due = await deps.db
    .selectDistinct({ sessionId: schema.dialerQueueItems.sessionId })
    .from(schema.dialerQueueItems)
    .innerJoin(schema.dialerSessions, eq(schema.dialerSessions.id, schema.dialerQueueItems.sessionId))
    .where(and(
      eq(schema.dialerSessions.status, 'active'),
      eq(schema.dialerQueueItems.status, 'pending'),
      lte(schema.dialerQueueItems.retryNotBefore, deps.now()),
      gte(schema.dialerSessions.lastPolledAt, new Date(deps.now().getTime() - PRESENCE_WINDOW_MS)),
    ));
  for (const { sessionId } of due) {
    try { await advanceSession(sessionId, buildEngineDeps()); } catch (err) {
      console.error('[followup-worker] nudge failed', { sessionId, err: (err as Error).message });
    }
  }
  return due.length;
}

function liveDeps(): WorkerDeps {
  const db = getDb();
  return {
    db,
    sf: { soqlQuery, soqlCount, sfFetch },
    calendarFor: fetchBusinessCalendar,
    capFor: async (orgId) => {
      const cfg = await db.query.campaignConfigs.findFirst({
        where: and(eq(schema.campaignConfigs.orgId, orgId), eq(schema.campaignConfigs.key, 'default')),
      });
      return cfg?.followupDailyCap ?? FOLLOWUP_DAILY_CAP_DEFAULT;
    },
    now: () => new Date(),
  };
}

export async function runFollowupTick(deps: WorkerDeps = liveDeps()): Promise<{ processed: number }> {
  const now = deps.now();
  // Reap orphans (a tick that died mid-job).
  await deps.db.update(schema.followupRolloverJobs)
    .set({ status: 'pending', updatedAt: now })
    .where(and(eq(schema.followupRolloverJobs.status, 'in_flight'), lte(schema.followupRolloverJobs.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS))));
  const jobs = await deps.db.query.followupRolloverJobs.findMany({
    where: and(eq(schema.followupRolloverJobs.status, 'pending'), lte(schema.followupRolloverJobs.nextAttemptAt, now)),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
    limit: 25,
  });
  let processed = 0;
  for (const j of jobs) {
    // CONDITIONAL claim: only the replica that flips pending → in_flight owns the
    // job. A blind UPDATE let a deploy overlap create the task twice.
    const rows = await deps.db.update(schema.followupRolloverJobs)
      .set({ status: 'in_flight', attempts: sql`${schema.followupRolloverJobs.attempts} + 1`, updatedAt: now })
      .where(and(eq(schema.followupRolloverJobs.id, j.id), eq(schema.followupRolloverJobs.status, 'pending')))
      .returning({ id: schema.followupRolloverJobs.id });
    if (rows.length === 0) continue; // another replica claimed it
    try {
      await processRolloverJob({ ...j, attempts: j.attempts + 1 }, deps);
    } catch (err) {
      // processRolloverJob handles its own failures; a throw here means the DB
      // write itself failed. Never let it abort the rest of the batch.
      console.error('[followup-worker] job crashed', { jobId: j.id, err: (err as Error).message });
    }
    processed++;
  }
  return { processed };
}

/** Drive from server.ts. Single-flight — a slow tick is never overlapped. */
export function startFollowupLoop(intervalMs = 5000): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runFollowupTick()
      .catch((err) => console.error('[followup-worker] tick error', err))
      .finally(() => { running = false; });
  }, intervalMs);
}

/**
 * The retry nudge on its OWN timer. It used to ride the rollover tick, which put
 * a rep-facing action (dialing the next lead) behind however long Salesforce took
 * to drain the rollover queue. Separate timers keep the nudge on time.
 */
export function startRetryNudgeLoop(intervalMs = 5000): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    nudgeDueRetries(liveDeps())
      .catch((err) => console.error('[followup-worker] nudge tick error', err))
      .finally(() => { running = false; });
  }, intervalMs);
}
