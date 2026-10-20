/**
 * Deploys without cutting live AI calls. When Railway replaces cti-api it sends the old process SIGTERM, and closing the
 * server closed every media stream, so each call in progress was cut (owner's test calls, 2026-10-19: two calls cut a few
 * seconds after a deploy). Now server.ts first waits here, until every live call in this process has ended or the
 * longest call could have (AI_VOICE_MAX_CALL_SECONDS and a margin), then closes the server. Railway has to give the
 * process that long before it kills it: RAILWAY_DEPLOYMENT_DRAINING_SECONDS on @cti/api (runbook).
 *
 * A live call is an open Twilio media stream (the bridge closes the socket when the call ends, however it ends) or its
 * after-call work in this process: an inbound call is finalized here once its stream ends, its details filled in by a
 * model first (an outbound call is finalized by its status callback, which reaches the new process). After the last one
 * ends, a short settle catches work that starts just after its stream closes. New traffic already goes to the new
 * deployment; a stream that still arrives here is answered and waited for too, while the internal trigger refuses new
 * calls (routes-internal.ts: outreach-api retries them on the new process). A second signal stops the wait at once.
 */
import { errText, type BridgeLog } from './bridge-tools.js';

/** Past AI_VOICE_MAX_CALL_SECONDS: a call stopped at its limit still hangs up and closes its stream. */
export const DRAIN_MARGIN_SECONDS = 30;
/** After the last call and its tracked work end: for work that starts just after a stream closes. */
export const DRAIN_SETTLE_MS = 5_000;

/** The socket surface the drain needs: one 'close' event. */
export interface ClosableSocket {
  once(event: 'close', listener: () => void): unknown;
}

export type DrainResult = 'drained' | 'deadline' | 'forced';

const openStreams = new Set<ClosableSocket>();
const afterCallWork = new Set<Promise<unknown>>();
const onEmpty = new Set<() => void>();
let draining = false;

const busy = (): boolean => openStreams.size > 0 || afterCallWork.size > 0;

function wakeIfIdle(): void {
  if (busy()) return;
  for (const wake of [...onEmpty]) wake();
}

/** Counts `socket` as a live call until it closes. */
export function trackLiveStream(socket: ClosableSocket): void {
  openStreams.add(socket);
  socket.once('close', () => {
    openStreams.delete(socket);
    wakeIfIdle();
  });
}

/** Counts `work` (a call's after-call work) as part of a live call until it settles. Returns `work` itself. */
export function trackAfterCallWork<T>(work: Promise<T>): Promise<T> {
  afterCallWork.add(work);
  const done = () => {
    afterCallWork.delete(work);
    wakeIfIdle();
  };
  work.then(done, done);
  return work;
}

export function liveStreamCount(): number {
  return openStreams.size;
}

export function afterCallWorkCount(): number {
  return afterCallWork.size;
}

/** True once shutdown has started: no new calls are placed from this process. */
export function isDraining(): boolean {
  return draining;
}

/**
 * Resolves with `onTimeout` after `ms`; with 'drained' as soon as the last stream and work end, when `untilEmpty`; with
 * 'forced' as soon as `signal` aborts.
 */
function wait(ms: number, onTimeout: DrainResult, untilEmpty: boolean, signal: AbortSignal | undefined): Promise<DrainResult> {
  return new Promise((resolve) => {
    const done = (result: DrainResult) => {
      clearTimeout(timer);
      onEmpty.delete(empty);
      signal?.removeEventListener('abort', forced);
      resolve(result);
    };
    const empty = () => done('drained');
    const forced = () => done('forced');
    const timer = setTimeout(() => done(onTimeout), ms);
    if (untilEmpty) onEmpty.add(empty);
    signal?.addEventListener('abort', forced, { once: true });
  });
}

/**
 * Waits for this process's live AI calls and their after-call work to end (see the module comment). Never throws. With
 * none it returns at once; otherwise, once they have ended, it waits `settleMs` more.
 */
export async function drainLiveCalls(o: { maxWaitMs: number; settleMs: number; signal?: AbortSignal; log: BridgeLog }): Promise<DrainResult> {
  draining = true;
  if (o.signal?.aborted) return 'forced';
  if (!busy()) return 'drained';
  const counts = () => ({ live: openStreams.size, finishing: afterCallWork.size });
  o.log.info({ ...counts(), maxWaitMs: o.maxWaitMs }, 'ai-voice: draining live calls before shutdown');
  const deadline = Date.now() + o.maxWaitMs;
  // A call or work that starts during the settle is waited for too, until the same deadline: at most maxWaitMs + settleMs.
  while (busy()) {
    const left = deadline - Date.now();
    const calls = left > 0 ? await wait(left, 'deadline', true, o.signal) : 'deadline';
    if (calls === 'deadline') {
      o.log.warn(counts(), 'ai-voice: drain deadline reached; closing the calls still live');
      return 'deadline';
    }
    if (calls === 'forced') {
      o.log.warn(counts(), 'ai-voice: shutdown forced; closing the calls still live');
      return 'forced';
    }
    const settled = await wait(o.settleMs, 'drained', false, o.signal);
    if (settled === 'forced') return 'forced';
  }
  o.log.info({}, 'ai-voice: live calls drained');
  return 'drained';
}

/**
 * The process's SIGTERM/SIGINT handler (server.ts). The first signal stops the timers, waits for the live calls
 * (`drain`), then closes the server; a later one aborts the drain's signal so the server closes now. It never rejects
 * (a signal handler's rejection would only be logged as stray): a server that fails to close is logged and leaves exit
 * code 1 for when the process ends, without cutting short what is still closing.
 */
export function gracefulClose(o: {
  stopTimers: () => void;
  drain: (signal: AbortSignal) => Promise<DrainResult>;
  closeServer: () => Promise<void>;
  log: BridgeLog;
  setExitCode: (code: number) => void;
}): () => Promise<void> {
  const force = new AbortController();
  let closing: Promise<void> | null = null;
  const shutDown = async (): Promise<void> => {
    o.stopTimers();
    await o.drain(force.signal);
    try {
      await o.closeServer();
    } catch (err) {
      o.log.error({ err: errText(err) }, 'cti-api: server close failed');
      o.setExitCode(1);
    }
  };
  return () => {
    if (closing) {
      force.abort();
      return closing;
    }
    closing = shutDown();
    return closing;
  };
}

/** Test hook. */
export function resetDrainForTests(): void {
  openStreams.clear();
  afterCallWork.clear();
  onEmpty.clear();
  draining = false;
}
