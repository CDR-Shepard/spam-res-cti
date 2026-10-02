/**
 * dialer_time_tasks + dialer_rep_legs access for salesforce/dialer-time-worker.ts.
 * The worker only sees the DialerTimeStore interface, so its tests run on an
 * in-memory store; this file's SQL is pinned in dialer-time-store.test.ts.
 */
import { and, eq, gt, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import type { SyncedRow, WindowLeg } from './dialer-time-plan.js';

type Db = ReturnType<typeof getDb>;
const t = schema.dialerTimeTasks;
const l = schema.dialerRepLegs;

export interface DialerTimeStore {
  loadLegs(start: Date, end: Date): Promise<WindowLeg[]>;
  loadRows(days: readonly string[]): Promise<SyncedRow[]>;
  ensureRow(orgId: string, userId: string, day: string): Promise<SyncedRow>;
  /** THE CLAIM IS THE LEASE (final review I1, dialer-connect-worker.ts's
   *  convention): an atomic UPDATE ... WHERE next_attempt_at <= now RETURNING
   *  the row, so two overlapping API instances can never both write the same
   *  (rep, day) Task. Returns the fresh row (another instance may have just
   *  created the Task) on success, or null when it is already leased or not
   *  yet due — the caller skips it for free. */
  claimRow(id: string, now: Date, leaseMs: number): Promise<SyncedRow | null>;
  saveSynced(id: string, taskId: string, seconds: number, now: Date): Promise<void>;
  saveFailure(id: string, attempts: number, nextAttemptAt: Date, lastError: string, now: Date): Promise<void>;
  /** An expired Salesforce sign-in (final review M1): waits `nextAttemptAt`
   *  without bumping `attempts`, so a reconnect doesn't read as a failure and
   *  the token refresh isn't hammered every tick until the rep reconnects. */
  saveAuthWait(id: string, nextAttemptAt: Date, lastError: string, now: Date): Promise<void>;
  clearTaskId(id: string, now: Date): Promise<void>;
  sfUserIdFor(userId: string): Promise<string | null>;
}

const rowColumns = {
  id: t.id,
  orgId: t.orgId,
  userId: t.userId,
  day: t.day,
  salesforceTaskId: t.salesforceTaskId,
  syncedSeconds: t.syncedSeconds,
  attempts: t.attempts,
  nextAttemptAt: t.nextAttemptAt,
};

export function windowLegsStatement(db: Db, start: Date, end: Date) {
  return db
    .select({ orgId: l.orgId, userId: l.userId, joinedAt: l.joinedAt, endedAt: l.endedAt })
    .from(l)
    .where(and(lt(l.joinedAt, end), or(isNull(l.endedAt), gt(l.endedAt, start))));
}

export function rowsForDaysStatement(db: Db, days: readonly string[]) {
  return db.select(rowColumns).from(t).where(inArray(t.day, [...days]));
}

export function insertRowStatement(db: Db, orgId: string, userId: string, day: string) {
  return db.insert(t).values({ orgId, userId, day }).onConflictDoNothing();
}

/** THE CLAIM IS THE LEASE — see DialerTimeStore.claimRow. */
export function claimRowStatement(db: Db, id: string, now: Date, leaseMs: number) {
  return db
    .update(t)
    .set({ nextAttemptAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(and(eq(t.id, id), lte(t.nextAttemptAt, now)))
    .returning(rowColumns);
}

export function liveDialerTimeStore(db: Db): DialerTimeStore {
  return {
    loadLegs: (start, end) => windowLegsStatement(db, start, end),
    loadRows: (days) => (days.length === 0 ? Promise.resolve([]) : rowsForDaysStatement(db, days)),
    async ensureRow(orgId, userId, day) {
      await insertRowStatement(db, orgId, userId, day);
      const [row] = await db.select(rowColumns).from(t).where(and(eq(t.userId, userId), eq(t.day, day))).limit(1);
      if (!row) throw new Error('dialer_time_tasks row missing after insert');
      return row;
    },
    async claimRow(id, now, leaseMs) {
      const [row] = await claimRowStatement(db, id, now, leaseMs);
      return row ?? null;
    },
    async saveSynced(id, taskId, seconds, now) {
      await db
        .update(t)
        .set({ salesforceTaskId: taskId, syncedSeconds: seconds, attempts: 0, nextAttemptAt: now, lastError: null, updatedAt: now })
        .where(eq(t.id, id));
    },
    async saveFailure(id, attempts, nextAttemptAt, lastError, now) {
      await db.update(t).set({ attempts, nextAttemptAt, lastError, updatedAt: now }).where(eq(t.id, id));
    },
    async saveAuthWait(id, nextAttemptAt, lastError, now) {
      // attempts untouched on purpose: a reconnect is not a failure.
      await db.update(t).set({ nextAttemptAt, lastError, updatedAt: now }).where(eq(t.id, id));
    },
    async clearTaskId(id, now) {
      // Also releases the claim (I1): a deleted-in-Salesforce Task is not a
      // failure needing backoff, it's due again immediately.
      await db.update(t).set({ salesforceTaskId: null, syncedSeconds: null, nextAttemptAt: now, updatedAt: now }).where(eq(t.id, id));
    },
    async sfUserIdFor(userId) {
      const [conn] = await db
        .select({ sfUserId: schema.salesforceConnections.sfUserId })
        .from(schema.salesforceConnections)
        .where(eq(schema.salesforceConnections.userId, userId))
        .limit(1);
      return conn?.sfUserId ?? null;
    },
  };
}
