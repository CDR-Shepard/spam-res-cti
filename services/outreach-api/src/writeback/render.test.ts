import type { BookedAppointment } from '@cti/contracts';
import { describe, expect, it } from 'vitest';
import { prodDescribe } from '../test/writeback-describes.js';
import { writableFields } from './fields.js';
import { buildWritePlan, type Change, type WritePlan } from './plan.js';
import { CHANGES_MAX, CHATTER_MAX, changesFieldText, chatterMarker, chatterText, ptWords, type RenderInput } from './render.js';

const AT = new Date('2026-10-06T22:12:00.000Z'); // Tue Oct 6, 3:12 PM PT
const CALL_ID = '6f0c2a9e-1b2c-4d5e-8f90-123456789abc';
const URL = `https://outreach.example.com/campaigns/c1?call=${CALL_ID}`;
const OPP = writableFields(prodDescribe('Opportunity'), 'Opportunity');
const LEAD = writableFields(prodDescribe('Lead'), 'Lead');
const booked = (kind: 'phone' | 'walkthrough'): BookedAppointment => ({
  slotId: kind === 'phone' ? 'p1' : 'w1',
  kind,
  start: '2026-10-07T18:00:00.000Z',
  end: kind === 'phone' ? '2026-10-07T18:15:00.000Z' : '2026-10-07T19:00:00.000Z',
  specialistSfUserId: '0058X00000Fsx39QAB',
  addressConfirmed: kind === 'walkthrough',
  note: '',
  bookedAt: '2026-10-06T22:10:00.000Z',
});
const answers = {
  Timeline__c: { value: '90 Days', evidence: 'probably in about 90 days' },
  Motivation__c: { value: 'Relocating OOS', evidence: 'we are moving to Texas' },
  Condition__c: { value: '3 - Major Fixer with Major Issues', evidence: 'the roof needs replacing' },
  Major_Repairs_Needed__c: { value: ['Roof'], evidence: 'the roof needs replacing' },
};

/** The Opportunity plan for a booked call; `written` is what the run step would report (base changes + onBooked). */
function oppBooking(kind: 'phone' | 'walkthrough', converted: boolean): { plan: WritePlan; written: Change[] } {
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

const base = (plan: WritePlan, written: Change[], over: Partial<RenderInput> = {}): RenderInput => ({
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

describe('ptWords', () => {
  it('says the Pacific wall clock with PT, across both DST changes', () => {
    expect(ptWords(AT)).toBe('Tue Oct 6, 3:12 PM PT');
    expect(ptWords(new Date('2026-01-15T20:00:00.000Z'))).toBe('Thu Jan 15, 12:00 PM PT');
    expect(ptWords(new Date('2026-03-08T09:59:00.000Z'))).toBe('Sun Mar 8, 1:59 AM PT'); // PST, a minute before the spring gap
    expect(ptWords(new Date('2026-03-08T10:00:00.000Z'))).toBe('Sun Mar 8, 3:00 AM PT'); // PDT
    expect(ptWords(new Date('2026-11-01T08:30:00.000Z'))).toBe('Sun Nov 1, 1:30 AM PT'); // PDT, first 1:30
    expect(ptWords(new Date('2026-11-01T09:30:00.000Z'))).toBe('Sun Nov 1, 1:30 AM PT'); // PST, second 1:30
    expect(ptWords(new Date('2026-10-07T07:05:00.000Z'))).toBe('Wed Oct 7, 12:05 AM PT');
  });
});

describe('changesFieldText (spec §5.5)', () => {
  it('an Opportunity that booked a phone consultation', () => {
    const { plan, written } = oppBooking('phone', false);
    const created = ['Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden', 'Chatter post'];
    const notWritten = [{ label: 'Rating', reason: 'Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)' }];
    expect(changesFieldText(base(plan, written, { applied: { written, notWritten, created } }))).toBe(
      [
        'AI call on Tue Oct 6, 3:12 PM PT · Appointment set · AI call 6f0c2a9e…',
        'Changed',
        '- Stage: Closed Lost → Appointment Set',
        '- Rating: Cold → Hot',
        "- Timeline: Didn't Ask → 90 Days",
        '- Motivation: (blank) → Relocating OOS',
        '- Major Repairs Needed: (blank) → Roof',
        'Created',
        '- Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden',
        '- Chatter post',
        "Kept the rep's value",
        '- Condition: kept "5 - Cosmetic Fixer" (seller said: "the roof needs replacing")',
        'Not written',
        '- Rating: Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)',
      ].join('\n'),
    );
  });
  it('a converted Lead that booked a walkthrough', () => {
    const { plan, written } = oppBooking('walkthrough', true);
    const created = ['Event: Property Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden', 'Chatter post'];
    const text = changesFieldText(
      base(plan, written, { applied: { written, notWritten: [], created }, conversion: { leadName: 'Jane Seller', ownerName: 'Grant Golden', adopted: false } }),
    );
    expect(text).toBe(
      [
        'AI call on Tue Oct 6, 3:12 PM PT · Appointment set · AI call 6f0c2a9e…',
        'Changed',
        '- Stage: New Opportunity → Appointment Set',
        '- Rating: (blank) → Hot',
        "- Timeline: Didn't Ask → 90 Days",
        '- Motivation: (blank) → Relocating OOS',
        '- Major Repairs Needed: (blank) → Roof',
        'Created',
        '- Converted Lead "Jane Seller" into this Opportunity (owner Grant Golden); new Account and Contact',
        '- Event: Property Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden',
        '- Chatter post',
        "Kept the rep's value",
        '- Condition: kept "5 - Cosmetic Fixer" (seller said: "the roof needs replacing")',
      ].join('\n'),
    );
  });
  it('a conversion a rep made first says who converted it, never that the AI did', () => {
    const { plan, written } = oppBooking('phone', true);
    const text = changesFieldText(base(plan, written, { conversion: { leadName: null, ownerName: 'Grant Golden', adopted: true, convertedBy: 'Sam Setter' } }));
    expect(text).toContain('Created\n- Lead was already converted by Sam Setter; wrote to its Opportunity\n- Chatter post');
    const unknown = changesFieldText(base(plan, written, { conversion: { leadName: null, ownerName: 'Grant Golden', adopted: true, convertedBy: null } }));
    expect(unknown).toContain('- Lead was already converted by a rep; wrote to its Opportunity');
  });
  it('the fallback: a Lead that could not be converted, with the mapping unavailable', () => {
    const plan = buildWritePlan({
      sfObject: 'Lead',
      outcome: 'appointment_set',
      mapped: null,
      current: { Status: 'Long Term Follow-Up', Rating: 'Hot' },
      researchStatus: 'Working',
      fields: LEAD,
      appointment: booked('phone'),
      callbackAt: null,
      now: AT,
      converted: null,
    });
    const created = ['Hold: AI-booked phone call – convert Jane Seller, Wed Oct 7, 11:00 AM PT, owner Grant Golden', 'Task: convert and book, owner Grant Golden', 'Chatter post'];
    const text = changesFieldText(base(plan, plan.changes, { applied: { written: plan.changes, notWritten: [], created }, conversionRefused: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Hunt_Winner_Owner_Change' }));
    expect(text).toBe(
      [
        'AI call on Tue Oct 6, 3:12 PM PT · Appointment set · AI call 6f0c2a9e…',
        'Created',
        '- Hold: AI-booked phone call – convert Jane Seller, Wed Oct 7, 11:00 AM PT, owner Grant Golden',
        '- Task: convert and book, owner Grant Golden',
        '- Chatter post',
        'Not written',
        '- Lead not converted: FIELD_CUSTOM_VALIDATION_EXCEPTION: Hunt_Winner_Owner_Change; a hold and a "convert and book" Task were created instead',
        'Not filled',
        '- Status: changed in Salesforce since the AI\'s research, so left alone',
        '- Rating: changed in Salesforce since the AI\'s research, so left alone',
        '- Fill-blanks skipped: the answer mapping was unavailable',
      ].join('\n'),
    );
  });
  it('words every skip reason', () => {
    const plan: WritePlan = {
      ...oppBooking('phone', false).plan,
      kept: [],
      skipped: [
        { field: 'StageName', label: 'Stage', why: 'not_from_state' },
        { field: 'Mold__c', label: 'Mold', why: 'not_writable' },
        { field: 'Occupancy__c', label: 'Occupancy', why: 'invalid_value' },
      ],
    };
    const text = changesFieldText(base(plan, [], { applied: { written: [], notWritten: [], created: [] } }));
    expect(text).toBe(
      [
        'AI call on Tue Oct 6, 3:12 PM PT · Appointment set · AI call 6f0c2a9e…',
        'Not filled',
        '- Stage: left at its current value (the AI only moves it from the usual starting values)',
        "- Mold: the connected Salesforce user can't edit it",
        '- Occupancy: the value is not in this org\'s picklist',
      ].join('\n'),
    );
  });
  it('strips control characters, keeps one item per line, and shows (blank) for null', () => {
    const written: Change[] = [{ field: 'Reason_For_Selling__c', label: 'Reason\tFor Selling?', before: null, after: 'job\nmove\u0007 now\u0000', why: 'filled' }];
    const text = changesFieldText(base(oppBooking('phone', false).plan, written, { applied: { written, notWritten: [], created: [] } }));
    expect(text).toContain('- ReasonFor Selling?: (blank) → job move now');
    expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F]/);
  });
  it('200 changes stay within CHANGES_MAX and end with …', () => {
    const written: Change[] = Array.from({ length: 200 }, (_, n) => ({ field: `F${n}__c`, label: `Field ${n}`, before: 'x'.repeat(100), after: 'y'.repeat(100), why: 'filled' as const }));
    const text = changesFieldText(base(oppBooking('phone', false).plan, written, { applied: { written, notWritten: [], created: [] } }));
    expect(text.length).toBeLessThanOrEqual(CHANGES_MAX);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('chatterText (spec §5.6)', () => {
  it('an Opportunity that booked', () => {
    const { plan, written } = oppBooking('phone', false);
    expect(chatterText(base(plan, written))).toBe(
      [
        'AI call 6f0c2a9e · Oct 6, 3:12 PM PT · Appointment set',
        'Booked: phone consultation with Grant, Wed Oct 7, 11:00 AM PT (seller: 2:00 PM ET)',
        'Summary: The seller is moving to Texas for work and wants to sell within three months. The roof needs replacing. They booked a call with Grant.',
        'Seller said: Timeline 90 Days · Motivation Relocating OOS · Major Repairs Needed Roof',
        'Changed: Stage → Appointment Set; Rating → Hot; Timeline → 90 Days; +2 more (see AI Last Call Changes)',
        `Call details: ${URL}`,
      ].join('\n'),
    );
  });
  it('a converted Lead that booked a walkthrough says so right after the header', () => {
    const { plan, written } = oppBooking('walkthrough', true);
    const text = chatterText(
      base(plan, written, {
        appointmentWords: 'walkthrough at 12 Oak St, Fresno with Grant, Wed Oct 7, 11:00 AM PT',
        conversion: { leadName: 'Jane Seller', ownerName: 'Grant Golden', adopted: false },
      }),
    );
    expect(text.split('\n').slice(0, 3)).toEqual([
      'AI call 6f0c2a9e · Oct 6, 3:12 PM PT · Appointment set',
      'Converted from Lead by the AI after the seller booked.',
      'Booked: walkthrough at 12 Oak St, Fresno with Grant, Wed Oct 7, 11:00 AM PT',
    ]);
    expect(text.length).toBeLessThanOrEqual(CHATTER_MAX);
  });
  it('a conversion a rep made first: the post names who converted it, never "by the AI"', () => {
    const { plan, written } = oppBooking('phone', true);
    const text = chatterText(base(plan, written, { conversion: { leadName: 'Jane Seller', ownerName: 'Grant Golden', adopted: true, convertedBy: 'Sam Setter' } }));
    expect(text.split('\n')[1]).toBe('Lead was already converted by Sam Setter.');
    expect(text).not.toContain('by the AI');
    const unknown = chatterText(base(plan, written, { conversion: { leadName: 'Jane Seller', ownerName: 'Grant Golden', adopted: true } }));
    expect(unknown.split('\n')[1]).toBe('Lead was already converted by a rep.');
  });
  it('the fallback says the Lead was not converted, and why', () => {
    const plan = buildWritePlan({
      sfObject: 'Lead',
      outcome: 'appointment_set',
      mapped: null,
      current: { Status: 'Long Term Follow-Up', Rating: null },
      researchStatus: 'Long Term Follow-Up',
      fields: LEAD,
      appointment: booked('phone'),
      callbackAt: null,
      now: AT,
      converted: null,
    });
    expect(chatterText(base(plan, plan.changes, { summary: null, conversionRefused: 'INSUFFICIENT_ACCESS: no Convert Leads permission' }))).toBe(
      [
        'AI call 6f0c2a9e · Oct 6, 3:12 PM PT · Appointment set',
        'Not converted to an Opportunity (INSUFFICIENT_ACCESS: no Convert Leads permission): a hold and a "convert and book" Task were created.',
        'Booked: phone consultation with Grant, Wed Oct 7, 11:00 AM PT (seller: 2:00 PM ET)',
        'Changed: Status → Working; Rating → Hot',
        `Call details: ${URL}`,
      ].join('\n'),
    );
  });
  it('M4: the first line carries the call marker, so a retry can find a post whose answer was lost', () => {
    const { plan, written } = oppBooking('phone', false);
    expect(chatterMarker(CALL_ID)).toBe('AI call 6f0c2a9e ·');
    const long = chatterText(base(plan, written, { summary: 'w'.repeat(5_000), appointmentWords: 'b'.repeat(2_000) }));
    expect(long.startsWith(`${chatterMarker(CALL_ID)} `)).toBe(true);
  });
  it('a call that changed nothing says so', () => {
    const { plan } = oppBooking('phone', false);
    const text = chatterText(base(plan, [], { outcomeWords: 'Wrong number', appointmentWords: null, summary: null }));
    expect(text).toBe(['AI call 6f0c2a9e · Oct 6, 3:12 PM PT · Wrong number', 'Changed: nothing', `Call details: ${URL}`].join('\n'));
  });
  it('a 5,000-character summary: ≤ 980 characters, cut in order, still ending with the URL line', () => {
    const { plan, written } = oppBooking('phone', false);
    const oneSentence = chatterText(base(plan, written, { summary: `${'Short first sentence.'} ${'word '.repeat(1000)}` }));
    expect(oneSentence).toContain('Summary: Short first sentence.\n');
    expect(oneSentence).toContain('Seller said:');
    const long = chatterText(base(plan, written, { summary: 'w'.repeat(5_000) }));
    expect(long.length).toBeLessThanOrEqual(CHATTER_MAX);
    expect(long.endsWith(`\nCall details: ${URL}`)).toBe(true);
    expect(long).toContain(`Summary: ${'w'.repeat(199)}…\n`);
  });
  it('drops "Seller said", then shortens the change list, and never cuts the conversion or URL lines', () => {
    const many: Change[] = Array.from({ length: 30 }, (_, n) => ({ field: `F${n}`, label: `A long field label number ${n}`, before: null, after: 'v'.repeat(120), why: 'filled' as const }));
    const { plan } = oppBooking('phone', true);
    const text = chatterText(base(plan, many, { summary: 's'.repeat(400), appointmentWords: 'b'.repeat(400), conversion: { leadName: 'J', ownerName: 'G', adopted: false } }));
    expect(text.length).toBeLessThanOrEqual(CHATTER_MAX);
    expect(text).not.toContain('Seller said:');
    expect(text).toContain('Changed: +30 changes (see AI Last Call Changes)');
    expect(text).toContain('\nConverted from Lead by the AI after the seller booked.\n');
    expect(text.endsWith(`\nCall details: ${URL}`)).toBe(true);
  });
  it('strips control characters from the summary', () => {
    const { plan, written } = oppBooking('phone', false);
    const text = chatterText(base(plan, written, { summary: 'Hi\u0000 there\u001b[31m.\tOk' }));
    expect(text).toContain('Summary: Hi there[31m.Ok');
    expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F]/);
  });
});

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
