/**
 * The test-phones list added by migration 0061_inbound_agent_testing.sql.
 *
 * Re-exported from schema-outreach.ts (which schema.ts re-exports), so
 * `schema.aiTestPhones` reaches every service through `@cti/db`.
 *
 * Same rule as schema-outreach.ts: this file imports NOTHING from schema.ts, so
 * the foreign keys live in the SQL migration only (org → organizations,
 * added_by → users). The unique (org_id, e164) is declared here too so a caller
 * can name it as an `onConflictDoNothing` target.
 */
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * A phone an admin allows to get the AI phone agent when it calls one of the
 * agent's numbers (and to get outbound test calls). Strict E.164, unique per org;
 * at most contracts TEST_PHONES_MAX per org (enforced by outreach-api).
 */
export const aiTestPhones = pgTable(
  'ai_test_phones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    e164: text('e164').notNull(),
    /** Who the phone belongs to, in the admin's words; '' = none. */
    label: text('label').default('').notNull(),
    addedBy: uuid('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgE164Unique: unique('ai_test_phones_org_e164_unique').on(t.orgId, t.e164),
  }),
);

export type AiTestPhoneRow = typeof aiTestPhones.$inferSelect;
