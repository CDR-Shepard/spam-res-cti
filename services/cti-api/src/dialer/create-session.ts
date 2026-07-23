import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { resolveDialNumber } from '../salesforce/record-phone.js';
import { salesforceUserId } from '../salesforce/current-user.js';

/** Postgres unique-violation on the one-active-session-per-rep partial index. */
const ACTIVE_SESSION_INDEX = 'dialer_sessions_one_active_per_user';
function isActiveSessionConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === ACTIVE_SESSION_INDEX;
}

export function buildQueueRows(
  sessionId: string,
  objectType: string,
  resolved: Array<{ recordId: string; toNumber: string | null; fallbackNumber?: string | null }>,
): Array<{ sessionId: string; ordinal: number; objectType: string; recordId: string; toNumber: string | null; fallbackNumber: string | null; status: 'pending' | 'unreachable' }> {
  return resolved.map((r, i) => ({
    sessionId, ordinal: i, objectType, recordId: r.recordId, toNumber: r.toNumber,
    fallbackNumber: r.fallbackNumber ?? null,
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
  const resolved: Array<{ recordId: string; toNumber: string | null; fallbackNumber: string | null }> = [];
  for (const recordId of args.recordIds) {
    const r = await deps.resolveDialNumber(args.userId, args.objectType, recordId);
    resolved.push({ recordId, toNumber: r?.e164 ?? null, fallbackNumber: r?.fallbackE164 ?? null });
  }
  let session: typeof schema.dialerSessions.$inferSelect | undefined;
  try {
    [session] = await deps.db
      .insert(schema.dialerSessions)
      .values({ orgId: args.orgId, userId: args.userId, sfOwnerId, objectType: args.objectType, status: 'active' })
      .returning();
  } catch (err) {
    // The rep already has an active session (unique index). Return it rather
    // than create a second — a second active session would let the engine
    // originate a concurrent call for this rep (double-dial). This makes a
    // double-submitted start idempotent, and lets the rep re-kick a session
    // whose first originate failed (the caller advances whatever it gets back).
    if (isActiveSessionConflict(err)) {
      const existing = await deps.db.query.dialerSessions.findFirst({
        where: and(eq(schema.dialerSessions.userId, args.userId), eq(schema.dialerSessions.status, 'active')),
      });
      if (existing) {
        const items = await deps.db.query.dialerQueueItems.findMany({
          where: eq(schema.dialerQueueItems.sessionId, existing.id),
        });
        return { sessionId: existing.id, total: items.length };
      }
    }
    throw err;
  }
  const rows = buildQueueRows(session!.id, args.objectType, resolved);
  if (rows.length) await deps.db.insert(schema.dialerQueueItems).values(rows);
  return { sessionId: session!.id, total: rows.length };
}

/**
 * Create a session and immediately kick the engine so the first eligible record
 * starts dialing. WITHOUT this initial advance, a freshly-created 'active'
 * session sits with every item 'pending' forever: nothing else originates the
 * first call — `resumeSession` needs status 'paused', `repNext` needs an
 * already-connected item, and the dial-outcome webhooks only fire after a dial
 * that never started. So creation is the one and only place the loop begins.
 *
 * `advance` (the engine kick) and `create` are injected so the wiring is unit
 * testable without the telephony/db singletons `buildEngineDeps` news up. A
 * kick failure propagates: the caller returns an error rather than handing the
 * rep a session that silently never dials.
 */
export async function createAndStartSession(
  deps: CreateSessionDeps & { advance: (sessionId: string) => Promise<unknown> },
  args: { userId: string; orgId: string; objectType: 'Lead' | 'Opportunity'; recordIds: string[] },
  create: typeof createDialerSession = createDialerSession,
): Promise<{ sessionId: string; total: number }> {
  const result = await create(deps, args);
  await deps.advance(result.sessionId);
  return result;
}
