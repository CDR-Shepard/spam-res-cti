/**
 * How an AI call's outcome reads to people: the words the Salesforce subject
 * and the CTI UI show, the rep wrap-up disposition its `calls` row carries,
 * and the qualification lines of a summary. Pure.
 */
import { QUALIFICATION_FIELDS } from './prompt-tools.js';
import type { AiCallOutcome } from './store.js';

/** The one outcome → words map (Salesforce Task subject, summaries, the UI). */
export const OUTCOME_WORDS: Readonly<Record<AiCallOutcome, string>> = {
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
};

const isOutcome = (o: string): o is AiCallOutcome => Object.prototype.hasOwnProperty.call(OUTCOME_WORDS, o);

export function outcomeWords(outcome: string | null | undefined): string {
  if (!outcome) return 'No outcome';
  return isOutcome(outcome) ? OUTCOME_WORDS[outcome] : outcome;
}

/**
 * The `calls.disposition` of an AI call, in the reps' wrap-up vocabulary
 * (apps/cti-web WrapupForm DISPOSITIONS). It must never be null: an outbound
 * terminal `calls` row without a disposition blocks the rep's next dial
 * (routes/calls.ts findPendingDisposition) and the abandoned-call sweep
 * (salesforce/sync.ts) would log a second, "Not dispositioned" Task for it.
 * A person was reached → 'Connected' (dialer/contact-history-live.ts reads
 * that as a connect).
 */
const DISPOSITIONS: Partial<Record<AiCallOutcome, string>> = {
  voicemail: 'Left voicemail',
  no_answer: 'No answer',
  busy: 'Busy',
  wrong_number: 'Wrong number',
  do_not_call: 'Do not call',
  failed: 'Failed',
  blocked: 'Blocked',
};
export const CONNECTED_DISPOSITION = 'Connected';

export function ctiDisposition(outcome: string | null | undefined): string {
  if (!outcome || !isOutcome(outcome)) return OUTCOME_WORDS.other;
  return DISPOSITIONS[outcome] ?? CONNECTED_DISPOSITION;
}

const label = (key: string): string => {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** `- Motivation: relocating` lines for the known, non-empty qualification fields. */
export function qualificationLines(q: unknown): string[] {
  if (q === null || typeof q !== 'object' || Array.isArray(q)) return [];
  const rec = q as Record<string, unknown>;
  return QUALIFICATION_FIELDS.flatMap((k) => {
    const v = rec[k];
    return typeof v === 'string' && v.trim() ? [`- ${label(k)}: ${v.trim()}`] : [];
  });
}
