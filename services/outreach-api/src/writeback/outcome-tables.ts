/**
 * Plan 1D write-back: what a call's result does to a Lead's Status or an Opportunity's Stage, and the fields that move
 * with it. The tables are the spec's §5.2 (Lead) and §5.3 (Opportunity), approved by the user as written. The values
 * are defaults: the write plan validates each one against the live describe before use.
 */
import type { Disposition } from './mapping-model.js';

export const CALL_RESULTS = [
  'appointment', 'transferred', 'callback', 'not_now', 'not_selling', 'sold_mls', 'sold_investor', 'sold_ibuyer', 'listed', 'do_not_call', 'wrong_number', 'other',
] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

const SOLD: Readonly<Partial<Record<Disposition, CallResult>>> = {
  sold_mls: 'sold_mls',
  sold_investor: 'sold_investor',
  sold_ibuyer: 'sold_ibuyer',
  listed_with_agent: 'listed',
};

/**
 * The call's result for the tables (spec §3.4, §5). `appointment` needs a stored booking; an `appointment_set` without
 * one is a callback. `not_interested` is refined by the disposition; `hung_up` and `other` only by a sold or listed one.
 */
export function callResult(outcome: string, disposition: Disposition | null, hasAppointment: boolean): CallResult {
  const sold = disposition === null ? undefined : SOLD[disposition];
  switch (outcome) {
    case 'appointment_set':
      return hasAppointment ? 'appointment' : 'callback';
    case 'qualified_transferred':
      return 'transferred';
    case 'qualified_callback':
    case 'transfer_failed':
      return 'callback';
    case 'do_not_call':
      return 'do_not_call';
    case 'wrong_number':
      return 'wrong_number';
    case 'not_interested':
      return sold ?? (disposition === 'not_selling' ? 'not_selling' : 'not_now');
    case 'hung_up':
    case 'other':
      return sold ?? 'other';
    default:
      return 'other';
  }
}

/** The Lead Statuses the write-back moves from (spec §5.2). */
export const LEAD_FROM: ReadonlySet<string> = new Set(['New', 'Working', 'Long Term Follow-Up', 'Unqualified']);
/** The Opportunity Stages the write-back moves from (spec §5.3). */
export const OPP_FROM: ReadonlySet<string> = new Set(['Closed Lost', 'Offer Rejected', 'Followup', 'Misqualified', 'New Opportunity', 'Pending Appointment']);
/** The open stages: the only ones `onlyFromOpen` rows move from. */
export const OPP_OPEN: ReadonlySet<string> = new Set(['Followup', 'New Opportunity', 'Pending Appointment']);

/**
 * `set` writes the value; `fill` writes only over a blankish value; `raise` writes only over blank or Cold (Rating Warm).
 * `NOW` is the write-back's now; `CALLBACK` is the call's callback time, else the next business day 10:00 Pacific.
 */
export type Move = { field: string; value: string | boolean | 'NOW' | 'CALLBACK'; mode: 'set' | 'fill' | 'raise' };
export interface Row {
  status: string | null;
  also: readonly Move[];
  /** The status moves only from an open stage (OPP_OPEN). */
  onlyFromOpen?: boolean;
}

/**
 * The reason that goes with a status (Unqualified Reason, Loss Reason, Closed Lost Reason). It is written only with its
 * status: when the status move is applied, or (as `fill`) when the record is already at that status. A record whose
 * status is left alone keeps its reason too: a loss reason on an open Opportunity, or an unqualified reason on a Working
 * Lead, would be wrong data.
 */
export const REASON_FIELDS: ReadonlySet<string> = new Set(['Unqualified_Reason__c', 'Loss_Reason__c', 'Closed_Lost_Reason__c']);

const set = (field: string, value: Move['value']): Move => ({ field, value, mode: 'set' });
const NONE: Row = { status: null, also: [] };

const unqualified = (reason: string, ...more: Move[]): Row => ({ status: 'Unqualified', also: [set('Unqualified_Reason__c', reason), ...more] });

/**
 * spec §5.2. `appointment` here is the fallback only (the conversion was refused or is off): a Lead that converts is
 * written as its new Opportunity, under OPP_TABLE.appointment.
 */
export const LEAD_TABLE: Readonly<Record<CallResult, Row>> = {
  appointment: { status: 'Working', also: [set('Rating', 'Hot')] },
  transferred: { status: 'Working', also: [set('Rating', 'Hot')] },
  callback: { status: 'Working', also: [{ field: 'Rating', value: 'Warm', mode: 'raise' }] },
  not_now: { status: 'Long Term Follow-Up', also: [] },
  not_selling: unqualified('Not Interested'),
  sold_mls: unqualified('Already sold (MLS)'),
  sold_investor: unqualified('Already sold (Other Investor)'),
  sold_ibuyer: unqualified('Already sold (Other Investor)'),
  listed: unqualified('Went with Competition'),
  do_not_call: unqualified('Hostile/Remove from list', set('Removal_Status__c', 'Remove me'), set('DoNotCall', true), set('Skip_on_Dialer__c', true)),
  wrong_number: NONE,
  other: NONE,
};

const closedLost = (lossReason: string, closedLostReason: string | null, onlyFromOpen = false, ...more: Move[]): Row => ({
  status: 'Closed Lost',
  ...(onlyFromOpen ? { onlyFromOpen: true } : {}),
  also: [set('Loss_Reason__c', lossReason), ...(closedLostReason === null ? [] : [{ field: 'Closed_Lost_Reason__c', value: closedLostReason, mode: 'fill' } as Move]), ...more],
});

/** spec §5.3. `appointment` is applied after the Event is made (`onBooked`); `appointment_conflict` when the slot was taken. */
export const OPP_TABLE: Readonly<Record<CallResult | 'appointment_conflict', Row>> = {
  appointment: { status: 'Appointment Set', also: [set('Rating__c', 'Hot')] },
  appointment_conflict: { status: 'Followup', also: [set('Next_Follow_Up_Date__c', 'NOW')] },
  transferred: { status: 'Followup', also: [set('Next_Follow_Up_Date__c', 'NOW')] },
  callback: { status: 'Followup', also: [set('Next_Follow_Up_Date__c', 'CALLBACK')] },
  not_now: { status: null, also: [set('Rating__c', 'Cold')] },
  not_selling: closedLost('Other', null, true),
  sold_mls: closedLost('Sold on MLS', 'Sold on MLS'),
  sold_investor: closedLost('Sold to Other Investor', 'Sold To Other Investor'),
  sold_ibuyer: closedLost('Sold to iBuyer', 'Sold to iBuyer'),
  listed: closedLost('Lost to Competitor', null),
  do_not_call: closedLost('Hostile/Remove From List', null, true, set('Skip_on_Dialer__c', true)),
  wrong_number: NONE,
  other: NONE,
};
