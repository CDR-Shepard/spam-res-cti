/**
 * Power dialer control panel. With no run active it shows the list-view picker
 * (pick an object + one of the rep's Salesforce list views → dial it). During a
 * run it shows progress, the current record, and controls (pause/resume, skip,
 * stop, next), polling the session every ~2s.
 *
 * Screen-pop: the panel calls `onScreenPop(recordId)` once per record the moment
 * it becomes the in-flight record, so the rep sees the lead/opp while it rings.
 * The caller (App) maps that to Open CTI `screenPopRecord`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dialerControl,
  getDialer,
  getSalesforceListViews,
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

/** Pure — which dialerControl action the toggle button sends next. */
export function pauseResumeAction(status: DialerSession['status']): DialerControlAction {
  return status === 'paused' ? 'resume' : 'pause';
}

/** Pure — Next is only meaningful once the current record has connected. */
export function isNextEnabled(item: DialerCurrentItem | null): boolean {
  return item?.status === 'connected';
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
   * Called once per record the moment it becomes the in-flight record (i.e. as
   * the dialer starts calling it), so the rep sees the lead/opp while it rings.
   */
  onScreenPop: (recordId: string) => void;
  /** Start a run from a Salesforce list view (parent creates the session). */
  onStartFromListView: (object: DialerObjectType, listViewId: string) => Promise<void>;
  /** Called when the panel begins tracking a session (sessionId set). */
  onStart: () => void;
  /** Called when the rep stops the run from the Stop control. */
  onStop: () => void;
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
          {(['Lead', 'Opportunity'] as const).map((o) => (
            <button
              key={o}
              className={`btn ${object === o ? 'active' : ''}`}
              disabled={starting}
              onClick={() => setObject(o)}
            >
              {o === 'Lead' ? 'Leads' : 'Opportunities'}
            </button>
          ))}
        </div>
        {loading && <div className="empty-hint"><span className="spinner" /> Loading your list views…</div>}
        {error && <div className="dp-error">{error}</div>}
        {listViews && listViews.length === 0 && (
          <div className="empty-hint">No {object === 'Lead' ? 'Lead' : 'Opportunity'} list views found.</div>
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
  const { sessionId, onScreenPop, onStartFromListView, onStart, onStop } = props;
  const [view, setView] = useState<DialerSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);

  // Id of the last currentItem we screen-popped for — pop once per NEW
  // connected item, not on every ~2s poll.
  const lastPoppedIdRef = useRef<string | null>(null);
  // Lets a control action (pause/skip/...) trigger an immediate re-poll
  // instead of waiting up to 2s for the next tick.
  const pollNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    lastPoppedIdRef.current = null;
    pollNowRef.current = () => {};

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

        // Screen-pop each record as it becomes the in-flight record (dialing OR
        // connected) — so the rep sees the lead/opp while it's ringing, not only
        // once someone answers. Fires once per record via the last-popped ref.
        const current = next.currentItem;
        if (current && lastPoppedIdRef.current !== current.id) {
          lastPoppedIdRef.current = current.id;
          onScreenPop(current.recordId);
        }

        if (TERMINAL_STATUSES.has(next.session.status)) {
          stopPolling();
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
          <button className="btn primary full dp-summary-cta" onClick={onStart}>
            Start another run
          </button>
        </div>
      ) : (
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
      )}
    </div>
  );
}
