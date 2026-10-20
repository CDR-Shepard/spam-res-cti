/**
 * Real Postgres: what keeps Sam's AI calls from a seller without a stop on the seller's own record. A person who took
 * the seller over, or a flag waiting for a person (a holding email promised one), pauses the calls until the seller is
 * given back to Sam (I1). A duplicate record synced AFTER the seller opted out carries an address on the suppression
 * list: it is not called either, unless that address is on more than SHARED_ADDRESS_LIMIT records (I2a). A held touch
 * is never a candidate of the `ai_call.place` tick, so it is never refused, burns no attempt and starts no refusal run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { SHARED_ADDRESS_LIMIT } from '../conversations/shared-address.js';
import { ensureConversation, flagConversation, setHandler, stopSeller, suppressAddress } from '../conversations/store.js';
import { seedUser } from '../test/call-plan-seed.js';
import { leadId, seedRecord, snapshot } from '../test/outreach-fixtures.js';
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

  describe('I2a: a duplicate record synced after the seller opted out', () => {
    let seq = 0;
    const ADDRESS = 'seller@example.com';

    /** Seller A (an enrolled lead) is stopped for `reason`; nothing else carries the address yet. */
    async function stoppedSeller(h: Harness, reason: 'opted_out' | 'complained' | 'asked_to_stop') {
      const a = await seedReleasedLead(db, h.base, { recordOver: { email: ADDRESS }, dueAt: LATER });
      const conv = await ensureConversation(db, { orgId: h.base.orgId, crmRecordId: a.crmRecordId });
      await stopSeller(db, { conversationId: conv.id, reason, now: NOW });
      return a;
    }
    /** `n` more records with the address (any case), no enrollment. */
    async function moreRecords(orgId: string, n: number): Promise<void> {
      for (let i = 0; i < n; i += 1) await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(600_000 + (seq += 1)), email: i % 2 === 0 ? ' Seller@Example.com' : 'SELLER@example.com ' }));
    }

    it.each(['opted_out', 'complained', 'asked_to_stop'] as const)('after A %s, record B with the same address is not claimed and burns no attempt', async (reason) => {
      const h = await paceHarness(db);
      await stoppedSeller(h, reason);
      const b = await seedReleasedLead(db, h.base, { recordOver: { email: 'Seller@Example.COM' } });
      await paused(h, b);
    });

    it(`with the address on ${SHARED_ADDRESS_LIMIT + 1} records it says nothing about who B is: B is claimed`, async () => {
      const h = await paceHarness(db);
      await stoppedSeller(h, 'opted_out');
      // A, these, and B: one more than the limit.
      await moreRecords(h.base.orgId, SHARED_ADDRESS_LIMIT - 1);
      const b = await seedReleasedLead(db, h.base, { recordOver: { email: ADDRESS } });
      expect((await h.run(NOW)).placed).toBe(1);
      expect(await touchById(db, b.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it(`with the address on exactly ${SHARED_ADDRESS_LIMIT} records B is still held`, async () => {
      const h = await paceHarness(db);
      await stoppedSeller(h, 'opted_out');
      // A, these, and B: the limit itself.
      await moreRecords(h.base.orgId, SHARED_ADDRESS_LIMIT - 2);
      const b = await seedReleasedLead(db, h.base, { recordOver: { email: ADDRESS } });
      await paused(h, b);
    });

    it('a bounced address (not an opt-out) does not hold a call', async () => {
      const h = await paceHarness(db);
      const b = await seedReleasedLead(db, h.base, { recordOver: { email: ADDRESS } });
      await suppressAddress(db, { orgId: h.base.orgId, address: ADDRESS, reason: 'bounced', conversationId: null });
      expect((await h.run(NOW)).placed).toBe(1);
      expect((await touchById(db, b.touchId)).status).toBe('sent');
    });

    it("another tenant's suppression of the same address holds nothing here", async () => {
      const other = await paceHarness(db);
      await suppressAddress(db, { orgId: other.base.orgId, address: ADDRESS, reason: 'opted_out', conversationId: null });
      const h = await paceHarness(db);
      await seedReleasedLead(db, h.base, { recordOver: { email: ADDRESS } });
      expect((await h.run(NOW)).placed).toBe(1);
    });
  });
});
