import { humanize, wordFor } from './outreach-words';
import type { AiCallBlockReason, AiCallFailReason, AiCallOutcome, AiCallStatus, AiConsentStatus, CallGoalKey, CallStage, EvidenceSource, PreferredWindow, ResearchSource, ResearchSourceStatus, ResearchSourceSummary, SellingSignal } from '@cti/contracts';

export const CALL_STAGE_WORDS: Record<CallStage, string> = {
  research: 'researching',
  review: 'waiting for review',
  approved: 'approved',
  queued: 'queued',
  done: 'done',
};

export const GOAL_WORDS: Record<CallGoalKey, string> = {
  still_selling: 'Still selling?',
  timeline: 'Timeline',
  condition: 'Condition of the house',
  price_expectations: 'Their price in mind',
};

export const WINDOW_WORDS: Record<PreferredWindow, string> = {
  any: 'Any time in the calling window',
  morning: 'Morning (8–12)',
  afternoon: 'Afternoon (12–5)',
  evening: 'Evening (5–9)',
};

export const SOURCE_WORDS: Record<ResearchSource, string> = {
  record: 'Record',
  related: 'Related records',
  tasks: 'Tasks',
  events: 'Events',
  notes: 'Notes',
  content_notes: 'Enhanced notes',
  emails: 'Emails',
  chatter: 'Chatter',
  chatter_comments: 'Chatter comments',
};

/** Where a selling signal's evidence came from (the plan's own source names, not the research sources). */
export const EVIDENCE_WORDS: Record<EvidenceSource, string> = {
  record: 'Record',
  related: 'Related record',
  task: 'Task',
  event: 'Event',
  note: 'Note',
  email: 'Email',
  chatter: 'Chatter',
};

export const SOURCE_STATUS_WORDS: Record<ResearchSourceStatus, string> = {
  ok: 'read',
  missing: 'not available in this org',
  denied: 'the integration user cannot read it',
  error: 'could not be read',
  skipped: 'skipped',
};

/** 'unknown' is never consent: the field is set up but its value could not be read. */
export const CONSENT_WORDS: Record<AiConsentStatus, string> = {
  yes: 'AI consent: yes',
  no: 'AI consent: no',
  field_missing: 'AI consent field missing',
  unknown: 'AI consent: could not be read — research again',
};

export const STRENGTH_WORDS: Record<SellingSignal['strength'], string> = { strong: 'strong', moderate: 'moderate', weak: 'weak' };

export function sourceLine(s: ResearchSourceSummary): string {
  if (s.status !== 'ok') return `${SOURCE_WORDS[s.source]}: ${SOURCE_STATUS_WORDS[s.status]}`;
  return `${SOURCE_WORDS[s.source]}: ${s.count}${s.truncated ? ' (most recent)' : ''}`;
}

export const OUTCOME_WORDS: Record<AiCallOutcome, string> = {
  qualified_transferred: 'Transferred to a person',
  qualified_callback: 'Callback booked',
  not_interested: 'Not interested',
  do_not_call: 'Asked not to be called',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Call failed',
  wrong_number: 'Wrong number',
  hung_up: 'Hung up',
  transfer_failed: 'Transfer missed — call them back',
  blocked: 'Blocked',
  other: 'Other',
};

export const CALL_STATUS_WORDS: Record<AiCallStatus, string> = {
  queued: 'Queued',
  ringing: 'Ringing',
  in_progress: 'In progress',
  transferring: 'Transferring',
  transferred: 'Transferred',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
};

/** The engine's refusals (cti-api's gate), as the end of "Not called: …". */
export const BLOCK_REASON_WORDS: Record<AiCallBlockReason, string> = {
  ai_voice_unavailable: 'AI calling is switched off',
  no_consent: 'no AI consent in Salesforce',
  consent_field_missing: 'this Salesforce org has no AI consent field',
  no_phone: 'the record has no phone number',
  opted_out: 'they opted out of calls',
  blocked: 'the number is on the block list',
  dnc: 'on the federal Do Not Call list',
  daily_cap: "their state's daily call limit was reached",
  customer_ceiling: 'the call limit for this person was reached',
  calling_hours: "outside calling hours where they live",
  no_caller_id: 'no AI caller ID number is free',
  not_admin_for_test: 'test calls are for admins, to a number in AI_VOICE_TEST_NUMBERS',
  invalid_number: 'the phone number is not valid',
  call_in_progress: 'another call to them is in progress',
};

/** Why a call could not be attempted, as the end of "Not called: …". */
export const FAIL_REASON_WORDS: Record<AiCallFailReason, string> = {
  record_not_found: 'the Salesforce record was not found',
  salesforce_error: 'Salesforce did not answer',
  gate_error: 'a compliance check could not run',
  twilio_error: 'the phone carrier refused the call',
  in_flight: 'the call request was still being handled',
  unknown_user: 'the approver cannot place AI calls',
  plan_rejected: "the voice agent refused the plan's text",
};

/** The pacer's own reasons (outreach-api ai-calls/pace.ts and stage.ts). */
const PACER_REASON_WORDS: Readonly<Record<string, string>> = {
  gave_up: 'gave up after repeated errors',
  transport: 'the AI calling service did not answer',
  sf_do_not_call: 'Do Not Call is checked in Salesforce',
  skip_on_dialer: 'Skip on Dialer is checked in Salesforce',
  outside_window: "waiting for the plan's time of day",
  not_claimable: 'the lead changed since it was queued',
  activity_check_failed: 'could not check Salesforce for new activity',
  new_salesforce_activity: 'new activity in Salesforce; researching again',
  plan_not_approved: 'the plan is no longer approved',
};

const REASON_WORDS: Readonly<Record<string, string>> = { ...BLOCK_REASON_WORDS, ...FAIL_REASON_WORDS, ...PACER_REASON_WORDS };

/** A touch's last refusal or failure in words; an unknown code is shown with spaces. */
export function reasonWords(code: string): string {
  return wordFor(REASON_WORDS, code, code.replace(/_/g, ' '));
}

export function notCalledWords(code: string | null): string {
  return code ? `Not called: ${reasonWords(code)}` : 'Not called';
}

const EXIT_WORDS: Readonly<Record<string, string>> = {
  plan_rejected: 'Plan rejected',
  ai_call_no_answer: 'No answer after every attempt',
  ai_call_ended: 'The call ended',
  not_interested: 'Not interested',
  do_not_call: 'Asked not to be called',
  wrong_number: 'Wrong number',
  deselected: 'Removed from the lead picker',
};

/** An AI call enrollment's exit or completion reason in words (`ai_call_<reason>` = it was never called). */
export function aiExitWords(reason: string | null): string | null {
  if (!reason) return null;
  if (Object.hasOwn(EXIT_WORDS, reason)) return EXIT_WORDS[reason]!;
  if (reason.startsWith('ai_call_')) return notCalledWords(reason.slice('ai_call_'.length));
  return humanize(reason);
}
