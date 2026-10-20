import { describe, expect, it, vi } from 'vitest';
import { renderElevenLabsVoicemail, spokenPhoneNumbers, voicemailVoiceFor } from './elevenlabs-voicemail.js';
import { silentLog } from './testing.js';

const SETTINGS = { apiKey: 'k-test', voiceId: 'eXpIbVcVbLo8ZJQDlDnl', modelId: 'eleven_v4_turbo' };
const TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech/eXpIbVcVbLo8ZJQDlDnl?output_format=pcm_16000';
const TEXT = 'Hi Jane. You can reach us at 619-555-0142.';

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fetch that records each request and answers with `respond()` (or throws what it throws). */
function fakeFetch(respond: () => Response) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const answer = (status: number, type: string, body: string | Buffer) => () =>
  new Response(body, { status, headers: { 'content-type': type } });

describe('renderElevenLabsVoicemail — one voicemail in Siren, as phone audio', () => {
  it('asks ElevenLabs text-to-speech for 16 kHz PCM in Siren on v4 Turbo, with numbers said digit by digit', async () => {
    const f = fakeFetch(answer(200, 'audio/pcm', Buffer.alloc(32_000)));
    await renderElevenLabsVoicemail(SETTINGS, f.fetchImpl)(TEXT);
    expect(f.sent).toHaveLength(1);
    const { url, init } = f.sent[0]!;
    expect(url).toBe(TTS_URL);
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('xi-api-key')).toBe('k-test');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'Hi Jane. You can reach us at six one nine, five five five, zero one four two.',
      model_id: 'eleven_v4_turbo',
      voice_settings: { stability: 0.5 },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('resolves to a phone WAV: 1 s of PCM is 8,000 μ-law bytes after the 58-byte header', async () => {
    const f = fakeFetch(answer(200, 'audio/pcm', Buffer.alloc(32_000)));
    const wav = await renderElevenLabsVoicemail(SETTINGS, f.fetchImpl)(TEXT);
    expect(wav.length).toBe(8_058);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(20)).toBe(7);
    expect(new Set(wav.subarray(58))).toEqual(new Set([0xff]));
  });

  it.each([
    [401, 'application/json', '{"detail":{"status":"quota_exceeded","message":"Jane is over quota"}}', /401 quota_exceeded/],
    [500, 'text/plain', 'upstream broke', /500/],
    [200, 'application/json', '{}', /not audio/],
    [200, 'audio/pcm', '', /too short/],
    [200, 'audio/pcm', Buffer.alloc(15_998), /too short/],
  ] as const)('rejects %s %s (case %#) with no text in the error', async (status, type, body, want) => {
    const f = fakeFetch(answer(status, type, body));
    const err = await renderElevenLabsVoicemail(SETTINGS, f.fetchImpl)(TEXT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(want);
    expect(String(err)).not.toContain('Jane');
  });

  it('accepts exactly half a second of audio (the shortest voicemail it takes)', async () => {
    const f = fakeFetch(answer(200, 'audio/pcm', Buffer.alloc(16_000)));
    expect((await renderElevenLabsVoicemail(SETTINGS, f.fetchImpl)(TEXT)).length).toBe(58 + 4_000);
  });

  it('keeps only a plain status code from an error body (no message, nothing odd)', async () => {
    const f = fakeFetch(answer(429, 'application/json', `{"detail":{"status":"too_many\\nrequests ${'x'.repeat(80)}"}}`));
    const err = await renderElevenLabsVoicemail(SETTINGS, f.fetchImpl)(TEXT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toBe('Error: ElevenLabs voicemail 429');
  });

  it('rejects when the audio cannot be read (a timeout or a cut connection mid-body), without the text', async () => {
    const f = fakeFetch(() => {
      const res = new Response(Buffer.alloc(32_000), { status: 200, headers: { 'content-type': 'audio/pcm' } });
      vi.spyOn(res, 'arrayBuffer').mockRejectedValue(new Error('The operation was aborted due to timeout'));
      return res;
    });
    const err = await renderElevenLabsVoicemail(SETTINGS, f.fetchImpl)(TEXT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/ElevenLabs voicemail: reading the audio failed: The operation was aborted due to timeout/);
    expect(String(err)).not.toContain('Jane');
  });

  it('rejects when the request itself fails (timeout, network), without the text', async () => {
    const f = fakeFetch(() => {
      throw new Error('network down');
    });
    const err = await renderElevenLabsVoicemail(SETTINGS, f.fetchImpl)(TEXT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/ElevenLabs voicemail: request failed: network down/);
    expect(String(err)).not.toContain('Jane');
  });
});

describe('spokenPhoneNumbers — numbers the way Sam says them on calls', () => {
  it('says every written NANP number digit by digit in groups', () => {
    expect(spokenPhoneNumbers('Call 619-555-0142 or 858-555-0199.')).toBe(
      'Call six one nine, five five five, zero one four two or eight five eight, five five five, zero one nine nine.',
    );
  });

  it('leaves text without a number alone', () => {
    expect(spokenPhoneNumbers('Thanks, and have a great day!')).toBe('Thanks, and have a great day!');
  });

  it.each(['Ref 1619-555-0142', 'Ref 619-555-01423', 'Ref 1619-555-01423'])('leaves %s alone (part of a longer run of digits)', (text) => {
    expect(spokenPhoneNumbers(text)).toBe(text);
  });
});

describe('voicemailVoiceFor — the config picks the voicemail voice', () => {
  const base = { ELEVENLABS_API_KEY: 'k-test', AI_VOICE_ELEVENLABS_VOICE: 'eXpIbVcVbLo8ZJQDlDnl', AI_VOICE_ELEVENLABS_MODEL: 'eleven_v4_turbo' };

  it("'say' keeps the stock voice: no renderer", () => {
    expect(voicemailVoiceFor({ ...base, AI_VOICE_VOICEMAIL_TTS: 'say' }, silentLog)).toBeNull();
  });

  it("'elevenlabs' without a key: no renderer, and one warning", () => {
    const log = { ...silentLog, warn: vi.fn() };
    expect(voicemailVoiceFor({ ...base, ELEVENLABS_API_KEY: undefined, AI_VOICE_VOICEMAIL_TTS: 'elevenlabs' }, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("'elevenlabs' with a key: a renderer that calls the configured key, voice and model", async () => {
    const f = fakeFetch(answer(200, 'audio/pcm', Buffer.alloc(32_000)));
    const cfg = { ELEVENLABS_API_KEY: 'k-other', AI_VOICE_ELEVENLABS_VOICE: 'voiceB', AI_VOICE_ELEVENLABS_MODEL: 'eleven_flash_v2_5', AI_VOICE_VOICEMAIL_TTS: 'elevenlabs' as const };
    const render = voicemailVoiceFor(cfg, silentLog, f.fetchImpl);
    expect(render).not.toBeNull();
    await render!(TEXT);
    expect(f.sent[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voiceB?output_format=pcm_16000');
    expect(new Headers(f.sent[0]!.init.headers).get('xi-api-key')).toBe('k-other');
    expect(JSON.parse(String(f.sent[0]!.init.body))).toMatchObject({ model_id: 'eleven_flash_v2_5' });
  });
});
