/**
 * Adapts a real `ws` WebSocket to the bridge's `BridgeSocket`: messages are
 * delivered as strings (ws hands over a Buffer, an ArrayBuffer, or — for a
 * fragmented message — an array of Buffers), and the OpenAI Realtime socket
 * is opened with `ws` directly (no SDK, no beta header).
 */
import WebSocket from 'ws';
import type { BridgeSocket } from './bridge.js';

export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export function rawDataToString(d: WebSocket.RawData): string {
  if (Array.isArray(d)) return Buffer.concat(d).toString('utf8');
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
  return d.toString('utf8');
}

export function wsToBridgeSocket(ws: WebSocket): BridgeSocket {
  function on(ev: 'message', cb: (d: string) => void): void;
  function on(ev: 'close', cb: () => void): void;
  function on(ev: 'error', cb: (e: Error) => void): void;
  function on(ev: 'open', cb: () => void): void;
  function on(ev: 'message' | 'close' | 'error' | 'open', cb: (...a: never[]) => void): void {
    const fn = cb as (...a: unknown[]) => void;
    if (ev === 'message') ws.on('message', (d: WebSocket.RawData) => fn(rawDataToString(d)));
    else if (ev === 'close') ws.on('close', () => fn());
    else if (ev === 'error') ws.on('error', (e: Error) => fn(e));
    else ws.on('open', () => fn());
  }
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    on,
    get readyState() {
      return ws.readyState;
    },
  };
}

export function realtimeUrl(model: string): string {
  return `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`;
}

/** Open the OpenAI Realtime socket. Errors surface as the socket's `error`/`close` events. */
export function openRealtime(url: string, apiKey: string): BridgeSocket {
  return wsToBridgeSocket(new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } }));
}
