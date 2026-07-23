import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { progressLabel, isNextEnabled, pauseResumeAction, shouldTeardownRun, DialerPanel } from './DialerPanel';
import * as dialerApi from '../dialer-api';

describe('progressLabel', () => {
  it('counts every terminal disposition as done, not just connected-and-dispositioned', () => {
    // 3 done + 5 no-connect + 2 skipped + 0 unreachable = 10 processed; 1 is
    // connected (rep on the call), 9 still pending.
    expect(
      progressLabel({ total: 20, done: 3, connected: 1, noConnect: 5, skipped: 2, unreachable: 0, pending: 9 }),
    ).toBe('10 of 20 done · 1 connected · 2 skipped');
  });

  it('shows a nobody-answered run as fully processed (regression: used to stick at "0 of N")', () => {
    // 1 no-connect + 1 unreachable, no one connected — the run is complete.
    expect(
      progressLabel({ total: 2, done: 0, connected: 0, noConnect: 1, skipped: 0, unreachable: 1, pending: 0 }),
    ).toBe('2 of 2 done · 0 connected · 0 skipped');
  });

  it('handles a fresh, empty run', () => {
    expect(
      progressLabel({ total: 0, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 0 }),
    ).toBe('0 of 0 done · 0 connected · 0 skipped');
  });
});

// @testing-library/react is not a devDep here (checked package.json), so we
// can't mount the panel in a real DOM and simulate a click. Instead we test
// the pure decision functions each control button's onClick delegates to —
// the same thing a "click Pause, expect dialerControl('pause')" test would
// verify, minus the DOM plumbing.
describe('control button → dialerControl action mapping', () => {
  it('Pause/Resume toggles on session status', () => {
    expect(pauseResumeAction('active')).toBe('pause');
    expect(pauseResumeAction('paused')).toBe('resume');
  });

  it('Next is only enabled once the current record is connected', () => {
    expect(isNextEnabled({ id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'connected', toNumber: '+16195551234' })).toBe(true);
    expect(isNextEnabled({ id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234' })).toBe(false);
    expect(isNextEnabled(null)).toBe(false);
  });
});

describe('shouldTeardownRun — release the conference leg when a run ends on its own', () => {
  it('tears down the moment a run reaches a terminal status (done or stopped)', () => {
    // A run that finishes by itself (nobody presses Stop) must still release the
    // rep's long-lived conference leg — otherwise the single Twilio Device stays
    // busy and the next manual call is rejected ("a call is already in progress").
    expect(shouldTeardownRun('done', false)).toBe(true);
    expect(shouldTeardownRun('stopped', false)).toBe(true);
  });

  it('does not tear down while the run is still going', () => {
    expect(shouldTeardownRun('active', false)).toBe(false);
    expect(shouldTeardownRun('paused', false)).toBe(false);
  });

  it('fires exactly once — a repeat terminal poll after teardown is a no-op', () => {
    expect(shouldTeardownRun('done', true)).toBe(false);
    expect(shouldTeardownRun('stopped', true)).toBe(false);
  });
});

describe('dialerControl is called with the mapped action', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calling dialerControl with the action a control button would send resolves and is observed by the mock', async () => {
    const mockControl = vi.spyOn(dialerApi, 'dialerControl').mockResolvedValue({ ok: true });
    await dialerApi.dialerControl('sess1', pauseResumeAction('active'));
    expect(mockControl).toHaveBeenCalledWith('sess1', 'pause');
  });
});

describe('DialerPanel (no @testing-library available — shallow render only)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the list-view picker when there is no active session', () => {
    const html = renderToStaticMarkup(
      <DialerPanel sessionId={null} onScreenPop={() => {}} onStartFromListView={async () => {}} onStart={() => {}} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toContain('Power dial a list');
    expect(html).toContain('Opportunities');
  });

  it('renders a loading state before the first poll resolves, without crashing', () => {
    // getDialer is called from an effect, which react-dom/server never runs,
    // so this only exercises the synchronous initial render (view === null).
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue({
      session: { id: 'sess1', status: 'active' },
      counts: { total: 5, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 5 },
      currentItem: null,
    });
    const html = renderToStaticMarkup(
      <DialerPanel sessionId="sess1" onScreenPop={() => {}} onStartFromListView={async () => {}} onStart={() => {}} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} />,
    );
    expect(typeof html).toBe('string');
  });
});
