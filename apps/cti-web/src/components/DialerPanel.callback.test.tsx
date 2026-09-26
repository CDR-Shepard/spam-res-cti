/** @vitest-environment jsdom */
/**
 * DialerPanel's side of callback waiting (spec
 * docs/superpowers/specs/2026-09-26-callback-waiting-design.md): it hands App a
 * run snapshot on every poll (Task 2); in Task 3 it also shows the banner,
 * re-joins before Resume, and screen-pops once per record across remounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialerPanel, shouldPopItem, withRejoin, type DialerPanelProps, type PopLedger } from './DialerPanel';
import * as dialerApi from '../dialer-api';
import * as chime from '../callback-chime';
import type { DialerControlAction, DialerCurrentItem, DialerSession, DialerSessionView } from '../dialer-api';

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

  // Review m3: the poll loop is set up once per sessionId; it must not keep
  // the handler it started with.
  it('a new onRunSnapshot handed down mid-run is the one the next poll calls', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    const first = vi.fn();
    const second = vi.fn();
    const props: DialerPanelProps = {
      sessionId: 'sess1', onScreenPop: noop, onStartFromListView: async () => {}, onPrepare: async () => {},
      onJoin: async () => true, onStop: noop, onComplete: noop, onDismiss: noop,
    };
    const { rerender } = render(<DialerPanel {...props} onRunSnapshot={first} />);
    await waitFor(() => expect(first).toHaveBeenCalled());
    rerender(<DialerPanel {...props} onRunSnapshot={second} />);
    const before = first.mock.calls.length;
    await waitFor(() => expect(second).toHaveBeenCalled(), { timeout: 3000 });
    expect(first.mock.calls.length).toBe(before);
  });
});

describe('DialerPanel — the callback banner (Task 3)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });
  const cb = (o: Record<string, unknown> = {}) => ({
    id: 'CA1', callerLabel: 'Jane Doe', recordType: 'Lead', busy: false, onAnswer: vi.fn(), onIgnore: vi.fn(), ...o,
  });

  it('sits above the current-record card', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    const { container } = mount({ callback: cb() });
    await screen.findByText('Callback: Jane Doe · Lead');
    const banner = container.querySelector('.dp-callback')!;
    const card = container.querySelector('.dp-current')!;
    expect(banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows between dials too, when there is no current record', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ item: null }));
    mount({ callback: cb() });
    expect(await screen.findByText('Callback: Jane Doe · Lead')).toBeTruthy();
  });

  it('wires Pause & answer and Ignore', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    const c = cb();
    mount({ callback: c });
    fireEvent.click(await screen.findByText('Pause & answer'));
    fireEvent.click(screen.getByText('Ignore'));
    expect(c.onAnswer).toHaveBeenCalledTimes(1);
    expect(c.onIgnore).toHaveBeenCalledTimes(1);
  });

  // Task 3 review, minor 6: a plain Pause/Resume/Skip must not race a
  // take-callback in flight. Stop stays — ending the run is always allowed.
  it('while Pause & answer is in flight, Pause/Resume and the item controls are disabled; Stop is not', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    mount({ callback: cb({ busy: true }) });
    const button = (label: string): HTMLButtonElement => screen.getByText(label).closest('button') as HTMLButtonElement;
    await screen.findByText('Pause');
    expect(button('Pause').disabled).toBe(true);
    expect(button('Skip').disabled).toBe(true);
    expect(button('Stop').disabled).toBe(false);
  });

  it('…and enabled again once it settles', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    mount({ callback: cb({ busy: false }) });
    const button = (label: string): HTMLButtonElement => screen.getByText(label).closest('button') as HTMLButtonElement;
    await screen.findByText('Pause');
    expect(button('Pause').disabled).toBe(false);
    expect(button('Skip').disabled).toBe(false);
  });

  it('is not shown once the run is over', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'done', item: null }));
    mount({ callback: cb() });
    await screen.findByText('Run complete');
    expect(screen.queryByText('Callback: Jane Doe · Lead')).toBeNull();
  });
});

describe('withRejoin — Resume re-joins the room first when this tab has no leg (decision 6)', () => {
  it('puts join in FRONT of any request that resumes, when the leg is down', () => {
    expect(withRejoin(['resume'], true)).toEqual(['join', 'resume']);
    expect(withRejoin(['next', 'resume'], true)).toEqual(['join', 'next', 'resume']);
    expect(withRejoin(['redial', 'resume'], true)).toEqual(['join', 'redial', 'resume']);
  });
  it('leaves everything else alone', () => {
    expect(withRejoin(['resume'], false)).toEqual(['resume']);
    expect(withRejoin(['pause'], true)).toEqual(['pause']);
    expect(withRejoin(['skip'], true)).toEqual(['skip']);
    expect(withRejoin(['stop'], true)).toEqual(['stop']);
  });
});

describe('DialerPanel — Resume after a callback (Task 3)', () => {
  function recordControls(order: string[]): void {
    vi.spyOn(dialerApi, 'dialerControl').mockImplementation(async (_id: string, action: DialerControlAction) => {
      order.push(action);
      return { ok: true };
    });
  }

  it('with no leg: joins the room first, and only then POSTs resume', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const order: string[] = [];
    recordControls(order);
    mount({ needsRejoin: () => true, onRejoin: async () => { order.push('join'); return true; } });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(order).toEqual(['join', 'resume']));
  });

  it('a join a Stop superseded (false) sends nothing', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const order: string[] = [];
    recordControls(order);
    const onRejoin = vi.fn(async () => false);
    mount({ needsRejoin: () => true, onRejoin });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(onRejoin).toHaveBeenCalled());
    await new Promise((r) => { setTimeout(r, 20); });
    expect(order).toEqual([]);
  });

  it('a refused join says why and sends nothing', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const order: string[] = [];
    recordControls(order);
    mount({ needsRejoin: () => true, onRejoin: async () => { throw new Error("Couldn't rejoin the run — if another power-dial run of yours is live, stop it first."); } });
    fireEvent.click(await screen.findByText('Resume'));
    expect(await screen.findByText("Couldn't rejoin the run — if another power-dial run of yours is live, stop it first.")).toBeTruthy();
    expect(order).toEqual([]);
  });

  it('with a live leg: Resume is the plain resume it always was', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const order: string[] = [];
    recordControls(order);
    const onRejoin = vi.fn(async () => true);
    mount({ needsRejoin: () => false, onRejoin });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(order).toEqual(['resume']));
    expect(onRejoin).not.toHaveBeenCalled();
  });

  it('a hung-up prospect card on a paused run: Resume re-joins, then next, then resume', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: { status: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' } }));
    const order: string[] = [];
    recordControls(order);
    mount({ needsRejoin: () => true, onRejoin: async () => { order.push('join'); return true; } });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(order).toEqual(['join', 'next', 'resume']));
  });

  it('Pause never re-joins', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    const order: string[] = [];
    recordControls(order);
    const onRejoin = vi.fn(async () => true);
    mount({ needsRejoin: () => true, onRejoin });
    fireEvent.click(await screen.findByText('Pause'));
    await waitFor(() => expect(order).toEqual(['pause']));
    expect(onRejoin).not.toHaveBeenCalled();
  });
});

describe('DialerPanel — one screen-pop per connected record, across remounts (decision 8)', () => {
  it('shouldPopItem: a connected record not yet popped in THIS run', () => {
    const connected = { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'connected', toNumber: null };
    expect(shouldPopItem({ sessionId: null, itemId: null }, 'sess1', connected)).toBe(true);
    expect(shouldPopItem({ sessionId: 'sess1', itemId: 'i1' }, 'sess1', connected)).toBe(false);
    expect(shouldPopItem({ sessionId: 'sess0', itemId: 'i1' }, 'sess1', connected)).toBe(true);
    expect(shouldPopItem({ sessionId: null, itemId: null }, 'sess1', { ...connected, status: 'dialing' })).toBe(false);
    expect(shouldPopItem({ sessionId: null, itemId: null }, 'sess1', null)).toBe(false);
  });

  it('an App-owned ledger stops a remounted panel popping the same record again', async () => {
    const getDialer = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ item: { status: 'connected' } }));
    const ledger = { current: { sessionId: null, itemId: null } as PopLedger };
    const onScreenPop = vi.fn();
    const first = mount({ onScreenPop, popLedger: ledger });
    await waitFor(() => expect(onScreenPop).toHaveBeenCalledTimes(1));
    first.unmount();
    const before = getDialer.mock.calls.length;
    mount({ onScreenPop, popLedger: ledger });
    await waitFor(() => expect(getDialer.mock.calls.length).toBeGreaterThan(before));
    await new Promise((r) => { setTimeout(r, 20); });
    expect(onScreenPop).toHaveBeenCalledTimes(1);
  });

  it('a new record in the same run still pops', async () => {
    const getDialer = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ item: { status: 'connected' } }));
    const ledger = { current: { sessionId: 'sess1', itemId: 'i0' } as PopLedger };
    const onScreenPop = vi.fn();
    mount({ onScreenPop, popLedger: ledger });
    await waitFor(() => expect(onScreenPop).toHaveBeenCalledWith('00Q1'));
    expect(ledger.current).toEqual({ sessionId: 'sess1', itemId: 'i1' });
    expect(getDialer).toHaveBeenCalled();
  });
});
