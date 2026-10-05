import { describe, expect, it } from 'vitest';
import { DoNotContactCategory, SkipReason } from '@cti/contracts';
import { ApiRequestError } from './api';
import { DNC_CATEGORY_WORDS, enrollmentStatusWords, errorText, gateStepWords, humanize, pauseReasonWords, SKIP_REASON_WORDS, wordFor } from './outreach-words';

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

describe('plan and review words', () => {
  it('words every enrollment status, adding the exit reason for stopped people', () => {
    expect(enrollmentStatusWords('active', null)).toBe('In sequence');
    expect(enrollmentStatusWords('exited', 'left_query')).toBe('Stopped: left the Salesforce query');
    expect(enrollmentStatusWords('exited', 'litigator')).toBe('Stopped: litigator');
    expect(enrollmentStatusWords('completed', 'sequence_complete')).toBe('Finished');
  });
  it('turns a gate step into a sentence', () => {
    expect(gateStepWords({ rule: 'contact_point', channel: 'sms', verdict: 'removed', detail: 'No mobile number on the record' })).toBe('Text ruled out: No mobile number on the record');
    expect(gateStepWords({ rule: 'call_kind', channel: 'rep_call', verdict: 'kept', detail: 'No AI-call consent, so a rep makes this call' })).toBe('Rep call kept: No AI-call consent, so a rep makes this call');
    expect(gateStepWords({ rule: 'frequency', channel: '', verdict: 'deferred', detail: 'Already contacted today' })).toBe('Moved later: Already contacted today');
  });
  it('has words for every do-not-contact category', () => {
    for (const category of DoNotContactCategory.options) expect(DNC_CATEGORY_WORDS[category]).toMatch(/^[A-Z]/);
  });
});
