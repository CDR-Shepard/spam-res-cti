/** @vitest-environment jsdom */
/**
 * Reset CTI in the real App (spec 2026-09-28): the reset poller in a signed-in
 * tab, the order of a reset, that it waits out a ringing call, that a 401 on
 * the poll is never a sign-out, and the sign-in notice after the reload.
 * Only @twilio/voice-sdk and fetch are faked; the coordinator is real (a lone
 * tab leads). jsdom's location can't be spied, so App reloads through
 * cti-reset.ts `pageReloader`, which these tests spy on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { pageReloader, RESET_NOTICE_TEXT } from './cti-reset';
import * as opencti from './opencti';

const events: string[] = [];

class FakeDevice {
  static instances: FakeDevice[] = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_token: string, _opts: unknown) { FakeDevice.instances.push(this); }
  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { events.push('device destroyed'); }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const ME = {
  user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: false },
  salesforce: { connected: false },
};
const SESSION = JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' });

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

let resetSignal: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeDevice.instances.length = 0;
  events.length = 0;
  localStorage.clear();
  resetSignal = () => jsonResponse({ resetDue: false });
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/auth/reset-signal')) return resetSignal();
    if (url.includes('/auth/reset-complete') && method === 'POST') {
      events.push(localStorage.getItem('cti.session.v1') ? 'reset-complete (session still stored)' : 'reset-complete (session already gone)');
      return jsonResponse({ ok: true });
    }
    if (url.includes('/auth/dev-session')) return jsonResponse({ error: 'Not found' }, 404);
    if (url.includes('/auth/salesforce/login/start')) return jsonResponse({ authUrl: 'https://login.example.com/x', handshake: 'h1' });
    if (url.includes('/auth/salesforce/login/status')) {
      return jsonResponse({ status: 'connected', token: 'tok2', user: { id: 'u1', email: 'rep@example.com' } });
    }
    if (url.includes('/auth/me')) return jsonResponse(ME);
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(pageReloader, 'reload').mockImplementation(() => {
    events.push(localStorage.getItem('cti.session.v1') === null ? 'reload (wiped)' : 'reload (NOT wiped)');
  });
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const signedIn = (): void => { localStorage.setItem('cti.session.v1', SESSION); };
const callsTo = (path: string): number => fetchMock.mock.calls.filter(([u]) => String(u).includes(path)).length;
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('App — an idle rep with a reset due', () => {
  it('waits for the coordinator to hear its peers, then: Device down → reset-complete (old session) → wipe + flags → reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    localStorage.setItem('cti.displayName', 'Ada');
    localStorage.setItem('cti.audio.input', 'mic-jabra');
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    localStorage.setItem('unrelated', 'kept');
    resetSignal = () => jsonResponse({ resetDue: true });
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));

    await advance(2_500);
    expect(events).toEqual([]); // a freshly loaded tab never acts before it knows its peers

    await advance(6_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)', 'reload (wiped)']);
    for (const k of ['cti.session.v1', 'cti.displayName', 'cti.audio.input', 'cti.audio.output']) expect(localStorage.getItem(k)).toBeNull();
    expect(localStorage.getItem('cti.soundCheck.due')).toBe('1');
    expect(localStorage.getItem('cti.reset.notice')).toBe('1');
    expect(localStorage.getItem('unrelated')).toBe('kept');
    expect(callsTo('/auth/reset-complete')).toBe(1);
  });
});

describe('App — a reset never interrupts a call', () => {
  it('waits while a callback rings, then resets once the rep declines it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    resetSignal = () => jsonResponse({ resetDue: true });
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const call = {
      parameters: { From: '+16195551234' },
      customParameters: new Map<string, string>(),
      accept: vi.fn(),
      reject: vi.fn(),
      on: vi.fn(),
    };
    act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
    await screen.findByTitle('Decline');

    await advance(30_000);
    expect(events).toEqual([]);
    expect(callsTo('/auth/reset-complete')).toBe(0);
    expect(pageReloader.reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Decline'));
    await advance(8_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)', 'reload (wiped)']);
  });
});

describe('App — the reset poll never signs anyone out', () => {
  it('a 401 on reset-signal is ignored: the Device stays, the rep stays signed in, and it polls again 20 s later', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    resetSignal = () => jsonResponse({ error: 'Unauthorized' }, 401);
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    await waitFor(() => expect(callsTo('/auth/reset-signal')).toBe(1));
    await advance(21_000);
    expect(callsTo('/auth/reset-signal')).toBe(2);
    expect(events).toEqual([]);
    expect(screen.queryByText('Sign in with Salesforce')).toBeNull();
    expect(localStorage.getItem('cti.session.v1')).toBe(SESSION);
  });

  it('no reset pending: one poll on sign-in and one every 20 s — nothing else happens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    await waitFor(() => expect(callsTo('/auth/reset-signal')).toBe(1));
    await advance(41_000);
    expect(callsTo('/auth/reset-signal')).toBe(3);
    expect(events).toEqual([]);
    expect(callsTo('/auth/reset-complete')).toBe(0);
  });
});

describe('App — after a reset, the sign-in screen says why', () => {
  it('shows the notice when the flag is set', async () => {
    localStorage.setItem('cti.reset.notice', '1');
    render(<App />);
    expect(await screen.findByText('Sign in with Salesforce')).toBeTruthy();
    expect(screen.getByText(RESET_NOTICE_TEXT)).toBeTruthy();
  });

  it('no flag, no notice', async () => {
    render(<App />);
    await screen.findByText('Sign in with Salesforce');
    expect(screen.queryByText(RESET_NOTICE_TEXT)).toBeNull();
  });

  it('signing in clears the notice and its flag', async () => {
    localStorage.setItem('cti.reset.notice', '1');
    vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<App />);
    fireEvent.click(await screen.findByText('Sign in with Salesforce'));
    await waitFor(() => expect(localStorage.getItem('cti.reset.notice')).toBeNull());
    await waitFor(() => expect(screen.queryByText(RESET_NOTICE_TEXT)).toBeNull());
    expect(JSON.parse(localStorage.getItem('cti.session.v1')!).token).toBe('tok2');
  });
});
