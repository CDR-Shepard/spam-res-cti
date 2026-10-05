/**
 * The in-process registry of AI calls this instance placed and has not
 * finished: the record context cached at placement (so the stream route never
 * re-reads Salesforce), the live bridge, the transcript buffer, and the one
 * `closing` latch that lets exactly ONE of {end_call, transfer, voicemail,
 * bridge failure} act on the call.
 *
 * Entries are replaced, never mutated. Each entry also expires on its own
 * (unref'd timer) so a lost status callback cannot leak it.
 *
 * Per-process by design: a call answered after a restart (or on another
 * replica) finds no entry and is hung up — cti-api runs one replica.
 */
import type { AiCallBridge, BridgeLog } from './bridge.js';
import type { PromptInput } from './prompt.js';
import type { AiCallRecord } from './record.js';
import type { TranscriptBuffer } from './transcript.js';

/** The bridge surface the service drives (a fake in tests). */
export type ActiveBridge = Pick<AiCallBridge, 'start' | 'silence' | 'waitForPlayback' | 'stop'>;

export interface ActiveAiCall {
  aiCallId: string;
  orgId: string;
  startedBy: string;
  /** Who a transfer rings. */
  handoffUserId: string;
  /** Null until `calls.create` returns. */
  callSid: string | null;
  toE164: string;
  fromE164: string;
  isTest: boolean;
  record: AiCallRecord | null;
  /** Everything the prompt needs except the local time, which is taken when the call is answered. */
  prompt: Omit<PromptInput, 'localTime'>;
  bridge: ActiveBridge | null;
  transcript: TranscriptBuffer | null;
  closing: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

const active = new Map<string, ActiveAiCall>();
const expiries = new Map<string, Timer>();

export function getActiveCall(aiCallId: string): ActiveAiCall | null {
  return active.get(aiCallId) ?? null;
}

/** Register (or replace) an entry; `ttlMs` arms its expiry. */
export function registerActiveCall(entry: ActiveAiCall, ttlMs?: number, log?: BridgeLog): void {
  active.set(entry.aiCallId, entry);
  if (ttlMs === undefined) return;
  const old = expiries.get(entry.aiCallId);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    expiries.delete(entry.aiCallId);
    if (!active.has(entry.aiCallId)) return;
    log?.warn({ aiCallId: entry.aiCallId }, 'ai-voice: registry entry expired');
    void closeActiveCall(entry.aiCallId);
  }, ttlMs);
  timer.unref?.();
  expiries.set(entry.aiCallId, timer);
}

/** Replace fields of an entry; null when there is none. */
export function updateActiveCall(aiCallId: string, patch: Partial<Omit<ActiveAiCall, 'aiCallId'>>): ActiveAiCall | null {
  const cur = active.get(aiCallId);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  active.set(aiCallId, next);
  return next;
}

export function dropActiveCall(aiCallId: string): ActiveAiCall | null {
  const cur = active.get(aiCallId) ?? null;
  active.delete(aiCallId);
  const timer = expiries.get(aiCallId);
  if (timer) clearTimeout(timer);
  expiries.delete(aiCallId);
  return cur;
}

/** True for exactly one caller: the first to claim the right to end/transfer this call. */
export function claimClose(aiCallId: string): boolean {
  const cur = active.get(aiCallId);
  if (!cur || cur.closing) return false;
  active.set(aiCallId, { ...cur, closing: true });
  return true;
}

/** Drop the entry, stop its bridge and write its last transcript lines. Idempotent. */
export async function closeActiveCall(aiCallId: string): Promise<void> {
  const cur = dropActiveCall(aiCallId);
  if (!cur) return;
  cur.bridge?.stop();
  await cur.transcript?.close();
}

/** Test hook. */
export function clearActiveCalls(): void {
  for (const id of [...active.keys()]) dropActiveCall(id);
}
