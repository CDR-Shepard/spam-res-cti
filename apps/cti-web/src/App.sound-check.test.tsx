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

class FakeDevice {
  static instances: FakeDevice[] = [];
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

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.registerFor = null;
  localStorage.clear();
  pending = null;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/dev-session')) return jsonResponse({ error: 'Not found' }, 404);
    if (url.includes('/auth/me')) return jsonResponse(ME);
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/mobile/devices')) return jsonResponse({ devices: [] });
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
