/**
 * Ringing INBOUND call — a callback dialed to the rep's number, ringing the
 * softphone. Answer bridges the call in the CTI; decline sends it to voicemail.
 *
 * When the caller matched a Salesforce record (server-side `findByPhone`,
 * threaded through as Twilio custom parameters — see
 * services/cti-api/src/routes/inbound-caller-params.ts and
 * src/incoming-accept.ts), the ring screen leads with their name instead of
 * the bare number.
 */
import { formatE164 } from '../format';
import { PhoneIcon, PhoneHangupIcon } from '../icons';

interface IncomingScreenProps {
  from?: string;
  /** Salesforce contact/lead/etc. name, when the caller matched a record. */
  callerName?: string;
  /** e.g. "Lead" / "Contact" / "Opportunity" / "Record" — shown next to the number when a name is present. */
  recordType?: string;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingScreen(props: IncomingScreenProps): JSX.Element {
  const formattedNumber = props.from ? formatE164(props.from) : 'Unknown caller';
  // No name → exactly today's rendering (formatted number / "Unknown caller",
  // and the static ringing indicator on line 2).
  const line1 = props.callerName || formattedNumber;
  const line2 = props.callerName
    ? `${formattedNumber}${props.recordType ? ` · ${props.recordType}` : ''}`
    : 'Incoming call…';

  return (
    <div className="call-screen incoming">
      <div className="call-avatar ringing"><PhoneIcon /></div>
      <div className="to">{line1}</div>
      <div className="timer muted">{line2}</div>
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
