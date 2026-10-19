import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elevenLabsDialogueUrl } from './elevenlabs-dialogue.js';
import { ELEVENLABS_FINAL_TIMEOUT_MS, splitPhrases, type TtsSocket } from './elevenlabs-socket.js';
import { elevenLabsTts, elevenLabsUrl, externalVoiceFor } from './elevenlabs-tts.js';
import type { TtsEvents, TtsStream } from './external-voice.js';
import { PHONE_FRAME_BYTES, lastFrame } from './phone-audio.js';
import { silentLog } from './testing.js';

interface FakeTtsSocket extends TtsSocket {
  sent: Array<Record<string, unknown>>;
  closed: boolean;
  readyState: number;
  emit(ev: string, ...args: unknown[]): void;
}

function fakeTtsSocket(): FakeTtsSocket {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const s = {
    sent: [] as Array<Record<string, unknown>>,
    closed: false,
    readyState: 0,
    send(d: string) {
      if (s.readyState !== 1) throw new Error('WebSocket is not open');
      s.sent.push(JSON.parse(d) as Record<string, unknown>);
    },
    close() {
      s.closed = true;
      s.readyState = 3;
    },
    on(ev: string, cb: (...a: unknown[]) => void) {
      (handlers[ev] ??= []).push(cb);
    },
    emit(ev: string, ...args: unknown[]) {
      if (ev === 'open') s.readyState = 1;
      if (ev === 'close') s.readyState = 3;
      for (const h of handlers[ev] ?? []) h(...args);
    },
  };
  return s as unknown as FakeTtsSocket;
}

const SETTINGS = { apiKey: 'xi-test-key', voiceId: 'eXpIbVcVbLo8ZJQDlDnl', modelId: 'eleven_v4_turbo' };

let sockets: FakeTtsSocket[];
let connects: Array<{ url: string; headers: Record<string, string> }>;
let calls: string[];
let tts: TtsStream;
let warn: ReturnType<typeof vi.fn>;

const sock = () => sockets.at(-1) as FakeTtsSocket;
const fromServer = (m: object) => sock().emit('message', JSON.stringify(m));

beforeEach(() => {
  sockets = [];
  connects = [];
  calls = [];
  warn = vi.fn();
  const events: TtsEvents = {
    audio: (id, b64) => calls.push(`audio ${id} ${b64}`),
    done: (id) => calls.push(`done ${id}`),
    failed: (err) => calls.push(`failed ${err.message}`),
  };
  const open = elevenLabsTts(SETTINGS, { ...silentLog, warn }, (url, headers) => {
    connects.push({ url, headers });
    const s = fakeTtsSocket();
    sockets.push(s);
    return s;
  });
  tts = open(events);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('elevenLabsUrl', () => {
  it('is the multi-context stream for the voice, in phone audio (8 kHz μ-law), kept open up to 3 minutes idle', () => {
    expect(elevenLabsUrl('eXpIbVcVbLo8ZJQDlDnl', 'eleven_v4_turbo')).toBe(
      'wss://api.elevenlabs.io/v1/text-to-speech/eXpIbVcVbLo8ZJQDlDnl/multi-stream-input?model_id=eleven_v4_turbo&output_format=ulaw_8000&inactivity_timeout=180',
    );
  });
});

describe('splitPhrases — whole sentences go to the voice as soon as they are written', () => {
  it('splits after a sentence end followed by a space and keeps the rest', () => {
    expect(splitPhrases('Hi Jane. This is Sam')).toEqual({ phrases: ['Hi Jane.'], rest: 'This is Sam' });
    expect(splitPhrases('Got it! Is now okay? I')).toEqual({ phrases: ['Got it!', 'Is now okay?'], rest: 'I' });
  });

  it('waits for the next character: a final period may still be "St." or "1.5"', () => {
    expect(splitPhrases('Hi Jane.')).toEqual({ phrases: [], rest: 'Hi Jane.' });
  });

  it('with firstClause, the first phrase may end at a comma, dash or colon once it has two words; later ones end at sentences', () => {
    expect(splitPhrases('Got it, so the', { firstClause: true })).toEqual({ phrases: ['Got it,'], rest: 'so the' });
    expect(splitPhrases('Hi Jane, this is Sam, with GG Homes. ', { firstClause: true })).toEqual({ phrases: ['Hi Jane,', 'this is Sam, with GG Homes.'], rest: '' });
    expect(splitPhrases('Okay, so the', { firstClause: true })).toEqual({ phrases: [], rest: 'Okay, so the' });
    expect(splitPhrases('It sold for $250,000 last', { firstClause: true })).toEqual({ phrases: [], rest: 'It sold for $250,000 last' });
    expect(splitPhrases('Got it, so the')).toEqual({ phrases: [], rest: 'Got it, so the' });
  });

  it('never makes a sentence of punctuation or an emoji alone (it has nothing to say): it goes with the next one', () => {
    expect(splitPhrases('Okay! ! So')).toEqual({ phrases: ['Okay!'], rest: '! So' });
    expect(splitPhrases('Sounds good. 🙂 ')).toEqual({ phrases: ['Sounds good.'], rest: '🙂 ' });
  });

  it('does not split after a title or street abbreviation, or inside a pause ("…")', () => {
    expect(splitPhrases('Is this Mr. Smith on Oak St. here? Yes')).toEqual({ phrases: ['Is this Mr. Smith on Oak St. here?'], rest: 'Yes' });
    expect(splitPhrases('six one nine... five five five... one two')).toEqual({ phrases: [], rest: 'six one nine... five five five... one two' });
  });
});

describe('elevenLabsTts — speaking a line', () => {
  it('connects at once with the key in a header (never in the URL)', () => {
    expect(connects).toEqual([{ url: elevenLabsUrl(SETTINGS.voiceId, SETTINGS.modelId), headers: { 'xi-api-key': 'xi-test-key' } }]);
  });

  it('holds what it is given until the socket opens, then sends it in order', () => {
    tts.speak('i1', 'Hi Jane. ');
    expect(sock().sent).toEqual([]);
    sock().emit('open');
    expect(sock().sent.map((m) => m.text)).toEqual([' ', 'Hi Jane. ']);
  });

  it('opens a context per line with the voice settings, sends each finished sentence with flush, the rest on finish, then closes it', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane');
    tts.speak('i1', '. This is ');
    tts.speak('i1', 'Sam');
    tts.finish('i1');
    expect(sock().sent).toEqual([
      { text: ' ', context_id: 'i1', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { text: 'Hi Jane. ', context_id: 'i1', flush: true },
      { text: 'This is Sam ', context_id: 'i1', flush: true },
      { context_id: 'i1', close_context: true },
    ]);
  });

  it('a line whose text all went out as sentences just closes on finish', () => {
    sock().emit('open');
    tts.speak('i1', 'Thanks so much. ');
    tts.finish('i1');
    expect(sock().sent.slice(-2)).toEqual([
      { text: 'Thanks so much. ', context_id: 'i1', flush: true },
      { context_id: 'i1', close_context: true },
    ]);
  });

  it("hands on the voice's audio and its final message for the line", () => {
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    tts.finish('i1');
    fromServer({ audio: 'AAAA', contextId: 'i1', alignment: null });
    fromServer({ audio: null, isFinal: true, contextId: 'i1' });
    expect(calls).toEqual([`audio i1 ${lastFrame(Buffer.from('AAAA', 'base64')).toString('base64')}`, 'done i1']);
  });

  it('hands on whole 20 ms frames only: a part frame waits for the next piece, the last one is filled out with silence', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    tts.finish('i1');
    const voice = Buffer.from(Array.from({ length: 379 }, (_, i) => i % 255));
    fromServer({ audio: voice.toString('base64'), contextId: 'i1' });
    fromServer({ isFinal: true, contextId: 'i1' });
    expect(calls).toEqual([
      `audio i1 ${voice.subarray(0, 2 * PHONE_FRAME_BYTES).toString('base64')}`,
      `audio i1 ${lastFrame(voice.subarray(2 * PHONE_FRAME_BYTES)).toString('base64')}`,
      'done i1',
    ]);
  });

  it('keeps the part frame across pieces, and takes audio that comes with the final message', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    tts.finish('i1');
    const voice = Buffer.from(Array.from({ length: 630 }, (_, i) => i % 255));
    const piece = (from: number, to: number) => voice.subarray(from, to).toString('base64');
    fromServer({ audio: piece(0, 100), contextId: 'i1' }); // nothing whole yet
    fromServer({ audio: piece(100, 200), contextId: 'i1' }); // one frame, 40 kept
    fromServer({ audio: piece(200, 330), contextId: 'i1' }); // one frame, 10 kept
    fromServer({ audio: piece(330, 630), isFinal: true, contextId: 'i1' }); // one frame, then the last 150 filled out
    const b64 = (b: Buffer) => b.toString('base64');
    expect(calls).toEqual([
      `audio i1 ${b64(voice.subarray(0, 160))}`,
      `audio i1 ${b64(voice.subarray(160, 320))}`,
      `audio i1 ${b64(voice.subarray(320, 480))}`,
      `audio i1 ${b64(lastFrame(voice.subarray(480)))}`,
      'done i1',
    ]);
  });

  it("a cut line's part frame is dropped, not played", () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane. This is');
    fromServer({ audio: Buffer.alloc(100, 7).toString('base64'), contextId: 'i1' });
    tts.cancel('i1');
    fromServer({ isFinal: true, contextId: 'i1' });
    expect(calls).toEqual([]);
  });

  it('cancel closes the line at once and drops anything still coming for it', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane. This is');
    tts.cancel('i1');
    expect(sock().sent.at(-1)).toEqual({ context_id: 'i1', close_context: true });
    fromServer({ audio: 'BBBB', contextId: 'i1' });
    fromServer({ isFinal: true, contextId: 'i1' });
    expect(calls).toEqual([]);
    tts.finish('i1');
    expect(sock().sent.filter((m) => m.close_context)).toHaveLength(1);
  });

  it('cancel of a line that never started sends nothing', () => {
    sock().emit('open');
    tts.cancel('i9');
    expect(sock().sent).toEqual([]);
  });
});

describe('elevenLabsTts — when the voice goes wrong', () => {
  it('fails if the socket closes before it ever opened (bad key, no credit), with the reason', () => {
    sock().emit('close', 1008, 'invalid_api_key');
    expect(calls).toEqual(['failed ElevenLabs socket closed 1008 invalid_api_key']);
  });

  it('fails on a socket error', () => {
    sock().emit('error', new Error('ECONNRESET'));
    expect(calls).toEqual(['failed ElevenLabs socket error: ECONNRESET']);
  });

  it('fails if the socket closes while a line is still being spoken', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane. ');
    sock().emit('close', 1011, '');
    expect(calls).toEqual(['failed ElevenLabs socket closed 1011']);
  });

  it('an idle close (no line in progress) is not a failure: the next line reconnects', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    tts.finish('i1');
    fromServer({ isFinal: true, contextId: 'i1' });
    sock().emit('close', 1000, 'inactivity');
    expect(calls).toEqual(['done i1']);
    tts.speak('i2', 'Still there? ');
    expect(sockets).toHaveLength(2);
    sock().emit('open');
    expect(sock().sent.map((m) => m.text)).toEqual([' ', 'Still there? ']);
  });

  it('fails on an error message from the server', () => {
    sock().emit('open');
    fromServer({ error: 'quota_exceeded', message: 'This request exceeds your quota.' });
    expect(calls).toEqual(['failed ElevenLabs error quota_exceeded: This request exceeds your quota.']);
  });

  it('fails if a finished line gets no final message in time, so a call never hangs on a silent voice', () => {
    vi.useFakeTimers();
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    tts.finish('i1');
    vi.advanceTimersByTime(ELEVENLABS_FINAL_TIMEOUT_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([`failed ElevenLabs gave no final audio for a line in ${ELEVENLABS_FINAL_TIMEOUT_MS} ms`]);
  });

  it('reports a failure once, and nothing after close()', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    sock().emit('error', new Error('x'));
    sock().emit('close', 1006, '');
    expect(calls).toEqual(['failed ElevenLabs socket error: x']);
    tts.close();
  });

  it('close() ends the socket politely and later socket events are ignored', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    tts.close();
    expect(sock().sent.at(-1)).toEqual({ close_socket: true });
    expect(sock().closed).toBe(true);
    sock().emit('close', 1000, '');
    expect(calls).toEqual([]);
  });
});

describe('externalVoiceFor — the AI_VOICE_TTS switch', () => {
  const cfg = {
    AI_VOICE_TTS: 'elevenlabs' as const,
    AI_VOICE_BARGE_IN: 'gate' as const,
    ELEVENLABS_API_KEY: 'k',
    AI_VOICE_ELEVENLABS_VOICE: 'v',
    AI_VOICE_ELEVENLABS_MODEL: 'm',
  };

  it('is none for the OpenAI voice (the default)', () => {
    expect(externalVoiceFor({ ...cfg, AI_VOICE_TTS: 'openai' }, silentLog)).toBeNull();
  });

  it('is the ElevenLabs voice when chosen with a key: v3/v4 models on the dialogue socket, the others on the multi-context one', () => {
    const urls: string[] = [];
    const connect = (url: string) => {
      urls.push(url);
      return fakeTtsSocket();
    };
    const events = { audio: () => {}, done: () => {}, failed: () => {} };
    externalVoiceFor({ ...cfg, AI_VOICE_ELEVENLABS_MODEL: 'eleven_v4_turbo' }, silentLog, connect)?.(events);
    externalVoiceFor({ ...cfg, AI_VOICE_ELEVENLABS_MODEL: 'eleven_flash_v2_5' }, silentLog, connect)?.(events);
    expect(urls).toEqual([elevenLabsDialogueUrl('eleven_v4_turbo'), elevenLabsUrl('v', 'eleven_flash_v2_5')]);
  });

  it('falls back to the OpenAI voice, with a warning, when ElevenLabs is chosen without a key', () => {
    const w = vi.fn();
    expect(externalVoiceFor({ ...cfg, ELEVENLABS_API_KEY: undefined }, { ...silentLog, warn: w })).toBeNull();
    expect(w).toHaveBeenCalledWith({}, 'ai-voice: AI_VOICE_TTS=elevenlabs but ELEVENLABS_API_KEY is not set — using the OpenAI voice');
  });

  it('uses the OpenAI voice, with a warning, with instant barge-in (OpenAI starts and cuts responses on its own there)', () => {
    const w = vi.fn();
    expect(externalVoiceFor({ ...cfg, AI_VOICE_BARGE_IN: 'instant' }, { ...silentLog, warn: w })).toBeNull();
    expect(w).toHaveBeenCalledWith({}, 'ai-voice: AI_VOICE_TTS=elevenlabs needs AI_VOICE_BARGE_IN=gate — using the OpenAI voice');
  });
});
