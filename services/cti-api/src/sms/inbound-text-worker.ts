/**
 * Inbound-text worker — drains inbound_messages single-flight: each text to a
 * rep's number becomes a Salesforce Task on the matched record and an email
 * alert to the rep, both through the REP's own Salesforce connection.
 *
 * Per row, in order, each step guarded by its own stamp so a retry never
 * repeats one that finished:
 *  1. match the sender (`findByPhone`) — an error or no match is fine: the Task
 *     is created unlinked, never lost;
 *  2. create the Task, unless `sf_task_id` is set, and stamp it at once;
 *  3. email the rep via `emailSimple`, unless `emailed_at` is set or the row is
 *     a backfill (backfills get ONE digest instead — see the ops task), and stamp;
 *  4. mark the row done.
 * A Salesforce auth failure is terminal (`failed`, "reconnect Salesforce"): no
 * retry fixes a disconnected rep, and the stamps make a later manual requeue
 * safe. Anything else backs off 30 s, 2 min, 10 min, then fails.
 *
 * Mirrors salesforce/followup-worker.ts: injected deps, a conditional
 * pending → in_flight claim stamped with a fresh clock read, a reaper for rows
 * a dead tick left in flight, and a single-flight loop. Like that worker, a
 * create that lands AFTER our timeout gave up on it can be created again on the
 * retry — the timeouts are generous for exactly that reason.
 *
 * The message body never reaches a log line (see `redactBody`).
 * Design: docs/superpowers/specs/2026-09-25-inbound-texts-design.md.
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import type { InboundMessage } from '@cti/db';
import { findByPhone, sfFetch, soqlEscape, soqlQuery } from '../salesforce/client.js';
import { salesforceUserId } from '../salesforce/current-user.js';
import { isInvalidFieldError } from '../salesforce/cti-origin.js';
import { isSalesforceAuthError, withTimeout } from '../salesforce/followup-worker.js';
import { orgTodayIso } from '../dialer/org-day.js';
import {
  isOptOutText,
  salesforceRecordUrl,
  textEmail,
  textTaskDescription,
  textTaskLinks,
  textTaskSubject,
  type SenderMatch,
} from './inbound-text.js';

type Db = ReturnType<typeof getDb>;

/** Waits before retry 1, 2 and 3. A fourth failure is final. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
/** Ceiling on each Salesforce read. A hung socket must not pin the single-flight tick. */
export const SF_CALL_TIMEOUT_MS = 30_000;
/** The two MUTATING calls (Task create, email) get longer: abandoning one early
 *  risks a retry racing a create or send that actually landed. */
export const SF_CREATE_TIMEOUT_MS = 60_000;
/** A row's worst case — three reads and two writes, each at its timeout — plus a
 *  minute for our own database writes. An in_flight row older than this cannot
 *  still be running, so the reaper hands it back. */
export const STUCK_AFTER_MS = SF_CALL_TIMEOUT_MS * 3 + SF_CREATE_TIMEOUT_MS * 2 + 60_000;
export const BATCH_LIMIT = 25;
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
  now: () => Date;
}

/** Replaces the message body wherever it appears. Salesforce can quote a value
 *  back in an error, and error text goes to the log. */
function redactBody(text: string, body: string): string {
  return body.trim().length >= 4 ? text.split(body).join('[message]') : text;
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

/** Step 1. Never throws: a failed or empty match only costs the Task its link. */
async function matchSender(deps: InboundTextDeps, row: InboundMessage, userId: string): Promise<SenderMatch | null> {
  try {
    const m = await withTimeout(deps.sf.findByPhone(userId, row.fromE164), SF_CALL_TIMEOUT_MS, 'sender match');
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

/** Step 2. Returns the new Task's id; throws with the HTTP status in the message
 *  so `isSalesforceAuthError` can recognise a 401. */
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
  if (res.status >= 400) throw new Error(`task create failed (${res.status}): ${JSON.stringify(res.json)}`);
  const id = (res.json as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) throw new Error(`task create returned no id (${res.status})`);
  return id;
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

/** Step 3. `emailSimple` answers an array of per-input results; a 200 can still
 *  carry `isSuccess: false`, which means nothing was sent. */
async function sendTextEmail(
  deps: InboundTextDeps,
  row: InboundMessage,
  userId: string,
  ownerId: string,
  match: SenderMatch | null,
  taskId: string,
): Promise<void> {
  const to = await repEmail(deps, userId, ownerId);
  const links = textTaskLinks(match);
  const instanceUrl = await deps.instanceUrlFor(userId);
  const email = textEmail({
    name: match?.name ?? null,
    fromE164: row.fromE164,
    toE164: row.toE164,
    receivedAt: row.receivedAt,
    body: row.body,
    numMedia: row.numMedia,
    recordUrl: instanceUrl ? salesforceRecordUrl(instanceUrl, links.WhoId ?? links.WhatId ?? taskId) : null,
    optOut: isOptOutText(row.body),
  });
  const res = await withTimeout(
    deps.sf.sfFetch(userId, '/actions/standard/emailSimple', {
      method: 'POST',
      body: {
        inputs: [{ emailAddresses: to, emailSubject: email.subject, emailBody: email.body, senderType: 'CurrentUser' }],
      },
    }),
    SF_CREATE_TIMEOUT_MS,
    'email',
  );
  if (res.status >= 400) throw new Error(`email failed (${res.status}): ${JSON.stringify(res.json)}`);
  const refused = (Array.isArray(res.json) ? res.json : []).find(
    (r) => (r as { isSuccess?: unknown } | null)?.isSuccess === false,
  ) as { errors?: unknown } | undefined;
  if (refused) throw new Error(`email refused: ${JSON.stringify(refused.errors ?? null)}`);
}

function logFailed(row: InboundMessage, reason: string): void {
  console.error(`${LOG} text failed`, { rowId: row.id, messageSid: row.messageSid, userId: row.userId, reason });
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
  try {
    const needTask = !row.sfTaskId;
    const needEmail = !row.emailedAt && !row.backfill;
    if (needTask || needEmail) {
      const match = await matchSender(deps, row, userId);
      const ownerId = await withTimeout(deps.sf.salesforceUserId(userId), SF_CALL_TIMEOUT_MS, 'salesforce user');
      let taskId = row.sfTaskId;
      if (!taskId) {
        taskId = await createTextTask(deps, row, userId, ownerId, match);
        // Stamped BEFORE the email: a failure from here on retries the email only.
        await patchRow(deps, row.id, { sfTaskId: taskId });
      }
      if (needEmail) {
        await sendTextEmail(deps, row, userId, ownerId, match, taskId);
        await patchRow(deps, row.id, { emailedAt: deps.now() });
      }
    }
    await patchRow(deps, row.id, { status: 'done', lastError: null });
  } catch (err) {
    if (isSalesforceAuthError(err)) {
      logFailed(row, RECONNECT);
      await patchRow(deps, row.id, { status: 'failed', lastError: RECONNECT });
      return;
    }
    const msg = errorText(err);
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

/** Rows a dead tick left in flight go back to pending (their stamps keep the retry safe). */
export function reapStuckInboundTexts(db: Db, now: Date) {
  return db
    .update(schema.inboundMessages)
    .set({ status: 'pending', updatedAt: now })
    .where(
      and(
        eq(schema.inboundMessages.status, 'in_flight'),
        lte(schema.inboundMessages.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      ),
    );
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
 * bumped attempt count, not the scan's copy.
 */
export function claimInboundText(db: Db, id: string, at: Date) {
  return db
    .update(schema.inboundMessages)
    .set({ status: 'in_flight', attempts: sql`${schema.inboundMessages.attempts} + 1`, updatedAt: at })
    .where(and(eq(schema.inboundMessages.id, id), eq(schema.inboundMessages.status, 'pending')))
    .returning();
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
    now: () => new Date(),
  };
}

export async function runInboundTextTick(deps: InboundTextDeps = liveDeps()): Promise<{ processed: number }> {
  await reapStuckInboundTexts(deps.db, deps.now());
  const due = await selectDueInboundTexts(deps.db, deps.now());
  let processed = 0;
  for (const candidate of due) {
    // `deps.now()`, not a tick-start clock: the reaper measures staleness from
    // `updated_at`, and a batch can take minutes — a stale stamp would make the
    // last rows of a batch instantly reap-eligible on another replica.
    const [claimed] = await claimInboundText(deps.db, candidate.id, deps.now());
    if (!claimed) continue; // another replica has it
    try {
      await processInboundText(claimed, deps);
    } catch (err) {
      // processInboundText handles its own failures; this is a failed DB write.
      // Never let one row abort the batch. The reaper will hand it back.
      console.error(`${LOG} row crashed`, { rowId: claimed.id, messageSid: claimed.messageSid, err: redactBody(errorText(err), claimed.body) });
    }
    processed++;
  }
  return { processed };
}

/** Drive from server.ts. Single-flight — a slow tick is never overlapped. */
export function startInboundTextLoop(intervalMs = 5000): NodeJS.Timeout {
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
