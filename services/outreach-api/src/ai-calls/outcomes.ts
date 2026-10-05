/** What a finished AI call does to its enrollment (decision 9). Pure. */
import type { AiCallOutcome } from '@cti/contracts';

/** `ai_calls.status` values after which nothing more happens on the call. */
export const TERMINAL_AI_CALL_STATUSES = ['transferred', 'completed', 'failed', 'blocked'] as const;

export type NextStep = { kind: 'hand_off' } | { kind: 'exit'; reason: string } | { kind: 'complete'; reason: string } | { kind: 'retry' };

const HAND_OFF: ReadonlySet<string> = new Set(['qualified_transferred', 'qualified_callback', 'transfer_failed']);
const EXIT: ReadonlySet<string> = new Set(['not_interested', 'do_not_call', 'wrong_number']);
const UNANSWERED: ReadonlySet<string> = new Set(['no_answer', 'busy', 'voicemail', 'failed']);

/** `answeredAttempts` counts this enrollment's sent AI call touches, this one included. */
export function nextStepFor(outcome: AiCallOutcome | null, answeredAttempts: number, maxAttempts: number): NextStep {
  if (outcome && HAND_OFF.has(outcome)) return { kind: 'hand_off' };
  if (outcome && EXIT.has(outcome)) return { kind: 'exit', reason: outcome };
  if (outcome === null || UNANSWERED.has(outcome)) {
    return answeredAttempts < maxAttempts ? { kind: 'retry' } : { kind: 'complete', reason: 'ai_call_no_answer' };
  }
  return { kind: 'complete', reason: 'ai_call_ended' };
}
