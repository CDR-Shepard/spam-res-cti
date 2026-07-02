/**
 * Ringing INBOUND call — a callback dialed to the rep's number, ringing the
 * softphone. Answer bridges the call in the CTI; decline sends it to voicemail.
 */
import { formatE164 } from '../format';
import { PhoneIcon, PhoneHangupIcon } from '../icons';

interface IncomingScreenProps {
  from?: string;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingScreen(props: IncomingScreenProps): JSX.Element {
  return (
    <div className="call-screen incoming">
      <div className="call-avatar ringing"><PhoneIcon /></div>
      <div className="to">{props.from ? formatE164(props.from) : 'Unknown caller'}</div>
      <div className="timer muted">Incoming call…</div>
      <div className="call-controls">
        <button className="cbtn hangup" onClick={props.onDecline} title="Decline">
          <PhoneHangupIcon />
        </button>
        <button className="cbtn answer" onClick={props.onAccept} title="Answer">
          <PhoneIcon />
        </button>
      </div>
    </div>
  );
}
