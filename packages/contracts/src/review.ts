import { z } from 'zod';
import { ContactChannel, SfObject } from './crm.js';

/** The fixed vocabulary triage may tag a record with. */
export const TRIAGE_TAGS = [
  'motivated',
  'not_motivated',
  'timeline_now',
  'timeline_3_months',
  'timeline_6_months_plus',
  'vacant',
  'tenant_occupied',
  'needs_repairs',
  'inherited',
  'pre_foreclosure',
  'divorce',
  'relocating',
  'tired_landlord',
  'price_sensitive',
  'spouse_decides',
  'prefers_text',
  'prefers_email',
  'prefers_call',
  'bad_number',
  'wrong_person',
] as const;
export const TriageTag = z.enum(TRIAGE_TAGS);
export type TriageTag = z.infer<typeof TriageTag>;

/** Why the AI thinks a person must not be contacted. Held for the owner, never acted on alone. */
export const DoNotContactCategory = z.enum(['sold', 'attorney', 'deceased', 'asked_no_contact', 'listed_with_agent', 'hostile', 'other']);
export type DoNotContactCategory = z.infer<typeof DoNotContactCategory>;

/** The triage model's output. Every model response is parsed with this before use. */
export const TriageResult = z.object({
  summary: z.string().min(1).max(600),
  /** Preferred channels, best first; [] = no preference. Each reason quotes the note behind it. */
  channels: z.array(z.object({ channel: ContactChannel, reason: z.string().min(1).max(300) })).max(3),
  timing: z.string().max(200).nullable(),
  tags: z.array(TriageTag).max(8),
  doNotContact: z.object({ category: DoNotContactCategory, quote: z.string().min(1).max(300) }).nullable(),
});
export type TriageResult = z.infer<typeof TriageResult>;

/** One flagged enrollment on the Needs Review list. */
export const NeedsReviewItem = z.object({
  enrollmentId: z.string().uuid(),
  campaignId: z.string().uuid(),
  campaignName: z.string(),
  sfObject: SfObject,
  sfRecordId: z.string(),
  name: z.string().nullable(),
  ownerName: z.string().nullable(),
  category: DoNotContactCategory,
  quote: z.string(),
  flaggedAt: z.string(),
});
export type NeedsReviewItem = z.infer<typeof NeedsReviewItem>;

/** GET /api/review. */
export const NeedsReviewResponse = z.object({ items: z.array(NeedsReviewItem) });
export type NeedsReviewResponse = z.infer<typeof NeedsReviewResponse>;

/** POST /api/review/:enrollmentId — dismiss resumes the enrollment; confirm opts the person out. */
export const ReviewDecision = z.object({ decision: z.enum(['dismiss', 'confirm']) });
export type ReviewDecision = z.infer<typeof ReviewDecision>;
