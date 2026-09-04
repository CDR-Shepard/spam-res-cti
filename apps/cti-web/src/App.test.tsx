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
import { App } from './App';
import * as opencti from './opencti';
import type { IncomingCallLike } from './incoming-accept';

/** Minimal fake incoming call: matches what App.tsx's TwilioIncomingCall needs. */
interface FakeIncomingCall extends IncomingCallLike {
  accept: () => void;
  reject: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

function fakeCall(overrides: Pick<IncomingCallLike, 'parameters' | 'customParameters'>): FakeIncomingCall {
  return {
    ...overrides,
    accept: vi.fn(),
    reject: vi.fn(),
    on: vi.fn(),
  };
}

/** Fake Twilio Device — captures the `on('incoming', ...)` handler App.tsx's
 *  ensureDevice() wires up, so a test can simulate a ring without a real
 *  Device/WebRTC stack. Constructed the moment ensureDevice() runs (this
 *  instance becomes the softphone leader on mount, with no peers to contest
 *  it), mirroring the real @twilio/voice-sdk Device shape App.tsx relies on. */
class FakeDevice {
  static instances: FakeDevice[] = [];
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
