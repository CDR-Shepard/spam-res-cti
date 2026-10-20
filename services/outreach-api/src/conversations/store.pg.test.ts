import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { leadId, seedCampaign, seedEnrollment, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { enrollmentById, seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import {
  appendEvent,
  ensureConversation,
  findConversationByToken,
  flagConversation,
  setHandler,
  setStatusFromCall,
  stopSeller,
  suppressAddress,
  suppressionFor,
} from './store.js';
import { SHARED_ADDRESS_LIMIT, type SharedAddressNotice } from './shared-address.js';

const NOW = new Date('2026-10-19T17:00:00.000Z');
const TOKEN_RE = /^[a-z2-7]{26}$/;

describe.skipIf(!pgLane)('conversation store (real Postgres)', () => {
  let t: TestDb;
  let seq = 0;
  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  /** A fresh tenant with one record (optionally with an email) so tests never see each other's rows. */
  async function seedSeller(email: string | null = null) {
    seq += 1;
    const orgId = await seedOrg(t.db);
    const crmRecordId = await seedRecord(t.db, orgId, snapshot({ sfRecordId: leadId(seq), email }));
    return { orgId, crmRecordId };
  }

  async function conversationRow(id: string) {
    const [row] = await t.db.select().from(schema.sellerConversations).where(eq(schema.sellerConversations.id, id));
    return row!;
  }

  async function eventsOf(conversationId: string) {
    return t.db
      .select()
      .from(schema.conversationEvents)
      .where(eq(schema.conversationEvents.conversationId, conversationId))
      .orderBy(schema.conversationEvents.createdAt, schema.conversationEvents.id);
  }

  async function suppressionRows(orgId: string) {
    return t.db.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.orgId, orgId));
  }

  describe('ensureConversation / findConversationByToken', () => {
    it('is idempotent and hands out a 26-character base32 token', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const a = await ensureConversation(t.db, { orgId, crmRecordId });
      const b = await ensureConversation(t.db, { orgId, crmRecordId, practiceUserId: null });
      expect(b.id).toBe(a.id);
      expect(a.token).toMatch(TOKEN_RE);
      expect(a).toMatchObject({ handler: 'sam', status: 'open', practiceUserId: null, stopReason: null, flagReason: null });
    });

    it('gives every conversation its own token', async () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 5; i += 1) {
        const { orgId, crmRecordId } = await seedSeller();
        tokens.add((await ensureConversation(t.db, { orgId, crmRecordId })).token);
      }
      expect(tokens.size).toBe(5);
    });

    it('keeps a practice conversation for the same record as a second row, one per admin', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const admin = await seedUser(t.db, orgId);
      const other = await seedUser(t.db, orgId);
      const real = await ensureConversation(t.db, { orgId, crmRecordId });
      const practice = await ensureConversation(t.db, { orgId, crmRecordId, practiceUserId: admin });
      expect(practice.id).not.toBe(real.id);
      expect(practice.practiceUserId).toBe(admin);
      expect(practice.token).not.toBe(real.token);
      expect((await ensureConversation(t.db, { orgId, crmRecordId, practiceUserId: admin })).id).toBe(practice.id);
      expect((await ensureConversation(t.db, { orgId, crmRecordId, practiceUserId: other })).id).not.toBe(practice.id);
    });

    it('finds a conversation by its token, in any case, and null for an unknown one', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      expect((await findConversationByToken(t.db, conv.token))?.id).toBe(conv.id);
      expect((await findConversationByToken(t.db, conv.token.toUpperCase()))?.id).toBe(conv.id);
      expect(await findConversationByToken(t.db, 'a'.repeat(26))).toBeNull();
    });
  });

  describe('appendEvent', () => {
    it('owes a Salesforce Task when sfLog is true, and nothing when it is false', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      const logged = await appendEvent(t.db, { orgId, conversationId: conv.id, kind: 'note', direction: 'none', actor: 'person', subject: 's', body: 'b', meta: { x: 1 }, sfLog: true });
      const quiet = await appendEvent(t.db, { orgId, conversationId: conv.id, kind: 'note', direction: 'none', actor: 'person', sfLog: false });
      const events = await eventsOf(conv.id);
      const byId = new Map(events.map((e) => [e.id, e]));
      expect(byId.get(logged)).toMatchObject({ sfLogStatus: 'pending', subject: 's', body: 'b', meta: { x: 1 }, orgId });
      expect(byId.get(logged)!.sfLogNextAt).toBeInstanceOf(Date);
      expect(byId.get(quiet)).toMatchObject({ sfLogStatus: 'skipped', sfLogNextAt: null, meta: {}, subject: null, detail: null });
    });

    it('stores skipped for a practice conversation even when sfLog is true', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const admin = await seedUser(t.db, orgId);
      const practice = await ensureConversation(t.db, { orgId, crmRecordId, practiceUserId: admin });
      const id = await appendEvent(t.db, { orgId, conversationId: practice.id, kind: 'email', direction: 'out', actor: 'sam', sfLog: true });
      const [event] = (await eventsOf(practice.id)).filter((e) => e.id === id);
      expect(event).toMatchObject({ sfLogStatus: 'skipped', sfLogNextAt: null });
    });

    it('keeps occurredAt and the acting user when given', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const userId = await seedUser(t.db, orgId);
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      const id = await appendEvent(t.db, { orgId, conversationId: conv.id, kind: 'human_touch', direction: 'out', actor: 'person', userId, occurredAt: NOW, detail: 'called', sfLog: false });
      const [event] = (await eventsOf(conv.id)).filter((e) => e.id === id);
      expect(event).toMatchObject({ userId, detail: 'called' });
      expect(event!.occurredAt.toISOString()).toBe(NOW.toISOString());
    });

    it('refuses a conversation of another tenant', async () => {
      const a = await seedSeller();
      const b = await seedSeller();
      const conv = await ensureConversation(t.db, a);
      await expect(appendEvent(t.db, { orgId: b.orgId, conversationId: conv.id, kind: 'note', direction: 'none', actor: 'system', sfLog: false })).rejects.toThrow(`conversation ${conv.id} not found for event`);
      expect(await eventsOf(conv.id)).toHaveLength(0);
    });
  });

  describe('setHandler', () => {
    it('takes over once: true, then false when nothing changes', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const person = await seedUser(t.db, orgId);
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      expect(await setHandler(t.db, { conversationId: conv.id, handler: 'person', userId: person, now: NOW })).toBe(true);
      expect(await setHandler(t.db, { conversationId: conv.id, handler: 'person', userId: person, now: NOW })).toBe(false);
      const row = await conversationRow(conv.id);
      expect(row).toMatchObject({ handler: 'person', handlerUserId: person });
      expect(row.handlerChangedAt?.toISOString()).toBe(NOW.toISOString());
      const events = await eventsOf(conv.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'handler', direction: 'none', actor: 'person', userId: person, detail: 'taken_over', sfLogStatus: 'skipped' });
    });

    it('giving back to Sam clears the flag and the person; two handler events', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const person = await seedUser(t.db, orgId);
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await flagConversation(t.db, { conversationId: conv.id, reason: 'unsure', now: NOW });
      expect((await conversationRow(conv.id)).flagReason).toBe('unsure');
      await setHandler(t.db, { conversationId: conv.id, handler: 'person', userId: person, now: NOW });
      // Taking over keeps the flag: the person has not dealt with it yet.
      expect((await conversationRow(conv.id)).flagReason).toBe('unsure');
      expect(await setHandler(t.db, { conversationId: conv.id, handler: 'sam', userId: person, now: NOW })).toBe(true);
      const row = await conversationRow(conv.id);
      expect(row).toMatchObject({ handler: 'sam', handlerUserId: null, flagReason: null, flaggedAt: null });
      const handlerEvents = (await eventsOf(conv.id)).filter((e) => e.kind === 'handler');
      expect(handlerEvents.map((e) => e.detail).sort()).toEqual(['given_back', 'taken_over']);
      expect(handlerEvents.every((e) => e.sfLogStatus === 'skipped')).toBe(true);
    });

    it('is false for an unknown conversation', async () => {
      expect(await setHandler(t.db, { conversationId: '00000000-0000-4000-8000-000000000000', handler: 'person', userId: null, now: NOW })).toBe(false);
    });

    it('a flagged seller Sam still handles: "sam" clears the flag in one step, with one given_back event', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const person = await seedUser(t.db, orgId);
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await flagConversation(t.db, { conversationId: conv.id, reason: 'wants_appointment', now: NOW });
      expect(await setHandler(t.db, { conversationId: conv.id, handler: 'sam', userId: person, now: NOW })).toBe(true);
      expect(await conversationRow(conv.id)).toMatchObject({ handler: 'sam', handlerUserId: null, flagReason: null, flaggedAt: null });
      const handlerEvents = (await eventsOf(conv.id)).filter((e) => e.kind === 'handler');
      expect(handlerEvents).toEqual([expect.objectContaining({ actor: 'person', userId: person, detail: 'given_back', sfLogStatus: 'skipped' })]);
      // Cleared: asking again changes nothing.
      expect(await setHandler(t.db, { conversationId: conv.id, handler: 'sam', userId: person, now: NOW })).toBe(false);
      expect((await eventsOf(conv.id)).filter((e) => e.kind === 'handler')).toHaveLength(1);
    });

    it('"sam" on a Sam-handled seller with no flag is a no-op: false, nothing written', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      expect(await setHandler(t.db, { conversationId: conv.id, handler: 'sam', userId: null, now: NOW })).toBe(false);
      expect(await conversationRow(conv.id)).toMatchObject({ handler: 'sam', handlerChangedAt: null });
      expect(await eventsOf(conv.id)).toEqual([]);
    });

    it('"person" on a flagged seller a person already handles stays a no-op (the flag waits for the give-back)', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const person = await seedUser(t.db, orgId);
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await flagConversation(t.db, { conversationId: conv.id, reason: 'unsure', now: NOW });
      await setHandler(t.db, { conversationId: conv.id, handler: 'person', userId: person, now: NOW });
      expect(await setHandler(t.db, { conversationId: conv.id, handler: 'person', userId: person, now: NOW })).toBe(false);
      expect((await conversationRow(conv.id)).flagReason).toBe('unsure');
    });
  });

  describe('flagConversation', () => {
    it('flags once, keeps the first reason, and logs the flag to Salesforce', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      expect(await flagConversation(t.db, { conversationId: conv.id, reason: 'offer_or_price', now: NOW })).toBe(true);
      expect(await flagConversation(t.db, { conversationId: conv.id, reason: 'legal', now: NOW })).toBe(false);
      const row = await conversationRow(conv.id);
      expect(row.flagReason).toBe('offer_or_price');
      expect(row.flaggedAt?.toISOString()).toBe(NOW.toISOString());
      const events = (await eventsOf(conv.id)).filter((e) => e.kind === 'flag');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ detail: 'offer_or_price', direction: 'none', sfLogStatus: 'pending' });
    });

    it('does not log a practice conversation flag to Salesforce', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const admin = await seedUser(t.db, orgId);
      const practice = await ensureConversation(t.db, { orgId, crmRecordId, practiceUserId: admin });
      await flagConversation(t.db, { conversationId: practice.id, reason: 'unsure', now: NOW });
      const events = await eventsOf(practice.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'flag', sfLogStatus: 'skipped' });
    });
  });

  describe('stopSeller', () => {
    /** A seller with an active ai_call enrollment (and its planned touch) and a conversation. */
    async function seedEnrolledSeller(email: string | null) {
      const { orgId, campaignId } = await seedAiCallCampaign(t.db);
      const lead = await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email } });
      const conv = await ensureConversation(t.db, { orgId, crmRecordId: lead.crmRecordId });
      return { orgId, campaignId, lead, conv };
    }

    it('stops the conversation, suppresses the address, exits the enrollment and logs it', async () => {
      const { orgId, lead, conv } = await seedEnrolledSeller('Seller@Example.com');
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW })).toBe(true);
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      expect(await suppressionRows(orgId)).toMatchObject([{ address: 'seller@example.com', reason: 'opted_out', conversationId: conv.id }]);
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out', callStage: 'done' });
      expect(await touchById(t.db, lead.touchId)).toMatchObject({ status: 'skipped', skipReason: 'opted_out' });
      const events = await eventsOf(conv.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'status', direction: 'none', detail: 'opted_out', sfLogStatus: 'pending' });
    });

    it('is false the second time with the same reason and writes no second event', async () => {
      const { orgId, conv } = await seedEnrolledSeller('seller@example.com');
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW })).toBe(true);
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW })).toBe(false);
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'asked_to_stop', now: NOW })).toBe(false);
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      expect(await eventsOf(conv.id)).toHaveLength(1);
      expect(await suppressionRows(orgId)).toMatchObject([{ reason: 'opted_out' }]);
    });

    it('is false for an unknown conversation', async () => {
      expect(await stopSeller(t.db, { conversationId: '00000000-0000-4000-8000-000000000000', reason: 'opted_out', now: NOW })).toBe(false);
    });

    it('stops a booked conversation too', async () => {
      const { conv } = await seedEnrolledSeller(null);
      await t.db.update(schema.sellerConversations).set({ status: 'booked' }).where(eq(schema.sellerConversations.id, conv.id));
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'asked_to_stop', now: NOW })).toBe(true);
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'asked_to_stop' });
    });

    it('suppresses nothing for a record with no email, but still stops and exits', async () => {
      const { orgId, lead, conv } = await seedEnrolledSeller(null);
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'asked_to_stop', now: NOW })).toBe(true);
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'asked_to_stop' });
    });

    it('records a complaint as complained', async () => {
      const { orgId, conv } = await seedEnrolledSeller('mad@example.com');
      await stopSeller(t.db, { conversationId: conv.id, reason: 'complained', now: NOW });
      expect(await suppressionRows(orgId)).toMatchObject([{ address: 'mad@example.com', reason: 'complained' }]);
    });

    it('stops every other real conversation with the same address, in any case, and exits their enrollments', async () => {
      const { orgId, campaignId, lead, conv } = await seedEnrolledSeller('seller@example.com');
      const twin = await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email: 'SELLER@EXAMPLE.COM' } });
      const twinConv = await ensureConversation(t.db, { orgId, crmRecordId: twin.crmRecordId });
      const otherRecord = await seedRecord(t.db, orgId, snapshot({ sfRecordId: leadId(800_000 + (seq += 1)), email: 'someone-else@example.com' }));
      const otherConv = await ensureConversation(t.db, { orgId, crmRecordId: otherRecord });
      // The same address in another tenant is another seller entirely.
      const foreign = await seedSeller('seller@example.com');
      const foreignConv = await ensureConversation(t.db, foreign);
      // A practice conversation for the twin's record is not a seller conversation.
      const admin = await seedUser(t.db, orgId);
      const twinPractice = await ensureConversation(t.db, { orgId, crmRecordId: twin.crmRecordId, practiceUserId: admin });

      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW })).toBe(true);

      expect(await conversationRow(twinConv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      expect(await conversationRow(otherConv.id)).toMatchObject({ status: 'open', stopReason: null });
      expect(await conversationRow(foreignConv.id)).toMatchObject({ status: 'open', stopReason: null });
      expect(await conversationRow(twinPractice.id)).toMatchObject({ status: 'open', stopReason: null });
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
      expect(await enrollmentById(t.db, twin.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
      expect(await suppressionRows(orgId)).toHaveLength(1);
      expect(await suppressionRows(foreign.orgId)).toEqual([]);
      // A conversation the sweep newly stops says so on its own timeline, and owes Salesforce a Task.
      expect(await eventsOf(twinConv.id)).toMatchObject([{ kind: 'status', detail: 'opted_out', sfLogStatus: 'pending' }]);
      expect(await eventsOf(otherConv.id)).toEqual([]);
    });

    it('leaves enrollments in sequence campaigns alone', async () => {
      const { orgId, conv, lead } = await seedEnrolledSeller('seller@example.com');
      const sequence = await seedCampaign(t.db, orgId, { mode: 'sequence', status: 'active' });
      const sequenceEnrollment = await seedEnrollment(t.db, orgId, sequence.id, lead.crmRecordId);
      await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
      expect(await enrollmentById(t.db, sequenceEnrollment)).toMatchObject({ status: 'active', exitReason: null });
    });

    it('for a practice conversation suppresses nothing, exits nothing and logs nothing', async () => {
      const { orgId, lead, conv } = await seedEnrolledSeller('seller@example.com');
      const admin = await seedUser(t.db, orgId);
      const practice = await ensureConversation(t.db, { orgId, crmRecordId: lead.crmRecordId, practiceUserId: admin });
      expect(await stopSeller(t.db, { conversationId: practice.id, reason: 'opted_out', now: NOW })).toBe(true);
      expect(await conversationRow(practice.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'open' });
      const events = await eventsOf(practice.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'status', detail: 'opted_out', sfLogStatus: 'skipped' });
    });

    /** A duplicate lead of the seller: another record with the same address and an active ai_call enrollment, and no conversation. */
    const seedDuplicate = (orgId: string, campaignId: string, email = 'Seller@Example.COM') =>
      seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email } });

    const conversationsOfRecord = (orgId: string, crmRecordId: string) =>
      t.db
        .select()
        .from(schema.sellerConversations)
        .where(and(eq(schema.sellerConversations.orgId, orgId), eq(schema.sellerConversations.crmRecordId, crmRecordId)));

    it('gives a same-address record with no conversation a stopped one and exits its enrollment', async () => {
      const { orgId, campaignId, conv } = await seedEnrolledSeller('seller@example.com');
      const duplicate = await seedDuplicate(orgId, campaignId);
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toEqual([]);
      await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
      const [created, ...more] = await conversationsOfRecord(orgId, duplicate.crmRecordId);
      expect(more).toEqual([]);
      expect(created).toMatchObject({ status: 'stopped', stopReason: 'opted_out', practiceUserId: null });
      expect(created!.token).toMatch(/^[a-z2-7]{26}$/);
      expect(await eventsOf(created!.id)).toMatchObject([{ kind: 'status', detail: 'opted_out', sfLogStatus: 'pending' }]);
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
      expect(await touchById(t.db, duplicate.touchId)).toMatchObject({ status: 'skipped', skipReason: 'opted_out' });
    });

    it('lets a sibling already stopped for another reason keep it (no new event), but still exits its enrollment', async () => {
      const { orgId, campaignId, conv } = await seedEnrolledSeller('seller@example.com');
      const duplicate = await seedDuplicate(orgId, campaignId);
      const duplicateConv = await ensureConversation(t.db, { orgId, crmRecordId: duplicate.crmRecordId });
      await t.db.update(schema.sellerConversations).set({ status: 'stopped', stopReason: 'not_interested' }).where(eq(schema.sellerConversations.id, duplicateConv.id));
      await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
      expect(await conversationRow(duplicateConv.id)).toMatchObject({ status: 'stopped', stopReason: 'not_interested' });
      expect(await eventsOf(duplicateConv.id)).toEqual([]);
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
    });

    it('stops a booked sibling', async () => {
      const { orgId, campaignId, conv } = await seedEnrolledSeller('seller@example.com');
      const duplicate = await seedDuplicate(orgId, campaignId);
      const duplicateConv = await ensureConversation(t.db, { orgId, crmRecordId: duplicate.crmRecordId });
      await t.db.update(schema.sellerConversations).set({ status: 'booked' }).where(eq(schema.sellerConversations.id, duplicateConv.id));
      await stopSeller(t.db, { conversationId: conv.id, reason: 'complained', now: NOW });
      expect(await conversationRow(duplicateConv.id)).toMatchObject({ status: 'stopped', stopReason: 'complained' });
      expect(await eventsOf(duplicateConv.id)).toMatchObject([{ kind: 'status', detail: 'complained', sfLogStatus: 'pending' }]);
    });

    it('after a call said not_interested, an opt-out suppresses the address, upgrades the reason and adds one event', async () => {
      const { orgId, lead, conv } = await seedEnrolledSeller('seller@example.com');
      await setStatusFromCall(t.db, { orgId, crmRecordId: lead.crmRecordId, outcome: 'not_interested', now: NOW });
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'not_interested' });
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await eventsOf(conv.id)).toHaveLength(1);

      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW })).toBe(true);

      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      expect(await suppressionRows(orgId)).toMatchObject([{ address: 'seller@example.com', reason: 'opted_out', conversationId: conv.id }]);
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
      const events = await eventsOf(conv.id);
      expect(events).toHaveLength(2);
      expect(events.map((e) => [e.detail, e.sfLogStatus])).toEqual([['not_interested', 'skipped'], ['opted_out', 'pending']]);
    });

    it('after a call said not_interested, a complaint is recorded as complained', async () => {
      const { orgId, lead, conv } = await seedEnrolledSeller('seller@example.com');
      await setStatusFromCall(t.db, { orgId, crmRecordId: lead.crmRecordId, outcome: 'not_interested', now: NOW });
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'complained', now: NOW })).toBe(true);
      expect(await conversationRow(conv.id)).toMatchObject({ stopReason: 'complained' });
      expect(await suppressionRows(orgId)).toMatchObject([{ reason: 'complained' }]);
    });

    it('an already stopped conversation still sweeps a duplicate record that appeared later', async () => {
      const { orgId, campaignId, conv } = await seedEnrolledSeller('seller@example.com');
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW })).toBe(true);
      const later = await seedDuplicate(orgId, campaignId);
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW })).toBe(false);
      expect(await conversationsOfRecord(orgId, later.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: 'opted_out' }]);
      expect(await enrollmentById(t.db, later.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
      expect(await eventsOf(conv.id)).toHaveLength(1);
    });

    it('asked_to_stop on a conversation stopped as not_interested suppresses the address but keeps the reason and adds no event', async () => {
      const { orgId, lead, conv } = await seedEnrolledSeller('seller@example.com');
      await setStatusFromCall(t.db, { orgId, crmRecordId: lead.crmRecordId, outcome: 'not_interested', now: NOW });
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'asked_to_stop', now: NOW })).toBe(false);
      expect(await conversationRow(conv.id)).toMatchObject({ stopReason: 'not_interested' });
      expect(await eventsOf(conv.id)).toHaveLength(1);
      expect(await suppressionRows(orgId)).toMatchObject([{ reason: 'opted_out' }]);
    });

    it('not_interested stops only its own record: it suppresses nothing and leaves a same-address record untouched (I3)', async () => {
      const { orgId, campaignId, lead, conv } = await seedEnrolledSeller('seller@example.com');
      const duplicate = await seedDuplicate(orgId, campaignId);
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'not_interested', now: NOW })).toBe(true);
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'not_interested' });
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toEqual([]);
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });
      expect(await touchById(t.db, duplicate.touchId)).toMatchObject({ status: 'planned' });
      // Already stopped as not_interested: a second one is no news, and still no suppression.
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'not_interested', now: NOW })).toBe(false);
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toEqual([]);
    });

    describe('an address shared by many records (SHARED_ADDRESS_LIMIT, I3)', () => {
      /** The seller plus `others` more records with the same address (any case), each with an active enrollment. */
      async function seedSharedAddress(others: number) {
        const seller = await seedEnrolledSeller('shared@example.com');
        const siblings = [];
        for (let i = 0; i < others; i += 1) siblings.push(await seedDuplicate(seller.orgId, seller.campaignId, i % 2 === 0 ? 'Shared@Example.com' : ' shared@example.COM '));
        return { ...seller, siblings };
      }

      it('the limit is 5 records', () => {
        expect(SHARED_ADDRESS_LIMIT).toBe(5);
      });

      it('opted_out with the address on 3 records stops both siblings, and nobody is told', async () => {
        const { orgId, conv, siblings } = await seedSharedAddress(2);
        const notices: SharedAddressNotice[] = [];
        await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW, onSharedAddress: (n) => notices.push(n) });
        for (const sibling of siblings) {
          expect(await conversationsOfRecord(orgId, sibling.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: 'opted_out' }]);
          expect(await enrollmentById(t.db, sibling.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
        }
        expect(notices).toEqual([]);
      });

      it('with the address on exactly 5 records the stop still spreads', async () => {
        const { orgId, conv, siblings } = await seedSharedAddress(4);
        const notices: SharedAddressNotice[] = [];
        await stopSeller(t.db, { conversationId: conv.id, reason: 'asked_to_stop', now: NOW, onSharedAddress: (n) => notices.push(n) });
        for (const sibling of siblings) expect(await enrollmentById(t.db, sibling.enrollmentId)).toMatchObject({ status: 'exited' });
        expect(notices).toEqual([]);
      });

      it.each(['opted_out', 'complained', 'asked_to_stop'] as const)(
        '%s with the address on 7 records stops only its own record, still suppresses the address, and tells the caller once (ids and a count)',
        async (reason) => {
          const { orgId, lead, conv, siblings } = await seedSharedAddress(6);
          const notices: SharedAddressNotice[] = [];
          expect(await stopSeller(t.db, { conversationId: conv.id, reason, now: NOW, onSharedAddress: (n) => notices.push(n) })).toBe(true);
          expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: reason });
          expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: reason });
          for (const sibling of siblings) {
            expect(await conversationsOfRecord(orgId, sibling.crmRecordId)).toEqual([]);
            expect(await enrollmentById(t.db, sibling.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });
          }
          expect(await suppressionRows(orgId)).toMatchObject([{ address: 'shared@example.com', reason: reason === 'complained' ? 'complained' : 'opted_out' }]);
          expect(notices).toEqual([{ orgId, conversationId: conv.id, sharedRecordCount: 7 }]);
          expect(JSON.stringify(notices)).not.toMatch(/@/);
        },
      );

      it('an already stopped conversation that meets the shared address tells the caller again and still spreads nothing', async () => {
        const { orgId, conv, siblings } = await seedSharedAddress(6);
        await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
        const notices: SharedAddressNotice[] = [];
        expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW, onSharedAddress: (n) => notices.push(n) })).toBe(false);
        expect(notices).toEqual([{ orgId, conversationId: conv.id, sharedRecordCount: 7 }]);
        for (const sibling of siblings) expect(await enrollmentById(t.db, sibling.enrollmentId)).toMatchObject({ status: 'active' });
      });

      it('spreads through an emailed address shared by few records while holding back at one shared by many', async () => {
        const { orgId, campaignId, conv, siblings } = await seedSharedAddress(6);
        const eventId = await appendEvent(t.db, { orgId, conversationId: conv.id, kind: 'email', direction: 'out', actor: 'sam', occurredAt: NOW, subject: 's', body: 'b', sfLog: false });
        await t.db.insert(schema.emailMessages).values({ orgId, conversationId: conv.id, eventId, direction: 'out', status: 'sent', purpose: 'first', toAddress: 'old@example.com', fromAddress: 'sam@example.com' });
        const oldHolder = await seedDuplicate(orgId, campaignId, 'old@example.com');
        const notices: SharedAddressNotice[] = [];
        await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW, onSharedAddress: (n) => notices.push(n) });
        expect(await enrollmentById(t.db, oldHolder.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
        for (const sibling of siblings) expect(await enrollmentById(t.db, sibling.enrollmentId)).toMatchObject({ status: 'active' });
        expect((await suppressionRows(orgId)).map((r) => r.address).sort()).toEqual(['old@example.com', 'shared@example.com']);
        expect(notices).toEqual([{ orgId, conversationId: conv.id, sharedRecordCount: 7 }]);
      });

      it('a rolled-back stop tells the caller inside the transaction only (the caller alerts after commit)', async () => {
        const { conv } = await seedSharedAddress(6);
        const notices: SharedAddressNotice[] = [];
        await expect(
          t.db.transaction(async (tx) => {
            await stopSeller(tx as unknown as typeof t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW, onSharedAddress: (n) => notices.push(n) });
            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
        expect(notices).toHaveLength(1);
        expect(await conversationRow(conv.id)).toMatchObject({ status: 'open' });
      });
    });

    describe('the address that was emailed', () => {
      /** An outbound email row of the conversation to `toAddress` (the event it hangs off is created too). */
      async function queueEmail(orgId: string, conversationId: string, toAddress: string, direction: 'out' | 'in' = 'out') {
        const eventId = await appendEvent(t.db, {
          orgId,
          conversationId,
          kind: 'email',
          direction,
          actor: direction === 'out' ? 'sam' : 'seller',
          occurredAt: NOW,
          subject: 'Your house',
          body: 'Hello there.',
          sfLog: false,
        });
        await t.db.insert(schema.emailMessages).values({
          orgId,
          conversationId,
          eventId,
          direction,
          status: direction === 'out' ? 'sent' : 'received',
          purpose: direction === 'out' ? 'first' : 'inbound',
          toAddress,
          fromAddress: 'sam@example.com',
        });
      }
      const changeRecordEmail = (crmRecordId: string, email: string | null) =>
        t.db.update(schema.crmRecords).set({ email }).where(eq(schema.crmRecords.id, crmRecordId));

      it.each(['opted_out', 'asked_to_stop', 'complained'] as const)(
        '%s suppresses the address Sam wrote to even after the record email changed in Salesforce, and the new one too',
        async (reason) => {
          const { orgId, lead, conv } = await seedEnrolledSeller('old@example.com');
          await queueEmail(orgId, conv.id, 'Old@Example.com');
          await changeRecordEmail(lead.crmRecordId, 'new@example.com');
          expect(await stopSeller(t.db, { conversationId: conv.id, reason, now: NOW })).toBe(true);
          const expected = reason === 'complained' ? 'complained' : 'opted_out';
          const rows = (await suppressionRows(orgId)).map((r) => [r.address, r.reason, r.conversationId]).sort();
          expect(rows).toEqual([
            ['new@example.com', expected, conv.id],
            ['old@example.com', expected, conv.id],
          ]);
        },
      );

      it('suppresses every distinct address it wrote to, once each, and never an inbound sender', async () => {
        const { orgId, conv } = await seedEnrolledSeller('seller@example.com');
        await queueEmail(orgId, conv.id, 'a@example.com');
        await queueEmail(orgId, conv.id, ' A@EXAMPLE.COM ');
        await queueEmail(orgId, conv.id, 'b@example.com');
        await queueEmail(orgId, conv.id, 'sam@reply.example.com', 'in');
        await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
        expect((await suppressionRows(orgId)).map((r) => r.address).sort()).toEqual(['a@example.com', 'b@example.com', 'seller@example.com']);
      });

      it('suppresses the emailed address even when the record has no email any more', async () => {
        const { orgId, lead, conv } = await seedEnrolledSeller('old@example.com');
        await queueEmail(orgId, conv.id, 'old@example.com');
        await changeRecordEmail(lead.crmRecordId, null);
        await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
        expect(await suppressionRows(orgId)).toMatchObject([{ address: 'old@example.com', reason: 'opted_out' }]);
      });

      it('not_interested suppresses neither the emailed address nor the current one', async () => {
        const { orgId, lead, conv } = await seedEnrolledSeller('old@example.com');
        await queueEmail(orgId, conv.id, 'old@example.com');
        await changeRecordEmail(lead.crmRecordId, 'new@example.com');
        expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'not_interested', now: NOW })).toBe(true);
        expect(await suppressionRows(orgId)).toEqual([]);
      });

      it('an already stopped conversation still suppresses the emailed address on a later opt-out', async () => {
        const { orgId, lead, conv } = await seedEnrolledSeller('old@example.com');
        await queueEmail(orgId, conv.id, 'old@example.com');
        await changeRecordEmail(lead.crmRecordId, 'new@example.com');
        await stopSeller(t.db, { conversationId: conv.id, reason: 'not_interested', now: NOW });
        await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
        expect((await suppressionRows(orgId)).map((r) => r.address).sort()).toEqual(['new@example.com', 'old@example.com']);
      });

      it('inserts the suppressions in one canonical (sorted) order, whatever order the addresses came in', async () => {
        // Two sweeps over the same addresses must lock them in the same order or they can deadlock (40P01).
        const { orgId, conv } = await seedEnrolledSeller('z-current@example.com');
        await queueEmail(orgId, conv.id, 'm@example.com');
        await queueEmail(orgId, conv.id, 'a@example.com');
        await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
        // One transaction, so heap order is insertion order.
        const inserted = await t.pool.query('select address from email_suppressions where org_id = $1 order by ctid', [orgId]);
        expect(inserted.rows.map((r: { address: string }) => r.address)).toEqual(['a@example.com', 'm@example.com', 'z-current@example.com']);
      });

      describe('another record that carries an address Sam emailed', () => {
        /** The seller's record changed email after Sam wrote; `holder` is another record that now has the old address. */
        async function seedMovedSeller() {
          const { orgId, campaignId, lead, conv } = await seedEnrolledSeller('old@example.com');
          await queueEmail(orgId, conv.id, 'old@example.com');
          await changeRecordEmail(lead.crmRecordId, 'new@example.com');
          const holder = await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email: 'OLD@Example.com' } });
          return { orgId, campaignId, lead, conv, holder };
        }

        it.each(['opted_out', 'asked_to_stop', 'complained'] as const)(
          'is stopped and its enrollment exited after the seller %s, though the seller\'s current email is different',
          async (reason) => {
            const { orgId, lead, conv, holder } = await seedMovedSeller();
            expect(await stopSeller(t.db, { conversationId: conv.id, reason, now: NOW })).toBe(true);
            expect(await conversationsOfRecord(orgId, holder.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: reason }]);
            expect(await enrollmentById(t.db, holder.enrollmentId)).toMatchObject({ status: 'exited', exitReason: reason });
            expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: reason });
            expect(await eventsOf((await conversationsOfRecord(orgId, holder.crmRecordId))[0]!.id)).toMatchObject([{ kind: 'status', detail: reason, sfLogStatus: 'pending' }]);
          },
        );

        it('stops the holders of every emailed address, once each, and leaves a record with another address alone', async () => {
          const { orgId, campaignId, conv, holder } = await seedMovedSeller();
          await queueEmail(orgId, conv.id, 'older@example.com');
          const olderHolder = await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email: ' Older@Example.com ' } });
          const bystander = await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email: 'bystander@example.com' } });
          await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
          for (const stopped of [holder, olderHolder]) {
            expect(await conversationsOfRecord(orgId, stopped.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: 'opted_out' }]);
            expect(await enrollmentById(t.db, stopped.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
          }
          expect(await conversationsOfRecord(orgId, bystander.crmRecordId)).toEqual([]);
          expect(await enrollmentById(t.db, bystander.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });
        });

        it('not_interested does not suppress, so it does not reach the old address\'s holder either', async () => {
          const { orgId, conv, holder } = await seedMovedSeller();
          expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'not_interested', now: NOW })).toBe(true);
          expect(await conversationsOfRecord(orgId, holder.crmRecordId)).toEqual([]);
          expect(await enrollmentById(t.db, holder.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });
        });

        it('a practice conversation never reaches it', async () => {
          const { orgId, lead, holder } = await seedMovedSeller();
          const admin = await seedUser(t.db, orgId);
          const practice = await ensureConversation(t.db, { orgId, crmRecordId: lead.crmRecordId, practiceUserId: admin });
          await queueEmail(orgId, practice.id, 'old@example.com');
          expect(await stopSeller(t.db, { conversationId: practice.id, reason: 'opted_out', now: NOW })).toBe(true);
          expect(await conversationsOfRecord(orgId, holder.crmRecordId)).toEqual([]);
          expect(await enrollmentById(t.db, holder.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });
        });

        it('is swept even when the seller\'s record has no email left', async () => {
          const { orgId, lead, conv, holder } = await seedMovedSeller();
          await changeRecordEmail(lead.crmRecordId, null);
          await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
          expect(await conversationsOfRecord(orgId, holder.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: 'opted_out' }]);
        });
      });

      it("never reaches another conversation's addresses or a practice conversation's", async () => {
        const { orgId, lead, conv } = await seedEnrolledSeller('seller@example.com');
        const otherRecord = await seedRecord(t.db, orgId, snapshot({ sfRecordId: leadId(900_000 + (seq += 1)), email: 'someone-else@example.com' }));
        const other = await ensureConversation(t.db, { orgId, crmRecordId: otherRecord });
        await queueEmail(orgId, other.id, 'someone-else@example.com');
        const admin = await seedUser(t.db, orgId);
        const practice = await ensureConversation(t.db, { orgId, crmRecordId: lead.crmRecordId, practiceUserId: admin });
        await queueEmail(orgId, practice.id, 'practice-copy@example.com');
        await stopSeller(t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW });
        expect((await suppressionRows(orgId)).map((r) => r.address)).toEqual(['seller@example.com']);
        // And stopping the practice conversation itself still touches nothing outside its row.
        await stopSeller(t.db, { conversationId: practice.id, reason: 'opted_out', now: NOW });
        expect((await suppressionRows(orgId)).map((r) => r.address)).toEqual(['seller@example.com']);
      });
    });

    it('a practice conversation that is already stopped is false and reaches nothing', async () => {
      const { orgId, campaignId, lead } = await seedEnrolledSeller('seller@example.com');
      const duplicate = await seedDuplicate(orgId, campaignId);
      const admin = await seedUser(t.db, orgId);
      const practice = await ensureConversation(t.db, { orgId, crmRecordId: lead.crmRecordId, practiceUserId: admin });
      expect(await stopSeller(t.db, { conversationId: practice.id, reason: 'not_interested', now: NOW })).toBe(true);
      expect(await stopSeller(t.db, { conversationId: practice.id, reason: 'opted_out', now: NOW })).toBe(false);
      expect(await conversationRow(practice.id)).toMatchObject({ stopReason: 'not_interested' });
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'active' });
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'active' });
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toEqual([]);
      expect(await eventsOf(practice.id)).toHaveLength(1);
    });

    it('is all or nothing: an outer transaction that rolls back undoes the stop', async () => {
      const { orgId, lead, conv } = await seedEnrolledSeller('seller@example.com');
      await expect(
        t.db.transaction(async (tx) => {
          expect(await stopSeller(tx as unknown as typeof t.db, { conversationId: conv.id, reason: 'opted_out', now: NOW })).toBe(true);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'open', stopReason: null });
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'active' });
      expect(await eventsOf(conv.id)).toHaveLength(0);
    });
  });

  describe('setStatusFromCall', () => {
    const call = async (orgId: string, crmRecordId: string, outcome: Parameters<typeof setStatusFromCall>[1]['outcome']) =>
      setStatusFromCall(t.db, { orgId, crmRecordId, outcome, now: NOW });

    it('appointment_set books an open conversation, with a status event that is not logged to Salesforce', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await call(orgId, crmRecordId, 'appointment_set');
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'booked', stopReason: null });
      const events = await eventsOf(conv.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'status', detail: 'booked', sfLogStatus: 'skipped' });
      // Booked already: a second appointment changes nothing and adds no event.
      await call(orgId, crmRecordId, 'appointment_set');
      expect(await eventsOf(conv.id)).toHaveLength(1);
    });

    it('creates the conversation when there is none', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      await call(orgId, crmRecordId, 'appointment_set');
      const created = await t.db
        .select()
        .from(schema.sellerConversations)
        .where(and(eq(schema.sellerConversations.orgId, orgId), eq(schema.sellerConversations.crmRecordId, crmRecordId)));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ status: 'booked', practiceUserId: null });
    });

    it('does nothing for a voicemail, a null outcome or any other outcome', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      for (const outcome of ['voicemail', 'no_answer', 'qualified_transferred', 'other', null] as const) await call(orgId, crmRecordId, outcome);
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'open', stopReason: null });
      expect(await eventsOf(conv.id)).toHaveLength(0);
    });

    it('do_not_call stops a booked conversation as asked_to_stop', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await call(orgId, crmRecordId, 'appointment_set');
      await call(orgId, crmRecordId, 'do_not_call');
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'asked_to_stop' });
      const stop = (await eventsOf(conv.id)).filter((e) => e.detail === 'asked_to_stop');
      expect(stop).toHaveLength(1);
      expect(stop[0]).toMatchObject({ kind: 'status', sfLogStatus: 'skipped' });
    });

    it('not_interested stops an open conversation, and a stopped one stays as it was', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await call(orgId, crmRecordId, 'not_interested');
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'not_interested' });
      await call(orgId, crmRecordId, 'do_not_call');
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'not_interested' });
      expect(await eventsOf(conv.id)).toHaveLength(1);
    });

    it('an appointment does not reopen a stopped conversation', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await call(orgId, crmRecordId, 'do_not_call');
      await call(orgId, crmRecordId, 'appointment_set');
      expect(await conversationRow(conv.id)).toMatchObject({ status: 'stopped', stopReason: 'asked_to_stop' });
    });

    /** A seller (an AI-call lead with an active enrollment) and a duplicate record with the same address and no conversation. */
    async function seedCalledSeller() {
      const { orgId, campaignId } = await seedAiCallCampaign(t.db);
      const lead = await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email: 'seller@example.com' } });
      const duplicate = await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email: 'SELLER@example.com' } });
      return { orgId, campaignId, lead, duplicate };
    }
    const conversationsOfRecord = (orgId: string, crmRecordId: string) =>
      t.db
        .select()
        .from(schema.sellerConversations)
        .where(and(eq(schema.sellerConversations.orgId, orgId), eq(schema.sellerConversations.crmRecordId, crmRecordId)));

    it('do_not_call suppresses the address and sweeps the duplicate record, but leaves its own enrollment to the results tick', async () => {
      const { orgId, lead, duplicate } = await seedCalledSeller();
      await call(orgId, lead.crmRecordId, 'do_not_call');
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });
      expect(await suppressionRows(orgId)).toMatchObject([{ address: 'seller@example.com', reason: 'opted_out' }]);
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: 'asked_to_stop' }]);
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'asked_to_stop' });
      const [own] = await conversationsOfRecord(orgId, lead.crmRecordId);
      expect(await eventsOf(own!.id)).toMatchObject([{ detail: 'asked_to_stop', sfLogStatus: 'skipped' }]);
      const [sibling] = await conversationsOfRecord(orgId, duplicate.crmRecordId);
      expect(await eventsOf(sibling!.id)).toMatchObject([{ detail: 'asked_to_stop', sfLogStatus: 'pending' }]);
    });

    it('not_interested is about one property: it suppresses nothing, leaves the duplicate record alone and its own enrollment to the results tick (I3)', async () => {
      const { orgId, lead, duplicate } = await seedCalledSeller();
      await call(orgId, lead.crmRecordId, 'not_interested');
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'active' });
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toEqual([]);
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });
    });

    it('do_not_call at an address on 7 records stops only its own conversation and tells the caller once', async () => {
      const { orgId, campaignId, lead, duplicate } = await seedCalledSeller();
      const more = [];
      for (let i = 0; i < 5; i += 1) more.push(await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email: 'seller@example.com' } }));
      const notices: SharedAddressNotice[] = [];
      await setStatusFromCall(t.db, { orgId, crmRecordId: lead.crmRecordId, outcome: 'do_not_call', now: NOW, onSharedAddress: (n) => notices.push(n) });
      const [own] = await conversationsOfRecord(orgId, lead.crmRecordId);
      expect(own).toMatchObject({ status: 'stopped', stopReason: 'asked_to_stop' });
      for (const sibling of [duplicate, ...more]) expect(await enrollmentById(t.db, sibling.enrollmentId)).toMatchObject({ status: 'active' });
      expect(await suppressionRows(orgId)).toMatchObject([{ address: 'seller@example.com', reason: 'opted_out' }]);
      expect(notices).toEqual([{ orgId, conversationId: own!.id, sharedRecordCount: 7 }]);
    });

    it('an appointment does not sweep: the duplicate record and its enrollment are left alone', async () => {
      const { orgId, lead, duplicate } = await seedCalledSeller();
      await call(orgId, lead.crmRecordId, 'appointment_set');
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toEqual([]);
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'active' });
      expect(await suppressionRows(orgId)).toEqual([]);
    });

    it('do_not_call on an already stopped conversation still suppresses and sweeps, with no second event', async () => {
      const { orgId, campaignId, lead } = await seedCalledSeller();
      await call(orgId, lead.crmRecordId, 'not_interested');
      const [own] = await conversationsOfRecord(orgId, lead.crmRecordId);
      // A third record with the same address shows up, then the seller says do-not-call.
      const later = await seedReleasedLead(t.db, { orgId, campaignId }, { recordOver: { email: 'seller@EXAMPLE.com' } });
      await call(orgId, lead.crmRecordId, 'do_not_call');
      expect(await conversationRow(own!.id)).toMatchObject({ status: 'stopped', stopReason: 'not_interested' });
      expect(await eventsOf(own!.id)).toHaveLength(1);
      expect(await suppressionRows(orgId)).toMatchObject([{ reason: 'opted_out' }]);
      expect(await conversationsOfRecord(orgId, later.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: 'asked_to_stop' }]);
      expect(await enrollmentById(t.db, later.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'asked_to_stop' });
    });
  });

  describe('suppressAddress / suppressionFor', () => {
    it('stores the address lowercased and finds it in any case', async () => {
      const { orgId } = await seedSeller();
      await suppressAddress(t.db, { orgId, address: 'Seller@Example.com', reason: 'opted_out', conversationId: null });
      expect(await suppressionFor(t.db, orgId, 'SELLER@example.COM')).toBe('opted_out');
      expect(await suppressionFor(t.db, orgId, 'seller@example.com')).toBe('opted_out');
      expect(await suppressionRows(orgId)).toMatchObject([{ address: 'seller@example.com', conversationId: null }]);
      expect(await suppressionFor(t.db, orgId, 'other@example.com')).toBeNull();
    });

    it.each(['opted_out', 'complained'] as const)('a stop upgrades a bounced address: bounced, then %s, stores the stop reason', async (reason) => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await suppressAddress(t.db, { orgId, address: 'seller@example.com', reason: 'bounced', conversationId: null });
      await suppressAddress(t.db, { orgId, address: 'SELLER@example.com', reason, conversationId: conv.id });
      expect(await suppressionFor(t.db, orgId, 'seller@example.com')).toBe(reason);
      expect(await suppressionRows(orgId)).toMatchObject([{ address: 'seller@example.com', conversationId: conv.id }]);
    });

    it('an upgrade with no conversation keeps the one the bounce recorded', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await suppressAddress(t.db, { orgId, address: 'seller@example.com', reason: 'bounced', conversationId: conv.id });
      await suppressAddress(t.db, { orgId, address: 'seller@example.com', reason: 'opted_out', conversationId: null });
      expect(await suppressionRows(orgId)).toMatchObject([{ reason: 'opted_out', conversationId: conv.id }]);
    });

    it.each([
      ['opted_out', 'complained'],
      ['opted_out', 'bounced'],
      ['complained', 'opted_out'],
      ['complained', 'bounced'],
      ['bounced', 'bounced'],
    ] as const)('otherwise keeps the first reason: %s, then %s, stays the first', async (first, second) => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await suppressAddress(t.db, { orgId, address: 'seller@example.com', reason: first, conversationId: conv.id });
      await suppressAddress(t.db, { orgId, address: 'SELLER@example.com', reason: second, conversationId: null });
      expect(await suppressionRows(orgId)).toMatchObject([{ reason: first, conversationId: conv.id }]);
    });

    it('is per tenant', async () => {
      const a = await seedSeller();
      const b = await seedSeller();
      await suppressAddress(t.db, { orgId: a.orgId, address: 'seller@example.com', reason: 'opted_out', conversationId: null });
      expect(await suppressionFor(t.db, b.orgId, 'seller@example.com')).toBeNull();
    });
  });
});
