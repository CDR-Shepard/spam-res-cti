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
 * `session.update` always goes first. Audio payloads are never logged.
 *
 * In `instant` barge-in mode (the default) OpenAI's VAD answers each caller turn
 * and any caller sound cuts the agent. In `gate` mode the bridge owns the turns:
 * it answers each committed caller turn with one `response.create` at a time (never
 * over a caller mid-utterance), keeps talking through listening sounds and cuts the agent (never the opener)
 * only on a real interruption (bridge-overlap.ts; spec
 * docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.1).
 *
 * Once the call is closing (a hangup/transfer tool result, or `silence()`) the
 * agent is never asked to speak again; in instant mode a hangup/transfer result
 * also turns off VAD auto-responses (`create_response: false`). If the call ends from the OpenAI side
 * or hits its time limit, the bridge silences the agent, reports `onEnd`, and
 * closes both sockets after END_GRACE_MS unless the service calls `stop()`
 * first — closing the stream lets Twilio continue past </Connect> and end the
 * call even if the service never hangs up.
 */
import { obj, openAiErrorFields, parseFrame, str, type Msg } from './bridge-frames.js';
import { Outbox } from './bridge-outbox.js';
import { LATE_OVERLAP_MS, OverlapGate, type InterruptWhy } from './bridge-overlap.js';
import { PCMU_BYTES_PER_MS, PlaybackTracker, base64Bytes, type ClearTimer, type SetTimer, type Truncation } from './bridge-playback.js';
import { openerItem, sessionUpdate, stopAutoResponses, truncate, type ReasoningEffort, type VadEagerness } from './bridge-session.js';
import type { BargeInMode } from './bridge-turn-stats.js';
import { errText, functionCalls, runToolBatch, type BridgeLog, type FunctionCall, type ToolResult } from './bridge-tools.js';
import type { ToolName } from './prompt.js';

export type { BargeInMode, BridgeLog, ReasoningEffort, ToolResult, VadEagerness };

/** The transcriber before 2026-10-09; the bridge's default so a bare BridgeOptions behaves as before. */
export const LEGACY_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

/** How long after `session.updated` the agent waits for the caller before opening. */
export const OPENER_DELAY_MS = 3000;
/** Default cap on waiting for the agent's last words before a hangup/transfer. */
export const PLAYBACK_DRAIN_MAX_MS = 8000;
/** After a bridge-side end, how long the service has to hang up/redirect before the bridge closes the stream. */
export const END_GRACE_MS = 10_000;
/** How long after the OpenAI socket opens (and the session is sent) to wait for `session.updated`. */
export const SESSION_READY_TIMEOUT_MS = 5000;
/** Shortest accepted `maxCallMs`. */
export const MIN_CALL_MS = 10_000;

const WS_OPEN = 1;

export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(ev: 'message', cb: (d: string) => void): void;
  on(ev: 'close', cb: () => void): void;
  on(ev: 'error', cb: (e: Error) => void): void;
  on(ev: 'open', cb: () => void): void;
  /** ws semantics: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  readonly readyState: number;
}

export type EndReason = 'twilio_closed' | 'openai_closed' | 'max_duration' | 'error';

export interface BridgeHooks {
  onTool(name: ToolName, args: unknown): Promise<ToolResult>;
  onTranscript(entry: { role: 'agent' | 'caller' | 'system'; text: string; at: Date }): void;
  onEnd(reason: EndReason, detail?: string): void;
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
  maxCallMs: number;
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
  private readonly bargeIn: BargeInMode;
  private readonly outbox: Outbox;
  private started = false;
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
  /** Gate mode: the caller started talking while our response.create was in flight; cancel it once created. */
  private cancelWhenCreated = false;
  /** Tool batches queued or running (instant mode can queue two). */
  private toolBatches = 0;
  /** A turn wants an answer while a response or a tool batch is still going. */
  private wantResponse = false;
  /** A late overlap ("yeah sure" over the end of a question): answer once the agent's audio has played. */
  private answerAfterPlayback = false;
  private callerTalking = false;
  /** The agent called wait_for_user and nobody has spoken since. */
  private holding = false;
  private agentSpoke = false;
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
  private stopped = false;
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
    this.bargeIn = opts.bargeIn ?? 'instant';
    this.playback = new PlaybackTracker({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onDrained: () => this.onAgentFinished(),
    });
    this.gate = new OverlapGate({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onInterrupt: (why) => this.interruptAgent(why),
    });
    this.outbox = new Outbox(() =>
      hooks.log.warn({ queued: 'full' }, 'ai-voice bridge: openai outbox full, dropping oldest caller audio'),
    );

    opts.twilio.on('message', (d) => this.onTwilioFrame(d));
    opts.twilio.on('close', () => this.endAndTearDown('twilio_closed'));
    opts.twilio.on('error', (e) => this.endAndTearDown('error', `twilio: ${e.message}`));
    opts.openai.on('message', (d) => this.onOpenAiFrame(d));
    opts.openai.on('open', () => {
      this.armReadyTimer();
      this.flush();
    });
    opts.openai.on('close', () => this.endWithBackstop('openai_closed'));
    opts.openai.on('error', (e) => this.endWithBackstop('error', `openai: ${e.message}`));
  }

  /** Configure the session (sent first, once OpenAI is open) and arm the max-duration timer. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.outbox.prepend(
      JSON.stringify(
        sessionUpdate({ ...this.opts, bargeIn: this.bargeIn, transcribeModel: this.opts.transcribeModel ?? LEGACY_TRANSCRIBE_MODEL }),
      ),
    );
    this.maxTimer = this.setTimer(() => this.endWithBackstop('max_duration'), this.opts.maxCallMs);
    this.armReadyTimer();
    this.flush();
  }

  /** Stop the agent talking right now (before a voicemail/transfer redirect). Idempotent. */
  silence(): void {
    if (this.silenced) return;
    this.silenced = true;
    this.closing = true;
    this.cancelOpener();
    this.gate.close();
    this.cancelWhenCreated = false;
    this.sendTwilio({ event: 'clear', streamSid: this.opts.streamSid });
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
    const msg = this.parse(raw, 'twilio');
    if (!msg) return;
    switch (msg.event) {
      case 'media': {
        const media = obj(msg.media);
        this.playback.onInboundMedia(Number(media.timestamp));
        const payload = str(media.payload);
        if (payload) {
          this.sentAudioMs += base64Bytes(payload) / PCMU_BYTES_PER_MS;
          this.sendOpenAi({ type: 'input_audio_buffer.append', audio: payload }, true);
        }
        return;
      }
      case 'mark':
        this.playback.onMark(str(obj(msg.mark).name));
        return;
      case 'stop':
        this.endAndTearDown('twilio_closed');
        return;
      default:
        return; // connected / start (consumed by the route) / dtmf
    }
  }

  // ── OpenAI → bridge ────────────────────────────────────────────────────────

  private onOpenAiFrame(raw: unknown): void {
    const msg = this.parse(raw, 'openai');
    if (!msg) return;
    switch (msg.type) {
      case 'session.updated':
        return this.onSessionUpdated();
      case 'input_audio_buffer.speech_started':
        return this.onCallerSpeech(str(msg.item_id));
      case 'input_audio_buffer.speech_stopped':
        return this.onCallerStopped(str(msg.item_id));
      case 'input_audio_buffer.committed':
        return this.onCallerTurn(str(msg.item_id));
      case 'conversation.item.input_audio_transcription.delta':
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
        this.transcript('caller', msg.transcript);
        return this.onCallerFinal(str(msg.item_id), str(msg.transcript));
      case 'conversation.item.input_audio_transcription.failed':
        return this.onCallerFinal(str(msg.item_id), '');
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
    this.openerTimer = this.setTimer(() => this.openCall(), OPENER_DELAY_MS);
  }

  /** Before `session.updated` an error means the session was never configured: end the call. */
  private onOpenAiError(fields: Record<string, string>): void {
    this.hooks.log.warn(fields, 'ai-voice bridge: openai error event');
    if (!this.sessionReady) return this.notConfigured(fields.message || fields.code || 'error');
    // A rejected response.create never gets response.created: don't stay "pending" forever.
    if (!this.rejectsPendingCreate(fields)) return;
    this.responsePending = false;
    this.cancelWhenCreated = false; // it was meant for the rejected create
    if (this.wantResponse) this.requestResponse();
  }

  /** An error releases our pending create only if it names it; without an event_id, anything but a stale cancel. */
  private rejectsPendingCreate(fields: Record<string, string>): boolean {
    if (!this.responsePending) return false;
    if (fields.eventId) return fields.eventId === this.pendingCreateId;
    return fields.code !== 'response_cancel_not_active';
  }

  /** Start the `session.updated` clock once the session is sent and the socket is open. */
  private armReadyTimer(): void {
    if (!this.started || this.sessionReady || this.ended || this.readyTimer !== null) return;
    if (this.opts.openai.readyState !== WS_OPEN) return;
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
    this.sendOpenAi(openerItem());
    this.requestResponse();
  }

  private onCallerSpeech(itemId: string): void {
    this.callerSpoke = true;
    this.callerTalking = true;
    this.holding = false;
    this.cancelOpener();
    if (this.bargeIn === 'instant') {
      this.cutAgent();
      return;
    }
    if (this.closing) return;
    if (this.agentSpeaking()) {
      const cuttable = this.playback.currentItemId !== this.openerItemId;
      this.gate.open(itemId, { cuttable, late: this.playback.remainingMs() <= LATE_OVERLAP_MS });
      return;
    }
    // A response that has not played a sound yet: drop it unheard; their turn gets a fresh one.
    if (this.responseActive && !this.responseHasAudio) this.cancelResponse();
    else if (this.responsePending && !this.responseActive) this.cancelWhenCreated = true;
  }

  private onCallerStopped(itemId: string): void {
    this.callerTalking = false;
    this.gate.onSpeechStopped(itemId);
  }

  /** Gate mode: a committed caller turn gets an answer — an overlap still being judged waits for its verdict. */
  private onCallerTurn(itemId: string): void {
    if (this.bargeIn !== 'gate' || this.closing) return;
    if (this.gate.has(itemId)) {
      this.judgedTurns = new Set([...this.judgedTurns, itemId]);
      return;
    }
    this.requestResponse();
  }

  /** The final transcript (or a failed one) of an overlap being judged. */
  private onCallerFinal(itemId: string, text: string): void {
    if (this.bargeIn !== 'gate' || !this.gate.has(itemId)) return;
    const end = this.gate.finish(itemId, text);
    this.judgedTurns = new Set([...this.judgedTurns].filter((id) => id !== itemId));
    if (end === 'interrupted') return; // answered by interruptAgent
    if (end === 'ignore') return this.afterResponse(); // a listening sound: release an answer it held back
    if (this.agentSpeaking()) this.answerAfterPlayback = true;
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
    this.sendTwilio({ event: 'clear', streamSid: this.opts.streamSid });
    this.truncateOnce(cut);
    return true;
  }

  /** The gate decided the caller is really talking (and settled every overlap). */
  private interruptAgent(why: InterruptWhy): void {
    const cancelled = this.cancelResponse();
    // Our next create is still in flight: drop that response once it exists, or it plays over them.
    if (this.responsePending && !this.responseActive) this.cancelWhenCreated = true;
    this.answerAfterPlayback = false; // the turn that cut the agent gets its own answer
    if (this.cutAgent() || cancelled) {
      this.hooks.log.info({ why }, 'ai-voice bridge: caller interrupted the agent');
      this.note('[stopped — they interrupted]');
    }
    // A committed turn among them is over: answer it. Otherwise the speaker's commit will.
    const owed = this.judgedTurns.size > 0;
    this.judgedTurns = new Set();
    if (owed) this.requestResponse();
  }

  private get toolsRunning(): boolean {
    return this.toolBatches > 0;
  }

  /** Ask the agent to speak — in gate mode one response at a time. */
  private requestResponse(): void {
    if (this.closing || this.ended) return;
    // Instant mode: VAD answers turns; the opener and after-tool creates go out at once, as before the gate.
    if (this.bargeIn === 'instant') return this.sendOpenAi({ type: 'response.create' });
    // Never over a caller mid-utterance: their commit (or the overlap's verdict) releases it, answering both.
    if (this.callerTalking || this.responsePending || this.responseActive || this.toolsRunning) {
      this.wantResponse = true;
      return;
    }
    this.wantResponse = false;
    this.responsePending = true;
    this.createSeq += 1;
    this.pendingCreateId = `ai-create-${this.createSeq}`;
    this.sendOpenAi({ type: 'response.create', event_id: this.pendingCreateId });
  }

  private onResponseCreated(): void {
    this.responsePending = false;
    this.responseActive = true;
    this.responseHasAudio = false;
    this.responseCut = false;
    if (!this.cancelWhenCreated) return;
    // The caller kept talking: drop this answer unheard; their committed turn is answered after its response.done.
    this.cancelWhenCreated = false;
    this.cancelResponse();
  }

  /** Cancel the active response once; true if a cancel was sent. */
  private cancelResponse(): boolean {
    if (!this.responseActive || this.responseCut) return false;
    this.responseCut = true;
    this.sendOpenAi({ type: 'response.cancel' });
    return true;
  }

  /** The agent's queued audio finished playing. */
  private onAgentFinished(): void {
    if (this.ended || this.closing) return;
    if (!this.answerAfterPlayback) return;
    this.answerAfterPlayback = false;
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
    this.sendOpenAi(truncate(cut.itemId, cut.audioEndMs));
  }

  /** Forward agent audio — never before the session is ready, after silence(), or of a response the bridge cancelled. */
  private onAgentAudio(itemId: string, delta: string): void {
    if (!this.sessionReady || this.silenced || !delta || this.truncated.has(itemId) || this.responseCut) return;
    if (!this.responseHasAudio) {
      this.responseHasAudio = true;
      this.agentSpoke = true;
      this.openerItemId ??= itemId;
    }
    this.sendTwilio({
      event: 'media',
      streamSid: this.opts.streamSid,
      media: { payload: delta },
    });
    const mark = this.playback.onAudioDelta(itemId, delta);
    this.sendTwilio({
      event: 'mark',
      streamSid: this.opts.streamSid,
      mark: { name: mark },
    });
  }

  /** Agent lines after `silence()`, or of a response cancelled before a sound of it played, are recorded as not played. */
  private transcript(role: 'agent' | 'caller', value: unknown): void {
    const text = str(value).trim();
    if (!text) return;
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
    this.responseActive = false;
    this.responsePending = false;
    this.responseCut = false;
    this.cancelWhenCreated = false;
    const calls = functionCalls(response);
    if (calls.length > 0) this.runTools(calls);
    this.playback.onResponseDone(); // after the tool bookkeeping: a drain notified here sees the batch
    if (calls.length === 0) this.afterResponse();
  }

  /** Run a response's tool calls after any earlier batch, then speak, hold, or end the conversation. */
  private runTools(calls: readonly FunctionCall[]): void {
    const deps = {
      onTool: this.hooks.onTool.bind(this.hooks),
      log: this.hooks.log,
      send: (m: object) => this.sendOpenAi(m),
    };
    this.toolBatches += 1;
    this.toolChain = this.toolChain
      .then(async () => {
        // Counted down exactly once, before acting on the result (and even if the batch throws).
        const { carryOn, speak } = await runToolBatch(calls, deps).finally(() => (this.toolBatches -= 1));
        if (!carryOn) this.closeConversation();
        if (speak) return this.requestResponse();
        this.holding = !this.wantResponse; // a turn that came in during the batch is answered, not held
        this.afterResponse();
      })
      .catch((e: unknown) => {
        this.hooks.log.error({ err: errText(e) }, 'ai-voice bridge: tool batch failed');
        this.afterResponse();
      });
  }

  /** A response (or a quiet tool batch) finished without asking for another. */
  private afterResponse(): void {
    if (this.wantResponse) this.requestResponse();
  }

  /** A hangup/transfer result: latch closing and stop VAD from starting a response during the drain. */
  private closeConversation(): void {
    this.closing = true;
    this.gate.close();
    this.cancelWhenCreated = false;
    // Gate sessions never auto-respond; instant sessions stop VAD responses during the drain.
    if (this.bargeIn === 'gate' || this.autoResponsesOff) return;
    this.autoResponsesOff = true;
    this.sendOpenAi(stopAutoResponses(this.opts));
  }

  // ── sockets & lifecycle ────────────────────────────────────────────────────

  private parse(raw: unknown, source: 'twilio' | 'openai'): Msg | null {
    const msg = parseFrame(raw);
    if (!msg) this.hooks.log.warn({ source }, 'ai-voice bridge: unparseable frame');
    return msg;
  }

  private sendTwilio(m: object): void {
    if (this.stopped || this.opts.twilio.readyState !== WS_OPEN) return;
    this.opts.twilio.send(JSON.stringify(m));
  }

  /** Queue until started and open; drop once the OpenAI socket is closing/closed. */
  private sendOpenAi(m: object, droppable = false): void {
    if (this.stopped || this.opts.openai.readyState > WS_OPEN) return;
    const data = JSON.stringify(m);
    if (!this.started || this.opts.openai.readyState !== WS_OPEN) {
      this.outbox.push(data, droppable);
      return;
    }
    this.flush();
    this.opts.openai.send(data);
  }

  private flush(): void {
    if (!this.started || this.stopped || this.opts.openai.readyState !== WS_OPEN) return;
    for (const m of this.outbox.drain()) this.opts.openai.send(m);
  }

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
    this.clearReadyTimer();
    if (this.maxTimer !== null) this.clearTimer(this.maxTimer);
    this.maxTimer = null;
    this.playback.releaseAll();
    this.guard('onEnd', () => this.hooks.onEnd(reason, detail));
  }

  /** OpenAI-side or time-limit end: silence now, report, and close the stream if the service does not. */
  private endWithBackstop(reason: EndReason, detail?: string): void {
    if (this.ended) return;
    this.silence();
    this.finish(reason, detail);
    if (this.stopped) return;
    this.backstopTimer = this.setTimer(() => this.endAndTearDown(reason, detail), END_GRACE_MS);
  }

  private endAndTearDown(reason: EndReason, detail?: string): void {
    this.finish(reason, detail);
    if (this.stopped) return;
    this.stopped = true;
    if (this.backstopTimer !== null) this.clearTimer(this.backstopTimer);
    this.backstopTimer = null;
    this.outbox.clear();
    for (const s of [this.opts.twilio, this.opts.openai]) {
      try {
        s.close();
      } catch (e) {
        this.hooks.log.warn({ err: errText(e) }, 'ai-voice bridge: socket close failed');
      }
    }
  }
}
