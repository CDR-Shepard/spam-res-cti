/**
 * One Twilio media stream = one AI conversation. The route (routes-stream.ts)
 * has already checked Twilio's signature on the upgrade; this waits for the
 * `start` frame, proves it belongs to a call WE placed (HMAC token over the
 * call id, the registry entry, the call sid, a live row), then opens the
 * OpenAI Realtime socket and starts the bridge.
 *
 * Every refusal or failure closes the stream AND hangs the call up over REST
 * — a person must never be left on a silent line. Media frames that arrive
 * while the start is being checked are dropped (a few ms of "hello").
 *
 * Bridge hooks: tools → service-tools.ts; transcript → batched writes;
 * a bridge-side end (OpenAI closed/error, time limit) → hang up, unless
 * another closer (end_call / transfer / voicemail) already owns the call.
 */
import { aiVoiceAvailable, type AppConfig } from '../config.js';
import { UUID_RE, TWILIO_CALL_SID_RE } from '../telephony/webhooks.js';
import { AiCallBridge, MIN_CALL_MS, type BridgeHooks, type BridgeLog, type BridgeOptions, type BridgeSocket, type EndReason } from './bridge.js';
import { obj, parseFrame, str, type Msg } from './bridge-frames.js';
import { buildInstructions, toolsFor } from './prompt.js';
import { promptSlots } from './prompt-context.js';
import { claimClose, getActiveCall, updateActiveCall, type ActiveAiCall, type ActiveBridge } from './registry.js';
import { localTimeFor } from './service.js';
import { handleToolCall, type ToolEffects } from './service-tools.js';
import type { AiCallStatus, AiCallStore } from './store.js';
import { TranscriptBuffer } from './transcript.js';
import { TRANSFER_RESULT_PATH, callbackUrl, transferTwiml, verifyStreamToken, type AiVoiceTwilio } from './twilio.js';
import { realtimeUrl } from './ws-adapter.js';

/** How long Twilio has to send `start` after the socket opens. */
export const START_TIMEOUT_MS = 10_000;
const WS_OPEN = 1;
/** `queued` too: a row whose post-create write failed is still a placed call. */
const LIVE_ROW_STATUSES: readonly AiCallStatus[] = ['queued', 'ringing', 'in_progress'];

export interface StreamSessionDeps {
  cfg: AppConfig;
  store: AiCallStore;
  twilio: AiVoiceTwilio;
  effects: ToolEffects;
  openRealtime: (url: string, apiKey: string) => BridgeSocket;
  createBridge?: (opts: BridgeOptions, hooks: BridgeHooks) => ActiveBridge;
  now: () => Date;
  log: BridgeLog;
  startTimeoutMs?: number;
}

export type StreamOutcome =
  | 'started'
  | 'bad_token'
  | 'no_call'
  | 'sid_mismatch'
  | 'duplicate'
  | 'not_live'
  | 'unavailable'
  | 'closed'
  | 'timeout'
  | 'error';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const defaultCreateBridge = (opts: BridgeOptions, hooks: BridgeHooks): ActiveBridge => new AiCallBridge(opts, hooks);

/** Handle one stream; resolves with what happened to its `start`. Never rejects. */
export function runStreamSession(socket: BridgeSocket, deps: StreamSessionDeps): Promise<StreamOutcome> {
  return new Promise((resolve) => {
    let handled = false;
    const finish = (o: StreamOutcome) => {
      handled = true;
      clearTimeout(timer);
      resolve(o);
    };
    const timer = setTimeout(() => {
      if (handled) return;
      deps.log.warn({}, 'ai-voice: no stream start in time');
      finish('timeout');
      safeClose(socket, deps.log);
    }, deps.startTimeoutMs ?? START_TIMEOUT_MS);
    socket.on('message', (raw) => {
      if (handled) return;
      const msg = parseFrame(raw);
      if (msg?.event !== 'start') return;
      handled = true;
      onStart(socket, obj(msg.start), deps).then(finish, (e: unknown) => {
        deps.log.error({ err: errText(e) }, 'ai-voice: stream start failed');
        finish('error');
      });
    });
    socket.on('close', () => {
      if (!handled) finish('closed');
    });
    socket.on('error', (e) => deps.log.warn({ err: e.message }, 'ai-voice: twilio stream socket error'));
  });
}

function safeClose(socket: BridgeSocket, log: BridgeLog): void {
  try {
    socket.close();
  } catch (e) {
    log.warn({ err: errText(e) }, 'ai-voice: stream close failed');
  }
}

async function onStart(socket: BridgeSocket, start: Msg, deps: StreamSessionDeps): Promise<StreamOutcome> {
  const params = obj(start.customParameters);
  const aiCallId = str(params.aiCallId);
  const callSid = str(start.callSid);

  const refuse = async (outcome: StreamOutcome, markFailed: boolean): Promise<StreamOutcome> => {
    deps.log.warn({ aiCallId: UUID_RE.test(aiCallId) ? aiCallId : '(invalid)', outcome }, 'ai-voice: stream refused');
    safeClose(socket, deps.log);
    if (TWILIO_CALL_SID_RE.test(callSid)) {
      await deps.twilio.hangup(callSid).catch((e: unknown) => deps.log.error({ err: errText(e) }, 'ai-voice: hangup failed'));
    }
    if (markFailed) {
      await deps.store.markFailed(aiCallId).catch((e: unknown) => deps.log.error({ err: errText(e) }, 'ai-voice: mark failed'));
    }
    return outcome;
  };

  if (!UUID_RE.test(aiCallId) || !verifyStreamToken(aiCallId, str(params.token), deps.cfg.SESSION_SECRET)) {
    return refuse('bad_token', false);
  }
  const entry = getActiveCall(aiCallId);
  if (!entry) return refuse('no_call', true);
  if (entry.callSid !== null && entry.callSid !== callSid) return refuse('sid_mismatch', false);
  if (entry.bridge !== null) {
    // One conversation per call: a second stream is dropped without touching the live one.
    deps.log.warn({ aiCallId }, 'ai-voice: duplicate stream for a live call');
    safeClose(socket, deps.log);
    return 'duplicate';
  }
  if (!aiVoiceAvailable(deps.cfg)) return refuse('unavailable', true);

  try {
    const row = await deps.store.get(aiCallId);
    if (!row || !(LIVE_ROW_STATUSES as readonly string[]).includes(row.status)) return refuse('not_live', false);
    if (socket.readyState !== WS_OPEN) return 'closed';
    startBridge(socket, { ...entry, callSid }, str(start.streamSid), deps);
  } catch (e) {
    deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: could not start the conversation');
    getActiveCall(aiCallId)?.bridge?.stop();
    return refuse('error', true);
  }
  // Bookkeeping only: a failed status write must not end a conversation that is running.
  await deps.store
    .updateWhereStatus(aiCallId, LIVE_ROW_STATUSES, { status: 'in_progress', startedAt: deps.now() })
    .catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: in-progress write failed'));
  deps.log.info({ aiCallId }, 'ai-voice: stream started');
  return 'started';
}

function startBridge(socket: BridgeSocket, entry: ActiveAiCall & { callSid: string }, streamSid: string, deps: StreamSessionDeps): void {
  const { cfg } = deps;
  const instructions = buildInstructions({ ...entry.prompt, localTime: localTimeFor(entry.toE164, deps.now()) });
  // The times the prompt lists are exactly the ones the agent can name and book (Fix 1, M-2).
  const slots = promptSlots(entry.prompt.slots);
  const openai = deps.openRealtime(realtimeUrl(cfg.AI_VOICE_MODEL), cfg.OPENAI_API_KEY ?? '');
  const transcript = new TranscriptBuffer((lines) => deps.store.appendTranscript(entry.aiCallId, lines), { log: deps.log });
  let bridge: ActiveBridge | null = null;
  const hooks: BridgeHooks = {
    onTool: (name, args) =>
      handleToolCall(name, args, {
        ctx: {
          store: deps.store,
          aiCallId: entry.aiCallId,
          orgId: entry.orgId,
          toE164: entry.toE164,
          log: deps.log,
          now: deps.now,
          slots,
        },
        effects: deps.effects,
        call: {
          callSid: entry.callSid,
          twilio: deps.twilio,
          claimClose: () => claimClose(entry.aiCallId),
          waitForPlayback: () => bridge?.waitForPlayback() ?? Promise.resolve(),
          stopStream: () => bridge?.stop(),
          transferTwiml: (reason) => transferFor(entry, cfg, reason),
        },
      }),
    onTranscript: (line) => transcript.push(line),
    onEnd: (reason, detail) => onBridgeEnd(entry, reason, detail, () => bridge, transcript, deps),
    log: deps.log,
  };
  bridge = (deps.createBridge ?? defaultCreateBridge)(
    {
      twilio: socket,
      openai,
      streamSid,
      instructions,
      tools: toolsFor(slots),
      voice: cfg.AI_VOICE_VOICE,
      model: cfg.AI_VOICE_MODEL,
      reasoningEffort: cfg.AI_VOICE_REASONING,
      vadEagerness: cfg.AI_VOICE_VAD_EAGERNESS,
      maxCallMs: Math.max(MIN_CALL_MS, cfg.AI_VOICE_MAX_CALL_SECONDS * 1000),
    },
    hooks,
  );
  updateActiveCall(entry.aiCallId, { bridge, transcript, callSid: entry.callSid });
  bridge.start();
}

/** The rep sees the prospect's number, name and record, and that this is an AI hand-off. */
function transferFor(entry: ActiveAiCall, cfg: AppConfig, reason: string): string {
  const r = entry.record;
  const name = r ? (r.objectType === 'Opportunity' ? r.firstName : r.name) : 'AI test call';
  return transferTwiml({
    userId: entry.handoffUserId,
    callerId: entry.toE164,
    actionUrl: callbackUrl(cfg.API_PUBLIC_URL, TRANSFER_RESULT_PATH, entry.aiCallId),
    caller: { ...(name ? { name } : {}), ...(r ? { popRecordId: r.recordId } : {}) },
    reason,
  });
}

function onBridgeEnd(
  entry: ActiveAiCall & { callSid: string },
  reason: EndReason,
  detail: string | undefined,
  bridge: () => ActiveBridge | null,
  transcript: TranscriptBuffer,
  deps: StreamSessionDeps,
): void {
  const { aiCallId } = entry;
  deps.log.info({ aiCallId, reason, detail }, 'ai-voice: conversation ended');
  void transcript.flush();
  if (reason === 'twilio_closed') return; // hung up, redirected, or stopped — finalize does the rest
  if (!claimClose(aiCallId)) return; // end_call / transfer / voicemail already owns the call
  void (async () => {
    if (reason !== 'max_duration') {
      await deps.store.markFailed(aiCallId).catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: mark failed'));
    }
    await deps.twilio
      .hangup(entry.callSid)
      .catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: hangup failed, closing the stream'));
    bridge()?.stop();
  })();
}
