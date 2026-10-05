/** Real Postgres: approve, edit, reject and research again. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { ctxOf, seedAiCallCampaign, seedPlanLead, seedUser, SEED_NOW, type PlanLead } from '../test/call-plan-seed.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { DecisionError, PLAN_REJECTED_EXIT_REASON, approvePlan, editPlan, rejectPlan, researchAgain, type DecisionCode } from './decisions.js';
import { currentPlan } from './store.js';

const { doNotContact: _omit, ...EDITABLE } = validPlan;
const OWNER = '005000000000001AAA';
const OWNER_15 = '005000000000001';

describe.skipIf(!pgLane)('call plan decisions (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function setup(o: Parameters<typeof seedPlanLead>[2] = {}) {
    const base = await seedAiCallCampaign(db);
    const admin = await seedUser(db, base.orgId);
    const lead = await seedPlanLead(db, base, { ownerSfUserId: OWNER, ...o });
    return { ...base, admin, lead, ctx: ctxOf(base.orgId, admin, true) };
  }
  const code = async (p: Promise<unknown>): Promise<{ code: DecisionCode; status: number } | null> =>
    p.then(
      () => null,
      (err) => {
        if (err instanceof DecisionError) return { code: err.code, status: err.status };
        throw err;
      },
    );
  const enrollment = async (id: string) => (await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, id)))[0]!;
  const plans = (enrollmentId: string) => db.select().from(schema.callPlans).where(eq(schema.callPlans.enrollmentId, enrollmentId)).orderBy(schema.callPlans.version);
  const flagTriage = (orgId: string, recordId: string) =>
    db
      .execute(sql`
        insert into record_triage (org_id, crm_record_id, notes_hash, model, result, input_tokens, output_tokens)
        values (${orgId}::uuid, ${recordId}::uuid, 'h', 'm', ${JSON.stringify({ summary: 's', channels: [], timing: null, tags: [], doNotContact: { category: 'attorney', quote: 'Talk to my lawyer' } })}::jsonb, 1, 1)
        returning id`)
      .then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows[0]!.id);
  const approve = (s: { ctx: ReturnType<typeof ctxOf>; lead: PlanLead }, version = 1) => approvePlan(db, s.ctx, s.lead.enrollmentId, { version }, SEED_NOW);

  describe('approve', () => {
    it('1: the owner (a rep) approves: the plan is approved by them and the lead is approved', async () => {
      const s = await setup();
      const rep = await seedUser(db, s.orgId, { sfUserId: OWNER_15 });
      await approvePlan(db, ctxOf(s.orgId, rep, false), s.lead.enrollmentId, { version: 1 }, SEED_NOW);
      const [plan] = await plans(s.lead.enrollmentId);
      expect(plan).toMatchObject({ status: 'approved', decidedBy: rep });
      expect(plan!.decidedAt).toEqual(SEED_NOW);
      expect((await enrollment(s.lead.enrollmentId)).callStage).toBe('approved');
    });

    it('2: a rep who does not own the record is refused and nothing changes', async () => {
      const s = await setup();
      const rep = await seedUser(db, s.orgId, { sfUserId: '005000000000099' });
      expect(await code(approvePlan(db, ctxOf(s.orgId, rep, false), s.lead.enrollmentId, { version: 1 }, SEED_NOW))).toEqual({ code: 'FORBIDDEN', status: 403 });
      expect((await plans(s.lead.enrollmentId))[0]!.status).toBe('proposed');
      expect((await enrollment(s.lead.enrollmentId)).callStage).toBe('review');
    });

    it("3: approving a version that an edit replaced is PLAN_CHANGED", async () => {
      const s = await setup();
      await editPlan(db, s.ctx, s.lead.enrollmentId, { version: 1, plan: EDITABLE }, SEED_NOW);
      expect(await code(approve(s, 1))).toEqual({ code: 'PLAN_CHANGED', status: 409 });
    });

    it.each([
      ['no', 'NO_AI_CONSENT'],
      ['field_missing', 'NO_AI_CONSENT'],
      ['unknown', 'CONSENT_UNKNOWN'],
      [null, 'CONSENT_UNKNOWN'],
    ] as const)('4 (CF-10b): consent %s is refused as %s', async (consent, expected) => {
      const s = await setup({ consent });
      expect(await code(approve(s))).toEqual({ code: expected, status: 409 });
      expect((await plans(s.lead.enrollmentId))[0]!.status).toBe('proposed');
    });

    it("4b (CF-6): the consent checked is the current plan's own research, not a newer research row", async () => {
      const s = await setup({ consent: 'no' });
      await db.execute(sql`
        insert into call_research (org_id, enrollment_id, crm_record_id, version, snapshot, size_chars, content_hash)
        select org_id, enrollment_id, crm_record_id, 2, jsonb_set(snapshot, '{consent}', '"yes"'), size_chars, 'newer' from call_research where id = ${s.lead.researchId}::uuid`);
      expect(await code(approve(s))).toEqual({ code: 'NO_AI_CONSENT', status: 409 });
    });

    it('5: a do-not-contact flag nobody dismissed is DNC_PENDING', async () => {
      const s = await setup();
      await flagTriage(s.orgId, s.lead.crmRecordId);
      expect(await code(approve(s))).toEqual({ code: 'DNC_PENDING', status: 409 });
    });

    it('5a (CF-10a): a lead held in Needs Review is refused, though its do-not-contact plan is still the current proposed plan', async () => {
      const s = await setup({ status: 'needs_review', dncFlagged: true });
      await flagTriage(s.orgId, s.lead.crmRecordId);
      expect(await code(approve(s))).toEqual({ code: 'DNC_PENDING', status: 409 });
      expect((await currentPlan(db, s.lead.enrollmentId))!.status).toBe('proposed');
      expect(await code(editPlan(db, s.ctx, s.lead.enrollmentId, { version: 1, plan: EDITABLE }, SEED_NOW))).toEqual({ code: 'DNC_PENDING', status: 409 });
      expect(await code(rejectPlan(db, s.ctx, s.lead.enrollmentId, SEED_NOW))).toEqual({ code: 'DNC_PENDING', status: 409 });
      expect((await enrollment(s.lead.enrollmentId)).status).toBe('needs_review');
    });

    it('5b (CF-10c): a plan the model flagged is refused until a person dismisses the flag, then it may be approved (CF-7)', async () => {
      const s = await setup({ dncFlagged: true });
      expect(await code(approve(s))).toEqual({ code: 'DNC_NOT_DISMISSED', status: 409 });
      const triageId = await flagTriage(s.orgId, s.lead.crmRecordId);
      await db.execute(sql`update crm_records set dnc_dismissed_triage_id = ${triageId}::uuid where id = ${s.lead.crmRecordId}::uuid`);
      expect(await code(approve(s))).toBeNull();
      expect((await currentPlan(db, s.lead.enrollmentId))).toMatchObject({ status: 'approved', dncFlagged: true });
    });

    it.each(['research', 'queued', 'approved'] as const)('6: call_stage %s is NOT_IN_REVIEW', async (callStage) => {
      const s = await setup({ callStage });
      expect(await code(approve(s))).toEqual({ code: 'NOT_IN_REVIEW', status: 409 });
    });

    it('6b: another tenant\'s lead is NOT_FOUND', async () => {
      const s = await setup();
      const other = await setup();
      expect(await code(approvePlan(db, other.ctx, s.lead.enrollmentId, { version: 1 }, SEED_NOW))).toEqual({ code: 'NOT_FOUND', status: 404 });
    });
  });

  describe('edit', () => {
    it('7: an edit makes v2 (proposed, source edit, by the editor, no model, no doNotContact) and supersedes v1', async () => {
      const s = await setup();
      const edited = { ...EDITABLE, opener: 'Ask how the family is doing with the house.' };
      await editPlan(db, s.ctx, s.lead.enrollmentId, { version: 1, plan: edited }, SEED_NOW);
      const [v1, v2] = await plans(s.lead.enrollmentId);
      expect(v1!.status).toBe('superseded');
      expect(v2).toMatchObject({ version: 2, status: 'proposed', source: 'edit', createdBy: s.admin, model: null, researchId: v1!.researchId, dncFlagged: false });
      expect((v2!.plan as { opener: string; doNotContact: unknown }).opener).toBe(edited.opener);
      expect((v2!.plan as { doNotContact: unknown }).doNotContact).toBeNull();
    });

    it('7b: editing an approved plan sends the lead back to review', async () => {
      const s = await setup({ callStage: 'approved', planStatus: 'approved' });
      await editPlan(db, s.ctx, s.lead.enrollmentId, { version: 1, plan: EDITABLE }, SEED_NOW);
      expect((await enrollment(s.lead.enrollmentId)).callStage).toBe('review');
      expect((await currentPlan(db, s.lead.enrollmentId))).toMatchObject({ version: 2, status: 'proposed' });
    });

    it('7c (CF-7): an edit keeps the do-not-contact history and the dismisser of the plan it replaces', async () => {
      const s = await setup({ dncFlagged: true });
      await db.execute(sql`update call_plans set decided_by = ${s.admin}::uuid, decided_at = ${SEED_NOW.toISOString()}::timestamptz where id = ${s.lead.planId}::uuid`);
      await editPlan(db, s.ctx, s.lead.enrollmentId, { version: 1, plan: EDITABLE }, SEED_NOW);
      expect(await currentPlan(db, s.lead.enrollmentId)).toMatchObject({ version: 2, dncFlagged: true, decidedBy: s.admin });
    });

    it('8: two concurrent edits from the same version: one wins, the other gets PLAN_CHANGED', async () => {
      const s = await setup();
      const results = await Promise.all([
        code(editPlan(db, s.ctx, s.lead.enrollmentId, { version: 1, plan: { ...EDITABLE, opener: 'A' } }, SEED_NOW)),
        code(editPlan(db, s.ctx, s.lead.enrollmentId, { version: 1, plan: { ...EDITABLE, opener: 'B' } }, SEED_NOW)),
      ]);
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(results.find((r) => r !== null)).toEqual({ code: 'PLAN_CHANGED', status: 409 });
      expect(await plans(s.lead.enrollmentId)).toHaveLength(2);
    });
  });

  it('9: reject marks the plan rejected, exits the enrollment as plan_rejected (stage done) and frees its contact keys', async () => {
    const s = await setup();
    await db.insert(schema.enrollmentContactKeys).values({ enrollmentId: s.lead.enrollmentId, orgId: s.orgId, key: '+15125550100', active: true });
    await rejectPlan(db, s.ctx, s.lead.enrollmentId, SEED_NOW);
    expect((await plans(s.lead.enrollmentId))[0]).toMatchObject({ status: 'rejected', decidedBy: s.admin });
    expect(await enrollment(s.lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: PLAN_REJECTED_EXIT_REASON, callStage: 'done' });
    const keys = await db.select().from(schema.enrollmentContactKeys).where(eq(schema.enrollmentContactKeys.enrollmentId, s.lead.enrollmentId));
    expect(keys.every((k) => !k.active)).toBe(true);
  });

  describe('research again', () => {
    it.each(['review', 'approved'] as const)('10: from %s it goes back to research and clears the prepare claim, error and failure count (a parked lead is tried again)', async (callStage) => {
      const s = await setup({ callStage, planStatus: callStage === 'approved' ? 'approved' : 'proposed' });
      await db.update(schema.campaignEnrollments).set({ callPrepareAttemptedAt: SEED_NOW, callPrepareError: 'Research or planning failed; it will try again.', callPrepareFailures: 3 }).where(eq(schema.campaignEnrollments.id, s.lead.enrollmentId));
      await researchAgain(db, s.ctx, s.lead.enrollmentId, SEED_NOW);
      expect(await enrollment(s.lead.enrollmentId)).toMatchObject({ callStage: 'research', callPrepareAttemptedAt: null, callPrepareError: null, callPrepareFailures: 0 });
    });

    it('10b: a queued lead cannot be researched again', async () => {
      const s = await setup({ callStage: 'queued', planStatus: 'approved' });
      expect(await code(researchAgain(db, s.ctx, s.lead.enrollmentId, SEED_NOW))).toEqual({ code: 'NOT_IN_REVIEW', status: 409 });
    });
  });
});
