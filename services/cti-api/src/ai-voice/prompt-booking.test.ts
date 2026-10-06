import { describe, expect, it } from 'vitest';
import type { AppointmentSlot } from '@cti/contracts';
import { context } from './prompt-context.js';
import type { PromptInput } from './prompt.js';
import { bookingSection, slotWords } from './prompt-booking.js';
import { buildInstructions } from './prompt.js';

const LA = 'America/Los_Angeles';
const OWNER = '0058X00000Fsx39QAB';

function slot(over: Partial<AppointmentSlot> = {}): AppointmentSlot {
  return {
    id: 'p1',
    kind: 'phone',
    // Wednesday, October 7 2026, 11:00 AM Pacific (PDT, UTC-7).
    start: '2026-10-07T18:00:00.000Z',
    end: '2026-10-07T18:15:00.000Z',
    specialistSfUserId: OWNER,
    specialistFirstName: 'Grant',
    timeZone: LA,
    ...over,
  };
}

const walk = (over: Partial<AppointmentSlot> = {}): AppointmentSlot =>
  slot({ id: 'w1', kind: 'walkthrough', start: '2026-10-08T16:00:00.000Z', end: '2026-10-08T17:00:00.000Z', ...over });

function input(over: Partial<PromptInput> = {}): PromptInput {
  return {
    agentName: 'Ava',
    companyName: 'GG Homes',
    firstName: 'Jane',
    address: '1234 Oak St, Tampa, FL 33601',
    notes: '',
    isTest: false,
    localTime: 'Tuesday 4:12 PM',
    callbackNumber: null,
    ...over,
  };
}

describe('slotWords', () => {
  it('says the day, date and hour in the seller zone when it is the specialist zone', () => {
    expect(slotWords(slot(), LA)).toBe('Wednesday, October 7 at 11 AM');
  });

  it('keeps the minutes when the time is not on the hour', () => {
    expect(slotWords(slot({ start: '2026-10-07T18:30:00.000Z', end: '2026-10-07T18:45:00.000Z' }), LA)).toBe(
      'Wednesday, October 7 at 11:30 AM',
    );
  });

  it('a seller in another zone hears their own time first, then the specialist time', () => {
    expect(slotWords(slot(), 'America/New_York')).toBe('Wednesday, October 7 at 2 PM their time, 11 AM Pacific');
  });

  it('adds no note when the other zone reads the same clock time (Phoenix in summer)', () => {
    expect(slotWords(slot(), 'America/Phoenix')).toBe('Wednesday, October 7 at 11 AM');
  });

  it('uses only plain spaces (no narrow no-break space before AM/PM)', () => {
    expect(slotWords(slot(), 'America/Chicago')).not.toMatch(/[  ]/);
  });
});

describe('bookingSection', () => {
  it('is null without slots', () => {
    expect(bookingSection(context(input()))).toBeNull();
    expect(bookingSection(context(input({ slots: [] })))).toBeNull();
  });

  it('lists the offered times by id, in order, in the seller time', () => {
    const text = bookingSection(context(input({ slots: [slot(), slot({ id: 'p2', start: '2026-10-07T21:00:00.000Z', end: '2026-10-07T21:15:00.000Z' }), walk()], sellerTimeZone: LA })))!;
    expect(text.startsWith('# Booking an appointment')).toBe(true);
    const list = text.slice(text.indexOf('Times you can offer (their local time):'));
    expect(list.split('\n').slice(1)).toEqual([
      '- p1: phone call, Wednesday, October 7 at 11 AM',
      '- p2: phone call, Wednesday, October 7 at 2 PM',
      '- w1: walkthrough, Thursday, October 8 at 9 AM',
    ]);
  });

  it('names the specialist, the two kinds, the walkthrough address rule and the booking rules', () => {
    const text = bookingSection(context(input({ slots: [slot(), walk()], sellerTimeZone: LA })))!;
    expect(text).toContain('- You can book a time with Grant, one of our specialists. Two kinds:');
    expect(text).toContain('  - a quick phone call (about fifteen minutes), or');
    expect(text).toContain('  - an in-person walkthrough of the house (about an hour).');
    expect(text).toContain('Then offer TWO times of that kind from the list below, in their time, and let them choose. If neither works, offer the next two.');
    expect(text).toContain('"That\'s the property at 1234 Oak Street, right?" Only book it once they say yes (address_confirmed true).');
    expect(text).toContain('Book only a time from this list, by its id. Never make up a time, and never promise a time you haven\'t booked.');
    expect(text).toContain('then end_call with outcome "appointment_set".');
    expect(text).toContain('- If no time works: schedule_callback instead.');
  });

  it('tells the agent to say times the way people do, never digits', () => {
    const text = bookingSection(context(input({ slots: [slot()], sellerTimeZone: LA })))!;
    expect(text).toMatch(/"Thursday at two in the afternoon"/);
    expect(text).toMatch(/never read out digits/i);
  });

  it('says "one of our specialists" when the slot has no first name', () => {
    const text = bookingSection(context(input({ slots: [slot({ specialistFirstName: null }), walk({ specialistFirstName: null })], sellerTimeZone: LA })))!;
    expect(text).toContain('- You can book a time with one of our specialists. Two kinds:');
    const phoneOnly = bookingSection(context(input({ slots: [slot({ specialistFirstName: null })], sellerTimeZone: LA })))!;
    expect(phoneOnly).toContain('- You can book a quick phone call (about fifteen minutes) with one of our specialists.');
  });

  it('sanitises a first name carrying markup', () => {
    const text = bookingSection(context(input({ slots: [slot({ specialistFirstName: 'Gr#a"n<t>' })], sellerTimeZone: LA })))!;
    expect(text).toContain('with Grant, one of our specialists');
    expect(text).not.toContain('Gr#a');
    expect(text).not.toContain('<t>');
  });

  it('falls back to the slot zone, then Pacific, when the seller zone is unknown or invalid', () => {
    const ny = slot({ timeZone: 'America/New_York' });
    expect(context(input({ slots: [ny] })).sellerTz).toBe('America/New_York');
    expect(context(input({ slots: [ny], sellerTimeZone: null })).sellerTz).toBe('America/New_York');
    expect(context(input({})).sellerTz).toBe(LA);
    expect(context(input({ slots: [ny], sellerTimeZone: 'Not/AZone' })).sellerTz).toBe('America/New_York');
  });

  it('drops a slot whose id or times are malformed instead of rendering it', () => {
    const c = context(input({ slots: [slot({ id: 'x1' }), slot({ id: 'p2', start: 'soon' }), slot({ id: 'p3' })], sellerTimeZone: LA }));
    expect(c.slots.map((s) => s.id)).toEqual(['p3']);
  });
});

describe('Fix 1 M-1: only the kinds on offer', () => {
  it('phone calls only: the section offers a quick phone call, never a walkthrough, and does not ask which kind', () => {
    const text = bookingSection(context(input({ slots: [slot(), slot({ id: 'p2', start: '2026-10-07T21:00:00.000Z', end: '2026-10-07T21:15:00.000Z' })], sellerTimeZone: LA })))!;
    expect(text).toContain('- You can book a quick phone call (about fifteen minutes) with Grant, one of our specialists.');
    expect(text).toContain('- Offer TWO times from the list below, in their time, and let them choose. If neither works, offer the next two.');
    expect(text).not.toMatch(/walkthrough|Two kinds|which they'd prefer/);
  });

  it('walkthroughs only: the section offers a walkthrough, confirms the property, and never offers a phone call instead', () => {
    const text = bookingSection(context(input({ slots: [walk()], sellerTimeZone: LA })))!;
    expect(text).toContain('- You can book an in-person walkthrough of the house (about an hour) with Grant, one of our specialists.');
    expect(text).toContain('"That\'s the property at 1234 Oak Street, right?" Only book it once they say yes (address_confirmed true).');
    expect(text).toContain("If it's a different property, don't book it; offer to have the specialist call them back instead (schedule_callback).");
    expect(text).not.toMatch(/phone call|Two kinds|which they'd prefer/);
  });

  it('both kinds: asks which they prefer, as before', () => {
    const text = bookingSection(context(input({ slots: [slot(), walk()], sellerTimeZone: LA })))!;
    expect(text).toContain("- Ask which they'd prefer. Then offer TWO times of that kind");
    expect(text).toContain("If it's a different property, don't book a walkthrough; offer the phone call instead.");
  });
});

describe('Fix 1 M-6: the role section names a booked appointment as a good ending when there are times to offer', () => {
  it('with slots', () => {
    expect(buildInstructions(input({ slots: [slot()], sellerTimeZone: LA }))).toContain(
      '- A good call ends in a warm hand-off, a booked appointment, a scheduled callback, or a polite goodbye. Never an offer, never a hard sell.',
    );
  });

  it('without slots it is unchanged', () => {
    const text = buildInstructions(input());
    expect(text).toContain('- A good call ends in a warm hand-off, a scheduled callback, or a polite goodbye. Never an offer, never a hard sell.');
    expect(text).not.toContain('booked appointment');
  });
});
