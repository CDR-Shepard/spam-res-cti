import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  jsonb,
  boolean,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// =============================================================================
// Enums
// =============================================================================

export const callStatus = pgEnum('call_status', [
  'queued',
  'initiating',
  'ringing',
  'in_progress',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'canceled',
]);

export const callDirection = pgEnum('call_direction', ['outbound', 'inbound']);

export const decisionEnum = pgEnum('precall_decision', ['ALLOW', 'BLOCK', 'REQUIRE_REVIEW']);

export const numberHealthEnum = pgEnum('number_health', [
  'healthy',
  'warning',
  'degraded',
  'spam_likely',
  'unknown',
]);

export const syncStatusEnum = pgEnum('sync_status', ['pending', 'in_flight', 'succeeded', 'failed']);

// =============================================================================
// Core
// =============================================================================

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Salesforce org id this local org maps to (set on first SF login). */
  sfOrgId: text('sf_org_id'),
  /**
   * How this org satisfies DNC compliance, driving the firewall's federal_dnc
   * gate display:
   *  - 'registry' (default): check the number against the loaded DNC cache;
   *    honestly report "not scrubbed" when no list is loaded.
   *  - 'external_prescrubbed': the org attests its call lists are scrubbed
   *    offline before loading. The gate passes GREEN labeled "pre-scrubbed list
   *    (org policy)" — but a number that IS in a loaded cache still BLOCKS.
   */
  dncMode: text('dnc_mode').default('registry').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    timezone: text('timezone').default('UTC').notNull(),
    /** Admins manage outbound numbers, assignment, and campaigns. */
    isAdmin: boolean('is_admin').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_unique').on(t.email),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    tokenIdx: uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
  }),
);

// =============================================================================
// Salesforce
// =============================================================================

export const salesforceConnections = pgTable(
  'salesforce_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    instanceUrl: text('instance_url').notNull(),
    sfUserId: text('sf_user_id').notNull(),
    sfOrgId: text('sf_org_id').notNull(),
    /** Encrypted via crypto.encryptString */
    accessTokenEnc: text('access_token_enc').notNull(),
    /** Encrypted via crypto.encryptString — may be null if user revoked */
    refreshTokenEnc: text('refresh_token_enc'),
    scope: text('scope'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Cached SF user profile — populated from /oauth2/userinfo after connect.
    sfUserName: text('sf_user_name'),
    sfUserEmail: text('sf_user_email'),
    sfPhotoB64: text('sf_photo_b64'),
    sfPhotoContentType: text('sf_photo_content_type'),
    sfProfileFetchedAt: timestamp('sf_profile_fetched_at', { withTimezone: true }),
  },
  (t) => ({
    userUnique: uniqueIndex('sf_conn_user_unique').on(t.userId),
  }),
);

/** Short-lived state for OAuth (PKCE verifier + redirect target). */
export const salesforceOauthState = pgTable('salesforce_oauth_state', {
  state: text('state').primaryKey(),
  pkceVerifier: text('pkce_verifier').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** opaque token the client polls with */
  desktopHandshakeToken: text('desktop_handshake_token').notNull(),
  /** Login mode (userId null): the user found/created in the callback. */
  loginUserId: uuid('login_user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Set when the login-status poll has minted the session (single-use). */
  sessionRetrievedAt: timestamp('session_retrieved_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// =============================================================================
// Telephony
// =============================================================================

export const outboundNumbers = pgTable(
  'outbound_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    e164: text('e164').notNull(),
    label: text('label'),
    provider: text('provider').notNull(),
    active: boolean('active').default(true).notNull(),
    /** Rep this number is assigned to (their active dialing pool). Null = the
     *  shared reserve pool, held back until an admin assigns it. */
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Twilio IncomingPhoneNumber SID (PN…). Set when imported from Twilio;
     *  lets inbound-webhook registration find the carrier number by SID. */
    twilioSid: text('twilio_sid'),
    health: numberHealthEnum('health').default('unknown').notNull(),
    healthUpdatedAt: timestamp('health_updated_at', { withTimezone: true }),
    /** Who last set `health`: 'numberverifier' | 'reputation_worker' |
     *  'analytics_block' | 'manual'. Drives safe auto-restore. */
    healthSource: text('health_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Inbound auto-answer config (drives caller-reputation hygiene against
    // anti-spam reverse-call probes).
    inboundEnabled: boolean('inbound_enabled').default(false).notNull(),
    inboundGreeting: text('inbound_greeting'),
    inboundMatchedGreeting: text('inbound_matched_greeting'),
    inboundRecordSeconds: integer('inbound_record_seconds').default(60).notNull(),
    inboundTranscribe: boolean('inbound_transcribe').default(true).notNull(),
    inboundForwardToE164: text('inbound_forward_to_e164'),
    // 2026 spam-resistance: per-DID warmup + velocity tracking.
    firstUsedAt: timestamp('first_used_at', { withTimezone: true }),
    lastDialAt: timestamp('last_dial_at', { withTimezone: true }),
    dialsToday: integer('dials_today').default(0).notNull(),
    dialsTodayDate: text('dials_today_date').default('1970-01-01').notNull(),
    warmupOverrideCap: integer('warmup_override_cap'),
    lastMinuteDialCount: integer('last_minute_dial_count').default(0).notNull(),
    lastMinuteWindowStart: timestamp('last_minute_window_start', { withTimezone: true }),
    baselineAttestation: text('baseline_attestation'),
    baselineAttestationSetAt: timestamp('baseline_attestation_set_at', { withTimezone: true }),
  },
  (t) => ({
    orgE164Unique: uniqueIndex('outbound_numbers_org_e164_unique').on(t.orgId, t.e164),
  }),
);

export const numberHealthSnapshots = pgTable('number_health_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  outboundNumberId: uuid('outbound_number_id')
    .notNull()
    .references(() => outboundNumbers.id, { onDelete: 'cascade' }),
  health: numberHealthEnum('health').notNull(),
  source: text('source').notNull(), // e.g. "manual", "freecallerregistry", "stub"
  details: jsonb('details'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
});

// =============================================================================
// Call targets cache (lightweight; Salesforce remains source of truth)
// =============================================================================

export const callTargets = pgTable(
  'call_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    e164: text('e164').notNull(),
    displayName: text('display_name'),
    timezone: text('timezone'),
    salesforceWhoId: text('salesforce_who_id'),
    salesforceWhatId: text('salesforce_what_id'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgE164Idx: index('call_targets_org_e164_idx').on(t.orgId, t.e164),
  }),
);

// =============================================================================
// Compliance / firewall
// =============================================================================

export const optOuts = pgTable(
  'opt_outs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    e164: text('e164').notNull(),
    source: text('source').notNull(), // e.g. "manual", "stop_keyword", "import"
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgE164Unique: uniqueIndex('opt_outs_org_e164_unique').on(t.orgId, t.e164),
  }),
);

export const blockedNumbers = pgTable(
  'blocked_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    e164: text('e164').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgE164Unique: uniqueIndex('blocked_numbers_org_e164_unique').on(t.orgId, t.e164),
  }),
);

export const campaignConfigs = pgTable(
  'campaign_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    paused: boolean('paused').default(false).notNull(),
    /** Max attempts per target per rolling window (days) */
    maxAttempts: integer('max_attempts').default(5).notNull(),
    attemptWindowDays: integer('attempt_window_days').default(14).notNull(),
    /** Allowed calling hours, recipient-local. Stored "HH:MM" */
    callingHoursStart: text('calling_hours_start').default('08:00').notNull(),
    callingHoursEnd: text('calling_hours_end').default('20:00').notNull(),
    /** ISO weekday numbers 1-7 (Mon-Sun) allowed */
    callingDays: jsonb('calling_days').default(sql`'[1,2,3,4,5]'::jsonb`).notNull(),
    /** "one_party" | "two_party" | "off" */
    recordingConsentMode: text('recording_consent_mode').default('off').notNull(),
    requiredScriptId: text('required_script_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgKeyUnique: uniqueIndex('campaign_configs_org_key_unique').on(t.orgId, t.key),
  }),
);

// =============================================================================
// 2026 firewall-gap closures
// =============================================================================

/** Federal Do-Not-Call cache (vendor-pluggable). Sync from FreeDNCList. */
export const federalDncEntries = pgTable('federal_dnc_entries', {
  e164: text('e164').primaryKey(),
  source: text('source').default('manual').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

/** Reassigned Numbers Database cache (FCC safe harbor — 90 day TTL). */
export const rndLookups = pgTable(
  'rnd_lookups',
  {
    e164: text('e164').notNull(),
    consentDate: text('consent_date').notNull(), // ISO date
    checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
    result: text('result').notNull(), // 'no_match' | 'reassigned' | 'unknown'
    vendor: text('vendor'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.e164, t.consentDate] }) }),
);

/** Per-recipient TCPA consent audit trail. */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    e164: text('e164').notNull(),
    consentType: text('consent_type').notNull(),
    sourceUrl: text('source_url'),
    sourceIp: text('source_ip'),
    disclosureText: text('disclosure_text'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (t) => ({ orgE164Idx: index('consent_records_org_e164_idx').on(t.orgId, t.e164) }),
);

/** Per-US-state mini-TCPA rule overrides. Stricter than campaign defaults wins. */
export const stateCallingRules = pgTable('state_calling_rules', {
  stateCode: text('state_code').primaryKey(),
  callingHoursStart: text('calling_hours_start').default('08:00').notNull(),
  callingHoursEnd: text('calling_hours_end').default('20:00').notNull(),
  maxAttemptsPer24h: integer('max_attempts_per_24h'),
  requiresRegistration: boolean('requires_registration').default(false).notNull(),
  requiresBond: boolean('requires_bond').default(false).notNull(),
  notes: text('notes'),
});

export const preCallAudits = pgTable(
  'pre_call_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    toNumberRaw: text('to_number_raw').notNull(),
    toNumberE164: text('to_number_e164'),
    fromNumberE164: text('from_number_e164'),
    campaignKey: text('campaign_key'),
    decision: decisionEnum('decision').notNull(),
    reasons: jsonb('reasons').notNull(), // string[]
    blockReason: text('block_reason'),
    requiredScriptId: text('required_script_id'),
    checks: jsonb('checks').notNull(), // detailed firewall report
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgCreatedIdx: index('pre_call_audits_org_created_idx').on(t.orgId, t.createdAt),
    e164Idx: index('pre_call_audits_e164_idx').on(t.toNumberE164),
  }),
);

// =============================================================================
// Calls
// =============================================================================

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerCallId: text('provider_call_id'),
    fromNumber: text('from_number').notNull(),
    toNumber: text('to_number').notNull(),
    normalizedToNumber: text('normalized_to_number').notNull(),
    direction: callDirection('direction').default('outbound').notNull(),
    status: callStatus('status').default('queued').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    disposition: text('disposition'),
    notes: text('notes'),
    recordingUrl: text('recording_url'),
    transcriptUrl: text('transcript_url'),
    salesforceTaskId: text('salesforce_task_id'),
    salesforceWhoId: text('salesforce_who_id'),
    salesforceWhatId: text('salesforce_what_id'),
    preCallAuditId: uuid('precall_audit_id').references(() => preCallAudits.id),
    campaignKey: text('campaign_key'),
    metadata: jsonb('metadata'),
    /**
     * Full human-readable call record (numbers, provider ids, durations, the
     * firewall decision + reasons, and the extended custom-field metadata). We
     * keep the complete detail HERE so the Salesforce Task Description can stay
     * lean (rep notes + time) and org Chatter automations don't post diagnostics.
     */
    syncDetail: text('sync_detail'),
    // Inbound-only fields (populated when direction='inbound')
    inboundCallerMatched: boolean('inbound_caller_matched'),
    inboundVoicemailUrl: text('inbound_voicemail_url'),
    inboundTranscript: text('inbound_transcript'),
    shakenAttestation: text('shaken_attestation'), // 'A' | 'B' | 'C' | null
    shakenVerstat: text('shaken_verstat'),
    analyticsBlocked: boolean('analytics_blocked'),
    analyticsBlockReason: text('analytics_block_reason'),
    recordingDisclosurePlayed: boolean('recording_disclosure_played'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    providerIdIdx: uniqueIndex('calls_provider_call_id_unique')
      .on(t.provider, t.providerCallId)
      .where(sql`${t.providerCallId} is not null`),
    orgCreatedIdx: index('calls_org_created_idx').on(t.orgId, t.createdAt),
    targetIdx: index('calls_org_target_idx').on(t.orgId, t.normalizedToNumber),
  }),
);

export const callEvents = pgTable(
  'call_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    rawStatus: text('raw_status'),
    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    callIdx: index('call_events_call_idx').on(t.callId, t.occurredAt),
  }),
);

// =============================================================================
// Provider webhooks (raw inbox for idempotency + debugging)
// =============================================================================

export const providerWebhookEvents = pgTable(
  'provider_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    /** Provider-supplied id, used for idempotency. Falls back to sha256(body) */
    externalId: text('external_id').notNull(),
    signatureValid: boolean('signature_valid').notNull(),
    headers: jsonb('headers'),
    body: jsonb('body'),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => ({
    providerExtUnique: uniqueIndex('provider_webhook_external_unique').on(t.provider, t.externalId),
  }),
);

// =============================================================================
// Salesforce sync queue
// =============================================================================

export const salesforceSyncJobs = pgTable(
  'salesforce_sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
    status: syncStatusEnum('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    salesforceTaskId: text('salesforce_task_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Touched on every status transition. A job stuck in 'in_flight' with a stale
    // updatedAt is an orphan from a crashed/redeployed tick and gets reaped back
    // to 'pending' so the call's Salesforce Task is never permanently lost.
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    callUnique: uniqueIndex('sf_sync_call_unique').on(t.callId),
    statusIdx: index('sf_sync_status_idx').on(t.status, t.nextAttemptAt),
  }),
);

// =============================================================================
// Type helpers
// =============================================================================

export type Call = typeof calls.$inferSelect;
export type NewCall = typeof calls.$inferInsert;
export type PreCallAudit = typeof preCallAudits.$inferSelect;
export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type OutboundNumber = typeof outboundNumbers.$inferSelect;
export type CampaignConfig = typeof campaignConfigs.$inferSelect;
export type SalesforceConnection = typeof salesforceConnections.$inferSelect;
