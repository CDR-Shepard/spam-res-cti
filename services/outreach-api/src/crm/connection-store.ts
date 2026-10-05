import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { decryptString, encryptString } from '@cti/auth';
import type { FieldMap } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { refreshAccessToken, SalesforceAuthError, type SalesforceOAuthConfig, type SalesforceToken, type TokenSource } from '@cti/salesforce';

export type CrmConnection = typeof schema.crmConnections.$inferSelect;

const PROVIDER = 'salesforce';
/** last_error is shown in the app; keep it a line, not a stack. */
const MAX_ERROR_LENGTH = 500;

function byOrg(orgId: string): SQL {
  return and(eq(schema.crmConnections.orgId, orgId), eq(schema.crmConnections.provider, PROVIDER))!;
}

/** The tenant's Salesforce connection, or null. Guarded like tenancy/scope.ts: a row for another org is never returned. */
export async function loadConnection(db: Db, orgId: string): Promise<CrmConnection | null> {
  const row = await db.query.crmConnections.findFirst({ where: byOrg(orgId) });
  return row && row.orgId === orgId ? row : null;
}

export interface SaveConnectionInput {
  orgId: string;
  userId: string;
  instanceUrl: string;
  sfOrgId: string;
  sfUserId: string;
  sfUsername: string | null;
  accessToken: string;
  refreshToken: string | null;
  fieldMap: FieldMap;
}

/** Upsert the tenant's one connection (ON CONFLICT org_id, provider). Tokens are encrypted here and nowhere else. */
export async function saveConnection(db: Db, input: SaveConnectionInput): Promise<void> {
  const now = new Date();
  const fields = {
    instanceUrl: input.instanceUrl,
    sfOrgId: input.sfOrgId,
    sfUserId: input.sfUserId,
    sfUsername: input.sfUsername,
    accessTokenEnc: encryptString(input.accessToken),
    refreshTokenEnc: input.refreshToken ? encryptString(input.refreshToken) : null,
    status: 'connected' as const,
    lastError: null,
    fieldMap: input.fieldMap,
    connectedBy: input.userId,
    connectedAt: now,
    updatedAt: now,
  };
  await db
    .insert(schema.crmConnections)
    .values({ orgId: input.orgId, provider: PROVIDER, ...fields })
    .onConflictDoUpdate({ target: [schema.crmConnections.orgId, schema.crmConnections.provider], set: fields });
}

/** Replace the tenant's field map; null when there is no connection to update. */
export async function saveFieldMap(db: Db, orgId: string, fieldMap: FieldMap): Promise<CrmConnection | null> {
  const [row] = await db.update(schema.crmConnections).set({ fieldMap, updatedAt: new Date() }).where(byOrg(orgId)).returning();
  return row ?? null;
}

/** Forget the tenant's connection and its tokens. Campaigns notice on their next refresh (CrmNotConnectedError → paused, A8). */
export async function deleteConnection(db: Db, orgId: string): Promise<void> {
  await db.delete(schema.crmConnections).where(byOrg(orgId));
}

/** `byOrg` plus: the row still holds the refresh token ciphertext the caller read (null = still has none). */
function byOrgWithRefreshToken(orgId: string, refreshTokenEnc: string | null): SQL {
  const unchanged = refreshTokenEnc === null ? isNull(schema.crmConnections.refreshTokenEnc) : eq(schema.crmConnections.refreshTokenEnc, refreshTokenEnc);
  return and(byOrg(orgId), unchanged)!;
}

/**
 * Marks the connection broken. Pass `ifRefreshTokenEnc` (the ciphertext the
 * failed refresh used) so a reconnect that replaced the tokens in the meantime
 * is not marked broken by a failure that belongs to the old ones.
 */
export async function markBroken(db: Db, orgId: string, error: string, ifRefreshTokenEnc?: string | null): Promise<void> {
  await db
    .update(schema.crmConnections)
    .set({ status: 'broken', lastError: error.slice(0, MAX_ERROR_LENGTH), updatedAt: new Date() })
    .where(ifRefreshTokenEnc === undefined ? byOrg(orgId) : byOrgWithRefreshToken(orgId, ifRefreshTokenEnc));
}

/**
 * Refreshes in flight, by org. Concurrent 401s (a refresh tick and a preview
 * request, or two parallel queries on one client) all wait on one token
 * exchange instead of each calling Salesforce and each writing the row.
 * Entries live only for the duration of the call.
 */
const refreshesInFlight = new Map<string, Promise<SalesforceToken>>();

/**
 * The token source a tenant's SalesforceClient runs on. `current()` reads and
 * decrypts the stored access token once; `refresh()` (called by the client on
 * a 401) trades the refresh token for a new access token and persists it
 * encrypted. When Salesforce rejects the refresh token (SalesforceAuthError
 * from @cti/salesforce) the connection is marked broken — the refresh job then
 * pauses the tenant's campaigns (A8) — and SalesforceAuthError is thrown. A
 * Salesforce outage (SalesforceApiError: 5xx or an unreadable body) is
 * rethrown unchanged, so an outage never forces an admin to reconnect.
 * Refreshes are single-flight per org (see `refreshesInFlight`).
 */
export function orgTokenSource(db: Db, orgId: string, oauth: SalesforceOAuthConfig, fetchImpl?: typeof fetch): TokenSource {
  let cached: SalesforceToken | null = null;

  async function current(): Promise<SalesforceToken> {
    if (cached) return cached;
    const row = await loadConnection(db, orgId);
    if (!row || row.status !== 'connected') throw new SalesforceAuthError('Salesforce is not connected for this tenant');
    cached = { accessToken: decryptString(row.accessTokenEnc), instanceUrl: row.instanceUrl };
    return cached;
  }

  async function exchangeAndStore(): Promise<SalesforceToken> {
    const row = await loadConnection(db, orgId);
    if (!row?.refreshTokenEnc) {
      await markBroken(db, orgId, 'No refresh token stored; reconnect Salesforce', row ? null : undefined);
      throw new SalesforceAuthError('No Salesforce refresh token; reconnect Salesforce');
    }
    let next: { accessToken: string; instanceUrl: string | null };
    try {
      next = await refreshAccessToken(oauth, decryptString(row.refreshTokenEnc), fetchImpl);
    } catch (err) {
      if (!(err instanceof SalesforceAuthError)) throw err; // outage: keep the connection, the caller retries next tick
      const message = `Token refresh failed: ${err.message}`;
      await markBroken(db, orgId, message, row.refreshTokenEnc);
      throw new SalesforceAuthError(message);
    }
    const token: SalesforceToken = { accessToken: next.accessToken, instanceUrl: next.instanceUrl ?? row.instanceUrl };
    await db
      .update(schema.crmConnections)
      .set({ accessTokenEnc: encryptString(token.accessToken), instanceUrl: token.instanceUrl, updatedAt: new Date() })
      .where(byOrgWithRefreshToken(orgId, row.refreshTokenEnc));
    return token;
  }

  async function refresh(): Promise<SalesforceToken> {
    let flight = refreshesInFlight.get(orgId);
    if (!flight) {
      flight = exchangeAndStore().finally(() => refreshesInFlight.delete(orgId));
      refreshesInFlight.set(orgId, flight);
    }
    cached = await flight;
    return cached;
  }

  return { current, refresh };
}
