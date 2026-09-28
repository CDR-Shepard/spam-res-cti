/** @vitest-environment jsdom */
/**
 * Pins App.tsx's WIRING of the run-settings feature (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md, review fix
 * Important 3d): `/auth/me`'s `dialerRunDefaults` reaches DialerPanel's
 * `runDefaults` prop, and a Start the server accepts triggers exactly ONE
 * `/auth/me` re-read (not zero — the rep's saved choices would go stale — and
 * not more than one, which would just be extra load for nothing). The pieces
 * are pinned at the pure/SSR/mounted-DialerPanel level in run-settings.test.ts
 * and DialerPanel.run-settings.test.tsx; this file only pins the App-level
 * call sites those cannot reach (real `/auth/me` fetch, real App state).
 *
 * Same harness idiom as App.dialer-leg.test.tsx: real App, fake Twilio SDK,
 * fake fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import * as opencti from './opencti';
import * as coordinator from './softphone-coordinator';

class FakeTrack {
  private handlers = new Map<string, Array<() => void>>();
  addEventListener(event: string, cb: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  fire(event: string): void { for (const cb of this.handlers.get(event) ?? []) cb(); }
}

class FakeConnection {
  private handlers = new Map<string, Array<() => void>>();
  disconnect = vi.fn(() => { this.emit('disconnect'); });
  micTrack = new FakeTrack();
  getLocalStream(): { getAudioTracks: () => FakeTrack[] } { return { getAudioTracks: () => [this.micTrack] }; }
  on(event: string, cb: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string): void { for (const cb of this.handlers.get(event) ?? []) cb(); }
}

class FakeDevice {
  static instances: FakeDevice[] = [];
  static connects: Array<{ params: Record<string, string>; connection: FakeConnection }> = [];
  private listeners = new Map<string, Array<(a?: unknown) => void>>();
  audio = {
    availableInputDevices: new Map([['default', { deviceId: 'default' }]]),
    inputDevice: null as { deviceId: string } | null,
    setInputDevice: vi.fn(async (id: string) => { FakeDevice.instances[0]!.audio.inputDevice = { deviceId: id }; }),
    on: vi.fn(),
  };
  constructor(_token: string, _opts: unknown) { FakeDevice.instances.push(this); }
  on(event: string, cb: (a?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, arg?: unknown): void { for (const cb of this.listeners.get(event) ?? []) cb(arg); }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { /* not exercised */ }
  async connect(opts: { params: Record<string, string> }): Promise<FakeConnection> {
    const connection = new FakeConnection();
    FakeDevice.connects.push({ params: opts.params, connection });
    return connection;
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const state = {
  status: 'ready' as 'ready' | 'active' | 'stopped',
  controls: [] as string[],
  /** /auth/me's dialerRunDefaults — mutated by the test that checks the
   *  merge-then-refresh behavior is not exercised here (see Minor 2's own
   *  tests); here it just needs to be a fixed, non-default value so the
   *  wiring from fetch response to the DialerPanel prop is unambiguous. */
  dialerRunDefaults: { passes: 1, maxRecords: 50, rolloverBusinessDays: 2 } as
    { passes: 1 | 2; maxRecords: number | null; rolloverBusinessDays: 1 | 2 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

const VIEW = () => ({
  session: { id: 'sess-1', status: state.status },
  counts: { total: 1, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
  currentItem: null,
  firstPassTotal: 1,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.connects.length = 0;
  state.controls = [];
  state.status = 'ready';
  state.dialerRunDefaults = { passes: 1, maxRecords: 50, rolloverBusinessDays: 2 };
  const realDeps = coordinator.browserCoordinatorDeps;
  vi.spyOn(coordinator, 'browserCoordinatorDeps').mockImplementation((userId, getBusy) => realDeps(userId, getBusy));
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/me')) {
      return jsonResponse({
        user: {
          userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true,
          dialerRunDefaults: state.dialerRunDefaults,
        },
        salesforce: { connected: true },
      });
    }
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/dialer/handoffs/pending')) return jsonResponse({ handoff: null });
    const control = /\/dialer\/sessions\/sess-1\/(start|stop|pause|resume|skip|next)/.exec(url);
    if (control) {
      state.controls.push(control[1]!);
      if (control[1] === 'start') state.status = 'active';
      return jsonResponse({ ok: true });
    }
    if (url.includes('/dialer/sessions/sess-1')) return jsonResponse(VIEW());
    if (url.includes('/dialer/sessions') && init?.method === 'POST') return jsonResponse({ sessionId: 'sess-1', total: 1 });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function handOverRun(): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { type: 'POWER_DIAL', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    }));
  });
}

const authMeCallCount = (): number => fetchMock.mock.calls.filter(([u]) => String(u).includes('/auth/me')).length;

describe('App — run-settings wiring (review fix, Important 3d)', () => {
  it("passes /auth/me's dialerRunDefaults down to DialerPanel's runDefaults prop", async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    // state.dialerRunDefaults is { passes: 1, maxRecords: 50, rolloverBusinessDays: 2 } —
    // the Ready screen should reflect it, not today's run (Twice/All/next business day).
    await screen.findByRole('button', { name: 'Once' });
    expect(screen.getByRole('button', { name: 'Once' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'In 2 business days' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('50');
  });

  it('Start, once accepted, triggers exactly one more /auth/me re-read', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    await screen.findByText('Start dialing');
    const before = authMeCallCount();
    fireEvent.click(screen.getByText('Start dialing'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
    await waitFor(() => expect(authMeCallCount()).toBe(before + 1));
    // Give any stray extra call a moment to show up, then confirm there isn't one.
    await new Promise((r) => setTimeout(r, 200));
    expect(authMeCallCount()).toBe(before + 1);
  });
});
