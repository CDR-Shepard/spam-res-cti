/**
 * The ElevenLabs voice for an AI call on the multi-context text-to-speech socket (spec
 * 2026-10-19-ai-voice-elevenlabs-design.md), which serves the v2 models (eleven_flash_v2_5, eleven_turbo_v2_5): a
 * context per agent line. Each sentence goes out as soon as it is written (with `flush`), so the first is spoken while
 * the rest is still being written; a line ends with `flush` + `close_context` and is done at ElevenLabs' `isFinal`.
 * The v3/v4 models are served on the text-to-dialogue socket instead (elevenlabs-dialogue.ts); `externalVoiceFor`
 * picks the client from the model.
 */
import type { AppConfig } from '../config.js';
import type { BridgeLog } from './bridge-tools.js';
import { DIALOGUE_MODEL, elevenLabsDialogue } from './elevenlabs-dialogue.js';
import {
  ELEVENLABS_FINAL_TIMEOUT_MS,
  ELEVENLABS_WS,
  OUTPUT_FORMAT,
  connectWs,
  openTtsConnection,
  speakable,
  splitPhrases,
  type ConnectTts,
  type ElevenLabsSettings,
} from './elevenlabs-socket.js';
import type { OpenTts, TtsEvents, TtsStream } from './external-voice.js';

/** The longest ElevenLabs allows (seconds); an idle socket closes after it and the next line reopens it. */
const INACTIVITY_TIMEOUT_S = 180;
/** As in the owner's ear test (ElevenLabs' defaults). */
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };

export function elevenLabsUrl(voiceId: string, modelId: string): string {
  const query = new URLSearchParams({ model_id: modelId, output_format: OUTPUT_FORMAT, inactivity_timeout: String(INACTIVITY_TIMEOUT_S) });
  return `${ELEVENLABS_WS}/text-to-speech/${encodeURIComponent(voiceId)}/multi-stream-input?${query.toString()}`;
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
    let lines = new Map<string, Line>();
    /** Lines cut off by the caller: whatever ElevenLabs still sends for them is dropped. */
    let cancelled = new Set<string>();
    /** close() was called or the voice failed: nothing more is sent or reported. */
    let ended = false;

    const clearTimers = (): void => {
      for (const line of lines.values()) if (line.timer) clearTimeout(line.timer);
    };

    const onMessage = (m: Record<string, unknown>): void => {
      if (str(m.error)) return conn.fail(`ElevenLabs error ${str(m.error)}${str(m.message) ? `: ${str(m.message)}` : ''}`);
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

    const conn = openTtsConnection({
      url: elevenLabsUrl(s.voiceId, s.modelId),
      apiKey: s.apiKey,
      log,
      connect,
      busy: () => lines.size > 0,
      onMessage,
      onFail: (message) => {
        ended = true;
        clearTimers();
        events.failed(new Error(message));
      },
    });

    const setLine = (id: string, line: Line): void => {
      lines = new Map([...lines, [id, line]]);
    };

    return {
      speak(id, text) {
        if (ended || cancelled.has(id)) return;
        const line = lines.get(id) ?? null;
        if (line?.finished) return;
        if (!line) conn.send({ text: ' ', context_id: id, voice_settings: VOICE_SETTINGS });
        const { phrases, rest } = splitPhrases((line?.buffer ?? '') + text);
        setLine(id, { buffer: rest, finished: false, timer: null });
        for (const phrase of phrases) conn.send({ text: `${phrase} `, context_id: id, flush: true });
      },
      finish(id) {
        const line = lines.get(id);
        if (ended || !line || line.finished) return;
        const last = line.buffer.trim();
        if (speakable(last)) conn.send({ text: `${last} `, context_id: id, flush: true });
        conn.send({ context_id: id, close_context: true });
        const timer = setTimeout(() => conn.fail(`ElevenLabs gave no final audio for a line in ${ELEVENLABS_FINAL_TIMEOUT_MS} ms`), ELEVENLABS_FINAL_TIMEOUT_MS);
        setLine(id, { buffer: '', finished: true, timer });
      },
      cancel(id) {
        const line = lines.get(id);
        if (ended || !line) return;
        if (line.timer) clearTimeout(line.timer);
        lines = new Map([...lines].filter(([k]) => k !== id));
        cancelled = new Set([...cancelled, id]);
        if (!line.finished) conn.send({ context_id: id, close_context: true });
      },
      close() {
        if (ended) return;
        ended = true;
        clearTimers();
        conn.close({ close_socket: true });
      },
    };
  };
}

type VoiceConfig = Pick<AppConfig, 'AI_VOICE_TTS' | 'AI_VOICE_BARGE_IN' | 'ELEVENLABS_API_KEY' | 'AI_VOICE_ELEVENLABS_VOICE' | 'AI_VOICE_ELEVENLABS_MODEL'>;

/**
 * The external voice the config asks for, or null for the OpenAI voice: also when ElevenLabs is chosen without a key,
 * or with instant barge-in (OpenAI starts and cuts responses itself there, which the voice layer can't follow).
 * v3/v4 models go to the text-to-dialogue socket, the others to the multi-context one.
 */
export function externalVoiceFor(cfg: VoiceConfig, log: BridgeLog, connect: ConnectTts = connectWs): OpenTts | null {
  if (cfg.AI_VOICE_TTS !== 'elevenlabs') return null;
  if (!cfg.ELEVENLABS_API_KEY) {
    log.warn({}, 'ai-voice: AI_VOICE_TTS=elevenlabs but ELEVENLABS_API_KEY is not set — using the OpenAI voice');
    return null;
  }
  if (cfg.AI_VOICE_BARGE_IN !== 'gate') {
    log.warn({}, 'ai-voice: AI_VOICE_TTS=elevenlabs needs AI_VOICE_BARGE_IN=gate — using the OpenAI voice');
    return null;
  }
  const settings = { apiKey: cfg.ELEVENLABS_API_KEY, voiceId: cfg.AI_VOICE_ELEVENLABS_VOICE, modelId: cfg.AI_VOICE_ELEVENLABS_MODEL };
  return DIALOGUE_MODEL.test(settings.modelId) ? elevenLabsDialogue(settings, log, connect) : elevenLabsTts(settings, log, connect);
}
