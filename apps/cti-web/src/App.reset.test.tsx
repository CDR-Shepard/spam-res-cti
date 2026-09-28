/** @vitest-environment jsdom */
/**
 * Reset CTI in the real App (spec 2026-09-28): the reset poller in a signed-in
 * tab, the order of a reset, that it waits out a ringing call, that a 401 on
 * the poll is never a sign-out, and the sign-in notice after the reload.
 * Only @twilio/voice-sdk and fetch are faked; the coordinator is real (a lone
 * tab leads). jsdom's location can't be spied, so App reloads through
 * cti-reset.ts `pageReloader`, which these tests spy on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { pageReloader, RESET_NOTICE_TEXT } from './cti-reset';
import * as opencti from './opencti';

const events: string[] = [];

class FakeDevice {
  static instances: FakeDevice[] = [];
  /** When set, register() waits on this. */
  static registerGate: Promise<void> | null = null;
  /** Outbound calls placed on any FakeDevice. */
  static connects = 0;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_token: string, _opts: unknown) { FakeDevice.instances.push(this); }
  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  register(): Promise<void> { return FakeDevice.registerGate ?? Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { events.push('device destroyed'); }
  async connect(): Promise<{ on: () => void; parameters: Record<string, string> }> {
    FakeDevice.connects += 1;
    return { on: () => {}, parameters: {} };
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const ME = {
  user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: false },
  salesforce: { connected: false },
};
const SESSION = JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' });

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

let resetSignal: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;
/** When set, these requests wait on the gate before answering. */
const gates: { resetComplete: Promise<void> | null; token: Promise<void> | null; firewall: Promise<void> | null } = {
  resetComplete: null, token: null, firewall: null,
};
/** A gate plus the function that opens it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const ALLOW_VERDICT = {
  decision: 'ALLOW', reasons: [], blockReason: null, requiredScriptId: null, auditId: 'audit-1',
  checks: [], normalizedTo: '+16195551234', fromNumber: '+16195559999',
};

/** HTTP status for each /telephony/token call, in order; 200 once they run out. */
let tokenStatuses: number[] = [];
/** The server's un-dispositioned call (the banner), and the Recent list. */
let pendingDisposition: Record<string, unknown> | null = null;
let recentRows: Array<Record<string, unknown>> = [];

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.registerGate = null;
  FakeDevice.connects = 0;
  tokenStatuses = [];
  pendingDisposition = null;
  recentRows = [];
  events.length = 0;
  gates.resetComplete = null;
  gates.token = null;
  gates.firewall = null;
  localStorage.clear();
  resetSignal = () => jsonResponse({ resetDue: false });
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/auth/reset-signal')) return resetSignal();
    if (url.includes('/auth/reset-complete') && method === 'POST') {
      events.push(localStorage.getItem('cti.session.v1') ? 'reset-complete (session still stored)' : 'reset-complete (session already gone)');
      if (gates.resetComplete) await gates.resetComplete;
      return jsonResponse({ ok: true });
    }
    if (url.includes('/firewall/precall')) {
      if (gates.firewall) await gates.firewall;
      return jsonResponse(ALLOW_VERDICT);
    }
    if (method === 'POST' && url.endsWith('/calls')) {
      events.push('POST /calls');
      return jsonResponse({ call: { id: 'call-1', fromNumber: '+16195559999', toNumber: '+16195551234', normalizedToNumber: '+16195551234' } });
    }
    const tokenStatus = url.includes('/telephony/token') ? tokenStatuses[callsTo('/telephony/token') - 1] ?? 200 : 200;
    if (tokenStatus !== 200) return jsonResponse({ error: 'no token' }, tokenStatus);
    if (url.includes('/telephony/token') && gates.token) {
      await gates.token;
      return jsonResponse({ token: 'device-token' });
    }
    if (url.includes('/auth/dev-session')) return jsonResponse({ error: 'Not found' }, 404);
    if (url.includes('/auth/salesforce/login/start')) return jsonResponse({ authUrl: 'https://login.example.com/x', handshake: 'h1' });
    if (url.includes('/auth/salesforce/login/status')) {
      return jsonResponse({ status: 'connected', token: 'tok2', user: { id: 'u1', email: 'rep@example.com' } });
    }
    if (url.includes('/auth/me')) return jsonResponse(ME);
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: pendingDisposition });
    if (url.includes('/calls?limit=')) return jsonResponse({ calls: recentRows });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(pageReloader, 'reload').mockImplementation(() => {
    events.push(localStorage.getItem('cti.session.v1') === null ? 'reload (wiped)' : 'reload (NOT wiped)');
  });
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const signedIn = (): void => { localStorage.setItem('cti.session.v1', SESSION); };
const callsTo = (path: string): number => fetchMock.mock.calls.filter(([u]) => String(u).includes(path)).length;
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('App — an idle rep with a reset due', () => {
  it('waits for the coordinator to hear its peers, then: Device down → reset-complete (old session) → wipe + flags → reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    localStorage.setItem('cti.displayName', 'Ada');
    localStorage.setItem('cti.audio.input', 'mic-jabra');
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    localStorage.setItem('unrelated', 'kept');
    resetSignal = () => jsonResponse({ resetDue: true });
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));

    await advance(2_500);
    expect(events).toEqual([]); // a freshly loaded tab never acts before it knows its peers

    await advance(6_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)', 'reload (wiped)']);
    for (const k of ['cti.session.v1', 'cti.displayName', 'cti.audio.input', 'cti.audio.output']) expect(localStorage.getItem(k)).toBeNull();
    expect(localStorage.getItem('cti.soundCheck.due')).toBe('1');
    expect(localStorage.getItem('cti.reset.notice')).toBe('1');
    expect(localStorage.getItem('unrelated')).toBe('kept');
    expect(callsTo('/auth/reset-complete')).toBe(1);
  });
});

/** Dial a number on the pad (the rep's auto-place flow starts from here). */
function dialDigits(digits: string): void {
  for (const d of digits) {
    const key = Array.from(document.querySelectorAll('.dialpad .key')).find((b) => b.querySelector('.num')?.textContent === d);
    if (!key) throw new Error(`no dial pad key for "${d}"`);
    fireEvent.click(key);
  }
}

describe('App — C1: nothing builds a Device between the teardown and the reload', () => {
  // The reviewer's repro: `online` fired while the reset-complete POST was in
  // flight, a new Device registered, a callback rang, and the reload landed
  // with the Decline screen up.
  it('`online` while the reset-complete POST is in flight builds no Device, and says nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    resetSignal = () => jsonResponse({ resetDue: true });
    const post = gate();
    gates.resetComplete = post.promise;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    await advance(8_000);
    await waitFor(() => expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)']));
    expect(screen.getByText('Resetting your phone…')).toBeTruthy();

    act(() => { window.dispatchEvent(new Event('online')); });
    await advance(1_000);
    expect(FakeDevice.instances.length).toBe(1);
    expect(callsTo('/telephony/token')).toBe(1);
    expect(document.querySelector('.toast')).toBeNull();

    post.open();
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(FakeDevice.instances.length).toBe(1);
    expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)', 'reload (wiped)']);
  });

  it('a Device build already in flight when the reset began destroys nothing of the next page — it builds no Device at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    resetSignal = () => jsonResponse({ resetDue: true });
    const token = gate();
    gates.token = token.promise; // the leader's first Device is still fetching its token
    render(<App />);
    await waitFor(() => expect(callsTo('/telephony/token')).toBe(1));
    await advance(8_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));

    token.open(); // the build resumes AFTER the teardown
    await advance(1_000);
    expect(FakeDevice.instances.length).toBe(0);
    expect(document.querySelector('.toast')).toBeNull();
  });

  // Same generation check, the other await: the Device exists and is
  // registering when the teardown lands (here a sign-out: the SDK's token
  // refresh came back 401). The caller that started that build — a dial,
  // because the leader's first build failed — gets a refusal, never the
  // destroyed Device.
  it('a teardown while the Device registers: the dial that started the build never connects on the destroyed Device', async () => {
    signedIn();
    tokenStatuses = [500, 200, 401]; // mount build fails; the dial's build gets a token; its refresh is refused
    render(<App />);
    await waitFor(() => expect(callsTo('/telephony/token')).toBe(1));
    await waitFor(() => expect(document.querySelector('.toast')).not.toBeNull()); // "Inbound calls unavailable"
    expect(FakeDevice.instances.length).toBe(0);

    const register = gate();
    FakeDevice.registerGate = register.promise;
    dialDigits('6195551234');
    fireEvent.click(screen.getByTitle('Check & call'));
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1)); // place() is building it, and waits
    act(() => { FakeDevice.instances[0]!.emit('tokenWillExpire'); });
    await waitFor(() => expect(events).toContain('device destroyed'));

    register.open();
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    expect(FakeDevice.connects).toBe(0);
  });

  it('a firewall answer that lands mid-reset places no call (the auto-place refuses quietly)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    resetSignal = () => jsonResponse({ resetDue: true });
    const firewall = gate();
    gates.firewall = firewall.promise;
    const post = gate();
    gates.resetComplete = post.promise;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    dialDigits('6195551234');
    fireEvent.click(screen.getByTitle('Check & call'));
    await advance(8_000);
    await waitFor(() => expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)']));

    firewall.open(); // ALLOW: a rep's verdict places the call at once — but not now
    await advance(1_000);
    expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)']);
    expect(FakeDevice.instances.length).toBe(1);
    expect(document.querySelector('.toast')).toBeNull();

    post.open();
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
  });
});

describe('App — M3: another tab reset and this one missed the broadcast', () => {
  it("the next poll finds storage wiped: Device down and reload — no POST, and storage left as the other tab left it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    await waitFor(() => expect(callsTo('/auth/reset-signal')).toBe(1));

    // The other tab's reset: wipe, then its two flags.
    localStorage.removeItem('cti.session.v1');
    localStorage.setItem('cti.soundCheck.due', '1');
    localStorage.setItem('cti.reset.notice', '1');
    await advance(21_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['device destroyed', 'reload (wiped)']);
    expect(callsTo('/auth/reset-signal')).toBe(1); // it never asked
    expect(callsTo('/auth/reset-complete')).toBe(0);
  });
});

describe('App — a reset never interrupts a call', () => {
  it('waits while a callback rings, then resets once the rep declines it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    resetSignal = () => jsonResponse({ resetDue: true });
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const call = {
      parameters: { From: '+16195551234' },
      customParameters: new Map<string, string>(),
      accept: vi.fn(),
      reject: vi.fn(),
      on: vi.fn(),
    };
    act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
    await screen.findByTitle('Decline');

    await advance(30_000);
    expect(events).toEqual([]);
    expect(callsTo('/auth/reset-complete')).toBe(0);
    expect(pageReloader.reload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Decline'));
    await advance(8_000);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)', 'reload (wiped)']);
  });
});

describe('App — the reset poll never signs anyone out', () => {
  it('a 401 on reset-signal is ignored: the Device stays, the rep stays signed in, and it polls again 20 s later', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    resetSignal = () => jsonResponse({ error: 'Unauthorized' }, 401);
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    await waitFor(() => expect(callsTo('/auth/reset-signal')).toBe(1));
    await advance(21_000);
    expect(callsTo('/auth/reset-signal')).toBe(2);
    expect(events).toEqual([]);
    expect(screen.queryByText('Sign in with Salesforce')).toBeNull();
    expect(localStorage.getItem('cti.session.v1')).toBe(SESSION);
  });

  it('no reset pending: one poll on sign-in and one every 20 s — nothing else happens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    await waitFor(() => expect(callsTo('/auth/reset-signal')).toBe(1));
    await advance(41_000);
    expect(callsTo('/auth/reset-signal')).toBe(3);
    expect(events).toEqual([]);
    expect(callsTo('/auth/reset-complete')).toBe(0);
  });
});

describe('App — after a reset, the sign-in screen says why', () => {
  it('shows the notice when the flag is set', async () => {
    localStorage.setItem('cti.reset.notice', '1');
    render(<App />);
    expect(await screen.findByText('Sign in with Salesforce')).toBeTruthy();
    expect(screen.getByText(RESET_NOTICE_TEXT)).toBeTruthy();
  });

  it('no flag, no notice', async () => {
    render(<App />);
    await screen.findByText('Sign in with Salesforce');
    expect(screen.queryByText(RESET_NOTICE_TEXT)).toBeNull();
  });

  it('signing in clears the notice and its flag', async () => {
    localStorage.setItem('cti.reset.notice', '1');
    vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<App />);
    fireEvent.click(await screen.findByText('Sign in with Salesforce'));
    await waitFor(() => expect(localStorage.getItem('cti.reset.notice')).toBeNull());
    await waitFor(() => expect(screen.queryByText(RESET_NOTICE_TEXT)).toBeNull());
    expect(JSON.parse(localStorage.getItem('cti.session.v1')!).token).toBe('tok2');
  });
});

// Follow-up 2 (final review): after a reset every tab of the rep lands on the
// sign-in gate. Signing in on one must bring the others back with it.
describe('App — on the sign-in gate, another tab signs in', () => {
  const OTHER_SESSION = JSON.stringify({ token: 'tok2', userId: 'u1', email: 'rep@example.com' });
  /** Another tab writes (or removes) the session: this tab hears a storage event. */
  const otherTabWrites = (value: string | null): void => {
    act(() => {
      if (value === null) localStorage.removeItem('cti.session.v1');
      else localStorage.setItem('cti.session.v1', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'cti.session.v1', newValue: value }));
    });
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  };

  it('reloads this tab, so it picks the new session up', async () => {
    render(<App />);
    await screen.findByText('Sign in with Salesforce');
    otherTabWrites(OTHER_SESSION);
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
  });

  it('a session going away, another key, or a clear() never reloads it', async () => {
    render(<App />);
    await screen.findByText('Sign in with Salesforce');
    otherTabWrites(null);
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'cti.audio.input', newValue: 'mic-jabra' })); });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
    await settle();
    expect(pageReloader.reload).not.toHaveBeenCalled();
  });

  it('a session that came and went again (signed in, then out) does not reload it', async () => {
    render(<App />);
    await screen.findByText('Sign in with Salesforce');
    act(() => {
      localStorage.setItem('cti.session.v1', OTHER_SESSION);
      window.dispatchEvent(new StorageEvent('storage', { key: 'cti.session.v1', newValue: OTHER_SESSION }));
      localStorage.removeItem('cti.session.v1');
      window.dispatchEvent(new StorageEvent('storage', { key: 'cti.session.v1', newValue: null }));
    });
    await settle();
    expect(pageReloader.reload).not.toHaveBeenCalled();
  });

  it('a signed-in tab never reloads on it', async () => {
    signedIn();
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    otherTabWrites(OTHER_SESSION);
    await settle();
    expect(pageReloader.reload).not.toHaveBeenCalled();
  });

  // A refresh 401 mid-call signs out but keeps the call (M1): the reload must
  // wait for it, or it would cut the call.
  it('never under a call still ringing behind the gate: it reloads once the call is gone', async () => {
    signedIn();
    tokenStatuses = [200, 401]; // the mount's Device gets a token; its refresh is refused
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const listeners = new Map<string, Array<() => void>>();
    const call = {
      parameters: { From: '+16195551234' },
      customParameters: new Map<string, string>(),
      accept: vi.fn(),
      reject: vi.fn(),
      on: (event: string, cb: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    };
    act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
    await screen.findByTitle('Decline');
    act(() => { FakeDevice.instances[0]!.emit('tokenWillExpire'); });
    await screen.findByText('Sign in with Salesforce'); // signed out; the ring is still up
    otherTabWrites(OTHER_SESSION);
    await settle();
    expect(pageReloader.reload).not.toHaveBeenCalled();
    expect(events).not.toContain('device destroyed');

    act(() => { for (const cb of listeners.get('cancel') ?? []) cb(); }); // the caller hangs up
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(events).toContain('device destroyed');
  });
});

// Follow-up 5 (final review): reopening a disposition is locked during a reset
// too. The session is being revoked — a wrap-up opened now could never save.
describe('App — no wrap-up reopens during a reset', () => {
  const CALL = {
    id: 'call-9', toNumber: '+16195551234', normalizedToNumber: '+16195551234', fromNumber: '+16195559999',
    direction: 'outbound', status: 'completed', disposition: null, notes: null, durationSeconds: 30,
    salesforceTaskId: null, salesforceWhoId: null, salesforceWhatId: null, createdAt: new Date().toISOString(), syncError: null,
  };

  it('hides the pending-disposition banner, and a Recent row does not reopen the wrap-up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    pendingDisposition = { id: 'call-9', toNumber: '+16195551234', fromNumber: '+16195559999', durationSeconds: 30, status: 'completed', notes: '' };
    recentRows = [CALL];
    resetSignal = () => jsonResponse({ resetDue: true });
    const post = gate();
    gates.resetComplete = post.promise;
    render(<App />);
    await screen.findByText(/needs a disposition/); // an old disposition never holds a reset back (R1)
    await advance(8_000);
    await waitFor(() => expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)']));
    expect(screen.queryByText(/needs a disposition/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    fireEvent.click(await screen.findByTitle('Finish disposition'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Log call')).toBeNull();

    post.open();
    await waitFor(() => expect(pageReloader.reload).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['device destroyed', 'reset-complete (session still stored)', 'reload (wiped)']);
  });

  it('with no reset, the banner reopens the wrap-up as before', async () => {
    signedIn();
    pendingDisposition = { id: 'call-9', toNumber: '+16195551234', fromNumber: '+16195559999', durationSeconds: 30, status: 'completed', notes: '' };
    render(<App />);
    fireEvent.click(await screen.findByText(/needs a disposition/));
    expect(await screen.findByText('Log call')).toBeTruthy();
  });
});
