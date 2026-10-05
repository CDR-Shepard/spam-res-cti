import { z } from 'zod';
import { EnrollmentStatus } from './campaigns.js';
import { SfObject } from './crm.js';
import { DoNotContactCategory } from './review.js';

/** What the research step reads from Salesforce for one lead. */
export const ResearchSource = z.enum(['record', 'related', 'tasks', 'events', 'notes', 'content_notes', 'emails', 'chatter', 'chatter_comments']);
export type ResearchSource = z.infer<typeof ResearchSource>;

/** ok; missing = the org has no such object or field; denied = the integration user may not read it; error = another refusal; skipped = not attempted. */
export const ResearchSourceStatus = z.enum(['ok', 'missing', 'denied', 'error', 'skipped']);
export type ResearchSourceStatus = z.infer<typeof ResearchSourceStatus>;

export const ResearchSourceSummary = z.object({
  source: ResearchSource,
  status: ResearchSourceStatus,
  count: z.number().int().min(0),
  /** More items existed than the cap kept (the most recent are kept). */
  truncated: z.boolean(),
  /** Salesforce's error code, or a short reason; never record content. */
  note: z.string().max(300).nullable(),
});
export type ResearchSourceSummary = z.infer<typeof ResearchSourceSummary>;

/** The record's AI call consent field (`AI_Call_Consent__c` through the field map) when researched.
 * 'unknown': the field is configured but its value could not be read; never treated as consent. */
export const AiConsentStatus = z.enum(['yes', 'no', 'field_missing', 'unknown']);
export type AiConsentStatus = z.infer<typeof AiConsentStatus>;

/** campaign_enrollments.call_stage. */
export const CallStage = z.enum(['research', 'review', 'approved', 'queued', 'done']);
export type CallStage = z.infer<typeof CallStage>;

export const EvidenceSource = z.enum(['record', 'related', 'task', 'event', 'note', 'email', 'chatter']);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

export const SellingSignal = z.object({
  signal: z.string().trim().min(1).max(200),
  /** Words copied from the data that show the signal. */
  evidence: z.string().trim().min(1).max(300),
  source: EvidenceSource,
  strength: z.enum(['strong', 'moderate', 'weak']),
});
export type SellingSignal = z.infer<typeof SellingSignal>;

/** The four things every call tries to learn. */
export const CallGoalKey = z.enum(['still_selling', 'timeline', 'condition', 'price_expectations']);
export type CallGoalKey = z.infer<typeof CallGoalKey>;
export const CALL_GOAL_KEYS = CallGoalKey.options;

export const CallGoal = z.object({
  goal: CallGoalKey,
  /** What the records already say about it, or null. */
  known: z.string().trim().max(300).nullable(),
  /** How the call should find out. */
  approach: z.string().trim().min(1).max(300),
});
export type CallGoal = z.infer<typeof CallGoal>;

/** Recipient-local part of the 08:00–21:00 calling window the call should aim for. */
export const PreferredWindow = z.enum(['any', 'morning', 'afternoon', 'evening']);
export type PreferredWindow = z.infer<typeof PreferredWindow>;

const lines = (maxChars: number, maxItems: number, minItems = 0) => z.array(z.string().trim().min(1).max(maxChars)).min(minItems).max(maxItems);

/** The plan model's output (zod-validated before use) and what a person approves. */
export const CallPlan = z.object({
  situationSummary: z.string().trim().min(1).max(800),
  sellingSignals: z.array(SellingSignal).max(8),
  /** What to say right after the AI disclosure and once they agree to a minute. */
  opener: z.string().trim().min(1).max(300),
  goals: z
    .array(CallGoal)
    .length(4)
    .refine((goals) => new Set(goals.map((g) => g.goal)).size === CALL_GOAL_KEYS.length, { message: 'Each goal exactly once' }),
  talkingPoints: lines(200, 8),
  questions: lines(200, 10, 1),
  avoid: lines(200, 8),
  bestTimeToCall: z.object({ window: PreferredWindow, reason: z.string().trim().max(200) }),
  /** Non-null holds the person in Needs Review; no plan is offered for approval. */
  doNotContact: z.object({ category: DoNotContactCategory, quote: z.string().trim().min(1).max(300) }).nullable(),
});
export type CallPlan = z.infer<typeof CallPlan>;

/** What a person may edit: everything but the do-not-contact assessment. */
export const EditableCallPlan = CallPlan.omit({ doNotContact: true });
export type EditableCallPlan = z.infer<typeof EditableCallPlan>;

export const GateWarningCode = z.enum([
  'no_ai_consent',
  'consent_field_missing',
  /** The consent field is configured but its value could not be read (CF-5): never consent. */
  'consent_unknown',
  'no_phone',
  'opted_out',
  'blocked',
  'dnc',
  /** A do-not-contact flag on the person is waiting in Needs Review (CF-10). */
  'dnc_pending',
  /** The plan was flagged do-not-contact and no person has dismissed the flag (CF-10). */
  'dnc_not_dismissed',
  'sf_do_not_call',
  'skip_on_dialer',
  'closed',
  'state_daily_cap',
  'outside_calling_hours',
]);
export type GateWarningCode = z.infer<typeof GateWarningCode>;

/** block = the engine will refuse the call as things stand; info = it may delay it. */
export const GateWarning = z.object({ code: GateWarningCode, severity: z.enum(['block', 'info']), words: z.string() });
export type GateWarning = z.infer<typeof GateWarning>;

export const CallPlanVersion = z.object({
  version: z.number().int().min(1),
  status: z.enum(['proposed', 'approved']),
  source: z.enum(['model', 'edit']),
  plan: EditableCallPlan,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** The model raised do-not-contact and a person dismissed it before this card was shown. */
  dncFlagDismissed: z.boolean(),
  /** Who dismissed it and when (display name or email); null when it was not recorded. */
  dncFlagDismissedBy: z.string().nullable(),
  dncFlagDismissedAt: z.string().nullable(),
});
export type CallPlanVersion = z.infer<typeof CallPlanVersion>;

/** One lead on the call plan board. */
export const CallPlanCard = z.object({
  enrollmentId: z.string().uuid(),
  sfObject: SfObject,
  sfRecordId: z.string(),
  /** `${instance_url}/${sfRecordId}`; null when the connection is gone. */
  recordUrl: z.string().url().nullable(),
  name: z.string().nullable(),
  ownerName: z.string().nullable(),
  enrollmentStatus: EnrollmentStatus,
  callStage: CallStage,
  consent: AiConsentStatus.nullable(),
  warnings: z.array(GateWarning),
  research: z.object({ version: z.number(), collectedAt: z.string(), sources: z.array(ResearchSourceSummary) }).nullable(),
  plan: CallPlanVersion.nullable(),
  /** Last research or plan failure, in plain words. */
  prepareError: z.string().nullable(),
  /** The viewer is the record owner or an admin (review.ts's rule). */
  mayDecide: z.boolean(),
});
export type CallPlanCard = z.infer<typeof CallPlanCard>;

/** GET /api/campaigns/:id/call-plans — 25 cards a page; `counts` covers the whole campaign (active enrollments). */
export const CallPlansResponse = z.object({
  cards: z.array(CallPlanCard),
  nextCursor: z.string().nullable(),
  counts: z.record(CallStage, z.number()),
});
export type CallPlansResponse = z.infer<typeof CallPlansResponse>;

/** POST /api/call-plans/:enrollmentId/approve — `version` is the one the person read. */
export const ApproveCallPlanRequest = z.object({ version: z.number().int().min(1) });
export type ApproveCallPlanRequest = z.infer<typeof ApproveCallPlanRequest>;

/** PUT /api/call-plans/:enrollmentId — saves a new version (status proposed) based on `version`. */
export const EditCallPlanRequest = z.object({ version: z.number().int().min(1), plan: EditableCallPlan });
export type EditCallPlanRequest = z.infer<typeof EditCallPlanRequest>;

/**
 * POST /api/campaigns/:id/ai-calls/release — "Call all approved". `skipped` counts the leads looked at and not released.
 * `more`: the call stopped at its cap (calls released, or pages read) with approved leads still unread; run it again.
 */
export const ReleaseCallsResponse = z.object({ released: z.number(), skipped: z.number(), more: z.boolean() });
export type ReleaseCallsResponse = z.infer<typeof ReleaseCallsResponse>;
