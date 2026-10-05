import { describe, expect, it } from 'vitest';
import { OUTCOME_WORDS, ctiDisposition, outcomeWords, qualificationLines } from './outcomes.js';

describe('OUTCOME_WORDS', () => {
  it('has the agreed words for every outcome (the SF subject and the UI read it)', () => {
    expect(OUTCOME_WORDS).toEqual({
      qualified_transferred: 'Transferred to rep',
      qualified_callback: 'Callback requested',
      not_interested: 'Not interested',
      do_not_call: 'Do not call',
      voicemail: 'Left voicemail',
      no_answer: 'No answer',
      busy: 'Busy',
      failed: 'Failed',
      wrong_number: 'Wrong number',
      hung_up: 'Hung up',
      transfer_failed: 'Transfer missed — callback promised',
      blocked: 'Blocked',
      other: 'Other',
    });
  });

  it('outcomeWords falls back for an unknown or missing outcome', () => {
    expect(outcomeWords('busy')).toBe('Busy');
    expect(outcomeWords(null)).toBe('No outcome');
    expect(outcomeWords('banana')).toBe('banana');
  });
});

describe('ctiDisposition', () => {
  it.each([
    ['qualified_transferred', 'Connected'],
    ['qualified_callback', 'Connected'],
    ['not_interested', 'Connected'],
    ['hung_up', 'Connected'],
    ['transfer_failed', 'Connected'],
    ['other', 'Connected'],
    ['voicemail', 'Left voicemail'],
    ['no_answer', 'No answer'],
    ['busy', 'Busy'],
    ['wrong_number', 'Wrong number'],
    ['do_not_call', 'Do not call'],
    ['failed', 'Failed'],
  ])('%s → %s (the rep wrap-up vocabulary; never null, or the call blocks the rep’s next dial)', (outcome, want) => {
    expect(ctiDisposition(outcome)).toBe(want);
  });

  it('a missing outcome still has a disposition', () => {
    expect(ctiDisposition(null)).toBe('Other');
  });
});

describe('qualificationLines', () => {
  it('labels the known non-empty fields in a fixed order and ignores the rest', () => {
    expect(
      qualificationLines({ timeline: '3 months', motivation: 'relocating', decision_makers: '', bogus: 'x', price_expectation: 250 }),
    ).toEqual(['- Motivation: relocating', '- Timeline: 3 months']);
  });

  it('is empty for nothing usable', () => {
    expect(qualificationLines(null)).toEqual([]);
    expect(qualificationLines([])).toEqual([]);
    expect(qualificationLines({ decision_makers: '  ' })).toEqual([]);
  });
});
