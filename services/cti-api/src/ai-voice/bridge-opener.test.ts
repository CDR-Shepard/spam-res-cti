/**
 * BridgeOptions.opener (plan 2026-10-16 inbound agent testing): an inbound call opens with INBOUND_OPENER — its own
 * words, after 300 ms instead of OPENER_DELAY_MS — and everything else about the opener holds: the caller speaking
 * first cancels it, and the gate never cuts it. A bridge given no opener behaves exactly as before (bridge.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCallBridge, OPENER_DELAY_MS, type BridgeOptions, type BridgeSocket } from './bridge.js';
import { INBOUND_OPENER, OPENER_PROMPT } from './bridge-session.js';
import { INBOUND_TOOLS } from './prompt-tools.js';

type Ev = 'message' | 'close' | 'error' | 'open';

class FakeSocket implements BridgeSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly history: Array<Record<string, unknown>> = [];
  private readonly handlers: Record<Ev, Array<(a: unknown) => void>> = { message: [], close: [], error: [], open: [] };
  send(data: string): void {
    const m = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(m);
    this.history.push(m);
  }
  close(): void {
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
  msg(o: object): void {
    this.emit('message', JSON.stringify(o));
  }
  clearSent(): void {
    this.sent.length = 0;
  }
}

const SID = 'MZ0000';
const READY = { type: 'session.updated', session: {} };
const audio = (ms: number): string => Buffer.alloc(ms * 8).toString('base64');
const openerSaying = (text: string) => ({
  type: 'conversation.item.create',
  item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

function setup(over: Partial<BridgeOptions> = {}) {
  const twilio = new FakeSocket();
  const openai = new FakeSocket();
  const hooks = { onTool: vi.fn(async () => ({ output: '{"ok":true}' })), onTranscript: vi.fn(), onEnd: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  const bridge = new AiCallBridge(
    {
      twilio, openai, streamSid: SID, instructions: 'INBOUND', tools: INBOUND_TOOLS, voice: 'marin', model: 'gpt-realtime-2.1',
      reasoningEffort: 'low', vadEagerness: 'auto', maxCallMs: 600_000, opener: INBOUND_OPENER, ...over,
    },
    hooks,
  );
  bridge.start();
  openai.clearSent();
  return { twilio, openai, bridge };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the inbound opener', () => {
  it('answers 300 ms after the session is ready, with the inbound words', async () => {
    const { openai } = setup();
    openai.msg(READY);
    await vi.advanceTimersByTimeAsync(INBOUND_OPENER.delayMs - 1);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent).toEqual([openerSaying(INBOUND_OPENER.prompt), { type: 'response.create' }]);
    expect(INBOUND_OPENER.prompt).not.toBe(OPENER_PROMPT);
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS);
    expect(openai.sent).toHaveLength(2); // once
  });

  it('a caller who speaks first cancels it: their turn is answered instead', async () => {
    const { openai } = setup();
    openai.msg(READY);
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 1 });
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS);
    expect(openai.sent.some((m) => m.type === 'conversation.item.create')).toBe(false);
  });

  it('gate mode never cuts it, however long the caller talks over it', async () => {
    const { twilio, openai } = setup({ bargeIn: 'gate', transcribeModel: 'gpt-live-transcribe' });
    openai.msg(READY);
    twilio.msg({ event: 'media', streamSid: SID, sequenceNumber: '3', media: { track: 'inbound', chunk: '1', timestamp: '100', payload: 'AAAA' } });
    await vi.advanceTimersByTimeAsync(INBOUND_OPENER.delayMs);
    expect(openai.sent.find((m) => m.type === 'conversation.item.create')).toEqual(openerSaying(INBOUND_OPENER.prompt));
    openai.msg({ type: 'response.created' });
    openai.msg({ type: 'response.output_audio.delta', item_id: 'item_0', delta: audio(4000) });
    twilio.sent.length = 0;
    openai.msg({ type: 'input_audio_buffer.speech_started', item_id: 'c1', audio_start_ms: 1500 });
    openai.msg({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'c1', content_index: 0, delta: ' Hi is this the house buyer' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(openai.sent.some((m) => m.type === 'response.cancel')).toBe(false);
  });

  it('a bridge with no opener option still waits OPENER_DELAY_MS and says OPENER_PROMPT', async () => {
    const { openai } = setup({ opener: undefined });
    openai.msg(READY);
    await vi.advanceTimersByTimeAsync(OPENER_DELAY_MS - 1);
    expect(openai.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openai.sent[0]).toEqual(openerSaying(OPENER_PROMPT));
  });
});
