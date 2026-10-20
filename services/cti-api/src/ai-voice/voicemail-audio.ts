/**
 * Each call's voicemail in Sam's voice, between the render and Twilio's `<Play>` (plan 2026-10-19 voicemail in Sam's
 * voice). `prepare` starts the render as soon as the call is placed; at the beep `playUrl` hands out its URL if the
 * audio for exactly that text is ready (waiting a little for a render still running), else null and the call gets
 * `<Say>`; Twilio then fetches the WAV from the public GET route.
 *
 * The URL carries a random 256-bit token, never the call id, and is the only key to the audio (Twilio sends no
 * signature on `<Play>` fetches). Audio lives in memory only, until the call ends (`forget`, from its final status)
 * or at the latest for as long as a call can be live (ttlMs, as the registry), at most `maxHeld` calls at once (oldest
 * dropped first) — per process, like the registry: cti-api runs one replica. Logs name the call, never the text (the
 * seller's name and street) or the token.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { BridgeLog } from './bridge-tools.js';
import type { RenderVoicemail } from './elevenlabs-voicemail.js';
import { VOICEMAIL_AUDIO_PATH } from './twilio.js';

/** How long the beep waits for a render still running before the call gets `<Say>`. */
export const VOICEMAIL_READY_WAIT_MS = 1_500;
/** At most this many calls' audio is held (a few MB at ~120 KB a voicemail). */
export const VOICEMAIL_MAX_HELD = 200;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface VoicemailAudio {
  /** Start rendering this call's voicemail in the background; never throws; a second call for the same id is ignored. */
  prepare(aiCallId: string, text: string): void;
  /** The play URL when audio for exactly `text` is ready, waiting up to `waitMs` for a render still running; else null. */
  playUrl(aiCallId: string, text: string, waitMs?: number): Promise<string | null>;
  /** The WAV behind a token, or null (unknown, expired, not ready, failed). */
  wav(token: string): Buffer | null;
  /** The call has ended: its audio and URL are gone now, not at the end of ttlMs. */
  forget(aiCallId: string): void;
}

export interface VoicemailAudioOptions {
  render: RenderVoicemail;
  apiPublicUrl: string;
  ttlMs: number;
  log: BridgeLog;
  maxHeld?: number;
}

interface Held {
  text: string;
  token: string;
  state: 'pending' | 'ready' | 'failed';
  wav: Buffer | null;
  /** Settles (never rejects) when the render is over, either way. */
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createVoicemailAudio(o: VoicemailAudioOptions): VoicemailAudio {
  const maxHeld = o.maxHeld ?? VOICEMAIL_MAX_HELD;
  /** By call id; insertion order is age, so the first key is the oldest. */
  const held = new Map<string, Held>();
  const callOf = new Map<string, string>();
  /**
   * Renders run one at a time: the ElevenLabs account also speaks the live calls (AI_VOICE_TTS=elevenlabs), whose
   * requests a burst of renders must not crowd out. A render takes ~3 s and a phone rings for longer, so a short queue
   * is still ready by the beep; one that isn't gets `<Say>`.
   */
  let lastRender: Promise<void> = Promise.resolve();

  const forget = (aiCallId: string): void => {
    const cur = held.get(aiCallId);
    if (!cur) return;
    clearTimeout(cur.timer);
    held.delete(aiCallId);
    callOf.delete(cur.token);
  };

  /** The render's result, only onto the entry it was started for (it may have expired or been dropped since). */
  const settle = (aiCallId: string, token: string, patch: Pick<Held, 'state' | 'wav'>): void => {
    const cur = held.get(aiCallId);
    if (cur?.token === token) held.set(aiCallId, { ...cur, ...patch });
  };

  const start = (aiCallId: string, text: string): void => {
    for (const oldest of held.keys()) {
      if (held.size < maxHeld) break;
      forget(oldest);
    }
    const token = randomBytes(32).toString('hex');
    const startedAt = Date.now();
    const finish = async (): Promise<void> => {
      if (held.get(aiCallId)?.token !== token) return; // the call ended (or was dropped) while queued: nothing to render
      let wav: Buffer;
      try {
        wav = await o.render(text);
        if (!Buffer.isBuffer(wav) || wav.length === 0) throw new Error('the render gave no audio');
      } catch (e) {
        settle(aiCallId, token, { state: 'failed', wav: null });
        o.log.warn({ aiCallId, err: errText(e) }, 'ai-voice: voicemail audio failed — the call will use <Say>');
        return;
      }
      settle(aiCallId, token, { state: 'ready', wav });
      o.log.info({ aiCallId, ms: Date.now() - startedAt, bytes: wav.length }, 'ai-voice: voicemail audio ready');
    };
    // The entry is set below before `finish` runs (a microtask later at the earliest). Only a throwing logger can reach
    // the catch, after the entry is settled: there is nowhere left to report it, and the beep must not see it.
    const done = lastRender.then(finish).catch(() => {});
    lastRender = done;
    const timer = setTimeout(() => forget(aiCallId), o.ttlMs);
    timer.unref?.();
    held.set(aiCallId, { text, token, state: 'pending', wav: null, done, timer });
    callOf.set(token, aiCallId);
  };

  /** Settles after `ms`, or when `done` does; the timer never outlives the wait. */
  const within = async (done: Promise<void>, ms: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([done, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    prepare(aiCallId, text) {
      try {
        if (!held.has(aiCallId)) start(aiCallId, text);
      } catch (e) {
        o.log.error({ aiCallId, err: errText(e) }, 'ai-voice: voicemail audio could not start — the call will use <Say>');
      }
    },
    // The beep comes once: whatever it does not take is dropped, so a render it gave up on is never sent (or kept).
    async playUrl(aiCallId, text, waitMs = VOICEMAIL_READY_WAIT_MS) {
      const first = held.get(aiCallId);
      if (!first || first.text !== text) {
        o.log.info({ aiCallId, reason: first ? 'other_text' : 'none' }, 'ai-voice: voicemail audio not used');
        forget(aiCallId);
        return null;
      }
      if (first.state === 'pending') await within(first.done, waitMs);
      const now = held.get(aiCallId);
      if (now?.token === first.token && now.state === 'ready') return `${o.apiPublicUrl}${VOICEMAIL_AUDIO_PATH}/${now.token}`;
      o.log.info({ aiCallId, reason: now?.state ?? 'expired' }, 'ai-voice: voicemail audio not used');
      if (now?.token === first.token) forget(aiCallId);
      return null;
    },
    wav(token) {
      if (!TOKEN_RE.test(token)) return null;
      const aiCallId = callOf.get(token);
      const cur = aiCallId ? held.get(aiCallId) : undefined;
      return cur?.token === token && cur.state === 'ready' ? cur.wav : null;
    },
    forget,
  };
}

/**
 * Public: the token is the key. Any other answer is the same 404, so nothing tells which calls exist. Fastify's
 * request log (info) would write the URL, token and all, where more people can read it than should hear the
 * voicemail: this route logs at warn and above only.
 */
export function registerVoicemailAudioRoute(app: FastifyInstance, audio: VoicemailAudio): void {
  app.get(`${VOICEMAIL_AUDIO_PATH}/:token`, { logLevel: 'warn' }, async (req, reply) => {
    const { token } = req.params as { token?: unknown };
    const wav = typeof token === 'string' ? audio.wav(token) : null;
    if (!wav) return reply.code(404).type('text/plain').send('Not found');
    return reply.type('audio/wav').header('cache-control', 'no-store').send(wav);
  });
}
