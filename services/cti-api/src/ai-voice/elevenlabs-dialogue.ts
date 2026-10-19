/**
 * The ElevenLabs voice for an AI call on the text-to-dialogue socket, the one ElevenLabs serves its v3/v4 models on
 * (eleven_v4_turbo: the owner's ear test; ~0.24 s to first audio measured 2026-10-19). One socket per call naming the
 * voice first; no contexts: the audio comes back in the order the sentences were sent, each sentence (flushed as soon
 * as it is written) followed by its `is_final_audio_for_turn`. So a line is done when it is finished and every
 * sentence of it has its end marker; a cut line's audio is dropped as it arrives (the socket has no way to stop it,
 * and generation is several times faster than speech). Each line starts a new turn. A keep-alive every 10 s holds the
 * socket open through quiet stretches (it closes after 20 s without a message).
 *
 * After the owner's first call (crackle on words, bursts at line starts): the audio comes as 16 kHz PCM and is made
 * phone audio here (phone-audio.ts); a line's first quarter second is held and sent as one piece, so a late second
 * chunk can't stutter its start (it arrives ~5 ms after the first, so this costs next to nothing); and a line's first
 * words go out at its first comma, so the voice starts before the first sentence is fully written.
 *
 * After the owner's second call (Sam cut in and out on the phone; the same audio was clean as a file): the bridge gets
 * whole 20 ms frames only, as from the OpenAI voice (phone-audio.ts `wholeFrames`).
 */
import type { BridgeLog } from './bridge-tools.js';
import {
  ELEVENLABS_FINAL_TIMEOUT_MS,
  ELEVENLABS_WS,
  connectWs,
  openTtsConnection,
  speakable,
  splitPhrases,
  type ConnectTts,
  type ElevenLabsSettings,
} from './elevenlabs-socket.js';
import type { OpenTts, TtsEvents, TtsStream } from './external-voice.js';
import { lastFrame, phoneDownsampler, wholeFrames, type PhoneDownsampler } from './phone-audio.js';

/** The models ElevenLabs serves only on this socket. */
export const DIALOGUE_MODEL = /^eleven_v[34]/;
export const DIALOGUE_KEEP_ALIVE_MS = 10_000;
/** What ElevenLabs sends: 16 kHz PCM, made 8 kHz μ-law here. */
const SOURCE_FORMAT = 'pcm_16000';
/** A line's first audio is held until there is this much, or its sentence ends. */
export const DIALOGUE_START_HOLD_MS = 250;
const PHONE_BYTES_PER_MS = 8;
/** As in the owner's ear test (this socket takes stability only). */
const VOICE_SETTINGS = { stability: 0.5 };

export function elevenLabsDialogueUrl(modelId: string): string {
  const query = new URLSearchParams({ model_id: modelId, output_format: SOURCE_FORMAT });
  return `${ELEVENLABS_WS}/text-to-dialogue/stream-input?${query.toString()}`;
}

interface Line {
  /** Text written but not yet sent (no sentence end yet). */
  buffer: string;
  /** Sentences sent, and end markers back. */
  sent: number;
  spoken: number;
  /** No more text is coming. */
  finished: boolean;
  /** The caller cut in: its audio is dropped. */
  cut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** This line's 16 kHz → phone audio converter. */
  phone: PhoneDownsampler;
  /** Phone audio held before the line starts playing. */
  held: Buffer;
  playing: boolean;
  /** Phone audio short of a whole frame, sent with the next piece (or filled out with silence at the line's end). */
  carry: Buffer;
}

const EMPTY = Buffer.alloc(0);
const newLine = (): Line => ({
  buffer: '',
  sent: 0,
  spoken: 0,
  finished: false,
  cut: false,
  timer: null,
  phone: phoneDownsampler(),
  held: EMPTY,
  playing: false,
  carry: EMPTY,
});

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function elevenLabsDialogue(s: ElevenLabsSettings, log: BridgeLog, connect: ConnectTts = connectWs): OpenTts {
  return (events: TtsEvents): TtsStream => {
    let lines = new Map<string, Line>();
    /** The line of each sentence sent and not yet spoken, oldest first: the order its audio comes back in. */
    let order: string[] = [];
    let ended = false;

    const clearTimers = (): void => {
      for (const line of lines.values()) if (line.timer) clearTimeout(line.timer);
    };
    const setLine = (id: string, line: Line): void => {
      lines = new Map([...lines, [id, line]]);
    };
    const forget = (id: string, line: Line): void => {
      if (line.timer) clearTimeout(line.timer);
      lines = new Map([...lines].filter(([k]) => k !== id));
    };

    const emit = (id: string, ulaw: Buffer): void => {
      if (ulaw.length) events.audio(id, ulaw.toString('base64'));
    };

    /** Done when finished and fully spoken (its last part frame filled out); a cut line is just forgotten once its last sentence is back. */
    const settle = (id: string): void => {
      const line = lines.get(id);
      if (!line || line.spoken < line.sent) return;
      if (line.cut) return forget(id, line);
      if (!line.finished) return;
      forget(id, line);
      emit(id, lastFrame(line.carry));
      events.done(id);
    };

    /** The line is kept with its new part frame, then the whole frames of its old one and `ulaw` go out. */
    const stream = (id: string, line: Line, ulaw: Buffer): void => {
      const { frames, carry } = wholeFrames(line.carry, ulaw);
      setLine(id, { ...line, carry });
      emit(id, frames);
    };

    /** Converted, then held until the line has a quarter second (or its sentence ends), then streamed. */
    const play = (id: string, line: Line, pcm: Buffer): void => {
      const ulaw = line.phone.push(pcm);
      if (line.playing) return stream(id, line, ulaw);
      const held = Buffer.concat([line.held, ulaw]);
      if (held.length < DIALOGUE_START_HOLD_MS * PHONE_BYTES_PER_MS) return setLine(id, { ...line, held });
      stream(id, { ...line, held: EMPTY, playing: true }, held);
    };

    const onMessage = (m: Record<string, unknown>): void => {
      if (str(m.error)) return conn.fail(`ElevenLabs error ${str(m.error)}${str(m.message) ? `: ${str(m.message)}` : ''}`);
      const head = order[0];
      if (head === undefined) return;
      const line = lines.get(head);
      if (str(m.audio) && line && !line.cut) play(head, line, Buffer.from(str(m.audio), 'base64'));
      if (m.is_final_audio_for_turn !== true) return;
      order = order.slice(1);
      const now = lines.get(head);
      if (!now) return;
      const next = { ...now, held: EMPTY, playing: now.playing || now.held.length > 0, spoken: now.spoken + 1 };
      if (!now.cut && now.held.length) stream(head, next, now.held);
      else setLine(head, next);
      settle(head);
    };

    const conn = openTtsConnection({
      url: elevenLabsDialogueUrl(s.modelId),
      apiKey: s.apiKey,
      log,
      connect,
      hello: { voices: [s.voiceId], voice_settings: VOICE_SETTINGS },
      keepAlive: { everyMs: DIALOGUE_KEEP_ALIVE_MS, message: { keep_alive: true } },
      busy: () => order.length > 0 || [...lines.values()].some((l) => !l.cut),
      onMessage,
      onFail: (message) => {
        ended = true;
        clearTimers();
        events.failed(new Error(message));
      },
    });

    /** One sentence, flushed; the first of a line starts a new turn. */
    const sendSentence = (id: string, line: Line, text: string): Line => {
      conn.send({ inputs: [{ text: `${text} `, voice_id: s.voiceId, new_turn: line.sent === 0 }], flush: true });
      order = [...order, id];
      return { ...line, sent: line.sent + 1 };
    };

    return {
      speak(id, text) {
        const known = lines.get(id);
        if (ended || known?.cut || known?.finished) return;
        const start: Line = known ?? newLine();
        const { phrases, rest } = splitPhrases(start.buffer + text, { firstClause: start.sent === 0 });
        const line = phrases.reduce((l, phrase) => sendSentence(id, l, phrase), { ...start, buffer: rest });
        setLine(id, line);
      },
      finish(id) {
        const known = lines.get(id);
        if (ended || !known || known.finished || known.cut) return;
        const last = known.buffer.trim();
        const line = speakable(last) ? sendSentence(id, { ...known, buffer: '' }, last) : known;
        const timer = setTimeout(() => conn.fail(`ElevenLabs gave no final audio for a line in ${ELEVENLABS_FINAL_TIMEOUT_MS} ms`), ELEVENLABS_FINAL_TIMEOUT_MS);
        setLine(id, { ...line, buffer: '', finished: true, timer });
        settle(id);
      },
      cancel(id) {
        const line = lines.get(id);
        if (ended || !line) return;
        if (line.timer) clearTimeout(line.timer);
        setLine(id, { ...line, buffer: '', cut: true, timer: null, held: EMPTY, carry: EMPTY });
        settle(id);
      },
      close() {
        if (ended) return;
        ended = true;
        clearTimers();
        conn.close();
      },
    };
  };
}
