/**
 * Per-DID window-stats query, shared by the real-time firewall gate and the
 * periodic auto-pause worker so both judge a DID on identical numbers.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { schema } from '../db/index.js';
import type { DidWindowStats } from './signals.js';

type Db = ReturnType<typeof getDb>;

/** Dials, connected count, and avg connected duration for a DID since `since`. */
export async function fetchDidWindowStats(
  db: Db,
  orgId: string,
  e164: string,
  since: Date,
): Promise<DidWindowStats> {
  const rows = await db
    .select({
      dials: sql<number>`count(*)::int`,
      connected: sql<number>`count(*) filter (where ${schema.calls.answeredAt} is not null or coalesce(${schema.calls.durationSeconds}, 0) > 0)::int`,
      avgDur: sql<number | null>`avg(${schema.calls.durationSeconds}) filter (where coalesce(${schema.calls.durationSeconds}, 0) > 0)`,
    })
    .from(schema.calls)
    .where(
      and(
        eq(schema.calls.orgId, orgId),
        eq(schema.calls.fromNumber, e164),
        gte(schema.calls.createdAt, since),
      ),
    );
  const r = rows[0];
  return {
    dials: r?.dials ?? 0,
    connected: r?.connected ?? 0,
    avgConnectedDuration: r?.avgDur != null ? Number(r.avgDur) : null,
  };
}
