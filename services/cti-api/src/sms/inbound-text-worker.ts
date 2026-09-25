/**
 * Inbound-text worker — drains inbound_messages single-flight: each text to a
 * rep's number becomes a Salesforce Task on the matched record and an email
 * alert to the rep, both through the REP's own Salesforce connection.
 *
 * Per row, in order, each step guarded by its own stamp so a retry never
 * repeats one that finished:
 *  1. match the sender (`findByPhone`, preferring a Contact's open Opportunity
 *     exactly like an inbound call in salesforce/sync.ts) — an error or no match
 *     is fine: the Task is created unlinked, never lost;
 *  2. create the Task, unless `sf_task_id` is set, and stamp it at once;
 *  3. email the rep via `emailSimple`, unless `emailed_at` is set or the row is
 *     a backfill (backfills get ONE digest instead — see the ops task), and stamp.
 *     FLOOD GUARD: at most one email per rep per sender number per hour; a later
 *     text inside that hour still gets its Task, and `email_skip_reason` says why
 *     it got no email (a decision made once, never revisited on a retry);
 *  4. mark the row done.
 *
 * THE ALERT DOES NOT DEPEND ON THE TASK. The email is how the rep learns a
 * customer texted; a Task that cannot be written must not silence it. When the
 * create fails for good — a permanent error (a validation rule, no access), or
 * any error on the row's last try — the email still goes out, saying the text
 * was not logged, and the row ends `failed` with the Task's error and
 * `emailed_at` set. A retryable Task error on an earlier try emails nothing yet:
 * the retry will probably log it, and the email then links the Task.
 *
 * A Salesforce auth failure is terminal (`failed`, "reconnect Salesforce") and
 * sends nothing: no retry fixes a disconnected rep, and the email is sent AS the
 * rep, so it cannot go either. The stamps make a later manual requeue safe.
 * Anything else backs off 30 s, then 2 min, then fails (MAX_TRIES = 3).
 *
 * ATTEMPTS ARE CAPPED EVERYWHERE, so no row can loop forever. A row stuck in
 * flight on its last try (a crash, a hang past STUCK_AFTER_MS) is FAILED by the
 * capped reaper rather than handed back, and a pending row re-claimed past its
 * last try (a hand-requeued row) is failed without a fresh try. Either way the
 * row is marked failed FIRST and only then is the rep sent the alert it never
 * got (`finalAlert`, best effort): a crash while emailing cannot make it
 * claimable again.
 *
 * Mirrors salesforce/followup-worker.ts: injected deps, a conditional
 * pending → in_flight claim stamped with a fresh clock read, a reaper for rows
 * a dead tick left in flight, and a single-flight loop. Like that worker, a
 * create that lands AFTER our timeout gave up on it can be created again on the
 * retry — the timeouts are generous for exactly that reason.
 *
 * Kill switch: INBOUND_TEXTS=off never starts the loop (`maybeStartInboundTextLoop`).
 * The message body never reaches a log line (see `redactBody`).
 * Design: docs/superpowers/specs/2026-09-25-inbound-texts-design.md.
 */
import { and, asc, eq, gte, isNotNull, lt, lte, notExists, sql } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import type { InboundMessage, InboundMessageStatus, InboundTextDigest } from '@cti/db';
import type { AppConfig } from '../config.js';
import { findByPhone, sfFetch, soqlEscape, soqlQuery } from '../salesforce/client.js';
import { salesforceUserId } from '../salesforce/current-user.js';
import { isInvalidFieldError } from '../salesforce/cti-origin.js';
import { isSalesforceAuthError, withTimeout } from '../salesforce/followup-worker.js';
import { orgTodayIso } from '../dialer/org-day.js';
import {
  isOptOutText,
  redactBody,
  salesforceHomeUrl,
  salesforceRecordUrl,
  taskFailureIsRetryable,
  textDigestEmail,
  textEmail,
  textEmailLinkTarget,
  textTaskDescription,
  textTaskLinks,
  textTaskSubject,
  type DigestEntry,
  type SenderMatch,
} from './inbound-text.js';

type Db = ReturnType<typeof getDb>;

/** Waits before retry 1 and 2. */
export const RETRY_DELAYS_MS = [30_000, 120_000] as const;
/**
 * THREE TRIES IN ALL — one try plus two retries (30 s, then 2 min), per the
 * spec. The last try is the one that sends the "could not be logged" alert when
 * the Task keeps failing, so this bounds how late that alert can be: about 2.5
 * minutes after the text. Longer only delays the rep; a Salesforce outage long
 * enough to outlast it will not be ridden out by another ten minutes either.
 * `attempts` counts tries (the claim bumps it first), so the try whose number is
 * MAX_TRIES is the last, and a row at MAX_TRIES is never tried again.
 */
export const MAX_TRIES = RETRY_DELAYS_MS.length + 1;
/** Loop period (server.ts, via `maybeStartInboundTextLoop`). */
export const LOOP_INTERVAL_MS = 5_000;
/** Flood guard: at most one alert per rep per sender number in this window. A
 *  texter who sends five messages in a minute gets five Tasks and ONE email. */
export const EMAIL_WINDOW_MS = 60 * 60_000;
const FLOOD_SKIP_REASON = 'one alert per sender per hour: this rep was already emailed about this number';
const STUCK_GAVE_UP = 'gave up: stuck in flight on its last try';
/** Ceiling on each Salesforce read. A hung socket must not pin the single-flight tick. */
export const SF_CALL_TIMEOUT_MS = 30_000;
/** The two MUTATING calls (Task create, email) get longer: abandoning one early
 *  risks a retry racing a create or send that actually landed. */
export const SF_CREATE_TIMEOUT_MS = 60_000;
/** A row's worst case — three reads and two writes, each at its timeout — plus a
 *  minute for our own database writes. An in_flight row older than this cannot
 *  still be running, so the reaper hands it back (or, on its last try, fails it). */
export const STUCK_AFTER_MS = SF_CALL_TIMEOUT_MS * 3 + SF_CREATE_TIMEOUT_MS * 2 + 60_000;
export const BATCH_LIMIT = 25;
/**
 * A digest's worst case in `sending`: the ONE mutating call (the emailSimple
 * POST) at its timeout, plus a minute for our own database writes. Unlike
 * `STUCK_AFTER_MS`, this does NOT include the Salesforce reads — I2 moved
 * every read to BEFORE the claim, so a digest only enters `sending` once the
 * email is already built and ready to POST. A digest stuck past this can only
 * still be that one POST, or already dead — either way its outcome is
 * unknown, never a retry (see `reapStuckSendingDigests`).
 */
export const DIGEST_STUCK_AFTER_MS = SF_CREATE_TIMEOUT_MS + 60_000;
/** Salesforce's Task.Description limit. A text is far shorter; this only keeps a
 *  STRING_TOO_LONG error (which quotes the value) impossible. */
const DESCRIPTION_MAX = 32_000;
const RECONNECT = 'reconnect Salesforce';
const LOG = '[inbound-text-worker]';

/** Error codes that mean "Salesforce refused the LINK", so the Task is retried
 *  once without WhoId/WhatId rather than lost. INVALID_FIELD is matched by prefix
 *  (`isInvalidFieldError`); the rest are the record-level refusals a matched
 *  record can earn between the match and the create. */
const LINK_REJECTION_CODES: ReadonlySet<string> = new Set([
  'CANNOT_UPDATE_CONVERTED_LEAD',
  'INVALID_CROSS_REFERENCE_KEY',
  'FIELD_INTEGRITY_EXCEPTION',
  'ENTITY_IS_DELETED',
  // The rep can no longer see the matched record (reassigned, sharing changed).
  // The Task is still theirs to have — just not on a record they cannot reach.
  'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
]);

export interface InboundTextDeps {
  db: Db;
  sf: {
    findByPhone: typeof findByPhone;
    salesforceUserId: typeof salesforceUserId;
    soqlQuery: typeof soqlQuery;
    sfFetch: typeof sfFetch;
  };
  /** The rep's Salesforce instance, for the email's record link; null = leave the link out. */
  instanceUrlFor: (userId: string) => Promise<string | null>;
  /** Flood guard: has this rep been emailed about a text from this number since `since`? */
  alertedRecently: (userId: string, fromE164: string, since: Date) => Promise<boolean>;
  now: () => Date;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
}

async function patchRow(deps: InboundTextDeps, id: string, patch: Partial<InboundMessage>): Promise<void> {
  await deps.db
    .update(schema.inboundMessages)
    .set({ ...patch, updatedAt: deps.now() })
    .where(eq(schema.inboundMessages.id, id));
}

/**
 * Step 1. Never throws: a failed or empty match only costs the Task its link.
 * `preferOpenOpportunity` links a Contact's text to its primary OPEN Opportunity
 * (else its Account), exactly as salesforce/sync.ts links an inbound call — the
 * deal is what the team works, and a text is inbound, so the outbound ownership
 * gate that keeps the preference off outbound calls does not apply. The extra
 * lookup is self-bounded (3 s) and degrades to the Account on any failure.
 */
async function matchSender(deps: InboundTextDeps, row: InboundMessage, userId: string): Promise<SenderMatch | null> {
  try {
    const m = await withTimeout(
      deps.sf.findByPhone(userId, row.fromE164, { preferOpenOpportunity: true }),
      SF_CALL_TIMEOUT_MS,
      'sender match',
    );
    return m && (m.whoId || m.whatId) ? m : null;
  } catch (err) {
    console.warn(`${LOG} sender match failed; the Task will be unlinked`, {
      rowId: row.id,
      messageSid: row.messageSid,
      err: redactBody(errorText(err), row.body),
    });
    return null;
  }
}

function isLinkRejection(json: unknown): boolean {
  if (isInvalidFieldError(json)) return true;
  const entries = Array.isArray(json) ? json : [json];
  return entries.some((e) => {
    const code = (e as { errorCode?: unknown } | null)?.errorCode;
    return typeof code === 'string' && LINK_REJECTION_CODES.has(code);
  });
}

/** A Task create Salesforce answered with an error status. Carries the answer so
 *  the worker can tell a permanent refusal from a retryable one; the status stays
 *  in the message so `isSalesforceAuthError` still recognises a 401. */
class TaskCreateError extends Error {
  constructor(
    readonly status: number,
    readonly json: unknown,
  ) {
    super(`task create failed (${status}): ${JSON.stringify(json)}`);
    this.name = 'TaskCreateError';
  }
}

/** Step 2. Returns the new Task's id; throws a TaskCreateError on an error status. */
async function createTextTask(
  deps: InboundTextDeps,
  row: InboundMessage,
  userId: string,
  ownerId: string,
  match: SenderMatch | null,
): Promise<string> {
  const links = textTaskLinks(match);
  // No Status: the org default ("Open") applies. A hard-coded 'Not Started' hid
  // 203 tasks from reps' list views on 2026-09-23. No CTI_Origin__c either — the
  // picklist has no value for texts, and an unknown value fails the create.
  const fields: Record<string, string> = {
    Subject: textTaskSubject(match?.name ?? null, row.fromE164, isOptOutText(row.body)),
    Description: textTaskDescription(row.body, row.numMedia).slice(0, DESCRIPTION_MAX),
    ActivityDate: orgTodayIso(row.receivedAt),
    OwnerId: ownerId,
    Priority: 'Normal',
    ...links,
  };
  const post = (body: Record<string, string>) => deps.sf.sfFetch(userId, '/sobjects/Task', { method: 'POST', body });
  // One timeout budget for the create AND its one unlinked retry, so a wedged
  // Salesforce cannot pin the tick for twice as long.
  const res = await withTimeout(
    (async () => {
      const first = await post(fields);
      const linked = 'WhoId' in links || 'WhatId' in links;
      if (first.status < 400 || !linked || !isLinkRejection(first.json)) return first;
      console.warn(`${LOG} Salesforce refused the Task's link; creating it without WhoId/WhatId`, {
        rowId: row.id,
        messageSid: row.messageSid,
        whoId: links.WhoId ?? null,
        whatId: links.WhatId ?? null,
        status: first.status,
        err: redactBody(JSON.stringify(first.json), row.body).slice(0, 500),
      });
      const { WhoId: _who, WhatId: _what, ...unlinked } = fields;
      return post(unlinked);
    })(),
    SF_CREATE_TIMEOUT_MS,
    'create task',
  );
  if (res.status >= 400) throw new TaskCreateError(res.status, res.json);
  const id = (res.json as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) throw new Error(`task create returned no id (${res.status})`);
  return id;
}

/**
 * Step 2 plus the decision about what its failure means. A Task that is LOST
 * FOR GOOD — a permanent refusal, or any failure on the row's last try — comes
 * back as `{ error }` instead of throwing, so the caller still sends the alert.
 * Everything else throws: auth is terminal and sends nothing, and a retryable
 * error on an earlier try waits for the retry, which will probably log the Task
 * and then email a link to it. A timeout, a network error or a 2xx with no id
 * is not a TaskCreateError and counts as retryable.
 */
async function createTaskOrGiveUp(
  deps: InboundTextDeps,
  row: InboundMessage,
  userId: string,
  ownerId: string,
  match: SenderMatch | null,
): Promise<{ taskId: string } | { error: unknown }> {
  try {
    return { taskId: await createTextTask(deps, row, userId, ownerId, match) };
  } catch (err) {
    if (isSalesforceAuthError(err)) throw err;
    const retryable = err instanceof TaskCreateError ? taskFailureIsRetryable(err.status, err.json) : true;
    if (retryable && row.attempts < MAX_TRIES) throw err;
    return { error: err };
  }
}

/** The rep's own address — `User.Email` in Salesforce, the spec's source of truth. */
async function repEmail(deps: InboundTextDeps, userId: string, ownerId: string): Promise<string> {
  const rows = await withTimeout(
    deps.sf.soqlQuery<{ Email?: string | null }>(userId, `SELECT Email FROM User WHERE Id = '${soqlEscape(ownerId)}' LIMIT 1`),
    SF_CALL_TIMEOUT_MS,
    'rep email',
  );
  const email = rows[0]?.Email?.trim();
  if (!email) throw new Error('rep has no email address in Salesforce');
  return email;
}

/** Where the email's link goes: the record `textEmailLinkTarget` picks (the open
 *  Opportunity, else the Lead/Contact, else the Task), else the Salesforce home
 *  page when there is neither a match nor a Task. Null when the instance is unknown. */
function emailLink(instanceUrl: string | null, match: SenderMatch | null, taskId: string | null): string | null {
  if (!instanceUrl) return null;
  const target = textEmailLinkTarget(textTaskLinks(match), taskId);
  return target ? salesforceRecordUrl(instanceUrl, target) : salesforceHomeUrl(instanceUrl);
}

/**
 * A DEFINITE Salesforce refusal of an emailSimple POST — a 4xx response, or a
 * 200 whose answer says `isSuccess: false`. Either way, Salesforce looked at
 * the request and said no: it never sent the email, so retrying is safe.
 * `status` is the HTTP status when there was one (a synchronous refusal is
 * always a real response), used only for `isDefiniteEmailRefusal`'s check —
 * `postEmailSimple` never throws this for a 5xx or for a network/timeout
 * error (those propagate UNCHANGED, so `isSalesforceAuthError` still sees a
 * real `SalesforceUnauthorizedError` instance and a timeout's plain message);
 * the digest worker treats anything that ISN'T this as ambiguous (I2).
 */
class EmailSendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/** True for a send Salesforce definitely refused (never sent) — safe to
 *  retry. False for everything else: a timeout, a network error, or a 5xx
 *  (genuinely ambiguous — Salesforce may have sent it anyway). Auth errors
 *  are checked separately, earlier, via `isSalesforceAuthError`. */
function isDefiniteEmailRefusal(err: unknown): boolean {
  return err instanceof EmailSendError;
}

/**
 * `emailSimple` answers an array of per-input results; a 200 can still carry
 * `isSuccess: false`, which means nothing was sent. Shared by the per-text
 * alert (`sendTextEmail`, `what: 'email'` — its exact wording is pinned by
 * existing tests) and the backfill digest (`processPendingDigest`,
 * `what: 'digest email'`). A definite refusal ALSO throws `EmailSendError`
 * (message unchanged) so the digest can tell it apart from an ambiguous
 * failure (I2); the per-text alert ignores that distinction (any failure
 * backs off the same way, see `processInboundText`).
 */
async function postEmailSimple(
  deps: InboundTextDeps,
  userId: string,
  to: string,
  subject: string,
  body: string,
  what: string,
): Promise<void> {
  // No try/catch here on purpose: a network error, a timeout, or a thrown
  // SalesforceUnauthorizedError must propagate UNCHANGED — `isSalesforceAuthError`
  // relies on `instanceof SalesforceUnauthorizedError`, and the digest's
  // "ambiguous" bucket relies on this NOT being an EmailSendError.
  const res = await withTimeout(
    deps.sf.sfFetch(userId, '/actions/standard/emailSimple', {
      method: 'POST',
      body: {
        inputs: [{ emailAddresses: to, emailSubject: subject, emailBody: body, senderType: 'CurrentUser' }],
      },
    }),
    SF_CREATE_TIMEOUT_MS,
    what,
  );
  if (res.status >= 400) {
    const msg = `${what} failed (${res.status}): ${JSON.stringify(res.json)}`;
    // A 4xx is Salesforce answering "no" — definite. A 5xx (or anything this
    // codebase hasn't seen) is treated as ambiguous, same as no response at all.
    if (res.status < 500) throw new EmailSendError(res.status, msg);
    throw new Error(msg);
  }
  const refused = (Array.isArray(res.json) ? res.json : []).find(
    (r) => (r as { isSuccess?: unknown } | null)?.isSuccess === false,
  ) as { errors?: unknown } | undefined;
  if (refused) throw new EmailSendError(res.status, `${what} refused: ${JSON.stringify(refused.errors ?? null)}`);
}

/** Step 3. `taskId` is null when the Task could not be created — the email then
 *  says the text was not logged. */
async function sendTextEmail(
  deps: InboundTextDeps,
  row: InboundMessage,
  userId: string,
  ownerId: string,
  match: SenderMatch | null,
  taskId: string | null,
): Promise<void> {
  const to = await repEmail(deps, userId, ownerId);
  const instanceUrl = await deps.instanceUrlFor(userId);
  const email = textEmail({
    name: match?.name ?? null,
    fromE164: row.fromE164,
    toE164: row.toE164,
    receivedAt: row.receivedAt,
    body: row.body,
    numMedia: row.numMedia,
    recordUrl: emailLink(instanceUrl, match, taskId),
    optOut: isOptOutText(row.body),
    notLogged: taskId === null,
  });
  await postEmailSimple(deps, userId, to, email.subject, email.body, 'email');
}

/**
 * Step 3 behind the flood guard: one email per rep per sender number per
 * EMAIL_WINDOW_MS. A suppressed alert is recorded in `email_skip_reason`, which
 * also makes the decision once-only (a retry of this row never asks again). Two
 * replicas can each pass the check for the same sender at the same moment — two
 * emails, rarely; the guard bounds floods, it is not a lock.
 *
 * A text that could NOT be logged (no Task — `taskId` null) bypasses the guard:
 * that email is the rep's only sign the text exists, and suppressing it would
 * lose the text entirely. Once-only still holds — the caller only gets here
 * while `emailed_at` is unset — and permanent Task failures are rare enough that
 * this cannot become the flood the guard exists to stop.
 */
async function alertRep(
  deps: InboundTextDeps,
  row: InboundMessage,
  userId: string,
  ownerId: string,
  match: SenderMatch | null,
  taskId: string | null,
): Promise<void> {
  const since = new Date(deps.now().getTime() - EMAIL_WINDOW_MS);
  const logged = taskId !== null;
  if (logged && (await deps.alertedRecently(userId, row.fromE164, since))) {
    await patchRow(deps, row.id, { emailSkipReason: FLOOD_SKIP_REASON });
    return;
  }
  await sendTextEmail(deps, row, userId, ownerId, match, taskId);
  await patchRow(deps, row.id, { emailedAt: deps.now() });
}

/** Does this row still owe its rep an individual alert? */
function owesAlert(row: InboundMessage): boolean {
  return !row.emailedAt && !row.emailSkipReason && !row.backfill;
}

function logFailed(row: InboundMessage, reason: string): void {
  console.error(`${LOG} text failed`, { rowId: row.id, messageSid: row.messageSid, userId: row.userId, reason });
}

/**
 * The alert for a row given up on OUTSIDE processInboundText — by the capped
 * reaper, or on a re-claim past its last try. The row is already `failed` when
 * this runs (see the header), so this is best effort: a failure is logged,
 * never retried.
 */
async function finalAlert(row: InboundMessage, deps: InboundTextDeps): Promise<void> {
  const userId = row.userId;
  if (!userId || !owesAlert(row)) return;
  try {
    const match = await matchSender(deps, row, userId);
    const ownerId = await withTimeout(deps.sf.salesforceUserId(userId), SF_CALL_TIMEOUT_MS, 'salesforce user');
    await alertRep(deps, row, userId, ownerId, match, row.sfTaskId);
  } catch (err) {
    const reason = isSalesforceAuthError(err) ? RECONNECT : redactBody(errorText(err), row.body);
    console.error(`${LOG} final alert failed`, { rowId: row.id, messageSid: row.messageSid, userId, reason });
  }
}

/** A pending row re-claimed past its last try: fail it without a fresh try, then alert. */
async function giveUpReclaimed(row: InboundMessage, deps: InboundTextDeps): Promise<void> {
  const reason = `gave up: already tried ${MAX_TRIES} times`;
  const lastError = (row.lastError ? `${reason}; ${row.lastError}` : reason).slice(0, 2000);
  logFailed(row, redactBody(lastError, row.body));
  await patchRow(deps, row.id, { status: 'failed', lastError });
  await finalAlert(row, deps);
}

/**
 * One claimed row. `row.attempts` is this attempt's number (the claim bumped it).
 * Handles its own failures; a throw out of here means a database write failed.
 */
export async function processInboundText(row: InboundMessage, deps: InboundTextDeps): Promise<void> {
  const userId = row.userId;
  if (!userId) {
    // The rep was deleted after the text routed to them (user_id is SET NULL).
    await patchRow(deps, row.id, { status: 'skipped', lastError: 'no rep' });
    return;
  }
  // Set when the Task is lost for good (see createTaskOrGiveUp). The alert still
  // goes out; the row then ends `failed` with this error.
  let taskError: unknown = null;
  try {
    const needTask = !row.sfTaskId;
    const needEmail = owesAlert(row);
    if (needTask || needEmail) {
      const match = await matchSender(deps, row, userId);
      const ownerId = await withTimeout(deps.sf.salesforceUserId(userId), SF_CALL_TIMEOUT_MS, 'salesforce user');
      let taskId = row.sfTaskId;
      if (!taskId) {
        const created = await createTaskOrGiveUp(deps, row, userId, ownerId, match);
        if ('taskId' in created) {
          taskId = created.taskId;
          // Stamped BEFORE the email: a failure from here on retries the email only.
          await patchRow(deps, row.id, { sfTaskId: taskId });
        } else {
          taskError = created.error;
        }
      }
      if (needEmail) await alertRep(deps, row, userId, ownerId, match, taskId);
    }
    if (taskError !== null) {
      const msg = errorText(taskError);
      logFailed(row, redactBody(msg, row.body));
      await patchRow(deps, row.id, { status: 'failed', lastError: msg });
      return;
    }
    await patchRow(deps, row.id, { status: 'done', lastError: null });
  } catch (err) {
    if (isSalesforceAuthError(err)) {
      logFailed(row, RECONNECT);
      await patchRow(deps, row.id, { status: 'failed', lastError: RECONNECT });
      return;
    }
    // A Task given up on AND a failed alert: keep both, the Task's error first.
    const msg = (taskError !== null ? `${errorText(taskError)}; email: ${errorText(err)}` : errorText(err)).slice(0, 2000);
    const delay = RETRY_DELAYS_MS[row.attempts - 1];
    if (delay === undefined) {
      logFailed(row, redactBody(msg, row.body));
      await patchRow(deps, row.id, { status: 'failed', lastError: msg });
      return;
    }
    await patchRow(deps, row.id, {
      status: 'pending',
      lastError: msg,
      nextAttemptAt: new Date(deps.now().getTime() + delay),
    });
  }
}

/** Rows a dead tick left in flight WITH A TRY LEFT go back to pending (their
 *  stamps keep the retry safe). One on its last try is the capped reaper's. */
export function reapStuckInboundTexts(db: Db, now: Date) {
  return db
    .update(schema.inboundMessages)
    .set({ status: 'pending', updatedAt: now })
    .where(
      and(
        eq(schema.inboundMessages.status, 'in_flight'),
        lte(schema.inboundMessages.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS)),
        lt(schema.inboundMessages.attempts, MAX_TRIES),
      ),
    );
}

/**
 * The capped reaper: a row stuck in flight on its LAST try is failed, never
 * handed back — handing it back would re-claim it past the cap, and a row that
 * crashes or hangs its worker every time would loop forever. Its previous error
 * is kept after the reason. Returns the rows so the tick can send each rep the
 * alert it never got; the conditional UPDATE means exactly one replica gets
 * each row back.
 */
export function failExhaustedStuckInboundTexts(db: Db, now: Date) {
  return db
    .update(schema.inboundMessages)
    .set({
      status: 'failed',
      // `::text`: concat_ws takes "any", so Postgres cannot infer the parameter's type.
      lastError: sql`concat_ws('; ', ${STUCK_GAVE_UP}::text, ${schema.inboundMessages.lastError})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.inboundMessages.status, 'in_flight'),
        lte(schema.inboundMessages.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS)),
        gte(schema.inboundMessages.attempts, MAX_TRIES),
      ),
    )
    .returning();
}

/** The flood guard's question, answered by the (user_id, from_e164, emailed_at) index. */
export function selectRecentAlert(db: Db, userId: string, fromE164: string, since: Date) {
  return db
    .select({ id: schema.inboundMessages.id })
    .from(schema.inboundMessages)
    .where(
      and(
        eq(schema.inboundMessages.userId, userId),
        eq(schema.inboundMessages.fromE164, fromE164),
        gte(schema.inboundMessages.emailedAt, since),
      ),
    )
    .limit(1);
}

export function selectDueInboundTexts(db: Db, now: Date) {
  return db
    .select()
    .from(schema.inboundMessages)
    .where(and(eq(schema.inboundMessages.status, 'pending'), lte(schema.inboundMessages.nextAttemptAt, now)))
    .orderBy(asc(schema.inboundMessages.createdAt))
    .limit(BATCH_LIMIT);
}

/**
 * CONDITIONAL claim: only the replica that flips pending → in_flight owns the
 * row (Railway runs old and new containers side by side on every deploy). It
 * returns the row AS CLAIMED, so processing sees the latest stamps and the
 * bumped attempt count, not the scan's copy. It re-checks that the row is DUE:
 * between the scan and this claim another replica may have tried it and set a
 * later `next_attempt_at`, and claiming it anyway would skip the backoff.
 */
export function claimInboundText(db: Db, id: string, at: Date) {
  return db
    .update(schema.inboundMessages)
    .set({ status: 'in_flight', attempts: sql`${schema.inboundMessages.attempts} + 1`, updatedAt: at })
    .where(
      and(
        eq(schema.inboundMessages.id, id),
        eq(schema.inboundMessages.status, 'pending'),
        lte(schema.inboundMessages.nextAttemptAt, at),
      ),
    )
    .returning();
}

// =============================================================================
// The backfill digest — ONE email per finished backfill batch (design task 6;
// state machine per review finding I2).
//
// A backfill row never gets an individual alert (`owesAlert` excludes
// `backfill` rows above), so without this step a backfilled rep would see new
// Tasks appear with no notice at all. Once EVERY row in a `backfill_batch` has
// reached a terminal status (done/failed/skipped — never while one is still
// pending/in_flight), the tick queues that batch's digest as a `pending` row
// in `inbound_text_digests` (`queueReadyDigests`). A SEPARATE step then works
// through due `pending` digests (`processDueDigests`), one small state machine
// per digest:
//
//   pending --(claim)--> sending --(success)--> sent
//      ^                    |
//      |                    +--(definite refusal: 4xx, isSuccess:false)--> pending (backoff) or failed (MAX_TRIES)
//      |                                         `--(ambiguous: timeout/network/5xx)--> unknown (terminal, NEVER retried)
//      +--(a READ failed before the claim)-------------------------------> pending (backoff) or failed (MAX_TRIES)
//      `--(a Salesforce AUTH failure, at any point)-----------------------> failed, immediately ("reconnect Salesforce")
//
// THE READS COME BEFORE THE CLAIM, deliberately the opposite of the row
// worker above: the old design claimed FIRST (an insert that only one caller
// could win) and only then did the Salesforce reads and sent the email. A
// read failing right after that claim landed left the batch permanently
// claimed with no email ever sent — a silent, unrecoverable miss, because
// there is no OTHER guard once the claim exists. Doing every read first (the
// rep's Salesforce user, their email, their instance URL, and the batch's
// Task names) and building the whole email BEFORE claiming means a read
// failure leaves the digest `pending` — genuinely retryable, not lost.
//
// The claim itself (`claimDigestForSending`) is a compare-and-swap exactly
// like a row's claim: pending -> sending, re-checking `next_attempt_at`, so
// a digest still backing off cannot be claimed early and two replicas racing
// the same digest can never both win it.
//
// AMBIGUOUS NEVER RETRIES. Once the claim lands, the ONE thing that follows is
// the emailSimple POST — and unlike a Task create, there is nothing to check
// afterward to learn whether it actually went out. A definite Salesforce
// refusal (4xx, or a 200 saying `isSuccess: false`) proves nothing was sent,
// so THAT case is safe to retry. Anything else — a timeout, a network error, a
// 5xx — is ambiguous: Salesforce may have received and sent the email even
// though we never saw a clean answer, so retrying could double-send. Those go
// straight to `unknown`, terminal, logged loudly for a human to check the
// rep's inbox before ever re-queuing it (see the runbook).
//
// The reaper (`reapStuckSendingDigests`) mirrors this: a digest stuck in
// `sending` past `DIGEST_STUCK_AFTER_MS` is ALSO ambiguous by the same logic
// (we cannot tell whether that in-flight POST landed), so it becomes
// `unknown`, never handed back to `pending` for another try.
// =============================================================================

const TERMINAL_INBOUND_STATUSES: ReadonlySet<InboundMessageStatus> = new Set(['done', 'failed', 'skipped']);
const DIGEST_STUCK_UNKNOWN = 'stuck sending past the reaper window — outcome unknown, never retried';

/** Every backfill row not yet digested, oldest first — `readyDigestBatches`'
 *  candidate pool. NOT EXISTS (a batch's digest row, once inserted, excludes
 *  it here for good — its own state machine owns it from then on) rather than
 *  loading and diffing every digested batch id each tick. */
export function selectUndigestedBackfillRows(db: Db) {
  return db
    .select()
    .from(schema.inboundMessages)
    .where(
      and(
        eq(schema.inboundMessages.backfill, true),
        isNotNull(schema.inboundMessages.backfillBatch),
        notExists(
          db
            .select({ one: sql`1` })
            .from(schema.inboundTextDigests)
            .where(eq(schema.inboundTextDigests.batchId, schema.inboundMessages.backfillBatch)),
        ),
      ),
    )
    .orderBy(asc(schema.inboundMessages.receivedAt));
}

export interface DigestBatch {
  batchId: string;
  userId: string;
  /** Oldest first — the order `selectUndigestedBackfillRows` returns them in. */
  rows: InboundMessage[];
}

/**
 * Groups undigested backfill rows by batch, keeping only a batch whose EVERY
 * row has reached a terminal status — the digest's "wait until the whole
 * batch is done" gate. Pure and DB-free. `rows` must already be grouped
 * sensibly (oldest-first per the SQL above); this never re-sorts them.
 */
export function readyDigestBatches(rows: InboundMessage[]): DigestBatch[] {
  const byBatch = new Map<string, InboundMessage[]>();
  for (const row of rows) {
    if (!row.backfillBatch) continue;
    const list = byBatch.get(row.backfillBatch);
    if (list) list.push(row);
    else byBatch.set(row.backfillBatch, [row]);
  }
  const ready: DigestBatch[] = [];
  for (const [batchId, batchRows] of byBatch) {
    if (batchRows.some((r) => !TERMINAL_INBOUND_STATUSES.has(r.status))) continue;
    const userId = batchRows[0]!.userId;
    if (!userId) continue; // the rep is gone (user_id SET NULL) — nobody to email
    ready.push({ batchId, userId, rows: batchRows });
  }
  return ready;
}

/** Queues one ready batch's digest as `pending`. Bare `onConflictDoNothing()`
 *  — no target — matching the repo convention (`batch_id` is a FULL, non-
 *  partial primary key, so the bare form can never regress into 42P10).
 *  Belt-and-suspenders: `selectUndigestedBackfillRows`'s NOT EXISTS already
 *  keeps an already-queued batch from reaching here twice. */
export function insertPendingDigest(db: Db, batchId: string, userId: string, at: Date) {
  return db
    .insert(schema.inboundTextDigests)
    .values({ batchId, userId, status: 'pending', nextAttemptAt: at })
    .onConflictDoNothing()
    .returning({ batchId: schema.inboundTextDigests.batchId });
}

/** Every `pending` digest whose `next_attempt_at` has passed — the same shape
 *  as `selectDueInboundTexts`. */
export function selectDuePendingDigests(db: Db, now: Date) {
  return db
    .select()
    .from(schema.inboundTextDigests)
    .where(and(eq(schema.inboundTextDigests.status, 'pending'), lte(schema.inboundTextDigests.nextAttemptAt, now)))
    .orderBy(asc(schema.inboundTextDigests.createdAt))
    .limit(BATCH_LIMIT);
}

/**
 * The compare-and-swap claim, run ONLY after every read has already
 * succeeded and the email is already built (see the module doc above). Mirrors
 * `claimInboundText`: only the caller that flips pending -> sending owns the
 * digest, and the `next_attempt_at` re-check means a digest still backing off
 * cannot be claimed early by a second replica scanning at the same moment.
 */
export function claimDigestForSending(db: Db, batchId: string, at: Date) {
  return db
    .update(schema.inboundTextDigests)
    .set({ status: 'sending', updatedAt: at })
    .where(
      and(
        eq(schema.inboundTextDigests.batchId, batchId),
        eq(schema.inboundTextDigests.status, 'pending'),
        lte(schema.inboundTextDigests.nextAttemptAt, at),
      ),
    )
    .returning();
}

/** Rows a dead tick left in `sending` are AMBIGUOUS, never handed back for a
 *  retry — the one call `sending` covers is the emailSimple POST itself, and
 *  a hung tick cannot prove whether it landed. Mirrors `reapStuckInboundTexts`'
 *  shape, not its "hand back with a try left" behavior. */
export function reapStuckSendingDigests(db: Db, now: Date) {
  return db
    .update(schema.inboundTextDigests)
    .set({ status: 'unknown', lastError: DIGEST_STUCK_UNKNOWN, updatedAt: now })
    .where(
      and(
        eq(schema.inboundTextDigests.status, 'sending'),
        lte(schema.inboundTextDigests.updatedAt, new Date(now.getTime() - DIGEST_STUCK_AFTER_MS)),
      ),
    )
    .returning();
}

/** A batch's rows, re-read fresh at send time (never carried across ticks in
 *  memory) — the same rows `readyDigestBatches` saw when the digest was
 *  queued, now used to build the actual email content. */
export function selectBatchRows(db: Db, batchId: string) {
  return db
    .select()
    .from(schema.inboundMessages)
    .where(eq(schema.inboundMessages.backfillBatch, batchId))
    .orderBy(asc(schema.inboundMessages.receivedAt));
}

/** One batched SOQL read for every Task the batch created, so the digest shows
 *  the SAME sender name the Task itself was linked to (not a fresh, possibly
 *  different, phone re-match). A row whose Task creation failed (no sf_task_id)
 *  is simply absent — its digest entry falls back to the formatted number. */
async function taskNamesByTaskId(deps: InboundTextDeps, userId: string, taskIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (taskIds.length === 0) return names;
  const ids = taskIds.map((id) => `'${soqlEscape(id)}'`).join(',');
  const rows = await withTimeout(
    deps.sf.soqlQuery<{ Id: string; Who: { Name?: string } | null }>(userId, `SELECT Id, Who.Name FROM Task WHERE Id IN (${ids})`),
    SF_CALL_TIMEOUT_MS,
    'digest task names',
  );
  for (const r of rows) if (r.Who?.Name) names.set(r.Id, r.Who.Name);
  return names;
}

async function patchDigest(deps: InboundTextDeps, batchId: string, patch: Partial<InboundTextDigest>): Promise<void> {
  await deps.db
    .update(schema.inboundTextDigests)
    .set({ ...patch, updatedAt: deps.now() })
    .where(eq(schema.inboundTextDigests.batchId, batchId));
}

/**
 * The pre-claim failure writes' own compare-and-swap. A READ that fails
 * BEFORE the claim means this worker never held the digest, so its write
 * must prove the digest is still the SAME pending row it read —
 * `status = 'pending' AND attempts = <what this worker saw>` — or touch
 * nothing. Two workers can read the SAME pending digest during a deploy
 * overlap; if worker A goes on to claim, send, and mark it `sent` (or the
 * reaper marks a `sending` row `unknown`) while worker B's read then fails,
 * B's write must not clobber that — an unconditional `patchDigest` here
 * would flip `sent` back to `pending` (a second send) or hide a `sending`
 * row from the reaper. When zero rows match, this simply does nothing.
 *
 * A write issued AFTER a successful claim uses `patchDigest` directly and
 * unconditionally: this worker IS the owner then, and its write is allowed
 * to correct even a premature reaper `unknown` with the true outcome.
 */
export function patchDigestPreClaim(
  db: Db,
  batchId: string,
  attemptsSeen: number,
  patch: Partial<InboundTextDigest>,
  at: Date,
) {
  return db
    .update(schema.inboundTextDigests)
    .set({ ...patch, updatedAt: at })
    .where(
      and(
        eq(schema.inboundTextDigests.batchId, batchId),
        eq(schema.inboundTextDigests.status, 'pending'),
        eq(schema.inboundTextDigests.attempts, attemptsSeen),
      ),
    );
}

function logDigestFailed(digestRow: InboundTextDigest, reason: string): void {
  console.error(`${LOG} digest failed`, { batchId: digestRow.batchId, userId: digestRow.userId, reason });
}

/** Every text body in the batch, so a digest failure log (or its stored
 *  `last_error`) can never quote one back — Salesforce's error payloads echo
 *  the rejected value, and the digest's rejected value IS the concatenation
 *  of every text in the batch. */
function redactAgainstRows(text: string, rows: readonly InboundMessage[]): string {
  return rows.reduce((acc, r) => redactBody(acc, r.body), text);
}

/**
 * A retryable failure — either a read that failed BEFORE the claim, or a
 * DEFINITE Salesforce refusal of the send (after the claim). Both back off
 * the same way rows do: `RETRY_DELAYS_MS[attempts]`, MAX_TRIES total, then
 * terminal `failed`. `digestRow.attempts` is always the PRE-claim value —
 * the claim itself never bumps attempts (see the module doc: unlike a row's
 * claim, this claim happens AFTER the work that can fail is already done),
 * so a pre-claim and a post-claim failure both bump the SAME counter once.
 *
 * `preClaim` selects the write itself: true (a read failure) goes through
 * `patchDigestPreClaim` — this worker never held the claim, so the write is
 * guarded and may land on nothing; false (a definite send refusal, always
 * after a successful claim) uses the unconditional `patchDigest` — this
 * worker IS the owner.
 */
async function retryOrFailDigest(
  deps: InboundTextDeps,
  digestRow: InboundTextDigest,
  err: unknown,
  rows: readonly InboundMessage[],
  preClaim: boolean,
): Promise<'pending' | 'failed'> {
  const nextAttempts = digestRow.attempts + 1;
  const msg = redactAgainstRows(errorText(err), rows).slice(0, 2000);
  const delay = RETRY_DELAYS_MS[nextAttempts - 1];
  const write = (patch: Partial<InboundTextDigest>) =>
    preClaim
      ? patchDigestPreClaim(deps.db, digestRow.batchId, digestRow.attempts, patch, deps.now())
      : patchDigest(deps, digestRow.batchId, patch);
  if (delay === undefined) {
    await write({ status: 'failed', attempts: nextAttempts, lastError: msg });
    logDigestFailed(digestRow, msg);
    return 'failed';
  }
  await write({
    status: 'pending',
    attempts: nextAttempts,
    lastError: msg,
    nextAttemptAt: new Date(deps.now().getTime() + delay),
  });
  return 'pending';
}

/** A Salesforce auth failure, at any point (a read OR the send): terminal at
 *  once, matching the row worker's rule — no retry fixes a disconnected rep,
 *  and the email is sent AS the rep, so it cannot go either. `preClaim`
 *  selects the guarded vs. unconditional write, same as `retryOrFailDigest`. */
async function failDigestAuth(deps: InboundTextDeps, digestRow: InboundTextDigest, preClaim: boolean): Promise<void> {
  if (preClaim) {
    await patchDigestPreClaim(deps.db, digestRow.batchId, digestRow.attempts, { status: 'failed', lastError: RECONNECT }, deps.now());
  } else {
    await patchDigest(deps, digestRow.batchId, { status: 'failed', lastError: RECONNECT });
  }
  logDigestFailed(digestRow, RECONNECT);
}

/** An AMBIGUOUS send outcome (timeout, network error, or a 5xx) — Salesforce
 *  may have sent the email anyway, so this is terminal and NEVER retried
 *  (retrying could double-send). Logged loudly: a human needs to check the
 *  rep's inbox before ever re-queuing this batch (see the runbook). */
async function markDigestUnknown(
  deps: InboundTextDeps,
  digestRow: InboundTextDigest,
  err: unknown,
  rows: readonly InboundMessage[],
): Promise<void> {
  const msg = redactAgainstRows(errorText(err), rows).slice(0, 2000);
  await patchDigest(deps, digestRow.batchId, { status: 'unknown', lastError: msg });
  console.error(`${LOG} digest send outcome unknown — Salesforce may have sent it anyway; NOT retrying`, {
    batchId: digestRow.batchId,
    userId: digestRow.userId,
    reason: msg,
  });
}

/**
 * One pending digest's full attempt: read everything and build the email
 * FIRST, claim SECOND, send THIRD (see the module doc above for why this
 * order is the whole point of I2). Returns the outcome for the tick's count;
 * `'skipped'` means another replica (or a not-yet-due backoff) already owns
 * this digest and nothing here changed.
 */
export async function processPendingDigest(
  deps: InboundTextDeps,
  digestRow: InboundTextDigest,
): Promise<'sent' | 'retried' | 'failed' | 'unknown' | 'skipped'> {
  const { batchId, userId } = digestRow;
  let rows: InboundMessage[] = [];
  let to: string;
  let email: { subject: string; body: string };
  try {
    rows = await selectBatchRows(deps.db, batchId);
    const ownerId = await withTimeout(deps.sf.salesforceUserId(userId), SF_CALL_TIMEOUT_MS, 'salesforce user');
    to = await repEmail(deps, userId, ownerId);
    const instanceUrl = await deps.instanceUrlFor(userId);
    const taskIds = [...new Set(rows.map((r) => r.sfTaskId).filter((id): id is string => id !== null))];
    const names = await taskNamesByTaskId(deps, userId, taskIds);
    const entries: DigestEntry[] = rows.map((r) => ({
      name: (r.sfTaskId && names.get(r.sfTaskId)) ?? null,
      fromE164: r.fromE164,
      receivedAt: r.receivedAt,
      body: r.body,
      numMedia: r.numMedia,
      recordUrl: !instanceUrl ? null : r.sfTaskId ? salesforceRecordUrl(instanceUrl, r.sfTaskId) : salesforceHomeUrl(instanceUrl),
    }));
    email = textDigestEmail(entries);
  } catch (err) {
    if (isSalesforceAuthError(err)) {
      await failDigestAuth(deps, digestRow, true);
      return 'failed';
    }
    const outcome = await retryOrFailDigest(deps, digestRow, err, rows, true);
    return outcome === 'failed' ? 'failed' : 'retried';
  }

  // Every read succeeded and the email is ready — ONLY NOW claim.
  const [claimed] = await claimDigestForSending(deps.db, batchId, deps.now());
  if (!claimed) return 'skipped'; // another replica already owns it, or it is no longer due

  try {
    await postEmailSimple(deps, userId, to, email.subject, email.body, 'digest email');
  } catch (err) {
    if (isSalesforceAuthError(err)) {
      await failDigestAuth(deps, digestRow, false);
      return 'failed';
    }
    if (isDefiniteEmailRefusal(err)) {
      const outcome = await retryOrFailDigest(deps, digestRow, err, rows, false);
      return outcome === 'failed' ? 'failed' : 'retried';
    }
    // Ambiguous — timeout, network error, or a 5xx. Never retried.
    await markDigestUnknown(deps, digestRow, err, rows);
    return 'unknown';
  }
  await patchDigest(deps, batchId, { status: 'sent', sentAt: deps.now() });
  return 'sent';
}

/** One digest's work must never abort the tick. A throw here is a failed DB
 *  write; the reaper deals with whatever state it left. */
async function guardedDigest(digestRow: InboundTextDigest, work: () => Promise<string>): Promise<string | null> {
  try {
    return await work();
  } catch (err) {
    console.error(`${LOG} digest row crashed`, { batchId: digestRow.batchId, userId: digestRow.userId, err: errorText(err) });
    return null;
  }
}

/** Step 1 of the tick's digest work: every batch that just finished (or
 *  finished on an earlier tick but was never queued) gets its digest queued
 *  as `pending`. Queuing is NOT sending — `processDueDigests` does that. */
export async function queueReadyDigests(deps: InboundTextDeps): Promise<void> {
  const rows = await selectUndigestedBackfillRows(deps.db);
  for (const batch of readyDigestBatches(rows)) {
    await insertPendingDigest(deps.db, batch.batchId, batch.userId, deps.now());
  }
}

/** Step 2: every `pending` digest due for a try gets one. */
export async function processDueDigests(deps: InboundTextDeps): Promise<number> {
  const due = await selectDuePendingDigests(deps.db, deps.now());
  let sent = 0;
  for (const digestRow of due) {
    const outcome = await guardedDigest(digestRow, () => processPendingDigest(deps, digestRow));
    if (outcome === 'sent') sent++;
  }
  return sent;
}

function liveDeps(): InboundTextDeps {
  const db = getDb();
  return {
    db,
    sf: { findByPhone, salesforceUserId, soqlQuery, sfFetch },
    instanceUrlFor: async (userId) =>
      (
        await db.query.salesforceConnections.findFirst({
          where: eq(schema.salesforceConnections.userId, userId),
          columns: { instanceUrl: true },
        })
      )?.instanceUrl ?? null,
    alertedRecently: async (userId, fromE164, since) => (await selectRecentAlert(db, userId, fromE164, since)).length > 0,
    now: () => new Date(),
  };
}

/** One row's work must never abort the batch. A throw here is a failed DB write;
 *  the (capped) reaper deals with whatever state it left. */
async function guarded(row: InboundMessage, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`${LOG} row crashed`, { rowId: row.id, messageSid: row.messageSid, err: redactBody(errorText(err), row.body) });
  }
}

export async function runInboundTextTick(
  deps: InboundTextDeps = liveDeps(),
): Promise<{ processed: number; gaveUp: number; digestsSent: number }> {
  await reapStuckInboundTexts(deps.db, deps.now());
  let gaveUp = 0;
  for (const stuck of await failExhaustedStuckInboundTexts(deps.db, deps.now())) {
    logFailed(stuck, STUCK_GAVE_UP);
    await guarded(stuck, () => finalAlert(stuck, deps));
    gaveUp++;
  }
  const due = await selectDueInboundTexts(deps.db, deps.now());
  let processed = 0;
  for (const candidate of due) {
    // `deps.now()` AT EACH CLAIM, never a tick-start clock: the reaper measures
    // staleness from `updated_at`, and a batch can take minutes — a stale stamp
    // would make the last rows of a batch instantly reap-eligible on another
    // replica, which would then run them a second time.
    const [claimed] = await claimInboundText(deps.db, candidate.id, deps.now());
    if (!claimed) continue; // another replica has it, or it is no longer due
    if (claimed.attempts > MAX_TRIES) {
      await guarded(claimed, () => giveUpReclaimed(claimed, deps));
      gaveUp++;
      continue;
    }
    await guarded(claimed, () => processInboundText(claimed, deps));
    processed++;
  }
  // Digests: reap any 'sending' digest a dead tick left ambiguous, queue any
  // batch that just went (or already went) fully terminal above, then give
  // every due 'pending' digest one try.
  await reapStuckSendingDigests(deps.db, deps.now());
  await queueReadyDigests(deps);
  const digestsSent = await processDueDigests(deps);
  return { processed, gaveUp, digestsSent };
}

/** Drive from server.ts (via `maybeStartInboundTextLoop`). Single-flight — a
 *  slow tick is never overlapped. */
export function startInboundTextLoop(intervalMs = LOOP_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runInboundTextTick()
      .catch((err) => console.error(`${LOG} tick error`, { err: errorText(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}

/**
 * The kill switch (config.ts INBOUND_TEXTS). `off` = the loop never starts: no
 * claim, no Task, no email. Returns the timer for server.ts's close(), or null.
 * `start` is a seam for the test; production never passes it.
 */
export function maybeStartInboundTextLoop(
  cfg: Pick<AppConfig, 'INBOUND_TEXTS'>,
  start: (intervalMs: number) => NodeJS.Timeout = startInboundTextLoop,
): NodeJS.Timeout | null {
  return cfg.INBOUND_TEXTS === 'on' ? start(LOOP_INTERVAL_MS) : null;
}
