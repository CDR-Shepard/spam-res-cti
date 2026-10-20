/**
 * Real Postgres, Task 14: the seller's conversation rides on a call's trigger exactly when the trigger is sent as fresh (the
 * same condition that adds appointment times, CF-13), with or without a booking offer; a kept key whose request cti-api stored
 * is re-sent with the same body shape (no history, no slots, no priority offer) so it settles through the 409. Reading the
 * history never blocks a call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InternalAiCallRequest } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { appendEvent, ensureConversation } from '../conversations/store.js';
import { readTimeline } from '../conversations/timeline.js';
import { seedAiCall, seedReleasedLead, touchById, type ReleasedLead } from '../test/ai-call-seed.js';
import { fakeMaps, GRANT, SD_LEAD_ADDRESS, USERS } from '../test/fake-offer.js';
import { paceHarness } from '../test/fake-pace.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';

// Calls through to the real read; one test makes it fail.
vi.mock('../conversations/timeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conversations/timeline.js')>();
  return { ...actual, readTimeline: vi.fn(actual.readTimeline) };
});

/** Monday 18:00 CDT (16:00 PDT): the plan fixture's evening window for a Texas number; the region's times start Tuesday. */
const NOW = new Date('2026-10-05T23:00:00.000Z');
const EMAIL_AT = new Date('2026-10-02T15:00:00.000Z');
const CALL_AT = new Date('2026-10-03T16:00:00.000Z');
const booking = { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [GRANT] }, aiCallWriteback: true };
/** What the digest writes for the seeded email (digest.ts: date, who, the quoted subject, the body). */
const EMAIL_LINE = '2026-10-02 Email from Sam — "Your house": Hello there.';
const REPLY_TEXT = 'PRIVATE-REPLY-TEXT call me after five';

type RecordTarget = Extract<InternalAiCallRequest['target'], { kind: 'record' }>;
const target = (r: InternalAiCallRequest): RecordTarget => {
  if (r.target.kind !== 'record') throw new Error('expected a record target');
  return r.target;
};
const hasSlots = (r: InternalAiCallRequest): boolean => (target(r).slots?.length ?? 0) > 0;

describe.skipIf(!pgLane)('ai_call.place: the seller\'s conversation rides on the call (Task 14)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  type Harness = Awaited<ReturnType<typeof paceHarness>>;

  /** The default harness: no booking offer, so a call carries no slots. */
  const plainHarness = (): Promise<Harness> => paceHarness(db);

  /** Booking on, the region's reps and Grant active, a made-up San Diego property on the record, and Google answering. */
  async function routedHarness(): Promise<Harness> {
    const h = await paceHarness(db, { ...booking, aiCallConcurrency: 5 }, { maps: fakeMaps().maps });
    h.cti.store = true;
    h.sf.state.users = [...USERS];
    h.sf.state.recordFields = { ...SD_LEAD_ADDRESS };
    return h;
  }

  /** An email on the seller's real conversation: the event and its email_messages row. */
  async function addEmail(
    lead: ReleasedLead,
    o: { direction?: 'in' | 'out'; subject?: string; body?: string; occurredAt?: Date } = {},
  ): Promise<void> {
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    const direction = o.direction ?? 'out';
    const eventId = await appendEvent(db, {
      orgId: lead.orgId,
      conversationId: conv.id,
      kind: 'email',
      direction,
      actor: direction === 'out' ? 'sam' : 'seller',
      occurredAt: o.occurredAt ?? EMAIL_AT,
      subject: o.subject ?? 'Your house',
      body: o.body ?? 'Hello there.',
      sfLog: false,
    });
    await db.insert(schema.emailMessages).values({
      orgId: lead.orgId,
      conversationId: conv.id,
      eventId,
      direction,
      status: direction === 'out' ? 'sent' : 'received',
      purpose: direction === 'out' ? 'first' : 'inbound',
      toAddress: 'seller@example.com',
      fromAddress: 'sam@example.com',
    });
  }

  /** An earlier real call to the seller: a sent touch (seq 2) carrying a completed call. */
  async function addEarlierCall(lead: ReleasedLead, summary: string): Promise<void> {
    const aiCallId = await seedAiCall(db, lead.orgId, lead.approver, { status: 'completed', outcome: 'voicemail', summary, startedAt: CALL_AT });
    await db.insert(schema.touches).values({ orgId: lead.orgId, enrollmentId: lead.enrollmentId, seq: 2, channel: 'ai_call', status: 'sent', dueAt: CALL_AT, aiCallId });
  }

  /** Ticks at each due time until the touch is sent (at most `max` ticks). */
  async function runUntilSent(h: Harness, touchId: string, max = 6): Promise<void> {
    for (let i = 0; i < max; i += 1) {
      const t = await touchById(db, touchId);
      if (t.status === 'sent') return;
      await h.run(t.dueAt);
    }
    throw new Error('the touch was never sent');
  }

  it('a fresh send with no booking offer still carries the history of a record that has one sent email', async () => {
    const h = await plainHarness();
    const lead = await seedReleasedLead(db, h.base);
    await addEmail(lead);

    expect((await h.run(NOW)).placed).toBe(1);

    expect(h.cti.requests).toHaveLength(1);
    const t = target(h.cti.requests[0]!);
    expect(t.history).toBe(EMAIL_LINE);
    expect('slots' in t).toBe(false);
  });

  it('a fresh send with an offer carries both the times and the history; the history is what the timeline says, oldest first', async () => {
    const h = await routedHarness();
    const lead = await seedReleasedLead(db, h.base);
    await addEmail(lead);
    await addEarlierCall(lead, 'Left a voicemail about the house.');
    await addEmail(lead, { direction: 'in', subject: 'Re: Your house', body: REPLY_TEXT, occurredAt: new Date('2026-10-04T15:00:00.000Z') });

    expect((await h.run(NOW)).placed).toBe(1);

    const t = target(h.cti.requests[0]!);
    expect(hasSlots(h.cti.requests[0]!)).toBe(true);
    expect(t.history?.split('\n')).toEqual([
      EMAIL_LINE,
      '2026-10-03 Call — Voicemail. Left a voicemail about the house.',
      `2026-10-04 Email from the seller — "Re: Your house": ${REPLY_TEXT}`,
    ]);
  });

  it('a record with nothing in its timeline sends no history key at all', async () => {
    const h = await plainHarness();
    await seedReleasedLead(db, h.base);

    await h.run(NOW);

    expect('history' in target(h.cti.requests[0]!)).toBe(false);
  });

  it('only the seller\'s own record counts: another seller\'s email is not in this call\'s history', async () => {
    const h = await plainHarness();
    const lead = await seedReleasedLead(db, h.base);
    const other = await seedReleasedLead(db, h.base);
    await addEmail(other, { subject: 'Someone else', body: 'Not for this call.' });

    await h.run(NOW);

    const mine = h.cti.requests.find((r) => target(r).recordId === lead.sfRecordId)!;
    expect('history' in target(mine)).toBe(false);
    const theirs = h.cti.requests.find((r) => target(r).recordId === other.sfRecordId)!;
    expect(target(theirs).history).toContain('Someone else');
  });

  it('a practice conversation of an admin is not the seller\'s history', async () => {
    const h = await plainHarness();
    const lead = await seedReleasedLead(db, h.base);
    const practice = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, practiceUserId: lead.approver });
    const eventId = await appendEvent(db, {
      orgId: lead.orgId, conversationId: practice.id, kind: 'email', direction: 'out', actor: 'sam', occurredAt: EMAIL_AT,
      subject: 'Practice', body: 'Only the admin saw this.', sfLog: false,
    });
    await db.insert(schema.emailMessages).values({
      orgId: lead.orgId, conversationId: practice.id, eventId, direction: 'out', status: 'sent', purpose: 'practice', toAddress: 'admin@example.com', fromAddress: 'sam@example.com',
    });

    await h.run(NOW);

    expect('history' in target(h.cti.requests[0]!)).toBe(false);
  });

  describe('CF-13: a kept key cti-api stored is re-sent with the same body shape', () => {
    it('a kept, stored re-send has neither times nor history; the 409 settles it and the next key carries both again', async () => {
      const h = await routedHarness();
      const lead = await seedReleasedLead(db, h.base);
      await addEmail(lead);
      h.cti.answers.push({ lostAnswer: { result: 'blocked', reason: 'calling_hours' } });

      await h.run(NOW);
      const first = target(h.cti.requests[0]!);
      expect(first.history).toBe(EMAIL_LINE);
      expect(hasSlots(h.cti.requests[0]!)).toBe(true);
      expect(first.priority).toBeDefined();
      const kept = await touchById(db, lead.touchId);
      expect(kept).toMatchObject({ status: 'planned', lastBlockReason: 'transport', triggerKey: h.cti.requests[0]!.idempotencyKey });

      await h.run(kept.dueAt);
      const resent = target(h.cti.requests[1]!);
      expect(h.cti.requests[1]!.idempotencyKey).toBe(h.cti.requests[0]!.idempotencyKey);
      expect('slots' in resent).toBe(false);
      expect('priority' in resent).toBe(false);
      expect('history' in resent).toBe(false);

      await runUntilSent(h, lead.touchId);
      const fresh = h.cti.requests.at(-1)!;
      expect(fresh.idempotencyKey).not.toBe(h.cti.requests[0]!.idempotencyKey);
      expect(target(fresh).history).toBe(EMAIL_LINE);
      expect(hasSlots(fresh)).toBe(true);
    });

    it('a kept key cti-api never stored is sent as fresh: the retry carries the history again', async () => {
      const h = await plainHarness();
      const lead = await seedReleasedLead(db, h.base);
      await addEmail(lead);
      h.cti.answers.push({ transport: 'network' });

      expect((await h.run(NOW)).retried).toBe(1);
      await runUntilSent(h, lead.touchId);

      expect(h.cti.requests).toHaveLength(2);
      expect(h.cti.requests[1]!.idempotencyKey).toBe(h.cti.requests[0]!.idempotencyKey);
      expect(target(h.cti.requests[0]!).history).toBe(EMAIL_LINE);
      expect(target(h.cti.requests[1]!).history).toBe(EMAIL_LINE);
    });
  });

  describe('reading the history never blocks a call', () => {
    it('a timeline read that throws: the call is placed without history, and the log names the error and the ids, never the seller\'s text', async () => {
      const h = await plainHarness();
      const lead = await seedReleasedLead(db, h.base);
      await addEmail(lead, { body: REPLY_TEXT });
      vi.mocked(readTimeline).mockRejectedValueOnce(new TypeError(`could not read ${REPLY_TEXT}`));

      expect((await h.run(NOW)).placed).toBe(1);

      expect('history' in target(h.cti.requests[0]!)).toBe(false);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent' });
      const warned = h.logs.filter((l) => l.msg === 'ai_call.place: the seller\'s history could not be read; the call goes without it');
      expect(warned).toEqual([{ level: 'warn', obj: { orgId: h.base.orgId, touchId: lead.touchId, errName: 'TypeError' }, msg: expect.any(String) }]);
      expect(JSON.stringify(h.logs)).not.toContain(REPLY_TEXT);
      expect(JSON.stringify(h.logs)).not.toContain('Hello there');
    });

    it('the next call reads the history again (one failure is not remembered)', async () => {
      const h = await plainHarness();
      const lead = await seedReleasedLead(db, h.base);
      await addEmail(lead);
      vi.mocked(readTimeline).mockRejectedValueOnce(new Error('transient'));
      h.cti.answers.push({ result: 'blocked', reason: 'calling_hours' });

      await h.run(NOW);
      await runUntilSent(h, lead.touchId);

      expect('history' in target(h.cti.requests[0]!)).toBe(false);
      expect(target(h.cti.requests.at(-1)!).history).toBe(EMAIL_LINE);
    });
  });
});
