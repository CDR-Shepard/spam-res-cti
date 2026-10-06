import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { InternalAiCallRequest } from '@cti/contracts';
import { schema } from '@cti/db';
import type { CtiClient, TriggerOutcome } from '../ai-calls/cti-client.js';
import { buildApp } from '../app.js';
import { seedAiCall } from '../test/ai-call-seed.js';
import { seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { registerAiCallRoutes } from './ai-calls.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
const query = vi.hoisted(() => ({
  listAiCallResults: vi.fn(async () => ({ items: [], nextCursor: null })),
  loadTranscript: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../ai-calls/results-query.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../ai-calls/results-query.js')>()), ...query }));

const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const CAMPAIGN_ID = '44444444-4444-4444-8444-444444444444';
const AI_CALL_ID = '55555555-5555-4555-8555-555555555555';
const ORG_UUID = 'O1';
const admin = { userId: 'U-ADMIN', orgId: ORG_UUID, email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, userId: 'U-REP', isAdmin: false };
const auth = { authorization: 'Bearer t' };

function fakeCti(outcome: TriggerOutcome = { kind: 'response', response: { result: 'placed', aiCallId: AI_CALL_ID } }) {
  const requests: InternalAiCallRequest[] = [];
  const cti: CtiClient & { availabilityAnswer: { available: boolean; testNumbers: string[] } | null } = {
    availabilityAnswer: { available: true, testNumbers: ['+15125550111'] },
    async trigger(req) {
      requests.push(req);
      return outcome;
    },
    async availability() {
      return cti.availabilityAnswer;
    },
  };
  return { cti, requests };
}

let app: FastifyInstance;
async function build(cti: CtiClient | null, campaign: Record<string, unknown> | null = { id: CAMPAIGN_ID, orgId: 'O1', mode: 'ai_call', status: 'active' }) {
  const { db } = fakeDb({ organizations: [ORG], tables: { campaigns: campaign ? [campaign] : [] } });
  return buildApp({ cfg: testConfig(), readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerAiCallRoutes(scope, { db, cti })] });
}
const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload }) });

beforeEach(() => {
  state.session = admin;
  query.listAiCallResults.mockClear();
  query.loadTranscript.mockClear();
});
afterEach(async () => {
  await app?.close();
});

describe('AI call routes', () => {
  it('401 without a session', async () => {
    app = await build(fakeCti().cti);
    state.session = null;
    for (const [method, url] of [
      ['GET', `/api/campaigns/${CAMPAIGN_ID}/ai-calls`],
      ['GET', `/api/ai-calls/${AI_CALL_ID}/transcript`],
      ['GET', '/api/ai-calls/availability'],
      ['POST', '/api/ai-calls/test'],
      ['POST', `/api/ai-calls/${AI_CALL_ID}/writeback/retry`],
    ] as const) {
      expect((await call(method, url, method === 'POST' ? { to: '+15125550111' } : undefined)).statusCode, url).toBe(401);
    }
  });

  describe('results', () => {
    it('any member lists a campaign\'s results with the cursor', async () => {
      app = await build(null);
      state.session = rep;
      const res = await call('GET', `/api/campaigns/${CAMPAIGN_ID}/ai-calls?cursor=abc`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], nextCursor: null });
      expect(query.listAiCallResults).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: 'O1' }), CAMPAIGN_ID, 'abc');
    });
    it('a sequence campaign is 409, an unknown one 404', async () => {
      app = await build(null, { id: CAMPAIGN_ID, orgId: 'O1', mode: 'sequence', status: 'active' });
      expect((await call('GET', `/api/campaigns/${CAMPAIGN_ID}/ai-calls`)).json().code).toBe('NOT_AI_CALL_CAMPAIGN');
      await app.close();
      app = await build(null, null);
      expect((await call('GET', `/api/campaigns/${CAMPAIGN_ID}/ai-calls`)).statusCode).toBe(404);
      expect(query.listAiCallResults).not.toHaveBeenCalled();
    });
  });

  describe('transcript', () => {
    it('relays the transcript; 403 for a rep who may not read it; 404 for an unknown call or a bad id', async () => {
      app = await build(null);
      const transcript = { aiCallId: AI_CALL_ID, lines: [{ role: 'agent', text: 'Hi', at: null }] };
      query.loadTranscript.mockResolvedValueOnce(transcript);
      expect((await call('GET', `/api/ai-calls/${AI_CALL_ID}/transcript`)).json()).toEqual(transcript);
      query.loadTranscript.mockResolvedValueOnce('forbidden');
      expect((await call('GET', `/api/ai-calls/${AI_CALL_ID}/transcript`)).statusCode).toBe(403);
      query.loadTranscript.mockResolvedValueOnce(null);
      expect((await call('GET', `/api/ai-calls/${AI_CALL_ID}/transcript`)).statusCode).toBe(404);
      expect((await call('GET', '/api/ai-calls/nope/transcript')).statusCode).toBe(404);
    });
  });

  describe('availability', () => {
    it('an admin sees the test numbers', async () => {
      app = await build(fakeCti().cti);
      expect((await call('GET', '/api/ai-calls/availability')).json()).toEqual({ available: true, testNumbers: ['+15125550111'] });
    });
    it('a non-admin never does, even when cti-api lists some', async () => {
      app = await build(fakeCti().cti);
      state.session = rep;
      expect((await call('GET', '/api/ai-calls/availability')).json()).toEqual({ available: true, testNumbers: [] });
    });
    it('not configured: unavailable with no numbers; cti-api unreachable: 503', async () => {
      app = await build(null);
      expect((await call('GET', '/api/ai-calls/availability')).json()).toEqual({ available: false, testNumbers: [] });
      await app.close();
      const { cti } = fakeCti();
      cti.availabilityAnswer = null;
      app = await build(cti);
      const res = await call('GET', '/api/ai-calls/availability');
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('CTI_UNREACHABLE');
    });
  });

  describe('test call', () => {
    it('an admin\'s test call goes to cti-api as a test target with a fresh key, and the answer is relayed', async () => {
      const f = fakeCti();
      app = await build(f.cti);
      const res = await call('POST', '/api/ai-calls/test', { to: '+15125550111' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ result: 'placed', aiCallId: AI_CALL_ID });
      expect(f.requests).toEqual([
        { orgId: 'O1', userId: 'U-ADMIN', idempotencyKey: expect.stringMatching(/^test:[0-9a-f-]{36}$/), target: { kind: 'test', to: '+15125550111', planText: null } },
      ]);
      await call('POST', '/api/ai-calls/test', { to: '+15125550111' });
      expect(f.requests[1]!.idempotencyKey).not.toBe(f.requests[0]!.idempotencyKey);
    });
    it('relays cti-api\'s own refusal (its gate: admin and AI_VOICE_TEST_NUMBERS)', async () => {
      app = await build(fakeCti({ kind: 'response', response: { result: 'blocked', reason: 'not_admin_for_test', aiCallId: AI_CALL_ID } }).cti);
      expect((await call('POST', '/api/ai-calls/test', { to: '+15125559999' })).json()).toEqual({ result: 'blocked', reason: 'not_admin_for_test', aiCallId: AI_CALL_ID });
    });
    it('a non-admin is 403 and nothing is sent', async () => {
      const f = fakeCti();
      app = await build(f.cti);
      state.session = rep;
      expect((await call('POST', '/api/ai-calls/test', { to: '+15125550111' })).statusCode).toBe(403);
      expect(f.requests).toEqual([]);
    });
    it('a transport failure is 502, no CTI configured is 503, a bad body 400', async () => {
      app = await build(fakeCti({ kind: 'transport', error: 'timeout' }).cti);
      const res = await call('POST', '/api/ai-calls/test', { to: '+15125550111' });
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('CTI_UNREACHABLE');
      expect((await call('POST', '/api/ai-calls/test', { to: '1' })).statusCode).toBe(400);
      await app.close();
      app = await build(null);
      const off = await call('POST', '/api/ai-calls/test', { to: '+15125550111' });
      expect(off.statusCode).toBe(503);
      expect(off.json().code).toBe('AI_CALLS_NOT_CONFIGURED');
    });
  });

  describe('write-back retry', () => {
    it('a non-admin is 403; a call id that is not a uuid is 404', async () => {
      app = await build(null);
      state.session = rep;
      expect((await call('POST', `/api/ai-calls/${AI_CALL_ID}/writeback/retry`)).statusCode).toBe(403);
      state.session = admin;
      expect((await call('POST', '/api/ai-calls/nope/writeback/retry')).statusCode).toBe(404);
    });
  });
});

describe.skipIf(!pgLane)('write-back retry (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let pgApp: FastifyInstance;
  beforeAll(async () => {
    t = await createTestDb();
    pgApp = await buildApp({ cfg: testConfig(), readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerAiCallRoutes(scope, { db: t.db, cti: null })] });
  }, 120_000);
  afterAll(async () => {
    await pgApp?.close();
    await t?.drop();
  });

  async function seedRow(status: 'failed' | 'done') {
    const { orgId } = await seedAiCallCampaign(t.db, 'active');
    const userId = await seedUser(t.db, orgId);
    const aiCallId = await seedAiCall(t.db, orgId, userId, { status: 'completed', outcome: 'appointment_set' });
    const steps = { convert: { status: 'done', detail: 'converted' } };
    await t.db.insert(schema.aiCallWritebacks).values({ orgId, aiCallId, sfObject: 'Lead', sfRecordId: '00Q8X00000AbCdEUAV', outcome: 'appointment_set', status, attempts: 6, lastError: 'SalesforceApiError', lockedUntil: new Date(), steps });
    state.session = { ...admin, orgId, userId };
    return { orgId, aiCallId };
  }
  const retry = (aiCallId: string) => pgApp.inject({ method: 'POST', url: `/api/ai-calls/${aiCallId}/writeback/retry`, headers: auth });
  const rowOf = async (aiCallId: string) => (await t.db.select().from(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.aiCallId, aiCallId)))[0]!;

  it('a failed write-back goes back to pending with its attempts reset and its step results kept: 204', async () => {
    const { aiCallId } = await seedRow('failed');
    const before = Date.now();
    const res = await retry(aiCallId);
    expect(res.statusCode).toBe(204);
    const row = await rowOf(aiCallId);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, lockedUntil: null, lastError: null, steps: { convert: { status: 'done', detail: 'converted' } } });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });

  it('a done write-back, or another tenant\'s call, is 409 NOT_RETRYABLE', async () => {
    const { aiCallId } = await seedRow('done');
    const res = await retry(aiCallId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_RETRYABLE');
    const other = await seedRow('failed');
    state.session = { ...admin, orgId: (await seedRow('done')).orgId };
    expect((await retry(other.aiCallId)).statusCode).toBe(409);
    expect((await rowOf(other.aiCallId)).status).toBe('failed');
  });
});
