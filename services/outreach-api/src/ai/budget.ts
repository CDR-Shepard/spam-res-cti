/**
 * Per-tenant daily AI spend, in micro-dollars, keyed by UTC day in `ai_usage_days`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import type { OutreachSettings } from '../settings.js';

const MICROS_PER_USD = 1_000_000;

/** `YYYY-MM-DD` of `now` in UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function spentTodayMicros(db: Db, orgId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ costMicros: schema.aiUsageDays.costMicros })
    .from(schema.aiUsageDays)
    .where(and(eq(schema.aiUsageDays.orgId, orgId), eq(schema.aiUsageDays.day, utcDay(now))));
  return row?.costMicros ?? 0;
}

/** Adds `micros` to today's total (one atomic upsert, safe under concurrent callers). */
export async function addSpend(db: Db, orgId: string, now: Date, micros: number): Promise<void> {
  if (!Number.isInteger(micros) || micros < 0) throw new Error(`invalid AI spend: ${micros}`);
  if (micros === 0) return;
  await db
    .insert(schema.aiUsageDays)
    .values({ orgId, day: utcDay(now), costMicros: micros })
    .onConflictDoUpdate({
      target: [schema.aiUsageDays.orgId, schema.aiUsageDays.day],
      set: { costMicros: sql.raw('ai_usage_days.cost_micros + excluded.cost_micros'), updatedAt: sql`now()` },
    });
}

export function budgetMicros(settings: OutreachSettings): number {
  return Math.round(settings.aiDailyBudgetUsd * MICROS_PER_USD);
}
