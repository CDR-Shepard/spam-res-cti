/** @vitest-environment jsdom */
/**
 * DialerPanel's side of callback waiting (spec
 * docs/superpowers/specs/2026-09-26-callback-waiting-design.md): it hands App a
 * run snapshot on every poll (Task 2); in Task 3 it also shows the banner,
 * re-joins before Resume, and screen-pops once per record across remounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialerPanel, type DialerPanelProps } from './DialerPanel';
import * as dialerApi from '../dialer-api';
import type { DialerCurrentItem, DialerSession, DialerSessionView } from '../dialer-api';

const view = (o: { sessionStatus?: DialerSession['status']; item?: Partial<DialerCurrentItem> | null } = {}): DialerSessionView => ({
  session: { id: 'sess1', status: o.sessionStatus ?? 'active' },
  counts: { total: 2, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 2 },
  currentItem: o.item === null
    ? null
    : { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234', ...(o.item ?? {}) },
  rollovers: { moved: 0, pushed: 0, failed: 0, pending: 0 },
});

const noop = (): void => {};
function mount(extra: Partial<DialerPanelProps> = {}) {
  return render(
    <DialerPanel sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}} onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop} {...extra} />,
  );
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DialerPanel — the lifted run snapshot (Task 2)', () => {
  it('hands every successful poll to onRunSnapshot — the slice App judges "talking" by', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ item: { status: 'connected', prospectEndedAt: null } }));
    const onRunSnapshot = vi.fn();
    mount({ onRunSnapshot });
    await waitFor(() => expect(onRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess1', sessionStatus: 'active', itemStatus: 'connected', prospectEndedAt: null }));
  });

  it('between dials the snapshot has no item', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const onRunSnapshot = vi.fn();
    mount({ onRunSnapshot });
    await waitFor(() => expect(onRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess1', sessionStatus: 'paused', itemStatus: null, prospectEndedAt: null }));
  });

  it('a failed poll hands nothing over — the last good snapshot stands', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockRejectedValue(new Error('offline'));
    const onRunSnapshot = vi.fn();
    mount({ onRunSnapshot });
    await waitFor(() => expect(dialerApi.getDialer).toHaveBeenCalled());
    await new Promise((r) => { setTimeout(r, 20); });
    expect(onRunSnapshot).not.toHaveBeenCalled();
  });
});
