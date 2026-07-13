import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { DialerItem } from './session-store.js';
import { inFlightItem, nextPendingItem } from './state.js';
import type { DialerTelephony } from './telephony-port.js';
import type { dialerPoolNumbers } from './pool.js';
import type { rolloverFollowUp } from '../salesforce/followup.js';

export interface EngineDeps {
  db: ReturnType<typeof getDb>;
  telephony: DialerTelephony;
  dialerPoolNumbers: typeof dialerPoolNumbers;
  rolloverFollowUp: typeof rolloverFollowUp;
  onScreenPop: (userId: string, objectType: string, recordId: string) => void;
  todayIso: string;
}

type Session = typeof schema.dialerSessions.$inferSelect;

async function loadItems(deps: EngineDeps, sessionId: string): Promise<DialerItem[]> {
  return deps.db.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, sessionId) });
}

async function setSession(deps: EngineDeps, id: string, status: Session['status']): Promise<void> {
  await deps.db.update(schema.dialerSessions).set({ status, updatedAt: new Date() }).where(eq(schema.dialerSessions.id, id));
}
async function setItem(deps: EngineDeps, id: string, patch: Partial<DialerItem>): Promise<void> {
  await deps.db.update(schema.dialerQueueItems).set({ ...patch, updatedAt: new Date() }).where(eq(schema.dialerQueueItems.id, id));
}

export async function advanceSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<{ action: 'dialing' | 'waiting' | 'done' | 'idle' | 'paused_no_numbers'; itemId?: string }> {
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
  if (!session || session.status !== 'active') return { action: 'idle' };
  let items = await loadItems(deps, sessionId);
  if (inFlightItem(items)) return { action: 'waiting' };

  // Skip any unreachable pendings (defensive; creation already marks them).
  for (;;) {
    const next = nextPendingItem(items);
    if (!next) { await setSession(deps, sessionId, 'done'); return { action: 'done' }; }
    if (!next.toNumber) {
      await setItem(deps, next.id, { status: 'unreachable' });
      items = items.map((i) => (i.id === next.id ? { ...i, status: 'unreachable' } : i));
      continue;
    }
    const pool = await deps.dialerPoolNumbers(session.orgId);
    const did = pool[0];
    if (!did) { await setSession(deps, sessionId, 'paused'); return { action: 'paused_no_numbers' }; }
    await setItem(deps, next.id, { status: 'dialing' });
    const { callId } = await deps.telephony.originate({
      sessionId, itemId: next.id, fromE164: did.e164, toE164: next.toNumber, userId: session.userId,
    });
    await setItem(deps, next.id, { callId });
    return { action: 'dialing', itemId: next.id };
  }
}

export async function handleDialOutcome(
  callId: string,
  outcome: 'connected' | 'no_connect',
  deps: EngineDeps,
): Promise<void> {
  const item = await deps.db.query.dialerQueueItems.findFirst({ where: eq(schema.dialerQueueItems.callId, callId) });
  if (!item || item.status !== 'dialing') return;
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, item.sessionId) });
  if (!session) return;

  await setItem(deps, item.id, { status: outcome, outcome });
  if (outcome === 'connected') {
    await deps.telephony.bridgeToRep(callId, session.userId);
    deps.onScreenPop(session.userId, item.objectType, item.recordId);
    return; // wait for the rep's `next`
  }
  try {
    await deps.rolloverFollowUp(session.userId, session.sfOwnerId, item.recordId, deps.todayIso);
  } catch (err) {
    console.error('[dialer] rollover failed', { itemId: item.id, err: (err as Error).message });
  }
  await advanceSession(item.sessionId, deps);
}
