/**
 * Real Postgres: Test a record previews (plan 1E Task 3). Research through a scripted, recording Salesforce client, a fake
 * plan model, the 1D practice offer; the row ends `ready` or `failed` with a code, and nothing campaign-shaped is written.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { RecordTest, type CallPlan } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { spentTodayMicros } from '../ai/budget.js';
import { CallPlanOutputError, type CallPlanModel } from '../ai/call-plan-model.js';
import { costMicros } from '../ai/model.js';
import { renderPlanForAgent } from '../ai-calls/plan-text.js';
import { planFacts } from '../call-plans/plan-context.js';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { DescribeCache } from '../research/describe.js';
import { ResearchSnapshot } from '../research/snapshot.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { seedUser } from '../test/call-plan-seed.js';
import { seedConnection, seedOrg } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { FEBRUARY_CALL, recordTestOrg, RT_FIELD_MAP, RT_LEAD, RT_OPP } from '../test/record-test-org.js';
import { GRANT, quiet } from '../test/writeback-harness.js';
import { runPreview, type PreviewDeps } from './preview.js';
import { insertRecordTest, loadRecordTest, toRecordTest } from './store.js';

/** Tue Oct 6, 9:00 AM PT: the default phone hours leave free times today and tomorrow. */
const NOW = new Date('2026-10-06T16:00:00.000Z');
const MODEL = 'claude-sonnet-5-5';
const LEAD = RT_LEAD;
const OPP = RT_OPP;
const FIELD_MAP = RT_FIELD_MAP;
const salesforce = recordTestOrg;

type FakeModel = CallPlanModel & { plan: ReturnType<typeof vi.fn> };
const fakeModel = (plan: CallPlan = validPlan): FakeModel => ({
  modelId: MODEL,
  plan: vi.fn(async () => ({ plan, inputTokens: 12_000, outputTokens: 1_500, model: MODEL })),
});

describe.skipIf(!pgLane)('runPreview (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function tenant(o: { connected?: boolean; sfObject?: 'Lead' | 'Opportunity' } = {}) {
    const orgId = await seedOrg(db);
    await db.update(schema.organizations).set({ name: 'GG Homes' }).where(eq(schema.organizations.id, orgId));
    if (o.connected !== false) await seedConnection(db, orgId, FIELD_MAP);
    const admin = await seedUser(db, orgId, { displayName: 'Ada Admin' });
    const sfObject = o.sfObject ?? 'Lead';
    const testId = await insertRecordTest(db, { orgId, requestedBy: admin, sfObject, sfRecordId: sfObject === 'Lead' ? LEAD : OPP });
    return { orgId, admin, testId };
  }
  const deps = (sf: { client: SalesforceClient }, model: CallPlanModel, over: Partial<PreviewDeps> = {}): PreviewDeps => ({
    db, clients: async () => sf.client, model, describes: new DescribeCache(), now: () => NOW, log: quiet, defaultSpecialists: [GRANT], ...over,
  });
  const stored = async (id: string) => (await db.select().from(schema.aiRecordTests).where(eq(schema.aiRecordTests.id, id)))[0]!;
  const orgCount = async (table: string, orgId: string) =>
    Number(((await db.execute(sql.raw(`select count(*)::int as n from ${table} where org_id = '${orgId}'`))) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);

  it('1: a Lead with history ends ready: the computed last contact wins, the plan text is the rendered plan, spend and tokens stored', async () => {
    const t = await tenant();
    const sf = salesforce({ archived: [FEBRUARY_CALL] });
    const model = fakeModel({ ...validPlan, reengagement: { lastContact: 'in 2024', lastTopic: 'the roof leak' } });
    await runPreview(deps(sf, model), t.testId);
    const row = await stored(t.testId);
    expect(row).toMatchObject({ status: 'ready', error: null, name: 'Pat Seller', model: MODEL, inputTokens: 12_000, outputTokens: 1_500, completedAt: NOW });
    const research = ResearchSnapshot.parse(row.research);
    const plan = row.plan as CallPlan;
    expect(plan.reengagement?.lastContact).toBe(planFacts(research, NOW).lastContactWords);
    expect(plan.reengagement?.lastContact).not.toBe('in 2024');
    expect(plan.reengagement?.lastTopic).toBe('the roof leak');
    const rendered = renderPlanForAgent(plan, NOW);
    expect(rendered.ok).toBe(true);
    expect(row.planText).toBe(rendered.ok ? rendered.text : null);
    expect(row.planTextIssues).toEqual([]);
    expect(row.costMicros).toBe(costMicros(MODEL, 12_000, 1_500));
    expect(row.costMicros).toBeGreaterThan(0);
    expect(await spentTodayMicros(db, t.orgId, NOW)).toBe(row.costMicros);
    const prompt = model.plan.mock.calls[0]![0] as { user: string };
    expect(prompt.user).toContain('Company: GG Homes.');
    const api = toRecordTest({ ...row, requestedByName: 'Ada Admin' }, [], 'https://example.my.salesforce.com');
    expect(RecordTest.parse(api)).toMatchObject({ status: 'ready', consent: 'yes', returning: true, recordUrl: `https://example.my.salesforce.com/${LEAD}` });
  });

  it('2: an Opportunity: sf_object Opportunity, its name, and the consent research read', async () => {
    const t = await tenant({ sfObject: 'Opportunity' });
    await runPreview(deps(salesforce(), fakeModel()), t.testId);
    const row = await stored(t.testId);
    expect(row).toMatchObject({ status: 'ready', sfObject: 'Opportunity', sfRecordId: OPP, name: 'Oak Street' });
    expect(ResearchSnapshot.parse(row.research).consent).toBe('no');
  });

  it('3: booking on with free time: the times, their owner, and no note', async () => {
    const t = await tenant();
    await runPreview(deps(salesforce(), fakeModel()), t.testId);
    const row = await stored(t.testId);
    expect((row.slots as unknown[]).length).toBeGreaterThan(0);
    expect(row.ownerSfUserId).toBe(GRANT);
    expect(row.offerNote).toBeNull();
  });

  it('3b: booking off: no times and the note, still ready', async () => {
    const t = await tenant();
    await runPreview(deps(salesforce(), fakeModel(), { defaultSpecialists: [] }), t.testId);
    expect(await stored(t.testId)).toMatchObject({ status: 'ready', slots: [], offerNote: 'booking_off', ownerSfUserId: null });
  });

  it('4 (G-5): plan text the agent may not get is stored as null with its words, and the preview is still ready', async () => {
    const t = await tenant();
    await runPreview(deps(salesforce(), fakeModel({ ...validPlan, opener: 'Ask whether 300k for the house on Oak Street still works.' })), t.testId);
    const row = await stored(t.testId);
    expect(row.status).toBe('ready');
    expect(row.planText).toBeNull();
    expect(row.planTextIssues).toEqual(['the opener: a price or an amount']);
  });

  it('5: a record Salesforce does not return ends not_found, with no model call and no spend', async () => {
    const t = await tenant();
    const model = fakeModel();
    await runPreview(deps(salesforce({ lead: null }), model), t.testId);
    expect(await stored(t.testId)).toMatchObject({ status: 'failed', error: 'not_found', costMicros: 0 });
    expect(model.plan).not.toHaveBeenCalled();
    expect(await spentTodayMicros(db, t.orgId, NOW)).toBe(0);
  });

  it('6: a model answer that is not a plan ends plan_failed, and its usage is charged', async () => {
    const t = await tenant();
    const usage = { model: MODEL, inputTokens: 9_000, outputTokens: 800 };
    const model: CallPlanModel = { modelId: MODEL, plan: vi.fn(async () => { throw new CallPlanOutputError('bad plan', usage); }) };
    await runPreview(deps(salesforce(), model), t.testId);
    const cost = costMicros(MODEL, 9_000, 800);
    expect(await stored(t.testId)).toMatchObject({ status: 'failed', error: 'plan_failed', costMicros: cost, inputTokens: 9_000, outputTokens: 800 });
    expect(await spentTodayMicros(db, t.orgId, NOW)).toBe(cost);
  });

  it('6b: any other model failure ends plan_failed with no spend', async () => {
    const t = await tenant();
    const model: CallPlanModel = { modelId: MODEL, plan: vi.fn(async () => { throw new Error('overloaded'); }) };
    await runPreview(deps(salesforce(), model), t.testId);
    expect(await stored(t.testId)).toMatchObject({ status: 'failed', error: 'plan_failed', costMicros: 0 });
  });

  it('7: a model that hangs past the injected signal ends timeout', async () => {
    const t = await tenant();
    const model: CallPlanModel = {
      modelId: MODEL,
      plan: (_p, opts) => new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason))),
    };
    await runPreview(deps(salesforce(), model, { signal: () => AbortSignal.timeout(50) }), t.testId);
    expect(await stored(t.testId)).toMatchObject({ status: 'failed', error: 'timeout' });
  });

  it('8: no Salesforce connection (or no field map) ends not_connected', async () => {
    const t = await tenant({ connected: false });
    await runPreview(deps(salesforce(), fakeModel(), { clients: async () => { throw new CrmNotConnectedError(); } }), t.testId);
    expect(await stored(t.testId)).toMatchObject({ status: 'failed', error: 'not_connected' });
    const u = await tenant({ connected: false });
    await runPreview(deps(salesforce(), fakeModel()), u.testId);
    expect(await stored(u.testId)).toMatchObject({ status: 'failed', error: 'not_connected' });
  });

  it('8b: research that throws ends salesforce_error', async () => {
    const t = await tenant();
    const broken = { client: { query: async () => { throw new Error('boom'); }, describe: async () => { throw new Error('boom'); } } as unknown as SalesforceClient };
    await runPreview(deps(broken, fakeModel()), t.testId);
    expect(await stored(t.testId)).toMatchObject({ status: 'failed', error: 'salesforce_error' });
  });

  it('9 (G-1): a ready preview writes no enrollment, touch, call plan, research or CRM record, and sends Salesforce reads only', async () => {
    const t = await tenant();
    const tables = ['campaign_enrollments', 'touches', 'call_plans', 'call_research', 'crm_records', 'sf_writes'];
    const before = await Promise.all(tables.map((x) => orgCount(x, t.orgId)));
    const sf = salesforce({ archived: [FEBRUARY_CALL] });
    await runPreview(deps(sf, fakeModel()), t.testId);
    expect((await stored(t.testId)).status).toBe('ready');
    expect(await Promise.all(tables.map((x) => orgCount(x, t.orgId)))).toEqual(before);
    expect(sf.used.length).toBeGreaterThan(0);
    expect([...new Set(sf.used)].sort()).toEqual(['describe', 'query', 'queryIncludingArchived']);
  });

  it('never runs a row that is not running (a second run of a finished preview changes nothing)', async () => {
    const t = await tenant();
    await runPreview(deps(salesforce(), fakeModel()), t.testId);
    const first = await stored(t.testId);
    const model = fakeModel();
    await runPreview(deps(salesforce(), model), t.testId);
    expect(model.plan).not.toHaveBeenCalled();
    expect(await stored(t.testId)).toEqual(first);
    expect((await loadRecordTest(db, t.orgId, t.testId, NOW))?.requestedByName).toBe('Ada Admin');
  });
});
