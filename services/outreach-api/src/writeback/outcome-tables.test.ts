import { describe, expect, it } from 'vitest';
import type { Disposition } from './mapping-model.js';
import { CALL_RESULTS, LEAD_FROM, LEAD_TABLE, OPP_FROM, OPP_OPEN, OPP_TABLE, REASON_FIELDS, callResult, type CallResult } from './outcome-tables.js';

describe('callResult (spec §3.4, §5)', () => {
  const Q = { dispositionQuoted: true };
  const P = { practice: true };
  type Facts = Parameters<typeof callResult>[3];
  const rows: Array<[outcome: string, disposition: Disposition | null, booked: boolean, expected: CallResult, facts?: Facts]> = [
    ['appointment_set', null, true, 'appointment'],
    ['appointment_set', 'interested', true, 'appointment'],
    ['appointment_set', null, false, 'callback'],
    ['qualified_transferred', 'interested', false, 'transferred'],
    ['qualified_transferred', 'sold_mls', false, 'transferred'],
    ['qualified_callback', null, false, 'callback'],
    ['transfer_failed', 'not_now', false, 'callback'],
    ['do_not_call', 'not_selling', false, 'do_not_call'],
    ['wrong_number', null, false, 'wrong_number'],
    ['not_interested', 'sold_mls', false, 'sold_mls'],
    ['not_interested', 'sold_investor', false, 'sold_investor'],
    ['not_interested', 'sold_ibuyer', false, 'sold_ibuyer'],
    ['not_interested', 'listed_with_agent', false, 'listed'],
    ['not_interested', 'not_selling', false, 'not_selling'],
    ['not_interested', 'not_now', false, 'not_now'],
    ['not_interested', 'interested', false, 'not_now'],
    ['not_interested', 'unknown', false, 'not_now'],
    ['not_interested', null, false, 'not_now'],
    ['hung_up', 'sold_mls', false, 'sold_mls', Q],
    ['hung_up', 'sold_ibuyer', false, 'sold_ibuyer', Q],
    ['hung_up', 'listed_with_agent', false, 'listed', Q],
    ['hung_up', 'not_selling', false, 'other', Q],
    ['hung_up', null, false, 'other'],
    ['other', 'sold_investor', false, 'sold_investor', Q],
    ['other', 'not_now', false, 'other', Q],
    ['other', null, false, 'other'],
    ['voicemail', 'sold_mls', false, 'other', Q],
    // 5a Fix 1 (M-3): hung_up / other close only on the seller's quoted words
    ['hung_up', 'sold_mls', false, 'other'],
    ['hung_up', 'listed_with_agent', false, 'other', { dispositionQuoted: false }],
    ['other', 'sold_investor', false, 'other'],
    // 5a Fix 1 (M-9): a booking that still stands is the appointment result, whatever the transfer did
    ['qualified_transferred', 'interested', true, 'appointment'],
    ['transfer_failed', null, true, 'appointment'],
    ['do_not_call', null, true, 'do_not_call'],
    ['wrong_number', null, true, 'wrong_number'],
    ['qualified_callback', null, true, 'callback'],
    ['not_interested', 'not_now', true, 'not_now'],
    ['hung_up', null, true, 'other'],
    // a practice call never books
    ['appointment_set', null, true, 'callback', P],
    ['qualified_transferred', null, true, 'transferred', P],
    ['transfer_failed', null, true, 'callback', P],
  ];
  it.each(rows)('%s + %s (booked %s) → %s %j', (outcome, disposition, booked, expected, facts) => {
    expect(callResult(outcome, disposition, booked, facts)).toBe(expected);
  });
});

describe('the from-states', () => {
  it('pins the spec lists', () => {
    expect([...LEAD_FROM]).toEqual(['New', 'Working', 'Long Term Follow-Up', 'Unqualified']);
    expect([...OPP_FROM]).toEqual(['Closed Lost', 'Offer Rejected', 'Followup', 'Misqualified', 'New Opportunity', 'Pending Appointment']);
    expect([...OPP_OPEN]).toEqual(['Followup', 'New Opportunity', 'Pending Appointment']);
  });
});

describe('the tables (spec §5.2, §5.3), row for row', () => {
  it('Lead', () => {
    expect(LEAD_TABLE).toEqual({
      appointment: { status: 'Working', also: [{ field: 'Rating', value: 'Hot', mode: 'set' }] },
      transferred: { status: 'Working', also: [{ field: 'Rating', value: 'Hot', mode: 'set' }] },
      callback: { status: 'Working', also: [{ field: 'Rating', value: 'Warm', mode: 'raise' }] },
      not_now: { status: 'Long Term Follow-Up', also: [] },
      not_selling: { status: 'Unqualified', also: [{ field: 'Unqualified_Reason__c', value: 'Not Interested', mode: 'set' }] },
      sold_mls: { status: 'Unqualified', also: [{ field: 'Unqualified_Reason__c', value: 'Already sold (MLS)', mode: 'set' }] },
      sold_investor: { status: 'Unqualified', also: [{ field: 'Unqualified_Reason__c', value: 'Already sold (Other Investor)', mode: 'set' }] },
      sold_ibuyer: { status: 'Unqualified', also: [{ field: 'Unqualified_Reason__c', value: 'Already sold (Other Investor)', mode: 'set' }] },
      listed: { status: 'Unqualified', also: [{ field: 'Unqualified_Reason__c', value: 'Went with Competition', mode: 'set' }] },
      do_not_call: {
        status: 'Unqualified',
        also: [
          { field: 'Unqualified_Reason__c', value: 'Hostile/Remove from list', mode: 'set' },
          { field: 'Removal_Status__c', value: 'Remove me', mode: 'fill' },
          { field: 'DoNotCall', value: true, mode: 'set' },
          { field: 'Skip_on_Dialer__c', value: true, mode: 'set' },
        ],
      },
      wrong_number: { status: null, also: [] },
      other: { status: null, also: [] },
    });
  });
  it('Opportunity', () => {
    expect(OPP_TABLE).toEqual({
      appointment: { status: 'Appointment Set', also: [{ field: 'Rating__c', value: 'Hot', mode: 'set' }] },
      appointment_conflict: { status: 'Followup', also: [{ field: 'Next_Follow_Up_Date__c', value: 'NOW', mode: 'set' }] },
      transferred: { status: 'Followup', also: [{ field: 'Next_Follow_Up_Date__c', value: 'NOW', mode: 'set' }] },
      callback: { status: 'Followup', also: [{ field: 'Next_Follow_Up_Date__c', value: 'CALLBACK', mode: 'set' }] },
      not_now: { status: null, also: [{ field: 'Rating__c', value: 'Cold', mode: 'set' }] },
      not_selling: { status: 'Closed Lost', onlyFromOpen: true, also: [{ field: 'Loss_Reason__c', value: 'Other', mode: 'set' }] },
      sold_mls: {
        status: 'Closed Lost',
        also: [
          { field: 'Loss_Reason__c', value: 'Sold on MLS', mode: 'set' },
          { field: 'Closed_Lost_Reason__c', value: 'Sold on MLS', mode: 'fill' },
        ],
      },
      sold_investor: {
        status: 'Closed Lost',
        also: [
          { field: 'Loss_Reason__c', value: 'Sold to Other Investor', mode: 'set' },
          { field: 'Closed_Lost_Reason__c', value: 'Sold To Other Investor', mode: 'fill' },
        ],
      },
      sold_ibuyer: {
        status: 'Closed Lost',
        also: [
          { field: 'Loss_Reason__c', value: 'Sold to iBuyer', mode: 'set' },
          { field: 'Closed_Lost_Reason__c', value: 'Sold to iBuyer', mode: 'fill' },
        ],
      },
      listed: { status: 'Closed Lost', also: [{ field: 'Loss_Reason__c', value: 'Lost to Competitor', mode: 'set' }] },
      do_not_call: {
        status: 'Closed Lost',
        onlyFromOpen: true,
        also: [
          { field: 'Loss_Reason__c', value: 'Hostile/Remove From List', mode: 'set' },
          { field: 'Skip_on_Dialer__c', value: true, mode: 'set' },
        ],
      },
      wrong_number: { status: null, also: [] },
      other: { status: null, also: [] },
    });
  });
  it('has a row for every call result', () => {
    expect(Object.keys(LEAD_TABLE).sort()).toEqual([...CALL_RESULTS].sort());
    expect(Object.keys(OPP_TABLE).sort()).toEqual([...CALL_RESULTS, 'appointment_conflict'].sort());
  });
  it('the reason fields are the ones tied to a status', () => {
    expect([...REASON_FIELDS]).toEqual(['Unqualified_Reason__c', 'Loss_Reason__c', 'Closed_Lost_Reason__c']);
  });

  // The production picklists (_t2, read-only describe, 2026-10-06): every value a table writes must be one of them.
  const PROD: Record<string, readonly string[]> = {
    'Lead.Status': ['New', 'Working', 'Long Term Follow-Up', 'Unqualified', 'Duplicate', 'Qualified'],
    'Lead.Rating': ['Hot', 'Warm', 'Cold'],
    'Lead.Unqualified_Reason__c': [
      'Could not find phone number', 'Already sold (MLS)', 'Already sold (Other Investor)', "Doesn't have a property to sell at all", 'Hostile/Remove from list', 'Other',
      'Outside buy area', 'Spam', 'Not Interested', 'Went with Competition', 'Unqualified - In Contract', 'Unqualified - In Negotiation',
      'Unqualified - Calling for Specific Team Mate', 'Insufficient lead information',
    ],
    'Lead.Removal_Status__c': ['Remove me', 'Spam'],
    'Opportunity.StageName': [
      'New Opportunity', 'Pending Appointment', 'Appointment Set', 'Followup', 'Negotiation', 'New Buyer', 'Investigation', 'Preapproved', 'BRE Signed', 'Writing Offers',
      'Offer Accepted', 'Misqualified', 'Duplicate', 'Contract Signed', 'Closed Lost', 'Closed Won (Buyer)', 'Verbal Submitted', 'Verbal Submitted – Pending Walkthrough',
      'Verbal Submitted – No Walkthrough Needed', 'Walkthrough Invited', 'Walkthrough Attended', 'Final Offer Submitted', 'Offer Rejected', 'Assignment Contract Sent',
      'Contract in Escrow', 'Buyer Cancelled Escrow', 'Offer Rescinded',
    ],
    'Opportunity.Rating__c': ['Hot', 'Warm', 'Cool', 'Cold'],
    'Opportunity.Loss_Reason__c': [
      'Lost to Competitor', 'No Budget / Lost Funding', 'No Decision / Non-Responsive', 'Price', 'Other', 'Sold on MLS', 'Sold to Other Investor', 'Sold to iBuyer',
      'Hostile/Remove From List', 'Land', 'Wholesaler', 'No Info from Skiptrace', 'Dead deal management approved', 'Fake Lead', 'Duplicate Opportunity',
    ],
    'Opportunity.Closed_Lost_Reason__c': [
      'Sold on MLS', 'Sold To Other Investor', 'Sold to iBuyer', 'Decided to List (Our Team)', 'Hostile/Remove From List', 'Outside buy area', 'Other', 'Bought from Other Agent',
      'Sold to Family Member',
    ],
  };
  const BOOLEAN = new Set(['Lead.DoNotCall', 'Lead.Skip_on_Dialer__c', 'Opportunity.Skip_on_Dialer__c']);
  const DATETIME = new Set(['Opportunity.Next_Follow_Up_Date__c']);
  const STATUS = { Lead: 'Status', Opportunity: 'StageName' } as const;

  it.each([
    ['Lead', LEAD_TABLE],
    ['Opportunity', OPP_TABLE],
  ] as const)('every %s table value is in the production picklists (or a boolean / datetime field)', (sfObject, table) => {
    for (const row of Object.values(table)) {
      if (row.status !== null) expect(PROD[`${sfObject}.${STATUS[sfObject]}`]).toContain(row.status);
      for (const m of row.also) {
        const key = `${sfObject}.${m.field}`;
        if (BOOLEAN.has(key)) expect(m.value).toBe(true);
        else if (DATETIME.has(key)) expect(['NOW', 'CALLBACK']).toContain(m.value);
        else expect(PROD[key]).toContain(m.value);
      }
    }
  });
  it('the from-states are production stage and status values', () => {
    for (const s of LEAD_FROM) expect(PROD['Lead.Status']).toContain(s);
    for (const s of OPP_FROM) expect(PROD['Opportunity.StageName']).toContain(s);
  });
});
