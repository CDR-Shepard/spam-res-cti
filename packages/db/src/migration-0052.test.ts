/**
 * 0052_ai_call_campaigns.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  CALL_PLAN_SOURCES,
  CALL_PLAN_STATUSES,
  CALL_STAGES,
  CAMPAIGN_MODES,
  callPlans,
  callResearch,
  campaignEnrollments,
  campaignSelections,
  campaigns,
  touches,
} from './schema-outreach.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0052_ai_call_campaigns.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);
const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const columnsOf = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).columns.map((c) => c.name);

describe('migration 0052_ai_call_campaigns', () => {
  it('starts with the lock_timeout guard (FKs lock organizations, users, campaigns, touches)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('adds campaigns.mode, default sequence, with a named CHECK of CAMPAIGN_MODES', () => {
    expect(statements).toContain(
      `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'sequence' CONSTRAINT "campaigns_mode_check" CHECK ("mode" IN (${quoted(CAMPAIGN_MODES)}))`,
    );
  });

  it('creates campaign_selections keyed by (campaign_id, sf_record_id)', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "campaign_selections"'));
    expect(create).toContain('CONSTRAINT "campaign_selections_pkey" PRIMARY KEY ("campaign_id", "sf_record_id")');
    expect(create).toContain('"campaign_id" uuid NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE');
  });

  it('adds the call stage columns to campaign_enrollments with a CHECK of CALL_STAGES', () => {
    const alter = statements.find((s) => s.startsWith('ALTER TABLE "campaign_enrollments"'));
    expect(alter).toContain(`ADD COLUMN IF NOT EXISTS "call_stage" text CONSTRAINT "campaign_enrollments_call_stage_check" CHECK ("call_stage" IN (${quoted(CALL_STAGES)}))`);
    expect(alter).toContain('ADD COLUMN IF NOT EXISTS "call_prepare_attempted_at" timestamptz');
    expect(alter).toContain('ADD COLUMN IF NOT EXISTS "call_prepare_error" text');
  });

  it('versions research and plans per enrollment, and allows one current plan', () => {
    expect(statements).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "call_research_enrollment_version_unique" ON "call_research" ("enrollment_id", "version")');
    expect(statements).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "call_plans_enrollment_version_unique" ON "call_plans" ("enrollment_id", "version")');
    expect(statements).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "call_plans_current_unique" ON "call_plans" ("enrollment_id") WHERE "status" IN ('proposed', 'approved')`,
    );
    const plans = statements.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "call_plans"'))!;
    expect(plans).toContain(`CONSTRAINT "call_plans_status_check" CHECK ("status" IN (${quoted(CALL_PLAN_STATUSES)}))`);
    expect(plans).toContain(`CONSTRAINT "call_plans_source_check" CHECK ("source" IN (${quoted(CALL_PLAN_SOURCES)}))`);
  });

  it('adds the AI call columns to touches; ai_call_id references ai_calls (0050)', () => {
    const alter = statements.find((s) => s.startsWith('ALTER TABLE "touches"'))!;
    for (const col of [
      'ADD COLUMN IF NOT EXISTS "ai_call_id" uuid REFERENCES "ai_calls"("id") ON DELETE SET NULL',
      'ADD COLUMN IF NOT EXISTS "call_plan_id" uuid REFERENCES "call_plans"("id") ON DELETE SET NULL',
      'ADD COLUMN IF NOT EXISTS "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL',
      'ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0',
      'ADD COLUMN IF NOT EXISTS "trigger_key" text',
      'ADD COLUMN IF NOT EXISTS "last_block_reason" text',
    ]) expect(alter).toContain(col);
    expect(statements).toContain('CREATE INDEX IF NOT EXISTS "touches_ai_call_idx" ON "touches" ("ai_call_id") WHERE "ai_call_id" IS NOT NULL');
  });

  it('Drizzle mirrors the new columns and tables', () => {
    expect(columnsOf(campaigns)).toContain('mode');
    expect(columnsOf(campaignEnrollments)).toEqual(expect.arrayContaining(['call_stage', 'call_prepare_attempted_at', 'call_prepare_error']));
    expect(columnsOf(touches)).toEqual(expect.arrayContaining(['ai_call_id', 'call_plan_id', 'requested_by', 'attempts', 'trigger_key', 'last_block_reason']));
    expect(columnsOf(campaignSelections)).toEqual(['campaign_id', 'org_id', 'sf_record_id', 'selected_by', 'selected_at']);
    expect(columnsOf(callResearch)).toEqual(['id', 'org_id', 'enrollment_id', 'crm_record_id', 'version', 'snapshot', 'sources', 'size_chars', 'content_hash', 'created_at']);
    expect(columnsOf(callPlans)).toEqual([
      'id', 'org_id', 'enrollment_id', 'research_id', 'version', 'status', 'source', 'model', 'plan', 'dnc_flagged',
      'input_tokens', 'output_tokens', 'created_by', 'decided_by', 'decided_at', 'created_at',
    ]);
    for (const t of [campaignSelections, callResearch, callPlans]) expect(getTableConfig(t).foreignKeys).toHaveLength(0);
  });
});
