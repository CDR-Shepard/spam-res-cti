/**
 * The ElevenLabs voice for an AI call (spec 2026-10-19-ai-voice-elevenlabs-design.md): one multi-context WebSocket per
 * call, opened when the call starts, and a context per agent line. Each sentence goes out as soon as it is written
 * (with `flush`), so the first is spoken while the rest is still being written; a line ends with `flush` +
 * `close_context` and is done at ElevenLabs' `isFinal`. A socket that closes while idle reconnects on the next line;
 * any other failure is reported once (`failed`) and the call carries on in the OpenAI voice (external-voice.ts).
 */
import WebSocket from 'ws';
import type { AppConfig } from '../config.js';
import type { BridgeLog } from './bridge-tools.js';
import type { OpenTts, TtsEvents, TtsStream } from './external-voice.js';
import { rawDataToString } from './ws-adapter.js';

/** A finished line with no `isFinal` by then fails the voice, so a call never waits on a silent one. */
export const ELEVENLABS_FINAL_TIMEOUT_MS = 10_000;
const ELEVENLABS_WS = 'wss://api.elevenlabs.io/v1/text-to-speech';
/** Twilio's media format, so the audio goes to the call untouched. */
const OUTPUT_FORMAT = 'ulaw_8000';
/** The longest ElevenLabs allows (seconds); an idle socket closes after it and the next line reconnects. */
const INACTIVITY_TIMEOUT_S = 180;
/** As in the owner's ear test (ElevenLabs' defaults). */
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };
const WS_OPEN = 1;

/** A sentence end: . ! or ? (with closing quotes or brackets) and then a space. */
const SENTENCE_END = /[.!?]["'”’)]*\s+/g;
/** Not the end of a sentence: a title or street abbreviation, or a spoken pause ("six one nine... five five five"). */
const NOT_A_SENTENCE_END = /(?:(?<![\p{L}])(?:mr|mrs|ms|dr|st|ave|blvd|rd|jr|sr|vs)\.|\.\.\.|…)$/iu;

export interface ElevenLabsSettings {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

/** The part of a `ws` socket this file uses (the close carries its code and reason, which say why a key was refused). */
export interface TtsSocket {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
  on(ev: 'open', cb: () => void): void;
  on(ev: 'message', cb: (data: string) => void): void;
  on(ev: 'close', cb: (code: number, reason: string) => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
}

export type ConnectTts = (url: string, headers: Record<string, string>) => TtsSocket;

export function elevenLabsUrl(voiceId: string, modelId: string): string {
  const query = new URLSearchParams({ model_id: modelId, output_format: OUTPUT_FORMAT, inactivity_timeout: String(INACTIVITY_TIMEOUT_S) });
  return `${ELEVENLABS_WS}/${encodeURIComponent(voiceId)}/multi-stream-input?${query.toString()}`;
}

/** Whole sentences ready to speak, and the text still being written. */
export function splitPhrases(buffer: string): { phrases: string[]; rest: string } {
  const phrases: string[] = [];
  let start = 0;
  for (const m of buffer.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].trimEnd().length;
    if (NOT_A_SENTENCE_END.test(buffer.slice(start, end))) continue;
    const phrase = buffer.slice(start, end).trim();
    if (phrase) phrases.push(phrase);
    start = m.index + m[0].length;
  }
  return { phrases, rest: buffer.slice(start) };
}

export function connectWs(url: string, headers: Record<string, string>): TtsSocket {
  const ws = new WebSocket(url, { headers });
  function on(ev: 'open', cb: () => void): void;
  function on(ev: 'message', cb: (data: string) => void): void;
  function on(ev: 'close', cb: (code: number, reason: string) => void): void;
  function on(ev: 'error', cb: (err: Error) => void): void;
  function on(ev: 'open' | 'message' | 'close' | 'error', cb: (...a: never[]) => void): void {
    const fn = cb as (...a: unknown[]) => void;
    if (ev === 'message') ws.on('message', (d: WebSocket.RawData) => fn(rawDataToString(d)));
    else if (ev === 'close') ws.on('close', (code: number, reason: Buffer) => fn(code, reason.toString('utf8')));
    else if (ev === 'error') ws.on('error', (e: Error) => fn(e));
    else ws.on('open', () => fn());
  }
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on,
    get readyState() {
      return ws.readyState;
    },
  };
}

interface Line {
  /** Text written but not yet sent (no sentence end yet). */
  buffer: string;
  /** flush + close_context sent; waiting for `isFinal`. */
  finished: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function elevenLabsTts(s: ElevenLabsSettings, log: BridgeLog, connect: ConnectTts = connectWs): OpenTts {
  return (events: TtsEvents): TtsStream => {
    const url = elevenLabsUrl(s.voiceId, s.modelId);
    let socket: TtsSocket | null = null;
    let queue: string[] = [];
    let lines = new Map<string, Line>();
    /** Lines cut off by the caller: whatever ElevenLabs still sends for them is dropped. */
    let cancelled = new Set<string>();
    /** close() was called or the voice failed: nothing more is sent or reported. */
    let ended = false;

    const clearTimers = (): void => {
      for (const line of lines.values()) if (line.timer) clearTimeout(line.timer);
    };

    const fail = (message: string): void => {
      if (ended) return;
      ended = true;
      clearTimers();
      socket?.close();
      events.failed(new Error(message));
    };

    const closedMessage = (code: number, reason: string): string => `ElevenLabs socket closed ${code}${reason ? ` ${reason}` : ''}`;

    const onMessage = (raw: string): void => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        log.warn({}, 'ai-voice: ElevenLabs sent a frame that is not JSON');
        return;
      }
      if (str(m.error)) return fail(`ElevenLabs error ${str(m.error)}${str(m.message) ? `: ${str(m.message)}` : ''}`);
      const id = str(m.contextId) || str(m.context_id);
      const final = m.isFinal === true || m.is_final === true;
      const line = lines.get(id);
      if (!line) {
        if (final) cancelled = new Set([...cancelled].filter((c) => c !== id));
        return;
      }
      if (str(m.audio)) events.audio(id, str(m.audio));
      if (!final) return;
      if (line.timer) clearTimeout(line.timer);
      lines = new Map([...lines].filter(([k]) => k !== id));
      events.done(id);
    };

    const open = (): TtsSocket => {
      const sock = connect(url, { 'xi-api-key': s.apiKey });
      const startedAt = Date.now();
      let opened = false;
      socket = sock;
      const current = (): boolean => socket === sock && !ended;
      sock.on('open', () => {
        if (!current()) return;
        opened = true;
        log.info({ ms: Date.now() - startedAt }, 'ai-voice: ElevenLabs voice connected');
        const pending = queue;
        queue = [];
        for (const raw of pending) sock.send(raw);
      });
      sock.on('message', (raw) => {
        if (current()) onMessage(raw);
      });
      sock.on('error', (err) => {
        if (current()) fail(`ElevenLabs socket error: ${err.message}`);
      });
      sock.on('close', (code, reason) => {
        if (!current()) return;
        if (!opened || lines.size > 0) return fail(closedMessage(code, reason));
        socket = null; // idle close: the next line reconnects
      });
      return sock;
    };
    open();

    const send = (m: object): void => {
      if (ended) return;
      const raw = JSON.stringify(m);
      const sock = socket && socket.readyState <= WS_OPEN ? socket : open();
      if (sock.readyState !== WS_OPEN) {
        queue = [...queue, raw];
        return;
      }
      try {
        sock.send(raw);
      } catch (err) {
        fail(`ElevenLabs send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const setLine = (id: string, line: Line): void => {
      lines = new Map([...lines, [id, line]]);
    };

    return {
      speak(id, text) {
        if (ended || cancelled.has(id)) return;
        const line = lines.get(id) ?? null;
        if (line?.finished) return;
        if (!line) send({ text: ' ', context_id: id, voice_settings: VOICE_SETTINGS });
        const { phrases, rest } = splitPhrases((line?.buffer ?? '') + text);
        setLine(id, { buffer: rest, finished: false, timer: null });
        for (const phrase of phrases) send({ text: `${phrase} `, context_id: id, flush: true });
      },
      finish(id) {
        const line = lines.get(id);
        if (ended || !line || line.finished) return;
        const last = line.buffer.trim();
        if (last) send({ text: `${last} `, context_id: id, flush: true });
        send({ context_id: id, close_context: true });
        const timer = setTimeout(() => fail(`ElevenLabs gave no final audio for a line in ${ELEVENLABS_FINAL_TIMEOUT_MS} ms`), ELEVENLABS_FINAL_TIMEOUT_MS);
        setLine(id, { buffer: '', finished: true, timer });
      },
      cancel(id) {
        const line = lines.get(id);
        if (ended || !line) return;
        if (line.timer) clearTimeout(line.timer);
        lines = new Map([...lines].filter(([k]) => k !== id));
        cancelled = new Set([...cancelled, id]);
        if (!line.finished) send({ context_id: id, close_context: true });
      },
      close() {
        if (ended) return;
        ended = true;
        clearTimers();
        if (socket?.readyState === WS_OPEN) socket.send(JSON.stringify({ close_socket: true }));
        socket?.close();
      },
    };
  };
}

type VoiceConfig = Pick<AppConfig, 'AI_VOICE_TTS' | 'ELEVENLABS_API_KEY' | 'AI_VOICE_ELEVENLABS_VOICE' | 'AI_VOICE_ELEVENLABS_MODEL'>;

/** The external voice the config asks for, or null for the OpenAI voice (also when ElevenLabs is chosen without a key). */
export function externalVoiceFor(cfg: VoiceConfig, log: BridgeLog, connect: ConnectTts = connectWs): OpenTts | null {
  if (cfg.AI_VOICE_TTS !== 'elevenlabs') return null;
  if (!cfg.ELEVENLABS_API_KEY) {
    log.warn({}, 'ai-voice: AI_VOICE_TTS=elevenlabs but ELEVENLABS_API_KEY is not set — using the OpenAI voice');
    return null;
  }
  return elevenLabsTts({ apiKey: cfg.ELEVENLABS_API_KEY, voiceId: cfg.AI_VOICE_ELEVENLABS_VOICE, modelId: cfg.AI_VOICE_ELEVENLABS_MODEL }, log, connect);
}
