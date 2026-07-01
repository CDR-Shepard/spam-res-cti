/**
 * Post-call wrap-up: disposition + notes. Identical component in cti-web
 * and cti-desktop.
 */
import { formatE164 } from '../format';

export const DISPOSITIONS = [
  'Connected', 'Left voicemail', 'No answer', 'Wrong number',
  'Do not call', 'Busy', 'Bad number', 'Call back',
] as const;

interface WrapupFormProps {
  toNumber: string;
  timer: string;
  /** Salesforce record the Task will attach to, when known. */
  recordName?: string;
  disposition: string;
  onDisposition: (d: string) => void;
  notes: string;
  onNotes: (n: string) => void;
  busy: boolean;
  onSubmit: () => void;
}

export function WrapupForm(props: WrapupFormProps): JSX.Element {
  return (
    <div className="wrapup">
      <div className="summary">
        <div className="num">{formatE164(props.toNumber)}</div>
        <div className="meta"><span className="tnum">{props.timer}</span> · call ended</div>
        {props.recordName && (
          <div className="meta attach">Task will attach to {props.recordName}</div>
        )}
      </div>
      <label className="lbl">Disposition</label>
      <div className="disposition-grid">
        {DISPOSITIONS.map((d) => (
          <button
            key={d}
            className={`disp-chip ${props.disposition === d ? 'selected' : ''} ${d === 'Do not call' ? 'dnc' : ''}`}
            onClick={() => props.onDisposition(d)}
          >
            {d}
          </button>
        ))}
      </div>
      <label className="lbl">Notes</label>
      <textarea
        className="field"
        rows={4}
        value={props.notes}
        onChange={(e) => props.onNotes(e.target.value)}
        placeholder="What did you discuss? Next steps?"
      />
      <div className="row wrapup-actions">
        <button className="btn primary grow" disabled={props.busy} onClick={props.onSubmit}>
          {props.busy ? <><span className="spinner" /> Logging…</> : 'Log call'}
        </button>
      </div>
      <div className="wrapup-note">Every call is logged to Salesforce. Disposition this call to continue.</div>
    </div>
  );
}
