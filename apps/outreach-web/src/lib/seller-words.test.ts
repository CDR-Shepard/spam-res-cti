import { describe, expect, it } from 'vitest';
import { EmailBlock, EmailStatus, FlagReason, StopReason } from '@cti/contracts';
import { ApiRequestError } from './api';
import {
  EMAIL_BLOCK_WORDS,
  EMAIL_STATUS_WORDS,
  FLAG_REASON_WORDS,
  STOP_REASON_WORDS,
  eventIdFromHash,
  durationWords,
  emailErrorWords,
  noteWords,
  practiceAllowed,
  sellerStatus,
  sendAfterWords,
} from './seller-words';

/** A local-time moment in October 2026 (Tuesday the 20th is "today" in these tests). */
const local = (day: number, hour: number, minute = 0, second = 0): Date => new Date(2026, 9, day, hour, minute, second);
const NOW = local(20, 7);

describe('the word tables cover every value the contract can send', () => {
  it.each([
    ['StopReason', StopReason.options, STOP_REASON_WORDS],
    ['FlagReason', FlagReason.options, FLAG_REASON_WORDS],
    ['EmailBlock', EmailBlock.options, EMAIL_BLOCK_WORDS],
    ['EmailStatus', EmailStatus.options, EMAIL_STATUS_WORDS],
  ] as const)('%s: every option has words, and no word table has an extra', (_name, options, words) => {
    for (const option of options) expect(words[option as keyof typeof words], `${option} has no words`).toMatch(/\S/);
    expect(Object.keys(words).sort()).toEqual([...options].sort());
  });

  it('uses the Salesforce Task reason words for a flag, and the controller\'s block words', () => {
    expect(FLAG_REASON_WORDS.offer_or_price).toBe('asked about an offer or price');
    expect(FLAG_REASON_WORDS.draft_rejected).toBe("Sam's reply did not pass the checks");
    expect(EMAIL_BLOCK_WORDS.suppressed).toBe('This address is on the do-not-email list');
    expect(EMAIL_BLOCK_WORDS.not_approved).toBe('No approved call plan yet');
    expect(EMAIL_BLOCK_WORDS.daily_cap).toBe('Sam already sent 3 emails today');
  });
});

describe('practiceAllowed', () => {
  it('a practice copy goes only to the admin, so only the server setup and the tenant switch can stop it', () => {
    const stopped = EmailBlock.options.filter((block) => !practiceAllowed(block));
    expect(stopped.sort()).toEqual(['disabled', 'not_configured', 'paused']);
    expect(practiceAllowed(null)).toBe(true);
  });

  it.each(['suppressed', 'sf_opt_out', 'stopped', 'booked', 'closed', 'taken_over', 'flagged', 'not_approved', 'daily_cap', 'no_address'] as const)(
    'a seller block (%s) leaves the practice copy available',
    (block) => expect(practiceAllowed(block)).toBe(true),
  );
});

describe('sellerStatus', () => {
  const base = { status: 'open', stopReason: null, flagReason: null, handler: 'sam', handlerName: null } as const;

  it.each([
    ['Sam is talking with the seller', base, 'Talking with Sam'],
    ['a person took over', { ...base, handler: 'person', handlerName: 'Dana' }, 'Taken over by Dana'],
    ['a person with no name', { ...base, handler: 'person' }, 'Taken over by a person'],
    ['booked', { ...base, status: 'booked' }, 'Booked'],
    ['stopped with a reason', { ...base, status: 'stopped', stopReason: 'opted_out' }, 'Stopped (opted out)'],
    ['stopped with no reason', { ...base, status: 'stopped' }, 'Stopped'],
    ['flagged', { ...base, flagReason: 'offer_or_price' }, 'Needs a person (asked about an offer or price)'],
    ['stopped outranks a flag', { ...base, status: 'stopped', stopReason: 'complained', flagReason: 'legal' }, 'Stopped (spam complaint)'],
    ['booked outranks a flag', { ...base, status: 'booked', flagReason: 'legal' }, 'Booked'],
    ['a person already on a flagged seller', { ...base, handler: 'person', handlerName: 'Dana', flagReason: 'legal' }, 'Taken over by Dana'],
  ] as const)('%s', (_name, view, label) => {
    expect(sellerStatus(view).label).toBe(label);
  });

  it('gives each state a tone', () => {
    expect(sellerStatus(base).tone).toBe('success');
    expect(sellerStatus({ ...base, status: 'booked' }).tone).toBe('success');
    expect(sellerStatus({ ...base, status: 'stopped' }).tone).toBe('danger');
    expect(sellerStatus({ ...base, flagReason: 'legal' }).tone).toBe('warning');
    expect(sellerStatus({ ...base, handler: 'person' }).tone).toBe('neutral');
  });
});

describe('noteWords', () => {
  it.each([
    [{ kind: 'handler', detail: 'taken_over', byName: 'Dana' }, 'Taken over by Dana'],
    [{ kind: 'handler', detail: 'taken_over', byName: null }, 'Taken over by a person'],
    [{ kind: 'handler', detail: 'given_back', byName: 'Dana' }, 'Given back to Sam by Dana'],
    [{ kind: 'handler', detail: 'given_back', byName: null }, 'Given back to Sam'],
    [{ kind: 'flag', detail: 'legal', byName: null }, 'Needs a person: mentioned an attorney or legal action'],
    [{ kind: 'status', detail: 'opted_out', byName: null }, 'Stopped: opted out'],
    [{ kind: 'status', detail: 'booked', byName: null }, 'Booked'],
  ] as const)('words %j as %s', (note, words) => {
    expect(noteWords(note)).toBe(words);
  });

  it('shows a detail that is already words as it is, humanizes a code it does not know, and never shows nothing', () => {
    expect(noteWords({ kind: 'status', detail: 'The seller replied STOP.', byName: null })).toBe('The seller replied STOP.');
    expect(noteWords({ kind: 'status', detail: 'some_new_status', byName: null })).toBe('Some new status');
    expect(noteWords({ kind: 'flag', detail: '', byName: null })).toBe('Needs a person');
    expect(noteWords({ kind: 'status', detail: '', byName: null })).toBe('Status changed');
    expect(noteWords({ kind: 'handler', detail: '', byName: null })).toBe('Handler changed');
  });
});

describe('sendAfterWords', () => {
  it.each([
    ['right now', local(20, 7, 0, 0), 'now'],
    ['within a minute', local(20, 7, 0, 59), 'now'],
    ['in the past', local(20, 6, 0), 'now'],
    ['later today', local(20, 9, 0), 'today at 9:00 AM'],
    ['an hour from now', local(20, 8, 0), 'today at 8:00 AM'],
    ['tomorrow morning', local(21, 8, 0), 'tomorrow at 8:00 AM'],
    ['in three days', local(23, 8, 30), 'Friday, Oct 23 at 8:30 AM'],
    ['next month', local(40, 13, 5), 'Monday, Nov 9 at 1:05 PM'],
  ])('%s', (_name, at, words) => {
    expect(sendAfterWords(at.toISOString(), NOW)).toBe(words);
  });

  it('reads an unreadable time as soon, not as a broken date', () => {
    expect(sendAfterWords('not a time', NOW)).toBe('soon');
  });
});

describe('durationWords', () => {
  it.each([[0, '0:00'], [7, '0:07'], [192, '3:12'], [3600, '60:00']])('%i seconds is %s', (seconds, words) => {
    expect(durationWords(seconds)).toBe(words);
  });
});

describe('eventIdFromHash', () => {
  it('reads the id after event-, with or without the #', () => {
    expect(eventIdFromHash('event-abc')).toBe('abc');
    expect(eventIdFromHash('#event-abc')).toBe('abc');
  });
  it('is null for anything else', () => {
    expect(eventIdFromHash('')).toBeNull();
    expect(eventIdFromHash('top')).toBeNull();
    expect(eventIdFromHash('event-')).toBeNull();
    expect(eventIdFromHash(undefined)).toBeNull();
  });
});

describe('emailErrorWords', () => {
  const api = (status: number, code: string, message = 'server words', details?: unknown) => new ApiRequestError(status, code, message, details);

  it.each([
    [api(409, 'EMAIL_ALREADY_QUEUED'), 'An email to this seller is already waiting to go out.'],
    [api(429, 'AI_BUDGET'), "Sam's AI budget for today is used up"],
    [api(502, 'MODEL_ERROR'), 'Sam could not write a draft right now. Try again.'],
    [api(422, 'DRAFT_REFUSED'), 'Sam would not write this email'],
    [api(409, 'suppressed'), 'This address is on the do-not-email list'],
    [api(409, 'daily_cap'), 'Sam already sent 3 emails today'],
    [api(403, 'FORBIDDEN', 'Only admins can do that.'), 'Only admins can do that.'],
    [new Error('boom'), 'Something went wrong. Try again.'],
  ])('words %#', (error, message) => {
    expect(emailErrorWords(error)).toEqual({ message, details: [] });
  });

  it('lists what is wrong with a draft the server refused', () => {
    const words = emailErrorWords(api(422, 'DRAFT_INVALID', 'Fix the draft before it is sent.', ['The subject is empty.', 'The body is empty.']));
    expect(words).toEqual({ message: 'Fix the draft before it is sent.', details: ['The subject is empty.', 'The body is empty.'] });
  });

  it('ignores details that are not a list of sentences', () => {
    expect(emailErrorWords(api(422, 'DRAFT_INVALID', 'Fix the draft before it is sent.', { nope: 1 })).details).toEqual([]);
    expect(emailErrorWords(api(422, 'DRAFT_INVALID', 'Fix the draft before it is sent.', ['ok', 3])).details).toEqual(['ok']);
  });

  it('does not take a 409 with another code for a block', () => {
    expect(emailErrorWords(api(409, 'SOMETHING_ELSE', 'The server said this.')).message).toBe('The server said this.');
  });
});
