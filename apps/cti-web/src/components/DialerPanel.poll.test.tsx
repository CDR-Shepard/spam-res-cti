/** @vitest-environment jsdom */
/**
 * Pins the panel's poll LOOP — DialerPanel.test.tsx (node, SSR only) covers
 * `pollDelayMs`, but react-dom/server never runs the effect that schedules the
 * next poll, so the cadence itself needs a mounted panel and fake timers.
 *
 * The loop is a self-rescheduling setTimeout: each poll arms the next with
 * `pollDelayMs(view)`, so a run whose current record is dialing/connected is
 * polled every second and everything else keeps today's 2 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { DialerPanel, POLL_TIMEOUT_MS } from './DialerPanel';
import * as dialerApi from '../dialer-api';
import type { DialerSessionView } from '../dialer-api';

/** A view whose current record is in `itemStatus` (null = no current record). */
const view = (itemStatus: string | null, sessionStatus: DialerSessionView['session']['status'] = 'active'): DialerSessionView => ({
  session: { id: 'sess1', status: sessionStatus },
  counts: { total: 1, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
  currentItem: itemStatus ? { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: itemStatus, toNumber: '+16195551234' } : null,
  rollovers: { moved: 0, pushed: 0, failed: 0, pending: 0 },
});

const noop = () => {};
const mount = () => render(
  <DialerPanel sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}} onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop} />,
);

/** Polls issued AFTER the immediate one the mount fires. */
const pollsAfterMount = (spy: { mock: { calls: unknown[] } }): number => spy.mock.calls.length - 1;

describe('DialerPanel poll cadence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a dialing view polls twice within ~2.1 s where a pending view polls once', async () => {
    const dialing = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view('dialing'));
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(pollsAfterMount(dialing)).toBe(2);
    cleanup();

    const pending = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view('pending'));
    pending.mockClear();
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(pollsAfterMount(pending)).toBe(1);
  });

  // The pop is decided on the FIRST poll that sees `connected`; after that the
  // rep is talking for minutes and nothing changes until they press Next, which
  // re-polls on its own. 1 s here would hold the fast cadence for the whole
  // conversation and buy nothing.
  it('a connected view is back at 2 s — the fast cadence is for the ring, not the conversation', async () => {
    const spy = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view('connected'));
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
    expect(pollsAfterMount(spy)).toBe(2);
  });

  // A fetch that never settles — a laptop that slept mid-poll wakes with a
  // half-open socket Chrome can hold for minutes — used to be harmless: the
  // interval fired regardless. A self-rescheduling loop arms the next poll only
  // when this one settles, so the panel would freeze on its last view with no
  // error and the next connect would never pop.
  it('a poll that never settles is abandoned after the timeout and the loop carries on', async () => {
    const spy = vi.spyOn(dialerApi, 'getDialer').mockImplementation((_id, opts) =>
      new Promise<DialerSessionView>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS - 100); });
    expect(spy).toHaveBeenCalledTimes(1);
    // timeout → rejection → the usual 2 s re-arm
    await act(async () => { await vi.advanceTimersByTimeAsync(100 + 2100); });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a poll that FAILS (503, network blip) re-arms at 2 s instead of ending the loop', async () => {
    const spy = vi.spyOn(dialerApi, 'getDialer')
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue(view('pending'));
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(pollsAfterMount(spy)).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(pollsAfterMount(spy)).toBe(2);
  });

  // Every control action re-polls immediately. That re-poll must REPLACE the
  // pending tick, not run beside it: otherwise each click adds a permanent
  // parallel chain and the poll rate doubles per click for the rest of the run.
  it("a control action's immediate re-poll replaces the pending tick rather than forking a second chain", async () => {
    const spy = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view('pending'));
    vi.spyOn(dialerApi, 'dialerControl').mockResolvedValue({ ok: true });
    const r = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(r.getByText('Pause')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(spy).toHaveBeenCalledTimes(2); // the re-poll
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(spy).toHaveBeenCalledTimes(4); // two more ticks, not four
  });

  it('the cadence follows the LATEST view: a dial that settles drops back to 2 s', async () => {
    const spy = vi.spyOn(dialerApi, 'getDialer')
      .mockResolvedValueOnce(view('dialing'))   // mount → next in 1 s
      .mockResolvedValueOnce(view('no_connect')) // t=1 s → next in 2 s
      .mockResolvedValue(view('pending'));
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(pollsAfterMount(spy)).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // t=2.1 s: nothing yet
    expect(pollsAfterMount(spy)).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // t=3.1 s: the 2 s poll
    expect(pollsAfterMount(spy)).toBe(2);
  });

  it('a stopped poll never re-arms: once the terminal run has settled, no further polls', async () => {
    // done + no pending rollovers → shouldKeepPollingForRollovers is false on
    // the very first poll, which stops polling. A self-rescheduling loop must
    // honor that stop instead of arming the next tick regardless.
    const spy = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view(null, 'done'));
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(pollsAfterMount(spy)).toBe(0);
  });

  it('unmounting cancels the pending poll', async () => {
    const spy = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view('dialing'));
    const r = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(pollsAfterMount(spy)).toBe(1);
    r.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(pollsAfterMount(spy)).toBe(1);
  });
});
