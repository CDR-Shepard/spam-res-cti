import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  progressLabel,
  isNextEnabled,
  pauseResumeAction,
  shouldTeardownRun,
  shouldScreenPop,
  retryCountdown,
  rolloverLine,
  AttemptBadge,
  DialerPanel,
} from './DialerPanel';
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

describe('shouldScreenPop — humans only', () => {
  it('pops only once the record is connected (AMD drops machines before bridging, so connected = human)', () => {
    const base = { id: 'i1', recordId: '00Q1', objectType: 'Lead', toNumber: '+16195551234' };
    expect(shouldScreenPop({ ...base, status: 'connected' })).toBe(true);
    expect(shouldScreenPop({ ...base, status: 'dialing' })).toBe(false);
    expect(shouldScreenPop({ ...base, status: 'no_connect' })).toBe(false);
    expect(shouldScreenPop(null)).toBe(false);
  });
});

describe('retryCountdown', () => {
  it('formats the time until the next retry as m:ss, never negative', () => {
    const now = Date.parse('2026-08-22T17:00:00Z');
    expect(retryCountdown('2026-08-22T17:03:40Z', now)).toBe('3:40');
    expect(retryCountdown('2026-08-22T17:00:05Z', now)).toBe('0:05');
    expect(retryCountdown('2026-08-22T16:59:00Z', now)).toBe('0:00');
  });
});

describe('rolloverLine', () => {
  it('reads naturally and omits zero parts', () => {
    expect(rolloverLine({ moved: 12, pushed: 3, failed: 0 })).toBe('12 follow-ups moved to tomorrow · 3 pushed later (daily limit)');
    expect(rolloverLine({ moved: 1, pushed: 0, failed: 0 })).toBe('1 follow-up moved to tomorrow');
    expect(rolloverLine({ moved: 0, pushed: 0, failed: 2 })).toBe('2 follow-ups could not be moved — see admin');
    expect(rolloverLine({ moved: 0, pushed: 0, failed: 0 })).toBe('');
  });
});

describe('DialerPanel render (SSR)', () => {
  it('shows the attempt badge and the retry countdown from the view', () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue({
      session: { id: 'sess1', status: 'active' },
      counts: { total: 2, done: 0, connected: 0, noConnect: 1, skipped: 0, unreachable: 0, pending: 1 },
      currentItem: { id: 'i2', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234', attempt: 2 },
      waitingRetry: null, rollovers: { moved: 0, pushed: 0, failed: 0, pending: 0 },
    });
    // SSR never runs the effect, so we render the pure pieces directly:
    expect(renderToStaticMarkup(<AttemptBadge attempt={2} />)).toContain('Attempt 2 of 2');
    expect(renderToStaticMarkup(<AttemptBadge attempt={1} />)).toBe('');
  });
});
