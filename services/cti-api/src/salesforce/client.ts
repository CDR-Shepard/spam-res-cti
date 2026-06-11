/**
 * Salesforce REST client — token-aware, auto-refreshing.
 */
import { request } from 'undici';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { encryptString, decryptString } from '../crypto.js';
import { getDb, schema } from '../db/index.js';
import { refreshAccessToken } from './oauth.js';

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

async function sfFetch(
  userId: string,
  path: string,
  init: { method?: HttpMethod; body?: unknown; query?: Record<string, string> } = {},
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
 */
export async function findByPhone(userId: string, e164: string): Promise<SalesforceMatch | null> {
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
  const soslQuery = `FIND {${wildcarded}} IN PHONE FIELDS RETURNING Lead(Id, Name), Contact(Id, Name, AccountId)`;
  const res = await sfFetch(userId, '/search/', { query: { q: soslQuery } });
  if (res.status >= 400) return null;
  const data = res.json as {
    searchRecords?: Array<{ attributes: { type: string }; Id: string; Name?: string; AccountId?: string }>;
  };
  const records = data.searchRecords ?? [];
  if (records.length === 0) return null;
  if (records.length > 1) {
    const first = records[0]!;
    return {
      whoId: first.Id,
      name: first.Name,
      ambiguous: true,
    };
  }
  const r = records[0]!;
  if (r.attributes.type === 'Lead') return { whoId: r.Id, name: r.Name };
  if (r.attributes.type === 'Contact') {
    return { whoId: r.Id, whatId: r.AccountId, name: r.Name };
  }
  return null;
}

export interface CallTaskInput {
  subject: string;
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
 * Creates a Task. If custom fields are not present in the org, retries with them stripped
 * (graceful degradation) and logs a warning.
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
    CallType: 'Outbound',
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

  const attempt = async (payload: Record<string, unknown>) =>
    sfFetch(userId, '/sobjects/Task', { method: 'POST', body: payload });

  let res = await attempt(base);
  if (res.status >= 400) {
    // Inspect for INVALID_FIELD errors → strip custom fields & retry.
    const errs = res.json as Array<{ errorCode?: string; message?: string }>;
    const isInvalidField =
      Array.isArray(errs) &&
      errs.some((e) => typeof e.errorCode === 'string' && e.errorCode.startsWith('INVALID_FIELD'));
    if (isInvalidField) {
      const stripped: Record<string, unknown> = {};
      const degraded: string[] = [];
      for (const [k, v] of Object.entries(base)) {
        if (STANDARD_FIELDS.has(k)) stripped[k] = v;
        else degraded.push(k);
      }
      // Fold degraded data into Description so we don't lose it.
      stripped.Description = [
        input.description ?? '',
        '',
        '--- Caller Reputation CTI: extended metadata (custom fields not present) ---',
        ...degraded.map((k) => `${k}: ${JSON.stringify(input.customFields?.[k] ?? null)}`),
      ]
        .join('\n')
        .trim();
      res = await attempt(stripped);
      if (res.status >= 400) {
        throw new Error(`Salesforce Task create failed (degraded): ${JSON.stringify(res.json)}`);
      }
      const created = res.json as { id: string; success: boolean };
      return { taskId: created.id, degradedFields: degraded };
    }
    throw new Error(`Salesforce Task create failed: ${JSON.stringify(res.json)}`);
  }
  const created = res.json as { id: string; success: boolean };
  return { taskId: created.id };
}
