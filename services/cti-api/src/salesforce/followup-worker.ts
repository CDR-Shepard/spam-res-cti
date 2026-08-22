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
 * Single-flight is what makes the cap correct: two rollovers can't both read 99.
 * Mirrors salesforce/sync.ts (attempts, backoff, stuck-job reaper).
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { FollowupRolloverJob } from '../db/schema.js';
import { advanceSession } from '../dialer/engine.js';
import { buildEngineDeps } from '../dialer/live-deps.js';
import { fetchBusinessCalendar } from './business-calendar.js';
import { SalesforceUnauthorizedError, sfFetch, soqlCount, soqlEscape, soqlQuery } from './client.js';
import { FOLLOWUP_DAILY_CAP_DEFAULT, followUpCountSoql, pickRolloverDay } from './followup-day.js';
import { followUpCopyFields, pickFollowUpTask, type FollowUpTask } from './followup.js';

export { enqueueFollowupRollover, type RolloverDb } from './followup-enqueue.js';

export const MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 30_000;
export const STUCK_AFTER_MS = 2 * 60_000;

export interface WorkerDeps {
  db: ReturnType<typeof getDb>;
  sf: { soqlQuery: typeof soqlQuery; soqlCount: typeof soqlCount; sfFetch: typeof sfFetch };
  calendarFor: (userId: string) => Promise<{ workingWeekdays: ReadonlySet<number>; holidays: ReadonlySet<string> }>;
  capFor: (orgId: string) => Promise<number>;
  now: () => Date;
}

async function patchJob(deps: WorkerDeps, id: string, patch: Partial<FollowupRolloverJob>): Promise<void> {
  await deps.db.update(schema.followupRolloverJobs).set({ ...patch, updatedAt: deps.now() }).where(eq(schema.followupRolloverJobs.id, id));
}

async function findOpenFollowUp(deps: WorkerDeps, job: FollowupRolloverJob): Promise<FollowUpTask | null> {
  const rid = soqlEscape(job.recordId);
  const owner = soqlEscape(job.sfOwnerId);
  const tasks = await deps.sf.soqlQuery<FollowUpTask>(
    job.userId,
    'SELECT Id, Subject, Type, Priority, OwnerId, WhoId, WhatId, ActivityDate FROM Task ' +
      `WHERE IsClosed = false AND OwnerId = '${owner}' AND (WhoId = '${rid}' OR WhatId = '${rid}') ` +
      "AND (Subject LIKE '%Follow-up%' OR Subject LIKE '%Followup%' OR Subject LIKE '%Follow up%') " +
      'ORDER BY ActivityDate ASC NULLS LAST LIMIT 50',
  );
  return pickFollowUpTask(tasks);
}

export async function processRolloverJob(job: FollowupRolloverJob, deps: WorkerDeps): Promise<void> {
  try {
    const task = await findOpenFollowUp(deps, job);
    if (!task) {
      await patchJob(deps, job.id, { status: 'succeeded', lastError: 'no-task', completedAt: deps.now() });
      return;
    }

    let createdId = job.createdTaskId;
    let targetDate = job.targetDate;
    if (!createdId) {
      const cal = await deps.calendarFor(job.userId);
      const cap = await deps.capFor(job.orgId);
      targetDate = await pickRolloverDay({
        fromDate: job.fromDate, cap, workingWeekdays: cal.workingWeekdays, holidays: cal.holidays,
        countOn: (d) => deps.sf.soqlCount(job.userId, followUpCountSoql(job.sfOwnerId, d)),
      });
      if (!targetDate) {
        await patchJob(deps, job.id, { status: 'failed', lastError: 'no business day with room within 30 days', completedAt: deps.now() });
        return;
      }
      const created = await deps.sf.sfFetch(job.userId, '/sobjects/Task', { method: 'POST', body: followUpCopyFields(task, targetDate) });
      if (created.status >= 400) throw new Error(`create failed: ${JSON.stringify(created.json)}`);
      createdId = (created.json as { id: string }).id;
      // Stamp BEFORE completing: a crash from here on is retried by completing only.
      await patchJob(deps, job.id, { createdTaskId: createdId, targetDate });
    }

    const done = await deps.sf.sfFetch(job.userId, `/sobjects/Task/${task.Id}`, { method: 'PATCH', body: { Status: 'Completed' } });
    if (done.status >= 400) throw new Error(`complete failed: ${JSON.stringify(done.json)}`);
    await patchJob(deps, job.id, { status: 'succeeded', completedTaskId: task.Id, completedAt: deps.now(), lastError: null });
  } catch (err) {
    if (err instanceof SalesforceUnauthorizedError) {
      await patchJob(deps, job.id, { status: 'failed', lastError: 'reconnect Salesforce', completedAt: deps.now() });
      return;
    }
    const msg = (err as Error).message;
    if (job.attempts >= MAX_ATTEMPTS) {
      await patchJob(deps, job.id, { status: 'failed', lastError: msg, completedAt: deps.now() });
      return;
    }
    const delay = BACKOFF_BASE_MS * 2 ** (job.attempts - 1);
    await patchJob(deps, job.id, { status: 'pending', lastError: msg, nextAttemptAt: new Date(deps.now().getTime() + delay) });
  }
}

/** Kick any active session whose earliest retry floor has passed (Task 2/3 leave
 *  such sessions 'active' with nothing eligible until now). */
export async function nudgeDueRetries(deps: WorkerDeps): Promise<number> {
  const due = await deps.db
    .selectDistinct({ sessionId: schema.dialerQueueItems.sessionId })
    .from(schema.dialerQueueItems)
    .innerJoin(schema.dialerSessions, eq(schema.dialerSessions.id, schema.dialerQueueItems.sessionId))
    .where(and(
      eq(schema.dialerSessions.status, 'active'),
      eq(schema.dialerQueueItems.status, 'pending'),
      lte(schema.dialerQueueItems.retryNotBefore, deps.now()),
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

export async function runFollowupTick(): Promise<{ processed: number; nudged: number }> {
  const deps = liveDeps();
  const now = deps.now();
  // Reap orphans (a tick that died mid-job).
  await deps.db.update(schema.followupRolloverJobs)
    .set({ status: 'pending', updatedAt: now })
    .where(and(eq(schema.followupRolloverJobs.status, 'in_flight'), lte(schema.followupRolloverJobs.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS))));
  const nudged = await nudgeDueRetries(deps);
  const jobs = await deps.db.query.followupRolloverJobs.findMany({
    where: and(eq(schema.followupRolloverJobs.status, 'pending'), lte(schema.followupRolloverJobs.nextAttemptAt, now)),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
    limit: 25,
  });
  let processed = 0;
  for (const j of jobs) {
    await patchJob(deps, j.id, { status: 'in_flight', attempts: sql`${schema.followupRolloverJobs.attempts} + 1` as unknown as number });
    await processRolloverJob({ ...j, attempts: j.attempts + 1 }, deps);
    processed++;
  }
  return { processed, nudged };
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
