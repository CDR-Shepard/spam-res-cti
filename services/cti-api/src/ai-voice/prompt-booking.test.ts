import { describe, expect, it } from 'vitest';
import type { AppointmentSlot, ConsultationFact, PriorityOffer } from '@cti/contracts';
import { context, promptPriority, promptSlots } from './prompt-context.js';
import type { PromptInput } from './prompt.js';
import { slotWords } from './prompt-booking.js';
import { promptView } from './prompt-view.js';
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

/** The section of `text` from `heading` up to the next top-level heading, or null when there is none. */
function sectionOf(text: string, heading: string): string | null {
  const at = text.indexOf(heading);
  if (at < 0) return null;
  const end = text.indexOf('\n\n# ', at);
  return text.slice(at, end < 0 ? undefined : end);
}

/** The Booking section of the full instructions, or null when there is none. */
function bookingSection(p: PromptInput): string | null {
  return sectionOf(buildInstructions(p), '# Booking an appointment');
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
    expect(slotWords(slot(), 'America/Chicago')).not.toMatch(/[\u202F\u00A0]/);
  });
});

describe('bookingSection', () => {
  it('is null without slots', () => {
    expect(bookingSection(input())).toBeNull();
    expect(bookingSection(input({ slots: [] }))).toBeNull();
  });

  it('lists the offered times by id, in order, in the seller time, with who each one is with', () => {
    const text = bookingSection(input({ slots: [slot(), slot({ id: 'p2', start: '2026-10-07T21:00:00.000Z', end: '2026-10-07T21:15:00.000Z' }), walk()], sellerTimeZone: LA }))!;
    expect(text.startsWith('# Booking an appointment')).toBe(true);
    const list = text.slice(text.indexOf('Times you can offer (their local time):'));
    expect(list.split('\n').slice(1)).toEqual([
      '- p1: phone consultation with Grant, Wednesday, October 7 at 11 AM',
      '- p2: phone consultation with Grant, Wednesday, October 7 at 2 PM',
      '- w1: in-person consultation with Grant, Thursday, October 8 at 9 AM',
    ]);
  });

  it('offers in person first, by phone only if they want no one at the house, confirms the property, and the booking rules', () => {
    const text = bookingSection(input({ slots: [slot(), walk()], sellerTimeZone: LA }))!;
    expect(text).toContain(
      '- First offer an in-person consultation at the house (about an hour) with one of our specialists. Offer TWO in-person times from the list below, in their time, and say who it\'s with — e.g. "Thursday at eleven with Blake". If neither works, offer the next two.',
    );
    expect(text).toContain(
      "- Only if they don't want anyone coming out to the house, offer a phone consultation (about an hour) instead: TWO phone times from the list.",
    );
    expect(text.indexOf('First offer an in-person consultation')).toBeLessThan(text.indexOf("Only if they don't want anyone coming out"));
    expect(text).toContain(
      '- Before booking an in-person time, confirm the property: "That\'s the property at 1234 Oak Street, right?" Only book it once they say yes (address_confirmed true). If it\'s a different property, offer a phone consultation instead.',
    );
    expect(text).toContain('Book only a time from this list, by its id. Never make up a time, and never promise a time you haven\'t booked.');
    expect(text).toContain(
      '- Call book_appointment silently. Then confirm the day, the time and who it\'s with in ONE line with your goodbye, then end_call with outcome "appointment_set".',
    );
    expect(text).toContain('- If no time works: schedule_callback instead.');
  });

  it('says the times are listed right here: offer them straight away, never say you are checking or thinking about them', () => {
    const text = bookingSection(input({ slots: [slot()], sellerTimeZone: LA }))!;
    expect(text).toContain('- The times are listed right here: offer them straight away. Never say you\'re checking or thinking about the times.');
  });

  it('tells the agent to say times the way people do, never digits', () => {
    const text = bookingSection(input({ slots: [slot()], sellerTimeZone: LA }))!;
    expect(text).toMatch(/"Thursday at two in the afternoon"/);
    expect(text).toMatch(/never read out digits/i);
  });

  it('a time whose specialist has no first name names no one', () => {
    const text = bookingSection(input({ slots: [slot({ specialistFirstName: null }), walk({ specialistFirstName: null })], sellerTimeZone: LA }))!;
    expect(text).toContain('- p1: phone consultation, Wednesday, October 7 at 11 AM');
    expect(text).toContain('- w1: in-person consultation, Thursday, October 8 at 9 AM');
  });

  it('sanitises a first name carrying markup', () => {
    const text = bookingSection(input({ slots: [slot({ specialistFirstName: 'Gr#a"n<t>' })], sellerTimeZone: LA }))!;
    expect(text).toContain('- p1: phone consultation with Grant, ');
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

describe('only the kinds on offer (Fix 1 M-1, routing step 1 words)', () => {
  it('phone consultations only: books by phone, never in person, and never puts in-person first', () => {
    const text = bookingSection(input({ slots: [slot(), slot({ id: 'p2', start: '2026-10-07T21:00:00.000Z', end: '2026-10-07T21:15:00.000Z' })], sellerTimeZone: LA }))!;
    expect(text).toContain(
      "- You can book a phone consultation (about an hour) with one of our specialists. Offer TWO times from the list below, in their time, and say who it's with. If neither works, offer the next two.",
    );
    expect(text).not.toMatch(/in-person|walkthrough|First offer|Only if they don't want/);
  });

  it('in-person consultations only: offers in person, confirms the property, and never offers a phone consultation instead', () => {
    const text = bookingSection(input({ slots: [walk()], sellerTimeZone: LA }))!;
    expect(text).toContain('- First offer an in-person consultation at the house (about an hour) with one of our specialists.');
    expect(text).toContain('"That\'s the property at 1234 Oak Street, right?" Only book it once they say yes (address_confirmed true).');
    expect(text).toContain("If it's a different property, don't book it; offer to have the specialist call them back instead (schedule_callback).");
    expect(text).not.toMatch(/phone consultation|Only if they don't want/);
  });

  it('both kinds: in person first, by phone as the fallback for a different property', () => {
    const text = bookingSection(input({ slots: [slot(), walk()], sellerTimeZone: LA }))!;
    expect(text).toContain("- Only if they don't want anyone coming out to the house, offer a phone consultation (about an hour) instead");
    expect(text).toContain("If it's a different property, offer a phone consultation instead.");
    expect(text).not.toMatch(/Two kinds|which they'd prefer|walkthrough/);
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

describe('final review I-1: a walkthrough needs a street address to confirm', () => {
  it('drops walkthrough slots (list and offer words) when the record has no address; phone slots stay', () => {
    const p = input({ address: null, slots: [slot(), walk()], sellerTimeZone: LA });
    expect(context(p).slots.map((s) => s.id)).toEqual(['p1']);
    const text = bookingSection(p)!;
    expect(text).not.toMatch(/in-person|walkthrough|w1/);
    expect(text).not.toContain("That's the property, right?");
  });

  it('drops walkthrough slots when the address has only a city', () => {
    const c = context(input({ address: 'Tampa, FL 33601', slots: [slot(), walk()], sellerTimeZone: LA }));
    expect(c.slots.map((s) => s.id)).toEqual(['p1']);
  });

  it('walkthroughs only and no street: nothing to offer, so no booking section', () => {
    expect(bookingSection(input({ address: null, slots: [walk()], sellerTimeZone: LA }))).toBeNull();
  });

  it('keeps walkthrough slots when the address has a street', () => {
    expect(context(input({ slots: [slot(), walk()], sellerTimeZone: LA })).slots.map((s) => s.id)).toEqual(['p1', 'w1']);
  });

  it('promptSlots applies the same rule, so the tool enum and the bookable list agree with the prompt', () => {
    expect(promptSlots([slot(), walk()], null).map((s) => s.id)).toEqual(['p1']);
    expect(promptSlots([slot(), walk()], '1234 Oak St, Tampa, FL 33601').map((s) => s.id)).toEqual(['p1', 'w1']);
  });

  // Final review C1: outreach-api now sends walkthrough slots and the priority offer for these, so they must survive here.
  it.each([
    '1234 N Main St, Santa Ana, CA 92701',
    '4500 W Pico Blvd, Los Angeles, CA 90019',
    '456 3rd Ave, Chula Vista, CA 91910',
    '100 N. Tustin Ave, Orange, CA 92867',
    '1200 E 7th St, Long Beach',
    '3300 Calle Zoomar, San Clemente, CA 92673',
  ])('a directional or numbered street keeps walkthrough slots and the priority offer: %s', (address) => {
    expect(promptSlots([slot(), walk()], address).map((s) => s.id)).toEqual(['p1', 'w1']);
    expect(promptPriority(GRANT, address)).not.toBeNull();
  });
});

// Routing step 1 (Task 11): what Sam is told about earlier and booked consultations, who each time is with, and high priority.
const IN_2026 = 'Tuesday, October 20, 2026, 9:12 AM';
const LAST: ConsultationFact = { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' };
const NEXT: ConsultationFact = { start: '2026-10-21T18:00:00.000Z', kind: 'phone', ownerName: 'Seth Boisvert' };
const GRANT: PriorityOffer = { specialistSfUserId: OWNER, specialistFirstName: 'Grant', timeZone: LA, defaultStart: '2026-10-20T16:00:00.000Z' };
const consulted = (last: ConsultationFact | null, next: ConsultationFact | null = null) => ({ consultations: { last, next } });
const view = (over: Partial<PromptInput>) => ({ ...promptView(input({ localTime: IN_2026, ...over })) });

describe('promptView: an earlier consultation', () => {
  it('on file: had_consultation, the day without the year (same year), the first name, in person', () => {
    expect(view(consulted(LAST))).toMatchObject({
      had_consultation: true,
      last_consultation_when: 'March 12',
      last_consultation_with: 'Blake',
      last_consultation_in_person: true,
    });
  });

  it('in another year: the day says the year', () => {
    expect(view(consulted({ ...LAST, start: '2025-03-12T17:00:00.000Z' })).last_consultation_when).toBe('March 12, 2025');
  });

  it('when the local time names no year, the day always says it (never a guessed year)', () => {
    expect(view({ localTime: 'Tuesday 4:12 PM', ...consulted(LAST) }).last_consultation_when).toBe('March 12, 2026');
  });

  it('the day is the one in the seller zone', () => {
    // 03:30 UTC on March 13 is still the evening of March 12 in New York.
    const late = { ...LAST, start: '2026-03-13T03:30:00.000Z' };
    expect(view({ sellerTimeZone: 'America/New_York', ...consulted(late) }).last_consultation_when).toBe('March 12');
  });

  it('by phone with no owner: not in person, and with no one', () => {
    expect(view(consulted({ ...LAST, kind: 'phone', ownerName: null }))).toMatchObject({
      had_consultation: true,
      last_consultation_with: '',
      last_consultation_in_person: false,
    });
  });

  it('none on file, or a start that is not a time: no section and every value empty', () => {
    const empty = {
      had_consultation: false,
      last_consultation_when: '',
      last_consultation_with: '',
      last_consultation_in_person: false,
      has_booked_consultation: false,
      booked_consultation_text: '',
    };
    expect(view({})).toMatchObject(empty);
    expect(view(consulted(null, null))).toMatchObject(empty);
    expect(view(consulted({ ...LAST, start: 'soon' }, { ...NEXT, start: 'soon' }))).toMatchObject(empty);
  });
});

describe('promptView: a booked consultation', () => {
  it('by phone with Seth: the day, time, who and how, in the seller zone', () => {
    expect(view(consulted(null, NEXT))).toMatchObject({
      has_booked_consultation: true,
      booked_consultation_text: 'Wednesday, October 21 at 11 AM with Seth, by phone',
      had_consultation: false,
    });
  });

  it('in person, and with no one named when the owner is unknown', () => {
    expect(view(consulted(null, { ...NEXT, kind: 'in_person' })).booked_consultation_text).toBe('Wednesday, October 21 at 11 AM with Seth, in person');
    expect(view(consulted(null, { ...NEXT, ownerName: null })).booked_consultation_text).toBe('Wednesday, October 21 at 11 AM, by phone');
  });
});

describe('promptView: who each time is with, and high priority', () => {
  it('time_with is each slot\'s specialist first name, or empty', () => {
    const v = view({ slots: [slot({ specialistFirstName: 'Blake' }), walk({ specialistFirstName: 'Seth' }), slot({ id: 'p2', specialistFirstName: null })], sellerTimeZone: LA });
    expect((v.appointment_times as ReadonlyArray<Record<string, string>>).map((t) => t.time_with)).toEqual(['Blake', 'Seth', '']);
  });

  // Final review I2: specialist_name is kept for saved custom templates ("book a time with {{specialist_name}}").
  it('specialist_name: the one rep every offered time is with', () => {
    const blake = { specialistSfUserId: '0058X00000FA8tLQAT', specialistFirstName: 'Blake' };
    expect(view({ slots: [slot(blake), walk(blake)], sellerTimeZone: LA }).specialist_name).toBe('Blake');
  });

  it('specialist_name: times with more than one rep say "one of our specialists", never the first rep for all', () => {
    const blake = { specialistSfUserId: '0058X00000FA8tLQAT', specialistFirstName: 'Blake' };
    const chance = { specialistSfUserId: '0055f000005qXn8AAE', specialistFirstName: 'Chance' };
    expect(view({ slots: [slot(blake), walk(chance)], sellerTimeZone: LA }).specialist_name).toBe('one of our specialists');
  });

  it('a priority offer: can_book_priority and can_book_any, Grant, and the default start in the seller zone', () => {
    expect(view({ priority: GRANT })).toMatchObject({
      can_book: false,
      can_book_priority: true,
      can_book_any: true,
      priority_specialist_name: 'Grant',
      priority_default_text: 'Tuesday, October 20 at 9 AM',
    });
  });

  it('a seller in another zone hears the default in their time, then Pacific', () => {
    expect(view({ priority: GRANT, sellerTimeZone: 'America/New_York' }).priority_default_text).toBe(
      'Tuesday, October 20 at 12 PM their time, 9 AM Pacific',
    );
  });

  it('a priority offer whose specialist has no first name: "our specialist"', () => {
    expect(view({ priority: { ...GRANT, specialistFirstName: null } }).priority_specialist_name).toBe('our specialist');
  });

  it('no street to confirm, or no offer: no priority section, and can_book_any only with slots', () => {
    const none = { can_book_priority: false, priority_specialist_name: '', priority_default_text: '' };
    expect(view({ priority: GRANT, address: 'Tampa, FL 33601' })).toMatchObject({ ...none, can_book_any: false });
    expect(view({})).toMatchObject({ ...none, can_book_any: false });
    expect(view({ slots: [slot()] })).toMatchObject({ ...none, can_book_any: true });
  });
});

describe('buildInstructions: consultations and high priority (routing step 1)', () => {
  const build = (over: Partial<PromptInput>) => buildInstructions(input({ localTime: IN_2026, sellerTimeZone: LA, ...over }));
  const toolsOf = (text: string) => text.slice(text.indexOf('# Tools'), text.indexOf('# Voicemail'));
  const endCallLine = (text: string) => toolsOf(text).split('\n').find((l) => l.startsWith('- end_call')) ?? '';

  it('an in-person time with Blake and a phone time: in person first, the list names Blake, by phone only as a fallback', () => {
    const text = build({ slots: [walk({ specialistFirstName: 'Blake' }), slot({ specialistFirstName: null })] });
    expect(text).toContain('First offer an in-person consultation');
    expect(text).toContain('- w1: in-person consultation with Blake, ');
    expect(text).toContain("Only if they don't want anyone coming out");
    expect(toolsOf(text)).toContain(
      '- book_appointment — once they pick one of the offered times (see Booking): slot_id is its id from the list; address_confirmed is true only after they confirmed the property (always for an in-person time); what_changed is what\'s changed since their earlier consultation, in their words (empty if there was none); note is anything the specialist should know. Call it silently. If it says the time was just taken, offer another time from the list.',
    );
    expect(text).not.toMatch(/# High priority|book_priority_appointment/);
  });

  it('a priority offer and no slots: the High priority section, its tool and appointment_set, no Booking section', () => {
    const text = build({ priority: GRANT });
    expect(text).toContain('# High priority');
    expect(text).not.toContain('# Booking an appointment');
    expect(endCallLine(text)).toContain('"appointment_set" (an appointment was booked), ');
    expect(text).toContain('- A good call ends in a warm hand-off, a booked appointment, a scheduled callback');
    expect(text).toContain(
      "- If they want to sell as soon as possible or something is urgent (a foreclosure, an auction date) and they'd rather book than talk now, offer a visit from Grant (see High priority).",
    );
    expect(sectionOf(text, '# High priority')).toBe(
      [
        '# High priority',
        '- Someone is high priority when they want to sell as soon as possible or something is urgent — a foreclosure, an auction date. You judge it from what they tell you.',
        "- For them, offer an in-person consultation with Grant at the time they ask for: any day in the next two weeks, starting between 8 in the morning and 7 at night Pacific time, at least two hours from now. If they don't name a time, offer Tuesday, October 20 at 9 AM.",
        '- Confirm the property first ("That\'s the property at 1234 Oak Street, right?"), then call book_priority_appointment silently with the agreed time in Pacific time, why it\'s urgent in their words, and anything Grant should know.',
        "- Then confirm the day and time in ONE line with your goodbye, and end_call with outcome \"appointment_set\". If it says the time doesn't work, offer one that does.",
      ].join('\n'),
    );
    expect(toolsOf(text)).toContain(
      "- book_priority_appointment — for a high-priority seller (see High priority): start is the agreed time as YYYY-MM-DDTHH:MM in Pacific time; address_confirmed true once they confirmed the property; reason is why it's urgent; what_changed is what's changed since their earlier consultation, in their words (empty if there was none); note is anything Grant should know. Call it silently.",
    );
  });

  it('fix round 1: a priority-only call never mentions book_appointment, which it is not offered', () => {
    const text = build({ priority: GRANT, ...consulted(LAST) });
    const line = toolsOf(text).split('\n').find((l) => l.startsWith('- book_priority_appointment')) ?? '';
    expect(line).toContain("what_changed is what's changed since their earlier consultation, in their words (empty if there was none)");
    expect(line).not.toContain('book_appointment');
    expect(text).not.toContain('book_appointment');
  });

  it('slots and a priority offer: High priority comes after Booking and before Do-not-call', () => {
    const text = build({ slots: [slot()], priority: GRANT });
    const booking = text.indexOf('# Booking an appointment');
    const priority = text.indexOf('# High priority');
    expect(booking).toBeGreaterThanOrEqual(0);
    expect(priority).toBeGreaterThan(booking);
    expect(text.indexOf('# Do-not-call')).toBeGreaterThan(priority);
  });

  it('an upcoming consultation: confirm it, book nothing, and end_call offers already_booked', () => {
    const text = build(consulted(null, NEXT));
    expect(sectionOf(text, '# Their consultation is already booked')).toBe(
      [
        '# Their consultation is already booked',
        "- They already have a consultation booked: Wednesday, October 21 at 11 AM with Seth, by phone. Don't book another one.",
        "- Confirm it with them — the day, the time and who it's with — and answer what you can. If that time no longer works, offer to have the team call them to move it (schedule_callback).",
        '- Then say goodbye and end_call with outcome "already_booked".',
      ].join('\n'),
    );
    expect(text).toContain("Don't book another one");
    expect(endCallLine(text)).toContain('"already_booked" (they already had one booked and you confirmed it), "hung_up"');
    expect(endCallLine(text)).not.toContain('appointment_set');
  });

  it('an earlier consultation: Sam brings it up and passes what changed when she books', () => {
    const text = build({ slots: [slot()], ...consulted(LAST) });
    expect(sectionOf(text, '# Their earlier consultation')).toBe(
      [
        '# Their earlier consultation',
        "- We've met with them before: an in-person consultation on March 12 with Blake.",
        '- Bring it up yourself, early and warmly — e.g. "I see we came out back on March 12 — what\'s changed since then?"',
        '- Listen to what changed, then still offer a new consultation. When you book, pass what changed, in their words, as what_changed.',
      ].join('\n'),
    );
    expect(text.indexOf('# Their earlier consultation')).toBeLessThan(text.indexOf('# Booking an appointment'));
  });

  it('fix round 1: an earlier and an upcoming consultation with nothing to book (what outreach sends): only listen, never offer a new one', () => {
    const text = build(consulted(LAST, NEXT));
    expect(sectionOf(text, '# Their earlier consultation')).toBe(
      [
        '# Their earlier consultation',
        "- We've met with them before: an in-person consultation on March 12 with Blake.",
        '- Bring it up yourself, early and warmly — e.g. "I see we came out back on March 12 — what\'s changed since then?"',
        '- Listen to what changed.',
      ].join('\n'),
    );
    expect(text).toContain('- Listen to what changed.');
    expect(text).not.toContain('still offer a new consultation');
    expect(text).toContain("Don't book another one");
  });

  it('fix round 1: with only a priority offer to book, an earlier consultation still leads to a new one', () => {
    const text = build({ priority: GRANT, ...consulted(LAST) });
    expect(text).toContain('- Listen to what changed, then still offer a new consultation. When you book, pass what changed, in their words, as what_changed.');
    expect(text).not.toContain('- Listen to what changed.\n');
  });

  it('an earlier phone consultation with no owner named', () => {
    const text = build(consulted({ ...LAST, kind: 'phone', ownerName: null }));
    expect(text).toContain("- We've met with them before: a phone consultation on March 12.");
    expect(text).toContain('"I see we spoke with you back on March 12 — what\'s changed since then?"');
  });

  it('without consultations or a priority offer none of these sections or outcomes appear', () => {
    const text = build({ slots: [slot()] });
    expect(text).not.toMatch(/# Their earlier consultation|# Their consultation is already booked|# High priority|already_booked/);
  });
});
