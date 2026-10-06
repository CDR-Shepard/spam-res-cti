/** Shared inputs for the write-plan tests (plan.test.ts, plan-guard.test.ts). */
import type { BookedAppointment } from '@cti/contracts';
import { writableFields } from '../writeback/fields.js';
import type { MappedAnswers } from '../writeback/mapping-model.js';
import type { buildWritePlan } from '../writeback/plan.js';
import { prodDescribe } from './writeback-describes.js';

export const NOW = new Date('2026-10-06T22:12:00.000Z'); // Tue Oct 6, 3:12 PM PT
export const LEAD = writableFields(prodDescribe('Lead'), 'Lead');
export const OPP = writableFields(prodDescribe('Opportunity'), 'Opportunity');
export const BOOKED: BookedAppointment = {
  slotId: 'p1',
  kind: 'phone',
  start: '2026-10-07T18:00:00.000Z',
  end: '2026-10-07T18:15:00.000Z',
  specialistSfUserId: '0058X00000Fsx39QAB',
  addressConfirmed: false,
  note: 'mornings are best',
  bookedAt: '2026-10-06T22:10:00.000Z',
};
export const none: MappedAnswers = { disposition: 'interested', values: {} };

export type In = Parameters<typeof buildWritePlan>[0];
export const lead = (over: Partial<In> = {}): In => ({
  sfObject: 'Lead',
  outcome: 'qualified_transferred',
  mapped: none,
  current: { Status: 'Long Term Follow-Up', Rating: null, Timeline__c: "I Didn't Ask", DoNotCall: false, Skip_on_Dialer__c: false },
  researchStatus: 'Long Term Follow-Up',
  fields: LEAD,
  appointment: null,
  callbackAt: null,
  now: NOW,
  converted: null,
  ...over,
});
export const opp = (over: Partial<In> = {}): In => ({
  ...lead(),
  sfObject: 'Opportunity',
  current: { StageName: 'Followup', Rating__c: 'Warm', Loss_Reason__c: null, Closed_Lost_Reason__c: null, Next_Follow_Up_Date__c: null, Skip_on_Dialer__c: false },
  researchStatus: 'Followup',
  fields: OPP,
  ...over,
});
export const mapped = (disposition: MappedAnswers['disposition'], values: MappedAnswers['values'] = {}): MappedAnswers => ({ disposition, values });
