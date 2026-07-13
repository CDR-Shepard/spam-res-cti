import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

export function isDialerPoolKind(kind: string): boolean {
  return kind === 'dialer_pool';
}

/** Active dialer-pool DIDs for an org (the numbers the power dialer may use). */
export async function dialerPoolNumbers(
  orgId: string,
): Promise<Array<typeof schema.outboundNumbers.$inferSelect>> {
  const db = getDb();
  return db
    .select()
    .from(schema.outboundNumbers)
    .where(
      and(
        eq(schema.outboundNumbers.orgId, orgId),
        eq(schema.outboundNumbers.active, true),
        eq(schema.outboundNumbers.kind, 'dialer_pool'),
      ),
    );
}
