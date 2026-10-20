/**
 * Sam's email channel and the per-seller conversation (migration 0062_seller_conversations.sql).
 *
 * Re-exported from schema-outreach.ts (which schema.ts re-exports), so
 * `schema.sellerConversations` and the rest reach every service through `@cti/db`.
 *
 * Same rule as schema-outreach.ts: this file imports NOTHING from schema.ts, so
 * foreign keys and CHECK constraints live in the SQL migration only; the
 * `*_` constants are the CHECKs' exact value lists, pinned by migration-0062.test.ts.
 * stop_reason and flag_reason have no CHECK on purpose (a later step adds a value
 * without a migration); contracts StopReason / FlagReason list them.
 */
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** seller_conversations.handler (CHECK): who is handling the seller. */
export const CONVERSATION_HANDLERS = ['sam', 'person'] as const;
/** seller_conversations.status (CHECK). */
export const CONVERSATION_STATUSES = ['open', 'booked', 'stopped'] as const;
/** conversation_events.kind (CHECK). */
export const CONVERSATION_EVENT_KINDS = ['email', 'text', 'human_touch', 'handler', 'status', 'flag', 'note'] as const;
/** conversation_events.direction (CHECK). */
export const CONVERSATION_EVENT_DIRECTIONS = ['in', 'out', 'none'] as const;
/** conversation_events.actor (CHECK). */
export const CONVERSATION_ACTORS = ['sam', 'seller', 'person', 'system'] as const;
/** conversation_events.sf_log_status (CHECK): the Salesforce Task log. */
export const SF_LOG_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const;
/** email_messages.direction (CHECK). */
export const EMAIL_DIRECTIONS = ['out', 'in'] as const;
/** email_messages.status (CHECK). */
export const EMAIL_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'canceled', 'received'] as const;
/** email_messages.purpose (CHECK). */
export const EMAIL_PURPOSES = ['first', 'reply', 'holding', 'practice', 'inbound'] as const;
/** email_suppressions.reason (CHECK). */
export const EMAIL_SUPPRESSION_REASONS = ['opted_out', 'complained', 'bounced'] as const;
/** resend_webhook_events.status (CHECK). */
export const WEBHOOK_EVENT_STATUSES = ['pending', 'done', 'failed', 'ignored'] as const;

/**
 * One row per seller (crm_record) per tenant: the reply token, who is handling the seller and whether
 * Sam may still reach out. practice_user_id is NULL for the real conversation; an admin's practice email
 * gets its own row. (FKs in SQL only: org → organizations, crm_record → crm_records, practice_user and
 * handler_user → users.)
 *
 * The two partial uniques are declared here too. An ON CONFLICT on either must repeat the column list and
 * the WHERE predicate (onConflictDoNothing({ target }) cannot name a partial index without them).
 */
export const sellerConversations = pgTable(
  'seller_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    crmRecordId: uuid('crm_record_id').notNull(),
    /** The admin a practice conversation belongs to; NULL for the real one. */
    practiceUserId: uuid('practice_user_id'),
    /** The opaque reply token (sam+<token>@reply.rethinkre.team). */
    token: text('token').notNull(),
    handler: text('handler').$type<(typeof CONVERSATION_HANDLERS)[number]>().default('sam').notNull(),
    handlerUserId: uuid('handler_user_id'),
    handlerChangedAt: timestamp('handler_changed_at', { withTimezone: true }),
    status: text('status').$type<(typeof CONVERSATION_STATUSES)[number]>().default('open').notNull(),
    /** Why Sam may no longer reach out (contracts StopReason); no CHECK. */
    stopReason: text('stop_reason'),
    /** Why a person is needed (contracts FlagReason); no CHECK. */
    flagReason: text('flag_reason'),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tokenUnique: unique('seller_conversations_token_unique').on(t.token),
    recordUnique: uniqueIndex('seller_conversations_record_unique')
      .on(t.orgId, t.crmRecordId)
      .where(sql`practice_user_id IS NULL`),
    practiceUnique: uniqueIndex('seller_conversations_practice_unique')
      .on(t.orgId, t.crmRecordId, t.practiceUserId)
      .where(sql`practice_user_id IS NOT NULL`),
    // The users FKs: removing a user finds its rows by these (partial: most rows have none).
    practiceUserIdx: index('seller_conversations_practice_user_idx').on(t.practiceUserId).where(sql`practice_user_id IS NOT NULL`),
    handlerUserIdx: index('seller_conversations_handler_user_idx').on(t.handlerUserId).where(sql`handler_user_id IS NOT NULL`),
  }),
);

/**
 * The timeline rows Sam and the team write (emails, hand-overs, status changes, flags; texts and human
 * touches later). Calls are not stored here: they are merged in from ai_calls at read time. org_id has no
 * FK (the conversation's cascade covers it). (FKs in SQL only: conversation → seller_conversations,
 * user → users.)
 */
export const conversationEvents = pgTable(
  'conversation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    kind: text('kind').$type<(typeof CONVERSATION_EVENT_KINDS)[number]>().notNull(),
    direction: text('direction').$type<(typeof CONVERSATION_EVENT_DIRECTIONS)[number]>().notNull(),
    actor: text('actor').$type<(typeof CONVERSATION_ACTORS)[number]>().notNull(),
    userId: uuid('user_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    subject: text('subject'),
    body: text('body'),
    detail: text('detail'),
    meta: jsonb('meta').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    /** The Salesforce Task log: 'pending' = the tick owes one; 'skipped' (the default) = nothing to log. */
    sfLogStatus: text('sf_log_status').$type<(typeof SF_LOG_STATUSES)[number]>().default('skipped').notNull(),
    sfTaskId: text('sf_task_id'),
    sfLogAttempts: integer('sf_log_attempts').default(0).notNull(),
    sfLogNextAt: timestamp('sf_log_next_at', { withTimezone: true }),
    sfLogError: text('sf_log_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    conversationIdx: index('conversation_events_conversation_idx').on(t.conversationId, t.occurredAt),
    sfLogDueIdx: index('conversation_events_sf_log_due_idx').on(t.sfLogNextAt).where(sql`sf_log_status = 'pending'`),
    // One Salesforce Task, one event (partial: most events have no Task).
    sfTaskUnique: uniqueIndex('conversation_events_sf_task_unique').on(t.orgId, t.sfTaskId).where(sql`sf_task_id IS NOT NULL`),
    // The users FK (partial: Sam's and the seller's events have no user).
    userIdx: index('conversation_events_user_idx').on(t.userId).where(sql`user_id IS NOT NULL`),
  }),
);

/**
 * The email outbox and inbox: one row per email, tied to its timeline event. (FKs in SQL only:
 * conversation → seller_conversations, event → conversation_events, touch → touches, requested_by → users.)
 */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    eventId: uuid('event_id').notNull(),
    direction: text('direction').$type<(typeof EMAIL_DIRECTIONS)[number]>().notNull(),
    status: text('status').$type<(typeof EMAIL_STATUSES)[number]>().notNull(),
    purpose: text('purpose').$type<(typeof EMAIL_PURPOSES)[number]>().notNull(),
    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address').notNull(),
    inReplyTo: text('in_reply_to'),
    references: text('references'),
    messageId: text('message_id'),
    resendId: text('resend_id'),
    sendAfter: timestamp('send_after', { withTimezone: true }),
    attempts: integer('attempts').default(0).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** When the tick first handed this email to Resend; NULL = never. Resend forgets the idempotency key 24 hours later. */
    firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true }),
    /** The last send error; for a canceled email, why it was not sent. */
    lastError: text('last_error'),
    /** When the inbound tick finished deciding on a reply. */
    handledAt: timestamp('handled_at', { withTimezone: true }),
    touchId: uuid('touch_id'),
    requestedBy: uuid('requested_by'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eventUnique: uniqueIndex('email_messages_event_unique').on(t.eventId),
    resendUnique: uniqueIndex('email_messages_resend_unique')
      .on(t.direction, t.resendId)
      .where(sql`resend_id IS NOT NULL`),
    messageIdIdx: index('email_messages_message_id_idx').on(t.messageId).where(sql`message_id IS NOT NULL`),
    dueIdx: index('email_messages_due_idx').on(t.sendAfter).where(sql`status = 'queued'`),
    conversationIdx: index('email_messages_conversation_idx').on(t.conversationId, t.createdAt),
    // The users FK (partial: only an email a person sent has one).
    requestedByIdx: index('email_messages_requested_by_idx').on(t.requestedBy).where(sql`requested_by IS NOT NULL`),
  }),
);

/**
 * Addresses Sam must never email again, per tenant; address is stored lowercased. (FKs in SQL only:
 * org → organizations, conversation → seller_conversations, SET NULL.)
 */
export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    orgId: uuid('org_id').notNull(),
    address: text('address').notNull(),
    reason: text('reason').$type<(typeof EMAIL_SUPPRESSION_REASONS)[number]>().notNull(),
    conversationId: uuid('conversation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ name: 'email_suppressions_org_address_pk', columns: [t.orgId, t.address] }),
  }),
);

/**
 * Resend (Svix) webhooks, stored once under their svix-id and processed by a tick. No FKs: the event is
 * received before it is matched to anything.
 */
export const resendWebhookEvents = pgTable(
  'resend_webhook_events',
  {
    svixId: text('svix_id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').$type<(typeof WEBHOOK_EVENT_STATUSES)[number]>().default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastError: text('last_error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => ({
    dueIdx: index('resend_webhook_events_due_idx').on(t.nextAttemptAt).where(sql`status = 'pending'`),
  }),
);

export type SellerConversationRow = typeof sellerConversations.$inferSelect;
export type ConversationEventRow = typeof conversationEvents.$inferSelect;
export type EmailMessageRow = typeof emailMessages.$inferSelect;
