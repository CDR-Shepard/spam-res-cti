/**
 * An external voice (ElevenLabs) for an AI call, as a layer around the OpenAI Realtime socket (spec
 * 2026-10-19-ai-voice-elevenlabs-design.md). The session answers in text; each text item is streamed to the voice and
 * the voice's audio reaches the bridge as `response.output_audio.delta`, so the bridge cannot tell the difference:
 * - a response's `response.done` is held until its audio has finished, then preceded by `response.output_audio.done`
 *   and `response.output_audio_transcript.done` (the order OpenAI uses), so the goodbye guard, the drain before
 *   hanging up, turn timing and the barge-in gate all see the voice's audio;
 * - a barge-in's `conversation.item.truncate` (OpenAI can't cut a text item) stops that item's voice instead, and a
 *   `response.cancel` stops the voice too (and, once OpenAI has finished writing, releases the held done);
 * - if the voice fails, the session goes back to OpenAI audio and everything passes through from then on; a line the
 *   caller heard none of is deleted and OpenAI is asked again (the same request), so nothing goes unsaid.
 * Gate barge-in only (AI_VOICE_BARGE_IN=gate): every response is one the bridge asked for (elevenlabs-tts.ts).
 */
import type { BridgeLog } from './bridge-tools.js';
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
  /** Some of its audio went to the bridge. */
  heard: boolean;
}

const WS_OPEN = 1;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Msg => (v !== null && typeof v === 'object' ? (v as Msg) : {});
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const parse = (raw: string): Msg | null => {
  try {
    const m = JSON.parse(raw) as unknown;
    return m !== null && typeof m === 'object' ? (m as Msg) : null;
  } catch {
    return null;
  }
};
const pending = (i: Item): boolean => i.state === 'speaking' || i.state === 'finished';
const without = <K, V>(map: Map<K, V>, key: K): Map<K, V> => new Map([...map].filter(([k]) => k !== key));

export function withExternalVoice(openai: BridgeSocket, openTts: OpenTts, log: BridgeLog): BridgeSocket {
  const listeners: Array<(d: string) => void> = [];
  let items = new Map<string, Item>();
  /** response id → its held `response.done` frame. */
  let held = new Map<string, string>();
  /** Responses the bridge cancelled while OpenAI was still writing: the rest of their text is never spoken. */
  let stopped = new Set<string>();
  /** response id → the `response.create` that asked for it (asked again if the voice fails before it is heard). */
  let requests = new Map<string, Msg>();
  let lastCreate: Msg = { type: 'response.create' };
  /** Unheard responses to ask for again once OpenAI has ended them (after a failure). */
  let replays = new Set<string>();
  let latestResponseId = '';
  let failed = false;

  const deliver = (raw: string): void => {
    for (const cb of listeners) cb(raw);
  };
  const emit = (m: Msg): void => deliver(JSON.stringify(m));
  const ownItems = (responseId: string): Array<[string, Item]> => [...items].filter(([, i]) => i.responseId === responseId);
  const setState = (itemId: string, state: ItemState): Item | null => {
    const item = items.get(itemId);
    if (!item) return null;
    items = new Map([...items, [itemId, { ...item, state }]]);
    return item;
  };

  /** The layer's own messages to OpenAI (the bridge's go through `send`); never while the socket isn't open. */
  const tellOpenAi = (m: Msg): void => {
    if (openai.readyState !== WS_OPEN) return;
    try {
      openai.send(JSON.stringify(m));
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai-voice: could not send to OpenAI');
    }
  };

  /** Each item of a response gets its audio done and its transcript, once; the items are then forgotten. */
  const closeOut = (responseId: string): void => {
    for (const [itemId, item] of ownItems(responseId)) {
      emit({ type: 'response.output_audio.done', response_id: responseId, item_id: itemId });
      emit({ type: 'response.output_audio_transcript.done', response_id: responseId, item_id: itemId, transcript: item.text });
    }
    items = new Map([...items].filter(([, i]) => i.responseId !== responseId));
  };

  /**
   * A response's held done goes once OpenAI has ended it and every line of it is spoken or cut. Until OpenAI ends it,
   * a cut line stays known as cut, so the rest OpenAI writes for it is never spoken.
   */
  const release = (responseId: string): void => {
    const done = held.get(responseId);
    if (done === undefined) return;
    if (ownItems(responseId).some(([, i]) => pending(i))) return;
    closeOut(responseId);
    held = without(held, responseId);
    requests = without(requests, responseId);
    deliver(done);
  };

  const stopResponse = (responseId: string): void => {
    for (const [itemId, item] of ownItems(responseId)) {
      if (!pending(item)) continue;
      tts.cancel(itemId);
      setState(itemId, 'cancelled');
    }
  };

  /**
   * After a failure, a response the caller heard none of: its lines are deleted and OpenAI is asked again (the same
   * request), now in its own voice. A response with a tool call goes on as it is, without its lines, so the tool runs
   * exactly once (the bridge speaks after it, and the goodbye guard asks for a goodbye before an end_call); a cut one
   * goes on as it is.
   */
  const replay = (responseId: string, response: Msg, raw: string): void => {
    replays = new Set([...replays].filter((id) => id !== responseId));
    const request = requests.get(responseId) ?? { type: 'response.create' };
    requests = without(requests, responseId);
    if (str(response.status) !== 'completed') return deliver(raw);
    const output = arr(response.output).map(obj);
    for (const line of output.filter((o) => str(o.type) === 'message' && str(o.id))) {
      tellOpenAi({ type: 'conversation.item.delete', item_id: str(line.id) });
    }
    if (output.some((o) => str(o.type) === 'function_call')) return deliver(raw);
    tellOpenAi(request);
    log.info({ responseId }, 'ai-voice: the external voice never spoke that line; OpenAI says it again in its own voice');
  };

  const fail = (err: Error): void => {
    if (failed) return;
    failed = true;
    log.warn({ err: err.message }, 'ai-voice: the external voice failed — the call carries on in the OpenAI voice');
    tellOpenAi({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'] } });
    const responses = new Set([...items.values()].map((i) => i.responseId));
    for (const responseId of responses) {
      const own = ownItems(responseId).map(([, i]) => i);
      const unheard = own.every((i) => !i.heard) && own.some((i) => i.state !== 'cancelled');
      if (!unheard) {
        closeOut(responseId);
        continue;
      }
      items = new Map([...items].filter(([, i]) => i.responseId !== responseId));
      replays = new Set([...replays, responseId]);
    }
    const dones = [...held];
    held = new Map();
    for (const [responseId, raw] of dones) {
      if (replays.has(responseId)) replay(responseId, obj(parse(raw)?.response), raw);
      else deliver(raw);
    }
  };

  const tts = openTts({
    audio(itemId, base64) {
      const item = items.get(itemId);
      if (failed || !item || !pending(item)) return;
      if (!item.heard) items = new Map([...items, [itemId, { ...item, heard: true }]]);
      emit({ type: 'response.output_audio.delta', response_id: item.responseId, item_id: itemId, delta: base64 });
    },
    done(itemId) {
      const item = setState(itemId, 'done');
      if (item) release(item.responseId);
    },
    failed: fail,
  });

  const onTextDelta = (m: Msg): void => {
    const responseId = str(m.response_id);
    const itemId = str(m.item_id);
    if (stopped.has(responseId)) return;
    const known = items.get(itemId);
    if (known && !pending(known)) return;
    if (!known && ownItems(responseId).some(([, i]) => pending(i))) {
      log.warn({ responseId }, 'ai-voice: a second spoken line in one response — the two may overlap');
    }
    const item = known ?? { responseId, text: '', state: 'speaking' as const, heard: false };
    items = new Map([...items, [itemId, { ...item, text: item.text + str(m.delta) }]]);
    tts.speak(itemId, str(m.delta));
  };

  const onTextDone = (m: Msg): void => {
    const itemId = str(m.item_id);
    const item = items.get(itemId);
    if (!item || item.state !== 'speaking') return;
    items = new Map([...items, [itemId, { ...item, text: str(m.text) || item.text, state: 'finished' }]]);
    tts.finish(itemId);
  };

  /** OpenAI ended a response: a line still being written is spoken as it is (completed) or stopped; then it waits. */
  const onResponseDone = (m: Msg, raw: string): void => {
    const response = obj(m.response);
    const responseId = str(response.id);
    const completed = str(response.status) === 'completed';
    for (const [itemId, item] of ownItems(responseId)) {
      if (item.state !== 'speaking') continue;
      if (completed) {
        setState(itemId, 'finished');
        tts.finish(itemId);
      } else {
        setState(itemId, 'cancelled');
        tts.cancel(itemId);
      }
    }
    stopped = new Set([...stopped].filter((id) => id !== responseId));
    held = new Map([...held, [responseId, raw]]);
    release(responseId);
  };

  /** OpenAI → bridge. */
  openai.on('message', (raw) => {
    const m = parse(raw);
    if (!m) return deliver(raw);
    if (failed) {
      const response = obj(m.response);
      if (m.type === 'response.done' && replays.has(str(response.id))) return replay(str(response.id), response, raw);
      return deliver(raw);
    }
    switch (m.type) {
      case 'response.created':
        latestResponseId = str(obj(m.response).id);
        requests = new Map([...requests, [latestResponseId, lastCreate]]);
        return deliver(raw);
      case 'response.output_text.delta':
        return onTextDelta(m);
      case 'response.output_text.done':
        return onTextDone(m);
      case 'response.done':
        return onResponseDone(m, raw);
      default:
        return deliver(raw);
    }
  });

  /** Bridge → OpenAI. */
  const send = (raw: string): void => {
    const m = parse(raw);
    if (!m) return openai.send(raw);
    if (failed) {
      // The caller cut in: an unheard response waiting to be asked for again goes on as it is (the bridge cut it).
      if (m.type === 'response.cancel') replays = new Set();
      return openai.send(raw);
    }
    switch (m.type) {
      case 'response.create': {
        const { event_id: _eventId, ...request } = m;
        lastCreate = request;
        return openai.send(raw);
      }
      case 'session.update':
        return openai.send(JSON.stringify({ ...m, session: { ...obj(m.session), output_modalities: ['text'] } }));
      case 'conversation.item.truncate': {
        const itemId = str(m.item_id);
        const item = items.get(itemId);
        if (item && pending(item)) {
          tts.cancel(itemId);
          setState(itemId, 'cancelled');
          release(item.responseId);
        }
        return; // a text item can't be truncated; the voice is what stops
      }
      case 'response.cancel':
        stopResponse(latestResponseId);
        if (held.has(latestResponseId)) return release(latestResponseId); // OpenAI has finished: only the voice was going
        stopped = new Set([...stopped, latestResponseId]);
        return openai.send(raw);
      default:
        return openai.send(raw);
    }
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
