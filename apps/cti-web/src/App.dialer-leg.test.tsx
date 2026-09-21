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
  constructor(_token: string, _opts: unknown) { FakeDevice.instances.push(this); }
  on(): void { /* inbound events are not exercised here */ }
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

const state = { status: 'ready' as 'ready' | 'active' | 'stopped', controls: [] as string[] };

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
      if (control[1] === 'stop') state.status = 'stopped';
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
});
