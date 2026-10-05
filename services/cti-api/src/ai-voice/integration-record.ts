/**
 * Plan 1C: an AI call triggered by outreach-api loads its record with the TENANT's
 * integration connection (crm_connections, owned by outreach-api), not a rep's token.
 *
 * READ-ONLY on purpose: the access token is decrypted (both services share
 * TOKEN_ENCRYPTION_KEY) and never refreshed here. outreach-api owns refreshes and reads
 * Salesforce right before every trigger, so the token is fresh; a 401 anyway fails the
 * trigger as `salesforce_error`, which outreach retries. Two services never race to
 * rotate the same refresh token.
 *
 * The record itself is built by `loadAiCallRecord` (record.ts), unchanged: consent
 * (`AI_Call_Consent__c`), phones in the dialer's order with its Skip on Dialer rule,
 * and the notes. The gate in startAiCall decides on it exactly as for a rep's call.
 */
import { and, eq } from 'drizzle-orm';
import { decryptString } from '@cti/auth';
import { schema } from '@cti/db';
import { SalesforceApiError, SalesforceAuthError, SalesforceClient, type TokenSource } from '@cti/salesforce';
import type { AppConfig } from '../config.js';
import type { Db } from '../dialer/pick-did.js';
import { resolveDialNumber } from '../salesforce/record-phone.js';
import { loadAiCallRecord, type AiCallRecord, type RecordDeps } from './record.js';

export class IntegrationTokenExpiredError extends Error {
  constructor() {
    super('Integration access token expired; outreach-api refreshes it before the next trigger');
    this.name = 'IntegrationTokenExpiredError';
  }
}

/** The tenant's connected Salesforce integration: its encrypted access token and instance. */
export function integrationConnectionQuery(db: Db, orgId: string) {
  const c = schema.crmConnections;
  return db
    .select({ accessTokenEnc: c.accessTokenEnc, instanceUrl: c.instanceUrl })
    .from(c)
    .where(and(eq(c.orgId, orgId), eq(c.provider, 'salesforce'), eq(c.status, 'connected')))
    .limit(1);
}

export function crmReadOnlyTokenSource(db: Db, orgId: string): TokenSource {
  return {
    async current() {
      const [row] = await integrationConnectionQuery(db, orgId);
      if (!row) throw new SalesforceAuthError('No connected Salesforce integration for this tenant');
      return { accessToken: decryptString(row.accessTokenEnc), instanceUrl: row.instanceUrl };
    },
    async refresh() {
      throw new IntegrationTokenExpiredError();
    },
  };
}

/** The describe cache in record.ts is keyed by this "user id", so tenants never share entries with reps. */
export const integrationRecordKey = (orgId: string): string => `integration:${orgId}`;

/** Errors in the shape the CTI's own soqlQuery throws, so record-phone's INVALID_FIELD fallback still matches. */
async function querying<T>(client: SalesforceClient, soql: string): Promise<T[]> {
  try {
    return await client.query<T>(soql);
  } catch (err) {
    if (err instanceof SalesforceApiError) throw new Error(`SOQL failed (${err.status}): ${JSON.stringify(err.body)}`);
    throw err;
  }
}

export function integrationRecordDeps(client: SalesforceClient): RecordDeps {
  return {
    sfFetch: async (_userId, path, init = {}) =>
      client.request(path, { method: init.method, body: init.body, query: init.query, signal: init.signal }),
    soqlQuery: (_userId, soql) => querying<Record<string, unknown>>(client, soql),
    resolveDialNumber: (userId, objectType, recordId) =>
      resolveDialNumber(userId, objectType, recordId, <T>(_u: string, soql: string) => querying<T>(client, soql)),
  };
}

export function loadIntegrationRecord(
  db: Db,
  cfg: Pick<AppConfig, 'SALESFORCE_API_VERSION'>,
  orgId: string,
  objectType: 'Lead' | 'Opportunity',
  recordId: string,
  fetchImpl?: typeof fetch,
): Promise<AiCallRecord | null> {
  const client = new SalesforceClient({
    tokens: crmReadOnlyTokenSource(db, orgId),
    apiVersion: cfg.SALESFORCE_API_VERSION,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return loadAiCallRecord(integrationRecordKey(orgId), objectType, recordId, integrationRecordDeps(client));
}
