/**
 * An external voice (ElevenLabs) for an AI call, as a layer around the OpenAI Realtime socket (spec
 * 2026-10-19-ai-voice-elevenlabs-design.md). The session answers in text; each text item is streamed to the voice and
 * the voice's audio reaches the bridge as `response.output_audio.delta`, so the bridge cannot tell the difference:
 * - a response's `response.done` is held until its audio has finished, then preceded by `response.output_audio.done`
 *   and `response.output_audio_transcript.done` (the order OpenAI uses), so the goodbye guard, the drain before
 *   hanging up, turn timing and the barge-in gate all see the voice's audio;
 * - a barge-in's `conversation.item.truncate` (OpenAI can't cut a text item) stops that item's voice instead, and a
 *   `response.cancel` after OpenAI has finished writing stops the voice and releases the held done;
 * - if the voice fails, the session goes back to OpenAI audio and everything passes through from then on.
 */
import type { BridgeLog } from './bridge.js';
import type { BridgeSocket } from './bridge-sockets.js';

/** One TTS connection for a call; a context per response item. */
export interface TtsStream {
  /** Add text to an item's speech (the context opens on first use). */
  speak(itemId: string, text: string): void;
  /** No more text for this item: speak what is buffered. */
  finish(itemId: string): void;
  /** Stop this item now: no more audio for it. */
  cancel(itemId: string): void;
  close(): void;
}

export interface TtsEvents {
  /** μ-law 8 kHz audio for an item, base64 (Twilio's media format). */
  audio(itemId: string, base64: string): void;
  /** The item's last audio has been sent. */
  done(itemId: string): void;
  /** The voice is unusable for the rest of the call. */
  failed(err: Error): void;
}

export type OpenTts = (events: TtsEvents) => TtsStream;

type Msg = Record<string, unknown>;
type ItemState = 'speaking' | 'finished' | 'done' | 'cancelled';

interface Item {
  responseId: string;
  text: string;
  state: ItemState;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Msg => (v !== null && typeof v === 'object' ? (v as Msg) : {});
const parse = (raw: string): Msg | null => {
  try {
    const m = JSON.parse(raw) as unknown;
    return m !== null && typeof m === 'object' ? (m as Msg) : null;
  } catch {
    return null;
  }
};
const pending = (i: Item): boolean => i.state === 'speaking' || i.state === 'finished';

export function withExternalVoice(openai: BridgeSocket, openTts: OpenTts, log: BridgeLog): BridgeSocket {
  const listeners: Array<(d: string) => void> = [];
  let items = new Map<string, Item>();
  /** response id → its held `response.done` frame. */
  let held = new Map<string, string>();
  let latestResponseId = '';
  let failed = false;

  const deliver = (raw: string): void => {
    for (const cb of listeners) cb(raw);
  };
  const emit = (m: Msg): void => deliver(JSON.stringify(m));

  /** Each item of a response gets its audio done and transcript once, then the response's held done (if any) goes. */
  const release = (responseId: string): void => {
    const own = [...items].filter(([, i]) => i.responseId === responseId);
    if (own.some(([, i]) => pending(i))) return;
    for (const [itemId, item] of own) {
      emit({ type: 'response.output_audio.done', response_id: responseId, item_id: itemId });
      emit({ type: 'response.output_audio_transcript.done', response_id: responseId, item_id: itemId, transcript: item.text });
    }
    items = new Map([...items].filter(([, i]) => i.responseId !== responseId));
    const done = held.get(responseId);
    if (done === undefined) return;
    held = new Map([...held].filter(([id]) => id !== responseId));
    deliver(done);
  };

  const setState = (itemId: string, state: ItemState): Item | null => {
    const item = items.get(itemId);
    if (!item) return null;
    items = new Map([...items, [itemId, { ...item, state }]]);
    return item;
  };

  const stopResponse = (responseId: string): void => {
    for (const [itemId, item] of items) {
      if (item.responseId !== responseId || !pending(item)) continue;
      tts.cancel(itemId);
      setState(itemId, 'cancelled');
    }
  };

  const fail = (err: Error): void => {
    if (failed) return;
    failed = true;
    log.warn({ err: err.message }, 'ai-voice: the external voice failed — the call carries on in the OpenAI voice');
    openai.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'] } }));
    for (const [itemId, item] of items) if (pending(item)) setState(itemId, 'done');
    for (const responseId of new Set([...items.values()].map((i) => i.responseId).concat([...held.keys()]))) release(responseId);
  };

  const tts = openTts({
    audio(itemId, base64) {
      const item = items.get(itemId);
      if (failed || !item || !pending(item)) return;
      emit({ type: 'response.output_audio.delta', response_id: item.responseId, item_id: itemId, delta: base64 });
    },
    done(itemId) {
      const item = setState(itemId, 'done');
      if (item) release(item.responseId);
    },
    failed: fail,
  });

  /** OpenAI → bridge. */
  openai.on('message', (raw) => {
    const m = failed ? null : parse(raw);
    if (!m) return deliver(raw);
    switch (m.type) {
      case 'response.created':
        latestResponseId = str(obj(m.response).id);
        return deliver(raw);
      case 'response.output_text.delta': {
        const itemId = str(m.item_id);
        const item = items.get(itemId) ?? { responseId: str(m.response_id), text: '', state: 'speaking' as const };
        if (!pending(item)) return;
        items = new Map([...items, [itemId, { ...item, text: item.text + str(m.delta) }]]);
        tts.speak(itemId, str(m.delta));
        return;
      }
      case 'response.output_text.done': {
        const itemId = str(m.item_id);
        const item = items.get(itemId);
        if (!item || !pending(item)) return;
        items = new Map([...items, [itemId, { ...item, text: str(m.text) || item.text, state: 'finished' }]]);
        tts.finish(itemId);
        return;
      }
      case 'response.done': {
        const responseId = str(obj(m.response).id);
        held = new Map([...held, [responseId, raw]]);
        return release(responseId);
      }
      default:
        return deliver(raw);
    }
  });

  /** Bridge → OpenAI. */
  const send = (raw: string): void => {
    const m = failed ? null : parse(raw);
    if (!m) return openai.send(raw);
    if (m.type === 'session.update') {
      return openai.send(JSON.stringify({ ...m, session: { ...obj(m.session), output_modalities: ['text'] } }));
    }
    if (m.type === 'conversation.item.truncate') {
      const itemId = str(m.item_id);
      const item = items.get(itemId);
      if (item && pending(item)) {
        tts.cancel(itemId);
        setState(itemId, 'cancelled');
        release(item.responseId);
      }
      return; // a text item can't be truncated; the voice is what stops
    }
    if (m.type === 'response.cancel' && held.has(latestResponseId)) {
      stopResponse(latestResponseId); // OpenAI has finished writing: only the voice is still going
      return release(latestResponseId);
    }
    if (m.type === 'response.cancel') stopResponse(latestResponseId);
    return openai.send(raw);
  };

  function on(ev: 'message', cb: (d: string) => void): void;
  function on(ev: 'close', cb: () => void): void;
  function on(ev: 'error', cb: (e: Error) => void): void;
  function on(ev: 'open', cb: () => void): void;
  function on(ev: 'message' | 'close' | 'error' | 'open', cb: (...a: never[]) => void): void {
    if (ev === 'message') listeners.push(cb as (d: string) => void);
    else openai.on(ev as 'close', cb as () => void);
  }

  return {
    send,
    close: (code, reason) => {
      tts.close();
      openai.close(code, reason);
    },
    on,
    get readyState() {
      return openai.readyState;
    },
  };
}
