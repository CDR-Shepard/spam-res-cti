/** Real Postgres: versioned research and plans, the plan's do-not-contact triage row, and the reset after a dismissal. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ResearchSource } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { pendingDncFlag } from '../campaigns/dnc-hold.js';
import { reenrollDeselected } from '../campaigns/reenroll.js';
import { assembleSnapshot, ResearchSnapshot } from '../research/snapshot.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { leadId, seedCampaign, seedEnrollment, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { currentPlan, latestResearch, resetCallStageAfterDismiss, savePlan, saveResearch, storeDncTriage, type SavePlanInput } from './store.js';

const NOW = new Date('2026-10-05T15:00:00.000Z');

function researchSnapshot(sfRecordId: string, name = 'Pat Seller'): ResearchSnapshot {
  return assembleSnapshot({
    sfObject: 'Lead',
    sfRecordId,
    collectedAt: NOW,
    consent: 'yes',
    records: [{ relation: 'self', sfObject: 'Lead', id: sfRecordId, role: null, fields: [{ name: 'Name', label: 'Name', value: name }] }],
    activity: [],
    sources: ResearchSource.options.map((source) => ({ source, status: 'ok' as const, count: 0, truncated: false, note: null })),
  });
}

/** Resolves when `release()` is called. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!pgLane)('call plan store (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let n = 0;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function lead(over: Partial<typeof schema.campaignEnrollments.$inferInsert> = {}) {
    n += 1;
    const orgId = await seedOrg(db);
    const campaign = await seedCampaign(db, orgId, { mode: 'ai_call', status: 'active' });
    const sfRecordId = leadId(n);
    const crmRecordId = await seedRecord(db, orgId, snapshot({ sfRecordId }));
    const enrollmentId = await seedEnrollment(db, orgId, campaign.id, crmRecordId, { callStage: 'research', ...over });
    return { orgId, campaignId: campaign.id, sfRecordId, crmRecordId, enrollmentId };
  }
  const planInput = (l: { orgId: string; enrollmentId: string }, researchId: string, over: Partial<SavePlanInput> = {}): SavePlanInput => ({
    orgId: l.orgId,
    enrollmentId: l.enrollmentId,
    researchId,
    source: 'model',
    model: 'claude-sonnet-5-5',
    plan: validPlan,
    dncFlagged: false,
    inputTokens: 12_000,
    outputTokens: 1_500,
    createdBy: null,
    ...over,
  });
  const plansOf = (enrollmentId: string) => db.select().from(schema.callPlans).where(eq(schema.callPlans.enrollmentId, enrollmentId)).orderBy(schema.callPlans.version);
  const enrollment = async (id: string) => (await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, id)))[0]!;

  it('numbers research versions 1 and 2 and stores the snapshot, its sources, size and hash', async () => {
    const l = await lead();
    const s = researchSnapshot(l.sfRecordId);
    const a = await saveResearch(db, { ...l, snapshot: s });
    const b = await saveResearch(db, { ...l, snapshot: researchSnapshot(l.sfRecordId, 'Pat B. Seller') });
    expect([a.version, b.version]).toEqual([1, 2]);
    const [row] = await db.select().from(schema.callResearch).where(eq(schema.callResearch.id, a.id));
    expect(ResearchSnapshot.parse(row!.snapshot)).toEqual(s);
    expect(row).toMatchObject({ orgId: l.orgId, crmRecordId: l.crmRecordId, sources: s.sources, sizeChars: JSON.stringify(s).length });
    expect(row!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores research whose values were cut in the middle of an emoji', async () => {
    const l = await lead();
    const s = assembleSnapshot(
      {
        sfObject: 'Lead',
        sfRecordId: l.sfRecordId,
        collectedAt: NOW,
        consent: 'unknown',
        records: [{ relation: 'self', sfObject: 'Lead', id: l.sfRecordId, role: null, fields: [{ name: 'Name', label: 'Name', value: '😀'.repeat(1_500) }] }],
        activity: [],
        sources: [],
      },
      1_203,
    );
    const saved = await saveResearch(db, { ...l, snapshot: s });
    const [row] = await db.select().from(schema.callResearch).where(eq(schema.callResearch.id, saved.id));
    expect(row!.snapshot).toEqual(s);
  });

  it('gives two concurrent research writers versions 1 and 2 (the loser retries once inside its transaction)', async () => {
    const l = await lead();
    const first = gate();
    const inserted = gate();
    const a = db.transaction(async (tx) => {
      const saved = await saveResearch(tx, { ...l, snapshot: researchSnapshot(l.sfRecordId) });
      inserted.release();
      await first.wait;
      return saved;
    });
    await inserted.wait;
    const b = db.transaction(async (tx) => {
      const saved = await saveResearch(tx, { ...l, snapshot: researchSnapshot(l.sfRecordId, 'B') });
      // The transaction is still usable after the retried unique violation.
      await tx.execute('select 1');
      return saved;
    });
    await pause(200);
    first.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.version, rb.version]).toEqual([1, 2]);
  });

  it('supersedes the current plan when a new version is saved; currentPlan is the newest', async () => {
    const l = await lead();
    const research = await saveResearch(db, { ...l, snapshot: researchSnapshot(l.sfRecordId) });
    const v1 = await savePlan(db, planInput(l, research.id));
    const v2 = await savePlan(db, planInput(l, research.id, { source: 'edit', model: null, inputTokens: 0, outputTokens: 0, plan: { ...validPlan, opener: 'Edited opener' } }));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    const plans = await plansOf(l.enrollmentId);
    expect(plans.map((p) => [p.version, p.status, p.source])).toEqual([
      [1, 'superseded', 'model'],
      [2, 'proposed', 'edit'],
    ]);
    expect(plans[0]).toMatchObject({ model: 'claude-sonnet-5-5', inputTokens: 12_000, outputTokens: 1_500, plan: validPlan, dncFlagged: false });
    const current = await currentPlan(db, l.enrollmentId);
    expect(current).toMatchObject({ id: v2.id, version: 2, status: 'proposed' });
    expect((current!.plan as { opener: string }).opener).toBe('Edited opener');
    expect((await latestResearch(db, l.enrollmentId))?.id).toBe(research.id);
  });

  it('lets only one of two concurrent plan writers win; the other sees the unique violation', async () => {
    const l = await lead();
    const research = await saveResearch(db, { ...l, snapshot: researchSnapshot(l.sfRecordId) });
    await savePlan(db, planInput(l, research.id));
    const first = gate();
    const saved = gate();
    const a = db.transaction(async (tx) => {
      await savePlan(tx, planInput(l, research.id, { source: 'edit', model: null }));
      saved.release();
      await first.wait;
    });
    await saved.wait;
    const b = db.transaction(async (tx) => {
      await savePlan(tx, planInput(l, research.id));
    });
    await pause(200);
    first.release();
    await a;
    await expect(b).rejects.toMatchObject({ code: '23505' });
    const current = (await plansOf(l.enrollmentId)).filter((p) => p.status === 'proposed' || p.status === 'approved');
    expect(current.map((p) => [p.version, p.source])).toEqual([[2, 'edit']]);
  });

  it('has no current plan or research before anything is saved', async () => {
    const l = await lead();
    expect(await currentPlan(db, l.enrollmentId)).toBeNull();
    expect(await latestResearch(db, l.enrollmentId)).toBeNull();
  });

  it('stores a plan flag as a record_triage row that 1A pendingDncFlag reads', async () => {
    const l = await lead();
    const flag = { category: 'sold' as const, quote: 'closed with another buyer in June' };
    const id = await storeDncTriage(db, { orgId: l.orgId, crmRecordId: l.crmRecordId, notesHash: 'h'.repeat(64), model: 'claude-sonnet-5-5', summary: validPlan.situationSummary, flag, inputTokens: 12_000, outputTokens: 1_500 });
    expect(await pendingDncFlag(db, l.crmRecordId)).toEqual({ triageId: id, ...flag });
    const [row] = await db.select().from(schema.recordTriage).where(eq(schema.recordTriage.id, id));
    expect(row).toMatchObject({ orgId: l.orgId, model: 'claude-sonnet-5-5', inputTokens: 12_000, outputTokens: 1_500, result: { summary: validPlan.situationSummary, channels: [], timing: null, tags: [], doNotContact: flag } });
  });

  it('caps the triage summary at 600 characters without splitting an emoji, and fills an empty one', async () => {
    const l = await lead();
    const flag = { category: 'other' as const, quote: 'asked to be left alone' };
    const base = { orgId: l.orgId, crmRecordId: l.crmRecordId, notesHash: 'h', model: 'claude-sonnet-5-5', flag, inputTokens: 1, outputTokens: 1 };
    const long = await storeDncTriage(db, { ...base, summary: `x${'😀'.repeat(400)}` });
    const empty = await storeDncTriage(db, { ...base, summary: '   ' });
    const summaries = await db.select({ id: schema.recordTriage.id, result: schema.recordTriage.result }).from(schema.recordTriage).where(eq(schema.recordTriage.crmRecordId, l.crmRecordId));
    const byId = new Map(summaries.map((s) => [s.id, (s.result as { summary: string }).summary]));
    expect(byId.get(long)).toBe(`x${'😀'.repeat(299)}`);
    expect(byId.get(empty)).toBe('Do-not-contact signal found while researching a call.');
  });

  describe('resetCallStageAfterDismiss', () => {
    it('turns an approved plan back into a proposal and puts the lead back in review', async () => {
      const l = await lead({ callStage: 'approved' });
      const research = await saveResearch(db, { ...l, snapshot: researchSnapshot(l.sfRecordId) });
      const plan = await savePlan(db, planInput(l, research.id));
      const [user] = await db.insert(schema.users).values({ orgId: l.orgId, email: `u${n}@example.com`, displayName: 'Admin' }).returning({ id: schema.users.id });
      await db.update(schema.callPlans).set({ status: 'approved', decidedBy: user!.id, decidedAt: NOW }).where(eq(schema.callPlans.id, plan.id));
      await db.update(schema.campaignEnrollments).set({ callPrepareAttemptedAt: NOW }).where(eq(schema.campaignEnrollments.id, l.enrollmentId));
      await db.transaction((tx) => resetCallStageAfterDismiss(tx, l.enrollmentId));
      expect(await currentPlan(db, l.enrollmentId)).toMatchObject({ id: plan.id, status: 'proposed', decidedBy: null, decidedAt: null });
      expect(await enrollment(l.enrollmentId)).toMatchObject({ callStage: 'review', callPrepareAttemptedAt: null });
    });
    it.each(['proposed', 'approved'] as const)('records the dismisser on a flagged %s plan, and on no other plan', async (status) => {
      const l = await lead({ callStage: status === 'approved' ? 'approved' : 'review' });
      const research = await saveResearch(db, { ...l, snapshot: researchSnapshot(l.sfRecordId) });
      const plan = await savePlan(db, { ...planInput(l, research.id), dncFlagged: true });
      const [user] = await db.insert(schema.users).values({ orgId: l.orgId, email: `u${n}@example.com`, displayName: 'Rita' }).returning({ id: schema.users.id });
      await db.update(schema.callPlans).set({ status }).where(eq(schema.callPlans.id, plan.id));
      await resetCallStageAfterDismiss(db, l.enrollmentId, { userId: user!.id, at: NOW });
      expect(await currentPlan(db, l.enrollmentId)).toMatchObject({ status: 'proposed', dncDismissedBy: user!.id, dncDismissedAt: NOW, decidedBy: null, decidedAt: null });
      const plain = await lead({ callStage: 'review' });
      const r2 = await saveResearch(db, { ...plain, snapshot: researchSnapshot(plain.sfRecordId) });
      await savePlan(db, planInput(plain, r2.id));
      await resetCallStageAfterDismiss(db, plain.enrollmentId, { userId: user!.id, at: NOW });
      expect(await currentPlan(db, plain.enrollmentId)).toMatchObject({ dncDismissedBy: null, dncDismissedAt: null });
    });
    it('sends a lead without a current plan back to research', async () => {
      const l = await lead({ callStage: 'review' });
      await resetCallStageAfterDismiss(db, l.enrollmentId);
      expect((await enrollment(l.enrollmentId)).callStage).toBe('research');
    });
    it.each(['proposed', 'approved'] as const)('M-6: a dismissal does not undo a pending "Research again" (%s plan is still current, stage research stays)', async (status) => {
      const l = await lead({ callStage: 'research' });
      const research = await saveResearch(db, { ...l, snapshot: researchSnapshot(l.sfRecordId) });
      const plan = await savePlan(db, { ...planInput(l, research.id), dncFlagged: true });
      await db.update(schema.callPlans).set({ status }).where(eq(schema.callPlans.id, plan.id));
      await db.update(schema.campaignEnrollments).set({ callPrepareAttemptedAt: NOW }).where(eq(schema.campaignEnrollments.id, l.enrollmentId));
      const [user] = await db.insert(schema.users).values({ orgId: l.orgId, email: `u${n}@example.com`, displayName: 'Rita' }).returning({ id: schema.users.id });
      await resetCallStageAfterDismiss(db, l.enrollmentId, { userId: user!.id, at: NOW });
      // A prepare already claimed for the new research stays claimed.
      expect(await enrollment(l.enrollmentId)).toMatchObject({ callStage: 'research', callPrepareAttemptedAt: NOW });
      expect(await currentPlan(db, l.enrollmentId)).toMatchObject({ status: 'proposed', dncDismissedBy: user!.id });
    });
    it('leaves a done stage and a sequence enrollment (no call stage) alone', async () => {
      const done = await lead({ callStage: 'done' });
      const sequence = await lead({ callStage: null });
      await resetCallStageAfterDismiss(db, done.enrollmentId);
      await resetCallStageAfterDismiss(db, sequence.enrollmentId);
      expect((await enrollment(done.enrollmentId)).callStage).toBe('done');
      expect((await enrollment(sequence.enrollmentId)).callStage).toBeNull();
    });
  });

  describe('a lead re-enrolled after it was deselected (carry-forward CF-3)', () => {
    async function deselectedWithPlan(status: 'proposed' | 'approved') {
      const l = await lead({ callStage: 'approved' });
      const research = await saveResearch(db, { ...l, snapshot: researchSnapshot(l.sfRecordId) });
      const plan = await savePlan(db, planInput(l, research.id));
      await db.update(schema.callPlans).set({ status }).where(eq(schema.callPlans.id, plan.id));
      await db.update(schema.campaignEnrollments).set({ status: 'exited', exitReason: 'deselected' }).where(eq(schema.campaignEnrollments.id, l.enrollmentId));
      await db.insert(schema.campaignSelections).values({ campaignId: l.campaignId, orgId: l.orgId, sfRecordId: l.sfRecordId });
      const back = await reenrollDeselected(db, { campaignId: l.campaignId, touchDays: [0], now: NOW, candidates: [{ enrollmentId: l.enrollmentId, sfRecordId: l.sfRecordId, keys: [`+1512555${String(n).padStart(4, '0')}`] }] });
      expect(back.reenrolled).toBe(1);
      return { ...l, researchId: research.id, planId: plan.id };
    }

    it.each(['proposed', 'approved'] as const)('never offers a %s plan or its research from before the reactivation', async (status) => {
      const l = await deselectedWithPlan(status);
      expect(await enrollment(l.enrollmentId)).toMatchObject({ status: 'active', callStage: 'research' });
      expect(await currentPlan(db, l.enrollmentId)).toBeNull();
      expect(await latestResearch(db, l.enrollmentId)).toBeNull();
      expect((await plansOf(l.enrollmentId)).map((p) => p.status)).toEqual(['superseded']);
    });

    it('a dismissal after the reactivation sends the lead to research, not back to the old plan', async () => {
      const l = await deselectedWithPlan('approved');
      await resetCallStageAfterDismiss(db, l.enrollmentId);
      expect((await enrollment(l.enrollmentId)).callStage).toBe('research');
      expect(await currentPlan(db, l.enrollmentId)).toBeNull();
    });

    it('new research and a new plan after the reactivation continue the versions and are current', async () => {
      const l = await deselectedWithPlan('proposed');
      const research = await saveResearch(db, { ...l, snapshot: researchSnapshot(l.sfRecordId, 'Fresh') });
      const plan = await savePlan(db, planInput(l, research.id));
      expect([research.version, plan.version]).toEqual([2, 2]);
      expect((await currentPlan(db, l.enrollmentId))?.id).toBe(plan.id);
      expect((await latestResearch(db, l.enrollmentId))?.id).toBe(research.id);
    });
  });
});
