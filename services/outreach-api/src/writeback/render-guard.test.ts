/** The changes text and Chatter post: 5a Fix 1 and sweep cases (date-times, do-not-call, transfers, held fields). */
import { describe, expect, it } from 'vitest';
import { prodDescribe } from '../test/writeback-describes.js';
import { AT, OPP, base, booked, oppBooking } from '../test/render-fixtures.js';
import { writableFields } from './fields.js';
import { buildWritePlan, type Change, type WritePlan } from './plan.js';
import { CHATTER_MAX, changesFieldText, chatterText } from './render.js';
describe('5a Fix 1 (M-7): date-times are shown in Pacific words', () => {
  const followUp = (before: string | null, after: string): Change => ({ field: 'Next_Follow_Up_Date__c', label: 'Next Follow-Up Date', before, after, why: 'follow_up' });
  it('both the before (Salesforce "+0000" form) and the after (ISO) in the changes text and in Chatter', () => {
    const { plan } = oppBooking('phone', false);
    const written = [followUp('2026-10-05T17:00:00.000+0000', '2026-10-07T17:00:00.000Z')];
    const input = base(plan, written, { applied: { written, notWritten: [], created: [] }, appointmentWords: null, summary: null });
    expect(changesFieldText(input)).toContain('- Next Follow-Up Date: Mon Oct 5, 10:00 AM PT → Wed Oct 7, 10:00 AM PT');
    expect(chatterText(input)).toContain('Changed: Next Follow-Up Date → Wed Oct 7, 10:00 AM PT');
  });
  it('leaves other values alone, including a bare date', () => {
    const { plan } = oppBooking('phone', false);
    const written = [{ ...followUp(null, '2026-10-07'), label: 'Follow-up day' }, { field: 'Timeline__c', label: 'Timeline', before: null, after: '90 Days', why: 'filled' as const }];
    const text = changesFieldText(base(plan, written, { applied: { written, notWritten: [], created: [] } }));
    expect(text).toContain('- Follow-up day: (blank) → 2026-10-07');
    expect(text).toContain('- Timeline: (blank) → 90 Days');
  });
});

describe('5a Fix 1 (M-8): a do-not-call flag that could not be set has its own section', () => {
  const dncPlan = (): WritePlan => {
    const fields = writableFields(prodDescribe('Lead', ['DoNotCall']), 'Lead');
    return buildWritePlan({
      sfObject: 'Lead', outcome: 'do_not_call', mapped: null, current: { Status: 'Working', DoNotCall: false, Skip_on_Dialer__c: false },
      researchStatus: 'Working', fields, appointment: null, callbackAt: null, now: AT, converted: null,
    });
  };
  it('a plan skip and a Salesforce refusal of a DNC field go under "Could not set do-not-call flag", not "Not filled"/"Not written"', () => {
    const plan = dncPlan();
    expect(plan.skipped).toEqual([{ field: 'DoNotCall', label: 'DoNotCall', why: 'not_writable' }]);
    const notWritten = [
      { field: 'Skip_on_Dialer__c', label: 'Skip on Dialer', reason: 'Salesforce refused (INSUFFICIENT_ACCESS)' },
      { label: 'Rating', reason: 'Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)' },
    ];
    const written = plan.changes.filter((c) => c.field !== 'Skip_on_Dialer__c');
    const text = changesFieldText(base(plan, written, { outcomeWords: 'Do not call', applied: { written, notWritten, created: [] }, appointmentWords: null }));
    expect(text.split('\n').slice(0, 4)).toEqual([
      'AI call on Tue Oct 6, 3:12 PM PT · Do not call · AI call 6f0c2a9e…',
      'Could not set do-not-call flag',
      "- DoNotCall: the connected Salesforce user can't edit it",
      '- Skip on Dialer: Salesforce refused (INSUFFICIENT_ACCESS)',
    ]);
    expect(text).toContain('Not written\n- Rating: Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)');
    expect(text).toContain('Not filled\n- Fill-blanks skipped: the answer mapping was unavailable');
    expect(text).not.toMatch(/Not filled\n- DoNotCall|Not written\n- Skip on Dialer/);
  });
  it('Chatter says so right after the header, and the line is never cut', () => {
    const plan = dncPlan();
    const input = base(plan, plan.changes, { outcomeWords: 'Do not call', applied: { written: plan.changes, notWritten: [], created: [] }, appointmentWords: null, summary: 'x '.repeat(3_000) });
    const text = chatterText(input);
    expect(text.split('\n')[1]).toBe('Could not set do-not-call flag: DoNotCall (see AI Last Call Changes)');
    expect(text.length).toBeLessThanOrEqual(CHATTER_MAX);
  });
});

describe('5a Fix 1 (M-9): a booking followed by a transfer is noted', () => {
  const transferPlan = (outcome: 'qualified_transferred' | 'transfer_failed', kind: 'phone' | 'walkthrough'): WritePlan =>
    buildWritePlan({
      sfObject: 'Opportunity', outcome, mapped: null, current: { StageName: 'Followup' }, researchStatus: 'Followup',
      fields: OPP, appointment: booked(kind), callbackAt: null, now: AT, converted: null,
    });
  it('transferred: the changes text and Chatter say who took the call', () => {
    const plan = transferPlan('qualified_transferred', 'phone');
    const input = base(plan, [], { outcomeWords: 'Transferred', transferredTo: 'Evren Gomez', appointmentWords: 'phone consultation with Grant, Wed Oct 7, 11:00 AM PT' });
    expect(changesFieldText(input).split('\n')[1]).toBe('Booked phone consultation Wed Oct 7, 11:00 AM PT; then transferred to Evren Gomez');
    expect(chatterText(input)).toContain('Booked: phone consultation with Grant, Wed Oct 7, 11:00 AM PT; then transferred to Evren Gomez');
  });
  it('transfer failed, with no appointment words from the run step', () => {
    const plan = transferPlan('transfer_failed', 'walkthrough');
    const input = base(plan, [], { outcomeWords: 'Transfer failed', appointmentWords: null });
    expect(changesFieldText(input).split('\n')[1]).toBe('Booked walkthrough Wed Oct 7, 11:00 AM PT; then the transfer failed');
    expect(chatterText(input)).toContain('Booked: walkthrough Wed Oct 7, 11:00 AM PT; then the transfer failed');
  });
  it('a transfer to an unnamed person still reads', () => {
    const plan = transferPlan('qualified_transferred', 'phone');
    expect(changesFieldText(base(plan, [], { transferredTo: null })).split('\n')[1]).toBe('Booked phone consultation Wed Oct 7, 11:00 AM PT; then transferred to a rep');
  });
  it('a plain booking adds no line', () => {
    const { plan, written } = oppBooking('phone', false);
    expect(changesFieldText(base(plan, written)).split('\n')[1]).toBe('Changed');
  });
});

describe('sweep: the "Not changed" sections say what happened', () => {
  it('D-21(4): a held Rating or Status is "Not changed", a skipped answer stays "Not filled"', () => {
    const plan = buildWritePlan({
      sfObject: 'Opportunity', outcome: 'not_interested', mapped: { disposition: 'not_now', values: { Timeline__c: { value: 'Never', evidence: 'x' } } },
      current: { StageName: 'Negotiation', Rating__c: 'Hot', Timeline__c: null }, researchStatus: 'Negotiation',
      fields: OPP, appointment: null, callbackAt: null, now: AT, converted: null,
    });
    const text = changesFieldText(base(plan, [], { applied: { written: [], notWritten: [], created: [] }, appointmentWords: null }));
    expect(text).toContain("Not changed\n- Rating: left at its current value (the AI only moves it from the usual starting values)\nNot filled\n- Timeline: the value is not in this org's picklist");
  });
  it('D-24: a field changed since the call is "changed in Salesforce", never "a rep edited it"', () => {
    const { plan } = oppBooking('phone', false);
    const text = changesFieldText(base(plan, [], { applied: { written: [], notWritten: [], created: [], notChanged: [{ label: 'Timeline', now: '30 Days' }] } }));
    expect(text).toContain('Not changed — changed in Salesforce since the call\n- Timeline (now 30 Days)');
    expect(text).not.toContain('a rep edited');
  });
  it('D-25 N3: a field held only because the status moved says so, and is not called edited', () => {
    const { plan } = oppBooking('phone', false);
    const notChanged = [{ label: 'Stage', now: 'Offer Made' }, { label: 'Rating', now: null, held: 'Stage' }];
    const text = changesFieldText(base(plan, [], { applied: { written: [], notWritten: [], created: [], notChanged } }));
    expect(text).toContain('Not changed — changed in Salesforce since the call\n- Stage (now Offer Made)\n- Rating (held: Stage was changed)');
  });
});
