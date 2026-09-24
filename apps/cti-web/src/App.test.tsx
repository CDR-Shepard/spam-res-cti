/** @vitest-environment jsdom */
/**
 * Pins the App.tsx wiring around inbound calls — the glue that connects
 * incoming-accept.ts's pure decision logic (already covered by
 * incoming-accept.test.ts) to the real component:
 *
 *   1. the ring-screen JSX (around line 1181) that reads `callerName` /
 *      `recordType` off `incoming.customParameters` (a Map), not
 *      `incoming.parameters` — a plain object;
 *   2. the `acceptIncoming` callback (around line 942) that calls
 *      `acceptIncomingCall(call, { screenPop: screenPopRecord })` on accept.
 *
 * Neither is exercised by incoming-accept.test.ts (which only calls the pure
 * functions directly with hand-built call objects) or IncomingScreen.test.tsx
 * (which only renders the presentational component with hand-picked props).
 * A regression in the App-level plumbing — e.g. reading the wrong field, or
 * dropping the screen-pop call — would leave both of those green while the
 * real ring screen showed a bare number or popped the wrong record.
 *
 * App.tsx builds its Twilio Device lazily inside ensureDevice() (dynamic
 * `import('@twilio/voice-sdk')`), not at module scope, so the real component
 * can be mounted here — only the SDK module and the network (`fetch`) are
 * faked. The softphone leader-election coordinator (softphone-coordinator.ts)
 * is used for real: with no peer tabs present it elects this instance leader
 * synchronously (see leader-election.ts's shouldBeLeader — a lone instance
 * always wins), which is exactly what drives ensureDevice() to run on mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, HANGUP_FALLBACK_MS } from './App';
import * as opencti from './opencti';
import type { IncomingCallLike } from './incoming-accept';

/** Minimal fake incoming call: matches what App.tsx's TwilioIncomingCall needs.
 *  `on`/`emit` are a REAL (if tiny) event emitter — not just a spy — so tests
 *  can simulate the SDK firing 'cancel'/'disconnect'/'error' on a call that's
 *  already been accepted (see acceptIncoming's listeners in App.tsx). */
interface FakeIncomingCall extends IncomingCallLike {
  accept: () => void;
  reject: () => void;
  disconnect: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

function fakeCall(overrides: Pick<IncomingCallLike, 'parameters' | 'customParameters'>): FakeIncomingCall {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    ...overrides,
    accept: vi.fn(),
    reject: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
}

/** Fake outbound Twilio Call (device.connect()'s return value) — same real
 *  on/emit shape as FakeIncomingCall, for the same reason: tests need to
 *  simulate 'disconnect' firing (or NOT firing) after hangup(). */
class FakeOutboundConnection {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  disconnect = vi.fn();
  parameters: Record<string, string> = { CallSid: 'CA_test_1' };
  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

/** Fake Twilio Device — captures the `on('incoming', ...)` handler App.tsx's
 *  ensureDevice() wires up, so a test can simulate a ring without a real
 *  Device/WebRTC stack. Constructed the moment ensureDevice() runs (this
 *  instance becomes the softphone leader on mount, with no peers to contest
 *  it), mirroring the real @twilio/voice-sdk Device shape App.tsx relies on. */
class FakeDevice {
  static instances: FakeDevice[] = [];
  /** Outbound legs handed out by connect() — one per place() call. */
  static connects: FakeOutboundConnection[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_token: string, _opts: unknown) {
    FakeDevice.instances.push(this);
  }
  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { /* not exercised */ }
  connect(_opts: unknown): Promise<FakeOutboundConnection> {
    const connection = new FakeOutboundConnection();
    FakeDevice.connects.push(connection);
    return Promise.resolve(connection);
  }
}

vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const ME_RESPONSE = {
  user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: false },
  salesforce: { connected: false },
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.connects.length = 0;
  localStorage.clear();
  // Seed a signed-in session so App.tsx's bootstrap effect skips straight to
  // fetching /auth/me instead of the dev-session fallback.
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/me')) return jsonResponse(ME_RESPONSE);
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    return jsonResponse({});
  }));
  // screenPopRecord (opencti.ts) is real code that no-ops with a console.error
  // outside Salesforce — spy on it (rather than mocking the whole module) so
  // the test observes the actual call App.tsx makes.
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  // This suite mounts the full App repeatedly (each test rings a fresh call),
  // so — unlike this codebase's other component tests, which mount at most
  // once per test — leftover DOM from a prior test would make the next
  // `getByTitle('Answer')` ambiguous. Unmount explicitly between tests.
  cleanup();
  // Safety net: a test that enables fake timers and fails before switching
  // back must not poison every test that runs after it.
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Render the app, wait for it to sign in and register the (fake) Twilio
 *  Device, then fire an inbound ring through that device — exactly the path
 *  a real callback takes (Device 'incoming' event → setIncoming(call) → the
 *  ring-screen JSX). Returns the call object for the caller to accept/decline. */
async function ring(call: FakeIncomingCall): Promise<void> {
  render(<App />);
  await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
  act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
  await screen.findByTitle('Answer');
}

describe('App — inbound ring screen reads customParameters (not parameters)', () => {
  it('renders the matched caller\'s name and record type instead of the raw number', async () => {
    const call = fakeCall({
      parameters: { From: '+16195551234' },
      customParameters: new Map([
        ['callerName', 'Jane Doe'],
        ['recordId', '00Q000000000001AAA'],
        ['recordType', 'Lead'],
      ]),
    });
    await ring(call);

    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText((_, node) => node?.textContent === '+1 (619) 555-1234 · Lead')).toBeTruthy();
    // The raw, unformatted number must never appear on screen.
    expect(screen.queryByText('+16195551234')).toBeNull();
  });

  it('with an EMPTY customParameters Map, renders the formatted number and no record type — exactly as before this feature', async () => {
    const call = fakeCall({
      parameters: { From: '+16195551234' },
      customParameters: new Map(),
    });
    await ring(call);

    expect(screen.getByText('+1 (619) 555-1234')).toBeTruthy();
    expect(screen.getByText(/Incoming call/)).toBeTruthy();
    expect(screen.queryByText('Jane Doe')).toBeNull();
    expect(document.querySelector('.call-screen')?.textContent).not.toContain('·');
  });

  it('reads the name from customParameters (a Map), NOT from parameters, when both carry a name', async () => {
    const call = fakeCall({
      // `parameters` carries a conflicting, non-standard `callerName` field —
      // the real Twilio SDK never puts one there, but this proves App.tsx's
      // JSX (`incoming.customParameters?.get('callerName')`) doesn't
      // accidentally read from `incoming.parameters` instead.
      parameters: { From: '+16195551234', callerName: 'Wrong Name' },
      customParameters: new Map([['callerName', 'Jane Doe']]),
    });
    await ring(call);

    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(screen.queryByText('Wrong Name')).toBeNull();
  });
});

describe('App — accepting an inbound call screen-pops via acceptIncomingCall', () => {
  it('accepting a call WITH a recordId triggers the screen-pop exactly once with that id', async () => {
    const call = fakeCall({
      parameters: { From: '+16195551234' },
      customParameters: new Map([
        ['callerName', 'Jane Doe'],
        ['recordId', '00Q000000000001AAA'],
        ['recordType', 'Lead'],
      ]),
    });
    await ring(call);

    fireEvent.click(screen.getByTitle('Answer'));

    expect(call.accept).toHaveBeenCalledTimes(1);
    expect(opencti.screenPopRecord).toHaveBeenCalledTimes(1);
    expect(opencti.screenPopRecord).toHaveBeenCalledWith('00Q000000000001AAA');
  });

  it('accepting a call with NO recordId never triggers a screen-pop', async () => {
    const call = fakeCall({
      parameters: { From: '+16195551234' },
      customParameters: new Map([['callerName', 'Jane Doe']]),
    });
    await ring(call);

    fireEvent.click(screen.getByTitle('Answer'));

    expect(call.accept).toHaveBeenCalledTimes(1);
    expect(opencti.screenPopRecord).not.toHaveBeenCalled();
  });

  it('accepting an unmatched call (no customParameters at all) never triggers a screen-pop', async () => {
    const call = fakeCall({ parameters: { From: '+16195551234' } });
    await ring(call);

    fireEvent.click(screen.getByTitle('Answer'));

    expect(opencti.screenPopRecord).not.toHaveBeenCalled();
  });
});

/**
 * Pins the fix for the 2026-09-24 incident: Twilio Voice Insights showed a
 * rep answering an inbound callback 12s into the ring, right as the caller
 * hung up (16s) — `get-user-media succeeded` at 13:17:40, then
 * `connection cancel` at 13:17:41. acceptIncoming() had already flipped the
 * UI to the active call screen and only listened for 'disconnect'/'error',
 * never 'cancel', so the rep was stuck staring at silence until they
 * reloaded the page. Separately, hangup() called disconnect() on a
 * connection that (in this exact scenario, and more generally whenever the
 * SDK doesn't emit anything for an already-closed call) never fires an
 * event back, so the in-call screen never cleared even when the rep pressed
 * the hang-up button themselves.
 */
describe('App — a cancelled inbound call and a hangup that never gets an event both return to idle', () => {
  it("a caller who hangs up WHILE the rep is answering returns the rep to idle, with the exact toast", async () => {
    const call = fakeCall({ parameters: { From: '+16195551234' }, customParameters: new Map() });
    await ring(call);
    fireEvent.click(screen.getByTitle('Answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    await screen.findByTitle('End call');

    act(() => { call.emit('cancel'); });

    expect(screen.getByText('The caller hung up before you answered.')).toBeTruthy();
    // Back on the idle dial pad — the in-call screen is gone.
    expect(screen.queryByTitle('End call')).toBeNull();
    await screen.findByTitle('Check & call');
  });

  it('hang up with NO event ever firing still clears the screen, via the fallback', async () => {
    const call = fakeCall({ parameters: { From: '+16195551234' }, customParameters: new Map() });
    await ring(call);
    fireEvent.click(screen.getByTitle('Answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    await screen.findByTitle('End call');

    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle('End call'));
    expect(call.disconnect).toHaveBeenCalledTimes(1);
    // Nothing has happened yet — the fallback hasn't fired.
    expect(screen.queryByTitle('End call')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(HANGUP_FALLBACK_MS); });
    vi.useRealTimers();

    expect(screen.queryByTitle('End call')).toBeNull();
    await screen.findByTitle('Check & call');
    expect(call.disconnect).toHaveBeenCalledTimes(1);
  });

  it("hang up followed IMMEDIATELY by a real 'disconnect' event goes idle once — the fallback is a no-op", async () => {
    const call = fakeCall({ parameters: { From: '+16195551234' }, customParameters: new Map() });
    await ring(call);
    fireEvent.click(screen.getByTitle('Answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    await screen.findByTitle('End call');

    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle('End call'));
    act(() => { call.emit('disconnect'); });
    // Synchronous check — the DOM is already updated inside act(), and
    // findBy*'s internal polling can't advance while fake timers are frozen.
    expect(screen.queryByTitle('End call')).toBeNull();
    expect(screen.getByTitle('Check & call')).toBeTruthy();

    // Advance well past the fallback window — it must be a complete no-op:
    // no second toast, no error, the dial pad stays exactly as it is.
    await act(async () => { await vi.advanceTimersByTimeAsync(HANGUP_FALLBACK_MS + 500); });
    vi.useRealTimers();

    expect(screen.queryByText('The caller hung up before you answered.')).toBeNull();
    expect(screen.queryByText(/Call error/)).toBeNull();
    expect(call.disconnect).toHaveBeenCalledTimes(1);
  });
});

/** Click a digit key (0-9, *, #) on the idle dial pad by its visible label. */
function dialDigit(d: string): void {
  const btn = Array.from(document.querySelectorAll('.dialpad .key')).find(
    (b) => b.querySelector('.num')?.textContent === d,
  );
  if (!btn) throw new Error(`no dial pad key for "${d}"`);
  fireEvent.click(btn);
}

const ALLOW_VERDICT = {
  decision: 'ALLOW',
  reasons: [],
  blockReason: null,
  requiredScriptId: null,
  auditId: 'audit-1',
  checks: [],
  normalizedTo: '+16195551234',
  fromNumber: '+16195559999',
};

const OUTBOUND_CALL = {
  id: 'call-1',
  fromNumber: '+16195559999',
  toNumber: '+16195551234',
  normalizedToNumber: '+16195551234',
};

/** Same routes as the default beforeEach fetch stub, plus the firewall +
 *  call-creation + call-PATCH routes an outbound dial needs. Returns the
 *  mock so tests can inspect exactly which PATCHes went out. */
function stubOutboundFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/auth/me')) return jsonResponse(ME_RESPONSE);
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/firewall/precall')) return jsonResponse(ALLOW_VERDICT);
    if (method === 'POST' && url.endsWith('/calls')) return jsonResponse({ call: OUTBOUND_CALL, taskAllowed: true });
    if (method === 'PATCH' && url.includes('/calls/')) return jsonResponse({});
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Render the app, dial a number, and drive it through the non-admin
 *  auto-place flow (ME_RESPONSE has isAdmin: false, so clearing the
 *  firewall dials immediately — see App.tsx's auto-place effect) until the
 *  outbound call screen is up. Returns the fake connection device.connect()
 *  handed back, so the test can drive its events. */
async function placeOutboundCall(): Promise<FakeOutboundConnection> {
  render(<App />);
  await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
  for (const d of ['5', '5', '5', '1', '2', '3', '4']) dialDigit(d);
  fireEvent.click(screen.getByTitle('Check & call'));
  await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
  await screen.findByTitle('End call');
  return FakeDevice.connects[0]!;
}

/** Same incident fix, on the OUTBOUND leg: hangup() must always clear the
 *  in-call screen, whether or not the SDK ever emits 'disconnect'. The
 *  power-dialer conference leg (dialerConnRef) is untouched by any of this —
 *  hangup() only ever acts on connectionRef. */
describe('App — outbound hang up always reaches wrap-up', () => {
  it("hang up plus a normal 'disconnect' event reaches wrap-up exactly as before (unchanged PATCH)", async () => {
    const fetchMock = stubOutboundFetch();
    const connection = await placeOutboundCall();

    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle('End call'));
    act(() => { connection.emit('disconnect'); });
    expect(document.querySelector('.wrapup')).toBeTruthy();

    // The fallback must be a no-op after a real event already ran.
    await act(async () => { await vi.advanceTimersByTimeAsync(HANGUP_FALLBACK_MS + 500); });
    vi.useRealTimers();

    const completedPatches = fetchMock.mock.calls.filter(([u, i]) => {
      const opts = i as { method?: string; body?: string } | undefined;
      if (!String(u).includes('/calls/call-1')) return false;
      if (opts?.method !== 'PATCH') return false;
      const body = opts.body ? (JSON.parse(opts.body) as { status?: string }) : {};
      return body.status === 'completed';
    });
    expect(completedPatches).toHaveLength(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('hang up with NO event reaches wrap-up after the fallback', async () => {
    stubOutboundFetch();
    const connection = await placeOutboundCall();

    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle('End call'));
    expect(document.querySelector('.wrapup')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(HANGUP_FALLBACK_MS); });
    vi.useRealTimers();

    expect(document.querySelector('.wrapup')).toBeTruthy();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});
