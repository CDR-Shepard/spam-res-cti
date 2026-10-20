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

    it('not_interested never suppresses the address, but still stops the seller across records', async () => {
      const { orgId, campaignId, lead, conv } = await seedEnrolledSeller('seller@example.com');
      const duplicate = await seedDuplicate(orgId, campaignId);
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'not_interested', now: NOW })).toBe(true);
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'not_interested' });
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: 'not_interested' }]);
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'not_interested' });
      // Already stopped as not_interested: a second one is no news, and still no suppression.
      expect(await stopSeller(t.db, { conversationId: conv.id, reason: 'not_interested', now: NOW })).toBe(false);
      expect(await suppressionRows(orgId)).toEqual([]);
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

    it('not_interested sweeps the duplicate record but suppresses nothing and leaves its own enrollment', async () => {
      const { orgId, lead, duplicate } = await seedCalledSeller();
      await call(orgId, lead.crmRecordId, 'not_interested');
      expect(await enrollmentById(t.db, lead.enrollmentId)).toMatchObject({ status: 'active' });
      expect(await suppressionRows(orgId)).toEqual([]);
      expect(await conversationsOfRecord(orgId, duplicate.crmRecordId)).toMatchObject([{ status: 'stopped', stopReason: 'not_interested' }]);
      expect(await enrollmentById(t.db, duplicate.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'not_interested' });
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

    it('keeps the first reason', async () => {
      const { orgId, crmRecordId } = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId, crmRecordId });
      await suppressAddress(t.db, { orgId, address: 'seller@example.com', reason: 'bounced', conversationId: conv.id });
      await suppressAddress(t.db, { orgId, address: 'SELLER@example.com', reason: 'complained', conversationId: null });
      expect(await suppressionFor(t.db, orgId, 'seller@example.com')).toBe('bounced');
      expect(await suppressionRows(orgId)).toHaveLength(1);
    });

    it('is per tenant', async () => {
      const a = await seedSeller();
      const b = await seedSeller();
      await suppressAddress(t.db, { orgId: a.orgId, address: 'seller@example.com', reason: 'opted_out', conversationId: null });
      expect(await suppressionFor(t.db, b.orgId, 'seller@example.com')).toBeNull();
    });
  });
});
