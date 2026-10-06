/**
 * Test a record (plan 1E, spec docs/superpowers/specs/2026-10-06-ai-call-test-a-record-design.md):
 * an admin pastes a Salesforce Lead or Opportunity Id or link, outreach-api previews how the AI would
 * call it (research → plan → agent text → times), and the admin may run that call to a test number or
 * to their browser. The record ref parser lives here so the web validates as the admin types.
 */
import { z } from 'zod';
import { AI_TEST_IDENTITY_RE } from './ai-test-identity.js';
import { AiCallOutcome, AiCallStatus, InternalAiCallResponse, InternalBrowserTokenResponse, WritebackChange } from './ai-calls.js';
import { AppointmentSlots, BookedAppointment } from './appointments.js';
import { AiConsentStatus, CallPlan, ResearchSourceSummary } from './call-plans.js';
import { SfObject } from './crm.js';

export { AI_TEST_IDENTITY_RE, aiTestIdentity, aiTestIdentityUser } from './ai-test-identity.js';

export type RecordRefError = 'no_id' | 'wrong_object' | 'bad_checksum';

/** The words each refusal shows (POST /api/record-tests answers 400 INVALID_RECORD with them). */
export const RECORD_REF_ERROR_WORDS: Readonly<Record<RecordRefError, string>> = {
  no_id: "That isn't a Salesforce Lead or Opportunity Id or link.",
  wrong_object: 'Only Leads (00Q…) and Opportunities (006…) can be tested.',
  bad_checksum: "That Id's last three characters don't match. Copy it again from Salesforce.",
};

const PREFIX_OBJECT: Readonly<Record<string, 'Lead' | 'Opportunity'>> = { '00Q': 'Lead', '006': 'Opportunity' };
const CHECKSUM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const ID15 = /^[a-zA-Z0-9]{15}$/;

/** A 15-character Salesforce Id to its 18-character form: one checksum character per 5-character chunk. */
export function toSalesforceId18(id15: string): string {
  if (!ID15.test(id15)) throw new Error('toSalesforceId18: not a 15-character Id');
  let suffix = '';
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const c = id15.charAt(chunk * 5 + i);
      if (c >= 'A' && c <= 'Z') bits |= 1 << i;
    }
    suffix += CHECKSUM_CHARS.charAt(bits);
  }
  return id15 + suffix;
}

/** Maximal runs of letters and digits 15 or 18 long, with at least one digit: what an Id in a URL looks like. */
function idTokens(input: string): string[] {
  return (input.match(/[a-zA-Z0-9]+/g) ?? []).filter((t) => (t.length === 15 || t.length === 18) && /[0-9]/.test(t));
}

/**
 * The first 00Q/006 Id token in an Id or a Salesforce URL (Lightning, related list or Classic); 15 → 18
 * with the standard checksum. The URL's domain is ignored: the record is read through the tenant's own
 * connection, so another org's Id is simply not found.
 */
export function parseSalesforceRecordRef(
  input: string,
): { ok: true; sfObject: 'Lead' | 'Opportunity'; sfRecordId: string } | { ok: false; error: RecordRefError } {
  const tokens = idTokens(input);
  const token = tokens.find((t) => PREFIX_OBJECT[t.slice(0, 3)] !== undefined);
  if (!token) return { ok: false, error: tokens.length > 0 ? 'wrong_object' : 'no_id' };
  const sfObject = PREFIX_OBJECT[token.slice(0, 3)]!;
  const sfRecordId = toSalesforceId18(token.slice(0, 15));
  if (token.length === 18 && token.slice(15).toUpperCase() !== sfRecordId.slice(15)) return { ok: false, error: 'bad_checksum' };
  return { ok: true, sfObject, sfRecordId };
}

export const RecordTestStatus = z.enum(['running', 'ready', 'failed']);
export type RecordTestStatus = z.infer<typeof RecordTestStatus>;
/** ai_record_tests.error. interrupted is never stored: a running row older than 6 minutes reads as it. */
export const RecordTestError = z.enum(['not_found', 'salesforce_error', 'not_connected', 'plan_failed', 'timeout', 'interrupted']);
export type RecordTestError = z.infer<typeof RecordTestError>;

/** POST /api/record-tests (admin): an Id or a Salesforce link. */
export const CreateRecordTestRequest = z.object({ record: z.string().trim().min(15).max(500) }).strict();
export type CreateRecordTestRequest = z.infer<typeof CreateRecordTestRequest>;

/** POST /api/record-tests/:id/calls (admin): ring a test number, or the browser registered under `identity`. */
export const RecordTestCallRequest = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('phone'), to: z.string().min(7).max(20) }).strict(),
  z.object({ mode: z.literal('browser'), identity: z.string().regex(AI_TEST_IDENTITY_RE) }).strict(),
]);
export type RecordTestCallRequest = z.infer<typeof RecordTestCallRequest>;

/** Task 11 (optional): what a real call would have written. Nothing is sent. */
export const RecordTestDryRun = z.object({
  status: z.enum(['ready', 'nothing', 'failed']),
  changes: z.array(WritebackChange),
  changesText: z.string().nullable(),
  chatterText: z.string().nullable(),
  wouldCreate: z.array(z.string()),
  conversion: z.string().nullable(),
  note: z.string().nullable(),
});
export type RecordTestDryRun = z.infer<typeof RecordTestDryRun>;

/** One test call on a preview, joined to its ai_calls row. */
export const RecordTestCall = z.object({
  id: z.string().uuid(),
  mode: z.enum(['phone', 'browser']),
  toE164: z.string().nullable(),
  createdAt: z.string(),
  aiCallId: z.string().uuid().nullable(),
  result: InternalAiCallResponse.nullable(),
  callStatus: AiCallStatus.nullable(),
  outcome: AiCallOutcome.nullable(),
  summary: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  callbackAt: z.string().nullable(),
  qualification: z.record(z.string()),
  appointment: BookedAppointment.nullable(),
  dryRun: RecordTestDryRun.nullable(),
});
export type RecordTestCall = z.infer<typeof RecordTestCall>;

/** GET /api/record-tests/:id: the preview ("how I'll approach this call") and its test calls. */
export const RecordTest = z.object({
  id: z.string().uuid(),
  sfObject: SfObject,
  sfRecordId: z.string(),
  recordUrl: z.string().url().nullable(),
  name: z.string().nullable(),
  status: RecordTestStatus,
  error: RecordTestError.nullable(),
  consent: AiConsentStatus.nullable(),
  plan: CallPlan.nullable(),
  /** The exact text the voice agent gets; null when the plan text check refused it. */
  planText: z.string().nullable(),
  /** Why the plan text was refused, in words (blocks running). */
  planTextWords: z.array(z.string()),
  /** The plan found a last real contact: the agent treats them as someone we know. */
  returning: z.boolean(),
  slots: AppointmentSlots,
  offerNote: z.string().nullable(),
  ownerSfUserId: z.string().nullable(),
  sources: z.array(ResearchSourceSummary),
  costMicros: z.number().int(),
  requestedByName: z.string().nullable(),
  createdAt: z.string(),
  calls: z.array(RecordTestCall),
});
export type RecordTest = z.infer<typeof RecordTest>;

/** GET /api/record-tests: the tenant's latest 20. */
export const RecordTestsResponse = z.object({
  items: z.array(RecordTest.pick({ id: true, sfObject: true, sfRecordId: true, name: true, status: true, createdAt: true, requestedByName: true })),
});
export type RecordTestsResponse = z.infer<typeof RecordTestsResponse>;

/** POST /api/record-tests/browser-token (admin): relayed from cti-api, `Cache-Control: no-store`. */
export const BrowserTokenResponse = InternalBrowserTokenResponse;
export type BrowserTokenResponse = InternalBrowserTokenResponse;
