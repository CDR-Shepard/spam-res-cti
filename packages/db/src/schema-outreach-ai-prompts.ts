/**
 * Admin-editable agent prompts added by migration 0060_ai_agent_prompts.sql (the 'inbound' kind: 0061).
 *
 * Re-exported from schema-outreach.ts (which schema.ts re-exports), so
 * `schema.aiAgentPrompts` reaches every service through `@cti/db`.
 *
 * Same rule as schema-outreach.ts: this file imports NOTHING from schema.ts, so
 * foreign keys and the CHECK constraint live in the SQL migration only; the
 * `*_KINDS` constant is the CHECK's exact value list, pinned by migration-0061.test.ts.
 */
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** ai_agent_prompts.kind (CHECK, widened by 0061); the same three values as @cti/contracts AgentPromptKind. */
export const AI_AGENT_PROMPT_KINDS = ['instructions', 'voicemail', 'inbound'] as const;

/**
 * One saved version of an org's AI phone agent instructions or voicemail message.
 * Append-only: the active version is the newest created_at per (org_id, kind), and
 * body NULL means "the built-in default"
 * (FKs in SQL only: org → organizations, created_by → users).
 */
export const aiAgentPrompts = pgTable(
  'ai_agent_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    kind: text('kind').$type<(typeof AI_AGENT_PROMPT_KINDS)[number]>().notNull(),
    /** The template text; NULL = use the built-in default. */
    body: text('body'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    activeIdx: index('ai_agent_prompts_active_idx').on(t.orgId, t.kind, sql`${t.createdAt} desc`),
  }),
);

export type AiAgentPromptRow = typeof aiAgentPrompts.$inferSelect;
