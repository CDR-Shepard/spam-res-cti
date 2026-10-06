import { describe, expect, it } from 'vitest';
import { appointmentWords, callSearch } from './call-words';
import { AiCallBlockReason, AiCallFailReason, AiCallOutcome, AiCallStatus, AiConsentStatus, CallGoalKey, CallStage, EvidenceSource, PreferredWindow, QualificationTopic, ResearchSource, ResearchSourceStatus } from '@cti/contracts';
import {
  BLOCK_REASON_WORDS,
  CALL_STATUS_WORDS,
  CALL_STAGE_WORDS,
  CONSENT_WORDS,
  EVIDENCE_WORDS,
  FAIL_REASON_WORDS,
  GOAL_WORDS,
  OUTCOME_WORDS,
  SOURCE_STATUS_WORDS,
  SOURCE_WORDS,
  STRENGTH_WORDS,
  TOPIC_WORDS,
  WINDOW_WORDS,
  aiExitWords,
  notCalledWords,
  sourceLine,
} from './call-words';

describe('sourceLine', () => {
  it('words a missing source', () => {
    expect(sourceLine({ source: 'chatter', status: 'missing', count: 0, truncated: false, note: 'INVALID_TYPE' })).toBe('Chatter: not available in this org');
  });
  it('words a read source, and says when only the most recent were kept', () => {
    expect(sourceLine({ source: 'tasks', status: 'ok', count: 25, truncated: true, note: null })).toBe('Tasks: 25 (most recent)');
    expect(sourceLine({ source: 'notes', status: 'ok', count: 3, truncated: false, note: null })).toBe('Notes: 3');
  });
});

describe('word tables', () => {
  const tables: Array<[string, readonly string[], Record<string, string>]> = [
    ['CALL_STAGE_WORDS', CallStage.options, CALL_STAGE_WORDS],
    ['GOAL_WORDS', CallGoalKey.options, GOAL_WORDS],
    ['WINDOW_WORDS', PreferredWindow.options, WINDOW_WORDS],
    ['SOURCE_WORDS', ResearchSource.options, SOURCE_WORDS],
    ['EVIDENCE_WORDS', EvidenceSource.options, EVIDENCE_WORDS],
    ['SOURCE_STATUS_WORDS', ResearchSourceStatus.options, SOURCE_STATUS_WORDS],
    ['CONSENT_WORDS', AiConsentStatus.options, CONSENT_WORDS],
    ['STRENGTH_WORDS', ['strong', 'moderate', 'weak'], STRENGTH_WORDS],
    ['OUTCOME_WORDS', AiCallOutcome.options, OUTCOME_WORDS],
    ['CALL_STATUS_WORDS', AiCallStatus.options, CALL_STATUS_WORDS],
    ['BLOCK_REASON_WORDS', AiCallBlockReason.options, BLOCK_REASON_WORDS],
    ['FAIL_REASON_WORDS', AiCallFailReason.options, FAIL_REASON_WORDS],
    ['TOPIC_WORDS', QualificationTopic.options, TOPIC_WORDS],
  ];
  it.each(tables)('%s has a non-empty word for every key', (_name, keys, words) => {
    for (const key of keys) expect(words[key]?.length ?? 0, key).toBeGreaterThan(0);
  });

  it('never words an unreadable consent as consent', () => {
    expect(CONSENT_WORDS.unknown).toBe('AI consent: could not be read — research again');
  });
});

describe('TOPIC_WORDS', () => {
  it('words each qualification topic plainly', () => {
    expect(TOPIC_WORDS).toEqual({
      motivation: "why they'd sell",
      timeline: 'timeline',
      condition: 'condition',
      repairs: 'repairs',
      occupancy: 'who lives there',
      price: 'their price in mind',
      competition: 'other offers or agents',
      mortgage: 'what they owe',
      decision_makers: 'who decides',
    });
  });
});

describe('AI call result words', () => {
  it('words the outcomes a person acts on', () => {
    expect(OUTCOME_WORDS.qualified_callback).toBe('Callback booked');
    expect(OUTCOME_WORDS.qualified_transferred).toBe('Transferred to a person');
    expect(CALL_STATUS_WORDS.completed).toBe('Completed');
    expect(OUTCOME_WORDS.appointment_set).toBe('Appointment set');
  });

  it.each([
    ['ai_call_no_consent', 'Not called: no AI consent in Salesforce'],
    ['ai_call_gave_up', 'Not called: gave up after repeated errors'],
    ['ai_call_sf_do_not_call', 'Not called: Do Not Call is checked in Salesforce'],
    ['ai_call_record_not_found', 'Not called: the Salesforce record was not found'],
    ['ai_call_dnc', 'Not called: on the federal Do Not Call list'],
    ['plan_rejected', 'Plan rejected'],
    ['ai_call_no_answer', 'No answer after every attempt'],
    ['ai_call_ended', 'The call ended'],
    ['not_interested', 'Not interested'],
    ['deselected', 'Removed from the lead picker'],
    ['some_new_reason', 'Some new reason'],
  ])('aiExitWords(%s)', (reason, words) => {
    expect(aiExitWords(reason)).toBe(words);
  });

  it('aiExitWords(null) is null', () => {
    expect(aiExitWords(null)).toBeNull();
  });

  it('notCalledWords words a refusal, a failure, a pacer reason and an unknown code', () => {
    expect(notCalledWords('no_consent')).toBe('Not called: no AI consent in Salesforce');
    expect(notCalledWords('twilio_error')).toBe('Not called: the phone carrier refused the call');
    expect(notCalledWords('gave_up')).toBe('Not called: gave up after repeated errors');
    expect(notCalledWords('plan_rejected')).toBe("Not called: the voice agent refused the plan's text");
    expect(notCalledWords('idempotency_conflict')).toBe('Not called: the call request clashed with an earlier one; trying again');
    expect(notCalledWords('brand_new')).toBe('Not called: brand new');
    expect(notCalledWords(null)).toBe('Not called');
  });
});

describe('plan 1D words', () => {
  const booked = { kind: 'phone' as const, start: '2026-10-07T18:00:00.000Z' };
  it('appointmentWords says the kind and the time in the zone given (the viewer\'s by default)', () => {
    expect(appointmentWords(booked, 'America/Los_Angeles')).toBe('Phone call Wed Oct 7, 11:00 AM');
    expect(appointmentWords({ kind: 'walkthrough', start: '2026-10-09T17:00:00.000Z' }, 'America/New_York')).toBe('Walkthrough Fri Oct 9, 1:00 PM');
    expect(appointmentWords(booked)).toMatch(/^Phone call \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
  });

  it('callSearch keeps only a call id that is a uuid', () => {
    expect(callSearch({ call: '99999999-9999-4999-8999-999999999999' })).toEqual({ call: '99999999-9999-4999-8999-999999999999' });
    expect(callSearch({ call: 'javascript:alert(1)' })).toEqual({});
    expect(callSearch({ call: 42 })).toEqual({});
    expect(callSearch({})).toEqual({});
  });
});
