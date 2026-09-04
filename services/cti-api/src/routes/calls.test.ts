import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OwnershipSnapshot } from '../salesforce/ownership.js';

// ---------------------------------------------------------------------------
// GET /calls route-level harness (Fastify + fake-DB injection), following
// calls-disposition.test.ts's idiom: hoisted `state`, `vi.mock` of
// `../config.js` / `@cti/auth` / `@cti/db`, then `registerCallRoutes`. Only
// these three are mocked — the route never touches Salesforce or the dialer,
// so those modules import for real, same as calls-disposition.test.ts.
// ---------------------------------------------------------------------------
const routeState = vi.hoisted(() => ({
  authedUser: null as { userId: string; orgId: string; email: string; isAdmin: boolean } | null,
  // The fixed fixture `select().from(schema.calls).where().orderBy().limit()`
  // resolves to. `where`/`orderBy` are recorded but not introspected for
  // filtering (dialer-handoffs.test.ts convention) — the route's own
  // `eq(userId, ...)` is what actually scopes calls in production.
  callRows: [] as Array<Record<string, unknown>>,
  // The fixture `select({...}).from(schema.salesforceSyncJobs).where(...)`
  // resolves to.
  syncJobRows: [] as Array<{ callId: string; status: string; lastError: string | null }>,
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ TELEPHONY_PROVIDER: 'twilio' }),
}));

vi.mock('@cti/auth', () => ({
  resolveSession: async () => routeState.authedUser,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      select(_cols?: unknown) {
        return {
          from(table: unknown) {
            // Distinguish the two `GET /calls` queries by which table they
            // named — the calls query chains `.where().orderBy().limit()`,
            // the sync-jobs query resolves directly off `.where()`.
            if (table === actual.schema.calls) {
              return {
                where: (_where: unknown) => ({
                  orderBy: (_col: unknown) => ({
                    limit: async (_n: number) => routeState.callRows,
                  }),
                }),
              };
            }
            return {
              where: async (_where: unknown) => routeState.syncJobRows,
            };
          },
        };
      },
    }),
  };
});

import { registerCallRoutes, clientTaskAllowed, syncErrorForCall, toNumberE164ForCall } from './calls.js';

// The raw shape GET /calls gets back from salesforce_sync_jobs.
const SOQL_DUMP = 'SOQL failed (400): [{"message":"No such column","errorCode":"INVALID_FIELD"}]';
const NO_TASK = { salesforceTaskId: null };

describe('syncErrorForCall', () => {
  it('surfaces the deliberate skip once the job is done', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'succeeded', lastError: 'not-owner' })).toBe('not-owner');
  });

  it('reduces a terminal failure to the token, never the Salesforce error text', () => {
    // last_error is a SOQL/HTTP dump: org field names, record ids, API internals.
    // The browser gets a reason code; the operator reads the detail in the job row.
    expect(syncErrorForCall(NO_TASK, { status: 'failed', lastError: SOQL_DUMP })).toBe('failed');
    expect(syncErrorForCall(NO_TASK, { status: 'failed', lastError: null })).toBe('failed');
  });

  it('says nothing while the job is still retrying or in flight', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'pending', lastError: SOQL_DUMP })).toBeNull();
    expect(syncErrorForCall(NO_TASK, { status: 'in_flight', lastError: SOQL_DUMP })).toBeNull();
  });

  it('is null for a clean sync and for a call with no job at all', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'succeeded', lastError: null })).toBeNull();
    expect(syncErrorForCall(NO_TASK, undefined)).toBeNull();
  });

  it('reports nothing for a succeeded job whose lastError is not a known skip reason', () => {
    // A stale attempt error left on a job that later succeeded is not a reason
    // the rep can act on — and it is raw Salesforce text.
    expect(syncErrorForCall(NO_TASK, { status: 'succeeded', lastError: SOQL_DUMP })).toBeNull();
  });

  it('says nothing when the Task exists, however the job got there', () => {
    // Jobs written before the success path started clearing lastError still
    // carry the error of an attempt that later succeeded. The call has its Task.
    expect(syncErrorForCall({ salesforceTaskId: '00T1' }, { status: 'succeeded', lastError: 'not-owner' })).toBeNull();
    expect(syncErrorForCall({ salesforceTaskId: '00T1' }, { status: 'failed', lastError: SOQL_DUMP })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clientTaskAllowed — the `taskAllowed` flag on POST /calls.
// `true` lets the SOFTPHONE write the Salesforce Task itself (Open CTI), which
// then posts `skipSalesforceSync: true` — so a `true` here is the one path that
// runs NO server-side gate at all. Unknown ownership must therefore answer
// `false` (the backend writes it instead, gated and retried), never `true`.
// ---------------------------------------------------------------------------
const ME = '005ME';
const snap = (o: Partial<OwnershipSnapshot> = {}): OwnershipSnapshot => ({ type: 'Lead', ownerId: ME, ...o });

describe('clientTaskAllowed', () => {
  it('is true with no round-trip when there is no gated id', async () => {
    const resolveMe = vi.fn(async () => ME);
    const lookup = vi.fn(async () => snap());
    expect(await clientTaskAllowed(undefined, resolveMe, lookup)).toBe(true);
    // A custom object is allowed by the rule outright — not even /users/me.
    expect(await clientTaskAllowed('a01000000000001', resolveMe, lookup)).toBe(true);
    expect(resolveMe).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('is true on a record the rep owns', async () => {
    expect(await clientTaskAllowed('00Q000000000001', async () => ME, async () => snap())).toBe(true);
  });

  it('is false on a record the rep neither owns nor manages', async () => {
    const r = await clientTaskAllowed('006000000000001', async () => ME,
      async () => snap({ type: 'Opportunity', ownerId: '005OTHER', leadManagerId: '005ALSOOTHER' }));
    expect(r).toBe(false);
  });

  it('fails CLOSED when the ownership lookup throws', async () => {
    const onError = vi.fn();
    const r = await clientTaskAllowed('00Q000000000001', async () => ME, async () => { throw new Error('SOQL 503'); }, onError);
    expect(r).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED when resolving the caller\'s own Salesforce user id throws', async () => {
    const lookup = vi.fn(async () => snap());
    const r = await clientTaskAllowed('00Q000000000001', async () => { throw new Error('no connection'); }, lookup);
    expect(r).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// toNumberE164ForCall — the `toNumberE164` field on `GET /calls`'s rows.
// ---------------------------------------------------------------------------
describe('toNumberE164ForCall', () => {
  it('returns normalizedToNumber for a call that carries an audit', () => {
    expect(toNumberE164ForCall({ preCallAuditId: 'audit-1', normalizedToNumber: '+16198481782' }))
      .toBe('+16198481782');
  });

  it('is null for a call with no audit, e.g. an inbound call', () => {
    expect(toNumberE164ForCall({ preCallAuditId: null, normalizedToNumber: '+13235249247' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /calls — recent calls carry the normalized number
// ---------------------------------------------------------------------------
const OUTBOUND_CALL = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'call-1',
  orgId: 'O1',
  userId: 'U1',
  direction: 'outbound',
  status: 'completed',
  fromNumber: '+13235249247',
  toNumber: '6198481782',
  normalizedToNumber: '+16198481782',
  preCallAuditId: 'audit-1',
  disposition: 'Connected',
  salesforceTaskId: null,
  createdAt: new Date('2026-09-01T12:00:00Z'),
  ...over,
});

const INBOUND_CALL = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'call-2',
  orgId: 'O1',
  userId: 'U1',
  direction: 'inbound',
  status: 'completed',
  fromNumber: '+16195551234',
  toNumber: '+13235249247',
  normalizedToNumber: '+13235249247',
  preCallAuditId: null,
  disposition: null,
  salesforceTaskId: null,
  createdAt: new Date('2026-09-01T11:00:00Z'),
  ...over,
});

describe('GET /calls', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    routeState.authedUser = { userId: 'U1', orgId: 'O1', email: 'rep@example.com', isAdmin: false };
    routeState.callRows = [];
    routeState.syncJobRows = [];
    app = Fastify();
    await registerCallRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function recent() {
    return app.inject({ method: 'GET', url: '/calls', headers: { authorization: 'Bearer tok' } });
  }

  it('carries the firewall-normalized destination alongside the raw typed number', async () => {
    routeState.callRows = [OUTBOUND_CALL()];

    const res = await recent();

    expect(res.statusCode).toBe(200);
    const [call] = res.json().calls;
    expect(call.toNumber).toBe('6198481782');
    expect(call.toNumberE164).toBe('+16198481782');
  });

  it('reports null (not a dropped row) for a call with no audit, e.g. inbound', async () => {
    routeState.callRows = [OUTBOUND_CALL(), INBOUND_CALL()];

    const res = await recent();

    const calls = res.json().calls;
    expect(calls).toHaveLength(2);
    const inbound = calls.find((c: { id: string }) => c.id === 'call-2');
    expect(inbound.toNumberE164).toBeNull();
    // Still fully present — not dropped just because it has no audit.
    expect(inbound.toNumber).toBe('+13235249247');
    expect(inbound.direction).toBe('inbound');
  });
});
