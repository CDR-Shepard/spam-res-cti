/** @vitest-environment jsdom */
/**
 * Reset CTI across two tabs of the same rep, in the real App (spec 2026-09-28,
 * decision 4): two <App/>s share localStorage (as two tabs do) and a fake
 * BroadcastChannel, so their real coordinators elect one leader, exchange
 * presence (with resetBusy) and deliver the {type:'reset'} broadcast. Pins the
 * App-level wiring no unit test reaches:
 *   - App hands resetBusy to the coordinator, so a peer in wrap-up (not busy
 *     for the election) holds the leader's reset back;
 *   - App wires coord.onReset to the hook, so the peer finishes on the
 *     broadcast — at once, not whenever it next leads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { pageReloader } from './cti-reset';
import * as opencti from './opencti';
import * as coordinator from './softphone-coordinator';

class FakeDevice {
  static instances: FakeDevice[] = [];
  destroyed = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_token: string, _opts: unknown) { FakeDevice.instances.push(this); }
  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { this.destroyed = true; }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

/** Same-name channels see each other's messages, one task later (as the real one delivers). */
class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((e: MessageEvent) => void) | null = null;
  private closed = false;
  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set<FakeBroadcastChannel>();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }
  postMessage(data: unknown): void {
    for (const other of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (other === this) continue;
      setTimeout(() => { if (!other.closed) other.onmessage?.({ data } as MessageEvent); }, 0);
    }
  }
  close(): void {
    this.closed = true;
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

const ME = {
  user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: false },
  salesforce: { connected: false },
};
const PENDING = { id: 'call-9', toNumber: '+16195551234', fromNumber: '+16195559999', durationSeconds: 30, status: 'completed', notes: '' };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

const state = { resetDue: false, pending: PENDING as typeof PENDING | null };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeBroadcastChannel.channels.clear();
  state.resetDue = false;
  state.pending = PENDING;
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  // Deterministic tab ids in mount order: the first tab is 'a', and wins ties.
  const ids = ['a', 'b'];
  const realDeps = coordinator.browserCoordinatorDeps;
  vi.spyOn(coordinator, 'browserCoordinatorDeps').mockImplementation((...args: Parameters<typeof realDeps>) => {
    const id = ids.shift() ?? 'z';
    return { ...realDeps(...args), randomId: () => id };
  });
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/reset-signal')) return jsonResponse({ resetDue: state.resetDue });
    if (url.includes('/auth/reset-complete') && init?.method === 'POST') return jsonResponse({ ok: true });
    if (url.includes('/auth/me')) return jsonResponse(ME);
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: state.pending });
    if (url.includes('/calls/call-9/disposition')) { state.pending = null; return jsonResponse({ ok: true }); }
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
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

// Task 3 review I3 (M17): only the softphone tab holds the Device.
describe('App × 2 tabs — Reset my audio in the tab that is not the softphone', () => {
  it("builds no Device there and never touches the leader's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.pending = null;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1)); // tab a: the leader's Device
    const tabB = render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(2)); // b, alone for a moment, built one
    await advance(4_000); // b heard a and stood down
    const built = FakeDevice.instances.length;
    expect(FakeDevice.instances.filter((d) => !d.destroyed)).toEqual([FakeDevice.instances[0]]);

    fireEvent.click(within(tabB.container).getByRole('button', { name: 'Settings' }));
    fireEvent.click(await within(tabB.container).findByRole('button', { name: 'Reset my audio' }));
    await advance(1_000);
    expect(FakeDevice.instances.length).toBe(built);
    expect(FakeDevice.instances[0]!.destroyed).toBe(false);
    // Task 3 review M-h: it says what really happens — no rebuild here.
    expect(within(tabB.container).getByText('Audio settings cleared — your active softphone tab will use System default.')).toBeTruthy();
  });
});

describe('App × 2 tabs — a peer in wrap-up holds the leader back; then both reset', () => {
  it('the leader waits out the peer\'s wrap-up, then resets, and the peer finishes on the broadcast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tabA = render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1)); // tab a: the leader's Device
    const tabB = render(<App />);
    await within(tabB.container).findByText(/needs a disposition/);
    await advance(4_000); // presence exchanged; b stood down (its brief Device is gone)
    const live = FakeDevice.instances.filter((d) => !d.destroyed);
    expect(live).toEqual([FakeDevice.instances[0]]);

    // Tab b opens the wrap-up form: busy for a reset, never for the election.
    fireEvent.click(within(tabB.container).getByText(/needs a disposition/));
    await within(tabB.container).findByText('Log call');
    state.resetDue = true;
    await advance(21_000); // both tabs learn the reset is due
    await advance(10_000);
    expect(callsTo('/auth/reset-complete')).toBe(0);
    expect(pageReloader.reload).not.toHaveBeenCalled();
    expect(FakeDevice.instances[0]!.destroyed).toBe(false);
    expect(within(tabA.container).queryByText('Log call')).toBeNull(); // the leader was idle all along

    // Tab b logs the call: idle. Within a beat and two checks, tab a resets —
    // and tab b finishes on the broadcast, straight away (it is not the leader,
    // so without the broadcast it would never finish while tab a lives).
    fireEvent.click(within(tabB.container).getByText('Log call'));
    await waitFor(() => expect(within(tabB.container).queryByText('Log call')).toBeNull());
    await advance(6_000);
    await waitFor(() => expect(callsTo('/auth/reset-complete')).toBe(1));
    await advance(100);
    expect(pageReloader.reload).toHaveBeenCalledTimes(2);
    expect(FakeDevice.instances[0]!.destroyed).toBe(true);
    expect(localStorage.getItem('cti.session.v1')).toBeNull();
  });
});
