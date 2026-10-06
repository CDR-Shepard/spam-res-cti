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

// Sweep D-12: these tests time out at the 5 s default under the full parallel root run (they pass alone); no logic change.
vi.setConfig({ testTimeout: 15_000 });

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
  /** Which session id POST /dialer/sessions hands back next — toggled to
   *  'sess-2' to start a SECOND run in the merge-survives-a-failed-refresh
   *  test below. */
  nextSessionId: 'sess-1',
  /** True for exactly one /auth/me call: it rejects instead of answering, so
   *  a test can prove a merge survives a refresh that fails. */
  failNextAuthMe: false,
  /** Milliseconds the NEXT /auth/me call is delayed before answering (then
   *  reset to 0) — proves a refresh is truly AWAITED before beginRun, not
   *  fired-and-forgotten (re-review fix, Minor: the refresh must land before
   *  the run it begins renders, not sometime after). */
  delayNextAuthMeMs: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

const VIEW = (id: string) => ({
  session: { id, status: id === 'sess-1' ? state.status : 'ready' },
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
  state.nextSessionId = 'sess-1';
  state.failNextAuthMe = false;
  state.delayNextAuthMeMs = 0;
  const realDeps = coordinator.browserCoordinatorDeps;
  vi.spyOn(coordinator, 'browserCoordinatorDeps').mockImplementation((userId, getBusy) => realDeps(userId, getBusy));
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/me')) {
      if (state.failNextAuthMe) { state.failNextAuthMe = false; throw new Error('network hiccup'); }
      if (state.delayNextAuthMeMs > 0) {
        const ms = state.delayNextAuthMeMs;
        state.delayNextAuthMeMs = 0;
        await new Promise((r) => setTimeout(r, ms));
      }
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
    if (url.includes('/dialer/salesforce/listviews')) return jsonResponse({ listViews: [{ id: 'lv1', label: 'My Leads', developerName: 'My_Leads' }] });
    const control = /\/dialer\/sessions\/sess-1\/(start|stop|pause|resume|skip|next)/.exec(url);
    if (control) {
      state.controls.push(control[1]!);
      if (control[1] === 'start') {
        state.status = 'active';
        // The real server saves Calls per person / How many / Missed tasks as
        // the rep's next defaults in the SAME request that flips the run
        // active (spec 2026-09-28) — mirrored here so a beginRun-triggered
        // refresh right after Start sees what was just accepted, not stale
        // mock state.
        if (init?.body) {
          try { state.dialerRunDefaults = JSON.parse(init.body); } catch { /* leave state.dialerRunDefaults as-is */ }
        }
      }
      return jsonResponse({ ok: true });
    }
    if (url.includes('/dialer/sessions/sess-2')) return jsonResponse(VIEW('sess-2'));
    if (url.includes('/dialer/sessions/sess-1')) return jsonResponse(VIEW('sess-1'));
    if (url.includes('/dialer/sessions') && init?.method === 'POST') return jsonResponse({ sessionId: state.nextSessionId, total: 1 });
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

function handOverRun(recordId = '00Q000000000001'): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { type: 'POWER_DIAL', objectType: 'Lead', recordIds: [recordId] },
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

  // Review fix (Minor 2): the accepted settings are merged into `me`
  // immutably BEFORE the follow-up /auth/me refresh — so this tab is right
  // even when that refresh fails outright.
  it('merges the accepted settings into `me` immutably, so a SECOND run starts from them even though the refresh after Start failed', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    // Change every setting away from state.dialerRunDefaults (1 / 50 / 2).
    fireEvent.click(await screen.findByRole('button', { name: 'Twice' }));
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next business day' }));
    state.failNextAuthMe = true; // the refresh Start triggers will reject
    fireEvent.click(screen.getByText('Start dialing'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
    await waitFor(() => expect(state.failNextAuthMe).toBe(false)); // the failing call happened
    // A second, independent run — its Ready screen must reflect what was
    // just accepted (Twice / 75 / Next business day), not the ORIGINAL
    // state.dialerRunDefaults (1 / 50 / 2) the failed refresh never updated.
    state.nextSessionId = 'sess-2';
    handOverRun('00Q000000000002');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Twice' })[0]?.getAttribute('aria-pressed')).toBe('true'));
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('75');
    expect(screen.getByRole('button', { name: 'Next business day' }).getAttribute('aria-pressed')).toBe('true');
  });

  // Review fix (Minor 2), STRENGTHENED by a re-review safety finding: a new
  // run refreshes /auth/me too, so a limit remembered from ANOTHER tab is
  // picked up. But the refresh used to be fire-and-forget inside beginRun
  // (`void refreshMe()`) — it usually landed too late to affect the very run
  // it was meant to freshen, since the per-session reseed effect reads
  // runDefaults SYNCHRONOUSLY the instant the new sessionId lands, and a
  // same-session runDefaults change is deliberately ignored (Important 3).
  // Pinned with a slow (150 ms) /auth/me: the run must still start from what
  // it returns, not whatever this tab had cached when the run began.
  it('a run begins from a fresh /auth/me, even a slow one — not what this tab had cached', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    // "Another tab saved 75" on the server, moments before this tab starts a
    // run — and this /auth/me round trip is slow.
    state.dialerRunDefaults = { passes: 1, maxRecords: 75, rolloverBusinessDays: 2 };
    state.delayNextAuthMeMs = 150;
    const before = authMeCallCount();
    handOverRun();
    await screen.findByText('Start dialing');
    expect(authMeCallCount()).toBeGreaterThan(before);
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('75');
  });

  // Same fix, same reasoning, the OTHER call site: starting from a picked
  // Salesforce list view (startPowerDialFromListView) rather than a
  // postMessage handoff (startPowerDial).
  it('starting from a Salesforce list view also awaits the /auth/me refresh before beginRun', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    fireEvent.click(screen.getByText('Power Dial'));
    await screen.findByText('Power dial a list');
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'lv1' } });
    state.dialerRunDefaults = { passes: 1, maxRecords: 75, rolloverBusinessDays: 2 };
    state.delayNextAuthMeMs = 150;
    fireEvent.click(screen.getByText('Dial this list'));
    await screen.findByText('Start dialing');
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('75');
  });
});
