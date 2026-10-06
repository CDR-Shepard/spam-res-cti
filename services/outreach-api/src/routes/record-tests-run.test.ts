/**
 * Test a record, running the call (plan 1E Task 8): the browser token relay and POST /api/record-tests/:id/calls, admins
 * only. startRecordTestCall and the store are replaced (their SQL runs on the Postgres lane in record-tests/run.test.ts);
 * cti-api is a fake CtiClient. The token is never logged (G-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BrowserTokenResponse } from '@cti/contracts';
import type { BrowserTokenOutcome, CtiClient } from '../ai-calls/cti-client.js';
import { buildApp } from '../app.js';
import { DescribeCache } from '../research/describe.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { GRANT } from '../test/writeback-harness.js';
import { registerRecordTestRoutes } from './record-tests.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
vi.mock('../record-tests/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../record-tests/run.js')>()),
  startRecordTestCall: vi.fn(),
}));
vi.mock('../record-tests/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../record-tests/store.js')>()),
  loadRecordTest: vi.fn(async () => null),
  loadRecordTestCalls: vi.fn(async () => []),
}));
vi.mock('../crm/connection-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../crm/connection-store.js')>()),
  loadConnection: vi.fn(async () => ({ instanceUrl: 'https://example.my.salesforce.com' })),
}));
const run = vi.mocked(await import('../record-tests/run.js'));
const store = vi.mocked(await import('../record-tests/store.js'));

const TEST_ID = '77777777-7777-4777-8777-777777777777';
const CALL_ID = '88888888-8888-4888-8888-888888888888';
const AI_CALL = '99999999-9999-4999-8999-999999999999';
const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
const admin = { userId: '22222222-2222-4222-8222-222222222222', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, isAdmin: false };
const IDENTITY = `aitest_${admin.userId.replace(/-/g, '')}_a1b2c3d4e5f6`;
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJncmFudHMiOnt9fQ.U0VDUkVUU0lHTkFUVVJF';
const MINTED = { token: TOKEN, identity: IDENTITY, expiresAt: '2026-10-06T18:20:00.000Z' };
const auth = { authorization: 'Bearer t' };

let app: FastifyInstance;
let lines: string[];
let tokenAnswer: BrowserTokenOutcome;
const cti = {
  trigger: vi.fn(),
  availability: vi.fn(),
  browserToken: vi.fn(async () => tokenAnswer),
} satisfies CtiClient;

async function build(over: { cti?: CtiClient | null } = {}) {
  return buildApp({
    cfg: testConfig({ NODE_ENV: 'development' }),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    logStream: { write: (line) => lines.push(line) },
    apiRoutes: [
      (scope) =>
        registerRecordTestRoutes(scope, {
          db: fakeDb({ organizations: [ORG] }).db, clients: async () => { throw new Error('unused'); },
          cti: over.cti === undefined ? cti : over.cti, model: null, describes: new DescribeCache(), defaultSpecialists: [GRANT],
        }),
    ],
  });
}
const tokenPost = (remoteAddress?: string) =>
  app.inject({ method: 'POST', url: '/api/record-tests/browser-token', headers: auth, ...(remoteAddress ? { remoteAddress } : {}) });
const callPost = (payload: Record<string, unknown>, id = TEST_ID) =>
  app.inject({ method: 'POST', url: `/api/record-tests/${id}/calls`, headers: auth, payload });

beforeEach(async () => {
  state.session = admin;
  lines = [];
  tokenAnswer = { kind: 'token', ...MINTED };
  vi.clearAllMocks();
  run.startRecordTestCall.mockResolvedValue({ ok: true, callId: CALL_ID, response: { result: 'placed', aiCallId: AI_CALL } });
  app = await build();
});
afterEach(async () => {
  await app?.close();
});

describe('POST /api/record-tests/browser-token', () => {
  it('16: a rep gets 403 and no token is asked for', async () => {
    state.session = rep;
    expect((await tokenPost()).statusCode).toBe(403);
    expect((await callPost({ mode: 'browser', identity: IDENTITY })).statusCode).toBe(403);
    expect(cti.browserToken).not.toHaveBeenCalled();
    expect(run.startRecordTestCall).not.toHaveBeenCalled();
  });

  it('17: an admin gets the relayed token, no-store, for their own user', async () => {
    const res = await tokenPost();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(BrowserTokenResponse.parse(res.json())).toEqual(MINTED);
    expect(cti.browserToken).toHaveBeenCalledWith({ orgId: 'O1', userId: admin.userId });
  });

  it.each([
    [{ kind: 'refused', code: 'browser_calls_unavailable' }, 503, 'BROWSER_CALLS_UNAVAILABLE'],
    [{ kind: 'refused', code: 'not_admin' }, 403, 'FORBIDDEN'],
    [{ kind: 'refused', code: 'unknown_user' }, 403, 'FORBIDDEN'],
    [{ kind: 'transport', error: 'timeout' }, 502, 'CTI_UNREACHABLE'],
  ] as const)('18: cti-api answering %j is %i %s', async (answer, status, code) => {
    tokenAnswer = answer;
    const res = await tokenPost();
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it("18 (E-3): an admin the calling service doesn't know in this tenant (a super admin acting on another) is told so, not that only admins may", async () => {
    tokenAnswer = { kind: 'refused', code: 'unknown_user' };
    expect((await tokenPost()).json().error).toBe("Talk in browser only works in your own tenant: the calling service doesn't know you here. Use Ring my phone.");
    tokenAnswer = { kind: 'refused', code: 'not_admin' };
    expect((await tokenPost()).json().error).toBe('Only an admin can take a test call in the browser.');
  });

  it('18: no cti-api client configured is 503 AI_CALLS_NOT_CONFIGURED', async () => {
    await app.close();
    app = await build({ cti: null });
    const res = await tokenPost();
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('AI_CALLS_NOT_CONFIGURED');
  });

  it('19: the token never reaches the log', async () => {
    await tokenPost();
    await app.close();
    const log = lines.join('');
    expect(log).toContain('/api/record-tests/browser-token');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('U0VDUkVUU0lHTkFUVVJF');
    expect(log).not.toContain(IDENTITY);
  });

  it('carries its own limiter: 10 a minute from one address', async () => {
    for (let i = 0; i < 10; i += 1) expect((await tokenPost('10.0.0.9')).statusCode).toBe(200);
    expect((await tokenPost('10.0.0.9')).statusCode).toBe(429);
  });
});

describe('POST /api/record-tests/:id/calls', () => {
  it('a placed call answers 200 { callId, response } and runs as the session admin', async () => {
    const res = await callPost({ mode: 'phone', to: '+15125550111' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ callId: CALL_ID, response: { result: 'placed', aiCallId: AI_CALL } });
    const [, ctx, id, body] = run.startRecordTestCall.mock.calls[0]!;
    expect(ctx.session.userId).toBe(admin.userId);
    expect(id).toBe(TEST_ID);
    expect(body).toEqual({ mode: 'phone', to: '+15125550111' });
  });

  it.each([
    [{ ok: false, error: 'not_found' }, 404, 'NOT_FOUND'],
    [{ ok: false, error: 'not_ready' }, 409, 'NOT_READY'],
    [{ ok: false, error: 'not_a_test_number' }, 400, 'NOT_A_TEST_NUMBER'],
    [{ ok: false, error: 'not_your_browser' }, 403, 'NOT_YOUR_BROWSER'],
    [{ ok: false, error: 'cti_unreachable' }, 502, 'CTI_UNREACHABLE'],
    [{ ok: false, refusal: { code: 'CALL_IN_PROGRESS' } }, 409, 'CALL_IN_PROGRESS'],
    [{ ok: false, refusal: { code: 'RATE_LIMITED', retryAt: new Date('2026-10-06T22:42:00.000Z'), limit: 'calls_per_hour' } }, 429, 'RATE_LIMITED'],
  ] as const)('18: %j is %i %s', async (result, status, code) => {
    run.startRecordTestCall.mockResolvedValueOnce(result as never);
    const res = await callPost({ mode: 'browser', identity: IDENTITY });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it('18: plan text rejected is 409 PLAN_TEXT_REJECTED with the words', async () => {
    run.startRecordTestCall.mockResolvedValueOnce({ ok: false, error: 'plan_text_rejected', words: ['the opener: a price or an amount'] });
    const res = await callPost({ mode: 'phone', to: '+15125550111' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'PLAN_TEXT_REJECTED', details: { words: ['the opener: a price or an amount'] } });
  });

  it('a body that is neither mode, or an id that is not a uuid, is refused before anything runs', async () => {
    expect((await callPost({ mode: 'browser', identity: 'rep_abc' })).statusCode).toBe(400);
    expect((await callPost({ mode: 'phone', to: '+15125550111' }, 'nope')).statusCode).toBe(404);
    expect(run.startRecordTestCall).not.toHaveBeenCalled();
  });

  it('no cti-api client configured is 503 AI_CALLS_NOT_CONFIGURED', async () => {
    await app.close();
    app = await build({ cti: null });
    expect((await callPost({ mode: 'phone', to: '+15125550111' })).json().code).toBe('AI_CALLS_NOT_CONFIGURED');
    expect(run.startRecordTestCall).not.toHaveBeenCalled();
  });
});

describe('GET /api/record-tests/:id', () => {
  it('carries the test\'s calls, read org-scoped', async () => {
    const row = {
      id: TEST_ID, orgId: 'O1', requestedBy: admin.userId, sfObject: 'Lead', sfRecordId: '00Q8X00001AbCdEUAV', status: 'ready', error: null,
      name: 'Pat Seller', research: null, plan: null, planText: null, planTextIssues: [], slots: [], offerNote: null, ownerSfUserId: null,
      model: null, inputTokens: 0, outputTokens: 0, costMicros: 0, createdAt: new Date('2026-10-06T16:00:00.000Z'), completedAt: null,
      requestedByName: 'Ada Admin',
    };
    const call = {
      id: CALL_ID, mode: 'browser', toE164: null, createdAt: '2026-10-06T16:05:00.000Z', aiCallId: AI_CALL, result: { result: 'placed', aiCallId: AI_CALL },
      callStatus: 'completed', outcome: 'appointment_set', summary: 'Booked.', durationSeconds: 90, callbackAt: null, qualification: {}, appointment: null, dryRun: null,
    };
    store.loadRecordTest.mockResolvedValueOnce(row as never);
    store.loadRecordTestCalls.mockResolvedValueOnce([call] as never);
    const res = await app.inject({ method: 'GET', url: `/api/record-tests/${TEST_ID}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().calls).toEqual([call]);
    expect(store.loadRecordTestCalls).toHaveBeenCalledWith(expect.anything(), 'O1', TEST_ID);
  });
});
