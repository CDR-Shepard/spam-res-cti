/**
 * The bridge's two sockets (Twilio Media Streams and OpenAI Realtime), injected and ws-like.
 * Twilio frames go out at once while the stream is open. OpenAI messages queue (bounded,
 * bridge-outbox.ts) until the bridge has started and the socket is open, so `session.update`
 * always goes first; once that socket is closing they are dropped. `close()` closes both,
 * once. Frames that are not JSON are logged by source only — never their contents.
 */
import { parseFrame, type Msg } from './bridge-frames.js';
import { Outbox } from './bridge-outbox.js';
import { errText, type BridgeLog } from './bridge-tools.js';

/** ws readyState OPEN. */
const WS_OPEN = 1;

export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(ev: 'message', cb: (d: string) => void): void;
  on(ev: 'close', cb: () => void): void;
  on(ev: 'error', cb: (e: Error) => void): void;
  on(ev: 'open', cb: () => void): void;
  /** ws semantics: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  readonly readyState: number;
}

export class BridgeSockets {
  private readonly outbox: Outbox;
  private isStarted = false;
  private isStopped = false;

  constructor(
    private readonly twilio: BridgeSocket,
    private readonly openai: BridgeSocket,
    private readonly log: BridgeLog,
  ) {
    this.outbox = new Outbox(() =>
      log.warn({ queued: 'full' }, 'ai-voice bridge: openai outbox full, dropping oldest caller audio'),
    );
  }

  /** `start()` was called: OpenAI messages may flow (once the socket is open). */
  get started(): boolean {
    return this.isStarted;
  }

  /** `close()` was called: nothing is sent any more. */
  get stopped(): boolean {
    return this.isStopped;
  }

  /** The OpenAI socket is open. */
  get openAiOpen(): boolean {
    return this.openai.readyState === WS_OPEN;
  }

  /** Put `first` (the session.update) ahead of everything queued; OpenAI messages go out from the next flush. */
  start(first: object): void {
    this.isStarted = true;
    this.outbox.prepend(JSON.stringify(first));
  }

  parse(raw: unknown, source: 'twilio' | 'openai'): Msg | null {
    const msg = parseFrame(raw);
    if (!msg) this.log.warn({ source }, 'ai-voice bridge: unparseable frame');
    return msg;
  }

  sendTwilio(m: object): void {
    if (this.isStopped || this.twilio.readyState !== WS_OPEN) return;
    this.twilio.send(JSON.stringify(m));
  }

  /** Queue until started and open; drop once the OpenAI socket is closing/closed. */
  sendOpenAi(m: object, droppable = false): void {
    if (this.isStopped || this.openai.readyState > WS_OPEN) return;
    const data = JSON.stringify(m);
    if (!this.isStarted || this.openai.readyState !== WS_OPEN) {
      this.outbox.push(data, droppable);
      return;
    }
    this.flush();
    this.openai.send(data);
  }

  flush(): void {
    if (!this.isStarted || this.isStopped || this.openai.readyState !== WS_OPEN) return;
    for (const m of this.outbox.drain()) this.openai.send(m);
  }

  /** Close both sockets, once; whatever is still queued for OpenAI is dropped. */
  close(): void {
    if (this.isStopped) return;
    this.isStopped = true;
    this.outbox.clear();
    for (const s of [this.twilio, this.openai]) {
      try {
        s.close();
      } catch (e) {
        this.log.warn({ err: errText(e) }, 'ai-voice bridge: socket close failed');
      }
    }
  }
}
