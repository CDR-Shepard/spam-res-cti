/**
 * Real Postgres, Fix 1 of Plan 1D Part 3: the calendar read once per tick (M-1), and times other calls booked taken out (I-4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { InternalAiCallRequest } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import { paceHarness } from '../test/fake-pace.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';

/** Monday 18:00 CDT (16:00 PDT): the plan fixture's evening window for a Texas number; the owner's phone times start Tuesday. */
const NOW = new Date('2026-10-05T23:00:00.000Z');
const MIN = 60_000;
const at = (from: Date, ms: number) => new Date(from.getTime() + ms);
const OWNER = '0058X00000Fsx39QAB';
const ownerRow = { Id: OWNER, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles' };
const booking = { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, specialists: [OWNER] } };

type RecordTarget = Extract<InternalAiCallRequest['target'], { kind: 'record' }>;
const target = (r: InternalAiCallRequest): RecordTarget => {
  if (r.target.kind !== 'record') throw new Error('expected a record target');
  return r.target;
};
const hasSlots = (r: InternalAiCallRequest): boolean => (target(r).slots?.length ?? 0) > 0;

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
    const h = await paceHarness(db, booking);
    h.sf.state.users = [ownerRow];
    return h;
  }

  it('M-1: two calls in one tick read the owner and the calendar once', async () => {
    const h = await ownerHarness();
    await seedReleasedLead(db, h.base);
    await seedReleasedLead(db, h.base);

    expect((await h.run(NOW)).placed).toBe(2);
    expect(h.cti.requests.every(hasSlots)).toBe(true);
    expect(h.sf.state.soql.filter((q) => / FROM User /.test(q))).toHaveLength(1);
    expect(h.sf.state.soql.filter((q) => /ShowAs != 'Free'/.test(q))).toHaveLength(1);
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
