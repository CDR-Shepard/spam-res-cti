import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCallBridge, type BridgeHooks, type BridgeOptions, type BridgeSocket, type ToolResult } from './bridge.js';
import { withExternalVoice, type TtsEvents } from './external-voice.js';
import { AI_CALL_TOOLS } from './prompt.js';
import { silentLog } from './testing.js';

/**
 * Answering sooner, with patience (turn-patience.ts; gate mode, a 250 ms server_vad silence). The caller's words run
 * behind their turn (probe 2026-11-16: none of "Um." at its commit, the rest of a sentence 0.1–0.3 s after it), so the
 * bridge judges the wait at the commit and again as words come in, and takes back an answer nobody has heard yet.
 */
const SID = 'MZ0000';
const READY = { type: 'session.updated', session: {} };
const TIMING = 'ai-voice: turn timing';
const PATIENCE = { longTurnWaitMs: 250, hesitantWaitMs: 700 };
const CREATE = { type: 'response.create', event_id: expect.stringMatching(/^ai-create-\d+$/) };
const audio = (ms: number): string => Buffer.alloc(ms * 8).toString('base64');

class FakeSocket implements BridgeSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  readonly history: Array<Record<string, unknown>> = [];
  private readonly handlers: Record<'message' | 'close' | 'error' | 'open', Array<(a: unknown) => void>> = { message: [], close: [], error: [], open: [] };
  send(data: string): void {
    const m = JSON.parse(data) as Record<string, unknown>;
    this.sent = [...this.sent, m];
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
  clearSent(): void {
    this.sent = [];
  }
  types(): unknown[] {
    return this.sent.map((m) => m.type);
  }
}

function setup(over: Partial<BridgeOptions> = {}, onTool?: BridgeHooks['onTool']) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  const hooks = {
    onTool: onTool ?? vi.fn(async () => ({ output: '{"ok":true}' })),
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
      reasoningEffort: 'minimal',
      vadEagerness: 'auto',
      maxCallMs: 600_000,
      finalWordsWaitMs: 0,
      bargeIn: 'gate',
      turnDetection: 'server_vad',
      silenceMs: 250,
      patience: PATIENCE,
      ...over,
    },
    hooks,
  );
  bridge.start();
  openai.msg(READY);
  openai.clearSent();
  return { twilio, openai, hooks, bridge };
}
type Setup = ReturnType<typeof setup>;

const at = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const creates = (s: Setup) => s.openai.sent.filter((m) => m.type === 'response.create');
const cancels = (s: Setup) => s.openai.sent.filter((m) => m.type === 'response.cancel');
const deletes = (s: Setup) => s.openai.sent.filter((m) => m.type === 'conversation.item.delete');
const created = (s: Setup) => s.openai.msg({ type: 'response.created' });
const heard = (s: Setup, id: string, text: string) =>
  s.openai.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta: text });
const line = (id: string, text: string) => ({ type: 'message', id, role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text }] });
const done = (status: 'completed' | 'cancelled', ...output: object[]) => ({ type: 'response.done', response: { status, output } });
const fnCall = (name: string, callId: string) => ({ type: 'function_call', name, call_id: callId, arguments: '{}', status: 'completed' });
/** The caller talks for `ms` (`words` of it already in), then the turn ends: the stop after the 250 ms silence, then the commit. */
const says = async (s: Setup, id: string, ms: number, words = '') => {
  s.openai.msg({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: 0 });
  if (words) heard(s, id, words);
  await at(ms + 250);
  s.openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: ms });
  s.openai.msg({ type: 'input_audio_buffer.committed', item_id: id });
};
/** The agent says a line (`item`), and it plays out: Twilio echoes every mark. */
const agentSays = (s: Setup, item: string, ms = 200) => {
  created(s);
  s.openai.msg({ type: 'response.output_audio.delta', item_id: item, delta: audio(ms) });
  s.openai.msg({ type: 'response.output_audio.done' });
  s.openai.msg(done('completed'));
  for (const m of s.twilio.history.filter((x) => x.event === 'mark')) s.twilio.msg({ event: 'mark', streamSid: SID, mark: m.mark });
};
const timingLines = (s: Setup): Array<Record<string, unknown>> =>
  s.hooks.log.info.mock.calls.filter(([, m]) => m === TIMING).map(([fields]) => fields as Record<string, unknown>);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the wait, judged at the commit', () => {
  it('a short answer ("Mike.") is answered the moment its turn ends', async () => {
    const s = setup();
    await says(s, 'c1', 400, ' Mike.');
    expect(creates(s)).toEqual([CREATE]);
  });

  it('a long stretch of talk waits the long-turn time first: they may only be pausing', async () => {
    const s = setup();
    await says(s, 'c1', 3000, ' The kitchen was redone and the roof is pretty old though');
    await at(249);
    expect(creates(s)).toEqual([]);
    await at(1);
    expect(creates(s)).toEqual([CREATE]);
  });

  it('words that trail off ("Um,") wait the hesitant time', async () => {
    const s = setup();
    await says(s, 'c1', 300, ' Um,');
    await at(699);
    expect(creates(s)).toEqual([]);
    await at(1);
    expect(creates(s)).toEqual([CREATE]);
  });

  it('going on talking during the wait cancels it: one answer, after they finish', async () => {
    const s = setup();
    await says(s, 'c1', 300, ' It is, uh');
    await at(400);
    await says(s, 'c2', 600, ' forty-one forty-three Mississippi.'); // they went on before the 700 ms were up
    expect(creates(s)).toEqual([CREATE]);
    await at(2000);
    expect(creates(s)).toEqual([CREATE]);
  });

  it('talk adds up across pauses since the agent last spoke: the second half of a long answer is a long turn', async () => {
    const s = setup();
    await says(s, 'c1', 1200, ' I want to see what I can get for it');
    expect(creates(s)).toEqual([CREATE]);
    await says(s, 'c2', 1200, ' and if it does not work I will list it.'); // the first answer is dropped unheard
    expect(creates(s)).toEqual([CREATE]); // 2.4 s of talk now: the answer waits
    created(s); // the dropped one
    s.openai.msg(done('cancelled'));
    await at(250);
    expect(creates(s)).toEqual([CREATE, CREATE]);
  });

  it("the agent's next line starts the count again", async () => {
    const s = setup();
    await says(s, 'c1', 3000);
    await at(250);
    agentSays(s, 'a1');
    s.openai.clearSent();
    await says(s, 'c2', 400, ' Yesterday.');
    expect(creates(s)).toEqual([CREATE]);
  });

  it("talk over the agent's line (listening sounds) is not the start of a long turn", async () => {
    const s = setup();
    await says(s, 'c1', 400, ' Mike.');
    created(s);
    s.openai.msg({ type: 'response.output_audio.delta', item_id: 'a1', delta: audio(6000) });
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(done('completed'));
    // 2.5 s of "mm-hmm"s while the line plays; the gate lets the agent go on.
    s.openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'o1', audio_start_ms: 0 });
    await at(2750);
    s.openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'o1', audio_end_ms: 2500 });
    for (const m of s.twilio.history.filter((x) => x.event === 'mark')) s.twilio.msg({ event: 'mark', streamSid: SID, mark: m.mark });
    await at(0);
    s.openai.clearSent();
    await says(s, 'c2', 400, ' Yes.');
    expect(creates(s)).toEqual([CREATE]);
  });

  it('a call that ends during the wait is not answered, and leaves no timer behind', async () => {
    const quiet = setup();
    quiet.bridge.stop();
    const idleTimers = vi.getTimerCount();
    const s = setup();
    await says(s, 'c1', 300, ' Um,');
    s.bridge.stop();
    expect(vi.getTimerCount()).toBe(idleTimers * 2);
    await at(5000);
    expect(creates(s)).toEqual([]);
  });

  it('no patience configured (the default): every turn is answered at its commit, and late words change nothing', async () => {
    const s = setup({ silenceMs: 500, patience: undefined });
    await says(s, 'c1', 3000);
    expect(creates(s)).toEqual([CREATE]);
    created(s);
    heard(s, 'c1', ' Um,');
    expect(cancels(s)).toEqual([]);
  });

  it('semantic_vad does its own waiting: patience is off there', async () => {
    const s = setup({ turnDetection: 'semantic_vad' });
    await says(s, 'c1', 3000, ' Um,');
    expect(creates(s)).toEqual([CREATE]);
  });
});

describe('the wait, judged again as the words come in', () => {
  it('"Um." has no words at its commit: asked for at once, taken back when they come in, asked again when the wait is up', async () => {
    const s = setup();
    await says(s, 'c1', 300);
    expect(creates(s)).toEqual([CREATE]);
    created(s);
    await at(120);
    heard(s, 'c1', ' Um');
    expect(cancels(s)).toHaveLength(1);
    s.openai.msg(done('cancelled', line('m1', 'Take your')));
    expect(deletes(s)).toEqual([{ type: 'conversation.item.delete', item_id: 'm1' }]); // never heard: forgotten
    heard(s, 'c1', ','); // more of the same line: one cancel is enough
    await at(579);
    expect(creates(s)).toEqual([CREATE]);
    await at(1);
    expect(creates(s)).toEqual([CREATE, CREATE]); // 700 ms after the commit, not after the words
    expect(cancels(s)).toHaveLength(1);
  });

  it('taken back before OpenAI has created the response: it is cancelled the moment it exists', async () => {
    const s = setup();
    await says(s, 'c1', 300);
    await at(60);
    heard(s, 'c1', ' Um');
    expect(cancels(s)).toEqual([]);
    created(s);
    expect(cancels(s)).toHaveLength(1);
    s.openai.msg(done('cancelled'));
    await at(640);
    expect(creates(s)).toEqual([CREATE, CREATE]);
  });

  it('"Um, yes.": taken back at "Um", and asked again as soon as the rest is in', async () => {
    const s = setup();
    await says(s, 'c1', 900);
    created(s);
    await at(130);
    heard(s, 'c1', ' Um,');
    expect(cancels(s)).toHaveLength(1);
    await at(170);
    heard(s, 'c1', ' yes.');
    expect(creates(s)).toEqual([CREATE]); // the one taken back has not ended yet
    s.openai.msg(done('cancelled'));
    expect(creates(s)).toEqual([CREATE, CREATE]);
    await at(2000);
    expect(creates(s)).toEqual([CREATE, CREATE]);
  });

  it('words that come in once the agent is heard change nothing', async () => {
    const s = setup();
    await says(s, 'c1', 300);
    created(s);
    s.openai.msg({ type: 'response.output_audio.delta', item_id: 'a1', delta: audio(200) });
    heard(s, 'c1', ' Um');
    expect(cancels(s)).toEqual([]);
    await at(2000);
    expect(creates(s)).toEqual([CREATE]);
  });

  it("nor do they take back the agent's next response, once its answer was heard", async () => {
    const s = setup();
    await says(s, 'c1', 300);
    created(s);
    s.openai.msg({ type: 'response.output_audio.delta', item_id: 'a1', delta: audio(100) });
    s.openai.msg({ type: 'response.output_audio.done' });
    s.openai.msg(done('completed', fnCall('schedule_callback', 't1'))); // "One sec." and a tool: a follow-up comes next
    await at(0);
    expect(creates(s)).toEqual([CREATE, CREATE]);
    heard(s, 'c1', ' Um');
    created(s);
    expect(cancels(s)).toEqual([]);
  });

  it('a line cut short on a joining word at its commit, that turns out whole: answered as soon as the rest is in', async () => {
    const s = setup();
    await says(s, 'c1', 1200, ' We could do Tuesday or');
    expect(creates(s)).toEqual([]);
    await at(100);
    heard(s, 'c1', ' Wednesday.');
    expect(creates(s)).toEqual([CREATE]);
    await at(2000);
    expect(creates(s)).toEqual([CREATE]);
  });

  it('a line cut short after "the" is not a caller trailing off: no wait', async () => {
    const s = setup();
    await says(s, 'c1', 1500, ' Yeah, I have tenants in the');
    expect(creates(s)).toEqual([CREATE]);
    created(s);
    heard(s, 'c1', ' property.');
    expect(cancels(s)).toEqual([]);
  });

  it('a long turn whose late words trail off waits the hesitant time, from its commit', async () => {
    const s = setup();
    await says(s, 'c1', 3000, ' I was going to sell it');
    await at(100);
    heard(s, 'c1', ' but');
    await at(150);
    expect(creates(s)).toEqual([]); // the long-turn wait would have ended here
    await at(449);
    expect(creates(s)).toEqual([]);
    await at(1);
    expect(creates(s)).toEqual([CREATE]);
  });

  it('a long turn already asked for, whose words then trail off: taken back for the rest of the hesitant time', async () => {
    const s = setup();
    await says(s, 'c1', 3000, ' I was going to sell it');
    await at(250);
    expect(creates(s)).toEqual([CREATE]);
    created(s);
    await at(50);
    heard(s, 'c1', ' but');
    expect(cancels(s)).toHaveLength(1);
    s.openai.msg(done('cancelled'));
    await at(399);
    expect(creates(s)).toEqual([CREATE]);
    await at(1);
    expect(creates(s)).toEqual([CREATE, CREATE]);
  });

  it("the final transcript counts like any other words, and another line's words do not", async () => {
    const s = setup();
    await says(s, 'c1', 300);
    created(s);
    heard(s, 'c0', ' Um'); // an earlier line's late words
    expect(cancels(s)).toEqual([]);
    s.openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'c1', content_index: 0, transcript: 'Um,' });
    expect(cancels(s)).toHaveLength(1);
  });

  it('they go on talking after an answer was taken back: one answer, after they finish', async () => {
    const s = setup();
    await says(s, 'c1', 300);
    created(s);
    heard(s, 'c1', ' Um');
    s.openai.msg(done('cancelled'));
    await at(200);
    await says(s, 'c2', 500, ' Tuesday works.');
    expect(creates(s)).toEqual([CREATE, CREATE]);
    await at(2000);
    expect(creates(s)).toEqual([CREATE, CREATE]);
  });
});

describe('a turn waiting out its patience is still a turn', () => {
  it('a dropped response ending during the wait does not lose the turn: its timing line is logged, held by patience', async () => {
    const s = setup();
    agentSays(s, 'a0');
    await says(s, 'c1', 1200, ' I want to see what I can get for it');
    created(s);
    await says(s, 'c2', 1200, ' and then I will decide.'); // the first answer is dropped; 2.4 s of talk: the answer waits
    await at(100);
    s.openai.msg(done('cancelled')); // the dropped answer ends inside the wait
    await at(150);
    expect(creates(s)).toEqual([CREATE, CREATE]);
    agentSays(s, 'a1');
    expect(timingLines(s)).toEqual([expect.objectContaining({ deferred: 'patience', requestedMs: 250 })]);
  });

  it('an answer taken back shows in its timing line: held by patience, two responses', async () => {
    const s = setup();
    agentSays(s, 'a0');
    await says(s, 'c1', 300);
    created(s);
    await at(120);
    heard(s, 'c1', ' Um');
    s.openai.msg(done('cancelled'));
    await at(580);
    agentSays(s, 'a1');
    expect(timingLines(s)).toEqual([expect.objectContaining({ deferred: 'patience', requestedMs: 0, responses: 2 })]);
  });

  it('with a separate voice (ElevenLabs): a reply OpenAI finished writing ends inside the take-back, and the turn is still timed', async () => {
    const raw = new FakeSocket();
    let voice: TtsEvents | null = null;
    const tts = { speak: vi.fn(), finish: vi.fn(), cancel: vi.fn(), close: vi.fn() };
    const wrapped = withExternalVoice(raw, (events) => ((voice = events), tts), silentLog);
    const s = { ...setup({ openai: wrapped }), openai: raw };
    raw.msg(READY);
    /** OpenAI writes a whole line; the voice layer holds its done until the voice has spoken it. */
    const writes = (id: string, item: string, text: string) => {
      raw.msg({ type: 'response.created', response: { id } });
      raw.msg({ type: 'response.output_text.delta', response_id: id, item_id: item, delta: text });
      raw.msg({ type: 'response.output_text.done', response_id: id, item_id: item, text });
      raw.msg({ type: 'response.done', response: { id, status: 'completed', output: [line(item, text)] } });
    };
    const speaks = (item: string) => {
      voice?.audio(item, audio(200));
      voice?.done(item);
      for (const m of s.twilio.history.filter((x) => x.event === 'mark')) s.twilio.msg({ event: 'mark', streamSid: SID, mark: m.mark });
    };
    writes('r0', 'a0', 'Thanks for calling.');
    speaks('a0');
    raw.clearSent();
    await says(s, 'c1', 300);
    expect(creates(s)).toEqual([CREATE]);
    writes('r1', 'm1', 'What is the address?'); // written, not yet spoken: its done is held
    await at(120);
    heard(s, 'c1', ' Um');
    expect(tts.cancel).toHaveBeenCalledWith('m1');
    expect(cancels(s)).toEqual([]); // OpenAI had ended it: the layer released its done inside the cancel
    expect(deletes(s)).toEqual([{ type: 'conversation.item.delete', item_id: 'm1' }]);
    await at(580);
    expect(creates(s)).toEqual([CREATE, CREATE]);
    writes('r2', 'a1', 'Take your time.');
    speaks('a1');
    expect(timingLines(s)).toEqual([expect.objectContaining({ deferred: 'patience', requestedMs: 0, responses: 2 })]);
  });

  it('a reply taken back that carried a tool call: the tool runs, and its follow-up is the answer when the wait is up', async () => {
    const s = setup();
    await says(s, 'c1', 300);
    created(s);
    await at(120);
    heard(s, 'c1', ' Um');
    s.openai.msg(done('cancelled', fnCall('schedule_callback', 't1')));
    await at(0);
    expect(s.hooks.onTool).toHaveBeenCalledTimes(1);
    await at(579);
    expect(creates(s)).toEqual([CREATE]);
    await at(1);
    expect(creates(s)).toEqual([CREATE, CREATE]);
  });

  it('a wait_for_user batch that ends during the wait does not put the call on hold: one answer, and the next check-in at 8 s', async () => {
    let release: (r: ToolResult) => void = () => {};
    const onTool = vi.fn(() => new Promise<ToolResult>((resolve) => (release = resolve)));
    const s = setup({}, onTool);
    agentSays(s, 'a0');
    await says(s, 'c1', 400, ' Hang on.');
    created(s);
    // The bridge answers wait_for_user itself; the note save beside it is what keeps the batch running.
    s.openai.msg(done('completed', fnCall('save_qualification', 't1'), fnCall('wait_for_user', 'w1')));
    await at(0);
    expect(onTool).toHaveBeenCalledTimes(1);
    await says(s, 'c2', 2500, ' Okay, sorry about that, I am back now.'); // a long turn: the answer waits
    await at(100);
    release({ output: '{"ok":true}' });
    await at(0); // the batch ends inside the wait
    expect(creates(s)).toEqual([CREATE]);
    await at(150);
    expect(creates(s)).toEqual([CREATE, CREATE]);
    agentSays(s, 'a1');
    s.openai.clearSent();
    await at(7999);
    expect(creates(s)).toEqual([]);
    await at(1);
    expect(creates(s)).toEqual([CREATE]); // the 8 s check-in, not the 30 s of a hold
  });
});
