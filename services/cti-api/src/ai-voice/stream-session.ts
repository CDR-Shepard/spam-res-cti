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
 * turn stats → one log line + ai_calls.turn_stats (best effort);
 * a bridge-side end (OpenAI closed/error, time limit) → hang up, unless
 * another closer (end_call / transfer / voicemail) already owns the call.
 *
 * An INBOUND call (a test phone called the AI; inbound-call.ts) runs the same
 * way with the inbound prompt + line rules, INBOUND_TOOLS (end_call only: it
 * saves nothing mid-call) and INBOUND_OPENER. Twilio sends it no status
 * callback, so it is finalized here when its conversation ends, however it
 * ends; finalize first fills its details and status in from the transcript
 * (service-finalize.ts, caller-details.ts).
 */
import type { AiCallTurnStats, AppointmentSlot } from '@cti/contracts';
import { aiVoiceAvailable, type AppConfig } from '../config.js';
import { UUID_RE, TWILIO_CALL_SID_RE } from '../telephony/webhooks.js';
import { AiCallBridge, MIN_CALL_MS, type BridgeHooks, type BridgeLog, type BridgeOptions, type BridgeSocket, type EndReason } from './bridge.js';
import { obj, parseFrame, str, type Msg } from './bridge-frames.js';
import type { CallerDetailsDeps } from './caller-details.js';
import { INBOUND_OPENER } from './bridge-session.js';
import { sayGoodbyeWithNumber } from './bridge-tools.js';
import { INBOUND_TOOLS, buildInboundInstructions, buildInstructions, toolsFor, type PromptInput } from './prompt.js';
import { phoneForms, promptSlots } from './prompt-context.js';
import { logTemplateError } from './prompt-saved.js';
import { claimClose, getActiveCall, updateActiveCall, type ActiveAiCall, type ActiveBridge } from './registry.js';
import { localTimeFor } from './service.js';
import { finalizeAiCall } from './service-finalize.js';
import { handleToolCall, type ToolEffects } from './service-tools.js';
import type { AiCallStatus, AiCallStore } from './store.js';
import { TranscriptBuffer } from './transcript.js';
import { TRANSFER_RESULT_PATH, callbackUrl, testTransferOffTwiml, transferTwiml, verifyStreamToken, type AiVoiceTwilio } from './twilio.js';
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
  /** The model that fills an inbound call's details from its transcript when it ends; absent = none (the call closes `incomplete`). */
  details?: CallerDetailsDeps;
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

/**
 * What the agent is told and may do. Both directions get the goodbye guard (a silent end_call after the caller spoke
 * is sent back once). An inbound call (a test phone called the AI) gets the inbound prompt + line rules,
 * INBOUND_TOOLS and the quick INBOUND_OPENER; an outbound call its prompt and tools (no opener option), and a guard
 * goodbye that gives our callback number.
 */
function conversationFor(
  entry: ActiveAiCall,
  slots: AppointmentSlot[],
  deps: StreamSessionDeps,
): Pick<BridgeOptions, 'instructions' | 'tools' | 'opener' | 'goodbyeBeforeEnd' | 'goodbyeNote'> {
  // Part 6 B: a practice call rings a test number but says the seller's local time (the record's phone; service.ts).
  const prompt: PromptInput = { ...entry.prompt, localTime: localTimeFor(entry.localTimeE164 ?? entry.toE164, deps.now()) };
  if (entry.direction === 'inbound') {
    return {
      instructions: buildInboundInstructions(prompt, logTemplateError(deps.log)),
      tools: INBOUND_TOOLS,
      opener: INBOUND_OPENER,
      goodbyeBeforeEnd: true,
    };
  }
  return {
    instructions: buildInstructions(prompt, logTemplateError(deps.log)),
    tools: toolsFor(slots),
    goodbyeBeforeEnd: true,
    goodbyeNote: sayGoodbyeWithNumber(phoneForms(prompt.callbackNumber)?.spoken ?? null),
  };
}

function startBridge(socket: BridgeSocket, entry: ActiveAiCall & { callSid: string }, streamSid: string, deps: StreamSessionDeps): void {
  const { cfg } = deps;
  // The times the prompt lists are exactly the ones the agent can name and book (Fix 1, M-2).
  const slots = promptSlots(entry.prompt.slots, entry.prompt.address);
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
          isTest: entry.isTest,
          ...(entry.direction === 'inbound' ? { direction: 'inbound' as const } : {}),
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
    onStats: (stats) => saveTurnStats(entry.aiCallId, stats, deps),
    onEnd: (reason, detail) => onBridgeEnd(entry, reason, detail, () => bridge, transcript, deps),
    log: deps.log,
  };
  bridge = (deps.createBridge ?? defaultCreateBridge)(
    {
      twilio: socket,
      openai,
      streamSid,
      ...conversationFor(entry, slots, deps),
      voice: cfg.AI_VOICE_VOICE,
      model: cfg.AI_VOICE_MODEL,
      reasoningEffort: cfg.AI_VOICE_REASONING,
      vadEagerness: cfg.AI_VOICE_VAD_EAGERNESS,
      bargeIn: cfg.AI_VOICE_BARGE_IN,
      transcribeModel: cfg.AI_VOICE_TRANSCRIBE_MODEL,
      turnDetection: cfg.AI_VOICE_TURN_DETECTION,
      silenceMs: cfg.AI_VOICE_SILENCE_MS,
      overlapJudge: cfg.AI_VOICE_OVERLAP_JUDGE,
      stopMs: cfg.AI_VOICE_STOP_MS,
      maxCallMs: Math.max(MIN_CALL_MS, cfg.AI_VOICE_MAX_CALL_SECONDS * 1000),
    },
    hooks,
  );
  updateActiveCall(entry.aiCallId, { bridge, transcript, callSid: entry.callSid });
  bridge.start();
}

/** The call's turn-taking numbers: one log line and the `turn_stats` column (best effort). */
function saveTurnStats(aiCallId: string, stats: AiCallTurnStats, deps: StreamSessionDeps): void {
  deps.log.info({ aiCallId, turnStats: stats }, 'ai-voice: turn stats');
  void deps.store
    .update(aiCallId, { turnStats: stats })
    .catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: turn stats not saved'));
}

/** The rep sees the prospect's number, name and record, and that this is an AI hand-off. A test call with AI_VOICE_TEST_TRANSFER=off rings no one. */
function transferFor(entry: ActiveAiCall, cfg: AppConfig, reason: string): string {
  if (entry.isTest && cfg.AI_VOICE_TEST_TRANSFER === 'off') return testTransferOffTwiml();
  const r = entry.record;
  const name = r ? (r.objectType === 'Opportunity' ? r.firstName : r.name) : 'AI test call';
  return transferTwiml({
    userId: entry.handoffUserId,
    // A <Dial callerId> must be a phone number: a browser test leg (plan 1E, `client:…`) shows the AI's own number.
    callerId: entry.toE164.startsWith('client:') ? entry.fromE164 : entry.toE164,
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
  if (entry.direction === 'inbound') return void endInboundCall(entry, reason, bridge, deps);
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

/**
 * The end of an inbound call. A bridge-side end (OpenAI closed/error, time limit) hangs up first, as for an outbound
 * call, unless end_call already owns the call. Then, however it ended, the row is finalized here: Twilio sends an
 * inbound call no status callback (finalize also tears down the live entry and writes the last transcript lines).
 */
async function endInboundCall(
  entry: ActiveAiCall & { callSid: string },
  reason: EndReason,
  bridge: () => ActiveBridge | null,
  deps: StreamSessionDeps,
): Promise<void> {
  const { aiCallId } = entry;
  if (reason !== 'twilio_closed' && claimClose(aiCallId)) {
    if (reason !== 'max_duration') {
      await deps.store.markFailed(aiCallId).catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: mark failed'));
    }
    await deps.twilio
      .hangup(entry.callSid)
      .catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: hangup failed, closing the stream'));
    bridge()?.stop();
  }
  const finalizing = { store: deps.store, log: deps.log, ...(deps.details ? { details: deps.details } : {}) };
  await finalizeAiCall(finalizing, aiCallId, { callStatus: 'completed', durationSeconds: null, endedAt: deps.now() }).catch((e: unknown) =>
    deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: inbound call not finalized — the sweeper will close it'),
  );
}
