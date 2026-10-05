import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { encryptString } from '@cti/auth';
import { schema } from '@cti/db';
import { SalesforceAuthError } from '@cti/salesforce';
import type { Db } from '../dialer/pick-did.js';
import { _resetSkipFieldWarnForTests } from '../salesforce/record-phone.js';
import {
  IntegrationTokenExpiredError,
  crmReadOnlyTokenSource,
  integrationConnectionQuery,
  integrationRecordKey,
  loadIntegrationRecord,
} from './integration-record.js';
import { clearDescribeCache } from './record.js';

const ORG = '99999999-2222-4333-8444-555555555555';
const LEAD_ID = '00Q5e00000AbCdEFGH';
const LEAD_2 = '00Q5e00000ZzZzZZZZ';
const INSTANCE = 'https://acme.my.salesforce.com';
const KEY = 'ab'.repeat(32);
const CFG = { SALESFORCE_API_VERSION: 'v60.0' };

/** The @cti/salesforce fake-fetch pattern (that helper is not exported from the package). */
interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}
interface FakeReply {
  status: number;
  body?: unknown;
}
function fakeFetch(script: (call: FakeCall) => FakeReply): { impl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', headers: { ...((init?.headers ?? {}) as Record<string, string>) } };
    calls.push(call);
    const reply = script(call);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { impl, calls };
}

const renderDb = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

/** A Db whose one select chain answers `rows`; any write would throw (there is none to call). */
function fakeDb(rows: Array<{ accessTokenEnc: string; instanceUrl: string }>) {
  const update = vi.fn();
  const insert = vi.fn();
  const limit = vi.fn(async () => rows);
  const db = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }), update, insert } as unknown as Db;
  return { db, update, insert, limit };
}

const LEAD_FIELDS = [
  { name: 'Id', label: 'Lead ID', type: 'id' },
  { name: 'AI_Call_Consent__c', label: 'AI Call Consent', type: 'boolean' },
  { name: 'Notes__c', label: 'Notes', type: 'textarea' },
  { name: 'FirstName', label: 'First Name', type: 'string' },
  { name: 'Name', label: 'Full Name', type: 'string' },
  { name: 'OwnerId', label: 'Owner ID', type: 'reference' },
];

/** Salesforce by URL: describe, the record, the phone lookup and recent Tasks. */
function salesforce(overrides: { phoneQuery?: (call: FakeCall) => FakeReply | null; status401?: boolean } = {}) {
  return fakeFetch((call) => {
    if (overrides.status401) return { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID' }] };
    const url = new URL(call.url);
    if (url.pathname.endsWith('/sobjects/Lead/describe')) return { status: 200, body: { name: 'Lead', fields: LEAD_FIELDS } };
    const q = url.searchParams.get('q') ?? '';
    if (q.includes('FROM Task')) {
      return { status: 200, body: { records: [{ Subject: 'Call', Description: 'Roof leaks', ActivityDate: '2026-09-01' }] } };
    }
    if (q.includes('MobilePhone')) {
      const custom = overrides.phoneQuery?.(call);
      if (custom) return custom;
      return { status: 200, body: { records: [{ Name: 'Pat Doe', MobilePhone: '619-555-0100', Phone: '619-555-0101' }] } };
    }
    if (q.startsWith('SELECT Id')) {
      return {
        status: 200,
        body: { records: [{ Id: LEAD_ID, AI_Call_Consent__c: true, Notes__c: 'Inherited', FirstName: 'Pat', Name: 'Pat Doe', OwnerId: '005000000000001AAA' }] },
      };
    }
    throw new Error(`unexpected ${call.url}`);
  });
}

beforeEach(() => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', KEY);
  clearDescribeCache();
  _resetSkipFieldWarnForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe('crmReadOnlyTokenSource', () => {
  it("pins the read: the tenant's connected Salesforce integration row", () => {
    const { sql, params } = integrationConnectionQuery(renderDb, ORG).toSQL();
    expect(sql).toBe(
      'select "access_token_enc", "instance_url" from "crm_connections" where ("crm_connections"."org_id" = $1 and "crm_connections"."provider" = $2 and "crm_connections"."status" = $3) limit $4',
    );
    expect(params).toEqual([ORG, 'salesforce', 'connected', 1]);
  });

  it('1: current() decrypts the access token of the connected row', async () => {
    const { db } = fakeDb([{ accessTokenEnc: encryptString('ACCESS-1'), instanceUrl: INSTANCE }]);
    expect(await crmReadOnlyTokenSource(db, ORG).current()).toEqual({ accessToken: 'ACCESS-1', instanceUrl: INSTANCE });
  });

  it('2: no connected row (none, or broken) -> SalesforceAuthError', async () => {
    const { db } = fakeDb([]);
    await expect(crmReadOnlyTokenSource(db, ORG).current()).rejects.toBeInstanceOf(SalesforceAuthError);
  });

  it('3: refresh() always throws IntegrationTokenExpiredError and never writes', async () => {
    const { db, update, insert, limit } = fakeDb([{ accessTokenEnc: encryptString('A'), instanceUrl: INSTANCE }]);
    await expect(crmReadOnlyTokenSource(db, ORG).refresh()).rejects.toBeInstanceOf(IntegrationTokenExpiredError);
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it('the describe-cache key is integration:<orgId>', () => {
    expect(integrationRecordKey(ORG)).toBe(`integration:${ORG}`);
  });
});

describe('loadIntegrationRecord', () => {
  const connected = () => fakeDb([{ accessTokenEnc: encryptString('ACCESS-1'), instanceUrl: INSTANCE }]).db;

  it('4: loads the record with the integration token, as loadAiCallRecord builds it', async () => {
    const sf = salesforce();
    const record = await loadIntegrationRecord(connected(), CFG, ORG, 'Lead', LEAD_ID, sf.impl);
    expect(record).toEqual({
      objectType: 'Lead',
      recordId: LEAD_ID,
      name: 'Pat Doe',
      firstName: 'Pat',
      phones: ['+16195550100', '+16195550101'],
      consentAiCall: true,
      consentFieldMissing: false,
      address: null,
      notes: 'Notes: Inherited\nTask 2026-09-01 — Call: Roof leaks',
      ownerSfUserId: '005000000000001AAA',
    });
    expect(sf.calls.every((c) => c.headers.authorization === 'Bearer ACCESS-1')).toBe(true);
    expect(sf.calls.every((c) => c.url.startsWith(`${INSTANCE}/services/data/v60.0/`))).toBe(true);
    expect(sf.calls.every((c) => c.method === 'GET')).toBe(true);
    const queries = sf.calls.map((c) => new URL(c.url).searchParams.get('q') ?? new URL(c.url).pathname);
    expect(queries.some((q) => q.includes('Skip_on_Dialer__c'))).toBe(true);
    expect(queries.some((q) => q.includes('FROM Task'))).toBe(true);
  });

  it('5: the describe is cached per tenant, so a second record does not re-describe', async () => {
    const sf = salesforce();
    await loadIntegrationRecord(connected(), CFG, ORG, 'Lead', LEAD_ID, sf.impl);
    await loadIntegrationRecord(connected(), CFG, ORG, 'Lead', LEAD_2, sf.impl);
    expect(sf.calls.filter((c) => c.url.includes('/describe'))).toHaveLength(1);
  });

  it('6: a 401 throws through the client refresh attempt (never refreshed here)', async () => {
    const sf = salesforce({ status401: true });
    await expect(loadIntegrationRecord(connected(), CFG, ORG, 'Lead', LEAD_ID, sf.impl)).rejects.toBeInstanceOf(IntegrationTokenExpiredError);
    expect(sf.calls).toHaveLength(1);
  });

  it('7: an INVALID_FIELD 400 on the Skip on Dialer query falls back to the query without it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sf = salesforce({
      phoneQuery: (call) =>
        (new URL(call.url).searchParams.get('q') ?? '').includes('Skip_on_Dialer__c')
          ? { status: 400, body: [{ message: "No such column 'Skip_on_Dialer__c'", errorCode: 'INVALID_FIELD' }] }
          : null,
    });
    const record = await loadIntegrationRecord(connected(), CFG, ORG, 'Lead', LEAD_ID, sf.impl);
    expect(record?.phones).toEqual(['+16195550100', '+16195550101']);
    const phoneQueries = sf.calls.map((c) => new URL(c.url).searchParams.get('q') ?? '').filter((q) => q.includes('MobilePhone'));
    expect(phoneQueries).toHaveLength(2);
    expect(warn.mock.calls.some((args) => String(args[0]).includes('Skip_on_Dialer__c'))).toBe(true);
    warn.mockRestore();
  });

  it('another SOQL error is rethrown as the CTI-shaped "SOQL failed (<status>): <body>" error', async () => {
    const sf = salesforce({ phoneQuery: () => ({ status: 400, body: [{ errorCode: 'MALFORMED_QUERY' }] }) });
    await expect(loadIntegrationRecord(connected(), CFG, ORG, 'Lead', LEAD_ID, sf.impl)).rejects.toThrow(
      'SOQL failed (400): [{"errorCode":"MALFORMED_QUERY"}]',
    );
  });

  it('a tenant without a connected integration fails the load', async () => {
    const sf = salesforce();
    await expect(loadIntegrationRecord(fakeDb([]).db, CFG, ORG, 'Lead', LEAD_ID, sf.impl)).rejects.toBeInstanceOf(SalesforceAuthError);
    expect(sf.calls).toHaveLength(0);
  });
});
