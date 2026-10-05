import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '@cti/auth';
import { SalesforceAuthError, SalesforceClient } from '@cti/salesforce';
import { fakeDb, testConfig } from '../test/harness.js';
import { bootstrapClient, CrmNotConnectedError, liveClientFactory, salesforceOAuthConfig } from './client-factory.js';

const SF_ENV = { SALESFORCE_CLIENT_ID: 'cid', SALESFORCE_CLIENT_SECRET: 'csecret', SALESFORCE_REDIRECT_URI: 'http://api.test/api/connections/salesforce/callback' };

beforeEach(() => vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32)));
afterEach(() => vi.unstubAllEnvs());

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('salesforceOAuthConfig', () => {
  it('maps the env onto the package config', () => {
    expect(salesforceOAuthConfig(testConfig(SF_ENV))).toEqual({
      clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://api.test/api/connections/salesforce/callback', loginUrl: 'https://login.salesforce.com',
    });
  });
  it('throws when Salesforce is not configured', () => {
    expect(() => salesforceOAuthConfig(testConfig())).toThrow(/not configured/);
  });
});

describe('liveClientFactory', () => {
  it('builds a client on the tenant connection: requests carry the decrypted token to its instance', async () => {
    const row = { orgId: 'O1', provider: 'salesforce', instanceUrl: 'https://gg.my.salesforce.com', status: 'connected', accessTokenEnc: encryptString('AT-1'), refreshTokenEnc: null };
    const fetchImpl = vi.fn(async () => okJson({ totalSize: 0, done: true, records: [] }));
    const factory = liveClientFactory(fakeDb({ tables: { crmConnections: [row] } }).db, testConfig(SF_ENV), fetchImpl as unknown as typeof fetch);
    const client = await factory('O1');
    expect(client).toBeInstanceOf(SalesforceClient);
    await client.query('SELECT Id FROM Lead LIMIT 1');
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [string | URL | Request, RequestInit | undefined];
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    expect(url).toMatch(/^https:\/\/gg\.my\.salesforce\.com\/services\/data\/v60\.0\/query/);
    expect(headers.get('authorization')).toBe('Bearer AT-1');
  });

  it.each([
    ['no connection row', []],
    ['a broken connection', [{ orgId: 'O1', status: 'broken', instanceUrl: 'https://x', accessTokenEnc: 'v1:x:y:z' }]],
  ])('throws CrmNotConnectedError for %s', async (_label, rows) => {
    const factory = liveClientFactory(fakeDb({ tables: { crmConnections: rows } }).db, testConfig(SF_ENV));
    await expect(factory('O1')).rejects.toBeInstanceOf(CrmNotConnectedError);
  });

  it('throws CrmNotConnectedError when the server has no Salesforce config', async () => {
    await expect(liveClientFactory(fakeDb().db, testConfig())('O1')).rejects.toBeInstanceOf(CrmNotConnectedError);
  });
});

describe('bootstrapClient', () => {
  it('uses the given token and cannot refresh', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 401 }));
    const client = bootstrapClient({ accessToken: 'AT-new', instanceUrl: 'https://gg.my.salesforce.com' }, testConfig(SF_ENV), fetchImpl as unknown as typeof fetch);
    await expect(client.describe('Lead')).rejects.toBeInstanceOf(SalesforceAuthError);
  });
});
