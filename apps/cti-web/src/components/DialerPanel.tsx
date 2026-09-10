/**
 * Power dialer control panel. With no run active it shows the list-view picker
 * (pick an object + one of the rep's Salesforce list views → dial it). During a
 * run it shows progress, the current record, and controls (pause/resume, skip,
 * stop, next), polling the session every ~2s.
 * A run is created READY and shows a confirm block (ConfirmBlock) until the rep
 * presses Start dialing; only then does the softphone join the conference and
 * the engine dial.
 *
 * Screen-pop: the panel calls `onScreenPop(recordId)` once per record the moment
 * it connects to a live human (see `shouldScreenPop`) — never for voicemail.
 * The caller (App) maps that to Open CTI `screenPopRecord`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dialerControl,
  getDialer,
  getSalesforceListViews,
  OBJECT_LABELS,
  type DialerControlAction,
  type DialerCurrentItem,
  type DialerObjectType,
  type DialerSession,
  type DialerSessionCounts,
  type DialerSessionView,
  type SalesforceListView,
} from '../dialer-api';
import { formatE164 } from '../format';
import { ApiError } from '../api';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(['done', 'stopped']);
/**
 * How long, after a run first goes terminal, we keep polling for its follow-up
 * rollovers to finish. The rollover worker ticks every ~5s and then makes two or
 * three Salesforce round-trips per job, so a rep who reaches the summary screen
 * is always ahead of it. Bounded so a wedged or backed-off queue (retries stretch
 * to ~63 min) can't leave the panel polling forever.
 */
export const ROLLOVER_SETTLE_MS = 60_000;

/**
 * Records that have reached a terminal disposition — dialed-and-dispositioned
 * (`done`), no-answer/busy/machine (`noConnect`), rep-skipped (`skipped`), or
 * no number to dial (`unreachable`). NOT `connected` (rep is on the call) or
 * `pending`/dialing (not finished). This is what "X of N done" should reflect —
 * counting only `done` left the bar at "0 of N" for any run nobody answered.
 */
export function processedCount(counts: DialerSessionCounts): number {
  return counts.done + counts.noConnect + counts.skipped + counts.unreachable;
}

/** Pure — "3 of 20 done · 1 connected · 2 skipped". */
export function progressLabel(counts: DialerSessionCounts): string {
  return `${processedCount(counts)} of ${counts.total} done · ${counts.connected} connected · ${counts.skipped} skipped`;
}

/**
 * Pure — the creation-stamped arithmetic the confirm block and the run line
 * share. Every input is fixed at queue build, so neither line drifts while the
 * rep watches: `firstPassTotal` counts attempt-1 rows only (an attempt-2 retry
 * row appended mid-run would inflate a live total), `unreachable` is fixed at
 * creation, and only the creation-stamped breakdown keys are read — an
 * out-of-hours skip the engine stamps at minute 40 adds a key this ignores.
 */
export function queueParts(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): {
  total: number; alreadyWorked: number; skipOnDialer: number; consent: number; unreachable: number; dialing: number;
} {
  const alreadyWorked = breakdown?.already_worked ?? 0;
  const skipOnDialer = breakdown?.skip_on_dialer ?? 0;
  // Consent skips are creation-stamped too (opted out / blocked list / DNC).
  const consent = (breakdown?.opted_out ?? 0) + (breakdown?.blocked ?? 0) + (breakdown?.dnc_blocked ?? 0);
  const dialing = firstPassTotal - alreadyWorked - skipOnDialer - consent - unreachable;
  return { total: firstPassTotal, alreadyWorked, skipOnDialer, consent, unreachable, dialing };
}

/** Pure — the run line, e.g. "50 records · 18 already worked today · dialing 32". Zero parts omitted. */
export function queueLine(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): string {
  const q = queueParts(firstPassTotal, unreachable, breakdown);
  const parts = [`${q.total} records`];
  if (q.alreadyWorked > 0) parts.push(`${q.alreadyWorked} already worked today`);
  if (q.skipOnDialer > 0) parts.push(`${q.skipOnDialer} skipped by flag`);
  if (q.consent > 0) parts.push(`${q.consent} blocked by consent`);
  parts.push(`dialing ${q.dialing}`);
  return parts.join(' · ');
}

/**
 * Pure — the confirm block's line, e.g.
 * "187 will be dialed · 9 already worked · 4 no number · 2 blocked".
 * Leads with the figure the rep is deciding on; zero parts omitted.
 */
export function confirmLine(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): string {
  const q = queueParts(firstPassTotal, unreachable, breakdown);
  const parts = [`${q.dialing} will be dialed`];
  if (q.alreadyWorked > 0) parts.push(`${q.alreadyWorked} already worked`);
  if (q.skipOnDialer > 0) parts.push(`${q.skipOnDialer} skipped by flag`);
  if (q.unreachable > 0) parts.push(`${q.unreachable} no number`);
  if (q.consent > 0) parts.push(`${q.consent} blocked`);
  return parts.join(' · ');
}

/** Miss reason → rep-facing words, in the order the miss line lists them.
 *  Keys are the server's `DialOutcome` values (plus the legacy `no_connect`
 *  rows written before reasons existed, and the tally's `other`). */
const MISS_LABELS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['voicemail', 'voicemail'],
  ['no_answer', 'no answer'],
  ['busy', 'busy'],
  ['failed', 'bad number'],
  ['fax', 'fax'],
  ['canceled', 'canceled'],
  ['hangup', 'hung up'],
  ['no_connect', 'no connect'],
  ['other', 'other'],
];

/** Pure — "12 voicemail · 4 no answer · 2 bad number"; '' with no misses.
 *  Known reasons in a fixed order; anything the server adds later trails
 *  under its own key so it is never silently dropped. */
export function missLine(breakdown?: Record<string, number>): string {
  if (!breakdown) return '';
  const known = new Set(MISS_LABELS.map(([k]) => k));
  const named = MISS_LABELS
    .filter(([k]) => (breakdown[k] ?? 0) > 0)
    .map(([k, label]) => `${breakdown[k]} ${label}`);
  const rest = Object.keys(breakdown)
    .filter((k) => !known.has(k) && (breakdown[k] ?? 0) > 0)
    .sort()
    .map((k) => `${breakdown[k]} ${k.replace(/_/g, ' ')}`);
  return [...named, ...rest].join(' · ');
}

const OUTCOME_LABELS: Record<string, string> = {
  voicemail: 'Voicemail', no_answer: 'No answer', busy: 'Busy', failed: 'Bad number',
  fax: 'Fax', canceled: 'Canceled', hangup: 'Hung up',
};
const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued', dialing: 'Dialing', connected: 'Connected', done: 'Done',
  skipped: 'Skipped', unreachable: 'No number', no_connect: 'No connect',
  failed: 'Bad number',
};

/** Pure — the current record's one-phrase state; a miss shows its reason. */
export function itemStatusLabel(item: Pick<DialerCurrentItem, 'status' | 'outcome'>): string {
  const outcomeLabel = item.status === 'no_connect' && item.outcome ? OUTCOME_LABELS[item.outcome] : undefined;
  if (outcomeLabel) return outcomeLabel;
  return STATUS_LABELS[item.status] ?? item.status.replace(/_/g, ' ');
}

/**
 * Pure — the Start-dialing sequence. The softphone joins the run's conference
 * FIRST (`join` is the parent's onStart) so the first prospect that connects
 * finds the rep already in the room; only then is the engine told to dial.
 * A `join` that resolves false means a stop or a newer run superseded this one
 * mid-await — nothing is sent. A `join` that throws propagates untouched.
 */
export async function startDialingSequence(
  join: () => Promise<boolean>,
  control: (action: DialerControlAction) => Promise<void>,
): Promise<'started' | 'superseded'> {
  const joined = await join();
  if (!joined) return 'superseded';
  await control('start');
  return 'started';
}

/** The server's `{ error }` sentence when there is one; otherwise the fallback. */
function controlErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.data && typeof e.data === 'object') {
    const msg = (e.data as { error?: unknown }).error;
    if (typeof msg === 'string') return msg;
  }
  return e instanceof Error ? e.message : fallback;
}

/** Pure — a refused `start` (409: another run is active) is the one failure
 *  that proves this session is still ready; anything else may have started it. */
export function isStartRefused(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}

/** Pure — which dialerControl action the toggle button sends next. */
export function pauseResumeAction(status: DialerSession['status']): DialerControlAction {
  return status === 'paused' ? 'resume' : 'pause';
}

/** Pure — Next is only meaningful once the current record has connected. */
export function isNextEnabled(item: DialerCurrentItem | null): boolean {
  return item?.status === 'connected';
}

/** Pure — pop the record ONLY for a live human. AMD hangs up machines before the
 *  rep is bridged, so `connected` ⇒ a person; voicemail never pops. */
export function shouldScreenPop(item: DialerCurrentItem | null): boolean {
  return item?.status === 'connected';
}

/** Pure — "m:ss" until the next retry; clamps at 0:00. */
export function retryCountdown(nextRetryAt: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(nextRetryAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Pure — the run-summary rollover line; '' when there is nothing to say.
 *
 * Failures are ALWAYS appended, never only reported when nothing else happened:
 * a {moved: 8, failed: 3} run used to read "8 follow-ups moved to tomorrow" and
 * quietly drop the three the rep needs an admin to chase. The noun is carried by
 * whichever clause comes first, so the line reads as one sentence.
 */
export function rolloverLine(r: { moved: number; pushed: number; failed: number }): string {
  const parts: string[] = [];
  if (r.moved) parts.push(`${r.moved} follow-up${r.moved === 1 ? '' : 's'} moved to tomorrow`);
  if (r.pushed) parts.push(`${r.pushed} pushed later (daily limit)`);
  if (r.failed) {
    parts.push(parts.length
      ? `${r.failed} could not be moved — see admin`
      : `${r.failed} follow-up${r.failed === 1 ? '' : 's'} could not be moved — see admin`);
  }
  return parts.join(' · ');
}

/**
 * Pure — should the poll keep running after the run has already ended?
 *
 * The run-summary rollover line was unreachable in practice: polling stopped the
 * instant the session went terminal, which is seconds before the follow-up worker
 * (5s tick + Salesforce round-trips) has processed any of the jobs — so
 * `rollovers` was always `{pending: N}` and `rolloverLine` rendered ''. Teardown
 * (`onComplete`) still fires exactly once at that first terminal poll; only the
 * polling continues, until the rollovers settle or `ROLLOVER_SETTLE_MS` elapses.
 */
export function shouldKeepPollingForRollovers(
  view: DialerSessionView,
  firstTerminalAt: number,
  now: number,
): boolean {
  if (!TERMINAL_STATUSES.has(view.session.status)) return false;
  if (!view.rollovers || view.rollovers.pending <= 0) return false;
  return now - firstTerminalAt < ROLLOVER_SETTLE_MS;
}

export function AttemptBadge({ attempt }: { attempt?: number }): JSX.Element | null {
  return attempt === 2 ? <span className="dp-attempt">Attempt 2 of 2</span> : null;
}

/**
 * Pure — should this poll tick tear the run down? A run tears down exactly once,
 * the moment it first reaches a terminal status (`done` when it finishes on its
 * own, `stopped` when ended remotely), so the rep's long-lived conference leg is
 * released from the single Twilio Device. Without this, a run that ENDS BY ITSELF
 * (nobody presses Stop) leaves that leg connected and the next manual call is
 * rejected — "a call is already in progress." `alreadyTornDown` is the caller's
 * latch (a ref) so repeated terminal polls don't re-fire the teardown.
 */
export function shouldTeardownRun(status: DialerSession['status'], alreadyTornDown: boolean): boolean {
  return !alreadyTornDown && TERMINAL_STATUSES.has(status);
}

/** Status dot color for the current record's dial outcome. */
function dotClassForItemStatus(status: string): string {
  if (status === 'connected') return 'ok';
  if (status === 'no_connect' || status === 'unreachable' || status === 'failed') return 'bad';
  if (status === 'skipped') return 'dim';
  return 'warn';
}

export interface DialerPanelProps {
  /** Active session id, owned by the parent — null means no run in progress. */
  sessionId: string | null;
  /**
   * Called once per record the moment it connects to a human (see
   * shouldScreenPop) — voicemail and no-connects never pop.
   */
  onScreenPop: (recordId: string) => void;
  /** Start a run from a Salesforce list view (parent creates the session). */
  onStartFromListView: (object: DialerObjectType, listViewId: string) => Promise<void>;
  /**
   * The rep pressed Start dialing on a ready run. The parent joins the
   * softphone to the run's Twilio conference and resolves true once the leg is
   * up (false if a stop or a newer run superseded it meanwhile). The panel
   * sends the `start` control only on true — see startDialingSequence.
   */
  onStart: () => Promise<boolean>;
  /** Called when the rep stops the run from the Stop control. */
  onStop: () => void;
  /**
   * Called once when the run reaches a terminal status without the rep pressing
   * Stop — it finished on its own (`done`) or was ended remotely (`stopped`).
   * The parent releases the rep's conference leg (freeing the single Twilio Device
   * for the next call) but keeps the session, so this panel's completion summary
   * stays on screen until the rep dismisses it via onDismiss.
   */
  onComplete: (result: { status: DialerSession['status']; counts: DialerSessionCounts }) => void;
  /**
   * Dismiss a finished/stopped run's summary and return to the list-view picker
   * (the summary's "Start another run" CTA). Clears the parent's session id.
   */
  onDismiss: () => void;
  /**
   * `start` was refused with 409 — the rep has another active run, and THIS
   * session is still `ready` (nothing dialed, nothing will). The parent drops
   * the conference leg it joined for Start and releases the nav lock, so the
   * rep can go stop the other run; the confirm block stays with the message.
   * Only on 409: any other failure leaves the leg up, because the server may
   * have flipped the session active (a failed first originate) and the run
   * screen will take over on the next poll.
   */
  onStartRefused: () => void;
}

function CurrentRecord({ item }: { item: DialerCurrentItem }): JSX.Element {
  return (
    <div className="section dp-current">
      <div className="kicker">Current record</div>
      <div className="dp-current-number tnum">{formatE164(item.toNumber) || item.toNumber || 'No number'}</div>
      <div className="dp-current-meta">
        <span className={`cdot ${dotClassForItemStatus(item.status)}`} />
        {item.objectType} · {itemStatusLabel(item)}
      </div>
      {item.fromNumber && <div className="dp-current-from">from {formatE164(item.fromNumber)}</div>}
      <AttemptBadge attempt={item.attempt} />
    </div>
  );
}

/**
 * The no-run state: pick an object + one of the rep's Salesforce list views and
 * start dialing it. The CTI pulls the list's records via the rep's SF token —
 * no Salesforce list-view button needed (the Lightning Console won't hand a
 * custom button the row selection).
 */
function ListViewPicker({
  onStart,
}: {
  onStart: (object: DialerObjectType, listViewId: string) => Promise<void>;
}): JSX.Element {
  const [object, setObject] = useState<DialerObjectType>('Lead');
  const [listViews, setListViews] = useState<SalesforceListView[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setListViews(null);
    setSelected('');
    getSalesforceListViews(object)
      .then((r) => { if (!cancelled) setListViews(r.listViews); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your list views.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [object]);

  const dial = async (): Promise<void> => {
    if (!selected) return;
    setStarting(true);
    try {
      await onStart(object, selected);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Power dial a list</div>
        <div className="row dp-picker-obj">
          {(['Lead', 'Opportunity', 'Task'] as const).map((o) => (
            <button
              key={o}
              className={`btn ${object === o ? 'active' : ''}`}
              disabled={starting}
              onClick={() => setObject(o)}
            >
              {OBJECT_LABELS[o]}
            </button>
          ))}
        </div>
        {loading && <div className="empty-hint"><span className="spinner" /> Loading your list views…</div>}
        {error && <div className="dp-error">{error}</div>}
        {listViews && listViews.length === 0 && (
          <div className="empty-hint">No {OBJECT_LABELS[object]} list views found.</div>
        )}
        {listViews && listViews.length > 0 && (
          <>
            <select
              className="dp-picker-select"
              value={selected}
              disabled={starting}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choose a list view…</option>
              {listViews.map((lv) => (
                <option key={lv.id} value={lv.id}>{lv.label}</option>
              ))}
            </select>
            <button className="btn primary full" disabled={!selected || starting} onClick={() => void dial()}>
              {starting ? 'Checking records…' : 'Dial this list'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The run was created READY: the queue is built, nothing has dialed. Show the
 * rep what the list came to and let them start it — or back out, which stops
 * the (never-started) session and returns to the picker.
 */
export function ConfirmBlock({
  view,
  busy,
  error,
  onStartDialing,
  onChooseAnother,
}: {
  view: DialerSessionView;
  busy: boolean;
  error: string | null;
  onStartDialing: () => void;
  onChooseAnother: () => void;
}): JSX.Element {
  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Ready to dial</div>
        <div className="dp-queue-line">
          {confirmLine(view.firstPassTotal ?? view.counts.total, view.counts.unreachable, view.skipBreakdown)}
        </div>
        {error && <div className="dp-error">{error}</div>}
        <button className="btn primary full" disabled={busy} onClick={onStartDialing}>
          {busy ? 'Starting…' : 'Start dialing'}
        </button>
        <button className="btn full" disabled={busy} onClick={onChooseAnother}>
          Choose a different list
        </button>
      </div>
    </div>
  );
}

export function DialerPanel(props: DialerPanelProps): JSX.Element {
  const { sessionId, onScreenPop, onStartFromListView, onStart, onStop, onComplete, onDismiss, onStartRefused } = props;
  const [view, setView] = useState<DialerSessionView | null>(null);
  // The poll owns `error` (a failed refresh); control actions own
  // `controlError` (a refused pause/skip/stop/next/start), so a successful
  // poll tick cannot erase what a control action just told the rep.
  const [error, setError] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  // Ticks every second so the retry countdown re-renders without waiting on
  // the ~2s poll.
  const [now, setNow] = useState(() => Date.now());

  // Id of the last currentItem we screen-popped for — pop once per NEW
  // connected item, not on every ~2s poll.
  const lastPoppedIdRef = useRef<string | null>(null);
  // Lets a control action (pause/skip/...) trigger an immediate re-poll
  // instead of waiting up to 2s for the next tick.
  const pollNowRef = useRef<() => void>(() => {});
  // Latch so the terminal-status teardown (onComplete) fires exactly once per run.
  const completedRef = useRef(false);
  // When this run FIRST reported a terminal status — the clock the rollover
  // settle window is measured from. Null until then.
  const firstTerminalAtRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    lastPoppedIdRef.current = null;
    pollNowRef.current = () => {};
    completedRef.current = false;
    firstTerminalAtRef.current = null;

    if (!sessionId) {
      setView(null);
      setError(null);
      setControlError(null);
      return;
    }

    setView(null);
    setError(null);
    setControlError(null);

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const stopPolling = (): void => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    };

    const poll = async (): Promise<void> => {
      try {
        const next = await getDialer(sessionId);
        if (cancelled) return;
        setView(next);
        setError(null);

        // Pop the record only for a live human (see shouldScreenPop) — not while
        // it is still ringing, and never for voicemail. Once per item.
        const current = next.currentItem;
        if (shouldScreenPop(current) && current && lastPoppedIdRef.current !== current.id) {
          lastPoppedIdRef.current = current.id;
          onScreenPop(current.recordId);
        }

        // The run reached a terminal status. If it got there WITHOUT the rep
        // pressing Stop (a run that finished on its own, or was ended remotely),
        // release the rep's conference leg via onComplete — the single Twilio
        // Device is otherwise left busy and the next call fails. The latch keeps
        // this to exactly one fire even if a poll is already in flight when the
        // status flips.
        //
        // Polling, unlike the teardown, does NOT stop here: the follow-up
        // rollovers are still being written and the summary's rollover line
        // depends on them (see shouldKeepPollingForRollovers).
        if (TERMINAL_STATUSES.has(next.session.status)) {
          if (firstTerminalAtRef.current === null) firstTerminalAtRef.current = Date.now();
          if (shouldTeardownRun(next.session.status, completedRef.current)) {
            completedRef.current = true;
            onComplete({ status: next.session.status, counts: next.counts });
          }
          if (!shouldKeepPollingForRollovers(next, firstTerminalAtRef.current, Date.now())) stopPolling();
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not refresh the dialer session.');
        }
      }
    };

    pollNowRef.current = () => { void poll(); };
    void poll();
    intervalId = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stopPolling();
      pollNowRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const runControl = useCallback((action: DialerControlAction): Promise<void> => {
    if (!sessionId) return Promise.resolve();
    setControlBusy(true);
    setControlError(null);
    return dialerControl(sessionId, action)
      .then(() => pollNowRef.current())
      .catch((e: unknown) => {
        setControlError(controlErrorMessage(e, `Could not ${action} the run.`));
      })
      .finally(() => setControlBusy(false));
  }, [sessionId]);

  // Await the stop control request BEFORE tearing down the parent's conference
  // leg (onStop) — calling onStop first would drop the rep's conference leg
  // even if the backend stop request hasn't gone out (or fails) yet. The Stop
  // button stays disabled (controlBusy) for the duration of the await.
  const handleStop = useCallback(() => {
    void (async () => {
      await runControl('stop');
      onStop();
    })();
  }, [runControl, onStop]);

  // Start dialing: join the softphone to the conference (onStart), THEN send
  // `start`. busy covers the whole sequence so the button cannot double-fire;
  // a superseded join sends nothing and shows nothing — the rep chose to leave.
  const handleStartDialing = useCallback(() => {
    if (!sessionId) return;
    void (async () => {
      setControlBusy(true);
      setControlError(null);
      try {
        // On success ('started' or 'superseded') there is nothing to show here —
        // the run screen takes over on the next poll, or the rep already left.
        await startDialingSequence(onStart, async (action) => {
          await dialerControl(sessionId, action);
          pollNowRef.current();
        });
      } catch (e: unknown) {
        setControlError(controlErrorMessage(e, 'Could not start the run.'));
        if (isStartRefused(e)) onStartRefused();
      } finally {
        setControlBusy(false);
      }
    })();
  }, [onStart, sessionId, onStartRefused]);

  if (!sessionId) {
    return <ListViewPicker onStart={onStartFromListView} />;
  }

  if (!view) {
    return (
      <div className="empty-state">
        <span className="spinner lg" />
        {error && <span className="empty-hint">{error}</span>}
      </div>
    );
  }

  // A successful poll tick cannot erase what a control action just told the
  // rep — see the `error`/`controlError` split above.
  const shownError = controlError ?? error;
  const miss = missLine(view.missBreakdown);

  if (view.session.status === 'ready') {
    return (
      <ConfirmBlock
        view={view}
        busy={controlBusy}
        error={shownError}
        onStartDialing={handleStartDialing}
        onChooseAnother={handleStop}
      />
    );
  }

  const isTerminal = TERMINAL_STATUSES.has(view.session.status);
  const isPaused = view.session.status === 'paused';
  const pct = view.counts.total > 0 ? Math.round((processedCount(view.counts) / view.counts.total) * 100) : 0;

  return (
    <div className="dialer-panel">
      <div className="section dp-progress">
        <div className="kicker">Power dialer</div>
        <div className="dp-queue-line">
          {queueLine(view.firstPassTotal ?? view.counts.total, view.counts.unreachable, view.skipBreakdown)}
        </div>
        {miss && <div className="dp-queue-line">{miss}</div>}
        <div className="dp-progress-label">{progressLabel(view.counts)}</div>
        <div className="meterbar tall">
          <div className="meterfill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {view.currentItem && <CurrentRecord item={view.currentItem} />}

      {shownError && <div className="dp-error">{shownError}</div>}

      {isTerminal ? (
        <div className="dp-summary">
          <div className="dp-summary-title">
            Run {view.session.status === 'done' ? 'complete' : 'stopped'}
          </div>
          <div className="dp-summary-meta">{progressLabel(view.counts)}</div>
          {miss && <div className="dp-summary-meta">{miss}</div>}
          {view.rollovers && view.rollovers.pending > 0 ? (
            // The worker hasn't finished writing the rollovers yet; the poll is
            // still running (bounded by ROLLOVER_SETTLE_MS) and will replace this
            // with the real line the moment they settle.
            <div className="dp-summary-meta">Finishing follow-ups…</div>
          ) : view.rollovers && rolloverLine(view.rollovers) ? (
            <div className="dp-summary-meta">{rolloverLine(view.rollovers)}</div>
          ) : null}
          <button className="btn primary full dp-summary-cta" onClick={onDismiss}>
            Start another run
          </button>
        </div>
      ) : (
        <>
          {view.waitingRetry && (
            <div className="dp-waiting">Next retry in {retryCountdown(view.waitingRetry.nextRetryAt, now)}</div>
          )}
          <div className="row dp-controls">
            <button
              className="btn"
              disabled={controlBusy}
              onClick={() => runControl(pauseResumeAction(view.session.status))}
            >
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn" disabled={controlBusy} onClick={() => runControl('skip')}>
              Skip
            </button>
            <button className="btn danger" disabled={controlBusy} onClick={handleStop}>
              Stop
            </button>
            <button
              className="btn primary"
              disabled={controlBusy || !isNextEnabled(view.currentItem)}
              onClick={() => runControl('next')}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
