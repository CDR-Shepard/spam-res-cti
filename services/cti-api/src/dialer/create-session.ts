import { getDb, schema } from '@cti/db';
import type { ConsentBlock } from './consent-check.js';
import { pairKey } from './contact-history.js';
import { rotateAfter, type ListWorker } from './list-position.js';
import { fetchContactNames, resolveDialNumber } from '../salesforce/record-phone.js';
import { fetchTasks, resolveTaskTarget } from '../salesforce/task-targets.js';
import { salesforceUserId } from '../salesforce/current-user.js';

/**
 * What a run dials down: a Lead/Opportunity list of records, or a list of
 * Tasks — a Task run resolves each Task to the PERSON it dials (see
 * `resolveRows`), so a Task session's items are Leads/Contacts/Opportunities
 * carrying their originating task id.
 */
export type DialerRunObject = 'Lead' | 'Opportunity' | 'Task';

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
  /** What the panel headlines from the first ring (migration 0041). A Lead or
   *  Contact's own Name; an Opportunity's primary contact once `withContactNames`
   *  has run, else the Opportunity's own Name. */
  displayName?: string | null;
  /** Opportunity rows only: the primary contact whose name should replace the
   *  Opportunity's, resolved for the whole run in one batched read. */
  contactId?: string | null;
  /** Two reps, one list (spec §4): the record's ORIGINAL index in the
   *  Salesforce list view — not the (possibly rotated) queue ordinal. Set
   *  only on a run created from a list view; undefined otherwise. */
  listPosition?: number | null;
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
  taskId: string | null; followupEligible: boolean; displayName: string | null;
  status: 'pending' | 'unreachable' | 'skipped'; outcome: string | null;
  listPosition: number | null;
}> {
  return resolved.map((r, i) => {
    // A consent-blocked SECOND NUMBER is dropped, right here, at the one place
    // the pair is written. It is still a dialed number, not decoration: the
    // engine's end-of-run retry (`handleDialOutcome` in engine.ts) inserts the
    // attempt-2 row straight from `secondaryNumber` — no path re-reads consent
    // before that dial. So a record whose Mobile is clean but whose Phone is
    // opted out / blocked / DNC-listed would otherwise be power-dialed on that
    // Phone with no check at all. The row itself is NOT skipped — the primary
    // is still lawful to call, and refusing it would punish a record nobody
    // asked us to refuse.
    const fallback = r.fallbackConsentBlock ? null : r.fallbackNumber ?? null;
    return {
      sessionId, ordinal: i, objectType: r.objectType, recordId: r.recordId, toNumber: r.toNumber,
      // Attempt-1 rows never carry a fallback: the immediate Mobile→Phone
      // retry this field once fed was removed — the engine now settles every
      // miss as one attempt and requeues the OTHER number, if any, in a fresh
      // attempt-2 row at the end of the run, reading it from `secondaryNumber`
      // alone. Nothing reads `fallbackNumber` from a live row any more.
      fallbackNumber: null,
      // Immutable copy of the resolved pair: `secondaryNumber` is what the
      // attempt-2 row (built in engine.ts) restores from.
      attempt: 1, primaryNumber: r.toNumber, secondaryNumber: fallback,
      taskId: r.taskId ?? null, followupEligible: r.followupEligible ?? true,
      // Written on EVERY status: a skipped or unreachable row says WHO was
      // passed over, not just which number.
      displayName: r.displayName ?? null,
      // The record's place in the SALESFORCE list, not the (possibly
      // rotated) queue ordinal above — see list-position.ts. Null on a run
      // with no list view.
      listPosition: r.listPosition ?? null,
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
  /** The primary contacts' names for the run's Opportunity rows, ONE batched
   *  read for the whole run (see `withContactNames`). Injected so creation
   *  stays unit testable and a Lead run can be pinned to never call it. */
  fetchContactNames: typeof fetchContactNames;
  salesforceUserId: typeof salesforceUserId;
  /** Which of these numbers has the team already power-dialed in the last
   *  three hours (the courtesy cooldown's own window, `COOLDOWN_MS` in
   *  contact-history.ts). Injected (rather than read inline) so creation
   *  stays unit testable, and so the live wiring can be the fail-open variant. */
  workedRecently: (orgId: string, numbers: readonly string[]) => Promise<Set<string>>;
  /** Which of these numbers the org may NOT call — opt-out list, manual block
   *  list, federal DNC cache. The gate click-to-dial has always had and the
   *  power dialer never did (spam-defense audit §1). Injected on the same
   *  terms as `workedRecently`: unit testable, and live-wired to the fail-open
   *  variant. */
  consentBlocked: (orgId: string, numbers: readonly string[]) => Promise<Map<string, ConsentBlock>>;
  /** One number per pass (2026-09-23 ruling): of a record's Mobile/Phone
   *  pair, the number that has ever CONNECTED for this person becomes the
   *  only number the run dials — see `withPreferredNumbers`. Injected on the
   *  same fail-open terms as the two gates above: a broken read must never
   *  stop the run, it just leaves the rows at the resolved Mobile-then-Phone
   *  order. */
  preferredNumbers: (orgId: string, pairs: ReadonlyArray<readonly [string, string]>) => Promise<Map<string, string>>;
  /** Two reps, one list (spec §4): the furthest position any rep reached
   *  dialing this SAME Salesforce list view in the last 12h (see
   *  `list-position.ts#listStartPosition`), so a second run over it rotates
   *  to start right after that spot instead of re-dialing the top. Injected
   *  RAW, on the same fail-open terms as `preferredNumbers` above: a broken
   *  read is caught right here (`resolveListStartPosition`), not inside the
   *  live wiring — worst case is a run that starts from the top, never a
   *  dead queue. Only called when the run carries a `listViewId`. */
  listStartPosition: (
    orgId: string,
    listViewId: string,
    now: Date,
  ) => Promise<{ position: number; workedBy: ReadonlyArray<ListWorker> } | null>;
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
        displayName: r?.displayName ?? null, contactId: r?.contactId ?? null,
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
      displayName: r?.displayName ?? null, contactId: r?.contactId ?? null,
    });
  }
  return out;
}

/** The batched read, made safe: a name is decoration, so a lookup that fails
 *  (expired token, a SOQL limit, an org quirk) logs and yields nothing — the
 *  rows keep the Opportunity's own Name and the run is still created. */
async function contactNamesOrNone(
  deps: CreateSessionDeps,
  userId: string,
  contactIds: readonly string[],
): Promise<Map<string, string>> {
  try {
    return await deps.fetchContactNames(userId, contactIds);
  } catch (err) {
    console.warn(
      `[create-session] contact-name lookup failed for ${contactIds.length} Opportunity contact(s) — ` +
        `those rows keep the Opportunity Name: ${(err as Error).message}`,
    );
    return new Map();
  }
}

/**
 * Put the PERSON's name on each Opportunity row that has a primary contact, in
 * ONE batched read for the whole run — never a query per record (the id is on
 * the row precisely because `Contact.Name` cannot be traversed from
 * Opportunity in SOQL). Distinct ids: a list often carries the same person on
 * two Opportunities. A run with no Opportunity contacts makes no query at all.
 * A contact the read did not name keeps the Opportunity's own Name.
 */
async function withContactNames(deps: CreateSessionDeps, userId: string, rows: ResolvedRow[]): Promise<ResolvedRow[]> {
  const contactIds = [...new Set(
    rows.filter((r) => r.objectType === 'Opportunity').map((r) => r.contactId).filter((id): id is string => !!id),
  )];
  if (contactIds.length === 0) return rows;
  const names = await contactNamesOrNone(deps, userId, contactIds);
  return rows.map((r) => {
    const name = r.contactId ? names.get(r.contactId) : undefined;
    return name ? { ...r, displayName: name } : r;
  });
}

/**
 * One number per pass (2026-09-23 ruling): a record whose person has ever
 * ANSWERED on one of their two numbers leads with that number, and the run
 * gets no second number for it — the OTHER number is dropped outright, not
 * kept as a fallback, since falling back to a number the person did not
 * answer on defeats the point of remembering which one worked. Only rows with
 * BOTH numbers are asked about (a single-number row has nothing to prefer
 * between); a run with no such pairs makes no query at all.
 *
 * Looked up by `pairKey(toNumber, fallbackNumber)` — the row's OWN pair — not
 * by `toNumber` alone. Two different records can share one number (the same
 * Phone with two different Mobiles, say): keying by the bare number would let
 * a preference computed from ONE record's pair leak onto another record that
 * merely dials the same number, including a record with no fallback at all
 * (never queried, and now provably never matched either). A value the map
 * returns that is neither of THIS row's own two numbers is ignored — the map
 * is built from our own pair-scoped query, so that should never happen, but
 * the row's own two numbers are the only thing the ruling is about.
 *
 * Either way a preference wins, the second number is dropped: once the
 * person has answered on one of their two numbers, the run never dials the
 * other. That holds even when the preference IS the already-primary number
 * — `fallbackNumber` still goes to null, or the engine's end-of-run retry
 * (which reads `secondaryNumber`, carried from `fallbackNumber` in
 * `buildQueueRows`) would still have the dropped number to fall onto.
 *
 * Fails OPEN: a broken read leaves every row exactly as `resolveDialNumber`
 * returned it — worst case is the usual Mobile-then-Phone order, never a dead
 * queue. Applied before the already-worked/consent gates below, so those
 * checks run against the number the run will actually dial first.
 */
async function withPreferredNumbers(deps: CreateSessionDeps, orgId: string, rows: ResolvedRow[]): Promise<ResolvedRow[]> {
  const pairs: ReadonlyArray<readonly [string, string]> = [...new Map(
    rows
      .filter((r): r is ResolvedRow & { toNumber: string; fallbackNumber: string } => !!r.toNumber && !!r.fallbackNumber)
      .map((r): [string, readonly [string, string]] => [pairKey(r.toNumber, r.fallbackNumber), [r.toNumber, r.fallbackNumber]]),
  ).values()];
  if (pairs.length === 0) return rows;
  let preferred: Map<string, string>;
  try {
    preferred = await deps.preferredNumbers(orgId, pairs);
  } catch (err) {
    console.warn(
      `[create-session] preferred-number lookup failed — leaving ${pairs.length} pair(s) at the resolved Mobile/Phone order: ${(err as Error).message}`,
    );
    return rows;
  }
  return rows.map((r) => {
    if (!r.toNumber || !r.fallbackNumber) return r; // nothing to prefer between
    const pref = preferred.get(pairKey(r.toNumber, r.fallbackNumber));
    // Ignore anything that isn't one of THIS row's own two numbers.
    if (pref === undefined || (pref !== r.toNumber && pref !== r.fallbackNumber)) return r;
    // No fallback to carry: the number nobody answered on is simply gone,
    // whether the preference was the primary or the secondary.
    return { ...r, toNumber: pref, fallbackNumber: null };
  });
}

/**
 * The fail-open boundary for the shared-list read (controller decision #5): a
 * thrown read must mean "no rotation, a normal run from the top" — the same
 * posture `withPreferredNumbers` takes on its own lookup, and for the same
 * reason: a broken join must never turn into a dead queue.
 */
async function resolveListStartPosition(
  deps: CreateSessionDeps,
  orgId: string,
  listViewId: string,
): Promise<number | null> {
  try {
    const shared = await deps.listStartPosition(orgId, listViewId, new Date());
    return shared?.position ?? null;
  } catch (err) {
    console.warn(
      `[create-session] list-position lookup failed for list "${listViewId}" — starting from the top: ${(err as Error).message}`,
    );
    return null;
  }
}

export async function createDialerSession(
  deps: CreateSessionDeps,
  args: { userId: string; orgId: string; objectType: DialerRunObject; recordIds: string[]; listViewId?: string },
): Promise<{ sessionId: string; total: number }> {
  const sfOwnerId = await deps.salesforceUserId(args.userId);

  // Two reps, one list (spec §4): rotate the RECORD ORDER before anything is
  // resolved, so every later step (name lookup, number resolution, the
  // consent/already-worked batches) runs on the queue's actual dial order —
  // never the list's original order with positions patched on afterward.
  // `positions[i]` is the ORIGINAL list index of the i-th (now reordered)
  // record id; it becomes that row's `listPosition` below. No list view, or
  // nobody has dialed it in the share window: `rotation` is null and the
  // list's own order is the dial order, exactly as before this feature.
  const startPosition = args.listViewId
    ? await resolveListStartPosition(deps, args.orgId, args.listViewId)
    : null;
  const rotation = args.listViewId ? rotateAfter(args.recordIds, startPosition) : null;
  const orderedRecordIds = rotation ? rotation.ordered : args.recordIds;

  const named = await withContactNames(
    deps, args.userId, await resolveRows(deps, args.userId, args.objectType, orderedRecordIds),
  );
  const withListPositions = rotation
    ? named.map((r, i) => ({ ...r, listPosition: rotation.positions[i] }))
    : named;
  const resolved = await withPreferredNumbers(deps, args.orgId, withListPositions);
  // Created READY: the queue is built and nothing dials. `advanceSession`
  // ignores any session that is not 'active', so a ready session cannot
  // originate by construction; only `startSession` (the rep's Start dialing)
  // flips it. That is also why no unique-index conflict is handled here any
  // more — the one-active-run-per-rep index fires on the flip, not the insert.
  const [session] = await deps.db
    .insert(schema.dialerSessions)
    .values({
      orgId: args.orgId, userId: args.userId, sfOwnerId, objectType: args.objectType, status: 'ready',
      listViewId: args.listViewId ?? null,
    })
    .returning();
  // ONE batched read per gate for the whole run, after the session exists.
  // Distinct: a list often carries the same person on two records, and
  // both verdicts are per NUMBER — duplicates would only bloat the IN (...)
  // binds. The two reads are independent, so they go out together.
  //
  // The two batches differ ON PURPOSE. Already-worked asks "did the team
  // already dial this in the last three hours" (an estimate — the engine's
  // own dial-time gate is authoritative), which is only ever about the number
  // the run dials FIRST, so it stays one bind per primary. Consent asks "may
  // we call this number at all", and the dialer can still dial BOTH halves of
  // the pair over the life of the run — not on attempt 1 any more, but the
  // engine's end-of-run retry inserts its attempt-2 row straight from
  // `secondaryNumber` with no consent re-check — so every second number has
  // to be in this batch or it is dialed unchecked.
  const numbers = [...new Set(resolved.map((r) => r.toNumber).filter((n): n is string => !!n))];
  const consentNumbers = [...new Set(
    resolved.flatMap((r) => [r.toNumber, r.fallbackNumber ?? null]).filter((n): n is string => !!n),
  )];
  const [worked, consent] = await Promise.all([
    deps.workedRecently(args.orgId, numbers),
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
