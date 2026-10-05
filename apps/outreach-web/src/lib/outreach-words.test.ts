import { describe, expect, it } from 'vitest';
import { SkipReason } from '@cti/contracts';
import { ApiRequestError } from './api';
import { errorText, humanize, pauseReasonWords, SKIP_REASON_WORDS, wordFor } from './outreach-words';

describe('outreach words', () => {
  it('has a human label for every SkipReason', () => {
    for (const reason of SkipReason.options) expect(SKIP_REASON_WORDS[reason]).toMatch(/^[A-Z]/);
  });
  it.each([
    ['manual', 'Paused by an admin'],
    ['crm_broken', 'Paused: the Salesforce connection needs to be reconnected'],
    ['ai_budget', "Paused: today's AI budget is used up — resumes tomorrow"],
    ['kill_switch', 'Paused: outreach is switched off'],
  ])('words the pause reason %s', (reason, words) => {
    expect(pauseReasonWords(reason)).toBe(words);
  });
  it('falls back to "Paused" for a missing or unknown pause reason, including prototype keys', () => {
    expect(pauseReasonWords(null)).toBe('Paused');
    expect(pauseReasonWords('carrier_spike')).toBe('Paused');
    expect(pauseReasonWords('constructor')).toBe('Paused');
  });
  it('humanizes unknown codes and ignores prototype keys', () => {
    expect(humanize('left_query')).toBe('Left query');
    expect(wordFor({}, 'toString')).toBe('ToString');
  });
  it('prefers page words, then shared words, then the server message', () => {
    const err = new ApiRequestError(409, 'CRM_NOT_CONNECTED', 'not connected');
    expect(errorText(err, { CRM_NOT_CONNECTED: 'Page words' })).toBe('Page words');
    expect(errorText(err)).toBe('Salesforce is not connected. An admin can connect it in Settings.');
    expect(errorText(new ApiRequestError(500, 'INTERNAL_ERROR', 'Server says no'))).toBe('Server says no');
    expect(errorText(new Error('boom'))).toBe('Something went wrong. Try again.');
  });
});
