import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiCallBridge,
  END_GRACE_MS,
  OPENER_DELAY_MS,
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
  closeCalls = 0;
  private readonly handlers: Record<Ev, Array<(a: unknown) => void>> = {
    message: [],
    close: [],
    error: [],
    open: [],
  };

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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
    await vi.advanceTimersByTimeAsync(10_000);
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
    expect(openai.sent).toEqual([
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
    expect(openai.types()).toEqual(['conversation.item.create', 'conversation.item.create']);
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
    const { bridge, hooks } = setup({ maxCallMs: 60_000 });
    bridge.start();
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
