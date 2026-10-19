/**
 * What both ElevenLabs voice clients share (spec 2026-10-19-ai-voice-elevenlabs-design.md): the call's socket
 * (`openTtsConnection`) and how written text is cut into sentences to speak (`splitPhrases`). The multi-context
 * text-to-speech socket (elevenlabs-tts.ts) serves the v2 models; the text-to-dialogue socket (elevenlabs-dialogue.ts)
 * serves v3/v4 (eleven_v4_turbo, the owner's ear test).
 */
import WebSocket from 'ws';
import type { BridgeLog } from './bridge-tools.js';
import { rawDataToString } from './ws-adapter.js';

/** A finished line with no end marker by then fails the voice, so a call never waits on a silent one. */
export const ELEVENLABS_FINAL_TIMEOUT_MS = 10_000;
export const ELEVENLABS_WS = 'wss://api.elevenlabs.io/v1';
/** Twilio's media format, so the audio goes to the call untouched. */
export const OUTPUT_FORMAT = 'ulaw_8000';
const WS_OPEN = 1;

/** A sentence end: . ! or ? (with closing quotes or brackets) and then a space. */
const SENTENCE_END = /[.!?]["'”’)]*\s+/g;
/** Not the end of a sentence: a title or street abbreviation, or a spoken pause ("six one nine... five five five"). */
const NOT_A_SENTENCE_END = /(?:(?<![\p{L}])(?:mr|mrs|ms|dr|st|ave|blvd|rd|jr|sr|vs)\.|\.\.\.|…)$/iu;

/** Text with something to say: a letter or a digit (an emoji or punctuation alone may never come back as audio). */
export const speakable = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/** Whole sentences ready to speak, and the text still being written; a sentence with nothing to say goes with the next. */
export function splitPhrases(buffer: string): { phrases: string[]; rest: string } {
  const phrases: string[] = [];
  let start = 0;
  for (const m of buffer.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].trimEnd().length;
    const phrase = buffer.slice(start, end);
    if (NOT_A_SENTENCE_END.test(phrase) || !speakable(phrase)) continue;
    phrases.push(phrase.trim());
    start = m.index + m[0].length;
  }
  return { phrases, rest: buffer.slice(start) };
}

export interface ElevenLabsSettings {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

/** The part of a `ws` socket the clients use (the close carries its code and reason, which say why a key was refused). */
export interface TtsSocket {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
  on(ev: 'open', cb: () => void): void;
  on(ev: 'message', cb: (data: string) => void): void;
  on(ev: 'close', cb: (code: number, reason: string) => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
}

export type ConnectTts = (url: string, headers: Record<string, string>) => TtsSocket;

export function connectWs(url: string, headers: Record<string, string>): TtsSocket {
  const ws = new WebSocket(url, { headers });
  function on(ev: 'open', cb: () => void): void;
  function on(ev: 'message', cb: (data: string) => void): void;
  function on(ev: 'close', cb: (code: number, reason: string) => void): void;
  function on(ev: 'error', cb: (err: Error) => void): void;
  function on(ev: 'open' | 'message' | 'close' | 'error', cb: (...a: never[]) => void): void {
    const fn = cb as (...a: unknown[]) => void;
    if (ev === 'message') ws.on('message', (d: WebSocket.RawData) => fn(rawDataToString(d)));
    else if (ev === 'close') ws.on('close', (code: number, reason: Buffer) => fn(code, reason.toString('utf8')));
    else if (ev === 'error') ws.on('error', (e: Error) => fn(e));
    else ws.on('open', () => fn());
  }
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on,
    get readyState() {
      return ws.readyState;
    },
  };
}

export interface TtsConnection {
  /** Sent at once if the socket is open, else when it opens (a closed idle socket is reopened first). */
  send(m: object): void;
  /** The voice is unusable: reported once (onFail), and nothing more is sent or received. */
  fail(message: string): void;
  /** Ends the connection for good; `goodbye` is sent first if the socket is open. */
  close(goodbye?: object): void;
}

export interface TtsConnectionOptions {
  url: string;
  apiKey: string;
  log: BridgeLog;
  connect: ConnectTts;
  /** Sent first on every new socket (the dialogue socket's voice list). */
  hello?: object;
  /** Sent this often while the socket is open, so the server keeps it (the dialogue socket closes after 20 s idle). */
  keepAlive?: { everyMs: number; message: object };
  /** A line is still coming: a close now loses it (a failure); otherwise an idle close reopens on the next send. */
  busy(): boolean;
  /** A message from the server, parsed. */
  onMessage(m: Record<string, unknown>): void;
  onFail(message: string): void;
}

/** One ElevenLabs socket for a call, opened at once so the first line has no connect delay. */
export function openTtsConnection(o: TtsConnectionOptions): TtsConnection {
  let socket: TtsSocket | null = null;
  let queue: string[] = [];
  let ended = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stopKeepAlive = (): void => {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
  };

  const fail = (message: string): void => {
    if (ended) return;
    ended = true;
    stopKeepAlive();
    socket?.close();
    o.onFail(message);
  };

  const sendNow = (sock: TtsSocket, raw: string): void => {
    try {
      sock.send(raw);
    } catch (err) {
      fail(`ElevenLabs send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onRaw = (raw: string): void => {
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      o.log.warn({}, 'ai-voice: ElevenLabs sent a frame that is not JSON');
      return;
    }
    if (m !== null && typeof m === 'object') o.onMessage(m as Record<string, unknown>);
  };

  const open = (): TtsSocket => {
    stopKeepAlive();
    const sock = o.connect(o.url, { 'xi-api-key': o.apiKey });
    const startedAt = Date.now();
    let opened = false;
    socket = sock;
    queue = o.hello ? [JSON.stringify(o.hello)] : [];
    const current = (): boolean => socket === sock && !ended;
    sock.on('open', () => {
      if (!current()) return;
      opened = true;
      o.log.info({ ms: Date.now() - startedAt }, 'ai-voice: ElevenLabs voice connected');
      const pending = queue;
      queue = [];
      for (const raw of pending) sendNow(sock, raw);
      if (o.keepAlive && !ended) {
        const { everyMs, message } = o.keepAlive;
        keepAlive = setInterval(() => sendNow(sock, JSON.stringify(message)), everyMs);
      }
    });
    sock.on('message', (raw) => {
      if (current()) onRaw(raw);
    });
    sock.on('error', (err) => {
      if (current()) fail(`ElevenLabs socket error: ${err.message}`);
    });
    sock.on('close', (code, reason) => {
      if (!current()) return;
      stopKeepAlive();
      if (!opened || o.busy()) return fail(`ElevenLabs socket closed ${code}${reason ? ` ${reason}` : ''}`);
      socket = null; // idle close: the next line reopens
    });
    return sock;
  };
  open();

  return {
    send(m) {
      if (ended) return;
      const raw = JSON.stringify(m);
      // Closing before its close event: what is still owed on it is lost (a failure); idle, a fresh socket takes over.
      if (socket && socket.readyState > WS_OPEN && o.busy()) return fail('ElevenLabs socket closing');
      const sock = socket && socket.readyState <= WS_OPEN ? socket : open();
      if (sock.readyState === WS_OPEN) sendNow(sock, raw);
      else queue = [...queue, raw];
    },
    fail,
    close(goodbye) {
      if (ended) return;
      ended = true;
      stopKeepAlive();
      if (goodbye && socket?.readyState === WS_OPEN) {
        try {
          socket.send(JSON.stringify(goodbye));
        } catch {
          // closing anyway
        }
      }
      socket?.close();
    },
  };
}
