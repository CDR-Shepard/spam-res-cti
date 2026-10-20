/** Task 8 fix 1: how a booking is named, shared by the Event, the Tasks, the Chatter post and the dry-run preview. */
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { conflictReason, consultationWords, eventSubject, PRIORITY_SUBJECT } from './booking-words.js';
import * as appointment from './appointment.js';

const PHONE: BookedAppointment = {
  slotId: 'p1', kind: 'phone', start: '2026-10-21T16:00:00.000Z', end: '2026-10-21T17:00:00.000Z', specialistSfUserId: '0058X00000FA8tLQAT',
  addressConfirmed: false, note: '', bookedAt: '2026-10-19T22:10:00.000Z',
};
const WALK: BookedAppointment = { ...PHONE, slotId: 'w1', kind: 'walkthrough' };
const PRIORITY: BookedAppointment = { ...WALK, slotId: 'h1', priority: true };

describe('booking words', () => {
  it('the Event Subject, and the words for the kind', () => {
    expect([eventSubject(PHONE), eventSubject(WALK), eventSubject(PRIORITY)]).toEqual(['Phone Consultation', 'Property Consultation', 'High Priority Property Consultation']);
    expect([consultationWords(PHONE), consultationWords(WALK), consultationWords(PRIORITY)]).toEqual(['phone consultation', 'property consultation', 'high-priority property consultation']);
  });

  it('why a conflict was not booked', () => {
    expect(conflictReason({ kind: 'conflict' })).toBe('the calendar was taken');
    expect(conflictReason({ kind: 'conflict', reason: 'drive' })).toBe("the rep's calendar no longer leaves time to drive there");
  });

  it('appointment.ts re-exports the subject for its importers', () => {
    expect(appointment.PRIORITY_SUBJECT).toBe(PRIORITY_SUBJECT);
    expect(appointment.eventSubject(PRIORITY)).toBe(PRIORITY_SUBJECT);
  });
});
