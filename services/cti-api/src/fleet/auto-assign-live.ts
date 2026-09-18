/**
 * Production wiring for starter-number assignment. Kept apart from
 * auto-assign.ts so that module stays pure and every piece of SQL here can be
 * pinned by a test that RENDERS it — a fake DB records a query object without
 * ever proving what Postgres would actually match or lock.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { assignStarterNumbers, type AutoAssignOutcome, type AutoAssignTx } from './auto-assign.js';
import type { Holding } from './plan.js';

/**
 * Claim up to `n` free reserve numbers for one user, atomically.
 *
 * The manual `assign` command SELECTs the free numbers and then UPDATEs them one
 * by one. Fine for one operator at a terminal, wrong for sign-in: on an
 * onboarding morning two new hires land in the same second, both SELECT the same
 * six lowest numbers, and the second UPDATE silently steals them from the first.
 * So the pick and the write are ONE statement, and the pick takes row locks with
 * SKIP LOCKED — a concurrent claimer skips rows this one holds and takes the
 * next six instead of waiting or colliding.
 *
 * The CTE form is deliberate. `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP
 * LOCKED)` lets the planner re-run the subquery per outer row and hand back more
 * than `n`; a CTE that takes row locks is always materialized once.
 *
 * `e164 like '+1%' and length(e164) = 12` keeps this agreeing with
 * `classifyArea` (fleet/plan.ts), which is a strict `+1` + 10 digits regex.
 * Without it a malformed or non-US number whose characters 3-5 happen to read
 * "213" would be claimed as an LA number that the planner then counts as
 * "other" — so the rep holds it AND is still told they need six.
 *
 * Scoped to the rep's OWN org: the reserve is per tenant, and an unscoped claim
 * would hand one company's numbers to another company's new hire.
 */
export function claimReserveSql(args: {
  orgId: string; userId: string; codes: readonly string[]; n: number; label: string;
}): SQL {
  const codes = sql.join(args.codes.map((c) => sql`${c}`), sql`, `);
  return sql`
    with picked as (
      select id
        from outbound_numbers
       where org_id = ${args.orgId}
         and kind = 'agent'
         and assigned_user_id is null
         and active
         and health not in ('degraded', 'spam_likely')
         and e164 like '+1%' and length(e164) = 12
         and substring(e164 from 3 for 3) in (${codes})
       order by e164
       limit ${args.n}
         for update skip locked
    )
    update outbound_numbers o
       set assigned_user_id = ${args.userId},
           label = ${args.label}
      from picked
     where o.id = picked.id
    returning o.e164`;
}

/**
 * Serialize concurrent claims for the SAME rep. Transaction-scoped, so it is
 * released on commit or rollback with nothing to clean up, and it blocks only a
 * second claim for this user — two different reps still proceed in parallel and
 * SKIP LOCKED keeps them off each other's rows.
 *
 * DEPENDS ON READ COMMITTED (the Postgres default; nothing here changes it). The
 * second sign-in must take a FRESH snapshot after the first commits, so its
 * holdings read sees the numbers just claimed. Under REPEATABLE READ the lock
 * would still serialize the two, and the second would still read stale holdings
 * and claim a full set anyway.
 */
export function userLockSql(userId: string): SQL {
  return sql`select pg_advisory_xact_lock(hashtext(${`starter-numbers:${userId}`}))`;
}

/**
 * The rep's agent numbers. Org-scoped like the claim, so the read half and the
 * write half of one operation can never disagree about whose numbers count.
 * Health and `active` are returned, not filtered: `buyPlanForRep` owns the
 * definition of "usable" and this must not pre-empt it.
 */
export function holdingsWhere(who: { orgId: string; userId: string }): SQL {
  return and(
    eq(schema.outboundNumbers.orgId, who.orgId),
    eq(schema.outboundNumbers.assignedUserId, who.userId),
    eq(schema.outboundNumbers.kind, 'agent'),
  )!;
}

/** The e164s out of a claim's result. Split out so a test can pin the column. */
export function claimedE164s(res: { rows: ReadonlyArray<Record<string, unknown>> }): string[] {
  return res.rows.map((r) => r.e164).filter((v): v is string => typeof v === 'string');
}

/**
 * Best-effort: bring a rep up to the 6 LA + 6 SD standard out of the reserve.
 * Never throws, so the sign-in path that calls it needs no guard of its own.
 */
export async function assignStarterNumbersLive(who: {
  orgId: string; userId: string; email: string;
}): Promise<AutoAssignOutcome> {
  try {
    const db = getDb();
    return await assignStarterNumbers(
      {
        withUserLock: (lockFor, fn) =>
          db.transaction(async (tx) => {
            await tx.execute(userLockSql(lockFor.userId));
            const handle: AutoAssignTx = {
              holdings: async () =>
                (await tx
                  .select({
                    e164: schema.outboundNumbers.e164,
                    health: schema.outboundNumbers.health,
                    active: schema.outboundNumbers.active,
                  })
                  .from(schema.outboundNumbers)
                  .where(holdingsWhere(lockFor))) as Holding[],
              claim: async ({ codes, n, label }) => {
                // `in ()` is a syntax error, and a zero-row claim is a no-op anyway.
                if (codes.length === 0 || n <= 0) return [];
                return claimedE164s(await tx.execute(claimReserveSql({ ...lockFor, codes, n, label })));
              },
            };
            return fn(handle);
          }),
      },
      who,
    );
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
