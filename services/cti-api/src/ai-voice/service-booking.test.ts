import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppointmentSlot, ConsultationFact, PriorityOffer } from '@cti/contracts';
import {
  bookAppointment,
  bookPriorityAppointment,
  PRIORITY_BAD_TIME,
  PRIORITY_NEEDS_ADDRESS,
  PRIORITY_OUTSIDE_HOURS,
  PRIORITY_TOO_SOON,
  PRIORITY_UNAVAILABLE,
  SLOT_TAKEN,
  WALKTHROUGH_NEEDS_ADDRESS,
} from './service-booking.js';
import { defaultToolEffects, handleToolCall, type CallControl, type ToolCtx, type ToolEffects } from './service-tools.js';
import { CALL_SID, fakeStore, fakeTwilio, silentLog, type FakeStore } from './testing.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '22222222-2222-4333-8444-555555555555';
const ORG = 'o1';
const OWNER = '0058X00000Fsx39QAB';
const NOW = new Date('2026-10-06T18:00:00.000Z');

const P1: AppointmentSlot = {
  id: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
  specialistSfUserId: OWNER, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles',
};
const P2: AppointmentSlot = { ...P1, id: 'p2', start: '2026-10-07T21:00:00.000Z', end: '2026-10-07T21:15:00.000Z' };
const W1: AppointmentSlot = {
  ...P1, id: 'w1', kind: 'walkthrough', start: '2026-10-08T16:00:00.000Z', end: '2026-10-08T17:00:00.000Z',
};

let store: FakeStore;
let ctx: ToolCtx;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
const call = { callSid: CALL_SID, twilio: fakeTwilio(), claimClose: () => true, waitForPlayback: async () => {}, stopStream: () => {}, transferTwiml: () => '' } satisfies CallControl;

beforeEach(async () => {
  store = fakeStore();
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await store.insert({ id: ID, orgId: ORG, startedBy: 'u1', toE164: '+16195550100', status: 'in_progress', callSid: CALL_SID });
  ctx = { store, aiCallId: ID, orgId: ORG, toE164: '+16195550100', log, now: () => NOW, slots: [P1, P2, W1], priority: null, consultations: null };
});

const book = (args: unknown, effects: ToolEffects = defaultToolEffects) => bookAppointment(args, { ctx, effects, call });
const stored = () => store.rows.get(ID)?.appointment ?? null;

describe('bookAppointment', () => {
  it('1: an id not on the list is refused and nothing is stored', async () => {
    const res = await book({ slot_id: 'p9', address_confirmed: true, note: '' });
    expect(res.output).toMatch(/not on your list/);
    expect(stored()).toBeNull();
  });

  it('2: a walkthrough without a confirmed address asks for it and stores nothing', async () => {
    expect(await book({ slot_id: 'w1', address_confirmed: false, note: '' })).toEqual({ output: WALKTHROUGH_NEEDS_ADDRESS });
    expect(await book({ slot_id: 'w1', note: '' })).toEqual({ output: WALKTHROUGH_NEEDS_ADDRESS });
    expect(stored()).toBeNull();
  });

  it('3: a phone slot is stored with the slot times, the owner and the booking time', async () => {
    const res = await book({ slot_id: 'p1', address_confirmed: false, note: '  Prefers mornings.  ' });
    expect(res).toEqual({
      output: 'booked — confirm the day and time in one line with your goodbye, then end_call with outcome appointment_set',
      then: 'continue',
    });
    expect(stored()).toEqual({
      slotId: 'p1',
      kind: 'phone',
      start: P1.start,
      end: P1.end,
      specialistSfUserId: OWNER,
      addressConfirmed: false,
      note: 'Prefers mornings.',
      bookedAt: NOW.toISOString(),
    });
    expect(store.rows.get(ID)?.summary).toBe('Appointment booked: phone consultation with Grant Wed Oct 7, 11:00 AM PT');
  });

  it('3b: a walkthrough with the address confirmed is stored as one', async () => {
    await book({ slot_id: 'w1', address_confirmed: true, note: 'x'.repeat(400) });
    expect(stored()).toMatchObject({ slotId: 'w1', kind: 'walkthrough', addressConfirmed: true, note: 'x'.repeat(300) });
    expect(store.rows.get(ID)?.summary).toBe('Appointment booked: in-person consultation with Grant Thu Oct 8, 9:00 AM PT');
  });

  it('Fix 1 I-3: the time a slot blocks (a walkthrough\'s buffer) is stored with the booking; a slot without one stores none', async () => {
    ctx = { ...ctx, slots: [P1, { ...W1, blockStart: '2026-10-08T15:30:00.000Z', blockEnd: '2026-10-08T17:30:00.000Z' }] };
    await book({ slot_id: 'w1', address_confirmed: true, note: '' });
    expect(stored()).toMatchObject({ slotId: 'w1', blockStart: '2026-10-08T15:30:00.000Z', blockEnd: '2026-10-08T17:30:00.000Z' });
    await book({ slot_id: 'p1', address_confirmed: false, note: '' });
    expect(stored()).not.toHaveProperty('blockStart');
    expect(stored()).not.toHaveProperty('blockEnd');
  });

  it('4: booking twice keeps the last booking', async () => {
    await book({ slot_id: 'p1', address_confirmed: false, note: '' });
    await book({ slot_id: 'p2', address_confirmed: false, note: '' });
    expect(stored()).toMatchObject({ slotId: 'p2', start: P2.start });
  });

  it('5: a store failure is logged and the agent hears the callback fallback; it never throws', async () => {
    store.setAppointment = async () => {
      throw new Error('db down');
    };
    const res = await book({ slot_id: 'p1', address_confirmed: false, note: '' });
    expect(res).toEqual({ output: 'booking failed — offer to have the specialist call them back instead (schedule_callback)' });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ aiCallId: ID, what: 'book_appointment', err: 'db down' }), expect.any(String));
  });

  it('6 (D-10): a time another real AI call already booked with the same owner is refused, and the agent offers another', async () => {
    await store.insert({
      id: OTHER, orgId: ORG, startedBy: 'u2', toE164: '+16195550199', status: 'completed', outcome: 'appointment_set', endedAt: NOW,
      appointment: { slotId: 'p3', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z', specialistSfUserId: OWNER, addressConfirmed: false, note: '', bookedAt: NOW.toISOString() },
    });
    const res = await book({ slot_id: 'p1', address_confirmed: false, note: '' });
    expect(res).toEqual({ output: SLOT_TAKEN, then: 'continue' });
    expect(stored()).toBeNull();
    expect(store.rows.get(ID)?.summary).toBeNull();
    // The other time is still free.
    await book({ slot_id: 'p2', address_confirmed: false, note: '' });
    expect(stored()).toMatchObject({ slotId: 'p2' });
  });

  it('7: the call already ended → the fallback, nothing stored', async () => {
    await store.update(ID, { endedAt: NOW });
    const res = await book({ slot_id: 'p1', address_confirmed: false, note: '' });
    expect(res.output).toMatch(/^booking failed/);
    expect(stored()).toBeNull();
  });

  it('final review m2: a listed time whose start has passed (or is minutes away) is refused and nothing is stored', async () => {
    const SOON: AppointmentSlot = { ...P1, id: 'p3', start: '2026-10-06T18:03:00.000Z', end: '2026-10-06T18:18:00.000Z' };
    const PAST: AppointmentSlot = { ...P1, id: 'p4', start: '2026-10-06T17:00:00.000Z', end: '2026-10-06T17:15:00.000Z' };
    ctx = { ...ctx, slots: [P1, SOON, PAST] };
    expect((await book({ slot_id: 'p4', address_confirmed: false, note: '' })).output).toMatch(/already passed/);
    expect((await book({ slot_id: 'p3', address_confirmed: false, note: '' })).output).toMatch(/already passed/);
    expect(stored()).toBeNull();
    expect((await book({ slot_id: 'p1', address_confirmed: false, note: '' })).output).toMatch(/^booked/);
  });

  it('8: junk arguments are refused as not on the list', async () => {
    expect((await book(null)).output).toMatch(/not on your list/);
    expect((await book({ slot_id: 7 })).output).toMatch(/not on your list/);
  });

  it('is what handleToolCall runs for book_appointment', async () => {
    const res = await handleToolCall('book_appointment', { slot_id: 'p1', address_confirmed: false, note: '' }, { ctx, effects: defaultToolEffects, call });
    expect(res.then).toBe('continue');
    expect(stored()).toMatchObject({ slotId: 'p1' });
  });
});

describe('book_appointment: the region and the earlier consultation (routing step 1)', () => {
  const BLAKE = '0058X00000FA8tLQAT';
  const LA: AppointmentSlot = { ...W1, id: 'w2', region: 'LA', specialistSfUserId: BLAKE, specialistFirstName: 'Blake' };
  const LAST: ConsultationFact = { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' };

  it('copies the slot region, what changed (trimmed) and the earlier consultation; the summary names the rep', async () => {
    ctx = { ...ctx, slots: [LA], consultations: { last: LAST, next: null } };
    await book({ slot_id: 'w2', address_confirmed: true, note: '', what_changed: '  They got a cash offer from a neighbor.  ' });
    expect(stored()).toMatchObject({
      slotId: 'w2', region: 'LA', specialistSfUserId: BLAKE, whatChanged: 'They got a cash offer from a neighbor.', previousConsultation: LAST,
    });
    expect(store.rows.get(ID)?.summary).toBe('Appointment booked: in-person consultation with Blake Thu Oct 8, 9:00 AM PT');
  });

  it('an empty what_changed and no earlier consultation leave both out; a slot with no first name names no one', async () => {
    ctx = { ...ctx, slots: [{ ...LA, specialistFirstName: null }], consultations: { last: null, next: LAST } };
    await book({ slot_id: 'w2', address_confirmed: true, note: '', what_changed: '   ' });
    expect(stored()).toMatchObject({ region: 'LA' });
    expect(stored()).not.toHaveProperty('whatChanged');
    expect(stored()).not.toHaveProperty('previousConsultation');
    expect(store.rows.get(ID)?.summary).toBe('Appointment booked: in-person consultation Thu Oct 8, 9:00 AM PT');
  });

  it('what_changed is capped at 300 characters; a missing one is left out', async () => {
    await book({ slot_id: 'p1', address_confirmed: false, note: '', what_changed: 'y'.repeat(400) });
    expect(stored()).toMatchObject({ whatChanged: 'y'.repeat(300) });
    await book({ slot_id: 'p2', address_confirmed: false, note: '' });
    expect(stored()).not.toHaveProperty('whatChanged');
    expect(stored()).not.toHaveProperty('region');
  });
});

describe('bookPriorityAppointment (high priority, routing step 1)', () => {
  /** Mon Oct 19 2026, 10:00 AM PDT. */
  const MON = new Date('2026-10-19T17:00:00.000Z');
  const GRANT: PriorityOffer = {
    specialistSfUserId: OWNER, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles', defaultStart: '2026-10-19T19:00:00.000Z',
  };
  const LAST: ConsultationFact = { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' };
  const args = (over: Record<string, unknown> = {}) => ({
    start: '2026-10-20T10:00', address_confirmed: true, reason: 'Auction on Friday', what_changed: '', note: '', ...over,
  });
  const priority = (a: unknown, effects: ToolEffects = defaultToolEffects) => bookPriorityAppointment(a, { ctx, effects, call });

  beforeEach(() => {
    ctx = { ...ctx, now: () => MON, slots: [], priority: GRANT };
  });

  it('exactly two hours ahead books: Grant, slot h1, an hour, in person with the address confirmed, marked priority', async () => {
    const res = await priority(args({ start: '2026-10-19T12:00', reason: 'Foreclosure sale on Friday', note: 'Gate code at the side door.' }));
    expect(res).toEqual({
      output: 'booked — confirm the day and time in one line with your goodbye, then end_call with outcome appointment_set',
      then: 'continue',
    });
    expect(stored()).toEqual({
      slotId: 'h1',
      kind: 'walkthrough',
      start: '2026-10-19T19:00:00.000Z',
      end: '2026-10-19T20:00:00.000Z',
      specialistSfUserId: OWNER,
      addressConfirmed: true,
      note: 'Urgent: Foreclosure sale on Friday. Gate code at the side door.',
      bookedAt: MON.toISOString(),
      priority: true,
    });
    expect(store.rows.get(ID)?.outcome).toBe('appointment_set');
    expect(store.rows.get(ID)?.summary).toBe('Appointment booked: high-priority in-person consultation with Grant Mon Oct 19, 12:00 PM PT');
  });

  it.each([
    ['a Saturday', '2026-10-24T10:00', '2026-10-24T17:00:00.000Z'],
    ['8 AM, the first start', '2026-10-20T08:00', '2026-10-20T15:00:00.000Z'],
    ['7 PM, the last start (it ends at 8 PM)', '2026-10-20T19:00', '2026-10-21T02:00:00.000Z'],
    ['9 AM after daylight saving ends (PST)', '2026-11-02T09:00', '2026-11-02T17:00:00.000Z'],
  ])('%s books', async (_label, start, iso) => {
    expect((await priority(args({ start }))).output).toMatch(/^booked/);
    expect(stored()).toMatchObject({ slotId: 'h1', start: iso, end: new Date(Date.parse(iso) + 60 * 60_000).toISOString(), priority: true });
  });

  it.each([
    ['an hour and a half away', '2026-10-19T11:30', PRIORITY_TOO_SOON],
    ['an hour and three quarters away', '2026-10-19T11:45', PRIORITY_TOO_SOON],
    ['earlier today', '2026-10-19T08:00', PRIORITY_TOO_SOON],
    ['7:45 AM', '2026-10-20T07:45', PRIORITY_OUTSIDE_HOURS],
    ['7:15 PM (it would end after 8 PM)', '2026-10-20T19:15', PRIORITY_OUTSIDE_HOURS],
    ['8 PM', '2026-10-20T20:00', PRIORITY_OUTSIDE_HOURS],
    ['off the quarter hour', '2026-10-20T10:10', PRIORITY_BAD_TIME],
    ['words', 'tomorrow 2pm', PRIORITY_BAD_TIME],
    ['no such hour', '2026-10-20T25:00', PRIORITY_BAD_TIME],
    ['with seconds', '2026-10-20T10:00:00', PRIORITY_BAD_TIME],
    ['with a zone', '2026-10-20T10:00Z', PRIORITY_BAD_TIME],
    ['no such day', '2026-02-30T10:00', PRIORITY_BAD_TIME],
  ])('%s (%s) is refused and nothing is stored', async (_label, start, refusal) => {
    expect(await priority(args({ start }))).toEqual({ output: refusal });
    expect(stored()).toBeNull();
    expect(store.rows.get(ID)?.summary).toBeNull();
  });

  it('checks in order: the offer, then the address, then the time as written, then the two hours, then the hours', async () => {
    ctx = { ...ctx, priority: null };
    expect(await priority(args({ address_confirmed: false, start: 'soon' }))).toEqual({ output: PRIORITY_UNAVAILABLE });
    ctx = { ...ctx, priority: GRANT };
    expect(await priority(args({ address_confirmed: false, start: 'soon' }))).toEqual({ output: PRIORITY_NEEDS_ADDRESS });
    expect(await priority(args({ address_confirmed: 'yes' }))).toEqual({ output: PRIORITY_NEEDS_ADDRESS });
    expect(await priority(args({ start: '2026-10-19T11:10' }))).toEqual({ output: PRIORITY_BAD_TIME });
    expect(await priority(args({ start: '2026-10-19T07:00' }))).toEqual({ output: PRIORITY_TOO_SOON });
    expect(stored()).toBeNull();
  });

  it('junk arguments book nothing', async () => {
    expect(await priority(null)).toEqual({ output: PRIORITY_NEEDS_ADDRESS });
    expect(await priority(args({ start: 1_792_000_000_000 }))).toEqual({ output: PRIORITY_BAD_TIME });
    expect(await priority(args({ start: undefined }))).toEqual({ output: PRIORITY_BAD_TIME });
    expect(stored()).toBeNull();
  });

  it.each([
    ['Auction on Friday', 'Gate code at the side door.', 'Urgent: Auction on Friday. Gate code at the side door.'],
    ['Auction on Friday.', 'Call first.', 'Urgent: Auction on Friday. Call first.'],
    ['Auction on Friday', '', 'Urgent: Auction on Friday.'],
    ['Auction on Friday.', '   ', 'Urgent: Auction on Friday.'],
    ['  Auction\n on   Friday ', ' Call\n\nfirst. ', 'Urgent: Auction on Friday. Call first.'],
  ])('the note: reason %j and note %j → %j', async (reason, note, want) => {
    await priority(args({ reason, note }));
    expect(stored()).toMatchObject({ note: want });
  });

  it('the note is one line of at most 300 characters', async () => {
    await priority(args({ note: `${'z'.repeat(200)}\n${'z'.repeat(200)}` }));
    const note = (stored() as { note: string }).note;
    expect(note).toHaveLength(300);
    expect(note.startsWith('Urgent: Auction on Friday. zzz')).toBe(true);
    expect(note).not.toContain('\n');
  });

  it('carries the earlier consultation and what changed (trimmed) into the booking', async () => {
    ctx = { ...ctx, consultations: { last: LAST, next: null } };
    await priority(args({ what_changed: '  The bank set an auction date.  ' }));
    expect(stored()).toMatchObject({ previousConsultation: LAST, whatChanged: 'The bank set an auction date.' });
  });

  it('with no earlier consultation and nothing changed, neither is stored', async () => {
    ctx = { ...ctx, consultations: { last: null, next: null } };
    await priority(args({ what_changed: '  ' }));
    expect(stored()).not.toHaveProperty('previousConsultation');
    expect(stored()).not.toHaveProperty('whatChanged');
  });

  it('a rep with no first name: the summary names no one', async () => {
    ctx = { ...ctx, priority: { ...GRANT, specialistFirstName: null } };
    await priority(args());
    expect(store.rows.get(ID)?.summary).toBe('Appointment booked: high-priority in-person consultation Tue Oct 20, 10:00 AM PT');
  });

  it("D-10 is skipped: it books over another real call's standing booking with Grant at the same time", async () => {
    await store.insert({
      id: OTHER, orgId: ORG, startedBy: 'u2', toE164: '+16195550199', status: 'completed', outcome: 'appointment_set', endedAt: MON,
      appointment: {
        slotId: 'w1', kind: 'walkthrough', start: '2026-10-20T17:00:00.000Z', end: '2026-10-20T18:00:00.000Z',
        specialistSfUserId: OWNER, addressConfirmed: true, note: '', bookedAt: MON.toISOString(),
      },
    });
    expect((await priority(args({ start: '2026-10-20T10:00' }))).output).toMatch(/^booked/);
    expect(stored()).toMatchObject({ slotId: 'h1', start: '2026-10-20T17:00:00.000Z', priority: true });
  });

  it('the call already ended: the fallback, nothing stored (the live-row rule still holds)', async () => {
    await store.update(ID, { endedAt: MON });
    expect((await priority(args())).output).toMatch(/^booking failed/);
    expect(stored()).toBeNull();
  });

  it("logs ids and codes only: never the reason, what changed or the note, whether it's refused or fails", async () => {
    const secret = { reason: 'SECRET-REASON', what_changed: 'SECRET-CHANGED', note: 'SECRET-NOTE' };
    await priority(args({ ...secret, start: '2026-10-19T11:30' }));
    await priority(args({ ...secret, start: 'SECRET-START' }));
    store.setAppointment = async () => {
      throw new Error('db down');
    };
    const res = await priority(args(secret));
    expect(res).toEqual({ output: 'booking failed — offer to have the specialist call them back instead (schedule_callback)' });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ aiCallId: ID, what: 'book_priority_appointment', err: 'db down' }), expect.any(String));
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(logged).not.toContain('SECRET');
  });

  it('is what handleToolCall runs for book_priority_appointment', async () => {
    const res = await handleToolCall('book_priority_appointment', args(), { ctx, effects: defaultToolEffects, call });
    expect(res.then).toBe('continue');
    expect(stored()).toMatchObject({ slotId: 'h1', priority: true });
  });
});
