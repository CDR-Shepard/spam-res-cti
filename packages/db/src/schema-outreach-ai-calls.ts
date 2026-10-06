/**
 * Outreach AI-call tables added by plan 1D (migration 0055_ai_call_writebacks.sql).
 *
 * Re-exported from schema-outreach.ts (which schema.ts re-exports), so
 * `schema.aiCallWritebacks` / `schema.aiPracticeCalls` reach every service
 * through `@cti/db`. Kept in its own file only so schema-outreach.ts stays a
 * readable size.
 *
 * Same rule as schema-outreach.ts: this file imports NOTHING from schema.ts, so
 * foreign keys and CHECK constraints live in the SQL migration only; the
 * `*_` constants are the CHECKs' exact value lists, pinned by migration-0055.test.ts.
 */
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** ai_call_writebacks.sf_object (CHECK): the record the call was about. */
export const AI_CALL_WRITEBACK_SF_OBJECTS = ['Lead', 'Opportunity'] as const;
/** ai_call_writebacks.status (CHECK). */
export const AI_CALL_WRITEBACK_STATUSES = ['pending', 'running', 'done', 'partial', 'failed', 'skipped'] as const;

/**
 * The Salesforce write-back job for one finished real AI call (FKs in SQL only:
 * org → organizations, ai_call → ai_calls, touch → touches, enrollment → campaign_enrollments).
 */
export const aiCallWritebacks = pgTable(
  'ai_call_writebacks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    aiCallId: uuid('ai_call_id').notNull(),
    touchId: uuid('touch_id'),
    enrollmentId: uuid('enrollment_id'),
    /** Always the record the call was about; never rewritten after a conversion. */
    sfObject: text('sf_object').$type<(typeof AI_CALL_WRITEBACK_SF_OBJECTS)[number]>().notNull(),
    sfRecordId: text('sf_record_id').notNull(),
    outcome: text('outcome').notNull(),
    status: text('status').$type<(typeof AI_CALL_WRITEBACK_STATUSES)[number]>().default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** The write plan, frozen the first time it is computed. */
    plan: jsonb('plan'),
    /** Per-step state. */
    steps: jsonb('steps').default(sql`'{}'::jsonb`).notNull(),
    sfEventId: text('sf_event_id'),
    sfTaskId: text('sf_task_id'),
    sfFeedItemId: text('sf_feed_item_id'),
    /** Set when a Lead was converted: every later step targets this Opportunity. */
    convertedOpportunityId: text('converted_opportunity_id'),
    convertedAccountId: text('converted_account_id'),
    convertedContactId: text('converted_contact_id'),
    model: text('model'),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    aiCallUnique: uniqueIndex('ai_call_writebacks_ai_call_unique').on(t.aiCallId),
    dueIdx: index('ai_call_writebacks_due_idx').on(t.nextAttemptAt).where(sql`status IN ('pending', 'running')`),
    recordIdx: index('ai_call_writebacks_record_idx').on(t.orgId, t.sfRecordId),
  }),
);

/**
 * One practice call: an admin's test number rung with a lead's real record and plan
 * (FKs in SQL only: org, campaign, enrollment, call_plan, ai_call, requested_by → users).
 */
export const aiPracticeCalls = pgTable(
  'ai_practice_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    campaignId: uuid('campaign_id').notNull(),
    enrollmentId: uuid('enrollment_id').notNull(),
    callPlanId: uuid('call_plan_id'),
    planVersion: integer('plan_version').notNull(),
    aiCallId: uuid('ai_call_id'),
    requestedBy: uuid('requested_by'),
    toE164: text('to_e164').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The trigger's answer (InternalAiCallResponse). */
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    campaignIdx: index('ai_practice_calls_campaign_idx').on(t.campaignId, sql`${t.createdAt} desc`),
  }),
);

export type AiCallWritebackRow = typeof aiCallWritebacks.$inferSelect;
export type AiPracticeCallRow = typeof aiPracticeCalls.$inferSelect;
