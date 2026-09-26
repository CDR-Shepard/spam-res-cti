/**
 * A callback ringing during a power-dial run while the rep is not talking to a
 * prospect (spec docs/superpowers/specs/2026-09-26-callback-waiting-design.md).
 * Sits above the current-record card; the rep has the ring window (~25 s) to
 * choose. Pause & answer parks the run and answers; Ignore lets the callback
 * forward or go to voicemail as it always did. Chimes once when it appears —
 * the SDK plays no ringtone for a call that arrives while another is up.
 */
import { useEffect, useRef } from 'react';
import { playCallbackChime } from '../callback-chime';

export interface CallbackBannerProps {
  /** The matched Salesforce name, else the formatted number. */
  callerLabel: string;
  recordType?: string;
  /** Pause & answer is in flight. */
  busy: boolean;
  onAnswer: () => void;
  onIgnore: () => void;
}

export function CallbackBanner({ callerLabel, recordType, busy, onAnswer, onIgnore }: CallbackBannerProps): JSX.Element {
  // Once per banner: a re-render (busy flipping) must not chime again, nor
  // React's development double-mount.
  const chimed = useRef(false);
  useEffect(() => {
    if (chimed.current) return;
    chimed.current = true;
    playCallbackChime().catch((err: unknown) => {
      // Not actionable for the rep, and the banner itself is the signal.
      console.warn('[callback] chime did not play', err);
    });
  }, []);
  return (
    <div className="section dp-callback" role="alert">
      <div className="dp-callback-text">{`Callback: ${callerLabel}${recordType ? ` · ${recordType}` : ''}`}</div>
      <div className="row dp-callback-actions">
        <button className="btn primary" disabled={busy} onClick={onAnswer}>{busy ? 'Pausing…' : 'Pause & answer'}</button>
        <button className="btn" disabled={busy} onClick={onIgnore}>Ignore</button>
      </div>
    </div>
  );
}
