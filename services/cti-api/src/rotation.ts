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
import { regionForAreaCode, timezoneForAreaCode } from './firewall/tz.js';

type Db = ReturnType<typeof getDb>;

/** 3-digit area code of a +1 NANP number, or null. */
function npaOf(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const m = /^\+1(\d{3})\d{7}$/.exec(e164);
  return m ? m[1]! : null;
}

/**
 * Local-presence rank of a candidate DID against the number being dialed —
 * lower is better:
 *   0 exact area code (619 → 619): the firewall's local-presence bonus
 *   1 same metro (619 → 858, both San Diego)
 *   2 same timezone
 *   3 anything else / callee area unknown
 */
function localPresenceTier(didNpa: string | null, calleeNpa: string | null): number {
  if (!calleeNpa || !didNpa) return 3;
  if (didNpa === calleeNpa) return 0;
  const dr = regionForAreaCode(didNpa);
  const cr = regionForAreaCode(calleeNpa);
  if (dr && cr && dr === cr) return 1;
  const dt = timezoneForAreaCode(didNpa)?.timezone;
  const ct = timezoneForAreaCode(calleeNpa)?.timezone;
  if (dt && ct && dt === ct) return 2;
  return 3;
}

/**
 * @param toE164 the number being dialed; when provided, rotation prefers a DID
 *   whose area code matches the callee's (local presence) before falling back
 *   to load-balancing across the rest of the pool.
 */
export async function pickRotationNumber(
  db: Db,
  orgId: string,
  userId: string,
  toE164?: string,
): Promise<string | null> {
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
  const calleeNpa = npaOf(toE164);
  const eligible = pool
    .filter((n) => n.health !== 'spam_likely' && n.health !== 'degraded')
    .map((n) => {
      const dialsToday = n.dialsTodayDate === today ? n.dialsToday : 0;
      const daysSince = n.firstUsedAt
        ? Math.floor((Date.now() - n.firstUsedAt.getTime()) / 86_400_000)
        : null;
      const cap = n.warmupOverrideCap ?? warmupCapForAge(daysSince).cap;
      return { n, room: cap - dialsToday, tier: localPresenceTier(npaOf(n.e164), calleeNpa) };
    })
    .filter((x) => x.room > 0)
    .sort((a, b) => {
      // Local-presence match first, then largest remaining room, then LRU. This
      // keeps warmup balancing WITHIN the matched-area group — e.g. it spreads
      // load across the rep's 619 numbers before reaching for an 858 or LA one.
      if (a.tier !== b.tier) return a.tier - b.tier;
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
