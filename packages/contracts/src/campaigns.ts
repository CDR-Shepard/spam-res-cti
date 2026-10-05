import { z } from 'zod';
import { ContactChannel, SfObject } from './crm.js';
import { TriageResult } from './review.js';

export const CampaignStatus = z.enum(['draft', 'dry_run', 'active', 'paused', 'archived']);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

/** Who is in a campaign: a Salesforce list view (15- or 18-char Id) or a pasted SOQL query. */
export const CampaignSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list_view'), listViewId: z.string().min(15).max(18) }),
  z.object({ kind: z.literal('soql'), soql: z.string().min(10).max(20000) }),
]);
export type CampaignSource = z.infer<typeof CampaignSource>;

/** True when `days` starts at 0 and every day is later than the one before. */
function isTouchSchedule(days: readonly number[]): boolean {
  if (days[0] !== 0) return false;
  for (let i = 1; i < days.length; i++) {
    if (days[i]! <= days[i - 1]!) return false;
  }
  return true;
}

/** Days after enrollment of each touch, e.g. [0, 1, 3, 6, 10, 14]. */
export const TouchDays = z
  .array(z.number().int().min(0).max(60))
  .min(1)
  .max(12)
  .refine(isTouchSchedule, { message: 'Touch days must start at 0 and strictly increase' });
export type TouchDays = z.infer<typeof TouchDays>;

/** POST /api/campaigns. */
export const CreateCampaignRequest = z.object({
  name: z.string().trim().min(1).max(120),
  sfObject: SfObject,
  source: CampaignSource,
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequest>;

/** PATCH /api/campaigns/:id. */
export const UpdateCampaignRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  refreshMinutes: z.number().int().min(60).max(1440).optional(),
  touchDays: TouchDays.optional(),
});
export type UpdateCampaignRequest = z.infer<typeof UpdateCampaignRequest>;

/** POST /api/campaigns/:id/status. A campaign never returns to draft. */
export const CampaignStatusChange = z.object({ status: z.enum(['dry_run', 'active', 'paused', 'archived']) });
export type CampaignStatusChange = z.infer<typeof CampaignStatusChange>;

export const Campaign = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sfObject: SfObject,
  source: CampaignSource,
  status: CampaignStatus,
  /** manual | crm_broken | ai_budget | kill_switch while paused; else null. */
  pauseReason: z.string().nullable(),
  refreshMinutes: z.number(),
  touchDays: z.array(z.number()),
  memberCount: z.number(),
  lastRefreshedAt: z.string().nullable(),
  lastRefreshError: z.string().nullable(),
  createdAt: z.string(),
});
export type Campaign = z.infer<typeof Campaign>;

/** GET /api/campaigns. */
export const CampaignsResponse = z.object({ campaigns: z.array(Campaign) });
export type CampaignsResponse = z.infer<typeof CampaignsResponse>;

/** Why a member is not enrolled (preview) or why an enrollment left. */
export const SkipReason = z.enum([
  'no_contact_point',
  'opted_out',
  'blocked',
  'dnc',
  'sf_do_not_call',
  'sf_email_opt_out',
  'skip_on_dialer',
  'in_other_campaign',
  'closed',
]);
export type SkipReason = z.infer<typeof SkipReason>;

/** POST /api/campaigns/preview. */
export const PreviewRequest = z.object({ sfObject: SfObject, source: CampaignSource });
export type PreviewRequest = z.infer<typeof PreviewRequest>;

export const PreviewRecord = z.object({
  sfRecordId: z.string(),
  name: z.string().nullable(),
  ownerName: z.string().nullable(),
  channels: z.array(ContactChannel),
  skipReason: SkipReason.nullable(),
});
export type PreviewRecord = z.infer<typeof PreviewRecord>;

export const CampaignPreview = z.object({
  /** Every member Id the query returns. */
  total: z.number(),
  /** Members whose fields were checked (the first 2,000 at most). */
  examined: z.number(),
  /** Of `examined`. */
  eligible: z.number(),
  /** Of `examined`, by reason. */
  skipped: z.record(SkipReason, z.number()),
  /** The first 20 examined. */
  sample: z.array(PreviewRecord).max(20),
});
export type CampaignPreview = z.infer<typeof CampaignPreview>;

export const TouchChannel = z.enum(['ai_call', 'rep_call', 'sms', 'email']);
export type TouchChannel = z.infer<typeof TouchChannel>;

export const TouchStatus = z.enum(['planned', 'held', 'queued', 'dialing', 'sent', 'failed', 'skipped']);
export type TouchStatus = z.infer<typeof TouchStatus>;

export const EnrollmentStatus = z.enum(['active', 'conversing', 'needs_review', 'handed_off', 'completed', 'exited']);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatus>;

/** One planner rule's verdict on one channel — a touch's gate audit is a list of these. */
export const GateStep = z.object({
  rule: z.string(),
  channel: z.string(),
  verdict: z.enum(['removed', 'deferred', 'kept', 'held']),
  detail: z.string(),
});
export type GateStep = z.infer<typeof GateStep>;

/** One enrollment in the campaign's plan view. Triage is shown without its do-not-contact quote. */
export const PlanRow = z.object({
  enrollmentId: z.string().uuid(),
  sfRecordId: z.string(),
  name: z.string().nullable(),
  ownerName: z.string().nullable(),
  status: EnrollmentStatus,
  exitReason: z.string().nullable(),
  triage: TriageResult.omit({ doNotContact: true }).nullable(),
  nextTouch: z
    .object({
      seq: z.number(),
      channel: TouchChannel,
      status: TouchStatus,
      dueAt: z.string(),
      gateAudit: z.array(GateStep),
    })
    .nullable(),
});
export type PlanRow = z.infer<typeof PlanRow>;

/** GET /api/campaigns/:id/plan — 50 rows a page; `counts` covers the whole campaign. */
export const CampaignPlanResponse = z.object({
  rows: z.array(PlanRow),
  nextCursor: z.string().nullable(),
  counts: z.record(EnrollmentStatus, z.number()),
});
export type CampaignPlanResponse = z.infer<typeof CampaignPlanResponse>;
