import { describe, expect, it } from 'vitest';
import { prodDescribe } from '../test/writeback-describes.js';
import { BOOKED, NOW, lead, mapped, opp } from '../test/write-plan-fixtures.js';
import type { MappedAnswers } from './mapping-model.js';
import { writableFields } from './fields.js';
import { StoredWritePlan, buildWritePlan } from './plan.js';

describe('buildWritePlan: status and stage (spec §5.2, §5.3)', () => {
  it('1: Lead at LTFU, transferred, research saw LTFU → Working and Hot', () => {
    const p = buildWritePlan(lead());
    expect(p.result).toBe('transferred');
    expect(p.patch).toEqual({ Status: 'Working', Rating: 'Hot' });
    expect(p.changes).toEqual([
      { field: 'Status', label: 'Status', before: 'Long Term Follow-Up', after: 'Working', why: 'status' },
      { field: 'Rating', label: 'Rating', before: null, after: 'Hot', why: 'status' },
    ]);
    expect(p.skipped).toEqual([]);
    expect(p.appointment).toBeNull();
    expect(p.contactDnc).toBe(false);
    expect(p.mapped).toBe(true);
  });
  it('2: Status moved since research (Unqualified now, LTFU then) → skipped, and Rating with it (5a Fix 1, I-3)', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Unqualified', Rating: null } }));
    expect(p.patch).toEqual({});
    expect(p.skipped).toEqual([
      { field: 'Status', label: 'Status', why: 'moved_since_research' },
      { field: 'Rating', label: 'Rating', why: 'moved_since_research' },
    ]);
  });
  it('3: a queue-owned Lead plans the same (the PATCH refusal is the run step\'s)', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Rating: null, OwnerId: '00G8X000000AbCdUAK' } }));
    expect(p.patch).toEqual({ Status: 'Working', Rating: 'Hot' });
  });
  it('4: Lead, not interested and not selling → Unqualified, Not Interested', () => {
    const p = buildWritePlan(lead({ outcome: 'not_interested', mapped: mapped('not_selling') }));
    expect(p.result).toBe('not_selling');
    expect(p.patch).toEqual({ Status: 'Unqualified', Unqualified_Reason__c: 'Not Interested' });
  });
  it('5: Lead, do not call → Unqualified, Hostile, Remove me, Do Not Call, Skip on Dialer', () => {
    const p = buildWritePlan(lead({ outcome: 'do_not_call', current: { Status: 'Working', DoNotCall: false, Skip_on_Dialer__c: null }, researchStatus: 'Working' }));
    expect(p.patch).toEqual({ Status: 'Unqualified', Unqualified_Reason__c: 'Hostile/Remove from list', Removal_Status__c: 'Remove me', DoNotCall: true, Skip_on_Dialer__c: true });
    expect(p.changes.map((c) => [c.field, c.why])).toEqual([
      ['Status', 'status'],
      ['Unqualified_Reason__c', 'status'],
      ['Removal_Status__c', 'dnc'],
      ['DoNotCall', 'dnc'],
      ['Skip_on_Dialer__c', 'dnc'],
    ]);
    expect(p.changes.find((c) => c.field === 'DoNotCall')).toMatchObject({ before: 'false', after: 'true' });
    expect(p.contactDnc).toBe(false);
  });
  it('6: Opportunity at Closed Lost books → no stage in the base patch; Appointment Set on booked, Followup on conflict', () => {
    const p = buildWritePlan(opp({ outcome: 'appointment_set', appointment: BOOKED, current: { StageName: 'Closed Lost', Rating__c: 'Cold', Next_Follow_Up_Date__c: null }, researchStatus: 'Closed Lost' }));
    expect(p.result).toBe('appointment');
    expect(p.patch).toEqual({});
    expect(p.appointment).toEqual({
      booked: BOOKED,
      kind: 'opportunity_event',
      onBooked: { StageName: 'Appointment Set', Rating__c: 'Hot' },
      onConflict: { StageName: 'Followup', Next_Follow_Up_Date__c: NOW.toISOString() },
      onBookedChanges: [
        { field: 'StageName', label: 'Stage', before: 'Closed Lost', after: 'Appointment Set', why: 'status' },
        { field: 'Rating__c', label: 'Rating', before: 'Cold', after: 'Hot', why: 'status' },
      ],
      onConflictChanges: [
        { field: 'StageName', label: 'Stage', before: 'Closed Lost', after: 'Followup', why: 'status' },
        { field: 'Next_Follow_Up_Date__c', label: 'Next Follow-Up Date', before: null, after: NOW.toISOString(), why: 'follow_up' },
      ],
    });
  });
  it('7: Opportunity in Negotiation, transferred → stage and the follow-up skipped not_from_state (5a Fix 1, I-3)', () => {
    const p = buildWritePlan(opp({ current: { StageName: 'Negotiation' }, researchStatus: 'Negotiation' }));
    expect(p.skipped).toEqual([
      { field: 'StageName', label: 'Stage', why: 'not_from_state' },
      { field: 'Next_Follow_Up_Date__c', label: 'Next Follow-Up Date', why: 'not_from_state' },
    ]);
    expect(p.patch).toEqual({});
  });
  it('8: Opportunity at Followup, not selling → Closed Lost, Loss Reason Other', () => {
    const p = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('not_selling') }));
    expect(p.patch).toEqual({ StageName: 'Closed Lost', Loss_Reason__c: 'Other' });
  });
  it('9: Opportunity already Closed Lost, not selling → stage unchanged, no Rating move, Loss Reason only filled', () => {
    const kept = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('not_selling'), current: { StageName: 'Closed Lost', Rating__c: 'Hot', Loss_Reason__c: 'Price' }, researchStatus: 'Closed Lost' }));
    expect(kept.patch).toEqual({});
    expect(kept.changes).toEqual([]);
    expect(kept.skipped).toEqual([]);
    const blank = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('not_selling'), current: { StageName: 'Closed Lost', Loss_Reason__c: null }, researchStatus: 'Closed Lost' }));
    expect(blank.patch).toEqual({ Loss_Reason__c: 'Other' });
  });
  it('9b: an open Opportunity, not now → stage unchanged, Rating Cold', () => {
    expect(buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('not_now') })).patch).toEqual({ Rating__c: 'Cold' });
  });
  it('10: Opportunity, sold to an investor → Closed Lost, Loss Reason, and Closed Lost Reason filled', () => {
    const p = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('sold_investor') }));
    expect(p.patch).toEqual({ StageName: 'Closed Lost', Loss_Reason__c: 'Sold to Other Investor', Closed_Lost_Reason__c: 'Sold To Other Investor' });
    const filled = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('sold_investor'), current: { StageName: 'Followup', Closed_Lost_Reason__c: 'Other' } }));
    expect(filled.patch).toEqual({ StageName: 'Closed Lost', Loss_Reason__c: 'Sold to Other Investor' });
  });
  it('a reason never goes on a record whose status is left alone', () => {
    const p = buildWritePlan(opp({ outcome: 'not_interested', mapped: mapped('sold_mls'), current: { StageName: 'Negotiation', Loss_Reason__c: null }, researchStatus: 'Negotiation' }));
    expect(p.patch).toEqual({});
    expect(p.skipped).toEqual([
      { field: 'StageName', label: 'Stage', why: 'not_from_state' },
      { field: 'Loss_Reason__c', label: 'Opportunity Stage Status Reason', why: 'not_from_state' },
      { field: 'Closed_Lost_Reason__c', label: 'Closed/Lost Reason', why: 'not_from_state' },
    ]);
  });
  it('11: callback → Followup and Next Follow-Up at the callback time, else the next business day 10:00 PT', () => {
    const at = new Date('2026-10-08T16:30:00.000Z');
    expect(buildWritePlan(opp({ outcome: 'qualified_callback', callbackAt: at })).patch).toEqual({ Next_Follow_Up_Date__c: at.toISOString() });
    expect(buildWritePlan(opp({ outcome: 'qualified_callback', current: { StageName: 'Pending Appointment' }, researchStatus: 'Pending Appointment' })).patch).toEqual({
      StageName: 'Followup',
      Next_Follow_Up_Date__c: '2026-10-07T17:00:00.000Z', // Wed Oct 7, 10:00 AM PDT
    });
    const friday = new Date('2026-10-09T20:00:00.000Z');
    expect(buildWritePlan(opp({ outcome: 'transfer_failed', now: friday })).patch.Next_Follow_Up_Date__c).toBe('2026-10-12T17:00:00.000Z');
    const winter = new Date('2026-12-04T20:00:00.000Z'); // Fri Dec 4 → Mon Dec 7, 10:00 PST
    expect(buildWritePlan(opp({ outcome: 'transfer_failed', now: winter })).patch.Next_Follow_Up_Date__c).toBe('2026-12-07T18:00:00.000Z');
  });
  it('callback on a Lead raises Rating to Warm only from blank or Cold', () => {
    const cb = (Rating: string | null) => buildWritePlan(lead({ outcome: 'qualified_callback', current: { Status: 'Long Term Follow-Up', Rating } })).patch;
    expect(cb(null)).toEqual({ Status: 'Working', Rating: 'Warm' });
    expect(cb('Cold')).toEqual({ Status: 'Working', Rating: 'Warm' });
    expect(cb('Hot')).toEqual({ Status: 'Working' });
  });
  it('wrong number and other move nothing; a status already at its target is no change', () => {
    expect(buildWritePlan(lead({ outcome: 'wrong_number' })).patch).toEqual({});
    expect(buildWritePlan(lead({ outcome: 'hung_up', mapped: mapped('not_now') })).result).toBe('other');
    const same = buildWritePlan(lead({ current: { Status: 'Working', Rating: 'Hot' }, researchStatus: 'Working' }));
    expect(same.patch).toEqual({});
    expect(same.changes).toEqual([]);
  });
  it('a Lead status outside the from list is not moved; a null research status skips the research check', () => {
    expect(buildWritePlan(lead({ current: { Status: 'Duplicate' }, researchStatus: 'Duplicate' })).skipped).toEqual([
      { field: 'Status', label: 'Status', why: 'not_from_state' },
      { field: 'Rating', label: 'Rating', why: 'not_from_state' },
    ]);
    expect(buildWritePlan(lead({ researchStatus: null })).patch).toEqual({ Status: 'Working', Rating: 'Hot' });
  });
  it('a table field the org lacks or does not let us edit is skipped as not_writable', () => {
    const fields = writableFields(prodDescribe('Lead', ['Rating']), 'Lead');
    expect(buildWritePlan(lead({ fields })).skipped).toEqual([{ field: 'Rating', label: 'Rating', why: 'not_writable' }]);
  });
  it('Opportunity do not call → Closed Lost from an open stage, Hostile, Skip on Dialer, and the contact flag', () => {
    const p = buildWritePlan(opp({ outcome: 'do_not_call' }));
    expect(p.patch).toEqual({ StageName: 'Closed Lost', Loss_Reason__c: 'Hostile/Remove From List', Skip_on_Dialer__c: true });
    expect(p.contactDnc).toBe(true);
  });
});

describe('buildWritePlan: fill blanks (spec §5.1)', () => {
  const ev = (value: MappedAnswers['values'][string]['value'], evidence = 'seller words'): MappedAnswers['values'][string] => ({ value, evidence });
  it('12: Timeline "I Didn\'t Ask" → "90 Days" is filled', () => {
    const p = buildWritePlan(lead({ mapped: mapped('interested', { Timeline__c: ev('90 Days') }) }));
    expect(p.patch.Timeline__c).toBe('90 Days');
    expect(p.changes).toContainEqual({ field: 'Timeline__c', label: 'Timeline', before: "I Didn't Ask", after: '90 Days', why: 'filled' });
  });
  it('13: Timeline "30 Days" with mapped "90 Days" is kept as the rep\'s value', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Timeline__c: '30 Days' }, mapped: mapped('interested', { Timeline__c: ev('90 Days', 'in about 90 days') }) }));
    expect(p.patch.Timeline__c).toBeUndefined();
    expect(p.kept).toEqual([{ field: 'Timeline__c', label: 'Timeline', current: '30 Days', proposed: '90 Days', evidence: 'in about 90 days' }]);
  });
  it('14: a boolean is written false → true only', () => {
    const on = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Roof_Issues__c: false }, mapped: mapped('interested', { Roof_Issues__c: ev(true) }) }));
    expect(on.changes).toContainEqual({ field: 'Roof_Issues__c', label: 'Roof Issues', before: 'false', after: 'true', why: 'filled' });
    const already = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Roof_Issues__c: true }, mapped: mapped('interested', { Roof_Issues__c: ev(true) }) }));
    expect(already.patch.Roof_Issues__c).toBeUndefined();
    expect(already.kept).toEqual([]);
  });
  it('15: a value missing from the describe is skipped as invalid_value, for a mapped field and a table field', () => {
    const p = buildWritePlan(lead({ mapped: mapped('interested', { Occupancy__c: ev('Houseboat') }) }));
    expect(p.skipped).toContainEqual({ field: 'Occupancy__c', label: 'Occupancy', why: 'invalid_value' });
    const describe = prodDescribe('Lead');
    const reasons = describe.fields.find((f) => f.name === 'Unqualified_Reason__c')!;
    reasons.picklistValues = reasons.picklistValues!.filter((v) => v.value !== 'Not Interested');
    const q = buildWritePlan(lead({ outcome: 'not_interested', mapped: mapped('not_selling'), fields: writableFields(describe, 'Lead') }));
    expect(q.patch).toEqual({ Status: 'Unqualified' });
    expect(q.skipped).toEqual([{ field: 'Unqualified_Reason__c', label: 'Unqualified Reason', why: 'invalid_value' }]);
  });
  it('a mapped field that is not writable is skipped as not_writable', () => {
    const fields = writableFields(prodDescribe('Lead', ['Mold__c']), 'Lead');
    expect(buildWritePlan(lead({ fields, mapped: mapped('interested', { Mold__c: ev(true) }) })).skipped).toEqual([{ field: 'Mold__c', label: 'Mold__c', why: 'not_writable' }]);
  });
  it('16: mapped null → no fills, mapped false, status moves still applied', () => {
    const p = buildWritePlan(lead({ mapped: null, outcome: 'not_interested', current: { Status: 'Working' }, researchStatus: 'Working' }));
    expect(p.mapped).toBe(false);
    expect(p.result).toBe('not_now');
    expect(p.patch).toEqual({ Status: 'Long Term Follow-Up' });
  });
  it('a multipicklist is written joined with ";" and counts as blank when it holds only placeholders', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Major_Repairs_Needed__c: 'Unsure', Competition__c: 'Has Offers' }, mapped: mapped('interested', { Major_Repairs_Needed__c: ev(['Roof', 'Plumbing']), Competition__c: ev(['Has Offers']) }) }));
    expect(p.patch.Major_Repairs_Needed__c).toBe('Roof;Plumbing');
    expect(p.patch.Competition__c).toBeUndefined();
    expect(p.kept).toEqual([]);
  });
  it('a currency is filled only over blank or zero and written as a number', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Seller_s_Asking_Price__c: 0, Amount_Owed__c: 120000 }, mapped: mapped('interested', { Seller_s_Asking_Price__c: ev(350000), Amount_Owed__c: ev(150000) }) }));
    expect(p.patch.Seller_s_Asking_Price__c).toBe(350000);
    expect(p.kept).toEqual([{ field: 'Amount_Owed__c', label: 'Amount Owed', current: '120000', proposed: '150000', evidence: 'seller words' }]);
  });
  it('5a Fix 1 (I-1): an amount owed of 0 is the rep\'s value ("free and clear"); an asking price of 0 is blank', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Seller_s_Asking_Price__c: 0, Amount_Owed__c: 0 }, mapped: mapped('interested', { Seller_s_Asking_Price__c: ev(350000), Amount_Owed__c: ev(150000) }) }));
    expect(p.patch.Seller_s_Asking_Price__c).toBe(350000);
    expect(p.patch.Amount_Owed__c).toBeUndefined();
    expect(p.kept).toEqual([{ field: 'Amount_Owed__c', label: 'Amount Owed', current: '0', proposed: '150000', evidence: 'seller words' }]);
  });
  it('a declined value is written only over blank or a never-write value', () => {
    const decline = { Timeline__c: ev("Seller Wouldn't Disclose") };
    expect(buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Timeline__c: null }, mapped: mapped('interested', decline) })).patch.Timeline__c).toBe("Seller Wouldn't Disclose");
    expect(buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Timeline__c: "Didn't Ask" }, mapped: mapped('interested', decline) })).patch.Timeline__c).toBe("Seller Wouldn't Disclose");
    const overReal = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Motivation__c: 'Divorce' }, mapped: mapped('interested', { Motivation__c: ev("Seller Wouldn't Say") }) }));
    expect(overReal.patch.Motivation__c).toBeUndefined();
    const condition = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Condition__c: "Seller Didn't Say" }, mapped: mapped('interested', { Condition__c: ev("Seller Didn't Say") }) }));
    expect(condition.patch.Condition__c).toBeUndefined();
    expect(condition.kept).toEqual([]);
  });
  it('never writes a never-write value even if one reached the plan', () => {
    const p = buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Condition__c: null }, mapped: mapped('interested', { Condition__c: ev("I Didn't Ask") }) }));
    expect(p.patch.Condition__c).toBeUndefined();
    expect(p.skipped).toContainEqual({ field: 'Condition__c', label: 'Condition', why: 'invalid_value' });
  });
});

describe('buildWritePlan: the appointment', () => {
  it('18: a converted Lead is the Opportunity case; the carried Timeline is a rep\'s value', () => {
    const p = buildWritePlan(
      opp({
        outcome: 'appointment_set',
        appointment: BOOKED,
        current: { StageName: 'New Opportunity', Rating__c: null, Timeline__c: '90 Days' },
        researchStatus: null,
        converted: { fromLeadId: '00Q8X00001AbCdEUAV' },
        mapped: mapped('interested', { Timeline__c: { value: '30 Days', evidence: 'within a month' } }),
      }),
    );
    expect(p.sfObject).toBe('Opportunity');
    expect(p.appointment?.kind).toBe('opportunity_event');
    expect(p.appointment?.onBooked).toEqual({ StageName: 'Appointment Set', Rating__c: 'Hot' });
    expect(p.patch).toEqual({});
    expect(p.kept).toEqual([{ field: 'Timeline__c', label: 'Timeline', current: '90 Days', proposed: '30 Days', evidence: 'within a month' }]);
  });
  it('19: a Lead that books but was not converted takes the hold fallback: Working and Hot in the base patch', () => {
    const p = buildWritePlan(lead({ outcome: 'appointment_set', appointment: BOOKED }));
    expect(p.result).toBe('appointment');
    expect(p.patch).toEqual({ Status: 'Working', Rating: 'Hot' });
    expect(p.appointment).toEqual({ booked: BOOKED, kind: 'lead_hold', onBooked: {}, onConflict: {}, onBookedChanges: [], onConflictChanges: [] });
  });
  it('an Opportunity stage the tables do not move from keeps its stage and Rating on booking (5a Fix 1, I-3)', () => {
    const p = buildWritePlan(opp({ outcome: 'appointment_set', appointment: BOOKED, current: { StageName: 'Negotiation' }, researchStatus: 'Negotiation' }));
    expect(p.appointment?.onBooked).toEqual({});
    expect(p.appointment?.onConflict).toEqual({});
    expect(p.skipped).toEqual([
      { field: 'StageName', label: 'Stage', why: 'not_from_state' },
      { field: 'Rating__c', label: 'Rating', why: 'not_from_state' },
    ]);
  });
  it('an Opportunity already at Appointment Set books again: no stage move, and no skip from the conflict moves', () => {
    const p = buildWritePlan(opp({ outcome: 'appointment_set', appointment: BOOKED, current: { StageName: 'Appointment Set', Rating__c: 'Warm' }, researchStatus: 'Appointment Set' }));
    expect(p.appointment?.onBooked).toEqual({ Rating__c: 'Hot' });
    // 5a Fix 1 (I-3): Appointment Set is outside the from-states, so a conflict leaves the follow-up to the conflict Task
    expect(p.appointment?.onConflict).toEqual({});
    expect(p.skipped).toEqual([]);
  });
  it('appointment_set without a stored booking is a callback', () => {
    const p = buildWritePlan(opp({ outcome: 'appointment_set', appointment: null }));
    expect(p.result).toBe('callback');
    expect(p.appointment).toBeNull();
  });
  it('a converted plan must target the Opportunity', () => {
    expect(() => buildWritePlan(lead({ converted: { fromLeadId: '00Q8X00001AbCdEUAV' } }))).toThrow(/Opportunity/);
  });
});

describe('StoredWritePlan', () => {
  it('17: round-trips through JSON (jsonb)', () => {
    const plans = [
      buildWritePlan(opp({ outcome: 'appointment_set', appointment: BOOKED, mapped: mapped('interested', { Timeline__c: { value: '90 Days', evidence: 'ninety days' } }) })),
      buildWritePlan(lead({ outcome: 'do_not_call', mapped: null })),
      buildWritePlan(lead({ current: { Status: 'Long Term Follow-Up', Timeline__c: '30 Days', Seller_s_Asking_Price__c: null }, mapped: mapped('interested', { Timeline__c: { value: '90 Days', evidence: 'x' }, Seller_s_Asking_Price__c: { value: 350000, evidence: '350' } }) })),
    ];
    for (const plan of plans) expect(StoredWritePlan.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });
  it('refuses a drifted row', () => {
    const plan = buildWritePlan(lead());
    expect(StoredWritePlan.safeParse({ ...plan, result: 'maybe' }).success).toBe(false);
    expect(StoredWritePlan.safeParse({ ...plan, changes: [{ field: 'Status' }] }).success).toBe(false);
  });
});
