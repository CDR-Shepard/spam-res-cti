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
  /** The local mic track the app watches (audio-readiness.ts watchLocalMic). */
  micTrack = new FakeTrack();
  getLocalStream(): { getAudioTracks: () => FakeTrack[] } { return { getAudioTracks: () => [this.micTrack] }; }
  on(event: string, cb: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string): void { for (const cb of this.handlers.get(event) ?? []) cb(); }
  /** Task 8: pins that `joinLeg` wires `watchLineVolume` onto every leg it
   *  hands out (a fresh join and a recovered one alike) — see App.tsx's
   *  `on('volume', …)` registration right after `dialerConnRef.current = connection`. */
  hasListenerFor(event: string): boolean { return (this.handlers.get(event)?.length ?? 0) > 0; }
}

class FakeDevice {
  static instances: FakeDevice[] = [];
  static connects: Array<{ params: Record<string, string>; connection: FakeConnection }> = [];
  /** connect() rejects once this many legs have been handed out. */
  static failConnectsAfter = Infinity;
  private listeners = new Map<string, Array<(a?: unknown) => void>>();
  /** device.audio — the AudioHelper surface the mic re-pin uses. */
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
    if (FakeDevice.connects.length >= FakeDevice.failConnectsAfter) throw new Error('ConnectionError (31005)');
    const connection = new FakeConnection();
    FakeDevice.connects.push({ params: opts.params, connection });
    return connection;
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const state = {
  status: 'ready' as 'ready' | 'active' | 'stopped',
  controls: [] as string[],
  stopChangesStatus: true,
  /** Device `error` fired during the start round trip (parks the phone in preflight). */
  errorDuringStart: false,
  /** The next POST /dialer/sessions answers with this run. */
  nextSessionId: 'sess-1',
  /** The tab's "busy" predicate, as handed to the softphone election. */
  isBusy: null as null | (() => boolean),
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

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.connects.length = 0;
  FakeDevice.failConnectsAfter = Infinity;
  state.stopChangesStatus = true;
  state.errorDuringStart = false;
  state.nextSessionId = 'sess-1';
  state.isBusy = null;
  state.status = 'ready';
  const realDeps = coordinator.browserCoordinatorDeps;
  vi.spyOn(coordinator, 'browserCoordinatorDeps').mockImplementation((userId, getBusy) => { state.isBusy = getBusy; return realDeps(userId, getBusy); });
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
      if (control[1] === 'start') {
        state.status = 'active';
        if (state.errorDuringStart) FakeDevice.instances[0]?.emit('error', { code: 31005, message: 'websocket closed' });
      }
      if (control[1] === 'stop' && state.stopChangesStatus) state.status = 'stopped';
      return jsonResponse({ ok: true });
    }
    if (url.includes('/dialer/sessions/sess-1')) return jsonResponse(VIEW());
    if (url.includes('/dialer/sessions/sess-2')) return jsonResponse({ ...VIEW(), session: { id: 'sess-2', status: 'ready' } });
    if (url.includes('/dialer/sessions') && init?.method === 'POST') return jsonResponse({ sessionId: state.nextSessionId, total: 1 });
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

/** Hand the app a run the way Salesforce does (postMessage). */
function handOverRun(): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { type: 'POWER_DIAL', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    }));
  });
}

/** Render, hand the app a run, press Start, and wait for the leg to join. */
async function startRun(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
  handOverRun();
  fireEvent.click(await screen.findByText('Start dialing'));
  await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
}

describe('App — power-dialer conference leg wiring', () => {
  it('joins AFTER start, naming the run so the server can record this leg on it', async () => {
    await startRun();
    expect(state.controls).toEqual(['start']);
    expect(FakeDevice.connects[0]!.params).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
  });

  // Task 8: in YouTube hold-music mode the line is silent while waiting, so the
  // first sound on it means someone was connected — watchLineVolume feeds that
  // signal to the player. It must be attached to every leg this tab ever holds,
  // not just the first, so it has to happen at the one place all of them pass
  // through: joinLeg, right after `dialerConnRef.current = connection`.
  it('feeds the dialer leg to watchLineVolume, so it gets a volume listener', async () => {
    await startRun();
    expect(FakeDevice.connects[0]!.connection.hasListenerFor('volume')).toBe(true);
  });

  it('re-joins when the leg drops on its own while the run is still live', async () => {
    await startRun();
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
    expect(FakeDevice.connects[1]!.params).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
    expect(state.controls).toEqual(['start']); // recovered — the run was NOT stopped
  });

  it('a recovered leg also gets a volume listener, not just the first', async () => {
    await startRun();
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
    expect(FakeDevice.connects[1]!.connection.hasListenerFor('volume')).toBe(true);
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

  // Only a RECOVERY may join from `preflight`. A fresh Start from there means a
  // Device error is outstanding: the run is stopped rather than joined.
  it('a fresh Start does not join from preflight — a Device error during start stops the run', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    state.errorDuringStart = true;
    handOverRun();
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(state.controls).toEqual(['start', 'stop']));
    expect(FakeDevice.connects.length).toBe(0);
  });

  // The Salesforce handoff seam can hand the app ANOTHER run mid-run (it lands
  // on the confirm block, ready, un-started). A recovery must name the run its
  // leg belongs to, not whatever the app is looking at now.
  it('a recovery names the run it was started for, not a newer ready run the app was handed meanwhile', async () => {
    await startRun();
    state.nextSessionId = 'sess-2';
    handOverRun();
    await screen.findByText('Start dialing');
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
    expect(FakeDevice.connects[1]!.params).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
  });

  it('the recovery cap is per run: two re-joins in one run do not count against the next', async () => {
    await startRun();
    for (let leg = 0; leg < 2; leg++) {
      act(() => { FakeDevice.connects[leg]!.connection.emit('disconnect'); });
      await waitFor(() => expect(FakeDevice.connects.length).toBe(leg + 2), { timeout: 4000 });
    }
    fireEvent.click(await screen.findByText('Stop'));
    await waitFor(() => expect(state.controls).toEqual(['start', 'stop']));
    // Stop returns the panel to the list picker; hand it a fresh run.
    state.status = 'ready';
    handOverRun();
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(4));
    for (let leg = 3; leg < 6; leg++) {
      act(() => { FakeDevice.connects[leg]!.connection.emit('disconnect'); });
      await waitFor(() => expect(FakeDevice.connects.length).toBe(leg + 2), { timeout: 4000 });
    }
    expect(state.controls).toEqual(['start', 'stop', 'start']);
  }, 30_000);

  it('…and decays: three re-joins spread over more than ten minutes do not exhaust it', async () => {
    await startRun();
    const realNow = Date.now;
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      for (let leg = 0; leg < 3; leg++) {
        act(() => { FakeDevice.connects[leg]!.connection.emit('disconnect'); });
        await waitFor(() => expect(FakeDevice.connects.length).toBe(leg + 2), { timeout: 4000 });
        offset += 11 * 60_000;
      }
      act(() => { FakeDevice.connects[3]!.connection.emit('disconnect'); });
      await waitFor(() => expect(FakeDevice.connects.length).toBe(5), { timeout: 4000 });
      expect(state.controls).toEqual(['start']);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  }, 25_000);

  // While the recovery works, this tab must keep the Device: the softphone
  // election would otherwise move it to another visible tab mid-recovery.
  it('the tab stays "busy" for the softphone election during a recovery, and frees once the run is over', async () => {
    await startRun();
    expect(state.isBusy!()).toBe(true);
    FakeDevice.failConnectsAfter = 1;
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await new Promise((r) => setTimeout(r, 500));
    expect(state.isBusy!()).toBe(true);
    await waitFor(() => expect(state.controls).toEqual(['start', 'stop']), { timeout: 4000 });
    await waitFor(() => expect(state.isBusy!()).toBe(false));
  });

  // The mic that died mid-run (2026-09-22): the leg keeps receiving audio but
  // its local track ended with the old headset, and nothing re-acquired it.
  it("re-pins the microphone when the dialer leg's local track ends, and says so", async () => {
    await startRun();
    const device = FakeDevice.instances[0]!;
    act(() => { FakeDevice.connects[0]!.connection.micTrack.fire('ended'); });
    await waitFor(() => expect(device.audio.setInputDevice).toHaveBeenCalledWith('default'));
    expect(await screen.findByText('Microphone reconnected.')).toBeTruthy();
    expect(FakeDevice.connects.length).toBe(1); // the leg itself is untouched
  });

  // 2026-09-25: the mic chosen in Settings. The leg runs on the same Device, so
  // a re-pin must land on the chosen headset, not the system default.
  it('re-pins the dialer leg to the microphone chosen in Settings', async () => {
    localStorage.setItem('cti.audio.input', 'mic-jabra');
    await startRun();
    const device = FakeDevice.instances[0]!;
    device.audio.availableInputDevices.set('mic-jabra', { deviceId: 'mic-jabra' });
    act(() => { FakeDevice.connects[0]!.connection.micTrack.fire('ended'); });
    await waitFor(() => expect(device.audio.setInputDevice).toHaveBeenCalledWith('mic-jabra'));
    expect(device.audio.setInputDevice).not.toHaveBeenCalledWith('default');
  });
});
