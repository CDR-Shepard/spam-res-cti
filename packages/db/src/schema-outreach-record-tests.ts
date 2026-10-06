/**
 * Test a record tables added by plan 1E (migration 0058_ai_record_tests.sql).
 *
 * Re-exported from schema-outreach.ts (which schema.ts re-exports), so
 * `schema.aiRecordTests` / `schema.aiRecordTestCalls` reach every service
 * through `@cti/db`. Kept in its own file only so schema-outreach.ts stays a
 * readable size.
 *
 * Same rule as schema-outreach.ts: this file imports NOTHING from schema.ts, so
 * foreign keys and CHECK constraints live in the SQL migration only; the
 * `*_` constants are the CHECKs' exact value lists, pinned by migration-0058.test.ts.
 */
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** ai_record_tests.sf_object (CHECK). */
export const AI_RECORD_TEST_SF_OBJECTS = ['Lead', 'Opportunity'] as const;
/** ai_record_tests.status (CHECK). */
export const AI_RECORD_TEST_STATUSES = ['running', 'ready', 'failed'] as const;
/** ai_record_test_calls.mode (CHECK: a phone call has to_e164 only, a browser call client_identity only). */
export const AI_RECORD_TEST_CALL_MODES = ['phone', 'browser'] as const;

/**
 * One preview of how the AI would call a Lead or Opportunity: research, plan, the
 * agent's plan text and the times it would offer. Admin-only and never a campaign:
 * no enrollment, touch, call_plans or crm_records row, never a Salesforce write
 * (FKs in SQL only: org → organizations, requested_by → users).
 */
export const aiRecordTests = pgTable(
  'ai_record_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    requestedBy: uuid('requested_by'),
    sfObject: text('sf_object').$type<(typeof AI_RECORD_TEST_SF_OBJECTS)[number]>().notNull(),
    /** Always 18 characters (the record ref parser normalises a 15-character Id). */
    sfRecordId: text('sf_record_id').notNull(),
    /** running → ready | failed. A running row older than 6 minutes READS as failed: interrupted. */
    status: text('status').$type<(typeof AI_RECORD_TEST_STATUSES)[number]>().default('running').notNull(),
    /** A short code (RecordTestError, @cti/contracts record-tests.ts). */
    error: text('error'),
    name: text('name'),
    /** The ResearchSnapshot the plan was written from. */
    research: jsonb('research'),
    /** The CallPlan (facts applied). */
    plan: jsonb('plan'),
    /** The exact text the voice agent would get; null when the plan text check refused it. */
    planText: text('plan_text'),
    /** describePlanTextIssues words when planText is null. */
    planTextIssues: jsonb('plan_text_issues').$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    /** AppointmentSlots offered at preview time. */
    slots: jsonb('slots').$type<unknown[]>().default(sql`'[]'::jsonb`).notNull(),
    /** Why no times were offered (null when slots were offered). */
    offerNote: text('offer_note'),
    ownerSfUserId: text('owner_sf_user_id'),
    model: text('model'),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    costMicros: bigint('cost_micros', { mode: 'number' }).default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    orgCreatedIdx: index('ai_record_tests_org_created_idx').on(t.orgId, sql`${t.createdAt} desc`),
    requesterIdx: index('ai_record_tests_requester_idx').on(t.requestedBy, sql`${t.createdAt} desc`),
  }),
);

/**
 * One test call run from a preview: a practice call to an admin test number
 * (phone) or to the admin's browser (client identity). Never a touch
 * (FKs in SQL only: org, record_test → ai_record_tests, requested_by → users, ai_call → ai_calls).
 */
export const aiRecordTestCalls = pgTable(
  'ai_record_test_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    recordTestId: uuid('record_test_id').notNull(),
    requestedBy: uuid('requested_by'),
    mode: text('mode').$type<(typeof AI_RECORD_TEST_CALL_MODES)[number]>().notNull(),
    /** Set for a phone call only (CHECK). */
    toE164: text('to_e164'),
    /** Set for a browser call only (CHECK): aitest_<user hex>_<nonce hex>. */
    clientIdentity: text('client_identity'),
    idempotencyKey: text('idempotency_key').notNull(),
    aiCallId: uuid('ai_call_id'),
    /** The trigger's answer (InternalAiCallResponse). */
    result: jsonb('result'),
    /** "Would have written to Salesforce" (RecordTestDryRun), computed once on request. */
    dryRun: jsonb('dry_run'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyUnique: uniqueIndex('ai_record_test_calls_key_unique').on(t.idempotencyKey),
    testIdx: index('ai_record_test_calls_test_idx').on(t.recordTestId, sql`${t.createdAt} desc`),
    requesterIdx: index('ai_record_test_calls_requester_idx').on(t.requestedBy, sql`${t.createdAt} desc`),
  }),
);

export type AiRecordTestRow = typeof aiRecordTests.$inferSelect;
export type AiRecordTestCallRow = typeof aiRecordTestCalls.$inferSelect;
