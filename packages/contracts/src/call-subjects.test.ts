import { describe, expect, it } from 'vitest';
import { AI_CALL_SUBJECT, AI_CONVERSATION_SUBJECT, ctiSubjectDisposition } from './call-subjects.js';

describe('ctiSubjectDisposition', () => {
  it.each<[string, string | null]>([
    ['Outbound Call | Connected | (619) 555-0142 / Pat Seller', 'Connected'],
    ['Inbound Call | Not dispositioned | (619) 555-0142', 'Not dispositioned'],
    ['Inbound Call | (619) 555-0142 / Pat Seller', null],
    ['Outgoing | Dana Rep', null],
    ['AI call: Connected', null],
  ])('%j → %j', (subject, expected) => {
    expect(ctiSubjectDisposition(subject)).toBe(expected);
  });
});

describe('AI call subjects', () => {
  it('a conversation outcome counts; a callback to-do or a missed call is an AI call Task but no conversation', () => {
    expect(AI_CONVERSATION_SUBJECT.test('AI call: Appointment set')).toBe(true);
    expect(AI_CONVERSATION_SUBJECT.test('AI call: callback Thursday')).toBe(false);
    expect(AI_CONVERSATION_SUBJECT.test('AI call: No answer')).toBe(false);
    expect(AI_CALL_SUBJECT.test('AI call: callback Thursday')).toBe(true);
  });
});
