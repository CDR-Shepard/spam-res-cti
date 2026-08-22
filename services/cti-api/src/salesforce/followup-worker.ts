/**
 * Follow-up rollover worker — drains followup_rollover_jobs single-flight.
 *
 * ONE ROLLOVER PER PERSON PER DAY. The job key is (user, record, day), so a Task
 * run holding two follow-ups for the same person enqueues ONE job. Per job:
 * find the TEMPLATE — the exact task the rep dialed when the job carries a
 * `source_task_id` (Task runs), else the rep's earliest open Follow-up on the
 * record → pick the first business day under the org's daily cap (the day's open
 * tasks are fetched live and counted here) → CREATE exactly one copy → stamp
 * created_task_id → COMPLETE the whole CLEAR SET: the template plus every other
 * open same-day follow-up on that person. The rep gets one item tomorrow instead
 * of a pile, and no sibling is left open past its due date.
 *
 * Create-before-complete means a create failure leaves the originals open
 * (retryable) instead of lost; stamping created_task_id before the PATCHes means
 * a crash in between is retried by completing only — never a duplicate task.
 * The clear set itself is stamped (completed_task_ids) BEFORE the create, so the
 * retry knows every task the copy replaced.
 *
 * Single-flight makes the cap EXACT within one process: two rollovers in the same
 * tick can't both read 99. Across processes it is a ceiling we honor, not a lock
 * we hold — Railway runs the old and the new container side by side on every
 * deploy, so two replicas can each read the same count for DIFFERENT jobs and
 * both land on one day. That matches the spec's stance on hand-created tasks (a
 * human can always add one; the cap never blocks them).
 *
 * What we guarantee about double-processing is narrower than "never", and worth
 * stating precisely. The pending → in_flight claim below is conditional
 * (UPDATE ... WHERE status = 'pending' RETURNING), so for a given pass exactly
 * one replica wins the row and the loser skips it. The only other way a second
 * replica can pick the same job up is the reaper, so STUCK_AFTER_MS is set to a
 * job's WORST-CASE wall time — the follow-up query, the business calendar fetch,
 * up to thirty day-counts (one per business day scanned), the create, and the
 * complete, each timing out (≈17.5 minutes total) — and each claim stamps
 * `updated_at` with a clock read taken at that claim — not at the
 * top of the batch, which used to make the 25th job of a tick instantly
 * reap-eligible. An in_flight job is therefore only reaped once it genuinely
 * cannot still be running, and a reaped job that IS re-run is still safe:
 * `created_task_id` is stamped before the complete, so the rerun completes the
 * original instead of creating a second copy.
 *
 * Mirrors salesforce/sync.ts (attempts, backoff, stuck-job reaper).
 */
import { and, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { FollowupRolloverJob } from '../db/schema.js';
import { advanceSession, stopSession } from '../dialer/engine.js';
import { buildEngineDeps } from '../dialer/live-deps.js';
import { nextBusinessDay } from '../dialer/next-business-day.js';
import { inFlightItem } from '../dialer/state.js';
import { fetchBusinessCalendar } from './business-calendar.js';
import { SalesforceUnauthorizedError, sfFetch, soqlEscape, soqlQuery } from './client.js';
import { FOLLOWUP_DAILY_CAP_DEFAULT, MAX_ROLLOVER_BUSINESS_DAYS, followUpTasksSoql, pickRolloverDay } from './followup-day.js';
import { countFollowUps, isFollowUpSubject } from './followup-subject.js';
import { followUpCopyFields, pickFollowUpTask, type FollowUpTask } from './followup.js';
import { fetchOwnership, gatedIds, mayCreateTaskOn, type OwnershipSnapshot } from './ownership.js';

export const MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 30_000;
/** Ceiling on any single Salesforce call. Without it a hung socket pins the
 *  single-flight tick (and the whole rollover queue behind it) indefinitely. */
export const SF_CALL_TIMEOUT_MS = 30_000;
/** The create POST gets a longer ceiling than the reads around it: it is the one
 *  call that MUTATES Salesforce, so abandoning it early risks a retry racing a
 *  create that actually landed. Give it room to finish. */
export const SF_CREATE_TIMEOUT_MS = 60_000;
/** Must exceed a job's worst case: query + calendar + one count per business day scanned + create + complete,
 *  each at its timeout. A job still running past this is reaped and re-claimed by another replica. */
export const STUCK_AFTER_MS = SF_CALL_TIMEOUT_MS * (MAX_ROLLOVER_BUSINESS_DAYS + 3) + SF_CREATE_TIMEOUT_MS;
/** How recently the softphone must have polled a dialer session for the retry
 *  nudge to originate a call for it. The DialerPanel polls every ~2s, so this is
 *  five missed polls — enough slack for one slow response, short enough that a
 *  closed tab stops counting as present almost immediately. The old 30s was
 *  fifteen missed polls, i.e. a tab that had been gone half a minute could still
 *  get a lead dialed into an empty conference. See `nudgeDueRetries`. */
export const PRESENCE_WINDOW_MS = 10_000;
/** An 'active' session with no live dial that hasn't been polled this recently is
 *  an abandoned run. See `expireAbandonedSessions`. */
export const ABANDONED_AFTER_MS = 10 * 60_000;

export interface WorkerDeps {
  db: ReturnType<typeof getDb>;
  sf: { soqlQuery: typeof soqlQuery; sfFetch: typeof sfFetch };
  calendarFor: (userId: string) => Promise<{ workingWeekdays: ReadonlySet<number>; holidays: ReadonlySet<string> }>;
  capFor: (orgId: string) => Promise<number>;
  /** Owner (and Opportunity lead manager) of the record this job rolls — the
   *  ownership gate's only input. Injected so the gate is testable without SOQL. */
  ownership: (userId: string, recordId: string) => Promise<OwnershipSnapshot>;
  now: () => Date;
  /** Advance a dialer run (the retry nudge). Injected so `nudgeDueRetries` is
   *  testable without a live engine — the real one originates a phone call. */
  advance: (sessionId: string) => Promise<unknown>;
  /** Stop a dialer run (the abandoned-run reaper). Injected for the same reason. */
  stop: (sessionId: string) => Promise<unknown>;
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

/**
 * Every OPEN task the rep owns on this job's record. One query answers two
 * questions — which task is the template (`pickFollowUpTask`) and which same-day
 * follow-ups have to be cleared with it (`sameDaySiblings`) — so the record path
 * never pays for two round-trips to learn one thing.
 */
async function listOpenFollowUps(deps: WorkerDeps, job: FollowupRolloverJob): Promise<FollowUpTask[]> {
  const rid = soqlEscape(job.recordId);
  const owner = soqlEscape(job.sfOwnerId);
  const tasks = await withTimeout(
    deps.sf.soqlQuery<FollowUpTask>(
      job.userId,
      'SELECT Id, Subject, Type, Priority, OwnerId, WhoId, WhatId, ActivityDate FROM Task ' +
        `WHERE IsClosed = false AND OwnerId = '${owner}' AND (WhoId = '${rid}' OR WhatId = '${rid}') ` +
        // No subject filter: SOQL LIKE cannot express the shared follow-up rule
        // (it would match "refund" on 'FU' and miss 'F/U'). `pickFollowUpTask`
        // applies that rule in code over whatever comes back — so this LIMIT now
        // spans ALL of the rep's open tasks on the record, not just the
        // follow-ups. 200 leaves room for a busy record whose follow-up would
        // otherwise fall off the end and read as "no-task".
        'ORDER BY ActivityDate ASC NULLS LAST LIMIT 200',
    ),
    SF_CALL_TIMEOUT_MS,
    'follow-up query',
  );
  return tasks;
}

/**
 * Pure — the other tasks this rollover has to clear.
 *
 * SAME-DAY FOLLOW-UPS ONLY. The rule the user set is one rollover per person per
 * day: everything that was due on the missed day moves as a single copy, so
 * every one of those has to be completed or it sits open past its due date with
 * no job left to move it. A FUTURE-dated follow-up is work the rep has not
 * reached yet, and an OVERDUE one belongs to an earlier day's decision — neither
 * is touched. Non-follow-up tasks ('Check in', 'Send quote') are never touched
 * at all, by the same shared subject rule the enqueue used.
 */
export function sameDaySiblings(
  tasks: ReadonlyArray<FollowUpTask>,
  primaryId: string,
  fromDate: string,
): FollowUpTask[] {
  return tasks.filter((t) => t.Id !== primaryId && t.ActivityDate === fromDate && isFollowUpSubject(t.Subject));
}

/**
 * The exact task the rep dialed (Task runs). Re-read rather than trusted: it may
 * have been completed, closed, or reassigned between the miss and this job, and
 * any of those means "nothing to roll" — never fall back to searching the
 * record, which could roll a different follow-up the rep never called.
 */
async function findSourceTask(deps: WorkerDeps, job: FollowupRolloverJob, sourceTaskId: string): Promise<FollowUpTask | null> {
  const rows = await withTimeout(deps.sf.soqlQuery<FollowUpTask>(job.userId,
    'SELECT Id, Subject, Type, Priority, OwnerId, WhoId, WhatId, ActivityDate FROM Task ' +
    `WHERE Id = '${soqlEscape(sourceTaskId)}' AND IsClosed = false AND OwnerId = '${soqlEscape(job.sfOwnerId)}' LIMIT 1`), SF_CALL_TIMEOUT_MS, 'source task');
  return rows[0] ?? null;
}

/**
 * Complete every task the copy replaced, then close the job out. `ids[0]` is the
 * PRIMARY (the template the copy was made from); the rest are its same-day
 * siblings. Sequential on purpose — a handful of PATCHes is not worth the
 * concurrency, and a serial order makes a partial failure readable.
 *
 * Ids are non-null by construction — a null here would PATCH
 * `/sobjects/Task/null`, which Salesforce answers with a 404 the job would then
 * burn all 8 retries on. A genuine 404 on a SIBLING is different: the task was
 * deleted between the stamp and this PATCH, there is nothing left to complete,
 * and failing the job over it would strand a rollover that otherwise finished.
 * Log and skip. The primary keeps the strict rule (a 404 there means the job's
 * own subject vanished, which is worth a retry and a visible failure), and any
 * other >= 400 on any id is still an error — including the 401 the auth branch
 * in `processRolloverJob` depends on seeing.
 *
 * The job is marked succeeded only after the LAST PATCH, so a crash part-way
 * through leaves it retryable with the full clear set still stamped.
 */
async function completeTasks(deps: WorkerDeps, job: FollowupRolloverJob, ids: ReadonlyArray<string>): Promise<void> {
  // The copy already exists by the time we get here (fresh path stamps
  // `createdTaskId` first; the retry path only runs with it set), so a task
  // that vanished since the stamp — primary OR sibling — is skipped, never a
  // failure: failing on the primary would strand every sibling in the set.
  for (const id of ids) {
    const done = await withTimeout(
      deps.sf.sfFetch(job.userId, `/sobjects/Task/${id}`, { method: 'PATCH', body: { Status: 'Completed' } }),
      SF_CALL_TIMEOUT_MS,
      'complete task',
    );
    if (done.status === 404) {
      console.warn('[followup-worker] task already gone; skipping complete', { jobId: job.id, taskId: id });
      continue;
    }
    if (done.status >= 400) throw new Error(`complete failed (${done.status}): ${JSON.stringify(done.json)}`);
  }
  await patchJob(deps, job.id, { status: 'succeeded', completedTaskId: ids[0], completedAt: deps.now(), lastError: null });
}

function logFailed(job: FollowupRolloverJob, reason: string): void {
  console.error('[followup-worker] job failed', { jobId: job.id, userId: job.userId, recordId: job.recordId, reason });
}

export async function processRolloverJob(job: FollowupRolloverJob, deps: WorkerDeps): Promise<void> {
  // Set the moment this attempt's create lands. Together with `job.createdTaskId`
  // it answers "does the copy already exist?", which decides whether an auth
  // error is terminal or retryable — see the catch.
  let createdThisAttempt = false;
  try {
    // RETRY PATH: the copy already exists, so all that's left is completing the
    // clear set. Never re-resolve it — with a null-ActivityDate original the copy
    // (dated) now sorts FIRST, so a fresh lookup would complete the COPY and
    // leave the original open. The ids are stamped at create time and mean "the
    // tasks this copy replaced". `completed_task_ids` is the full set;
    // `completed_task_id` alone is what a row written by the PREVIOUS deploy has,
    // so it is the fallback — never a second source of truth.
    if (job.createdTaskId) {
      // Impossible via this module (the ids are stamped around the same create),
      // but a hand-edited or half-migrated row would otherwise PATCH Task/null.
      // Thrown, not logged, so the catch below treats it as transient.
      const retryIds = job.completedTaskIds ?? (job.completedTaskId ? [job.completedTaskId] : []);
      if (retryIds.length === 0) throw new Error('job has createdTaskId but no completedTaskId');
      await completeTasks(deps, job, retryIds);
      return;
    }

    // The record's open tasks. The record path needs them to pick the template;
    // the by-id path re-uses them for the siblings only (its template is the
    // exact task the rep dialed, whatever a search would have preferred).
    let onRecord = job.sourceTaskId ? null : await listOpenFollowUps(deps, job);
    let task = job.sourceTaskId ? await findSourceTask(deps, job, job.sourceTaskId) : null;
    if (!task) {
      // By-id miss (closed, completed by hand, or reassigned since the dial) or
      // the record path: fall through to the record's open follow-ups. One
      // rollover per person per day still owes this record its same-day
      // clearing and its single copy — closing out as no-task would strand them.
      onRecord ??= await listOpenFollowUps(deps, job);
      task = pickFollowUpTask(onRecord);
    }
    if (!task) {
      await patchJob(deps, job.id, { status: 'succeeded', lastError: 'no-task', completedAt: deps.now() });
      return;
    }

    // OWNERSHIP GATE. Rolling a follow-up writes a Task on someone's record; if
    // the rep neither owns nor manages it, we create nothing and close the job
    // out as 'not-owner'. The SOURCE task is deliberately left OPEN — completing
    // it would erase another rep's follow-up. A lookup failure throws into the
    // catch below (transient → retry), i.e. the gate fails closed.
    //
    // Gate every id the COPY will attach to, not the id the job was enqueued on:
    // `followUpCopyFields` carries BOTH WhoId and WhatId off the source task, so
    // a task on the rep's own lead but attached to another rep's Opportunity
    // would otherwise write activity on that Opportunity. `mayCreateTaskOn`
    // skips ids the rule does not name (custom objects) without a round-trip;
    // when the task attaches to none it names, fall back to the job's record so
    // a Lead/Opp run keeps the gate it has always had.
    const attachIds = gatedIds([task.WhoId, task.WhatId]).length > 0 ? [task.WhoId, task.WhatId] : [job.recordId];
    const mayRoll = await mayCreateTaskOn(attachIds, job.sfOwnerId, (id) =>
      withTimeout(deps.ownership(job.userId, id), SF_CALL_TIMEOUT_MS, 'ownership'));
    if (!mayRoll) {
      await patchJob(deps, job.id, { status: 'succeeded', lastError: 'not-owner', completedAt: deps.now() });
      return;
    }

    // THE CLEAR SET: the template plus every other same-day follow-up on this
    // person. One rollover per person per day means one copy replaces all of
    // them, so all of them get completed. The by-id path pays one extra SOQL for
    // the sibling list — the price of not leaving a swallowed enqueue (the job
    // key is per person, not per task) open past its due date.
    const clearSet = [task.Id, ...sameDaySiblings(
      onRecord ?? await listOpenFollowUps(deps, job), task.Id, job.fromDate,
    ).map((t) => t.Id)];

    // Same reason as every other outbound call here: a hung socket in the
    // calendar fetch would pin the single-flight tick and the queue behind it.
    const cal = await withTimeout(deps.calendarFor(job.userId), SF_CALL_TIMEOUT_MS, 'business calendar');
    const cap = await deps.capFor(job.orgId);
    // The plain next business day (no cap applied) — stamped alongside the
    // actual target so the session-view summary can tell "moved" from
    // "pushed" without ever calling Salesforce itself.
    const nextDay = nextBusinessDay(job.fromDate, cal.workingWeekdays, cal.holidays);
    const targetDate = await pickRolloverDay({
      fromDate: job.fromDate, cap, workingWeekdays: cal.workingWeekdays, holidays: cal.holidays,
      countOn: async (d) => countFollowUps(await withTimeout(deps.sf.soqlQuery<{ Subject?: string | null }>(job.userId, followUpTasksSoql(job.sfOwnerId, d)), SF_CALL_TIMEOUT_MS, 'follow-up count')),
    });
    if (!targetDate) {
      logFailed(job, 'no business day with room within 30 days');
      await patchJob(deps, job.id, { status: 'failed', lastError: 'no business day with room within 30 days', completedAt: deps.now() });
      return;
    }

    // Pre-stamp everything we already know BEFORE the mutating call. The create
    // is the only step whose answer we can lose (a timeout tells us nothing about
    // whether Salesforce made the Task), and the run summary reads `target_date` /
    // `next_day` to say "moved" vs "pushed". Writing them after the POST meant a
    // create timeout left the row blank and the rep's summary silently short.
    // `created_task_id` stays unstamped until we have the real id — it is the flag
    // that says "the copy exists, only complete on retry". The clear set rides
    // along here for the same reason: after the POST the retry must know EVERY
    // task the copy replaced, not just the template.
    await patchJob(deps, job.id, { targetDate, nextDay, completedTaskId: task.Id, completedTaskIds: clearSet });

    const created = await withTimeout(
      deps.sf.sfFetch(job.userId, '/sobjects/Task', { method: 'POST', body: followUpCopyFields(task, targetDate) }),
      SF_CREATE_TIMEOUT_MS,
      'create task',
    );
    // The status goes in the message so `isSalesforceAuthError` can see a 401.
    if (created.status >= 400) throw new Error(`create failed (${created.status}): ${JSON.stringify(created.json)}`);
    const createdId = (created.json as { id?: unknown })?.id;
    if (typeof createdId !== 'string' || !createdId) throw new Error(`create returned no id (${created.status})`);
    // Stamp BEFORE completing: a crash from here on is retried by completing only.
    await patchJob(deps, job.id, { createdTaskId: createdId });
    createdThisAttempt = true;

    await completeTasks(deps, job, clearSet);
  } catch (err) {
    // Auth BEFORE the create is terminal: nothing exists yet and no amount of
    // retrying fixes a disconnected Salesforce, so tell the rep to reconnect.
    // Auth AFTER the create is NOT — the copy is already on tomorrow's list and
    // the original is still open, which is the one state a rep would notice as
    // broken (a duplicate follow-up forever). The rep reconnects on their next
    // Salesforce action anyway, and the backoff window (~63 min over 8 attempts)
    // is enough for that to happen; only then do we give up.
    const copyExists = job.createdTaskId != null || createdThisAttempt;
    const authError = isSalesforceAuthError(err);
    if (authError && !copyExists) {
      logFailed(job, 'reconnect Salesforce');
      await patchJob(deps, job.id, { status: 'failed', lastError: 'reconnect Salesforce', completedAt: deps.now() });
      return;
    }
    const msg = authError
      ? 'reconnect Salesforce (copy exists; will retry completing the original)'
      : (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    if (job.attempts >= MAX_ATTEMPTS) {
      logFailed(job, msg);
      await patchJob(deps, job.id, { status: 'failed', lastError: msg, completedAt: deps.now() });
      return;
    }
    const delay = BACKOFF_BASE_MS * 2 ** (job.attempts - 1);
    await patchJob(deps, job.id, { status: 'pending', lastError: msg, nextAttemptAt: new Date(deps.now().getTime() + delay) });
  }
}

/** One candidate row for the retry nudge: a due pending item joined to its session. */
export interface DueRetryRow {
  sessionId: string;
  status: string;
  lastPolledAt: Date | null;
  retryNotBefore: Date | null;
}

/**
 * Pure — may the nudge ORIGINATE a call for this row right now?
 *
 * The same conditions are in the SQL below as a pre-filter (so the query stays
 * cheap); they are re-checked here because this is the predicate that actually
 * decides to place a phone call, and a predicate that important should be
 * testable without a database.
 */
export function nudgeEligible(row: DueRetryRow, now: Date): boolean {
  if (row.status !== 'active') return false;
  // Never polled: no evidence a rep was ever at the phone for this run.
  if (row.lastPolledAt == null) return false;
  if (now.getTime() - row.lastPolledAt.getTime() > PRESENCE_WINDOW_MS) return false;
  if (row.retryNotBefore != null && row.retryNotBefore.getTime() > now.getTime()) return false;
  return true;
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
 * Sessions never polled (last_polled_at IS NULL) are excluded — correct, and the
 * safe direction. Runs abandoned in that state are cleaned up by
 * `expireAbandonedSessions`, not dialed.
 */
export async function nudgeDueRetries(deps: WorkerDeps): Promise<number> {
  const now = deps.now();
  const due: DueRetryRow[] = await deps.db
    .selectDistinct({
      sessionId: schema.dialerQueueItems.sessionId,
      status: schema.dialerSessions.status,
      lastPolledAt: schema.dialerSessions.lastPolledAt,
      retryNotBefore: schema.dialerQueueItems.retryNotBefore,
    })
    .from(schema.dialerQueueItems)
    .innerJoin(schema.dialerSessions, eq(schema.dialerSessions.id, schema.dialerQueueItems.sessionId))
    .where(and(
      eq(schema.dialerSessions.status, 'active'),
      eq(schema.dialerQueueItems.status, 'pending'),
      lte(schema.dialerQueueItems.retryNotBefore, now),
      gte(schema.dialerSessions.lastPolledAt, new Date(now.getTime() - PRESENCE_WINDOW_MS)),
    ));
  // A session with two due retries yields two rows — nudge it once.
  const ids = [...new Set(due.filter((r) => nudgeEligible(r, now)).map((r) => r.sessionId))];
  for (const sessionId of ids) {
    try { await deps.advance(sessionId); } catch (err) {
      console.error('[followup-worker] nudge failed', { sessionId, err: (err as Error).message });
    }
  }
  return ids.length;
}

/** Pure — is this session an abandoned run? See `expireAbandonedSessions`. */
export function isAbandoned(
  session: { status: string; lastPolledAt: Date | null; updatedAt: Date },
  now: Date,
): boolean {
  if (session.status !== 'active') return false;
  // A run that was never polled falls back to when it was last written — that is
  // its only evidence of life, and it is stamped at creation.
  const lastSeen = session.lastPolledAt ?? session.updatedAt;
  return lastSeen.getTime() < now.getTime() - ABANDONED_AFTER_MS;
}

/**
 * Stop runs the rep walked away from.
 *
 * A run parked in `waiting_retry` has nothing eligible to dial and is only ever
 * moved along by the presence-gated nudge above. So if the rep closes the tab
 * while it waits, presence never comes back, the nudge never fires, and the
 * session stays 'active' forever — which wedges the partial unique index
 * `dialer_sessions_one_active_per_user`: the rep's next list start hits the
 * conflict, `createDialerSession` hands back the STALE session, and they resume
 * dialing yesterday's leftovers instead of the list they just picked.
 *
 * This NEVER originates a call — it only stops sessions. A session with a live
 * dial ('dialing'/'connected') is left alone however stale its poll: the call
 * itself is the presence, and hanging it up would drop a rep mid-conversation.
 */
export async function expireAbandonedSessions(deps: WorkerDeps): Promise<number> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const candidates = await deps.db.query.dialerSessions.findMany({
    where: and(
      eq(schema.dialerSessions.status, 'active'),
      or(
        lt(schema.dialerSessions.lastPolledAt, cutoff),
        and(isNull(schema.dialerSessions.lastPolledAt), lt(schema.dialerSessions.updatedAt, cutoff)),
      ),
    ),
  });
  let expired = 0;
  for (const session of candidates) {
    if (!isAbandoned(session, now)) continue;
    const items = await deps.db.query.dialerQueueItems.findMany({
      where: eq(schema.dialerQueueItems.sessionId, session.id),
    });
    if (inFlightItem(items)) continue; // a live dial IS presence
    try {
      await deps.stop(session.id);
      expired++;
    } catch (err) {
      // One rep's stuck Twilio conference must not block every other rep's slot.
      console.error('[followup-worker] expire abandoned session failed', { sessionId: session.id, err: (err as Error).message });
    }
  }
  return expired;
}

function liveDeps(): WorkerDeps {
  const db = getDb();
  return {
    db,
    sf: { soqlQuery, sfFetch },
    calendarFor: fetchBusinessCalendar,
    capFor: async (orgId) => {
      const cfg = await db.query.campaignConfigs.findFirst({
        where: and(eq(schema.campaignConfigs.orgId, orgId), eq(schema.campaignConfigs.key, 'default')),
      });
      return cfg?.followupDailyCap ?? FOLLOWUP_DAILY_CAP_DEFAULT;
    },
    ownership: fetchOwnership,
    now: () => new Date(),
    advance: (sessionId) => advanceSession(sessionId, buildEngineDeps()),
    stop: (sessionId) => stopSession(sessionId, buildEngineDeps()),
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
    // `deps.now()`, NOT the tick's `now`: the reaper measures staleness from
    // `updated_at`, and a batch of 25 jobs can take minutes to drain. Stamping
    // every claim with the tick's start time made the last job of a batch look
    // minutes-stale the instant it was claimed — instantly reap-eligible on
    // another replica, and therefore processed twice.
    const rows = await deps.db.update(schema.followupRolloverJobs)
      .set({ status: 'in_flight', attempts: sql`${schema.followupRolloverJobs.attempts} + 1`, updatedAt: deps.now() })
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
    const deps = liveDeps();
    // Expire abandoned runs BEFORE nudging: an expired session is no longer
    // 'active', so the nudge in the same tick correctly ignores it (and it never
    // would have nudged it anyway — that is exactly why it was stuck).
    expireAbandonedSessions(deps)
      .then(() => nudgeDueRetries(deps))
      .catch((err) => console.error('[followup-worker] nudge tick error', err))
      .finally(() => { running = false; });
  }, intervalMs);
}
