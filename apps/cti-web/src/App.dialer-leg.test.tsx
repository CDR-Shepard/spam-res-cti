/** @vitest-environment jsdom */
/**
 * Pins App.tsx's WIRING of the power-dialer conference leg — dialer-leg.test.ts
 * covers the decisions, but a helper plus its inputs does not pin the call site:
 *
 *   1. the join names the run (`DialerSessionId`), so the server can record this
 *      leg's CallSid on it — what the run-end cleanup hangs up;
 *   2. a leg that disconnects ON ITS OWN while the run is live is re-joined
 *      (before this, the softphone had no `disconnect` listener on the leg at
 *      all: the run kept dialing humans into an empty room);
 *   3. the disconnect the app causes itself (Stop) is NOT treated as a drop.
 *
 * Same harness idiom as App.test.tsx: real App, fake Twilio SDK, fake fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
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
  static connects: Array<{ params: Record<string, string>; connection: FakeConnection }> = [];
  /** connect() rejects once this many legs have been handed out. */
  static failConnectsAfter = Infinity;
  private listeners = new Map<string, Array<(a?: unknown) => void>>();
  constructor(_token: string, _opts: unknown) { FakeDevice.instances.push(this); }
  on(event: string, cb: (a?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, arg?: unknown): void { for (const cb of this.listeners.get(event) ?? []) cb(arg); }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { /* not exercised */ }
  async connect(opts: { params: Record<string, string> }): Promise<FakeConnection> {
    if (FakeDevice.connects.length >= FakeDevice.failConnectsAfter) throw new Error('ConnectionError (31005)');
    const connection = new FakeConnection();
    FakeDevice.connects.push({ params: opts.params, connection });
    return connection;
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const state = { status: 'ready' as 'ready' | 'active' | 'stopped', controls: [] as string[], stopChangesStatus: true };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

const VIEW = () => ({
  session: { id: 'sess-1', status: state.status },
  counts: { total: 1, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
  currentItem: null,
  firstPassTotal: 1,
});

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.connects.length = 0;
  FakeDevice.failConnectsAfter = Infinity;
  state.stopChangesStatus = true;
  state.status = 'ready';
  state.controls = [];
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
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
      if (control[1] === 'start') state.status = 'active';
      if (control[1] === 'stop' && state.stopChangesStatus) state.status = 'stopped';
      return jsonResponse({ ok: true });
    }
    if (url.includes('/dialer/sessions/sess-1')) return jsonResponse(VIEW());
    if (url.includes('/dialer/sessions') && init?.method === 'POST') return jsonResponse({ sessionId: 'sess-1', total: 1 });
    return jsonResponse({});
  }));
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Hand the app a run the way Salesforce does (postMessage), then press Start. */
async function startRun(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { type: 'POWER_DIAL', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    }));
  });
  fireEvent.click(await screen.findByText('Start dialing'));
  await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
}

describe('App — power-dialer conference leg wiring', () => {
  it('joins AFTER start, naming the run so the server can record this leg on it', async () => {
    await startRun();
    expect(state.controls).toEqual(['start']);
    expect(FakeDevice.connects[0]!.params).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
  });

  it('re-joins when the leg drops on its own while the run is still live', async () => {
    await startRun();
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
    expect(FakeDevice.connects[1]!.params).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
    expect(state.controls).toEqual(['start']); // recovered — the run was NOT stopped
  });

  it('does not re-join a run the server already ended (that disconnect was the server tidying up)', async () => {
    await startRun();
    state.status = 'stopped';
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await new Promise((r) => setTimeout(r, 2200));
    expect(FakeDevice.connects.length).toBe(1);
  });

  it('pressing Stop hangs the leg up without treating it as a drop', async () => {
    await startRun();
    fireEvent.click(await screen.findByText('Stop'));
    await waitFor(() => expect(FakeDevice.connects[0]!.connection.disconnect).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 2200));
    expect(FakeDevice.connects.length).toBe(1);
  });

  // Twilio signalling blips reach Device `error`, which parks the phone in
  // `preflight` for the rest of the run. A recovery that insisted on `idle` could
  // never rejoin after one — it always stopped the run, for exactly the case
  // (a network blip) it exists to survive.
  it('still re-joins after a Device error has parked the phone in preflight', async () => {
    await startRun();
    act(() => { FakeDevice.instances[0]!.emit('error', { code: 31005, message: 'websocket closed' }); });
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
    expect(state.controls).toEqual(['start']);
  });

  it('stops the run, says so, and unlocks the phone when the leg cannot be brought back', async () => {
    await startRun();
    FakeDevice.failConnectsAfter = 1;
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await waitFor(() => expect(state.controls).toEqual(['start', 'stop']), { timeout: 4000 });
    expect(await screen.findByText(/so the run was stopped/)).toBeTruthy();
    expect(FakeDevice.connects.length).toBe(1);
    // The run is over: the bottom nav (hidden for the length of a run) is back.
    await waitFor(() => expect(document.querySelector('.nav')).not.toBeNull());
  });

  it('keeps the phone on the Power Dial tab during a live run (the nav the test above waits for really is hidden)', async () => {
    await startRun();
    expect(document.querySelector('.nav')).toBeNull();
  });

  // The Stop button's own hang-up is ignored because Stop supersedes the run —
  // NOT because the status happens to read `stopped` by the time anyone looks.
  it('pressing Stop never re-joins, even while the server still reads active', async () => {
    await startRun();
    state.stopChangesStatus = false;
    fireEvent.click(await screen.findByText('Stop'));
    await waitFor(() => expect(FakeDevice.connects[0]!.connection.disconnect).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 2200));
    expect(FakeDevice.connects.length).toBe(1);
  });

  // The leg drops on its own, and THEN the rep presses Stop while the recovery is
  // still waiting. Only the run-generation check can save this one: the ref guard
  // already let the drop through, and the server still reads `active`.
  it('a Stop pressed DURING a recovery wins: no re-join', async () => {
    await startRun();
    state.stopChangesStatus = false;
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    fireEvent.click(await screen.findByText('Stop'));
    await new Promise((r) => setTimeout(r, 2200));
    expect(FakeDevice.connects.length).toBe(1);
  });

  it('gives up after three re-joins in a row: the fourth drop stops the run', async () => {
    await startRun();
    for (let leg = 0; leg < 3; leg++) {
      act(() => { FakeDevice.connects[leg]!.connection.emit('disconnect'); });
      await waitFor(() => expect(FakeDevice.connects.length).toBe(leg + 2), { timeout: 4000 });
    }
    expect(state.controls).toEqual(['start']);
    act(() => { FakeDevice.connects[3]!.connection.emit('disconnect'); });
    await waitFor(() => expect(state.controls).toEqual(['start', 'stop']), { timeout: 4000 });
    expect(FakeDevice.connects.length).toBe(4);
  }, 20_000);

  it('a duplicate disconnect for the same leg starts ONE recovery, not two', async () => {
    await startRun();
    act(() => {
      FakeDevice.connects[0]!.connection.emit('disconnect');
      FakeDevice.connects[0]!.connection.emit('disconnect');
    });
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 1800));
    expect(FakeDevice.connects.length).toBe(2);
  });
});
