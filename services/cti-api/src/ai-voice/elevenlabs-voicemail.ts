/**
 * A call's voicemail in Sam's ElevenLabs voice (plan 2026-10-19 voicemail in Sam's voice): the whole message rendered
 * in one request while the phone rings, made phone audio here (phone-audio.ts) and wrapped as a WAV for `<Play>`.
 *
 * ElevenLabs' one-shot text-to-speech endpoint serves eleven_v4_turbo (checked 2026-10-19: a bogus model is refused
 * 400 model_not_found and the history logs v4 Turbo), though the models page lists v4 only on the dialogue socket; it
 * also serves the v2 models AI_VOICE_ELEVENLABS_MODEL may be set back to. A full default voicemail (186 characters,
 * 14.5 s of audio) took 3.1–3.5 s, which is why it is rendered before the beep, not at it.
 *
 * Errors carry the HTTP status and ElevenLabs' status code, never the text: it names the seller and their street.
 */
import type { AppConfig } from '../config.js';
import type { BridgeLog } from './bridge-tools.js';
import type { ElevenLabsSettings } from './elevenlabs-socket.js';
import { muLawWav, phoneAudio } from './phone-audio.js';
import { phoneForms } from './prompt-context.js';

export const ELEVENLABS_HTTP = 'https://api.elevenlabs.io/v1';
export const VOICEMAIL_RENDER_TIMEOUT_MS = 15_000;
/** Half a second of 16 kHz PCM: anything shorter is not a voicemail. */
export const MIN_VOICEMAIL_PCM_BYTES = 16_000;
/**
 * Siren reads a voicemail at 65–78 ms a character (measured 2026-10-19). A clip under 50 ms a character of what was sent
 * stopped well short, and may have lost the callback number TCPA requires (47 CFR 64.1200(b)(2)), so the call reads it
 * with Polly. A coarse tripwire: a clip missing only its last few words still passes.
 */
export const MIN_VOICEMAIL_MS_PER_CHAR = 50;
/** 16 kHz, 16-bit mono. */
const PCM_BYTES_PER_MS = 32;
/** What ElevenLabs sends: 16 kHz PCM, made phone audio here. */
const SOURCE_FORMAT = 'pcm_16000';
/** As the live voice (elevenlabs-dialogue.ts). */
const VOICE_SETTINGS = { stability: 0.5 };
/** A number as the voicemail template writes it (619-555-0142), not part of a longer run of digits. */
const WRITTEN_NUMBER = /(?<!\d)(\d{3})-(\d{3})-(\d{4})(?!\d)/g;

/** A voicemail's text as a μ-law WAV; rejects on any failure (the call then gets `<Say>`). */
export type RenderVoicemail = (text: string) => Promise<Buffer>;

/**
 * Written phone numbers said digit by digit in groups, as the live agent says them (`callback_number_spoken`). Only the
 * form `{{callback_number}}` writes a US number in (619-555-0142); other forms an edited template might type are left
 * to the voice.
 */
export function spokenPhoneNumbers(text: string): string {
  return text.replace(WRITTEN_NUMBER, (match, a: string, b: string, c: string) => phoneForms(`+1${a}${b}${c}`)?.spoken ?? match);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What an ElevenLabs status code looks like ("quota_exceeded"); anything else is not logged. */
const STATUS_CODE = /^[a-z_]{1,64}$/;

/** ElevenLabs' `detail.status` code from an error body, or '' — never its message. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: { status?: unknown } } | null;
    const code = body?.detail?.status;
    return typeof code === 'string' && STATUS_CODE.test(code) ? code : '';
  } catch {
    return '';
  }
}

async function fetchPcm(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new Error(`ElevenLabs voicemail: request failed: ${errText(e)}`);
  }
  if (!res.ok) throw new Error(`ElevenLabs voicemail ${res.status} ${await errorCode(res)}`.trimEnd());
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('audio/')) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`ElevenLabs voicemail: not audio (${type || 'no content-type'})`);
  }
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new Error(`ElevenLabs voicemail: reading the audio failed: ${errText(e)}`);
  }
}

export function renderElevenLabsVoicemail(s: ElevenLabsSettings, fetchImpl: typeof fetch = fetch): RenderVoicemail {
  const url = `${ELEVENLABS_HTTP}/text-to-speech/${encodeURIComponent(s.voiceId)}?output_format=${SOURCE_FORMAT}`;
  return async (text) => {
    const spoken = spokenPhoneNumbers(text);
    const pcm = await fetchPcm(
      url,
      {
        method: 'POST',
        headers: { 'xi-api-key': s.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text: spoken, model_id: s.modelId, voice_settings: VOICE_SETTINGS }),
        signal: AbortSignal.timeout(VOICEMAIL_RENDER_TIMEOUT_MS),
      },
      fetchImpl,
    );
    if (pcm.length < MIN_VOICEMAIL_PCM_BYTES) throw new Error(`ElevenLabs voicemail: too short (${pcm.length} bytes)`);
    const ms = Math.floor(pcm.length / PCM_BYTES_PER_MS);
    const chars = spoken.replace(/\s+/g, ' ').trim().length; // words, not a saved template's blank lines and indentation
    if (ms < chars * MIN_VOICEMAIL_MS_PER_CHAR) {
      throw new Error(`ElevenLabs voicemail: too short for its text (${ms} ms for ${chars} characters)`);
    }
    return muLawWav(await phoneAudio(pcm));
  };
}

type VoicemailConfig = Pick<AppConfig, 'AI_VOICE_VOICEMAIL_TTS' | 'ELEVENLABS_API_KEY' | 'AI_VOICE_ELEVENLABS_VOICE' | 'AI_VOICE_ELEVENLABS_MODEL'>;

/** The voicemail renderer the config asks for, or null for `<Say>` (also when ElevenLabs is chosen without a key). */
export function voicemailVoiceFor(cfg: VoicemailConfig, log: BridgeLog, fetchImpl: typeof fetch = fetch): RenderVoicemail | null {
  if (cfg.AI_VOICE_VOICEMAIL_TTS !== 'elevenlabs') return null;
  if (!cfg.ELEVENLABS_API_KEY) {
    log.warn({}, 'ai-voice: AI_VOICE_VOICEMAIL_TTS=elevenlabs but ELEVENLABS_API_KEY is not set — voicemails use <Say>');
    return null;
  }
  const settings = { apiKey: cfg.ELEVENLABS_API_KEY, voiceId: cfg.AI_VOICE_ELEVENLABS_VOICE, modelId: cfg.AI_VOICE_ELEVENLABS_MODEL };
  return renderElevenLabsVoicemail(settings, fetchImpl);
}
