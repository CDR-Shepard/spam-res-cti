/**
 * Sam's email channel and the per-seller conversation (plan
 * docs/superpowers/plans/2026-10-19-sam-email-timeline.md): the timeline a seller's page shows (calls, emails,
 * hand-overs, status changes, flags on one list), who is handling the seller, the reasons Sam stops or asks
 * a person, and the draft / send / settings shapes. outreach-api owns the tables (migration 0062) and serves
 * these; outreach-web renders them. Timestamps are ISO strings, as elsewhere in the contracts.
 *
 * The enums that mirror a table CHECK (handler, status, email status) must stay in step with the db
 * package's lists (CONVERSATION_HANDLERS, CONVERSATION_STATUSES, EMAIL_STATUSES). StopReason and FlagReason
 * have no CHECK, so a later step adds a value here without a migration.
 */
import { z } from 'zod';
import { AiCallOutcome } from './ai-calls.js';
import { SfObject } from './crm.js';

/** Who is handling the seller: Sam (the AI assistant) or a person on the team. */
export const ConversationHandler = z.enum(['sam', 'person']);
export type ConversationHandler = z.infer<typeof ConversationHandler>;

/** open = Sam may reach out; booked = an appointment is set; stopped = Sam must not reach out (see StopReason). */
export const ConversationStatus = z.enum(['open', 'booked', 'stopped']);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

/** Why Sam stopped for a seller: the seller opted out, complained, asked to stop, or said not interested. */
export const StopReason = z.enum(['opted_out', 'complained', 'asked_to_stop', 'not_interested']);
export type StopReason = z.infer<typeof StopReason>;

/** Why a person is needed on a seller: a reply or draft Sam did not handle (flag Task for the record owner). */
export const FlagReason = z.enum([
  'offer_or_price', 'angry_or_threat', 'legal', 'not_owner', 'wants_appointment', 'unsure', 'other_sender', 'loop_guard',
  'after_close', 'draft_rejected',
]);
export type FlagReason = z.infer<typeof FlagReason>;

/** email_messages.status (migration 0062). received = mail in. */
export const EmailStatus = z.enum(['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'canceled', 'received']);
export type EmailStatus = z.infer<typeof EmailStatus>;

/** Why Sam may not email a seller right now (the seller page shows it beside a disabled Email button). */
export const EmailBlock = z.enum([
  'not_configured', 'disabled', 'paused', 'no_address', 'suppressed', 'sf_opt_out', 'stopped', 'booked', 'closed', 'taken_over',
  'flagged', 'not_approved', 'daily_cap',
]);
export type EmailBlock = z.infer<typeof EmailBlock>;

/** The longest subject and body a draft may have (a subject is one header line; the body is plain text). */
export const EMAIL_SUBJECT_MAX = 150;
export const EMAIL_BODY_MAX = 3000;

/**
 * One call on the timeline (an ai_calls row; calls are merged in at read time, never copied). outcome,
 * summary and durationSeconds are null until the call has them (ai_calls.outcome / summary / duration_seconds
 * are nullable, as AiCallResult models them).
 */
const TimelineCall = z.object({
  type: z.literal('call'),
  /** ai_calls.id */
  id: z.string().uuid(),
  at: z.string(),
  outcome: AiCallOutcome.nullable(),
  summary: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  transcriptAvailable: z.boolean(),
});

/** One email on the timeline, in or out. notSentReason is why Sam's email did not go (a canceled one). */
const TimelineEmail = z.object({
  type: z.literal('email'),
  /** conversation_events.id */
  id: z.string().uuid(),
  at: z.string(),
  direction: z.enum(['in', 'out']),
  actor: z.enum(['sam', 'seller', 'person']),
  subject: z.string(),
  body: z.string(),
  status: EmailStatus,
  autoReply: z.boolean(),
  notSentReason: EmailBlock.nullable(),
});

/**
 * A hand-over, a status change or a flag. `detail` is a code, not words: the hand-over (`taken_over` /
 * `given_back`), the status or stop reason (`booked`, `opted_out`, ...), or the flag reason (`legal`, `unsure`, ...);
 * the web says it in words. byName is the person who did it (null = Sam or the system).
 */
const TimelineNote = z.object({
  type: z.literal('note'),
  id: z.string().uuid(),
  at: z.string(),
  kind: z.enum(['handler', 'status', 'flag']),
  detail: z.string(),
  byName: z.string().nullable(),
});

export const TimelineItem = z.discriminatedUnion('type', [TimelineCall, TimelineEmail, TimelineNote]);
export type TimelineItem = z.infer<typeof TimelineItem>;

/**
 * GET /sellers/:sfRecordId/conversation: everything a seller's page needs. conversationId is null until the
 * seller has a conversation row. emailBlock is why Sam may not email (null when mayEmail); mayChangeHandler is
 * whether the viewer may take over or give back (the record's owner or an admin).
 */
export const ConversationView = z.object({
  sfRecordId: z.string(),
  sfObject: SfObject,
  name: z.string(),
  recordUrl: z.string(),
  conversationId: z.string().uuid().nullable(),
  handler: ConversationHandler,
  handlerName: z.string().nullable(),
  status: ConversationStatus,
  stopReason: StopReason.nullable(),
  flagReason: FlagReason.nullable(),
  emailAddress: z.string().nullable(),
  emailBlock: EmailBlock.nullable(),
  mayEmail: z.boolean(),
  mayChangeHandler: z.boolean(),
  items: z.array(TimelineItem),
});
export type ConversationView = z.infer<typeof ConversationView>;

/** An email as the admin edits and sends it: one-line subject, plain-text body. */
export const EmailDraft = z.object({
  subject: z
    .string()
    .min(1)
    .max(EMAIL_SUBJECT_MAX)
    .refine((s) => !/[\r\n]/.test(s), 'The subject must be one line'),
  body: z.string().min(1).max(EMAIL_BODY_MAX),
});
export type EmailDraft = z.infer<typeof EmailDraft>;

/** Ask Sam for a draft. practice = to the admin's own address instead of the seller's. */
export const EmailDraftRequest = z.object({ practice: z.boolean() });
export type EmailDraftRequest = z.infer<typeof EmailDraftRequest>;

/** Sam's draft, and the address it would go to. */
export const EmailDraftResponse = EmailDraft.extend({ to: z.string() });
export type EmailDraftResponse = z.infer<typeof EmailDraftResponse>;

/** Queue the (edited) draft. practice = to the admin's own address; nothing touches the seller. */
export const EmailSendRequest = EmailDraft.extend({ practice: z.boolean() });
export type EmailSendRequest = z.infer<typeof EmailSendRequest>;

/** The queued email, when it goes out (the sending-hours window) and where. */
export const EmailSendResponse = z.object({ emailId: z.string().uuid(), sendAfter: z.string(), to: z.string() });
export type EmailSendResponse = z.infer<typeof EmailSendResponse>;

/** PUT /sellers/:sfRecordId/handler: a person takes over, or gives the seller back to Sam. */
export const HandlerChangeRequest = z.object({ handler: ConversationHandler });
export type HandlerChangeRequest = z.infer<typeof HandlerChangeRequest>;

/**
 * The tenant's email switch. configured = the server can email: Resend is set up AND Sam's writer is (an Anthropic
 * key and a priced EMAIL_MODEL). pausedAt / pausedReason say Sam's email was paused (a spam complaint) until an
 * admin turns it back on.
 */
export const SamEmailSettings = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  pausedAt: z.string().nullable(),
  pausedReason: z.string().nullable(),
});
export type SamEmailSettings = z.infer<typeof SamEmailSettings>;

export const SamEmailSettingsSave = z.object({ enabled: z.boolean() });
export type SamEmailSettingsSave = z.infer<typeof SamEmailSettingsSave>;
