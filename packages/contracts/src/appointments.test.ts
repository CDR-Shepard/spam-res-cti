import { describe, expect, it } from 'vitest';
import {
  AiCallBookingSettings,
  AiCallSettings,
  AppointmentSlot,
  AppointmentSlots,
  BOOKING_STANDS_OUTCOMES,
  BookedAppointment,
  BookingRouting,
  bookingStands,
  CallContext,
  CONSULTATION_MINUTES,
  ConsultationFact,
  Consultations,
  IanaZone,
  PRIORITY_RULES,
  PRIORITY_SLOT_ID,
  PriorityOffer,
  RegionKey,
  ROUTING_ZONE,
  RoutingReadiness,
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

const CHANCE = '0055f000005qXn8AAE';
const BLAKE = '0058X00000FA8tLQAT';
const SETH = '0055f000005qXVfAAM';
const THOMAS = '0055f000005qYO6AAM';
const OFFICE = '18872 MacArthur Blvd #220, Irvine, CA 92612';
const LA = {
  key: 'LA',
  counties: ['Los Angeles', 'Orange', 'Riverside', 'San Bernardino'],
  reps: [CHANCE, BLAKE],
  startTimes: ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'],
};
const SD = {
  key: 'SD',
  counties: ['San Diego'],
  reps: [SETH, THOMAS],
  startTimes: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'],
};
const routing = { officeAddress: OFFICE, regions: [LA, SD] };
const fact = { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' } as const;

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

describe('routing constants', () => {
  it('pin the spec values', () => {
    expect(ROUTING_ZONE).toBe('America/Los_Angeles');
    expect(CONSULTATION_MINUTES).toBe(60);
    expect(PRIORITY_SLOT_ID).toBe('h1');
    expect(PRIORITY_RULES).toEqual({ minLeadMinutes: 120, maxAheadDays: 14, firstStartHour: 8, endByHour: 20, defaultStartHour: 9, stepMinutes: 15 });
  });
});

describe('booking regions and routing', () => {
  it('a booking blob saved before routing still parses', () => {
    const saved = { ...booking, enabled: true, specialists: ['0058X00000Fsx39QAB'] };
    expect('routing' in saved).toBe(false);
    const parsed = AiCallBookingSettings.safeParse(saved);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.routing).toBeUndefined();
  });

  it('routing: LA and SD parse', () => {
    expect(BookingRouting.parse(routing)).toEqual(routing);
    expect(AiCallBookingSettings.parse({ ...booking, routing }).routing).toEqual(routing);
    expect(AiCallSettings.parse({ booking: { ...booking, routing }, writeback: true }).booking.routing).toEqual(routing);
  });

  const withLa = (patch: Record<string, unknown>) => ({ ...routing, regions: [{ ...LA, ...patch }, SD] });

  it.each([
    ['Orange in both regions', { ...routing, regions: [LA, { ...SD, counties: ['San Diego', 'Orange'] }] }],
    ['a county repeated across regions in another case', { ...routing, regions: [LA, { ...SD, counties: [' orange '] }] }],
    ['startTimes out of order', withLa({ startTimes: ['11:00', '09:00'] })],
    ['startTimes repeated', withLa({ startTimes: ['09:00', '09:00'] })],
    ['a start time 9:00 without its zero', withLa({ startTimes: ['9:00', '11:00'] })],
    ['a start time of 24:00', withLa({ startTimes: ['09:00', '24:00'] })],
    ['a lowercase key', withLa({ key: 'la' })],
    ['a 7-letter key', withLa({ key: 'ABCDEFG' })],
    ['a one-letter key', withLa({ key: 'L' })],
    ['an office address of x', { ...routing, officeAddress: 'x' }],
    ['a 201-character office address', { ...routing, officeAddress: 'x'.repeat(201) }],
    ['the same key twice', { ...routing, regions: [LA, { ...SD, key: 'LA' }] }],
    ['no regions', { ...routing, regions: [] }],
    ['seven regions', { ...routing, regions: Array.from({ length: 7 }, (_, i) => ({ ...LA, key: `R${'ABCDEFG'[i]}`, counties: [`County ${i}`] })) }],
    ['no counties', withLa({ counties: [] })],
    ['a 1-character county', withLa({ counties: ['L'] })],
    ['thirteen counties', withLa({ counties: Array.from({ length: 13 }, (_, i) => `County ${i}`) })],
    ['seven reps', withLa({ reps: Array.from({ length: 7 }, () => CHANCE) })],
    ['a rep that is not a User id', withLa({ reps: ['00Q8X00000Fsx39QAB'] })],
    ['no start times', withLa({ startTimes: [] })],
    ['25 start times', withLa({ startTimes: Array.from({ length: 25 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`) })],
    ['an extra key on a region', withLa({ extra: 1 })],
    ['an extra key on routing', { ...routing, extra: 1 }],
  ])('the routing schema rejects %s', (_label, body) => {
    expect(BookingRouting.safeParse(body).success).toBe(false);
  });

  it('a region may have no reps yet', () => {
    expect(BookingRouting.safeParse(withLa({ reps: [] })).success).toBe(true);
  });

  it('region keys are 2 to 6 capital letters', () => {
    expect(RegionKey.safeParse('LA').success).toBe(true);
    expect(RegionKey.safeParse('INLAND').success).toBe(true);
    expect(RegionKey.safeParse('la').success).toBe(false);
    expect(RegionKey.safeParse('L1').success).toBe(false);
  });
});

describe('consultation facts', () => {
  it('context with consultations parses', () => {
    const ctx = { returning: false, consultations: { last: fact, next: null } };
    expect(CallContext.parse(ctx)).toEqual(ctx);
    expect(CallContext.parse({ returning: true })).toEqual({ returning: true });
  });

  it('a name with a # (Team #2) does not parse', () => {
    expect(CallContext.safeParse({ returning: false, consultations: { last: { ...fact, ownerName: 'Team #2' }, next: null } }).success).toBe(false);
  });

  it('an unnamed owner, a phone kind and both facts parse', () => {
    expect(ConsultationFact.safeParse({ ...fact, ownerName: null, kind: 'phone' }).success).toBe(true);
    expect(Consultations.safeParse({ last: fact, next: { ...fact, start: '2026-11-04T18:00:00.000Z' } }).success).toBe(true);
  });

  it.each([
    ['a start that is not a time', { ...fact, start: 'tomorrow' }],
    ['a kind of walkthrough', { ...fact, kind: 'walkthrough' }],
    ['an empty owner name', { ...fact, ownerName: '' }],
    ['an 81-character owner name', { ...fact, ownerName: 'A'.repeat(81) }],
    ['an owner name that starts with a digit', { ...fact, ownerName: '2 Teams' }],
    ['an extra key', { ...fact, extra: 1 }],
  ])('a consultation fact with %s is rejected', (_label, body) => {
    expect(ConsultationFact.safeParse(body).success).toBe(false);
  });

  it('consultations need both last and next, and nothing else', () => {
    expect(Consultations.safeParse({ last: fact }).success).toBe(false);
    expect(Consultations.safeParse({ last: null, next: null, extra: 1 }).success).toBe(false);
  });
});

describe('high-priority booking', () => {
  const offer = { specialistSfUserId: '0058X00000Fsx39QAB', specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles', defaultStart: '2026-10-20T16:00:00.000Z' };

  it('a priority offer parses; a first name may be null', () => {
    expect(PriorityOffer.parse(offer)).toEqual(offer);
    expect(PriorityOffer.safeParse({ ...offer, specialistFirstName: null }).success).toBe(true);
  });

  it.each([
    ['defaultStart: tomorrow', { ...offer, defaultStart: 'tomorrow' }],
    ['a first name with a digit', { ...offer, specialistFirstName: 'Grant2' }],
    ['a rep that is not a User id', { ...offer, specialistSfUserId: '00Q8X00000Fsx39QAB' }],
    ['a zone of UTC', { ...offer, timeZone: 'UTC' }],
    ['an extra key', { ...offer, extra: 1 }],
  ])('a priority offer with %s is rejected', (_label, body) => {
    expect(PriorityOffer.safeParse(body).success).toBe(false);
  });

  const priorityBooked = {
    slotId: 'h1', kind: 'walkthrough', start: '2026-10-20T16:00:00.000Z', end: '2026-10-20T17:00:00.000Z',
    specialistSfUserId: '0058X00000Fsx39QAB', addressConfirmed: true, note: '', bookedAt: '2026-10-20T14:00:00.000Z',
    priority: true, whatChanged: 'now they really want to sell', previousConsultation: fact,
  };

  it('a priority booking parses', () => {
    expect(BookedAppointment.parse(priorityBooked)).toEqual(priorityBooked);
  });

  it('slot ids are p1-p9, w1-w9 or h1, and nothing else', () => {
    for (const slotId of ['h2', 'h0', 'x1', 'p10', 'h']) {
      expect(BookedAppointment.safeParse({ ...priorityBooked, slotId }).success).toBe(false);
    }
    for (const slotId of ['p1', 'w9', 'h1']) {
      expect(BookedAppointment.safeParse({ ...priorityBooked, slotId }).success).toBe(true);
    }
  });

  it('priority is only ever true; whatChanged is at most 300 characters; the previous consultation must be a fact', () => {
    expect(BookedAppointment.safeParse({ ...priorityBooked, priority: false }).success).toBe(false);
    expect(BookedAppointment.safeParse({ ...priorityBooked, whatChanged: 'x'.repeat(301) }).success).toBe(false);
    expect(BookedAppointment.safeParse({ ...priorityBooked, previousConsultation: { ...fact, ownerName: 'Team #2' } }).success).toBe(false);
  });

  it('a booking with a region parses, and an older one without any of the new keys still does', () => {
    const plain = { slotId: 'w1', kind: 'walkthrough', start: '2026-10-08T16:00:00.000Z', end: '2026-10-08T17:00:00.000Z', specialistSfUserId: GRANT, addressConfirmed: false, note: '', bookedAt: '2026-10-06T18:00:00.000Z' };
    expect(BookedAppointment.parse(plain)).toEqual(plain);
    expect(BookedAppointment.parse({ ...plain, region: 'SD' }).region).toBe('SD');
    expect(BookedAppointment.safeParse({ ...plain, region: 'sd' }).success).toBe(false);
  });

  it('a slot with region LA parses; la fails', () => {
    expect(AppointmentSlot.parse(slot({ region: 'LA' })).region).toBe('LA');
    expect(AppointmentSlot.safeParse(slot({ region: 'la' })).success).toBe(false);
    expect(AppointmentSlot.parse(phoneSlot).region).toBeUndefined();
  });
});

describe('routing readiness', () => {
  const readiness = {
    officeAddress: OFFICE,
    mapsConfigured: true,
    regions: [{ key: 'LA', counties: LA.counties, startTimes: LA.startTimes, reps: [{ id: CHANCE, name: 'Chance Lanier', title: null, isActive: true }] }],
  };

  it('parses, and WritebackReadiness carries it as optional and nullable', () => {
    expect(RoutingReadiness.parse(readiness)).toEqual(readiness);
    const base = {
      ready: true,
      convertReady: true,
      convertRecordTypes: { account: null, opportunity: null },
      appointmentOwner: null,
      items: [],
    };
    expect(WritebackReadiness.safeParse(base).success).toBe(true);
    expect(WritebackReadiness.safeParse({ ...base, routing: null }).success).toBe(true);
    expect(WritebackReadiness.parse({ ...base, routing: readiness }).routing).toEqual(readiness);
    expect(WritebackReadiness.safeParse({ ...base, routing: { ...readiness, mapsConfigured: 'yes' } }).success).toBe(false);
  });
});
