/**
 * The live-call bridge: Twilio Media Streams ⇄ OpenAI Realtime. Pure plumbing
 * over two injected ws-like sockets (no network, no DB). Both sides speak
 * base64 μ-law 8 kHz, so audio passes straight through.
 *
 * The bridge fails closed until OpenAI confirms the session (`session.updated`):
 * no agent audio reaches Twilio before it, and an OpenAI `error` before it, or
 * no confirmation within SESSION_READY_TIMEOUT_MS of the socket opening, ends
 * the call (`error`, "session not configured: …"). Later errors are only logged.
 *
 * Caller audio is always forwarded. Agent audio goes to Twilio chunk by chunk,
 * each followed by a `mark`, so a barge-in can `clear` Twilio and truncate the
 * assistant item where the caller stopped hearing it (bridge-playback.ts). The
 * model waits for the caller's "Hello?" and opens the call itself after
 * OPENER_DELAY_MS of silence. Tool calls arrive on `response.done` and run via
 * `hooks.onTool`. OpenAI messages queue (bounded) until started and open, so
 * `session.update` always goes first (bridge-sockets.ts). Audio payloads are never logged.
 *
 * In `instant` barge-in mode (the BridgeOptions default; the service default is `gate`) OpenAI's VAD answers each caller turn
 * and any caller sound cuts the agent. In `gate` mode the bridge owns the turns:
 * it answers each committed caller turn with one `response.create` at a time (never
 * over a caller mid-utterance), keeps talking through listening sounds and cuts the agent (never the opener)
 * only on a real interruption (bridge-overlap.ts; spec
 * docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.1). Its default `sound` judge
 * (§4.5) measures how long the caller keeps talking from their audio (bridge-sound.ts), not from transcribed words.
 * Gate mode also checks in after silence (bridge-silence.ts, §4.2). In both modes the bridge
 * times each answered caller turn and reports the call's numbers once via `onStats`, just
 * before `onEnd` (bridge-turn-stats.ts, §4.3), and logs where each one's time went (bridge-turn-timing.ts).
 *
 * Once the call is closing (a hangup/transfer tool result, or `silence()`) the
 * agent is never asked to speak again; in instant mode a hangup/transfer result
 * also turns off VAD auto-responses (`create_response: false`). If the call ends from the OpenAI side
 * or hits its time limit, the bridge silences the agent, reports `onEnd`, and
 * closes both sockets after END_GRACE_MS unless the service calls `stop()`
 * first — closing the stream lets Twilio continue past </Connect> and end the
 * call even if the service never hangs up.
 */
import type { AiCallTurnStats } from '@cti/contracts';
import { obj, openAiErrorFields, str, type Msg } from './bridge-frames.js';
import { DEFAULT_STOP_MS, LATE_OVERLAP_MS, OverlapGate, type InterruptWhy, type OverlapJudge } from './bridge-overlap.js';
import { PCMU_BYTES_PER_MS, PlaybackTracker, base64Bytes, type ClearTimer, type SetTimer, type Truncation } from './bridge-playback.js';
import {
  DEFAULT_SILENCE_MS,
  DEFAULT_TURN_DETECTION,
  openerItem,
  sessionUpdate,
  stopAutoResponses,
  truncate,
  type OpenerOption,
  type ReasoningEffort,
  type TurnDetection,
  type TurnDetectionSettings,
  type VadEagerness,
} from './bridge-session.js';
import { HOLD_CHECK_MS, SILENCE_CHECK_MS, SilenceCheck, silenceNoteItem } from './bridge-silence.js';
import { CallerSoundMeter } from './bridge-sound.js';
import { BridgeSockets, type BridgeSocket } from './bridge-sockets.js';
import { TurnStatsCollector, type BargeInMode } from './bridge-turn-stats.js';
import { TurnTiming, heldBy } from './bridge-turn-timing.js';
import { ANSWER_THEM_FIRST, endCallArgs, endCallOutcome, errText, followUpAfterTools, functionCalls, runToolBatch, type BridgeLog, type FunctionCall, type Spoke, type ToolResult } from './bridge-tools.js';
import { CallerLines, optedOut, waitingOnAnswer } from './caller-question.js';
import type { ToolName } from './prompt.js';

export type { BargeInMode, BridgeLog, BridgeSocket, OverlapJudge, ReasoningEffort, ToolResult, TurnDetection, VadEagerness };

/** The transcriber before 2026-10-09; the bridge's default so a bare BridgeOptions behaves as before. */
export const LEGACY_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

/** How long after `session.updated` the agent waits for the caller before opening. */
export const OPENER_DELAY_MS = 3000;
/** End_call outcomes the goodbye guard never sends back: an opt-out must be written at once, and a hang-up has no one to say goodbye to. */
const NEVER_SENT_BACK: ReadonlySet<string> = new Set(['do_not_call', 'wrong_number', 'hung_up']);
/** How long the goodbye guard waits for the caller's final words before it decides (a transcript can trail the commit). */
export const FINAL_WORDS_WAIT_MS = 1500;
/** How many silent end_calls a call sends back to answer the caller ('answer' or 'resume') before the goodbye-only ask. */
const MAX_ANSWER_REFUSALS = 2;
/**
 * How the goodbye guard settles a silent end_call: answer their question in a speech-only turn ('answer'); answer a
 * caller who spoke again as usual, tools and all ('resume'); say a goodbye and end ('goodbye'); 'ended': the call ended
 * while it waited, and finish already ran the end_call; null: run it.
 */
type EndRefusal = 'answer' | 'resume' | 'goodbye' | 'ended' | null;
/** Tools after which a sent-back end_call is stale: the call went somewhere else (end_call itself is handled apart). */
const MOVES_PAST_AN_END: ReadonlySet<string> = new Set<ToolName>([
  'book_appointment',
  'book_priority_appointment',
  'schedule_callback',
  'mark_do_not_call',
  'transfer_to_rep',
]);

/** Default cap on waiting for the agent's last words before a hangup/transfer (stretched to the audio still queued: bridge-playback.ts). */
export const PLAYBACK_DRAIN_MAX_MS = 8000;
/** After a bridge-side end, how long the service has to hang up/redirect before the bridge closes the stream. */
export const END_GRACE_MS = 10_000;
/** How long after the OpenAI socket opens (and the session is sent) to wait for `session.updated`. */
export const SESSION_READY_TIMEOUT_MS = 5000;
/** Shortest accepted `maxCallMs`. */
export const MIN_CALL_MS = 10_000;

export type EndReason = 'twilio_closed' | 'openai_closed' | 'max_duration' | 'error';

export interface BridgeHooks {
  onTool(name: ToolName, args: unknown): Promise<ToolResult>;
  onTranscript(entry: { role: 'agent' | 'caller' | 'system'; text: string; at: Date }): void;
  onEnd(reason: EndReason, detail?: string): void;
  /** Once, just before onEnd: this call's turn-taking numbers (spec 2026-10-09 §4.3). */
  onStats?(stats: AiCallTurnStats): void;
  log: BridgeLog;
}

export interface BridgeOptions {
  twilio: BridgeSocket;
  openai: BridgeSocket;
  streamSid: string;
  instructions: string;
  tools: readonly unknown[];
  voice: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  vadEagerness: VadEagerness;
  /** 'gate' (spec 2026-10-09) or 'instant' (default here; the service passes AI_VOICE_BARGE_IN). */
  bargeIn?: BargeInMode;
  /** Session transcriber (default LEGACY_TRANSCRIBE_MODEL; the service passes AI_VOICE_TRANSCRIBE_MODEL). */
  transcribeModel?: string;
  /** What ends the caller's turn (default `semantic_vad`, as before; the service passes AI_VOICE_TURN_DETECTION). */
  turnDetection?: TurnDetection;
  /** `server_vad` only: the silence that ends the caller's turn, in ms (default 500; the service passes AI_VOICE_SILENCE_MS). */
  silenceMs?: number;
  /** Gate mode only: 'sound' (spec §4.5) or 'words' (default here, the 2026-10-09 gate; the service passes AI_VOICE_OVERLAP_JUDGE). */
  overlapJudge?: OverlapJudge;
  /** Sound judge only: the caller's sound this long over the agent stops it, in ms (default DEFAULT_STOP_MS; the service passes AI_VOICE_STOP_MS). */
  stopMs?: number;
  maxCallMs: number;
  /** How the agent opens the call (default OPENER_DELAY_MS and OPENER_PROMPT; an inbound call passes INBOUND_OPENER). */
  opener?: OpenerOption;
  /**
   * An end_call that comes with no audio after the caller spoke is sent back once, asking for a spoken goodbye first,
   * so the caller is never hung up on without a word (simulated inbound calls, 2026-10-18; outbound too since
   * 2026-10-19). The goodbye is a speech-only response (no tool calls: a second silent end_call came back instead,
   * 2026-10-19), and once it is done the bridge runs the sent-back end_call itself — unless the caller spoke again first.
   * Since 2026-10-20 a caller whose last words are a question is answered instead of hung up on (decideRefusal).
   */
  goodbyeBeforeEnd?: boolean;
  /** goodbyeBeforeEnd: how long to wait for the caller's final words before deciding (default FINAL_WORDS_WAIT_MS). */
  finalWordsWaitMs?: number;
  /** goodbyeBeforeEnd: an end_call with outcome not_interested is never answered, only said goodbye to (outbound: a seller who declined). */
  goodbyeOnNotInterested?: boolean;
  /** What a sent-back end_call is answered with (default SAY_GOODBYE_FIRST; outbound: sayGoodbyeWithNumber). */
  goodbyeNote?: string;
  now?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
}

export class AiCallBridge {
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly playback: PlaybackTracker;
  private readonly gate: OverlapGate;
  /** Gate mode with the sound judge only: how long the caller's current sound has run, from every inbound frame. */
  private readonly meter: CallerSoundMeter | null;
  private readonly silenceCheck: SilenceCheck;
  private readonly stats: TurnStatsCollector;
  private readonly timing: TurnTiming;
  private readonly bargeIn: BargeInMode;
  /** The turn-detection settings with their defaults applied (sent in the session and again when the call closes). */
  private readonly vad: TurnDetectionSettings;
  private readonly sockets: BridgeSockets;
  private sessionReady = false;
  private callerSpoke = false;
  private openerSent = false;
  private responseActive = false;
  /** Our response.create is in flight (response.created not seen yet). */
  private responsePending = false;
  /** Gate mode: the event_id of that create, so only an error about it releases it. */
  private pendingCreateId = '';
  private createSeq = 0;
  /** The active response has forwarded audio to Twilio. */
  private responseHasAudio = false;
  /** We cancelled the active response (the gate cut it, or it was dropped unheard): not the agent speaking, never cancelled twice. */
  private responseCut = false;
  /** The item of the active response's last forwarded audio, and the last agent line it said (both reset on response.created). */
  private responseItemId = '';
  private lastAgentLine = '';
  /** Gate mode: the caller started talking while our response.create was in flight; cancel it once created. */
  private cancelWhenCreated = false;
  /** Tool batches queued or running (instant mode can queue two). */
  private toolBatches = 0;
  /** A turn wants an answer while a response or a tool batch is still going. */
  private wantResponse = false;
  /** A late overlap ("yeah sure" over the end of a question): answer once the agent's audio has played. */
  private answerAfterPlayback = false;
  private callerTalking = false;
  /** The caller stopped and OpenAI has not committed that item yet: a turn is about to be answered. */
  private awaitingCommit: string | null = null;
  /** The agent called wait_for_user and nobody has spoken since. */
  private holding = false;
  private agentSpoke = false;
  /** goodbyeBeforeEnd: a caller turn (any commit, overlaps included) since the first audio of the agent's latest spoken response. */
  private callerSpokeSinceAgent = false;
  /** goodbyeBeforeEnd sends back at most one end_call a call. */
  private silentEndRefused = false;
  /** goodbyeBeforeEnd: caller turns that drop an owed goodbye (onCallerTurn), counted to see one during decideRefusal's wait. */
  private callerTurns = 0;
  /** goodbyeBeforeEnd: the caller's words since the agent last spoke, to tell a question waiting on an answer. */
  private readonly callerLines: CallerLines;
  /** goodbyeBeforeEnd: silent end_calls sent back to answer the caller (MAX_ANSWER_REFUSALS a call). */
  private answerRefusals = 0;
  /**
   * goodbyeBeforeEnd: the answer to a caller still talking is owed, and is speech only (until the agent's audio starts;
   * the sent-back end_call stays unrun until then, so a hang-up first still records it).
   */
  private answerOwed = false;
  /** goodbyeBeforeEnd: the sent-back end_call, run once its speech-only goodbye is done (null: none owed, or the caller spoke again). */
  private owedEnd: { args: unknown } | null = null;
  /** goodbyeBeforeEnd: a goodbye that was partly heard got cut; the guard re-arms only once the agent speaks again. */
  private rearmOnSpeech = false;
  /**
   * goodbyeBeforeEnd: a sent-back end_call the conversation has not moved past. If the call ends first (the caller hung
   * up during the goodbye), finish runs it, so its outcome and summary are still recorded. Forgotten once the caller
   * speaks again before the goodbye, the agent speaks again after a cut one, or an end_call or a booking, callback,
   * do-not-call or transfer runs (MOVES_PAST_AN_END): an outcome withdrawn since must never be recorded (re-review
   * 2026-10-19: it overwrote the booking made since).
   */
  private unrunEnd: { args: unknown } | null = null;
  /** The first agent item that played: the opener, never cut by the gate. */
  private openerItemId: string | null = null;
  /** Committed caller turns the gate is still judging: when it cuts the agent, they are answered at once. */
  private judgedTurns: ReadonlySet<string> = new Set();
  /** Caller audio handed to OpenAI so far, in ms (for endpoint timing). */
  private sentAudioMs = 0;
  private silenced = false;
  /** No further `response.create` once a tool ended the conversation or the agent was silenced. */
  private closing = false;
  /** VAD auto-responses were turned off (sent once, when a tool ends the conversation). */
  private autoResponsesOff = false;
  private truncated = new Set<string>();
  private ended = false;
  private openerTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private backstopTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private toolChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: BridgeOptions,
    private readonly hooks: BridgeHooks,
  ) {
    if (!Number.isFinite(opts.maxCallMs) || opts.maxCallMs < MIN_CALL_MS) {
      throw new RangeError(`maxCallMs must be a finite number >= ${MIN_CALL_MS}`);
    }
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.callerLines = new CallerLines({ setTimer: this.setTimer, clearTimer: this.clearTimer });
    this.bargeIn = opts.bargeIn ?? 'instant';
    this.vad = {
      vadEagerness: opts.vadEagerness,
      turnDetection: opts.turnDetection ?? DEFAULT_TURN_DETECTION,
      silenceMs: Number.isFinite(opts.silenceMs) ? (opts.silenceMs as number) : DEFAULT_SILENCE_MS,
    };
    this.playback = new PlaybackTracker({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onDrained: () => this.onAgentFinished(),
    });
    const judge = opts.overlapJudge ?? 'words';
    this.meter = this.bargeIn === 'gate' && judge === 'sound' ? new CallerSoundMeter() : null;
    this.gate = new OverlapGate({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      judge,
      stopMs: Number.isFinite(opts.stopMs) ? (opts.stopMs as number) : DEFAULT_STOP_MS,
      onInterrupt: (why) => this.interruptAgent(why),
      onListening: (_itemId, maxRunMs) => this.onListening(maxRunMs), // only with words: a cough is not a "mm-hmm"
    });
    this.silenceCheck = new SilenceCheck({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onSilence: (seconds) => this.onSilence(seconds),
    });
    this.stats = new TurnStatsCollector(this.bargeIn);
    this.timing = new TurnTiming(this.bargeIn, this.vad.turnDetection, (line) => hooks.log.info(line, 'ai-voice: turn timing'));
    this.sockets = new BridgeSockets(opts.twilio, opts.openai, hooks.log);

    opts.twilio.on('message', (d) => this.onTwilioFrame(d));
    opts.twilio.on('close', () => this.endAndTearDown('twilio_closed'));
    opts.twilio.on('error', (e) => this.endAndTearDown('error', `twilio: ${e.message}`));
    opts.openai.on('message', (d) => this.onOpenAiFrame(d));
    opts.openai.on('open', () => {
      this.armReadyTimer();
      this.sockets.flush();
    });
    opts.openai.on('close', () => this.endWithBackstop('openai_closed'));
    opts.openai.on('error', (e) => this.endWithBackstop('error', `openai: ${e.message}`));
  }

  /** Configure the session (sent first, once OpenAI is open) and arm the max-duration timer. */
  start(): void {
    if (this.sockets.started || this.sockets.stopped) return;
    this.sockets.start(
      sessionUpdate({
        ...this.opts,
        ...this.vad,
        bargeIn: this.bargeIn,
        transcribeModel: this.opts.transcribeModel ?? LEGACY_TRANSCRIBE_MODEL,
      }),
    );
    this.maxTimer = this.setTimer(() => this.endWithBackstop('max_duration'), this.opts.maxCallMs);
    this.armReadyTimer();
    this.sockets.flush();
  }

  /** Stop the agent talking right now (before a voicemail/transfer redirect). Idempotent. */
  silence(): void {
    if (this.silenced) return;
    this.silenced = true;
    this.closing = true;
    this.cancelOpener();
    this.gate.close();
    this.stats.clearOverlaps();
    this.timing.end(); // Twilio echoes every mark once cleared: that is not playing
    this.silenceCheck.cancel();
    this.cancelWhenCreated = false;
    this.sockets.sendTwilio({ event: 'clear', streamSid: this.opts.streamSid });
    this.cancelResponse();
    const cut = this.playback.interrupt();
    if (cut) this.truncateOnce(cut);
  }

  /** Resolves when the agent's current audio has finished playing, or after `maxMs`. */
  waitForPlayback(maxMs: number = PLAYBACK_DRAIN_MAX_MS): Promise<void> {
    if (this.ended) return Promise.resolve();
    return this.playback.waitForDrain(maxMs);
  }

  /** Close both sockets. Idempotent; reports `twilio_closed` ("stopped") if the call had not ended. */
  stop(): void {
    this.endAndTearDown('twilio_closed', 'stopped');
  }

  // ── Twilio → bridge ────────────────────────────────────────────────────────

  private onTwilioFrame(raw: unknown): void {
    const msg = this.sockets.parse(raw, 'twilio');
    if (!msg) return;
    switch (msg.event) {
      case 'media': {
        const media = obj(msg.media);
        this.playback.onInboundMedia(Number(media.timestamp));
        const payload = str(media.payload);
        if (payload) {
          this.sentAudioMs += base64Bytes(payload) / PCMU_BYTES_PER_MS;
          this.sockets.sendOpenAi({ type: 'input_audio_buffer.append', audio: payload }, true);
          const runMs = this.meter?.push(payload); // after forwarding: every frame, in order
          if (runMs !== undefined && !this.gate.idle) this.gate.onSound(runMs);
        }
        return;
      }
      case 'mark': {
        const name = str(obj(msg.mark).name);
        this.playback.onMark(name);
        this.timing.played(name, this.now());
        return;
      }
      case 'stop':
        this.endAndTearDown('twilio_closed');
        return;
      default:
        return; // connected / start (consumed by the route) / dtmf
    }
  }

  // ── OpenAI → bridge ────────────────────────────────────────────────────────

  private onOpenAiFrame(raw: unknown): void {
    const msg = this.sockets.parse(raw, 'openai');
    if (!msg) return;
    switch (msg.type) {
      case 'session.updated':
        return this.onSessionUpdated();
      case 'input_audio_buffer.speech_started':
        return this.onCallerSpeech(str(msg.item_id));
      case 'input_audio_buffer.speech_stopped':
        return this.onCallerStopped(str(msg.item_id), typeof msg.audio_end_ms === 'number' ? msg.audio_end_ms : Number.NaN);
      case 'input_audio_buffer.committed':
        return this.onCallerTurn(str(msg.item_id));
      case 'conversation.item.input_audio_transcription.delta':
        this.callerLines.delta(str(msg.item_id), str(msg.delta));
        return this.gate.onDelta(str(msg.item_id), str(msg.delta));
      case 'response.created':
        return this.onResponseCreated();
      case 'response.output_audio.delta':
        return this.onAgentAudio(str(msg.item_id), str(msg.delta));
      case 'response.output_audio.done':
        this.playback.onAudioDone();
        return;
      case 'response.output_audio_transcript.done':
        return this.transcript('agent', msg.transcript);
      case 'conversation.item.input_audio_transcription.completed':
        this.callerLines.final(str(msg.item_id), str(msg.transcript));
        this.transcript('caller', msg.transcript);
        return this.onCallerFinal(str(msg.item_id), str(msg.transcript));
      case 'conversation.item.input_audio_transcription.failed':
        return this.onTranscriptionFailed(str(msg.item_id), obj(msg.error));
      case 'response.done':
        return this.onResponseDone(obj(msg.response));
      case 'error':
        return this.onOpenAiError(openAiErrorFields(obj(msg.error)));
      default:
        return;
    }
  }

  private onSessionUpdated(): void {
    if (this.sessionReady || this.ended) return;
    this.sessionReady = true;
    this.clearReadyTimer();
    if (this.callerSpoke || this.openerSent || this.closing) return;
    this.openerTimer = this.setTimer(() => this.openCall(), this.opts.opener?.delayMs ?? OPENER_DELAY_MS);
  }

  /** Before `session.updated` an error means the session was never configured: end the call. */
  private onOpenAiError(fields: Record<string, string>): void {
    this.hooks.log.warn(fields, 'ai-voice bridge: openai error event');
    if (!this.sessionReady) return this.notConfigured(fields.message || fields.code || 'error');
    // A rejected response.create never gets response.created: don't stay "pending" forever.
    if (!this.rejectsPendingCreate(fields)) return;
    this.responsePending = false;
    this.cancelWhenCreated = false; // it was meant for the rejected create
    this.dropOwedEnd(); // a rejected goodbye create: never end the call after some later reply
    this.afterResponse(); // an answer still owed goes out; otherwise the silence is timed again
  }

  /** An error releases our pending create (gate mode only) if it names it; without an event_id, only a "busy" rejection. */
  private rejectsPendingCreate(fields: Record<string, string>): boolean {
    if (!this.responsePending) return false;
    if (fields.eventId) return fields.eventId === this.pendingCreateId;
    return fields.code === 'conversation_already_has_active_response';
  }

  /** Start the `session.updated` clock once the session is sent and the socket is open. */
  private armReadyTimer(): void {
    if (!this.sockets.started || this.sessionReady || this.ended || this.readyTimer !== null) return;
    if (!this.sockets.openAiOpen) return;
    this.readyTimer = this.setTimer(() => {
      this.readyTimer = null;
      this.notConfigured('timeout');
    }, SESSION_READY_TIMEOUT_MS);
  }

  private clearReadyTimer(): void {
    if (this.readyTimer === null) return;
    this.clearTimer(this.readyTimer);
    this.readyTimer = null;
  }

  private notConfigured(why: string): void {
    if (this.ended) return;
    this.hooks.log.error({ why }, 'ai-voice bridge: session not configured, ending the call');
    this.endWithBackstop('error', `session not configured: ${why}`);
  }

  private openCall(): void {
    this.openerTimer = null;
    if (this.callerSpoke || this.openerSent || this.ended || this.closing) return;
    this.openerSent = true;
    this.sockets.sendOpenAi(openerItem(this.opts.opener?.prompt));
    this.requestResponse();
  }

  private onCallerSpeech(itemId: string): void {
    this.timing.speechStarted();
    this.callerSpoke = true;
    this.callerTalking = true;
    this.holding = false;
    this.cancelOpener();
    this.silenceCheck.heard();
    if (this.bargeIn === 'instant') {
      if (this.cutAgent()) this.stats.interruption();
      return;
    }
    if (this.closing) return;
    if (this.agentSpeaking()) {
      const cuttable = this.playback.currentItemId !== this.openerItemId;
      this.gate.open(itemId, { cuttable, late: this.playback.remainingMs() <= LATE_OVERLAP_MS, runMs: this.meter?.runMs ?? 0 });
      return;
    }
    // A response that has not played a sound yet: drop it unheard; their turn gets a fresh one.
    if (this.responseActive && !this.responseHasAudio) this.cancelResponse();
    else if (this.responsePending && !this.responseActive) this.cancelWhenCreated = true;
  }

  /** The caller stopped: a turn is timed from here (`audioEndMs` on OpenAI's input audio clock). */
  private onCallerStopped(itemId: string, audioEndMs: number): void {
    this.callerTalking = false;
    if (itemId) this.awaitingCommit = itemId;
    this.gate.onSpeechStopped(itemId);
    if (!Number.isFinite(audioEndMs)) return;
    // server_vad's audio_end_ms already includes its silence wait, so add it back; semantic_vad's true wait is not in the event.
    const endpointMs = this.sentAudioMs - audioEndMs + (this.vad.turnDetection === 'server_vad' ? this.vad.silenceMs : 0);
    // An overlap is not a turn until it is answered (its verdict, or a cut that answers it).
    const at = this.now();
    const overlap = this.gate.has(itemId);
    if (overlap) this.stats.overlapStopped(itemId, endpointMs, at);
    else this.stats.callerStopped(endpointMs, at);
    this.timing.stopped(itemId, at, overlap, this.gate.isLate(itemId));
  }

  /** Gate mode: a committed caller turn gets an answer — an overlap still being judged waits for its verdict. */
  private onCallerTurn(itemId: string): void {
    this.callerSpokeSinceAgent = true;
    this.callerLines.committed(itemId);
    // They spoke again after their bye: answer them normally, and don't end the call. An overlap the gate is still
    // judging (an "okay" over the goodbye) leaves it: a real interruption cuts the goodbye, which drops it then.
    if (!this.gate.has(itemId)) {
      this.callerTurns += 1;
      this.dropOwedEnd();
    }
    if (this.awaitingCommit === itemId) this.awaitingCommit = null;
    this.timing.committed(itemId, this.now());
    if (this.bargeIn !== 'gate' || this.closing) return;
    if (this.gate.has(itemId)) {
      this.judgedTurns = new Set([...this.judgedTurns, itemId]);
      this.timing.deferred('overlap_verdict', itemId);
      return;
    }
    this.stats.overlapsAnswered([itemId]); // an overlap the gate settled before this commit
    this.timing.overlapsAnswered([itemId]);
    this.requestResponse();
  }

  /** The gate depends on transcription: log a failure (its code only — never text or audio); the overlap has no words. */
  private onTranscriptionFailed(itemId: string, error: Msg): void {
    const { code, errorType } = openAiErrorFields(error);
    this.hooks.log.warn({ code, errorType }, 'ai-voice bridge: caller transcription failed');
    this.callerLines.final(itemId, '');
    this.onCallerFinal(itemId, '');
  }

  /** The final transcript (or a failed one) of an overlap being judged. */
  private onCallerFinal(itemId: string, text: string): void {
    if (this.bargeIn !== 'gate' || !this.gate.has(itemId)) return;
    const end = this.gate.finish(itemId, text);
    this.judgedTurns = new Set([...this.judgedTurns].filter((id) => id !== itemId));
    if (end === 'interrupted') return; // answered by interruptAgent
    if (end === 'ignore') {
      this.stats.overlapIgnored(itemId);
      this.timing.ignored(itemId);
      return this.afterResponse(); // release an answer it held back
    }
    // Audio still queued: answer when it drains. Otherwise requestResponse waits for any active response's done.
    this.stats.overlapsAnswered([itemId], this.playback.playing);
    this.timing.overlapsAnswered([itemId], this.playback.playing);
    if (this.playback.playing) this.answerAfterPlayback = true;
    else this.requestResponse();
  }

  /** The agent is audible or about to be: audio queued in Twilio, or a response that already produced audio. */
  private agentSpeaking(): boolean {
    return this.playback.playing || (this.responseActive && this.responseHasAudio && !this.responseCut);
  }

  /** Stop the agent where the caller stopped hearing it; true if any of its audio was still queued. */
  private cutAgent(): boolean {
    const cut = this.playback.interrupt();
    if (!cut) return false;
    this.sockets.sendTwilio({ event: 'clear', streamSid: this.opts.streamSid });
    this.truncateOnce(cut);
    return true;
  }

  /** The gate decided the caller is really talking (and settled every overlap). */
  private interruptAgent(why: InterruptWhy): void {
    // A late cut keeps a reply whose audio is all here: its tool calls (end_call, transfer) still run once it is done.
    const keep = why === 'late' && this.responseHasAudio && !this.playback.audioStreaming;
    const cancelled = !keep && this.cancelResponse();
    // Our next create is still in flight: drop that response once it exists, or it plays over them.
    if (this.responsePending && !this.responseActive) this.cancelWhenCreated = true;
    this.answerAfterPlayback = false; // the turn that cut the agent gets its own answer
    if (this.cutAgent() || cancelled) {
      this.stats.interruption();
      const sound = this.meter === null ? {} : { runMs: Math.round(this.meter.runMs) };
      this.hooks.log.info({ why, ...sound }, 'ai-voice bridge: caller interrupted the agent');
      this.note('[stopped — they interrupted]');
    }
    // A committed turn among them is over: answer it. Otherwise the speaker's commit will.
    const owed = [...this.judgedTurns];
    this.judgedTurns = new Set();
    if (owed.length === 0) return;
    this.stats.overlapsAnswered(owed);
    this.timing.overlapsAnswered(owed);
    this.requestResponse();
  }

  /** An overlap was only a listening sound; with the sound judge its length is logged, to tune AI_VOICE_STOP_MS from real calls. */
  private onListening(maxRunMs: number): void {
    this.stats.listeningSound();
    if (this.meter !== null) this.hooks.log.info({ maxRunMs: Math.round(maxRunMs) }, 'ai-voice bridge: caller listening sound');
  }

  private get toolsRunning(): boolean {
    return this.toolBatches > 0;
  }

  /** Ask the agent to speak — in gate mode one response at a time; the goodbye owed after a sent-back end_call is speech only. */
  private requestResponse(): void {
    if (this.closing || this.ended) return;
    const speechOnly = this.owedEnd === null && !this.answerOwed ? {} : { response: { tool_choice: 'none' } };
    // Instant mode: VAD answers turns; the opener and after-tool creates go out at once, as before the gate.
    if (this.bargeIn === 'instant') {
      this.timing.requested(this.now());
      return this.sockets.sendOpenAi({ type: 'response.create', ...speechOnly });
    }
    // Never over a caller mid-utterance: their commit (or the overlap's verdict) releases it, answering both.
    const held = heldBy(this.callerTalking, this.responsePending || this.responseActive, this.toolsRunning);
    if (held !== null) {
      this.wantResponse = true;
      this.timing.deferred(held);
      return;
    }
    this.wantResponse = false;
    this.silenceCheck.cancel();
    this.responsePending = true;
    this.createSeq += 1;
    this.pendingCreateId = `ai-create-${this.createSeq}`;
    this.sockets.sendOpenAi({ type: 'response.create', event_id: this.pendingCreateId, ...speechOnly });
    this.timing.requested(this.now());
  }

  private onResponseCreated(): void {
    this.timing.created(this.now());
    this.silenceCheck.cancel();
    this.responsePending = false;
    this.responseActive = true;
    this.responseHasAudio = false;
    this.responseCut = false;
    this.responseItemId = '';
    this.lastAgentLine = '';
    if (!this.cancelWhenCreated) return;
    // The caller kept talking: drop this answer unheard; their committed turn is answered after its response.done.
    this.cancelWhenCreated = false;
    this.cancelResponse();
  }

  /** Cancel the active response once; true if a cancel was sent. */
  private cancelResponse(): boolean {
    if (!this.responseActive || this.responseCut) return false;
    this.responseCut = true;
    this.sockets.sendOpenAi({ type: 'response.cancel' });
    return true;
  }

  /** The agent's queued audio finished playing. */
  private onAgentFinished(): void {
    this.stats.agentFinished(this.now());
    if (this.ended || this.closing) return;
    // A caller still talking over the end is answering it (spec §4.1) — unless a next response (a tool follow-up) is coming.
    if (!this.responsePending && !(this.responseActive && !this.responseHasAudio)) {
      // Sound judge: it is their turn now — answered at its commit, or with the answer below if already committed.
      const released = this.gate.onAgentFinished();
      if (released !== null && this.judgedTurns.has(released)) {
        this.judgedTurns = new Set([...this.judgedTurns].filter((id) => id !== released));
        this.stats.overlapsAnswered([released]);
        this.timing.overlapsAnswered([released]);
        this.answerAfterPlayback = true; // one answer, for it and any late answer already owed
      }
    }
    if (!this.answerAfterPlayback) return this.onAgentWaiting();
    this.answerAfterPlayback = false;
    this.requestResponse();
  }

  /** Gate mode: no caller turn, response, tool, playback or verdict is under way — the agent is waiting for the caller. */
  private waiting(): boolean {
    if (this.bargeIn !== 'gate' || this.ended || this.closing || !this.agentSpoke) return false;
    if (this.callerTalking || this.awaitingCommit !== null || this.judgedTurns.size > 0 || !this.gate.idle) return false;
    if (this.responsePending || this.responseActive || this.toolsRunning || this.wantResponse || this.answerAfterPlayback) return false;
    return !this.playback.playing;
  }

  /** If the agent is now waiting: a turn it did not answer aloud is no longer timed, and the silence is (longer on hold). */
  private onAgentWaiting(): void {
    if (!this.waiting()) return;
    this.stats.dropPending();
    this.timing.dropPending();
    this.silenceCheck.arm(this.holding ? HOLD_CHECK_MS : SILENCE_CHECK_MS);
  }

  /** Nobody spoke: a hidden note, and the agent checks in (the prompt says how). No turn can be pending: one needs speech. */
  private onSilence(seconds: number): void {
    if (!this.waiting()) return;
    this.stats.silenceCheck();
    this.note(`[no answer for ${seconds} s]`);
    this.sockets.sendOpenAi(silenceNoteItem(seconds));
    this.requestResponse();
  }

  /** A system line in the transcript (not spoken). */
  private note(text: string): void {
    this.guard('onTranscript', () => this.hooks.onTranscript({ role: 'system', text, at: new Date(this.now()) }));
  }

  /** Truncate an item at most once, and drop any of its audio that arrives afterwards. */
  private truncateOnce(cut: Truncation): void {
    if (this.truncated.has(cut.itemId)) return;
    this.truncated = new Set([...this.truncated, cut.itemId]);
    this.sockets.sendOpenAi(truncate(cut.itemId, cut.audioEndMs));
  }

  /** Forward agent audio — never before the session is ready, after silence(), or of a response the bridge cancelled. */
  private onAgentAudio(itemId: string, delta: string): void {
    const at = this.now();
    this.timing.delta(at);
    if (!this.sessionReady || this.silenced || !delta || this.truncated.has(itemId) || this.responseCut) return;
    this.responseItemId = itemId;
    const first = !this.responseHasAudio;
    if (first) {
      this.responseHasAudio = true;
      this.stats.agentAudio(at);
      this.agentSpoke = true;
      this.callerSpokeSinceAgent = false;
      this.callerLines.agentSpoke();
      if (this.answerOwed) this.unrunEnd = null; // the agent answers them: the call goes on
      this.answerOwed = false;
      if (this.rearmOnSpeech) {
        this.silentEndRefused = false;
        this.unrunEnd = null; // speaking again after a cut goodbye: the call goes on
      }
      this.rearmOnSpeech = false;
      this.openerItemId ??= itemId;
    }
    this.sockets.sendTwilio({
      event: 'media',
      streamSid: this.opts.streamSid,
      media: { payload: delta },
    });
    const mark = this.playback.onAudioDelta(itemId, delta);
    if (first) this.timing.forwarded(at, mark);
    this.sockets.sendTwilio({
      event: 'mark',
      streamSid: this.opts.streamSid,
      mark: { name: mark },
    });
  }

  /** Agent lines after `silence()`, or of a response cancelled before a sound of it played, are recorded as not played. */
  private transcript(role: 'agent' | 'caller', value: unknown): void {
    const text = str(value).trim();
    if (!text) return;
    if (role === 'agent') this.lastAgentLine = text;
    const unplayed = role === 'agent' && (this.silenced || (this.responseCut && !this.responseHasAudio));
    const entry = unplayed
      ? { role: 'system' as const, text: `[not played] ${text}`, at: new Date(this.now()) }
      : { role, text, at: new Date(this.now()) };
    this.guard('onTranscript', () => this.hooks.onTranscript(entry));
  }

  /** A throwing hook must not take down the socket event handler that called it. */
  private guard(hook: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.hooks.log.error({ hook, err: errText(e) }, 'ai-voice bridge: hook threw');
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────────

  private onResponseDone(response: Msg): void {
    // What the caller heard, taken before the resets below: audio that played and was not cut (a kept late cut only truncated its item).
    const spoke = {
      audio: this.responseHasAudio && !this.responseCut && !this.truncated.has(this.responseItemId),
      question: this.lastAgentLine.endsWith('?'),
    };
    // Any of it played, cut or not: a late-cut goodbye was still said (the guard below must not send its end_call back).
    const played = this.responseHasAudio;
    // Cut by us (the gate), by OpenAI (instant mode's interrupt_response), or truncated where the caller stopped hearing it.
    const cut = this.responseCut || this.truncated.has(this.responseItemId) || str(response.status) === 'cancelled';
    this.responseActive = false;
    this.responsePending = false;
    this.responseCut = false;
    this.cancelWhenCreated = false;
    const calls = functionCalls(response);
    // The speech-only goodbye a sent-back end_call asked for: run that end_call now, unless the goodbye was cut.
    const owed = calls.length === 0 ? this.takeOwedEnd(cut, played) : null;
    if (calls.length > 0) this.runTools(calls, spoke, played);
    if (owed !== null) this.endAfterGoodbye(owed.args);
    this.playback.onResponseDone(); // after the tool bookkeeping: a drain notified here sees the batch
    if (calls.length === 0 && owed === null) this.afterResponse();
  }

  /** Run a response's tool calls after any earlier batch, then speak, hold, let the caller answer, or end the conversation. */
  private runTools(calls: readonly FunctionCall[], spoke: Spoke, played: boolean): void {
    const deps = {
      onTool: this.hooks.onTool.bind(this.hooks),
      log: this.hooks.log,
      send: (m: object) => this.sockets.sendOpenAi(m),
    };
    // A silent end_call after the caller spoke that might be answered waits for their words (unrun meanwhile: a call that
    // ends during the wait records it in finish, before onEnd); any other batch is settled now, as before.
    const candidate = this.silentEndAfterCaller(calls, played);
    const waits = candidate && this.answerable(calls);
    const turnsAtEnd = this.callerTurns;
    let refusal: EndRefusal = candidate && !waits ? this.decideRefusal(calls, turnsAtEnd) : null;
    if (waits) this.unrunEnd = { args: endCallArgs(calls) };
    else this.settleEnds(calls, refusal);
    this.toolBatches += 1;
    this.timing.toolBatch();
    this.toolChain = this.toolChain
      .then(async () => {
        if (waits) {
          await this.callerLines.settled(this.opts.finalWordsWaitMs ?? FINAL_WORDS_WAIT_MS);
          refusal = this.decideRefusal(calls, turnsAtEnd);
          this.settleEnds(calls, refusal);
        }
        const goodbyeNote = refusal === 'answer' || refusal === 'resume' ? ANSWER_THEM_FIRST : this.opts.goodbyeNote;
        // Counted down exactly once, before acting on the result (and even if the batch throws).
        const batch = await runToolBatch(calls, deps, { refuseSilentEnd: refusal !== null, goodbyeNote }).finally(() => (this.toolBatches -= 1));
        if (refusal === 'ended') return; // its end_call (the batch's only tool) already ran in finish
        if (batch.refusedSilentEnd && (refusal === 'answer' || refusal === 'resume')) {
          this.hooks.log.info({}, 'ai-voice bridge: end_call while the caller was still talking — told to answer them');
          this.note('[end_call sent back — the caller was still talking]');
        } else if (batch.refusedSilentEnd) {
          this.hooks.log.info({}, 'ai-voice bridge: end_call with no goodbye after the caller spoke — asked for one');
          this.note('[end_call sent back — asked for a goodbye]');
        }
        if (!batch.carryOn) this.closeConversation();
        if (followUpAfterTools(calls, batch, spoke)) return this.requestResponse();
        // Only wait_for_user holds; a note save after a question leaves the floor to the caller (an answer already in is sent).
        if (!batch.speak) this.holding = !this.wantResponse; // a turn that came in during the batch is answered, not held
        this.afterResponse();
      })
      .catch((e: unknown) => {
        this.hooks.log.error({ err: errText(e) }, 'ai-voice bridge: tool batch failed');
        this.afterResponse();
      });
  }

  /**
   * The ends a batch settles. A refused end_call is owed after its goodbye ('goodbye'), or, told to answer the caller
   * ('answer'), owed nothing: it runs at the end only if the caller hangs up before the agent's answer starts, and the
   * answer is speech only (an inbound agent's only tool is end_call: it could end again in the same turn). A caller who
   * spoke again ('resume') withdraws it. Any end_call
   * that runs settles one owed earlier (a transfer, an unrun one); a tool that moves past an end drops an unrun one, except
   * in the refused batch itself (it came before that end).
   */
  private settleEnds(calls: readonly FunctionCall[], refusal: EndRefusal): void {
    if (refusal === 'ended') return; // finish ran the unrun end_call (or the conversation had moved past it)
    if (refusal === 'goodbye') {
      this.owedEnd = { args: endCallArgs(calls) };
      this.unrunEnd = this.owedEnd;
    } else if (refusal === 'answer') {
      this.unrunEnd = { args: endCallArgs(calls) };
      this.answerOwed = true;
    } else if (refusal === 'resume') {
      this.owedEnd = null; // they spoke again: the end is withdrawn, as dropOwedEnd does for one owed after a goodbye
      this.unrunEnd = null;
    } else if (calls.some((call) => call.name === 'end_call')) {
      this.owedEnd = null;
      this.unrunEnd = null;
    }
    if (refusal === null && calls.some((call) => MOVES_PAST_AN_END.has(call.name))) this.unrunEnd = null;
  }

  /**
   * goodbyeBeforeEnd, checked at response.done: an end_call in a response that played nothing, after a caller turn the
   * agent has not answered aloud. Not before the agent has said anything (a voicemail greeting or a phone menu: it stays
   * silent there), and never one whose outcome must be recorded at once (an opt-out, or a caller already gone:
   * NEVER_SENT_BACK).
   */
  private silentEndAfterCaller(calls: readonly FunctionCall[], played: boolean): boolean {
    return (
      this.opts.goodbyeBeforeEnd === true &&
      !played &&
      !this.closing &&
      this.agentSpoke &&
      this.callerSpokeSinceAgent &&
      calls.some((call) => call.name === 'end_call') &&
      !NEVER_SENT_BACK.has(endCallOutcome(calls))
    );
  }

  /**
   * Whether a silent end_call might be answered rather than said goodbye to, so its batch waits for the caller's words:
   * an end_call alone (a batch's other tools — a booking, a do-not-call, notes — must run before a hang-up records the
   * end), within MAX_ANSWER_REFUSALS a call, and not an outbound seller's not_interested (one goodbye, then the end).
   */
  private answerable(calls: readonly FunctionCall[]): boolean {
    return (
      this.answerRefusals < MAX_ANSWER_REFUSALS &&
      calls.every((call) => call.name === 'end_call') &&
      !(this.opts.goodbyeOnNotInterested === true && endCallOutcome(calls) === 'not_interested')
    );
  }

  /**
   * How a silent end_call after the caller spoke is settled (after the wait for their words, when answerable). A caller
   * who spoke again after it, or is speaking now, is answered as usual ('resume'). One whose last words are a question
   * is answered in a speech-only turn ('answer': a test call, 2026-10-19, was hung up on mid-question), unless they opted
   * out. Both count toward MAX_ANSWER_REFUSALS a call (a TV in the background cannot keep a call up). Otherwise, once a
   * call, the agent says a goodbye and the bridge ends the call; after that the end_call runs. 'ended': the call ended
   * during the wait (finish ran the end_call); a call that began closing meanwhile runs it.
   */
  private decideRefusal(calls: readonly FunctionCall[], turnsAtEnd: number): EndRefusal {
    if (this.ended) return 'ended';
    if (this.closing) return null;
    const spokeAgain = this.callerTurns !== turnsAtEnd || this.callerTalking;
    if (spokeAgain && this.answerRefusals < MAX_ANSWER_REFUSALS) {
      this.answerRefusals += 1;
      return 'resume';
    }
    const lines = this.callerLines.sinceAgent();
    if (this.answerable(calls) && !optedOut(lines) && waitingOnAnswer(lines)) {
      this.answerRefusals += 1;
      return 'answer';
    }
    if (this.silentEndRefused) return null;
    this.silentEndRefused = true;
    return 'goodbye';
  }

  /**
   * The goodbye response is done: the owed end_call to run now, or null (none owed, or the goodbye was cut). A cut
   * goodbye that was partly heard ("bye!" over it) re-arms the guard only once the agent speaks again, so their reply's
   * silent end_call runs instead of a second goodbye; one cut before a sound of it played re-arms at once.
   */
  private takeOwedEnd(cut: boolean, played: boolean): { args: unknown } | null {
    const owed = this.owedEnd;
    if (owed === null) return null;
    if (cut && played) {
      this.owedEnd = null;
      this.rearmOnSpeech = true;
      return null;
    }
    if (cut) {
      this.dropOwedEnd();
      return null;
    }
    this.owedEnd = null;
    return owed;
  }

  /**
   * The owed goodbye was never said (cut, a new caller turn, a rejected create): forget the end, and re-arm the guard so
   * a later silent end_call is sent back again. No loop: each refusal needs a new caller turn, and the goodbye is speech only.
   */
  private dropOwedEnd(): void {
    if (this.owedEnd === null) return;
    this.owedEnd = null;
    this.unrunEnd = null;
    this.silentEndRefused = false;
  }

  /**
   * goodbyeBeforeEnd: the call ended (finish) with a sent-back end_call never run — the caller hung up during the goodbye,
   * say. Run it now for its outcome and summary; the hang-up it asks for finds the call already over.
   */
  private runUnrunEnd(): void {
    const unrun = this.unrunEnd;
    if (unrun === null) return;
    this.unrunEnd = null;
    this.owedEnd = null;
    this.hooks.log.info({}, 'ai-voice bridge: the call ended before the sent-back end_call ran — running it now');
    try {
      void this.hooks
        .onTool('end_call', unrun.args)
        .then((result) => this.hooks.log.info({ output: result.output }, 'ai-voice bridge: the sent-back end_call ran at the end'))
        .catch((e: unknown) => {
          this.hooks.log.error({ err: errText(e) }, 'ai-voice bridge: running the sent-back end_call at the end failed');
        });
    } catch (e) {
      this.hooks.log.error({ err: errText(e) }, 'ai-voice bridge: running the sent-back end_call at the end failed');
    }
  }

  /** goodbyeBeforeEnd: the goodbye a sent-back end_call asked for is done — run that end_call (its arguments), after any earlier batch. */
  private endAfterGoodbye(args: unknown): void {
    this.unrunEnd = null;
    this.hooks.log.info({}, 'ai-voice bridge: goodbye said after a sent-back end_call — ending the call');
    this.toolBatches += 1;
    this.toolChain = this.toolChain
      .then(async () => {
        let result: ToolResult;
        try {
          result = await this.hooks.onTool('end_call', args);
        } finally {
          this.toolBatches -= 1; // also when onTool throws before returning a promise
        }
        if (result.then !== 'hangup' && result.then !== 'transfer') throw new Error('end_call did not end the call');
        this.closeConversation();
      })
      .catch(async (e: unknown) => {
        // The caller said bye: end the call from here once the goodbye has played, rather than leave the line open.
        this.hooks.log.error({ err: errText(e) }, 'ai-voice bridge: ending the call after the goodbye failed');
        await this.waitForPlayback();
        this.endWithBackstop('error', 'ending the call after the goodbye failed');
      });
  }

  /** A response (or a quiet tool batch) finished without asking for another. */
  private afterResponse(): void {
    if (this.wantResponse) return this.requestResponse();
    this.onAgentWaiting();
  }

  /** A hangup/transfer result: latch closing and stop VAD from starting a response during the drain. */
  private closeConversation(): void {
    this.closing = true;
    this.gate.close();
    this.stats.clearOverlaps();
    this.silenceCheck.cancel();
    this.cancelWhenCreated = false;
    // Gate sessions never auto-respond; instant sessions stop VAD responses during the drain.
    if (this.bargeIn === 'gate' || this.autoResponsesOff) return;
    this.autoResponsesOff = true;
    this.sockets.sendOpenAi(stopAutoResponses(this.vad));
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private cancelOpener(): void {
    if (this.openerTimer === null) return;
    this.clearTimer(this.openerTimer);
    this.openerTimer = null;
  }

  /** Report the end once; later causes are ignored. */
  private finish(reason: EndReason, detail?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.cancelOpener();
    this.gate.close();
    this.stats.clearOverlaps();
    this.silenceCheck.cancel();
    this.clearReadyTimer();
    if (this.maxTimer !== null) this.clearTimer(this.maxTimer);
    this.maxTimer = null;
    this.playback.releaseAll();
    this.timing.end();
    this.callerLines.close(); // a guard waiting for the caller's words decides now (the call is over)
    this.runUnrunEnd(); // before onEnd: its end_call, not the session's end handling, records how the call went
    this.guard('onStats', () => this.hooks.onStats?.(this.stats.summary()));
    this.guard('onEnd', () => this.hooks.onEnd(reason, detail));
  }

  /** OpenAI-side or time-limit end: silence now, report, and close the stream if the service does not. */
  private endWithBackstop(reason: EndReason, detail?: string): void {
    if (this.ended) return;
    this.silence();
    this.finish(reason, detail);
    if (this.sockets.stopped) return;
    this.backstopTimer = this.setTimer(() => this.endAndTearDown(reason, detail), END_GRACE_MS);
  }

  private endAndTearDown(reason: EndReason, detail?: string): void {
    this.finish(reason, detail);
    if (this.sockets.stopped) return;
    if (this.backstopTimer !== null) this.clearTimer(this.backstopTimer);
    this.backstopTimer = null;
    this.sockets.close();
  }
}
