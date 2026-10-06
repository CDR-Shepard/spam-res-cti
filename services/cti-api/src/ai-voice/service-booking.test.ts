import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppointmentSlot } from '@cti/contracts';
import { bookAppointment, SLOT_TAKEN, WALKTHROUGH_NEEDS_ADDRESS } from './service-booking.js';
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
  ctx = { store, aiCallId: ID, orgId: ORG, toE164: '+16195550100', log, now: () => NOW, slots: [P1, P2, W1] };
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
    expect(store.rows.get(ID)?.summary).toBe(`Appointment booked: phone call ${P1.start}`);
  });

  it('3b: a walkthrough with the address confirmed is stored as one', async () => {
    await book({ slot_id: 'w1', address_confirmed: true, note: 'x'.repeat(400) });
    expect(stored()).toMatchObject({ slotId: 'w1', kind: 'walkthrough', addressConfirmed: true, note: 'x'.repeat(300) });
    expect(store.rows.get(ID)?.summary).toBe(`Appointment booked: walkthrough ${W1.start}`);
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
