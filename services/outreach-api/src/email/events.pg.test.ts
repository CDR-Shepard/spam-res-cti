/**
 * Real Postgres: the webhook event tick and the delivery events. What these protect: a seller who complains
 * is never emailed again and the tenant is paused; a bounce suppresses the address; the events Resend sends
 * in any order land on the same final state; a stored event is worked on by one tick at a time and retried
 * with a backoff when it throws.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { leadId, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { seedUser } from '../test/call-plan-seed.js';
import { ensureConversation, suppressionFor, type SellerConversationRow } from '../conversations/store.js';
import { samEmailSettings } from '../settings.js';
import type { AlertEvent } from '../alerts.js';
import { queueEmail } from './outbox.js';
import { handleDeliveryEvent, processEmailEvents, type EventDeps } from './events.js';
import { replyAddress } from './addresses.js';
import { ResendError, type ReceivedEmail, type ResendClient } from './resend-client.js';

const NOW = new Date('2026-10-20T17:00:00.000Z');
const MINUTE = 60_000;
/** Older than the 5 minutes an unmatched event may still wait for its email row. */
const STALE = 10 * MINUTE;
const APP_URL = 'https://app.example.com';
const SUBJECT = 'Re: the house on Oak Street';
const BODY = 'Thanks for getting back to me. Would Thursday afternoon work for a quick call?';
const CFG: EventDeps['cfg'] = {
  emailEnabled: true,
  EMAIL_FROM: 'Sam at GG Homes <sam@rethinkre.team>',
  EMAIL_REPLY_DOMAIN: 'reply.rethinkre.team',
  EMAIL_POSTAL_ADDRESS: '18872 MacArthur Blvd #220, Irvine, CA 92612',
  EMAIL_COMPANY_NAME: 'GG Homes',
  API_PUBLIC_URL: 'https://outreach.example.com',
};
/** The tick never calls Resend for a delivery event: any call is a bug. */
const NO_RESEND: ResendClient = {
  async send() {
    throw new Error('send is not used by the events tick');
  },
  async getReceived() {
    throw new Error('getReceived is not used by delivery events');
  },
};

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * A Resend that serves inbound emails for the reply handler (email/inbound.ts): `answer(id)` is what
 * getReceived returns for an id (a thrown error is Resend failing).
 */
function inbox(answer: (id: string) => Promise<ReceivedEmail>): ResendClient & { getReceived: ReturnType<typeof vi.fn> } {
  return {
    async send() {
      throw new Error('send is not used by the events tick');
    },
    getReceived: vi.fn(answer),
  };
}

/** An auto-reply (recorded, never answered: no writer needed) to the conversation with this token. */
function autoReply(token: string, id = `re_in_${randomUUID()}`): ReceivedEmail {
  return {
    id,
    from: 'Pat Seller <delivered@resend.dev>',
    to: [replyAddress(token, 'reply.rethinkre.team')],
    cc: [],
    receivedFor: [],
    subject: 'Out of the office',
    text: 'I am away until Monday.',
    html: null,
    headers: { 'auto-submitted': 'auto-replied' },
    messageId: '<ooo-1@mail.example.com>',
  };
}

class BoomError extends Error {
  override name = 'BoomError';
}

describe.skipIf(!pgLane)('webhook events (real Postgres)', () => {
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
  // The tick claims every tenant's due events, so one test's leftovers must not reach the next.
  afterEach(async () => {
    await t.pool.query('delete from resend_webhook_events');
    await t.pool.query('delete from conversation_events');
  });

  interface Seller {
    orgId: string;
    crmRecordId: string;
    sfRecordId: string;
    address: string;
    conv: SellerConversationRow;
  }

  /** A fresh tenant (Sam email on) with one seller and their conversation. */
  async function seedSeller(address = 'delivered@resend.dev'): Promise<Seller> {
    seq += 1;
    const orgId = await seedOrg(db, { aiDailyBudgetUsd: 40, samEmail: { enabled: true } });
    const sfRecordId = leadId(seq);
    const crmRecordId = await seedRecord(db, orgId, snapshot({ sfRecordId, email: address }));
    return { orgId, crmRecordId, sfRecordId, address, conv: await ensureConversation(db, { orgId, crmRecordId }) };
  }

  /** One email Sam sent to the seller: the row is `sent` with the Resend id the webhook will name. */
  async function sentEmail(s: Seller, over: { conversationId?: string; status?: string; resendId?: string; to?: string } = {}): Promise<{ emailId: string; resendId: string }> {
    const { emailId } = await queueEmail(db, {
      orgId: s.orgId,
      conversationId: over.conversationId ?? s.conv.id,
      to: over.to ?? s.address,
      from: CFG.EMAIL_FROM,
      subject: SUBJECT,
      body: BODY,
      purpose: over.conversationId ? 'practice' : 'reply',
      requestedBy: null,
      inReplyTo: null,
      references: null,
      sendAfter: new Date(NOW.getTime() - MINUTE),
    });
    const resendId = over.resendId ?? `re_${randomUUID()}`;
    await t.pool.query(`update email_messages set status = $2, resend_id = $3, sent_at = $4 where id = $1`, [emailId, over.status ?? 'sent', resendId, NOW]);
    return { emailId, resendId };
  }

  /** A stored webhook event, as the route leaves it: pending and due a minute ago unless told otherwise. */
  async function receive(
    type: string,
    data: Record<string, unknown>,
    over: { svixId?: string; receivedAt?: Date; nextAttemptAt?: Date; attempts?: number } = {},
  ): Promise<string> {
    const svixId = over.svixId ?? `msg_${randomUUID()}`;
    await t.pool.query(
      `insert into resend_webhook_events (svix_id, type, payload, received_at, next_attempt_at, attempts) values ($1, $2, $3::jsonb, $4, $5, $6)`,
      [svixId, type, JSON.stringify({ type, data }), over.receivedAt ?? new Date(NOW.getTime() - MINUTE), over.nextAttemptAt ?? new Date(NOW.getTime() - MINUTE), over.attempts ?? 0],
    );
    return svixId;
  }

  async function emailRow(emailId: string) {
    const [row] = await db.select().from(schema.emailMessages).where(eq(schema.emailMessages.id, emailId));
    return row!;
  }
  async function conversationRow(id: string) {
    const [row] = await db.select().from(schema.sellerConversations).where(eq(schema.sellerConversations.id, id));
    return row!;
  }
  async function webhookRow(svixId: string) {
    const [row] = await db.select().from(schema.resendWebhookEvents).where(eq(schema.resendWebhookEvents.svixId, svixId));
    return row!;
  }
  async function settingsOf(orgId: string): Promise<Record<string, unknown>> {
    const [row] = await db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
    return row!.settings as Record<string, unknown>;
  }
  async function eventsOf(conversationId: string) {
    return db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.conversationId, conversationId));
  }

  /** What a direct `handleDeliveryEvent` call needs to raise the complaint alert. */
  const notifyWith = (alert: (e: AlertEvent) => Promise<void>, log: ReturnType<typeof fakeLog> = fakeLog()) => ({ alert, appPublicUrl: APP_URL, log });

  /** Makes every `kind` write on `table` fail while `run` works: a dependency that is down in the middle of an event. */
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

  /** A notify stub for the tests that do not look at alerts (the parameter is required). */
  const quiet = () => notifyWith(vi.fn(async () => {}));

  function deps(over: Partial<EventDeps> = {}) {
    const alert = vi.fn(async (_event: AlertEvent) => {});
    const log = fakeLog();
    return { alert, log, deps: { db, resend: NO_RESEND, writer: null, cfg: CFG, appPublicUrl: APP_URL, now: NOW, log, alert, ...over } satisfies EventDeps };
  }

  describe('email.sent and email.delivered, in either order (Review Focus 3)', () => {
    const SENT = (resendId: string, messageId = '<abc123@resend.example>') => ({ type: 'email.sent', data: { email_id: resendId, message_id: messageId } });
    const DELIVERED = (resendId: string) => ({ type: 'email.delivered', data: { email_id: resendId } });

    it('sent then delivered ends delivered with the message id', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s);
      expect(await handleDeliveryEvent(db, SENT(resendId), NOW, quiet())).toBe('done');
      expect(await handleDeliveryEvent(db, DELIVERED(resendId), NOW, quiet())).toBe('done');
      expect(await emailRow(emailId)).toMatchObject({ status: 'delivered', messageId: '<abc123@resend.example>' });
    });

    it('delivered then sent still ends delivered, and the late sent still records the message id', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s);
      expect(await handleDeliveryEvent(db, DELIVERED(resendId), NOW, quiet())).toBe('done');
      expect(await handleDeliveryEvent(db, SENT(resendId), NOW, quiet())).toBe('done');
      expect(await emailRow(emailId)).toMatchObject({ status: 'delivered', messageId: '<abc123@resend.example>' });
    });

    it('the same holds through the tick when both were stored in the order delivered, sent', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s);
      const first = await receive('email.delivered', { email_id: resendId }, { receivedAt: new Date(NOW.getTime() - 2 * MINUTE) });
      const second = await receive('email.sent', SENT(resendId).data, { receivedAt: new Date(NOW.getTime() - MINUTE) });
      expect(await processEmailEvents(deps().deps)).toEqual({ done: 2, ignored: 0, failed: 0 });
      expect(await emailRow(emailId)).toMatchObject({ status: 'delivered', messageId: '<abc123@resend.example>' });
      expect(await webhookRow(first)).toMatchObject({ status: 'done', processedAt: NOW, lastError: null });
      expect(await webhookRow(second)).toMatchObject({ status: 'done', processedAt: NOW });
    });

    it('a message id already on the row is kept, and a sent event without one changes nothing', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s);
      await t.pool.query(`update email_messages set message_id = '<ours@example.com>' where id = $1`, [emailId]);
      await handleDeliveryEvent(db, SENT(resendId, '<other@resend.example>'), NOW, quiet());
      expect((await emailRow(emailId)).messageId).toBe('<ours@example.com>');
      await handleDeliveryEvent(db, { type: 'email.sent', data: { email_id: resendId } }, NOW, quiet());
      await handleDeliveryEvent(db, { type: 'email.sent', data: { email_id: resendId, message_id: 42 } }, NOW, quiet());
      expect((await emailRow(emailId)).messageId).toBe('<ours@example.com>');
    });

    it('delivered only moves a row that is sending or sent: a bounced, complained or failed row stays as it is', async () => {
      const s = await seedSeller();
      for (const status of ['bounced', 'complained', 'failed']) {
        const { emailId, resendId } = await sentEmail(s, { status });
        expect(await handleDeliveryEvent(db, DELIVERED(resendId), NOW, quiet())).toBe('done');
        expect((await emailRow(emailId)).status).toBe(status);
      }
      const { emailId, resendId } = await sentEmail(s, { status: 'sending' });
      await handleDeliveryEvent(db, DELIVERED(resendId), NOW, quiet());
      expect((await emailRow(emailId)).status).toBe('delivered');
    });
  });

  describe('email.bounced', () => {
    it('marks the email bounced, suppresses the address, notes it on the timeline and leaves the conversation open', async () => {
      const s = await seedSeller('bounced@resend.dev');
      const { emailId, resendId } = await sentEmail(s);
      expect(await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW, quiet())).toBe('done');
      expect((await emailRow(emailId)).status).toBe('bounced');
      expect(await suppressionFor(db, s.orgId, 'BOUNCED@resend.dev')).toBe('bounced');
      expect((await conversationRow(s.conv.id)).status).toBe('open');
      const notes = (await eventsOf(s.conv.id)).filter((e) => e.kind === 'note');
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ detail: 'bounced', direction: 'none', actor: 'system', sfLogStatus: 'skipped' });
      expect(samEmailSettings({ settings: await settingsOf(s.orgId) }).pausedAt).toBeNull();
    });

    it('a bounce arriving after a delivered (or failed) event still lands, once', async () => {
      const s = await seedSeller('bounced@resend.dev');
      const { emailId, resendId } = await sentEmail(s, { status: 'delivered' });
      await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW, quiet());
      await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW, quiet());
      expect((await emailRow(emailId)).status).toBe('bounced');
      expect((await eventsOf(s.conv.id)).filter((e) => e.kind === 'note')).toHaveLength(1);
    });

    it('a bounce on an email already marked complained keeps complained', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s, { status: 'complained' });
      await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW, quiet());
      expect((await emailRow(emailId)).status).toBe('complained');
    });

    it("a bounce on a practice conversation's email never reaches the suppression list", async () => {
      const s = await seedSeller('bounced@resend.dev');
      const adminId = await seedUser(db, s.orgId);
      const practice = await ensureConversation(db, { orgId: s.orgId, crmRecordId: s.crmRecordId, practiceUserId: adminId });
      const { emailId, resendId } = await sentEmail(s, { conversationId: practice.id });
      await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW, quiet());
      expect((await emailRow(emailId)).status).toBe('bounced');
      expect(await suppressionFor(db, s.orgId, 'bounced@resend.dev')).toBeNull();
    });
  });

  describe('email.complained', () => {
    const complaint = (resendId: string) => ({ type: 'email.complained', data: { email_id: resendId } });

    it('marks the email complained, stops the seller, turns Sam email off with a pause, and alerts once', async () => {
      const s = await seedSeller('complained@resend.dev');
      const { emailId, resendId } = await sentEmail(s);
      const svixId = await receive('email.complained', { email_id: resendId });
      const { deps: d, alert } = deps();

      expect(await processEmailEvents(d)).toEqual({ done: 1, ignored: 0, failed: 0 });

      expect((await emailRow(emailId)).status).toBe('complained');
      expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'stopped', stopReason: 'complained' });
      expect(await suppressionFor(db, s.orgId, s.address)).toBe('complained');
      const settings = await settingsOf(s.orgId);
      expect(settings).toMatchObject({ aiDailyBudgetUsd: 40, samEmail: { enabled: false, pausedAt: NOW.toISOString(), pausedReason: 'complaint' } });
      expect(samEmailSettings({ settings })).toEqual({ enabled: false, pausedAt: NOW.toISOString(), pausedReason: 'complaint' });
      expect(alert).toHaveBeenCalledTimes(1);
      expect(await webhookRow(svixId)).toMatchObject({ status: 'done' });
    });

    it('the alert carries ids and the seller-page link only: no address, subject or text', async () => {
      const s = await seedSeller('complained@resend.dev');
      const { emailId, resendId } = await sentEmail(s);
      const { alert, log } = deps();
      await handleDeliveryEvent(db, complaint(resendId), NOW, notifyWith(alert, log));

      const event = alert.mock.calls[0]![0];
      expect(event).toMatchObject({ kind: 'email_complaint', severity: 'critical', orgId: s.orgId });
      expect(event.context).toEqual({ emailId, conversationId: s.conv.id, sellerUrl: `${APP_URL}/sellers/${s.sfRecordId}` });
      const everything = JSON.stringify([event, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
      for (const secret of ['complained@resend.dev', SUBJECT, BODY, 'Pat Seller']) expect(everything).not.toContain(secret);
    });

    it('a trailing slash on the app url does not double up in the link', async () => {
      const s = await seedSeller('complained@resend.dev');
      const { resendId } = await sentEmail(s);
      const { alert } = deps();
      await handleDeliveryEvent(db, complaint(resendId), NOW, { ...notifyWith(alert), appPublicUrl: `${APP_URL}//` });
      expect(alert.mock.calls[0]![0].context?.sellerUrl).toBe(`${APP_URL}/sellers/${s.sfRecordId}`);
    });

    it('suppresses the address that complained, not only the one on the record now', async () => {
      const s = await seedSeller('record-owner@example.com');
      const { resendId } = await sentEmail(s, { to: 'complained@resend.dev' });
      await handleDeliveryEvent(db, complaint(resendId), NOW, quiet());
      expect(await suppressionFor(db, s.orgId, 'complained@resend.dev')).toBe('complained');
      expect(await suppressionFor(db, s.orgId, 'record-owner@example.com')).toBe('complained');
    });

    it('a second complaint event for the same email changes nothing and does not alert again', async () => {
      const s = await seedSeller('complained@resend.dev');
      const { resendId } = await sentEmail(s);
      await receive('email.complained', { email_id: resendId }, { receivedAt: new Date(NOW.getTime() - 2 * MINUTE) });
      await receive('email.complained', { email_id: resendId }, { receivedAt: new Date(NOW.getTime() - MINUTE) });
      const { deps: d, alert } = deps();
      expect(await processEmailEvents(d)).toEqual({ done: 2, ignored: 0, failed: 0 });
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it('a failing alert does not undo the complaint: the changes are committed and the event is done', async () => {
      const s = await seedSeller('complained@resend.dev');
      const { emailId, resendId } = await sentEmail(s);
      const svixId = await receive('email.complained', { email_id: resendId });
      const alert = vi.fn(async () => {
        throw new BoomError('webhook host unreachable');
      });
      const { deps: d, log } = deps({ alert });
      expect(await processEmailEvents(d)).toEqual({ done: 1, ignored: 0, failed: 0 });
      expect(alert).toHaveBeenCalledTimes(1);
      expect((await emailRow(emailId)).status).toBe('complained');
      expect((await conversationRow(s.conv.id)).status).toBe('stopped');
      expect(samEmailSettings({ settings: await settingsOf(s.orgId) }).pausedAt).toBe(NOW.toISOString());
      expect(await webhookRow(svixId)).toMatchObject({ status: 'done' });
      expect(JSON.stringify(log.error.mock.calls)).not.toContain('unreachable');
    });

    it('with no alert passed the tick sends it through the shared dispatcher (it never throws)', async () => {
      const s = await seedSeller('complained@resend.dev');
      const { resendId } = await sentEmail(s);
      await receive('email.complained', { email_id: resendId });
      const { deps: d, log } = deps();
      const { alert: _unused, ...withoutAlert } = d;
      vi.stubEnv('ALERT_WEBHOOK_URL', ''); // the shared dispatcher would POST to a configured webhook: not from a test
      try {
        expect(await processEmailEvents(withoutAlert)).toEqual({ done: 1, ignored: 0, failed: 0 });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ alert: 'email_complaint', orgId: s.orgId }), expect.any(String));
    });

    it("a complaint on a practice conversation's email stops only the practice row but still pauses the tenant", async () => {
      const s = await seedSeller('complained@resend.dev');
      const adminId = await seedUser(db, s.orgId);
      const practice = await ensureConversation(db, { orgId: s.orgId, crmRecordId: s.crmRecordId, practiceUserId: adminId });
      const { resendId } = await sentEmail(s, { conversationId: practice.id, to: 'admin-practice@example.com' });
      const { alert } = deps();
      await handleDeliveryEvent(db, complaint(resendId), NOW, notifyWith(alert));
      expect((await conversationRow(practice.id)).status).toBe('stopped');
      expect((await conversationRow(s.conv.id)).status).toBe('open');
      expect(await suppressionFor(db, s.orgId, s.address)).toBeNull();
      expect(await suppressionFor(db, s.orgId, 'admin-practice@example.com')).toBeNull();
      expect(samEmailSettings({ settings: await settingsOf(s.orgId) }).pausedAt).toBe(NOW.toISOString());
      expect(alert).toHaveBeenCalledTimes(1);
    });

    it('two ticks running at once alert once: a claimed event is not handed to the second tick', async () => {
      const s = await seedSeller('complained@resend.dev');
      const { resendId } = await sentEmail(s);
      await receive('email.complained', { email_id: resendId });
      const { deps: d, alert } = deps();
      const [a, b] = await Promise.all([processEmailEvents(d), processEmailEvents(d)]);
      expect(a.done + b.done).toBe(1);
      expect(alert).toHaveBeenCalledTimes(1);
    });
  });

  describe('email.failed and email.suppressed', () => {
    it.each(['email.failed', 'email.suppressed'])('%s fails a sent email and records the event type as the reason', async (type) => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s);
      expect(await handleDeliveryEvent(db, { type, data: { email_id: resendId } }, NOW, quiet())).toBe('done');
      expect(await emailRow(emailId)).toMatchObject({ status: 'failed', lastError: type });
    });

    it('does not overwrite a delivered email', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s, { status: 'delivered' });
      await handleDeliveryEvent(db, { type: 'email.failed', data: { email_id: resendId } }, NOW, quiet());
      expect(await emailRow(emailId)).toMatchObject({ status: 'delivered', lastError: null });
    });
  });

  describe('what is ignored', () => {
    it('an event for an email id that is not ours is ignored', async () => {
      expect(await handleDeliveryEvent(db, { type: 'email.delivered', data: { email_id: `re_${randomUUID()}` } }, NOW, quiet())).toBe('ignored');
    });

    it('only OUR outbound email matches: an inbound row with that Resend id does not', async () => {
      const s = await seedSeller();
      const { emailId } = await sentEmail(s);
      await t.pool.query(`update email_messages set direction = 'in', status = 'received', resend_id = 're_inbound' where id = $1`, [emailId]);
      expect(await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: 're_inbound' } }, NOW, quiet())).toBe('ignored');
      expect(await suppressionFor(db, s.orgId, s.address)).toBeNull();
    });

    it.each([
      ['no data', undefined],
      ['no email_id', {}],
      ['a non-string email_id', { email_id: 7 }],
      ['a blank email_id', { email_id: '' }],
      ['data that is not an object', 'nope'],
    ])('an event with %s is ignored', async (_name, data) => {
      expect(await handleDeliveryEvent(db, { type: 'email.delivered', data }, NOW, quiet())).toBe('ignored');
    });

    it.each(['email.opened', 'email.clicked', 'email.delivery_delayed', 'contact.created', 'domain.updated', ''])('the type %j is ignored', async (type) => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s);
      expect(await handleDeliveryEvent(db, { type, data: { email_id: resendId } }, NOW, quiet())).toBe('ignored');
      expect((await emailRow(emailId)).status).toBe('sent');
    });

    it('the tick marks an unmatched event ignored and counts it, once it is too old to be waiting for its email row', async () => {
      const svixId = await receive('email.delivered', { email_id: `re_${randomUUID()}` }, { receivedAt: new Date(NOW.getTime() - STALE) });
      expect(await processEmailEvents(deps().deps)).toEqual({ done: 0, ignored: 1, failed: 0 });
      expect(await webhookRow(svixId)).toMatchObject({ status: 'ignored', processedAt: NOW });
    });
  });

  describe('an event that names an email we have not recorded yet (Resend can answer before the send tick commits resend_id)', () => {
    const delivered = (ageMs: number) => ({ type: 'email.delivered', data: { email_id: 're_not_yet' }, receivedAt: new Date(NOW.getTime() - ageMs) });

    it('is retried while it is under 5 minutes old, and ignored from 5 minutes on', async () => {
      expect(await handleDeliveryEvent(db, delivered(0), NOW, quiet())).toBe('retry');
      expect(await handleDeliveryEvent(db, delivered(5 * MINUTE - 1000), NOW, quiet())).toBe('retry');
      expect(await handleDeliveryEvent(db, delivered(5 * MINUTE), NOW, quiet())).toBe('ignored');
      expect(await handleDeliveryEvent(db, delivered(6 * MINUTE), NOW, quiet())).toBe('ignored');
    });

    it('is never retried when there is nothing to wait for: an unhandled type, or no email id', async () => {
      const young = new Date(NOW.getTime() - MINUTE);
      expect(await handleDeliveryEvent(db, { type: 'email.opened', data: { email_id: 're_not_yet' }, receivedAt: young }, NOW, quiet())).toBe('ignored');
      expect(await handleDeliveryEvent(db, { type: 'email.delivered', data: {}, receivedAt: young }, NOW, quiet())).toBe('ignored');
    });

    it('an email.sent stored a minute ago with no row yet is retried; once the row commits its resend_id the next due tick sets the message id', async () => {
      const s = await seedSeller();
      const { emailId } = await sentEmail(s, { status: 'sending' });
      const resendId = `re_${randomUUID()}`;
      await t.pool.query('update email_messages set resend_id = null, sent_at = null where id = $1', [emailId]);
      const svixId = await receive('email.sent', { email_id: resendId, message_id: '<abc123@resend.example>' });

      expect(await processEmailEvents(deps().deps)).toEqual({ done: 0, ignored: 0, failed: 0 });
      expect(await webhookRow(svixId)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'retry', nextAttemptAt: new Date(NOW.getTime() + MINUTE) });
      expect((await emailRow(emailId)).messageId).toBeNull();

      await t.pool.query(`update email_messages set status = 'sent', resend_id = $2 where id = $1`, [emailId, resendId]); // the send tick's markSent lands
      expect(await processEmailEvents(deps({ now: new Date(NOW.getTime() + 30_000) }).deps)).toEqual({ done: 0, ignored: 0, failed: 0 }); // not due yet
      expect(await processEmailEvents(deps({ now: new Date(NOW.getTime() + MINUTE) }).deps)).toEqual({ done: 1, ignored: 0, failed: 0 });
      expect(await emailRow(emailId)).toMatchObject({ status: 'sent', messageId: '<abc123@resend.example>' });
      expect(await webhookRow(svixId)).toMatchObject({ status: 'done', lastError: null });
    });

    it('one that never matches backs off 1, 2 and 4 minutes, then is ignored (it is over 5 minutes old by then)', async () => {
      const svixId = await receive('email.delivered', { email_id: 're_never' });
      const tickAt = (minutes: number) => processEmailEvents(deps({ now: new Date(NOW.getTime() + minutes * MINUTE) }).deps);
      for (const [minutes, attempts] of [[0, 1], [1, 2], [3, 3]] as const) {
        expect(await tickAt(minutes)).toEqual({ done: 0, ignored: 0, failed: 0 });
        expect(await webhookRow(svixId)).toMatchObject({ status: 'pending', attempts, lastError: 'retry' });
      }
      expect(await tickAt(7)).toEqual({ done: 0, ignored: 1, failed: 0 });
      expect(await webhookRow(svixId)).toMatchObject({ status: 'ignored', attempts: 3 });
    });
  });

  describe('the tick', () => {
    it('claims only pending events that are due, oldest first, up to the batch size', async () => {
      const at = (minutesBeforeStale: number) => new Date(NOW.getTime() - STALE - minutesBeforeStale * MINUTE);
      const old = await receive('email.delivered', { email_id: 're_a' }, { receivedAt: at(3) });
      const mid = await receive('email.delivered', { email_id: 're_b' }, { receivedAt: at(2) });
      const later = await receive('email.delivered', { email_id: 're_c' }, { receivedAt: at(1) });
      const notDue = await receive('email.delivered', { email_id: 're_d' }, { nextAttemptAt: new Date(NOW.getTime() + MINUTE), receivedAt: at(4) });
      const done = await receive('email.delivered', { email_id: 're_e' }, { receivedAt: at(5) });
      await t.pool.query(`update resend_webhook_events set status = 'done' where svix_id = $1`, [done]);

      expect(await processEmailEvents(deps({ batch: 2 }).deps)).toEqual({ done: 0, ignored: 2, failed: 0 });
      expect((await webhookRow(old)).status).toBe('ignored');
      expect((await webhookRow(mid)).status).toBe('ignored');
      expect((await webhookRow(later)).status).toBe('pending');
      expect((await webhookRow(notDue)).status).toBe('pending');

      expect(await processEmailEvents(deps().deps)).toEqual({ done: 0, ignored: 1, failed: 0 });
      expect((await webhookRow(later)).status).toBe('ignored');
      expect((await webhookRow(notDue)).status).toBe('pending');
      expect(await processEmailEvents(deps().deps)).toEqual({ done: 0, ignored: 0, failed: 0 });
    });

    it('with no batch size given it still works through a normal backlog', async () => {
      for (let i = 0; i < 25; i += 1) await receive('email.delivered', { email_id: `re_${i}` }, { receivedAt: new Date(NOW.getTime() - STALE) });
      expect(await processEmailEvents(deps().deps)).toEqual({ done: 0, ignored: 25, failed: 0 });
    });

    it('skips an event another tick holds instead of waiting for it, and takes the next one', async () => {
      const held = await receive('email.delivered', { email_id: 're_held' }, { receivedAt: new Date(NOW.getTime() - STALE - 2 * MINUTE) });
      const free = await receive('email.delivered', { email_id: 're_free' }, { receivedAt: new Date(NOW.getTime() - STALE - MINUTE) });
      const holder = await t.pool.connect();
      try {
        await holder.query('begin');
        await holder.query('select 1 from resend_webhook_events where svix_id = $1 for update', [held]);
        // Without `skip locked` this tick would wait for the holder, and so would a tick queued behind a slow one.
        const outcome = await Promise.race([processEmailEvents(deps().deps), new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 1500))]);
        expect(outcome).toEqual({ done: 0, ignored: 1, failed: 0 });
      } finally {
        await holder.query('rollback');
        holder.release();
      }
      expect((await webhookRow(held)).status).toBe('pending');
      expect((await webhookRow(free)).status).toBe('ignored');
    });

    it('takes a 10-minute lease on a claimed event, so a tick that dies mid-way hands it back later and not at once', async () => {
      const svixId = await receive('email.received', { email_id: 're_in' });
      let seen: Date | null = null;
      const resend = inbox(async () => {
        seen = (await webhookRow(svixId)).nextAttemptAt;
        throw new ResendError(404);
      });
      await processEmailEvents(deps({ resend }).deps);
      expect(seen).toEqual(new Date(NOW.getTime() + 10 * MINUTE));
    });

    it('a second tick that starts while the first is still working on an event does not take it', async () => {
      const svixId = await receive('email.received', { email_id: 're_in' });
      let release!: () => void;
      let working!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (working = resolve));
      const firstResend = inbox(async () => {
        working();
        await gate;
        throw new ResendError(404);
      });
      const secondResend = inbox(async () => Promise.reject(new ResendError(404)));

      const first = processEmailEvents(deps({ resend: firstResend }).deps);
      await started; // the first tick holds the event and is inside the reply handler
      expect(await processEmailEvents(deps({ resend: secondResend, now: new Date(NOW.getTime() + MINUTE) }).deps)).toEqual({ done: 0, ignored: 0, failed: 0 });
      expect(secondResend.getReceived).not.toHaveBeenCalled();
      release();
      expect(await first).toEqual({ done: 0, ignored: 1, failed: 0 });
      expect((await webhookRow(svixId)).status).toBe('ignored');
    });

    describe('email.received goes to the reply handler (email/inbound.ts)', () => {
      it('is always claimed and handed to the reply handler, and its answer settles the row', async () => {
        const s = await seedSeller();
        const reply = autoReply(s.conv.token, 're_1');
        const doneId = await receive('email.received', { email_id: 're_1' }, { receivedAt: new Date(NOW.getTime() - 3 * MINUTE) });
        const ignoredId = await receive('email.received', { email_id: 're_2' }, { receivedAt: new Date(NOW.getTime() - 2 * MINUTE) });
        const retryId = await receive('email.received', { email_id: 're_3' }, { receivedAt: new Date(NOW.getTime() - MINUTE) });
        const resend = inbox(async (id) => {
          if (id === 're_1') return reply;
          throw new ResendError(id === 're_2' ? 404 : 503);
        });

        expect(await processEmailEvents(deps({ resend }).deps)).toEqual({ done: 1, ignored: 1, failed: 0 });

        expect(resend.getReceived.mock.calls.map((c) => c[0])).toEqual(['re_1', 're_2', 're_3']);
        expect(await webhookRow(doneId)).toMatchObject({ status: 'done' });
        expect(await webhookRow(ignoredId)).toMatchObject({ status: 'ignored' });
        // 'retry' is a try again later that is not an error: the backoff applies and the attempt is counted.
        expect(await webhookRow(retryId)).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: new Date(NOW.getTime() + MINUTE), lastError: 'retry' });
        // The reply itself landed on the seller's timeline.
        expect((await eventsOf(s.conv.id)).filter((e) => e.kind === 'email' && e.direction === 'in')).toHaveLength(1);
      });

      it('delivery events are still handled by the tick itself: Resend is never asked for them', async () => {
        const s = await seedSeller();
        const { emailId, resendId } = await sentEmail(s);
        await receive('email.delivered', { email_id: resendId });
        const resend = inbox(async () => Promise.reject(new ResendError(404)));
        expect(await processEmailEvents(deps({ resend }).deps)).toEqual({ done: 1, ignored: 0, failed: 0 });
        expect(resend.getReceived).not.toHaveBeenCalled();
        expect((await emailRow(emailId)).status).toBe('delivered');
      });
    });

    describe('when handling throws', () => {
      /** A reply the handler can read but not store: the database refuses the inbound row (a pg error, name `error`, code P0001). */
      async function unstorableReply(attempts = 0, receivedAt?: Date) {
        const s = await seedSeller();
        const reply = autoReply(s.conv.token);
        const svixId = await receive('email.received', { email_id: reply.id }, { attempts, receivedAt });
        return { svixId, resend: inbox(async () => reply) };
      }

      it('counts the attempt, backs off by 2^attempts minutes and keeps only the error NAME', async () => {
        for (const [attempts, minutes] of [[0, 1], [1, 2], [2, 4], [6, 64]] as const) {
          const { svixId, resend } = await unstorableReply(attempts);
          const { deps: d, log } = deps({ resend });
          expect(await failingWrites('email_messages', 'insert', () => processEmailEvents(d))).toEqual({ done: 0, ignored: 0, failed: 1 });
          expect(await webhookRow(svixId)).toMatchObject({
            status: 'pending',
            attempts: attempts + 1,
            lastError: 'error',
            nextAttemptAt: new Date(NOW.getTime() + minutes * MINUTE),
          });
          expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ svixId, errorName: 'error', errorCode: 'P0001' }), 'email event failed');
          expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toMatch(/delivered@resend\.dev|blocked for the test|away until/);
          await t.pool.query('delete from resend_webhook_events');
        }
      });

      it('the 8th failed attempt makes the event failed for good', async () => {
        const { svixId, resend } = await unstorableReply(7);
        expect(await failingWrites('email_messages', 'insert', () => processEmailEvents(deps({ resend }).deps))).toEqual({ done: 0, ignored: 0, failed: 1 });
        expect(await webhookRow(svixId)).toMatchObject({ status: 'failed', attempts: 8, lastError: 'error', processedAt: NOW });
        // …and a failed event is never claimed again.
        expect(await processEmailEvents(deps({ resend }).deps)).toEqual({ done: 0, ignored: 0, failed: 0 });
      });

      it('one event that throws does not stop the others in the batch', async () => {
        const { svixId: bad, resend } = await unstorableReply(0, new Date(NOW.getTime() - STALE - MINUTE));
        const good = await receive('email.delivered', { email_id: `re_${randomUUID()}` }, { receivedAt: new Date(NOW.getTime() - STALE) });
        expect(await failingWrites('email_messages', 'insert', () => processEmailEvents(deps({ resend }).deps))).toEqual({ done: 0, ignored: 1, failed: 1 });
        expect((await webhookRow(bad)).status).toBe('pending');
        expect((await webhookRow(good)).status).toBe('ignored');
      });

      it('a throw inside a delivery event leaves no half-done complaint: nothing is committed, and the retry does all of it', async () => {
        const s = await seedSeller('complained@resend.dev');
        const { emailId, resendId } = await sentEmail(s);
        const svixId = await receive('email.complained', { email_id: resendId });
        // The last database step of a complaint (the tenant pause) fails: the stop and the status change before it must not stay.
        const first = deps();
        expect(await failingWrites('organizations', 'update', () => processEmailEvents(first.deps))).toEqual({ done: 0, ignored: 0, failed: 1 });
        expect(first.alert).not.toHaveBeenCalled();
        expect((await emailRow(emailId)).status).toBe('sent');
        expect(await conversationRow(s.conv.id)).toMatchObject({ status: 'open', stopReason: null });
        expect(await suppressionFor(db, s.orgId, s.address)).toBeNull();
        expect(await webhookRow(svixId)).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: new Date(NOW.getTime() + MINUTE) });

        const retry = deps({ now: new Date(NOW.getTime() + 2 * MINUTE) });
        expect(await processEmailEvents(retry.deps)).toEqual({ done: 1, ignored: 0, failed: 0 });
        expect((await emailRow(emailId)).status).toBe('complained');
        expect((await conversationRow(s.conv.id)).status).toBe('stopped');
        expect(samEmailSettings({ settings: await settingsOf(s.orgId) }).pausedAt).not.toBeNull();
        expect(retry.alert).toHaveBeenCalledTimes(1);
      });
    });

    describe('an event that fails for good raises a job_dead_lettered alert', () => {
      const lastAttempt = { attempts: 7 };

      it('a complaint failing its 8th attempt: one critical alert carrying the event id and type only', async () => {
        const s = await seedSeller('complained@resend.dev');
        const { resendId } = await sentEmail(s);
        const svixId = await receive('email.complained', { email_id: resendId }, lastAttempt);
        const { deps: d, alert, log } = deps();

        expect(await failingWrites('organizations', 'update', () => processEmailEvents(d))).toEqual({ done: 0, ignored: 0, failed: 1 });

        expect(await webhookRow(svixId)).toMatchObject({ status: 'failed', attempts: 8 });
        expect(alert).toHaveBeenCalledTimes(1);
        const event = alert.mock.calls[0]![0];
        expect(event).toMatchObject({ kind: 'job_dead_lettered', severity: 'critical', orgId: s.orgId });
        expect(event.context).toEqual({ svixId, type: 'email.complained' });
        const everything = JSON.stringify([event, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
        for (const secret of ['complained@resend.dev', SUBJECT, BODY, 'Pat Seller']) expect(everything).not.toContain(secret);
      });

      it('any other type is a warning', async () => {
        const s = await seedSeller('bounced@resend.dev');
        const { resendId } = await sentEmail(s);
        await receive('email.bounced', { email_id: resendId }, lastAttempt);
        const { deps: d, alert } = deps();
        expect(await failingWrites('conversation_events', 'insert', () => processEmailEvents(d))).toEqual({ done: 0, ignored: 0, failed: 1 });
        expect(alert).toHaveBeenCalledTimes(1);
        expect(alert.mock.calls[0]![0]).toMatchObject({ kind: 'job_dead_lettered', severity: 'warning', orgId: s.orgId });
      });

      it('is not raised while the event still has attempts left', async () => {
        const s = await seedSeller('complained@resend.dev');
        const { resendId } = await sentEmail(s);
        const svixId = await receive('email.complained', { email_id: resendId }, { attempts: 6 });
        const { deps: d, alert } = deps();
        await failingWrites('organizations', 'update', () => processEmailEvents(d));
        expect(await webhookRow(svixId)).toMatchObject({ status: 'pending', attempts: 7 });
        expect(alert).not.toHaveBeenCalled();
      });

      it('an event that names no email of ours is logged by id and raises no alert (there is no tenant to raise it for)', async () => {
        const svixId = await receive('email.received', { email_id: 're_in' }, lastAttempt);
        // Resend never gave the reply back, so nothing of it was stored: no tenant is known.
        const resend = inbox(async () => Promise.reject(new ResendError(503)));
        const { deps: d, alert, log } = deps({ resend });
        expect(await processEmailEvents(d)).toEqual({ done: 0, ignored: 0, failed: 0 });
        expect(await webhookRow(svixId)).toMatchObject({ status: 'failed', lastError: 'retry' });
        expect(alert).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith({ svixId, type: 'email.received' }, expect.stringContaining('no alert'));
        expect(JSON.stringify(log.error.mock.calls)).not.toContain('resend.dev');
      });

      it("a seller's reply that was stored but failed its 8th attempt: one critical alert for the reply's tenant, event id and type only", async () => {
        const s = await seedSeller();
        const reply = autoReply(s.conv.token);
        const svixId = await receive('email.received', { email_id: reply.id }, lastAttempt);
        const { deps: d, alert, log } = deps({ resend: inbox(async () => reply) });
        // The reply is stored, then its handling cannot finish (handled_at cannot be written): it is retried until it is out of attempts.
        expect(await failingWrites('email_messages', 'update', () => processEmailEvents(d))).toEqual({ done: 0, ignored: 0, failed: 1 });

        expect(await webhookRow(svixId)).toMatchObject({ status: 'failed', attempts: 8 });
        expect(alert).toHaveBeenCalledTimes(1);
        const event = alert.mock.calls[0]![0];
        expect(event).toMatchObject({ kind: 'job_dead_lettered', severity: 'critical', orgId: s.orgId });
        expect(event.context).toEqual({ svixId, type: 'email.received' });
        const everything = JSON.stringify([event, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
        for (const secret of ['delivered@resend.dev', 'Out of the office', 'away until', 'Pat Seller']) expect(everything).not.toContain(secret);
      });

      it("an outbound email's Resend id never stands in for a reply's: the dead-letter lookup is by direction", async () => {
        const s = await seedSeller();
        const { resendId } = await sentEmail(s);
        const svixId = await receive('email.received', { email_id: resendId }, lastAttempt);
        const { deps: d, alert, log } = deps({ resend: inbox(async () => Promise.reject(new ResendError(503))) });
        await processEmailEvents(d);
        expect(await webhookRow(svixId)).toMatchObject({ status: 'failed' });
        expect(alert).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith({ svixId, type: 'email.received' }, expect.stringContaining('no alert'));
      });

      it('an alert that throws never fails the tick: the event is failed and the error is logged by name', async () => {
        const s = await seedSeller('complained@resend.dev');
        const { resendId } = await sentEmail(s);
        const svixId = await receive('email.complained', { email_id: resendId }, lastAttempt);
        const alert = vi.fn(async () => {
          throw new BoomError('webhook host unreachable');
        });
        const { deps: d, log } = deps({ alert });
        expect(await failingWrites('organizations', 'update', () => processEmailEvents(d))).toEqual({ done: 0, ignored: 0, failed: 1 });
        expect(alert).toHaveBeenCalledTimes(1);
        expect(await webhookRow(svixId)).toMatchObject({ status: 'failed' });
        expect(JSON.stringify(log.error.mock.calls)).not.toContain('unreachable');
        expect(JSON.stringify(log.error.mock.calls)).toContain('BoomError');
      });
    });
  });
});
