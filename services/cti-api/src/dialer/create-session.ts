import { getDb, schema } from '../db/index.js';
import { resolveDialNumber } from '../salesforce/record-phone.js';
import { salesforceUserId } from '../salesforce/current-user.js';

export function buildQueueRows(
  sessionId: string,
  objectType: string,
  resolved: Array<{ recordId: string; toNumber: string | null }>,
): Array<{ sessionId: string; ordinal: number; objectType: string; recordId: string; toNumber: string | null; status: 'pending' | 'unreachable' }> {
  return resolved.map((r, i) => ({
    sessionId, ordinal: i, objectType, recordId: r.recordId, toNumber: r.toNumber,
    status: r.toNumber ? 'pending' : 'unreachable',
  }));
}

export interface CreateSessionDeps {
  resolveDialNumber: typeof resolveDialNumber;
  salesforceUserId: typeof salesforceUserId;
  db: ReturnType<typeof getDb>;
}

export async function createDialerSession(
  deps: CreateSessionDeps,
  args: { userId: string; orgId: string; objectType: 'Lead' | 'Opportunity'; recordIds: string[] },
): Promise<{ sessionId: string; total: number }> {
  const sfOwnerId = await deps.salesforceUserId(args.userId);
  const resolved: Array<{ recordId: string; toNumber: string | null }> = [];
  for (const recordId of args.recordIds) {
    const r = await deps.resolveDialNumber(args.userId, args.objectType, recordId);
    resolved.push({ recordId, toNumber: r?.e164 ?? null });
  }
  const [session] = await deps.db
    .insert(schema.dialerSessions)
    .values({ orgId: args.orgId, userId: args.userId, sfOwnerId, objectType: args.objectType, status: 'active' })
    .returning();
  const rows = buildQueueRows(session!.id, args.objectType, resolved);
  if (rows.length) await deps.db.insert(schema.dialerQueueItems).values(rows);
  return { sessionId: session!.id, total: rows.length };
}
