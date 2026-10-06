import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CtiClient } from '../ai-calls/cti-client.js';
import type { PracticeError } from '../ai-calls/practice.js';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { registerPracticeCallRoutes } from './practice-calls.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
const practice = vi.hoisted(() => ({
  startPractice: vi.fn(async (): Promise<unknown> => ({ ok: true, response: { result: 'placed', aiCallId: '55555555-5555-4555-8555-555555555555' } })),
  listPracticeCalls: vi.fn(async () => ({ items: [] })),
}));
vi.mock('../ai-calls/practice.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../ai-calls/practice.js')>()), ...practice }));

const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const CAMPAIGN_ID = '44444444-4444-4444-8444-444444444444';
const ENROLLMENT_ID = '66666666-6666-4666-8666-666666666666';
const admin = { userId: 'U-ADMIN', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, userId: 'U-REP', isAdmin: false };
const auth = { authorization: 'Bearer t' };
const cti: CtiClient = {
  trigger: async () => ({ kind: 'transport', error: 'unused' }),
  availability: async () => null,
  browserToken: async () => ({ kind: 'transport', error: 'unused' }),
};

let app: FastifyInstance;
async function build(c: CtiClient | null, campaign: Record<string, unknown> | null = { id: CAMPAIGN_ID, orgId: 'O1', mode: 'ai_call', status: 'active' }) {
  const { db } = fakeDb({ organizations: [ORG], tables: { campaigns: campaign ? [campaign] : [] } });
  return buildApp({
    cfg: testConfig(),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [(scope) => registerPracticeCallRoutes(scope, { db, clients: async () => { throw new Error('unused'); }, cti: c, defaultSpecialists: [] })],
  });
}
const post = (payload: unknown = { version: 2, to: '+15125550111' }, id = ENROLLMENT_ID) =>
  app.inject({ method: 'POST', url: `/api/call-plans/${id}/practice`, headers: auth, payload: payload as Record<string, unknown> });
const list = () => app.inject({ method: 'GET', url: `/api/campaigns/${CAMPAIGN_ID}/practice-calls`, headers: auth });

beforeEach(() => {
  state.session = admin;
  practice.startPractice.mockClear();
  practice.listPracticeCalls.mockClear();
});
afterEach(async () => {
  await app?.close();
});

describe('practice call routes', () => {
  it('401 without a session; 403 for a rep on both, with nothing started', async () => {
    app = await build(cti);
    state.session = null;
    expect((await post()).statusCode).toBe(401);
    expect((await list()).statusCode).toBe(401);
    state.session = rep;
    expect((await post()).statusCode).toBe(403);
    expect((await list()).statusCode).toBe(403);
    expect(practice.startPractice).not.toHaveBeenCalled();
  });

  it('an admin starts one: the enrollment, the body and the context reach startPractice; the answer comes back', async () => {
    app = await build(cti);
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'placed', aiCallId: '55555555-5555-4555-8555-555555555555' });
    expect(practice.startPractice).toHaveBeenCalledWith(
      expect.objectContaining({ cti, defaultSpecialists: [] }),
      expect.objectContaining({ orgId: 'O1' }),
      ENROLLMENT_ID,
      { version: 2, to: '+15125550111' },
    );
  });

  it('a blocked or refused answer is still a 200 with the answer (the page says it in words)', async () => {
    app = await build(cti);
    practice.startPractice.mockResolvedValueOnce({ ok: true, response: { result: 'blocked', reason: 'not_admin_for_test', aiCallId: '55555555-5555-4555-8555-555555555555' } });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: 'blocked', reason: 'not_admin_for_test' });
  });

  it('a bad id or body is 400 and never starts anything', async () => {
    app = await build(cti);
    expect((await post({ version: 2, to: '+15125550111' }, 'nope')).statusCode).toBe(400);
    expect((await post({ version: 0, to: '+15125550111' })).json().code).toBe('INVALID_BODY');
    expect((await post({ version: 1, to: '+15125550111', extra: true })).json().code).toBe('INVALID_BODY');
    expect(practice.startPractice).not.toHaveBeenCalled();
  });

  it('no AI calling configured (null cti) is 503 AI_CALLS_NOT_CONFIGURED', async () => {
    app = await build(null);
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('AI_CALLS_NOT_CONFIGURED');
    expect(practice.startPractice).not.toHaveBeenCalled();
  });

  it.each<[PracticeError, number, string]>([
    ['not_found', 404, 'NOT_FOUND'],
    ['not_ai_call_campaign', 409, 'NOT_AI_CALL_CAMPAIGN'],
    ['no_plan', 409, 'NO_PLAN'],
    ['not_a_test_number', 400, 'NOT_A_TEST_NUMBER'],
    ['cti_unreachable', 502, 'CTI_UNREACHABLE'],
    ['practice_in_progress', 409, 'PRACTICE_IN_PROGRESS'],
  ])('%s is %i %s', async (error, status, code) => {
    app = await build(cti);
    practice.startPractice.mockResolvedValueOnce({ ok: false, error });
    const res = await post();
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it('no_plan says the version is gone; plan_text_rejected is 409 with the words', async () => {
    app = await build(cti);
    practice.startPractice.mockResolvedValueOnce({ ok: false, error: 'no_plan' });
    expect((await post()).json().error).toBe('That plan version is not on the board any more.');
    practice.startPractice.mockResolvedValueOnce({ ok: false, error: 'plan_text_rejected', words: ['the opener: a price or an amount'] });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'PLAN_TEXT_REJECTED', details: { words: ['the opener: a price or an amount'] } });
    expect(res.json().error).toContain('the opener: a price or an amount');
  });

  it('the practice list: an admin reads the campaign\'s; an unknown campaign is 404, a sequence campaign 409', async () => {
    app = await build(cti);
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
    expect(practice.listPracticeCalls).toHaveBeenCalledWith(expect.anything(), 'O1', CAMPAIGN_ID);
    await app.close();
    app = await build(cti, null);
    expect((await list()).statusCode).toBe(404);
    await app.close();
    app = await build(cti, { id: CAMPAIGN_ID, orgId: 'O1', mode: 'sequence', status: 'active' });
    expect((await list()).json().code).toBe('NOT_AI_CALL_CAMPAIGN');
  });
});
