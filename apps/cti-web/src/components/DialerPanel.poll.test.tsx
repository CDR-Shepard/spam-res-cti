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
import { act, cleanup, render } from '@testing-library/react';
import { DialerPanel } from './DialerPanel';
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

  it('a connected view polls every second too (the pop is decided on this poll)', async () => {
    const spy = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view('connected'));
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(pollsAfterMount(spy)).toBe(3);
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
