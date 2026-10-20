/** Task 8: the words of the conflict / refused / passed-time Task (taskStep), per consultation kind and conflict reason. */
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { taskWords } from './steps-write.js';

const AI_CALL = '6f0c2a9e-1b2c-4d5e-8f90-123456789abc';
/** Wed Oct 21, 9:00 AM PT. */
const WALK: BookedAppointment = {
  slotId: 'w1',
  kind: 'walkthrough',
  start: '2026-10-21T16:00:00.000Z',
  end: '2026-10-21T17:00:00.000Z',
  specialistSfUserId: '0058X00000FA8tLQAT',
  addressConfirmed: true,
  note: '',
  bookedAt: '2026-10-19T22:10:00.000Z',
  region: 'LA',
};
const PHONE: BookedAppointment = { ...WALK, slotId: 'p1', kind: 'phone', addressConfirmed: false };
const PRIORITY: BookedAppointment = { ...WALK, slotId: 'h1', priority: true, specialistSfUserId: '0058X00000Fsx39QAB' };

describe('taskWords', () => {
  it("reason 'drive': the rep's calendar no longer leaves time to drive there", () => {
    expect(taskWords(AI_CALL, WALK, { kind: 'conflict', reason: 'drive' })).toEqual({
      subject: "AI booked a property consultation for Wed Oct 21, 9:00 AM PT but the rep's calendar no longer leaves time to drive there: call the seller to set a time",
      description: `The seller agreed to a property consultation at Wed Oct 21, 9:00 AM PT on an AI call (AI call ${AI_CALL}), but the rep's calendar no longer leaves time to drive there. Call the seller to set a time.`,
    });
  });

  it('a plain conflict: the calendar was taken; the kind is a phone or property consultation', () => {
    expect(taskWords(AI_CALL, PHONE, { kind: 'conflict' })).toEqual({
      subject: 'AI booked a phone consultation for Wed Oct 21, 9:00 AM PT but the calendar was taken: call the seller to set a time',
      description: `The seller agreed to a phone consultation at Wed Oct 21, 9:00 AM PT on an AI call (AI call ${AI_CALL}), but the calendar was taken. Call the seller to set a time.`,
    });
    expect(taskWords(AI_CALL, WALK, { kind: 'conflict' })?.subject).toBe(
      'AI booked a property consultation for Wed Oct 21, 9:00 AM PT but the calendar was taken: call the seller to set a time',
    );
  });

  it('a high-priority booking is a high-priority property consultation', () => {
    expect(taskWords(AI_CALL, PRIORITY, { kind: 'refused', code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' })?.subject).toBe(
      'AI booked a high-priority property consultation for Wed Oct 21, 9:00 AM PT but Salesforce refused the Event (FIELD_CUSTOM_VALIDATION_EXCEPTION): call the seller to set a time',
    );
    expect(taskWords(AI_CALL, PRIORITY, { kind: 'expired' })?.description).toBe(
      `The seller agreed to a high-priority property consultation at Wed Oct 21, 9:00 AM PT on an AI call (AI call ${AI_CALL}), but that time passed before the write-back could save it, so nothing was put on the calendar. Call the seller to re-book.`,
    );
  });

  it('a booking that was made needs no Task', () => {
    expect(taskWords(AI_CALL, WALK, { kind: 'created', eventId: '00U8X00000Evnt1QAA' })).toBeNull();
  });
});
