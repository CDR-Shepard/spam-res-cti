import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { decryptString, encryptString } from '@cti/auth';
import type { FieldMap } from '@cti/contracts';
import { schema } from '@cti/db';
import { SalesforceApiError, SalesforceAuthError, type SalesforceOAuthConfig } from '@cti/salesforce';
import { fakeDb } from '../test/harness.js';
import { deleteConnection, loadConnection, markBroken, orgTokenSource, saveConnection, saveFieldMap } from './connection-store.js';

const sf = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@cti/salesforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/salesforce')>()),
  refreshAccessToken: sf.refresh,
}));

const KEY = 'ab'.repeat(32);
const oauth: SalesforceOAuthConfig = { clientId: 'cid', redirectUri: 'http://api.test/api/connections/salesforce/callback', loginUrl: 'https://login.salesforce.com' };
const emptyObject = { notes: [], phones: [], email: null, doNotCall: null, emailOptOut: null, skipOnDialer: null, consent: null, webFormSource: null, state: null, leadManager: null };
const fieldMap: FieldMap = { Lead: { ...emptyObject, phones: ['MobilePhone'] }, Opportunity: emptyObject };
const sql = (w: unknown) => new PgDialect().sqlToQuery(w as SQL).sql;

beforeEach(() => { vi.stubEnv('TOKEN_ENCRYPTION_KEY', KEY); sf.refresh.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'CONN1', orgId: 'O1', provider: 'salesforce', instanceUrl: 'https://gg.my.salesforce.com', sfOrgId: '00D1', sfUserId: '0051', sfUsername: 'integration@gg.co',
    accessTokenEnc: encryptString('AT-old'), refreshTokenEnc: encryptString('RT-1'), status: 'connected', lastError: null, fieldMap,
    connectedBy: 'U1', connectedAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'), ...over,
  };
}

describe('saveConnection', () => {
  it('upserts on (org, provider) with both tokens encrypted at rest and the status reset to connected', async () => {
    const { db, writes, upserts } = fakeDb();
    await saveConnection(db, { orgId: 'O1', userId: 'U1', instanceUrl: 'https://gg.my.salesforce.com', sfOrgId: '00D1', sfUserId: '0051', sfUsername: 'integration@gg.co', accessToken: 'AT-plain', refreshToken: 'RT-plain', fieldMap });
    expect(writes).toHaveLength(1);
    const values = writes[0]!.values;
    expect(writes[0]!.table).toBe(schema.crmConnections);
    expect(values).toMatchObject({ orgId: 'O1', provider: 'salesforce', status: 'connected', lastError: null, connectedBy: 'U1', fieldMap, sfUsername: 'integration@gg.co' });
    expect(values.accessTokenEnc).not.toBe('AT-plain');
    expect(values.refreshTokenEnc).not.toBe('RT-plain');
    expect(JSON.stringify(values)).not.toContain('AT-plain');
    expect(decryptString(values.accessTokenEnc as string)).toBe('AT-plain');
    expect(decryptString(values.refreshTokenEnc as string)).toBe('RT-plain');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.set).toMatchObject({ status: 'connected', lastError: null, accessTokenEnc: values.accessTokenEnc, fieldMap });
    expect(upserts[0]!.set).not.toHaveProperty('orgId');
  });

  it('stores a null refresh token as null', async () => {
    const { db, writes } = fakeDb();
    await saveConnection(db, { orgId: 'O1', userId: 'U1', instanceUrl: 'https://x', sfOrgId: '00D1', sfUserId: '0051', sfUsername: null, accessToken: 'AT', refreshToken: null, fieldMap });
    expect(writes[0]!.values.refreshTokenEnc).toBeNull();
  });
});

describe('loadConnection', () => {
  it('queries by org and provider, and refuses a row from another org', async () => {
    const mine = fakeDb({ tables: { crmConnections: [connectionRow()] } });
    expect(await loadConnection(mine.db, 'O1')).toMatchObject({ id: 'CONN1' });
    const where = sql(mine.captured.where[0]);
    expect(where).toContain('"crm_connections"."org_id" = $1');
    expect(where).toContain('"crm_connections"."provider" = $2');
    const foreign = fakeDb({ tables: { crmConnections: [connectionRow({ orgId: 'O2' })] } });
    expect(await loadConnection(foreign.db, 'O1')).toBeNull();
    expect(await loadConnection(fakeDb().db, 'O1')).toBeNull();
  });
});

describe('markBroken', () => {
  it('sets status broken with the error, scoped to the org', async () => {
    const { db, writes, captured } = fakeDb();
    await markBroken(db, 'O1', 'refresh failed');
    expect(writes[0]).toMatchObject({ op: 'update', table: schema.crmConnections, values: { status: 'broken', lastError: 'refresh failed' } });
    expect(sql(captured.where[0])).toContain('"crm_connections"."org_id" = $1');
  });
});

describe('markBroken with a refresh token guard', () => {
  it('only marks the row broken while it still holds the refresh token the caller read', async () => {
    const { db, captured } = fakeDb();
    await markBroken(db, 'O1', 'refresh failed', 'CIPHER-1');
    const where = sql(captured.where[0]);
    expect(where).toContain('"crm_connections"."org_id" = $1');
    expect(where).toContain('"crm_connections"."refresh_token_enc" = $3');
  });

  it('guards on a still-null refresh token', async () => {
    const { db, captured } = fakeDb();
    await markBroken(db, 'O1', 'no token', null);
    expect(sql(captured.where[0])).toContain('"crm_connections"."refresh_token_enc" is null');
  });
});

describe('saveFieldMap / deleteConnection', () => {
  it('saveFieldMap updates only the field map, scoped to the org, and returns the row (or null)', async () => {
    const { db, writes, captured } = fakeDb({ updateReturning: [connectionRow()] });
    expect(await saveFieldMap(db, 'O1', fieldMap)).toMatchObject({ id: 'CONN1' });
    expect(writes[0]).toMatchObject({ op: 'update', table: schema.crmConnections, values: { fieldMap } });
    expect(Object.keys(writes[0]!.values).sort()).toEqual(['fieldMap', 'updatedAt']);
    expect(sql(captured.where[0])).toContain('"crm_connections"."org_id" = $1');
    expect(await saveFieldMap(fakeDb().db, 'O1', fieldMap)).toBeNull();
  });

  it('deleteConnection deletes the org row only', async () => {
    const { db, deletes, captured } = fakeDb();
    await deleteConnection(db, 'O1');
    expect(deletes).toEqual([{ table: schema.crmConnections }]);
    expect(sql(captured.where[0])).toBe('("crm_connections"."org_id" = $1 and "crm_connections"."provider" = $2)');
  });
});

describe('orgTokenSource', () => {
  it('current() decrypts the stored token; a broken or missing connection throws SalesforceAuthError', async () => {
    const ok = orgTokenSource(fakeDb({ tables: { crmConnections: [connectionRow()] } }).db, 'O1', oauth);
    expect(await ok.current()).toEqual({ accessToken: 'AT-old', instanceUrl: 'https://gg.my.salesforce.com' });
    const broken = orgTokenSource(fakeDb({ tables: { crmConnections: [connectionRow({ status: 'broken' })] } }).db, 'O1', oauth);
    await expect(broken.current()).rejects.toBeInstanceOf(SalesforceAuthError);
    await expect(orgTokenSource(fakeDb().db, 'O1', oauth).current()).rejects.toBeInstanceOf(SalesforceAuthError);
  });

  it('refresh() persists the new access token encrypted and returns it', async () => {
    sf.refresh.mockResolvedValue({ accessToken: 'AT-new', instanceUrl: 'https://gg2.my.salesforce.com' });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { db, writes } = fakeDb({ tables: { crmConnections: [connectionRow()] } });
    const tokens = orgTokenSource(db, 'O1', oauth, fetchImpl);
    expect(await tokens.refresh()).toEqual({ accessToken: 'AT-new', instanceUrl: 'https://gg2.my.salesforce.com' });
    expect(sf.refresh).toHaveBeenCalledWith(oauth, 'RT-1', fetchImpl);
    const update = writes.find((w) => w.op === 'update')!;
    expect(update.values.accessTokenEnc).not.toBe('AT-new');
    expect(decryptString(update.values.accessTokenEnc as string)).toBe('AT-new');
    expect(update.values.instanceUrl).toBe('https://gg2.my.salesforce.com');
    expect(await tokens.current()).toEqual({ accessToken: 'AT-new', instanceUrl: 'https://gg2.my.salesforce.com' });
  });

  it('refresh() writes the new access token only while the refresh token is the one it read', async () => {
    sf.refresh.mockResolvedValue({ accessToken: 'AT-new', instanceUrl: null });
    const row = connectionRow();
    const { db, captured } = fakeDb({ tables: { crmConnections: [row] } });
    await orgTokenSource(db, 'O1', oauth).refresh();
    const where = captured.where.map((w) => sql(w));
    expect(where.some((w) => w.includes('"crm_connections"."refresh_token_enc" = $3'))).toBe(true);
  });

  it('refresh() rejected by Salesforce marks the connection broken only if the refresh token is unchanged', async () => {
    sf.refresh.mockRejectedValue(new SalesforceAuthError('invalid_grant: expired access/refresh token'));
    const { db, captured } = fakeDb({ tables: { crmConnections: [connectionRow()] } });
    await expect(orgTokenSource(db, 'O1', oauth).refresh()).rejects.toBeInstanceOf(SalesforceAuthError);
    expect(captured.where.map((w) => sql(w)).some((w) => w.includes('"crm_connections"."refresh_token_enc" = $3'))).toBe(true);
  });

  it('refresh() rejected by Salesforce marks the connection broken and throws SalesforceAuthError', async () => {
    sf.refresh.mockRejectedValue(new SalesforceAuthError('invalid_grant: expired access/refresh token'));
    const { db, writes } = fakeDb({ tables: { crmConnections: [connectionRow()] } });
    await expect(orgTokenSource(db, 'O1', oauth).refresh()).rejects.toBeInstanceOf(SalesforceAuthError);
    expect(writes).toEqual([expect.objectContaining({ op: 'update', values: expect.objectContaining({ status: 'broken', lastError: expect.stringContaining('invalid_grant') }) })]);
  });

  it('refresh() during a Salesforce outage rethrows and leaves the connection connected', async () => {
    const outage = new SalesforceApiError('Salesforce token endpoint returned 503', 503, null);
    sf.refresh.mockRejectedValue(outage);
    const { db, writes } = fakeDb({ tables: { crmConnections: [connectionRow()] } });
    await expect(orgTokenSource(db, 'O1', oauth).refresh()).rejects.toBe(outage);
    expect(writes).toEqual([]);
  });

  it('refresh() with no stored refresh token marks broken without calling Salesforce', async () => {
    const { db, writes } = fakeDb({ tables: { crmConnections: [connectionRow({ refreshTokenEnc: null })] } });
    await expect(orgTokenSource(db, 'O1', oauth).refresh()).rejects.toBeInstanceOf(SalesforceAuthError);
    expect(sf.refresh).not.toHaveBeenCalled();
    expect(writes[0]!.values).toMatchObject({ status: 'broken' });
  });
});

describe('orgTokenSource refresh is single-flight per org', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('concurrent refresh() calls (even from separate token sources of one org) make one Salesforce call and one write', async () => {
    const gate = deferred<{ accessToken: string; instanceUrl: string | null }>();
    sf.refresh.mockReturnValue(gate.promise);
    const { db, writes } = fakeDb({ tables: { crmConnections: [connectionRow()] } });
    const a = orgTokenSource(db, 'O1', oauth);
    const b = orgTokenSource(db, 'O1', oauth);
    const calls = [a.refresh(), a.refresh(), b.refresh()];
    await vi.waitFor(() => expect(sf.refresh).toHaveBeenCalledTimes(1));
    gate.resolve({ accessToken: 'AT-new', instanceUrl: null });
    const tokens = await Promise.all(calls);
    expect(tokens).toEqual([tokens[0], tokens[0], tokens[0]]);
    expect(tokens[0]).toEqual({ accessToken: 'AT-new', instanceUrl: 'https://gg.my.salesforce.com' });
    expect(sf.refresh).toHaveBeenCalledTimes(1);
    expect(writes.filter((w) => w.op === 'update')).toHaveLength(1);
    expect(await b.current()).toEqual(tokens[0]);
  });

  it('refreshes for different orgs do not share a flight', async () => {
    sf.refresh.mockResolvedValue({ accessToken: 'AT-new', instanceUrl: null });
    const one = fakeDb({ tables: { crmConnections: [connectionRow()] } }).db;
    const two = fakeDb({ tables: { crmConnections: [connectionRow({ orgId: 'O2' })] } }).db;
    await Promise.all([orgTokenSource(one, 'O1', oauth).refresh(), orgTokenSource(two, 'O2', oauth).refresh()]);
    expect(sf.refresh).toHaveBeenCalledTimes(2);
  });

  it('once a flight settles the next refresh() calls Salesforce again, including after a failure', async () => {
    const outage = new SalesforceApiError('Salesforce token endpoint returned 503', 503, null);
    sf.refresh.mockRejectedValueOnce(outage).mockResolvedValue({ accessToken: 'AT-new', instanceUrl: null });
    const { db } = fakeDb({ tables: { crmConnections: [connectionRow()] } });
    const tokens = orgTokenSource(db, 'O1', oauth);
    const failed = await Promise.allSettled([tokens.refresh(), tokens.refresh()]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(sf.refresh).toHaveBeenCalledTimes(1);
    await expect(tokens.refresh()).resolves.toMatchObject({ accessToken: 'AT-new' });
    expect(sf.refresh).toHaveBeenCalledTimes(2);
  });
});
