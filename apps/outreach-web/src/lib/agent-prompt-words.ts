import { ApiRequestError } from './api';
import type { AgentPromptState } from '@cti/contracts';
import { errorText, formatDateTime } from './outreach-words';

/** What a save or preview says when cti-api (which checks the template) cannot be reached. */
export const CHECK_UNAVAILABLE_WORDS = "Can't check the prompt right now — try again in a minute";
export const VERSION_GONE_WORDS = "That version isn't there any more.";

const CHECK_UNAVAILABLE_CODE = 'prompt_check_unavailable';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : []);

/**
 * The plain-words problems a refused save answers with (a 400), or null when this is not that answer. The server says them
 * as `{ error: 'invalid_prompt', problems }`; they are also read from an error envelope's `details`.
 */
export function promptProblems(error: unknown): string[] | null {
  if (!(error instanceof ApiRequestError) || error.status !== 400) return null;
  const own = strings(asRecord(error.body)?.problems);
  const problems = own.length > 0 ? own : strings(asRecord(error.details)?.problems);
  return problems.length > 0 ? problems : null;
}

const isCheckDown = (error: ApiRequestError): boolean =>
  error.code.toLowerCase() === CHECK_UNAVAILABLE_CODE || asRecord(error.body)?.error === CHECK_UNAVAILABLE_CODE;

/** The server's own words for the check being down, else ours (its message is only the code when it has no words). */
function checkDownWords(error: ApiRequestError): string {
  const said = asRecord(error.body)?.message;
  if (typeof said === 'string' && said.trim() !== '') return said;
  const own = error.message.trim();
  return own === '' || own.toLowerCase() === CHECK_UNAVAILABLE_CODE || /^HTTP \d+$/.test(own) ? CHECK_UNAVAILABLE_WORDS : own;
}

/** A prompt route's failure in words: the check service being down in the server's words, anything else the usual way. */
export function agentPromptErrorText(error: unknown): string {
  return error instanceof ApiRequestError && isCheckDown(error) ? checkDownWords(error) : errorText(error);
}

/** Why a version could not be loaded: it may have been removed, or belong to another workspace. */
export function versionLoadErrorText(error: unknown): string {
  return error instanceof ApiRequestError && error.status === 404 ? VERSION_GONE_WORDS : agentPromptErrorText(error);
}

/**
 * Shown by the status line while a saved version is active, and by Save: a saved text is used as written, so the built-in prompt
 * (and the tools it goes with) can improve later without that reaching the org's calls.
 */
export const SAVED_REPLACES_WORDS = "A saved version replaces the built-in prompt — later improvements to it won't reach your calls until you reset or copy them in.";

/** The line under the tabs: whether the built-in default is in use, or who saved the text and when. */
export function promptStatusWords(state: Pick<AgentPromptState, 'active' | 'updatedAt' | 'updatedByEmail'>): string {
  if (state.active === null) return 'Using the default';
  const when = state.updatedAt ? ` ${formatDateTime(state.updatedAt)}` : '';
  const by = state.updatedByEmail ? ` by ${state.updatedByEmail}` : '';
  return `Edited${when}${by}`;
}

const COUNT = new Intl.NumberFormat('en-US');

/** "1,499 / 1,500 characters". */
export function characterCountWords(length: number, max: number): string {
  return `${COUNT.format(length)} / ${COUNT.format(max)} characters`;
}
