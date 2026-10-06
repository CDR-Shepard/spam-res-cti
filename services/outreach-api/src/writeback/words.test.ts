import { describe, expect, it } from 'vitest';
import type { OwnerUser } from '../appointments/calendar.js';
import { booked } from '../test/render-fixtures.js';
import { appointmentWords } from './words.js';

const owner: OwnerUser = { sfUserId: '0058X00000Fsx39QAB', name: 'Grant Golden', firstName: 'Grant', timeZone: 'America/Los_Angeles', isActive: true, zoneRefused: null };
const words = (result: Parameters<typeof appointmentWords>[0]['result'], task: Parameters<typeof appointmentWords>[0]['task'] = null) =>
  appointmentWords({ booked: booked('phone'), result, owner, address: null, sellerZone: null, task });

describe('appointmentWords (final review I-1: only what was made)', () => {
  it('a hold and a Task, both made', () => {
    expect(words({ kind: 'lead_hold', eventId: '00U8X00000Hold1QAA', taskId: '00T8X00000Task1QAA' })).toBe(
      "phone consultation Wed Oct 7, 11:00 AM PT held on Grant Golden's calendar; the Lead was not converted (Task to Grant Golden)",
    );
  });

  it('a refused hold is never said to be held', () => {
    const text = words({ kind: 'lead_hold', eventId: null, taskId: '00T8X00000Task1QAA' })!;
    expect(text).toBe('phone consultation for Wed Oct 7, 11:00 AM PT not held: Salesforce refused the hold; the Lead was not converted (Task to Grant Golden)');
  });

  it('a refused Task is never said to be sent', () => {
    expect(words({ kind: 'lead_hold', eventId: '00U8X00000Hold1QAA', taskId: null, taskCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' })).toBe(
      "phone consultation Wed Oct 7, 11:00 AM PT held on Grant Golden's calendar; the Lead was not converted (the Task to Grant Golden was refused, FIELD_CUSTOM_VALIDATION_EXCEPTION: follow up by hand)",
    );
  });

  it('both refused', () => {
    const text = words({ kind: 'lead_hold', eventId: null, taskId: null })!;
    expect(text).toContain('not held: Salesforce refused the hold');
    expect(text).toContain('the Task to Grant Golden was refused');
  });

  it('a conflict names the Task only when it was made', () => {
    expect(words({ kind: 'conflict' }, { made: true })).toBe('phone consultation for Wed Oct 7, 11:00 AM PT not booked: the calendar was taken (Task to Grant Golden)');
    expect(words({ kind: 'conflict' }, { made: false, code: 'INVALID_CROSS_REFERENCE_KEY' })).toBe(
      'phone consultation for Wed Oct 7, 11:00 AM PT not booked: the calendar was taken (the Task to Grant Golden was refused, INVALID_CROSS_REFERENCE_KEY: follow up by hand)',
    );
    expect(words({ kind: 'conflict' }, null)).toBe('phone consultation for Wed Oct 7, 11:00 AM PT not booked: the calendar was taken');
  });

  it('a refused Event and a passed time say the same about their Task', () => {
    expect(words({ kind: 'refused', code: 'X' }, { made: false })).toContain('(the Task to Grant Golden was refused: follow up by hand)');
    expect(words({ kind: 'expired' }, { made: true })).toContain('(Task to Grant Golden)');
  });
});
