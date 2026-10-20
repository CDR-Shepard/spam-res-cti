/**
 * Real Postgres: a seller's reply, from Resend's webhook id to Sam's answer, with a fake Resend (fixtures, the
 * real API is never called) and a fake writer. What these protect: a reply lands once on the right timeline
 * however often the event comes (Review Focus 3); an opt-out stops the seller and a quoted footer never does
 * (Review Focus 1); an auto-responder is never answered and the 3-a-day guard catches a loop (Review Focus 4);
 * a reply Sam cannot handle goes to a person, never silently nowhere; and two ticks, or a crash, never queue
 * a second answer or lose one.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { leadId, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { seedUser } from '../test/call-plan-seed.js';
import { ensureConversation, suppressAddress, suppressionFor, type SellerConversationRow } from '../conversations/store.js';
import type { AlertEvent } from '../alerts.js';
import { queueEmail } from './outbox.js';
import { replyAddress, unsubscribeMailto } from './addresses.js';
import { handleReceived, INBOUND_BODY_MAX, INBOUND_SUBJECT_MAX, INBOUND_TEXT_MAX, UNREADABLE_RETRY_WINDOW_MS, type InboundDeps } from './inbound.js';
import { ResendError, type ReceivedEmail, type ResendClient } from './resend-client.js';
import type { EmailDecision, EmailWriter } from './writer.js';

/** Tuesday 12:00 in Chicago (CDT): inside the 08:00-18:00 window. */
const NOW = new Date('2026-10-20T17:00:00.000Z');
/** Tuesday 21:00 in Chicago: Sam's answer waits for 08:00 Wednesday (13:00 UTC). */
const EVENING = new Date('2026-10-21T02:00:00.000Z');
const NEXT_MORNING = new Date('2026-10-21T13:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ADDRESS = 'delivered@resend.dev';
const FROM_HEADER = `Pat Seller <${ADDRESS}>`;
const THEIR_SUBJECT = 'Your home on Oak Street';
const THEIR_TEXT = 'Yes, the house on Oak Street is still for sale. We would like to move by spring.';
const THEIR_MESSAGE_ID = '<CAPat123@mail.example.com>';
const THEIR_REFERENCES = '<sam-1@resend.example>';
const CHICAGO = [{ field: 'MobilePhone', e164: '+13125550100' }];
const APP_URL = 'https://app.example.com';
const CFG: InboundDeps['cfg'] = {
  emailEnabled: true,
  EMAIL_FROM: 'Sam at GG Homes <sam@rethinkre.team>',
  EMAIL_REPLY_DOMAIN: 'reply.rethinkre.team',
  EMAIL_COMPANY_NAME: 'GG Homes',
};
const API_URL = 'https://outreach.example.com';

const SEND: EmailDecision = { action: 'send', flagReason: null, subject: '', body: 'Thanks, Pat. Spring gives us time to plan. What matters most to you about the move?' };
const FLAG_OFFER: EmailDecision = { action: 'flag', flagReason: 'offer_or_price', subject: '', body: 'Thanks for asking. Someone from the GG Homes team will follow up with you shortly.' };

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

class BoomError extends Error {
  override name = 'BoomError';
}

/** Sam's own footer as the seller's client quotes it back, line by line (render.ts writes it). */
function samFooter(token: string): string[] {
  return ['—', 'Sam', "GG Homes' AI assistant", '', 'GG Homes · 18872 MacArthur Blvd #220, Irvine, CA 92612', `To stop hearing from Sam, unsubscribe here: ${API_URL}/api/email/unsubscribe/${token}`];
}

describe.skipIf(!pgLane)('replies: receive, decide, answer (real Postgres)', () => {
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
  afterEach(async () => {
    await t.pool.query('delete from conversation_events');
  });

  interface Seller {
    orgId: string;
    crmRecordId: string;
    sfRecordId: string;
    conv: SellerConversationRow;
  }

  /** A fresh tenant (Sam email on) with one seller in Chicago and their conversation. */
  async function seedSeller(over: { settings?: Record<string, unknown>; email?: string | null; isClosed?: boolean } = {}): Promise<Seller> {
    seq += 1;
    const orgId = await seedOrg(db, over.settings ?? { aiDailyBudgetUsd: 40, samEmail: { enabled: true } });
    const sfRecordId = leadId(seq);
    const crmRecordId = await seedRecord(db, orgId, snapshot({ sfRecordId, email: over.email === undefined ? ADDRESS : over.email, phones: CHICAGO, isClosed: over.isClosed ?? false }));
    return { orgId, crmRecordId, sfRecordId, conv: await ensureConversation(db, { orgId, crmRecordId }) };
  }

  /** An email Sam sent to the seller (`sent`, with Resend's Message-ID), `ago` before NOW. */
  async function sentBySam(s: Seller, over: { messageId?: string; ago?: number; conversationId?: string; to?: string } = {}): Promise<string> {
    const { emailId } = await queueEmail(db, {
      orgId: s.orgId,
      conversationId: over.conversationId ?? s.conv.id,
      to: over.to ?? ADDRESS,
      from: CFG.EMAIL_FROM,
      subject: THEIR_SUBJECT,
      body: 'Hi Pat, I am Sam.',
      purpose: 'reply',
      requestedBy: null,
      inReplyTo: null,
      references: null,
      sendAfter: new Date(NOW.getTime() - 2 * HOUR),
    });
    const sentAt = new Date(NOW.getTime() - (over.ago ?? HOUR));
    await t.pool.query(`update email_messages set status = 'sent', resend_id = $2, message_id = $3, sent_at = $4 where id = $1`, [emailId, `re_${randomUUID()}`, over.messageId ?? null, sentAt]);
    return emailId;
  }

  /** The seller's reply as Resend's API returns it: addressed to the conversation's reply mailbox. */
  function reply(s: Seller | null, over: Partial<ReceivedEmail> = {}): ReceivedEmail {
    return {
      id: `re_in_${randomUUID()}`,
      from: FROM_HEADER,
      to: s ? [replyAddress(s.conv.token, CFG.EMAIL_REPLY_DOMAIN)] : ['someone-else@example.com'],
      cc: [],
      receivedFor: [],
      subject: `Re: ${THEIR_SUBJECT}`,
      text: THEIR_TEXT,
      html: null,
      headers: { 'in-reply-to': THEIR_REFERENCES, references: THEIR_REFERENCES },
      messageId: THEIR_MESSAGE_ID,
      ...over,
    };
  }

  /** A Resend that serves these fixtures by id (404 for any other). */
  function fakeResend(...emails: ReceivedEmail[]): ResendClient & { getReceived: ReturnType<typeof vi.fn> } {
    const byId = new Map(emails.map((e) => [e.id, e]));
    return {
      async send() {
        throw new Error('the reply handler never sends: it queues');
      },
      getReceived: vi.fn(async (id: string) => {
        const found = byId.get(id);
        if (!found) throw new ResendError(404);
        return found;
      }),
    };
  }

  /** A writer that answers `decision` (or what `answer` returns), priced like Sonnet 5.5. */
  function fakeWriter(decision: EmailDecision = SEND, answer?: () => Promise<EmailDecision>): EmailWriter & { write: ReturnType<typeof vi.fn> } {
    return {
      write: vi.fn(async () => ({ decision: answer ? await answer() : decision, model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 200 })),
    };
  }

  function deps(over: Partial<InboundDeps> & { emails?: ReceivedEmail[] } = {}) {
    const alert = vi.fn(async (_event: AlertEvent) => {});
    const log = fakeLog();
    const writer = fakeWriter();
    const { emails = [], ...rest } = over;
    const d: InboundDeps = { db, resend: fakeResend(...emails), writer, cfg: CFG, appPublicUrl: APP_URL, log, alert, ...rest };
    return { d, alert, log, writer: d.writer as ReturnType<typeof fakeWriter> | null };
  }

  const received = (email: ReceivedEmail | string) => ({ data: { email_id: typeof email === 'string' ? email : email.id } });

  async function inboundRows(conversationId: string) {
    const m = schema.emailMessages;
    return db.select().from(m).where(and(eq(m.conversationId, conversationId), eq(m.direction, 'in')));
  }
  async function queued(conversationId: string) {
    const m = schema.emailMessages;
    return db.select().from(m).where(and(eq(m.conversationId, conversationId), eq(m.direction, 'out'), eq(m.status, 'queued')));
  }
  async function eventsOf(conversationId: string) {
    return db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.conversationId, conversationId));
  }
  async function conversationRow(id: string) {
    const [row] = await db.select().from(schema.sellerConversations).where(eq(schema.sellerConversations.id, id));
    return row!;
  }

  /** Every alert and log line, flattened: none may carry the address, the subject or the seller's words. */
  function assertNoPii(alert: ReturnType<typeof vi.fn>, log: ReturnType<typeof fakeLog>, extra: string[] = []): void {
    const everything = JSON.stringify([alert.mock.calls, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    for (const secret of [ADDRESS, 'Pat Seller', THEIR_SUBJECT, THEIR_TEXT, 'Oak Street', ...extra]) expect(everything).not.toContain(secret);
  }

  /** Makes every `kind` write on `table` fail while `run` works. */
  async function failingWrites<T>(table: string, kind: 'insert' | 'update', run: () => Promise<T>): Promise<T> {
    const name = `test_block_${table}_${kind}`;
    await t.pool.query(`create or replace function ${name}() returns trigger language plpgsql as $$ begin raise exception 'blocked for the test'; end $$`);
    await t.pool.query(`create trigger ${name} before ${kind} on ${table} for each row execute function ${name}()`);
    try {
      return await run();
    } finally {
      await t.pool.query(`drop trigger ${name} on ${table}`);
    }
  }

  /** Resolves once some session of this test database is waiting on another transaction's lock (5 s at most). */
  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 250; i += 1) {
      const { rows: [row] } = await t.pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'transactionid'`,
      );
      if (row!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('no session ever waited on the held insert');
  }

  describe('a reply to the conversation\'s own mailbox', () => {
    it('is stored as the seller\'s email on the timeline and answered in the thread (Re: subject, In-Reply-To, References)', async () => {
      const s = await seedSeller();
      const email = reply(s);
      const { d, writer, alert, log } = deps({ emails: [email] });

      expect(await handleReceived(d, received(email), NOW)).toBe('done');

      const [inbound] = await inboundRows(s.conv.id);
      expect(inbound).toMatchObject({
        orgId: s.orgId,
        status: 'received',
        purpose: 'inbound',
        resendId: email.id,
        messageId: THEIR_MESSAGE_ID,
        inReplyTo: THEIR_REFERENCES,
        references: THEIR_REFERENCES,
        fromAddress: ADDRESS,
        toAddress: replyAddress(s.conv.token, CFG.EMAIL_REPLY_DOMAIN),
        handledAt: NOW,
      });
      const events = await eventsOf(s.conv.id);
      const event = events.find((e) => e.id === inbound!.eventId)!;
      expect(event).toMatchObject({ kind: 'email', direction: 'in', actor: 'seller', subject: `Re: ${THEIR_SUBJECT}`, body: THEIR_TEXT, meta: { autoReply: false }, sfLogStatus: 'pending' });

      expect(writer!.write).toHaveBeenCalledTimes(1);
      const prompt = writer!.write.mock.calls[0]![0] as { system: string; user: string };
      expect(prompt.system).toContain("This is a reply to the seller's email below.");
      expect(prompt.user).toContain(THEIR_TEXT);
      expect(prompt.user).toContain(`subject="Re: ${THEIR_SUBJECT}"`);

      const [answer] = await queued(s.conv.id);
      expect(answer).toMatchObject({
        purpose: 'reply',
        toAddress: ADDRESS,
        fromAddress: CFG.EMAIL_FROM,
        inReplyTo: THEIR_MESSAGE_ID,
        references: `${THEIR_REFERENCES} ${THEIR_MESSAGE_ID}`,
        sendAfter: NOW,
        requestedBy: null,
      });
      const answerEvent = events.find((e) => e.id === answer!.eventId)!;
      expect(answerEvent).toMatchObject({ kind: 'email', direction: 'out', actor: 'sam', subject: `Re: ${THEIR_SUBJECT}`, body: SEND.body });
      expect(alert).not.toHaveBeenCalled();
      expect((await conversationRow(s.conv.id)).flagReason).toBeNull();
      assertNoPii(alert, log);
    });

    it('the same event twice (Resend redelivers): one inbound row, one event, one answer, and the writer is not asked again (Review Focus 3)', async () => {
      const s = await seedSeller();
      const email = reply(s);
      const { d, writer } = deps({ emails: [email] });

      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect(await handleReceived(d, received(email), new Date(NOW.getTime() + MINUTE))).toBe('done');

      expect(await inboundRows(s.conv.id)).toHaveLength(1);
      expect(await queued(s.conv.id)).toHaveLength(1);
      expect((await eventsOf(s.conv.id)).filter((e) => e.direction === 'in')).toHaveLength(1);
      expect(writer!.write).toHaveBeenCalledTimes(1);
      expect((await inboundRows(s.conv.id))[0]!.handledAt).toEqual(NOW);
    });

    it('a subject that already starts with re: (any case) is not prefixed again', async () => {
      const s = await seedSeller();
      const email = reply(s, { subject: `RE: ${THEIR_SUBJECT}` });
      await handleReceived(deps({ emails: [email] }).d, received(email), NOW);
      const [answer] = await queued(s.conv.id);
      const event = (await eventsOf(s.conv.id)).find((e) => e.id === answer!.eventId)!;
      expect(event.subject).toBe(`RE: ${THEIR_SUBJECT}`);
    });

    it('a reply with no subject or Message-ID is still answered: "Re:" alone, no In-Reply-To', async () => {
      const s = await seedSeller();
      const email = reply(s, { subject: '', messageId: null, headers: {} });
      expect(await handleReceived(deps({ emails: [email] }).d, received(email), NOW)).toBe('done');
      const [answer] = await queued(s.conv.id);
      expect(answer).toMatchObject({ inReplyTo: null, references: null });
      expect((await eventsOf(s.conv.id)).find((e) => e.id === answer!.eventId)!.subject).toBe('Re:');
    });

    it('in the seller\'s evening the answer waits for their morning', async () => {
      const s = await seedSeller();
      const email = reply(s);
      await handleReceived(deps({ emails: [email] }).d, received(email), EVENING);
      expect((await queued(s.conv.id))[0]!.sendAfter).toEqual(NEXT_MORNING);
    });

    it('the token is read from Cc or Resend\'s received-for list too, in any letter case', async () => {
      const s = await seedSeller();
      const viaCc = reply(s, { to: ['pat.partner@example.com'], cc: [`"Sam" <${replyAddress(s.conv.token, CFG.EMAIL_REPLY_DOMAIN).toUpperCase()}>`] });
      const viaReceivedFor = reply(s, { to: ['undisclosed-recipients:;'], receivedFor: [replyAddress(s.conv.token, CFG.EMAIL_REPLY_DOMAIN)] });
      const { d } = deps({ emails: [viaCc, viaReceivedFor] });
      expect(await handleReceived(d, received(viaCc), NOW)).toBe('done');
      expect(await handleReceived(d, received(viaReceivedFor), NOW)).toBe('done');
      expect(await inboundRows(s.conv.id)).toHaveLength(2);
    });

    it('an HTML-only reply (no text part): the body comes from the HTML', async () => {
      const s = await seedSeller();
      const email = reply(s, { text: null, html: '<div>Yes, still for sale.</div><div>Spring would be best &amp; easiest.</div>' });
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      const inbound = (await eventsOf(s.conv.id)).find((e) => e.direction === 'in')!;
      expect(inbound.body).toBe('Yes, still for sale.\n\nSpring would be best & easiest.');
      expect((writer!.write.mock.calls[0]![0] as { user: string }).user).toContain('Spring would be best & easiest.');
    });

    it('the quoted thread below the reply is cut from the stored body and from what Sam reads', async () => {
      const s = await seedSeller();
      const text = `${THEIR_TEXT}\n\nOn Tue, Oct 20, 2026 at 9:00 AM Sam <${replyAddress(s.conv.token, CFG.EMAIL_REPLY_DOMAIN)}> wrote:\n> Hi Pat, I'm Sam.\n${samFooter(s.conv.token).map((l) => `> ${l}`).join('\n')}`;
      const email = reply(s, { text });
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect((await eventsOf(s.conv.id)).find((e) => e.direction === 'in')!.body).toBe(THEIR_TEXT);
      expect((writer!.write.mock.calls[0]![0] as { user: string }).user).not.toContain("I'm Sam");
    });

    it('caps what it stores and what Sam reads: text, subject and the answer\'s subject line', async () => {
      const s = await seedSeller();
      const long = `${'word '.repeat(4_000)}ZZTAILZZ`;
      const longSubject = `Re: ${'x'.repeat(400)}`;
      const email = reply(s, { text: long, subject: longSubject });
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      const inbound = (await eventsOf(s.conv.id)).find((e) => e.direction === 'in')!;
      expect(inbound.body!.length).toBeLessThanOrEqual(INBOUND_BODY_MAX);
      expect(inbound.body!.length).toBeGreaterThan(INBOUND_BODY_MAX - 10);
      expect(inbound.subject!.length).toBe(INBOUND_SUBJECT_MAX);
      const user = (writer!.write.mock.calls[0]![0] as { user: string }).user;
      const fenced = /<seller_email subject="([^"]*)">\n([\s\S]*)\n<\/seller_email>/.exec(user)!;
      expect(fenced[1]!.length).toBe(INBOUND_SUBJECT_MAX);
      expect(fenced[2]!.length).toBeLessThanOrEqual(INBOUND_TEXT_MAX);
      expect(fenced[2]!.length).toBeGreaterThan(INBOUND_TEXT_MAX - 10);
      expect(user).not.toContain('ZZTAILZZ');
      const [answer] = await queued(s.conv.id);
      expect((await eventsOf(s.conv.id)).find((e) => e.id === answer!.eventId)!.subject!.length).toBe(150);
    });

    it('a NUL character in the reply (Postgres text refuses it) is dropped, not retried forever', async () => {
      const s = await seedSeller();
      const email = reply(s, { text: `Yes\u0000 still for sale`, subject: `Re: Oak\u0000 St` });
      expect(await handleReceived(deps({ emails: [email] }).d, received(email), NOW)).toBe('done');
      expect((await eventsOf(s.conv.id)).find((e) => e.direction === 'in')).toMatchObject({ body: 'Yes still for sale', subject: 'Re: Oak St' });
    });
  });

  describe('a reply without a token', () => {
    it('is matched by In-Reply-To to the Message-ID of the email Sam sent', async () => {
      const s = await seedSeller();
      await sentBySam(s, { messageId: '<sam-42@resend.example>' });
      const email = reply(null, { headers: { 'in-reply-to': '<sam-42@resend.example>' } });
      expect(await handleReceived(deps({ emails: [email] }).d, received(email), NOW)).toBe('done');
      expect(await inboundRows(s.conv.id)).toHaveLength(1);
      expect(await queued(s.conv.id)).toHaveLength(1);
    });

    it('is matched by any id in References, with or without angle brackets on our stored Message-ID', async () => {
      const s = await seedSeller();
      await sentBySam(s, { messageId: 'sam-43@resend.example' });
      const email = reply(null, { headers: { references: '<unrelated@example.com>\r\n <sam-43@resend.example>' } });
      expect(await handleReceived(deps({ emails: [email] }).d, received(email), NOW)).toBe('done');
      expect(await inboundRows(s.conv.id)).toHaveLength(1);
    });

    it('never matches a seller\'s own inbound Message-ID (only Sam\'s outbound emails count)', async () => {
      const s = await seedSeller();
      const first = reply(s);
      await handleReceived(deps({ emails: [first] }).d, received(first), NOW);
      const stray = reply(null, { headers: { 'in-reply-to': THEIR_MESSAGE_ID } });
      const { d, log } = deps({ emails: [stray] });
      expect(await handleReceived(d, received(stray), NOW)).toBe('ignored');
      expect(log.info).toHaveBeenCalledWith({ resendId: stray.id }, expect.any(String));
    });

    it('with nothing that matches is ignored: nothing stored, and only the Resend id is logged', async () => {
      const s = await seedSeller();
      const stray = reply(null, { headers: { 'in-reply-to': '<nobody@example.com>' } });
      const { d, log, alert, writer } = deps({ emails: [stray] });
      expect(await handleReceived(d, received(stray), NOW)).toBe('ignored');
      expect(await inboundRows(s.conv.id)).toHaveLength(0);
      expect(writer!.write).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith({ resendId: stray.id }, expect.any(String));
      assertNoPii(alert, log);
    });

    it('a token of the right shape that names no conversation falls back to the headers', async () => {
      const s = await seedSeller();
      await sentBySam(s, { messageId: '<sam-44@resend.example>' });
      const email = reply(null, { to: [replyAddress('abcdefghijklmnopqrstuvwxyz', CFG.EMAIL_REPLY_DOMAIN)], headers: { 'in-reply-to': '<sam-44@resend.example>' } });
      expect(await handleReceived(deps({ emails: [email] }).d, received(email), NOW)).toBe('done');
      expect(await inboundRows(s.conv.id)).toHaveLength(1);
    });
  });

  describe('opt-outs', () => {
    it('mail to unsubscribe+<token> stops the seller and suppresses the address, and Sam is not asked', async () => {
      const s = await seedSeller();
      const email = reply(s, { to: [unsubscribeMailto(s.conv.token, CFG.EMAIL_REPLY_DOMAIN)], subject: 'unsubscribe', text: '' });
      const { d, writer, alert } = deps({ emails: [email] });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      expect(await suppressionFor(db, s.orgId, ADDRESS)).toBe('opted_out');
      expect(writer!.write).not.toHaveBeenCalled();
      expect(await queued(s.conv.id)).toHaveLength(0);
      expect(alert).not.toHaveBeenCalled();
      expect(await inboundRows(s.conv.id)).toHaveLength(1);
    });

    it('an opt-out at an address 7 records share stops only this seller and raises one seller_needs_person (ids and a count)', async () => {
      const s = await seedSeller();
      for (let i = 0; i < 6; i += 1) await seedRecord(db, s.orgId, snapshot({ sfRecordId: leadId(700_000 + (seq += 1)), email: ADDRESS }));
      const email = reply(s, { to: [unsubscribeMailto(s.conv.token, CFG.EMAIL_REPLY_DOMAIN)], subject: 'unsubscribe', text: '' });
      const { d, alert, log } = deps({ emails: [email] });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      const stopped = await t.pool.query(`select count(*)::int as n from seller_conversations where org_id = $1 and status = 'stopped'`, [s.orgId]);
      expect(stopped.rows[0].n).toBe(1);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0]![0]).toMatchObject({ kind: 'seller_needs_person', orgId: s.orgId, context: { conversationId: s.conv.id, sharedRecordCount: 7 } });
      expect(alert.mock.calls[0]![0].context).toEqual({ conversationId: s.conv.id, sharedRecordCount: 7 });
      assertNoPii(alert, log);
    });

    it.each([
      ['Cc', (s: Seller) => ({ cc: [unsubscribeMailto(s.conv.token, CFG.EMAIL_REPLY_DOMAIN)] })],
      ["Resend's received-for list", (s: Seller) => ({ receivedFor: [unsubscribeMailto(s.conv.token, CFG.EMAIL_REPLY_DOMAIN)] })],
    ])('mail to sam+<token> that also goes to unsubscribe+<the same token> (in %s) opts out', async (_where, also) => {
      const s = await seedSeller();
      const email = reply(s, also(s));
      const { d, writer } = deps({ emails: [email] });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      expect(writer!.write).not.toHaveBeenCalled();
    });

    it("unsubscribe+<another conversation's token> beside sam+<token> is not this seller's opt-out", async () => {
      const s = await seedSeller();
      const other = await seedSeller();
      const email = reply(s, { cc: [unsubscribeMailto(other.conv.token, CFG.EMAIL_REPLY_DOMAIN)] });
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).status).toBe('open');
      expect((await conversationRow(other.conv.id)).status).toBe('open');
      expect(writer!.write).toHaveBeenCalledTimes(1);
    });

    it('an unsubscribe mailto sent by an auto-responder still opts out', async () => {
      const s = await seedSeller();
      const email = reply(s, { to: [unsubscribeMailto(s.conv.token, CFG.EMAIL_REPLY_DOMAIN)], headers: { 'auto-submitted': 'auto-generated' } });
      await handleReceived(deps({ emails: [email] }).d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).status).toBe('stopped');
    });

    it('"Please take me off your list" written below the quoted thread opts out (the whole reply is read)', async () => {
      const s = await seedSeller();
      const text = `On Tue, Oct 20, 2026 at 9:00 AM Sam wrote:\n> Hi Pat, I'm Sam.\n\nPlease take me off your list.`;
      const email = reply(s, { text });
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
      expect(writer!.write).not.toHaveBeenCalled();
    });

    it('"Unsubscribe" in the subject line alone opts out', async () => {
      const s = await seedSeller();
      const email = reply(s, { subject: 'UNSUBSCRIBE', text: '' });
      await handleReceived(deps({ emails: [email] }).d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).status).toBe('stopped');
    });

    it('a reply that quotes Sam\'s footer (with ">") is not an opt-out: Sam answers it (Review Focus 1)', async () => {
      const s = await seedSeller();
      const text = `Sounds good, talk soon.\n\nOn Tue, Oct 20, 2026 at 9:00 AM Sam wrote:\n> Hi Pat, I'm Sam.\n${samFooter(s.conv.token).map((l) => `> ${l}`).join('\n')}`;
      const email = reply(s, { text });
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).status).toBe('open');
      expect(writer!.write).toHaveBeenCalledTimes(1);
      expect(await queued(s.conv.id)).toHaveLength(1);
    });

    it('a footer quoted with no ">" whose URL a client broke mid-path is not an opt-out (Review Focus 1)', async () => {
      const s = await seedSeller();
      const footer = samFooter(s.conv.token);
      const broken = [...footer.slice(0, -1), `To stop hearing from Sam, unsubscribe here: ${API_URL}/api/email/`, `unsubscribe/${s.conv.token}`];
      const email = reply(s, { text: ['Sounds good, talk soon.', '', ...broken].join('\n') });
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).status).toBe('open');
      expect(await suppressionFor(db, s.orgId, ADDRESS)).toBeNull();
      expect(writer!.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('replies Sam does not answer', () => {
    it('Auto-Submitted: auto-replied is recorded (marked auto-reply), never answered and never flagged (Review Focus 4)', async () => {
      const s = await seedSeller();
      const email = reply(s, { subject: 'Out of the office', headers: { 'auto-submitted': 'auto-replied' } });
      const { d, writer, alert } = deps({ emails: [email] });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      const inbound = (await eventsOf(s.conv.id)).find((e) => e.direction === 'in')!;
      expect(inbound.meta).toEqual({ autoReply: true });
      // An out-of-office is not logged to Salesforce (M9).
      expect(inbound).toMatchObject({ sfLogStatus: 'skipped', sfLogNextAt: null });
      expect(writer!.write).not.toHaveBeenCalled();
      expect(await queued(s.conv.id)).toHaveLength(0);
      expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'open', flagReason: null });
      expect(alert).not.toHaveBeenCalled();
      expect((await inboundRows(s.conv.id))[0]!.handledAt).toEqual(NOW);
    });

    it('a fourth seller reply after Sam sent 3 that day is flagged loop_guard, and the writer is not called (Review Focus 4)', async () => {
      const s = await seedSeller();
      for (const ago of [HOUR, 2 * HOUR, 23 * HOUR]) await sentBySam(s, { ago });
      const email = reply(s);
      const { d, writer, alert, log } = deps({ emails: [email] });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect((await conversationRow(s.conv.id)).flagReason).toBe('loop_guard');
      expect(writer!.write).not.toHaveBeenCalled();
      expect(await queued(s.conv.id)).toHaveLength(0);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0]![0]).toMatchObject({ kind: 'seller_needs_person', orgId: s.orgId, context: { reason: 'loop_guard' } });
      assertNoPii(alert, log);
    });

    it('3 sent but one of them over 24 hours ago is not a loop: Sam answers', async () => {
      const s = await seedSeller();
      for (const ago of [HOUR, 2 * HOUR, 25 * HOUR]) await sentBySam(s, { ago });
      const email = reply(s);
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect(writer!.write).toHaveBeenCalledTimes(1);
    });

    it('a sender that is not the seller: flagged other_sender with an alert carrying ids and the seller link only', async () => {
      const s = await seedSeller();
      const email = reply(s, { from: 'Someone Else <someone-else@example.com>' });
      const { d, writer, alert, log } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).flagReason).toBe('other_sender');
      expect(writer!.write).not.toHaveBeenCalled();
      const event = alert.mock.calls[0]![0];
      const [inbound] = await inboundRows(s.conv.id);
      expect(event).toMatchObject({ kind: 'seller_needs_person', orgId: s.orgId });
      expect(event.context).toEqual({ conversationId: s.conv.id, emailId: inbound!.id, reason: 'other_sender', sellerUrl: `${APP_URL}/sellers/${s.sfRecordId}` });
      assertNoPii(alert, log, ['someone-else@example.com', 'Someone Else']);
    });

    it('a sender that is not the seller is stored marked otherSender, still the seller\'s side of the timeline and still logged (M8)', async () => {
      const s = await seedSeller();
      const email = reply(s, { from: 'Someone Else <someone-else@example.com>' });
      await handleReceived(deps({ emails: [email] }).d, received(email), NOW);
      const inbound = (await eventsOf(s.conv.id)).find((e) => e.kind === 'email' && e.direction === 'in')!;
      expect(inbound).toMatchObject({ actor: 'seller', meta: { autoReply: false, otherSender: true }, sfLogStatus: 'pending' });
      // The seller's own reply is not marked.
      const own = reply(s);
      await handleReceived(deps({ emails: [own] }).d, received(own), NOW);
      const mine = (await eventsOf(s.conv.id)).filter((e) => e.kind === 'email' && e.direction === 'in').find((e) => e.id !== inbound.id)!;
      expect(mine.meta).toEqual({ autoReply: false });
    });

    it('a practice conversation\'s admin replying is not another sender; the seller\'s address there is (M8)', async () => {
      const s = await seedSeller();
      const adminId = await seedUser(db, s.orgId);
      const practice = await ensureConversation(db, { orgId: s.orgId, crmRecordId: s.crmRecordId, practiceUserId: adminId });
      const [admin] = await db.select().from(schema.users).where(eq(schema.users.id, adminId));
      const fromAdmin = reply({ ...s, conv: practice }, { from: `Admin <${admin!.email}>` });
      await handleReceived(deps({ emails: [fromAdmin] }).d, received(fromAdmin), NOW);
      expect((await eventsOf(practice.id)).find((e) => e.kind === 'email' && e.direction === 'in')!.meta).toEqual({ autoReply: false });
    });

    it('a reply from a suppressed address never reaches the writer: flagged unsure with an alert (M4)', async () => {
      const s = await seedSeller();
      // A stop that did not reach this record's conversation (an address shared by many records, for one).
      await suppressAddress(db, { orgId: s.orgId, address: ADDRESS.toUpperCase(), reason: 'opted_out', conversationId: null });
      const email = reply(s);
      const { d, writer, alert, log } = deps({ emails: [email] });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect(writer!.write).not.toHaveBeenCalled();
      expect(await queued(s.conv.id)).toHaveLength(0);
      expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'open', flagReason: 'unsure' });
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0]![0]).toMatchObject({ kind: 'seller_needs_person', context: { reason: 'unsure' } });
      assertNoPii(alert, log);
    });

    it('a reply from an address Salesforce opted out on ANOTHER record never reaches the writer: flagged unsure (M4, I2b)', async () => {
      const s = await seedSeller();
      await seedRecord(db, s.orgId, snapshot({ sfRecordId: leadId(800_000 + (seq += 1)), email: ` ${ADDRESS} ` }), { sfEmailOptOut: true });
      const email = reply(s);
      const { d, writer } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect(writer!.write).not.toHaveBeenCalled();
      expect((await conversationRow(s.conv.id)).flagReason).toBe('unsure');
    });

    it('an opt-out from a suppressed address is still an opt-out (the blocked-address rule comes after it)', async () => {
      const s = await seedSeller();
      await suppressAddress(db, { orgId: s.orgId, address: ADDRESS, reason: 'opted_out', conversationId: null });
      const email = reply(s, { subject: 'unsubscribe', text: '' });
      await handleReceived(deps({ emails: [email] }).d, received(email), NOW);
      expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out', flagReason: null });
    });

    it('a stopped conversation records the reply only', async () => {
      const s = await seedSeller();
      await t.pool.query(`update seller_conversations set status = 'stopped', stop_reason = 'not_interested' where id = $1`, [s.conv.id]);
      const email = reply(s);
      const { d, writer, alert } = deps({ emails: [email] });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect(writer!.write).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();
      expect(await inboundRows(s.conv.id)).toHaveLength(1);
    });

    it('a closed record is flagged after_close', async () => {
      const s = await seedSeller({ isClosed: true });
      const email = reply(s);
      await handleReceived(deps({ emails: [email] }).d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).flagReason).toBe('after_close');
    });

    it('a person handling the seller: recorded only, no alert', async () => {
      const s = await seedSeller();
      await t.pool.query(`update seller_conversations set handler = 'person' where id = $1`, [s.conv.id]);
      const email = reply(s);
      const { d, writer, alert } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect(writer!.write).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();
    });

    it('Sam email paused for the tenant: flagged unsure, the writer is not called', async () => {
      const s = await seedSeller({ settings: { samEmail: { enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint' } } });
      const email = reply(s);
      const { d, writer, alert } = deps({ emails: [email] });
      await handleReceived(d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).flagReason).toBe('unsure');
      expect(writer!.write).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it('the email channel not configured, or no writer: flagged unsure', async () => {
      const a = await seedSeller();
      const first = reply(a);
      await handleReceived(deps({ emails: [first], cfg: { ...CFG, emailEnabled: false } }).d, received(first), NOW);
      expect((await conversationRow(a.conv.id)).flagReason).toBe('unsure');

      const b = await seedSeller();
      const second = reply(b);
      await handleReceived(deps({ emails: [second], writer: null }).d, received(second), NOW);
      expect((await conversationRow(b.conv.id)).flagReason).toBe('unsure');
    });
  });

  describe('what Sam decides', () => {
    it('flag (offer_or_price): her thank-you goes out as a holding email and the conversation is flagged with her reason', async () => {
      const s = await seedSeller();
      const email = reply(s, { text: 'What would you offer for it?' });
      const { d, alert, log } = deps({ emails: [email], writer: fakeWriter(FLAG_OFFER) });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      const holding = await queued(s.conv.id);
      expect(holding).toHaveLength(1);
      expect(holding[0]).toMatchObject({ purpose: 'holding', toAddress: ADDRESS, inReplyTo: THEIR_MESSAGE_ID });
      expect((await eventsOf(s.conv.id)).find((e) => e.id === holding[0]!.eventId)!.body).toBe(FLAG_OFFER.body);
      expect((await conversationRow(s.conv.id)).flagReason).toBe('offer_or_price');
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0]![0]).toMatchObject({ kind: 'seller_needs_person', context: { reason: 'offer_or_price' } });
      assertNoPii(alert, log, ['What would you offer', FLAG_OFFER.body]);
    });

    it('flag with no reason is unsure', async () => {
      const s = await seedSeller();
      const email = reply(s);
      await handleReceived(deps({ emails: [email], writer: fakeWriter({ ...FLAG_OFFER, flagReason: null }) }).d, received(email), NOW);
      expect((await conversationRow(s.conv.id)).flagReason).toBe('unsure');
    });

    it('flag whose thank-you fails the draft check: no holding email, still flagged with her reason', async () => {
      const s = await seedSeller();
      const email = reply(s);
      await handleReceived(deps({ emails: [email], writer: fakeWriter({ ...FLAG_OFFER, body: 'We could offer $450,000.' }) }).d, received(email), NOW);
      expect(await queued(s.conv.id)).toHaveLength(0);
      expect((await conversationRow(s.conv.id)).flagReason).toBe('offer_or_price');
    });

    it('a draft that fails the check (a price, a link, a human claim) is not sent: flagged draft_rejected', async () => {
      const s = await seedSeller();
      const email = reply(s);
      const { d, alert } = deps({ emails: [email], writer: fakeWriter({ ...SEND, body: 'Homes like yours sell for $450,000 around here.' }) });
      await handleReceived(d, received(email), NOW);
      expect(await queued(s.conv.id)).toHaveLength(0);
      expect((await conversationRow(s.conv.id)).flagReason).toBe('draft_rejected');
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it('opt_out stops the seller as opted out; not_interested stops them as not interested; no_reply does nothing', async () => {
      const cases = [
        ['opt_out', { status: 'stopped', stopReason: 'opted_out' }],
        ['not_interested', { status: 'stopped', stopReason: 'not_interested' }],
        ['no_reply', { status: 'open', stopReason: null, flagReason: null }],
      ] as const;
      for (const [action, expected] of cases) {
        const s = await seedSeller();
        const email = reply(s);
        const { d, alert } = deps({ emails: [email], writer: fakeWriter({ action, flagReason: null, subject: '', body: '' }) });
        expect(await handleReceived(d, received(email), NOW)).toBe('done');
        expect(await conversationRow(s.conv.id), action).toMatchObject(expected);
        expect(await queued(s.conv.id), action).toHaveLength(0);
        expect(alert, action).not.toHaveBeenCalled();
        expect((await inboundRows(s.conv.id))[0]!.handledAt, action).toEqual(NOW);
        // Only an opt-out puts the address on the suppression list.
        expect(await suppressionFor(db, s.orgId, ADDRESS), action).toBe(action === 'opt_out' ? 'opted_out' : null);
      }
    });

    it('over budget: flagged unsure with an alert, never dropped', async () => {
      const s = await seedSeller({ settings: { aiDailyBudgetUsd: 0, samEmail: { enabled: true } } });
      const email = reply(s);
      const { d, writer, alert } = deps({ emails: [email] });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect(writer!.write).not.toHaveBeenCalled();
      expect((await conversationRow(s.conv.id)).flagReason).toBe('unsure');
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it('a writer that fails: flagged unsure with an alert, and the error text is never logged', async () => {
      const s = await seedSeller();
      const email = reply(s);
      const writer = fakeWriter(SEND, async () => {
        throw new BoomError(`model choked on ${THEIR_TEXT}`);
      });
      const { d, alert, log } = deps({ emails: [email], writer });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect((await conversationRow(s.conv.id)).flagReason).toBe('unsure');
      expect(alert).toHaveBeenCalledTimes(1);
      assertNoPii(alert, log);
    });

    it('an alert that throws does not undo the flag or fail the event', async () => {
      const s = await seedSeller();
      const email = reply(s, { from: 'someone-else@example.com' });
      const alert = vi.fn(async () => {
        throw new BoomError('webhook down');
      });
      const { d, log } = deps({ emails: [email], alert });
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect((await conversationRow(s.conv.id)).flagReason).toBe('other_sender');
      expect(JSON.stringify(log.error.mock.calls)).toContain('BoomError');
    });
  });

  describe('a practice conversation (an admin\'s own copy)', () => {
    async function practiceFor(s: Seller): Promise<{ conv: SellerConversationRow; adminEmail: string }> {
      const adminId = await seedUser(db, s.orgId);
      const [user] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, adminId));
      return { conv: await ensureConversation(db, { orgId: s.orgId, crmRecordId: s.crmRecordId, practiceUserId: adminId }), adminEmail: user!.email };
    }

    it('the admin\'s reply is answered to the admin\'s address at once (even in the evening), and nothing is logged to Salesforce', async () => {
      const s = await seedSeller();
      const practice = await practiceFor(s);
      const email = reply({ ...s, conv: practice.conv }, { from: `Admin <${practice.adminEmail.toUpperCase()}>` });
      expect(await handleReceived(deps({ emails: [email] }).d, received(email), EVENING)).toBe('done');
      const [answer] = await queued(practice.conv.id);
      expect(answer).toMatchObject({ purpose: 'reply', toAddress: practice.adminEmail, sendAfter: EVENING });
      expect((await eventsOf(practice.conv.id)).every((e) => e.sfLogStatus === 'skipped')).toBe(true);
      expect(await queued(s.conv.id)).toHaveLength(0);
    });

    it('a sender that is not the admin is flagged other_sender, even when it is the seller\'s address', async () => {
      const s = await seedSeller();
      const practice = await practiceFor(s);
      const email = reply({ ...s, conv: practice.conv });
      await handleReceived(deps({ emails: [email] }).d, received(email), NOW);
      expect((await conversationRow(practice.conv.id)).flagReason).toBe('other_sender');
      expect((await conversationRow(s.conv.id)).flagReason).toBeNull();
    });
  });

  describe('when Resend cannot give the email back', () => {
    it.each([400, 404, 410, 422])('HTTP %i: ignored (it will never be readable), logged by id and status only', async (status) => {
      const s = await seedSeller();
      const resend: ResendClient = { send: vi.fn(), getReceived: vi.fn(async () => Promise.reject(new ResendError(status))) };
      const { d, log } = deps({ resend });
      expect(await handleReceived(d, received('re_in_gone'), NOW)).toBe('ignored');
      expect(log.warn).toHaveBeenCalledWith({ resendId: 're_in_gone', status }, expect.any(String));
      expect(await inboundRows(s.conv.id)).toHaveLength(0);
    });

    describe('a 404 or 410 soon after the event arrived: Resend\'s stored copy can lag its webhook', () => {
      const failingWith = (status: number) => deps({ resend: { send: vi.fn(), getReceived: vi.fn(async () => Promise.reject(new ResendError(status))) } });
      const arrived = (ago: number) => ({ data: { email_id: 're_in_lagging' }, receivedAt: new Date(NOW.getTime() - ago) });

      it.each([404, 410])('HTTP %i under 10 minutes after the event arrived: retry; from 10 minutes on: ignored', async (status) => {
        expect(UNREADABLE_RETRY_WINDOW_MS).toBe(10 * MINUTE);
        expect(await handleReceived(failingWith(status).d, arrived(0), NOW)).toBe('retry');
        expect(await handleReceived(failingWith(status).d, arrived(10 * MINUTE - 1000), NOW)).toBe('retry');
        expect(await handleReceived(failingWith(status).d, arrived(10 * MINUTE), NOW)).toBe('ignored');
        expect(await handleReceived(failingWith(status).d, arrived(11 * MINUTE), NOW)).toBe('ignored');
      });

      it.each([400, 422])('HTTP %i is never waited for: ignored at once', async (status) => {
        expect(await handleReceived(failingWith(status).d, arrived(0), NOW)).toBe('ignored');
      });

      it('the retry is logged by id and status only', async () => {
        const { d, log } = failingWith(404);
        await handleReceived(d, arrived(MINUTE), NOW);
        expect(log.info).toHaveBeenCalledWith({ resendId: 're_in_lagging', status: 404 }, expect.any(String));
      });
    });

    it.each([
      ['no answer (status 0)', new ResendError(0, 'timeout')],
      ['401', new ResendError(401)],
      ['403', new ResendError(403)],
      ['429', new ResendError(429)],
      ['500', new ResendError(500)],
      ['503', new ResendError(503)],
      ['an unreadable 200', new ResendError(200, 'HTTP 200 bad_response')],
      ['an error that is not ResendError', new BoomError(`socket hang up for ${ADDRESS}`)],
    ])('%s: retry', async (_name, err) => {
      const resend: ResendClient = { send: vi.fn(), getReceived: vi.fn(async () => Promise.reject(err)) };
      const { d, log, alert } = deps({ resend });
      expect(await handleReceived(d, received('re_in_later'), NOW)).toBe('retry');
      assertNoPii(alert, log);
    });

    it('an event with no usable email id is ignored without asking Resend', async () => {
      const resend: ResendClient = { send: vi.fn(), getReceived: vi.fn() };
      const { d } = deps({ resend });
      for (const data of [undefined, {}, { email_id: '' }, { email_id: 7 }, 'nope']) {
        expect(await handleReceived(d, { data } as never, NOW)).toBe('ignored');
      }
      expect(resend.getReceived).not.toHaveBeenCalled();
    });
  });

  describe('two ticks, and a crash', () => {
    it('two handlers on the same event at once: one writer call and one answer', async () => {
      const s = await seedSeller();
      const email = reply(s);
      const writer = fakeWriter();
      const a = deps({ emails: [email], writer });
      const b = deps({ emails: [email], writer });
      const outcomes = await Promise.all([handleReceived(a.d, received(email), NOW), handleReceived(b.d, received(email), NOW)]);
      expect(outcomes.filter((o) => o === 'done').length).toBeGreaterThanOrEqual(1);
      expect(writer.write).toHaveBeenCalledTimes(1);
      expect(await queued(s.conv.id)).toHaveLength(1);
      expect(await inboundRows(s.conv.id)).toHaveLength(1);
      expect((await eventsOf(s.conv.id)).filter((e) => e.direction === 'in')).toHaveLength(1);
    });

    it('the loser of the store race (its insert hits the row another tick has not committed yet) rolls its event back and uses that row', async () => {
      const s = await seedSeller();
      const email = reply(s);
      const { d, writer } = deps({ emails: [email] });
      // Another tick has stored AND handled this reply, but has not committed: the loser's pre-check cannot see it.
      const holder = await t.pool.connect();
      let open = true;
      try {
        await holder.query('begin');
        const held = await holder.query<{ id: string }>(
          `insert into conversation_events (org_id, conversation_id, kind, direction, actor, subject, body) values ($1, $2, 'email', 'in', 'seller', 'held', 'held') returning id`,
          [s.orgId, s.conv.id],
        );
        await holder.query(
          `insert into email_messages (org_id, conversation_id, event_id, direction, status, purpose, to_address, from_address, resend_id, handled_at)
           values ($1, $2, $3, 'in', 'received', 'inbound', 'to', 'from', $4, $5)`,
          [s.orgId, s.conv.id, held.rows[0]!.id, email.id, NOW],
        );
        const loser = handleReceived(d, received(email), NOW);
        // The loser is inside its store transaction, its event written, waiting on the unique index for the holder.
        await waitForLockWait();
        await holder.query('commit');
        open = false;
        expect(await loser).toBe('done');
      } finally {
        if (open) await holder.query('rollback');
        holder.release();
      }
      const inbound = await inboundRows(s.conv.id);
      expect(inbound).toHaveLength(1);
      const events = (await eventsOf(s.conv.id)).filter((e) => e.direction === 'in');
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe(inbound[0]!.eventId);
      expect(events[0]!.body).toBe('held');
      expect(writer!.write).not.toHaveBeenCalled();
      expect(await queued(s.conv.id)).toHaveLength(0);
    });

    it('a second handler that finds the reply locked by the first answers retry, and never calls the writer', async () => {
      const s = await seedSeller();
      const email = reply(s);
      let release!: () => void;
      let inside!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const slow = fakeWriter(SEND, async () => {
        inside();
        await gate;
        return SEND;
      });
      const second = fakeWriter();
      const first = handleReceived(deps({ emails: [email], writer: slow }).d, received(email), NOW);
      await entered; // the first handler holds the reply's row and is waiting on the model
      expect(await handleReceived(deps({ emails: [email], writer: second }).d, received(email), NOW)).toBe('retry');
      release();
      expect(await first).toBe('done');
      expect(second.write).not.toHaveBeenCalled();
      expect(await queued(s.conv.id)).toHaveLength(1);
      // Once the first has committed, the event is simply done.
      expect(await handleReceived(deps({ emails: [email], writer: second }).d, received(email), NOW)).toBe('done');
      expect(second.write).not.toHaveBeenCalled();
    });

    it('a crash after Sam answered but before handled_at commits leaves nothing half-done: the retry answers exactly once', async () => {
      const s = await seedSeller();
      const email = reply(s);
      const { d, writer, alert } = deps({ emails: [email] });
      // The last write of the handling transaction (handled_at) fails: the queued answer must not survive it.
      await expect(failingWrites('email_messages', 'update', () => handleReceived(d, received(email), NOW))).rejects.toThrow();
      expect(await queued(s.conv.id)).toHaveLength(0);
      const [stored] = await inboundRows(s.conv.id);
      expect(stored!.handledAt).toBeNull();
      expect(alert).not.toHaveBeenCalled();

      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect(await queued(s.conv.id)).toHaveLength(1);
      expect(await inboundRows(s.conv.id)).toHaveLength(1);
      expect(writer!.write).toHaveBeenCalledTimes(2);
    });

    it('a crash before the reply was stored stores nothing: the retry stores it once', async () => {
      const s = await seedSeller();
      const email = reply(s);
      const { d } = deps({ emails: [email] });
      await expect(failingWrites('email_messages', 'insert', () => handleReceived(d, received(email), NOW))).rejects.toThrow();
      expect(await eventsOf(s.conv.id)).toHaveLength(0);
      expect(await handleReceived(d, received(email), NOW)).toBe('done');
      expect((await eventsOf(s.conv.id)).filter((e) => e.direction === 'in')).toHaveLength(1);
    });
  });
});
