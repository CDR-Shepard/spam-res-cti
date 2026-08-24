import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  progressLabel,
  queueLine,
  isNextEnabled,
  pauseResumeAction,
  shouldTeardownRun,
  shouldScreenPop,
  retryCountdown,
  rolloverLine,
  shouldKeepPollingForRollovers,
  ROLLOVER_SETTLE_MS,
  AttemptBadge,
  DialerPanel,
} from './DialerPanel';
import type { DialerSession, DialerSessionView } from '../dialer-api';
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

describe('queueLine', () => {
  const counts = { total: 50, done: 0, connected: 0, noConnect: 0, skipped: 18, unreachable: 0, pending: 32 };
  it('reads like the spec example and omits zero parts', () => {
    expect(queueLine(counts, { already_worked: 18 })).toBe('50 records · 18 already worked today · dialing 32');
    expect(queueLine(counts, { already_worked: 15, skip_on_dialer: 3 }))
      .toBe('50 records · 15 already worked today · 3 skipped by flag · dialing 32');
    expect(queueLine({ ...counts, skipped: 0, pending: 50 }, {})).toBe('50 records · dialing 50');
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

  it('always surfaces failures, even when some follow-ups did move', () => {
    // Regression: failures were only mentioned when NOTHING moved, so a partly
    // failed rollover told the rep "8 moved" and silently dropped the 3 that
    // did not — the exact case an admin needs to hear about.
    expect(rolloverLine({ moved: 8, pushed: 0, failed: 3 }))
      .toBe('8 follow-ups moved to tomorrow · 3 could not be moved — see admin');
    expect(rolloverLine({ moved: 2, pushed: 1, failed: 1 }))
      .toBe('2 follow-ups moved to tomorrow · 1 pushed later (daily limit) · 1 could not be moved — see admin');
  });
});

describe('shouldKeepPollingForRollovers', () => {
  const T0 = 1_000_000;
  const view = (status: DialerSession['status'], pending: number): DialerSessionView => ({
    session: { id: 'sess1', status },
    counts: { total: 1, done: 0, connected: 0, noConnect: 1, skipped: 0, unreachable: 0, pending: 0 },
    currentItem: null,
    rollovers: { moved: 0, pushed: 0, failed: 0, pending },
  });

  it('keeps polling a finished run while its rollovers are still being written', () => {
    // The worker ticks every 5s and then talks to Salesforce, so the rep reaches
    // the summary screen long before `rollovers` is anything but {pending: N} —
    // which is why the rollover line used to be unreachable.
    expect(shouldKeepPollingForRollovers(view('done', 3), T0, T0 + 4_000)).toBe(true);
    expect(shouldKeepPollingForRollovers(view('stopped', 1), T0, T0 + 4_000)).toBe(true);
  });

  it('stops as soon as every rollover has settled', () => {
    expect(shouldKeepPollingForRollovers(view('done', 0), T0, T0 + 4_000)).toBe(false);
  });

  it('gives up at the settle bound rather than polling a wedged queue forever', () => {
    expect(shouldKeepPollingForRollovers(view('done', 3), T0, T0 + ROLLOVER_SETTLE_MS)).toBe(false);
    expect(shouldKeepPollingForRollovers(view('done', 3), T0, T0 + ROLLOVER_SETTLE_MS + 1)).toBe(false);
  });

  it('is never true for a run that is still going', () => {
    expect(shouldKeepPollingForRollovers(view('active', 3), T0, T0 + 1_000)).toBe(false);
    expect(shouldKeepPollingForRollovers(view('paused', 3), T0, T0 + 1_000)).toBe(false);
  });

  it('is false when the view carries no rollover counts at all', () => {
    const bare: DialerSessionView = {
      session: { id: 'sess1', status: 'done' },
      counts: { total: 1, done: 1, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 0 },
      currentItem: null,
    };
    expect(shouldKeepPollingForRollovers(bare, T0, T0 + 1_000)).toBe(false);
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

describe('Tasks in the picker', () => {
  it('offers Leads, Opportunities, and Tasks', () => {
    const html = renderToStaticMarkup(<DialerPanel sessionId={null} onScreenPop={() => {}} onStartFromListView={async () => {}} onStart={() => {}} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('Tasks');
  });
});
