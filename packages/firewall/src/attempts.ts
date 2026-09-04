import { and, eq, gte, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { REASON } from './reasons.js';
import type { CheckResult } from './types.js';

/**
 * Fold `GROUP BY from_number` counts of a customer's recent contacts into the
 * per-number map (used for rotation + the per-number gate) and the total
 * across ALL numbers (the per-customer ceiling). Rows with a null from_number
 * (inbound/legacy) count toward the total but not any number's budget.
 *
 * Counts ACCUMULATE per from-number: the caller may hand us the concatenation
 * of several grouped queries (see customerAttemptCounts), and the same number
 * can appear once per source.
 */
export function tallyAttempts(
  rows: ReadonlyArray<{ from: string | null; n: number }>,
): { attemptsByNumber: Map<string, number>; customerAttemptsTotal: number } {
  const attemptsByNumber = new Map<string, number>();
  let customerAttemptsTotal = 0;
  for (const r of rows) {
    customerAttemptsTotal += r.n;
    if (r.from) attemptsByNumber.set(r.from, (attemptsByNumber.get(r.from) ?? 0) + r.n);
  }
  return { attemptsByNumber, customerAttemptsTotal };
}

/**
 * Every contact this org made to `toE164` since `windowStart`, grouped by the
 * number that placed it. This is the ONE definition of "an attempt", shared by
 * the click-to-dial gate below (gate 5) and the power dialer's per-run ceiling
 * (dialer/pick-agent-did.ts `customerAttemptState`) — a compliance backstop
 * that counted differently depending on which button the rep pressed would be
 * a discrepancy nobody could see.
 *
 * TWO sources, because the two dial paths record differently:
 *  - `calls`: written by click-to-dial (routes/calls.ts) and inbound.
 *  - `dialer_dial_attempts`: the power dialer originates straight through the
 *    Twilio SDK (dialer/twilio-telephony.ts) and writes no `calls` row, so
 *    counting only `calls` would leave the ceiling blind to the highest-volume
 *    dial path. One append-only row per successful originate, written inside the
 *    engine's dialing stamp.
 *
 * NOT `dialer_queue_items`, which this used to count: a TRUE no-answer rewrites
 * `to_number`/`from_number` on the SAME row to dial the record's Phone, so the
 * mobile dial vanished from the tally the moment the fallback was tried — the
 * recipient had been contacted twice and the ceiling could only see once.
 *
 * The two sources are disjoint (no dialer dial ever writes a `calls` row), so
 * summing them cannot double-count.
 */
export async function customerAttemptCounts(
  db: Db,
  orgId: string,
  toE164: string,
  windowStart: Date,
): Promise<{ attemptsByNumber: Map<string, number>; customerAttemptsTotal: number }> {
  const [calls, dialed] = await Promise.all([
    db
      .select({ from: schema.calls.fromNumber, n: sql<number>`count(*)::int` })
      .from(schema.calls)
      .where(
        and(
          eq(schema.calls.orgId, orgId),
          eq(schema.calls.normalizedToNumber, toE164),
          gte(schema.calls.createdAt, windowStart),
        ),
      )
      .groupBy(schema.calls.fromNumber),
    db
      .select({ from: schema.dialerDialAttempts.fromNumber, n: sql<number>`count(*)::int` })
      .from(schema.dialerDialAttempts)
      .where(
        and(
          eq(schema.dialerDialAttempts.orgId, orgId),
          eq(schema.dialerDialAttempts.toNumber, toE164),
          gte(schema.dialerDialAttempts.dialedAt, windowStart),
        ),
      )
      .groupBy(schema.dialerDialAttempts.fromNumber),
  ]);
  return tallyAttempts([...calls, ...dialed]);
}

/**
 * The per-customer ceiling predicate — ONE definition, shared by the
 * click-to-dial gate (attemptGateChecks) and the dialer's per-run skip
 * (dialer/pick-agent-did.ts). `>=` because the ceiling counts contacts already
 * made: at 15 of 15 the next dial would be the 16th.
 */
export function atCustomerCeiling(args: {
  customerAttemptsTotal: number;
  perCustomerMaxAttempts: number;
}): boolean {
  return args.customerAttemptsTotal >= args.perCustomerMaxAttempts;
}

/**
 * The two attempt gates: the per-customer ceiling (across all of a rep's
 * numbers — the anti-harassment backstop) and the per-number budget for the
 * chosen DID (which, with rotation swapping away from exhausted numbers, only
 * blocks when every number is exhausted or an over-budget number was forced in).
 */
export function attemptGateChecks(args: {
  windowDays: number;
  maxAttempts: number;
  perCustomerMaxAttempts: number;
  attemptsByNumber: Map<string, number>;
  customerAttemptsTotal: number;
  effectiveFrom: string | null;
}): CheckResult[] {
  const checks: CheckResult[] = [];
  if (atCustomerCeiling(args)) {
    checks.push({
      name: 'customer_limit',
      passed: false,
      severity: 'block',
      reasonCode: REASON.CUSTOMER_LIMIT_EXCEEDED,
      detail: `${args.customerAttemptsTotal} contacts to this customer across all numbers in ${args.windowDays}d (ceiling ${args.perCustomerMaxAttempts})`,
    });
  } else {
    checks.push({
      name: 'customer_limit',
      passed: true,
      severity: 'info',
      reasonCode: REASON.CUSTOMER_LIMIT_OK,
      detail: `${args.customerAttemptsTotal}/${args.perCustomerMaxAttempts} to this customer (all numbers) in ${args.windowDays}d`,
    });
  }
  if (args.effectiveFrom) {
    const perNumber = args.attemptsByNumber.get(args.effectiveFrom) ?? 0;
    if (perNumber >= args.maxAttempts) {
      checks.push({
        name: 'attempt_limit',
        passed: false,
        severity: 'block',
        reasonCode: REASON.ATTEMPT_LIMIT_EXCEEDED,
        detail: `${args.effectiveFrom} → this customer: ${perNumber} in ${args.windowDays}d (limit ${args.maxAttempts}/number; all your numbers may be exhausted for this customer)`,
      });
    } else {
      checks.push({
        name: 'attempt_limit',
        passed: true,
        severity: 'info',
        reasonCode: REASON.ATTEMPT_LIMIT_OK,
        detail: `${perNumber}/${args.maxAttempts} from this number to this customer in ${args.windowDays}d`,
      });
    }
  }
  return checks;
}
