/**
 * Power dialer control panel. With no run active it shows the list-view picker
 * (pick an object + one of the rep's Salesforce list views → dial it). During a
 * run it shows progress, the current record, and controls (pause/resume, skip,
 * stop, next), polling the session every ~2s.
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
 * Pure — what the rep inherited when the run STARTED, e.g.
 * "50 records · 18 already worked today · dialing 32".
 *
 * Every input is creation-stamped, so the line never drifts while the rep
 * watches it: `firstPassTotal` counts attempt-1 rows only (an attempt-2 retry
 * row appended mid-run would inflate a live total), `unreachable` is fixed at
 * queue build, and only the two creation-stamped breakdown keys are read —
 * an out-of-hours skip the engine stamps at minute 40 adds a key this
 * deliberately ignores. Zero-count parts are omitted.
 */
export function queueLine(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): string {
  const alreadyWorked = breakdown?.already_worked ?? 0;
  const skipOnDialer = breakdown?.skip_on_dialer ?? 0;
  const dialing = firstPassTotal - alreadyWorked - skipOnDialer - unreachable;
  const parts = [`${firstPassTotal} records`];
  if (alreadyWorked > 0) parts.push(`${alreadyWorked} already worked today`);
  if (skipOnDialer > 0) parts.push(`${skipOnDialer} skipped by flag`);
  parts.push(`dialing ${dialing}`);
  return parts.join(' · ');
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
  /** Called when the panel begins tracking a session (sessionId set). */
  onStart: () => void;
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
}

function CurrentRecord({ item }: { item: DialerCurrentItem }): JSX.Element {
  return (
    <div className="section dp-current">
      <div className="kicker">Current record</div>
      <div className="dp-current-number tnum">{formatE164(item.toNumber) || item.toNumber || 'No number'}</div>
      <div className="dp-current-meta">
        <span className={`cdot ${dotClassForItemStatus(item.status)}`} />
        {item.objectType} · {item.status.replace(/_/g, ' ')}
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
              {starting ? 'Starting…' : 'Dial this list'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function DialerPanel(props: DialerPanelProps): JSX.Element {
  const { sessionId, onScreenPop, onStartFromListView, onStart, onStop, onComplete, onDismiss } = props;
  const [view, setView] = useState<DialerSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      return;
    }

    onStart();
    setView(null);
    setError(null);

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
    return dialerControl(sessionId, action)
      .then(() => pollNowRef.current())
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : `Could not ${action} the run.`);
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
        <div className="dp-progress-label">{progressLabel(view.counts)}</div>
        <div className="meterbar tall">
          <div className="meterfill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {view.currentItem && <CurrentRecord item={view.currentItem} />}

      {error && <div className="dp-error">{error}</div>}

      {isTerminal ? (
        <div className="dp-summary">
          <div className="dp-summary-title">
            Run {view.session.status === 'done' ? 'complete' : 'stopped'}
          </div>
          <div className="dp-summary-meta">{progressLabel(view.counts)}</div>
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
