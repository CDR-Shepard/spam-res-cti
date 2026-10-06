import { humanize, wordFor } from './outreach-words';
import type { AiCallBlockReason, AiCallFailReason, AiCallOutcome, AiCallStatus, AiConsentStatus, CallGoalKey, CallStage, EvidenceSource, PreferredWindow, QualificationTopic, ResearchSource, ResearchSourceStatus, ResearchSourceSummary, SellingSignal } from '@cti/contracts';

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
  appointment_set: 'Appointment set',
};

/** What a call still needs to learn (plan 1D `stillToLearn`). */
export const TOPIC_WORDS: Record<QualificationTopic, string> = {
  motivation: "why they'd sell",
  timeline: 'timeline',
  condition: 'condition',
  repairs: 'repairs',
  occupancy: 'who lives there',
  price: 'their price in mind',
  competition: 'other offers or agents',
  mortgage: 'what they owe',
  decision_makers: 'who decides',
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
  idempotency_conflict: 'the call request clashed with an earlier one; trying again',
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

/**
 * Plan 1D: a booked appointment as "Phone call Wed Oct 7, 11:00 AM" or "Walkthrough …", in `timeZone` (the viewer's own when
 * left out). ICU's narrow no-break space before AM/PM becomes a plain one.
 */
export function appointmentWords(a: { kind: 'phone' | 'walkthrough'; start: string }, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(a.start));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${a.kind === 'phone' ? 'Phone call' : 'Walkthrough'} ${part('weekday')} ${part('month')} ${part('day')}, ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

/** A practice call's answer: ringing, or why it was not placed (a gate refusal or a failure, in words). */
export function practiceAnswerWords(r: { result: 'placed' | 'blocked' | 'failed'; reason?: string }): string {
  return r.result === 'placed' ? 'Ringing your phone…' : `Not placed: ${reasonWords(r.reason ?? 'unknown')}`;
}

const RINGING: ReadonlySet<string> = new Set(['queued', 'ringing']);
const ON_CALL: ReadonlySet<string> = new Set(['in_progress', 'transferring']);

/**
 * The practice button's status once cti-api answered (final review): it follows the call (its row on the campaign's
 * practice list) instead of saying "Ringing your phone…" for good.
 */
export function practiceStatusWords(
  answer: { result: 'placed' | 'blocked' | 'failed'; reason?: string },
  call: { callStatus: AiCallStatus | null; outcome: AiCallOutcome | null } | undefined,
): string {
  if (answer.result !== 'placed' || !call || call.callStatus === null || RINGING.has(call.callStatus)) return practiceAnswerWords(answer);
  if (ON_CALL.has(call.callStatus)) return 'On the call…';
  return call.outcome ? `Practice call ended: ${OUTCOME_WORDS[call.outcome]}.` : `Practice call ended: ${CALL_STATUS_WORDS[call.callStatus]}.`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The campaign page's search: `?call=<AI call id>` (the Chatter post's "Call details" link) opens that call on the results. */
export function callSearch(search: Record<string, unknown>): { call?: string } {
  return typeof search.call === 'string' && UUID.test(search.call) ? { call: search.call } : {};
}
