import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { resolveDialNumber } from '../salesforce/record-phone.js';
import { fetchTasks, resolveTaskTarget } from '../salesforce/task-targets.js';
import { salesforceUserId } from '../salesforce/current-user.js';

/**
 * What a run dials down: a Lead/Opportunity list of records, or a list of
 * Tasks — a Task run resolves each Task to the PERSON it dials (see
 * `resolveRows`), so a Task session's items are Leads/Contacts/Opportunities
 * carrying their originating task id.
 */
export type DialerRunObject = 'Lead' | 'Opportunity' | 'Task';

/** Postgres unique-violation on the one-active-session-per-rep partial index. */
const ACTIVE_SESSION_INDEX = 'dialer_sessions_one_active_per_user';
function isActiveSessionConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === ACTIVE_SESSION_INDEX;
}

/**
 * One resolved dial target. `objectType` is PER ROW, not per session: a Task
 * run mixes Leads, Contacts and Opportunities in one queue (and keeps an
 * unresolvable Task as its own 'Task' row so the panel can show what was
 * skipped).
 */
type ResolvedRow = {
  recordId: string;
  objectType: 'Lead' | 'Contact' | 'Opportunity' | 'Task';
  toNumber: string | null;
  fallbackNumber?: string | null;
  taskId?: string | null;
  followupEligible?: boolean;
  /** The rep checked Skip on Dialer on this record (Lead/Opportunity only). */
  skipOnDialer?: boolean;
};

/** Outcome stamped on a record the rep has checked Skip on Dialer on, so the
 *  panel can show it was deliberately passed over rather than lost. */
const SKIP_ON_DIALER_OUTCOME = 'skip_on_dialer';

export function buildQueueRows(
  sessionId: string,
  resolved: ResolvedRow[],
): Array<{
  sessionId: string; ordinal: number; objectType: string; recordId: string;
  toNumber: string | null; fallbackNumber: string | null;
  attempt: number; primaryNumber: string | null; secondaryNumber: string | null;
  taskId: string | null; followupEligible: boolean;
  status: 'pending' | 'unreachable' | 'skipped'; outcome: string | null;
}> {
  return resolved.map((r, i) => ({
    sessionId, ordinal: i, objectType: r.objectType, recordId: r.recordId, toNumber: r.toNumber,
    fallbackNumber: r.fallbackNumber ?? null,
    // Immutable copy of the resolved pair: the fallback later overwrites
    // toNumber/fallbackNumber, and an attempt-2 row restores from these.
    attempt: 1, primaryNumber: r.toNumber, secondaryNumber: r.fallbackNumber ?? null,
    taskId: r.taskId ?? null, followupEligible: r.followupEligible ?? true,
    // The checkbox wins over "no number": a flagged record reads as deliberately
    // skipped, never as unreachable. Either way the row exists and keeps its
    // numbers — the run reports what it passed over instead of dropping it, and
    // the engine only ever picks up a 'pending' row.
    status: r.skipOnDialer ? 'skipped' : r.toNumber ? 'pending' : 'unreachable',
    outcome: r.skipOnDialer ? SKIP_ON_DIALER_OUTCOME : null,
  }));
}

export interface CreateSessionDeps {
  resolveDialNumber: typeof resolveDialNumber;
  fetchTasks: typeof fetchTasks;
  salesforceUserId: typeof salesforceUserId;
  db: ReturnType<typeof getDb>;
}

/**
 * Turn the rep's selection into dial targets. Lead/Opportunity runs resolve
 * each record's own number. A Task run first fetches the Tasks (one batched
 * SOQL per 200), maps each to the person it dials, and resolves THAT record's
 * number — carrying the task id and its follow-up eligibility onto the row.
 * A Task whose target can't be resolved (no Who, no Opportunity What, or a
 * Task the fetch didn't return) still gets a row so the run reports it as
 * unreachable rather than silently dropping it.
 */
async function resolveRows(
  deps: CreateSessionDeps,
  userId: string,
  objectType: DialerRunObject,
  recordIds: string[],
): Promise<ResolvedRow[]> {
  if (objectType !== 'Task') {
    const out: ResolvedRow[] = [];
    for (const recordId of recordIds) {
      const r = await deps.resolveDialNumber(userId, objectType, recordId);
      out.push({
        recordId, objectType, toNumber: r?.e164 ?? null, fallbackNumber: r?.fallbackE164 ?? null,
        skipOnDialer: r?.skipOnDialer ?? false,
      });
    }
    return out;
  }
  const tasks = await deps.fetchTasks(userId, recordIds);
  const byId = new Map(tasks.map((t) => [t.Id, t]));
  const out: ResolvedRow[] = [];
  for (const taskId of recordIds) {
    const task = byId.get(taskId);
    const target = task ? resolveTaskTarget(task) : null;
    if (!target) {
      out.push({ recordId: taskId, objectType: 'Task', toNumber: null, taskId, followupEligible: true });
      continue;
    }
    const r = await deps.resolveDialNumber(userId, target.objectType, target.recordId);
    out.push({
      recordId: target.recordId, objectType: target.objectType,
      toNumber: r?.e164 ?? null, fallbackNumber: r?.fallbackE164 ?? null,
      taskId, followupEligible: target.followupEligible,
      skipOnDialer: r?.skipOnDialer ?? false,
    });
  }
  return out;
}

export async function createDialerSession(
  deps: CreateSessionDeps,
  args: { userId: string; orgId: string; objectType: DialerRunObject; recordIds: string[] },
): Promise<{ sessionId: string; total: number }> {
  const sfOwnerId = await deps.salesforceUserId(args.userId);
  const resolved = await resolveRows(deps, args.userId, args.objectType, args.recordIds);
  let session: typeof schema.dialerSessions.$inferSelect | undefined;
  try {
    [session] = await deps.db
      .insert(schema.dialerSessions)
      .values({ orgId: args.orgId, userId: args.userId, sfOwnerId, objectType: args.objectType, status: 'active' })
      .returning();
  } catch (err) {
    // The rep already has an active session (unique index). Return it rather
    // than create a second — a second active session would let the engine
    // originate a concurrent call for this rep (double-dial). This makes a
    // double-submitted start idempotent, and lets the rep re-kick a session
    // whose first originate failed (the caller advances whatever it gets back).
    if (isActiveSessionConflict(err)) {
      const existing = await deps.db.query.dialerSessions.findFirst({
        where: and(eq(schema.dialerSessions.userId, args.userId), eq(schema.dialerSessions.status, 'active')),
      });
      if (existing) {
        const items = await deps.db.query.dialerQueueItems.findMany({
          where: eq(schema.dialerQueueItems.sessionId, existing.id),
        });
        return { sessionId: existing.id, total: items.length };
      }
    }
    throw err;
  }
  const rows = buildQueueRows(session!.id, resolved);
  if (rows.length) await deps.db.insert(schema.dialerQueueItems).values(rows);
  return { sessionId: session!.id, total: rows.length };
}

/**
 * Create a session and immediately kick the engine so the first eligible record
 * starts dialing. WITHOUT this initial advance, a freshly-created 'active'
 * session sits with every item 'pending' forever: nothing else originates the
 * first call — `resumeSession` needs status 'paused', `repNext` needs an
 * already-connected item, and the dial-outcome webhooks only fire after a dial
 * that never started. So creation is the one and only place the loop begins.
 *
 * `advance` (the engine kick) and `create` are injected so the wiring is unit
 * testable without the telephony/db singletons `buildEngineDeps` news up. A
 * kick failure propagates: the caller returns an error rather than handing the
 * rep a session that silently never dials.
 */
export async function createAndStartSession(
  deps: CreateSessionDeps & { advance: (sessionId: string) => Promise<unknown> },
  args: { userId: string; orgId: string; objectType: DialerRunObject; recordIds: string[] },
  create: typeof createDialerSession = createDialerSession,
): Promise<{ sessionId: string; total: number }> {
  const result = await create(deps, args);
  await deps.advance(result.sessionId);
  return result;
}
