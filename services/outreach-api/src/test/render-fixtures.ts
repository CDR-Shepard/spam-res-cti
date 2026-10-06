/** Shared inputs for the write-back render tests (render.test.ts, render-guard.test.ts). */
import type { BookedAppointment } from '@cti/contracts';
import { writableFields } from '../writeback/fields.js';
import { buildWritePlan, type Change, type WritePlan } from '../writeback/plan.js';
import type { RenderInput } from '../writeback/render.js';
import { prodDescribe } from './writeback-describes.js';

export const AT = new Date('2026-10-06T22:12:00.000Z'); // Tue Oct 6, 3:12 PM PT
export const CALL_ID = '6f0c2a9e-1b2c-4d5e-8f90-123456789abc';
export const URL = `https://outreach.example.com/campaigns/c1?call=${CALL_ID}`;
export const OPP = writableFields(prodDescribe('Opportunity'), 'Opportunity');
export const LEAD = writableFields(prodDescribe('Lead'), 'Lead');
export const booked = (kind: 'phone' | 'walkthrough'): BookedAppointment => ({
  slotId: kind === 'phone' ? 'p1' : 'w1',
  kind,
  start: '2026-10-07T18:00:00.000Z',
  end: kind === 'phone' ? '2026-10-07T18:15:00.000Z' : '2026-10-07T19:00:00.000Z',
  specialistSfUserId: '0058X00000Fsx39QAB',
  addressConfirmed: kind === 'walkthrough',
  note: '',
  bookedAt: '2026-10-06T22:10:00.000Z',
});
export const answers = {
  Timeline__c: { value: '90 Days', evidence: 'probably in about 90 days' },
  Motivation__c: { value: 'Relocating OOS', evidence: 'we are moving to Texas' },
  Condition__c: { value: '3 - Major Fixer with Major Issues', evidence: 'the roof needs replacing' },
  Major_Repairs_Needed__c: { value: ['Roof'], evidence: 'the roof needs replacing' },
};

/** The Opportunity plan for a booked call; `written` is what the run step would report (base changes + onBooked). */
export function oppBooking(kind: 'phone' | 'walkthrough', converted: boolean): { plan: WritePlan; written: Change[] } {
  const plan = buildWritePlan({
    sfObject: 'Opportunity',
    outcome: 'appointment_set',
    mapped: { disposition: 'interested', values: answers },
    current: converted
      ? { StageName: 'New Opportunity', Rating__c: null, Timeline__c: "Didn't Ask", Condition__c: '5 - Cosmetic Fixer' }
      : { StageName: 'Closed Lost', Rating__c: 'Cold', Timeline__c: "Didn't Ask", Condition__c: '5 - Cosmetic Fixer' },
    researchStatus: converted ? null : 'Closed Lost',
    fields: OPP,
    appointment: booked(kind),
    callbackAt: null,
    now: AT,
    converted: converted ? { fromLeadId: '00Q8X00001AbCdEUAV' } : null,
  });
  return { plan, written: [...(plan.appointment?.onBookedChanges ?? []), ...plan.changes] };
}

export const base = (plan: WritePlan, written: Change[], over: Partial<RenderInput> = {}): RenderInput => ({
  at: AT,
  outcomeWords: 'Appointment set',
  aiCallId: CALL_ID,
  plan,
  applied: { written, notWritten: [], created: ['Chatter post'] },
  summary: 'The seller is moving to Texas for work and wants to sell within three months. The roof needs replacing. They booked a call with Grant.',
  appointmentWords: 'phone consultation with Grant, Wed Oct 7, 11:00 AM PT (seller: 2:00 PM ET)',
  resultsUrl: URL,
  conversion: null,
  conversionRefused: null,
  ...over,
});
