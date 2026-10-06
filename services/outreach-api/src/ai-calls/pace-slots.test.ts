/**
 * Real Postgres, Fix 1 of Plan 1D Part 3: which retries carry appointment times (I-2, against a fake cti-api that models its
 * request store's body hash), the calendar read once per tick (M-1), and times other calls booked taken out (I-4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { InternalAiCallRequest } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import { paceHarness } from '../test/fake-pace.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { STALE_REQUEST_MS } from './key-resolution.js';

/** Monday 18:00 CDT (16:00 PDT): the plan fixture's evening window for a Texas number; the owner's phone times start Tuesday. */
const NOW = new Date('2026-10-05T23:00:00.000Z');
const MIN = 60_000;
const at = (from: Date, ms: number) => new Date(from.getTime() + ms);
const OWNER = '0058X00000Fsx39QAB';
const ownerRow = { Id: OWNER, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles' };
const booking = { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [OWNER] }, aiCallWriteback: true };

type RecordTarget = Extract<InternalAiCallRequest['target'], { kind: 'record' }>;
const target = (r: InternalAiCallRequest): RecordTarget => {
  if (r.target.kind !== 'record') throw new Error('expected a record target');
  return r.target;
};
const hasSlots = (r: InternalAiCallRequest): boolean => (target(r).slots?.length ?? 0) > 0;
const triggerLogs = (logs: Array<{ obj: unknown; msg?: string }>) => logs.filter((l) => l.msg === 'ai_call.place: trigger answered').map((l) => l.obj as Record<string, unknown>);

describe.skipIf(!pgLane)('ai_call.place: appointment times on retries and across calls (Fix 1)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function ownerHarness() {
    const h = await paceHarness(db, { ...booking, aiCallConcurrency: 5 });
    h.cti.store = true;
    h.sf.state.users = [ownerRow];
    return h;
  }

  /** Ticks at each due time until the touch is sent (at most `max` ticks). */
  async function runUntilSent(h: Awaited<ReturnType<typeof ownerHarness>>, touchId: string, max = 6): Promise<void> {
    for (let i = 0; i < max; i += 1) {
      const t = await touchById(db, touchId);
      if (t.status === 'sent') return;
      await h.run(t.dueAt);
    }
    throw new Error('the touch was never sent');
  }

  describe('I-2: a kept key cti-api never stored is sent as fresh; one it stored settles through the 409', () => {
    it('(1) a transport failure before cti-api reserved the key: the retry keeps the key AND carries times', async () => {
      const h = await ownerHarness();
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ transport: 'network' });

      expect((await h.run(NOW)).retried).toBe(1);
      expect(hasSlots(h.cti.requests[0]!)).toBe(true);
      await runUntilSent(h, lead.touchId);

      const [first, retry] = h.cti.requests;
      expect(h.cti.requests).toHaveLength(2);
      expect(retry!.idempotencyKey).toBe(first!.idempotencyKey);
      expect(hasSlots(retry!)).toBe(true);
      expect(triggerLogs(h.logs).map((l) => l.conflict)).toEqual([undefined, undefined]);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('(2) cti-api stored a refusal whose answer was lost: the re-send has no times, the 409 replays the refusal, then one new key with times', async () => {
      const h = await ownerHarness();
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ lostAnswer: { result: 'blocked', reason: 'calling_hours' } });

      await h.run(NOW);
      const kept = await touchById(db, lead.touchId);
      expect(kept).toMatchObject({ status: 'planned', lastBlockReason: 'transport', triggerKey: h.cti.requests[0]!.idempotencyKey });

      await h.run(kept.dueAt);
      const resent = h.cti.requests[1]!;
      expect(resent.idempotencyKey).toBe(h.cti.requests[0]!.idempotencyKey);
      expect('slots' in target(resent)).toBe(false);
      expect(triggerLogs(h.logs).at(-1)).toMatchObject({ conflict: 'answered', result: 'retry:calling_hours' });
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', triggerKey: null, lastBlockReason: 'calling_hours' });

      await runUntilSent(h, lead.touchId);
      const keys = new Set(h.cti.requests.map((r) => r.idempotencyKey));
      expect(keys.size).toBe(2);
      expect(h.cti.requests).toHaveLength(3);
      expect(h.cti.requests[2]!.idempotencyKey).not.toBe(h.cti.requests[0]!.idempotencyKey);
      expect(hasSlots(h.cti.requests[2]!)).toBe(true);
    });

    it('(3) cti-api reserved the key and crashed with no call: waits until stale, the re-send 409s, and exactly one new key (with times) places it', async () => {
      const h = await ownerHarness();
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ reservedNoAnswer: true });

      await h.run(NOW);
      await runUntilSent(h, lead.touchId);

      const keys = h.cti.requests.map((r) => r.idempotencyKey);
      expect(new Set(keys).size).toBe(2);
      expect(keys.slice(0, 2)).toEqual([keys[0], keys[0]]);
      expect(h.cti.requests.map(hasSlots)).toEqual([true, false, true]);
      expect(triggerLogs(h.logs).map((l) => l.conflict)).toEqual([undefined, 'none', undefined]);
      // The re-send waited until cti-api would call the reservation stale (STALE_REQUEST_MS after it was made at NOW).
      expect(h.cti.sentAt[1]!.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + STALE_REQUEST_MS);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent' });
    });
  });

  it('M-1: two calls in one tick read the owner and the calendar once', async () => {
    const h = await ownerHarness();
    await seedReleasedLead(db, h.base);
    await seedReleasedLead(db, h.base);

    expect((await h.run(NOW)).placed).toBe(2);
    expect(h.cti.requests.every(hasSlots)).toBe(true);
    expect(h.sf.state.soql.filter((q) => / FROM User /.test(q))).toHaveLength(1);
    expect(h.sf.state.soql.filter((q) => /ShowAs != 'Free'/.test(q))).toHaveLength(1);
  });

  it('M-2: an owner zone Salesforce gives that cannot be used is logged once, not every tick', async () => {
    const h = await ownerHarness();
    h.sf.state.users = [{ ...ownerRow, TimeZoneSidKey: 'Mars/Olympus_Mons' }];
    await seedReleasedLead(db, h.base);
    await seedReleasedLead(db, h.base);
    await h.run(NOW);
    await seedReleasedLead(db, h.base);
    await h.run(at(NOW, MIN));
    const warned = h.logs.filter((l) => l.msg === "ai_call.place: the appointment owner's Salesforce time zone is not usable; business hours use the default zone");
    expect(warned).toEqual([{ level: 'warn', obj: { orgId: h.base.orgId, ownerSfUserId: OWNER, zone: 'Mars/Olympus_Mons', usedZone: 'America/Los_Angeles' }, msg: expect.any(String) }]);
    // Both ticks read the calendar (three calls, all with times).
    expect(h.cti.requests).toHaveLength(3);
    expect(h.sf.state.soql.filter((q) => / FROM User /.test(q))).toHaveLength(2);
    expect(h.cti.requests.every(hasSlots)).toBe(true);
  });

  describe('I-4: a time another call booked is not offered until the calendar shows it', () => {
    async function bookFirstOffer(h: Awaited<ReturnType<typeof ownerHarness>>, touchId: string) {
      const slot = target(h.cti.requests[0]!).slots![0]!;
      const aiCallId = (await touchById(db, touchId)).aiCallId!;
      // What cti-api's book_appointment stores on the call.
      const appointment = { slotId: slot.id, kind: slot.kind, start: slot.start, end: slot.end, specialistSfUserId: OWNER, addressConfirmed: true, note: '', bookedAt: NOW.toISOString() };
      await db.update(schema.aiCalls).set({ appointment }).where(eq(schema.aiCalls.id, aiCallId));
      return { slot, aiCallId };
    }

    it('two calls: the first books Tuesday 10:00; the second is not offered 10:00', async () => {
      const h = await ownerHarness();
      const a = await seedReleasedLead(db, h.base);
      expect((await h.run(NOW)).placed).toBe(1);
      const { slot } = await bookFirstOffer(h, a.touchId);
      expect(slot.start).toBe('2026-10-06T17:00:00.000Z'); // Tuesday 10:00 PDT

      await seedReleasedLead(db, h.base);
      expect((await h.run(at(NOW, MIN))).placed).toBe(1);

      const second = target(h.cti.requests[1]!).slots!;
      expect(second.map((s) => s.start)).not.toContain(slot.start);
      expect(second[0]!.start).toBe('2026-10-06T17:30:00.000Z');
    });

    it('once the write-back created the Event, the calendar is what counts (the booking is not taken out twice)', async () => {
      const h = await ownerHarness();
      const a = await seedReleasedLead(db, h.base);
      await h.run(NOW);
      const { slot, aiCallId } = await bookFirstOffer(h, a.touchId);
      const lead = await touchById(db, a.touchId);
      await db.insert(schema.aiCallWritebacks).values({
        orgId: h.base.orgId, aiCallId, touchId: a.touchId, enrollmentId: lead.enrollmentId, sfObject: 'Lead', sfRecordId: a.sfRecordId, outcome: 'appointment_set', status: 'done', sfEventId: '00U8X00000AbCdEUAZ',
      });
      // The fake calendar has no Event (as if a person moved it): nothing else holds the time.
      await seedReleasedLead(db, h.base);
      await h.run(at(NOW, MIN));
      expect(target(h.cti.requests[1]!).slots![0]!.start).toBe(slot.start);
    });
  });
});
