/**
 * How a booking is named (Task 8), shared by the write-back's Event, its Tasks and Chatter post, and the record test's
 * dry-run preview (which may not import appointment.ts), so the preview always says what the write-back writes. Pure.
 */
import type { BookedAppointment } from '@cti/contracts';

export const PRIORITY_SUBJECT = 'High Priority Property Consultation';
const SUBJECTS: Readonly<Record<BookedAppointment['kind'], string>> = { phone: 'Phone Consultation', walkthrough: 'Property Consultation' };

/** The Event's Subject, as reps name consultations (so the org's consultation flows run). */
export const eventSubject = (b: Pick<BookedAppointment, 'kind' | 'priority'>): string => (b.priority === true ? PRIORITY_SUBJECT : SUBJECTS[b.kind]);

/** A booking as the Task and Chatter words name it: phone, property, or high-priority property consultation. */
export function consultationWords(b: Pick<BookedAppointment, 'kind' | 'priority'>): string {
  if (b.priority === true) return 'high-priority property consultation';
  return b.kind === 'phone' ? 'phone consultation' : 'property consultation';
}

/** Why a write-time conflict was not booked, as both the Task and the Chatter post say it. */
export function conflictReason(c: { kind: 'conflict'; reason?: 'drive' }): string {
  return c.reason === 'drive' ? "the rep's calendar no longer leaves time to drive there" : 'the calendar was taken';
}
