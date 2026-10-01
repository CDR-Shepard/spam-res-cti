/**
 * Dialer-connect worker — every power-dial call that was bridged to a rep
 * (dialer_connects, written by dialer/connect-log.ts) becomes ONE completed
 * Call Task on the screen-popped record, as the rep, and then gets its public
 * recording link.
 *
 * TASK PHASE: rows whose call ended — or that were bridged 4 h ago and whose
 * hang-up was never heard — and that were bridged inside the last 24 h. The
 * click-to-dial ownership rule first (no Task on a record the rep does not
 * own), then createCallTask, then `created`.
 * LINK PHASE (Task 9): rows with a Task and a recording but no synced link.
 *
 * THE CLAIM IS THE LEASE. Claiming bumps the attempt counter and pushes
 * next_attempt_at out by that try's backoff (5 min at least, longer than a
 * row's worst case), so there is no in_flight state and no reaper: a crashed
 * try simply comes due again. Like the other Salesforce workers, a create that
 * landed after our timeout gave up on it can be made again by the retry.
 *
 * NO BACKFILL: pending rows bridged more than 24 h ago are expired, because
 * createCallTask dates the Task today — an old call must not read as today's.
 *
 * Kill switch: DIALER_CONNECT_TASKS=off never starts the loop.
 * Design: docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md.
 */
import { and, asc, eq, gte, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { getDb, schema, type DialerConnect } from '@cti/db';
import { createCallTask, updateCallTask } from './client.js';
import { fetchOwnership, mayCreateTaskOn } from './ownership.js';
import { fetchRecordName } from './sync.js';
import { isSalesforceAuthError, withTimeout } from './followup-worker.js';
import { buildRecordingPublicUrl, type RecordingLinkConfig } from '../telephony/recording-links.js';
import type { AppConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { MAX_TRIES, buildConnectTaskInput, leaseFor, taskLinks } from './dialer-connect-task.js';

type Db = ReturnType<typeof getDb>;
const c = schema.dialerConnects;

export const LOOP_INTERVAL_MS = 5_000;
export const BATCH_LIMIT = 25;
/** No Task for a call bridged longer ago than this — the Task would be dated today. */
export const TASK_WINDOW_MS = 24 * 60 * 60_000;
/** A bridged call with no hang-up stamp by now is logged anyway, without a duration. */
export const MISSED_END_AFTER_MS = 4 * 60 * 60_000;
/** A disconnected rep: retry hourly, uncounted — the 24 h window bounds it. */
export const AUTH_RETRY_MS = 60 * 60_000;
export const SF_CALL_TIMEOUT_MS = 30_000;
export const SF_CREATE_TIMEOUT_MS = 60_000;
const RECONNECT = 'reconnect Salesforce';
export const LOG = '[dialer-connect-worker]';

export interface DialerConnectDeps {
  db: Db;
  now: () => Date;
  link: RecordingLinkConfig;
  sf: {
    createCallTask: typeof createCallTask;
    updateCallTask: typeof updateCallTask;
    fetchOwnership: typeof fetchOwnership;
    fetchRecordName: typeof fetchRecordName;
  };
}

export function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export function patchConnect(db: Db, id: string, patch: Partial<typeof c.$inferInsert>, now: Date) {
  return db.update(c).set({ ...patch, updatedAt: now }).where(eq(c.id, id));
}

export function expireStaleConnects(db: Db, now: Date) {
  return db
    .update(c)
    .set({ taskState: 'expired', updatedAt: now })
    .where(and(eq(c.taskState, 'pending'), lt(c.bridgedAt, new Date(now.getTime() - TASK_WINDOW_MS))))
    .returning({ id: c.id });
}

export function selectDueConnectTasks(db: Db, now: Date) {
  return db
    .select()
    .from(c)
    .where(
      and(
        eq(c.taskState, 'pending'),
        lte(c.nextAttemptAt, now),
        gte(c.bridgedAt, new Date(now.getTime() - TASK_WINDOW_MS)),
        or(isNotNull(c.endedAt), lte(c.bridgedAt, new Date(now.getTime() - MISSED_END_AFTER_MS))),
      ),
    )
    .orderBy(asc(c.bridgedAt))
    .limit(BATCH_LIMIT);
}

export function claimConnectTask(db: Db, row: Pick<DialerConnect, 'id' | 'taskAttempts'>, now: Date) {
  const attempt = row.taskAttempts + 1;
  return db
    .update(c)
    .set({ taskAttempts: attempt, nextAttemptAt: new Date(now.getTime() + leaseFor(attempt)), updatedAt: now })
    .where(
      and(
        eq(c.id, row.id),
        eq(c.taskState, 'pending'),
        eq(c.taskAttempts, row.taskAttempts),
        lte(c.nextAttemptAt, now),
      ),
    )
    .returning();
}

async function taskTryFailed(row: DialerConnect, err: unknown, deps: DialerConnectDeps): Promise<'retry' | 'failed'> {
  const now = deps.now();
  const message = errorText(err);
  if (isSalesforceAuthError(err)) {
    await patchConnect(deps.db, row.id, {
      taskAttempts: row.taskAttempts - 1,
      nextAttemptAt: new Date(now.getTime() + AUTH_RETRY_MS),
      lastError: RECONNECT,
    }, now);
    return 'retry';
  }
  if (row.taskAttempts >= MAX_TRIES) {
    await patchConnect(deps.db, row.id, { taskState: 'failed', lastError: message }, now);
    console.error(`${LOG} gave up — no Task for this power-dial call`, { connectId: row.id, userId: row.userId, err: message });
    return 'failed';
  }
  // next_attempt_at already holds this try's backoff — the claim set it.
  await patchConnect(deps.db, row.id, { lastError: message }, now);
  console.warn(`${LOG} Task try failed, will retry`, { connectId: row.id, attempt: row.taskAttempts, err: message });
  return 'retry';
}

/** One claimed row → its Task. `row.taskAttempts` already counts this try. */
export async function processConnectTask(
  row: DialerConnect,
  deps: DialerConnectDeps,
): Promise<'created' | 'skipped_not_owner' | 'failed' | 'retry'> {
  const links = taskLinks(row.objectType, row.recordId);
  if (!links) {
    await patchConnect(deps.db, row.id, { taskState: 'failed', lastError: `no Task link for a ${row.objectType}` }, deps.now());
    console.error(`${LOG} no Task link for this record type`, { connectId: row.id, objectType: row.objectType });
    return 'failed';
  }
  try {
    const allowed = await mayCreateTaskOn([links.whoId, links.whatId], row.sfUserId, (id) =>
      withTimeout(deps.sf.fetchOwnership(row.userId, id), SF_CALL_TIMEOUT_MS, 'ownership lookup'),
    );
    if (!allowed) {
      await patchConnect(deps.db, row.id, { taskState: 'skipped_not_owner', lastError: null }, deps.now());
      return 'skipped_not_owner';
    }
    // Cosmetic: fetchRecordName already swallows its own errors; a timeout is null too.
    const recordName = await withTimeout(deps.sf.fetchRecordName(row.userId, row.recordId), SF_CALL_TIMEOUT_MS, 'record name')
      .catch(() => null);
    const { taskId } = await withTimeout(
      deps.sf.createCallTask(row.userId, buildConnectTaskInput(row, links, recordName)),
      SF_CREATE_TIMEOUT_MS,
      'task create',
    );
    // Due now: the link phase attaches the recording on the next tick if it is in.
    await patchConnect(deps.db, row.id, { taskState: 'created', salesforceTaskId: taskId, lastError: null, nextAttemptAt: deps.now() }, deps.now());
    return 'created';
  } catch (err) {
    return taskTryFailed(row, err, deps);
  }
}

/** The writable recording field click-to-dial Tasks carry (salesforce/sync.ts). */
export const RECORDING_URL_FIELD = 'tdc_cti__Recording_URL__c';

export function selectDueLinks(db: Db, now: Date) {
  return db
    .select()
    .from(c)
    .where(
      and(
        eq(c.taskState, 'created'),
        isNotNull(c.salesforceTaskId),
        isNotNull(c.recordingUrl),
        isNull(c.recordingLinkSyncedAt),
        lt(c.linkAttempts, MAX_TRIES),
        lte(c.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(c.bridgedAt))
    .limit(BATCH_LIMIT);
}

export function claimLink(db: Db, row: Pick<DialerConnect, 'id' | 'linkAttempts'>, now: Date) {
  const attempt = row.linkAttempts + 1;
  return db
    .update(c)
    .set({ linkAttempts: attempt, nextAttemptAt: new Date(now.getTime() + leaseFor(attempt)), updatedAt: now })
    .where(
      and(
        eq(c.id, row.id),
        isNull(c.recordingLinkSyncedAt),
        eq(c.linkAttempts, row.linkAttempts),
        lte(c.nextAttemptAt, now),
      ),
    )
    .returning();
}

/**
 * One claimed row → its recording link on its Task, as the rep. The PUBLIC
 * playback URL (GET /recordings/:id?sig=), never the Twilio media URL. A field
 * Salesforce rejects (the rep has no tdc_cti package license — see the
 * recording-links memory) is stamped synced with a loud log, exactly like the
 * click-to-dial sweep: no retry can fix a license.
 */
export async function pushConnectLink(row: DialerConnect, deps: DialerConnectDeps): Promise<'synced' | 'rejected' | 'retry' | 'failed'> {
  const url = buildRecordingPublicUrl(row.id, deps.link);
  try {
    const { updated } = await withTimeout(
      deps.sf.updateCallTask(row.userId, row.salesforceTaskId!, { [RECORDING_URL_FIELD]: url }),
      SF_CALL_TIMEOUT_MS,
      'recording link',
    );
    await patchConnect(deps.db, row.id, {
      recordingLinkSyncedAt: deps.now(),
      lastError: updated ? null : 'recording link field rejected',
    }, deps.now());
    if (!updated) {
      console.error(`${LOG} recording link field rejected — check the rep's tdc_cti package license`, { connectId: row.id, userId: row.userId });
      return 'rejected';
    }
    return 'synced';
  } catch (err) {
    const message = errorText(err);
    await patchConnect(deps.db, row.id, { lastError: message }, deps.now());
    if (row.linkAttempts >= MAX_TRIES) {
      console.error(`${LOG} gave up — recording link not on the Task`, { connectId: row.id, userId: row.userId, err: message });
      return 'failed';
    }
    console.warn(`${LOG} recording link try failed, will retry`, { connectId: row.id, attempt: row.linkAttempts, err: message });
    return 'retry';
  }
}

async function guarded(connectId: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`${LOG} row failed`, { connectId, err: errorText(err) });
  }
}

function liveDeps(): DialerConnectDeps {
  const cfg = loadConfig();
  return {
    db: getDb(),
    now: () => new Date(),
    link: { apiPublicUrl: cfg.API_PUBLIC_URL, secret: cfg.SESSION_SECRET },
    sf: { createCallTask, updateCallTask, fetchOwnership, fetchRecordName },
  };
}

export async function runDialerConnectTick(
  deps: DialerConnectDeps = liveDeps(),
): Promise<{ expired: number; tasks: number; links: number }> {
  const expired = await expireStaleConnects(deps.db, deps.now());
  if (expired.length > 0) {
    console.warn(`${LOG} power-dial calls expired without a Task (bridged over 24 h ago)`, { count: expired.length });
  }
  let tasks = 0;
  for (const candidate of await selectDueConnectTasks(deps.db, deps.now())) {
    // `deps.now()` AT EACH CLAIM: the lease is measured from the claim itself.
    const [claimed] = await claimConnectTask(deps.db, candidate, deps.now());
    if (!claimed) continue; // another worker has it, or it is no longer due
    if (claimed.taskAttempts > MAX_TRIES) {
      // Its last try crashed mid-way; never a 7th.
      await patchConnect(deps.db, claimed.id, { taskState: 'failed', lastError: `gave up after ${MAX_TRIES} tries` }, deps.now());
      console.error(`${LOG} gave up — no Task for this power-dial call`, { connectId: claimed.id, userId: claimed.userId, err: 'tries exhausted' });
      continue;
    }
    await guarded(claimed.id, () => processConnectTask(claimed, deps));
    tasks++;
  }
  let links = 0;
  for (const candidate of await selectDueLinks(deps.db, deps.now())) {
    const [claimed] = await claimLink(deps.db, candidate, deps.now());
    if (!claimed) continue;
    await guarded(claimed.id, () => pushConnectLink(claimed, deps));
    links++;
  }
  return { expired: expired.length, tasks, links };
}

/** Single-flight: a slow tick is never overlapped. */
export function startDialerConnectLoop(intervalMs = LOOP_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runDialerConnectTick()
      .catch((err) => console.error(`${LOG} tick error`, { err: errorText(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}

/** The kill switch (config.ts DIALER_CONNECT_TASKS). `start` is a test seam. */
export function maybeStartDialerConnectLoop(
  cfg: Pick<AppConfig, 'DIALER_CONNECT_TASKS'>,
  start: (intervalMs: number) => NodeJS.Timeout = startDialerConnectLoop,
): NodeJS.Timeout | null {
  return cfg.DIALER_CONNECT_TASKS === 'on' ? start(LOOP_INTERVAL_MS) : null;
}
