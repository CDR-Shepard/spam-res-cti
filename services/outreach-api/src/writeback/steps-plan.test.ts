/** Task 8 fix 1: the "converted without an Opportunity" Task names the consultation the way the other Tasks do. */
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { noOpportunityTaskWords } from './steps-plan.js';

const AI_CALL = '6f0c2a9e-1b2c-4d5e-8f90-123456789abc';
const LEAD = '00Q8X00000AbCdEUAV';
/** Wed Oct 21, 9:00 AM PT. */
const PHONE: BookedAppointment = {
  slotId: 'p1',
  kind: 'phone',
  start: '2026-10-21T16:00:00.000Z',
  end: '2026-10-21T17:00:00.000Z',
  specialistSfUserId: '0058X00000FA8tLQAT',
  addressConfirmed: false,
  note: '',
  bookedAt: '2026-10-19T22:10:00.000Z',
  region: 'LA',
};
const PRIORITY: BookedAppointment = { ...PHONE, slotId: 'h1', kind: 'walkthrough', addressConfirmed: true, priority: true, specialistSfUserId: '0058X00000Fsx39QAB' };

describe('noOpportunityTaskWords', () => {
  it('a high-priority booking is a high-priority property consultation, in the subject and the description', () => {
    expect(noOpportunityTaskWords(AI_CALL, LEAD, PRIORITY)).toEqual({
      subject: 'AI booked a high-priority property consultation for Wed Oct 21, 9:00 AM PT; this Lead was already converted without an Opportunity — create one and book it',
      description: `The AI assistant booked a high-priority property consultation on a call (AI call ${AI_CALL}) for Lead ${LEAD}, which someone had already converted without an Opportunity. Create the Opportunity and book the time.`,
    });
  });

  it('a phone booking is a phone consultation; a visit a property consultation', () => {
    const phone = noOpportunityTaskWords(AI_CALL, LEAD, PHONE);
    expect(phone.subject).toBe('AI booked a phone consultation for Wed Oct 21, 9:00 AM PT; this Lead was already converted without an Opportunity — create one and book it');
    expect(phone.description).toContain('The AI assistant booked a phone consultation on a call');
    expect(noOpportunityTaskWords(AI_CALL, LEAD, { ...PHONE, slotId: 'w1', kind: 'walkthrough' }).subject).toContain('AI booked a property consultation for ');
  });
});
