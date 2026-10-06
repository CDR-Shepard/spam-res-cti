import type { BookedAppointment } from '@cti/contracts';
import { describe, expect, it } from 'vitest';
import { prodDescribe } from '../test/writeback-describes.js';
import { writableFields } from './fields.js';
import { buildWritePlan, type Change, type WritePlan } from './plan.js';
import { CHANGES_MAX, CHATTER_MAX, changesFieldText, chatterText, ptWords, type RenderInput } from './render.js';

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
  it('an adopted conversion says so', () => {
    const { plan, written } = oppBooking('phone', true);
    const text = changesFieldText(base(plan, written, { conversion: { leadName: null, ownerName: 'Grant Golden', adopted: true } }));
    expect(text).toContain('Created\n- The Lead was already converted; wrote to its Opportunity\n- Chatter post');
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
        'AI call · Oct 6, 3:12 PM PT · Appointment set',
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
      'AI call · Oct 6, 3:12 PM PT · Appointment set',
      'Converted from Lead by the AI after the seller booked.',
      'Booked: walkthrough at 12 Oak St, Fresno with Grant, Wed Oct 7, 11:00 AM PT',
    ]);
    expect(text.length).toBeLessThanOrEqual(CHATTER_MAX);
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
        'AI call · Oct 6, 3:12 PM PT · Appointment set',
        'Not converted to an Opportunity (INSUFFICIENT_ACCESS: no Convert Leads permission): a hold and a "convert and book" Task were created.',
        'Booked: phone consultation with Grant, Wed Oct 7, 11:00 AM PT (seller: 2:00 PM ET)',
        'Changed: Status → Working; Rating → Hot',
        `Call details: ${URL}`,
      ].join('\n'),
    );
  });
  it('a call that changed nothing says so', () => {
    const { plan } = oppBooking('phone', false);
    const text = chatterText(base(plan, [], { outcomeWords: 'Wrong number', appointmentWords: null, summary: null }));
    expect(text).toBe(['AI call · Oct 6, 3:12 PM PT · Wrong number', 'Changed: nothing', `Call details: ${URL}`].join('\n'));
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
