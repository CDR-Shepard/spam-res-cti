/**
 * Number rotation — pick the least-loaded, least-recently-used active
 * healthy DID from the org pool that still has warmup headroom today.
 *
 * Used by BOTH the firewall (preflight prediction) and POST /calls (actual
 * selection) so the per-DID gates a rep sees in the verdict are evaluated
 * against the same number that will carry the call.
 */
import { and, eq } from 'drizzle-orm';
import type { getDb } from './db/index.js';
import { schema } from './db/index.js';
import { warmupCapForAge } from './firewall/warmup.js';

type Db = ReturnType<typeof getDb>;

export async function pickRotationNumber(db: Db, orgId: string, userId: string): Promise<string | null> {
  // Only the calling rep's ASSIGNED pool is dialable. Unassigned numbers are
  // the shared reserve, held back until an admin assigns them.
  const pool = await db
    .select()
    .from(schema.outboundNumbers)
    .where(
      and(
        eq(schema.outboundNumbers.orgId, orgId),
        eq(schema.outboundNumbers.active, true),
        eq(schema.outboundNumbers.assignedUserId, userId),
      ),
    );
  const today = new Date().toISOString().slice(0, 10);
  const eligible = pool
    .filter((n) => n.health !== 'spam_likely' && n.health !== 'degraded')
    .map((n) => {
      const dialsToday = n.dialsTodayDate === today ? n.dialsToday : 0;
      const daysSince = n.firstUsedAt
        ? Math.floor((Date.now() - n.firstUsedAt.getTime()) / 86_400_000)
        : null;
      const cap = n.warmupOverrideCap ?? warmupCapForAge(daysSince).cap;
      return { n, room: cap - dialsToday };
    })
    .filter((x) => x.room > 0)
    .sort((a, b) => {
      // Largest remaining room first, then oldest last-dial-at (LRU).
      if (b.room !== a.room) return b.room - a.room;
      const aT = a.n.lastDialAt?.getTime() ?? 0;
      const bT = b.n.lastDialAt?.getTime() ?? 0;
      return aT - bT;
    });
  // Fail CLOSED: if no DID is healthy AND under its warmup cap today, return
  // null so the caller surfaces "pool exhausted" instead of silently dialing an
  // unvetted, over-cap, or unhealthy number. Falling back to a default caller
  // ID here would defeat the warmup/rotation reputation defense — exactly the
  // number we must NOT burn is the one we'd reach for when the pool is tapped.
  return eligible[0]?.n.e164 ?? null;
}
