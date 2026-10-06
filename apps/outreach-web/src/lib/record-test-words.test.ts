import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { costWords, offerNoteWords, recordTestErrorText, recordTestSearch } from './record-test-words';

describe('record test words', () => {
  it('keeps only a uuid ?id=', () => {
    expect(recordTestSearch({ id: '55555555-5555-4555-8555-555555555555' })).toEqual({ id: '55555555-5555-4555-8555-555555555555' });
    expect(recordTestSearch({ id: 'nope' })).toEqual({});
    expect(recordTestSearch({ id: 7 })).toEqual({});
  });

  it('words each offer note, and an unknown one plainly', () => {
    expect(offerNoteWords('no_free_time')).toBe('No free time in the next 15 days, so no times would be offered.');
    expect(offerNoteWords('constructor')).toBe('No times would be offered.');
    expect(offerNoteWords(null)).toBe('No times would be offered.');
  });

  it('rounds the cost to cents', () => {
    expect(costWords(41_600)).toBe('This preview cost about $0.04.');
  });

  it('a 429 without a readable retryAt keeps the server words; other errors use the common words', () => {
    expect(recordTestErrorText(new ApiRequestError(429, 'RATE_LIMITED', 'Slow down. Try again at 3:42 PM PT.', { retryAt: 'soon' }))).toBe('Slow down. Try again at 3:42 PM PT.');
    expect(recordTestErrorText(new ApiRequestError(409, 'PREVIEW_RUNNING', 'Your last preview is still running.'))).toBe('Your last preview is still running.');
    expect(recordTestErrorText(new Error('x'))).toBe('Something went wrong. Try again.');
  });
});
