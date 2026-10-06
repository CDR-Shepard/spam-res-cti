import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RecordTest, type CallPlan } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { CallPlanModel } from '../ai/call-plan-model.js';
import { buildApp } from '../app.js';
import { DescribeCache } from '../research/describe.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { seedUser } from '../test/call-plan-seed.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { seedConnection, seedOrg } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { recordTestOrg, RT_FIELD_MAP, RT_LEAD, RT_OPP } from '../test/record-test-org.js';
import { GRANT } from '../test/writeback-harness.js';
import { registerRecordTestRoutes, type RecordTestRouteDeps } from './record-tests.js';

/** `unit` answers the store, limits, preview and connection from the fakes below; `pg` runs the real modules. */
const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null, mode: 'unit' as 'unit' | 'pg' }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
const unitDefaults = vi.hoisted(() => ({
  insertRecordTest: async (): Promise<unknown> => 'unused',
  loadRecordTest: async (): Promise<unknown> => null,
  listRecordTests: async (): Promise<unknown> => ({ items: [] }),
  withPreviewLimit: async (): Promise<unknown> => ({ ok: true, value: '77777777-7777-4777-8777-777777777777' }),
  runPreview: async (): Promise<unknown> => undefined,
  loadConnection: async (): Promise<unknown> => ({ instanceUrl: 'https://example.my.salesforce.com', fieldMap: null }),
}));
const unit = vi.hoisted(() => ({}) as Record<string, (...a: unknown[]) => Promise<unknown>>);
/** Each mocked function dispatches on state.mode, so one file holds both the unit and the real-Postgres cases. */
function dispatching<M extends Record<string, unknown>>(actual: M, names: Array<keyof typeof unitDefaults & keyof M>): M {
  const out: Record<string, unknown> = { ...actual };
  for (const name of names) {
    const real = actual[name] as (...a: unknown[]) => unknown;
    // unit[name] is read at call time, so a test can swap a fake for the rest of that test.
    out[name as string] = vi.fn((...a: unknown[]) => (state.mode === 'pg' ? real(...a) : (unit[name] as (...b: unknown[]) => unknown)(...a)));
  }
  return out as M;
}
vi.mock('../record-tests/store.js', async (importOriginal) =>
  dispatching(await importOriginal<typeof import('../record-tests/store.js')>(), ['insertRecordTest', 'loadRecordTest', 'listRecordTests']),
);
vi.mock('../record-tests/limits.js', async (importOriginal) => dispatching(await importOriginal<typeof import('../record-tests/limits.js')>(), ['withPreviewLimit']));
vi.mock('../record-tests/preview.js', async (importOriginal) => dispatching(await importOriginal<typeof import('../record-tests/preview.js')>(), ['runPreview']));
vi.mock('../crm/connection-store.js', async (importOriginal) => dispatching(await importOriginal<typeof import('../crm/connection-store.js')>(), ['loadConnection']));

const store = vi.mocked(await import('../record-tests/store.js'));
const limits = vi.mocked(await import('../record-tests/limits.js'));
const preview = vi.mocked(await import('../record-tests/preview.js'));
const connections = vi.mocked(await import('../crm/connection-store.js'));

const MODEL = 'claude-sonnet-5-5';
const TEST_ID = '77777777-7777-4777-8777-777777777777';
const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
const admin = { userId: '22222222-2222-4222-8222-222222222222', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, isAdmin: false };
const auth = { authorization: 'Bearer t' };
const model = (modelId = MODEL, plan: CallPlan = validPlan): CallPlanModel => ({
  modelId,
  plan: vi.fn(async () => ({ plan, inputTokens: 12_000, outputTokens: 1_500, model: MODEL })),
});

let app: FastifyInstance;
let pending: Array<() => Promise<void>> = [];
const background = (work: () => Promise<void>) => {
  pending.push(work);
};
async function build(db: Db, over: Partial<RecordTestRouteDeps> = {}) {
  return buildApp({
    cfg: testConfig(),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [
      (scope) =>
        registerRecordTestRoutes(scope, {
          db, clients: async () => recordTestOrg().client, cti: null, model: model(), describes: new DescribeCache(),
          defaultSpecialists: [GRANT], background, ...over,
        }),
    ],
  });
}
const post = (record: unknown) => app.inject({ method: 'POST', url: '/api/record-tests', headers: auth, payload: { record } as Record<string, unknown> });
const getOne = (id: string) => app.inject({ method: 'GET', url: `/api/record-tests/${id}`, headers: auth });
const getList = () => app.inject({ method: 'GET', url: '/api/record-tests', headers: auth });

afterEach(async () => {
  await app?.close();
});

describe('Test a record routes', () => {
  beforeEach(() => {
    state.mode = 'unit';
    state.session = admin;
    pending = [];
    Object.assign(unit, unitDefaults);
    vi.clearAllMocks();
  });
  const unitApp = (over: Partial<RecordTestRouteDeps> = {}) => build(fakeDb({ organizations: [ORG] }).db, over);
  const connected = () => {
    unit.loadConnection = async () => ({ instanceUrl: 'https://example.my.salesforce.com', fieldMap: RT_FIELD_MAP });
  };

  it('1: a rep gets 403 on every route, and nothing starts', async () => {
    app = await unitApp();
    state.session = rep;
    expect((await post(RT_LEAD)).statusCode).toBe(403);
    expect((await getList()).statusCode).toBe(403);
    expect((await getOne(TEST_ID)).statusCode).toBe(403);
    expect(limits.withPreviewLimit).not.toHaveBeenCalled();
    state.session = null;
    expect((await post(RT_LEAD)).statusCode).toBe(401);
  });

  it("2 (G-8): another org's test, or an id that is not a uuid, is 404", async () => {
    app = await unitApp();
    expect((await getOne(TEST_ID)).statusCode).toBe(404);
    expect(store.loadRecordTest).toHaveBeenCalledWith(expect.anything(), 'O1', TEST_ID, expect.any(Date));
    const bad = await getOne('nope');
    expect(bad.statusCode).toBe(404);
    expect(bad.json().code).toBe('NOT_FOUND');
  });

  it.each([
    ['an Account Id', '001D000000IqhSLIAZ', 'Only Leads (00Q…) and Opportunities (006…) can be tested.'],
    ['no Id at all', 'https://x.lightning.force.com/lightning/page/home', "That isn't a Salesforce Lead or Opportunity Id or link."],
    ['a body too short to hold an Id', 'hello', "That isn't a Salesforce Lead or Opportunity Id or link."],
    ['a bad checksum', '00Q8X00001AbCdEAAA', "That Id's last three characters don't match. Copy it again from Salesforce."],
  ])('3: %s is 400 INVALID_RECORD with the words', async (_label, record, words) => {
    app = await unitApp();
    connected();
    const res = await post(record);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_RECORD', error: words });
    expect(limits.withPreviewLimit).not.toHaveBeenCalled();
  });

  it('4: no plan model, or one with no price, is 503 AI_CALLS_NOT_CONFIGURED', async () => {
    connected();
    app = await unitApp({ model: null });
    expect((await post(RT_LEAD)).json()).toMatchObject({ code: 'AI_CALLS_NOT_CONFIGURED' });
    await app.close();
    app = await unitApp({ model: model('claude-unpriced-9') });
    const res = await post(RT_LEAD);
    expect(res.statusCode).toBe(503);
    expect(limits.withPreviewLimit).not.toHaveBeenCalled();
  });

  it('4b: no Salesforce connection (or no usable field map) is 409 NOT_CONNECTED', async () => {
    app = await unitApp();
    connections.loadConnection.mockResolvedValueOnce(null);
    expect((await post(RT_LEAD)).json()).toMatchObject({ code: 'NOT_CONNECTED' });
    // The default fake connection has no field map.
    const res = await post(RT_LEAD);
    expect(res.statusCode).toBe(409);
    expect(limits.withPreviewLimit).not.toHaveBeenCalled();
  });

  it('5: a refused limit: 429 RATE_LIMITED with retryAt; 409 PREVIEW_RUNNING and AI_BUDGET_SPENT', async () => {
    app = await unitApp();
    connected();
    const retryAt = new Date('2026-10-06T22:42:00.000Z');
    limits.withPreviewLimit.mockResolvedValueOnce({ ok: false, refusal: { code: 'RATE_LIMITED', retryAt, limit: 'previews_per_hour' } });
    const limited = await post(RT_LEAD);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED', details: { retryAt: retryAt.toISOString() } });
    expect(limited.json().error).toBe("You've run 10 previews in the last hour. Try again at 3:42 PM PT.");
    limits.withPreviewLimit.mockResolvedValueOnce({ ok: false, refusal: { code: 'PREVIEW_RUNNING' } });
    expect((await post(RT_LEAD)).json()).toMatchObject({ code: 'PREVIEW_RUNNING' });
    limits.withPreviewLimit.mockResolvedValueOnce({ ok: false, refusal: { code: 'AI_BUDGET_SPENT' } });
    const spent = await post(RT_LEAD);
    expect(spent.statusCode).toBe(409);
    expect(spent.json().code).toBe('AI_BUDGET_SPENT');
    expect(pending).toHaveLength(0);
  });

  it('6: an admin starts a preview: 202 { id }, the limit got the record, and the preview runs in the background', async () => {
    app = await unitApp();
    connected();
    const res = await post(`https://x.lightning.force.com/lightning/r/Opportunity/${RT_OPP}/view`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: TEST_ID });
    expect(limits.withPreviewLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: 'O1', userId: admin.userId }), expect.any(Function));
    expect(preview.runPreview).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    await pending[0]!();
    expect(preview.runPreview).toHaveBeenCalledWith(expect.objectContaining({ defaultSpecialists: [GRANT] }), TEST_ID);
  });

  it('8: the list is passed through', async () => {
    app = await unitApp();
    const items = [{ id: TEST_ID, sfObject: 'Lead', sfRecordId: RT_LEAD, name: null, status: 'running', createdAt: '2026-10-06T16:00:00.000Z', requestedByName: null }];
    store.listRecordTests.mockResolvedValueOnce({ items } as never);
    expect((await getList()).json()).toEqual({ items });
    expect(store.listRecordTests).toHaveBeenCalledWith(expect.anything(), 'O1', expect.any(Date));
  });
});

describe.skipIf(!pgLane)('Test a record routes (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(() => {
    state.mode = 'pg';
    pending = [];
  });
  async function tenant() {
    const orgId = await seedOrg(t.db);
    await seedConnection(t.db, orgId, RT_FIELD_MAP);
    const userId = await seedUser(t.db, orgId, { displayName: 'Ada Admin' });
    state.session = { ...admin, userId, orgId };
    return { orgId, userId };
  }

  it('6, 7: POST answers 202 at once; GET reads it running, then ready with the plan text, times, consent and words', async () => {
    await tenant();
    app = await build(t.db);
    const res = await post(RT_LEAD);
    expect(res.statusCode).toBe(202);
    const { id } = res.json() as { id: string };
    const running = await getOne(id);
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({ id, status: 'running', sfObject: 'Lead', sfRecordId: RT_LEAD, requestedByName: 'Ada Admin', calls: [] });
    await Promise.all(pending.map((w) => w()));
    const ready = RecordTest.parse((await getOne(id)).json());
    expect(ready).toMatchObject({ status: 'ready', error: null, name: 'Pat Seller', consent: 'yes', planTextWords: [], recordUrl: `https://example.my.salesforce.com/${RT_LEAD}` });
    expect(ready.planText).toContain('Opener: Ask whether the family has decided');
    expect(ready.slots.length).toBeGreaterThan(0);
    expect(ready.costMicros).toBeGreaterThan(0);
  });

  it("2 (G-8), 8: the list is this tenant's, newest first; another tenant's test is 404", async () => {
    const a = await tenant();
    app = await build(t.db);
    const first = (await post(RT_LEAD)).json().id as string;
    await Promise.all(pending.map((w) => w()));
    const second = (await post(RT_OPP)).json().id as string;
    const list = (await getList()).json() as { items: Array<{ id: string }> };
    expect(list.items.map((i) => i.id)).toEqual([second, first]);
    await tenant();
    expect((await getOne(first)).statusCode).toBe(404);
    expect((await getList()).json()).toEqual({ items: [] });
    state.session = { ...admin, userId: a.userId, orgId: a.orgId };
    expect((await getOne(randomUUID())).statusCode).toBe(404);
  });
});
