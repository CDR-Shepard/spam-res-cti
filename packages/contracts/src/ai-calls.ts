import { z } from 'zod';
import { AppointmentSlots, BookedAppointment, CallContext } from './appointments.js';
import { SfObject } from './crm.js';
import { AI_TEST_IDENTITY_RE } from './ai-test-identity.js';

export const INTERNAL_AI_CALLS_PATH = '/internal/ai-calls';
export const INTERNAL_AI_AVAILABILITY_PATH = '/internal/ai-calls/availability';
/** Plan 1E: an incoming-only Twilio Voice token for a "Talk in browser" test. */
export const INTERNAL_AI_BROWSER_TOKEN_PATH = '/internal/ai-calls/browser-token';
/** The approved plan as the voice agent receives it (fenced as data in its instructions). */
export const PLAN_TEXT_MAX = 4_000;

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/);

/** The engine's gate refusals (cti-api ai-voice/gate.ts AiGateBlock) plus call_in_progress (service.ts). */
export const AiCallBlockReason = z.enum([
  'ai_voice_unavailable', 'no_consent', 'consent_field_missing', 'no_phone', 'opted_out', 'blocked', 'dnc',
  'daily_cap', 'customer_ceiling', 'calling_hours', 'no_caller_id', 'not_admin_for_test', 'invalid_number', 'call_in_progress',
]);
export type AiCallBlockReason = z.infer<typeof AiCallBlockReason>;

/**
 * Not a gate decision: the call could not be attempted. in_flight = the same key is still being handled.
 * plan_rejected = the plan text failed cti-api's deterministic check (CF-9); nothing was dialed, and the
 * same plan will be rejected again, so it is final for that plan.
 */
export const AiCallFailReason = z.enum([
  'record_not_found', 'salesforce_error', 'gate_error', 'twilio_error', 'in_flight', 'unknown_user', 'plan_rejected',
]);
export type AiCallFailReason = z.infer<typeof AiCallFailReason>;

const SF_RECORD_ID = z.string().regex(/^[a-zA-Z0-9]{15,18}$/);

/**
 * record   A real call to the record's phone, with its approved plan. `context` and `slots` (plan 1D) are
 *          structured data cti-api renders outside the plan fence; slots are never plan text.
 * test     An admin's test number, optionally with a plan.
 * practice An admin's test number with a real record's plan and prompt (plan 1D decision 6): never books,
 *          converts or writes to Salesforce, and a transfer rings the admin who started it.
 * practice_browser  Plan 1E: a practice call that rings the admin's browser (`client:<clientIdentity>`)
 *          instead of a test number. The identity embeds the admin's user id; cti-api's gate checks it.
 */
export const InternalAiCallTarget = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('record'),
      objectType: z.enum(['Lead', 'Opportunity']),
      recordId: SF_RECORD_ID,
      planText: z.string().min(1).max(PLAN_TEXT_MAX),
      context: CallContext.optional(),
      slots: AppointmentSlots.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('test'), to: z.string().min(7).max(20), planText: z.string().max(PLAN_TEXT_MAX).nullable() }).strict(),
  z
    .object({
      kind: z.literal('practice'),
      objectType: z.enum(['Lead', 'Opportunity']),
      recordId: SF_RECORD_ID,
      to: z.string().min(7).max(20),
      planText: z.string().min(1).max(PLAN_TEXT_MAX),
      context: CallContext.optional(),
      slots: AppointmentSlots.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('practice_browser'),
      objectType: z.enum(['Lead', 'Opportunity']),
      recordId: SF_RECORD_ID,
      clientIdentity: z.string().regex(AI_TEST_IDENTITY_RE),
      planText: z.string().min(1).max(PLAN_TEXT_MAX),
      context: CallContext.optional(),
      slots: AppointmentSlots.optional(),
    })
    .strict(),
]);
export type InternalAiCallTarget = z.infer<typeof InternalAiCallTarget>;

/** POST /internal/ai-calls (cti-api), HMAC-signed. `userId` is the person who approved the plan (or the admin testing). */
export const InternalAiCallRequest = z
  .object({ orgId: z.string().uuid(), userId: z.string().uuid(), idempotencyKey: IdempotencyKey, target: InternalAiCallTarget })
  .strict();
export type InternalAiCallRequest = z.infer<typeof InternalAiCallRequest>;

export const InternalAiCallResponse = z.discriminatedUnion('result', [
  z.object({ result: z.literal('placed'), aiCallId: z.string().uuid() }),
  z.object({ result: z.literal('blocked'), reason: AiCallBlockReason, aiCallId: z.string().uuid() }),
  z.object({ result: z.literal('failed'), reason: AiCallFailReason, aiCallId: z.string().uuid().nullable() }),
]);
export type InternalAiCallResponse = z.infer<typeof InternalAiCallResponse>;

/**
 * GET /internal/ai-calls/availability (cti-api), HMAC-signed; relayed to admins by outreach-api.
 * `browserCalls` (plan 1E) is optional so an older cti-api, which never sends it, reads as "no browser tests".
 */
export const AiAvailability = z.object({ available: z.boolean(), testNumbers: z.array(z.string()), browserCalls: z.boolean().optional() });
export type AiAvailability = z.infer<typeof AiAvailability>;

/** POST /internal/ai-calls/browser-token (cti-api), HMAC-signed: `userId` is the admin who will take the call. */
export const InternalBrowserTokenRequest = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() }).strict();
export type InternalBrowserTokenRequest = z.infer<typeof InternalBrowserTokenRequest>;
/** An incoming-only Voice token (no outgoing grant) for a fresh aitest identity. Never logged. */
export const InternalBrowserTokenResponse = z.object({
  token: z.string().min(1),
  identity: z.string().regex(AI_TEST_IDENTITY_RE),
  expiresAt: z.string(),
});
export type InternalBrowserTokenResponse = z.infer<typeof InternalBrowserTokenResponse>;

/** ai_calls.status / ai_calls.outcome (migration 0050). */
export const AiCallStatus = z.enum(['queued', 'ringing', 'in_progress', 'transferring', 'transferred', 'completed', 'failed', 'blocked']);
export type AiCallStatus = z.infer<typeof AiCallStatus>;
export const AiCallOutcome = z.enum([
  'qualified_transferred', 'qualified_callback', 'not_interested', 'do_not_call', 'voicemail', 'no_answer', 'busy',
  'failed', 'wrong_number', 'hung_up', 'transfer_failed', 'blocked', 'other',
  /** Plan 1D: the agent booked one of the offered slots (a stored ai_calls.appointment). */
  'appointment_set',
]);
export type AiCallOutcome = z.infer<typeof AiCallOutcome>;

/** ai_call_writebacks.status (migration 0056). */
export const WritebackStatus = z.enum(['pending', 'running', 'done', 'partial', 'failed', 'skipped']);
export type WritebackStatus = z.infer<typeof WritebackStatus>;
export const WritebackChange = z.object({
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  kind: z.enum(['changed', 'kept', 'not_written', 'created', 'converted']),
});
export type WritebackChange = z.infer<typeof WritebackChange>;
export const WritebackSummary = z.object({
  status: WritebackStatus,
  changes: z.array(WritebackChange).max(80),
  error: z.string().nullable(),
  mayRetry: z.boolean(),
  /** Set when the write-back converted the Lead: results link to the new Opportunity. */
  convertedOpportunityId: z.string().nullable(),
  /** The new Opportunity's Salesforce link, built by the server (P6 M-3); null without a conversion or a connection. */
  convertedOpportunityUrl: z.string().url().nullable(),
});
export type WritebackSummary = z.infer<typeof WritebackSummary>;

/** One AI call touch on the campaign's results table. */
export const AiCallResult = z.object({
  touchId: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  name: z.string().nullable(),
  sfObject: SfObject,
  sfRecordId: z.string(),
  recordUrl: z.string().url().nullable(),
  touchStatus: z.enum(['planned', 'held', 'queued', 'dialing', 'sent', 'failed', 'skipped']),
  dueAt: z.string(),
  attempts: z.number().int(),
  lastBlockReason: z.string().nullable(),
  aiCallId: z.string().uuid().nullable(),
  callStatus: AiCallStatus.nullable(),
  outcome: AiCallOutcome.nullable(),
  summary: z.string().nullable(),
  qualification: z.record(z.unknown()).nullable(),
  durationSeconds: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  enrollmentStatus: z.string(),
  exitReason: z.string().nullable(),
  /** Owner or admin: may open the transcript. */
  mayReadTranscript: z.boolean(),
  /** The slot the agent booked (plan 1D), or null. */
  appointment: BookedAppointment.nullable(),
  /** The Salesforce write-back for this call (plan 1D), or null when there is none. */
  writeback: WritebackSummary.nullable(),
});
export type AiCallResult = z.infer<typeof AiCallResult>;

export const AiCallResultsResponse = z.object({ items: z.array(AiCallResult), nextCursor: z.string().nullable() });
export type AiCallResultsResponse = z.infer<typeof AiCallResultsResponse>;

export const TranscriptLine = z.object({ role: z.enum(['agent', 'caller', 'system']), text: z.string(), at: z.string().nullable() });
export type TranscriptLine = z.infer<typeof TranscriptLine>;
export const AiCallTranscript = z.object({ aiCallId: z.string().uuid(), lines: z.array(TranscriptLine) });
export type AiCallTranscript = z.infer<typeof AiCallTranscript>;

/** POST /api/ai-calls/test (admin): "Test call to my phone". */
export const TestCallRequest = z.object({ to: z.string().min(7).max(20) });
export type TestCallRequest = z.infer<typeof TestCallRequest>;
export const TestCallResponse = InternalAiCallResponse;
export type TestCallResponse = InternalAiCallResponse;

/** POST /api/call-plans/:enrollmentId/practice (admin): ring a test number with this lead's plan `version`. */
export const PracticeCallRequest = z.object({ version: z.number().int().min(1), to: z.string().min(7).max(20) }).strict();
export type PracticeCallRequest = z.infer<typeof PracticeCallRequest>;

/** One practice call on the campaign's list (ai_practice_calls, 0056). */
export const PracticeCall = z.object({
  id: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  name: z.string().nullable(),
  sfObject: SfObject,
  sfRecordId: z.string(),
  planVersion: z.number().int(),
  aiCallId: z.string().uuid().nullable(),
  callStatus: AiCallStatus.nullable(),
  outcome: AiCallOutcome.nullable(),
  summary: z.string().nullable(),
  appointment: BookedAppointment.nullable(),
  result: InternalAiCallResponse.nullable(),
  createdAt: z.string(),
});
export type PracticeCall = z.infer<typeof PracticeCall>;

export const PracticeCallsResponse = z.object({ items: z.array(PracticeCall) });
export type PracticeCallsResponse = z.infer<typeof PracticeCallsResponse>;
