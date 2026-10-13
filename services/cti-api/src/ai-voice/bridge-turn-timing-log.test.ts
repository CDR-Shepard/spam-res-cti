import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCallBridge, type BridgeHooks, type BridgeOptions, type BridgeSocket } from './bridge.js';
import { AI_CALL_TOOLS } from './prompt.js';

/** The one info line per answered caller turn (bridge-turn-timing.ts), logged by AiCallBridge. */
const MESSAGE = 'ai-voice: turn timing';
const SID = 'MZ0000';
const READY = { type: 'session.updated', session: {} };
const audio = (ms: number): string => Buffer.alloc(ms * 8).toString('base64');
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

class FakeSocket implements BridgeSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly history: Array<Record<string, unknown>> = [];
  private readonly handlers: Record<'message' | 'close' | 'error' | 'open', Array<(a: unknown) => void>> = { message: [], close: [], error: [], open: [] };
  send(data: string): void {
    const m = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(m);
    this.history.push(m);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const h of this.handlers.close) h(undefined);
  }
  on(ev: 'message' | 'close' | 'error' | 'open', cb: (a: never) => void): void {
    this.handlers[ev].push(cb as (a: unknown) => void);
  }
  msg(o: object): void {
    for (const h of this.handlers.message) h(JSON.stringify(o));
  }
  marks(): string[] {
    return this.history.filter((m) => m.event === 'mark').map((m) => (m.mark as { name: string }).name);
  }
}

type Hooks = BridgeHooks & { log: { info: ReturnType<typeof vi.fn> } };

function setup(over: Partial<BridgeOptions> = {}, onTool?: BridgeHooks['onTool']) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  const onStats = vi.fn();
  const hooks = {
    onTool: onTool ?? vi.fn(async () => ({ output: '{"ok":true}' })),
    onTranscript: vi.fn(),
    onEnd: vi.fn(),
    onStats,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies Hooks;
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
      bargeIn: 'gate',
      turnDetection: 'server_vad',
      maxCallMs: 600_000,
      ...over,
    },
    hooks,
  );
  bridge.start();
  openai.msg(READY);
  return { twilio, openai, hooks, bridge, onStats };
}
type Setup = ReturnType<typeof setup>;

/** Every `ai-voice: turn timing` field set logged so far. */
const lines = (s: Setup): Array<Record<string, unknown>> =>
  s.hooks.log.info.mock.calls.filter(([, m]) => m === MESSAGE).map(([fields]) => fields as Record<string, unknown>);

const at = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const started = (s: Setup, id = 'c1') => s.openai.msg({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: 0 });
const stopped = (s: Setup, id = 'c1') => s.openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: 900 });
const committed = (s: Setup, id = 'c1') => s.openai.msg({ type: 'input_audio_buffer.committed', item_id: id });
const created = (s: Setup) => s.openai.msg({ type: 'response.created' });
const delta = (s: Setup, itemId: string, ms = 100) => s.openai.msg({ type: 'response.output_audio.delta', item_id: itemId, delta: audio(ms) });
const words = (s: Setup, text: string, id = 'c1') =>
  s.openai.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta: text });
const completed = (s: Setup, text: string, id = 'c1') =>
  s.openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text });
const done = (...output: object[]) => ({ type: 'response.done', response: { status: 'completed', output } });
const cancelledDone = { type: 'response.done', response: { status: 'cancelled', output: [] } };
const creates = (s: Setup) => s.openai.sent.filter((m) => m.type === 'response.create');
/** Twilio confirms only the first chunk the agent sent after `fromIndex` marks. */
const echoMark = (s: Setup, index: number) => s.twilio.msg({ event: 'mark', streamSid: SID, mark: { name: s.twilio.marks()[index] } });
const echoAll = (s: Setup) => {
  for (let i = 0; i < s.twilio.marks().length; i += 1) echoMark(s, i);
};

/** Gate mode: the opener (item_0) played out, then the agent is 3 s into a streaming answer (item_1), a caller overlap possible. */
async function agentTalking(over: Partial<BridgeOptions> = {}) {
  const s = setup(over);
  created(s);
  delta(s, 'item_0');
  s.openai.msg({ type: 'response.output_audio.done' });
  s.openai.msg(done());
  echoAll(s);
  s.twilio.msg({ event: 'media', streamSid: SID, media: { timestamp: '1000', payload: audio(20) } });
  created(s);
  delta(s, 'item_1', 3000);
  s.twilio.msg({ event: 'media', streamSid: SID, media: { timestamp: '1500', payload: audio(20) } });
  await flush();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('turn timing log (gate mode)', () => {
  it('a normal turn logs once, with the figures of stopped → committed → create → created → deltas → mark echo', async () => {
    const s = setup();
    started(s);
    await at(1000);
    stopped(s);
    await at(40);
    committed(s); // the bridge sends response.create right away
    expect(creates(s)).toHaveLength(1);
    await at(120);
    created(s);
    await at(700);
    delta(s, 'item_1', 100);
    delta(s, 'item_1', 100);
    s.openai.msg({ type: 'response.output_audio.done' });
    await at(30);
    echoAll(s); // the first mark logs; the second changes nothing
    expect(lines(s)).toEqual([
      {
        committedMs: 40,
        requestedMs: 40,
        deferred: null,
        createdMs: 160,
        firstDeltaMs: 860,
        forwardedMs: 860,
        playedMs: 890,
        responses: 1,
        toolBatches: 0,
        overlap: false,
        late: false,
        bargeIn: 'gate',
        turnDetection: 'server_vad',
      },
    ]);
    s.bridge.stop();
    expect(lines(s)).toHaveLength(1); // logged on the echo, not again at the end
  });

  it('forwardedMs is the stats\' answer point', async () => {
    const s = setup();
    started(s);
    await at(1000);
    stopped(s);
    await at(40);
    committed(s);
    await at(120);
    created(s);
    await at(700);
    delta(s, 'item_1');
    echoAll(s);
    s.bridge.stop();
    const stats = s.onStats.mock.calls[0]?.[0] as { answerMs: { p50: number } };
    expect(stats.answerMs.p50).toBe(860);
    expect(lines(s)[0]).toMatchObject({ forwardedMs: stats.answerMs.p50 });
  });

  it('a function-call-first turn shows responses 2 and toolBatches 1', async () => {
    const s = setup();
    started(s);
    await at(1000);
    stopped(s);
    await at(30);
    committed(s);
    await at(100);
    created(s); // response 1: only a function call
    await at(200);
    s.openai.msg(done({ type: 'function_call', name: 'save_qualification', call_id: 'call_1', arguments: '{"field":"timeline","value":"3 months"}' }));
    await flush(); // the batch runs and the bridge asks for the follow-up answer
    expect(creates(s)).toHaveLength(2);
    await at(50);
    created(s); // response 2: the spoken answer
    await at(300);
    delta(s, 'item_1');
    await at(20);
    echoMark(s, 0);
    expect(lines(s)).toEqual([
      expect.objectContaining({
        committedMs: 30,
        requestedMs: 30,
        deferred: null,
        createdMs: 130,
        firstDeltaMs: 680,
        forwardedMs: 680,
        playedMs: 700,
        responses: 2,
        toolBatches: 1,
      }),
    ]);
  });

  it('a turn held behind a tool batch that was already running shows deferred "tools"', async () => {
    let finish: () => void = () => undefined;
    const s = setup({}, () => new Promise((resolve) => (finish = () => resolve({ output: '{"ok":true}' }))));
    created(s);
    s.openai.msg(done({ type: 'function_call', name: 'save_qualification', call_id: 'call_1', arguments: '{"field":"timeline","value":"3 months"}' }));
    await flush(); // the batch is running
    started(s);
    await at(500);
    stopped(s);
    await at(20);
    committed(s);
    expect(creates(s)).toHaveLength(0); // held: a batch is running
    await at(400);
    finish();
    await flush(); // released: one create answers both
    expect(creates(s)).toHaveLength(1);
    await at(60);
    created(s);
    await at(300);
    delta(s, 'item_1');
    echoMark(s, 0);
    expect(lines(s)).toEqual([expect.objectContaining({ deferred: 'tools', committedMs: 20, requestedMs: 420, createdMs: 480, forwardedMs: 780, responses: 1, toolBatches: 0 })]);
  });

  it('a turn held behind a response that is still active shows deferred "response_active"', async () => {
    const s = setup();
    created(s); // a response with no sound yet
    started(s); // the caller starts: it is dropped unheard
    await at(500);
    stopped(s);
    await at(20);
    committed(s);
    expect(creates(s)).toHaveLength(0);
    await at(100);
    s.openai.msg(cancelledDone); // the dropped response ends: the held answer goes out
    expect(creates(s)).toHaveLength(1);
    await at(80);
    created(s);
    await at(300);
    delta(s, 'item_1');
    echoMark(s, 0);
    expect(lines(s)).toEqual([expect.objectContaining({ deferred: 'response_active', requestedMs: 120, createdMs: 200, forwardedMs: 500, responses: 1 })]);
  });

  it('an overlap judged by words: deferred "overlap_verdict", overlap true, timed from its own stop', async () => {
    const s = await agentTalking();
    started(s);
    await at(400);
    stopped(s); // agent still talking: an overlap the gate is judging
    await at(50);
    committed(s);
    expect(creates(s)).toHaveLength(0);
    await at(100);
    words(s, ' Wait'); // a stop word cuts the agent: this overlap is the turn
    completed(s, 'Wait, who is this?');
    expect(s.openai.sent.some((m) => m.type === 'response.cancel')).toBe(true);
    await at(60);
    s.openai.msg(cancelledDone); // now the create can go
    expect(creates(s)).toHaveLength(1);
    await at(80);
    created(s);
    await at(400);
    delta(s, 'item_2');
    await at(20);
    echoMark(s, s.twilio.marks().length - 1);
    expect(lines(s)).toEqual([
      {
        committedMs: 50,
        requestedMs: 210,
        deferred: 'overlap_verdict',
        createdMs: 290,
        firstDeltaMs: 690,
        forwardedMs: 690,
        playedMs: 710,
        responses: 1,
        toolBatches: 0,
        overlap: true,
        late: false,
        bargeIn: 'gate',
        turnDetection: 'server_vad',
      },
    ]);
    expect(JSON.stringify(lines(s))).not.toMatch(/who is this/i); // numbers, booleans and short enums only
  });

  it('a late "yeah sure" overlap is answered once the agent has played: late true, deferred "overlap_verdict"', async () => {
    const s = await agentTalking();
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(done());
    s.twilio.msg({ event: 'media', streamSid: SID, media: { timestamp: '3000', payload: audio(20) } }); // 1 s of item_1 left
    started(s);
    words(s, ' Yeah sure');
    await at(300);
    stopped(s);
    await at(20);
    committed(s);
    completed(s, 'Yeah, sure.');
    expect(creates(s)).toHaveLength(0); // waits for item_1 to play out
    await at(700);
    echoAll(s); // item_1 played: the answer is requested now
    expect(creates(s)).toHaveLength(1);
    await at(50);
    created(s);
    await at(250);
    delta(s, 'item_2');
    await at(20);
    echoMark(s, s.twilio.marks().length - 1);
    expect(lines(s)).toEqual([
      expect.objectContaining({ overlap: true, late: true, deferred: 'overlap_verdict', committedMs: 20, requestedMs: 720, createdMs: 770, forwardedMs: 1020, playedMs: 1040 }),
    ]);
  });

  it('an answered turn Twilio never confirms logs with playedMs null at the next speech_started, and only once', async () => {
    const s = setup();
    started(s);
    await at(500);
    stopped(s);
    committed(s);
    await at(100);
    created(s);
    await at(300);
    delta(s, 'item_1');
    expect(lines(s)).toHaveLength(0);
    started(s, 'c2'); // the caller talks again before any mark came back
    expect(lines(s)).toEqual([expect.objectContaining({ forwardedMs: 400, playedMs: null })]);
    echoMark(s, 0); // too late to count
    s.bridge.stop();
    expect(lines(s)).toHaveLength(1);
  });

  it('an answered turn whose call ends before Twilio confirms it logs at the end, with playedMs null', async () => {
    const s = setup();
    started(s);
    await at(500);
    stopped(s);
    committed(s);
    await at(100);
    created(s);
    await at(300);
    delta(s, 'item_1');
    s.bridge.stop();
    expect(lines(s)).toEqual([expect.objectContaining({ forwardedMs: 400, playedMs: null })]);
    expect(s.hooks.log.info.mock.invocationCallOrder.at(-1)).toBeLessThan(s.hooks.onEnd.mock.invocationCallOrder[0] as number);
  });

  it('an unanswered turn (a check-in the agent never spoke for) logs nothing', async () => {
    const s = setup();
    started(s);
    await at(300);
    stopped(s);
    committed(s);
    s.bridge.stop();
    expect(lines(s)).toEqual([]);
  });
});

describe('turn timing log (instant mode)', () => {
  it('logs the VAD-answered turn with requestedMs null and sends no frame of its own', async () => {
    const s = setup({ bargeIn: 'instant' });
    s.openai.sent.length = 0;
    s.twilio.sent.length = 0;
    started(s);
    await at(800);
    stopped(s);
    await at(20);
    committed(s); // OpenAI's VAD answers by itself
    await at(150);
    created(s);
    await at(600);
    delta(s, 'item_1');
    await at(25);
    echoMark(s, 0);
    expect(lines(s)).toEqual([
      expect.objectContaining({ bargeIn: 'instant', committedMs: 20, requestedMs: null, createdMs: 170, firstDeltaMs: 770, forwardedMs: 770, playedMs: 795, responses: 1 }),
    ]);
    expect(s.openai.sent).toEqual([]); // logging only: nothing extra went to OpenAI…
    expect(s.twilio.sent).toEqual([
      { event: 'media', streamSid: SID, media: { payload: audio(100) } },
      { event: 'mark', streamSid: SID, mark: { name: 'agent-1' } },
    ]); // …or to Twilio, beyond the audio and its mark
  });
});
