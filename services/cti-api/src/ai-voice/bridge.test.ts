import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiCallBridge,
  END_GRACE_MS,
  OPENER_DELAY_MS,
  SESSION_READY_TIMEOUT_MS,
  type BridgeHooks,
  type BridgeOptions,
  type BridgeSocket,
} from './bridge.js';
import { AI_CALL_TOOLS } from './prompt.js';

type Ev = 'message' | 'close' | 'error' | 'open';

/** A ws-like socket that records every JSON message sent through it. */
class FakeSocket implements BridgeSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  /** Every message ever sent; clearSent() leaves it alone (Twilio still echoes marks for audio sent before). */
  readonly history: Array<Record<string, unknown>> = [];
  closeCalls = 0;
  private readonly handlers: Record<Ev, Array<(a: unknown) => void>> = {
    message: [],
    close: [],
    error: [],
    open: [],
  };

  send(data: string): void {
    const m = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(m);
    this.history.push(m);
  }
  close(): void {
    this.closeCalls += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  on(ev: Ev, cb: (a: never) => void): void {
    this.handlers[ev].push(cb as (a: unknown) => void);
  }
  emit(ev: Ev, arg?: unknown): void {
    for (const h of this.handlers[ev]) h(arg);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  msg(o: object): void {
    this.emit('message', JSON.stringify(o));
  }
  types(): unknown[] {
    return this.sent.map((m) => m.type ?? m.event);
  }
  clearSent(): void {
    this.sent.length = 0;
  }
}

const SID = 'MZ0000';
const READY = { type: 'session.updated', session: {} };
/** Base64 μ-law audio lasting `ms` milliseconds. */
const audio = (ms: number): string => Buffer.alloc(ms * 8).toString('base64');
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

function setup(over: Partial<BridgeOptions> = {}, hookOver: { onTool?: BridgeHooks['onTool'] } = {}) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  const hooks = {
    onTool: hookOver.onTool ?? vi.fn(async () => ({ output: '{"ok":true}' })),
    onTranscript: vi.fn(),
    onEnd: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const bridge = new AiCallBridge(
    {
      twilio,
      openai,
      streamSid: SID,
      instructions: 'INSTRUCTIONS',
      tools: AI_CALL_TOOLS,
      voice: 'marin',
      model: 'gpt-realtime-2.1',
      reasoningEffort: 'low',
      vadEagerness: 'auto',
      maxCallMs: 600_000,
      ...over,
    },
    hooks,
  );
  return { twilio, openai, hooks, bridge };
}

function media(ts: number, payload = 'AAAA') {
  return {
    event: 'media',
    streamSid: SID,
    sequenceNumber: '3',
    media: { track: 'inbound', chunk: '1', timestamp: String(ts), payload },
  };
}

function fnCall(name: string, args: string, callId: string) {
  return {
    type: 'function_call',
    name,
    call_id: callId,
    arguments: args,
    status: 'completed',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('session.update', () => {
  it('sends the GA session shape on start', () => {
    const { openai, bridge } = setup();
    bridge.start();
    expect(openai.sent[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        output_modalities: ['audio'],
        instructions: 'INSTRUCTIONS',
        reasoning: { effort: 'low' },
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            noise_reduction: { type: 'near_field' },
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'auto',
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
        tools: AI_CALL_TOOLS,
        tool_choice: 'auto',
      },
    });
  });

  it('gate mode turns off server responses and barge-in and uses the given transcriber', () => {
    const { openai, bridge } = setup({ bargeIn: 'gate', transcribeModel: 'gpt-live-transcribe' });
    bridge.start();
    const session = (openai.sent[0] as { session: { audio: { input: Record<string, unknown> } } }).session;
    expect(session.audio.input.transcription).toEqual({ model: 'gpt-live-transcribe', language: 'en' });
    expect(session.audio.input.turn_detection).toEqual({
      type: 'semantic_vad',
      eagerness: 'auto',
      create_response: false,
      interrupt_response: false,
    });
  });

  it('instant mode with the config default transcriber (AI_VOICE_TRANSCRIBE_MODEL unset) sends exactly today\'s session.update (F3)', () => {
    const today = setup();
    today.bridge.start();
    const service = setup({ bargeIn: 'instant', transcribeModel: 'gpt-4o-mini-transcribe' });
    service.bridge.start();
    expect(JSON.stringify(service.openai.sent[0])).toBe(JSON.stringify(today.openai.sent[0]));
  });

  it('sends reasoning only for gpt-realtime-2* models', () => {
    const session = (model: string) => {
      const { openai, bridge } = setup({
        model,
        reasoningEffort: 'minimal',
        vadEagerness: 'high',
      });
      bridge.start();
      return (openai.sent[0] as { session: Record<string, unknown> }).session;
    };
    expect(session('gpt-realtime-2').reasoning).toEqual({ effort: 'minimal' });
    expect(session('gpt-realtime-2.1-mini').reasoning).toEqual({
      effort: 'minimal',
    });
    const xhigh = setup({ model: 'gpt-realtime-2.1', reasoningEffort: 'xhigh' });
    xhigh.bridge.start();
    expect((xhigh.openai.sent[0] as { session: { reasoning: unknown } }).session.reasoning).toEqual({
      effort: 'xhigh',
    });
    expect(session('gpt-realtime-1.5')).not.toHaveProperty('reasoning');
    expect(session('gpt-realtime')).not.toHaveProperty('reasoning');
    expect(session('gpt-realtime-mini')).not.toHaveProperty('reasoning');
    const s = session('gpt-realtime');
    expect((s.audio as { input: { turn_detection: { eagerness: string } } }).input.turn_detection.eagerness).toBe(
      'high',
    );
  });

  it('queues everything until the OpenAI socket opens, then flushes in order', () => {
    const { twilio, openai, bridge } = setup();
    openai.readyState = 0;
    twilio.msg(media(20, 'P1')); // arrives before start
    bridge.start();
    twilio.msg(media(40, 'P2'));
    expect(openai.sent).toEqual([]);
    openai.open();
    expect(openai.types()).toEqual(['session.update', 'input_audio_buffer.append', 'input_audio_buffer.append']);
    expect(openai.sent.slice(1).map((m) => m.audio)).toEqual(['P1', 'P2']);
    twilio.msg(media(60, 'P3'));
    expect(openai.sent[3]).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'P3',
    });
  });

  it('sends session.update before audio that arrived before start even when already open', () => {
    const { twilio, openai, bridge } = setup();
    twilio.msg(media(20, 'P1'));
    expect(openai.sent).toEqual([]);
    bridge.start();
    expect(openai.types()).toEqual(['session.update', 'input_audio_buffer.append']);
  });
});

describe('turn detection in the session (AI_VOICE_TURN_DETECTION / AI_VOICE_SILENCE_MS)', () => {
  const turnDetectionOf = (over: Partial<BridgeOptions>): unknown => {
    const { openai, bridge } = setup({ vadEagerness: 'high', ...over });
    bridge.start();
    return (openai.sent[0] as { session: { audio: { input: { turn_detection: unknown } } } }).session.audio.input.turn_detection;
  };

  it('gate + server_vad: the silence decides; the bridge answers and cuts (no eagerness, no auto response)', () => {
    expect(turnDetectionOf({ bargeIn: 'gate', turnDetection: 'server_vad', silenceMs: 650 })).toStrictEqual({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 650,
      create_response: false,
      interrupt_response: false,
    });
  });

  it('gate + semantic_vad: exactly today\'s gate turn detection (eagerness applies)', () => {
    expect(turnDetectionOf({ bargeIn: 'gate', turnDetection: 'semantic_vad', silenceMs: 650 })).toStrictEqual({
      type: 'semantic_vad',
      eagerness: 'high',
      create_response: false,
      interrupt_response: false,
    });
  });

  it('instant + semantic_vad: exactly today\'s instant turn detection', () => {
    expect(turnDetectionOf({ bargeIn: 'instant', turnDetection: 'semantic_vad', silenceMs: 650 })).toStrictEqual({
      type: 'semantic_vad',
      eagerness: 'high',
      create_response: true,
      interrupt_response: true,
    });
  });

  it('instant + server_vad (explicit only): the silence decides; OpenAI answers and cuts', () => {
    expect(turnDetectionOf({ bargeIn: 'instant', turnDetection: 'server_vad', silenceMs: 400 })).toStrictEqual({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 400,
      create_response: true,
      interrupt_response: true,
    });
  });

  it('a bare BridgeOptions defaults to semantic_vad and 500 ms: unchanged for both modes', () => {
    const bare = (bargeIn: 'gate' | 'instant') => JSON.stringify(turnDetectionOf({ bargeIn }));
    const explicit = (bargeIn: 'gate' | 'instant') => JSON.stringify(turnDetectionOf({ bargeIn, turnDetection: 'semantic_vad', silenceMs: 500 }));
    expect(bare('gate')).toBe(explicit('gate'));
    expect(bare('instant')).toBe(explicit('instant'));
  });

  it('instant mode with the new settings unset sends byte-identical session.update bytes to today', () => {
    const today = setup();
    today.bridge.start();
    const withDefaults = setup({ bargeIn: 'instant', transcribeModel: 'gpt-4o-mini-transcribe', turnDetection: 'semantic_vad', silenceMs: 500 });
    withDefaults.bridge.start();
    expect(JSON.stringify(withDefaults.openai.sent[0])).toBe(JSON.stringify(today.openai.sent[0]));
  });

  it('instant + server_vad: a hangup turns off auto responses keeping the same turn detection shape', async () => {
    const onTool = vi.fn(async () => ({ output: 'ok', then: 'hangup' as const }));
    const { openai, bridge } = setup({ bargeIn: 'instant', turnDetection: 'server_vad', silenceMs: 400 }, { onTool });
    bridge.start();
    openai.clearSent();
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('end_call', '{}', 'c1')] } });
    await flush();
    expect(openai.sent[1]).toStrictEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 400,
              create_response: false,
              interrupt_response: true,
            },
          },
        },
      },
    });
  });

  it('instant + semantic_vad: the hangup update is exactly today\'s', async () => {
    const onTool = vi.fn(async () => ({ output: 'ok', then: 'hangup' as const }));
    const { openai, bridge } = setup({ bargeIn: 'instant', turnDetection: 'semantic_vad', vadEagerness: 'high' }, { onTool });
    bridge.start();
    openai.clearSent();
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('end_call', '{}', 'c1')] } });
    await flush();
    expect(openai.sent[1]).toStrictEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: { input: { turn_detection: { type: 'semantic_vad', eagerness: 'high', create_response: false, interrupt_response: true } } },
      },
    });
  });
});

describe('caller audio', () => {
  it('forwards Twilio media payloads untouched and ignores connected/start/dtmf', () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.clearSent();
    twilio.msg({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    twilio.msg({
      event: 'start',
      start: { streamSid: SID, customParameters: {} },
    });
    twilio.msg({ event: 'dtmf', dtmf: { track: 'inbound_track', digit: '1' } });
    twilio.msg(media(20, 'q83v'));
    expect(openai.sent).toEqual([{ type: 'input_audio_buffer.append', audio: 'q83v' }]);
    expect(twilio.sent).toEqual([]);
  });

  it('survives malformed Twilio and OpenAI frames', () => {
    const { twilio, openai, bridge, hooks } = setup();
    bridge.start();
    twilio.emit('message', 'not json');
    openai.emit('message', '{');
    twilio.msg({ event: 'media' });
    expect(hooks.onEnd).not.toHaveBeenCalled();
    expect(hooks.log.warn).toHaveBeenCalled();
  });
});

describe('opener', () => {
  it('opens the call once if nobody speaks within 3 s of session.updated', async () => {
    const { openai, bridge } = setup();
    bridge.start();
    openai.clearSent();
    await vi.advanceTimersByTimeAsync(SESSION_READY_TIMEOUT_MS - 1);
    expect(openai.sent).toEqual([]); // not armed until session.updated
    openai.msg({ type: 'session.updated', session: {} });
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS - 1);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '(The person picked up but has not spoken yet. Open the call now.)',
            },
          ],
        },
      },
      { type: 'response.create' },
    ]);
    openai.msg({ type: 'session.updated', session: {} });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openai.sent).toHaveLength(2);
  });

  it('does not open when the caller speaks first', async () => {
    const { openai, bridge } = setup();
    bridge.start();
    openai.msg({ type: 'session.updated', session: {} });
    await vi.advanceTimersByTimeAsync(1500);
    openai.msg({
      type: 'input_audio_buffer.speech_started',
      audio_start_ms: 100,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openai.types()).not.toContain('response.create');
  });

  it('does not open when the caller spoke before session.updated', async () => {
    const { openai, bridge } = setup();
    bridge.start();
    openai.msg({
      type: 'input_audio_buffer.speech_started',
      audio_start_ms: 100,
    });
    openai.msg({ type: 'session.updated', session: {} });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openai.types()).not.toContain('response.create');
  });
});

describe('agent audio and barge-in', () => {
  it('forwards each delta to Twilio followed by a mark', () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.msg(READY);
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: 'AUD1',
    });
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: 'AUD2',
    });
    expect(twilio.sent).toHaveLength(4);
    expect(twilio.sent[0]).toEqual({
      event: 'media',
      streamSid: SID,
      media: { payload: 'AUD1' },
    });
    expect(twilio.sent[1]).toMatchObject({
      event: 'mark',
      streamSid: SID,
      mark: { name: expect.any(String) },
    });
    expect(twilio.sent[2]).toEqual({
      event: 'media',
      streamSid: SID,
      media: { payload: 'AUD2' },
    });
    expect(twilio.sent[3]).toMatchObject({ event: 'mark', streamSid: SID });
  });

  it('clears Twilio and truncates the playing item when the caller barges in', () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.msg(READY);
    twilio.msg(media(1000));
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: audio(2000),
    });
    twilio.msg(media(1600));
    twilio.clearSent();
    openai.clearSent();
    openai.msg({
      type: 'input_audio_buffer.speech_started',
      audio_start_ms: 1500,
    });
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    expect(openai.sent).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item_1',
        content_index: 0,
        audio_end_ms: 600,
      },
    ]);
    // queue reset: a second speech_started does nothing
    openai.msg({
      type: 'input_audio_buffer.speech_started',
      audio_start_ms: 1700,
    });
    expect(twilio.sent).toHaveLength(1);
    expect(openai.sent).toHaveLength(1);
  });

  it('does nothing on speech_started once the agent audio has played out', () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.msg(READY);
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: audio(100),
    });
    const mark = (twilio.sent[1] as { mark: { name: string } }).mark.name;
    twilio.msg({ event: 'mark', streamSid: SID, mark: { name: mark } });
    twilio.clearSent();
    openai.clearSent();
    openai.msg({
      type: 'input_audio_buffer.speech_started',
      audio_start_ms: 1,
    });
    expect(twilio.sent).toEqual([]);
    expect(openai.sent).toEqual([]);
  });
});

describe('barge-in gate', () => {
  const marks = (twilio: FakeSocket) =>
    twilio.history.filter((m) => m.event === 'mark').map((m) => (m.mark as { name: string }).name);
  const playAll = (twilio: FakeSocket) => {
    for (const name of marks(twilio)) twilio.msg({ event: 'mark', streamSid: SID, mark: { name } });
  };
  const doneEmpty = { type: 'response.done', response: { status: 'completed', output: [] } };
  /** Gate mode tags each response.create with an event_id so an error can be tied to it. */
  const CREATE = { type: 'response.create', event_id: expect.stringMatching(/^ai-create-\d+$/) };
  const creates = (openai: FakeSocket) => openai.sent.filter((m) => m.type === 'response.create');
  const talk = (openai: FakeSocket, itemId: string, ms: number) => {
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: itemId, delta: audio(ms) });
  };

  /** Gate mode; the opener (item_0) played out; the agent is now 500 ms into a 3 s answer (item_1), still streaming. */
  function talking() {
    const s = setup({ bargeIn: 'gate', transcribeModel: 'gpt-live-transcribe' });
    s.bridge.start();
    s.openai.msg(READY);
    talk(s.openai, 'item_0', 100);
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(doneEmpty);
    playAll(s.twilio);
    s.twilio.msg(media(1000));
    talk(s.openai, 'item_1', 3000);
    s.twilio.msg(media(1500));
    s.twilio.clearSent();
    s.openai.clearSent();
    return s;
  }
  const started = (openai: FakeSocket, id = 'c1') => openai.msg({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: 1500 });
  const delta = (openai: FakeSocket, text: string, id = 'c1') =>
    openai.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta: text });
  const stopped = (openai: FakeSocket, id = 'c1') => openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: 2200 });
  const committed = (openai: FakeSocket, id = 'c1') => openai.msg({ type: 'input_audio_buffer.committed', item_id: id });
  const completed = (openai: FakeSocket, text: string, id = 'c1') =>
    openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text });

  it('keeps talking through "mm-hmm" and never answers it', () => {
    const { twilio, openai } = talking();
    started(openai);
    delta(openai, ' Mm');
    delta(openai, '-hmm');
    stopped(openai);
    committed(openai);
    completed(openai, 'Mm-hmm.');
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(200) });
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(twilio.sent.some((m) => m.event === 'media')).toBe(true);
    expect(openai.sent).toEqual([]);
  });

  it('stops on "wait" — cancel, clear, truncate at what was heard — and answers when their turn ends', () => {
    const { twilio, openai, hooks } = talking();
    started(openai);
    delta(openai, ' Wait');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    expect(openai.sent).toEqual([
      { type: 'response.cancel' },
      { type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 500 },
    ]);
    expect(hooks.onTranscript).toHaveBeenCalledWith(expect.objectContaining({ role: 'system', text: '[stopped — they interrupted]' }));
    openai.clearSent();
    stopped(openai);
    committed(openai); // the cancelled response has not reported done yet: wait for it
    expect(openai.sent).toEqual([]);
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    expect(openai.sent).toEqual([CREATE]);
  });

  it('stops on the second real word', () => {
    const { twilio, openai } = talking();
    started(openai);
    delta(openai, " I'm");
    expect(twilio.sent).toEqual([]);
    delta(openai, ' interested');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
  });

  it('stops after 3 s of talk with no words', async () => {
    const { twilio, openai } = talking();
    started(openai);
    await vi.advanceTimersByTimeAsync(2999);
    expect(twilio.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
  });

  it('a cough (no words, stops quickly) never cuts the agent', async () => {
    const { twilio, openai } = talking();
    started(openai);
    await vi.advanceTimersByTimeAsync(600);
    stopped(openai);
    committed(openai);
    await vi.advanceTimersByTimeAsync(5000);
    completed(openai, '');
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(openai.sent).toEqual([]);
  });

  it('a stop word that streams in after the commit cuts the agent and gets one answer', () => {
    const { twilio, openai } = talking();
    started(openai);
    stopped(openai);
    committed(openai); // still being judged: no answer yet
    expect(openai.sent).toEqual([]);
    delta(openai, ' Wait');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    completed(openai, 'Wait.');
    expect(openai.sent.filter((m) => m.type === 'response.create')).toEqual([CREATE]);
  });

  it('a late "yeah sure" is answered once the agent has finished', () => {
    const { twilio, openai } = talking();
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    twilio.msg(media(3000)); // 1 s of item_1 left to play
    openai.clearSent();
    started(openai);
    delta(openai, ' Yeah sure');
    stopped(openai);
    committed(openai);
    completed(openai, 'Yeah, sure.');
    expect(openai.sent).toEqual([]);
    playAll(twilio);
    expect(openai.sent).toEqual([CREATE]);
  });

  it('never cuts the opener; a question over it is answered after it plays', async () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    twilio.msg(media(100));
    talk(openai, 'item_0', 4000);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    twilio.clearSent();
    openai.clearSent();
    started(openai);
    delta(openai, ' Wait who is this');
    await vi.advanceTimersByTimeAsync(3000);
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    stopped(openai);
    committed(openai);
    completed(openai, 'Wait, who is this?');
    expect(openai.sent).toEqual([]);
    playAll(twilio);
    expect(openai.sent).toEqual([CREATE]);
  });

  it('cancels a response that has not played a sound when the caller keeps talking', () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.msg({ type: 'response.created' });
    twilio.clearSent();
    openai.clearSent();
    started(openai);
    expect(openai.sent).toEqual([{ type: 'response.cancel' }]);
    expect(twilio.sent).toEqual([]);
  });

  it('answers a normal turn when it is committed', () => {
    const { openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    started(openai);
    stopped(openai);
    committed(openai);
    expect(openai.sent).toEqual([CREATE]);
    committed(openai, 'c2'); // a second turn before response.created: one response at a time
    expect(openai.sent).toEqual([CREATE]);
    openai.msg({ type: 'response.created' });
    openai.msg(doneEmpty);
    expect(openai.sent).toEqual([CREATE, CREATE]);
  });

  it('a caller turn during a slow tool waits for the batch, then one response', async () => {
    let release: () => void = () => undefined;
    const onTool = vi.fn(() => new Promise<{ output: string }>((r) => { release = () => r({ output: '{"ok":true}' }); }));
    const { openai, bridge } = setup({ bargeIn: 'gate' }, { onTool });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'c1')] } });
    await flush();
    committed(openai, 'c9');
    expect(openai.types()).toEqual([]);
    release();
    await flush();
    expect(openai.types()).toEqual(['conversation.item.create', 'response.create']);
  });

  it('a rejected response.create does not leave the agent stuck silent', () => {
    const { openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    committed(openai, 'c1');
    committed(openai, 'c2'); // deferred behind the first
    expect(openai.sent).toEqual([CREATE]);
    openai.msg({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'busy' } });
    expect(openai.sent).toEqual([CREATE, CREATE]);
  });

  it('ignores caller speech over the goodbye once a tool ended the call', async () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' }, { onTool: vi.fn(async () => ({ output: 'bye', then: 'hangup' as const })) });
    bridge.start();
    openai.msg(READY);
    talk(openai, 'item_0', 100);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    playAll(twilio);
    talk(openai, 'item_1', 2000);
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('end_call', '{"outcome":"not_interested"}', 'e1')] } });
    await flush();
    twilio.clearSent();
    openai.clearSent();
    started(openai);
    delta(openai, ' Wait wait');
    committed(openai);
    expect(twilio.sent).toEqual([]);
    expect(openai.sent).toEqual([]);
  });

  it('a late answer still owed is dropped when a later interruption cuts the agent', () => {
    const { twilio, openai } = talking();
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    twilio.msg(media(3000)); // 1 s of item_1 left to play
    openai.clearSent();
    started(openai);
    delta(openai, ' Yeah sure');
    stopped(openai);
    committed(openai);
    completed(openai, 'Yeah, sure.'); // owed an answer once item_1 plays out
    started(openai, 'c2');
    delta(openai, ' Wait', 'c2'); // cuts item_1: its own turn is answered instead
    stopped(openai, 'c2');
    committed(openai, 'c2');
    expect(openai.types()).toEqual(['conversation.item.truncate', 'response.create']);
    talk(openai, 'item_2', 500);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    playAll(twilio);
    expect(openai.sent.filter((m) => m.type === 'response.create')).toEqual([CREATE]);
  });

  it('speech before the cut response reports done is not judged against a silent agent', () => {
    const { openai, hooks } = talking();
    started(openai);
    delta(openai, ' Wait');
    stopped(openai);
    committed(openai); // answered once the cancelled response reports done
    openai.clearSent();
    started(openai, 'c2'); // nothing is playing any more
    delta(openai, ' Wait', 'c2');
    expect(openai.sent).toEqual([]);
    const notes = hooks.onTranscript.mock.calls.filter(([e]) => (e as { text: string }).text === '[stopped — they interrupted]');
    expect(notes).toHaveLength(1);
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    expect(openai.sent).toEqual([]); // c2 is still talking: answered when their turn ends
    stopped(openai, 'c2');
    committed(openai, 'c2');
    expect(openai.sent).toEqual([CREATE]);
  });

  it('a tool batch that throws still answers a turn committed meanwhile', async () => {
    let release: () => void = () => undefined;
    // A hook that resolves to nothing makes the batch itself throw.
    const onTool = vi.fn(() => new Promise<{ output: string }>((r) => { release = () => r(undefined as unknown as { output: string }); }));
    const { openai, bridge, hooks } = setup({ bargeIn: 'gate' }, { onTool });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'c1')] } });
    await flush();
    committed(openai, 'c9');
    release();
    await flush();
    expect(hooks.log.error).toHaveBeenCalledWith(expect.anything(), 'ai-voice bridge: tool batch failed');
    expect(openai.types()).toEqual(['response.create']);
  });

  it('drops our answer unheard when the caller starts talking before it is created', () => {
    const { twilio, openai, bridge, hooks } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    twilio.clearSent();
    openai.clearSent();
    committed(openai, 'c1');
    expect(openai.sent).toEqual([CREATE]);
    started(openai, 'c2'); // they kept talking: our create is still in flight
    expect(openai.sent).toEqual([CREATE]);
    openai.msg({ type: 'response.created' });
    expect(openai.sent).toEqual([CREATE, { type: 'response.cancel' }]);
    stopped(openai, 'c2');
    committed(openai, 'c2'); // waits for the cancelled response to finish
    expect(openai.sent).toHaveLength(2);
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    expect(openai.sent).toEqual([CREATE, { type: 'response.cancel' }, CREATE]);
    openai.msg({ type: 'response.created' }); // the answer to their whole turn is not cancelled
    expect(openai.sent).toHaveLength(3);
    expect(twilio.sent).toEqual([]);
    expect(hooks.onTranscript).not.toHaveBeenCalled();
  });

  // server_vad ends the turn after a pause, so a caller who pauses mid-thought is answered too early; the gate hides it.
  for (const resumes of ['while our create is in flight', 'after the response was created, before any agent audio'] as const) {
    it(`server_vad: a caller who pauses past the silence and resumes ${resumes} gets ONE answer to both parts, none heard early`, () => {
      const { twilio, openai, bridge, hooks } = setup({ bargeIn: 'gate', turnDetection: 'server_vad', silenceMs: 500 });
      bridge.start();
      openai.msg(READY);
      twilio.clearSent();
      openai.clearSent();
      started(openai, 'c1');
      delta(openai, ' I think the roof', 'c1');
      stopped(openai, 'c1'); // 500 ms of silence: server_vad declares the turn over
      committed(openai, 'c1');
      expect(openai.sent).toEqual([CREATE]); // the early answer, not heard yet
      if (resumes === 'after the response was created, before any agent audio') {
        openai.msg({ type: 'response.created' });
        started(openai, 'c2'); // "...is about fifteen years old"
        expect(openai.sent).toEqual([CREATE, { type: 'response.cancel' }]);
      } else {
        started(openai, 'c2');
        openai.msg({ type: 'response.created' });
        expect(openai.sent).toEqual([CREATE, { type: 'response.cancel' }]);
      }
      openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(100) }); // already in flight: dropped
      expect(twilio.sent).toEqual([]);
      delta(openai, ' is about fifteen years old', 'c2');
      stopped(openai, 'c2');
      committed(openai, 'c2');
      expect(creates(openai)).toHaveLength(1); // waits for the cancelled response to finish
      openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
      expect(openai.sent).toEqual([CREATE, { type: 'response.cancel' }, CREATE]); // one answer, to both parts
      openai.msg({ type: 'response.created' });
      openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(100) });
      expect(openai.sent).toHaveLength(3); // the answer to their whole turn is not cancelled
      expect(twilio.sent.some((m) => m.event === 'media')).toBe(true);
      expect(hooks.onTranscript).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'system' })); // nothing was cut or dropped aloud
    });
  }

  it('a rejected create forgets the pending cancel, so the next answer is not dropped', () => {
    const { openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    committed(openai, 'c1');
    started(openai, 'c2');
    openai.msg({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'busy' } });
    stopped(openai, 'c2');
    committed(openai, 'c2');
    openai.msg({ type: 'response.created' });
    expect(openai.types()).toEqual(['response.create', 'response.create']);
  });

  // ── review fixes ──

  it('a tool answer that comes back while the caller is talking waits for their turn: one answer', async () => {
    let release: () => void = () => undefined;
    const onTool = vi.fn(() => new Promise<{ output: string }>((r) => { release = () => r({ output: '{"ok":true}' }); }));
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' }, { onTool });
    bridge.start();
    openai.msg(READY);
    talk(openai, 'item_0', 100); // "Let me check" + a slow tool
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
    playAll(twilio); // played out before the tool returns
    await flush();
    openai.clearSent();
    started(openai); // they answer into the silence
    release();
    await flush();
    expect(openai.types()).toEqual(['conversation.item.create']);
    stopped(openai);
    committed(openai);
    expect(creates(openai)).toEqual([CREATE]);
  });

  it('a tool answer deferred behind a listening sound is sent once that sound is judged', async () => {
    let release: () => void = () => undefined;
    const onTool = vi.fn(() => new Promise<{ output: string }>((r) => { release = () => r({ output: '{"ok":true}' }); }));
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' }, { onTool });
    bridge.start();
    openai.msg(READY);
    talk(openai, 'item_0', 100);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    playAll(twilio);
    twilio.msg(media(1000));
    talk(openai, 'item_1', 3000); // "Let me check that for you" + a slow tool
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
    await flush();
    openai.clearSent();
    started(openai); // over item_1, 3 s left: an overlap
    delta(openai, ' Mm-hmm');
    release();
    await flush();
    expect(openai.types()).toEqual(['conversation.item.create']);
    stopped(openai);
    committed(openai);
    expect(creates(openai)).toEqual([]);
    completed(openai, 'Mm-hmm.');
    expect(creates(openai)).toEqual([CREATE]);
  });

  it('drops the audio of a response cancelled unheard; the next response is the protected opener', async () => {
    const { twilio, openai, bridge, hooks } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS);
    openai.msg({ type: 'response.created' });
    twilio.clearSent();
    openai.clearSent();
    started(openai); // "Hello?" before a sound of the opener
    expect(openai.sent).toEqual([{ type: 'response.cancel' }]);
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(100) }); // already in flight
    openai.msg({ type: 'response.output_audio_transcript.done', item_id: 'item_0', transcript: 'Hi, this is Sam.' });
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    expect(twilio.sent).toEqual([]);
    expect(hooks.onTranscript).toHaveBeenCalledWith(expect.objectContaining({ role: 'system', text: '[not played] Hi, this is Sam.' }));
    stopped(openai);
    committed(openai);
    twilio.msg(media(100));
    talk(openai, 'item_1', 4000); // the disclosure, said in full
    started(openai, 'c2');
    delta(openai, ' Wait', 'c2');
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  it('a committed overlap pushed aside by new speech is still judged: cut and answered once', () => {
    const { twilio, openai } = talking();
    started(openai);
    stopped(openai);
    committed(openai); // no words yet
    started(openai, 'c2');
    delta(openai, ' Wait'); // c1's words arrive late
    completed(openai, 'Wait.');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    stopped(openai, 'c2');
    committed(openai, 'c2');
    completed(openai, '', 'c2'); // c2 was a cough
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    expect(creates(openai)).toEqual([CREATE]);
  });

  it('a pushed-aside overlap that was only a listening sound gets no answer', () => {
    const { twilio, openai } = talking();
    started(openai);
    stopped(openai);
    committed(openai);
    started(openai, 'c2');
    completed(openai, 'Mm-hmm.');
    stopped(openai, 'c2');
    committed(openai, 'c2');
    completed(openai, '', 'c2');
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(openai.sent).toEqual([]);
  });

  it('an error that is not about our pending create does not release it', () => {
    const { openai } = talking();
    started(openai);
    delta(openai, ' Wait'); // cut: response.cancel sent
    stopped(openai);
    committed(openai); // waits for the cancelled response
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } }); // create #1 in flight
    committed(openai, 'c2'); // waits behind it
    openai.msg({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'no active response' } });
    expect(creates(openai)).toEqual([{ type: 'response.create', event_id: 'ai-create-1' }]);
    openai.msg({ type: 'response.created' });
    openai.msg(doneEmpty);
    expect(creates(openai)).toEqual([
      { type: 'response.create', event_id: 'ai-create-1' },
      { type: 'response.create', event_id: 'ai-create-2' },
    ]);
  });

  it('a rejected create is matched by its event_id', () => {
    const { openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    committed(openai, 'c1');
    committed(openai, 'c2'); // deferred behind the first
    const busy = (eventId: string) =>
      openai.msg({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'busy', event_id: eventId } });
    busy('evt_someone_else');
    expect(creates(openai)).toHaveLength(1);
    busy('ai-create-1');
    expect(creates(openai)).toEqual([
      { type: 'response.create', event_id: 'ai-create-1' },
      { type: 'response.create', event_id: 'ai-create-2' },
    ]);
  });

  it('a cut while our next create is in flight drops that response as soon as it exists', async () => {
    const { twilio, openai } = talking();
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
    await flush(); // the batch asks for the next response while item_1 still plays
    expect(openai.types()).toEqual(['conversation.item.create', 'response.create']);
    started(openai);
    delta(openai, ' Wait');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    openai.clearSent();
    openai.msg({ type: 'response.created' });
    expect(openai.sent).toEqual([{ type: 'response.cancel' }]);
    stopped(openai);
    committed(openai);
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    expect(creates(openai)).toEqual([CREATE]);
  });

  it('an interruption judged after the agent has finished cuts and notes nothing, and is answered', () => {
    const { twilio, openai, hooks } = talking();
    started(openai);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    playAll(twilio); // the agent finished while they were talking
    delta(openai, " I'm");
    delta(openai, ' interested');
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(hooks.onTranscript).not.toHaveBeenCalledWith(expect.objectContaining({ text: '[stopped — they interrupted]' }));
    expect(hooks.log.info).not.toHaveBeenCalledWith(expect.anything(), 'ai-voice bridge: caller interrupted the agent');
    stopped(openai);
    committed(openai);
    expect(creates(openai)).toEqual([CREATE]);
  });

  it('a drain during response.done waits for the tool batch: one answer', async () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    twilio.msg(media(100));
    talk(openai, 'item_0', 4000); // the opener, still streaming
    playAll(twilio); // every chunk so far has played (a generation stall)
    openai.clearSent();
    started(openai);
    delta(openai, ' Wait who is this');
    stopped(openai);
    committed(openai);
    completed(openai, 'Wait, who is this?'); // over the opener: answered once it has played
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
    await flush();
    expect(creates(openai)).toEqual([CREATE]);
    openai.msg({ type: 'response.created' });
    openai.msg(doneEmpty);
    expect(creates(openai)).toEqual([CREATE]);
  });

  it('a late answer judged after the audio played out but before response.done is still answered', () => {
    const { twilio, openai } = talking();
    openai.msg({ type: 'response.output_audio.done' });
    playAll(twilio); // item_1 played out; its response.done has not arrived yet
    started(openai); // still "speaking" (active response with audio): a late overlap
    delta(openai, ' Yeah sure');
    stopped(openai);
    committed(openai);
    completed(openai, 'Yeah, sure.');
    expect(creates(openai)).toEqual([]);
    openai.msg(doneEmpty);
    expect(creates(openai)).toEqual([CREATE]);
  });

  it('an error with no event_id about something else (a truncate) does not release our pending create', () => {
    const { openai } = talking();
    started(openai);
    delta(openai, ' Wait'); // cut: response.cancel + truncate sent
    stopped(openai);
    committed(openai);
    openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } }); // create #1 in flight
    committed(openai, 'c2'); // waits behind it
    openai.msg({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'invalid_value', message: 'audio_end_ms is longer than the audio', param: 'audio_end_ms' },
    });
    expect(creates(openai)).toEqual([{ type: 'response.create', event_id: 'ai-create-1' }]);
    openai.msg({ type: 'response.created' });
    openai.msg(doneEmpty);
    expect(creates(openai)).toEqual([
      { type: 'response.create', event_id: 'ai-create-1' },
      { type: 'response.create', event_id: 'ai-create-2' },
    ]);
  });

  // ── final review F2: a failed caller transcription is logged (code and type only) ──

  it('F2: a failed transcription of an overlap is logged once with its code and type, no text, and settled as ignored', () => {
    const { twilio, openai, hooks } = talking();
    started(openai);
    stopped(openai);
    committed(openai);
    openai.msg({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'c1',
      content_index: 0,
      error: { type: 'transcription_error', code: 'audio_unintelligible', message: 'Could not transcribe "SECRET WORDS"', param: null },
    });
    expect(hooks.log.warn).toHaveBeenCalledTimes(1);
    expect(hooks.log.warn).toHaveBeenCalledWith(
      { code: 'audio_unintelligible', errorType: 'transcription_error' },
      'ai-voice bridge: caller transcription failed',
    );
    const logged = JSON.stringify([hooks.log.info.mock.calls, hooks.log.warn.mock.calls, hooks.log.error.mock.calls]);
    expect(logged).not.toContain('SECRET');
    expect(hooks.onTranscript).not.toHaveBeenCalled();
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(openai.sent).toEqual([]);
  });

  // ── final review F4: a follow-up response queued behind the first ──

  /** item_1 (3 s from 1000 ms) + save_qualification; the follow-up item_2 (2 s) is forwarded at 1500 while item_1 plays. */
  async function followUpQueued() {
    const s = talking();
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
    await flush(); // the batch asks for the follow-up while item_1 still plays
    expect(creates(s.openai)).toEqual([CREATE]);
    talk(s.openai, 'item_2', 2000); // plays after item_1: 4000–6000
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(doneEmpty);
    s.openai.clearSent();
    return s;
  }

  it('F4 (probe P1): a "mm-hmm" with 3 s of queued audio left (1 s of the first + the follow-up) is not answered', async () => {
    const { twilio, openai } = await followUpQueued();
    twilio.msg(media(3000));
    started(openai);
    delta(openai, ' Mm-hmm');
    stopped(openai);
    committed(openai);
    completed(openai, 'Mm-hmm.');
    playAll(twilio);
    expect(creates(openai)).toEqual([]);
  });

  it('F4: a "yeah sure" in the follow-up\'s last 1.5 s is still late: answered once it has played', async () => {
    const { twilio, openai } = await followUpQueued();
    twilio.msg(media(4800)); // 1.2 s of item_2 left
    started(openai);
    delta(openai, ' Yeah sure');
    stopped(openai);
    committed(openai);
    completed(openai, 'Yeah, sure.');
    expect(creates(openai)).toEqual([]);
    playAll(twilio);
    expect(creates(openai)).toEqual([CREATE]);
  });

  // ── final review F5: a caller still talking when the agent finishes is answering it ──

  it('F5a: a "yeah" that starts 2.5 s before the end and is still going when the agent finishes is answered once', async () => {
    const { twilio, openai } = talking(); // 2.5 s of item_1 left once it has all streamed
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    started(openai);
    delta(openai, ' Yeah');
    playAll(twilio); // the agent finishes while they are still talking
    expect(creates(openai)).toEqual([]);
    stopped(openai);
    committed(openai);
    delta(openai, ', sure');
    completed(openai, 'Yeah, sure.');
    expect(creates(openai)).toEqual([CREATE]);
    openai.msg({ type: 'response.created' });
    openai.msg(doneEmpty);
    await vi.advanceTimersByTimeAsync(1000);
    expect(creates(openai)).toEqual([CREATE]);
  });

  it('F5b: a "mm-hmm" that stopped mid-sentence is ignored, even when its verdict lands after the agent finished', async () => {
    const { twilio, openai } = talking();
    started(openai);
    delta(openai, ' Mm-hmm');
    stopped(openai);
    committed(openai);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    playAll(twilio);
    completed(openai, 'Mm-hmm.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(openai.sent).toEqual([]);
  });

  it('F5c: a cough still going when the agent finishes is ignored', async () => {
    const { twilio, openai } = talking();
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    started(openai);
    playAll(twilio);
    await vi.advanceTimersByTimeAsync(600);
    stopped(openai);
    committed(openai);
    completed(openai, '');
    await vi.advanceTimersByTimeAsync(1000);
    expect(openai.sent).toEqual([]);
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  it('F5d: a late "yeah sure" (last 1.5 s) still going when the agent finishes gets one answer', async () => {
    const { twilio, openai } = talking();
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    twilio.msg(media(3000)); // 1 s of item_1 left: late by the 1.5 s rule too
    started(openai);
    delta(openai, ' Yeah sure');
    playAll(twilio);
    stopped(openai);
    committed(openai);
    completed(openai, 'Yeah, sure.');
    expect(creates(openai)).toEqual([CREATE]);
    openai.msg({ type: 'response.created' });
    openai.msg(doneEmpty);
    await vi.advanceTimersByTimeAsync(1000);
    expect(creates(openai)).toEqual([CREATE]);
  });

  for (const createdBeforeDrain of [false, true]) {
    it(`P4: a "mm-hmm" still going when the first response ends is not late while its follow-up is ${createdBeforeDrain ? 'created but silent' : 'requested'}: no second answer`, async () => {
      const { twilio, openai } = talking(); // item_1: 3 s from 1000 ms, now at 1500 ms
      openai.msg({ type: 'response.output_audio.done' });
      openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
      await flush(); // the tool returns: follow-up B is requested before the caller speaks
      expect(creates(openai)).toEqual([CREATE]);
      started(openai); // 2.5 s of item_1 left: not late by the 1.5 s rule
      delta(openai, ' Mm-hmm');
      if (createdBeforeDrain) openai.msg({ type: 'response.created' });
      playAll(twilio); // item_1 finishes before B's first audio; their speech_stopped has not come yet
      if (!createdBeforeDrain) openai.msg({ type: 'response.created' });
      openai.msg({ type: 'response.output_audio.delta', item_id: 'item_2', delta: audio(2000) });
      stopped(openai);
      committed(openai);
      completed(openai, 'Mm-hmm.');
      openai.msg({ type: 'response.output_audio.done' });
      openai.msg(doneEmpty);
      playAll(twilio);
      await vi.advanceTimersByTimeAsync(1000);
      expect(creates(openai)).toEqual([CREATE]);
    });
  }

  it('F5e: a "hello?" still going when the opener finishes is the answer; the opener is never cut', () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    twilio.msg(media(100));
    talk(openai, 'item_0', 4000);
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(doneEmpty);
    twilio.clearSent();
    openai.clearSent();
    started(openai);
    delta(openai, ' Hello?');
    playAll(twilio);
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    stopped(openai);
    committed(openai);
    completed(openai, 'Hello?');
    expect(openai.sent).toEqual([CREATE]);
  });
});

describe('instant mode keeps its pre-gate frames', () => {
  it('a tool batch that ends during a VAD auto-response sends its create at once, and only once', async () => {
    let release: () => void = () => undefined;
    const onTool = vi.fn(() => new Promise<{ output: string }>((r) => { release = () => r({ output: '{"ok":true}' }); }));
    const { openai, bridge } = setup({}, { onTool });
    bridge.start();
    openai.msg(READY);
    openai.clearSent();
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
    await flush();
    openai.msg({ type: 'response.created' }); // VAD answered their next turn meanwhile
    release();
    await flush();
    expect(openai.types()).toEqual(['conversation.item.create', 'response.create']);
    expect(openai.sent[1]).toEqual({ type: 'response.create' });
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [] } });
    expect(openai.types()).toEqual(['conversation.item.create', 'response.create']);
  });
});

const DONE_EMPTY = { type: 'response.done', response: { status: 'completed', output: [] } };
/** Gate mode tags each response.create with an event_id. */
const GATE_CREATE = { type: 'response.create', event_id: expect.stringMatching(/^ai-create-\d+$/) };
/** Twilio confirms every agent chunk sent so far has played. */
const playAllMarks = (twilio: FakeSocket): void => {
  for (const m of twilio.history.filter((x) => x.event === 'mark')) twilio.msg({ event: 'mark', streamSid: SID, mark: m.mark });
};

describe('silence check-ins (gate mode)', () => {
  const note = (seconds: number) => ({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(No one has said anything for ${seconds} seconds.)` }] },
  });
  const notes = (openai: FakeSocket) => openai.sent.filter((m) => m.type === 'conversation.item.create');

  /** The agent opened the call (OPENER_DELAY_MS of silence), said its line, and it played out. */
  async function quietAfterAgent(over: Partial<BridgeOptions> = { bargeIn: 'gate' }, hookOver: { onTool?: BridgeHooks['onTool'] } = {}) {
    const s = setup(over, hookOver);
    s.bridge.start();
    s.openai.msg(READY);
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS);
    s.openai.msg({ type: 'response.created' });
    s.openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(100) });
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(DONE_EMPTY);
    const name = (s.twilio.sent.find((m) => m.event === 'mark') as { mark: { name: string } }).mark.name;
    s.twilio.msg({ event: 'mark', streamSid: SID, mark: { name } });
    s.openai.clearSent();
    return s;
  }

  it('checks in after 8 s of silence, at most twice until the caller speaks', async () => {
    const { openai, hooks } = await quietAfterAgent();
    await vi.advanceTimersByTimeAsync(7999);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([note(8), GATE_CREATE]);
    expect(hooks.onTranscript).toHaveBeenCalledWith(expect.objectContaining({ role: 'system', text: '[no answer for 8 s]' }));
    // the check-in plays, then silence again → second note; then no third
    for (let i = 0; i < 2; i += 1) {
      openai.msg({ type: 'response.created' });
      openai.msg(DONE_EMPTY);
      await vi.advanceTimersByTimeAsync(8000);
    }
    expect(openai.sent.filter((m) => m.type === 'conversation.item.create')).toHaveLength(2);
  });

  it('caller speech cancels the timer', async () => {
    const { openai } = await quietAfterAgent();
    await vi.advanceTimersByTimeAsync(5000);
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openai.sent).toEqual([]);
  });

  it('waits 30 s after wait_for_user', async () => {
    const { openai } = await quietAfterAgent();
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('wait_for_user', '{}', 'w1')] } });
    await flush();
    openai.clearSent();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([note(30), GATE_CREATE]);
  });

  it('a call screener: after the screener line and a quiet wait_for_user, the first check-in comes at 30 s, not 8 s (F1)', async () => {
    const { twilio, openai, bridge } = setup({ bargeIn: 'gate' });
    bridge.start();
    openai.msg(READY);
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 0 }); // the screener asks
    openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 3000 });
    openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' });
    openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c1', content_index: 0, transcript: 'Please say your name and why you are calling.' });
    expect(openai.sent.filter((m) => m.type === 'response.create')).toEqual([GATE_CREATE]);
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(4000) }); // "This is Ava, an AI assistant…"
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('wait_for_user', '{}', 'w1')] } });
    await flush();
    playAllMarks(twilio);
    openai.clearSent();
    await vi.advanceTimersByTimeAsync(8000);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(21_999);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([note(30), GATE_CREATE]);
  });

  it('keeps waiting 30 s for the second check-in while they are still on hold', async () => {
    const { openai } = await quietAfterAgent();
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('wait_for_user', '{}', 'w1')] } });
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    openai.msg({ type: 'response.created' }); // "Still there? Take your time."
    openai.msg(DONE_EMPTY);
    openai.clearSent();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([note(30), GATE_CREATE]);
  });

  it('a check-in whose create is rejected is followed by the next one', async () => {
    const { openai } = await quietAfterAgent();
    await vi.advanceTimersByTimeAsync(8000);
    const eventId = (openai.sent.find((m) => m.type === 'response.create') as { event_id: string }).event_id;
    openai.msg({ type: 'error', error: { type: 'server_error', code: 'server_error', message: 'internal', event_id: eventId } });
    await vi.advanceTimersByTimeAsync(8000);
    expect(notes(openai)).toEqual([note(8), note(8)]);
    expect(openai.sent.filter((m) => m.type === 'response.create')).toEqual([GATE_CREATE, GATE_CREATE]);
  });

  it('never checks in in instant mode', async () => {
    const { openai } = await quietAfterAgent({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(openai.sent.filter((m) => m.type === 'conversation.item.create')).toEqual([]);
  });

  it('starts over once the caller has spoken', async () => {
    const { openai } = await quietAfterAgent();
    for (let i = 0; i < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(8000);
      openai.msg({ type: 'response.created' });
      openai.msg(DONE_EMPTY);
    }
    await vi.advanceTimersByTimeAsync(8000);
    expect(notes(openai)).toHaveLength(2);
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 0 });
    openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 500 });
    openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' });
    openai.msg({ type: 'response.created' });
    openai.msg(DONE_EMPTY);
    await vi.advanceTimersByTimeAsync(8000);
    expect(notes(openai)).toHaveLength(3);
  });

  it('counts the silence from when the agent finished playing, not from response.done', async () => {
    const { twilio, openai } = await quietAfterAgent();
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(5000) });
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(DONE_EMPTY);
    await vi.advanceTimersByTimeAsync(10_000); // Twilio has not confirmed it played yet
    expect(openai.sent).toEqual([]);
    playAllMarks(twilio);
    await vi.advanceTimersByTimeAsync(7999);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([note(8), GATE_CREATE]);
  });

  it('waits while an overlap is still being judged, then times from its verdict', async () => {
    const { twilio, openai } = await quietAfterAgent();
    twilio.msg(media(1000));
    openai.clearSent(); // that frame's caller audio
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(3000) });
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 900 });
    openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 1300 });
    openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' }); // its transcript is slow
    openai.msg({ type: 'response.output_audio.done' });
    openai.msg(DONE_EMPTY);
    playAllMarks(twilio);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openai.sent).toEqual([]);
    openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c1', content_index: 0, transcript: 'Mm-hmm.' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(openai.sent).toEqual([note(8), GATE_CREATE]);
  });

  it('stops once the call is closing: a hangup result or silence()', async () => {
    const hangup = await quietAfterAgent({ bargeIn: 'gate' }, { onTool: vi.fn(async () => ({ output: 'bye', then: 'hangup' as const })) });
    hangup.openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('end_call', '{"outcome":"other"}', 'e1')] } });
    await flush();
    const silenced = await quietAfterAgent();
    silenced.bridge.silence();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hangup.openai.sent).toEqual([
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'e1', output: 'bye' } },
    ]);
    expect(silenced.openai.sent).toEqual([]);
  });
});

describe('turn stats', () => {
  /** A started bridge whose hooks carry an onStats spy. */
  function withStats(over: Partial<BridgeOptions> = { bargeIn: 'gate' }, hookOver: { onTool?: BridgeHooks['onTool'] } = {}) {
    const s = setup(over, hookOver);
    const onStats = vi.fn();
    (s.hooks as BridgeHooks).onStats = onStats;
    s.bridge.start();
    s.openai.msg(READY);
    return { ...s, onStats };
  }
  /** Caller audio sent to OpenAI from `fromMs` up to `toMs`, in 20 ms frames (it also moves Twilio's clock). */
  const callerAudio = (twilio: FakeSocket, toMs: number, fromMs = 0) => {
    for (let ts = fromMs + 20; ts <= toMs; ts += 20) twilio.msg(media(ts, audio(20)));
  };
  const said = (openai: FakeSocket, id: string, text: string) => {
    openai.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta: ` ${text}` });
    openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text });
  };
  const stoppedAt = (openai: FakeSocket, id: string, endMs: number) => {
    openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: endMs });
    openai.msg({ type: 'input_audio_buffer.committed', item_id: id });
  };
  const startedAt = (openai: FakeSocket, id: string, startMs = 0) =>
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: startMs });
  const cancelledDone = { type: 'response.done', response: { status: 'cancelled', output: [] } };
  const callerTurn = (openai: FakeSocket, id: string, endMs: number) => {
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: 0 });
    openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: endMs });
    openai.msg({ type: 'input_audio_buffer.committed', item_id: id });
  };
  const agentSays = (openai: FakeSocket, itemId: string, ms = 100) => {
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: itemId, delta: audio(ms) });
  };
  /** The opener played out (gate mode), so check-ins and overlaps apply. */
  async function openerPlayed(s: ReturnType<typeof withStats>) {
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS);
    agentSays(s.openai, 'item_0');
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(DONE_EMPTY);
    playAllMarks(s.twilio);
  }
  const statsOf = (onStats: ReturnType<typeof vi.fn>) => onStats.mock.calls[0]?.[0] as Record<string, unknown>;

  it('reports endpoint + answer time per answered turn, once, before onEnd', async () => {
    const { twilio, openai, bridge, hooks } = setup({ bargeIn: 'gate' });
    const onStats = vi.fn();
    (hooks as BridgeHooks).onStats = onStats;
    bridge.start();
    openai.msg(READY);
    for (let ts = 20; ts <= 3000; ts += 20) twilio.msg(media(ts, audio(20))); // 3000 ms of caller audio sent
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 1000 });
    openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 1800 }); // endpoint 1200
    openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' });
    await vi.advanceTimersByTimeAsync(700); // answer 700
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(100) });
    bridge.stop();
    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats.mock.calls[0]?.[0]).toMatchObject({
      v: 1, bargeIn: 'gate', turns: 1, totalMs: { p50: 1900, p90: 1900, max: 1900 },
      endpointMs: { p50: 1200 }, answerMs: { p50: 700 },
    });
    expect(onStats.mock.invocationCallOrder[0]).toBeLessThan(hooks.onEnd.mock.invocationCallOrder[0] as number);
  });

  describe('with server_vad the endpoint includes the silence wait (audio_end_ms already contains it)', () => {
    it('3000 ms sent, audio_end_ms 2700, silence 500 -> endpoint 800', async () => {
      const s = withStats({ bargeIn: 'gate', turnDetection: 'server_vad', silenceMs: 500 });
      callerAudio(s.twilio, 3000);
      callerTurn(s.openai, 'c1', 2700);
      await vi.advanceTimersByTimeAsync(700);
      agentSays(s.openai, 'item_0');
      s.bridge.stop();
      expect(statsOf(s.onStats)).toMatchObject({ turns: 1, totalMs: { p50: 1500 }, endpointMs: { p50: 800 }, answerMs: { p50: 700 } });
    });

    it('uses the configured silence, not a fixed 500', async () => {
      const s = withStats({ bargeIn: 'gate', turnDetection: 'server_vad', silenceMs: 800 });
      callerAudio(s.twilio, 3000);
      callerTurn(s.openai, 'c1', 2700);
      await vi.advanceTimersByTimeAsync(700);
      agentSays(s.openai, 'item_0');
      s.bridge.stop();
      expect(statsOf(s.onStats)).toMatchObject({ turns: 1, endpointMs: { p50: 1100 }, answerMs: { p50: 700 } });
    });

    it('an interruption that cut the agent is timed the same way', async () => {
      const s = withStats({ bargeIn: 'gate', turnDetection: 'server_vad', silenceMs: 500 });
      await openerPlayed(s);
      callerAudio(s.twilio, 1000);
      agentSays(s.openai, 'item_1', 3000);
      startedAt(s.openai, 'c1', 300);
      stoppedAt(s.openai, 'c1', 600); // 400 + the 500 ms of silence = 900; still being judged
      await vi.advanceTimersByTimeAsync(200);
      said(s.openai, 'c1', 'Wait, who is this?');
      s.openai.msg(cancelledDone);
      await vi.advanceTimersByTimeAsync(300);
      agentSays(s.openai, 'item_2');
      s.bridge.stop();
      expect(statsOf(s.onStats)).toMatchObject({ turns: 1, interruptions: 1, endpointMs: { p50: 900 }, answerMs: { p50: 500 } });
    });

    it('semantic_vad keeps the old formula (the true wait is not knowable from the event), whatever silenceMs is', async () => {
      const s = withStats({ bargeIn: 'gate', turnDetection: 'semantic_vad', silenceMs: 500 });
      callerAudio(s.twilio, 3000);
      callerTurn(s.openai, 'c1', 2700);
      await vi.advanceTimersByTimeAsync(700);
      agentSays(s.openai, 'item_0');
      s.bridge.stop();
      expect(statsOf(s.onStats)).toMatchObject({ turns: 1, totalMs: { p50: 1000 }, endpointMs: { p50: 300 }, answerMs: { p50: 700 } });
    });

    it('instant mode with an explicit server_vad adds the silence too', async () => {
      const s = withStats({ bargeIn: 'instant', turnDetection: 'server_vad', silenceMs: 500 });
      callerAudio(s.twilio, 3000);
      callerTurn(s.openai, 'c1', 2700);
      await vi.advanceTimersByTimeAsync(700);
      agentSays(s.openai, 'item_0');
      s.bridge.stop();
      expect(statsOf(s.onStats)).toMatchObject({ bargeIn: 'instant', turns: 1, endpointMs: { p50: 800 }, answerMs: { p50: 700 } });
    });
  });

  it('a turn answered only by wait_for_user is not paired with the check-in 30 s later', async () => {
    const s = withStats();
    await openerPlayed(s);
    callerAudio(s.twilio, 1000);
    callerTurn(s.openai, 'c1', 800);
    s.openai.msg({ type: 'response.created' });
    s.openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('wait_for_user', '{}', 'w1')] } });
    await flush();
    await vi.advanceTimersByTimeAsync(30_000); // the check-in
    agentSays(s.openai, 'item_1');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 0, totalMs: null, answerMs: null, silenceChecks: 1 });
  });

  it('a response that only calls a tool still counts, timed to the first audio of the answer after it', async () => {
    const s = withStats();
    callerAudio(s.twilio, 3000);
    callerTurn(s.openai, 'c1', 2000); // endpoint 1000
    await vi.advanceTimersByTimeAsync(300);
    s.openai.msg({ type: 'response.created' });
    s.openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
    await flush();
    await vi.advanceTimersByTimeAsync(400);
    agentSays(s.openai, 'item_0');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 1, endpointMs: { p50: 1000 }, answerMs: { p50: 700 } });
  });

  it('audio dropped unheard is not an answer: the turn is timed to the first audio forwarded', async () => {
    const s = withStats();
    callerAudio(s.twilio, 3000);
    callerTurn(s.openai, 'c1', 1000);
    await vi.advanceTimersByTimeAsync(100);
    s.openai.msg({ type: 'response.created' });
    s.openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c2', audio_start_ms: 2500 }); // cancels it unheard
    await vi.advanceTimersByTimeAsync(100);
    s.openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(100) }); // dropped
    s.openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c2', audio_end_ms: 2800 }); // endpoint 200
    s.openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c2' });
    s.openai.msg({ type: 'response.done', response: { status: 'cancelled', output: [] } });
    await vi.advanceTimersByTimeAsync(500);
    agentSays(s.openai, 'item_1');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 1, endpointMs: { p50: 200 }, answerMs: { p50: 500 } });
  });

  it('a listening sound over the agent is counted, and is not a turn', async () => {
    const s = withStats();
    await openerPlayed(s);
    s.twilio.msg(media(1000));
    agentSays(s.openai, 'item_1', 3000);
    startedAt(s.openai, 'c1', 900);
    stoppedAt(s.openai, 'c1', 0);
    said(s.openai, 'c1', 'Mm-hmm.'); // transcripts arrive after the commit
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg({ type: 'response.done', response: { status: 'completed', output: [fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'f1')] } });
    await flush();
    agentSays(s.openai, 'item_2'); // the agent carries on after its tool
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 0, listening: 1, interruptions: 0 });
  });

  it('a cough or a failed transcription over the agent is not counted as a listening sound (F7)', async () => {
    const s = withStats();
    await openerPlayed(s);
    s.twilio.msg(media(1000));
    agentSays(s.openai, 'item_1', 5000);
    startedAt(s.openai, 'c1', 900);
    stoppedAt(s.openai, 'c1', 1300);
    s.openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c1', content_index: 0, transcript: '' });
    startedAt(s.openai, 'c2', 1500);
    stoppedAt(s.openai, 'c2', 1800);
    s.openai.msg({
      type: 'conversation.item.input_audio_transcription.failed', item_id: 'c2', content_index: 0,
      error: { type: 'transcription_error', code: 'audio_unintelligible', message: 'could not transcribe' },
    });
    startedAt(s.openai, 'c3', 2000);
    stoppedAt(s.openai, 'c3', 2300);
    said(s.openai, 'c3', 'Mm-hmm.');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 0, listening: 1, interruptions: 0 });
  });

  it('counts an interruption that stopped the agent, and times the turn that did it', async () => {
    const s = withStats();
    await openerPlayed(s);
    callerAudio(s.twilio, 1000);
    agentSays(s.openai, 'item_1', 3000);
    startedAt(s.openai, 'c1', 300);
    stoppedAt(s.openai, 'c1', 600); // endpoint 400; still being judged
    await vi.advanceTimersByTimeAsync(200);
    said(s.openai, 'c1', 'Wait, who is this?'); // its words come after the commit: the cut
    s.openai.msg(cancelledDone);
    await vi.advanceTimersByTimeAsync(300);
    agentSays(s.openai, 'item_2');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 1, interruptions: 1, listening: 0, endpointMs: { p50: 400 }, answerMs: { p50: 500 } });
  });

  it('times a late answer from when the agent finished its own line, not from the caller stop', async () => {
    const s = withStats();
    await openerPlayed(s);
    callerAudio(s.twilio, 1000);
    agentSays(s.openai, 'item_1', 3000);
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(DONE_EMPTY);
    callerAudio(s.twilio, 3000, 1000); // 2 s of item_1 heard, 1 s left
    startedAt(s.openai, 'c1', 2500); // "…got a quick minute?" / "yeah sure"
    stoppedAt(s.openai, 'c1', 2900); // endpoint 100
    await vi.advanceTimersByTimeAsync(200);
    said(s.openai, 'c1', 'Yeah, sure.'); // answered once item_1 has played
    await vi.advanceTimersByTimeAsync(600);
    playAllMarks(s.twilio); // item_1 finishes 800 ms after they stopped: the answer clock starts here
    await vi.advanceTimersByTimeAsync(300);
    agentSays(s.openai, 'item_2');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 1, listening: 0, endpointMs: { p50: 100 }, answerMs: { p50: 300 } });
  });

  it('two overlaps answered by one cut are one turn, timed from the later', async () => {
    const s = withStats();
    await openerPlayed(s);
    callerAudio(s.twilio, 1000);
    agentSays(s.openai, 'item_1', 5000);
    startedAt(s.openai, 'c1');
    stoppedAt(s.openai, 'c1', 500); // endpoint 500, no words yet
    await vi.advanceTimersByTimeAsync(100);
    startedAt(s.openai, 'c2');
    stoppedAt(s.openai, 'c2', 800); // endpoint 200
    await vi.advanceTimersByTimeAsync(100);
    said(s.openai, 'c2', 'Wait, who is this?'); // cuts the agent: both are answered
    s.openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c1', content_index: 0, transcript: '' });
    s.openai.msg(cancelledDone);
    await vi.advanceTimersByTimeAsync(400);
    agentSays(s.openai, 'item_2');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 1, interruptions: 1, endpointMs: { p50: 200 }, answerMs: { p50: 500 } });
  });

  it('an overlap cut before its commit is timed once the commit answers it', async () => {
    const s = withStats();
    await openerPlayed(s);
    callerAudio(s.twilio, 1000);
    agentSays(s.openai, 'item_1', 3000);
    startedAt(s.openai, 'c1', 300);
    s.openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 600 }); // endpoint 400
    await vi.advanceTimersByTimeAsync(200);
    s.openai.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'c1', content_index: 0, delta: ' Wait' });
    s.openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' }); // after the cut: answered as a normal turn
    s.openai.msg(cancelledDone);
    await vi.advanceTimersByTimeAsync(300);
    agentSays(s.openai, 'item_2');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 1, interruptions: 1, endpointMs: { p50: 400 }, answerMs: { p50: 500 } });
  });

  it('a turn is not dropped when the cut response reports done between its stop and its commit', async () => {
    const s = withStats();
    await openerPlayed(s);
    callerAudio(s.twilio, 1000);
    agentSays(s.openai, 'item_1', 5000);
    startedAt(s.openai, 'c1');
    await vi.advanceTimersByTimeAsync(3000); // talk with no words: the gate cuts the agent
    s.openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 700 }); // endpoint 300
    s.openai.msg(cancelledDone); // lands before the commit
    s.openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' });
    await vi.advanceTimersByTimeAsync(400);
    agentSays(s.openai, 'item_2');
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({ turns: 1, interruptions: 1, endpointMs: { p50: 300 }, answerMs: { p50: 400 } });
  });

  it('onStats also fires before onEnd when the OpenAI socket closes', () => {
    const s = withStats();
    s.openai.close();
    expect(s.onStats).toHaveBeenCalledTimes(1);
    expect(s.hooks.onEnd).toHaveBeenCalledWith('openai_closed', undefined);
    expect(s.onStats.mock.invocationCallOrder[0]).toBeLessThan(s.hooks.onEnd.mock.invocationCallOrder[0] as number);
  });

  it('instant mode records turns too, and counts a barge-in that cut the agent as an interruption', async () => {
    const s = withStats({});
    callerAudio(s.twilio, 2000);
    callerTurn(s.openai, 'c1', 1500); // endpoint 500; nothing to cut yet
    await vi.advanceTimersByTimeAsync(600);
    agentSays(s.openai, 'item_0', 3000); // VAD's answer
    s.openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c2', audio_start_ms: 1900 });
    s.bridge.stop();
    expect(statsOf(s.onStats)).toMatchObject({
      bargeIn: 'instant', turns: 1, endpointMs: { p50: 500 }, answerMs: { p50: 600 }, interruptions: 1, silenceChecks: 0,
    });
  });

  it('a throwing onStats is logged and onEnd still fires', () => {
    const s = withStats();
    s.onStats.mockImplementation(() => {
      throw new Error('boom');
    });
    s.bridge.stop();
    expect(s.hooks.log.error).toHaveBeenCalledWith(expect.objectContaining({ hook: 'onStats' }), 'ai-voice bridge: hook threw');
    expect(s.hooks.onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('transcripts', () => {
  it('reports caller and agent lines with a timestamp, skipping blanks', () => {
    vi.setSystemTime(new Date('2026-10-05T18:00:00Z'));
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.msg({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: ' Hello? ',
    });
    openai.msg({
      type: 'response.output_audio_transcript.done',
      item_id: 'i2',
      transcript: 'Hi, this is an AI assistant.',
    });
    openai.msg({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i3',
      transcript: '  ',
    });
    expect(hooks.onTranscript.mock.calls).toEqual([
      [
        {
          role: 'caller',
          text: 'Hello?',
          at: new Date('2026-10-05T18:00:00Z'),
        },
      ],
      [
        {
          role: 'agent',
          text: 'Hi, this is an AI assistant.',
          at: new Date('2026-10-05T18:00:00Z'),
        },
      ],
    ]);
  });
});

describe('tool calls', () => {
  const done = (...output: object[]) => ({
    type: 'response.done',
    response: { status: 'completed', output },
  });

  it('runs a tool, returns its output and asks for the next response', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.clearSent();
    openai.msg(
      done(
        { type: 'message', role: 'assistant' },
        fnCall('save_qualification', '{"field":"timeline","value":"3 months"}', 'call_1'),
      ),
    );
    await flush();
    expect(hooks.onTool).toHaveBeenCalledWith('save_qualification', {
      field: 'timeline',
      value: '3 months',
    });
    expect(openai.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"ok":true}',
        },
      },
      { type: 'response.create' },
    ]);
  });

  it.each(['hangup', 'transfer'] as const)('does not ask for another response when then=%s', async (then) => {
    const { openai, bridge, hooks } = setup({}, { onTool: vi.fn(async () => ({ output: 'bye', then })) });
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('end_call', '{"outcome":"not_interested"}', 'call_9')));
    await flush();
    // The VAD auto-response switch-off is pinned under 'closing latch'.
    expect(openai.sent.filter((m) => m.type !== 'session.update')).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_9',
          output: 'bye',
        },
      },
    ]);
    expect(hooks.onEnd).not.toHaveBeenCalled();
  });

  it('answers wait_for_user itself and does not ask the agent to speak', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('wait_for_user', '{}', 'call_w')));
    await flush();
    expect(hooks.onTool).not.toHaveBeenCalled();
    expect(openai.sent).toEqual([
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_w', output: '{"ok":true}' } },
    ]);
  });

  it('a batch with wait_for_user and save_qualification runs both and stays quiet', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('save_qualification', '{"field":"timeline","value":"soon"}', 'c1'), fnCall('wait_for_user', '{}', 'c2')));
    await flush();
    expect(hooks.onTool).toHaveBeenCalledTimes(1);
    expect(openai.types()).toEqual(['conversation.item.create', 'conversation.item.create']);
  });

  it('answers bad JSON arguments with an error without calling the hook', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('save_qualification', '{"field":', 'call_2')));
    await flush();
    expect(hooks.onTool).not.toHaveBeenCalled();
    expect(openai.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_2',
          output: '{"error":"bad arguments"}',
        },
      },
      { type: 'response.create' },
    ]);
  });

  it('answers an unknown tool or a failing hook with an error and carries on', async () => {
    const onTool = vi.fn(async () => {
      throw new Error('db down');
    });
    const { openai, bridge, hooks } = setup({}, { onTool });
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('launch_rocket', '{}', 'call_3'), fnCall('schedule_callback', '{}', 'call_4')));
    await flush();
    expect(onTool).toHaveBeenCalledTimes(1);
    expect(openai.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_3',
          output: '{"error":"unknown tool"}',
        },
      },
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_4',
          output: '{"error":"tool failed"}',
        },
      },
      { type: 'response.create' },
    ]);
    expect(hooks.log.error).toHaveBeenCalled();
  });

  it('runs two calls in order, sends both outputs, then one response.create', async () => {
    const order: string[] = [];
    const onTool = vi.fn(async (name: string) => {
      order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, name === 'save_qualification' ? 50 : 1));
      order.push(`end:${name}`);
      return { output: name };
    });
    const { openai, bridge } = setup({}, { onTool: onTool as BridgeHooks['onTool'] });
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('save_qualification', '{}', 'c1'), fnCall('schedule_callback', '{}', 'c2')));
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual([
      'start:save_qualification',
      'end:save_qualification',
      'start:schedule_callback',
      'end:schedule_callback',
    ]);
    expect(openai.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'save_qualification',
        },
      },
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'c2',
          output: 'schedule_callback',
        },
      },
      { type: 'response.create' },
    ]);
  });

  it('skips response.create when any call in the batch hangs up', async () => {
    const onTool = vi.fn(async (name: string) => ({
      output: 'ok',
      then: name === 'mark_do_not_call' ? ('hangup' as const) : ('continue' as const),
    }));
    const { openai, bridge } = setup({}, { onTool: onTool as BridgeHooks['onTool'] });
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('save_qualification', '{}', 'c1'), fnCall('mark_do_not_call', '{}', 'c2')));
    await flush();
    expect(openai.types()).toEqual(['conversation.item.create', 'conversation.item.create', 'session.update']);
  });

  it('ignores response.done without function calls', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.clearSent();
    openai.msg(done({ type: 'message', role: 'assistant' }));
    openai.msg({ type: 'response.done', response: {} });
    await flush();
    expect(hooks.onTool).not.toHaveBeenCalled();
    expect(openai.sent).toEqual([]);
  });
});

describe('ending', () => {
  it('fires onEnd(max_duration) after maxCallMs from start', async () => {
    const { openai, bridge, hooks } = setup({ maxCallMs: 60_000 });
    bridge.start();
    openai.msg(READY);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(hooks.onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.onEnd).toHaveBeenCalledWith('max_duration', undefined);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it('Twilio stop closes OpenAI and ends with twilio_closed', () => {
    const { twilio, openai, bridge, hooks } = setup();
    bridge.start();
    twilio.msg({ event: 'stop', stop: { accountSid: 'AC', callSid: 'CA' } });
    expect(openai.readyState).toBe(3);
    expect(hooks.onEnd).toHaveBeenCalledWith('twilio_closed', undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a closed OpenAI socket ends with openai_closed', () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.close();
    expect(hooks.onEnd).toHaveBeenCalledWith('openai_closed', undefined);
  });

  it('rejects a missing or too-short maxCallMs', () => {
    for (const maxCallMs of [9_999, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => setup({ maxCallMs })).toThrow(RangeError);
    }
    expect(() => setup({ maxCallMs: 10_000 })).not.toThrow();
  });

  it('a socket error ends with error', () => {
    const { twilio, bridge, hooks } = setup();
    bridge.start();
    twilio.emit('error', new Error('ECONNRESET'));
    expect(hooks.onEnd).toHaveBeenCalledWith('error', 'twilio: ECONNRESET');
  });

  it('fires onEnd exactly once across twilio close, openai close and stop()', async () => {
    const { twilio, openai, bridge, hooks } = setup({ maxCallMs: 10_000 });
    bridge.start();
    twilio.close();
    openai.close();
    bridge.stop();
    bridge.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    expect(hooks.onEnd).toHaveBeenCalledWith('twilio_closed', undefined);
  });

  it('stop() is idempotent, closes both sockets and reports twilio_closed once', () => {
    const { twilio, openai, bridge, hooks } = setup();
    bridge.start();
    bridge.stop();
    bridge.stop();
    expect(twilio.closeCalls).toBe(1);
    expect(openai.closeCalls).toBe(1);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    expect(hooks.onEnd).toHaveBeenCalledWith('twilio_closed', 'stopped');
  });

  it('logs OpenAI error events without ending the call', () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    openai.msg(READY);
    openai.msg({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'bad_truncate',
        message: 'audio_end_ms too large',
      },
    });
    expect(hooks.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'bad_truncate',
        errorType: 'invalid_request_error',
      }),
      expect.any(String),
    );
    expect(hooks.onEnd).not.toHaveBeenCalled();
  });

  it('never logs audio payloads', () => {
    const { twilio, openai, bridge, hooks } = setup();
    bridge.start();
    openai.msg(READY);
    const secret = 'U0VDUkVUQVVESU8=';
    twilio.msg(media(20, secret));
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: secret,
    });
    openai.msg({
      type: 'error',
      error: { type: 'x', code: 'y', message: 'z' },
    });
    twilio.emit('message', `{"event":"media","media":{"payload":"${secret}"`);
    bridge.stop();
    const logged = JSON.stringify([hooks.log.info.mock.calls, hooks.log.warn.mock.calls, hooks.log.error.mock.calls]);
    expect(logged).not.toContain(secret);
  });
});

describe('hook failures', () => {
  it('a throwing onTranscript or onEnd is logged, not thrown into the socket handler', () => {
    const { twilio, openai, bridge, hooks } = setup();
    hooks.onTranscript.mockImplementation(() => {
      throw new Error('db down');
    });
    hooks.onEnd.mockImplementation(() => {
      throw new Error('db down');
    });
    bridge.start();
    expect(() =>
      openai.msg({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hi' }),
    ).not.toThrow();
    expect(() => twilio.msg({ event: 'stop', stop: {} })).not.toThrow();
    expect(openai.readyState).toBe(3);
    expect(hooks.log.error).toHaveBeenCalledTimes(2);
  });
});

describe('bridge-owned end backstop', () => {
  function playing() {
    const ctx = setup({ maxCallMs: 60_000 });
    ctx.bridge.start();
    ctx.openai.msg(READY);
    ctx.openai.msg({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1 }); // no opener
    ctx.twilio.msg(media(1000));
    ctx.openai.msg({ type: 'response.created', response: { id: 'r1' } });
    ctx.openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(1000) });
    ctx.twilio.msg(media(1200));
    ctx.twilio.clearSent();
    ctx.openai.clearSent();
    return ctx;
  }

  it('max_duration silences at once, reports, then closes both sockets after END_GRACE_MS', async () => {
    const { twilio, openai, hooks } = playing();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hooks.onEnd).toHaveBeenCalledWith('max_duration', undefined);
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    expect(openai.types()).toEqual(['response.cancel', 'conversation.item.truncate']);
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_2', delta: 'LATE' });
    expect(twilio.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS - 1);
    expect(twilio.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(twilio.readyState).toBe(3);
    expect(openai.readyState).toBe(3);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('openai_closed silences Twilio and closes it after the grace period', async () => {
    const { twilio, openai, hooks } = playing();
    openai.close();
    expect(hooks.onEnd).toHaveBeenCalledWith('openai_closed', undefined);
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS);
    expect(twilio.readyState).toBe(3);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it('an OpenAI socket error silences, reports error, and closes after the grace period', async () => {
    const { twilio, openai, hooks } = playing();
    openai.emit('error', new Error('boom'));
    expect(hooks.onEnd).toHaveBeenCalledWith('error', 'openai: boom');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS);
    expect(twilio.readyState).toBe(3);
    expect(openai.readyState).toBe(3);
  });

  it('stop() inside the grace period cancels the backstop', async () => {
    const { twilio, openai, bridge, hooks } = playing();
    openai.close();
    bridge.stop();
    expect(twilio.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS * 2);
    expect(twilio.closeCalls).toBe(1);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it('a late session.updated after the end arms no opener', async () => {
    const { openai, bridge } = setup({ maxCallMs: 10_000 });
    bridge.start();
    await vi.advanceTimersByTimeAsync(10_000); // max_duration; only the backstop remains
    expect(vi.getTimerCount()).toBe(1);
    openai.msg({ type: 'session.updated', session: {} });
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('closing latch', () => {
  const done = (...output: object[]) => ({ type: 'response.done', response: { status: 'completed', output } });
  const STOP_AUTO_RESPONSES = {
    type: 'session.update',
    session: {
      type: 'realtime',
      audio: {
        input: {
          turn_detection: { type: 'semantic_vad', eagerness: 'high', create_response: false, interrupt_response: true },
        },
      },
    },
  };

  for (const then of ['hangup', 'transfer'] as const) {
    it(`a ${then} result turns off VAD auto-responses (same turn detection otherwise), once`, async () => {
      const { openai, bridge } = setup({ vadEagerness: 'high' }, { onTool: vi.fn(async () => ({ output: 'ok', then })) });
      bridge.start();
      openai.clearSent();
      openai.msg(done(fnCall('end_call', '{}', 'c1')));
      await flush();
      expect(openai.sent).toEqual([
        { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
        STOP_AUTO_RESPONSES,
      ]);
      openai.clearSent();
      openai.msg(done(fnCall('end_call', '{}', 'c2')));
      await flush();
      expect(openai.types()).toEqual(['conversation.item.create']);
    });
  }

  it('a continuing result leaves VAD auto-responses on', async () => {
    const { openai, bridge } = setup();
    bridge.start();
    openai.clearSent();
    openai.msg(done(fnCall('save_qualification', '{}', 'c1')));
    await flush();
    expect(openai.types()).not.toContain('session.update');
  });

  it('after a hangup result, later tool batches send outputs but no response.create', async () => {
    const onTool = vi.fn(async (name: string) => ({
      output: 'ok',
      then: name === 'end_call' ? ('hangup' as const) : ('continue' as const),
    }));
    const { openai, bridge } = setup({}, { onTool: onTool as BridgeHooks['onTool'] });
    bridge.start();
    openai.msg(done(fnCall('end_call', '{}', 'c1')));
    await flush();
    openai.clearSent();
    openai.msg(done(fnCall('save_qualification', '{}', 'c2')));
    await flush();
    expect(openai.types()).toEqual(['conversation.item.create']);
  });

  it('after a transfer result, the opener never fires', async () => {
    const { openai, bridge } = setup({}, { onTool: vi.fn(async () => ({ output: 'ok', then: 'transfer' as const })) });
    bridge.start();
    openai.msg({ type: 'session.updated', session: {} });
    openai.msg(done(fnCall('transfer_to_rep', '{}', 'c1')));
    await flush();
    openai.clearSent();
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS * 2);
    expect(openai.sent).toEqual([]);
  });

  it('after silence(), a continuing tool result sends no response.create', async () => {
    const { openai, bridge } = setup();
    bridge.start();
    bridge.silence();
    openai.clearSent();
    openai.msg(done(fnCall('save_qualification', '{}', 'c1')));
    await flush();
    expect(openai.types()).toEqual(['conversation.item.create']);
  });

  it('silence() during a slow tool suppresses the response.create it would have sent', async () => {
    const onTool = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { output: 'ok' };
    });
    const { openai, bridge } = setup({}, { onTool });
    bridge.start();
    openai.msg(done(fnCall('save_qualification', '{}', 'c1')));
    await vi.advanceTimersByTimeAsync(10);
    bridge.silence();
    openai.clearSent();
    await vi.advanceTimersByTimeAsync(200);
    expect(openai.types()).toEqual(['conversation.item.create']);
  });
});

describe('after a barge-in truncation', () => {
  it('drops late deltas for the truncated item and never truncates it twice', () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.msg(READY);
    twilio.msg(media(1000));
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(2000) });
    twilio.msg(media(1300));
    openai.msg({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1 });
    twilio.clearSent();
    openai.clearSent();
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(100) });
    expect(twilio.sent).toEqual([]);
    openai.msg({ type: 'input_audio_buffer.speech_started', audio_start_ms: 2 });
    bridge.silence();
    expect(openai.types()).not.toContain('conversation.item.truncate');
  });

  it('still plays the next item', () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.msg(READY);
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_1', delta: audio(100) });
    openai.msg({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1 });
    twilio.clearSent();
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_2', delta: 'NEXT' });
    expect(twilio.sent[0]).toEqual({ event: 'media', streamSid: SID, media: { payload: 'NEXT' } });
  });
});

describe('OpenAI outbox cap', () => {
  it('keeps session.update and the newest caller audio when OpenAI is slow to open', () => {
    const { twilio, openai, bridge, hooks } = setup();
    openai.readyState = 0;
    bridge.start();
    for (let i = 0; i < 600; i++) twilio.msg(media(i * 20, `P${i}`));
    openai.open();
    expect(openai.sent).toHaveLength(500);
    expect(openai.sent[0]?.type).toBe('session.update');
    expect(openai.sent[1]?.audio).toBe('P101');
    expect(openai.sent[499]?.audio).toBe('P599');
    expect(hooks.log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('silence()', () => {
  it('clears Twilio, cancels the active response, truncates, and drops later audio', () => {
    const { twilio, openai, bridge, hooks } = setup();
    bridge.start();
    openai.msg(READY);
    twilio.msg(media(1000));
    openai.msg({ type: 'response.created', response: { id: 'resp_1' } });
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: audio(1000),
    });
    twilio.msg(media(1250));
    twilio.clearSent();
    openai.clearSent();
    bridge.silence();
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    expect(openai.sent).toEqual([
      { type: 'response.cancel' },
      {
        type: 'conversation.item.truncate',
        item_id: 'item_1',
        content_index: 0,
        audio_end_ms: 250,
      },
    ]);
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: 'MORE',
    });
    expect(twilio.sent).toHaveLength(1);
    // transcripts still flow; agent lines are marked as not heard
    openai.msg({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'wait' });
    openai.msg({ type: 'response.output_audio_transcript.done', transcript: 'As I was saying' });
    expect(hooks.onTranscript).toHaveBeenCalledTimes(2);
    expect(hooks.onTranscript.mock.calls[0]?.[0]).toMatchObject({ role: 'caller', text: 'wait' });
    expect(hooks.onTranscript.mock.calls[1]?.[0]).toMatchObject({
      role: 'system',
      text: '[not played] As I was saying',
    });
    // idempotent
    bridge.silence();
    expect(twilio.sent).toHaveLength(1);
    expect(openai.sent).toHaveLength(2);
  });

  it('skips response.cancel and truncate when nothing is active', () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.msg({ type: 'response.created', response: { id: 'resp_1' } });
    openai.msg({
      type: 'response.done',
      response: { status: 'completed', output: [] },
    });
    openai.clearSent();
    bridge.silence();
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    expect(openai.sent).toEqual([]);
  });

  it('still processes tool calls after silence', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    bridge.silence();
    openai.msg({
      type: 'response.done',
      response: { output: [fnCall('end_call', '{"outcome":"other"}', 'c1')] },
    });
    await flush();
    expect(hooks.onTool).toHaveBeenCalledWith('end_call', { outcome: 'other' });
  });
});

describe('waitForPlayback()', () => {
  it('resolves once output_audio.done has arrived and every mark has played', async () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.msg(READY);
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: audio(100),
    });
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: audio(100),
    });
    let resolved = false;
    void bridge.waitForPlayback().then(() => {
      resolved = true;
    });
    const marks = twilio.sent.filter((m) => m.event === 'mark').map((m) => (m.mark as { name: string }).name);
    twilio.msg({ event: 'mark', streamSid: SID, mark: { name: marks[0] } });
    twilio.msg({ event: 'mark', streamSid: SID, mark: { name: marks[1] } });
    await flush();
    expect(resolved).toBe(false); // audio not done yet
    openai.msg({ type: 'response.output_audio.done', item_id: 'item_1' });
    await flush();
    expect(resolved).toBe(true);
  });

  it('resolves after maxMs (default 8 s) when marks never come back', async () => {
    const { openai, bridge } = setup();
    bridge.start();
    openai.msg(READY);
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: audio(100),
    });
    openai.msg({ type: 'response.output_audio.done', item_id: 'item_1' });
    let resolved = false;
    void bridge.waitForPlayback().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it('resolves at once when nothing is playing, and when the bridge stops', async () => {
    const { openai, bridge } = setup();
    bridge.start();
    openai.msg(READY);
    await expect(bridge.waitForPlayback(1000)).resolves.toBeUndefined();
    openai.msg({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: audio(100),
    });
    const w = bridge.waitForPlayback(60_000);
    bridge.stop();
    await expect(w).resolves.toBeUndefined();
    await expect(bridge.waitForPlayback(60_000)).resolves.toBeUndefined(); // after the end
  });
});

describe('fails closed until the session is configured', () => {
  const delta = { type: 'response.output_audio.delta', item_id: 'item_1', delta: 'AUD1' };

  it('forwards no agent audio to Twilio before session.updated', () => {
    const { twilio, openai, bridge } = setup();
    bridge.start();
    openai.msg(delta);
    expect(twilio.sent).toEqual([]);
    openai.msg({ type: 'session.updated', session: {} });
    openai.msg(delta);
    expect(twilio.sent.map((m) => m.event)).toEqual(['media', 'mark']);
  });

  it('an OpenAI error before session.updated ends the call through the backstop', async () => {
    const { twilio, openai, bridge, hooks } = setup();
    bridge.start();
    openai.msg({ type: 'error', error: { type: 'invalid_request_error', code: 'bad_model', message: 'model not found' } });
    expect(hooks.onEnd).toHaveBeenCalledWith('error', 'session not configured: model not found');
    expect(twilio.sent).toEqual([{ event: 'clear', streamSid: SID }]);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS);
    expect(twilio.readyState).toBe(3);
    expect(openai.readyState).toBe(3);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it(`ends the call when no session.updated arrives within ${SESSION_READY_TIMEOUT_MS} ms of the socket opening`, async () => {
    const { openai, bridge, hooks } = setup();
    openai.readyState = 0;
    bridge.start();
    await vi.advanceTimersByTimeAsync(SESSION_READY_TIMEOUT_MS * 2);
    expect(hooks.onEnd).not.toHaveBeenCalled(); // the clock starts when the socket opens
    openai.open();
    await vi.advanceTimersByTimeAsync(SESSION_READY_TIMEOUT_MS - 1);
    expect(hooks.onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.onEnd).toHaveBeenCalledWith('error', 'session not configured: timeout');
    await vi.advanceTimersByTimeAsync(END_GRACE_MS);
    expect(openai.readyState).toBe(3);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it('session.updated in time disarms the timeout, and later errors are only logged', async () => {
    const { openai, bridge, hooks } = setup();
    bridge.start();
    await vi.advanceTimersByTimeAsync(SESSION_READY_TIMEOUT_MS - 1);
    openai.msg({ type: 'session.updated', session: {} });
    openai.msg({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1 }); // no opener timer
    await vi.advanceTimersByTimeAsync(SESSION_READY_TIMEOUT_MS * 2);
    openai.msg({ type: 'error', error: { type: 'x', code: 'y', message: 'z' } });
    expect(hooks.onEnd).not.toHaveBeenCalled();
    expect(hooks.log.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'z' }), expect.any(String));
  });
});
