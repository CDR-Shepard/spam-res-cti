/** Real Postgres: one seller's timeline merges the conversation's events with the AI calls reached through its touches. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { seedAiCall, seedReleasedLead, type ReleasedLead } from '../test/ai-call-seed.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { appendEvent, ensureConversation, type ConversationEventInput } from './store.js';
import { TimelineItem } from '@cti/contracts';
import { historyDigest } from './digest.js';
import { forPage, readTimeline } from './timeline.js';

const T0 = new Date('2026-10-19T15:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe.skipIf(!pgLane)('readTimeline (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  /** A fresh tenant with one AI-call lead (a record, an enrollment and a sent touch) so tests never see each other's rows. */
  async function seedSeller(): Promise<ReleasedLead> {
    const base = await seedAiCallCampaign(db, 'active');
    return seedReleasedLead(db, base);
  }

  /** The call a touch of the lead placed. The lead's own first touch carries it unless `seq` asks for another touch. */
  async function placeCall(lead: ReleasedLead, over: Partial<typeof schema.aiCalls.$inferInsert> = {}, seq = 1): Promise<string> {
    const aiCallId = await seedAiCall(db, lead.orgId, lead.approver, { status: 'completed', outcome: 'voicemail', startedAt: at(10), ...over });
    if (seq === 1) {
      await db.update(schema.touches).set({ status: 'sent', aiCallId }).where(eq(schema.touches.id, lead.touchId));
    } else {
      await db.insert(schema.touches).values({ orgId: lead.orgId, enrollmentId: lead.enrollmentId, seq, channel: 'ai_call', status: 'sent', dueAt: T0, aiCallId });
    }
    return aiCallId;
  }

  /** An email on the conversation's timeline: the event and its email_messages row. Returns the event id. */
  async function addEmail(
    conv: { id: string; orgId: string },
    o: {
      direction?: 'in' | 'out';
      actor?: ConversationEventInput['actor'];
      status?: (typeof schema.EMAIL_STATUSES)[number];
      subject?: string | null;
      body?: string | null;
      lastError?: string | null;
      meta?: Record<string, unknown>;
      occurredAt?: Date;
    } = {},
  ): Promise<string> {
    const direction = o.direction ?? 'out';
    const eventId = await appendEvent(db, {
      orgId: conv.orgId,
      conversationId: conv.id,
      kind: 'email',
      direction,
      actor: o.actor ?? (direction === 'out' ? 'sam' : 'seller'),
      occurredAt: o.occurredAt ?? at(5),
      subject: o.subject === undefined ? 'Your house' : o.subject,
      body: o.body === undefined ? 'Hello there.' : o.body,
      meta: o.meta,
      sfLog: false,
    });
    await db.insert(schema.emailMessages).values({
      orgId: conv.orgId,
      conversationId: conv.id,
      eventId,
      direction,
      status: o.status ?? (direction === 'out' ? 'sent' : 'received'),
      purpose: direction === 'out' ? 'first' : 'inbound',
      toAddress: 'seller@example.com',
      fromAddress: 'sam@example.com',
      lastError: o.lastError ?? null,
    });
    return eventId;
  }

  it('returns a sent email and a completed AI call in time order, oldest first', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    const callId = await placeCall(lead, { startedAt: at(10), outcome: 'qualified_callback', summary: 'Wants a callback.', durationSeconds: 73, transcript: [{ role: 'agent', text: 'Hi', at: '2026-10-19T15:10:00Z' }] });
    const emailId = await addEmail(conv, { occurredAt: at(5), subject: 'Your house', body: 'Hello there.' });

    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });

    expect(items).toEqual([
      {
        type: 'email',
        id: emailId,
        at: at(5).toISOString(),
        direction: 'out',
        actor: 'sam',
        subject: 'Your house',
        body: 'Hello there.',
        status: 'sent',
        autoReply: false,
        notSentReason: null,
      },
      {
        type: 'call',
        id: callId,
        at: at(10).toISOString(),
        outcome: 'qualified_callback',
        summary: 'Wants a callback.',
        durationSeconds: 73,
        transcriptAvailable: true,
      },
    ]);
  });

  it('puts a call before an email that came later', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    await placeCall(lead, { startedAt: at(1) });
    await addEmail(conv, { occurredAt: at(30) });
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });
    expect(items.map((i) => i.type)).toEqual(['call', 'email']);
  });

  it('leaves a test AI call out', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    await placeCall(lead, { isTest: true });
    expect(await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id })).toEqual([]);
  });

  it('shows a canceled outbound email with its notSentReason, and a failed one without', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    await addEmail(conv, { occurredAt: at(1), status: 'canceled', lastError: 'suppressed' });
    await addEmail(conv, { occurredAt: at(2), status: 'failed', lastError: 'resend 500' });
    await addEmail(conv, { occurredAt: at(3), status: 'canceled', lastError: 'a reason the contract does not know' });
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });
    expect(items).toMatchObject([
      { type: 'email', status: 'canceled', notSentReason: 'suppressed' },
      { type: 'email', status: 'failed', notSentReason: null },
      { type: 'email', status: 'canceled', notSentReason: null },
    ]);
  });

  it('marks an auto-reply from meta.autoReply, and an inbound email as received', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    await addEmail(conv, { occurredAt: at(1), direction: 'in', subject: 'Out of office', meta: { autoReply: true } });
    await addEmail(conv, { occurredAt: at(2), direction: 'in', meta: { autoReply: 'yes' } });
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });
    expect(items).toMatchObject([
      { type: 'email', direction: 'in', actor: 'seller', status: 'received', autoReply: true },
      { type: 'email', direction: 'in', actor: 'seller', status: 'received', autoReply: false },
    ]);
  });

  it('marks an email from another address (meta.otherSender) for the server only: the page items drop the key (M8)', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    const other = await addEmail(conv, { occurredAt: at(1), direction: 'in', meta: { autoReply: false, otherSender: true } });
    const own = await addEmail(conv, { occurredAt: at(2), direction: 'in', meta: { autoReply: false } });
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });
    expect(items).toEqual([
      expect.objectContaining({ id: other, type: 'email', actor: 'seller', otherSender: true }),
      expect.objectContaining({ id: own, type: 'email', actor: 'seller' }),
    ]);
    expect(items[1]).not.toHaveProperty('otherSender');
    const page = forPage(items);
    expect(page.map((i) => i.id)).toEqual([other, own]);
    for (const item of page) expect(item).not.toHaveProperty('otherSender');
    expect(page.map((i) => TimelineItem.parse(i))).toEqual(page);
    // The history digest leaves the other address's email out.
    expect(historyDigest(items, 1000)).toBe('2026-10-19 Email from the seller — "Your house": Hello there.');
  });

  it('reads a null subject or body of an email, and a null detail of a note, as an empty string', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    await addEmail(conv, { occurredAt: at(1), subject: null, body: null });
    await appendEvent(db, { orgId: lead.orgId, conversationId: conv.id, kind: 'flag', direction: 'none', actor: 'system', occurredAt: at(2), detail: null, sfLog: false });
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });
    expect(items).toMatchObject([
      { type: 'email', subject: '', body: '' },
      { type: 'note', kind: 'flag', detail: '' },
    ]);
  });

  it('shows hand-overs, status changes and flags as notes, named by the person who did them', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    const named = await seedUser(db, lead.orgId, { displayName: 'Pat Rivera' });
    const unnamed = await seedUser(db, lead.orgId);
    const [unnamedRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, unnamed));
    await appendEvent(db, { orgId: lead.orgId, conversationId: conv.id, kind: 'handler', direction: 'none', actor: 'person', userId: named, occurredAt: at(1), detail: 'taken_over', sfLog: false });
    await appendEvent(db, { orgId: lead.orgId, conversationId: conv.id, kind: 'handler', direction: 'none', actor: 'person', userId: unnamed, occurredAt: at(2), detail: 'given_back', sfLog: false });
    await appendEvent(db, { orgId: lead.orgId, conversationId: conv.id, kind: 'status', direction: 'none', actor: 'system', occurredAt: at(3), detail: 'booked', sfLog: false });
    await appendEvent(db, { orgId: lead.orgId, conversationId: conv.id, kind: 'flag', direction: 'none', actor: 'system', occurredAt: at(4), detail: 'unsure', sfLog: false });
    // Kinds with no timeline shape yet (texts, human touches, free notes) are not listed.
    await appendEvent(db, { orgId: lead.orgId, conversationId: conv.id, kind: 'text', direction: 'in', actor: 'seller', occurredAt: at(5), body: 'hi', sfLog: false });

    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });
    expect(items).toMatchObject([
      { type: 'note', kind: 'handler', detail: 'taken_over', byName: 'Pat Rivera' },
      { type: 'note', kind: 'handler', detail: 'given_back', byName: unnamedRow!.email.split('@')[0] },
      { type: 'note', kind: 'status', detail: 'booked', byName: null },
      { type: 'note', kind: 'flag', detail: 'unsure', byName: null },
    ]);
  });

  it('reports transcriptAvailable only for a call with a transcript, and keeps a call with no outcome, summary or duration', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    await placeCall(lead, { status: 'in_progress', outcome: null, summary: null, durationSeconds: null, startedAt: at(1) });
    await placeCall(lead, { startedAt: at(2), transcript: [{ role: 'caller', text: 'hello', at: '2026-10-19T15:02:00Z' }] }, 2);
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });
    expect(items).toMatchObject([
      { type: 'call', outcome: null, summary: null, durationSeconds: null, transcriptAvailable: false },
      { type: 'call', outcome: 'voicemail', transcriptAvailable: true },
    ]);
  });

  it('adds the calls of every touch of the record, without a duplicate, and falls back to created_at when a call never started', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    const first = await placeCall(lead, { startedAt: at(1) });
    const second = await placeCall(lead, { startedAt: null }, 2);
    // A second touch that points at the same call must not list it twice.
    await db.insert(schema.touches).values({ orgId: lead.orgId, enrollmentId: lead.enrollmentId, seq: 3, channel: 'ai_call', status: 'sent', dueAt: T0, aiCallId: first });
    await db.execute(sql`update ai_calls set created_at = ${at(20).toISOString()}::timestamptz where id = ${second}::uuid`);
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id });
    expect(items.map((i) => [i.type, i.id, i.at])).toEqual([
      ['call', first, at(1).toISOString()],
      ['call', second, at(20).toISOString()],
    ]);
  });

  it('shows the calls of a seller who has no conversation yet', async () => {
    const lead = await seedSeller();
    const callId = await placeCall(lead);
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: null });
    expect(items).toMatchObject([{ type: 'call', id: callId }]);
  });

  it('gives a practice conversation its own events and no calls', async () => {
    const lead = await seedSeller();
    const admin = await seedUser(db, lead.orgId);
    const real = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    const practice = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, practiceUserId: admin });
    await placeCall(lead);
    await addEmail(real, { subject: 'Real thread' });
    await addEmail(practice, { subject: 'Practice thread' });
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: practice.id });
    expect(items).toMatchObject([{ type: 'email', subject: 'Practice thread' }]);
    const realItems = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: real.id });
    expect(realItems.map((i) => i.type)).toEqual(['email', 'call']);
  });

  it("never shows another record's or another tenant's rows", async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    const other = await seedSeller();
    const otherConv = await ensureConversation(db, { orgId: other.orgId, crmRecordId: other.crmRecordId });
    await placeCall(other);
    await addEmail(otherConv, { subject: 'Someone else' });
    expect(await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id })).toEqual([]);
    // A conversation id of another tenant reads nothing, even when the caller names it.
    expect(await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: otherConv.id })).toEqual([]);
  });

  it('keeps the newest `limit` items, still oldest first', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    for (let i = 1; i <= 5; i += 1) await addEmail(conv, { occurredAt: at(i), subject: `Mail ${i}` });
    const callId = await placeCall(lead, { startedAt: at(3) });
    const items = await readTimeline(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: conv.id, limit: 4 });
    expect(items.map((i) => (i.type === 'email' ? i.subject : i.id))).toEqual(['Mail 3', callId, 'Mail 4', 'Mail 5']);
  });
});
