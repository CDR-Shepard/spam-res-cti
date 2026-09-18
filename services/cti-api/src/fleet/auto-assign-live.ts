/**
 * Production wiring for starter-number assignment. Kept apart from
 * auto-assign.ts so that module stays pure and the SQL here can be pinned by a
 * test that renders it — a fake DB records a query object without ever proving
 * what Postgres would actually match or lock.
 */
import { and, count, eq, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { assignStarterNumbers, type AutoAssignOutcome } from './auto-assign.js';

/**
 * Claim up to `n` free reserve numbers for one user, atomically.
 *
 * The manual `assign` command SELECTs the free numbers and then UPDATEs them one
 * by one. That is fine for one operator at a terminal and wrong for sign-in: on
 * an onboarding morning two new hires land in the same second, both SELECT the
 * same six lowest numbers, and the second UPDATE silently steals them from the
 * first. So the pick and the write are ONE statement, and the pick takes row
 * locks with SKIP LOCKED — a concurrent claimer skips rows this one has locked
 * and takes the next six instead of waiting or colliding.
 *
 * The CTE form is deliberate. `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP
 * LOCKED)` lets the planner re-run the subquery per outer row and hand back more
 * than `n`; a CTE that takes row locks is always materialized once.
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
 * Best-effort: give a rep who holds no numbers the 6 LA + 6 SD starter set.
 * Never throws, so the sign-in path that calls it needs no guard of its own.
 */
export async function assignStarterNumbersLive(who: {
  orgId: string; userId: string; email: string;
}): Promise<AutoAssignOutcome> {
  try {
    const db = getDb();
    return await assignStarterNumbers(
      {
        countHeld: async (userId) => {
          const [row] = await db
            .select({ n: count() })
            .from(schema.outboundNumbers)
            .where(and(
              eq(schema.outboundNumbers.assignedUserId, userId),
              eq(schema.outboundNumbers.kind, 'agent'),
              eq(schema.outboundNumbers.active, true),
            ));
          return Number(row?.n ?? 0);
        },
        claim: async (args) => {
          const res = await db.execute(claimReserveSql(args));
          return (res.rows as Array<{ e164: string }>).map((r) => r.e164);
        },
      },
      who,
    );
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
