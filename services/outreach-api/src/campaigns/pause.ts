/**
 * Automatic campaign pauses. The system pauses every running (`dry_run` or `active`)
 * campaign of a tenant when its Salesforce connection breaks (`crm_broken`, A8) or its
 * daily AI budget is spent (`ai_budget`, A9). `paused_from` remembers which state each
 * campaign was in, so a resume (B7 for `ai_budget`, a reconnect for `crm_broken`) can put
 * a dry-run campaign back in dry run instead of making it live.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';

export type AutoPauseReason = 'crm_broken' | 'ai_budget';
export const RUNNING_CAMPAIGN_STATUSES = ['dry_run', 'active'] as const;

/** Returns the number of campaigns paused (0 when none was running). */
export async function pauseOrgCampaigns(db: Db, orgId: string, reason: AutoPauseReason): Promise<number> {
  const rows = await db
    .update(schema.campaigns)
    // `status` on the right-hand side is the value before this UPDATE.
    .set({ status: 'paused', pauseReason: reason, pausedFrom: sql.raw('status'), updatedAt: sql`now()` })
    .where(and(eq(schema.campaigns.orgId, orgId), inArray(schema.campaigns.status, [...RUNNING_CAMPAIGN_STATUSES])))
    .returning({ id: schema.campaigns.id });
  return rows.length;
}
