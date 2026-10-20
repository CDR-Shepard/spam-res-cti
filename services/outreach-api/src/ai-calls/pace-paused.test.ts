/**
 * Real Postgres: what pauses Sam's AI calls to a seller without ending them. A person who took the seller over, or a
 * flag waiting for a person (a holding email promised one), pauses the calls until the seller is given back to Sam
 * (I1). A paused touch is never a candidate of the `ai_call.place` tick, so it is never refused, burns no attempt and
 * starts no refusal run; given back, it is called at the next tick.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { ensureConversation, flagConversation, setHandler } from '../conversations/store.js';
import { seedUser } from '../test/call-plan-seed.js';
import { seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import { paceHarness } from '../test/fake-pace.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { claimAiTouch, dueAiCallTouches, orgsWithDueAiCalls } from './touches.js';

/** Monday 18:00 CDT: inside the plan fixture's `evening` window for a Texas number. */
const NOW = new Date('2026-10-05T23:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60 * 60_000);

describe.skipIf(!pgLane)('ai_call.place: a seller a person handles or who waits for a person is not called (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  type Harness = Awaited<ReturnType<typeof paceHarness>>;

  /** The touch was never looked at: still planned, no attempt, no refusal recorded. */
  async function untouched(touchId: string): Promise<void> {
    expect(await touchById(db, touchId)).toMatchObject({ status: 'planned', attempts: 0, lastBlockReason: null, triggerKey: null, claimedAt: null });
  }

  /** Not a candidate of the tick, refused by the claim, and the tick leaves it as it was. */
  async function paused(h: Harness, lead: { touchId: string }): Promise<void> {
    expect((await dueAiCallTouches(db, h.base.orgId, NOW, 20)).map((d) => d.touchId)).not.toContain(lead.touchId);
    expect(await orgsWithDueAiCalls(db, NOW)).not.toContain(h.base.orgId);
    const counts = await h.run(NOW);
    expect(counts).toMatchObject({ placed: 0, retried: 0, failed: 0, deferred: 0, held: 0 });
    expect(h.cti.requests).toEqual([]);
    await untouched(lead.touchId);
    expect(await claimAiTouch(db, lead.touchId, NOW)).toBeNull();
    await untouched(lead.touchId);
  }

  describe('I1: taken over by a person', () => {
    it('a taken-over seller\'s due touch is not claimed and burns no attempt; given back to Sam, it is called', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      const person = await seedUser(db, h.base.orgId);
      const conv = await ensureConversation(db, { orgId: h.base.orgId, crmRecordId: lead.crmRecordId });
      await setHandler(db, { conversationId: conv.id, handler: 'person', userId: person, now: NOW });

      await paused(h, lead);

      await setHandler(db, { conversationId: conv.id, handler: 'sam', userId: person, now: NOW });
      expect((await h.run(LATER)).placed).toBe(1);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('a practice conversation taken over does not pause the seller', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      const admin = await seedUser(db, h.base.orgId);
      const practice = await ensureConversation(db, { orgId: h.base.orgId, crmRecordId: lead.crmRecordId, practiceUserId: admin });
      await db.update(schema.sellerConversations).set({ handler: 'person', handlerUserId: admin, flagReason: 'unsure' }).where(eq(schema.sellerConversations.id, practice.id));
      expect((await h.run(NOW)).placed).toBe(1);
    });

    it("another record's taken-over conversation does not pause this seller", async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      const other = await seedReleasedLead(db, h.base, { dueAt: LATER });
      const person = await seedUser(db, h.base.orgId);
      const otherConv = await ensureConversation(db, { orgId: h.base.orgId, crmRecordId: other.crmRecordId });
      await setHandler(db, { conversationId: otherConv.id, handler: 'person', userId: person, now: NOW });
      expect((await h.run(NOW)).placed).toBe(1);
      expect((await touchById(db, lead.touchId)).status).toBe('sent');
    });
  });

  describe('I1: flagged for a person', () => {
    it("a flagged seller's touch is not claimed and burns no attempt", async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      const conv = await ensureConversation(db, { orgId: h.base.orgId, crmRecordId: lead.crmRecordId });
      await flagConversation(db, { conversationId: conv.id, reason: 'wants_appointment', now: NOW });
      await paused(h, lead);
    });

    it('giving the seller back (which clears the flag) lets the call go', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      const person = await seedUser(db, h.base.orgId);
      const conv = await ensureConversation(db, { orgId: h.base.orgId, crmRecordId: lead.crmRecordId });
      await flagConversation(db, { conversationId: conv.id, reason: 'unsure', now: NOW });
      await setHandler(db, { conversationId: conv.id, handler: 'person', userId: person, now: NOW });
      await paused(h, lead);
      await setHandler(db, { conversationId: conv.id, handler: 'sam', userId: person, now: NOW });
      expect((await h.run(LATER)).placed).toBe(1);
    });

    it('an open, unflagged conversation handled by Sam is called as before', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      await ensureConversation(db, { orgId: h.base.orgId, crmRecordId: lead.crmRecordId });
      expect((await h.run(NOW)).placed).toBe(1);
    });
  });
});
