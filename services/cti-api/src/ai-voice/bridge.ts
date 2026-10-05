/**
 * The live-call bridge: Twilio Media Streams ⇄ OpenAI Realtime. Pure plumbing
 * over two injected ws-like sockets (no network, no DB). Both sides speak
 * base64 μ-law 8 kHz, so audio passes straight through.
 *
 * Caller audio is always forwarded. Agent audio goes to Twilio chunk by chunk,
 * each followed by a `mark`, so a barge-in can `clear` Twilio and truncate the
 * assistant item where the caller stopped hearing it (bridge-playback.ts). The
 * model waits for the caller's "Hello?" and opens the call itself after
 * OPENER_DELAY_MS of silence. Tool calls arrive on `response.done` and run via
 * `hooks.onTool`. OpenAI messages queue (bounded) until started and open, so
 * `session.update` always goes first. Audio payloads are never logged.
 *
 * Once the call is closing (a hangup/transfer tool result, or `silence()`) the
 * agent is never asked to speak again; a hangup/transfer result also turns off
 * VAD auto-responses (`create_response: false`). If the call ends from the OpenAI side
 * or hits its time limit, the bridge silences the agent, reports `onEnd`, and
 * closes both sockets after END_GRACE_MS unless the service calls `stop()`
 * first — closing the stream lets Twilio continue past </Connect> and end the
 * call even if the service never hangs up.
 */
import { obj, openAiErrorFields, parseFrame, str, type Msg } from './bridge-frames.js';
import { Outbox } from './bridge-outbox.js';
import { PlaybackTracker, type ClearTimer, type SetTimer, type Truncation } from './bridge-playback.js';
import { openerItem, sessionUpdate, stopAutoResponses, truncate, type ReasoningEffort, type VadEagerness } from './bridge-session.js';
import { errText, functionCalls, runToolBatch, type BridgeLog, type ToolResult } from './bridge-tools.js';
import type { ToolName } from './prompt.js';

export type { BridgeLog, ReasoningEffort, ToolResult, VadEagerness };

/** How long after `session.updated` the agent waits for the caller before opening. */
export const OPENER_DELAY_MS = 3000;
/** Default cap on waiting for the agent's last words before a hangup/transfer. */
export const PLAYBACK_DRAIN_MAX_MS = 8000;
/** After a bridge-side end, how long the service has to hang up/redirect before the bridge closes the stream. */
export const END_GRACE_MS = 10_000;
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
  private readonly outbox: Outbox;
  private started = false;
  private sessionReady = false;
  private callerSpoke = false;
  private openerSent = false;
  private responseActive = false;
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
    this.playback = new PlaybackTracker({ setTimer: this.setTimer, clearTimer: this.clearTimer });
    this.outbox = new Outbox(() =>
      hooks.log.warn({ queued: 'full' }, 'ai-voice bridge: openai outbox full, dropping oldest caller audio'),
    );

    opts.twilio.on('message', (d) => this.onTwilioFrame(d));
    opts.twilio.on('close', () => this.endAndTearDown('twilio_closed'));
    opts.twilio.on('error', (e) => this.endAndTearDown('error', `twilio: ${e.message}`));
    opts.openai.on('message', (d) => this.onOpenAiFrame(d));
    opts.openai.on('open', () => this.flush());
    opts.openai.on('close', () => this.endWithBackstop('openai_closed'));
    opts.openai.on('error', (e) => this.endWithBackstop('error', `openai: ${e.message}`));
  }

  /** Configure the session (sent first, once OpenAI is open) and arm the max-duration timer. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.outbox.prepend(JSON.stringify(sessionUpdate(this.opts)));
    this.maxTimer = this.setTimer(() => this.endWithBackstop('max_duration'), this.opts.maxCallMs);
    this.flush();
  }

  /** Stop the agent talking right now (before a voicemail/transfer redirect). Idempotent. */
  silence(): void {
    if (this.silenced) return;
    this.silenced = true;
    this.closing = true;
    this.cancelOpener();
    this.sendTwilio({ event: 'clear', streamSid: this.opts.streamSid });
    if (this.responseActive) this.sendOpenAi({ type: 'response.cancel' });
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
        if (payload) this.sendOpenAi({ type: 'input_audio_buffer.append', audio: payload }, true);
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
        return this.onCallerSpeech();
      case 'response.created':
        this.responseActive = true;
        return;
      case 'response.output_audio.delta':
        return this.onAgentAudio(str(msg.item_id), str(msg.delta));
      case 'response.output_audio.done':
        this.playback.onAudioDone();
        return;
      case 'response.output_audio_transcript.done':
        return this.transcript('agent', msg.transcript);
      case 'conversation.item.input_audio_transcription.completed':
        return this.transcript('caller', msg.transcript);
      case 'response.done':
        return this.onResponseDone(obj(msg.response));
      case 'error':
        return this.hooks.log.warn(openAiErrorFields(obj(msg.error)), 'ai-voice bridge: openai error event');
      default:
        return;
    }
  }

  private onSessionUpdated(): void {
    if (this.sessionReady || this.ended) return;
    this.sessionReady = true;
    if (this.callerSpoke || this.openerSent || this.closing) return;
    this.openerTimer = this.setTimer(() => this.openCall(), OPENER_DELAY_MS);
  }

  private openCall(): void {
    this.openerTimer = null;
    if (this.callerSpoke || this.openerSent || this.ended || this.closing) return;
    this.openerSent = true;
    this.sendOpenAi(openerItem());
    this.sendOpenAi({ type: 'response.create' });
  }

  private onCallerSpeech(): void {
    this.callerSpoke = true;
    this.cancelOpener();
    const cut = this.playback.interrupt();
    if (!cut) return;
    this.sendTwilio({ event: 'clear', streamSid: this.opts.streamSid });
    this.truncateOnce(cut);
  }

  /** Truncate an item at most once, and drop any of its audio that arrives afterwards. */
  private truncateOnce(cut: Truncation): void {
    if (this.truncated.has(cut.itemId)) return;
    this.truncated = new Set([...this.truncated, cut.itemId]);
    this.sendOpenAi(truncate(cut.itemId, cut.audioEndMs));
  }

  private onAgentAudio(itemId: string, delta: string): void {
    if (this.silenced || !delta || this.truncated.has(itemId)) return;
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

  /** Agent lines spoken after `silence()` were never played to the caller; record them as such. */
  private transcript(role: 'agent' | 'caller', value: unknown): void {
    const text = str(value).trim();
    if (!text) return;
    const entry =
      role === 'agent' && this.silenced
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
    this.playback.onResponseDone();
    const calls = functionCalls(response);
    if (calls.length === 0) return;
    const deps = {
      onTool: this.hooks.onTool.bind(this.hooks),
      log: this.hooks.log,
      send: (m: object) => this.sendOpenAi(m),
    };
    this.toolChain = this.toolChain
      .then(async () => {
        const carryOn = await runToolBatch(calls, deps);
        if (!carryOn) this.closeConversation();
        if (!this.closing) this.sendOpenAi({ type: 'response.create' });
      })
      .catch((e: unknown) => this.hooks.log.error({ err: errText(e) }, 'ai-voice bridge: tool batch failed'));
  }

  /** A hangup/transfer result: latch closing and stop VAD from starting a response during the drain. */
  private closeConversation(): void {
    this.closing = true;
    if (this.autoResponsesOff) return;
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
