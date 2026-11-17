import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCallBridge, type BridgeOptions, type BridgeSocket } from './bridge.js';
import { AI_CALL_TOOLS } from './prompt.js';
import { TRANSCRIPT_NOTES_RULE } from './transcript-note.js';

/**
 * The speech model mishears names the transcriber gets right (test calls 2026-11-16: it said "Everett", the transcript
 * had "Evan"), and it never sees the transcript. With transcriptNotes on, each caller line's final transcript goes into
 * the conversation as a hidden note right after that line, so later replies have the words in writing as well.
 */
const SID = 'MZ0000';
const READY = { type: 'session.updated', session: {} };

class FakeSocket implements BridgeSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  private readonly handlers: Record<'message' | 'close' | 'error' | 'open', Array<(a: unknown) => void>> = { message: [], close: [], error: [], open: [] };
  send(data: string): void {
    this.sent = [...this.sent, JSON.parse(data) as Record<string, unknown>];
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
}

function setup(over: Partial<BridgeOptions> = {}) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  const hooks = {
    onTool: vi.fn(async () => ({ output: '{"ok":true}' })),
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
      bargeIn: 'gate',
      turnDetection: 'server_vad',
      transcriptNotes: true,
      ...over,
    },
    hooks,
  );
  bridge.start();
  return { twilio, openai, hooks, bridge };
}
type Setup = ReturnType<typeof setup>;

const notes = (s: Setup) => s.openai.sent.filter((m) => m.type === 'conversation.item.create');
const creates = (s: Setup) => s.openai.sent.filter((m) => m.type === 'response.create');
const instructions = (s: Setup): string => (s.openai.sent.find((m) => m.type === 'session.update') as { session: { instructions: string } }).session.instructions;
const final = (s: Setup, id: string, transcript: string) =>
  s.openai.msg({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript });
const NOTE = (after: string, words: string, seq: number) => ({
  type: 'conversation.item.create',
  event_id: `ai-note-${seq}`,
  previous_item_id: after,
  item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(Written transcript of what they just said: "${words}")` }] },
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('transcript notes', () => {
  it("each caller line's final transcript is added right after that line, and the agent is told what the notes are", () => {
    const s = setup();
    s.openai.msg(READY);
    expect(instructions(s)).toBe(`INSTRUCTIONS\n\n${TRANSCRIPT_NOTES_RULE}`);
    final(s, 'c1', 'This is Evan.');
    final(s, 'c2', "It's forty-one twenty Maple.");
    expect(notes(s)).toEqual([NOTE('c1', 'This is Evan.', 1), NOTE('c2', "It's forty-one twenty Maple.", 2)]);
  });

  it('works the same in instant mode', () => {
    const s = setup({ bargeIn: 'instant', turnDetection: 'semantic_vad' });
    s.openai.msg(READY);
    final(s, 'c1', 'This is Evan.');
    expect(notes(s)).toEqual([NOTE('c1', 'This is Evan.', 1)]);
  });

  it('off (the default): no notes, and the instructions are as given', () => {
    const s = setup({ transcriptNotes: undefined });
    s.openai.msg(READY);
    final(s, 'c1', 'This is Evan.');
    expect(notes(s)).toEqual([]);
    expect(instructions(s)).toBe('INSTRUCTIONS');
  });

  it('a line with no words (transcription came back empty) gets none', () => {
    const s = setup();
    s.openai.msg(READY);
    final(s, 'c1', '  ');
    expect(notes(s)).toEqual([]);
  });

  it('none before the session is ready, and none once the call is closing or over', () => {
    const early = setup();
    final(early, 'c1', 'This is Evan.');
    expect(notes(early)).toEqual([]);

    const silenced = setup();
    silenced.openai.msg(READY);
    silenced.bridge.silence(); // a transfer or voicemail redirect: the conversation is over
    final(silenced, 'c1', 'This is Evan.');
    expect(notes(silenced)).toEqual([]);

    const over = setup();
    over.openai.msg(READY);
    over.bridge.stop();
    final(over, 'c1', 'This is Evan.');
    expect(notes(over)).toEqual([]);
  });

  it('a transcript that ends a patience wait: its note goes in before the answer is asked for, so that answer has it', () => {
    const s = setup({ silenceMs: 250, patience: { longTurnWaitMs: 250, hesitantWaitMs: 700 } });
    s.openai.msg(READY);
    s.openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 0 });
    s.openai.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'c1', content_index: 0, delta: ' Um,' });
    s.openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 400 });
    s.openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' });
    expect(creates(s)).toEqual([]); // "Um," trails off: the answer waits
    final(s, 'c1', "Um, it's Evan.");
    const order = s.openai.sent.map((m) => m.type).filter((t) => t === 'conversation.item.create' || t === 'response.create');
    expect(order).toEqual(['conversation.item.create', 'response.create']);
  });

  it('OpenAI rejecting a note is logged and changes nothing: the pending answer is still pending', () => {
    const s = setup();
    s.openai.msg(READY);
    s.openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 0 });
    s.openai.msg({ type: 'input_audio_buffer.speech_stopped', item_id: 'c1', audio_end_ms: 400 });
    s.openai.msg({ type: 'input_audio_buffer.committed', item_id: 'c1' });
    expect(creates(s)).toHaveLength(1);
    final(s, 'c1', 'This is Evan.');
    s.openai.msg({ type: 'error', error: { type: 'invalid_request_error', code: 'item_not_found', message: 'no such item', event_id: 'ai-note-1' } });
    expect(s.hooks.log.warn).toHaveBeenCalled();
    expect(creates(s)).toHaveLength(1); // not taken for a rejected response.create: no second one
    s.openai.msg({ type: 'error', error: { type: 'invalid_request_error', code: 'item_not_found', message: 'no such item' } }); // nor one that names no event
    expect(creates(s)).toHaveLength(1);
    s.openai.msg({ type: 'response.created' });
    s.openai.msg({ type: 'response.done', response: { status: 'completed', output: [] } });
    expect(creates(s)).toHaveLength(1);
  });
});
