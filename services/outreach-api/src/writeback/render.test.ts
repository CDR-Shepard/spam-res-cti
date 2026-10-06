import { describe, expect, it } from 'vitest';
import { AT, CALL_ID, LEAD, URL, base, booked, oppBooking } from '../test/render-fixtures.js';
import { buildWritePlan, type Change, type WritePlan } from './plan.js';
import { CHANGES_MAX, CHATTER_MAX, changesFieldText, chatterMarker, chatterText, ptWords, type RenderInput } from './render.js';

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
      current: { Status: 'Long Term Follow-Up', Rating: 'Warm' },
      researchStatus: 'Working',
      fields: LEAD,
      appointment: booked('phone'),
      callbackAt: null,
      now: AT,
      converted: null,
    });
    const created = ['Hold: AI-booked phone call – convert Jane Seller, Wed Oct 7, 11:00 AM PT, owner Grant Golden', 'Task: convert and book, owner Grant Golden', 'Chatter post'];
    const text = changesFieldText(base(plan, plan.changes, { applied: { written: plan.changes, notWritten: [], created }, conversionRefused: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Hunt_Winner_Owner_Change', fallback: { hold: true, task: true } }));
    expect(text).toBe(
      [
        'AI call on Tue Oct 6, 3:12 PM PT · Appointment set · AI call 6f0c2a9e…',
        'Created',
        '- Hold: AI-booked phone call – convert Jane Seller, Wed Oct 7, 11:00 AM PT, owner Grant Golden',
        '- Task: convert and book, owner Grant Golden',
        '- Chatter post',
        'Not written',
        '- Lead not converted: FIELD_CUSTOM_VALIDATION_EXCEPTION: Hunt_Winner_Owner_Change; a hold and a "convert and book" Task were created instead',
        'Not changed',
        '- Status: changed in Salesforce since the AI\'s research, so left alone',
        '- Rating: changed in Salesforce since the AI\'s research, so left alone',
        'Not filled',
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
        'Not changed',
        '- Stage: left at its current value (the AI only moves it from the usual starting values)',
        'Not filled',
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
    expect(chatterText(base(plan, plan.changes, { summary: null, conversionRefused: 'INSUFFICIENT_ACCESS: no Convert Leads permission', fallback: { hold: true, task: true } }))).toBe(
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

describe('final review I-1: the fallback is said as it was made, never assumed', () => {
  const leadPlan = () =>
    buildWritePlan({
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
  const REASON = 'INSUFFICIENT_ACCESS: no Convert Leads permission';
  const changesLine = (fallback: RenderInput['fallback']) => {
    const plan = leadPlan();
    const text = changesFieldText(base(plan, plan.changes, { conversionRefused: REASON, ...(fallback === undefined ? {} : { fallback }) }));
    return text.split('\n').find((l) => l.startsWith('- Lead not converted'));
  };
  const chatterLine = (fallback: RenderInput['fallback']) => {
    const plan = leadPlan();
    const text = chatterText(base(plan, plan.changes, { summary: null, conversionRefused: REASON, ...(fallback === undefined ? {} : { fallback }) }));
    return text.split('\n').find((l) => l.startsWith('Not converted'));
  };

  it('a refused hold: the Task is named, the hold is said to be missing', () => {
    const f = { hold: false, task: true, holdCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' };
    expect(changesLine(f)).toBe(`- Lead not converted: ${REASON}; a "convert and book" Task was created, but no hold could be put on the calendar (INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY)`);
    expect(chatterLine(f)).toBe(`Not converted to an Opportunity (${REASON}): a "convert and book" Task was created, but no hold could be put on the calendar (INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY).`);
  });

  it('a refused Task: the hold is named, the Task is said to be refused', () => {
    const f = { hold: true, task: false, taskCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' };
    expect(changesLine(f)).toBe(`- Lead not converted: ${REASON}; a hold was put on the calendar, but Salesforce refused the "convert and book" Task (FIELD_CUSTOM_VALIDATION_EXCEPTION)`);
    expect(chatterLine(f)).toContain('a hold was put on the calendar, but Salesforce refused the "convert and book" Task');
  });

  it('both refused (no ConvertLeads and no EditEvent): nothing is claimed, and the post says to book it by hand', () => {
    const f = { hold: false, task: false };
    expect(changesLine(f)).toBe(`- Lead not converted: ${REASON}; Salesforce refused both the hold and the "convert and book" Task: nothing is on the calendar, book it by hand`);
    expect(chatterLine(f)).toBe(`Not converted to an Opportunity (${REASON}): Salesforce refused both the hold and the "convert and book" Task: nothing is on the calendar, book it by hand.`);
    const plan = leadPlan();
    const all = changesFieldText(base(plan, plan.changes, { conversionRefused: REASON, fallback: f })) + chatterText(base(plan, plan.changes, { conversionRefused: REASON, fallback: f }));
    expect(all).not.toMatch(/were created|was created|was put on the calendar/);
  });

  it('unknown (no fallback result): only the reason, no claim about a hold or a Task', () => {
    expect(changesLine(undefined)).toBe(`- Lead not converted: ${REASON}`);
    expect(chatterLine(undefined)).toBe(`Not converted to an Opportunity (${REASON}).`);
  });
});
