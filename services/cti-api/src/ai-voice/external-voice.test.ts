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

  it('a cut while OpenAI is still writing: the rest of that line is never spoken, and the done goes once OpenAI ends it', () => {
    fromOpenAi({ type: 'response.created', response: { id: 'r1' } });
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r1', item_id: 'i1', delta: 'Hi Jane. ' });
    voice.send(JSON.stringify({ type: 'conversation.item.truncate', item_id: 'i1', content_index: 0, audio_end_ms: 200 }));
    voice.send(JSON.stringify({ type: 'response.cancel' }));
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r1', item_id: 'i1', delta: 'This is Sam.' });
    fromOpenAi({ type: 'response.output_text.done', response_id: 'r1', item_id: 'i1', text: 'Hi Jane. This is Sam.' });
    expect(tts.calls).toEqual(['speak i1 Hi Jane. ', 'cancel i1']);
    expect(types()).not.toContain('response.done');
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } });
    expect(types().slice(-3)).toEqual(['response.output_audio.done', 'response.output_audio_transcript.done', 'response.done']);
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
    tts.events.audio('i1', 'AAAA'); // the caller heard some of it
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

describe('withExternalVoice — the voice fails mid-line', () => {
  it('a line partly heard, before OpenAI ends the response: it is closed out at once, and the done passes straight through later', () => {
    fromOpenAi({ type: 'response.created', response: { id: 'r1' } });
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r1', item_id: 'i1', delta: 'Hi Jane' });
    tts.events.audio('i1', 'AAAA');
    tts.events.failed(new Error('x'));
    expect(types().slice(-2)).toEqual(['response.output_audio.done', 'response.output_audio_transcript.done']);
    expect(got.at(-1)).toMatchObject({ transcript: 'Hi Jane' });
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
    expect(types().at(-1)).toBe('response.done');
    expect(types().filter((t) => t === 'response.output_audio.done')).toHaveLength(1);
  });
});

describe('withExternalVoice — the voice fails before the caller heard the line', () => {
  const AUDIO = { type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'] } };

  it('the line is deleted and OpenAI is asked again with the same request, in its own voice; the bridge never sees the unheard done', () => {
    voice.send(JSON.stringify({ type: 'response.create', event_id: 'ai-create-1', response: { tool_choice: 'none' } }));
    textResponse();
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [{ id: 'i1', type: 'message' }] } });
    tts.events.failed(new Error('quota_exceeded'));
    expect(sentToOpenAi().slice(1)).toEqual([
      AUDIO,
      { type: 'conversation.item.delete', item_id: 'i1' },
      { type: 'response.create', response: { tool_choice: 'none' } },
    ]);
    expect(types()).not.toContain('response.done');
    expect(types()).not.toContain('response.output_audio_transcript.done');
  });

  it('a response with a tool call is not asked for again: its unheard line is deleted and its done goes on, so the tool runs once', () => {
    textResponse();
    const output = [{ id: 'i1', type: 'message' }, { id: 'f1', type: 'function_call', name: 'mark_do_not_call' }];
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output } });
    tts.events.failed(new Error('x'));
    expect(sentToOpenAi()).toEqual([AUDIO, { type: 'conversation.item.delete', item_id: 'i1' }]);
    expect(types().at(-1)).toBe('response.done');
    expect(got.at(-1)).toMatchObject({ response: { output } });
    expect(types()).not.toContain('response.output_audio_transcript.done');
  });

  it('the caller cuts in before OpenAI has ended the unheard response: it is not asked for again, its done goes on as it is', () => {
    textResponse();
    tts.events.failed(new Error('x'));
    voice.send(JSON.stringify({ type: 'response.cancel' }));
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [{ id: 'i1', type: 'message' }] } });
    expect(sentToOpenAi()).toEqual([AUDIO, { type: 'response.cancel' }]);
    expect(types().at(-1)).toBe('response.done');
  });

  it('still being written: OpenAI is asked again once it has ended that response', () => {
    textResponse();
    tts.events.failed(new Error('x'));
    expect(sentToOpenAi()).toEqual([AUDIO]);
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [{ id: 'i1', type: 'message' }] } });
    expect(sentToOpenAi().slice(1)).toEqual([{ type: 'conversation.item.delete', item_id: 'i1' }, { type: 'response.create' }]);
    expect(types()).not.toContain('response.done');
  });

  it('a response the caller cut off is not asked for again: its done goes on', () => {
    textResponse();
    tts.events.failed(new Error('x'));
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [{ id: 'i1', type: 'message' }] } });
    expect(sentToOpenAi()).toEqual([AUDIO]);
    expect(types().at(-1)).toBe('response.done');
  });

  it('before the OpenAI socket is open: nothing is sent and nothing throws (the bridge asks for audio itself once it opens)', () => {
    openai.readyState = 0;
    expect(() => tts.events.failed(new Error('x'))).not.toThrow();
    expect(openai.sent).toEqual([]);
    openai.readyState = 1;
    voice.send(JSON.stringify(AUDIO));
    expect(sentToOpenAi()).toEqual([AUDIO]);
  });
});

describe('withExternalVoice — a response OpenAI ends unusually', () => {
  it('a cancel before any text arrived: what OpenAI still writes for it is never spoken, and its done goes on', () => {
    fromOpenAi({ type: 'response.created', response: { id: 'r1' } });
    voice.send(JSON.stringify({ type: 'response.cancel' }));
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r1', item_id: 'i1', delta: 'Hi' });
    fromOpenAi({ type: 'response.output_text.done', response_id: 'r1', item_id: 'i1', text: 'Hi' });
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [] } });
    expect(tts.calls).toEqual([]);
    expect(types().at(-1)).toBe('response.done');
  });

  it('no text done: a completed line is spoken to its end, a failed one is stopped; either way the done goes', () => {
    fromOpenAi({ type: 'response.created', response: { id: 'r1' } });
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r1', item_id: 'i1', delta: 'Hi Jane.' });
    fromOpenAi({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } });
    expect(tts.calls.at(-1)).toBe('finish i1');
    expect(types()).not.toContain('response.done');
    tts.events.done('i1');
    expect(types().at(-1)).toBe('response.done');

    fromOpenAi({ type: 'response.created', response: { id: 'r2' } });
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r2', item_id: 'i2', delta: 'So the' });
    fromOpenAi({ type: 'response.done', response: { id: 'r2', status: 'failed', output: [] } });
    expect(tts.calls.at(-1)).toBe('cancel i2');
    expect(types().filter((t) => t === 'response.done')).toHaveLength(2);
  });

  it('warns when one response has a second spoken line (the two may overlap)', () => {
    fromOpenAi({ type: 'response.created', response: { id: 'r1' } });
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r1', item_id: 'i1', delta: 'One.' });
    fromOpenAi({ type: 'response.output_text.delta', response_id: 'r1', item_id: 'i2', delta: 'Two.' });
    expect(warn).toHaveBeenCalledWith({ responseId: 'r1' }, 'ai-voice: a second spoken line in one response — the two may overlap');
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
