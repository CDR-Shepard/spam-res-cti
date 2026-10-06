/** The write plan's guards (5a Fix 1 and the sweep): quoted dispositions, bookings after a transfer, the status guard. */
import { describe, expect, it } from 'vitest';
import { prodDescribe } from '../test/writeback-describes.js';
import { BOOKED, lead, mapped, opp } from '../test/write-plan-fixtures.js';
import { writableFields } from './fields.js';
import { StoredWritePlan, buildWritePlan } from './plan.js';

describe('5a Fix 1 (M-3): hung up / other close a record only on the seller\'s quoted words', () => {
  it('a sold disposition without a caller quote leaves a hung-up Lead alone; with one it is Unqualified', () => {
    const bare = buildWritePlan(lead({ outcome: 'hung_up', mapped: mapped('sold_mls') }));
    expect(bare.result).toBe('other');
    expect(bare.patch).toEqual({});
    const quoted = buildWritePlan(lead({ outcome: 'hung_up', mapped: { disposition: 'sold_mls', dispositionEvidence: 'we sold it on the MLS', values: {} } }));
    expect(quoted.result).toBe('sold_mls');
    expect(quoted.patch).toEqual({ Status: 'Unqualified', Unqualified_Reason__c: 'Already sold (MLS)' });
  });
});

describe('5a Fix 1 (M-9): a booking that still stands after a transfer is the appointment', () => {
  it('Opportunity, booked then transferred → the Event path, with the transfer noted', () => {
    const p = buildWritePlan(opp({ outcome: 'qualified_transferred', appointment: BOOKED }));
    expect(p.result).toBe('appointment');
    expect(p.bookingThen).toBe('transferred');
    expect(p.patch).toEqual({});
    expect(p.appointment).toMatchObject({ kind: 'opportunity_event', onBooked: { StageName: 'Appointment Set', Rating__c: 'Hot' } });
  });
  it('Lead, booked then the transfer failed → the appointment row (hold fallback when not converted)', () => {
    const p = buildWritePlan(lead({ outcome: 'transfer_failed', appointment: BOOKED }));
    expect(p.result).toBe('appointment');
    expect(p.bookingThen).toBe('transfer_failed');
    expect(p.patch).toEqual({ Status: 'Working', Rating: 'Hot' });
    expect(p.appointment?.kind).toBe('lead_hold');
  });
  it('a plain booking has nothing after it', () => {
    expect(buildWritePlan(opp({ outcome: 'appointment_set', appointment: BOOKED })).bookingThen).toBeNull();
    expect(buildWritePlan(opp({ outcome: 'qualified_transferred' })).bookingThen).toBeNull();
  });
  it('a practice call never books, whatever it stored', () => {
    const p = buildWritePlan(opp({ outcome: 'qualified_transferred', appointment: BOOKED, practice: true }));
    expect(p.result).toBe('transferred');
    expect(p.appointment).toBeNull();
    expect(p.bookingThen).toBeNull();
    expect(buildWritePlan(lead({ outcome: 'appointment_set', appointment: BOOKED, practice: true })).appointment).toBeNull();
  });
  it('round-trips through StoredWritePlan', () => {
    const plan = buildWritePlan(opp({ outcome: 'transfer_failed', appointment: BOOKED }));
    expect(StoredWritePlan.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });
});

describe('5a Fix 1 (I-3): Rating and Next Follow-Up move only with the status guard; do-not-call always applies', () => {
  it('Opportunity at Negotiation, not now (no status move) → Rating Cold skipped not_from_state', () => {
    const p = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('not_now'), current: { StageName: 'Negotiation', Rating__c: 'Hot' }, researchStatus: 'Negotiation' }));
    expect(p.patch).toEqual({});
    expect(p.skipped).toEqual([{ field: 'Rating__c', label: 'Rating', why: 'not_from_state' }]);
    expect(p.kept).toEqual([]);
  });
  it('Opportunity moved since research, not now → Rating Cold skipped moved_since_research', () => {
    const p = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('not_now'), current: { StageName: 'Pending Appointment', Rating__c: 'Hot' }, researchStatus: 'Followup' }));
    expect(p.patch).toEqual({});
    expect(p.skipped).toEqual([{ field: 'Rating__c', label: 'Rating', why: 'moved_since_research' }]);
  });
  it('a Lead outside the from-states, do not call → Status and reason skipped; Removal, Do Not Call and Skip on Dialer still set', () => {
    const p = buildWritePlan(lead({ outcome: 'do_not_call', current: { Status: 'Duplicate', Removal_Status__c: null, DoNotCall: false, Skip_on_Dialer__c: false }, researchStatus: 'Duplicate' }));
    expect(p.patch).toEqual({ Removal_Status__c: 'Remove me', DoNotCall: true, Skip_on_Dialer__c: true });
    expect(p.skipped).toEqual([
      { field: 'Status', label: 'Status', why: 'not_from_state' },
      { field: 'Unqualified_Reason__c', label: 'Unqualified Reason', why: 'not_from_state' },
    ]);
  });
  it('an Opportunity moved since research, do not call → Skip on Dialer still set, the contact flag still set', () => {
    const p = buildWritePlan(opp({ outcome: 'do_not_call', current: { StageName: 'Pending Appointment', Skip_on_Dialer__c: false }, researchStatus: 'Followup' }));
    expect(p.patch).toEqual({ Skip_on_Dialer__c: true });
    expect(p.contactDnc).toBe(true);
  });
  it('a record already at the target status still takes its Rating when research saw that status', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Working', Rating: 'Warm' }, researchStatus: 'Working' }));
    expect(p.patch).toEqual({ Rating: 'Hot' });
    expect(p.skipped).toEqual([]);
  });
  it('sweep D-21(6): already at the target, but moved there since research → a rep\'s Rating is held', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Working', Rating: 'Warm' }, researchStatus: 'Long Term Follow-Up' }));
    expect(p.patch).toEqual({});
    expect(p.skipped).toEqual([{ field: 'Rating', label: 'Rating', why: 'moved_since_research' }]);
  });
  it('sweep D-21(6): already at Unqualified since research → the reason is held too, the DNC flags still go', () => {
    const p = buildWritePlan(lead({ outcome: 'do_not_call', current: { Status: 'Unqualified', Unqualified_Reason__c: null, Removal_Status__c: null, DoNotCall: false, Skip_on_Dialer__c: false }, researchStatus: 'Working' }));
    expect(p.patch).toEqual({ Removal_Status__c: 'Remove me', DoNotCall: true, Skip_on_Dialer__c: true });
    expect(p.skipped).toEqual([{ field: 'Unqualified_Reason__c', label: 'Unqualified Reason', why: 'moved_since_research' }]);
  });
  it('a status the org will not take (not writable) does not hold back the Rating', () => {
    const fields = writableFields(prodDescribe('Lead', ['Status']), 'Lead');
    const p = buildWritePlan(lead({ fields }));
    expect(p.patch).toEqual({ Rating: 'Hot' });
    expect(p.skipped).toEqual([{ field: 'Status', label: 'Status', why: 'not_writable' }]);
  });
});

describe("5a Fix 1 (M-6): do not call keeps a rep's Removal Status", () => {
  it('a Lead marked "Spam" keeps it; Do Not Call and Skip on Dialer are still set', () => {
    const p = buildWritePlan(lead({ outcome: 'do_not_call', current: { Status: 'Working', Removal_Status__c: 'Spam', DoNotCall: false, Skip_on_Dialer__c: false }, researchStatus: 'Working' }));
    expect(p.patch).toEqual({ Status: 'Unqualified', Unqualified_Reason__c: 'Hostile/Remove from list', DoNotCall: true, Skip_on_Dialer__c: true });
  });
});

describe('5a Fix 1 (M-4): a mapped answer reaches its field whatever the case of its key', () => {
  it('an answer keyed by the org spelling of an allowlisted field is filled, not skipped', () => {
    const describe = prodDescribe('Lead');
    describe.fields.find((f) => f.name === 'Timeline__c')!.name = 'TIMELINE__c';
    const fields = writableFields(describe, 'Lead');
    expect(fields.get('Timeline__c')?.name).toBe('TIMELINE__c');
    const p = buildWritePlan(lead({ fields, current: { Status: 'Long Term Follow-Up', TIMELINE__c: null }, mapped: mapped('interested', { TIMELINE__c: { value: '90 Days', evidence: 'x' } }) }));
    expect(p.patch.TIMELINE__c).toBe('90 Days');
    expect(p.skipped).toEqual([]);
    expect(p.changes).toContainEqual({ field: 'Timeline__c', label: 'Timeline', before: null, after: '90 Days', why: 'filled' });
  });
});

describe('sweep D-21(3): a held move that would change nothing is not listed', () => {
  it('Rating already Cold on an Opportunity at Negotiation, not now → nothing skipped', () => {
    const p = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('not_now'), current: { StageName: 'Negotiation', Rating__c: 'Cold' }, researchStatus: 'Negotiation' }));
    expect(p.patch).toEqual({});
    expect(p.skipped).toEqual([]);
  });
  it('Rating already Hot on a Lead moved since research, transferred → only the Status is listed', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Unqualified', Rating: 'Hot' }, researchStatus: 'Long Term Follow-Up' }));
    expect(p.patch).toEqual({});
    expect(p.skipped).toEqual([{ field: 'Status', label: 'Status', why: 'moved_since_research' }]);
  });
  it('a held reason the record already has is not listed', () => {
    const p = buildWritePlan(lead({ outcome: 'do_not_call', current: { Status: 'Duplicate', Unqualified_Reason__c: 'Hostile/Remove from list', DoNotCall: true, Skip_on_Dialer__c: true, Removal_Status__c: 'Remove me' }, researchStatus: 'Duplicate' }));
    expect(p.skipped).toEqual([{ field: 'Status', label: 'Status', why: 'not_from_state' }]);
  });
});
