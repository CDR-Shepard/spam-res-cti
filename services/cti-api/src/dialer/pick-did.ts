/**
 * Dialer-pool DID selection — chooses the outbound caller ID the power dialer
 * uses for a given (rep, recipient) dial:
 *
 *  1. Sticky-for-(user,lead): if this rep has a sticky pool DID for this
 *     recipient and it's still an active, eligible `dialer_pool` number,
 *     reuse it (same answer-rate/reputation rationale as the click-to-dial
 *     sticky in routes/calls.ts).
 *  2. Otherwise, walk the org's dialer-pool DIDs in order and take the first
 *     one whose atomic warmup+velocity increment succeeds.
 *
 * The eligibility + increment is the EXACT shape POST /calls uses for the
 * rep's own assigned DID (routes/calls.ts): re-check active/health/warmup
 * cap/velocity inside the same conditional UPDATE ... RETURNING so concurrent
 * dials against the same pool DID can't race past its cap (TOCTOU-safe).
 * Two differences from that shape, both intentional:
 *   - no `assignedUserId` filter: pool DIDs are shared across the org's reps,
 *     not owned by one rep, so calls.ts's per-rep ownership check doesn't
 *     apply here.
 *   - an added `kind` filter (`dialer_pool` by default), so this path can
 *     never burn a rep's own `agent`-kind DID even if a stale/misrouted sticky
 *     row somehow pointed at one.
 *
 * The AI voice agent walks its OWN pool through the same machinery by passing
 * `kind: 'ai_pool'` (ai-voice/number-pool.ts): every read and claim below is
 * pinned to the caller's kind, so the dialer can never pick an AI number and
 * the AI can never pick a rep's or the dialer's.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { getDb, NumberKind } from '@cti/db';
import { schema } from '@cti/db';
import {
  CALLING_HOUR_END_INCLUSIVE,
  CALLING_HOUR_START,
  CALLING_HOURS_END_HHMM_EXCLUSIVE,
  CALLING_HOURS_START_HHMM,
  warmupCapForAge,
} from '@cti/firewall';
import { dialerPoolNumbers as realDialerPoolNumbers, type PoolKind } from './pool.js';

// The system calling window lives in @cti/firewall (calling-window.ts) so the
// firewall gate and this pre-filter cannot drift. Re-exported here so the
// dialer's callers and the drift interlock test keep one import site.
export { CALLING_HOUR_END_INCLUSIVE, CALLING_HOUR_START, CALLING_HOURS_END_HHMM_EXCLUSIVE, CALLING_HOURS_START_HHMM };

// The dialer's recipient-local calling-hours pre-filter lives in @cti/firewall
// (recipient-window.ts) so the outreach planner and this dialer share one rule.
// Re-exported so live-deps.ts and the tests keep this import site.
export { withinCallingHours } from '@cti/firewall';

export type Db = ReturnType<typeof getDb>;
type OutboundNumber = typeof schema.outboundNumbers.$inferSelect;

/**
 * Parse the DIALER_CALLING_HOURS_EXEMPT allowlist (comma-separated E.164) into a
 * Set. Numbers in it skip the calling-hours guard entirely — for OWNED test DIDs
 * only. Empty/undefined → an empty Set (no exemptions).
 */
export function parseCallingHoursExempt(csv: string | undefined): Set<string> {
  if (!csv) return new Set();
  return new Set(csv.split(',').map((s) => s.trim()).filter(Boolean));
}

/** This number's daily dial cap right now: an explicit override, else its warmup-age cap. */
export function effectiveCapFor(n: Pick<OutboundNumber, 'firstUsedAt' | 'warmupOverrideCap'>): number {
  const daysSince = n.firstUsedAt ? Math.floor((Date.now() - n.firstUsedAt.getTime()) / 86_400_000) : null;
  return n.warmupOverrideCap ?? warmupCapForAge(daysSince).cap;
}

/**
 * Atomically claim one dial against `e164`'s daily warmup cap + 10/min
 * velocity limit — identical eligibility+increment shape to routes/calls.ts's
 * warmup gate (see file header for the two deliberate deltas). Returns
 * whether the claim landed (false = 0 rows updated = not eligible right now).
 *
 * `kind` pins which sort of number may be claimed and defaults to the pool
 * dialer's own `dialer_pool`; Task runs dial the rep's OWN numbers and pass
 * `'agent'`, the AI voice agent passes `'ai_pool'`, so no path can ever burn a
 * number of another kind.
 */
export async function attemptIncrement(
  db: Db,
  orgId: string,
  e164: string,
  effectiveCap: number,
  kind: NumberKind = 'dialer_pool',
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const incremented = await db
    .update(schema.outboundNumbers)
    .set({
      firstUsedAt: sql`coalesce(${schema.outboundNumbers.firstUsedAt}, now())`,
      lastDialAt: new Date(),
      dialsTodayDate: today,
      dialsToday: sql`case when ${schema.outboundNumbers.dialsTodayDate} = ${today}::date then ${schema.outboundNumbers.dialsToday} + 1 else 1 end`,
      lastMinuteDialCount: sql`case when ${schema.outboundNumbers.lastMinuteWindowStart} is null or now() - ${schema.outboundNumbers.lastMinuteWindowStart} > interval '1 minute' then 1 else ${schema.outboundNumbers.lastMinuteDialCount} + 1 end`,
      lastMinuteWindowStart: sql`case when ${schema.outboundNumbers.lastMinuteWindowStart} is null or now() - ${schema.outboundNumbers.lastMinuteWindowStart} > interval '1 minute' then now() else ${schema.outboundNumbers.lastMinuteWindowStart} end`,
    })
    .where(
      and(
        eq(schema.outboundNumbers.orgId, orgId),
        eq(schema.outboundNumbers.e164, e164),
        eq(schema.outboundNumbers.active, true),
        eq(schema.outboundNumbers.kind, kind),
        notInArray(schema.outboundNumbers.health, ['spam_likely', 'degraded']),
        sql`(case when ${schema.outboundNumbers.dialsTodayDate} = ${today}::date then ${schema.outboundNumbers.dialsToday} else 0 end) < ${effectiveCap}`,
        sql`(case when ${schema.outboundNumbers.lastMinuteWindowStart} is null or now() - ${schema.outboundNumbers.lastMinuteWindowStart} > interval '1 minute' then 0 else ${schema.outboundNumbers.lastMinuteDialCount} end) < 10`,
      ),
    )
    .returning({ id: schema.outboundNumbers.id });
  return incremented.length > 0;
}

export interface PickPoolDidArgs {
  orgId: string;
  userId: string;
  toE164: string;
  /** Which pool to walk; `dialer_pool` (the power dialer) unless the AI says `ai_pool`. */
  kind?: PoolKind;
}

export interface PickPoolDidDeps {
  /** Injectable for tests; defaults to the real dialer/pool.js implementation. */
  dialerPoolNumbers?: (orgId: string, kind: PoolKind) => Promise<OutboundNumber[]>;
  /**
   * The sticky candidate for this recipient, replacing the `sticky_numbers`
   * read. The AI passes its own (the number its last call to them came from):
   * `sticky_numbers` is keyed (org, rep, recipient) and belongs to the rep's
   * dialing, so the AI never writes it. Whatever this returns is still
   * re-read with this call's `kind` before it can be claimed.
   */
  stickyE164?: () => Promise<string | undefined>;
}

/** The rep's `sticky_numbers` row for this recipient — the power dialer's sticky source. */
async function repStickyE164(db: Db, orgId: string, userId: string, toE164: string): Promise<string | undefined> {
  const rows = await db
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
  return rows[0]?.e164;
}

/**
 * Select the outbound DID for a power-dialer dial to `toE164`: the rep's
 * sticky DID for this recipient if it's still eligible, else the first
 * eligible DID in the org's dialer pool. Returns null when nothing is
 * eligible (fail-closed — the caller must not fall back to an unvetted
 * number).
 */
export async function pickPoolDid(
  db: Db,
  { orgId, userId, toE164, kind = 'dialer_pool' }: PickPoolDidArgs,
  deps: PickPoolDidDeps = {},
): Promise<{ e164: string } | null> {
  const listPoolNumbers = deps.dialerPoolNumbers ?? realDialerPoolNumbers;
  const stickyE164 = deps.stickyE164 ? await deps.stickyE164() : await repStickyE164(db, orgId, userId, toE164);

  if (stickyE164) {
    // Re-read the sticky candidate to (a) confirm it's still an active DID of
    // THIS pool's kind and (b) get firstUsedAt/warmupOverrideCap to compute
    // its current cap — mirrors calls.ts reading `did` before the atomic
    // increment. Undefined here means "not an active number of this kind"
    // (reassigned, deactivated, a stale sticky row, or a sticky that points
    // at another kind's number); fall through to the pool rather than
    // treating it as eligible.
    const sticky = await db.query.outboundNumbers.findFirst({
      where: and(
        eq(schema.outboundNumbers.orgId, orgId),
        eq(schema.outboundNumbers.e164, stickyE164),
        eq(schema.outboundNumbers.active, true),
        eq(schema.outboundNumbers.kind, kind),
      ),
    });
    if (sticky) {
      const ok = await attemptIncrement(db, orgId, sticky.e164, effectiveCapFor(sticky), kind);
      if (ok) return { e164: sticky.e164 };
    }
  }

  const pool = await listPoolNumbers(orgId, kind);
  for (const n of pool) {
    const ok = await attemptIncrement(db, orgId, n.e164, effectiveCapFor(n), kind);
    if (ok) return { e164: n.e164 };
  }
  return null;
}
