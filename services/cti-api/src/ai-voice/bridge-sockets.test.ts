import { describe, expect, it, vi } from 'vitest';
import { BridgeSockets, type BridgeSocket } from './bridge-sockets.js';

/** A ws-like socket that records what is sent and how often it is closed. */
function socket(readyState = 1) {
  const sent: string[] = [];
  const s = {
    readyState,
    closes: 0,
    sent,
    send: (d: string) => sent.push(d),
    close: () => {
      s.closes += 1;
    },
    on: () => undefined,
  };
  return s;
}

function setup(openaiState = 1) {
  const twilio = socket();
  const openai = socket(openaiState);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sockets = new BridgeSockets(twilio as BridgeSocket, openai as BridgeSocket, log);
  return { twilio, openai, log, sockets };
}

describe('BridgeSockets', () => {
  it('queues OpenAI messages until started, then sends the first message ahead of them', () => {
    const { openai, sockets } = setup();
    sockets.sendOpenAi({ type: 'input_audio_buffer.append', audio: 'AAAA' }, true);
    expect(openai.sent).toEqual([]);
    expect(sockets.started).toBe(false);
    sockets.start({ type: 'session.update' });
    expect(sockets.started).toBe(true);
    expect(openai.sent).toEqual([]); // from the next flush
    sockets.flush();
    expect(openai.sent.map((d) => JSON.parse(d).type)).toEqual(['session.update', 'input_audio_buffer.append']);
    sockets.sendOpenAi({ type: 'response.create' });
    expect(JSON.parse(openai.sent[2] as string)).toEqual({ type: 'response.create' });
  });

  it('queues while the OpenAI socket is connecting and sends on flush once it is open', () => {
    const { openai, sockets } = setup(0);
    sockets.start({ type: 'session.update' });
    sockets.sendOpenAi({ type: 'response.create' });
    sockets.flush();
    expect(sockets.openAiOpen).toBe(false);
    expect(openai.sent).toEqual([]);
    openai.readyState = 1;
    expect(sockets.openAiOpen).toBe(true);
    sockets.flush();
    expect(openai.sent.map((d) => JSON.parse(d).type)).toEqual(['session.update', 'response.create']);
  });

  it('drops OpenAI messages once that socket is closing', () => {
    const { openai, sockets } = setup();
    sockets.start({ type: 'session.update' });
    openai.readyState = 2;
    sockets.sendOpenAi({ type: 'response.create' });
    openai.readyState = 1;
    sockets.flush();
    expect(openai.sent.map((d) => JSON.parse(d).type)).toEqual(['session.update']);
  });

  it('sends Twilio frames only while that socket is open and not stopped', () => {
    const { twilio, sockets } = setup();
    sockets.sendTwilio({ event: 'clear' });
    twilio.readyState = 3;
    sockets.sendTwilio({ event: 'clear' });
    expect(twilio.sent).toEqual(['{"event":"clear"}']);
  });

  it('logs an unparseable frame by its source only', () => {
    const { log, sockets } = setup();
    expect(sockets.parse('not json SECRET', 'twilio')).toBeNull();
    expect(log.warn).toHaveBeenCalledWith({ source: 'twilio' }, 'ai-voice bridge: unparseable frame');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('SECRET');
    expect(sockets.parse('{"event":"media"}', 'openai')).toEqual({ event: 'media' });
  });

  it('closes both sockets once, drops what is queued, and sends nothing after', () => {
    const { twilio, openai, sockets } = setup(0);
    sockets.start({ type: 'session.update' });
    sockets.sendOpenAi({ type: 'response.create' });
    sockets.close();
    sockets.close();
    expect(sockets.stopped).toBe(true);
    expect([twilio.closes, openai.closes]).toEqual([1, 1]);
    openai.readyState = 1;
    sockets.flush();
    sockets.sendOpenAi({ type: 'response.create' });
    sockets.sendTwilio({ event: 'clear' });
    expect(openai.sent).toEqual([]);
    expect(twilio.sent).toEqual([]);
  });

  it('a socket that throws on close is logged, and the other is still closed', () => {
    const { twilio, openai, log, sockets } = setup();
    twilio.close = () => {
      throw new Error('boom');
    };
    sockets.close();
    expect(log.warn).toHaveBeenCalledWith({ err: 'boom' }, 'ai-voice bridge: socket close failed');
    expect(openai.closes).toBe(1);
  });
});
