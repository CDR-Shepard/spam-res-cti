import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIALOGUE_KEEP_ALIVE_MS, elevenLabsDialogue, elevenLabsDialogueUrl } from './elevenlabs-dialogue.js';
import { ELEVENLABS_FINAL_TIMEOUT_MS, type TtsSocket } from './elevenlabs-socket.js';
import type { TtsStream } from './external-voice.js';
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

const VOICE = 'eXpIbVcVbLo8ZJQDlDnl';
const HELLO = { voices: [VOICE], voice_settings: { stability: 0.5 } };

let sockets: FakeTtsSocket[];
let connects: Array<{ url: string; headers: Record<string, string> }>;
let calls: string[];
let tts: TtsStream;

const sock = () => sockets.at(-1) as FakeTtsSocket;
const fromServer = (m: object) => sock().emit('message', JSON.stringify(m));
const sentence = (text: string, newTurn = false) => ({ inputs: [{ text, voice_id: VOICE, new_turn: newTurn }], flush: true });

beforeEach(() => {
  sockets = [];
  connects = [];
  calls = [];
  tts = elevenLabsDialogue({ apiKey: 'xi-test-key', voiceId: VOICE, modelId: 'eleven_v4_turbo' }, silentLog, (url, headers) => {
    connects.push({ url, headers });
    const s = fakeTtsSocket();
    sockets.push(s);
    return s;
  })({
    audio: (id, b64) => calls.push(`audio ${id} ${b64}`),
    done: (id) => calls.push(`done ${id}`),
    failed: (err) => calls.push(`failed ${err.message}`),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('elevenLabsDialogueUrl', () => {
  it('is the text-to-dialogue stream (the socket ElevenLabs serves v3/v4 on), in phone audio', () => {
    expect(elevenLabsDialogueUrl('eleven_v4_turbo')).toBe(
      'wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=ulaw_8000',
    );
  });
});

describe('elevenLabsDialogue — speaking lines', () => {
  it('connects at once with the key in a header, and names the voice first on the socket', () => {
    expect(connects).toEqual([{ url: elevenLabsDialogueUrl('eleven_v4_turbo'), headers: { 'xi-api-key': 'xi-test-key' } }]);
    tts.speak('i1', 'Hi Jane. ');
    sock().emit('open');
    expect(sock().sent).toEqual([HELLO, sentence('Hi Jane. ', true)]);
  });

  it('sends each finished sentence at once (flushed), the rest on finish; a line starts a new turn', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane');
    tts.speak('i1', '. This is ');
    tts.speak('i1', 'Sam');
    tts.finish('i1');
    expect(sock().sent.slice(1)).toEqual([sentence('Hi Jane. ', true), sentence('This is Sam ')]);
  });

  it("hands on each line's audio in order, and a line is done at its last sentence's end marker", () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane. This is Sam. ');
    tts.finish('i1');
    tts.speak('i2', 'Do you have a minute? ');
    tts.finish('i2');
    fromServer({ audio: 'A1' });
    fromServer({ is_final_audio_for_turn: true });
    fromServer({ audio: 'A2' });
    fromServer({ is_final_audio_for_turn: true });
    fromServer({ audio: 'B1' });
    fromServer({ is_final_audio_for_turn: true });
    expect(calls).toEqual(['audio i1 A1', 'audio i1 A2', 'done i1', 'audio i2 B1', 'done i2']);
  });

  it('a line is not done before it is finished, even if all its sentences so far are spoken', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane. ');
    fromServer({ audio: 'A1' });
    fromServer({ is_final_audio_for_turn: true });
    expect(calls).toEqual(['audio i1 A1']);
    tts.finish('i1');
    expect(calls).toEqual(['audio i1 A1', 'done i1']);
  });

  it("a cut line's audio is dropped and the rest of its text never sent; the next line's audio still lines up", () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane. This is');
    tts.cancel('i1');
    tts.speak('i1', ' Sam. ');
    tts.finish('i1');
    tts.speak('i2', 'Sorry, go ahead. ');
    tts.finish('i2');
    expect(sock().sent.slice(1)).toEqual([sentence('Hi Jane. ', true), sentence('Sorry, go ahead. ', true)]);
    fromServer({ audio: 'A1' });
    fromServer({ is_final_audio_for_turn: true });
    fromServer({ audio: 'B1' });
    fromServer({ is_final_audio_for_turn: true });
    expect(calls).toEqual(['audio i2 B1', 'done i2']);
  });

  it('keeps the socket alive while the call is quiet (it closes after 20 s without a message)', () => {
    vi.useFakeTimers();
    sock().emit('open');
    vi.advanceTimersByTime(DIALOGUE_KEEP_ALIVE_MS);
    expect(sock().sent.at(-1)).toEqual({ keep_alive: true });
  });

  it('after an idle close, the next line reconnects and names the voice again', () => {
    sock().emit('open');
    sock().emit('close', 1000, '');
    tts.speak('i1', 'Still there? ');
    expect(sockets).toHaveLength(2);
    sock().emit('open');
    expect(sock().sent).toEqual([HELLO, sentence('Still there? ', true)]);
  });
});

describe('elevenLabsDialogue — text with nothing to say', () => {
  it('an emoji or punctuation left at the end of a line is never sent; the line is done with its last real sentence', () => {
    sock().emit('open');
    tts.speak('i1', 'Sounds good. 🙂');
    tts.finish('i1');
    expect(sock().sent.slice(1)).toEqual([sentence('Sounds good. ', true)]);
    fromServer({ audio: 'A1' });
    fromServer({ is_final_audio_for_turn: true });
    expect(calls).toEqual(['audio i1 A1', 'done i1']);
  });
});

describe('elevenLabsDialogue — the server closes the socket while a line is going out', () => {
  it('mid-line (sentences still owed): the voice fails at once, nothing goes to a second socket', () => {
    sock().emit('open');
    tts.speak('i1', 'One. Two. ');
    tts.cancel('i1');
    sock().readyState = 2; // the server's close frame is in; the close event is not yet
    tts.speak('i2', 'Next line here. ');
    expect(calls).toEqual(['failed ElevenLabs socket closing']);
    expect(sockets).toHaveLength(1);
  });

  it('between lines: a fresh socket opens (naming the voice first), and the old one is no longer kept alive', () => {
    vi.useFakeTimers();
    sock().emit('open');
    const old = sock();
    old.readyState = 2;
    tts.speak('i1', 'Still there? ');
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(DIALOGUE_KEEP_ALIVE_MS * 2);
    expect(old.sent.filter((m) => m.keep_alive)).toEqual([]);
    sock().emit('open');
    expect(sock().sent).toEqual([HELLO, sentence('Still there? ', true)]);
  });
});

describe('elevenLabsDialogue — when the voice goes wrong', () => {
  it('fails on an error message from the server', () => {
    sock().emit('open');
    fromServer({ error: 'quota_exceeded', message: 'This request exceeds your quota.', code: 1008 });
    expect(calls).toEqual(['failed ElevenLabs error quota_exceeded: This request exceeds your quota.']);
  });

  it('fails if the socket closes while a line is in progress', () => {
    sock().emit('open');
    tts.speak('i1', 'Hi Jane. ');
    sock().emit('close', 1011, '');
    expect(calls).toEqual(['failed ElevenLabs socket closed 1011']);
  });

  it('fails if a finished line gets no end marker in time', () => {
    vi.useFakeTimers();
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    tts.finish('i1');
    vi.advanceTimersByTime(ELEVENLABS_FINAL_TIMEOUT_MS);
    expect(calls).toEqual([`failed ElevenLabs gave no final audio for a line in ${ELEVENLABS_FINAL_TIMEOUT_MS} ms`]);
  });

  it('close() ends the socket; nothing is reported or kept alive after it', () => {
    vi.useFakeTimers();
    sock().emit('open');
    tts.speak('i1', 'Hi. ');
    tts.close();
    expect(sock().closed).toBe(true);
    const sent = sock().sent.length;
    vi.advanceTimersByTime(DIALOGUE_KEEP_ALIVE_MS * 3);
    sock().emit('close', 1000, '');
    expect(sock().sent).toHaveLength(sent);
    expect(calls).toEqual([]);
  });
});
