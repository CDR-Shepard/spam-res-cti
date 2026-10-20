import { describe, expect, it } from 'vitest';
import type { OwnerUser } from '../appointments/calendar.js';
import { booked, oppBooking } from '../test/render-fixtures.js';
import { appointmentWords, conversionOwnerName, createdLines } from './words.js';

const owner: OwnerUser = { sfUserId: '0058X00000Fsx39QAB', name: 'Grant Golden', firstName: 'Grant', timeZone: 'America/Los_Angeles', isActive: true, zoneRefused: null };
const words = (result: Parameters<typeof appointmentWords>[0]['result'], task: Parameters<typeof appointmentWords>[0]['task'] = null) =>
  appointmentWords({ booked: booked('phone'), result, owner, convertOwner: 'Grant Golden', address: null, sellerZone: null, task });

describe('appointmentWords (final review I-1: only what was made)', () => {
  it('a hold and a Task, both made', () => {
    expect(words({ kind: 'lead_hold', eventId: '00U8X00000Hold1QAA', taskId: '00T8X00000Task1QAA' })).toBe(
      "phone consultation Wed Oct 7, 11:00 AM PT held on Grant Golden's calendar; the Lead was not converted (Task to Grant Golden)",
    );
  });

  it('a refused hold is never said to be held', () => {
    const text = words({ kind: 'lead_hold', eventId: null, taskId: '00T8X00000Task1QAA' })!;
    expect(text).toBe('phone consultation for Wed Oct 7, 11:00 AM PT not held: Salesforce refused the hold; the Lead was not converted (Task to Grant Golden)');
  });

  it('a refused Task is never said to be sent', () => {
    expect(words({ kind: 'lead_hold', eventId: '00U8X00000Hold1QAA', taskId: null, taskCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' })).toBe(
      "phone consultation Wed Oct 7, 11:00 AM PT held on Grant Golden's calendar; the Lead was not converted (the Task to Grant Golden was refused, FIELD_CUSTOM_VALIDATION_EXCEPTION: follow up by hand)",
    );
  });

  it('both refused', () => {
    const text = words({ kind: 'lead_hold', eventId: null, taskId: null })!;
    expect(text).toContain('not held: Salesforce refused the hold');
    expect(text).toContain('the Task to Grant Golden was refused');
  });

  it('a conflict names the Task only when it was made', () => {
    expect(words({ kind: 'conflict' }, { made: true })).toBe('phone consultation for Wed Oct 7, 11:00 AM PT not booked: the calendar was taken (Task to Grant Golden)');
    expect(words({ kind: 'conflict' }, { made: false, code: 'INVALID_CROSS_REFERENCE_KEY' })).toBe(
      'phone consultation for Wed Oct 7, 11:00 AM PT not booked: the calendar was taken (the Task to Grant Golden was refused, INVALID_CROSS_REFERENCE_KEY: follow up by hand)',
    );
    expect(words({ kind: 'conflict' }, null)).toBe('phone consultation for Wed Oct 7, 11:00 AM PT not booked: the calendar was taken');
  });

  it('a refused Event and a passed time say the same about their Task', () => {
    expect(words({ kind: 'refused', code: 'X' }, { made: false })).toContain('(the Task to Grant Golden was refused: follow up by hand)');
    expect(words({ kind: 'expired' }, { made: true })).toContain('(Task to Grant Golden)');
  });
});

describe('Task 8: the consultation kinds in the Chatter words, and the Event by its Subject', () => {
  const walk = booked('walkthrough');
  const priority = { ...walk, slotId: 'h1', priority: true as const };
  const say = (b: typeof walk, result: Parameters<typeof appointmentWords>[0]['result']) => appointmentWords({ booked: b, result, owner, convertOwner: 'Grant Golden', address: null, sellerZone: null, task: null });

  it('a walkthrough is a property consultation; a high-priority one is a high-priority property consultation', () => {
    expect(say(walk, { kind: 'created', eventId: '00U8X00000Evnt1QAA' })).toBe('property consultation with Grant, Wed Oct 7, 11:00 AM PT');
    expect(say(priority, { kind: 'created', eventId: '00U8X00000Evnt1QAA' })).toBe('high-priority property consultation with Grant, Wed Oct 7, 11:00 AM PT');
    expect(say(walk, { kind: 'conflict', reason: 'drive' })).toBe("property consultation for Wed Oct 7, 11:00 AM PT not booked: the rep's calendar no longer leaves time to drive there");
    expect(say(walk, { kind: 'conflict' })).toBe('property consultation for Wed Oct 7, 11:00 AM PT not booked: the calendar was taken');
  });

  it("the changes text's Created line names a high-priority Event by its Subject", () => {
    const { plan } = oppBooking('walkthrough', false);
    const withPriority = { ...plan, appointment: { ...plan.appointment!, booked: priority } };
    const created = { kind: 'created' as const, eventId: '00U8X00000Evnt1QAA' };
    expect(createdLines({ plan: withPriority, result: created, owner, convertOwner: 'Grant Golden', taskId: null })).toEqual(['Event: High Priority Property Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden']);
    expect(createdLines({ plan, result: created, owner, convertOwner: 'Grant Golden', taskId: null })).toEqual(['Event: Property Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden']);
  });
});

describe('final review I3: the booked rep keeps the Event and the hold; the "convert and book" Task is the conversion owner\'s', () => {
  const chance: OwnerUser = { ...owner, sfUserId: '0055f000005qXn8AAE', name: 'Chance Lanier', firstName: 'Chance' };
  const hold = { kind: 'lead_hold' as const, eventId: '00U8X00000Hold1QAA', taskId: '00T8X00000Task1QAA' };
  const { plan } = oppBooking('phone', false);

  it('the Chatter words: held on the booked rep\'s calendar, the Task to the conversion owner', () => {
    expect(appointmentWords({ booked: booked('phone'), result: hold, owner: chance, convertOwner: 'Grant Golden', address: null, sellerZone: null, task: null })).toBe(
      "phone consultation Wed Oct 7, 11:00 AM PT held on Chance Lanier's calendar; the Lead was not converted (Task to Grant Golden)",
    );
  });

  it('the Created lines: the hold on the booked rep\'s calendar, the Task to the conversion owner', () => {
    expect(createdLines({ plan, result: hold, owner: chance, convertOwner: 'Grant Golden', taskId: null })).toEqual([
      "Hold on Chance Lanier's calendar: Wed Oct 7, 11:00 AM PT",
      'Task to Grant Golden: convert the Lead and book it',
    ]);
  });

  it('a booked rep Salesforce did not return is "the booked rep"', () => {
    expect(createdLines({ plan, result: { kind: 'created', eventId: '00U8X00000Evnt1QAA' }, owner: null, convertOwner: 'Grant Golden', taskId: null })).toEqual([
      'Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner the booked rep',
    ]);
    expect(appointmentWords({ booked: booked('phone'), result: { kind: 'conflict' }, owner: null, convertOwner: 'Grant Golden', address: null, sellerZone: null, task: { made: true } })).toBe(
      'phone consultation for Wed Oct 7, 11:00 AM PT not booked: the calendar was taken (Task to the booked rep)',
    );
  });

  it('conversionOwnerName: the appointment owner by name; the booked rep\'s name when the rep was taken instead', () => {
    expect(conversionOwnerName({ sfUserId: owner.sfUserId, name: 'Grant Golden', bookedRep: false }, chance)).toBe('Grant Golden');
    expect(conversionOwnerName({ sfUserId: chance.sfUserId, name: null, bookedRep: true }, chance)).toBe('Chance Lanier');
    expect(conversionOwnerName({ sfUserId: chance.sfUserId, name: null, bookedRep: true }, null)).toBe('the booked rep');
    expect(conversionOwnerName({ sfUserId: owner.sfUserId, name: null, bookedRep: false }, chance)).toBe('the appointment owner');
  });
});
