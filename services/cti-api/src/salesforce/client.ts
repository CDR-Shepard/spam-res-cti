/**
 * Salesforce REST client — token-aware, auto-refreshing.
 */
import { request } from 'undici';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { encryptString, decryptString } from '@cti/auth';
import { getDb, schema } from '@cti/db';
import { refreshAccessToken } from './oauth.js';
import { soqlEscape } from './soql.js';
import { CTI_ORIGIN, CTI_ORIGIN_FIELD, isInvalidFieldError, withoutCtiOrigin } from './cti-origin.js';

export class SalesforceUnauthorizedError extends Error {
  constructor() {
    super('Salesforce connection missing or revoked');
    this.name = 'SalesforceUnauthorizedError';
  }
}

interface ActiveToken {
  accessToken: string;
  instanceUrl: string;
  connectionId: string;
}

async function getActiveToken(userId: string): Promise<ActiveToken> {
  const db = getDb();
  const conn = await db.query.salesforceConnections.findFirst({
    where: eq(schema.salesforceConnections.userId, userId),
  });
  if (!conn) throw new SalesforceUnauthorizedError();

  const accessToken = decryptString(conn.accessTokenEnc);
  // We don't have reliable expiry timing; if a call returns 401 we'll refresh below.
  return { accessToken, instanceUrl: conn.instanceUrl, connectionId: conn.id };
}

async function refreshAndPersist(userId: string): Promise<ActiveToken> {
  const db = getDb();
  const conn = await db.query.salesforceConnections.findFirst({
    where: eq(schema.salesforceConnections.userId, userId),
  });
  if (!conn || !conn.refreshTokenEnc) throw new SalesforceUnauthorizedError();
  const refreshToken = decryptString(conn.refreshTokenEnc);
  const refreshed = await refreshAccessToken(refreshToken);
  const newAccess = encryptString(refreshed.access_token);
  const instanceUrl = refreshed.instance_url ?? conn.instanceUrl;
  await db
    .update(schema.salesforceConnections)
    .set({ accessTokenEnc: newAccess, instanceUrl, updatedAt: new Date() })
    .where(eq(schema.salesforceConnections.id, conn.id));
  return { accessToken: refreshed.access_token, instanceUrl, connectionId: conn.id };
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export async function sfFetch(
  userId: string,
  path: string,
  init: { method?: HttpMethod; body?: unknown; query?: Record<string, string>; signal?: AbortSignal } = {},
  retry = true,
): Promise<{ status: number; json: unknown }> {
  const cfg = loadConfig();
  let token = await getActiveToken(userId);
  const url = new URL(`/services/data/${cfg.SALESFORCE_API_VERSION}${path}`, token.instanceUrl);
  if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);

  const doRequest = async (t: string) =>
    request(url.toString(), {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      // Only set by callers that explicitly opt into a bounded round-trip
      // (see findPrimaryOpenOpportunityId / IMPORTANT-2) — undefined here is
      // a no-op for undici, so every other call site is unaffected.
      signal: init.signal,
    });

  let res = await doRequest(token.accessToken);
  if (res.statusCode === 401 && retry) {
    token = await refreshAndPersist(userId);
    res = await doRequest(token.accessToken);
  }
  const text = await res.body.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.statusCode, json };
}

// Re-exported so the many existing `import { soqlEscape } from './client.js'`
// call sites keep working; the implementation lives in soql.ts, which has no
// dependencies and can be imported from anywhere.
export { soqlEscape } from './soql.js';

/** Run a SOQL query as the given user; returns the `records` array. */
export async function soqlQuery<T = Record<string, unknown>>(
  userId: string,
  soql: string,
  opts: { signal?: AbortSignal } = {},
): Promise<T[]> {
  const res = await sfFetch(userId, '/query', { query: { q: soql }, signal: opts.signal });
  if (res.status >= 400) throw new Error(`SOQL failed (${res.status}): ${JSON.stringify(res.json)}`);
  return ((res.json as { records?: T[] }).records ?? []);
}

// --- High-level helpers ----------------------------------------------------

export interface SalesforceMatch {
  whoId?: string;
  whatId?: string;
  name?: string;
  ambiguous?: boolean;
}

/** Address fields we read from a Lead or Contact to derive the recipient's TZ. */
export interface RecordAddress {
  state: string | null;
  country: string | null;
  postalCode: string | null;
  recordName: string | null;
  objectType: 'Lead' | 'Contact' | 'Other';
}

/**
 * Fetches the mailing/billing address of a Lead or Contact by record ID.
 * Returns null if the record is not visible to the user or not addressable.
 * Used by the firewall to derive the recipient's timezone.
 */
export async function fetchRecordAddress(
  userId: string,
  recordId: string,
): Promise<RecordAddress | null> {
  // SF object ID prefixes: 00Q = Lead, 003 = Contact
  const prefix = recordId.slice(0, 3);
  const objectType: RecordAddress['objectType'] =
    prefix === '00Q' ? 'Lead' : prefix === '003' ? 'Contact' : 'Other';
  if (objectType === 'Other') return null;

  // Lead uses {State, Country, PostalCode}. Contact uses Mailing* equivalents.
  const fields = objectType === 'Lead'
    ? ['Name', 'State', 'Country', 'PostalCode']
    : ['Name', 'MailingState', 'MailingCountry', 'MailingPostalCode'];
  const path = `/sobjects/${objectType}/${encodeURIComponent(recordId)}?fields=${fields.join(',')}`;

  const res = await sfFetch(userId, path);
  if (res.status >= 400) return null;
  const r = res.json as Record<string, unknown>;
  if (objectType === 'Lead') {
    return {
      objectType,
      recordName: (r.Name as string | null) ?? null,
      state: (r.State as string | null) ?? null,
      country: (r.Country as string | null) ?? null,
      postalCode: (r.PostalCode as string | null) ?? null,
    };
  }
  return {
    objectType,
    recordName: (r.Name as string | null) ?? null,
    state: (r.MailingState as string | null) ?? null,
    country: (r.MailingCountry as string | null) ?? null,
    postalCode: (r.MailingPostalCode as string | null) ?? null,
  };
}

/**
 * Looks up a Lead or Contact by phone number using SOSL.
 * Returns the single match or marks ambiguous if multiple.
 *
 * `opts.preferOpenOpportunity` (CRITICAL-1, converted-lead fix wave):
 * defaults to `false` so every existing call site keeps today's behaviour
 * byte for byte — notably routes/inbound.ts's live-webhook lookup, which
 * only needs the caller's name and must never gain a second round-trip.
 * `sync.ts` is the only caller that opts in, and only for inbound calls
 * (`{ preferOpenOpportunity: inbound }` — `ownership.ts` exempts inbound
 * from the ownership gate, so preferring the Contact's open Opportunity over
 * its Account there carries no risk of a silently-skipped outbound Task).
 */
export async function findByPhone(
  userId: string,
  e164: string,
  opts: { preferOpenOpportunity?: boolean } = {},
): Promise<SalesforceMatch | null> {
  // E.164 input → digits only. SOSL treats '+' as a bind-variable prefix, and
  // '-' / '(' / ')' / spaces aren't allowed unless escaped. Salesforce phone
  // fields are searched with their digits normalized — but the search term
  // also needs to be digits, OPTIONALLY with the leading country-code "1"
  // stripped (US numbers in SF are commonly stored without country code).
  // Build a 10-digit + 7-digit variant so we hit both storage formats.
  const digits = e164.replace(/\D+/g, '');
  if (!digits) return null;
  const stripCountry = digits.length > 10 && digits.startsWith('1') ? digits.slice(1) : digits;
  // Use the * wildcard between segments to defeat any embedded separators
  // that SF stored. e.g. "843*212*7339" matches "843-212-7339", "(843) 212-7339",
  // or "+18432127339" all the same.
  const n = stripCountry;
  const wildcarded = n.length === 10
    ? `${n.slice(0, 3)}*${n.slice(3, 6)}*${n.slice(6)}`
    : n;
  // Search Lead + Contact + the org's custom Deal__c phone fields. If Deal__c
  // has no phone field (or doesn't exist), the SOSL errors — so we retry with
  // just the standard objects. That way Deal__c support never breaks the
  // baseline Lead/Contact matching.
  //
  // `Lead(... WHERE IsConverted = false)`: SOSL returns converted leads, and
  // after a lead converts the phone lives on BOTH the dead Lead and the new
  // Contact. Excluding converted leads here stops us ever attaching a Task to
  // a Lead Salesforce will reject with CANNOT_UPDATE_CONVERTED_LEAD.
  const withDeal =
    'RETURNING Lead(Id, Name WHERE IsConverted = false), Contact(Id, Name, AccountId), Deal__c(Id, Name)';
  const standard = 'RETURNING Lead(Id, Name WHERE IsConverted = false), Contact(Id, Name, AccountId)';
  const runSosl = (returning: string) =>
    sfFetch(userId, '/search/', { query: { q: `FIND {${wildcarded}} IN PHONE FIELDS ${returning}` } });
  let res = await runSosl(withDeal);
  // A 400 means the query was rejected — almost always because Deal__c has no
  // phone field / isn't searchable. Retry with just the standard objects so
  // Deal__c can never break baseline Lead/Contact matching. Transient 401/5xx
  // are left to the sync worker's retry rather than silently narrowing.
  if (res.status === 400) res = await runSosl(standard);
  if (res.status >= 400) return null;
  const data = res.json as {
    searchRecords?: Array<{ attributes: { type: string }; Id: string; Name?: string; AccountId?: string }>;
  };
  const records = data.searchRecords ?? [];
  if (records.length === 0) return null;
  const ambiguous = records.length > 1;
  // Preference order when several objects match the same phone: Contact,
  // then Lead, then anything else (Deal__c etc.). After a conversion the
  // Contact is the live record and both it and the (now-filtered) Lead can
  // still both show up here (e.g. the Lead filter above is best-effort — an
  // org where IsConverted isn't populated correctly could still slip one
  // through), so picking the Contact is correct even then.
  const r =
    records.find((rec) => rec.attributes.type === 'Contact') ??
    records.find((rec) => rec.attributes.type === 'Lead') ??
    records[0]!;
  // Lead/Contact attach via WhoId; everything else (Deal__c, etc.) via WhatId.
  if (r.attributes.type === 'Lead') return { whoId: r.Id, name: r.Name, ambiguous };
  if (r.attributes.type === 'Contact') {
    if (!opts.preferOpenOpportunity) {
      // Default / outbound behaviour, unchanged: land on the Account, no
      // second round-trip. An Opportunity is ownership-gated (ownership.ts)
      // and an Account is not — preferring it unconditionally would silently
      // drop outbound Tasks whose Contact's open Opportunity belongs to
      // another rep (CRITICAL-1).
      return { whoId: r.Id, whatId: r.AccountId, name: r.Name, ambiguous };
    }
    // A matched Contact should land on its open Opportunity (the record the
    // team actually works), not just the Account. Degrades to AccountId on
    // any failure/empty result — this must never throw or block the Task.
    const opportunityId = await findPrimaryOpenOpportunityId(userId, r.Id);
    return { whoId: r.Id, whatId: opportunityId ?? r.AccountId, name: r.Name, ambiguous };
  }
  return { whatId: r.Id, name: r.Name, ambiguous };
}

/**
 * The Contact's primary open Opportunity, or null if it has none / the
 * lookup fails. Exported (IMPORTANT-2, fix wave 2) — it now has TWO callers:
 * `findByPhone` above, via `opts.preferOpenOpportunity` (the after-call sync
 * worker, for inbound calls with no stored ids yet — see CRITICAL-1); and
 * `syncOne` (src/salesforce/sync.ts) directly, for an inbound call that
 * ALREADY carries an Account WhatId from routes/inbound.ts's webhook-time
 * lookup (which never opts into `preferOpenOpportunity`) — without this
 * second call site, only the converted-lead replay population would ever
 * land on the Opportunity, and every new inbound call would land on the
 * Account forever. Failure here must NEVER throw and must NEVER block the
 * Task — a Task that lands on the Account is far better than a Task that
 * fails.
 *
 * Bounded to 3s so a degraded Salesforce can never hang this lookup
 * indefinitely (undici's default request timeout is 300s) — the catch below
 * turns a timeout into the same AccountId fallback as any other failure.
 */
export async function findPrimaryOpenOpportunityId(userId: string, contactId: string): Promise<string | null> {
  try {
    const rows = await soqlQuery<{ OpportunityId: string }>(
      userId,
      `SELECT OpportunityId FROM OpportunityContactRole WHERE ContactId = '${soqlEscape(contactId)}' ` +
        `AND Opportunity.IsClosed = false ORDER BY IsPrimary DESC, Opportunity.CreatedDate DESC LIMIT 1`,
      { signal: AbortSignal.timeout(3000) },
    );
    return rows[0]?.OpportunityId ?? null;
  } catch {
    return null;
  }
}

export interface CallTaskInput {
  subject: string;
  /** 'Outbound' (default) or 'Inbound' — sets the Task's CallType. */
  callType?: 'Inbound' | 'Outbound';
  callDisposition?: string;
  callDurationInSeconds?: number;
  whoId?: string;
  whatId?: string;
  description?: string;
  /** All optional custom fields below — best-effort, degrade gracefully */
  customFields?: Record<string, string | number | null>;
}

const STANDARD_FIELDS = new Set([
  'Subject',
  'Status',
  'Priority',
  'TaskSubtype',
  'CallType',
  'CallDisposition',
  'CallDurationInSeconds',
  'WhoId',
  'WhatId',
  'ActivityDate',
  'Description',
]);

/**
 * Creates a Task, degrading through four payloads rather than losing the task:
 * the full one, one without the CTI marker, one with only standard fields PLUS
 * the marker, and finally standard fields alone. Which fields were dropped is
 * reported back as `degradedFields` and persisted by sync.ts to
 * `calls.metadata.salesforceDegradedFields` — that column is the signal, not a
 * log line. Nothing here logs: in an org missing the CTI custom fields EVERY
 * call log degrades, so a warning would be pure noise at real call volume.
 */
export async function createCallTask(
  userId: string,
  input: CallTaskInput,
): Promise<{ taskId: string; degradedFields?: string[] }> {
  const today = new Date().toISOString().slice(0, 10);
  const base: Record<string, unknown> = {
    Subject: input.subject,
    Status: 'Completed',
    Priority: 'Normal',
    TaskSubtype: 'Call',
    CallType: input.callType ?? 'Outbound',
    ActivityDate: today,
  };
  if (input.callDisposition) base.CallDisposition = input.callDisposition;
  if (typeof input.callDurationInSeconds === 'number')
    base.CallDurationInSeconds = input.callDurationInSeconds;
  if (input.whoId) base.WhoId = input.whoId;
  if (input.whatId) base.WhatId = input.whatId;
  if (input.description) base.Description = input.description;
  for (const [k, v] of Object.entries(input.customFields ?? {})) {
    if (v !== null && v !== undefined) base[k] = v;
  }
  // Stamped last so it always wins: this marker is how reports tell a CTI-written
  // task from one a person typed, and a caller-supplied customFields entry must
  // not be able to forge or clear it.
  base[CTI_ORIGIN_FIELD] = CTI_ORIGIN.callLog;

  const attempt = async (payload: Record<string, unknown>) =>
    sfFetch(userId, '/sobjects/Task', { method: 'POST', body: payload });

  let res = await attempt(base);

  // The marker is the newest field on this payload and the only one gated by
  // per-rep field-level security, so it is by far the likeliest single cause of
  // INVALID_FIELD. Drop just it and retry BEFORE falling back to stripping every
  // custom field — otherwise one invisible reporting field would cost the call
  // log its 360 CTI data (recording URL, call sid, disposition) as collateral.
  const markerWasRejected = res.status >= 400 && isInvalidFieldError(res.json);
  let firstErrorBody: unknown;
  if (markerWasRejected) {
    firstErrorBody = res.json;
    const retry = await attempt(withoutCtiOrigin(base));
    if (retry.status < 400) {
      const madeWithoutMarker = retry.json as { id: string; success: boolean };
      return { taskId: madeWithoutMarker.id, degradedFields: [CTI_ORIGIN_FIELD] };
    }
    res = retry;
  }

  if (res.status >= 400) {
    // Still rejected → strip every custom field & retry.
    //
    // `markerWasRejected` keeps the fallback reachable when the narrow retry
    // fails for an unrelated reason (a transient 503, say). The FIRST response
    // is what proved a field is unknown to this org/user; before the marker
    // existed that response went straight here, and a flaky second call must
    // not cost the caller the degraded create that used to succeed.
    // `markerWasRejected` alone decides this: when it is false, `res` is still
    // the FIRST response, which by construction was not an INVALID_FIELD.
    if (markerWasRejected) {
      const stripped: Record<string, unknown> = {};
      const degraded: string[] = [];
      for (const [k, v] of Object.entries(base)) {
        if (STANDARD_FIELDS.has(k)) stripped[k] = v;
        else degraded.push(k);
      }
      // Keep the marker if we possibly can. Reaching here means SOME custom
      // field is unknown to this org or invisible to this rep, but not
      // necessarily CTI_Origin__c — and in the org this runs in it is the
      // OTHERS that are missing: the marker is the only CTI custom field that
      // exists on Task there. Stripping everything would therefore throw away
      // the one field that makes a call log attributable to the CTI, on every
      // call, forever. This rung costs nothing in the common case: the payload
      // that used to be attempt 3 is now attempt 4, and it is only reached when
      // the marker genuinely cannot be written either.
      // No `marker !== undefined` guard: the stamp above is unconditional, and
      // a guard here would silently skip this whole rung if anyone ever made it
      // conditional — the wrong failure direction, since that is exactly when
      // the rest of this rung still matters.
      const keptMarker = await attempt({ ...stripped, [CTI_ORIGIN_FIELD]: base[CTI_ORIGIN_FIELD] });
      if (keptMarker.status < 400) {
        const made = keptMarker.json as { id: string; success: boolean };
        const stillDegraded = degraded.filter((f) => f !== CTI_ORIGIN_FIELD);
        // An empty array would mark the call "degraded" with nothing degraded,
        // in the very column used to diagnose this. Say nothing instead.
        return {
          taskId: made.id,
          ...(stillDegraded.length ? { degradedFields: stillDegraded } : {}),
        };
      }

      // The custom fields aren't defined in this SF org — drop them and keep the
      // lean Description (already copied above as a standard field). We do NOT
      // fold the diagnostics into Description: the full record, including these
      // values, is preserved in our own DB (calls.sync_detail), so nothing is
      // lost and org Chatter automations don't repost CTI internals.
      res = await attempt(stripped);
      if (res.status >= 400) {
        // Carry the FIRST body too: it is the one that names the offending
        // column, and it is the only diagnostic for "which field is this org
        // missing". The stripped attempt's error rarely says.
        const origin =
          firstErrorBody === undefined ? '' : ` (first rejection: ${JSON.stringify(firstErrorBody)})`;
        throw new Error(
          `Salesforce Task create failed (degraded): ${JSON.stringify(res.json)}${origin}`,
        );
      }
      const created = res.json as { id: string; success: boolean };
      return { taskId: created.id, degradedFields: degraded };
    }
    throw new Error(`Salesforce Task create failed: ${JSON.stringify(res.json)}`);
  }
  const created = res.json as { id: string; success: boolean };
  return { taskId: created.id };
}

/**
 * Posts ONE Chatter feed item of plain text onto a record (Lead/Contact/
 * Opportunity/Deal__c). Used by syncOne to give every dispositioned call a
 * feed item on its related record, in addition to (never instead of) the
 * Task write — per the 2026-08-26 ruling. Throws on failure so the caller can
 * decide how to handle it; syncOne treats a failed post as non-fatal to the
 * Task sync.
 */
export async function postChatterFeedItem(
  userId: string,
  subjectId: string,
  text: string,
): Promise<string> {
  const res = await sfFetch(userId, '/chatter/feed-elements', {
    method: 'POST',
    body: {
      feedElementType: 'FeedItem',
      subjectId,
      body: { messageSegments: [{ type: 'Text', text }] },
    },
  });
  if (res.status >= 400) {
    throw new Error(`Salesforce Chatter post failed (${subjectId}): ${JSON.stringify(res.json)}`);
  }
  const created = res.json as { id: string };
  return created.id;
}

/** sObject Collections takes at most 200 records per request (a Salesforce limit). */
export const FEED_ITEMS_PER_REQUEST = 200;

export interface FeedItemPost {
  /** The record the post lands on (FeedItem.ParentId). */
  parentId: string;
  /** Plain text (FeedItem.Body). */
  body: string;
}

/** One post's fate. A failure here is PER RECORD and final — Salesforce looked at
 *  this record and said no (no access, locked, deleted). Retrying cannot help. */
export type FeedItemResult =
  | { ok: true; id: string }
  | { ok: false; statusCode: string; message: string };

interface CollectionsSaveResult {
  id?: unknown;
  success?: unknown;
  errors?: Array<{ statusCode?: unknown; message?: unknown }> | null;
}

function feedItemResultOf(raw: CollectionsSaveResult): FeedItemResult {
  if (raw.success === true) {
    // A success we cannot name is still reported as terminal: the post exists,
    // so "try again" would duplicate it, and an id-less stamp would read as
    // "never handled" on the next pass and duplicate it then instead.
    return typeof raw.id === 'string' && raw.id ? { ok: true, id: raw.id } : { ok: false, statusCode: 'NO_ID_RETURNED', message: '' };
  }
  const first = raw.errors?.[0];
  return {
    ok: false,
    statusCode: typeof first?.statusCode === 'string' && first.statusCode ? first.statusCode : 'UNKNOWN_ERROR',
    message: typeof first?.message === 'string' ? first.message : '',
  };
}

/**
 * Posts MANY plain-text Chatter feed items in ONE request, through the sObject
 * Collections API (`POST /composite/sobjects`, `allOrNone: false`).
 *
 * Why not `postChatterFeedItem` in a loop: that is the Connect API — one HTTP
 * call per post, metered by a per-user HOURLY Connect rate limit. The
 * end-of-run "No answer" sweep posts up to ~300 at once as one rep, which is
 * exactly the shape that limit exists to stop. Collections rides the ordinary
 * REST allocation and is 1–2 calls for a whole run.
 *
 * Authored by the rep: the request is made on `userId`'s own OAuth token, so
 * CreatedBy — what Chatter shows as the author — is the rep.
 *
 * The answer is aligned BY INDEX with `posts`. Two kinds of failure, kept apart:
 *  - the REQUEST failed (non-2xx, or a body that is not an index-aligned array):
 *    THROWS. Nothing is known about any post in it; the caller treats the whole
 *    chunk as transient. The status is in the message (`(401)`, `(503)`) for the
 *    same reason followup-worker puts it there — `isSalesforceAuthError` reads it.
 *  - one RECORD failed (`success: false`): returned, not thrown, with the first
 *    error's `statusCode`. The other posts in the request still went through.
 *
 * At most `FEED_ITEMS_PER_REQUEST` posts. Chunking is the caller's job on
 * purpose: it must persist each chunk's ids before sending the next.
 */
export async function createFeedItems(
  userId: string,
  posts: ReadonlyArray<FeedItemPost>,
): Promise<FeedItemResult[]> {
  if (posts.length === 0) return [];
  if (posts.length > FEED_ITEMS_PER_REQUEST) {
    throw new Error(`createFeedItems takes at most ${FEED_ITEMS_PER_REQUEST} posts per request (got ${posts.length})`);
  }
  const res = await sfFetch(userId, '/composite/sobjects', {
    method: 'POST',
    body: {
      allOrNone: false,
      records: posts.map((p) => ({ attributes: { type: 'FeedItem' }, ParentId: p.parentId, Body: p.body })),
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Salesforce FeedItem create failed (${res.status}): ${JSON.stringify(res.json)}`);
  }
  if (!Array.isArray(res.json)) {
    throw new Error(`Salesforce FeedItem create answered with a body that is not an array (${res.status})`);
  }
  if (res.json.length !== posts.length) {
    throw new Error(`Salesforce FeedItem create returned ${res.json.length} results for ${posts.length} records`);
  }
  return (res.json as CollectionsSaveResult[]).map((raw) => feedItemResultOf(raw ?? {}));
}

/**
 * Patch fields onto an existing Task — used to attach the recording link, which
 * only exists after the call ends (and often after the Task was already
 * created). Only touches the fields passed in; throws on hard failure so the
 * caller can log it. A missing custom field (INVALID_FIELD) is treated as a
 * no-op so an org without the recording field doesn't error the webhook.
 */
export async function updateCallTask(
  userId: string,
  taskId: string,
  fields: Record<string, string | number | null>,
): Promise<{ updated: boolean }> {
  const res = await sfFetch(userId, `/sobjects/Task/${taskId}`, { method: 'PATCH', body: fields });
  if (res.status >= 400) {
    const errs = res.json as Array<{ errorCode?: string }>;
    const isInvalidField =
      Array.isArray(errs) &&
      errs.some((e) => typeof e.errorCode === 'string' && e.errorCode.startsWith('INVALID_FIELD'));
    if (isInvalidField) return { updated: false };
    throw new Error(`Salesforce Task update failed (${taskId}): ${JSON.stringify(res.json)}`);
  }
  return { updated: true };
}
