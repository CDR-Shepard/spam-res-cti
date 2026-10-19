import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withExternalVoice, type TtsEvents, type TtsStream } from './external-voice.js';
import { fakeSocket, silentLog, type FakeSocket } from './testing.js';

interface FakeTts extends TtsStream {
  calls: string[];
  events: TtsEvents;
}

let openai: FakeSocket;
let tts: FakeTts;
let got: Array<Record<string, unknown>>;
let warn: ReturnType<typeof vi.fn>;

function fakeTts(events: TtsEvents): FakeTts {
  const t: FakeTts = {
    calls: [],
    events,
    speak: (id, text) => t.calls.push(`speak ${id} ${text}`),
    finish: (id) => t.calls.push(`finish ${id}`),
    cancel: (id) => t.calls.push(`cancel ${id}`),
    close: () => t.calls.push('close'),
  };
  return t;
}

const fromOpenAi = (m: object) => openai.emit('message', JSON.stringify(m));
const sentToOpenAi = () => openai.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
const types = () => got.map((m) => m.type);

let voice: ReturnType<typeof withExternalVoice>;

beforeEach(() => {
  openai = fakeSocket();
  got = [];
  warn = vi.fn();
  voice = withExternalVoice(openai, (events) => (tts = fakeTts(events)), { ...silentLog, warn });
  voice.on('message', (d) => {
    try {
      got.push(JSON.parse(d) as Record<string, unknown>);
    } catch {
      got.push({ raw: d });
    }
  });
});

/** One response with one text item: created, two text deltas, text done. */
function textResponse(id = 'r1', item = 'i1', words = ['Hi Jane, ', 'this is Sam.']): void {
  fromOpenAi({ type: 'response.created', response: { id } });
  for (const delta of words) fromOpenAi({ type: 'response.output_text.delta', response_id: id, item_id: item, delta });
  fromOpenAi({ type: 'response.output_text.done', response_id: id, item_id: item, text: words.join('') });
}

describe('withExternalVoice — the session answers in text, the voice speaks it', () => {
  it('session.update asks OpenAI for text instead of audio; everything else is sent as is', () => {
    voice.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'], instructions: 'x' } }));
    voice.send(JSON.stringify({ type: 'response.create' }));
    expect(sentToOpenAi()).toEqual([
      { type: 'session.update', session: { type: 'realtime', output_modalities: ['text'], instructions: 'x' } },
      { type: 'response.create' },
    ]);
  });

  it("streams each text delta to the voice and hands the voice's audio to the bridge as OpenAI audio", () => {
    textResponse();
    expect(tts.calls).toEqual(['speak i1 Hi Jane, ', 'speak i1 this is Sam.', 'finish i1']);
    tts.events.audio('i1', 'AAAA');
    expect(got).toContainEqual({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'i1', delta: 'AAAA' });
    expect(types()).not.toContain('response.output_text.delta');
  });

  it('holds response.done until the voice has finished the audio, then sends audio done, the transcript, and done', () => {
    textResponse();
    tts.events.audio('i1', 'AAAA');
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
    expect(types()).not.toContain('response.done');
    tts.events.done('i1');
    expect(types().slice(-3)).toEqual(['response.output_audio.done', 'response.output_audio_transcript.done', 'response.done']);
    expect(got.find((m) => m.type === 'response.output_audio_transcript.done')).toMatchObject({ item_id: 'i1', transcript: 'Hi Jane, this is Sam.' });
  });

  it('a response with no text (only tool calls) is done at once', () => {
    fromOpenAi({ type: 'response.created', response: { id: 'r2' } });
    fromOpenAi({ type: 'response.done', response: { id: 'r2', status: 'completed', output: [{ type: 'function_call' }] } });
    expect(types()).toEqual(['response.created', 'response.done']);
  });

  it('other OpenAI events (caller speech, transcription, errors) pass straight through', () => {
    fromOpenAi({ type: 'input_audio_buffer.speech_started', item_id: 'c1' });
    fromOpenAi({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c1', transcript: 'hello' });
    expect(types()).toEqual(['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.completed']);
  });
});

describe('withExternalVoice — the caller cuts in', () => {
  it("a truncate stops the voice for that item (no more audio) and is not sent to OpenAI (it can't cut text)", () => {
    textResponse();
    tts.events.audio('i1', 'AAAA');
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
    voice.send(JSON.stringify({ type: 'conversation.item.truncate', item_id: 'i1', content_index: 0, audio_end_ms: 400 }));
    expect(tts.calls).toContain('cancel i1');
    expect(sentToOpenAi()).toEqual([]);
    tts.events.audio('i1', 'BBBB'); // already generated: dropped
    expect(got.filter((m) => m.type === 'response.output_audio.delta')).toHaveLength(1);
    expect(types().at(-1)).toBe('response.done'); // the held done is released by the cut
  });

  it('response.cancel while OpenAI is still writing: sent on, and the voice stops; the cancelled done is not held', () => {
    fromOpenAi({ type: 'response.created', response: { id: 'r1' } });
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r1', item_id: 'i1', delta: 'Hi Jane' });
    voice.send(JSON.stringify({ type: 'response.cancel' }));
    expect(sentToOpenAi()).toEqual([{ type: 'response.cancel' }]);
    expect(tts.calls).toContain('cancel i1');
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } });
    expect(types().at(-1)).toBe('response.done');
  });

  it('response.cancel after OpenAI finished (only the voice is still going): not sent, the voice stops, the done is released', () => {
    textResponse();
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
    voice.send(JSON.stringify({ type: 'response.cancel' }));
    expect(sentToOpenAi()).toEqual([]);
    expect(tts.calls).toContain('cancel i1');
    expect(types().at(-1)).toBe('response.done');
  });
});

describe('withExternalVoice — the voice fails', () => {
  it('switches the session back to OpenAI audio, releases what it held, and from then on passes everything through', () => {
    textResponse();
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
    tts.events.failed(new Error('socket closed 1008'));
    expect(sentToOpenAi()).toEqual([{ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'] } }]);
    expect(types().at(-1)).toBe('response.done');
    expect(warn).toHaveBeenCalledWith({ err: 'socket closed 1008' }, 'ai-voice: the external voice failed — the call carries on in the OpenAI voice');
    voice.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'] } }));
    expect(sentToOpenAi().at(-1)).toEqual({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'] } });
    fromOpenAi({ type: 'response.output_audio.delta', response_id: 'r2', item_id: 'i2', delta: 'CCCC' });
    expect(got.at(-1)).toMatchObject({ type: 'response.output_audio.delta', delta: 'CCCC' });
  });
});

describe('withExternalVoice — the socket', () => {
  it('close() closes the voice and the OpenAI socket; readyState is OpenAI’s', () => {
    expect(voice.readyState).toBe(1);
    voice.close(1000, 'bye');
    expect(tts.calls).toContain('close');
    expect(openai.closed).toBe(true);
  });

  it('a frame that is not JSON is passed through untouched', () => {
    openai.emit('message', 'not json');
    voice.send('also not json');
    expect(got).toEqual([{ raw: 'not json' }]);
    expect(openai.sent).toEqual(['also not json']);
  });
});
