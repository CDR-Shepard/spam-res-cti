/**
 * No-answer forwarding for inbound callbacks — pure helpers, isolated from the
 * Fastify/DB plumbing in inbound.ts so the routing decision is unit-testable.
 *
 * Flow: an inbound callback rings the rep's softphone. If they don't answer
 * within `NO_ANSWER_FORWARD_SECONDS`, the call rings their configured failover
 * number (`users.no_answer_forward_e164`, or a per-DID override); if THAT isn't
 * answered within `FORWARD_RING_SECONDS`, it falls through to voicemail. When no
 * failover is configured the softphone rings the full default window, preserving
 * the original behavior.
 */
import twilio from 'twilio';

/** How long the rep's softphone rings before we forward (per the feature spec). */
export const NO_ANSWER_FORWARD_SECONDS = 10;

/** Softphone ring window when NO failover number is configured (unchanged). */
export const DEFAULT_INBOUND_RING_SECONDS = 25;

/** How long the failover number itself rings before we give up → voicemail. */
export const FORWARD_RING_SECONDS = 20;

/** Query flag marking the dial-result callback for the forward leg, so a
 *  no-answer there goes to voicemail instead of forwarding again (loop guard). */
export const FORWARD_LEG_FLAG = 'forward';

/**
 * Resolve the number to forward an unanswered callback to. A per-DID override
 * (`outbound_numbers.inbound_forward_to_e164`, admin-set) wins; otherwise the
 * rung rep's own agent-level failover number. Empty/whitespace is treated as
 * unset. Returns null when neither is configured (→ voicemail, as before).
 */
export function resolveForwardTarget(opts: {
  numberForwardE164?: string | null;
  repForwardE164?: string | null;
}): string | null {
  const perNumber = opts.numberForwardE164?.trim();
  if (perNumber) return perNumber;
  const rep = opts.repForwardE164?.trim();
  if (rep) return rep;
  return null;
}

/** Softphone ring window: short (forward) when a failover exists, else default. */
export function inboundRingSeconds(hasForward: boolean): number {
  return hasForward ? NO_ANSWER_FORWARD_SECONDS : DEFAULT_INBOUND_RING_SECONDS;
}

/**
 * TwiML that rings the failover number for a callback the rep didn't answer.
 *
 * - callerId is the DID that was called (a number we own), NOT the original
 *   caller — Twilio only allows a verified/owned callerId on a PSTN <Dial>, and
 *   the agent's phone showing the business line is the expected forwarding UX.
 * - The `action` points back at dial-result with `?leg=forward`, so an
 *   unanswered forward drops to voicemail instead of forwarding in a loop.
 * - Recording mirrors the softphone-bridge leg; the "may be recorded"
 *   disclosure was already played once at the start of the call.
 */
export function buildForwardDialTwiml(opts: {
  apiPublicUrl: string;
  callDbId: string;
  forwardE164: string;
  callerIdE164: string;
  record: boolean;
}): string {
  const t = new twilio.twiml.VoiceResponse();
  const action =
    `${opts.apiPublicUrl}/telephony/twilio/inbound/dial-result` +
    `?callDbId=${encodeURIComponent(opts.callDbId)}&leg=${FORWARD_LEG_FLAG}`;
  const dial = t.dial({
    callerId: opts.callerIdE164,
    timeout: FORWARD_RING_SECONDS,
    answerOnBridge: true,
    action,
    method: 'POST',
    ...(opts.record
      ? {
          record: 'record-from-answer-dual',
          recordingStatusCallback: `${opts.apiPublicUrl}/telephony/twilio/recording?callDbId=${encodeURIComponent(opts.callDbId)}`,
          recordingStatusCallbackEvent: ['completed'],
          recordingStatusCallbackMethod: 'POST',
        }
      : {}),
  } as never);
  dial.number({}, opts.forwardE164);
  return t.toString();
}
