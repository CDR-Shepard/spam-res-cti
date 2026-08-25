import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { ConsentBlock } from './consent-check.js';
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
  /** The TEAM already power-dialed this number today (cross-shift dedupe). */
  alreadyWorked?: boolean;
  /** This number is on the org's opt-out / block list, or the federal DNC
   *  cache — the same three lists click-to-dial refuses on. */
  consentBlock?: ConsentBlock | null;
  /** The SAME three lists, checked against the fallback (the record's Phone).
   *  Separate from `consentBlock` because the two verdicts have different
   *  consequences: a blocked primary skips the row, a blocked fallback only
   *  drops the fallback — the primary is still lawful to call. */
  fallbackConsentBlock?: ConsentBlock | null;
};

/** Outcome stamped on a record the rep has checked Skip on Dialer on, so the
 *  panel can show it was deliberately passed over rather than lost. */
const SKIP_ON_DIALER_OUTCOME = 'skip_on_dialer';

/** Outcome stamped on a number the team already power-dialed today, so the
 *  panel can show the run inherited an earlier shift's work. */
const ALREADY_WORKED_OUTCOME = 'already_worked';

/** Outcome per consent list, so the row states WHICH list refused the number
 *  rather than a generic "skipped" — a rep asking "why didn't it dial?" is
 *  asking a compliance question and deserves the compliance answer. */
const CONSENT_OUTCOME: Record<ConsentBlock, string> = {
  opted_out: 'opted_out',
  blocked: 'blocked',
  dnc: 'dnc_blocked',
};

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
  return resolved.map((r, i) => {
    // A consent-blocked FALLBACK is dropped, right here, at the one place the
    // pair is written. The fallback is a dialed number, not decoration:
    // `engine.ts:345` swaps `toNumber := fallbackNumber` on a true no-answer and
    // re-dials it inside the same session, and `:428` copies `secondaryNumber`
    // onto the attempt-2 row — neither path re-reads consent. So a record whose
    // Mobile is clean but whose Phone is opted out / blocked / DNC-listed would
    // otherwise be power-dialed on that Phone with no check at all. Both halves
    // go, because `secondaryNumber` is exactly how the attempt-2 row would
    // resurrect it. The row itself is NOT skipped — the primary is still lawful
    // to call, and refusing it would punish a record nobody asked us to refuse.
    const fallback = r.fallbackConsentBlock ? null : r.fallbackNumber ?? null;
    return {
      sessionId, ordinal: i, objectType: r.objectType, recordId: r.recordId, toNumber: r.toNumber,
      fallbackNumber: fallback,
      // Immutable copy of the resolved pair: the fallback later overwrites
      // toNumber/fallbackNumber, and an attempt-2 row restores from these.
      attempt: 1, primaryNumber: r.toNumber, secondaryNumber: fallback,
      taskId: r.taskId ?? null, followupEligible: r.followupEligible ?? true,
      // PRECEDENCE: consent > skip_on_dialer > already_worked > unreachable.
      // A consent block (opt-out / block list / federal DNC) is the strongest
      // signal there is — it is why the call is unlawful, not merely unwanted —
      // so it outranks the rep's own checkbox, which in turn outranks "the team
      // got there first", which in turn outranks "no number" (a flagged record
      // reads as deliberately skipped, never as unreachable). Either way the row
      // exists and keeps its numbers — the run reports what it passed over
      // instead of dropping it, and the engine only ever picks a 'pending' row.
      status: r.consentBlock || r.skipOnDialer || r.alreadyWorked ? 'skipped' : r.toNumber ? 'pending' : 'unreachable',
      outcome: r.consentBlock
        ? CONSENT_OUTCOME[r.consentBlock]
        : r.skipOnDialer ? SKIP_ON_DIALER_OUTCOME : r.alreadyWorked ? ALREADY_WORKED_OUTCOME : null,
    };
  });
}

export interface CreateSessionDeps {
  resolveDialNumber: typeof resolveDialNumber;
  fetchTasks: typeof fetchTasks;
  salesforceUserId: typeof salesforceUserId;
  /** Which of these numbers has the team already power-dialed today. Injected
   *  (rather than read inline) so creation stays unit testable, and so the
   *  live wiring can be the fail-open variant. */
  workedToday: (orgId: string, numbers: readonly string[]) => Promise<Set<string>>;
  /** Which of these numbers the org may NOT call — opt-out list, manual block
   *  list, federal DNC cache. The gate click-to-dial has always had and the
   *  power dialer never did (spam-defense audit §1). Injected on the same
   *  terms as `workedToday`: unit testable, and live-wired to the fail-open
   *  variant. */
  consentBlocked: (orgId: string, numbers: readonly string[]) => Promise<Map<string, ConsentBlock>>;
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
  // ONE batched read per gate for the whole run, after the session exists (a
  // conflicting create returns the rep's existing session above and never gets
  // here). Distinct: a list often carries the same person on two records, and
  // both verdicts are per NUMBER — duplicates would only bloat the IN (...)
  // binds. The two reads are independent, so they go out together.
  //
  // The two batches differ ON PURPOSE. Already-worked asks "did the team
  // already dial this today", which is only ever about the number the run
  // dials FIRST, so it stays one bind per primary. Consent asks "may we call
  // this number at all", and the dialer calls BOTH halves of the pair — the
  // fallback is swapped in on a true no-answer and carried onto the attempt-2
  // row — so every fallback has to be in that batch or it is dialed unchecked.
  const numbers = [...new Set(resolved.map((r) => r.toNumber).filter((n): n is string => !!n))];
  const consentNumbers = [...new Set(
    resolved.flatMap((r) => [r.toNumber, r.fallbackNumber ?? null]).filter((n): n is string => !!n),
  )];
  const [worked, consent] = await Promise.all([
    deps.workedToday(args.orgId, numbers),
    deps.consentBlocked(args.orgId, consentNumbers),
  ]);
  const rows = buildQueueRows(session!.id, resolved.map((r) => ({
    ...r,
    alreadyWorked: !!r.toNumber && worked.has(r.toNumber),
    // A row with no number can be neither: both gates are keyed by number.
    consentBlock: r.toNumber ? consent.get(r.toNumber) ?? null : null,
    fallbackConsentBlock: r.fallbackNumber ? consent.get(r.fallbackNumber) ?? null : null,
  })));
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
