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
import { leadId, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { seedUser } from '../test/call-plan-seed.js';
import { appendEvent, ensureConversation, suppressAddress, type SellerConversationRow } from '../conversations/store.js';
import { queueEmail, sendBlock } from './outbox.js';
import { sendDueEmails } from './send.js';
import type { ResendClient, ResendSendRequest, ResendSendResult } from './resend-client.js';

/** Tuesday 12:00 in Chicago (CDT): inside the 08:00-18:00 window. */
const NOW = new Date('2026-10-20T17:00:00.000Z');
/** Tuesday 21:00 in Chicago. */
const EVENING = new Date('2026-10-21T02:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ADDRESS = 'delivered@resend.dev';
const SUBJECT = 'Re: the house on Oak Street';
const BODY = 'Thanks for getting back to me. Would Thursday afternoon work for a quick call?';
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
  let seq = 0;
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
    conv: SellerConversationRow;
  }

  /** A fresh tenant (Sam email on) with one seller in Chicago and their conversation. */
  async function seedSeller(over: { settings?: Record<string, unknown>; phones?: Array<{ field: string; e164: string }>; sfEmailOptOut?: boolean } = {}): Promise<Seller> {
    seq += 1;
    const orgId = await seedOrg(db, over.settings ?? { samEmail: { enabled: true } });
    const crmRecordId = await seedRecord(
      db,
      orgId,
      snapshot({ sfRecordId: leadId(seq), email: ADDRESS, phones: over.phones ?? CHICAGO, sfEmailOptOut: over.sfEmailOptOut ?? false }),
    );
    return { orgId, crmRecordId, conv: await ensureConversation(db, { orgId, crmRecordId }) };
  }

  async function seedPracticeSeller(): Promise<Seller & { adminId: string }> {
    const seller = await seedSeller();
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

  /** A row a dead tick left `sending`: claimed `claimedAgo` before NOW, created `createdAgo` before NOW. */
  async function strand(emailId: string, claimedAgo: number, createdAgo: number) {
    await db
      .update(schema.emailMessages)
      .set({ status: 'sending', attempts: 1, claimedAt: new Date(NOW.getTime() - claimedAgo), createdAt: new Date(NOW.getTime() - createdAgo) })
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

    it('keeps exactly one row per event', async () => {
      const s = await seedSeller();
      const { eventId } = await queue(s);
      const rows = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.eventId, eventId));
      expect(rows).toHaveLength(1);
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

      it('three due emails in one tick: the first three go and the rest wait for another day', async () => {
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
      it('re-sends a row stuck sending 6 minutes, created an hour ago, with the same idempotency key', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        await strand(emailId, 6 * MINUTE, HOUR);
        const resend = fakeResend(() => ({ kind: 'sent', id: 're_same' }));
        expect(await tick(resend.client)).toEqual({ sent: 1, retried: 0, canceled: 0, failed: 0 });
        expect(resend.calls.map((c) => c.key)).toEqual([`email:${emailId}`]);
        expect(await rowOf(emailId)).toMatchObject({ status: 'sent', resendId: 're_same', attempts: 2 });
      });

      it('fails a row stuck sending 6 minutes that was created 24 hours ago, and does not send it', async () => {
        const s = await seedSeller();
        const { emailId } = await queue(s);
        await strand(emailId, 6 * MINUTE, 24 * HOUR);
        const resend = fakeResend();
        expect(await tick(resend.client)).toEqual({ sent: 0, retried: 0, canceled: 0, failed: 0 });
        expect(resend.calls).toHaveLength(0);
        expect(await rowOf(emailId)).toMatchObject({ status: 'failed', lastError: 'idempotency_window', resendId: null });
      });

      it('the cut-off is 23 hours since the email was created', async () => {
        const s = await seedSeller();
        const inside = await queue(s);
        const outside = await queue(s);
        await strand(inside.emailId, 6 * MINUTE, 23 * HOUR - MINUTE);
        await strand(outside.emailId, 6 * MINUTE, 23 * HOUR + MINUTE);
        const resend = fakeResend();
        await tick(resend.client);
        expect(resend.calls.map((c) => c.key)).toEqual([`email:${inside.emailId}`]);
        expect((await rowOf(outside.emailId)).lastError).toBe('idempotency_window');
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

      it('skips the seller rules but not the tenant switch, the cap or the hours', async () => {
        const p = await seedPracticeSeller();
        await setConversation(p.conv.id, { status: 'stopped', stopReason: 'opted_out', flagReason: 'unsure' });
        await suppressAddress(db, { orgId: p.orgId, address: ADDRESS, reason: 'opted_out', conversationId: null });
        const sendable = await queue(p, { purpose: 'practice', requestedBy: p.adminId });
        expect(await sendBlock(db, sendable.emailId, NOW)).toBeNull();
        expect(await sendBlock(db, sendable.emailId, EVENING)).toBe('outside_window');
        await db.update(schema.organizations).set({ settings: { samEmail: { enabled: false } } }).where(eq(schema.organizations.id, p.orgId));
        expect(await sendBlock(db, sendable.emailId, NOW)).toBe('disabled');
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

    it('2. stopped', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { status: 'stopped', stopReason: 'asked_to_stop' });
      for (const purpose of SELLER_RULES) expect(await sendBlock(db, (await queue(s, { purpose })).emailId, NOW), purpose).toBe('stopped');
    });

    it('3. booked stops everything but a holding email', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { status: 'booked' });
      expect(await sendBlock(db, (await queue(s, { purpose: 'first' })).emailId, NOW)).toBe('booked');
      expect(await sendBlock(db, (await queue(s, { purpose: 'reply' })).emailId, NOW)).toBe('booked');
      expect(await sendBlock(db, (await queue(s, { purpose: 'holding' })).emailId, NOW)).toBeNull();
    });

    it('4. taken over by a person', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { handler: 'person' });
      for (const purpose of SELLER_RULES) expect(await sendBlock(db, (await queue(s, { purpose })).emailId, NOW), purpose).toBe('taken_over');
    });

    it('5. flagged stops a first or reply email but not a holding one', async () => {
      const s = await seedSeller();
      await setConversation(s.conv.id, { flagReason: 'wants_appointment', flaggedAt: NOW });
      expect(await sendBlock(db, (await queue(s, { purpose: 'first' })).emailId, NOW)).toBe('flagged');
      expect(await sendBlock(db, (await queue(s, { purpose: 'reply' })).emailId, NOW)).toBe('flagged');
      expect(await sendBlock(db, (await queue(s, { purpose: 'holding' })).emailId, NOW)).toBeNull();
    });

    it('6. a suppressed address, whatever its case, in this tenant only', async () => {
      const s = await seedSeller();
      const other = await seedSeller();
      await suppressAddress(db, { orgId: s.orgId, address: 'Delivered@Resend.dev', reason: 'opted_out', conversationId: s.conv.id });
      expect(await sendBlock(db, (await queue(s)).emailId, NOW)).toBe('suppressed');
      expect(await sendBlock(db, (await queue(s, { to: 'DELIVERED@resend.dev' })).emailId, NOW)).toBe('suppressed');
      expect(await sendBlock(db, (await queue(other)).emailId, NOW)).toBeNull();
    });

    it('7. Salesforce Email Opt Out on the record', async () => {
      const s = await seedSeller({ sfEmailOptOut: true });
      expect(await sendBlock(db, (await queue(s)).emailId, NOW)).toBe('sf_opt_out');
    });

    it('8. the daily cap, 9. then the hours', async () => {
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
      const everything = await seedSeller({ sfEmailOptOut: true });
      await setConversation(everything.conv.id, { status: 'stopped', stopReason: 'opted_out', handler: 'person', flagReason: 'unsure', flaggedAt: NOW });
      await suppressAddress(db, { orgId: everything.orgId, address: ADDRESS, reason: 'opted_out', conversationId: null });
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
