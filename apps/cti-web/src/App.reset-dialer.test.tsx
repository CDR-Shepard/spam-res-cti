/** @vitest-environment jsdom */
/**
 * Reset CTI against a power-dial run, in the real App (spec 2026-09-28,
 * controller ruling R1): what of a run holds a reset back, and what must not
 * hold it back forever. Same harness idiom as App.dialer-leg.test.tsx (real
 * App, real coordinator — a lone tab leads — fake Twilio SDK, fake fetch),
 * plus the two reset routes and a spied `pageReloader`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { pageReloader } from './cti-reset';
import * as opencti from './opencti';

class FakeConnection {
  private handlers = new Map<string, Array<() => void>>();
  disconnect = vi.fn(() => { this.emit('disconnect'); });
  on(event: string, cb: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string): void { for (const cb of this.handlers.get(event) ?? []) cb(); }
}

class FakeDevice {
  static instances: FakeDevice[] = [];
  static connects: FakeConnection[] = [];
  destroyed = false;
  private listeners = new Map<string, Array<(a?: unknown) => void>>();
  constructor(_token: string, _opts: unknown) { FakeDevice.instances.push(this); }
  on(event: string, cb: (a?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, arg?: unknown): void { for (const cb of this.listeners.get(event) ?? []) cb(arg); }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { this.destroyed = true; }
  async connect(): Promise<FakeConnection> {
    const connection = new FakeConnection();
    FakeDevice.connects.push(connection);
    return connection;
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

type RunStatus = 'ready' | 'active' | 'paused' | 'stopped';

const state = {
  status: 'ready' as RunStatus,
  controls: [] as string[],
  /** Stop flips the server's status to `stopped` (false: the server still reads active). */
  stopChangesStatus: true,
  resetDue: false,
  /** When set, POST .../start waits on this before answering. */
  holdStart: null as Promise<Response> | null,
  /** The next POST /dialer/sessions answers with this run. */
  nextSessionId: 'sess-1',
  /** When set, POST /auth/reset-complete waits on this before answering. */
  holdResetComplete: null as Promise<void> | null,
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
  state.status = 'ready';
  state.controls = [];
  state.stopChangesStatus = true;
  state.resetDue = false;
  state.holdStart = null;
  state.nextSessionId = 'sess-1';
  state.holdResetComplete = null;
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/reset-signal')) return jsonResponse({ resetDue: state.resetDue });
    if (url.includes('/auth/reset-complete') && init?.method === 'POST') {
      if (state.holdResetComplete) await state.holdResetComplete;
      return jsonResponse({ ok: true });
    }
    if (url.includes('/auth/me')) {
      return jsonResponse({
        user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true },
        salesforce: { connected: true },
      });
    }
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/dialer/handoffs/pending')) return jsonResponse({ handoff: null });
    const control = /\/dialer\/sessions\/sess-1\/(start|stop|pause|resume|skip|next)/.exec(url);
    if (control) {
      state.controls.push(control[1]!);
      if (control[1] === 'start') {
        if (state.holdStart) return state.holdStart;
        state.status = 'active';
      }
      if (control[1] === 'stop' && state.stopChangesStatus) state.status = 'stopped';
      return jsonResponse({ ok: true });
    }
    if (url.includes('/dialer/sessions/sess-1')) return jsonResponse(VIEW());
    // sess-2's polls fail: the panel never replaces sess-1's last snapshot.
    if (url.includes('/dialer/sessions/sess-2')) return jsonResponse({ error: 'boom' }, 500);
    if (url.includes('/dialer/sessions') && init?.method === 'POST') return jsonResponse({ sessionId: state.nextSessionId, total: 1 });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(pageReloader, 'reload').mockImplementation(() => {});
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const callsTo = (path: string): number => fetchMock.mock.calls.filter(([u]) => String(u).includes(path)).length;
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** Hand the app a run the way Salesforce does (postMessage). */
function handOverRun(): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { type: 'POWER_DIAL', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    }));
  });
}

describe('App — C1: a reset and Start dialing never overlap', () => {
  // (c) Start dialing is prepare → start → join. Once `start` is accepted the
  // server may be ringing a prospect for a leg that has not joined yet.
  it('a start in flight holds the reset back; once it settles (here: refused), the reset goes ahead', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.resetDue = true;
    let answerStart: (r: Response) => void = () => {};
    state.holdStart = new Promise<Response>((resolve) => { answerStart = resolve; });
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(state.controls).toEqual(['start']));

    await advance(30_000);
    expect(callsTo('/auth/reset-complete')).toBe(0);
    expect(FakeDevice.instances[0]!.destroyed).toBe(false);

    act(() => { answerStart(jsonResponse({ error: 'boom' }, 500)); });
    await waitFor(() => expect(state.controls).toEqual(['start', 'stop'])); // the sequence stops what it started
    await advance(6_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(callsTo('/auth/reset-complete')).toBe(1);
  });

  // (a) The reset began first (a `ready` run's confirm screen is idle).
  it('Start dialing pressed mid-reset: refused with the one quiet line — no start, no Device', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.resetDue = true;
    let openPost: () => void = () => {};
    state.holdResetComplete = new Promise<void>((resolve) => { openPost = resolve; });
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    await screen.findByText('Start dialing');
    await advance(8_000);
    await waitFor(() => expect(FakeDevice.instances[0]!.destroyed).toBe(true));

    fireEvent.click(screen.getByText('Start dialing'));
    await waitFor(() => expect(screen.getAllByText('Resetting your phone…').length).toBe(2)); // the banner + the panel's line
    expect(state.controls).toEqual([]);
    expect(FakeDevice.instances.length).toBe(1);
    expect(document.querySelector('.toast')).toBeNull();

    act(() => { openPost(); });
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
  });
});

describe('App — reset vs a power-dial run: the run status App hands to isBusyForReset (R1)', () => {
  // No leg on this tab, not parked, nav unlocked: ONLY the run's own status
  // (the panel's poll) says a run is on. Paused counts; a terminal one doesn't.
  it('a run the server reports paused holds the reset back; once it is stopped, the reset goes ahead', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.status = 'paused';
    state.resetDue = true;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    await waitFor(() => expect(callsTo('/dialer/sessions/sess-1')).toBeGreaterThan(0));
    await advance(30_000);
    expect(callsTo('/auth/reset-complete')).toBe(0);
    expect(FakeDevice.connects.length).toBe(0);

    state.status = 'stopped'; // ended elsewhere: the next poll says so
    await advance(10_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(callsTo('/auth/reset-complete')).toBe(1);
  });
});

describe('App — reset vs a power-dial run (I1: Stop must not leave a stale "active" behind)', () => {
  it('after Stop, the last "active" poll no longer holds the reset back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Every poll says `active`, even the one Stop triggers — so whichever poll
    // lands last, the run snapshot App holds reads `active` after Stop.
    state.stopChangesStatus = false;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
    await screen.findByText('Stop');

    // Due now, while the leg is up: the reset waits.
    state.resetDue = true;
    await advance(21_000);
    await advance(6_000);
    expect(callsTo('/auth/reset-complete')).toBe(0);

    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(FakeDevice.connects[0]!.disconnect).toHaveBeenCalled());
    await screen.findByText('Power dial a list');

    await advance(6_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(callsTo('/auth/reset-complete')).toBe(1);
  });

  it("a newer run on screen: the older run's last poll (paused) no longer holds the reset back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.status = 'paused';
    state.resetDue = true;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun(); // sess-1 — its polls say paused
    await waitFor(() => expect(callsTo('/dialer/sessions/sess-1')).toBeGreaterThan(0));
    await advance(10_000);
    expect(callsTo('/auth/reset-complete')).toBe(0);

    // Salesforce hands over another run (the handoff seam can swap it). Its
    // polls fail, so App still holds sess-1's `paused` — about a run that is
    // no longer on this tab.
    state.nextSessionId = 'sess-2';
    handOverRun();
    await waitFor(() => expect(callsTo('/dialer/sessions/sess-2')).toBeGreaterThan(0));
    await advance(6_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(callsTo('/auth/reset-complete')).toBe(1);
  });
});
