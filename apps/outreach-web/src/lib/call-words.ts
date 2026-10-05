import type { AiConsentStatus, CallGoalKey, CallStage, EvidenceSource, PreferredWindow, ResearchSource, ResearchSourceStatus, ResearchSourceSummary, SellingSignal } from '@cti/contracts';

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
