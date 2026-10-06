/** @vitest-environment jsdom */
/**
 * The run summary a terminal (done / stopped) run leaves on screen. The panel
 * is mounted — DialerPanel.test.tsx (node, SSR only) never reaches the summary,
 * because react-dom/server skips the effect that loads the run — with the same
 * fixture shape DialerPanel.callback.test.tsx uses for its "Run complete" case.
 *
 * Idle cutoff (spec 2026-10-06-dialer-idle-cutoff-design.md): the server stops
 * a run whose open line had nothing happen for 15 minutes and stamps
 * `stopReason: 'idle'`; the summary then says so, under "Run stopped".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DialerPanel } from './DialerPanel';
import * as dialerApi from '../dialer-api';
import type { DialerSession, DialerSessionView } from '../dialer-api';

const IDLE_LINE = 'Stopped after 15 minutes with no dialing.';

const terminalView = (status: DialerSession['status'], stopReason?: DialerSession['stopReason']): DialerSessionView => ({
  session: { id: 'sess1', status, ...(stopReason === undefined ? {} : { stopReason }) },
  counts: { total: 2, done: 1, connected: 1, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
  currentItem: null,
  rollovers: { moved: 0, pushed: 0, failed: 0, pending: 0 },
});

const noop = (): void => {};
const mount = () => render(
  <DialerPanel sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}} onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop} />,
);

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DialerPanel run summary — a run the server stopped for idling', () => {
  it('a stopped run with stopReason idle says why, under "Run stopped"', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(terminalView('stopped', 'idle'));
    const { container } = mount();
    await screen.findByText('Run stopped');
    const line = screen.getByText(IDLE_LINE);
    expect(line.className).toBe('dp-summary-meta');
    // Right after the title, ahead of the progress line.
    const lines = Array.from(container.querySelectorAll('.dp-summary > div')).map((el) => el.textContent);
    expect(lines.slice(0, 3)).toEqual(['Run stopped', IDLE_LINE, '1 of 2 done · 1 connected · 0 skipped']);
  });

  it('a stopped run with stopReason null (the rep pressed Stop) says nothing about idling', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(terminalView('stopped', null));
    mount();
    await screen.findByText('Run stopped');
    expect(screen.queryByText(IDLE_LINE)).toBeNull();
  });

  it('a stopped run with no stopReason at all (an older server) says nothing about idling', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(terminalView('stopped'));
    mount();
    await screen.findByText('Run stopped');
    expect(screen.queryByText(IDLE_LINE)).toBeNull();
  });

  it('a done run never shows it, even with stopReason idle (guard: the server cannot produce that)', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(terminalView('done', 'idle'));
    mount();
    await screen.findByText('Run complete');
    expect(screen.queryByText(IDLE_LINE)).toBeNull();
  });
});
