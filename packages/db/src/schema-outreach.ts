/**
 * Outreach tables (migration 0051_outreach_campaigns.sql; spec
 * docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md §9).
 *
 * Re-exported at the END of schema.ts (`export * from './schema-outreach.js'`),
 * so `schema.campaigns` etc. reach every service through `@cti/db`.
 *
 * This file imports NOTHING from schema.ts: no Drizzle `.references()` here, so
 * there is no ESM import cycle. Foreign keys (org_id → organizations, and the
 * outreach tables' links to each other) are declared in the SQL migration only.
 * CHECK constraints are likewise SQL-only; the `*_` constants below are their
 * exact value lists, pinned against the migration by migration-0051.test.ts.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** crm_connections.provider (CHECK). */
export const CRM_PROVIDERS = ['salesforce'] as const;
/** crm_connections.status (CHECK). `broken` = a token refresh failed. */
export const CRM_CONNECTION_STATUSES = ['connected', 'broken'] as const;
/** campaigns.sf_object (CHECK). */
export const CAMPAIGN_SF_OBJECTS = ['Lead', 'Opportunity'] as const;
/** campaigns.source_kind (CHECK). */
export const CAMPAIGN_SOURCE_KINDS = ['list_view', 'soql'] as const;
/** campaigns.status (CHECK): draft → dry_run → active ⇄ paused → archived. */
export const CAMPAIGN_STATUSES = ['draft', 'dry_run', 'active', 'paused', 'archived'] as const;
/** The status a paused campaign returns to on an automatic resume (B7). */
export const CAMPAIGN_PAUSED_FROM = ['dry_run', 'active'] as const;
/** campaign_enrollments.status (CHECK). */
export const ENROLLMENT_STATUSES = ['active', 'conversing', 'needs_review', 'handed_off', 'completed', 'exited'] as const;
/** touches.channel (CHECK). */
export const TOUCH_CHANNELS = ['ai_call', 'rep_call', 'sms', 'email'] as const;
/** touches.status (CHECK). Open = planned | held | queued | dialing. */
export const TOUCH_STATUSES = ['planned', 'held', 'queued', 'dialing', 'sent', 'failed', 'skipped'] as const;
/** sf_writes.kind (CHECK). */
export const SF_WRITE_KINDS = ['task', 'consent', 'do_not_contact'] as const;
/** sf_writes.status (CHECK). */
export const SF_WRITE_STATUSES = ['pending', 'done', 'failed'] as const;

/** One company-wide Salesforce connection per tenant (the Integration user). */
export const crmConnections = pgTable(
  'crm_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    provider: text('provider').$type<(typeof CRM_PROVIDERS)[number]>().default('salesforce').notNull(),
    instanceUrl: text('instance_url').notNull(),
    sfOrgId: text('sf_org_id').notNull(),
    sfUserId: text('sf_user_id').notNull(),
    sfUsername: text('sf_username'),
    /** Encrypted with @cti/auth encryptString. */
    accessTokenEnc: text('access_token_enc').notNull(),
    /** Encrypted with @cti/auth encryptString; null when Salesforce issued none. */
    refreshTokenEnc: text('refresh_token_enc'),
    status: text('status').$type<(typeof CRM_CONNECTION_STATUSES)[number]>().default('connected').notNull(),
    lastError: text('last_error'),
    /** FieldMap from @cti/contracts (crm.ts). */
    fieldMap: jsonb('field_map'),
    connectedBy: uuid('connected_by'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // FULL: the connect upserts ON CONFLICT (org_id, provider).
    orgProviderUnique: uniqueIndex('crm_connections_org_provider_unique').on(t.orgId, t.provider),
  }),
);

/** PKCE state for the connect flow; 10-minute TTL enforced in code. */
export const crmOauthStates = pgTable(
  'crm_oauth_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    state: text('state').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    stateUnique: uniqueIndex('crm_oauth_states_state_unique').on(t.state),
  }),
);

/** A list view or pasted SOQL of Leads or Opportunities. */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    name: text('name').notNull(),
    sfObject: text('sf_object').$type<(typeof CAMPAIGN_SF_OBJECTS)[number]>().notNull(),
    sourceKind: text('source_kind').$type<(typeof CAMPAIGN_SOURCE_KINDS)[number]>().notNull(),
    listViewId: text('list_view_id'),
    /** The membership query: pasted text, or the list view's described SOQL. */
    soql: text('soql').notNull(),
    status: text('status').$type<(typeof CAMPAIGN_STATUSES)[number]>().default('draft').notNull(),
    /** manual | crm_broken | ai_budget | kill_switch (no CHECK: later phases add reasons). */
    pauseReason: text('pause_reason'),
    /** dry_run | active: what an automatic resume returns to; null unless paused. */
    pausedFrom: text('paused_from').$type<(typeof CAMPAIGN_PAUSED_FROM)[number]>(),
    refreshMinutes: integer('refresh_minutes').default(240).notNull(),
    touchDays: integer('touch_days').array().default(sql`'{0,1,3,6,10,14}'`).notNull(),
    approvalsRemaining: integer('approvals_remaining').default(50).notNull(),
    playbook: jsonb('playbook').default(sql`'{}'::jsonb`).notNull(),
    memberCount: integer('member_count').default(0).notNull(),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    lastRefreshError: text('last_refresh_error'),
    /** Claim taken by a `campaign.refresh` tick while it works on this campaign; a claim older than 30 minutes is stale. */
    refreshStartedAt: timestamp('refresh_started_at', { withTimezone: true }),
    /** Cursor of the refresh's Task check; moves only when the check succeeds. */
    tasksCheckedAt: timestamp('tasks_checked_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgStatusIdx: index('campaigns_org_status_idx').on(t.orgId, t.status),
  }),
);

/** One row per Salesforce record per tenant. Notes text is never stored. */
export const crmRecords = pgTable(
  'crm_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    sfObject: text('sf_object').$type<(typeof CAMPAIGN_SF_OBJECTS)[number]>().notNull(),
    sfRecordId: text('sf_record_id').notNull(),
    name: text('name'),
    ownerSfUserId: text('owner_sf_user_id'),
    ownerName: text('owner_name'),
    leadManagerSfUserId: text('lead_manager_sf_user_id'),
    /** In field-map order. */
    phones: jsonb('phones').$type<Array<{ field: string; e164: string }>>().default(sql`'[]'::jsonb`).notNull(),
    email: text('email'),
    state: text('state'),
    webFormSource: text('web_form_source'),
    consentAiCall: boolean('consent_ai_call').default(false).notNull(),
    consentSource: text('consent_source'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    sfDoNotCall: boolean('sf_do_not_call').default(false).notNull(),
    sfEmailOptOut: boolean('sf_email_opt_out').default(false).notNull(),
    skipOnDialer: boolean('skip_on_dialer').default(false).notNull(),
    isClosed: boolean('is_closed').default(false).notNull(),
    notesHash: text('notes_hash'),
    triageNeeded: boolean('triage_needed').default(true).notNull(),
    /** Last time the triage tick claimed this row; NULL after a sync that changed the record. */
    triageAttemptedAt: timestamp('triage_attempted_at', { withTimezone: true }),
    /** The record_triage row whose do-not-contact flag a person last dismissed; a newer flag holds the person again. No FK. */
    dncDismissedTriageId: uuid('dnc_dismissed_triage_id'),
    sfLastModifiedAt: timestamp('sf_last_modified_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // FULL: refresh upserts ON CONFLICT (org_id, sf_record_id).
    orgRecordUnique: uniqueIndex('crm_records_org_record_unique').on(t.orgId, t.sfRecordId),
    triageNeededIdx: index('crm_records_triage_needed_idx').on(t.orgId, t.syncedAt).where(sql`triage_needed`),
  }),
);

/** One row per triage model call. `result` is a zod-validated TriageResult. */
export const recordTriage = pgTable(
  'record_triage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    crmRecordId: uuid('crm_record_id').notNull(),
    notesHash: text('notes_hash').notNull(),
    model: text('model').notNull(),
    result: jsonb('result').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    recordCreatedIdx: index('record_triage_record_created_idx').on(t.crmRecordId, t.createdAt.desc()),
  }),
);

/** One person in one campaign. */
export const campaignEnrollments = pgTable(
  'campaign_enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    campaignId: uuid('campaign_id').notNull(),
    crmRecordId: uuid('crm_record_id').notNull(),
    status: text('status').$type<(typeof ENROLLMENT_STATUSES)[number]>().default('active').notNull(),
    exitReason: text('exit_reason'),
    /** The AI's do-not-contact flag, awaiting the owner (DoNotContactCategory). */
    reviewCategory: text('review_category'),
    reviewQuote: text('review_quote'),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    /** The record_triage row the flag came from (FK in SQL only). */
    reviewTriageId: uuid('review_triage_id'),
    nextTouchAt: timestamp('next_touch_at', { withTimezone: true }),
    touchesDone: integer('touches_done').default(0).notNull(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    campaignRecordUnique: uniqueIndex('campaign_enrollments_campaign_record_unique').on(t.campaignId, t.crmRecordId),
    orgStatusNextIdx: index('campaign_enrollments_org_status_next_idx').on(t.orgId, t.status, t.nextTouchAt),
  }),
);

/** Every E.164 and lowercased email of an enrollment; active ones block other campaigns. */
export const enrollmentContactKeys = pgTable(
  'enrollment_contact_keys',
  {
    enrollmentId: uuid('enrollment_id').notNull(),
    orgId: uuid('org_id').notNull(),
    /** E.164 or lowercased email. */
    key: text('key').notNull(),
    active: boolean('active').default(true).notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'enrollment_contact_keys_pkey', columns: [t.enrollmentId, t.key] }),
    // PARTIAL: one active campaign per person. An ON CONFLICT target on it must
    // repeat WHERE active (else 42P10); enrollRecords catches the 23505 instead.
    activeUnique: uniqueIndex('enrollment_contact_keys_active_unique').on(t.orgId, t.key).where(sql`active`),
  }),
);

/** One planned or executed touch of an enrollment. */
export const touches = pgTable(
  'touches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    enrollmentId: uuid('enrollment_id').notNull(),
    seq: integer('seq').notNull(),
    channel: text('channel').$type<(typeof TOUCH_CHANNELS)[number]>().notNull(),
    status: text('status').$type<(typeof TOUCH_STATUSES)[number]>().notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** The CTI power-dial run a rep_call went into (no FK). */
    dialerSessionId: uuid('dialer_session_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    outcome: text('outcome'),
    providerRef: text('provider_ref'),
    body: text('body'),
    /** GateStep[] (@cti/contracts review.ts) — every planner rule's verdict. */
    gateAudit: jsonb('gate_audit').$type<unknown[]>().default(sql`'[]'::jsonb`).notNull(),
    skipReason: text('skip_reason'),
    /** Set once, by the compare-and-swap that counts this touch toward `touches_done`. */
    countedAt: timestamp('counted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // FULL: the planner inserts ON CONFLICT (enrollment_id, seq) DO NOTHING.
    enrollmentSeqUnique: uniqueIndex('touches_enrollment_seq_unique').on(t.enrollmentId, t.seq),
    orgStatusDueIdx: index('touches_org_status_due_idx').on(t.orgId, t.status, t.dueAt),
    dialerSessionIdx: index('touches_dialer_session_idx').on(t.dialerSessionId).where(sql`dialer_session_id IS NOT NULL`),
  }),
);

/** Salesforce write outbox (drained by plan 1B's sf.write job). */
export const sfWrites = pgTable(
  'sf_writes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    kind: text('kind').$type<(typeof SF_WRITE_KINDS)[number]>().notNull(),
    sfObject: text('sf_object').notNull(),
    sfRecordId: text('sf_record_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<(typeof SF_WRITE_STATUSES)[number]>().default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastError: text('last_error'),
    firstFailedAt: timestamp('first_failed_at', { withTimezone: true }),
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusNextIdx: index('sf_writes_status_next_idx').on(t.status, t.nextAttemptAt),
  }),
);

/** AI spend per tenant per UTC day, in micro-dollars (1e-6 USD). */
export const aiUsageDays = pgTable(
  'ai_usage_days',
  {
    orgId: uuid('org_id').notNull(),
    /** YYYY-MM-DD, UTC. */
    day: text('day').notNull(),
    costMicros: bigint('cost_micros', { mode: 'number' }).default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'ai_usage_days_pkey', columns: [t.orgId, t.day] }),
  }),
);

export type CrmConnectionRow = typeof crmConnections.$inferSelect;
export type CampaignRow = typeof campaigns.$inferSelect;
export type CrmRecordRow = typeof crmRecords.$inferSelect;
export type CampaignEnrollmentRow = typeof campaignEnrollments.$inferSelect;
export type TouchRow = typeof touches.$inferSelect;
export type SfWriteRow = typeof sfWrites.$inferSelect;
