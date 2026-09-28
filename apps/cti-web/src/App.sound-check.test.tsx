/** @vitest-environment jsdom */
/**
 * The sound check wired into App (spec decision 6):
 *   - it is due after a reset until "Looks good";
 *   - it is never shown on the sign-in screen, and never over a ringing call
 *     (the mic is released while it is hidden);
 *   - Settings can open it;
 *   - Settings → Reset my audio clears both picks, builds a fresh Device when
 *     idle (otherwise it switches the live Device back to System default),
 *     and opens the check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import * as opencti from './opencti';

function fakeOutputs() {
  let active = new Set<{ deviceId: string }>();
  return {
    get: () => active,
    set: vi.fn(async (id: string) => { active = new Set([{ deviceId: id }]); }),
  };
}

/** `device.audio`, with a Jabra headset both ways (copied from App.test.tsx). */
function fakeDeviceAudio() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const audio = {
    availableInputDevices: new Map([['default', { deviceId: 'default' }], ['mic-jabra', { deviceId: 'mic-jabra' }]]),
    availableOutputDevices: new Map([['default', { deviceId: 'default' }], ['spk-jabra', { deviceId: 'spk-jabra' }]]),
    inputDevice: null as { deviceId: string } | null,
    isOutputSelectionSupported: true,
    setInputDevice: vi.fn(async (id: string) => { audio.inputDevice = { deviceId: id }; }),
    unsetInputDevice: vi.fn(async () => { audio.inputDevice = null; }),
    speakerDevices: fakeOutputs(),
    ringtoneDevices: fakeOutputs(),
    on: (event: string, cb: (...args: unknown[]) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    emit: (event: string, ...args: unknown[]) => { for (const cb of listeners.get(event) ?? []) cb(...args); },
  };
  return audio;
}

class FakeConnection {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  disconnect = vi.fn();
  parameters: Record<string, string> = { CallSid: 'CA_1' };
  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

class FakeDevice {
  static instances: FakeDevice[] = [];
  static connects: FakeConnection[] = [];
  /** register() for the n-th Device built (0-based); resolved when unset. */
  static registerFor: ((n: number) => Promise<void>) | null = null;
  audio = fakeDeviceAudio();
  destroyed = false;
  private readonly n: number;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_token: string, _opts: unknown) { this.n = FakeDevice.instances.length; FakeDevice.instances.push(this); }
  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  register(): Promise<void> { return FakeDevice.registerFor?.(this.n) ?? Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { this.destroyed = true; }
  async connect(): Promise<FakeConnection> {
    const c = new FakeConnection();
    FakeDevice.connects.push(c);
    return c;
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const ME = {
  user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: false },
  salesforce: { connected: false },
};
const SESSION = JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' });
const PENDING = { id: 'call-9', toNumber: '+16195551234', fromNumber: '+16195559999', durationSeconds: 30, status: 'completed', notes: '' };
let pending: typeof PENDING | null;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

/** Chrome with the mic Allowed: a Permissions API, getUserMedia and an AudioContext. */
function grantMic(): { opened: () => number; stopped: () => number } {
  let opened = 0;
  let stopped = 0;
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: async () => ({ state: 'granted', addEventListener: () => {}, removeEventListener: () => {} }) },
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => [],
      getUserMedia: async () => { opened += 1; return { getTracks: () => [{ stop: () => { stopped += 1; } }] }; },
    },
  });
  vi.stubGlobal('AudioContext', class {
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData: (a: Float32Array) => { a.fill(0.1); } }; }
    close() { return Promise.resolve(); }
  });
  return { opened: () => opened, stopped: () => stopped };
}

const ALLOW_VERDICT = {
  decision: 'ALLOW', reasons: [], blockReason: null, requiredScriptId: null, auditId: 'audit-1',
  checks: [], normalizedTo: '+16195551234', fromNumber: '+16195559999',
};
/** The run's server status: `ready` until Start dialing sends `start`. */
let runStatus: 'ready' | 'active' = 'ready';
/** What /firewall/precall answers. */
let verdict: { decision: string } = ALLOW_VERDICT;
/** /telephony/token answers 401 once set (a dead session). */
let sessionDead = false;
/** The next this-many /telephony/token calls fail with a 500 (Twilio/API trouble). */
let tokenFailures = 0;
/** When set, the next /telephony/token call waits on it (a hung request). */
let holdNextToken: Promise<void> | null = null;
const runView = () => ({
  session: { id: 'sess-1', status: runStatus },
  counts: { total: 1, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
  currentItem: null,
  firstPassTotal: 1,
});

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.connects.length = 0;
  FakeDevice.registerFor = null;
  localStorage.clear();
  pending = null;
  runStatus = 'ready';
  verdict = ALLOW_VERDICT;
  sessionDead = false;
  tokenFailures = 0;
  holdNextToken = null;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/auth/dev-session')) return jsonResponse({ error: 'Not found' }, 404);
    if (url.includes('/auth/me')) return jsonResponse(ME);
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending });
    if (url.includes('/telephony/token') && tokenFailures > 0) { tokenFailures -= 1; return jsonResponse({ error: 'boom' }, 500); }
    if (url.includes('/telephony/token') && holdNextToken) { const held = holdNextToken; holdNextToken = null; await held; }
    if (url.includes('/telephony/token')) return sessionDead ? jsonResponse({ error: 'Unauthorized' }, 401) : jsonResponse({ token: 'device-token' });
    if (url.includes('/mobile/devices')) return jsonResponse({ devices: [] });
    if (url.includes('/firewall/precall')) return jsonResponse(verdict);
    if (url.includes('/auth/salesforce/login/start')) return jsonResponse({ authUrl: 'https://login.example.com/x', handshake: 'h1' });
    if (url.includes('/auth/salesforce/login/status')) {
      return jsonResponse({ status: 'connected', token: 'tok2', user: { id: 'u1', email: 'rep@example.com' } });
    }
    if (method === 'POST' && url.endsWith('/calls')) {
      return jsonResponse({ call: { id: 'call-1', fromNumber: '+16195559999', toNumber: '+16195551234', normalizedToNumber: '+16195551234' } });
    }
    if (url.includes('/dialer/handoffs/pending')) return jsonResponse({ handoff: null });
    if (url.includes('/dialer/sessions/sess-1/start')) { runStatus = 'active'; return jsonResponse({ ok: true }); }
    if (/\/dialer\/sessions\/sess-1\/\w+/.test(url)) return jsonResponse({ ok: true });
    if (url.includes('/dialer/sessions/sess-1')) return jsonResponse(runView());
    if (method === 'POST' && url.includes('/dialer/sessions')) return jsonResponse({ sessionId: 'sess-1', total: 1 });
    return jsonResponse({});
  }));
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete (navigator as unknown as Record<string, unknown>).permissions;
  delete (navigator as unknown as Record<string, unknown>).mediaDevices;
});

const dialog = () => screen.queryByRole('dialog', { name: 'Sound check' });
const signedIn = (): void => { localStorage.setItem('cti.session.v1', SESSION); };

describe('App — the sound check after a reset', () => {
  it('is never shown on the sign-in screen', async () => {
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await screen.findByText('Sign in with Salesforce');
    expect(dialog()).toBeNull();
  });

  it('opens once the rep is signed in', async () => {
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
  });

  // Task 3 review I2: the dialpad's global keyboard shortcuts used to run
  // behind the overlay — digits, then Enter (check), then Enter (POST /calls).
  it('is modal for the keyboard: digits and Enter behind it dial nothing, and Enter on its buttons is not swallowed', async () => {
    const fetchMock = vi.mocked(fetch);
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    const later = await screen.findByRole('button', { name: 'Not now' });
    for (const key of ['5', '5', '5', '1', '2', '3', '4', 'Enter', 'Enter']) fireEvent.keyDown(window, { key });
    await act(async () => { await Promise.resolve(); });
    const dialed = fetchMock.mock.calls.filter(([u]) => /\/firewall\/precall|\/calls$/.test(String(u)));
    expect(dialed).toEqual([]);
    expect(fireEvent.keyDown(later, { key: 'Enter' })).toBe(true); // default action (click) not prevented
    fireEvent.keyDown(later, { key: 'Escape' }); // Escape = "Not now"
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('cti.soundCheck.due')).toBe('1');
  });

  it('"Not now" closes it and keeps it due for the next load', async () => {
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await screen.findByRole('dialog', { name: 'Sound check' });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('cti.soundCheck.due')).toBe('1');
  });

  // Task 3 review I1: a due check opens on its own, in any softphone load —
  // a background tab, a collapsed utility panel. It never opens the mic by
  // itself, and it surfaces the panel so the rep sees it.
  it('never opens the mic by itself: nothing until "Start sound check"; and it pops the Salesforce panel open', async () => {
    const mic = grantMic();
    const panel = vi.spyOn(opencti, 'setPanelVisibility').mockImplementation(() => {});
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    const start = await screen.findByRole('button', { name: 'Start sound check' });
    expect(panel).toHaveBeenCalledWith(true);
    await act(async () => { await Promise.resolve(); });
    expect(mic.opened()).toBe(0);
    fireEvent.click(start);
    await screen.findByRole('progressbar', { name: 'Microphone level' });
    await waitFor(() => expect(mic.opened()).toBe(1));
  });

  // Re-review item 1: the real load order. /auth/me lands first (the check
  // comes on screen, and its effect finds no window.sforce yet); Open CTI's
  // script loads after. The panel must still be surfaced — once Open CTI is up.
  it('inside Salesforce, the panel pops for a due check although Open CTI loads after /auth/me', async () => {
    const setSoftphonePanelVisibility = vi.fn();
    let loadOpenCti: () => void = () => {};
    vi.spyOn(opencti, 'initOpenCti').mockImplementation(() => new Promise((resolve) => {
      loadOpenCti = () => {
        (window as unknown as { sforce: unknown }).sforce = {
          opencti: {
            setSoftphonePanelVisibility,
            setSoftphonePanelHeight: vi.fn(),
            notifyInitializationComplete: vi.fn(),
            enableClickToDial: vi.fn(),
            onClickToDial: vi.fn(),
          },
        };
        resolve({ ready: true });
      };
    }));
    try {
      signedIn();
      localStorage.setItem('cti.soundCheck.due', '1');
      render(<App />);
      await screen.findByRole('dialog', { name: 'Sound check' }); // /auth/me is in; Open CTI is not
      await waitFor(() => expect(opencti.initOpenCti).toHaveBeenCalled());
      expect(setSoftphonePanelVisibility).not.toHaveBeenCalled();
      await act(async () => { loadOpenCti(); });
      await waitFor(() => expect(setSoftphonePanelVisibility).toHaveBeenCalledWith({ visible: true }));
    } finally {
      delete (window as unknown as { sforce?: unknown }).sforce;
    }
  });

  it('"Looks good" finishes it: the flag is cleared and the microphone released', async () => {
    const mic = grantMic();
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start sound check' }));
    await screen.findByRole('progressbar', { name: 'Microphone level' });
    await waitFor(() => expect(mic.opened()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
    expect(dialog()).toBeNull();
    expect(localStorage.getItem('cti.soundCheck.due')).toBeNull();
    await waitFor(() => expect(mic.stopped()).toBe(1));
  });

  it('a ringing callback hides it and releases the mic; it comes back once the call is gone — asking to Start again', async () => {
    const mic = grantMic();
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Start sound check' }));
    await waitFor(() => expect(mic.opened()).toBe(1));
    const call = { parameters: { From: '+16195551234' }, customParameters: new Map<string, string>(), accept: vi.fn(), reject: vi.fn(), on: vi.fn() };
    act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
    await screen.findByTitle('Decline');
    expect(dialog()).toBeNull();
    await waitFor(() => expect(mic.stopped()).toBe(1));
    fireEvent.click(screen.getByTitle('Decline'));
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Start sound check' })).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(mic.opened()).toBe(1); // nothing re-opened by itself
  });
});

describe('App — Settings', () => {
  it('Run sound check opens it without making it due — and, being a click, starts the meter at once', async () => {
    const mic = grantMic();
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run sound check' }));
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
    await screen.findByRole('progressbar', { name: 'Microphone level' });
    await waitFor(() => expect(mic.opened()).toBe(1));
    expect(screen.queryByRole('button', { name: 'Start sound check' })).toBeNull();
    expect(localStorage.getItem('cti.soundCheck.due')).toBeNull();
  });

  it('Reset my audio (idle): both picks cleared, a fresh Device, and the check opens — never a sign-out', async () => {
    signedIn();
    localStorage.setItem('cti.audio.input', 'mic-jabra');
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset my audio' }));
    expect(localStorage.getItem('cti.audio.input')).toBeNull();
    expect(localStorage.getItem('cti.audio.output')).toBeNull();
    await waitFor(() => expect(FakeDevice.instances.length).toBe(2));
    expect(FakeDevice.instances[0]!.destroyed).toBe(true);
    expect(FakeDevice.instances[1]!.destroyed).toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
    expect(localStorage.getItem('cti.session.v1')).toBe(SESSION);
  });

  // Task 2's isBusyForReset follows controller ruling R1 (its cti-reset.ts
  // docstring): an old pendingDisposition banner that is NOT the open
  // wrap-up form does not block a reset — only phase 'wrapup' does, and this
  // banner (fetched from the server, never reopened) leaves phase 'idle'.
  // Reset my audio shares that same resetBusy(), so it rebuilds here exactly
  // as the plain-idle case does; the banner itself (pendingDisp state) is
  // untouched by the Device rebuild.
  it('Reset my audio with only an old pending-disposition banner (not the open wrap-up form): rebuilds like idle — R1 says a stale disposition never blocks a reset', async () => {
    pending = PENDING;
    signedIn();
    localStorage.setItem('cti.audio.input', 'mic-jabra');
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const audio = FakeDevice.instances[0]!.audio;
    await waitFor(() => expect(audio.setInputDevice).toHaveBeenCalledWith('mic-jabra'));
    await screen.findByText(/needs a disposition/);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset my audio' }));
    expect(localStorage.getItem('cti.audio.input')).toBeNull();
    expect(localStorage.getItem('cti.audio.output')).toBeNull();
    await waitFor(() => expect(FakeDevice.instances.length).toBe(2));
    expect(FakeDevice.instances[0]!.destroyed).toBe(true);
    expect(FakeDevice.instances[1]!.destroyed).toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
    // The banner survives the rebuild — it's App's pendingDisp state, unrelated to the Device.
    expect(await screen.findByText(/needs a disposition/)).toBeTruthy();
  });

  // Follow-up 3 (final review): "Inbound calls unavailable" — the Device
  // failed to build, so there is none — is exactly when a rep presses Reset
  // my audio. It must build one, not only clear the picks.
  it('Reset my audio with NO Device (its build failed): builds a fresh one', async () => {
    tokenFailures = 1;
    signedIn();
    render(<App />);
    await screen.findByText(/Inbound calls unavailable/);
    expect(FakeDevice.instances.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset my audio' }));
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    expect(FakeDevice.instances[0]!.destroyed).toBe(false);
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
    expect(screen.getByText('Microphone and speaker are back to System default.')).toBeTruthy();
  });

  it('Reset my audio while the first build hangs on its token: a fresh build, not stuck behind the hung one', async () => {
    let release: () => void = () => {};
    holdNextToken = new Promise<void>((resolve) => { release = resolve; });
    const tokenCalls = (): number => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/telephony/token')).length;
    signedIn();
    render(<App />);
    await waitFor(() => expect(tokenCalls()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset my audio' }));
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    expect(tokenCalls()).toBe(2);

    await act(async () => { release(); }); // the hung build resumes, superseded: it builds nothing
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    expect(FakeDevice.instances.length).toBe(1);
    expect(FakeDevice.instances[0]!.destroyed).toBe(false);
    expect(screen.queryByText(/Inbound calls unavailable/)).toBeNull();
  });

  // The first Device is still registering when Reset my audio tears it down
  // and builds a second. The first build then fails: it may destroy only its
  // own Device, never the new one — and, being superseded, it says nothing.
  it('Reset my audio mid-registration: the old build failing later never destroys the new Device, and never toasts', async () => {
    let failFirst: (e: Error) => void = () => {};
    FakeDevice.registerFor = (n) => (n === 0 ? new Promise<void>((_resolve, reject) => { failFirst = reject; }) : Promise.resolve());
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset my audio' }));
    await waitFor(() => expect(FakeDevice.instances.length).toBe(2));
    expect(FakeDevice.instances[0]!.destroyed).toBe(true);

    await act(async () => { failFirst(new Error('registration failed')); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    expect(FakeDevice.instances[1]!.destroyed).toBe(false);
    expect(screen.queryByText(/Inbound calls unavailable/)).toBeNull();

    // The new Device is still the one App holds: the next Reset my audio tears IT down.
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset my audio' }));
    await waitFor(() => expect(FakeDevice.instances.length).toBe(3));
    expect(FakeDevice.instances[1]!.destroyed).toBe(true);
  });
});

/** Dial a number on the pad; a rep's ALLOW verdict places the call at once. */
function dialDigits(digits: string): void {
  for (const d of digits) {
    const key = Array.from(document.querySelectorAll('.dialpad .key')).find((b) => b.querySelector('.num')?.textContent === d);
    if (!key) throw new Error(`no dial pad key for "${d}"`);
    fireEvent.click(key);
  }
}

// Task 3 review I3: the guards that keep the sound check and Reset my audio
// off a live call.
describe('App — the sound check and Reset my audio never touch a live call', () => {
  it('Reset my audio with a call still up (a Device error dropped it to preflight): no second Device, nothing hung up — the live Device goes to System default', async () => {
    signedIn();
    localStorage.setItem('cti.audio.input', 'mic-jabra');
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const device = FakeDevice.instances[0]!;
    dialDigits('6195551234');
    fireEvent.click(screen.getByTitle('Check & call'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
    const call = FakeDevice.connects[0]!;
    act(() => { device.emit('error', { code: 31005, message: 'websocket closed' }); }); // ringing → preflight, call still up
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' })); // the nav is back: Settings is reachable
    device.audio.unsetInputDevice.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset my audio' }));
    await waitFor(() => expect(device.audio.unsetInputDevice).toHaveBeenCalled());
    await waitFor(() => expect(device.audio.speakerDevices.set).toHaveBeenCalledWith('default'));
    expect(device.audio.ringtoneDevices.set).toHaveBeenCalledWith('default');
    expect(FakeDevice.instances.length).toBe(1);
    expect(device.destroyed).toBe(false);
    expect(call.disconnect).not.toHaveBeenCalled();
    expect(localStorage.getItem('cti.audio.input')).toBeNull();
  });

  it('an answered call hides the check (not only a ringing one); it comes back once the call ends', async () => {
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run sound check' }));
    await screen.findByRole('dialog', { name: 'Sound check' });
    const listeners = new Map<string, Array<() => void>>();
    const call = {
      parameters: { From: '+16195551234' }, customParameters: new Map<string, string>(), accept: vi.fn(), reject: vi.fn(),
      on: (e: string, cb: () => void) => { listeners.set(e, [...(listeners.get(e) ?? []), cb]); },
    };
    act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
    fireEvent.click(await screen.findByTitle('Answer'));
    await screen.findByTitle('End call');
    expect(dialog()).toBeNull();
    act(() => { for (const cb of listeners.get('disconnect') ?? []) cb(); });
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
  });

  it('a live power-dial run hides the check', async () => {
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    await screen.findByRole('dialog', { name: 'Sound check' });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window.parent,
        data: { type: 'POWER_DIAL', objectType: 'Lead', recordIds: ['00Q000000000001'] },
      }));
    });
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(1)); // the leg joined: the run is live
    await waitFor(() => expect(dialog()).toBeNull());
  });
});

// Follow-up 2 (final review): after a reset every tab of the rep has the check
// due. "Looks good" in one tab finishes it for all of them.
describe('App — a sound check finished in another tab', () => {
  /** Another tab clears the flag: this tab hears a storage event. */
  const otherTabFinishes = (): void => {
    act(() => {
      localStorage.removeItem('cti.soundCheck.due');
      window.dispatchEvent(new StorageEvent('storage', { key: 'cti.soundCheck.due', newValue: null }));
    });
  };

  it('is not shown when the flag is gone by the time /auth/me loads', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    let meIn: () => void = () => {};
    const meGate = new Promise<void>((resolve) => { meIn = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/auth/me')) await meGate;
      return base(input, init);
    });
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await screen.findByText('Loading…');
    localStorage.removeItem('cti.soundCheck.due'); // "Looks good" elsewhere, while this tab loads
    await act(async () => { meIn(); });
    await screen.findByRole('button', { name: 'Settings' });
    await act(async () => { await Promise.resolve(); });
    expect(dialog()).toBeNull();
  });

  it('closes a due check the moment another tab finishes it', async () => {
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await screen.findByRole('dialog', { name: 'Sound check' });
    otherTabFinishes();
    expect(dialog()).toBeNull();
  });

  it('closes it too when another tab clears all of storage', async () => {
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await screen.findByRole('dialog', { name: 'Sound check' });
    act(() => {
      localStorage.removeItem('cti.soundCheck.due');
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(dialog()).toBeNull();
  });

  it('a check the rep opened from Settings stays open', async () => {
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run sound check' }));
    await screen.findByRole('dialog', { name: 'Sound check' });
    otherTabFinishes();
    expect(dialog()).not.toBeNull();
  });

  it('another tab setting the flag, or another key, leaves a due check alone', async () => {
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await screen.findByRole('dialog', { name: 'Sound check' });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'cti.soundCheck.due', newValue: '1' })); });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'cti.audio.input', newValue: 'mic-jabra' })); });
    expect(dialog()).not.toBeNull();
  });
});

// Task 3 review M-e and M-h.
describe('App — the sound check around the rest of the softphone', () => {
  it("hides while a click-to-dial verdict is on screen (preflight), and comes back after", async () => {
    let clickToDial: (e: opencti.ClickToDialEvent) => void = () => {};
    vi.spyOn(opencti, 'initOpenCti').mockResolvedValue({ ready: true });
    vi.spyOn(opencti, 'onClickToDial').mockImplementation((handler) => { clickToDial = handler; });
    vi.spyOn(opencti, 'notifyReady').mockImplementation(() => {});
    vi.spyOn(opencti, 'setPanelHeight').mockImplementation(() => {});
    vi.spyOn(opencti, 'setPanelVisibility').mockImplementation(() => {});
    verdict = { ...ALLOW_VERDICT, decision: 'BLOCK' }; // a rep's refusal: the verdict stays up
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await screen.findByRole('dialog', { name: 'Sound check' });
    await waitFor(() => expect(opencti.onClickToDial).toHaveBeenCalled());
    await act(async () => { clickToDial({ number: '+16195551234' }); });
    await screen.findByText(/can.t call this number/);
    expect(dialog()).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' }); // clear the verdict: back to idle
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
  });

  // Re-review item 3 (M13w): wrap-up is reachable with a due check open —
  // click-to-dial hides it, the rep calls, then hangs up.
  it('never covers the wrap-up form: hidden through the call and its wrap-up, back once the call is logged', async () => {
    let clickToDial: (e: opencti.ClickToDialEvent) => void = () => {};
    vi.spyOn(opencti, 'initOpenCti').mockResolvedValue({ ready: true });
    vi.spyOn(opencti, 'onClickToDial').mockImplementation((handler) => { clickToDial = handler; });
    vi.spyOn(opencti, 'notifyReady').mockImplementation(() => {});
    vi.spyOn(opencti, 'setPanelHeight').mockImplementation(() => {});
    vi.spyOn(opencti, 'setPanelVisibility').mockImplementation(() => {});
    signedIn();
    localStorage.setItem('cti.soundCheck.due', '1');
    render(<App />);
    await screen.findByRole('dialog', { name: 'Sound check' });
    await waitFor(() => expect(opencti.onClickToDial).toHaveBeenCalled());
    await act(async () => { clickToDial({ number: '+16195551234' }); }); // ALLOW: a rep's call is placed at once
    await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
    expect(dialog()).toBeNull();
    act(() => { FakeDevice.connects[0]!.emit('disconnect'); }); // the call ends: wrap-up
    await screen.findByText('Log call');
    expect(dialog()).toBeNull();
    fireEvent.click(screen.getByText('Log call'));
    expect(await screen.findByRole('dialog', { name: 'Sound check' })).toBeTruthy();
  });

  it('closing the check never throws away an unsaved Settings draft', async () => {
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const forward = await screen.findByPlaceholderText('+1 555 010 0123 (your mobile)') as HTMLInputElement;
    fireEvent.change(forward, { target: { value: '+16195550000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run sound check' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(dialog()).toBeNull();
    expect((screen.getByPlaceholderText('+1 555 010 0123 (your mobile)') as HTMLInputElement).value).toBe('+16195550000');
  });

  it('a sign-out closes it: signing back in does not bring it back', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run sound check' }));
    await screen.findByRole('dialog', { name: 'Sound check' });
    sessionDead = true;
    act(() => { FakeDevice.instances[0]!.emit('tokenWillExpire'); });
    fireEvent.click(await screen.findByText('Sign in with Salesforce'));
    sessionDead = false;
    await screen.findByRole('button', { name: 'Settings' });
    await act(async () => { await Promise.resolve(); });
    expect(dialog()).toBeNull();
  });
});
