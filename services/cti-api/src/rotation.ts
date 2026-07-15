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
 * Per-customer attempt state, computed once by the caller (the firewall) and
 * passed in so rotation stays a pure ranking over the pool (no extra query).
 */
export interface AttemptCaps {
  /** from_number -> #calls that number has made to THIS customer in the window. */
  attemptsByNumber?: Map<string, number>;
  /** Per-number budget to one customer; a number at/over it is "exhausted" for
   *  this customer and gets deprioritized so rotation swaps to a fresh one. */
  maxAttemptsPerNumber?: number;
}

/**
 * @param toE164 the number being dialed; when provided, rotation prefers a DID
 *   whose area code matches the callee's (local presence) before falling back
 *   to load-balancing across the rest of the pool.
 * @param caps per-customer attempt state; when provided, a number that has hit
 *   its per-customer budget is ranked last (and can't be the sticky pick), so
 *   rotation swaps to another of the rep's numbers for that customer.
 */
export async function pickRotationNumber(
  db: Db,
  orgId: string,
  userId: string,
  toE164?: string,
  caps?: AttemptCaps,
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
      const custAttempts = caps?.attemptsByNumber?.get(n.e164) ?? 0;
      const exhausted =
        caps?.maxAttemptsPerNumber != null && custAttempts >= caps.maxAttemptsPerNumber;
      return {
        n,
        room: cap - dialsToday,
        tier: localPresenceTier(npaOf(n.e164), calleeNpa),
        exhausted,
      };
    })
    .filter((x) => x.room > 0)
    .sort((a, b) => {
      // A number that's hit its per-customer budget ranks last, so rotation
      // swaps to a fresh number for this customer before reusing an exhausted
      // one. Then: local-presence match, largest remaining warmup room, LRU.
      if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1;
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (b.room !== a.room) return b.room - a.room;
      const aT = a.n.lastDialAt?.getTime() ?? 0;
      const bT = b.n.lastDialAt?.getTime() ?? 0;
      return aT - bT;
    });
  // Sticky caller ID: if THIS rep called this lead before from a DID they STILL
  // own and can dial today, reuse it so the lead keeps seeing the same number.
  // The `eligible.some(...)` membership check is the sole safety authority — the
  // sticky DID is only ever returned when it's already in this rep's eligible
  // dial-today set (active, healthy, assigned to them, under warmup cap), so it
  // can never bypass a gate. Silently falls back to area-match otherwise.
  if (toE164 && eligible.length > 0) {
    const sticky = await db
      .select({ e164: schema.stickyNumbers.e164 })
      .from(schema.stickyNumbers)
      .where(
        and(
          eq(schema.stickyNumbers.orgId, orgId),
          eq(schema.stickyNumbers.assignedUserId, userId),
          eq(schema.stickyNumbers.recipientE164, toE164),
        ),
      )
      .limit(1);
    const stickyE164 = sticky[0]?.e164;
    // Reuse the sticky DID only while it's still under its per-customer budget;
    // once exhausted for this customer, yield to the swap (fall through).
    if (stickyE164 && eligible.some((x) => x.n.e164 === stickyE164 && !x.exhausted)) {
      return stickyE164;
    }
  }
  // Fail CLOSED: if no DID is healthy AND under its warmup cap today, return
  // null so the caller surfaces "pool exhausted" instead of silently dialing an
  // unvetted, over-cap, or unhealthy number. Falling back to a default caller
  // ID here would defeat the warmup/rotation reputation defense — exactly the
  // number we must NOT burn is the one we'd reach for when the pool is tapped.
  return eligible[0]?.n.e164 ?? null;
}
