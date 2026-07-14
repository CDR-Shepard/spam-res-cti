/**
 * Power dialer control panel — progress, current record, and playback
 * controls (pause/resume, skip, stop, next) for a server-originated dialer
 * session. Polls the session every ~2s while a run is active.
 *
 * Screen-pop is intentionally NOT wired to Open CTI here: the panel only
 * calls `onScreenPop(recordId)` when a NEW connected record appears. The
 * caller (App) decides what that means (e.g. `screenPopRecord`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dialerControl,
  getDialer,
  type DialerControlAction,
  type DialerCurrentItem,
  type DialerSession,
  type DialerSessionCounts,
  type DialerSessionView,
} from '../dialer-api';
import { formatE164 } from '../format';
import { PhoneIcon } from '../icons';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(['done', 'stopped']);

/** Pure — "3 of 20 done · 1 connected · 2 skipped". */
export function progressLabel(counts: DialerSessionCounts): string {
  return `${counts.done} of ${counts.total} done · ${counts.connected} connected · ${counts.skipped} skipped`;
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
  /** Called when a NEW currentItem with status 'connected' appears (fires once per item). */
  onScreenPop: (recordId: string) => void;
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

export function DialerPanel(props: DialerPanelProps): JSX.Element {
  const { sessionId, onScreenPop, onStart, onStop } = props;
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

        const current = next.currentItem;
        if (current && current.status === 'connected' && lastPoppedIdRef.current !== current.id) {
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

  const runControl = useCallback((action: DialerControlAction) => {
    if (!sessionId) return;
    setControlBusy(true);
    void dialerControl(sessionId, action)
      .then(() => pollNowRef.current())
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : `Could not ${action} the run.`);
      })
      .finally(() => setControlBusy(false));
  }, [sessionId]);

  const handleStop = useCallback(() => {
    runControl('stop');
    onStop();
  }, [runControl, onStop]);

  if (!sessionId) {
    return (
      <div className="empty-state">
        <PhoneIcon className="empty-icon" />
        No active run
        <span className="empty-hint">Start one from a Salesforce list view.</span>
      </div>
    );
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
  const pct = view.counts.total > 0 ? Math.round((view.counts.done / view.counts.total) * 100) : 0;

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
