import { describe, expect, it } from 'vitest';
import {
  AiCallBookingSettings,
  AiCallSettings,
  AppointmentSlot,
  AppointmentSlots,
  BOOKING_STANDS_OUTCOMES,
  BookedAppointment,
  bookingStands,
  CallContext,
  IanaZone,
  SLOT_ID,
  WritebackReadiness,
} from './appointments.js';

const GRANT = '0058X00000Fsx39QAB';

const phoneSlot = {
  id: 'p1',
  kind: 'phone',
  start: '2026-10-07T17:00:00.000Z',
  end: '2026-10-07T17:15:00.000Z',
  specialistSfUserId: GRANT,
  specialistFirstName: 'Grant',
  timeZone: 'America/Los_Angeles',
} as const;
const slot = (patch: Record<string, unknown>) => ({ ...phoneSlot, ...patch });

const kind = {
  enabled: true,
  durationMinutes: 15,
  startHour: 10,
  endHour: 18,
  stepMinutes: 30,
  minLeadMinutes: 120,
  horizonBusinessDays: 2,
  bufferMinutes: 0,
  maxOffered: 6,
};
const booking = {
  enabled: true,
  specialists: [GRANT],
  convertLeads: true,
  days: [1, 2, 3, 4, 5],
  phone: kind,
  walkthrough: { ...kind, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30 },
};

describe('AppointmentSlot', () => {
  it('1: a valid phone slot p1 parses', () => {
    expect(AppointmentSlot.parse(phoneSlot)).toEqual(phoneSlot);
  });

  it('a valid walkthrough slot w3 parses, and a slot may have no first name', () => {
    expect(AppointmentSlot.safeParse(slot({ id: 'w3', kind: 'walkthrough', specialistFirstName: null })).success).toBe(true);
  });

  it('2: w1 with kind phone is rejected (the id prefix must match the kind)', () => {
    expect(AppointmentSlot.safeParse(slot({ id: 'w1' })).success).toBe(false);
    expect(AppointmentSlot.safeParse(slot({ id: 'p1', kind: 'walkthrough' })).success).toBe(false);
  });

  it('3: end <= start is rejected', () => {
    expect(AppointmentSlot.safeParse(slot({ end: phoneSlot.start })).success).toBe(false);
    expect(AppointmentSlot.safeParse(slot({ end: '2026-10-07T16:59:00.000Z' })).success).toBe(false);
  });

  it('6: a first name with markup is rejected', () => {
    expect(AppointmentSlot.safeParse(slot({ specialistFirstName: 'Seth<script>' })).success).toBe(false);
  });

  it('8: an extra key is rejected (.strict())', () => {
    expect(AppointmentSlot.safeParse(slot({ extra: 1 })).success).toBe(false);
  });

  it.each([
    ['slot id p0', { id: 'p0' }],
    ['slot id p10', { id: 'p10' }],
    ['a user id that is not a User (00Q)', { specialistSfUserId: '00Q8X00000Fsx39QAB' }],
    ['a start without an offset', { start: '2026-10-07T17:00:00' }],
    ['a zone with a space', { timeZone: 'America/Los Angeles' }],
  ])('rejects %s', (_label, patch) => {
    expect(AppointmentSlot.safeParse(slot(patch)).success).toBe(false);
  });

  it('SLOT_ID is p or w and one digit 1-9', () => {
    expect(SLOT_ID.test('p1')).toBe(true);
    expect(SLOT_ID.test('w9')).toBe(true);
    expect(SLOT_ID.test('x1')).toBe(false);
  });

  it('IanaZone accepts two- and three-part zones', () => {
    expect(IanaZone.safeParse('America/Los_Angeles').success).toBe(true);
    expect(IanaZone.safeParse('America/Argentina/Buenos_Aires').success).toBe(true);
    expect(IanaZone.safeParse('UTC').success).toBe(false);
  });
});

describe('AppointmentSlots', () => {
  it('accepts up to 12 slots with unique ids', () => {
    const slots = Array.from({ length: 6 }, (_, i) => slot({ id: `p${i + 1}` }));
    expect(AppointmentSlots.safeParse(slots).success).toBe(true);
  });

  it('4: duplicate ids are rejected', () => {
    expect(AppointmentSlots.safeParse([phoneSlot, phoneSlot]).success).toBe(false);
  });

  it('5: 13 slots are rejected', () => {
    const slots = Array.from({ length: 13 }, (_, i) => slot({ id: i < 9 ? `p${i + 1}` : `w${i - 8}`, kind: i < 9 ? 'phone' : 'walkthrough' }));
    expect(AppointmentSlots.safeParse(slots).success).toBe(false);
  });
});

describe('BookedAppointment and CallContext', () => {
  const booked = {
    slotId: 'w2', kind: 'walkthrough', start: '2026-10-08T16:00:00.000Z', end: '2026-10-08T17:00:00.000Z',
    specialistSfUserId: GRANT, addressConfirmed: true, note: 'Gate code at the side door', bookedAt: '2026-10-06T18:00:00.000Z',
  };
  it('a booking parses; an extra key or a 301-character note does not', () => {
    expect(BookedAppointment.parse(booked)).toEqual(booked);
    expect(BookedAppointment.safeParse({ ...booked, extra: 1 }).success).toBe(false);
    expect(BookedAppointment.safeParse({ ...booked, note: 'x'.repeat(301) }).success).toBe(false);
  });
  it('the call context says whether the seller is returning', () => {
    expect(CallContext.parse({ returning: true })).toEqual({ returning: true });
    expect(CallContext.safeParse({ returning: true, extra: 1 }).success).toBe(false);
  });
});

describe('booking settings', () => {
  it('a full booking setting parses', () => {
    expect(AiCallBookingSettings.parse(booking)).toEqual(booking);
    expect(AiCallSettings.parse({ booking, writeback: true }).writeback).toBe(true);
  });

  it.each([
    ['endHour <= startHour', { endHour: 10 }],
    ['stepMinutes 20', { stepMinutes: 20 }],
    ['maxOffered 7', { maxOffered: 7 }],
    ['an extra key', { extra: 1 }],
  ])('7: phone settings with %s are rejected', (_label, patch) => {
    expect(AiCallBookingSettings.safeParse({ ...booking, phone: { ...kind, ...patch } }).success).toBe(false);
  });

  it('7b: useRecordOwner (removed: one appointment owner) is rejected', () => {
    expect(AiCallBookingSettings.safeParse({ ...booking, useRecordOwner: true }).success).toBe(false);
  });

  it('8: an extra key on the settings is rejected', () => {
    expect(AiCallSettings.safeParse({ booking, writeback: true, extra: 1 }).success).toBe(false);
  });

  it('specialists are User ids, at most 20; days are 1-7, at least one', () => {
    expect(AiCallBookingSettings.safeParse({ ...booking, specialists: ['00Q8X00000Fsx39QAB'] }).success).toBe(false);
    expect(AiCallBookingSettings.safeParse({ ...booking, specialists: Array.from({ length: 21 }, () => GRANT) }).success).toBe(false);
    expect(AiCallBookingSettings.safeParse({ ...booking, days: [] }).success).toBe(false);
    expect(AiCallBookingSettings.safeParse({ ...booking, days: [0] }).success).toBe(false);
    // sweep D-8: each weekday once.
    expect(AiCallBookingSettings.safeParse({ ...booking, days: [1, 2, 2] }).success).toBe(false);
  });
});

describe('WritebackReadiness', () => {
  it('carries conversion readiness, record types, the appointment owner and the problems', () => {
    const r = {
      ready: false,
      convertReady: false,
      convertRecordTypes: { account: 'Person Account', opportunity: null },
      appointmentOwner: { id: GRANT, name: 'Grant Golden', title: null, isActive: true },
      items: [{ object: 'Lead', field: null, label: 'Convert Leads', problem: 'cannot_convert' }],
    };
    expect(WritebackReadiness.parse(r)).toEqual(r);
    expect(WritebackReadiness.safeParse({ ...r, items: [{ ...r.items[0], problem: 'nope' }] }).success).toBe(false);
  });
});

describe('bookingStands (Part 4 Fix 1, I-1)', () => {
  const ENDED = new Date('2026-10-06T18:00:00Z');
  it.each([
    [null, null, true],
    [null, ENDED, false],
    ['appointment_set', null, true],
    ['appointment_set', ENDED, true],
    ['qualified_transferred', ENDED, true],
    ['transfer_failed', ENDED, true],
    ['do_not_call', null, false],
    ['do_not_call', ENDED, false],
    ['wrong_number', ENDED, false],
    ['not_interested', ENDED, false],
    ['qualified_callback', ENDED, false],
    ['hung_up', ENDED, false],
    ['other', ENDED, false],
  ] as const)('outcome %s, ended %s → %s', (outcome, endedAt, want) => {
    expect(bookingStands({ outcome, endedAt })).toBe(want);
  });

  it('the standing outcomes are exactly these', () => {
    expect([...BOOKING_STANDS_OUTCOMES]).toEqual(['appointment_set', 'qualified_transferred', 'transfer_failed']);
  });
});

describe('the blocked time (Part 4 Fix 1, I-3: the walkthrough travel buffer)', () => {
  const walk = slot({ id: 'w1', kind: 'walkthrough', start: '2026-10-08T16:00:00.000Z', end: '2026-10-08T17:00:00.000Z' });
  const blocked = { ...walk, blockStart: '2026-10-08T15:30:00.000Z', blockEnd: '2026-10-08T17:30:00.000Z' };

  it('a slot may carry blockStart / blockEnd; a slot without them (an older outreach-api) still parses', () => {
    expect(AppointmentSlot.parse(blocked)).toEqual(blocked);
    expect(AppointmentSlot.parse(walk)).toEqual(walk);
    expect(AppointmentSlots.safeParse([phoneSlot, blocked]).success).toBe(true);
  });

  it('the block must hold the slot: never starting after it, never ending before it, and real instants', () => {
    expect(AppointmentSlot.safeParse({ ...blocked, blockStart: '2026-10-08T16:30:00.000Z' }).success).toBe(false);
    expect(AppointmentSlot.safeParse({ ...blocked, blockEnd: '2026-10-08T16:30:00.000Z' }).success).toBe(false);
    expect(AppointmentSlot.safeParse({ ...blocked, blockStart: 'soon' }).success).toBe(false);
    expect(AppointmentSlot.safeParse({ ...walk, blockStart: walk.start, blockEnd: walk.end }).success).toBe(true);
  });

  it('a booking may carry the block too; an older booking without it still parses', () => {
    const booked = {
      slotId: 'w1', kind: 'walkthrough', start: walk.start, end: walk.end, specialistSfUserId: GRANT, addressConfirmed: true, note: '',
      bookedAt: '2026-10-06T18:00:00.000Z',
    };
    const withBlock = { ...booked, blockStart: blocked.blockStart, blockEnd: blocked.blockEnd };
    expect(BookedAppointment.parse(withBlock)).toEqual(withBlock);
    expect(BookedAppointment.parse(booked)).toEqual(booked);
    expect(BookedAppointment.safeParse({ ...booked, blockEnd: 'later' }).success).toBe(false);
  });
});
