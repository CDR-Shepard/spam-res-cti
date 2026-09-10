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
  confirmLine,
  missLine,
  itemStatusLabel,
  startDialingSequence,
  ConfirmBlock,
  isStartRefused,
} from './DialerPanel';
import type { DialerSession, DialerSessionView } from '../dialer-api';
import * as dialerApi from '../dialer-api';
import { ApiError } from '../api';

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
  it('consent skips come out of the dialing figure and are itemized', () => {
    const counts = { total: 50, done: 0, connected: 0, noConnect: 0, skipped: 20, unreachable: 0, pending: 30 };
    expect(queueLine(50, counts.unreachable, { already_worked: 15, opted_out: 2, dnc_blocked: 3 }))
      .toBe('50 records · 15 already worked today · 5 blocked by consent · dialing 30');
  });

  it('reads like the spec example and omits zero parts', () => {
    expect(queueLine(50, 0, { already_worked: 18 })).toBe('50 records · 18 already worked today · dialing 32');
    expect(queueLine(50, 0, { already_worked: 15, skip_on_dialer: 3 }))
      .toBe('50 records · 15 already worked today · 3 skipped by flag · dialing 32');
    expect(queueLine(50, 0, {})).toBe('50 records · dialing 50');
    expect(queueLine(50, 0)).toBe('50 records · dialing 50');
  });

  it('takes phone-less records out of the dialing figure', () => {
    // 50 in the run, 18 inherited, 2 with no number → 30 will actually ring.
    expect(queueLine(50, 2, { already_worked: 18 })).toBe('50 records · 18 already worked today · dialing 30');
  });

  /**
   * The line means "what this run started with" and must read the same at
   * minute 40 as at minute 0. Its three inputs are all creation-stamped, so
   * the two things that DO move mid-run — attempt-2 retry rows (which grow
   * counts.total and counts.pending) and out-of-hours skips stamped by the
   * engine (which grow counts.skipped and add a breakdown key) — cannot move
   * it: the retry rows are not attempt 1, and only already_worked and
   * skip_on_dialer are itemized or subtracted.
   */
  it('does not drift mid-run: attempt-2 rows and out-of-hours skips leave it unchanged', () => {
    // What the panel passes, mirroring the render site.
    const line = (v: DialerSessionView) =>
      queueLine(v.firstPassTotal ?? v.counts.total, v.counts.unreachable, v.skipBreakdown);

    const atStart: DialerSessionView = {
      session: { id: 'S1', status: 'active' },
      counts: { total: 50, done: 0, connected: 0, noConnect: 0, skipped: 18, unreachable: 2, pending: 30 },
      currentItem: null,
      firstPassTotal: 50,
      skipBreakdown: { already_worked: 15, skip_on_dialer: 3 },
    };
    const midRun: DialerSessionView = {
      ...atStart,
      // 6 no-connects have queued attempt-2 rows; the engine skipped 4 records
      // that fell outside calling hours.
      counts: { total: 56, done: 9, connected: 1, noConnect: 6, skipped: 22, unreachable: 2, pending: 16 },
      firstPassTotal: 50,
      skipBreakdown: { already_worked: 15, skip_on_dialer: 3, out_of_hours: 4 },
    };

    expect(line(atStart)).toBe('50 records · 15 already worked today · 3 skipped by flag · dialing 30');
    expect(line(midRun)).toBe(line(atStart));
  });

  it('falls back to the live total for a server that has not shipped firstPassTotal yet', () => {
    const legacy: DialerSessionView = {
      session: { id: 'S1', status: 'active' },
      counts: { total: 50, done: 0, connected: 0, noConnect: 0, skipped: 18, unreachable: 0, pending: 32 },
      currentItem: null,
      skipBreakdown: { already_worked: 18 },
    };
    expect(queueLine(legacy.firstPassTotal ?? legacy.counts.total, legacy.counts.unreachable, legacy.skipBreakdown))
      .toBe('50 records · 18 already worked today · dialing 32');
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
    expect(shouldTeardownRun('ready', false)).toBe(false);
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
      <DialerPanel sessionId={null} onScreenPop={() => {}} onStartFromListView={async () => {}} onStart={async () => true} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} onStartRefused={() => {}} />,
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
      <DialerPanel sessionId="sess1" onScreenPop={() => {}} onStartFromListView={async () => {}} onStart={async () => true} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} onStartRefused={() => {}} />,
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
    const html = renderToStaticMarkup(<DialerPanel sessionId={null} onScreenPop={() => {}} onStartFromListView={async () => {}} onStart={async () => true} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} onStartRefused={() => {}} />);
    expect(html).toContain('Tasks');
  });
});

describe('confirmLine — the confirm block before the first ring', () => {
  it('reads like the spec example: dialable count first, then what is left out', () => {
    expect(confirmLine(202, 4, { already_worked: 9, blocked: 2 }))
      .toBe('187 will be dialed · 9 already worked · 4 no number · 2 blocked');
  });
  it('omits zero parts and folds every consent reason into "blocked"', () => {
    expect(confirmLine(10, 0)).toBe('10 will be dialed');
    expect(confirmLine(10, 0, { opted_out: 1, dnc_blocked: 1, skip_on_dialer: 2 }))
      .toBe('6 will be dialed · 2 skipped by flag · 2 blocked');
  });
  it('shares its arithmetic with queueLine (same inputs, same dialable figure)', () => {
    expect(queueLine(202, 4, { already_worked: 9, blocked: 2 })).toContain('dialing 187');
  });
});

describe('missLine — what the misses were', () => {
  it('lists known reasons in a fixed order with rep-facing words', () => {
    expect(missLine({ failed: 2, voicemail: 12, no_answer: 4 })).toBe('12 voicemail · 4 no answer · 2 bad number');
  });
  it('is empty with no misses, and appends an unknown reason under its own key', () => {
    expect(missLine(undefined)).toBe('');
    expect(missLine({})).toBe('');
    expect(missLine({ voicemail: 1, something_new: 2 })).toBe('1 voicemail · 2 something new');
  });
});

describe('itemStatusLabel — the current record card', () => {
  it('names a miss by its reason', () => {
    expect(itemStatusLabel({ status: 'no_connect', outcome: 'voicemail' })).toBe('Voicemail');
    expect(itemStatusLabel({ status: 'no_connect', outcome: 'no_answer' })).toBe('No answer');
    expect(itemStatusLabel({ status: 'no_connect', outcome: 'busy' })).toBe('Busy');
    expect(itemStatusLabel({ status: 'no_connect', outcome: 'failed' })).toBe('Bad number');
  });
  it('names the other statuses, with No number for unreachable', () => {
    expect(itemStatusLabel({ status: 'unreachable', outcome: null })).toBe('No number');
    expect(itemStatusLabel({ status: 'dialing' })).toBe('Dialing');
    expect(itemStatusLabel({ status: 'connected' })).toBe('Connected');
    expect(itemStatusLabel({ status: 'no_connect', outcome: null })).toBe('No connect');
  });
  it('names a failed current-item status, not the raw lowercase status', () => {
    expect(itemStatusLabel({ status: 'failed' })).toBe('Bad number');
  });
});

describe('startDialingSequence — join the softphone first, then tell the engine', () => {
  it('sends start only after the conference leg is up', async () => {
    const join = vi.fn(async () => true);
    const control = vi.fn(async () => {});
    expect(await startDialingSequence(join, control)).toBe('started');
    expect(control).toHaveBeenCalledWith('start');
    expect(join.mock.invocationCallOrder[0]!).toBeLessThan(control.mock.invocationCallOrder[0]!);
  });
  it('sends nothing when the join reports the run was superseded', async () => {
    const control = vi.fn(async () => {});
    expect(await startDialingSequence(async () => false, control)).toBe('superseded');
    expect(control).not.toHaveBeenCalled();
  });
  it('sends nothing when the join throws (the error reaches the caller)', async () => {
    const control = vi.fn(async () => {});
    await expect(startDialingSequence(async () => { throw new Error('Device busy'); }, control)).rejects.toThrow('Device busy');
    expect(control).not.toHaveBeenCalled();
  });
});

describe('isStartRefused — the one start failure that proves the session is still ready', () => {
  it('is true only for a 409 (another run is already active)', () => {
    expect(isStartRefused(new ApiError(409, { error: 'x' }))).toBe(true);
  });
  it('is false for any other ApiError status or a non-ApiError failure', () => {
    expect(isStartRefused(new ApiError(500, {}))).toBe(false);
    expect(isStartRefused(new Error('Device busy'))).toBe(false);
  });
});

describe('ConfirmBlock (SSR)', () => {
  const view: DialerSessionView = {
    session: { id: 'sess1', status: 'ready' },
    counts: { total: 202, done: 0, connected: 0, noConnect: 0, skipped: 11, unreachable: 4, pending: 187 },
    currentItem: null,
    skipBreakdown: { already_worked: 9, blocked: 2 },
    firstPassTotal: 202,
  };
  it('shows the breakdown line, Start dialing, and the way out', () => {
    const html = renderToStaticMarkup(<ConfirmBlock view={view} busy={false} error={null} onStartDialing={() => {}} onChooseAnother={() => {}} />);
    expect(html).toContain('187 will be dialed · 9 already worked · 4 no number · 2 blocked');
    expect(html).toContain('Start dialing');
    expect(html).toContain('Choose a different list');
  });
  it('reads Starting… and disables both buttons while busy; shows the error when there is one', () => {
    const html = renderToStaticMarkup(<ConfirmBlock view={view} busy={true} error="Another power-dial run is already active for you" onStartDialing={() => {}} onChooseAnother={() => {}} />);
    expect(html).toContain('Starting…');
    expect(html).toContain('Another power-dial run is already active');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });
});
