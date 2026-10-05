import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DecisionError } from '../call-plans/decisions.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { registerCallPlanRoutes } from './call-plans.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
const decisions = vi.hoisted(() => ({
  editPlan: vi.fn(async () => undefined),
  approvePlan: vi.fn(async () => undefined),
  rejectPlan: vi.fn(async () => undefined),
  researchAgain: vi.fn(async () => undefined),
}));
vi.mock('../call-plans/decisions.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../call-plans/decisions.js')>()), ...decisions }));
const release = vi.hoisted(() => ({ releaseApprovedCalls: vi.fn(async () => ({ released: 2, skipped: 1 })) }));
vi.mock('../call-plans/release.js', () => release);
const cards = vi.hoisted(() => ({
  loadCallPlanCards: vi.fn(async () => ({ cards: [], nextCursor: null, counts: { research: 0, review: 0, approved: 0, queued: 0, done: 0 } })),
  loadCallPlanCard: vi.fn(async () => ({ enrollmentId: ENROLLMENT_ID })),
}));
vi.mock('../call-plans/cards.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../call-plans/cards.js')>()), ...cards }));

const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const ENROLLMENT_ID = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN_ID = '44444444-4444-4444-8444-444444444444';
const admin = { userId: 'U-ADMIN', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, userId: 'U-REP', isAdmin: false };
const auth = { authorization: 'Bearer t' };
const EDITABLE = {
  situationSummary: 'Wants to sell.',
  sellingSignals: [],
  opener: 'Ask how the house is.',
  goals: [
    { goal: 'still_selling', known: null, approach: 'Ask' },
    { goal: 'timeline', known: null, approach: 'Ask' },
    { goal: 'condition', known: null, approach: 'Ask' },
    { goal: 'price_expectations', known: null, approach: 'Ask' },
  ],
  talkingPoints: [],
  questions: ['Still selling?'],
  avoid: [],
  bestTimeToCall: { window: 'any', reason: '' },
};

let app: FastifyInstance;
async function build(campaign: Record<string, unknown> | null = { id: CAMPAIGN_ID, orgId: 'O1', mode: 'ai_call', status: 'active' }): Promise<FastifyInstance> {
  const { db } = fakeDb({ organizations: [ORG], tables: { campaigns: campaign ? [campaign] : [] } });
  return buildApp({ cfg: testConfig(), readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerCallPlanRoutes(scope, { db })] });
}
const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: Record<string, unknown>) => app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload }) });

beforeEach(async () => {
  state.session = admin;
  for (const fn of [...Object.values(decisions), ...Object.values(release), ...Object.values(cards)]) fn.mockClear();
  app = await build();
});
afterEach(async () => {
  await app.close();
});

describe('call plan routes', () => {
  it('401 without a session', async () => {
    state.session = null;
    for (const [method, url] of [
      ['GET', `/api/campaigns/${CAMPAIGN_ID}/call-plans`],
      ['PUT', `/api/call-plans/${ENROLLMENT_ID}`],
      ['POST', `/api/call-plans/${ENROLLMENT_ID}/approve`],
      ['POST', `/api/call-plans/${ENROLLMENT_ID}/reject`],
      ['POST', `/api/call-plans/${ENROLLMENT_ID}/research`],
      ['POST', `/api/campaigns/${CAMPAIGN_ID}/ai-calls/release`],
    ] as const) {
      expect((await call(method, url, {})).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('GET lists the board; a bad stage is 400; a sequence campaign is 409; an unknown campaign 404', async () => {
    const ok = await call('GET', `/api/campaigns/${CAMPAIGN_ID}/call-plans?stage=review`);
    expect(ok.statusCode).toBe(200);
    expect(cards.loadCallPlanCards).toHaveBeenCalledWith(expect.anything(), expect.anything(), CAMPAIGN_ID, { cursor: null, stage: 'review', now: expect.any(Date) });
    expect((await call('GET', `/api/campaigns/${CAMPAIGN_ID}/call-plans?stage=bogus`)).statusCode).toBe(400);
    await app.close();
    app = await build({ id: CAMPAIGN_ID, orgId: 'O1', mode: 'sequence', status: 'active' });
    expect((await call('GET', `/api/campaigns/${CAMPAIGN_ID}/call-plans`)).json().code).toBe('NOT_AI_CALL_CAMPAIGN');
    await app.close();
    app = await build(null);
    expect((await call('GET', `/api/campaigns/${CAMPAIGN_ID}/call-plans`)).statusCode).toBe(404);
  });

  it('400 on a bad lead id', async () => {
    expect((await call('POST', '/api/call-plans/not-a-uuid/approve', { version: 1 })).statusCode).toBe(400);
    expect((await call('PUT', '/api/call-plans/not-a-uuid', { version: 1, plan: EDITABLE })).statusCode).toBe(400);
  });

  it('400 on a body that fails the contract, without calling the decision', async () => {
    const bad = await call('PUT', `/api/call-plans/${ENROLLMENT_ID}`, { version: 1, plan: { ...EDITABLE, questions: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('INVALID_BODY');
    expect((await call('POST', `/api/call-plans/${ENROLLMENT_ID}/approve`, { version: 0 })).statusCode).toBe(400);
    expect(decisions.editPlan).not.toHaveBeenCalled();
    expect(decisions.approvePlan).not.toHaveBeenCalled();
  });

  it('400 on a plan that is not plain text (a NUL, a lone surrogate)', async () => {
    for (const opener of ['bad\u0000text', 'cut\ud83d']) {
      const res = await call('PUT', `/api/call-plans/${ENROLLMENT_ID}`, { version: 1, plan: { ...EDITABLE, opener } });
      expect(res.statusCode).toBe(400);
    }
    expect(decisions.editPlan).not.toHaveBeenCalled();
  });

  it('400 on a line break in a single-line field, a bidi override or a zero-width character; a multi-line summary is fine', async () => {
    const bad = [{ opener: 'one\ntwo' }, { opener: 'abc\u202edef' }, { avoid: ['x\u200by'] }, { bestTimeToCall: { window: 'any', reason: 'a\u2028b' } }];
    for (const over of bad) {
      const res = await call('PUT', `/api/call-plans/${ENROLLMENT_ID}`, { version: 1, plan: { ...EDITABLE, ...over } });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_BODY');
    }
    expect(decisions.editPlan).not.toHaveBeenCalled();
    const ok = await call('PUT', `/api/call-plans/${ENROLLMENT_ID}`, { version: 1, plan: { ...EDITABLE, situationSummary: 'First line.\n\nSecond line.' } });
    expect(ok.statusCode).toBe(200);
  });

  it('a valid edit, approve, reject and research each run their decision and answer with the card', async () => {
    const edit = await call('PUT', `/api/call-plans/${ENROLLMENT_ID}`, { version: 1, plan: EDITABLE });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toEqual({ enrollmentId: ENROLLMENT_ID });
    expect(decisions.editPlan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: 'O1' }), ENROLLMENT_ID, { version: 1, plan: EDITABLE }, expect.any(Date));
    expect((await call('POST', `/api/call-plans/${ENROLLMENT_ID}/approve`, { version: 3 })).statusCode).toBe(200);
    expect(decisions.approvePlan).toHaveBeenCalledWith(expect.anything(), expect.anything(), ENROLLMENT_ID, { version: 3 }, expect.any(Date));
    expect((await call('POST', `/api/call-plans/${ENROLLMENT_ID}/reject`)).statusCode).toBe(200);
    expect((await call('POST', `/api/call-plans/${ENROLLMENT_ID}/research`)).statusCode).toBe(200);
    expect(decisions.rejectPlan).toHaveBeenCalledTimes(1);
    expect(decisions.researchAgain).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['PLAN_CHANGED', 409],
    ['NO_AI_CONSENT', 409],
    ['CONSENT_UNKNOWN', 409],
    ['DNC_PENDING', 409],
    ['DNC_NOT_DISMISSED', 409],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
  ] as const)('a thrown DecisionError %s answers %i with its code and words', async (code, status) => {
    decisions.approvePlan.mockRejectedValueOnce(new DecisionError(code));
    const res = await call('POST', `/api/call-plans/${ENROLLMENT_ID}/approve`, { version: 1 });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code, error: expect.any(String) });
  });

  it('an unexpected error is not turned into a decision error', async () => {
    decisions.approvePlan.mockRejectedValueOnce(new Error('boom'));
    expect((await call('POST', `/api/call-plans/${ENROLLMENT_ID}/approve`, { version: 1 })).statusCode).toBe(500);
  });

  it('release is admin only (403 for a rep) and returns the counts', async () => {
    state.session = rep;
    expect((await call('POST', `/api/campaigns/${CAMPAIGN_ID}/ai-calls/release`)).statusCode).toBe(403);
    expect(release.releaseApprovedCalls).not.toHaveBeenCalled();
    state.session = admin;
    const res = await call('POST', `/api/campaigns/${CAMPAIGN_ID}/ai-calls/release`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ released: 2, skipped: 1 });
  });

  it('release maps a refused campaign to 409 with its code', async () => {
    release.releaseApprovedCalls.mockRejectedValueOnce(new DecisionError('CAMPAIGN_NOT_ACTIVE'));
    const res = await call('POST', `/api/campaigns/${CAMPAIGN_ID}/ai-calls/release`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CAMPAIGN_NOT_ACTIVE');
  });
});
