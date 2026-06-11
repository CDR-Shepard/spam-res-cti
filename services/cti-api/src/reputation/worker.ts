/**
 * Reputation auto-pause worker.
 *
 * Detection without action is useless. This periodically scans every active
 * DID and, when its recent answer rate or average connected duration crosses a
 * carrier-analytics kill threshold, flips its health to `degraded` — which
 * removes it from the rotation pool and makes the firewall block it — and fires
 * an alert. This is the difference between "the dashboard would have shown the
 * problem tomorrow" and "we stopped burning the number within minutes".
 */
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { dispatchAlert } from '../alerts.js';
import { fetchDidWindowStats } from './query.js';
import { shouldAutoPause, THRESHOLDS } from './signals.js';

interface WorkerLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export async function runReputationTick(logger: WorkerLogger): Promise<number> {
  const db = getDb();
  const dids = await db
    .select()
    .from(schema.outboundNumbers)
    .where(eq(schema.outboundNumbers.active, true));
  const since = new Date(Date.now() - THRESHOLDS.WINDOW_MS);
  let pausedCount = 0;

  for (const did of dids) {
    // Already paused/flagged — nothing to do until a human or a real provider
    // feed clears it.
    if (did.health === 'degraded' || did.health === 'spam_likely') continue;

    const stats = await fetchDidWindowStats(db, did.orgId, did.e164, since);
    const { pause, reasons } = shouldAutoPause(stats);
    if (!pause) continue;

    await db
      .update(schema.outboundNumbers)
      .set({ health: 'degraded', healthSource: 'reputation_worker', healthUpdatedAt: new Date() })
      .where(eq(schema.outboundNumbers.id, did.id));
    await db.insert(schema.numberHealthSnapshots).values({
      outboundNumberId: did.id,
      health: 'degraded',
      source: 'reputation_worker',
      details: { reasons, stats },
    });
    await dispatchAlert(logger, {
      kind: 'did_auto_paused',
      severity: 'warning',
      orgId: did.orgId,
      message: `Auto-paused ${did.e164}: ${reasons.join('; ')}`,
      context: { e164: did.e164, reasons, stats },
    });
    pausedCount++;
  }
  return pausedCount;
}

export function startReputationWorker(logger: WorkerLogger, intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    runReputationTick(logger).catch((err) => {
      logger.error({ err: (err as Error).message }, 'reputation worker tick failed');
    });
  }, intervalMs);
  // Don't keep the process alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
