/**
 * The stale-call sweeper: finalizes AI calls whose terminal status callback
 * never arrived (Twilio does not retry a lost or failed callback), so no row
 * stays "in progress" forever, uncounted and unlogged.
 *
 * Every 120 s (unref'd, single-flight), at most 50 rows with `ended_at is
 * null` that this process is not running (registry):
 *   - placed (CallSid) and older than 3 minutes → ask Twilio; a terminal call
 *     is finalized with Twilio's own status / duration / AMD / end time;
 *     a call Twilio has no record of (404), or that we cannot read for 6 h,
 *     is finalized `failed`; anything else waits for the next tick;
 *   - never placed (no CallSid) and older than 10 minutes → finalized `failed`.
 * finalizeAiCall is the same compare-and-swap the webhook uses, so a late
 * callback and the sweeper can never both finalize a row.
 *
 * Started from server.ts; null when AI voice is unavailable.
 */
import { getDb } from '@cti/db';
import { aiVoiceAvailable, type AppConfig } from '../config.js';
import type { BridgeLog } from './bridge.js';
import { getActiveCall } from './registry.js';
import { finalizeAiCall, isTerminalCallStatus, liveAfterCall, type AfterCall, type FinalizeInput } from './service-finalize.js';
import { drizzleAiCallStore, type AiCallRow, type AiCallStore } from './store.js';
import { createAiVoiceTwilio, type AiVoiceTwilio } from './twilio.js';

export const SWEEP_INTERVAL_MS = 120_000;
export const PLACED_STALE_MS = 3 * 60_000;
export const UNPLACED_STALE_MS = 10 * 60_000;
export const SWEEP_LIMIT = 50;
/** A placed call we still cannot read from Twilio after this long is given up as failed. */
export const GIVE_UP_AFTER_MS = 6 * 60 * 60_000;

export interface SweeperDeps {
  store: AiCallStore;
  twilio: Pick<AiVoiceTwilio, 'fetchCall'>;
  /** Is this call live in this process (its own callbacks will end it)? */
  isActive: (aiCallId: string) => boolean;
  afterCall?: AfterCall;
  now: () => Date;
  log: BridgeLog;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const notFound = (e: unknown): boolean => (e as { status?: unknown } | null)?.status === 404;

/** How this row ends, or null to leave it for the next tick. */
async function endFor(row: AiCallRow, deps: SweeperDeps): Promise<FinalizeInput | null> {
  const failed: FinalizeInput = { callStatus: 'failed', durationSeconds: null, endedAt: deps.now() };
  if (!row.callSid) return failed;
  try {
    const call = await deps.twilio.fetchCall(row.callSid);
    if (!isTerminalCallStatus(call.status)) return null;
    return {
      callStatus: call.status,
      durationSeconds: call.durationSeconds,
      endedAt: call.endTime ?? deps.now(),
      answeredBy: call.answeredBy,
      callSid: row.callSid,
    };
  } catch (e) {
    if (notFound(e) || deps.now().getTime() - row.createdAt.getTime() > GIVE_UP_AFTER_MS) return failed;
    deps.log.warn({ aiCallId: row.id, err: errText(e) }, 'ai-voice sweeper: Twilio read failed, will retry');
    return null;
  }
}

export async function sweepStaleAiCalls(deps: SweeperDeps): Promise<{ checked: number; finalized: number }> {
  const now = deps.now().getTime();
  const rows = await deps.store.staleOpen(new Date(now - PLACED_STALE_MS), new Date(now - UNPLACED_STALE_MS), SWEEP_LIMIT);
  let checked = 0;
  let finalized = 0;
  for (const row of rows) {
    if (deps.isActive(row.id)) continue;
    checked += 1;
    try {
      const end = await endFor(row, deps);
      if (!end) continue;
      const res = await finalizeAiCall({ store: deps.store, log: deps.log, ...(deps.afterCall ? { afterCall: deps.afterCall } : {}) }, row.id, end);
      if (res.finalized) {
        finalized += 1;
        deps.log.warn({ aiCallId: row.id, callStatus: end.callStatus }, 'ai-voice sweeper: finalized a call whose status callback never came');
      }
    } catch (e) {
      deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice sweeper: row failed');
    }
  }
  return { checked, finalized };
}

function liveSweeperDeps(cfg: AppConfig, log: BridgeLog): SweeperDeps {
  const store = drizzleAiCallStore(getDb());
  return {
    store,
    twilio: createAiVoiceTwilio(cfg),
    isActive: (id) => getActiveCall(id) !== null,
    afterCall: liveAfterCall(cfg, store, log).afterCall,
    now: () => new Date(),
    log,
  };
}

/** Starts the sweep (unref'd, single-flight); null when AI voice is unavailable. `deps` is a test seam. */
export function startAiCallSweeper(
  cfg: AppConfig,
  log: BridgeLog,
  deps: () => SweeperDeps = () => liveSweeperDeps(cfg, log),
): NodeJS.Timeout | null {
  if (!aiVoiceAvailable(cfg)) return null;
  let built: SweeperDeps | null = null;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await sweepStaleAiCalls((built ??= deps()));
      } catch (e) {
        log.error({ err: errText(e) }, 'ai-voice sweeper: tick failed');
      } finally {
        running = false;
      }
    })();
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
