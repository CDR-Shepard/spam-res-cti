import { and, eq, type SQL } from 'drizzle-orm';
import { getDb, schema, type NumberKind } from '@cti/db';

/** A shared (unowned) pool a picker walks: the power dialer's, or the AI voice agent's. */
export type PoolKind = Extract<NumberKind, 'dialer_pool' | 'ai_pool'>;

export function isDialerPoolKind(kind: string): boolean {
  return kind === 'dialer_pool';
}

/** The listing's WHERE, split out so a test can render it: one org, active, ONE kind. */
export function poolNumbersWhere(orgId: string, kind: PoolKind): SQL {
  return and(
    eq(schema.outboundNumbers.orgId, orgId),
    eq(schema.outboundNumbers.active, true),
    eq(schema.outboundNumbers.kind, kind),
  )!;
}

/**
 * Active pool DIDs of one kind for an org: `dialer_pool` (the default — the
 * numbers the power dialer may use) or `ai_pool` (the AI voice agent's own).
 * Never a mix, so neither caller can be handed the other's numbers.
 */
export async function dialerPoolNumbers(
  orgId: string,
  kind: PoolKind = 'dialer_pool',
): Promise<Array<typeof schema.outboundNumbers.$inferSelect>> {
  const db = getDb();
  return db.select().from(schema.outboundNumbers).where(poolNumbersWhere(orgId, kind));
}
