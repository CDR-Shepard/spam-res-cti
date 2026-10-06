/**
 * Plan 1D Part 4, Fix 1 (I-1, M-3): a booked call keeps its appointment however it ends, unless a later decision replaces
 * the outcome; an appointment on a call that finished without one standing frees the time for the next call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppointmentSlot } from '@cti/contracts';
import { clearActiveCalls } from './registry.js';
import { finalizeAiCall } from './service-finalize.js';
import { defaultToolEffects, handleToolCall, type CallControl, type ToolCtx } from './service-tools.js';
import { CALL_SID, fakeStore, fakeTwilio, type FakeStore } from './testing.js';

const ID = '11111111-2222-4333-8444-555555555555';
const NEXT = '33333333-2222-4333-8444-555555555555';
const ORG = 'o1';
const OWNER = '0058X00000Fsx39QAB';
const NOW = new Date('2026-10-06T18:00:00.000Z');
const END = new Date('2026-10-06T18:06:00.000Z');

const P1: AppointmentSlot = {
  id: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
  specialistSfUserId: OWNER, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles',
};
const P2: AppointmentSlot = { ...P1, id: 'p2', start: '2026-10-07T21:00:00.000Z', end: '2026-10-07T21:15:00.000Z' };

let store: FakeStore;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let closed: boolean;

const ctxFor = (id: string, slots: readonly AppointmentSlot[] = [P1, P2]): ToolCtx => ({
  store, aiCallId: id, orgId: ORG, toE164: id === ID ? '+16195550100' : '+16195550111', log, now: () => NOW, slots,
});
const callControl = (): CallControl => ({
  callSid: CALL_SID,
  twilio: fakeTwilio(),
  claimClose: () => {
    if (closed) return false;
    closed = true;
    return true;
  },
  waitForPlayback: async () => {},
  stopStream: () => {},
  transferTwiml: () => '<Response/>',
});
const tool = (name: Parameters<typeof handleToolCall>[0], args: unknown, id = ID) =>
  handleToolCall(name, args, { ctx: ctxFor(id), effects: defaultToolEffects, call: callControl() });
const bookP1 = (id = ID) => tool('book_appointment', { slot_id: 'p1', address_confirmed: false, note: '' }, id);
const hangUp = (id = ID) =>
  finalizeAiCall({ store, log }, id, { callStatus: 'completed', durationSeconds: 360, endedAt: END, answeredBy: 'human' });
const row = (id = ID) => store.rows.get(id)!;

beforeEach(async () => {
  store = fakeStore();
  closed = false;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  for (const [id, to] of [[ID, '+16195550100'], [NEXT, '+16195550111']] as const) {
    await store.insert({ id, orgId: ORG, startedBy: 'u1', toE164: to, status: 'in_progress', callSid: CALL_SID });
  }
});
afterEach(() => clearActiveCalls());

describe('I-1: the outcome of a booked call', () => {
  it('booking records appointment_set at once', async () => {
    await bookP1();
    expect(row().outcome).toBe('appointment_set');
  });

  it('booked, then the caller hangs up before end_call: the call ends as appointment_set', async () => {
    await bookP1();
    const res = await hangUp();
    expect(res.finalized && res.row).toMatchObject({ outcome: 'appointment_set', status: 'completed' });
    expect(row().appointment).toMatchObject({ slotId: 'p1' });
  });

  it('booked, then the bridge fails (marked failed): the outcome stays appointment_set', async () => {
    await bookP1();
    await store.markFailed(ID);
    expect(row()).toMatchObject({ status: 'failed', outcome: 'appointment_set' });
  });

  it('booked, then end_call appointment_set: appointment_set', async () => {
    await bookP1();
    await tool('end_call', { outcome: 'appointment_set', summary: 'Booked Thursday.' });
    await hangUp();
    expect(row().outcome).toBe('appointment_set');
  });

  it('booked, then the agent hears silence and ends as hung_up: still appointment_set (the same as the caller hanging up)', async () => {
    await bookP1();
    await tool('end_call', { outcome: 'hung_up', summary: 'Line went quiet.' });
    await hangUp();
    expect(row().outcome).toBe('appointment_set');
  });

  it('hung_up without a booking stays hung_up', async () => {
    await tool('end_call', { outcome: 'hung_up', summary: 'Line went quiet.' });
    expect(row().outcome).toBe('hung_up');
  });

  it('booked, then they change their mind (end_call not_interested): not_interested, and the time is free again', async () => {
    await bookP1();
    await tool('end_call', { outcome: 'not_interested', summary: 'Cancelled.' });
    await hangUp();
    expect(row().outcome).toBe('not_interested');
    expect((await bookP1(NEXT)).output).toMatch(/^booked/);
  });

  it('booked, then do-not-call: do_not_call wins, the number is opted out, and the time is free for the next call', async () => {
    await bookP1();
    await tool('mark_do_not_call', { note: 'stop calling me' });
    expect(row().outcome).toBe('do_not_call');
    await tool('end_call', { outcome: 'do_not_call', summary: 'Asked to stop.' });
    await hangUp();
    expect(row().outcome).toBe('do_not_call');
    expect(store.optOuts).toEqual([expect.objectContaining({ orgId: ORG, e164: '+16195550100' })]);
    expect(row().appointment).not.toBeNull();
    expect((await bookP1(NEXT)).output).toMatch(/^booked/);
  });

  it('booked, then transferred: qualified_transferred / transferred, the appointment stays on the row and keeps its time', async () => {
    await bookP1();
    await tool('transfer_to_rep', { reason: 'interested', summary: 'Wants to talk now.' });
    expect(row().outcome).toBe('qualified_transferred');
    expect(await store.markTransferred(ID)).toBe(true);
    await hangUp();
    expect(row()).toMatchObject({ outcome: 'qualified_transferred', status: 'transferred' });
    expect(row().appointment).toMatchObject({ slotId: 'p1' });
    expect((await bookP1(NEXT)).output).toMatch(/just taken/);
  });

  it('a live booked call holds its time; once it ends as appointment_set it still holds it', async () => {
    await bookP1();
    expect((await bookP1(NEXT)).output).toMatch(/just taken/);
    await hangUp();
    expect((await bookP1(NEXT)).output).toMatch(/just taken/);
  });

  it('a failed outcome write after the booking is logged; the agent still hears booked', async () => {
    store.setOutcome = async () => {
      throw new Error('db blip');
    };
    const res = await bookP1();
    expect(res.output).toMatch(/^booked/);
    expect(row().appointment).toMatchObject({ slotId: 'p1' });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ aiCallId: ID, err: 'db blip' }), expect.any(String));
  });
});

describe('M-3: the "Appointment booked" summary line', () => {
  it('an identical replay adds no second line', async () => {
    await bookP1();
    await bookP1();
    expect(row().summary).toBe(`Appointment booked: phone call ${P1.start}`);
  });

  it('a rebook replaces the earlier line and keeps every other line', async () => {
    await tool('schedule_callback', { when: 'Thursday after 5 PM', note: '' });
    await bookP1();
    await tool('book_appointment', { slot_id: 'p2', address_confirmed: false, note: '' });
    expect(row().summary).toBe(`Callback requested: Thursday after 5 PM\nAppointment booked: phone call ${P2.start}`);
  });
});
