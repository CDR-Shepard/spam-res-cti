/**
 * Power-dialer time → Salesforce. Every 5 minutes (and once at start-up), for
 * the last 3 Pacific days: each rep's time on the power dialer (line open,
 * dialer_rep_legs, merged — the admin Talk time screen's "On dialer") is
 * written to ONE "Power Dialer Time" Task per (rep, day), as the rep, so
 * Salesforce reports can sum it. dialer_time_tasks remembers the Task id and
 * the seconds last written; a write happens only when they differ.
 *
 * No duplicates: before a create, the rep's existing Task for that day is
 * looked up and adopted — so a crash between create and stamp, or a lost row,
 * is repaired on the next tick. A Task deleted in Salesforce is recreated.
 * Errors: a Salesforce auth error waits for the rep to reconnect (uncounted);
 * anything else backs off 5 m → 6 h and keeps trying (the day's number must
 * converge). Logs carry ids and error codes only.
 *
 * Kill switch: DIALER_TIME_TASKS=off never starts the loop.
 * Design: docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md.
 */
import { getDb } from '@cti/db';
import type { AppConfig } from '../config.js';
import { addDays, dayStartUtc } from '../reports/talk-time.js';
import { createDialerTimeTask, findDialerTimeTask, updateDialerTimeTask } from './dialer-time-client.js';
import { backoffMs, planDialerTimeWrites, windowDays, type PlannedWrite } from './dialer-time-plan.js';
import { liveDialerTimeStore, type DialerTimeStore } from './dialer-time-store.js';
import { errorText, unexpectedErrorSummary } from './error-summary.js';
import { isSalesforceAuthError, withTimeout } from './followup-worker.js';

export const DIALER_TIME_INTERVAL_MS = 300_000;
export const SF_TIMEOUT_MS = 30_000;
export const LOG = '[dialer-time-worker]';

export interface DialerTimeDeps {
  store: DialerTimeStore;
  now: () => Date;
  sf: {
    createDialerTimeTask: typeof createDialerTimeTask;
    updateDialerTimeTask: typeof updateDialerTimeTask;
    findDialerTimeTask: typeof findDialerTimeTask;
  };
}

function liveDeps(): DialerTimeDeps {
  return {
    store: liveDialerTimeStore(getDb()),
    now: () => new Date(),
    sf: { createDialerTimeTask, updateDialerTimeTask, findDialerTimeTask },
  };
}

/** Create — or adopt the rep's existing Task for the day — and return its id; null = skipped. */
async function createOrAdopt(w: PlannedWrite, deps: DialerTimeDeps): Promise<string | null> {
  const sfUserId = await deps.store.sfUserIdFor(w.userId);
  if (!sfUserId) {
    console.warn(`${LOG} no Salesforce connection — skipped`, { userId: w.userId, day: w.day });
    return null;
  }
  const existing = await withTimeout(deps.sf.findDialerTimeTask(w.userId, sfUserId, w.day), SF_TIMEOUT_MS, 'Salesforce Task lookup');
  if (existing) {
    const r = await withTimeout(deps.sf.updateDialerTimeTask(w.userId, existing, w.seconds), SF_TIMEOUT_MS, 'Salesforce Task update');
    if (r === 'updated') return existing;
  }
  const { taskId } = await withTimeout(deps.sf.createDialerTimeTask(w.userId, w.day, w.seconds), SF_TIMEOUT_MS, 'Salesforce Task create');
  return taskId;
}

/** One (rep, day). Returns true when Salesforce now holds `w.seconds`. */
async function syncOne(w: PlannedWrite, deps: DialerTimeDeps): Promise<boolean> {
  const row = w.row ?? (await deps.store.ensureRow(w.orgId, w.userId, w.day));
  try {
    if (row.salesforceTaskId) {
      const r = await withTimeout(deps.sf.updateDialerTimeTask(w.userId, row.salesforceTaskId, w.seconds), SF_TIMEOUT_MS, 'Salesforce Task update');
      if (r === 'missing') {
        await deps.store.clearTaskId(row.id, deps.now());
        console.warn(`${LOG} Task was deleted in Salesforce — recreating next tick`, { userId: w.userId, day: w.day });
        return false;
      }
      await deps.store.saveSynced(row.id, row.salesforceTaskId, w.seconds, deps.now());
      return true;
    }
    const taskId = await createOrAdopt(w, deps);
    if (!taskId) return false;
    await deps.store.saveSynced(row.id, taskId, w.seconds, deps.now());
    return true;
  } catch (err) {
    if (isSalesforceAuthError(err)) return false; // the rep reconnects; uncounted
    const attempts = row.attempts + 1;
    const now = deps.now();
    await deps.store.saveFailure(row.id, attempts, new Date(now.getTime() + backoffMs(attempts)), errorText(err), now);
    console.warn(`${LOG} write failed, will retry`, { userId: w.userId, day: w.day, attempts, err: unexpectedErrorSummary(err) });
    return false;
  }
}

export async function runDialerTimeTick(deps: DialerTimeDeps = liveDeps()): Promise<{ planned: number; written: number }> {
  const now = deps.now();
  const days = windowDays(now);
  const legs = await deps.store.loadLegs(dayStartUtc(days[0]!), dayStartUtc(addDays(days[days.length - 1]!, 1)));
  const rows = await deps.store.loadRows(days);
  const planned = planDialerTimeWrites({ legs, days, now, rows });
  let written = 0;
  for (const w of planned) {
    try {
      if (await syncOne(w, deps)) written++;
    } catch (err) {
      // A store failure (the row insert, the failure stamp): log, move on to the next rep.
      console.error(`${LOG} rep failed`, { userId: w.userId, day: w.day, err: unexpectedErrorSummary(err) });
    }
  }
  return { planned: planned.length, written };
}

/** Single-flight: a slow tick is never overlapped. Runs once immediately. */
export function startDialerTimeLoop(intervalMs = DIALER_TIME_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runDialerTimeTick()
      .catch((err) => console.error(`${LOG} tick error`, { err: unexpectedErrorSummary(err) }))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, 0);
  return setInterval(tick, intervalMs);
}

/** The kill switch (config.ts DIALER_TIME_TASKS). `start` is a test seam. */
export function maybeStartDialerTimeLoop(
  cfg: Pick<AppConfig, 'DIALER_TIME_TASKS'>,
  start: (intervalMs: number) => NodeJS.Timeout = startDialerTimeLoop,
): NodeJS.Timeout | null {
  return cfg.DIALER_TIME_TASKS === 'on' ? start(DIALER_TIME_INTERVAL_MS) : null;
}
