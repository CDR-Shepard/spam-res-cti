/**
 * "Preview Sam's email" on Test a record (owner, 2026-10-20): what Sam is told about a tested record (pure), and the
 * preview on real Postgres with a fake writer: org-scoped, ready tests only, charged to the AI budget, and nothing sent,
 * queued or stored.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { EditableCallPlan, RecordTestEmailPreview } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { addSpend, spentTodayMicros } from '../ai/budget.js';
import { renderPlanForAgent } from '../ai-calls/plan-text.js';
import type { EmailDecision, EmailWriter } from '../email/writer.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { ctxOf, seedUser } from '../test/call-plan-seed.js';
import { seedConnection, seedOrg } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { RT_LEAD, RT_OPP } from '../test/record-test-org.js';
import { quiet } from '../test/writeback-harness.js';
import type { RequestContext } from '../tenancy/scope.js';
import { previewTestEmail, testWriterInput } from './email-preview.js';
import { insertRecordTest } from './store.js';

// Tuesday, October 20, 2026: 11:05 AM in Chicago (the default zone), 12:05 PM in New York.
const NOW = new Date('2026-10-20T16:05:00.000Z');
const rendered = renderPlanForAgent(EditableCallPlan.parse(validPlan), NOW);
const PLAN_TEXT = rendered.ok ? rendered.text : '';

type Relation = 'self' | 'contact' | 'converted_contact' | 'account';
const block = (relation: Relation, fields: Record<string, string>) => ({
  relation,
  sfObject: relation === 'self' ? 'Lead' : 'Contact',
  id: `id-${relation}`,
  role: null,
  fields: Object.entries(fields).map(([name, value]) => ({ name, label: name, value })),
});
const research = (sfObject: 'Lead' | 'Opportunity', records: ReturnType<typeof block>[]) => ({
  version: 1, sfObject, sfRecordId: sfObject === 'Lead' ? RT_LEAD : RT_OPP, collectedAt: NOW.toISOString(), consent: 'unknown',
  records, activity: [], sources: [], truncated: false,
});

describe('testWriterInput', () => {
  const OPTS = { now: NOW, companyName: 'GG Homes', phoneFields: ['MobilePhone', 'Phone'] };
  const lead = { sfObject: 'Lead' as const, name: 'Pat Seller', plan: validPlan };

  it("a Lead: the first word of its Name (as a campaign's email), the plan as the agent gets it today, no history, their local time", () => {
    const input = testWriterInput({ ...lead, research: research('Lead', [block('self', { FirstName: 'Patricia', Phone: '(212) 555-0142' })]) }, OPTS);
    expect(input).toEqual({
      mode: 'first', inbound: null, firstName: 'Pat', companyName: 'GG Homes', planText: PLAN_TEXT, history: '',
      localTime: 'Tuesday, October 20, 2026, 12:05 PM',
    });
  });

  it("the plan is rendered as of now, not as of the preview: a last contact reads as long ago as it is today", () => {
    const plan = { ...validPlan, reengagement: { lastContact: 'in early October', lastContactAt: '2026-10-08T18:00:00.000Z', lastContactKind: 'call' as const, lastTopic: 'the roof' } };
    const input = testWriterInput({ ...lead, plan, research: null }, OPTS);
    const today = renderPlanForAgent(EditableCallPlan.parse(plan), NOW);
    expect(today.ok && input.planText).toBe(today.ok ? today.text : 'unrendered');
    const atPreview = renderPlanForAgent(EditableCallPlan.parse(plan), new Date('2026-10-09T18:00:00.000Z'));
    expect(atPreview.ok && atPreview.text).not.toBe(input.planText);
  });

  it('a plan that no longer parses, or that the voice agent could not be given, is no plan', () => {
    expect(testWriterInput({ ...lead, plan: { not: 'a plan' }, research: null }, OPTS).planText).toBeNull();
    expect(testWriterInput({ ...lead, plan: { ...validPlan, opener: 'Tell them we can offer $450,000 today.' }, research: null }, OPTS).planText).toBeNull();
  });

  it("phones in the field map's order on the record, then the contact's: the first that parses sets the zone; none reads Central", () => {
    const self = block('self', { Phone: '(212) 555-0142', MobilePhone: '(415) 555-0100' });
    expect(testWriterInput({ ...lead, research: research('Lead', [self]) }, OPTS).localTime).toBe('Tuesday, October 20, 2026, 9:05 AM');
    expect(testWriterInput({ ...lead, research: research('Lead', [self]) }, { ...OPTS, phoneFields: ['Phone'] }).localTime).toBe('Tuesday, October 20, 2026, 12:05 PM');
    expect(testWriterInput({ ...lead, research: research('Lead', [block('self', { Phone: 'none' })]) }, OPTS).localTime).toBe('Tuesday, October 20, 2026, 11:05 AM');
  });

  it("an Opportunity: the contact's first name, never the deal's Name; its own phone field (Mobile_Phone__c) before the contact's", () => {
    const opp = { sfObject: 'Opportunity' as const, name: '123 Oak Street', plan: validPlan };
    const oppPhones = { ...OPTS, phoneFields: ['Mobile_Phone__c', 'Phone__c'] };
    const records = [block('self', { StageName: 'Closed Lost', Mobile_Phone__c: '(619) 555-0100' }), block('contact', { FirstName: 'Jo Ann', MobilePhone: '+1 212 555 0199' })];
    expect(testWriterInput({ ...opp, research: research('Opportunity', records) }, oppPhones)).toMatchObject({ firstName: 'Jo', localTime: 'Tuesday, October 20, 2026, 9:05 AM' });
    const contactOnly = [block('self', { StageName: 'Closed Lost' }), block('contact', { FirstName: 'Jo Ann', MobilePhone: '+1 212 555 0199' })];
    expect(testWriterInput({ ...opp, research: research('Opportunity', contactOnly) }, oppPhones).localTime).toBe('Tuesday, October 20, 2026, 12:05 PM');
    expect(testWriterInput({ ...opp, research: research('Opportunity', [block('self', { StageName: 'Closed Lost' })]) }, oppPhones).firstName).toBeNull();
  });

  it('research that no longer parses still gives a first email (the name, the default zone)', () => {
    expect(testWriterInput({ ...lead, research: { version: 9 } }, OPTS)).toMatchObject({ firstName: 'Pat', localTime: 'Tuesday, October 20, 2026, 11:05 AM' });
  });
});

const SEND: EmailDecision = { action: 'send', flagReason: null, subject: '  Your home on Oak Street ', body: 'Hi Pat,\r\n\r\nIs the house on Oak Street still for sale?\r\n  ' };
const USAGE = { model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 200 };

describe.skipIf(!pgLane)('previewTestEmail (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function setup(o: { status?: 'running' | 'ready' | 'failed'; settings?: Record<string, unknown> } = {}) {
    const settings = o.settings ?? {};
    const orgId = await seedOrg(db, settings);
    await seedConnection(db, orgId);
    const admin = await seedUser(db, orgId);
    const testId = await insertRecordTest(db, { orgId, requestedBy: admin, sfObject: 'Lead', sfRecordId: RT_LEAD });
    if (o.status !== 'running') {
      await db.update(schema.aiRecordTests)
        // The stored plan text is the preview's; the email is written from the plan rendered again now.
        .set({ status: o.status ?? 'ready', name: 'Pat Seller', plan: validPlan, planText: 'STALE PREVIEW TEXT', research: research('Lead', [block('self', { FirstName: 'Patricia', Phone: '(212) 555-0142' })]), completedAt: NOW })
        .where(eq(schema.aiRecordTests.id, testId));
    }
    const write = vi.fn<EmailWriter['write']>().mockResolvedValue({ decision: SEND, ...USAGE });
    const writer: EmailWriter = { modelId: USAGE.model, write };
    const deps = { db, writer, companyName: 'GG Homes', postalAddress: '18872 MacArthur Blvd #220, Irvine, CA 92612', now: NOW, log: quiet };
    // The route's context carries the tenant row; the budget is read from its settings.
    const ctx = { ...ctxOf(orgId, admin, true), tenant: { settings } } as unknown as RequestContext;
    return { orgId, admin, testId, write, deps, ctx };
  }

  const count = async (table: string, orgId: string): Promise<number> => {
    const result = await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where org_id = ${orgId}::uuid`);
    return (result as unknown as { rows: { n: number }[] }).rows[0]!.n;
  };

  it('writes the first email from the test, charges the AI budget, and sends, queues and stores nothing', async () => {
    const s = await setup();
    const out = await previewTestEmail(s.deps, s.ctx, s.testId);
    expect(out).toEqual({
      ok: true,
      preview: {
        subject: 'Your home on Oak Street',
        // As renderEmail sends it: CRLF to LF, trailing whitespace trimmed.
        body: 'Hi Pat,\n\nIs the house on Oak Street still for sale?',
        footer: '—\nSam\n\nGG Homes · 18872 MacArthur Blvd #220, Irvine, CA 92612\nTo stop hearing from Sam, unsubscribe here',
        issues: [],
      },
    });
    expect(RecordTestEmailPreview.parse(out.ok && out.preview)).toBeTruthy();
    const [prompt] = s.write.mock.calls[0]!;
    expect(prompt.system).toContain('This is the first email to this seller.');
    expect(prompt.user).toContain('First name: Pat\n');
    expect(prompt.user).toContain("Seller's local time: Tuesday, October 20, 2026, 12:05 PM");
    expect(prompt.user).toContain(PLAN_TEXT);
    expect(prompt.user).not.toContain('STALE PREVIEW TEXT');
    expect(prompt.user).toContain('<conversation_history>\n(none)\n</conversation_history>');
    expect(await spentTodayMicros(db, s.orgId, NOW)).toBeGreaterThan(0);
    for (const table of ['email_messages', 'seller_conversations', 'conversation_events', 'crm_records', 'campaign_enrollments']) expect(await count(table, s.orgId)).toBe(0);
  });

  it('a draft that Send would refuse comes back with the reasons, in the words the seller page uses', async () => {
    const s = await setup();
    s.write.mockResolvedValueOnce({ decision: { ...SEND, subject: 'Your home\non Oak Street', body: 'We could pay $450,000 for it.' }, ...USAGE });
    const out = await previewTestEmail(s.deps, s.ctx, s.testId);
    expect(out.ok && out.preview.issues).toEqual(['The subject must be one line.', 'The body has a price or dollar amount; Sam does not quote prices or offers.']);
  });

  it("another tenant's test is not_found and the writer is never asked", async () => {
    const s = await setup();
    const other = await setup();
    expect(await previewTestEmail(s.deps, other.ctx, s.testId)).toEqual({ ok: false, error: 'not_found' });
    expect(s.write).not.toHaveBeenCalled();
  });

  it.each(['running', 'failed'] as const)('a %s test is not_ready', async (status) => {
    const s = await setup({ status });
    expect(await previewTestEmail(s.deps, s.ctx, s.testId)).toEqual({ ok: false, error: 'not_ready' });
    expect(s.write).not.toHaveBeenCalled();
  });

  it("a spent day never reaches the model", async () => {
    const s = await setup({ settings: { aiDailyBudgetUsd: 1 } });
    await addSpend(db, s.orgId, NOW, 1_000_000);
    expect(await previewTestEmail(s.deps, s.ctx, s.testId)).toEqual({ ok: false, error: 'over_budget' });
    expect(s.write).not.toHaveBeenCalled();
  });

  it('Sam declining to write is declined; a model fault is failed', async () => {
    const s = await setup();
    s.write.mockResolvedValueOnce({ decision: { ...SEND, action: 'no_reply', subject: '', body: '' }, ...USAGE });
    expect(await previewTestEmail(s.deps, s.ctx, s.testId)).toEqual({ ok: false, error: 'declined' });
    s.write.mockRejectedValueOnce(new Error('overloaded'));
    expect(await previewTestEmail(s.deps, s.ctx, s.testId)).toEqual({ ok: false, error: 'failed' });
  });
});
