/**
 * Real Postgres, the routed offer on real calls: which retries carry appointment times (I-2, against a fake cti-api that
 * models its request store's body hash), the reps' calendars and the Opportunity describe read once per tick (M-1), times
 * other calls booked taken out (I-4), and what the trigger carries: routed times, the high-priority offer and the seller's
 * consultations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AppointmentSlots, type InternalAiCallRequest } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { seedReleasedLead, selectLead, touchById } from '../test/ai-call-seed.js';
import { BLAKE, CHANCE, fakeMaps, GRANT, SD_LEAD_ADDRESS, SETH, THOMAS, USERS, usersWithInactive } from '../test/fake-offer.js';
import { paceHarness, type LogEntry } from '../test/fake-pace.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { STALE_REQUEST_MS } from './key-resolution.js';

type Row = Record<string, unknown>;

/** Monday 16:00 PDT (18:00 CDT): the plan fixture's evening window for a Texas number; the region's times start Tuesday. */
const NOW = new Date('2026-10-05T23:00:00.000Z');
const MIN = 60_000;
const at = (from: Date, ms: number) => new Date(from.getTime() + ms);
const SD_REPS = [SETH, THOMAS];
const booking = { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [GRANT] }, aiCallWriteback: true };
/** A made-up earlier consultation, as the consultations read selects it. */
const PAST_CONSULTATION: Row = { StartDateTime: '2026-03-12T17:00:00.000+0000', Subject: 'Property Consultation', Owner: { Name: 'Blake Person' } };
const CONTACT = '0038X00000BcdeFQAR';

type RecordTarget = Extract<InternalAiCallRequest['target'], { kind: 'record' }>;
const target = (r: InternalAiCallRequest): RecordTarget => {
  if (r.target.kind !== 'record') throw new Error('expected a record target');
  return r.target;
};
const hasSlots = (r: InternalAiCallRequest): boolean => (target(r).slots?.length ?? 0) > 0;
const hasPriority = (r: InternalAiCallRequest): boolean => target(r).priority !== undefined;
const triggerLogs = (logs: LogEntry[]) => logs.filter((l) => l.msg === 'ai_call.place: trigger answered').map((l) => l.obj as Record<string, unknown>);
const noteLogs = (logs: LogEntry[]) => logs.filter((l) => l.msg === 'ai_call.place: appointment offer note').map((l) => l.obj);
const userQueries = (soql: string[]) => soql.filter((q) => / FROM User /.test(q));
const busyQueries = (soql: string[]) => soql.filter((q) => / FROM Event WHERE OwnerId /.test(q));
const consultationQueries = (soql: string[]) => soql.filter((q) => /Subject LIKE '%Consultation%'/.test(q));

describe.skipIf(!pgLane)('ai_call.place: the routed offer on real calls', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  /** Booking on, every rep and Grant active, a made-up San Diego property on every record, and Google answering. */
  async function routedHarness(o: { users?: Row[] } = {}) {
    const h = await paceHarness(db, { ...booking, aiCallConcurrency: 5 }, { maps: fakeMaps().maps });
    h.cti.store = true;
    h.sf.state.users = [...(o.users ?? USERS)];
    h.sf.state.recordFields = { ...SD_LEAD_ADDRESS };
    return h;
  }

  /** Ticks at each due time until the touch is sent (at most `max` ticks). */
  async function runUntilSent(h: Awaited<ReturnType<typeof routedHarness>>, touchId: string, max = 6): Promise<void> {
    for (let i = 0; i < max; i += 1) {
      const t = await touchById(db, touchId);
      if (t.status === 'sent') return;
      await h.run(t.dueAt);
    }
    throw new Error('the touch was never sent');
  }

  it('a due touch carries the region\'s times, Grant\'s high-priority offer and the seller\'s earlier consultation', async () => {
    const h = await routedHarness();
    h.sf.state.consultations = [PAST_CONSULTATION];
    await seedReleasedLead(db, h.base);

    expect((await h.run(NOW)).placed).toBe(1);
    const t = target(h.cti.requests[0]!);
    expect(t.slots!.length).toBeGreaterThan(0);
    expect(AppointmentSlots.safeParse(t.slots).success).toBe(true);
    expect(t.slots!.every((s) => s.region === 'SD' && SD_REPS.includes(s.specialistSfUserId))).toBe(true);
    // Tuesday 09:00 PDT: the next booking day after Monday.
    expect(t.priority).toEqual({ specialistSfUserId: GRANT, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles', defaultStart: '2026-10-06T16:00:00.000Z' });
    expect(t.context).toEqual({
      returning: false,
      consultations: { last: { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Person' }, next: null },
    });
    expect(noteLogs(h.logs)).toEqual([]);
  });

  it('a region with no active rep: Grant\'s high-priority offer still goes, with no regular times, and the note is logged', async () => {
    const h = await routedHarness({ users: usersWithInactive(SETH, THOMAS) });
    const lead = await seedReleasedLead(db, h.base);

    expect((await h.run(NOW)).placed).toBe(1);
    const t = target(h.cti.requests[0]!);
    expect('slots' in t).toBe(false);
    expect(t.priority).toMatchObject({ specialistSfUserId: GRANT, defaultStart: '2026-10-06T16:00:00.000Z' });
    expect(noteLogs(h.logs)).toEqual([{ orgId: h.base.orgId, touchId: lead.touchId, note: 'no_reps', slots: 0, priority: true }]);
  });

  it('the consultations read covers the records the research found around the lead', async () => {
    const h = await routedHarness();
    const lead = await seedReleasedLead(db, h.base);
    const [plan] = await db.select({ researchId: schema.callPlans.researchId }).from(schema.callPlans).where(eq(schema.callPlans.id, lead.planId!));
    const [research] = await db.select({ snapshot: schema.callResearch.snapshot }).from(schema.callResearch).where(eq(schema.callResearch.id, plan!.researchId));
    const snapshot = research!.snapshot as { records: Row[] };
    const records = [...snapshot.records, { relation: 'converted_contact', sfObject: 'Contact', id: CONTACT, role: null, fields: [] }];
    await db.update(schema.callResearch).set({ snapshot: { ...snapshot, records } }).where(eq(schema.callResearch.id, plan!.researchId));

    expect((await h.run(NOW)).placed).toBe(1);
    const [soql] = consultationQueries(h.sf.state.soql);
    expect(soql).toContain(lead.sfRecordId);
    expect(soql).toContain(CONTACT);
  });

  describe('I-2: a kept key cti-api never stored is sent as fresh; one it stored settles through the 409', () => {
    it('(1) a transport failure before cti-api reserved the key: the retry keeps the key AND carries times', async () => {
      const h = await routedHarness();
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ transport: 'network' });

      expect((await h.run(NOW)).retried).toBe(1);
      expect(hasSlots(h.cti.requests[0]!)).toBe(true);
      await runUntilSent(h, lead.touchId);

      const [first, retry] = h.cti.requests;
      expect(h.cti.requests).toHaveLength(2);
      expect(retry!.idempotencyKey).toBe(first!.idempotencyKey);
      expect(hasSlots(retry!)).toBe(true);
      expect(hasPriority(retry!)).toBe(true);
      expect(triggerLogs(h.logs).map((l) => l.conflict)).toEqual([undefined, undefined]);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('(2) cti-api stored a refusal whose answer was lost: the re-send has no times and no priority, the 409 replays the refusal, then one new key with both', async () => {
      const h = await routedHarness();
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ lostAnswer: { result: 'blocked', reason: 'calling_hours' } });

      await h.run(NOW);
      const kept = await touchById(db, lead.touchId);
      expect(kept).toMatchObject({ status: 'planned', lastBlockReason: 'transport', triggerKey: h.cti.requests[0]!.idempotencyKey });

      await h.run(kept.dueAt);
      const resent = h.cti.requests[1]!;
      expect(resent.idempotencyKey).toBe(h.cti.requests[0]!.idempotencyKey);
      expect('slots' in target(resent)).toBe(false);
      expect('priority' in target(resent)).toBe(false);
      expect(triggerLogs(h.logs).at(-1)).toMatchObject({ conflict: 'answered', result: 'retry:calling_hours' });
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', triggerKey: null, lastBlockReason: 'calling_hours' });

      await runUntilSent(h, lead.touchId);
      const keys = new Set(h.cti.requests.map((r) => r.idempotencyKey));
      expect(keys.size).toBe(2);
      expect(h.cti.requests).toHaveLength(3);
      expect(h.cti.requests[2]!.idempotencyKey).not.toBe(h.cti.requests[0]!.idempotencyKey);
      expect(hasSlots(h.cti.requests[2]!)).toBe(true);
      expect(hasPriority(h.cti.requests[2]!)).toBe(true);
    });

    it('(3) cti-api reserved the key and crashed with no call: waits until stale, the re-send 409s, and exactly one new key (with times) places it', async () => {
      const h = await routedHarness();
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ reservedNoAnswer: true });

      await h.run(NOW);
      await runUntilSent(h, lead.touchId);

      const keys = h.cti.requests.map((r) => r.idempotencyKey);
      expect(new Set(keys).size).toBe(2);
      expect(keys.slice(0, 2)).toEqual([keys[0], keys[0]]);
      expect(h.cti.requests.map(hasSlots)).toEqual([true, false, true]);
      expect(h.cti.requests.map(hasPriority)).toEqual([true, false, true]);
      expect(triggerLogs(h.logs).map((l) => l.conflict)).toEqual([undefined, 'none', undefined]);
      // The re-send waited until cti-api would call the reservation stale (STALE_REQUEST_MS after it was made at NOW).
      expect(h.cti.sentAt[1]!.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + STALE_REQUEST_MS);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent' });
    });
  });

  it('M-1: two calls in one tick read the reps and their calendars once (one User query, one busy Event query)', async () => {
    const h = await routedHarness();
    await seedReleasedLead(db, h.base);
    await seedReleasedLead(db, h.base);

    expect((await h.run(NOW)).placed).toBe(2);
    expect(h.cti.requests.every(hasSlots)).toBe(true);
    expect(userQueries(h.sf.state.soql)).toHaveLength(1);
    const busy = busyQueries(h.sf.state.soql);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toContain('OwnerId IN (');
    for (const rep of [CHANCE, BLAKE, SETH, THOMAS]) expect(busy[0]).toContain(rep);
  });

  it('M-1: two Opportunity calls in one tick describe Opportunity once, for the property address', async () => {
    const h = await routedHarness();
    h.sf.state.recordFields = { Street__c: '123 Palm Ave', City__c: 'San Diego', State__c: 'CA', Zipcode__c: '92101' };
    for (const id of ['0068X00000Opp01AAA', '0068X00000Opp02AAA']) {
      await seedReleasedLead(db, h.base, { recordOver: { sfObject: 'Opportunity', sfRecordId: id } });
      // The claim needs the Opportunity selected; the fresh read gives it the same callable number as the Leads.
      await selectLead(db, { ...h.base, sfRecordId: id });
      h.sf.state.records.set(id, { Mobile_Phone__c: '+15125550100' });
    }

    expect((await h.run(NOW)).placed).toBe(2);
    expect(h.cti.requests.map((r) => target(r).objectType)).toEqual(['Opportunity', 'Opportunity']);
    expect(h.cti.requests.every(hasSlots)).toBe(true);
    expect(h.sf.state.described).toEqual(['Opportunity']);
  });

  it('M-2: a rep zone Salesforce gives that cannot be used is logged once, not every tick', async () => {
    const h = await routedHarness({ users: USERS.map((u) => (u.Id === SETH ? { ...u, TimeZoneSidKey: 'Mars/Olympus_Mons' } : u)) });
    await seedReleasedLead(db, h.base);
    await seedReleasedLead(db, h.base);
    await h.run(NOW);
    await seedReleasedLead(db, h.base);
    await h.run(at(NOW, MIN));
    const warned = h.logs.filter((l) => l.msg === "ai_call.place: a rep's Salesforce time zone is not usable; their times are given in the default zone");
    expect(warned).toEqual([{ level: 'warn', obj: { orgId: h.base.orgId, repSfUserId: SETH, zone: 'Mars/Olympus_Mons', usedZone: 'America/Los_Angeles' }, msg: expect.any(String) }]);
    // Both ticks read the calendars (three calls, all with times).
    expect(h.cti.requests).toHaveLength(3);
    expect(userQueries(h.sf.state.soql)).toHaveLength(2);
    expect(h.cti.requests.every(hasSlots)).toBe(true);
  });

  describe('I-4: a time another call booked with a rep is not offered with that rep until the calendar shows it', () => {
    /** San Diego with one active rep (Seth), so a time he is booked for has nobody else to take it. */
    const sethOnly = () => routedHarness({ users: usersWithInactive(THOMAS) });

    async function bookFirstOffer(h: Awaited<ReturnType<typeof routedHarness>>, touchId: string) {
      const slot = target(h.cti.requests[0]!).slots![0]!;
      const aiCallId = (await touchById(db, touchId)).aiCallId!;
      // What cti-api's book_appointment stores on the call.
      const appointment = {
        slotId: slot.id, kind: slot.kind, start: slot.start, end: slot.end, specialistSfUserId: slot.specialistSfUserId, region: slot.region,
        addressConfirmed: true, note: '', bookedAt: NOW.toISOString(),
      };
      await db.update(schema.aiCalls).set({ appointment }).where(eq(schema.aiCalls.id, aiCallId));
      return { slot, aiCallId };
    }

    it('two calls: the first books Tuesday 12:00 with Seth; the second is not offered 12:00', async () => {
      const h = await sethOnly();
      const a = await seedReleasedLead(db, h.base);
      expect((await h.run(NOW)).placed).toBe(1);
      const { slot } = await bookFirstOffer(h, a.touchId);
      // Tuesday 12:00 PDT: the first in-person start at least 20 hours ahead.
      expect(slot).toMatchObject({ kind: 'walkthrough', start: '2026-10-06T19:00:00.000Z', specialistSfUserId: SETH });

      // Same instant, so the 20-hour lead time still allows Tuesday 12:00: only the booking can take it out.
      await seedReleasedLead(db, h.base);
      expect((await h.run(NOW)).placed).toBe(1);

      const second = target(h.cti.requests[1]!).slots!;
      expect(second.length).toBeGreaterThan(0);
      expect(second.map((s) => s.start)).not.toContain(slot.start);
    });

    it('once the write-back created the Event, the calendar is what counts (the booking is not taken out twice)', async () => {
      const h = await sethOnly();
      const a = await seedReleasedLead(db, h.base);
      await h.run(NOW);
      const { slot, aiCallId } = await bookFirstOffer(h, a.touchId);
      const lead = await touchById(db, a.touchId);
      await db.insert(schema.aiCallWritebacks).values({
        orgId: h.base.orgId, aiCallId, touchId: a.touchId, enrollmentId: lead.enrollmentId, sfObject: 'Lead', sfRecordId: a.sfRecordId, outcome: 'appointment_set', status: 'done', sfEventId: '00U8X00000AbCdEUAZ',
      });
      // The fake calendar has no Event (as if a person moved it): nothing else holds the time.
      await seedReleasedLead(db, h.base);
      await h.run(NOW);
      expect(target(h.cti.requests[1]!).slots![0]!.start).toBe(slot.start);
    });
  });
});
