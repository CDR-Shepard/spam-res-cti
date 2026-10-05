import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { rawDataToString, realtimeUrl, wsToBridgeSocket } from './ws-adapter.js';

describe('ws adapter', () => {
  it('turns every ws RawData shape into the frame string', () => {
    expect(rawDataToString(Buffer.from('{"a":1}'))).toBe('{"a":1}');
    expect(rawDataToString([Buffer.from('{"a"'), Buffer.from(':1}')])).toBe('{"a":1}');
    expect(rawDataToString(new Uint8Array(Buffer.from('hi')).buffer)).toBe('hi');
  });

  it('delivers messages as strings and maps open/close/error/send/readyState', () => {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn() });
    const s = wsToBridgeSocket(ws as unknown as WebSocket);
    const got: unknown[] = [];
    s.on('message', (d) => got.push(d));
    s.on('open', () => got.push('open'));
    s.on('close', () => got.push('close'));
    s.on('error', (e) => got.push(e.message));
    ws.emit('open');
    ws.emit('message', Buffer.from('{"event":"media"}'), false);
    ws.emit('error', new Error('boom'));
    ws.emit('close', 1000, Buffer.from(''));
    expect(got).toEqual(['open', '{"event":"media"}', 'boom', 'close']);
    s.send('x');
    s.close();
    expect(ws.send).toHaveBeenCalledWith('x');
    expect(ws.close).toHaveBeenCalled();
    expect(s.readyState).toBe(1);
    ws.readyState = 3;
    expect(s.readyState).toBe(3);
  });

  it('names the model in the Realtime URL', () => {
    expect(realtimeUrl('gpt-realtime-2.1')).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1');
  });
});
