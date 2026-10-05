/**
 * Pure pacing decisions for AI call touches. These only ever DELAY or STOP a call; every
 * compliance gate is the engine's (cti-api gateAiCall) and runs on every trigger.
 *
 * What an answer from cti-api does to the touch (decision 10, CF-12, CF-13):
 *  - placed: the touch is sent.
 *  - final: the person cannot be called as things stand; the enrollment exits `ai_call_<reason>`.
 *  - park: the PLAN cannot be used (cti-api refused its text, or the approver has no CTI user). It goes back
 *    to the board for a person and is never retried until a plan is approved again.
 *  - retry: planned again for a computed time. The idempotency key is kept only when cti-api may still be
 *    handling, or have handled, this exact request (a transport failure, `in_flight`). A retry about the system,
 *    not the person (SYSTEM_REASONS, I-1), gives its attempt back, so an outage never uses up MAX_TRIGGER_ATTEMPTS.
 */
import type { PreferredWindow } from '@cti/contracts';
import { CALL_WINDOW, nextWindowOpening, withinRecipientWindow, type LocalWindow } from '@cti/firewall';
import type { TriggerOutcome } from './cti-client.js';

export const MAX_TRIGGER_ATTEMPTS = 8;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * cti-api takes over a reservation that never got an answer only after 10 minutes (its STALE_REQUEST_MS). A retry
 * that re-sends the SAME key sooner can only meet `in_flight` again and burn an attempt, so it waits at least this (CF-13).
 */
export const IN_FLIGHT_RETRY_MS = 10 * MINUTE;

export const PREFERRED_WINDOWS: Readonly<Record<PreferredWindow, LocalWindow>> = {
  any: CALL_WINDOW,
  morning: { start: '08:00', endExclusive: '12:00' },
  afternoon: { start: '12:00', endExclusive: '17:00' },
  evening: { start: '17:00', endExclusive: '21:00' },
};

/** Never retried: the person cannot be called as things stand. The enrollment exits ai_call_<reason>. */
export const FINAL_REASONS: ReadonlySet<string> = new Set([
  'no_consent', 'consent_field_missing', 'no_phone', 'invalid_number', 'opted_out', 'blocked', 'dnc', 'not_admin_for_test', 'record_not_found',
]);
/** Final for the PLAN, not the person (CF-12): back to the board with an error; a new approval may call. */
export const PARK_REASONS: ReadonlySet<string> = new Set(['plan_rejected', 'unknown_user']);
export const RETRY_REASONS: ReadonlySet<string> = new Set([
  'calling_hours', 'daily_cap', 'customer_ceiling', 'no_caller_id', 'ai_voice_unavailable', 'call_in_progress', 'in_flight', 'salesforce_error', 'gate_error', 'twilio_error',
]);

/**
 * About the system, not the person (I-1): cti-api's AI voice is off or not set up, no AI caller ID is free, its gate or its
 * Salesforce read failed, or cti-api did not answer at all (`transport`). They retry with their usual backoff but never count
 * toward MAX_TRIGGER_ATTEMPTS: the attempt is given back (touches.ts settleTouch), so a kill switch, a missing key or an outage
 * pauses every queued lead instead of exiting them `ai_call_gave_up`.
 */
export const SYSTEM_REASONS: ReadonlySet<string> = new Set(['ai_voice_unavailable', 'no_caller_id', 'gate_error', 'salesforce_error', 'transport']);

export type ParkReason = 'plan_rejected' | 'unknown_user';

export type TriggerDecision =
  | { kind: 'placed'; aiCallId: string }
  | { kind: 'retry'; reason: string; at: Date; keepKey: boolean; refundAttempt: boolean }
  | { kind: 'final'; reason: string; aiCallId: string | null }
  | { kind: 'park'; reason: ParkReason };

const later = (now: Date, ms: number): Date => new Date(now.getTime() + ms);
const backoffMs = (attempts: number): number => Math.min(5 * MINUTE * 2 ** Math.max(0, attempts - 1), 2 * HOUR);

function opening(to: string | null, from: Date, now: Date): Date {
  const at = nextWindowOpening(to, from, CALL_WINDOW);
  return at.getTime() > now.getTime() ? at : later(now, 15 * MINUTE);
}

function retryAt(reason: string, attempts: number, to: string | null, now: Date): Date {
  switch (reason) {
    case 'calling_hours': return opening(to, now, now);
    case 'daily_cap':
    case 'customer_ceiling': return opening(to, later(now, 12 * HOUR), now);
    case 'ai_voice_unavailable':
    case 'no_caller_id': return later(now, 30 * MINUTE);
    case 'call_in_progress': return later(now, 10 * MINUTE);
    case 'in_flight': return later(now, IN_FLIGHT_RETRY_MS);
    // The request may have reached cti-api and be reserved there: the same key goes again, never before the takeover.
    case 'transport': return later(now, Math.max(backoffMs(attempts), IN_FLIGHT_RETRY_MS));
    default: return later(now, backoffMs(attempts));
  }
}

/** `attempts` counts the trigger just answered (the claim incremented it); attempts given back (I-1) are not in it. */
export function decideTrigger(outcome: TriggerOutcome, attempts: number, toE164: string | null, now: Date): TriggerDecision {
  if (outcome.kind === 'response' && outcome.response.result === 'placed') return { kind: 'placed', aiCallId: outcome.response.aiCallId };
  const refusal = outcome.kind === 'response' && outcome.response.result !== 'placed' ? outcome.response : null;
  const reason: string = refusal ? refusal.reason : 'transport';
  const aiCallId = refusal ? refusal.aiCallId : null;
  if (PARK_REASONS.has(reason)) return { kind: 'park', reason: reason as ParkReason };
  if (FINAL_REASONS.has(reason)) return { kind: 'final', reason, aiCallId };
  const system = SYSTEM_REASONS.has(reason);
  if (!system && attempts >= MAX_TRIGGER_ATTEMPTS) return { kind: 'final', reason: 'gave_up', aiCallId };
  // Keep the idempotency key only when cti-api may still be handling (or have handled) this exact request.
  const keepKey = outcome.kind === 'transport' || reason === 'in_flight';
  return { kind: 'retry', reason, at: retryAt(reason, attempts, toE164, now), keepKey, refundAttempt: system };
}

export function windowCheck(toE164: string | null, now: Date, preferred: PreferredWindow): { ok: true } | { ok: false; at: Date } {
  const window = PREFERRED_WINDOWS[preferred];
  return withinRecipientWindow(toE164, now, window) ? { ok: true } : { ok: false, at: nextWindowOpening(toE164, now, window) };
}

/** No answer, busy, voicemail: try again in the next calling window at least 20 hours later. */
export const nextAttemptAt = (toE164: string | null, now: Date): Date => nextWindowOpening(toE164, later(now, 20 * HOUR), CALL_WINDOW);
