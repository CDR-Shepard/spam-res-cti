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
 *   - an added `kind = 'dialer_pool'` filter, so this path can never burn a
 *     rep's own `agent`-kind DID even if a stale/misrouted sticky row somehow
 *     pointed at one.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { schema } from '../db/index.js';
import { warmupCapForAge } from '../firewall/warmup.js';
import { timezoneForNumber } from '../firewall/tz.js';
import { dialerPoolNumbers as realDialerPoolNumbers } from './pool.js';

export type Db = ReturnType<typeof getDb>;
type OutboundNumber = typeof schema.outboundNumbers.$inferSelect;

/**
 * THE recipient-local calling window, for the whole system: dialing is allowed
 * while the local hour is in [8, 20] — 08:00:00 through 20:59:59, i.e. 8:00am
 * through 8:59pm. That sits inside the federal TCPA bound of 8am–9pm with a
 * one-minute margin at the top.
 *
 * ONE definition, two enforcement sites. The dialer's coarse pre-filter
 * (`withinCallingHours` below) and the firewall's authoritative click-to-dial
 * gate (`firewall/index.ts` gate 6) used to carry independent literals — 8am–9pm
 * here, 8am–8pm there — so a call the firewall would BLOCK at 8:10pm local
 * could still be attempted by the power dialer at that same instant, with
 * nothing keeping the two from drifting further (spam-defense audit §5, gap 1).
 * The firewall now imports these constants as the outer bound its campaign
 * window is clamped to, so neither site can move without the other.
 *
 * A campaign row may still NARROW the window (org business preference); it can
 * no longer widen it past this pair.
 */
export const CALLING_HOUR_START = 8;
export const CALLING_HOUR_END_INCLUSIVE = 20;

/** The same window as the `HH:MM` strings `campaign_configs` stores. The end is
 *  the EXCLUSIVE bound the firewall's minute comparator wants, so the whole of
 *  hour `CALLING_HOUR_END_INCLUSIVE` (through :59) is inside it — exactly what
 *  `withinCallingHours` allows. */
const hhmm = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;
export const CALLING_HOURS_START_HHMM = hhmm(CALLING_HOUR_START);
export const CALLING_HOURS_END_HHMM_EXCLUSIVE = hhmm(CALLING_HOUR_END_INCLUSIVE + 1);

/**
 * PURE: is `nowUtc` within the recipient-local calling window for `toE164`?
 * This is the dialer's coarse per-lead pre-filter — the firewall's per-call
 * gate remains authoritative for click-to-dial; both now share the window
 * constants above.
 *
 * Timezone is inferred from the dialed number's NANP area code. An unknown
 * timezone (non-NANP, toll-free, or otherwise unmapped) FAILS OPEN (true) —
 * the firewall already gates the actual click-to-dial per-call, so the
 * dialer's pre-filter erring toward "attempt it" (rather than silently
 * starving leads with unrecognized area codes out of the queue) is the safer
 * default here.
 */
export function withinCallingHours(toE164: string, nowUtc: Date): boolean {
  const tz = timezoneForNumber(toE164)?.timezone;
  if (!tz) return true;
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(nowUtc),
  );
  return hour >= CALLING_HOUR_START && hour <= CALLING_HOUR_END_INCLUSIVE;
}

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
 * `'agent'`, so neither path can ever burn a number of the other kind.
 */
export async function attemptIncrement(
  db: Db,
  orgId: string,
  e164: string,
  effectiveCap: number,
  kind: 'agent' | 'dialer_pool' = 'dialer_pool',
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
}

export interface PickPoolDidDeps {
  /** Injectable for tests; defaults to the real dialer/pool.js implementation. */
  dialerPoolNumbers?: (orgId: string) => Promise<OutboundNumber[]>;
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
  { orgId, userId, toE164 }: PickPoolDidArgs,
  deps: PickPoolDidDeps = {},
): Promise<{ e164: string } | null> {
  const listPoolNumbers = deps.dialerPoolNumbers ?? realDialerPoolNumbers;

  const stickyRows = await db
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
  const stickyE164 = stickyRows[0]?.e164;

  if (stickyE164) {
    // Re-read the sticky candidate to (a) confirm it's still an active
    // dialer_pool DID and (b) get firstUsedAt/warmupOverrideCap to compute
    // its current cap — mirrors calls.ts reading `did` before the atomic
    // increment. Undefined here means "no longer an active dialer_pool
    // number" (reassigned, deactivated, or a stale sticky row); fall through
    // to the pool rather than treating it as eligible.
    const sticky = await db.query.outboundNumbers.findFirst({
      where: and(
        eq(schema.outboundNumbers.orgId, orgId),
        eq(schema.outboundNumbers.e164, stickyE164),
        eq(schema.outboundNumbers.active, true),
        eq(schema.outboundNumbers.kind, 'dialer_pool'),
      ),
    });
    if (sticky) {
      const ok = await attemptIncrement(db, orgId, sticky.e164, effectiveCapFor(sticky));
      if (ok) return { e164: sticky.e164 };
    }
  }

  const pool = await listPoolNumbers(orgId);
  for (const n of pool) {
    const ok = await attemptIncrement(db, orgId, n.e164, effectiveCapFor(n));
    if (ok) return { e164: n.e164 };
  }
  return null;
}
