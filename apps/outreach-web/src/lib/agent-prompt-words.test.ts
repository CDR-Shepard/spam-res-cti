import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { agentPromptErrorText, characterCountWords, CHECK_UNAVAILABLE_WORDS, promptProblems, promptStatusWords, versionLoadErrorText, VERSION_GONE_WORDS } from './agent-prompt-words';
import { formatDateTime } from './outreach-words';

const err = (status: number, code: string, message: string, details?: unknown, body?: unknown) => new ApiRequestError(status, code, message, details, body);

describe('promptProblems', () => {
  it('reads the problems of a 400 from the route own body', () => {
    expect(promptProblems(err(400, 'UNKNOWN', 'HTTP 400', undefined, { error: 'invalid_prompt', problems: ['a', 'b'] }))).toEqual(['a', 'b']);
  });

  it('reads them from an error envelope details too', () => {
    expect(promptProblems(err(400, 'INVALID_PROMPT', 'invalid_prompt', { problems: ['a'] }, { error: 'invalid_prompt', code: 'INVALID_PROMPT', details: { problems: ['a'] } }))).toEqual(['a']);
  });

  it('keeps only the strings, and answers null when there are none or it is not a 400', () => {
    expect(promptProblems(err(400, 'UNKNOWN', 'HTTP 400', undefined, { problems: ['a', 3, null] }))).toEqual(['a']);
    expect(promptProblems(err(400, 'UNKNOWN', 'HTTP 400', undefined, { problems: [] }))).toBeNull();
    expect(promptProblems(err(400, 'UNKNOWN', 'HTTP 400', undefined, { problems: 'a' }))).toBeNull();
    expect(promptProblems(err(400, 'UNKNOWN', 'HTTP 400'))).toBeNull();
    expect(promptProblems(err(503, 'UNKNOWN', 'HTTP 503', undefined, { problems: ['a'] }))).toBeNull();
    expect(promptProblems(new Error('x'))).toBeNull();
  });
});

describe('the answers outreach-api sends, as the client parses them', () => {
  it('a refused save carries its problems next to the usual envelope', () => {
    const body = { error: 'invalid_prompt', code: 'INVALID_PROMPT', problems: ['Prompt is empty'], requestId: 'r1' };
    expect(promptProblems(err(400, 'INVALID_PROMPT', 'invalid_prompt', undefined, body))).toEqual(['Prompt is empty']);
  });

  it('the check being down carries its words in `message`', () => {
    const body = { error: 'prompt_check_unavailable', code: 'PROMPT_CHECK_UNAVAILABLE', message: "Can't check the prompt right now — try again in a minute", requestId: 'r1' };
    expect(agentPromptErrorText(err(503, 'PROMPT_CHECK_UNAVAILABLE', 'prompt_check_unavailable', undefined, body))).toBe("Can't check the prompt right now — try again in a minute");
  });
});

describe('agentPromptErrorText', () => {
  it('says what the server says when the check service is down, or the stock words without a message', () => {
    expect(agentPromptErrorText(err(503, 'UNKNOWN', 'HTTP 503', undefined, { error: 'prompt_check_unavailable', message: 'Try again soon' }))).toBe('Try again soon');
    expect(agentPromptErrorText(err(503, 'UNKNOWN', 'HTTP 503', undefined, { error: 'prompt_check_unavailable' }))).toBe(CHECK_UNAVAILABLE_WORDS);
    expect(agentPromptErrorText(err(503, 'PROMPT_CHECK_UNAVAILABLE', 'prompt_check_unavailable'))).toBe(CHECK_UNAVAILABLE_WORDS);
    expect(CHECK_UNAVAILABLE_WORDS).toBe("Can't check the prompt right now — try again in a minute");
  });

  it('keeps the envelope words of other 503s, so the calling service being down reads as it does elsewhere', () => {
    expect(agentPromptErrorText(err(503, 'CTI_UNREACHABLE', 'The calling service is not reachable', undefined, { error: 'The calling service is not reachable', code: 'CTI_UNREACHABLE' }))).toBe('The calling service is not reachable');
  });

  it('uses the words of an envelope that carries the check being down as its own code', () => {
    expect(agentPromptErrorText(err(503, 'prompt_check_unavailable', "Can't check just now"))).toBe("Can't check just now");
  });

  it('words a non-admin, and anything else the usual way', () => {
    expect(agentPromptErrorText(err(403, 'ADMIN_ONLY', 'Admin access required'))).toBe('Only admins can do that.');
    expect(agentPromptErrorText(err(500, 'INTERNAL', 'Something broke'))).toBe('Something broke');
    expect(agentPromptErrorText(new Error('x'))).toBe('Something went wrong. Try again.');
  });
});

describe('versionLoadErrorText', () => {
  it('says a missing version is gone, and words every other failure as a prompt route does', () => {
    expect(versionLoadErrorText(err(404, 'NOT_FOUND', 'Not found'))).toBe(VERSION_GONE_WORDS);
    expect(VERSION_GONE_WORDS).toBe("That version isn't there any more.");
    expect(versionLoadErrorText(err(503, 'UNKNOWN', 'HTTP 503', undefined, { error: 'prompt_check_unavailable' }))).toBe(CHECK_UNAVAILABLE_WORDS);
    expect(versionLoadErrorText(err(500, 'INTERNAL', 'Something broke'))).toBe('Something broke');
  });
});

describe('promptStatusWords', () => {
  it('says the default is in use', () => {
    expect(promptStatusWords({ active: null, updatedAt: null, updatedByEmail: null })).toBe('Using the default');
    // A reset keeps who and when it happened, but the default is what is in use.
    expect(promptStatusWords({ active: null, updatedAt: '2026-10-16T19:42:00.000Z', updatedByEmail: 'a@b.co' })).toBe('Using the default');
  });

  it('says when a saved text was edited and by whom', () => {
    const at = '2026-10-16T19:42:00.000Z';
    expect(promptStatusWords({ active: 'x', updatedAt: at, updatedByEmail: 'a@b.co' })).toBe(`Edited ${formatDateTime(at)} by a@b.co`);
    expect(promptStatusWords({ active: 'x', updatedAt: at, updatedByEmail: null })).toBe(`Edited ${formatDateTime(at)}`);
    expect(promptStatusWords({ active: 'x', updatedAt: null, updatedByEmail: 'a@b.co' })).toBe('Edited by a@b.co');
  });
});

describe('characterCountWords', () => {
  it('puts thousands separators on the count and the limit', () => {
    expect(characterCountWords(1499, 1500)).toBe('1,499 / 1,500 characters');
    expect(characterCountWords(0, 60_000)).toBe('0 / 60,000 characters');
  });
});
