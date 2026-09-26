/** @vitest-environment jsdom */
/**
 * Pins App.tsx's WIRING of callback waiting during a power-dial run (spec
 * docs/superpowers/specs/2026-09-26-callback-waiting-design.md). The decisions
 * are pinned in callback-waiting.test.ts / parked-heartbeat.test.ts; this
 * proves the call sites: the Device flag, where an incoming call goes during a
 * run, the dropped-leg hand-off, and (Task 3) the banner, Pause & answer and
 * Resume. Harness idiom: App.dialer-leg.test.tsx — real App, fake Twilio SDK,
 * fake fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import * as opencti from './opencti';
import * as heartbeat from './parked-heartbeat';
import * as chime from './callback-chime';
import * as dialerLeg from './dialer-leg';
import * as coordinator from './softphone-coordinator';

type Listener = (...args: unknown[]) => void;

class FakeTrack {
  private handlers = new Map<string, Array<() => void>>();
  addEventListener(event: string, cb: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
}

/** The rep's dialer conference leg (device.connect()'s return value). */
class FakeConnection {
  private handlers = new Map<string, Listener[]>();
  disconnect = vi.fn(() => { state.events.push('leg-disconnect'); this.emit('disconnect'); });
  micTrack = new FakeTrack();
  getLocalStream(): { getAudioTracks: () => FakeTrack[] } { return { getAudioTracks: () => [this.micTrack] }; }
  on(event: string, cb: Listener): void { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); }
  emit(event: string): void { for (const cb of this.handlers.get(event) ?? []) cb(); }
  hasListenerFor(event: string): boolean { return (this.handlers.get(event)?.length ?? 0) > 0; }
}

class FakeDevice {
  static instances: FakeDevice[] = [];
  static connects: Array<{ params: Record<string, string>; connection: FakeConnection }> = [];
  static lastOpts: Record<string, unknown> | null = null;
  /** Hold connect() open this long — so a callback can ring while the leg joins. */
  static connectDelayMs = 0;
  private listeners = new Map<string, Listener[]>();
  /** Calls rung on this Device and not yet dealt with — the SDK's `_calls`. */
  calls: FakeCall[] = [];
  destroyed = 0;
  audio = {
    availableInputDevices: new Map([['default', { deviceId: 'default' }]]),
    inputDevice: null as { deviceId: string } | null,
    setInputDevice: vi.fn(async () => {}),
    on: vi.fn(),
  };
  constructor(_token: string, opts: Record<string, unknown>) {
    FakeDevice.lastOpts = opts;
    FakeDevice.instances.push(this);
  }
  on(event: string, cb: Listener): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]); }
  emit(event: string, arg?: unknown): void { for (const cb of this.listeners.get(event) ?? []) cb(arg); }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { this.destroyed++; }
  async connect(opts: { params: Record<string, string> }): Promise<FakeConnection> {
    if (FakeDevice.connectDelayMs) await new Promise((r) => { setTimeout(r, FakeDevice.connectDelayMs); });
    const connection = new FakeConnection();
    FakeDevice.connects.push({ params: opts.params, connection });
    // As the real SDK does (voice-sdk device.ts connect): every call still
    // ringing on the Device is ignore()d — closed, with no event.
    // (Filtered to pending ones here so `ignore` being called means a live
    // callback was swallowed; the SDK's ignore() is a no-op on the others.)
    for (const call of this.calls.splice(0)) if (call.status() === 'pending') call.ignore();
    return connection;
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

/** A callback ringing the softphone — the SDK's incoming Call, faked. */
interface FakeCall {
  parameters: Record<string, string>;
  customParameters: Map<string, string>;
  accept: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  /** The SDK's ignore(): closes a pending call with NO event. */
  ignore: Mock<() => void>;
  disconnect: ReturnType<typeof vi.fn>;
  status: () => string;
  on: (event: string, cb: Listener) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

function callbackCall(n = 1): FakeCall {
  const listeners = new Map<string, Listener[]>();
  let status = 'pending';
  const emit = (event: string, ...args: unknown[]): void => {
    if (event === 'cancel' || event === 'disconnect') status = 'closed';
    for (const cb of listeners.get(event) ?? []) cb(...args);
  };
  return {
    parameters: { From: '+16195551234', CallSid: `CAcallback${n}` },
    customParameters: new Map([['callerName', 'Jane Doe'], ['recordId', '00QCALLBACK000001'], ['recordType', 'Lead']]),
    accept: vi.fn(() => { state.events.push('accept'); if (status === 'pending') status = 'open'; }),
    // As the SDK (call.ts reject): a no-op unless pending; emits 'reject'.
    reject: vi.fn(() => { if (status !== 'pending') return; status = 'closed'; emit('reject'); }),
    ignore: vi.fn(() => { if (status === 'pending') status = 'closed'; }),
    disconnect: vi.fn(),
    status: () => status,
    on: (event, cb) => { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    emit,
  };
}

const state = {
  status: 'ready' as 'ready' | 'active' | 'paused' | 'stopped' | 'done',
  /** The run's current item as the poll reports it (null = between dials). */
  currentItem: null as null | { status: string; prospectEndedAt: string | null },
  /** Every dialer control and take-callback the app sent, in order. */
  controls: [] as string[],
  /** Cross-object order: the take-callback POST, the leg disconnect, the accept. */
  events: [] as string[],
  /** How POST take-callback answers. */
  takeCallback: 'ok' as 'ok' | 'connected' | 'error',
  /** The rep's no-answer forward (Settings), from /auth/me. */
  forward: null as string | null,
  /** While set, POST take-callback waits for it before answering. */
  takeCallbackHold: null as Promise<void> | null,
  /** App's softphone-election busy test, captured. */
  isBusy: null as null | (() => boolean),
  /** App's leadership handler, captured — call it with false to lose leadership. */
  leadership: null as null | ((isLeader: boolean) => void),
};

/** Hold every take-callback until the returned release() is called. */
function holdTakeCallback(): () => void {
  let release: () => void = () => {};
  state.takeCallbackHold = new Promise<void>((r) => { release = r; });
  return () => { state.takeCallbackHold = null; release(); };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

const VIEW = () => ({
  session: { id: 'sess-1', status: state.status },
  counts: { total: 2, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 2 },
  currentItem: state.currentItem
    ? { id: 'i1', recordId: '00QPROSPECT000001', objectType: 'Lead', toNumber: '+16195550100', ...state.currentItem }
    : null,
  firstPassTotal: 2,
});

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.connects.length = 0;
  FakeDevice.lastOpts = null;
  FakeDevice.connectDelayMs = 0;
  state.status = 'ready';
  state.currentItem = null;
  state.controls = [];
  state.events = [];
  state.takeCallback = 'ok';
  state.forward = null;
  state.takeCallbackHold = null;
  state.isBusy = null;
  state.leadership = null;
  const realDeps = coordinator.browserCoordinatorDeps;
  vi.spyOn(coordinator, 'browserCoordinatorDeps').mockImplementation((userId, getBusy) => { state.isBusy = getBusy; return realDeps(userId, getBusy); });
  const realCreate = coordinator.createSoftphoneCoordinator;
  vi.spyOn(coordinator, 'createSoftphoneCoordinator').mockImplementation((deps) => {
    const c = realCreate(deps);
    return { ...c, onLeadershipChange: (cb) => { state.leadership = cb; c.onLeadershipChange(cb); } };
  });
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/me')) {
      return jsonResponse({
        user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true, noAnswerForwardE164: state.forward },
        salesforce: { connected: true },
      });
    }
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/dialer/handoffs/pending')) return jsonResponse({ handoff: null });
    if (url.includes('/dialer/sessions/sess-1/take-callback')) {
      state.controls.push('take-callback');
      state.events.push('take-callback');
      const mode = state.takeCallback; // how THIS request answers, even if held
      if (state.takeCallbackHold) await state.takeCallbackHold;
      if (mode === 'connected') return jsonResponse({ error: 'You are talking to a prospect — finish that call first.', reason: 'connected' }, 409);
      if (mode === 'error') return jsonResponse({ error: 'database unavailable' }, 500);
      const canceledItemId = state.currentItem?.status === 'dialing' ? 'i1' : null;
      if (canceledItemId) state.currentItem = null;
      state.status = 'paused';
      return jsonResponse({ ok: true, action: 'paused', canceledItemId });
    }
    const control = /\/dialer\/sessions\/sess-1\/(start|stop|pause|resume|skip|next|redial|end)$/.exec(url);
    if (control) {
      const action = control[1]!;
      state.controls.push(action);
      if (action === 'start' || action === 'resume') state.status = 'active';
      if (action === 'pause') state.status = 'paused';
      if (action === 'stop') state.status = 'stopped';
      if (action === 'next') state.currentItem = null;
      return jsonResponse({ ok: true });
    }
    if (url.includes('/dialer/sessions/sess-1')) return jsonResponse(VIEW());
    if (url.includes('/dialer/sessions') && init?.method === 'POST') return jsonResponse({ sessionId: 'sess-1', total: 2 });
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

/** Render, hand the app a run, press Start, and wait until the leg is adopted. */
async function startRun(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
  handOverRun();
  fireEvent.click(await screen.findByText('Start dialing'));
  await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
  // watchDialerLeg is attached right after dialerConnRef is set.
  await waitFor(() => expect(FakeDevice.connects[0]!.connection.hasListenerFor('disconnect')).toBe(true));
}

function ring(call: FakeCall): void {
  FakeDevice.instances[0]!.calls.push(call);
  act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
}

/** The rep's current conference leg drops on its own (network, a lost webhook). */
function dropLeg(i = 0): void {
  act(() => { FakeDevice.connects[i]!.connection.emit('disconnect'); });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** A run on screen (a dial ringing by default), with a callback on the banner. */
async function callbackOnBanner(item: { status: string; prospectEndedAt: string | null } = { status: 'dialing', prospectEndedAt: null }): Promise<FakeCall> {
  state.currentItem = item;
  await startRun();
  await screen.findByText(item.prospectEndedAt ? 'They hung up' : /Dialing/);
  const call = callbackCall();
  ring(call);
  await screen.findByText('Callback: Jane Doe · Lead');
  return call;
}

/** Pause & answer, then the callback ends: the paused run is back on screen. */
async function takeAndFinish(call: FakeCall): Promise<void> {
  fireEvent.click(screen.getByText('Pause & answer'));
  await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
  act(() => { call.emit('disconnect'); });
}

describe('App — callbacks during a power-dial run (Task 2 wiring)', () => {
  it('builds the Twilio Device with allowIncomingWhileBusy — at construction, not via updateOptions', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    expect(FakeDevice.lastOpts).toEqual(expect.objectContaining({ logLevel: 1, allowIncomingWhileBusy: true }));
  });

  it('with no run, a callback rings exactly as today', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const call = callbackCall();
    ring(call);
    expect(await screen.findByTitle('Answer')).toBeTruthy();
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('while the rep is talking to a prospect: rejected at once, and a toast says where it went', async () => {
    state.currentItem = { status: 'connected', prospectEndedAt: null };
    await startRun();
    await screen.findByText('End call'); // the poll saw the connected item — the snapshot is lifted
    const call = callbackCall();
    ring(call);
    expect(call.reject).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Missed callback from Jane Doe — you were on a call. It went to voicemail.')).toBeTruthy();
    expect(screen.queryByTitle('Answer')).toBeNull();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('…"your cell" when the rep has a no-answer forward set', async () => {
    state.forward = '+16195550199';
    state.currentItem = { status: 'connected', prospectEndedAt: null };
    await startRun();
    await screen.findByText('End call');
    ring(callbackCall());
    expect(await screen.findByText('Missed callback from Jane Doe — you were on a call. It went to your cell.')).toBeTruthy();
  });

  it('while a dial only rings: the callback waits for the rep — not rejected, no ring screen, the run stays on screen', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const call = callbackCall();
    ring(call);
    expect(call.reject).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Answer')).toBeNull();
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('the prospect answers after the callback started waiting: the next poll rejects it, with the toast', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const call = callbackCall();
    ring(call);
    state.currentItem = { status: 'connected', prospectEndedAt: null };
    await waitFor(() => expect(call.reject).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(await screen.findByText(/Missed callback from Jane Doe — you were on a call/)).toBeTruthy();
  });

  it('a second callback while one waits is rejected; the first keeps waiting', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const first = callbackCall(1);
    const second = callbackCall(2);
    ring(first);
    ring(second);
    expect(second.reject).toHaveBeenCalledTimes(1);
    expect(first.reject).not.toHaveBeenCalled();
  });

  it('a waiting caller who hangs up frees the slot: the next callback waits too', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const first = callbackCall(1);
    ring(first);
    act(() => { first.emit('cancel'); });
    const second = callbackCall(2);
    ring(second);
    expect(second.reject).not.toHaveBeenCalled();
  });

  it('a callback that reached the ring screen while the leg was joining is never answered over the live leg', async () => {
    FakeDevice.connectDelayMs = 300;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(state.controls).toContain('start'));
    const call = callbackCall();
    ring(call); // no leg yet → today's ring screen
    const answer = await screen.findByTitle('Answer');
    await waitFor(() => expect(FakeDevice.connects[0]?.connection.hasListenerFor('disconnect')).toBe(true));
    fireEvent.click(answer);
    expect(call.accept).not.toHaveBeenCalled();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Answer')).toBeNull();
  });

  it('the leg drops while a callback waits: no re-join (connect() would swallow the ring) — the run is parked, kept alive, and the callback rings the ordinary way', async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const call = callbackCall();
    ring(call);
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    expect(await screen.findByTitle('Answer')).toBeTruthy();
    expect(state.controls).toContain('take-callback');
    expect(beat).toHaveBeenCalledWith('sess-1', expect.anything());
    await new Promise((r) => { setTimeout(r, 2200); });
    expect(FakeDevice.connects.length).toBe(1);
    expect(document.querySelector('.nav')).toBeNull();
  }, 15_000);

  it('…but when the run cannot be paused (a prospect answered: 409), the callback is rejected with the toast and the leg is recovered as usual', async () => {
    state.takeCallback = 'connected';
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const call = callbackCall();
    ring(call);
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await waitFor(() => expect(call.reject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Missed callback from Jane Doe — you were on a call/)).toBeTruthy();
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
  }, 15_000);
});

describe('App — the banner, Pause & answer, and Resume (Task 3)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });

  it('shows the banner above the current record, and chimes once', async () => {
    await callbackOnBanner();
    expect(screen.getByText('Pause & answer')).toBeTruthy();
    expect(screen.getByText('Ignore')).toBeTruthy();
    const banner = document.querySelector('.dp-callback')!;
    const card = document.querySelector('.dp-current')!;
    expect(banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chime.playCallbackChime).toHaveBeenCalledTimes(1);
  });

  it('Ignore rejects the callback (forward/voicemail as today) and leaves the run alone', async () => {
    const call = await callbackOnBanner();
    fireEvent.click(screen.getByText('Ignore'));
    expect(call.reject).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Callback: Jane Doe · Lead')).toBeNull();
    expect(state.controls).not.toContain('take-callback');
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('the caller hanging up first takes the banner down', async () => {
    const call = await callbackOnBanner();
    act(() => { call.emit('cancel'); });
    expect(screen.queryByText('Callback: Jane Doe · Lead')).toBeNull();
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('Pause & answer: the server pauses FIRST, then the rep leaves the room, then the callback is answered — and the dropped leg is never recovered', async () => {
    const call = await callbackOnBanner();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    expect(state.events).toEqual(['take-callback', 'leg-disconnect', 'accept']);
    expect(opencti.screenPopRecord).toHaveBeenCalledWith('00QCALLBACK000001');
    expect(await screen.findByTitle('End call')).toBeTruthy();
    await new Promise((r) => { setTimeout(r, 2200); });
    expect(FakeDevice.connects.length).toBe(1);
    expect(state.controls).not.toContain('stop');
    expect(document.querySelector('.nav')).toBeNull();
  }, 15_000);

  it('409 — a prospect answered in the race: the callback is rejected with the toast, and the rep stays in the room', async () => {
    const call = await callbackOnBanner();
    state.takeCallback = 'connected';
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(call.reject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Missed callback from Jane Doe — you were on a call. It went to voicemail.')).toBeTruthy();
    expect(call.accept).not.toHaveBeenCalled();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('a pause that fails keeps the banner up (try again, or Ignore) and says why', async () => {
    const call = await callbackOnBanner();
    state.takeCallback = 'error';
    fireEvent.click(screen.getByText('Pause & answer'));
    expect(await screen.findByText("Couldn't pause the run to answer: database unavailable")).toBeTruthy();
    expect(screen.getByText('Callback: Jane Doe · Lead')).toBeTruthy();
    expect(call.accept).not.toHaveBeenCalled();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('after the callback: back on the paused run; Resume joins the room, waits for Twilio to answer the leg, THEN resumes', async () => {
    await takeAndFinish(await callbackOnBanner());
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2));
    expect(FakeDevice.connects[1]!.params).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
    await waitFor(() => expect(FakeDevice.connects[1]!.connection.hasListenerFor('accept')).toBe(true));
    expect(state.controls).not.toContain('resume');
    act(() => { FakeDevice.connects[1]!.connection.emit('accept'); });
    await waitFor(() => expect(state.controls).toContain('resume'));
  }, 15_000);

  it("a refused re-join (another run of the rep's owns the room) resumes nothing, says so, keeps the phone on Power Dial, and is not recovered", async () => {
    await takeAndFinish(await callbackOnBanner());
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(FakeDevice.connects[1]?.connection.hasListenerFor('accept')).toBe(true));
    act(() => { FakeDevice.connects[1]!.connection.emit('disconnect'); });
    expect(await screen.findByText(/Couldn't rejoin the run/)).toBeTruthy();
    expect(state.controls).not.toContain('resume');
    expect(document.querySelector('.nav')).toBeNull();
    await new Promise((r) => { setTimeout(r, 2200); });
    expect(FakeDevice.connects.length).toBe(2);
  }, 15_000);

  it('the prospect card that popped before the callback does not pop again when the panel comes back', async () => {
    await takeAndFinish(await callbackOnBanner({ status: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' }));
    await screen.findByText('Redial');
    await new Promise((r) => { setTimeout(r, 2500); });
    expect(vi.mocked(opencti.screenPopRecord).mock.calls.map(([id]) => id)).toEqual(['00QPROSPECT000001', '00QCALLBACK000001']);
  }, 15_000);
});

/**
 * Review fixes (Task 2 review, 2026-09-26). The SDK's connect() ignore()s every
 * call still ringing on the Device, with no event (voice-sdk device.ts
 * connect) — the fake above does the same — so nothing may re-join the room
 * while a callback rings or waits.
 */
describe('App — recovery never re-joins over a callback (review I-1)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });

  it('the leg drops with nothing waiting, and a callback rings during the recovery wait: the callback is handed off instead of re-joining — never swallowed, rings the ordinary way, no "reconnected" toast', async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    dropLeg();
    const call = callbackCall();
    ring(call); // the dead ref still reads as a live leg → the banner
    await screen.findByText('Callback: Jane Doe · Lead');
    expect(await screen.findByTitle('Answer', undefined, { timeout: 4000 })).toBeTruthy();
    expect(state.controls).toContain('take-callback');
    expect(call.ignore).not.toHaveBeenCalled();
    expect(FakeDevice.connects.length).toBe(1);
    expect(beat).toHaveBeenCalledWith('sess-1', expect.anything());
    await sleep(500);
    expect(screen.queryByText(/reconnected/)).toBeNull();
    expect(FakeDevice.connects.length).toBe(1);
  }, 15_000);

  it('…and when the run cannot be paused there, the callback is rejected with the toast and the leg re-joined', async () => {
    state.takeCallback = 'error';
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    dropLeg();
    const call = callbackCall();
    ring(call);
    await waitFor(() => expect(call.reject).toHaveBeenCalledTimes(1), { timeout: 4000 });
    // (Its "couldn't pause your run" toast is replaced at once by the rejoin's
    // "reconnected" one — there is one toast slot.)
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
    expect(call.ignore).not.toHaveBeenCalled();
    expect(state.controls).toContain('take-callback');
  }, 15_000);

  it('the leg drops DURING Pause & answer: nothing re-joins alongside it, however long take-callback takes — then the callback is answered', async () => {
    const call = await callbackOnBanner();
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    dropLeg();
    await sleep(2200); // past the recovery wait
    expect(FakeDevice.connects.length).toBe(1);
    expect(call.ignore).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    await sleep(2200);
    expect(FakeDevice.connects.length).toBe(1);
    expect(state.controls).not.toContain('stop');
  }, 15_000);

  it('…nor is the run stopped from under it when the leg has already dropped too often to be re-joined', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    for (let i = 0; i < dialerLeg.MAX_LEG_RECOVERIES; i++) {
      dropLeg(i);
      await waitFor(() => expect(FakeDevice.connects[i + 1]?.connection.hasListenerFor('disconnect')).toBe(true), { timeout: 4000 });
    }
    const call = callbackCall();
    ring(call);
    await screen.findByText('Callback: Jane Doe · Lead');
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    dropLeg(dialerLeg.MAX_LEG_RECOVERIES);
    await sleep(2200); // past the recovery wait
    expect(state.controls).not.toContain('stop');
    release();
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    await sleep(300);
    expect(state.controls).not.toContain('stop');
  }, 25_000);

  it('…if that Pause & answer fails, the drop is handled once it settles: the callback is handed off, the run parked', async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    const call = await callbackOnBanner();
    state.takeCallback = 'error';
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    state.takeCallback = 'ok';
    dropLeg();
    await sleep(200);
    release();
    expect(await screen.findByTitle('Answer', undefined, { timeout: 4000 })).toBeTruthy();
    expect(state.controls.filter((c) => c === 'take-callback')).toHaveLength(2);
    expect(beat).toHaveBeenCalledWith('sess-1', expect.anything());
    await sleep(2000);
    expect(FakeDevice.connects.length).toBe(1);
    expect(call.ignore).not.toHaveBeenCalled();
  }, 15_000);

  it('…if a prospect answered (409), the callback is rejected and the leg recovered as usual', async () => {
    const call = await callbackOnBanner();
    state.takeCallback = 'connected';
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    dropLeg();
    release();
    await waitFor(() => expect(call.reject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Missed callback from Jane Doe — you were on a call. It went to voicemail.')).toBeTruthy();
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
  }, 15_000);

  it('…if the caller hung up meanwhile, the paused run gets its leg back (else Resume would dial into an empty room)', async () => {
    const call = await callbackOnBanner();
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    dropLeg();
    act(() => { call.emit('cancel'); });
    release();
    expect(await screen.findByText('The caller hung up before you answered.')).toBeTruthy();
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
    expect(FakeDevice.connects[1]!.params).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
  }, 15_000);

  it("a callback the leg's join swallowed never reaches the banner — and never blocks the next one", async () => {
    FakeDevice.connectDelayMs = 300;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(state.controls).toContain('start'));
    const first = callbackCall(1);
    ring(first); // no leg yet → the ring screen; then connect() ignore()s it
    const answer = await screen.findByTitle('Answer');
    await waitFor(() => expect(FakeDevice.connects[0]?.connection.hasListenerFor('disconnect')).toBe(true));
    expect(first.ignore).toHaveBeenCalled();
    fireEvent.click(answer);
    await screen.findByText('Stop'); // the run's panel is back
    await sleep(100);
    expect(screen.queryByText('Callback: Jane Doe · Lead')).toBeNull();
    const second = callbackCall(2);
    ring(second);
    expect(second.reject).not.toHaveBeenCalled();
    expect(await screen.findByText('Callback: Jane Doe · Lead')).toBeTruthy();
  });

  it('a waiting callback closed with no event does not block the next one', async () => {
    const first = await callbackOnBanner();
    act(() => { first.ignore(); });
    const second = callbackCall(2);
    ring(second);
    expect(second.reject).not.toHaveBeenCalled();
  });

  it('Stop with a callback on the banner that was closed with no event: nothing re-rings', async () => {
    const call = await callbackOnBanner();
    act(() => { call.ignore(); });
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(state.controls).toContain('stop'));
    await waitFor(() => expect(screen.queryByText('Callback: Jane Doe · Lead')).toBeNull());
    expect(screen.queryByTitle('Answer')).toBeNull();
  });
});
