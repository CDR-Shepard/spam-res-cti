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
import { handleDeliveryEvent, processEmailEvents, type EventDeps, type ReceivedOutcome, type StoredEvent } from './events.js';
import type { ResendClient } from './resend-client.js';

const NOW = new Date('2026-10-20T17:00:00.000Z');
const MINUTE = 60_000;
const APP_URL = 'https://app.example.com';
const SUBJECT = 'Re: the house on Oak Street';
const BODY = 'Thanks for getting back to me. Would Thursday afternoon work for a quick call?';
const CFG: EventDeps['cfg'] = {
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
  async function sentEmail(s: Seller, over: { conversationId?: string; status?: string; resendId?: string } = {}): Promise<{ emailId: string; resendId: string }> {
    const { emailId } = await queueEmail(db, {
      orgId: s.orgId,
      conversationId: over.conversationId ?? s.conv.id,
      to: s.address,
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
      expect(await handleDeliveryEvent(db, SENT(resendId), NOW)).toBe('done');
      expect(await handleDeliveryEvent(db, DELIVERED(resendId), NOW)).toBe('done');
      expect(await emailRow(emailId)).toMatchObject({ status: 'delivered', messageId: '<abc123@resend.example>' });
    });

    it('delivered then sent still ends delivered, and the late sent still records the message id', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s);
      expect(await handleDeliveryEvent(db, DELIVERED(resendId), NOW)).toBe('done');
      expect(await handleDeliveryEvent(db, SENT(resendId), NOW)).toBe('done');
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
      await handleDeliveryEvent(db, SENT(resendId, '<other@resend.example>'), NOW);
      expect((await emailRow(emailId)).messageId).toBe('<ours@example.com>');
      await handleDeliveryEvent(db, { type: 'email.sent', data: { email_id: resendId } }, NOW);
      await handleDeliveryEvent(db, { type: 'email.sent', data: { email_id: resendId, message_id: 42 } }, NOW);
      expect((await emailRow(emailId)).messageId).toBe('<ours@example.com>');
    });

    it('delivered only moves a row that is sending or sent: a bounced, complained or failed row stays as it is', async () => {
      const s = await seedSeller();
      for (const status of ['bounced', 'complained', 'failed']) {
        const { emailId, resendId } = await sentEmail(s, { status });
        expect(await handleDeliveryEvent(db, DELIVERED(resendId), NOW)).toBe('done');
        expect((await emailRow(emailId)).status).toBe(status);
      }
      const { emailId, resendId } = await sentEmail(s, { status: 'sending' });
      await handleDeliveryEvent(db, DELIVERED(resendId), NOW);
      expect((await emailRow(emailId)).status).toBe('delivered');
    });
  });

  describe('email.bounced', () => {
    it('marks the email bounced, suppresses the address, notes it on the timeline and leaves the conversation open', async () => {
      const s = await seedSeller('bounced@resend.dev');
      const { emailId, resendId } = await sentEmail(s);
      expect(await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW)).toBe('done');
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
      await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW);
      await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW);
      expect((await emailRow(emailId)).status).toBe('bounced');
      expect((await eventsOf(s.conv.id)).filter((e) => e.kind === 'note')).toHaveLength(1);
    });

    it('a bounce on an email already marked complained keeps complained', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s, { status: 'complained' });
      await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW);
      expect((await emailRow(emailId)).status).toBe('complained');
    });

    it("a bounce on a practice conversation's email never reaches the suppression list", async () => {
      const s = await seedSeller('bounced@resend.dev');
      const adminId = await seedUser(db, s.orgId);
      const practice = await ensureConversation(db, { orgId: s.orgId, crmRecordId: s.crmRecordId, practiceUserId: adminId });
      const { emailId, resendId } = await sentEmail(s, { conversationId: practice.id });
      await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: resendId } }, NOW);
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
      const { resendId } = await sentEmail(s, { conversationId: practice.id });
      const { alert } = deps();
      await handleDeliveryEvent(db, complaint(resendId), NOW, notifyWith(alert));
      expect((await conversationRow(practice.id)).status).toBe('stopped');
      expect((await conversationRow(s.conv.id)).status).toBe('open');
      expect(await suppressionFor(db, s.orgId, s.address)).toBeNull();
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
      expect(await handleDeliveryEvent(db, { type, data: { email_id: resendId } }, NOW)).toBe('done');
      expect(await emailRow(emailId)).toMatchObject({ status: 'failed', lastError: type });
    });

    it('does not overwrite a delivered email', async () => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s, { status: 'delivered' });
      await handleDeliveryEvent(db, { type: 'email.failed', data: { email_id: resendId } }, NOW);
      expect(await emailRow(emailId)).toMatchObject({ status: 'delivered', lastError: null });
    });
  });

  describe('what is ignored', () => {
    it('an event for an email id that is not ours is ignored', async () => {
      expect(await handleDeliveryEvent(db, { type: 'email.delivered', data: { email_id: `re_${randomUUID()}` } }, NOW)).toBe('ignored');
    });

    it('only OUR outbound email matches: an inbound row with that Resend id does not', async () => {
      const s = await seedSeller();
      const { emailId } = await sentEmail(s);
      await t.pool.query(`update email_messages set direction = 'in', status = 'received', resend_id = 're_inbound' where id = $1`, [emailId]);
      expect(await handleDeliveryEvent(db, { type: 'email.bounced', data: { email_id: 're_inbound' } }, NOW)).toBe('ignored');
      expect(await suppressionFor(db, s.orgId, s.address)).toBeNull();
    });

    it.each([
      ['no data', undefined],
      ['no email_id', {}],
      ['a non-string email_id', { email_id: 7 }],
      ['a blank email_id', { email_id: '' }],
      ['data that is not an object', 'nope'],
    ])('an event with %s is ignored', async (_name, data) => {
      expect(await handleDeliveryEvent(db, { type: 'email.delivered', data }, NOW)).toBe('ignored');
    });

    it.each(['email.opened', 'email.clicked', 'email.delivery_delayed', 'contact.created', 'domain.updated', ''])('the type %j is ignored', async (type) => {
      const s = await seedSeller();
      const { emailId, resendId } = await sentEmail(s);
      expect(await handleDeliveryEvent(db, { type, data: { email_id: resendId } }, NOW)).toBe('ignored');
      expect((await emailRow(emailId)).status).toBe('sent');
    });

    it('the tick marks an unmatched event ignored and counts it', async () => {
      const svixId = await receive('email.delivered', { email_id: `re_${randomUUID()}` });
      expect(await processEmailEvents(deps().deps)).toEqual({ done: 0, ignored: 1, failed: 0 });
      expect(await webhookRow(svixId)).toMatchObject({ status: 'ignored', processedAt: NOW });
    });
  });

  describe('the tick', () => {
    it('claims only pending events that are due, oldest first, up to the batch size', async () => {
      const old = await receive('email.delivered', { email_id: 're_a' }, { receivedAt: new Date(NOW.getTime() - 3 * MINUTE) });
      const mid = await receive('email.delivered', { email_id: 're_b' }, { receivedAt: new Date(NOW.getTime() - 2 * MINUTE) });
      const later = await receive('email.delivered', { email_id: 're_c' }, { receivedAt: new Date(NOW.getTime() - MINUTE) });
      const notDue = await receive('email.delivered', { email_id: 're_d' }, { nextAttemptAt: new Date(NOW.getTime() + MINUTE), receivedAt: new Date(NOW.getTime() - 4 * MINUTE) });
      const done = await receive('email.delivered', { email_id: 're_e' }, { receivedAt: new Date(NOW.getTime() - 5 * MINUTE) });
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
      for (let i = 0; i < 25; i += 1) await receive('email.delivered', { email_id: `re_${i}` });
      expect(await processEmailEvents(deps().deps)).toEqual({ done: 0, ignored: 25, failed: 0 });
    });

    it('takes a 10-minute lease on a claimed event, so a tick that dies mid-way hands it back later and not at once', async () => {
      const svixId = await receive('email.received', { email_id: 're_in' });
      let seen: Date | null = null;
      const onReceived = vi.fn(async () => {
        seen = (await webhookRow(svixId)).nextAttemptAt;
        return 'done' as const;
      });
      await processEmailEvents(deps({ onReceived }).deps);
      expect(seen).toEqual(new Date(NOW.getTime() + 10 * MINUTE));
    });

    it('a second tick that starts while the first is still working on an event does not take it', async () => {
      const svixId = await receive('email.received', { email_id: 're_in' });
      let release!: () => void;
      let working!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (working = resolve));
      const firstHandler = vi.fn(async () => {
        working();
        await gate;
        return 'done' as const;
      });
      const secondHandler = vi.fn(async () => 'done' as const);

      const first = processEmailEvents(deps({ onReceived: firstHandler }).deps);
      await started; // the first tick holds the event and is inside its handler
      expect(await processEmailEvents(deps({ onReceived: secondHandler, now: new Date(NOW.getTime() + MINUTE) }).deps)).toEqual({ done: 0, ignored: 0, failed: 0 });
      expect(secondHandler).not.toHaveBeenCalled();
      release();
      expect(await first).toEqual({ done: 1, ignored: 0, failed: 0 });
      expect((await webhookRow(svixId)).status).toBe('done');
    });

    describe('email.received (Task 9 owns the handler)', () => {
      it('is NOT claimed while no handler is wired: the row stays pending and untouched', async () => {
        const svixId = await receive('email.received', { email_id: 're_in' });
        const before = await webhookRow(svixId);
        expect(await processEmailEvents(deps().deps)).toEqual({ done: 0, ignored: 0, failed: 0 });
        expect(await webhookRow(svixId)).toEqual(before);
      });

      it('is handed to the handler once one is wired, and its answer settles the row', async () => {
        const doneId = await receive('email.received', { email_id: 're_1' }, { receivedAt: new Date(NOW.getTime() - 3 * MINUTE) });
        const ignoredId = await receive('email.received', { email_id: 're_2' }, { receivedAt: new Date(NOW.getTime() - 2 * MINUTE) });
        const retryId = await receive('email.received', { email_id: 're_3' }, { receivedAt: new Date(NOW.getTime() - MINUTE) });
        const answers: Record<string, ReceivedOutcome> = { re_1: 'done', re_2: 'ignored', re_3: 'retry' };
        const onReceived = vi.fn(async (ev: StoredEvent, _now: Date) => answers[(ev.data as { email_id: string }).email_id]!);

        expect(await processEmailEvents(deps({ onReceived }).deps)).toEqual({ done: 1, ignored: 1, failed: 0 });

        expect(onReceived).toHaveBeenCalledTimes(3);
        expect(onReceived.mock.calls[0]![0]).toEqual({ type: 'email.received', data: { email_id: 're_1' } });
        expect(onReceived.mock.calls[0]![1]).toEqual(NOW);
        expect(await webhookRow(doneId)).toMatchObject({ status: 'done' });
        expect(await webhookRow(ignoredId)).toMatchObject({ status: 'ignored' });
        // 'retry' is a try again later that is not an error: the backoff applies and the attempt is counted.
        expect(await webhookRow(retryId)).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: new Date(NOW.getTime() + MINUTE), lastError: 'retry' });
      });

      it('delivery events are still handled by the tick itself when a handler is wired', async () => {
        const s = await seedSeller();
        const { emailId, resendId } = await sentEmail(s);
        await receive('email.delivered', { email_id: resendId });
        const onReceived = vi.fn(async () => 'done' as const);
        expect(await processEmailEvents(deps({ onReceived }).deps)).toEqual({ done: 1, ignored: 0, failed: 0 });
        expect(onReceived).not.toHaveBeenCalled();
        expect((await emailRow(emailId)).status).toBe('delivered');
      });
    });

    describe('when handling throws', () => {
      const failing = () => vi.fn(async (): Promise<'done'> => {
        throw new BoomError('boom for delivered@resend.dev');
      });

      it('counts the attempt, backs off by 2^attempts minutes and keeps only the error NAME', async () => {
        for (const [attempts, minutes] of [[0, 1], [1, 2], [2, 4], [6, 64]] as const) {
          const svixId = await receive('email.received', { email_id: 're_in' }, { attempts });
          const { deps: d, log } = deps({ onReceived: failing() });
          expect(await processEmailEvents(d)).toEqual({ done: 0, ignored: 0, failed: 1 });
          expect(await webhookRow(svixId)).toMatchObject({
            status: 'pending',
            attempts: attempts + 1,
            lastError: 'BoomError',
            nextAttemptAt: new Date(NOW.getTime() + minutes * MINUTE),
          });
          expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain('delivered@resend.dev');
          await t.pool.query('delete from resend_webhook_events');
        }
      });

      it('the 8th failed attempt makes the event failed for good', async () => {
        const svixId = await receive('email.received', { email_id: 're_in' }, { attempts: 7 });
        expect(await processEmailEvents(deps({ onReceived: failing() }).deps)).toEqual({ done: 0, ignored: 0, failed: 1 });
        expect(await webhookRow(svixId)).toMatchObject({ status: 'failed', attempts: 8, lastError: 'BoomError', processedAt: NOW });
        // …and a failed event is never claimed again.
        expect(await processEmailEvents(deps({ onReceived: failing() }).deps)).toEqual({ done: 0, ignored: 0, failed: 0 });
      });

      it('one event that throws does not stop the others in the batch', async () => {
        const bad = await receive('email.received', { email_id: 're_bad' }, { receivedAt: new Date(NOW.getTime() - 2 * MINUTE) });
        const good = await receive('email.delivered', { email_id: `re_${randomUUID()}` }, { receivedAt: new Date(NOW.getTime() - MINUTE) });
        expect(await processEmailEvents(deps({ onReceived: failing() }).deps)).toEqual({ done: 0, ignored: 1, failed: 1 });
        expect((await webhookRow(bad)).status).toBe('pending');
        expect((await webhookRow(good)).status).toBe('ignored');
      });

      it('a throw inside a delivery event leaves no half-done complaint: nothing is committed, and the retry does all of it', async () => {
        const s = await seedSeller('complained@resend.dev');
        const { emailId, resendId } = await sentEmail(s);
        const svixId = await receive('email.complained', { email_id: resendId });
        // The last database step of a complaint (the tenant pause) fails: the stop and the status change before it must not stay.
        await t.pool.query(`create or replace function test_block_org_update() returns trigger language plpgsql as $$ begin raise exception 'blocked for the test'; end $$`);
        await t.pool.query(`create trigger test_block_org_update before update on organizations for each row execute function test_block_org_update()`);
        const first = deps();
        try {
          expect(await processEmailEvents(first.deps)).toEqual({ done: 0, ignored: 0, failed: 1 });
        } finally {
          await t.pool.query('drop trigger test_block_org_update on organizations');
        }
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
  });
});
