/**
 * Real Postgres: the outbox and the send tick, with a fake Resend (the real API is never called). The rules
 * under test are the ones that keep a seller from a wrong or a doubled email: the gates, the daily cap, the
 * recipient's hours, one claim per row, and the idempotency window around a crash.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { leadId, seedCampaign, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { seedPlanLead, seedUser } from '../test/call-plan-seed.js';
import { appendEvent, ensureConversation, suppressAddress, type SellerConversationRow } from '../conversations/store.js';
import { queueEmail, sendBlock } from './outbox.js';
import { sendDueEmails } from './send.js';
import type { ResendClient, ResendSendRequest, ResendSendResult } from './resend-client.js';
import type { AlertEvent } from '../alerts.js';

/** Tuesday 12:00 in Chicago (CDT): inside the 08:00-18:00 window. */
const NOW = new Date('2026-10-20T17:00:00.000Z');
/** Tuesday 21:00 in Chicago. */
const EVENING = new Date('2026-10-21T02:00:00.000Z');
/** Tuesday 23:00 in Chicago. */
const LATE = new Date('2026-10-21T04:00:00.000Z');
/** Wednesday 08:00 in Chicago: the window's next opening after EVENING or LATE. */
const MORNING = new Date('2026-10-21T13:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ADDRESS = 'delivered@resend.dev';
const SUBJECT = 'Re: the house on Oak Street';
const BODY = 'Thanks for getting back to me. Would Thursday afternoon work for a quick call?';
/** Distinct Salesforce ids for the extra records a test seeds. */
let twinSeq = 0;
/** A Chicago number: Central time, and Illinois adds no calling-hours rule to the 08:00-18:00 email window (Texas, 512, starts at 09:00). */
const CHICAGO = [{ field: 'MobilePhone', e164: '+13125550100' }];
const CFG = {
  EMAIL_FROM: 'Sam at GG Homes <sam@rethinkre.team>',
  EMAIL_REPLY_DOMAIN: 'reply.rethinkre.team',
  EMAIL_POSTAL_ADDRESS: '18872 MacArthur Blvd #220, Irvine, CA 92612',
  EMAIL_COMPANY_NAME: 'GG Homes',
  API_PUBLIC_URL: 'https://outreach.example.com',
};

type Sent = { req: ResendSendRequest; key: string };

/** A Resend that records every send and answers with `next(callNumber)` (default: accepted). */
function fakeResend(next: (n: number) => ResendSendResult = () => ({ kind: 'sent', id: `re_${randomUUID()}` })): { client: ResendClient; calls: Sent[] } {
  const calls: Sent[] = [];
  const client: ResendClient = {
    async send(req, key) {
      calls.push({ req, key });
      return next(calls.length);
    },
    async getReceived() {
      throw new Error('getReceived is not used by the send tick');
    },
  };
  return { client, calls };
}

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe.skipIf(!pgLane)('outbox and send tick (real Postgres)', () => {
  let t: TestDb;
  let db: Db;
  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });
  // The tick scans every tenant's due rows, so a row left over from one test must not reach the next.
  afterEach(async () => {
    await t.pool.query('delete from conversation_events');
  });

  interface Seller {
    orgId: string;
    crmRecordId: string;
    /** The call plan on the seller's AI call enrollment (approved unless `approved: false`). */
    planId: string;
    conv: SellerConversationRow;
  }

  interface SellerOptions {
    settings?: Record<string, unknown>;
    phones?: Array<{ field: string; e164: string }>;
    sfEmailOptOut?: boolean;
    /** false = the plan is only proposed (warm leads only: a first email needs one a person approved). */
    approved?: boolean;
  }

  /** A fresh tenant (Sam email on) with one seller in Chicago on an AI call campaign, an approved plan, and their conversation. */
  async function seedSeller(over: SellerOptions = {}): Promise<Seller> {
    const orgId = await seedOrg(db, over.settings ?? { samEmail: { enabled: true } });
    const campaign = await seedCampaign(db, orgId, { mode: 'ai_call', status: 'active' });
    const lead = await seedPlanLead(
      db,
      { orgId, campaignId: campaign.id },
      { planStatus: over.approved === false ? 'proposed' : 'approved', phones: over.phones ?? CHICAGO, recordOver: { email: ADDRESS, sfEmailOptOut: over.sfEmailOptOut ?? false } },
    );
    return { orgId, crmRecordId: lead.crmRecordId, planId: lead.planId!, conv: await ensureConversation(db, { orgId, crmRecordId: lead.crmRecordId }) };
  }

  async function seedPracticeSeller(over: SellerOptions = {}): Promise<Seller & { adminId: string }> {
    const seller = await seedSeller(over);
    const adminId = await seedUser(db, seller.orgId);
    const conv = await ensureConversation(db, { orgId: seller.orgId, crmRecordId: seller.crmRecordId, practiceUserId: adminId });
    return { ...seller, conv, adminId };
  }

  const queue = (s: Seller, over: Partial<Parameters<typeof queueEmail>[1]> = {}) =>
    queueEmail(db, {
      orgId: s.orgId,
      conversationId: s.conv.id,
      to: ADDRESS,
      from: CFG.EMAIL_FROM,
      subject: SUBJECT,
      body: BODY,
      purpose: 'reply',
      requestedBy: null,
      inReplyTo: '<seller-1@mail.example.com>',
      references: '<seller-1@mail.example.com>',
      sendAfter: new Date(NOW.getTime() - MINUTE),
      ...over,
    });

  async function rowOf(emailId: string) {
    const [row] = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailId));
    return row!;
  }

  async function eventOf(eventId: string) {
    const [row] = await db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.id, eventId));
    return row!;
  }

  async function setConversation(id: string, set: Partial<typeof schema.sellerConversations.$inferInsert>) {
    await db.update(schema.sellerConversations).set(set).where(eq(schema.sellerConversations.id, id));
  }

  /** Another email of the seller's that already went out `ago` before NOW. */
  async function seedSent(s: Seller, ago: number, status: 'sent' | 'delivered' | 'sending' = 'sent'): Promise<string> {
    const { emailId } = await queue(s);
    const at = new Date(NOW.getTime() - ago);
    await db
      .update(schema.emailMessages)
      .set({ status, sentAt: status === 'sending' ? null : at, claimedAt: at, attempts: 1, resendId: status === 'sending' ? null : `re_${randomUUID()}` })
      .where(eq(schema.emailMessages.id, emailId));
    return emailId;
  }

  /**
   * A row a dead tick left `sending`: claimed `claimedAgo` before NOW, and first handed to Resend `firstAttemptAgo` before NOW
   * (null = it never got as far as Resend).
   */
  async function strand(emailId: string, claimedAgo: number, firstAttemptAgo: number | null, attempts = 1) {
    await db
      .update(schema.emailMessages)
      .set({
        status: 'sending',
        attempts,
        claimedAt: new Date(NOW.getTime() - claimedAgo),
        firstAttemptAt: firstAttemptAgo === null ? null : new Date(NOW.getTime() - firstAttemptAgo),
      })
      .where(eq(schema.emailMessages.id, emailId));
  }

  const tick = (resend: ResendClient, over: { now?: Date; batch?: number; log?: ReturnType<typeof fakeLog> } = {}) =>
    sendDueEmails({ db, resend, cfg: CFG, now: over.now ?? NOW, log: over.log ?? fakeLog(), ...(over.batch === undefined ? {} : { batch: over.batch }) });

  describe('queueEmail', () => {
    it('writes one email/out/sam timeline event (not yet logged to Salesforce) and one queued row, together', async () => {
      const s = await seedSeller();
      const sendAfter = new Date(NOW.getTime() + HOUR);
      const { emailId, eventId } = await queue(s, { sendAfter, purpose: 'first', requestedBy: await seedUser(db, s.orgId), touchId: null });
      const event = await eventOf(eventId);
      expect(event).toMatchObject({ orgId: s.orgId, conversationId: s.conv.id, kind: 'email', direction: 'out', actor: 'sam', subject: SUBJECT, body: BODY, sfLogStatus: 'skipped' });
      const row = await rowOf(emailId);
      expect(row).toMatchObject({
        orgId: s.orgId,
        conversationId: s.conv.id,
        eventId,
        direction: 'out',
        status: 'queued',
        purpose: 'first',
        toAddress: ADDRESS,
        fromAddress: CFG.EMAIL_FROM,
        inReplyTo: '<seller-1@mail.example.com>',
        references: '<seller-1@mail.example.com>',
        attempts: 0,
        claimedAt: null,
        resendId: null,
        sentAt: null,
      });
      expect(row.sendAfter).toEqual(sendAfter);
      expect(row.requestedBy).not.toBeNull();
    });

    it('keeps exactly one row per event: a second row for the same event is refused by the database', async () => {
      const s = await seedSeller();
      const { eventId } = await queue(s);
      const second = db.insert(schema.emailMessages).values({
        orgId: s.orgId,
        conversationId: s.conv.id,
        eventId,
        direction: 'out',
        status: 'queued',
        purpose: 'reply',
        toAddress: ADDRESS,
        fromAddress: CFG.EMAIL_FROM,
        sendAfter: NOW,
      });
      await expect(second).rejects.toMatchObject({ code: '23505', constraint: 'email_messages_event_unique' });
      const rows = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.eventId, eventId));
      expect(rows).toHaveLength(1);
    });

    it('refuses a purpose that does not fit the conversation, writing nothing: no `practice` on a real conversation, no `first` on a practice one', async () => {
      const real = await seedSeller();
      const practice = await seedPracticeSeller();
      await expect(queue(real, { purpose: 'practice' })).rejects.toThrow('does not fit');
      await expect(queue(practice, { purpose: 'first' })).rejects.toThrow('does not fit');
      for (const s of [real, practice]) {
        expect(await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.orgId, s.orgId))).toHaveLength(0);
        expect(await db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.orgId, s.orgId))).toHaveLength(0);
      }
    });

    it('Sam may answer on a practice conversation: `practice`, `reply` and `holding` queue there, `reply` and `holding` on a real one too', async () => {
      const practice = await seedPracticeSeller();
      for (const purpose of ['practice', 'reply', 'holding'] as const) {
        const { emailId, eventId } = await queue(practice, { purpose, requestedBy: purpose === 'practice' ? practice.adminId : null });
        expect(await rowOf(emailId), purpose).toMatchObject({ purpose, status: 'queued', conversationId: practice.conv.id });
        expect((await eventOf(eventId)).sfLogStatus, purpose).toBe('skipped');
      }
      const real = await seedSeller();
      for (const purpose of ['first', 'reply', 'holding'] as const) {
        expect((await rowOf((await queue(real, { purpose })).emailId)).purpose).toBe(purpose);
      }
    });

    it('a conversation of another tenant queues nothing: no event, no row', async () => {
      const s = await seedSeller();
      const other = await seedSeller();
      await expect(queue(s, { conversationId: other.conv.id })).rejects.toThrow();
      expect(await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.orgId, s.orgId))).toHaveLength(0);
      expect(await db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.orgId, s.orgId))).toHaveLength(0);
    });

    it('a practice conversation\'s event is never logged to Salesforce', async () => {
      const p = await seedPracticeSeller();
      const { eventId } = await queue(p, { purpose: 'practice', requestedBy: p.adminId });
      expect((await eventOf(eventId)).sfLogStatus).toBe('skipped');
    });
  });

  describe('sendDueEmails', () => {
    it('sends a due reply once, with the idempotency key, the conversation\'s reply address and the footer', async () => {
      const s = await seedSeller();
      const { emailId, eventId } = await queue(s);
      await db.update(schema.conversationEvents).set({ occurredAt: new Date(NOW.getTime() - HOUR) }).where(eq(schema.conversationEvents.id, eventId));
      const resend = fakeResend(() => ({ kind: 'sent', id: 're_abc123' }));

      expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });

      expect(resend.calls).toHaveLength(1);
      const { req, key } = resend.calls[0]!;
      expect(key).toBe(`email:${emailId}`);
      expect(req.to).toBe(ADDRESS);
      expect(req.from).toBe(CFG.EMAIL_FROM);
      expect(req.subject).toBe(SUBJECT);
      expect(req.replyTo).toBe(`sam+${s.conv.token}@reply.rethinkre.team`);
      expect(req.text).toContain(BODY);
      expect(req.text).toContain('To stop hearing from Sam');
      expect(req.text).toContain(`https://outreach.example.com/api/email/unsubscribe/${s.conv.token}`);
      expect(req.text).toContain('18872 MacArthur Blvd #220, Irvine, CA 92612');
      expect(req.html).toContain('unsubscribe here');
      expect(req.headers['List-Unsubscribe']).toContain(`unsubscribe+${s.conv.token}@reply.rethinkre.team`);
      expect(req.headers['In-Reply-To']).toBe('<seller-1@mail.example.com>');
      expect(req.headers['References']).toBe('<seller-1@mail.example.com>');

      expect(await rowOf(emailId)).toMatchObject({ status: 'sent', resendId: 're_abc123', sentAt: NOW, attempts: 1, lastError: null });
      expect(await eventOf(eventId)).toMatchObject({ sfLogStatus: 'pending', occurredAt: NOW });

      // A second tick finds nothing to do.
      expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 0 });
      expect(resend.calls).toHaveLength(1);
    });

    it('does not send a row that is not due yet', async () => {
      const s = await seedSeller();
      const { emailId } = await queue(s, { sendAfter: new Date(NOW.getTime() + MINUTE) });
      const resend = fakeResend();
      await tick(resend.client);
      expect(resend.calls).toHaveLength(0);
      expect(await rowOf(emailId)).toMatchObject({ status: 'queued', attempts: 0 });
    });

    it('stops at the batch size and takes the oldest due rows first', async () => {
      const s = await seedSeller();
      const first = await queue(s, { sendAfter: new Date(NOW.getTime() - 3 * MINUTE) });
      const second = await queue(s, { sendAfter: new Date(NOW.getTime() - 2 * MINUTE) });
      const third = await queue(s, { sendAfter: new Date(NOW.getTime() - MINUTE) });
      const resend = fakeResend();
      expect((await tick(resend.client, { batch: 2 })).sent).toBe(2);
      expect(resend.calls.map((c) => c.key)).toEqual([`email:${first.emailId}`, `email:${second.emailId}`]);
      expect((await rowOf(third.emailId)).status).toBe('queued');
    });

    it('two ticks at once never send the same row (compare-and-swap claim)', async () => {
      // Several sellers, so the two ticks really do overlap on the same due rows.
      const ids: string[] = [];
      for (let i = 0; i < 8; i += 1) ids.push((await queue(await seedSeller())).emailId);
      const resend = fakeResend();
      const [a, b] = await Promise.all([tick(resend.client), tick(resend.client)]);
      expect(a.sent + b.sent).toBe(8);
      expect(resend.calls.map((c) => c.key).sort()).toEqual(ids.map((id) => `email:${id}`).sort());
      for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('a handler=person conversation is canceled as taken_over and Resend sees nothing', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { handler: 'person' });
      const { emailId, eventId } = await queue(s);
      const resend = fakeResend();
      expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 1, failed: 0 });
      expect(resend.calls).toHaveLength(0);
      expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'taken_over', resendId: null, sentAt: null });
      expect((await eventOf(eventId)).sfLogStatus).toBe('skipped');
    });

    it('cancels with the block as last_error: the timeline shows it as the not-sent reason', async () => {
      const s = await seedSeller({ settings: {} });
      const { emailId } = await queue(s);
      await tick(fakeResend().client);
      expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'disabled' });
    });

    it('gates each tenant by its own settings in one tick', async () => {
      const on = await seedSeller();
      const off = await seedSeller({ settings: { samEmail: { enabled: false } } });
      const a = await queue(on);
      const b = await queue(off);
      const resend = fakeResend();
      expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 1, failed: 0 });
      expect((await rowOf(a.emailId)).status).toBe('sent');
      expect(await rowOf(b.emailId)).toMatchObject({ status: 'canceled', lastError: 'disabled' });
    });

    describe("a seller's answer canceled for the tenant's switch or the daily cap goes to a person (M6)", () => {
      /** A tick with its own alert sink. */
      const tickWithAlerts = async (resend: ResendClient, now: Date = NOW) => {
        const alerts: AlertEvent[] = [];
        const log = fakeLog();
        const counts = await sendDueEmails({ db, resend, cfg: CFG, now, log, alert: async (event) => void alerts.push(event) });
        return { counts, alerts, log };
      };
      const conversationOf = async (id: string) => (await db.select().from(schema.sellerConversations).where(eq(schema.sellerConversations.id, id)))[0]!;
      const PAUSED = { samEmail: { enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint' } };

      it.each([
        ['paused', 'reply', { settings: PAUSED }],
        ['paused', 'holding', { settings: PAUSED }],
        ['disabled', 'reply', { settings: {} }],
        ['disabled', 'holding', { settings: { samEmail: { enabled: false } } }],
      ] as const)('%s: a %s email is canceled, the conversation flagged unsure, and one seller_needs_person alert carries ids only', async (block, purpose, over) => {
        const s = await seedSeller(over);
        const { emailId } = await queue(s, { purpose });
        const resend = fakeResend();
        const { counts, alerts, log } = await tickWithAlerts(resend.client);
        expect(counts.canceled).toBe(1);
        expect(resend.calls).toHaveLength(0);
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: block });
        expect(await conversationOf(s.conv.id)).toMatchObject({ flagReason: 'unsure' });
        expect(alerts).toEqual([
          expect.objectContaining({ kind: 'seller_needs_person', orgId: s.orgId, context: { conversationId: s.conv.id, emailId, reason: 'unsure', block } }),
        ]);
        const everything = JSON.stringify([alerts, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
        for (const secret of [ADDRESS, SUBJECT, BODY]) expect(everything).not.toContain(secret);
      });

      it('daily_cap: a reply over the cap is canceled and the conversation flagged unsure, with one alert', async () => {
        const s = await seedSeller();
        for (const ago of [HOUR, 2 * HOUR, 3 * HOUR]) await seedSent(s, ago);
        const { emailId } = await queue(s);
        const { alerts } = await tickWithAlerts(fakeResend().client);
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'daily_cap' });
        expect(await conversationOf(s.conv.id)).toMatchObject({ flagReason: 'unsure' });
        expect(alerts).toEqual([expect.objectContaining({ kind: 'seller_needs_person', context: expect.objectContaining({ block: 'daily_cap' }) })]);
      });

      it('a first email canceled for the switch is unchanged: no flag, no alert', async () => {
        const s = await seedSeller({ settings: PAUSED });
        await queue(s, { purpose: 'first', inReplyTo: null, references: null });
        const { alerts } = await tickWithAlerts(fakeResend().client);
        expect(await conversationOf(s.conv.id)).toMatchObject({ flagReason: null });
        expect(alerts).toEqual([]);
      });

      it('a practice conversation\'s answer canceled for the switch is unchanged: no flag, no alert', async () => {
        const s = await seedPracticeSeller({ settings: PAUSED });
        await queue(s, { to: 'admin@example.com' });
        const { alerts } = await tickWithAlerts(fakeResend().client);
        expect(await conversationOf(s.conv.id)).toMatchObject({ flagReason: null });
        expect(alerts).toEqual([]);
      });

      it('a reply canceled for a seller rule (suppressed) is unchanged: no flag, no alert', async () => {
        const s = await seedSeller();
        await suppressAddress(db, { orgId: s.orgId, address: ADDRESS, reason: 'opted_out', conversationId: null });
        await queue(s);
        const { alerts } = await tickWithAlerts(fakeResend().client);
        expect(await conversationOf(s.conv.id)).toMatchObject({ flagReason: null });
        expect(alerts).toEqual([]);
      });

      it('an already flagged conversation keeps its first reason and raises no second alert', async () => {
        const s = await seedSeller({ settings: PAUSED });
        await setConversation(s.conv.id, { flagReason: 'offer_or_price', flaggedAt: NOW });
        await queue(s, { purpose: 'holding' });
        const { alerts } = await tickWithAlerts(fakeResend().client);
        expect(await conversationOf(s.conv.id)).toMatchObject({ flagReason: 'offer_or_price' });
        expect(alerts).toEqual([]);
      });

      it('an alert that throws is logged by name and does not undo the flag', async () => {
        const s = await seedSeller({ settings: PAUSED });
        const { emailId } = await queue(s);
        const log = fakeLog();
        await sendDueEmails({ db, resend: fakeResend().client, cfg: CFG, now: NOW, log, alert: async () => Promise.reject(new Error('webhook down')) });
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled' });
        expect(await conversationOf(s.conv.id)).toMatchObject({ flagReason: 'unsure' });
        expect(log.error).toHaveBeenCalled();
      });
    });

    describe('the daily cap', () => {
      it('cancels the 4th email when 3 went out in the last 24 hours', async () => {
        const s = await seedSeller();
        await seedSent(s, 2 * HOUR);
        await seedSent(s, 10 * HOUR, 'delivered');
        await seedSent(s, 23 * HOUR);
        const { emailId } = await queue(s);
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 1, failed: 0 });
        expect(resend.calls).toHaveLength(0);
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'daily_cap' });
      });

      it('does not count the row against itself: 2 others and this one is the 3rd, which goes', async () => {
        const s = await seedSeller();
        await seedSent(s, 2 * HOUR);
        await seedSent(s, 3 * HOUR);
        const { emailId } = await queue(s);
        expect((await tick(fakeResend().client)).sent).toBe(1);
        expect((await rowOf(emailId)).status).toBe('sent');
      });

      it('does not count emails older than 24 hours, or ones that never went out', async () => {
        const s = await seedSeller();
        await seedSent(s, 25 * HOUR);
        await seedSent(s, 48 * HOUR);
        await seedSent(s, 30 * HOUR, 'delivered');
        const failed = await queue(s);
        await db.update(schema.emailMessages).set({ status: 'failed', sentAt: new Date(NOW.getTime() - HOUR) }).where(eq(schema.emailMessages.id, failed.emailId));
        const canceled = await queue(s);
        await db.update(schema.emailMessages).set({ status: 'canceled' }).where(eq(schema.emailMessages.id, canceled.emailId));
        const { emailId } = await queue(s);
        expect((await tick(fakeResend().client)).sent).toBe(1);
        expect((await rowOf(emailId)).status).toBe('sent');
      });

      it('counts an email another tick has claimed and is still sending', async () => {
        const s = await seedSeller();
        await seedSent(s, HOUR);
        await seedSent(s, 2 * HOUR);
        await seedSent(s, MINUTE, 'sending');
        const { emailId } = await queue(s);
        await tick(fakeResend().client);
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'daily_cap' });
      });

      it('is per conversation: another seller\'s emails do not count', async () => {
        const s = await seedSeller();
        const other = await seedSeller();
        await seedSent(other, HOUR);
        await seedSent(other, 2 * HOUR);
        await seedSent(other, 3 * HOUR);
        const { emailId } = await queue(s);
        expect((await tick(fakeResend().client)).sent).toBe(1);
        expect((await rowOf(emailId)).status).toBe('sent');
      });

      it('four due emails in one tick: the first three go and the fourth is canceled daily_cap', async () => {
        const s = await seedSeller();
        const queued = [];
        for (let i = 0; i < 4; i += 1) queued.push(await queue(s, { sendAfter: new Date(NOW.getTime() - (10 - i) * MINUTE) }));
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 3, retried: 0, canceled: 1, failed: 0 });
        expect((await rowOf(queued[3]!.emailId)).lastError).toBe('daily_cap');
      });
    });

    describe('the seller\'s hours (08:00-18:00 local)', () => {
      it('a row due at 21:00 seller-local goes back to queued for 08:00 the next local day', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s, { sendAfter: EVENING });
        const resend = fakeResend();
        expect(await tick(resend.client, { now: EVENING })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 0 });
        expect(resend.calls).toHaveLength(0);
        // 08:00 CDT on Wednesday Oct 21. A deferral is not a send attempt.
        expect(await rowOf(emailId)).toMatchObject({ status: 'queued', sendAfter: new Date('2026-10-21T13:00:00.000Z'), attempts: 0, claimedAt: null });
      });

      it('then sends it at 08:00', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s, { sendAfter: EVENING });
        const resend = fakeResend();
        await tick(resend.client, { now: EVENING });
        expect((await tick(resend.client, { now: new Date('2026-10-21T12:59:00.000Z') })).sent).toBe(0);
        expect((await tick(resend.client, { now: new Date('2026-10-21T13:00:00.000Z') })).sent).toBe(1);
        expect(await rowOf(emailId)).toMatchObject({ status: 'sent', attempts: 1 });
      });

      it('a state\'s own hours narrow the window: a Texas seller waits for 09:00', async () => {
        const s = await seedSeller({ phones: [{ field: 'MobilePhone', e164: '+15125550100' }] });
        const { emailId } = await queue(s, { sendAfter: EVENING });
        await tick(fakeResend().client, { now: EVENING });
        expect((await rowOf(emailId)).sendAfter).toEqual(new Date('2026-10-21T14:00:00.000Z'));
      });

      it('a seller with no phone is scheduled on Central time', async () => {
        const s = await seedSeller({ phones: [] });
        const { emailId } = await queue(s, { sendAfter: EVENING });
        await tick(fakeResend().client, { now: EVENING });
        expect(await rowOf(emailId)).toMatchObject({ status: 'queued', sendAfter: new Date('2026-10-21T13:00:00.000Z') });
      });

      it('a block earlier in the order wins over the hours', async () => {
        const s = await seedSeller();
        await setConversation(s.conv.id, { handler: 'person' });
        const { emailId } = await queue(s, { sendAfter: EVENING });
        await tick(fakeResend().client, { now: EVENING });
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'taken_over' });
      });
    });

    describe('a crash after Resend accepted (Review Focus 5)', () => {
      it('re-sends a row stuck sending 6 minutes, first handed to Resend an hour ago, with the same idempotency key', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        await strand(emailId, 6 * MINUTE, HOUR);
        const resend = fakeResend(() => ({ kind: 'sent', id: 're_same' }));
        expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
        expect(resend.calls.map((c) => c.key)).toEqual([`email:${emailId}`]);
        // The key's 24 hours run from the FIRST attempt, which a re-send must not move.
        expect(await rowOf(emailId)).toMatchObject({ status: 'sent', resendId: 're_same', attempts: 2, firstAttemptAt: new Date(NOW.getTime() - HOUR) });
      });

      it('fails a row stuck sending 6 minutes whose first attempt was 24 hours ago, counts it, and does not send it', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        await strand(emailId, 6 * MINUTE, 24 * HOUR);
        const resend = fakeResend();
        const log = fakeLog();
        expect(await tick(resend.client, { log })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 1 });
        expect(resend.calls).toHaveLength(0);
        expect(await rowOf(emailId)).toMatchObject({ status: 'failed', lastError: 'idempotency_window', resendId: null });
      });

      it('the cut-off is 23 hours since the first attempt, not since the email was created', async () => {
        const s = await seedSeller();
        const inside = await queue(s);
        const outside = await queue(s);
        await strand(inside.emailId, 6 * MINUTE, 23 * HOUR - MINUTE);
        await strand(outside.emailId, 6 * MINUTE, 23 * HOUR + MINUTE);
        // Both were created just now: only the first-attempt time decides.
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 1 });
        expect(resend.calls.map((c) => c.key)).toEqual([`email:${inside.emailId}`]);
        expect((await rowOf(outside.emailId)).lastError).toBe('idempotency_window');
      });

      it('a row that never reached Resend can be re-queued at any age, and is sent', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        await db.update(schema.emailMessages).set({ createdAt: new Date(NOW.getTime() - 30 * HOUR) }).where(eq(schema.emailMessages.id, emailId));
        await strand(emailId, 6 * MINUTE, null);
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
        expect(resend.calls.map((c) => c.key)).toEqual([`email:${emailId}`]);
        expect((await rowOf(emailId)).firstAttemptAt).toEqual(NOW);
      });

      it('a row queued 30 hours ago that was never attempted is still sent', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s, { sendAfter: new Date(NOW.getTime() - 30 * HOUR) });
        await db.update(schema.emailMessages).set({ createdAt: new Date(NOW.getTime() - 30 * HOUR) }).where(eq(schema.emailMessages.id, emailId));
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
        expect((await rowOf(emailId)).status).toBe('sent');
      });

      it('leaves a row alone while its claim is under 5 minutes old (another tick is still on it)', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        await strand(emailId, 4 * MINUTE, HOUR);
        const resend = fakeResend();
        await tick(resend.client);
        expect(resend.calls).toHaveLength(0);
        expect(await rowOf(emailId)).toMatchObject({ status: 'sending', attempts: 1 });
      });

      it('a stranded row is still gated when it comes round again', async () => {
        const s = await seedSeller();
        await setConversation(s.conv.id, { status: 'stopped', stopReason: 'opted_out' });
        const { emailId } = await queue(s);
        await strand(emailId, 6 * MINUTE, HOUR);
        const resend = fakeResend();
        await tick(resend.client);
        expect(resend.calls).toHaveLength(0);
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'stopped' });
      });

      it('a row stranded after its 5th attempt is failed as stuck, not requeued for another round', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        await strand(emailId, 6 * MINUTE, HOUR, 5);
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 1 });
        expect(resend.calls).toHaveLength(0);
        expect(await rowOf(emailId)).toMatchObject({ status: 'failed', lastError: 'stuck', attempts: 5 });
      });
    });

    describe('Resend forgets the key after 24 hours (Review Focus 5 across a weekend)', () => {
      /** Maine (207): 09:00 to 17:00 on weekdays only. Friday 23 Oct 2026, 16:59 EDT. */
      const MAINE = [{ field: 'MobilePhone', e164: '+12075550100' }];
      const FRIDAY_1659 = new Date('2026-10-23T20:59:00.000Z');
      const FRIDAY_1700 = new Date('2026-10-23T21:00:00.000Z');
      const MONDAY_0900 = new Date('2026-10-26T13:00:00.000Z');

      it('a row that timed out at 16:59 Friday is failed when its retry meets the closed window, and Monday does not send it', async () => {
        const s = await seedSeller({ phones: MAINE });
        const { emailId } = await queue(s, { sendAfter: FRIDAY_1659 });
        const resend = fakeResend(() => ({ kind: 'retry', reason: 'timeout' }));
        expect(await tick(resend.client, { now: FRIDAY_1659 })).toEqual({ sent: 0, retried: 1, canceled: 0, failed: 0 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'queued', firstAttemptAt: FRIDAY_1659, sendAfter: FRIDAY_1700 });

        // 17:00: the window has shut and does not open again until Monday 09:00, 64 hours after the first attempt.
        expect(await tick(resend.client, { now: FRIDAY_1700 })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 1 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'failed', lastError: 'idempotency_window' });

        expect(await tick(resend.client, { now: MONDAY_0900 })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 0 });
        expect(resend.calls).toHaveLength(1);
      });

      it('and if no tick ran over the weekend, Monday\'s tick fails it instead of sending a second copy', async () => {
        const s = await seedSeller({ phones: MAINE });
        const { emailId } = await queue(s, { sendAfter: FRIDAY_1659 });
        const resend = fakeResend(() => ({ kind: 'retry', reason: 'timeout' }));
        await tick(resend.client, { now: FRIDAY_1659 });
        expect(await tick(resend.client, { now: MONDAY_0900 })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 1 });
        expect(resend.calls).toHaveLength(1);
        expect(await rowOf(emailId)).toMatchObject({ status: 'failed', lastError: 'idempotency_window' });
      });

      it('a row never handed to Resend simply waits for Monday and is sent then', async () => {
        const s = await seedSeller({ phones: MAINE });
        const { emailId } = await queue(s, { sendAfter: FRIDAY_1700 });
        const resend = fakeResend();
        expect(await tick(resend.client, { now: FRIDAY_1700 })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 0 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'queued', sendAfter: MONDAY_0900, firstAttemptAt: null });
        expect(await tick(resend.client, { now: MONDAY_0900 })).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
        expect(resend.calls.map((c) => c.key)).toEqual([`email:${emailId}`]);
      });

      it('a deferral that still lands inside the 23 hours is allowed, and the later send uses the same key and first-attempt time', async () => {
        const s = await seedSeller();
        const retriedAt = new Date('2026-10-20T22:59:00.000Z'); // 17:59 CDT
        const closed = new Date('2026-10-20T23:00:00.000Z'); // 18:00 CDT: the window has shut
        const nextMorning = new Date('2026-10-21T13:00:00.000Z'); // 08:00 CDT, 14 hours after the first attempt
        const { emailId } = await queue(s, { sendAfter: retriedAt });
        const resend = fakeResend((n) => (n === 1 ? { kind: 'retry', reason: 'timeout' } : { kind: 'sent', id: 're_morning' }));
        await tick(resend.client, { now: retriedAt });
        expect(await tick(resend.client, { now: closed })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 0 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'queued', sendAfter: nextMorning, attempts: 1, firstAttemptAt: retriedAt, lastError: 'timeout' });
        expect(await tick(resend.client, { now: nextMorning })).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
        expect(resend.calls.map((c) => c.key)).toEqual([`email:${emailId}`, `email:${emailId}`]);
        expect(await rowOf(emailId)).toMatchObject({ status: 'sent', firstAttemptAt: retriedAt, attempts: 2 });
      });

      it('first_attempt_at is written before the request leaves, and only for an email that is really sent', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        let seenByResend: { status: string; firstAttemptAt: Date | null } | null = null;
        const client: ResendClient = {
          async send() {
            const row = await rowOf(emailId);
            seenByResend = { status: row.status, firstAttemptAt: row.firstAttemptAt };
            return { kind: 'sent', id: 're_watched' };
          },
          async getReceived() {
            throw new Error('not used');
          },
        };
        await tick(client);
        expect(seenByResend).toEqual({ status: 'sending', firstAttemptAt: NOW });

        // A canceled email and a deferred one were never handed to Resend.
        const stopped = await seedSeller();
        await setConversation(stopped.conv.id, { handler: 'person' });
        const canceled = await queue(stopped);
        const evening = await queue(await seedSeller(), { sendAfter: EVENING });
        await tick(fakeResend().client, { now: EVENING });
        expect((await rowOf(canceled.emailId)).firstAttemptAt).toBeNull();
        expect((await rowOf(evening.emailId)).firstAttemptAt).toBeNull();
      });
    });

    describe('Resend answers', () => {
      it('retry: back to queued after 1, 5, 15 then 60 minutes, and failed on the 5th attempt', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        const resend = fakeResend(() => ({ kind: 'retry', reason: 'HTTP 503' }));
        let now = NOW;
        for (const [attempt, minutes] of [[1, 1], [2, 5], [3, 15], [4, 60]] as const) {
          expect(await tick(resend.client, { now })).toEqual({ sent: 0, retried: 1, canceled: 0, failed: 0 });
          expect(await rowOf(emailId), `after attempt ${attempt}`).toMatchObject({
            status: 'queued',
            attempts: attempt,
            sendAfter: new Date(now.getTime() + minutes * MINUTE),
            lastError: 'HTTP 503',
            claimedAt: null,
            // The idempotency key's 24 hours run from the first attempt; later attempts never move it.
            firstAttemptAt: NOW,
          });
          // Not due a minute early.
          expect((await tick(resend.client, { now: new Date(now.getTime() + minutes * MINUTE - MINUTE) })).retried).toBe(0);
          now = new Date(now.getTime() + minutes * MINUTE);
        }
        expect(await tick(resend.client, { now })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 1 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'failed', attempts: 5, lastError: 'HTTP 503' });
        expect(resend.calls).toHaveLength(5);
        expect(new Set(resend.calls.map((c) => c.key))).toEqual(new Set([`email:${emailId}`]));
        // Failed is final: nothing more is sent.
        await tick(resend.client, { now: new Date(now.getTime() + 24 * HOUR) });
        expect(resend.calls).toHaveLength(5);
      });

      it('a retry that then succeeds is sent and logged for Salesforce', async () => {
        const s = await seedSeller();
        const { emailId, eventId } = await queue(s);
        const resend = fakeResend((n) => (n === 1 ? { kind: 'retry', reason: 'timeout' } : { kind: 'sent', id: 're_second' }));
        await tick(resend.client);
        await tick(resend.client, { now: new Date(NOW.getTime() + MINUTE) });
        expect(await rowOf(emailId)).toMatchObject({ status: 'sent', resendId: 're_second', attempts: 2, sentAt: new Date(NOW.getTime() + MINUTE) });
        expect((await eventOf(eventId)).sfLogStatus).toBe('pending');
      });

      it('an answer that arrives after another worker took the row over changes nothing, and is logged', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        // While the request is out, the row is reaped and re-claimed elsewhere: it is `sending` again, under another claim.
        const otherClaim = new Date(NOW.getTime() + MINUTE);
        const client: ResendClient = {
          async send() {
            await db.update(schema.emailMessages).set({ claimedAt: otherClaim }).where(eq(schema.emailMessages.id, emailId));
            return { kind: 'sent', id: 're_late' };
          },
          async getReceived() {
            throw new Error('not used');
          },
        };
        const log = fakeLog();
        expect(await tick(client, { log })).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 0 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'sending', claimedAt: otherClaim, resendId: null, sentAt: null });
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ emailId, outcome: 'lost' }), expect.any(String));
      });

      it.each([
        ['no subject', { subject: null, body: BODY }],
        ['a blank subject', { subject: '  ', body: BODY }],
        ['no body', { subject: SUBJECT, body: null }],
        ['a blank body', { subject: SUBJECT, body: '\n \n' }],
      ])('%s: the row is failed as missing_content and nothing blank is sent', async (_label, content) => {
        const s = await seedSeller();
        const { emailId, eventId } = await queue(s);
        await db.update(schema.conversationEvents).set(content).where(eq(schema.conversationEvents.id, eventId));
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 1 });
        expect(resend.calls).toHaveLength(0);
        expect(await rowOf(emailId)).toMatchObject({ status: 'failed', lastError: 'missing_content', firstAttemptAt: null });
      });

      it('rejected: failed at once, with the reason, and never sent again', async () => {
        const s = await seedSeller();
        const { emailId, eventId } = await queue(s);
        const resend = fakeResend(() => ({ kind: 'rejected', reason: 'HTTP 422 validation_error' }));
        expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 1 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'failed', lastError: 'HTTP 422 validation_error', attempts: 1, resendId: null });
        expect((await eventOf(eventId)).sfLogStatus).toBe('skipped');
        await tick(resend.client, { now: new Date(NOW.getTime() + 24 * HOUR) });
        expect(resend.calls).toHaveLength(1);
      });
    });

    describe('a practice email', () => {
      it('is still sent when its conversation has handler=person; its event stays skipped for Salesforce', async () => {
        const p = await seedPracticeSeller();
        await setConversation(p.conv.id, { handler: 'person' });
        const { emailId, eventId } = await queue(p, { purpose: 'practice', requestedBy: p.adminId });
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'sent' });
        expect(await eventOf(eventId)).toMatchObject({ sfLogStatus: 'skipped', occurredAt: NOW });
        expect(resend.calls[0]!.req.replyTo).toBe(`sam+${p.conv.token}@reply.rethinkre.team`);
      });

      it.each(['reply', 'holding'] as const)(
        'a %s on a practice conversation is exempt like any practice email: sent despite every seller rule, its event never logged to Salesforce',
        async (purpose) => {
          const p = await seedPracticeSeller();
          await setConversation(p.conv.id, { status: 'booked', handler: 'person', flagReason: 'wants_appointment', flaggedAt: NOW });
          await suppressAddress(db, { orgId: p.orgId, address: ADDRESS, reason: 'opted_out', conversationId: null });
          await db.update(schema.crmRecords).set({ sfEmailOptOut: true }).where(eq(schema.crmRecords.id, p.crmRecordId));
          const { emailId, eventId } = await queue(p, { purpose, inReplyTo: '<admin-1@mail.example.com>', references: '<admin-1@mail.example.com>' });
          expect(await sendBlock(db, emailId, NOW)).toBeNull();
          const resend = fakeResend();
          expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
          expect(await rowOf(emailId)).toMatchObject({ status: 'sent', purpose });
          expect(await eventOf(eventId)).toMatchObject({ sfLogStatus: 'skipped', occurredAt: NOW });
          expect(resend.calls[0]!.req.headers['In-Reply-To']).toBe('<admin-1@mail.example.com>');
        },
      );

      it('a reply on a practice conversation still obeys the tenant switch and the daily cap, but not the seller\'s hours', async () => {
        const p = await seedPracticeSeller();
        const { emailId } = await queue(p, { purpose: 'reply' });
        expect(await sendBlock(db, emailId, EVENING)).toBeNull();
        await seedSent(p, HOUR);
        await seedSent(p, 2 * HOUR);
        await seedSent(p, 3 * HOUR);
        expect(await sendBlock(db, emailId, NOW)).toBe('daily_cap');
        await db.update(schema.organizations).set({ settings: { samEmail: { enabled: false } } }).where(eq(schema.organizations.id, p.orgId));
        expect(await sendBlock(db, emailId, NOW)).toBe('disabled');
      });

      it('skips the seller rules and the seller\'s hours (the admin is the recipient) but not the tenant switch or the cap', async () => {
        const p = await seedPracticeSeller({ approved: false });
        await setConversation(p.conv.id, { status: 'stopped', stopReason: 'opted_out', flagReason: 'unsure' });
        await suppressAddress(db, { orgId: p.orgId, address: ADDRESS, reason: 'opted_out', conversationId: null });
        await db.update(schema.crmRecords).set({ isClosed: true }).where(eq(schema.crmRecords.id, p.crmRecordId));
        const sendable = await queue(p, { purpose: 'practice', requestedBy: p.adminId });
        expect(await sendBlock(db, sendable.emailId, NOW)).toBeNull();
        expect(await sendBlock(db, sendable.emailId, EVENING)).toBeNull();
        await seedSent(p, HOUR);
        await seedSent(p, 2 * HOUR);
        await seedSent(p, 3 * HOUR);
        expect(await sendBlock(db, sendable.emailId, EVENING)).toBe('daily_cap');
        await db.update(schema.organizations).set({ settings: { samEmail: { enabled: false } } }).where(eq(schema.organizations.id, p.orgId));
        expect(await sendBlock(db, sendable.emailId, NOW)).toBe('disabled');
      });
    });

    it('a practice email due at 23:00 seller-local goes out on that tick; a real first email due then waits for 08:00', async () => {
      const p = await seedPracticeSeller();
      const practice = await queue(p, { purpose: 'practice', requestedBy: p.adminId, inReplyTo: null, references: null, sendAfter: LATE });
      const real = await seedSeller();
      const first = await queue(real, { purpose: 'first', inReplyTo: null, references: null, sendAfter: LATE });
      const resend = fakeResend();
      expect(await tick(resend.client, { now: LATE })).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
      expect(await rowOf(practice.emailId)).toMatchObject({ status: 'sent' });
      expect(await rowOf(first.emailId)).toMatchObject({ status: 'queued', sendAfter: MORNING, attempts: 0 });
      expect(resend.calls.map((c) => c.key)).toEqual([`email:${practice.emailId}`]);
    });

    describe('a first email is checked again for a warm lead when it is due', () => {
      it('the record closed after it was queued: canceled closed, and Resend sees nothing', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s, { purpose: 'first', inReplyTo: null, references: null });
        await db.update(schema.crmRecords).set({ isClosed: true }).where(eq(schema.crmRecords.id, s.crmRecordId));
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 1, failed: 0 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'closed' });
        expect(resend.calls).toEqual([]);
      });

      it('the call plan was rejected after it was queued: canceled not_approved, and Resend sees nothing', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s, { purpose: 'first', inReplyTo: null, references: null });
        await db.update(schema.callPlans).set({ status: 'rejected' }).where(eq(schema.callPlans.id, s.planId));
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 1, failed: 0 });
        expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'not_approved' });
        expect(resend.calls).toEqual([]);
      });

      it('a reply and a holding email to a closed seller with no approved plan still go', async () => {
        const s = await seedSeller({ approved: false });
        await db.update(schema.crmRecords).set({ isClosed: true }).where(eq(schema.crmRecords.id, s.crmRecordId));
        await queue(s, { purpose: 'reply' });
        await queue(s, { purpose: 'holding' });
        expect(await tick(fakeResend().client)).toEqual({ sent: 2, retried: 0, canceled: 0, failed: 0 });
      });
    });

    it('logs ids and counts only: never an address, a subject or any of the text', async () => {
      const s = await seedSeller();
      await queue(s);
      const blocked = await seedSeller({ settings: {} });
      await queue(blocked);
      const failing = await seedSeller();
      await queue(failing);
      const log = fakeLog();
      const resend = fakeResend((n) => (n === 1 ? { kind: 'sent', id: 're_x' } : { kind: 'rejected', reason: 'HTTP 422 validation_error' }));
      await tick(resend.client, { log });
      const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
      expect(logged.length).toBeGreaterThan(2);
      for (const secret of [ADDRESS, 'resend.dev', SUBJECT, 'Oak Street', 'Thursday afternoon', 'Pat Seller', s.conv.token, 'Sam at GG Homes']) {
        expect(logged).not.toContain(secret);
      }
    });

    it('a row that blows up is left `sending` for the reaper, logged by id only, and does not stop the rest', async () => {
      const s = await seedSeller();
      const other = await seedSeller();
      const broken = await queue(s, { sendAfter: new Date(NOW.getTime() - 2 * MINUTE) });
      const fine = await queue(other);
      const log = fakeLog();
      const resend = fakeResend((n) => {
        if (n === 1) throw new Error(`boom for ${ADDRESS}`);
        return { kind: 'sent', id: 're_fine' };
      });
      expect(await tick(resend.client, { log })).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
      expect(await rowOf(broken.emailId)).toMatchObject({ status: 'sending', attempts: 1 });
      expect((await rowOf(fine.emailId)).status).toBe('sent');
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.error.mock.calls)).toContain(broken.emailId);
      expect(JSON.stringify(log.error.mock.calls)).not.toContain('resend.dev');
    });
  });

  describe('sendBlock', () => {
    const SELLER_RULES = ['first', 'reply', 'holding'] as const;

    it('is null for a seller Sam may email, in hours', async () => {
      const s = await seedSeller();
      for (const purpose of SELLER_RULES) {
        const { emailId } = await queue(s, { purpose });
        expect(await sendBlock(db, emailId, NOW), purpose).toBeNull();
      }
    });

    it('throws for an email that does not exist', async () => {
      await expect(sendBlock(db, randomUUID(), NOW)).rejects.toThrow('email message not found');
    });

    it('1. disabled unless the tenant\'s Sam email is exactly on; paused when it was paused', async () => {
      for (const settings of [{}, { samEmail: { enabled: 'yes' } }, { samEmail: 'on' }, { samEmail: { enabled: false } }]) {
        const s = await seedSeller({ settings });
        expect(await sendBlock(db, (await queue(s)).emailId, NOW), JSON.stringify(settings)).toBe('disabled');
      }
      const paused = await seedSeller({ settings: { samEmail: { enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint' } } });
      expect(await sendBlock(db, (await queue(paused)).emailId, NOW)).toBe('paused');
      const offAndPaused = await seedSeller({ settings: { samEmail: { enabled: false, pausedAt: NOW.toISOString() } } });
      expect(await sendBlock(db, (await queue(offAndPaused)).emailId, NOW)).toBe('disabled');
    });

    it('2. a first email needs a call plan a person approved; a reply or holding email does not', async () => {
      const cold = await seedSeller({ approved: false });
      expect(await sendBlock(db, (await queue(cold, { purpose: 'first' })).emailId, NOW)).toBe('not_approved');
      expect(await sendBlock(db, (await queue(cold, { purpose: 'reply' })).emailId, NOW)).toBeNull();
      expect(await sendBlock(db, (await queue(cold, { purpose: 'holding' })).emailId, NOW)).toBeNull();
    });

    it('3. a first email to a closed record; a reply or holding email still goes', async () => {
      const s = await seedSeller();
      await db.update(schema.crmRecords).set({ isClosed: true }).where(eq(schema.crmRecords.id, s.crmRecordId));
      expect(await sendBlock(db, (await queue(s, { purpose: 'first' })).emailId, NOW)).toBe('closed');
      expect(await sendBlock(db, (await queue(s, { purpose: 'reply' })).emailId, NOW)).toBeNull();
      expect(await sendBlock(db, (await queue(s, { purpose: 'holding' })).emailId, NOW)).toBeNull();
    });

    it('4. stopped', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { status: 'stopped', stopReason: 'asked_to_stop' });
      for (const purpose of SELLER_RULES) expect(await sendBlock(db, (await queue(s, { purpose })).emailId, NOW), purpose).toBe('stopped');
    });

    it('5. booked stops everything but a holding email', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { status: 'booked' });
      expect(await sendBlock(db, (await queue(s, { purpose: 'first' })).emailId, NOW)).toBe('booked');
      expect(await sendBlock(db, (await queue(s, { purpose: 'reply' })).emailId, NOW)).toBe('booked');
      expect(await sendBlock(db, (await queue(s, { purpose: 'holding' })).emailId, NOW)).toBeNull();
    });

    it('6. taken over by a person', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { handler: 'person' });
      for (const purpose of SELLER_RULES) expect(await sendBlock(db, (await queue(s, { purpose })).emailId, NOW), purpose).toBe('taken_over');
    });

    it('7. flagged stops a first or reply email but not a holding one', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { flagReason: 'wants_appointment', flaggedAt: NOW });
      expect(await sendBlock(db, (await queue(s, { purpose: 'first' })).emailId, NOW)).toBe('flagged');
      expect(await sendBlock(db, (await queue(s, { purpose: 'reply' })).emailId, NOW)).toBe('flagged');
      expect(await sendBlock(db, (await queue(s, { purpose: 'holding' })).emailId, NOW)).toBeNull();
    });

    it('8. a suppressed address, whatever its case, in this tenant only', async () => {
      const s = await seedSeller();
      const other = await seedSeller();
      await suppressAddress(db, { orgId: s.orgId, address: 'Delivered@Resend.dev', reason: 'opted_out', conversationId: s.conv.id });
      expect(await sendBlock(db, (await queue(s)).emailId, NOW)).toBe('suppressed');
      expect(await sendBlock(db, (await queue(s, { to: 'DELIVERED@resend.dev' })).emailId, NOW)).toBe('suppressed');
      expect(await sendBlock(db, (await queue(other)).emailId, NOW)).toBeNull();
    });

    it('9. Salesforce Email Opt Out on the record', async () => {
      const s = await seedSeller({ sfEmailOptOut: true });
      expect(await sendBlock(db, (await queue(s)).emailId, NOW)).toBe('sf_opt_out');
    });

    it('9. Salesforce Email Opt Out on ANOTHER of the tenant\'s records with the address (any case) blocks it: sf_opt_out (I2b)', async () => {
      const s = await seedSeller();
      const other = await seedSeller();
      const twin = await seedRecord(db, s.orgId, snapshot({ sfRecordId: leadId(990_000 + (++twinSeq)), email: ' Delivered@Resend.DEV ' }), { sfEmailOptOut: true });
      expect(await sendBlock(db, (await queue(s)).emailId, NOW)).toBe('sf_opt_out');
      // The address the email goes to is what counts, not only the seller's record.
      expect(await sendBlock(db, (await queue(s, { to: 'someone-else@example.com' })).emailId, NOW)).toBeNull();
      // Another tenant's opted-out record with the same address holds nothing.
      expect(await sendBlock(db, (await queue(other)).emailId, NOW)).toBeNull();
      await db.update(schema.crmRecords).set({ sfEmailOptOut: false }).where(eq(schema.crmRecords.id, twin));
      expect(await sendBlock(db, (await queue(s)).emailId, NOW)).toBeNull();
    });

    it('the send tick cancels it as sf_opt_out (I2b)', async () => {
      const s = await seedSeller();
      await seedRecord(db, s.orgId, snapshot({ sfRecordId: leadId(990_000 + (++twinSeq)), email: ADDRESS }), { sfEmailOptOut: true });
      const { emailId } = await queue(s);
      const resend = { send: vi.fn(), getReceived: vi.fn() };
      await sendDueEmails({ db, resend, cfg: CFG, now: NOW, log: { info: () => {}, warn: () => {}, error: () => {} } });
      expect(resend.send).not.toHaveBeenCalled();
      expect(await rowOf(emailId)).toMatchObject({ status: 'canceled', lastError: 'sf_opt_out' });
    });

    it('10. the daily cap, 11. then the hours', async () => {
      const s = await seedSeller();
      await seedSent(s, HOUR);
      await seedSent(s, 2 * HOUR);
      await seedSent(s, 3 * HOUR);
      const { emailId } = await queue(s);
      expect(await sendBlock(db, emailId, NOW)).toBe('daily_cap');
      expect(await sendBlock(db, emailId, EVENING)).toBe('daily_cap');
      const quiet = await seedSeller();
      expect(await sendBlock(db, (await queue(quiet)).emailId, EVENING)).toBe('outside_window');
    });

    it('checks in the brief\'s order when several apply', async () => {
      const everything = await seedSeller({ sfEmailOptOut: true, approved: false });
      await db.update(schema.crmRecords).set({ isClosed: true }).where(eq(schema.crmRecords.id, everything.crmRecordId));
      await setConversation(everything.conv.id, { status: 'stopped', stopReason: 'opted_out', handler: 'person', flagReason: 'unsure', flaggedAt: NOW });
      await suppressAddress(db, { orgId: everything.orgId, address: ADDRESS, reason: 'opted_out', conversationId: null });
      const first = await queue(everything, { purpose: 'first' });
      expect(await sendBlock(db, first.emailId, EVENING)).toBe('not_approved');
      await db.update(schema.callPlans).set({ status: 'approved' }).where(eq(schema.callPlans.id, everything.planId));
      expect(await sendBlock(db, first.emailId, EVENING)).toBe('closed');
      await db.update(schema.crmRecords).set({ isClosed: false }).where(eq(schema.crmRecords.id, everything.crmRecordId));
      expect(await sendBlock(db, first.emailId, EVENING)).toBe('stopped');
      const { emailId } = await queue(everything);
      expect(await sendBlock(db, emailId, EVENING)).toBe('stopped');
      await setConversation(everything.conv.id, { status: 'open' });
      expect(await sendBlock(db, emailId, EVENING)).toBe('taken_over');
      await setConversation(everything.conv.id, { handler: 'sam' });
      expect(await sendBlock(db, emailId, EVENING)).toBe('flagged');
      await setConversation(everything.conv.id, { flagReason: null, flaggedAt: null });
      expect(await sendBlock(db, emailId, EVENING)).toBe('suppressed');
      await db.delete(schema.emailSuppressions).where(eq(schema.emailSuppressions.orgId, everything.orgId));
      expect(await sendBlock(db, emailId, EVENING)).toBe('sf_opt_out');
      await db.update(schema.crmRecords).set({ sfEmailOptOut: false }).where(eq(schema.crmRecords.id, everything.crmRecordId));
      expect(await sendBlock(db, emailId, EVENING)).toBe('outside_window');
      expect(await sendBlock(db, emailId, NOW)).toBeNull();
    });

    it('is scoped to the email\'s own tenant: another tenant\'s switch never gates it', async () => {
      const on = await seedSeller();
      await seedSeller({ settings: {} });
      expect(await sendBlock(db, (await queue(on)).emailId, NOW)).toBeNull();
    });
  });

  it('appendEvent and the outbox agree: an event written by something else is not an email row', async () => {
    const s = await seedSeller();
    await appendEvent(db, { orgId: s.orgId, conversationId: s.conv.id, kind: 'note', direction: 'none', actor: 'person', sfLog: false });
    const resend = fakeResend();
    expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 0 });
    expect(resend.calls).toHaveLength(0);
  });
});
