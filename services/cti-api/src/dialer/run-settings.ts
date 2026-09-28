/**
 * Power Dial run settings, server side (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md).
 *
 * The rep chooses on Ready to dial — AFTER the queue was built — and the
 * choices arrive with Start dialing, so everything here runs inside the
 * ready → active claim (engine.ts `claimReadySession`): the settings land on
 * the session in the flip's own UPDATE, the queue is cut to the run size, and
 * the rep's choices are saved as their next defaults. One transaction, so a
 * refused Start (the rep's other run holds the one-active-run slot) changes
 * nothing.
 *
 * Every write is a builder returned unawaited, so its rendered SQL is pinned
 * in run-settings.test.ts.
 */
import { and, eq, gt } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { toRolloverBusinessDays, type DialerRunSettings, type RolloverBusinessDays } from '@cti/contracts';
import { BUILD_SKIP_OUTCOMES } from './create-session.js';
import type { DialerItem } from './session-store.js';

/**
 * The ordinal of the last row a run of `maxRecords` people keeps: the
 * `maxRecords`-th PENDING row in queue order. The queue order is already the
 * list's rotated order (create-session.ts), so this is "the next N people from
 * where the list stands". Rows the build already settled — no number, Skip on
 * Dialer, consent, called in the last 3 h — are not people this run will dial,
 * so they do not count toward N; the ones in front of the cutoff stay so the
 * run still reports them. Null = keep every row: no limit, or no more
 * dialable rows than the limit.
 */
export function runSizeCutoff(
  items: ReadonlyArray<Pick<DialerItem, 'ordinal' | 'status'>>,
  maxRecords: number | null,
): number | null {
  if (maxRecords === null) return null;
  const pending = items.filter((i) => i.status === 'pending').map((i) => i.ordinal).sort((a, b) => a - b);
  if (pending.length <= maxRecords) return null;
  return pending[maxRecords - 1] ?? null;
}

/**
 * The ready → active compare-and-swap, carrying the run's settings when the
 * Start sent them. `runSize` (review M1) — min(maxRecords, pending rows),
 * computed by the caller from a queue read taken BEFORE this same claim —
 * rides in the SAME update as the other three settings; omitted (null) for a
 * settings-less Start (nothing written) or an unlimited one (written as
 * explicit NULL, same as `maxRecords`). Returns the rep's id so the defaults
 * can be saved in the same transaction without another read.
 */
export function claimReadySessionQuery(
  db: Pick<Db, 'update'>,
  sessionId: string,
  settings: DialerRunSettings | null,
  now: Date,
  runSize: number | null = null,
) {
  const s = schema.dialerSessions;
  return db
    .update(s)
    .set({
      status: 'active',
      updatedAt: now,
      ...(settings
        ? { passes: settings.passes, maxRecords: settings.maxRecords, rolloverBusinessDays: settings.rolloverBusinessDays, runSize }
        : {}),
    })
    .where(and(eq(s.id, sessionId), eq(s.status, 'ready')))
    .returning({ id: s.id, userId: s.userId });
}

/** Drop every row of this run past the run size (the cutoff row itself stays). */
export function trimQueueQuery(db: Pick<Db, 'delete'>, sessionId: string, cutoffOrdinal: number) {
  const i = schema.dialerQueueItems;
  return db.delete(i).where(and(eq(i.sessionId, sessionId), gt(i.ordinal, cutoffOrdinal)));
}

/** The rep's next defaults — all three: Calls per person, How many
 *  (controller ruling S2), and Missed tasks. */
export function saveRunDefaultsQuery(db: Pick<Db, 'update'>, userId: string, settings: DialerRunSettings) {
  return db
    .update(schema.users)
    .set({
      dialerPasses: settings.passes,
      dialerMaxRecords: settings.maxRecords,
      dialerRolloverBusinessDays: settings.rolloverBusinessDays,
    })
    .where(eq(schema.users.id, userId));
}

export function savedRolloverBusinessDaysQuery(db: Pick<Db, 'select'>, userId: string) {
  return db
    .select({ businessDays: schema.users.dialerRolloverBusinessDays })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
}

/** The rep's saved "Missed tasks move to" — what a click-to-dial rollover lands
 *  by. A missing row is today's rule (next business day). */
export async function savedRolloverBusinessDays(db: Pick<Db, 'select'>, userId: string): Promise<RolloverBusinessDays> {
  const [row] = await savedRolloverBusinessDaysQuery(db, userId);
  return toRolloverBusinessDays(row?.businessDays);
}

/**
 * Did this row settle BEFORE any dial was ever attempted on it (review M1) —
 * no phone number (`unreachable`), or skipped for a BUILD-time reason
 * (consent, the rep's own Skip on Dialer checkbox, already worked today —
 * `BUILD_SKIP_OUTCOMES`, create-session.ts)? Those never had a chance to be
 * one of this run's `runSize` dialable people.
 *
 * A RUNTIME skip — the cadence gate's 'cooldown'/'daily_cap', or a
 * take-callback cancel's 'canceled' — is NOT a build settle: it transitioned
 * FROM 'pending', so the person WAS one of the people this run set out to
 * dial. An appended row (`attempt !== 1`, an end-of-run retry; or `redialOf`
 * set, a rep-requested redial) is never a build settle either — it did not
 * exist at build to have settled then.
 */
export function settledAtBuild(
  item: Pick<DialerItem, 'status' | 'outcome' | 'attempt' | 'redialOf'>,
): boolean {
  if (item.attempt !== 1 || item.redialOf != null) return false;
  if (item.status === 'unreachable') return true;
  return item.status === 'skipped' && item.outcome != null && BUILD_SKIP_OUTCOMES.has(item.outcome);
}

/**
 * The 1-based rank of `currentOrdinal` among this run's DIALABLE rows —
 * everyone with `ordinal <= currentOrdinal` who did NOT settle at build
 * (`settledAtBuild`). Null for an unlimited run (`runSize` null): "record X
 * of N" only makes sense once N is capped — an unlimited run's total already
 * counts every row, settled or not (routes/dialer.ts `firstPassTotal`,
 * list-position.ts `listContextFor`), unchanged by this fix.
 */
export function runPosition(
  items: ReadonlyArray<Pick<DialerItem, 'ordinal' | 'status' | 'outcome' | 'attempt' | 'redialOf'>>,
  currentOrdinal: number,
  runSize: number | null,
): number | null {
  if (runSize === null) return null;
  return items.filter((i) => i.ordinal <= currentOrdinal && !settledAtBuild(i)).length;
}
