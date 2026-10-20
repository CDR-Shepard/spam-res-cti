import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createVoicemailAudio, registerVoicemailAudioRoute, type VoicemailAudio } from './voicemail-audio.js';

const API = 'https://api.test';
const A = '11111111-2222-4333-8444-555555555555';
const B = '22222222-2222-4333-8444-555555555555';
const C = '33333333-2222-4333-8444-555555555555';
const TEXT = 'Hi Jane, this is Sam, an AI assistant calling for GG Homes about your property on Oak Street.';
const TTL_MS = 60_000;
const WAV_A = Buffer.from('RIFF-audio-for-A');
const WAV_B = Buffer.from('RIFF-audio-for-B');
const URL_RE = /^https:\/\/api\.test\/telephony\/twilio\/ai-voice\/voicemail\/[0-9a-f]{64}$/;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tokenOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

let logged: unknown[][];
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let render: ReturnType<typeof vi.fn<(text: string) => Promise<Buffer>>>;
let audio: VoicemailAudio;

function make(maxHeld?: number): VoicemailAudio {
  return createVoicemailAudio({ render, apiPublicUrl: API, ttlMs: TTL_MS, log, ...(maxHeld ? { maxHeld } : {}) });
}

/** prepare() with an immediate render of `wav`, and its play URL. */
async function ready(id: string, wav: Buffer, a: VoicemailAudio = audio): Promise<string> {
  render.mockResolvedValueOnce(wav);
  a.prepare(id, TEXT);
  const url = await a.playUrl(id, TEXT, 0);
  expect(url).toMatch(URL_RE);
  return url!;
}

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  const record = (...args: unknown[]) => void logged.push(args);
  log = { info: vi.fn(record), warn: vi.fn(record), error: vi.fn(record) };
  render = vi.fn<(text: string) => Promise<Buffer>>();
  audio = make();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createVoicemailAudio — each call’s voicemail audio, held in memory behind a token', () => {
  it('serves the rendered audio at an unguessable URL once ready (the call id is not in it)', async () => {
    const url = await ready(A, WAV_A);
    expect(render).toHaveBeenCalledWith(TEXT);
    expect(url).not.toContain(A);
    expect(audio.wav(tokenOf(url))).toEqual(WAV_A);
  });

  it('renders once per call', async () => {
    render.mockResolvedValue(WAV_A);
    audio.prepare(A, TEXT);
    audio.prepare(A, TEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('another text gets no audio (never the wrong words)', async () => {
    await ready(A, WAV_A);
    expect(await audio.playUrl(A, `${TEXT} Call us back.`, 0)).toBeNull();
  });

  it('a render still running at the beep: waits up to the limit, then null', async () => {
    const d = deferred<Buffer>();
    render.mockReturnValueOnce(d.promise);
    audio.prepare(A, TEXT);
    let answer: string | null | undefined;
    void audio.playUrl(A, TEXT, 1_500).then((u) => (answer = u));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBeNull();
    d.resolve(WAV_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBeNull();
  });

  it('a render that finishes within the wait is used', async () => {
    const d = deferred<Buffer>();
    render.mockReturnValueOnce(d.promise);
    audio.prepare(A, TEXT);
    const url = audio.playUrl(A, TEXT, 1_500);
    await vi.advanceTimersByTimeAsync(400);
    d.resolve(WAV_A);
    expect(await url).toMatch(URL_RE);
  });

  it('a failed render: null, and a warning naming the call only', async () => {
    render.mockRejectedValueOnce(new Error('ElevenLabs voicemail 401 quota_exceeded'));
    audio.prepare(A, TEXT);
    expect(await audio.playUrl(A, TEXT, 1_500)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith({ aiCallId: A, err: 'ElevenLabs voicemail 401 quota_exceeded' }, expect.any(String));
  });

  it('a render that throws before returning a promise is a failed render, not a crash', async () => {
    render.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => audio.prepare(A, TEXT)).not.toThrow();
    expect(await audio.playUrl(A, TEXT, 0)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith({ aiCallId: A, err: 'boom' }, expect.any(String));
  });

  it('an unknown call: null at once', async () => {
    expect(await audio.playUrl(A, TEXT, 1_500)).toBeNull();
  });

  it('expires after ttlMs', async () => {
    const url = await ready(A, WAV_A);
    await vi.advanceTimersByTimeAsync(TTL_MS);
    expect(audio.wav(tokenOf(url))).toBeNull();
    expect(await audio.playUrl(A, TEXT, 0)).toBeNull();
  });

  it('a render finishing after its entry expired is not brought back', async () => {
    const d = deferred<Buffer>();
    render.mockReturnValueOnce(d.promise);
    audio.prepare(A, TEXT);
    await vi.advanceTimersByTimeAsync(TTL_MS);
    d.resolve(WAV_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(await audio.playUrl(A, TEXT, 0)).toBeNull();
  });

  it('holds at most maxHeld calls, dropping the oldest', async () => {
    const small = make(2);
    const a = await ready(A, WAV_A, small);
    const b = await ready(B, WAV_B, small);
    const c = await ready(C, WAV_A, small);
    expect(small.wav(tokenOf(a))).toBeNull();
    expect(small.wav(tokenOf(b))).toEqual(WAV_B);
    expect(small.wav(tokenOf(c))).toEqual(WAV_A);
  });

  it('forget: the call has ended, so its audio and URL are gone at once', async () => {
    const url = await ready(A, WAV_A);
    const b = await ready(B, WAV_B);
    audio.forget(A);
    expect(audio.wav(tokenOf(url))).toBeNull();
    expect(await audio.playUrl(A, TEXT, 0)).toBeNull();
    expect(audio.wav(tokenOf(b))).toEqual(WAV_B);
    expect(() => audio.forget(C)).not.toThrow();
  });

  it('forget during a render: the late result is not brought back', async () => {
    const d = deferred<Buffer>();
    render.mockReturnValueOnce(d.promise);
    audio.prepare(A, TEXT);
    audio.forget(A);
    d.resolve(WAV_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(await audio.playUrl(A, TEXT, 0)).toBeNull();
  });

  it('a render that resolves to no audio is a failed render: null at the beep, never an error into it', async () => {
    render.mockResolvedValueOnce(undefined as unknown as Buffer);
    audio.prepare(A, TEXT);
    expect(await audio.playUrl(A, TEXT, 1_500)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith({ aiCallId: A, err: expect.any(String) }, expect.any(String));
  });

  it('a logger that throws on "ready" loses nothing: the audio is still played', async () => {
    log.info.mockImplementation(() => {
      throw new Error('log sink down');
    });
    render.mockResolvedValueOnce(WAV_A);
    audio.prepare(A, TEXT);
    expect(await audio.playUrl(A, TEXT, 1_500)).toMatch(URL_RE);
  });

  it('a stale render finishing late never lands on a newer entry for the same call', async () => {
    const first = deferred<Buffer>();
    render.mockReturnValueOnce(first.promise);
    audio.prepare(A, TEXT);
    await vi.advanceTimersByTimeAsync(TTL_MS); // the first entry expires while its render is running
    render.mockResolvedValueOnce(WAV_B);
    audio.prepare(A, TEXT);
    await vi.advanceTimersByTimeAsync(0);
    first.resolve(WAV_A);
    await vi.advanceTimersByTimeAsync(0);
    const url = await audio.playUrl(A, TEXT, 0);
    expect(audio.wav(tokenOf(url!))).toEqual(WAV_B);
  });

  it('a beep waiting on a render whose entry is dropped meanwhile gets null, never the old audio', async () => {
    const small = make(1);
    const first = deferred<Buffer>();
    render.mockReturnValueOnce(first.promise);
    small.prepare(A, TEXT);
    const url = small.playUrl(A, TEXT, 1_500);
    render.mockResolvedValueOnce(WAV_B);
    small.prepare(B, TEXT); // drops A (maxHeld 1)
    first.resolve(WAV_A);
    expect(await url).toBeNull();
  });

  it("a dropped entry's own timer does not cut short the same call prepared again", async () => {
    const small = make(1);
    render.mockResolvedValue(WAV_A);
    small.prepare(A, TEXT);
    await vi.advanceTimersByTimeAsync(10_000);
    small.prepare(B, TEXT); // drops A
    await vi.advanceTimersByTimeAsync(10_000);
    small.prepare(A, TEXT); // A again at t=20 s: expires at t=80 s, not at the first entry's t=60 s
    await vi.advanceTimersByTimeAsync(40_001);
    expect(await small.playUrl(A, TEXT, 0)).toMatch(URL_RE);
  });

  it('a wait leaves no timer behind (only the entry’s own expiry)', async () => {
    render.mockResolvedValueOnce(WAV_A);
    audio.prepare(A, TEXT);
    await audio.playUrl(A, TEXT, 1_500);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('two calls never share audio', async () => {
    const a = await ready(A, WAV_A);
    const b = await ready(B, WAV_B);
    expect(tokenOf(a)).not.toBe(tokenOf(b));
    expect(audio.wav(tokenOf(a))).toEqual(WAV_A);
    expect(audio.wav(tokenOf(b))).toEqual(WAV_B);
  });

  it('no URL is handed out while the render is still running (no wait)', async () => {
    render.mockReturnValueOnce(deferred<Buffer>().promise);
    audio.prepare(A, TEXT);
    const url = audio.playUrl(A, TEXT, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(await url).toBeNull();
  });

  it('logs carry no text and no token', async () => {
    const url = await ready(A, WAV_A);
    render.mockRejectedValueOnce(new Error('ElevenLabs voicemail 500'));
    audio.prepare(B, TEXT);
    await audio.playUrl(B, TEXT, 0);
    await audio.playUrl(A, 'other words', 0);
    await audio.playUrl(C, TEXT, 0);
    expect(logged.length).toBeGreaterThan(0);
    const all = JSON.stringify(logged);
    expect(all).not.toContain('Jane');
    expect(all).not.toContain('Oak Street');
    expect(all).not.toContain(tokenOf(url));
  });
});

describe('GET /telephony/twilio/ai-voice/voicemail/:token — what Twilio <Play>s', () => {
  async function app() {
    const a = Fastify();
    registerVoicemailAudioRoute(a, audio);
    await a.ready();
    return a;
  }

  it('a ready token: the WAV, as audio/wav, never cached', async () => {
    const url = await ready(A, WAV_A);
    const server = await app();
    const res = await server.inject({ method: 'GET', url: new URL(url).pathname });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload).toEqual(WAV_A);
    await server.close();
  });

  it.each([
    ['an unknown token', 'f'.repeat(64)],
    ['not hex', 'z'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['uppercase', 'A'.repeat(64)],
  ])('%s: 404 Not found', async (_name, token) => {
    const server = await app();
    const res = await server.inject({ method: 'GET', url: `/telephony/twilio/ai-voice/voicemail/${token}` });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('Not found');
    await server.close();
  });

  it("the token never reaches the server's request log (the log is readable by more people than the audio should be)", async () => {
    const url = await ready(A, WAV_A);
    const lines: string[] = [];
    const server = Fastify({ logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } } });
    registerVoicemailAudioRoute(server, audio);
    await server.ready();
    expect((await server.inject({ method: 'GET', url: new URL(url).pathname })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: `/telephony/twilio/ai-voice/voicemail/${'f'.repeat(64)}` })).statusCode).toBe(404);
    await server.close();
    expect(lines.join('\n')).not.toContain(tokenOf(url));
    expect(lines.join('\n')).not.toContain('f'.repeat(64));
  });

  it('an expired token: the same 404 Not found', async () => {
    const url = await ready(A, WAV_A);
    await vi.advanceTimersByTimeAsync(TTL_MS);
    const server = await app();
    const res = await server.inject({ method: 'GET', url: new URL(url).pathname });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('Not found');
    await server.close();
  });
});
