/** Task 8 fix 1: the dry-run preview names the Event and the booking as the write-back writes them. */
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { bookedWords, createdRecords, type Booking } from './dry-run-words.js';

/** Wed Oct 21, 9:00 AM PT. */
const PHONE: BookedAppointment = {
  slotId: 'p1', kind: 'phone', start: '2026-10-21T16:00:00.000Z', end: '2026-10-21T17:00:00.000Z', specialistSfUserId: '0058X00000FA8tLQAT',
  addressConfirmed: false, note: '', bookedAt: '2026-10-19T22:10:00.000Z', region: 'LA',
};
const PRIORITY: BookedAppointment = { ...PHONE, slotId: 'h1', kind: 'walkthrough', addressConfirmed: true, priority: true, specialistSfUserId: '0058X00000Fsx39QAB' };
const booking = (booked: BookedAppointment, ownerName: string, ownerFirstName: string): Booking => ({ booked, ownerName, ownerFirstName, convertsWithLeadManager: null });

describe('dry-run words match the write-back', () => {
  it('a high-priority booking: the High Priority Property Consultation Event, and its words', () => {
    const b = booking(PRIORITY, 'Grant Golden', 'Grant');
    expect(createdRecords('Opportunity', b)).toEqual(['Event: High Priority Property Consultation, Wed Oct 21, 9:00 AM PT, owner Grant Golden']);
    expect(bookedWords(b)).toBe('high-priority property consultation with Grant, Wed Oct 21, 9:00 AM PT');
  });

  it('a phone booking: the Phone Consultation Event; a visit is a property consultation', () => {
    const b = booking(PHONE, 'Blake Person', 'Blake');
    expect(createdRecords('Opportunity', b)).toEqual(['Event: Phone Consultation, Wed Oct 21, 9:00 AM PT, owner Blake Person']);
    expect(bookedWords(b)).toBe('phone consultation with Blake, Wed Oct 21, 9:00 AM PT');
    const visit = booking({ ...PHONE, slotId: 'w1', kind: 'walkthrough' }, 'Blake Person', 'Blake');
    expect(createdRecords('Opportunity', visit)).toEqual(['Event: Property Consultation, Wed Oct 21, 9:00 AM PT, owner Blake Person']);
    expect(bookedWords(visit)).toBe('property consultation with Blake, Wed Oct 21, 9:00 AM PT');
  });
});
