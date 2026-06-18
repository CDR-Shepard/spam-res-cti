/**
 * In-call screen (ringing / active). Identical component in cti-web and
 * cti-desktop.
 */
import { formatE164 } from '../format';
import { MicIcon, MicOffIcon, PhoneIcon, PhoneHangupIcon, PhoneOutgoingIcon } from '../icons';

interface CallScreenProps {
  phase: 'ringing' | 'active';
  toNumber: string;
  fromNumber: string;
  /** Salesforce record context, when the dial came from click-to-dial. */
  recordName?: string;
  objectType?: string;
  timer: string;
  muted: boolean;
  onToggleMute: () => void;
  onHangup: () => void;
}

export function CallScreen(props: CallScreenProps): JSX.Element {
  const { phase, timer, muted } = props;
  return (
    <div className="call-screen">
      <div className={`call-avatar ${phase}`}><PhoneIcon /></div>
      <div className="to">{formatE164(props.toNumber)}</div>
      <div className="from"><PhoneOutgoingIcon /> via {formatE164(props.fromNumber)}</div>
      {props.recordName && (
        <div className="from record">{props.recordName}{props.objectType ? ` · ${props.objectType}` : ''}</div>
      )}
      <div className={`timer ${phase === 'ringing' ? 'muted' : ''}`}>
        {phase === 'ringing' ? 'Ringing' : timer}
      </div>
      <div className="call-controls">
        <button
          className={`cbtn ${muted ? 'active' : ''}`}
          onClick={props.onToggleMute}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
        </button>
        <button className="cbtn hangup" onClick={props.onHangup} title="End call">
          <PhoneHangupIcon />
        </button>
      </div>
    </div>
  );
}
