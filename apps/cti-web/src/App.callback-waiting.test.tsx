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
  private closed = false;
  on(event: string, cb: Listener): void { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); }
  emit(event: string): void {
    if (event === 'disconnect') this.closed = true;
    for (const cb of this.handlers.get(event) ?? []) cb();
  }
  status(): string { return this.closed ? 'closed' : 'open'; }
  hasListenerFor(event: string): boolean { return (this.handlers.get(event)?.length ?? 0) > 0; }
}

class FakeDevice {
  static instances: FakeDevice[] = [];
  static connects: Array<{ params: Record<string, string>; connection: FakeConnection }> = [];
  static lastOpts: Record<string, unknown> | null = null;
  /** Hold connect() open this long — so a callback can ring while the leg joins. */
  static connectDelayMs = 0;
  private listeners = new Map<string, Listener[]>();
  /** Every call rung on this Device. */
  rung: FakeCall[] = [];
  /** The SDK's `calls`: those still pending — it drops a call once accepted,
   *  cancelled, rejected or disconnected, and connect() ignore()s the rest. */
  get calls(): FakeCall[] { return this.rung.filter((c) => c.status() === 'pending'); }
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
    for (const call of this.calls) call.ignore();
    return connection;
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

/** A callback ringing the softphone — the SDK's incoming Call, faked. */
interface FakeCall {
  parameters: Record<string, string>;
  customParameters: Map<string, string>;
  accept: Mock<() => void>;
  reject: Mock<() => void>;
  /** The SDK's ignore(): closes a pending call with NO event. */
  ignore: Mock<() => void>;
  disconnect: Mock<() => void>;
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
    if (url.includes('/firewall/precall')) return jsonResponse({ error: 'unavailable' }, 503);
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
  FakeDevice.instances[0]!.rung.push(call);
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

describe('App — the dropped-leg hand-off yields to a Stop (review I-2)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });

  it("Stop lands while the hand-off's take-callback is out: the late 200 parks nothing — no heartbeat, no toast — and the callback keeps ringing", async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    const call = await callbackOnBanner();
    const release = holdTakeCallback();
    dropLeg();
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(state.controls).toContain('stop'));
    expect(await screen.findByTitle('Answer')).toBeTruthy(); // the run ended under it: rings the ordinary way
    release();
    await sleep(300);
    expect(beat).not.toHaveBeenCalled();
    expect(screen.queryByText(/lost its audio connection/)).toBeNull();
    expect(screen.getByTitle('Answer')).toBeTruthy();
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('…and a late failure does not reject the callback now on the ring screen', async () => {
    const call = await callbackOnBanner();
    state.takeCallback = 'error';
    const release = holdTakeCallback();
    dropLeg();
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(state.controls).toContain('stop'));
    await screen.findByTitle('Answer');
    release();
    await sleep(300);
    expect(call.reject).not.toHaveBeenCalled();
    expect(screen.queryByText(/Missed callback/)).toBeNull();
    expect(screen.getByTitle('Answer')).toBeTruthy();
  });

  it("a parked run's heartbeat reading \"over\" releases it — nav back — while it is still the run parked here with no leg", async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    await takeAndFinish(await callbackOnBanner());
    await screen.findByText('Resume');
    expect(document.querySelector('.nav')).toBeNull();
    state.status = 'stopped';
    act(() => { beat.mock.calls[0]![1].onRunOver(); });
    await waitFor(() => expect(document.querySelector('.nav')).not.toBeNull());
  }, 15_000);

  it('…but a beat that lands after Resume re-joined never drops the live leg', async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    await takeAndFinish(await callbackOnBanner());
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(FakeDevice.connects[1]?.connection.hasListenerFor('accept')).toBe(true));
    act(() => { FakeDevice.connects[1]!.connection.emit('accept'); });
    await waitFor(() => expect(state.controls).toContain('resume'));
    act(() => { beat.mock.calls[0]![1].onRunOver(); });
    expect(FakeDevice.connects[1]!.connection.disconnect).not.toHaveBeenCalled();
    expect(document.querySelector('.nav')).toBeNull();
  }, 15_000);

  it('…nor the leg of a NEW run that is joining after the parked one was stopped', async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    await takeAndFinish(await callbackOnBanner());
    fireEvent.click(await screen.findByText('Stop'));
    await waitFor(() => expect(state.controls).toContain('stop'));
    state.status = 'ready';
    state.currentItem = null;
    FakeDevice.connectDelayMs = 300;
    handOverRun();
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(state.controls.filter((c) => c === 'start')).toHaveLength(2));
    act(() => { beat.mock.calls[0]![1].onRunOver(); }); // the stopped run's late beat, mid-join
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2));
    await sleep(50);
    expect(FakeDevice.connects[1]!.connection.disconnect).not.toHaveBeenCalled();
    expect(document.querySelector('.nav')).toBeNull();
  }, 15_000);
});

describe('App — Pause & answer yields to a run that ended under it (review I-3)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });

  /** Pause & answer with take-callback held; the run is stopped remotely meanwhile,
   *  so the poll ends it and the callback moves to the ring screen. */
  async function runEndsDuringPauseAndAnswer(): Promise<{ call: FakeCall; release: () => void }> {
    const call = await callbackOnBanner();
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    state.status = 'stopped';
    expect(await screen.findByTitle('Answer', undefined, { timeout: 4000 })).toBeTruthy();
    return { call, release };
  }

  it('a late 409 does not reject the callback now on the ring screen, nor claim it was missed', async () => {
    state.takeCallback = 'connected';
    const { call, release } = await runEndsDuringPauseAndAnswer();
    release();
    await sleep(300);
    expect(call.reject).not.toHaveBeenCalled();
    expect(screen.queryByText(/Missed callback/)).toBeNull();
    expect(screen.getByTitle('Answer')).toBeTruthy();
  }, 15_000);

  it('a late 200 neither answers it behind the ring screen nor says the caller hung up', async () => {
    const { call, release } = await runEndsDuringPauseAndAnswer();
    release();
    await sleep(300);
    expect(call.accept).not.toHaveBeenCalled();
    expect(screen.queryByText('The caller hung up before you answered.')).toBeNull();
    expect(screen.getByTitle('Answer')).toBeTruthy();
  }, 15_000);

  it('a callback no longer on the banner is not rejected after the fact (the caller hung up, then the 409 landed)', async () => {
    const call = await callbackOnBanner();
    state.takeCallback = 'connected';
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    act(() => { call.emit('cancel'); });
    release();
    await waitFor(() => expect(screen.queryByText('Pausing…')).toBeNull());
    await sleep(100);
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('a callback on the ring screen that is rejected by any path takes the ring screen down', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const call = callbackCall();
    ring(call);
    await screen.findByTitle('Answer');
    act(() => { call.reject(); });
    await waitFor(() => expect(screen.queryByTitle('Answer')).toBeNull());
  });
});

describe('App — a callback re-rung on the ring screen (review m1, m2)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });

  it('m1: re-rung after the dropped-leg hand-off, it chimes — the SDK rang it silently, as the Device was busy when it arrived', async () => {
    await callbackOnBanner();
    expect(chime.playCallbackChime).toHaveBeenCalledTimes(1); // the banner's
    dropLeg();
    await screen.findByTitle('Answer', undefined, { timeout: 4000 });
    expect(chime.playCallbackChime).toHaveBeenCalledTimes(2);
  });

  it('m1: …and when re-rung because the run ended under it (Stop)', async () => {
    await callbackOnBanner();
    fireEvent.click(screen.getByText('Stop'));
    await screen.findByTitle('Answer');
    expect(chime.playCallbackChime).toHaveBeenCalledTimes(2);
  });

  it('m2: re-rung because the run ended, the tab reads "busy" at once — no render-long gap in which a leadership loss tears the Device down under the ringing call', async () => {
    const busyWhenRung: boolean[] = [];
    // setPanelVisibility is the last thing ringNormally does, synchronously.
    vi.spyOn(opencti, 'setPanelVisibility').mockImplementation(() => { busyWhenRung.push(state.isBusy!()); });
    await callbackOnBanner();
    busyWhenRung.length = 0; // the banner's own
    fireEvent.click(screen.getByText('Stop'));
    await screen.findByTitle('Answer');
    expect(busyWhenRung).toEqual([true]);
  });

  it('m1: a callback with no run rings exactly as today — the SDK plays its own ringtone, no chime', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    ring(callbackCall());
    await screen.findByTitle('Answer');
    expect(chime.playCallbackChime).not.toHaveBeenCalled();
  });
});

/** Pins for mutants the Task 2 review found surviving (M17-M33). */
describe('App — the Task 2 wiring, pinned (review I-5)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });

  it('M17: Pause & answer leaves the room without the leg ever reading as dropped — the ref is cleared BEFORE disconnect()', async () => {
    const realWatch = dialerLeg.watchDialerLeg;
    const dropped = vi.fn();
    vi.spyOn(dialerLeg, 'watchDialerLeg').mockImplementation((conn, opts) => realWatch(conn, { ...opts, onDropped: () => { dropped(); opts.onDropped(); } }));
    const call = await callbackOnBanner();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    expect(FakeDevice.connects[0]!.connection.disconnect).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('M18: Pause & answer parks the run — the heartbeat keeps it from being reaped while the callback is up', async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    const call = await callbackOnBanner();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    expect(beat).toHaveBeenCalledWith('sess-1', expect.anything());
  });

  it('M19: a callback closed with no event during the pause round trip is not answered, and the rep stays in the room', async () => {
    const call = await callbackOnBanner();
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    act(() => { call.ignore(); });
    release();
    expect(await screen.findByText('The caller hung up before you answered.')).toBeTruthy();
    expect(call.accept).not.toHaveBeenCalled();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('M24: after the dropped-leg hand-off the dead leg is gone — the callback can be answered, and Resume re-joins before it resumes', async () => {
    const call = await callbackOnBanner();
    dropLeg();
    fireEvent.click(await screen.findByTitle('Answer', undefined, { timeout: 4000 }));
    expect(call.accept).toHaveBeenCalledTimes(1);
    act(() => { call.emit('disconnect'); });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(FakeDevice.connects[1]?.connection.hasListenerFor('accept')).toBe(true));
    expect(state.controls).not.toContain('resume');
    act(() => { FakeDevice.connects[1]!.connection.emit('accept'); });
    await waitFor(() => expect(state.controls).toContain('resume'));
  }, 15_000);

  it('M27: the polls that follow a callback waiting while a dial rings do not reject it — only a prospect on the line does', async () => {
    const call = await callbackOnBanner();
    await sleep(2600); // several polls (one a second while a dial rings)
    expect(call.reject).not.toHaveBeenCalled();
    expect(screen.getByText('Callback: Jane Doe · Lead')).toBeTruthy();
  }, 15_000);

  it('M28: a poll showing the prospect talking while Pause & answer is out does not pull the callback from under it — the server has the last word', async () => {
    const call = await callbackOnBanner();
    const release = holdTakeCallback();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(state.controls).toContain('take-callback'));
    state.currentItem = { status: 'connected', prospectEndedAt: null };
    await sleep(2200); // polls see the prospect talking
    expect(call.reject).not.toHaveBeenCalled();
    state.currentItem = { status: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' }; // …who hung up before the pause landed
    release();
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    expect(call.reject).not.toHaveBeenCalled();
  }, 15_000);

  it('M29: Stop with a callback on the banner — it rings the ordinary way instead of being lost', async () => {
    const call = await callbackOnBanner();
    fireEvent.click(screen.getByText('Stop'));
    expect(await screen.findByTitle('Answer')).toBeTruthy();
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('M31: a run parked for a callback keeps this tab "busy" for the softphone election — it is coming back to this Device', async () => {
    await takeAndFinish(await callbackOnBanner());
    await screen.findByText('Resume');
    expect(state.isBusy!()).toBe(true);
  }, 15_000);

  it('M32: losing leadership while parked (phone idle) defers the Device teardown instead of destroying it', async () => {
    await takeAndFinish(await callbackOnBanner());
    await screen.findByText('Resume');
    act(() => { state.leadership!(false); });
    expect(FakeDevice.instances[0]!.destroyed).toBe(0);
  }, 15_000);

  it("M33: leadership lost during the parked run's callback — the Device is kept when the callback ends", async () => {
    const call = await callbackOnBanner();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    act(() => { state.leadership!(false); });
    expect(FakeDevice.instances[0]!.destroyed).toBe(0);
    act(() => { call.emit('disconnect'); });
    await screen.findByText('Resume');
    expect(FakeDevice.instances[0]!.destroyed).toBe(0);
  }, 15_000);

  it("M33: …and the dial pad's reset keeps it too (click-to-dial while parked, then Escape)", async () => {
    let clickToDial: ((e: opencti.ClickToDialEvent) => void) | null = null;
    vi.spyOn(opencti, 'initOpenCti').mockResolvedValue({ ready: true });
    vi.spyOn(opencti, 'onClickToDial').mockImplementation((h) => { clickToDial = h; });
    vi.spyOn(opencti, 'notifyReady').mockImplementation(() => {});
    vi.spyOn(opencti, 'setPanelHeight').mockImplementation(() => {});
    vi.spyOn(opencti, 'setPanelVisibility').mockImplementation(() => {});
    await takeAndFinish(await callbackOnBanner());
    await screen.findByText('Resume');
    act(() => { state.leadership!(false); });
    act(() => { clickToDial!({ number: '+16195550123' }); });
    await screen.findByText(/Firewall error/);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(FakeDevice.instances[0]!.destroyed).toBe(0);
  }, 15_000);
});

/** Task 3 review fixes (2026-09-26): Resume after a callback. */
describe('App — Resume after a callback (Task 3 review)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });

  /** After a callback: Resume pressed, the re-join's connect() done, its accept pending. */
  async function resumeJoining(): Promise<FakeConnection> {
    await takeAndFinish(await callbackOnBanner());
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(FakeDevice.connects[1]?.connection.hasListenerFor('accept')).toBe(true));
    return FakeDevice.connects[1]!.connection;
  }

  it('Important 1: a callback that reaches the ring screen during the join — resume is NOT posted; the rep keeps the leg and the callback waits on the banner', async () => {
    const leg = await resumeJoining();
    const second = callbackCall(2);
    ring(second); // the leg is not adopted yet → the ring screen
    await screen.findByTitle('Answer');
    act(() => { leg.emit('accept'); });
    expect(await screen.findByText('Callback: Jane Doe · Lead')).toBeTruthy();
    await sleep(300);
    expect(state.controls).not.toContain('resume');
    expect(leg.disconnect).not.toHaveBeenCalled();
    expect(second.reject).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Answer')).toBeNull();
    // …and it can be taken from there: back out of the room, then answered.
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(second.accept).toHaveBeenCalledTimes(1));
    expect(leg.disconnect).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('minor 4: answered and hung up in the same tick — refused, never adopted: no resume, and Resume again re-joins', async () => {
    const leg = await resumeJoining();
    act(() => { leg.emit('accept'); leg.emit('disconnect'); });
    expect(await screen.findByText(dialerLeg.LEG_REFUSED_MESSAGE)).toBeTruthy();
    expect(state.controls).not.toContain('resume');
    fireEvent.click(screen.getByText('Resume'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(3));
  }, 15_000);

  it('minor 5 / P2: a join Twilio never answers — no resume, the leg hung up, "check your connection and microphone", the phone stays on Power Dial', async () => {
    const realLegAccepted = dialerLeg.legAccepted;
    vi.spyOn(dialerLeg, 'legAccepted').mockImplementation((c) => realLegAccepted(c, 300));
    const leg = await resumeJoining();
    expect(await screen.findByText(dialerLeg.LEG_JOIN_FAILED_MESSAGE)).toBeTruthy();
    expect(leg.disconnect).toHaveBeenCalledTimes(1);
    expect(state.controls).not.toContain('resume');
    expect(document.querySelector('.nav')).toBeNull();
  }, 15_000);

  it('minor 6: Resume with a callback still being invited on the Device (not yet shown) does not join — connect() would swallow it', async () => {
    await takeAndFinish(await callbackOnBanner());
    const resume = await screen.findByText('Resume');
    FakeDevice.instances[0]!.rung.push(callbackCall(2)); // the SDK has it; 'incoming' not yet emitted
    fireEvent.click(resume);
    expect(await screen.findByText('Finish the current call before resuming the run.')).toBeTruthy();
    expect(FakeDevice.connects.length).toBe(1);
    expect(state.controls).not.toContain('resume');
  }, 15_000);
});
