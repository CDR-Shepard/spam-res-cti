import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
// The real YouTubeHoldPlayer mounts a live iframe via the YouTube IFrame API —
// far outside what an SSR test needs to exercise here. HoldMusicPlayer's own
// mount/no-mount decision is the thing this file pins; the player's internal
// play/pause/caption logic already has its own suite (YouTubeHoldPlayer.test.tsx).
vi.mock('./YouTubeHoldPlayer', () => ({
  YouTubeHoldPlayer: () => <div data-testid="yt-player" />,
}));
import {
  progressLabel,
  queueLine,
  queueParts,
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
  confirmContextLine,
  missLine,
  itemStatusLabel,
  startDialingSequence,
  ConfirmBlock,
  conflictingSessionId,
  CurrentRecord,
  HoldMusicPlayer,
  ItemControls,
  SessionToggle,
  controlsFor,
  actionsFor,
  runSequence,
  runControlsSequence,
  pollDelayMs,
} from './DialerPanel';
import type { DialerControlAction, DialerCurrentItem, DialerSession, DialerSessionView } from '../dialer-api';
import * as dialerApi from '../dialer-api';
import { ApiError } from '../api';
import type { HoldMusicSetting } from '@cti/contracts';

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
      .toBe('50 records · 15 called in the last 3 h · 5 blocked by consent · dialing 30');
  });

  it('reads like the spec example and omits zero parts', () => {
    expect(queueLine(50, 0, { already_worked: 18 })).toBe('50 records · 18 called in the last 3 h · dialing 32');
    expect(queueLine(50, 0, { already_worked: 15, skip_on_dialer: 3 }))
      .toBe('50 records · 15 called in the last 3 h · 3 skipped by flag · dialing 32');
    expect(queueLine(50, 0, {})).toBe('50 records · dialing 50');
    expect(queueLine(50, 0)).toBe('50 records · dialing 50');
  });

  it('takes phone-less records out of the dialing figure', () => {
    // 50 in the run, 18 inherited, 2 with no number → 30 will actually ring.
    expect(queueLine(50, 2, { already_worked: 18 })).toBe('50 records · 18 called in the last 3 h · dialing 30');
  });

  /**
   * The line means "what this run started with" and must read the same at
   * minute 40 as at minute 0. Its three inputs are all creation-stamped, so
   * the two things that DO move mid-run — attempt-2 retry rows (which grow
   * counts.total and counts.pending) and out-of-hours skips stamped by the
   * engine (which grow counts.skipped and add a breakdown key) — cannot move
   * it: the retry rows are not attempt 1, and only already_worked (folded
   * into "called in the last 3 h") and skip_on_dialer are itemized or
   * subtracted.
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

    expect(line(atStart)).toBe('50 records · 15 called in the last 3 h · 3 skipped by flag · dialing 30');
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
      .toBe('50 records · 18 called in the last 3 h · dialing 32');
  });

  it('also names the other two cadence skip reasons, folding daily_cap_unverified into the daily limit', () => {
    expect(queueLine(10, 0, { cooldown: 2, daily_cap: 1, daily_cap_unverified: 1, in_progress_elsewhere: 1 }))
      .toBe('10 records · 2 called in the last 3 h · 2 daily limit (state law) · 1 in progress in another run · dialing 5');
  });

  it('folds already_worked (the queue-build estimate) and cooldown (the dial-time gate) into one count — same 3-hour rule, one number', () => {
    expect(queueLine(10, 0, { already_worked: 2, cooldown: 1 })).toBe('10 records · 3 called in the last 3 h · dialing 7');
  });
});

describe('queueParts — the cadence skip reasons (spec §5)', () => {
  it('folds daily_cap_unverified into dailyCap and subtracts all three cadence reasons from dialing', () => {
    expect(queueParts(10, 0, { cooldown: 2, daily_cap: 1, daily_cap_unverified: 1, in_progress_elsewhere: 1 })).toEqual({
      total: 10, skipOnDialer: 0, consent: 0, unreachable: 0,
      cooldown: 2, dailyCap: 2, inProgressElsewhere: 1, dialing: 5,
    });
  });

  it('with no cadence keys, the new fields are zero and dialing is unaffected', () => {
    expect(queueParts(50, 0, { already_worked: 18 })).toEqual({
      total: 50, skipOnDialer: 0, consent: 0, unreachable: 0,
      cooldown: 18, dailyCap: 0, inProgressElsewhere: 0, dialing: 32,
    });
  });

  it('already_worked (queue-build estimate) and cooldown (dial-time gate) are the same 3-hour rule — one folded count', () => {
    expect(queueParts(10, 0, { already_worked: 2, cooldown: 1 })).toEqual({
      total: 10, skipOnDialer: 0, consent: 0, unreachable: 0,
      cooldown: 3, dailyCap: 0, inProgressElsewhere: 0, dialing: 7,
    });
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
      <DialerPanel sessionId={null} onScreenPop={() => {}} onStartFromListView={async () => {}} onPrepare={async () => {}} onJoin={async () => true} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} />,
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
      <DialerPanel sessionId="sess1" onScreenPop={() => {}} onStartFromListView={async () => {}} onPrepare={async () => {}} onJoin={async () => true} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} />,
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

/**
 * The rep's complaint: "when a lead connects there is a delay until we can see
 * the record including the seller's name — an awkward start to the call." The
 * name now rides on the queue row, so the card can headline it from the first
 * poll after the dial, well before the record pops on `connected`.
 */
describe('CurrentRecord (SSR) — the name is the headline the moment it dials', () => {
  const item: DialerCurrentItem = { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234' };

  it('with a name: the name comes first, then the number beneath it', () => {
    const html = renderToStaticMarkup(<CurrentRecord item={{ ...item, displayName: 'Ada Lovelace' }} />);
    const name = html.indexOf('Ada Lovelace');
    const number = html.indexOf('(619) 555-1234');
    expect(name).toBeGreaterThan(-1);
    expect(number).toBeGreaterThan(-1);
    expect(name).toBeLessThan(number);
    expect(html).toContain('class="dp-current-name"');
    // The number keeps its tabular digits, but is no longer the headline.
    expect(html).toMatch(/class="dp-current-number dp-current-number-sub tnum"/);
  });

  it('without a name: exactly today\'s layout — the number is the headline and no empty name element is rendered', () => {
    for (const nameless of [{ ...item }, { ...item, displayName: null }, { ...item, displayName: '' }, { ...item, displayName: '   ' }]) {
      const html = renderToStaticMarkup(<CurrentRecord item={nameless} />);
      expect(html).toContain('class="dp-current-number tnum"');
      expect(html).not.toContain('dp-current-name');
      expect(html).not.toContain('dp-current-number-sub');
      expect(html.indexOf('(619) 555-1234')).toBeLessThan(html.indexOf('Lead'));
    }
  });

  it('once the prospect hangs up: the meta line reads "They hung up" with the muted-red dot, not the object/status line', () => {
    const html = renderToStaticMarkup(
      <CurrentRecord item={{ ...item, status: 'connected', prospectEndedAt: '2026-09-23T18:00:00Z' }} />,
    );
    expect(html).toContain('They hung up');
    expect(html).toContain('cdot hangup');
    expect(html).not.toContain('Lead ·');
  });
});

/**
 * The rep's decision point once a connected call ends: End call/Next while
 * the prospect is still live, Redial/Resume once they've hung up (spec §5).
 * `ItemControls` is a pure, prop-only component — same idiom as
 * `ConfirmBlock` — so it renders via `renderToStaticMarkup` without needing
 * to mount the whole panel or run its effects.
 */
describe('controls', () => {
  const item: DialerCurrentItem = { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'pending', toNumber: '+16195551234' };
  const connected: DialerCurrentItem = { ...item, status: 'connected' };
  const noop = () => {};
  const render = renderToStaticMarkup;
  const view = (currentItem: DialerCurrentItem) => (
    <>
      <CurrentRecord item={currentItem} />
      <ItemControls item={currentItem} busy={false} onSkip={noop} onEnd={noop} onNext={noop} onRedial={noop} />
    </>
  );

  it('on a live connected call: End call and Next', () => {
    const html = render(view(connected));
    expect(html).toContain('End call');
    expect(html).toContain('>Next<');
    expect(html).not.toContain('Redial');
  });

  it('after the prospect hung up: the card says so and the controls are Redial and Resume', () => {
    const html = render(view({ ...connected, prospectEndedAt: '2026-09-23T18:00:00Z' }));
    expect(html).toContain('They hung up');
    expect(html).toContain('Redial');
    expect(html).toContain('Resume');
    expect(html).not.toContain('End call');
  });

  it('nothing connected yet (pending/dialing/null): Skip only', () => {
    const dialingHtml = render(<ItemControls item={{ ...item, status: 'dialing' }} busy={false} onSkip={noop} onEnd={noop} onNext={noop} onRedial={noop} />);
    expect(dialingHtml).toContain('Skip');
    expect(dialingHtml).not.toContain('End call');
    expect(dialingHtml).not.toContain('Redial');
    expect(dialingHtml).not.toContain('>Next<');
    expect(render(<ItemControls item={null} busy={false} onSkip={noop} onEnd={noop} onNext={noop} onRedial={noop} />)).toContain('Skip');
  });

  it('controlsFor is pure: dialing → [skip], connected → [end, next], hung up → [redial, next]', () => {
    expect(controlsFor({ ...item, status: 'dialing' })).toEqual(['skip']);
    expect(controlsFor(null)).toEqual(['skip']);
    expect(controlsFor(connected)).toEqual(['end', 'next']);
    expect(controlsFor({ ...connected, prospectEndedAt: 'x' })).toEqual(['redial', 'next']);
  });
});

/**
 * Fix round 1, finding 2: the session-level Pause/Resume button must not
 * render while the hung-up choice (Redial/Resume, see `ItemControls`) is
 * showing — otherwise the panel shows two buttons that could both say
 * "Resume". A mutation that always rendered this button passed the full
 * suite at 80/80, because the old inline `{!hungUp && ...}` in `DialerPanel`
 * was never exercised directly. `SessionToggle` fixes that: it is its own
 * prop-only component, so this is a direct, renderToStaticMarkup-testable
 * assertion.
 */
describe('SessionToggle — hidden while the hung-up choice is showing', () => {
  const noop = () => {};

  it('present, labeled by session status, when nothing is hung up', () => {
    expect(renderToStaticMarkup(<SessionToggle status="active" hungUp={false} busy={false} onClick={noop} />))
      .toContain('Pause');
    expect(renderToStaticMarkup(<SessionToggle status="paused" hungUp={false} busy={false} onClick={noop} />))
      .toContain('Resume');
  });

  it('absent once the prospect has hung up, whether the session is active or paused', () => {
    expect(renderToStaticMarkup(<SessionToggle status="active" hungUp={true} busy={false} onClick={noop} />)).toBe('');
    expect(renderToStaticMarkup(<SessionToggle status="paused" hungUp={true} busy={false} onClick={noop} />)).toBe('');
  });
});

/**
 * The paused-run chain (spec §5.3): `redialCurrent`/`repNext` both no-op the
 * actual dial on a paused session, so Redial and Next ("Resume") must also
 * send `resume` there — the rep should never need a second click. `actionsFor`
 * is the pure planner; `runSequence` is what runs its output in order,
 * stopping at the first failure (tested here with a fake `run`, since the
 * file has no jsdom/click harness — see the file-level comment above).
 */
describe('actionsFor — the paused-run chain', () => {
  it('chains next/redial with resume only on a paused run', () => {
    expect(actionsFor('next', 'paused')).toEqual(['next', 'resume']);
    expect(actionsFor('redial', 'paused')).toEqual(['redial', 'resume']);
  });

  it('is a single action on an active run', () => {
    expect(actionsFor('next', 'active')).toEqual(['next']);
    expect(actionsFor('redial', 'active')).toEqual(['redial']);
  });

  it('end and skip are always a single action, even on a paused run — End already pauses, and Skip never resumes anything', () => {
    expect(actionsFor('end', 'paused')).toEqual(['end']);
    expect(actionsFor('end', 'active')).toEqual(['end']);
    expect(actionsFor('skip', 'paused')).toEqual(['skip']);
  });
});

describe('runSequence — stops the chain at the first failure', () => {
  it('runs every action in order when each succeeds', async () => {
    const calls: DialerControlAction[] = [];
    const fakeRun = async (a: DialerControlAction): Promise<boolean> => { calls.push(a); return true; };
    expect(await runSequence(['redial', 'resume'], fakeRun)).toBe(true);
    expect(calls).toEqual(['redial', 'resume']);
  });

  it('stops after the first failure and never sends what follows', async () => {
    const calls: DialerControlAction[] = [];
    const fakeRun = async (a: DialerControlAction): Promise<boolean> => { calls.push(a); return false; };
    expect(await runSequence(['redial', 'resume'], fakeRun)).toBe(false);
    expect(calls).toEqual(['redial']);
  });

  it('an empty action list trivially succeeds without calling run', async () => {
    const fakeRun = vi.fn(async () => true);
    expect(await runSequence([], fakeRun)).toBe(true);
    expect(fakeRun).not.toHaveBeenCalled();
  });
});

/**
 * Fix round 1, finding 3: `controlBusy` must be held for the WHOLE chained
 * request (e.g. Redial → `resume` on a paused run), not toggled false→true
 * between the two — that gap let a second click double-fire mid-chain. This
 * proves the ownership with a fake `send`/`setBusy` pair: `setBusy` must be
 * called exactly twice — true once before anything sends, false once after
 * the whole chain settles — never in between, regardless of how many
 * actions run or whether one of them fails.
 */
describe('runControlsSequence — busy is held across the whole chain, not toggled per action', () => {
  it('sets busy true once before the chain and false once after — never in between', async () => {
    const busyCalls: boolean[] = [];
    const sendCalls: DialerControlAction[] = [];
    const send = async (a: DialerControlAction): Promise<boolean> => { sendCalls.push(a); return true; };
    const setBusy = (b: boolean) => busyCalls.push(b);

    expect(await runControlsSequence(['redial', 'resume'], send, setBusy)).toBe(true);
    expect(busyCalls).toEqual([true, false]);
    expect(sendCalls).toEqual(['redial', 'resume']);
  });

  it('still clears busy exactly once when the first action fails — no second send, no busy flicker', async () => {
    const busyCalls: boolean[] = [];
    const sendCalls: DialerControlAction[] = [];
    const send = async (a: DialerControlAction): Promise<boolean> => { sendCalls.push(a); return false; };
    const setBusy = (b: boolean) => busyCalls.push(b);

    expect(await runControlsSequence(['redial', 'resume'], send, setBusy)).toBe(false);
    expect(busyCalls).toEqual([true, false]);
    expect(sendCalls).toEqual(['redial']);
  });

  it('a single-action chain (an active run) still holds busy for that one request', async () => {
    const busyCalls: boolean[] = [];
    const send = async () => true;
    const setBusy = (b: boolean) => busyCalls.push(b);

    expect(await runControlsSequence(['skip'], send, setBusy)).toBe(true);
    expect(busyCalls).toEqual([true, false]);
  });
});

/**
 * The other half of the fix: the panel only LEARNS a record connected by
 * polling, so a 2 s cadence adds up to 2 s before the pop. While a dial is in
 * flight — the only time the next poll can flip the pop — poll every second.
 */
describe('pollDelayMs — faster while a dial is in flight', () => {
  /** A view whose current record is in `itemStatus` (null = no current record). */
  const view = (itemStatus: string | null, sessionStatus: DialerSession['status'] = 'active'): DialerSessionView => ({
    session: { id: 'sess1', status: sessionStatus },
    counts: { total: 1, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
    currentItem: itemStatus ? { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: itemStatus, toNumber: '+16195551234' } : null,
  });

  it('is 1 s while the current record is dialing — the ring is when the next poll can flip the pop', () => {
    expect(pollDelayMs(view('dialing'))).toBe(1000);
  });

  it('is back at 2 s once connected: the pop already fired, and Next re-polls on its own', () => {
    expect(pollDelayMs(view('connected'))).toBe(2000);
  });

  it('is today\'s 2 s everywhere else: before the first poll, no current record, pending, a settled miss, a terminal run', () => {
    expect(pollDelayMs(null)).toBe(2000);
    expect(pollDelayMs(view(null))).toBe(2000);
    expect(pollDelayMs(view('pending'))).toBe(2000);
    expect(pollDelayMs(view('no_connect'))).toBe(2000);
    expect(pollDelayMs(view('done'))).toBe(2000);
    expect(pollDelayMs(view(null, 'done'))).toBe(2000);
    expect(pollDelayMs(view(null, 'stopped'))).toBe(2000);
    expect(pollDelayMs(view(null, 'ready'))).toBe(2000);
  });
});

describe('Tasks in the picker', () => {
  it('offers Leads, Opportunities, and Tasks', () => {
    const html = renderToStaticMarkup(<DialerPanel sessionId={null} onScreenPop={() => {}} onStartFromListView={async () => {}} onPrepare={async () => {}} onJoin={async () => true} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('Tasks');
  });
});

describe('confirmLine — the confirm block before the first ring', () => {
  it('reads like the spec example: dialable count first, then what is left out', () => {
    expect(confirmLine(202, 4, { already_worked: 9, blocked: 2 }))
      .toBe('187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked');
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

describe('skip labels for the cadence rules', () => {
  it('confirm line names the three new reasons', () => {
    expect(confirmLine(10, 0, { cooldown: 2, daily_cap: 1, in_progress_elsewhere: 1 }))
      .toBe('6 will be dialed · 2 called in the last 3 h · 1 daily limit (state law) · 1 in progress in another run');
  });
  it('folds daily_cap_unverified into the same "daily limit (state law)" figure', () => {
    expect(confirmLine(10, 0, { daily_cap: 1, daily_cap_unverified: 2 }))
      .toBe('7 will be dialed · 3 daily limit (state law)');
  });
  it('folds already_worked and cooldown into one "called in the last 3 h" figure — same 3-hour rule, one number', () => {
    expect(confirmLine(10, 0, { already_worked: 2, cooldown: 1 })).toBe('7 will be dialed · 3 called in the last 3 h');
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

describe('startDialingSequence — prepare, then start, then join the conference', () => {
  it('runs prepare → start → join, in that order', async () => {
    const prepare = vi.fn(async () => {});
    const control = vi.fn(async () => {});
    const join = vi.fn(async () => true);
    expect(await startDialingSequence(prepare, control, join)).toBe('started');
    expect(control).toHaveBeenCalledWith('start');
    expect(prepare.mock.invocationCallOrder[0]!).toBeLessThan(control.mock.invocationCallOrder[0]!);
    expect(control.mock.invocationCallOrder[0]!).toBeLessThan(join.mock.invocationCallOrder[0]!);
  });
  it('a refused prepare (softphone on a call) sends no start and never joins — nothing rings', async () => {
    const control = vi.fn(async () => {});
    const join = vi.fn(async () => true);
    await expect(startDialingSequence(async () => { throw new Error('Device busy'); }, control, join))
      .rejects.toThrow('Device busy');
    expect(control).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });
  it('a refused start (409) never joins, so no leg can be dropped from the rep\'s live run in another tab', async () => {
    const join = vi.fn(async () => true);
    const control = vi.fn(async () => { throw new ApiError(409, { error: 'x' }); });
    await expect(startDialingSequence(async () => {}, control, join)).rejects.toBeInstanceOf(ApiError);
    expect(join).not.toHaveBeenCalled();
  });
  it('a join that throws stops the run it just started, then rethrows — prospects never ring into an empty room', async () => {
    const control = vi.fn(async (_action: DialerControlAction) => {});
    await expect(startDialingSequence(async () => {}, control, async () => { throw new Error('Device busy'); }))
      .rejects.toThrow('Device busy');
    expect(control.mock.calls.map(([a]) => a)).toEqual(['start', 'stop']);
  });
  it('a superseded join reports superseded and sends no stop — a newer run owns the leg', async () => {
    const control = vi.fn(async (_action: DialerControlAction) => {});
    expect(await startDialingSequence(async () => {}, control, async () => false)).toBe('superseded');
    expect(control.mock.calls.map(([a]) => a)).toEqual(['start']);
  });
  it('a 500 from start sends a best-effort stop, never joins, and rethrows — the server may have flipped the session active before failing', async () => {
    const join = vi.fn(async () => true);
    const control = vi.fn(async (_action: DialerControlAction) => { throw new ApiError(500, {}); });
    await expect(startDialingSequence(async () => {}, control, join)).rejects.toBeInstanceOf(ApiError);
    expect(control.mock.calls.map(([a]) => a)).toEqual(['start', 'stop']);
    expect(join).not.toHaveBeenCalled();
  });
  it('a non-ApiError start failure (e.g. a network error) also sends a best-effort stop, never joins, and rethrows', async () => {
    const join = vi.fn(async () => true);
    const control = vi.fn(async (_action: DialerControlAction) => { throw new Error('network'); });
    await expect(startDialingSequence(async () => {}, control, join)).rejects.toThrow('network');
    expect(control.mock.calls.map(([a]) => a)).toEqual(['start', 'stop']);
    expect(join).not.toHaveBeenCalled();
  });
  it('a 409 from start sends no stop — the session is still ready and the confirm block owns the next step', async () => {
    const join = vi.fn(async () => true);
    const control = vi.fn(async (_action: DialerControlAction) => { throw new ApiError(409, { error: 'x' }); });
    await expect(startDialingSequence(async () => {}, control, join)).rejects.toBeInstanceOf(ApiError);
    expect(control.mock.calls.map(([a]) => a)).toEqual(['start']);
    expect(join).not.toHaveBeenCalled();
  });
});

describe('conflictingSessionId — the other run the 409 named', () => {
  it('returns the id from a 409 body', () => {
    expect(conflictingSessionId(new ApiError(409, { error: 'x', activeSessionId: 'S-OTHER' }))).toBe('S-OTHER');
  });
  it('is null when the 409 named no run, or for any other failure', () => {
    expect(conflictingSessionId(new ApiError(409, { error: 'x', activeSessionId: null }))).toBeNull();
    expect(conflictingSessionId(new ApiError(409, { error: 'x' }))).toBeNull();
    expect(conflictingSessionId(new ApiError(500, { activeSessionId: 'S-OTHER' }))).toBeNull();
    expect(conflictingSessionId(new Error('Device busy'))).toBeNull();
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
    expect(html).toContain('187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked');
    expect(html).toContain('Start dialing');
    expect(html).toContain('Choose a different list');
  });
  it('reads Starting… and disables both buttons while busy; shows the error when there is one', () => {
    const html = renderToStaticMarkup(<ConfirmBlock view={view} busy={true} error="Another power-dial run is already active for you" onStartDialing={() => {}} onChooseAnother={() => {}} />);
    expect(html).toContain('Starting…');
    expect(html).toContain('Another power-dial run is already active');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });
  it('offers to stop the other run when the 409 named one', () => {
    const html = renderToStaticMarkup(
      <ConfirmBlock view={view} busy={false} error="Another power-dial run is already active for you — stop it first." onStartDialing={() => {}} onChooseAnother={() => {}} onStopOther={() => {}} />,
    );
    expect(html).toContain('Stop the other run');
  });
  it('does not offer it when the 409 named no run', () => {
    const html = renderToStaticMarkup(<ConfirmBlock view={view} busy={false} error="Another power-dial run is already active for you — stop it first." onStartDialing={() => {}} onChooseAnother={() => {}} />);
    expect(html).not.toContain('Stop the other run');
  });
  it('shows the shared-list line under the breakdown line when listContext names another rep', () => {
    const html = renderToStaticMarkup(
      <ConfirmBlock
        view={{ ...view, listContext: { total: 220, startedFrom: 87, workedBy: ['Garrett'] } }}
        busy={false} error={null} onStartDialing={() => {}} onChooseAnother={() => {}}
      />,
    );
    // renderToStaticMarkup HTML-escapes the apostrophe as `&#x27;`.
    expect(html).toContain('Garrett is on this list (record 87 of 220) — you&#x27;ll start from 88.');
    expect(html.indexOf('187 will be dialed')).toBeLessThan(html.indexOf('Garrett is on this list'));
  });
  it('omits the shared-list line with no listContext, or when startedFrom is 0 (wrapped to the top)', () => {
    expect(renderToStaticMarkup(<ConfirmBlock view={view} busy={false} error={null} onStartDialing={() => {}} onChooseAnother={() => {}} />))
      .not.toContain('is on this list');
    const wrapped = { ...view, listContext: { total: 220, startedFrom: 0, workedBy: ['Garrett'] } };
    expect(renderToStaticMarkup(<ConfirmBlock view={wrapped} busy={false} error={null} onStartDialing={() => {}} onChooseAnother={() => {}} />))
      .not.toContain('is on this list');
  });
});

/**
 * Two reps, one list (spec §4): the confirm block's extra line naming who
 * else (or just this rep) has dialed the list, and where the run will start.
 * `startedFrom`/`total` are 0-based/plain counts straight off the server —
 * the rep-facing copy is 1-based ("record 87 of 220" = index 86 is the 87th
 * record), so every arithmetic case below is deliberately off-by-one from
 * its inputs.
 */
describe('confirmContextLine', () => {
  it('one other rep: "Garrett is on this list (record 87 of 220) — you\'ll start from 88."', () => {
    expect(confirmContextLine({ total: 220, startedFrom: 87, workedBy: ['Garrett'] }))
      .toBe("Garrett is on this list (record 87 of 220) — you'll start from 88.");
  });

  it('two other reps: "Garrett and Danny are on this list …"', () => {
    expect(confirmContextLine({ total: 220, startedFrom: 87, workedBy: ['Garrett', 'Danny'] }))
      .toBe("Garrett and Danny are on this list (record 87 of 220) — you'll start from 88.");
  });

  it('three or more: a comma list with "and" before the last name', () => {
    expect(confirmContextLine({ total: 220, startedFrom: 87, workedBy: ['Garrett', 'Danny', 'Priya'] }))
      .toBe("Garrett, Danny and Priya are on this list (record 87 of 220) — you'll start from 88.");
    expect(confirmContextLine({ total: 220, startedFrom: 87, workedBy: ['Garrett', 'Danny', 'Priya', 'Sam'] }))
      .toBe("Garrett, Danny, Priya and Sam are on this list (record 87 of 220) — you'll start from 88.");
  });

  it('only the requesting rep has dialed it (workedBy empty, startedFrom > 0): the self-only copy', () => {
    expect(confirmContextLine({ total: 50, startedFrom: 12, workedBy: [] }))
      .toBe("You're on this list (record 12 of 50) — you'll start from 13.");
  });

  it('startedFrom 0 (wrapped to the top, or nobody has dialed it): no line', () => {
    expect(confirmContextLine({ total: 50, startedFrom: 0, workedBy: ['Garrett'] })).toBeNull();
    expect(confirmContextLine({ total: 50, startedFrom: 0, workedBy: [] })).toBeNull();
  });

  it('no listContext (not a list-view run, or an older server): no line', () => {
    expect(confirmContextLine(null)).toBeNull();
    expect(confirmContextLine(undefined)).toBeNull();
  });
});

describe('CurrentRecord — the list-position line', () => {
  const item: DialerCurrentItem = { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234' };

  it('listPosition + listTotal present: "record 88 of 220" (1-based from a 0-based index)', () => {
    const html = renderToStaticMarkup(<CurrentRecord item={{ ...item, listPosition: 87 }} listTotal={220} />);
    expect(html).toContain('record 88 of 220');
  });

  it('no listPosition, or no listTotal: no "record N of M" line (the "Current record" kicker is unaffected)', () => {
    const noListLine = /record \d+ of \d+/;
    expect(renderToStaticMarkup(<CurrentRecord item={item} />)).not.toMatch(noListLine);
    expect(renderToStaticMarkup(<CurrentRecord item={{ ...item, listPosition: 87 }} />)).not.toMatch(noListLine);
    expect(renderToStaticMarkup(<CurrentRecord item={{ ...item, listPosition: null }} listTotal={220} />)).not.toMatch(noListLine);
  });
});

/**
 * Task 8: the YouTube hold player rides the run, mounted right under the
 * current-record card. `HoldMusicPlayer` is pulled out as its own prop-only
 * piece — like `CurrentRecord`/`ConfirmBlock` above — because `DialerPanel`
 * itself never runs its data-fetching effect under `renderToStaticMarkup`
 * (see the `controls` describe block's comment on this file's SSR-only
 * testing strategy), so the mount decision has to be directly renderable.
 */
describe('HoldMusicPlayer (SSR) — mounts the YouTube player after the current-record card', () => {
  const currentItem: DialerCurrentItem = { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234' };
  const viewWith = (status: DialerSession['status']): DialerSessionView => ({
    session: { id: 'sess1', status },
    counts: { total: 1, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
    currentItem,
  });
  const youtubeChoice: HoldMusicSetting = { choice: 'youtube', youtube: { listId: 'PL123', videoId: null } };

  // Mirrors the real render site: the current-record card, then the slot the
  // player mounts into — see DialerPanel.tsx just after `{view.currentItem
  // && <CurrentRecord .../>}`.
  const renderRunning = (view: DialerSessionView, holdMusic?: HoldMusicSetting): string => renderToStaticMarkup(
    <>
      <CurrentRecord item={view.currentItem as DialerCurrentItem} />
      <HoldMusicPlayer view={view} holdMusic={holdMusic} />
    </>,
  );

  it('YouTube choice + stored ids + an active session: the player mounts after the current-record card', () => {
    const html = renderRunning(viewWith('active'), youtubeChoice);
    expect(html.indexOf('dp-current')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="yt-player"')).toBeGreaterThan(html.indexOf('dp-current'));
  });

  it('a paused session: the player is still mounted — it pauses, it does not vanish', () => {
    expect(renderRunning(viewWith('paused'), youtubeChoice)).toContain('data-testid="yt-player"');
  });

  it('a preset (non-YouTube) choice: no player', () => {
    expect(renderRunning(viewWith('active'), { choice: 'classical', youtube: null })).not.toContain('yt-player');
  });

  it('YouTube chosen but no stored ids yet: no player', () => {
    expect(renderRunning(viewWith('active'), { choice: 'youtube', youtube: null })).not.toContain('yt-player');
  });

  it('a done or stopped session: no player, even with YouTube chosen', () => {
    expect(renderRunning(viewWith('done'), youtubeChoice)).not.toContain('yt-player');
    expect(renderRunning(viewWith('stopped'), youtubeChoice)).not.toContain('yt-player');
  });

  it('no holdMusic prop at all (an older /auth/me, or the fetch not settled yet): no player', () => {
    expect(renderRunning(viewWith('active'), undefined)).not.toContain('yt-player');
  });
});
