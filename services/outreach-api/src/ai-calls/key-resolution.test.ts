/**
 * Real Postgres: what cti-api did with a kept idempotency key, read from the shared ai_call_requests and ai_calls tables,
 * and the paths that used to drop a kept key without asking (final-fix round 2: I-2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { InternalAiCallResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { holdForReview } from '../campaigns/dnc-hold.js';
import { enrollmentById, seedAiCall, seedAiCallRequest, seedReleasedLead, touchById, type ReleasedLead } from '../test/ai-call-seed.js';
import { seedUser } from '../test/call-plan-seed.js';
import { paceHarness } from '../test/fake-pace.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { TRIGGER_TIMEOUT_MS } from './cti-client.js';
import { FIND_SLACK_MS, resolveKey, settleKeptKey, STALE_REQUEST_MS } from './key-resolution.js';
import { IN_FLIGHT_RETRY_MS } from './pacing-rules.js';
import { planNoLongerApproved, skipNotClaimable } from './stage.js';

const NOW = new Date('2026-10-05T23:00:00.000Z');
const MIN = 60_000;
const at = (from: Date, ms: number) => new Date(from.getTime() + ms);
const CLAIMED = at(NOW, -30 * MIN);
const placed = (aiCallId: string): InternalAiCallResponse => ({ result: 'placed', aiCallId });

describe.skipIf(!pgLane)('kept idempotency keys (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  /** A queued lead whose touch went to cti-api under `key` at CLAIMED and is planned again, keeping the key. */
  async function keptLead(): Promise<{ h: Awaited<ReturnType<typeof paceHarness>>; lead: ReleasedLead; key: string }> {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    const key = `touch:${lead.touchId}:1:${CLAIMED.getTime()}`;
    await db
      .update(schema.touches)
      .set({ triggerKey: key, claimedAt: CLAIMED, attempts: 0, dueAt: at(CLAIMED, IN_FLIGHT_RETRY_MS), lastBlockReason: 'transport' })
      .where(eq(schema.touches.id, lead.touchId));
    return { h, lead, key };
  }

  const target = (h: { base: { orgId: string } }, lead: ReleasedLead, key: string) => ({ orgId: h.base.orgId, key, sfRecordId: lead.sfRecordId });

  describe('resolveKey', () => {
    it('none: cti-api never reserved the key', async () => {
      const { h, lead, key } = await keptLead();
      expect(await resolveKey(db, target(h, lead, key), NOW)).toEqual({ kind: 'none', stored: false });
    });

    it('answered: the stored answer, placed or a refusal', async () => {
      const { h, lead, key } = await keptLead();
      const aiCallId = await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: lead.sfRecordId, createdAt: CLAIMED });
      await seedAiCallRequest(db, { orgId: h.base.orgId, key, userId: lead.approver, response: placed(aiCallId), createdAt: CLAIMED });
      expect(await resolveKey(db, target(h, lead, key), NOW)).toEqual({ kind: 'answered', answer: placed(aiCallId) });

      const other = await keptLead();
      const refusal: InternalAiCallResponse = { result: 'failed', reason: 'salesforce_error', aiCallId: null };
      await seedAiCallRequest(db, { orgId: other.h.base.orgId, key: other.key, userId: other.lead.approver, response: refusal, createdAt: CLAIMED });
      expect(await resolveKey(db, target(other.h, other.lead, other.key), NOW)).toEqual({ kind: 'answered', answer: refusal });
    });

    it('pending: no answer yet and the reservation is younger than cti-api\'s stale window; it says until when', async () => {
      const { h, lead, key } = await keptLead();
      const updated = at(NOW, -STALE_REQUEST_MS + MIN);
      await seedAiCallRequest(db, { orgId: h.base.orgId, key, userId: lead.approver, createdAt: CLAIMED, updatedAt: updated });
      expect(await resolveKey(db, target(h, lead, key), NOW)).toEqual({ kind: 'pending', createdAt: CLAIMED, until: at(updated, STALE_REQUEST_MS) });
    });

    it('stale and unanswered: the call the crashed request left (same org, approver and record, since created_at minus the slack) is its answer, rebuilt as cti-api does', async () => {
      const { h, lead, key } = await keptLead();
      await seedAiCallRequest(db, { orgId: h.base.orgId, key, userId: lead.approver, createdAt: CLAIMED });
      const aiCallId = await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: lead.sfRecordId, createdAt: at(CLAIMED, -FIND_SLACK_MS + 1000), callSid: 'CA1' });
      expect(await resolveKey(db, target(h, lead, key), NOW)).toEqual({ kind: 'answered', answer: placed(aiCallId) });

      const blocked = await keptLead();
      await seedAiCallRequest(db, { orgId: blocked.h.base.orgId, key: blocked.key, userId: blocked.lead.approver, createdAt: CLAIMED });
      const blockedId = await seedAiCall(db, blocked.h.base.orgId, blocked.lead.approver, { sfRecordId: blocked.lead.sfRecordId, createdAt: CLAIMED, status: 'blocked', blockReason: 'dnc' });
      expect(await resolveKey(db, target(blocked.h, blocked.lead, blocked.key), NOW)).toEqual({ kind: 'answered', answer: { result: 'blocked', reason: 'dnc', aiCallId: blockedId } });

      const failed = await keptLead();
      await seedAiCallRequest(db, { orgId: failed.h.base.orgId, key: failed.key, userId: failed.lead.approver, createdAt: CLAIMED });
      const failedId = await seedAiCall(db, failed.h.base.orgId, failed.lead.approver, { sfRecordId: failed.lead.sfRecordId, createdAt: CLAIMED, status: 'failed' });
      expect(await resolveKey(db, target(failed.h, failed.lead, failed.key), NOW)).toEqual({ kind: 'answered', answer: { result: 'failed', reason: 'twilio_error', aiCallId: failedId } });
    });

    it('stale and unanswered with no such call: none (another approver, another record, or older than the slack does not count)', async () => {
      const { h, lead, key } = await keptLead();
      await seedAiCallRequest(db, { orgId: h.base.orgId, key, userId: lead.approver, createdAt: CLAIMED });
      const someoneElse = await seedUser(db, h.base.orgId);
      await seedAiCall(db, h.base.orgId, someoneElse, { sfRecordId: lead.sfRecordId, createdAt: CLAIMED });
      await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: '00Q000000000999AAA', createdAt: CLAIMED });
      await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: lead.sfRecordId, createdAt: at(CLAIMED, -FIND_SLACK_MS - 1000) });
      // Fix 1 (I-2): cti-api still holds the row, and with it the first body's hash.
      expect(await resolveKey(db, target(h, lead, key), NOW)).toEqual({ kind: 'none', stored: true });
    });
  });

  describe('Part 4 Fix 1 (I-2): practice calls', () => {
    it('a crashed record request never takes a practice call on the same record by the same user for its own call', async () => {
      const { h, lead, key } = await keptLead();
      await seedAiCallRequest(db, { orgId: h.base.orgId, key, userId: lead.approver, createdAt: CLAIMED });
      const real = await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: lead.sfRecordId, createdAt: CLAIMED, callSid: 'CAi2real' });
      await seedAiCall(db, h.base.orgId, lead.approver, {
        sfRecordId: lead.sfRecordId, isTest: true, practice: true, toE164: '+15125550177', createdAt: at(CLAIMED, MIN), callSid: 'CAi2practice',
      });
      expect(await resolveKey(db, target(h, lead, key), NOW)).toEqual({ kind: 'answered', answer: placed(real) });
    });

    it('with only a practice call in the window: none (the real call was never placed)', async () => {
      const { h, lead, key } = await keptLead();
      await seedAiCallRequest(db, { orgId: h.base.orgId, key, userId: lead.approver, createdAt: CLAIMED });
      await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: lead.sfRecordId, isTest: true, practice: true, createdAt: CLAIMED, callSid: 'CAi2practiceonly' });
      expect(await resolveKey(db, target(h, lead, key), NOW)).toEqual({ kind: 'none', stored: true });
    });
  });

  describe('settleKeptKey (a planned touch about to lose its key)', () => {
    it('a stored placed answer links the call: the touch is sent with that call, and its key is gone', async () => {
      const { h, lead, key } = await keptLead();
      const aiCallId = await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: lead.sfRecordId, createdAt: CLAIMED });
      await seedAiCallRequest(db, { orgId: h.base.orgId, key, userId: lead.approver, response: placed(aiCallId), createdAt: CLAIMED });
      expect(await settleKeptKey(db, lead.touchId, NOW)).toEqual({ kind: 'placed', aiCallId });
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', aiCallId, sentAt: NOW, triggerKey: null, lastBlockReason: null });
    });

    it('a touch claimed less than the trigger timeout ago with no reservation yet is pending, never free', async () => {
      const { lead } = await keptLead();
      const claimed = at(NOW, -5_000);
      await db.update(schema.touches).set({ claimedAt: claimed }).where(eq(schema.touches.id, lead.touchId));
      expect(await settleKeptKey(db, lead.touchId, NOW)).toEqual({ kind: 'pending', until: at(claimed, TRIGGER_TIMEOUT_MS) });
    });

    it('no key, or no reservation: free, and cti-api stored nothing (Fix 1, I-2: the re-send is fresh)', async () => {
      const { lead } = await keptLead();
      expect(await settleKeptKey(db, lead.touchId, NOW)).toEqual({ kind: 'free', stored: false });
      const plain = await seedReleasedLead(db, (await paceHarness(db)).base);
      expect(await settleKeptKey(db, plain.touchId, NOW)).toEqual({ kind: 'free', stored: false });
    });

    it('a stored refusal, or a stale reservation with no call: free, and cti-api stored the key (the re-send settles by 409)', async () => {
      const refused = await keptLead();
      const blockedId = await seedAiCall(db, refused.h.base.orgId, refused.lead.approver, { sfRecordId: refused.lead.sfRecordId, status: 'blocked', createdAt: CLAIMED });
      const refusal = { result: 'blocked' as const, reason: 'calling_hours' as const, aiCallId: blockedId };
      await seedAiCallRequest(db, { orgId: refused.h.base.orgId, key: refused.key, userId: refused.lead.approver, response: refusal, createdAt: CLAIMED });
      expect(await settleKeptKey(db, refused.lead.touchId, NOW)).toEqual({ kind: 'free', stored: true });
      const crashed = await keptLead();
      await seedAiCallRequest(db, { orgId: crashed.h.base.orgId, key: crashed.key, userId: crashed.lead.approver, createdAt: CLAIMED });
      expect(await settleKeptKey(db, crashed.lead.touchId, NOW)).toEqual({ kind: 'free', stored: true });
    });
  });

  describe('skips that used to drop a kept key', () => {
    /** The three answers a kept key can have: placed (stored), pending (fresh reservation), none. */
    async function scenario(kind: 'placed' | 'pending' | 'none') {
      const k = await keptLead();
      let aiCallId: string | null = null;
      if (kind === 'placed') {
        aiCallId = await seedAiCall(db, k.h.base.orgId, k.lead.approver, { sfRecordId: k.lead.sfRecordId, createdAt: CLAIMED });
        await seedAiCallRequest(db, { orgId: k.h.base.orgId, key: k.key, userId: k.lead.approver, response: placed(aiCallId), createdAt: CLAIMED });
      }
      if (kind === 'pending') {
        await seedAiCallRequest(db, { orgId: k.h.base.orgId, key: k.key, userId: k.lead.approver, createdAt: CLAIMED, updatedAt: at(NOW, -MIN) });
      }
      return { ...k, aiCallId };
    }

    it('skipNotClaimable: placed links the call (the lead stays queued); pending leaves the touch and its key; none skips as before', async () => {
      const p = await scenario('placed');
      expect(await skipNotClaimable(db, p.lead, NOW)).toEqual({ kind: 'placed' });
      expect(await touchById(db, p.lead.touchId)).toMatchObject({ status: 'sent', aiCallId: p.aiCallId });
      expect((await enrollmentById(db, p.lead.enrollmentId)).callStage).toBe('queued');

      const q = await scenario('pending');
      expect(await skipNotClaimable(db, q.lead, NOW)).toEqual({ kind: 'pending', until: at(at(NOW, -MIN), STALE_REQUEST_MS) });
      expect(await touchById(db, q.lead.touchId)).toMatchObject({ status: 'planned', triggerKey: q.key });

      const n = await scenario('none');
      expect(await skipNotClaimable(db, n.lead, NOW)).toEqual({ kind: 'skipped' });
      expect(await touchById(db, n.lead.touchId)).toMatchObject({ status: 'skipped', skipReason: 'not_claimable' });
      // M-b: a touch that is no longer planned is left alone, and says so.
      expect(await skipNotClaimable(db, n.lead, NOW)).toEqual({ kind: 'unchanged' });
    });

    it('a placed answer found for a lead no longer queued (approved again after a hold) puts it back at queued, so a release cannot make a second touch', async () => {
      const p = await scenario('placed');
      await db.update(schema.campaignEnrollments).set({ callStage: 'approved' }).where(eq(schema.campaignEnrollments.id, p.lead.enrollmentId));
      expect(await skipNotClaimable(db, p.lead, NOW)).toEqual({ kind: 'placed' });
      expect((await enrollmentById(db, p.lead.enrollmentId)).callStage).toBe('queued');
    });

    it('planNoLongerApproved: placed links the call; pending leaves it; none skips as before', async () => {
      for (const kind of ['placed', 'pending', 'none'] as const) {
        const s = await scenario(kind);
        await db.update(schema.callPlans).set({ status: 'superseded' }).where(eq(schema.callPlans.id, s.lead.planId!));
        const out = await planNoLongerApproved(db, s.lead, NOW);
        const t = await touchById(db, s.lead.touchId);
        if (kind === 'placed') expect([out, t.status, t.aiCallId]).toEqual([{ kind: 'placed' }, 'sent', s.aiCallId]);
        if (kind === 'pending') expect([out.kind, t.status, t.triggerKey]).toEqual(['pending', 'planned', s.key]);
        if (kind === 'none') expect([out, t.status, t.skipReason]).toEqual([{ kind: 'skipped' }, 'skipped', 'plan_not_approved']);
      }
    });

    it('holdForReview: placed links the call; pending leaves the touch planned with its key; none skips as before', async () => {
      const doNotContact = { category: 'attorney' as const, quote: 'Talk to my lawyer' };
      for (const kind of ['placed', 'pending', 'none'] as const) {
        const s = await scenario(kind);
        const [triage] = await db
          .insert(schema.recordTriage)
          .values({ orgId: s.h.base.orgId, crmRecordId: s.lead.crmRecordId, notesHash: `h-${kind}`, model: 'm', result: { summary: '', channels: [], timing: null, tags: [], doNotContact }, inputTokens: 1, outputTokens: 1 })
          .returning({ id: schema.recordTriage.id });
        const flag = { triageId: triage!.id, ...doNotContact };
        await db.transaction(async (tx) => {
          await holdForReview(tx as unknown as Db, { enrollmentId: s.lead.enrollmentId }, flag, NOW);
        });
        expect((await enrollmentById(db, s.lead.enrollmentId)).status).toBe('needs_review');
        const t = await touchById(db, s.lead.touchId);
        if (kind === 'placed') expect([t.status, t.aiCallId]).toEqual(['sent', s.aiCallId]);
        if (kind === 'pending') expect([t.status, t.triggerKey]).toEqual(['planned', s.key]);
        if (kind === 'none') expect([t.status, t.skipReason]).toEqual(['skipped', 'needs_review']);
      }
    });
  });
});
