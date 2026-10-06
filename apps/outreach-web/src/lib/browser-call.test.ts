import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { IDENTITY, TEST_ID } from '../test/record-test-fixtures';
import { defaultBrowserCallDeps, micErrorWords, useBrowserCall, type BrowserCallDeps, type BrowserCallState } from './browser-call';

type Fn = (...a: unknown[]) => void;

class Emitter {
  private readonly handlers = new Map<string, Fn[]>();
  on(ev: string, fn: Fn): void { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); }
  emit(ev: string, ...a: unknown[]): void { for (const fn of this.handlers.get(ev) ?? []) fn(...a); }
}

class FakeCall extends Emitter {
  accept = vi.fn(() => this.emit('accept'));
  mute = vi.fn();
  disconnect = vi.fn();
  reject = vi.fn();
}

class FakeDevice extends Emitter {
  static instances: FakeDevice[] = [];
  register = vi.fn(() => new Promise<void>(() => {}));
  destroy = vi.fn();
  constructor(readonly token: string, readonly opts: object) {
    super();
    FakeDevice.instances.push(this);
  }
}

const TOKEN = 'secret.jwt.token';
const TOKEN_ROUTE = 'POST /api/record-tests/browser-token';
const CALL_ROUTE = `POST /api/record-tests/${TEST_ID}/calls`;
const placed = { callId: '77777777-7777-4777-8777-777777777777', response: { result: 'placed', aiCallId: '88888888-8888-4888-8888-888888888888' } };

/** An answer with an HTTP error status (`stubFetch` answers it with ok: false). */
class Failure { constructor(readonly status: number, readonly body: unknown) {} }

interface Sent { route: string; body: unknown }
/** A fetch whose answers are plain promises (each route's answer may be held back with `hold`). */
function stubFetch(answers: Record<string, unknown>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const route = `${init?.method ?? 'GET'} ${input}`;
    sent.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = await answers[route];
    if (body instanceof Failure) return { ok: false, status: body.status, json: async () => body.body };
    return { ok: true, status: 200, json: async () => body };
  }));
  return sent;
}

type Deferred<T = unknown> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const MIC = {
  denied: 'The microphone is blocked for this site. Allow it in the browser\'s site settings, or use Ring my phone.',
  missing: 'No microphone was found. Connect one (headphones with a mic work), or use Ring my phone.',
  insecure: 'The microphone only works on a secure (https) page. Open the app over https, or use Ring my phone.',
  other: "The microphone couldn't be opened (another app may be using it). Try again, or use Ring my phone.",
};

const flush = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
const tokenAnswer = { token: TOKEN, identity: IDENTITY, expiresAt: '2026-10-06T18:00:00.000Z' };

function setup(over: Partial<BrowserCallDeps> = {}) {
  const deps: BrowserCallDeps = { loadDevice: async () => FakeDevice, getMic: vi.fn(async () => {}), isSupported: async () => true, ...over };
  const phases: string[] = [];
  const hook = renderHook(() => {
    const h = useBrowserCall(TEST_ID, deps);
    if (phases.at(-1) !== h.state.phase) phases.push(h.state.phase);
    return h;
  });
  const device = (): FakeDevice => FakeDevice.instances.at(-1)!;
  const state = (): BrowserCallState => hook.result.current.state;
  return { deps, phases, hook, device, state };
}

/** Starts a run and brings it to `live`. */
async function goLive(t: ReturnType<typeof setup>): Promise<FakeCall> {
  void t.hook.result.current.start();
  await flush();
  act(() => t.device().emit('registered'));
  await flush();
  const call = new FakeCall();
  act(() => t.device().emit('incoming', call));
  return call;
}

beforeEach(() => { FakeDevice.instances = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useBrowserCall', () => {
  it('mic → registering → placing → ringing → live; accepts once; POSTs the identity; never keeps the token', async () => {
    const answer = deferred<unknown>();
    const sent = stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: answer.promise });
    const mic = deferred();
    const t = setup({ getMic: () => mic.promise });
    await flush();
    expect(t.hook.result.current.supported).toBe(true);
    void t.hook.result.current.start();
    await flush();
    mic.resolve();
    await flush();
    expect(t.device().token).toBe(TOKEN);
    // Never DEBUG: at that level the SDK logs the token it sends (G-4, spec §8.1).
    expect(t.device().opts).toEqual({ logLevel: 'error' });
    act(() => t.device().emit('registered'));
    await flush();
    answer.resolve(placed);
    await flush();
    const call = new FakeCall();
    act(() => t.device().emit('incoming', call));
    expect(t.phases).toEqual(['idle', 'mic', 'registering', 'placing', 'ringing', 'live']);
    expect(call.accept).toHaveBeenCalledTimes(1);
    expect(sent.find((s) => s.route === CALL_ROUTE)?.body).toEqual({ mode: 'browser', identity: IDENTITY });
    expect(JSON.stringify(t.hook.result.current)).not.toContain(TOKEN);
  });

  it('a refused microphone ends refused, and no token is asked for', async () => {
    const sent = stubFetch({});
    const t = setup({ getMic: async () => { throw new DOMException('denied', 'NotAllowedError'); } });
    void t.hook.result.current.start();
    await flush();
    expect(t.state()).toEqual({ phase: 'ended', reason: 'refused', words: MIC.denied });
    expect(sent).toEqual([]);
  });

  it.each([
    ['NotAllowedError', MIC.denied],
    ['SecurityError', MIC.denied],
    ['NotFoundError', MIC.missing],
    ['OverconstrainedError', MIC.missing],
    ['InsecureContextError', MIC.insecure],
    ['NotReadableError', MIC.other],
    ['TypeError', MIC.other],
  ])('a microphone failure %s has its own words', (name, words) => {
    expect(micErrorWords(new DOMException('x', name))).toBe(words);
  });

  it('the default microphone check on a page that is not https fails as an insecure context', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
    const err = await defaultBrowserCallDeps.getMic().catch((e: unknown) => e);
    expect(micErrorWords(err)).toBe(MIC.insecure);
  });

  it('a Device that throws while being built ends in an error with words; nothing is placed', async () => {
    const sent = stubFetch({ [TOKEN_ROUTE]: tokenAnswer });
    class ThrowingDevice { constructor() { throw new Error('bad token'); } }
    const t = setup({ loadDevice: async () => ThrowingDevice as never });
    await act(async () => { await t.hook.result.current.start(); });
    expect(t.state()).toEqual({ phase: 'ended', reason: 'error', words: "This browser couldn't connect to the calling service. Try again or use Ring my phone." });
    expect(sent.map((s) => s.route)).toEqual([TOKEN_ROUTE]);
  });

  it('a register() that throws at once ends in an error; the Device is destroyed', async () => {
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer });
    class ThrowOnRegister extends FakeDevice { override register = vi.fn((): Promise<void> => { throw new Error('boom'); }); }
    const t = setup({ loadDevice: async () => ThrowOnRegister });
    await act(async () => { await t.hook.result.current.start(); });
    expect(t.state()).toEqual({ phase: 'ended', reason: 'error', words: "This browser couldn't connect to the calling service. Try again or use Ring my phone." });
    expect(t.device().destroy).toHaveBeenCalled();
  });

  it('registration that takes over 15 s ends in an error; the Device is destroyed and no call is placed', async () => {
    const sent = stubFetch({ [TOKEN_ROUTE]: tokenAnswer });
    const t = setup();
    void t.hook.result.current.start();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(t.state()).toMatchObject({ phase: 'ended', reason: 'error' });
    expect(t.device().destroy).toHaveBeenCalled();
    expect(sent.map((s) => s.route)).toEqual([TOKEN_ROUTE]);
  });

  it('a blocked answer ends refused with its words; the Device is destroyed', async () => {
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: { callId: placed.callId, response: { result: 'blocked', reason: 'no_caller_id', aiCallId: placed.response.aiCallId } } });
    const t = setup();
    void t.hook.result.current.start();
    await flush();
    act(() => t.device().emit('registered'));
    await flush();
    expect(t.state()).toEqual({ phase: 'ended', reason: 'refused', words: 'Not placed: no AI caller ID number is free' });
    expect(t.device().destroy).toHaveBeenCalled();
  });

  it('no incoming call within 45 s ends no_ring; the Device is destroyed', async () => {
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: placed });
    const t = setup();
    void t.hook.result.current.start();
    await flush();
    act(() => t.device().emit('registered'));
    await flush();
    expect(t.state().phase).toBe('ringing');
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(t.state()).toEqual({ phase: 'ended', reason: 'no_ring', words: "The AI didn't ring through. Try again or use Ring my phone." });
    expect(t.device().destroy).toHaveBeenCalled();
  });

  it('a second incoming call is rejected; the first stays live', async () => {
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: placed });
    const t = setup();
    const first = await goLive(t);
    const second = new FakeCall();
    act(() => t.device().emit('incoming', second));
    expect(second.reject).toHaveBeenCalled();
    expect(second.accept).not.toHaveBeenCalled();
    expect(first.disconnect).not.toHaveBeenCalled();
    expect(t.state().phase).toBe('live');
  });

  it('the AI ringing before the run request answers is accepted at once, and the placed answer keeps it live', async () => {
    const answer = deferred<unknown>();
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: answer.promise });
    const t = setup();
    const call = await goLive(t);
    expect(call.accept).toHaveBeenCalledTimes(1);
    answer.resolve(placed);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(t.state().phase).toBe('live');
    expect(t.phases).not.toContain('ringing');
    expect(t.device().destroy).not.toHaveBeenCalled();
  });

  it.each([
    ['the network fails', (a: Deferred) => a.reject(new TypeError('Failed to fetch'))],
    ['outreach-api answers 500', (a: Deferred) => a.resolve(new Failure(500, { error: 'boom', code: 'INTERNAL' }))],
    ['outreach-api answers blocked', (a: Deferred) => a.resolve({ callId: placed.callId, response: { result: 'blocked', reason: 'no_caller_id', aiCallId: placed.response.aiCallId } })],
  ])('a run request whose answer fails (%s) never hangs up the AI call this tab already accepted', async (_name, fail) => {
    const answer = deferred<unknown>();
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: answer.promise });
    const t = setup();
    const call = await goLive(t);
    fail(answer);
    await flush();
    expect(t.state().phase).toBe('live');
    expect(call.disconnect).not.toHaveBeenCalled();
    expect(t.device().destroy).not.toHaveBeenCalled();
  });

  it('toggleMute mutes, then unmutes', async () => {
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: placed });
    const t = setup();
    const call = await goLive(t);
    act(() => t.hook.result.current.toggleMute());
    expect(call.mute).toHaveBeenLastCalledWith(true);
    expect(t.state()).toMatchObject({ phase: 'live', muted: true });
    act(() => t.hook.result.current.toggleMute());
    expect(call.mute).toHaveBeenLastCalledWith(false);
    expect(t.state()).toMatchObject({ phase: 'live', muted: false });
  });

  it('hangUp disconnects, ends hung_up and destroys the Device', async () => {
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: placed });
    const t = setup();
    const call = await goLive(t);
    act(() => t.hook.result.current.hangUp());
    expect(call.disconnect).toHaveBeenCalled();
    act(() => call.emit('disconnect'));
    expect(t.state()).toEqual({ phase: 'ended', reason: 'hung_up' });
    expect(t.device().destroy).toHaveBeenCalled();
  });

  it('the AI hanging up ends remote', async () => {
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: placed });
    const t = setup();
    const call = await goLive(t);
    act(() => call.emit('disconnect'));
    expect(t.state()).toEqual({ phase: 'ended', reason: 'remote' });
    expect(t.device().destroy).toHaveBeenCalled();
  });

  it('leaving the page while live destroys the Device', async () => {
    stubFetch({ [TOKEN_ROUTE]: tokenAnswer, [CALL_ROUTE]: placed });
    const t = setup();
    await goLive(t);
    expect(t.state().phase).toBe('live');
    t.hook.unmount();
    expect(t.device().destroy).toHaveBeenCalled();
  });

  it('an unsupported browser reads supported false', async () => {
    const t = setup({ isSupported: async () => false });
    await flush();
    expect(t.hook.result.current.supported).toBe(false);
  });
});
