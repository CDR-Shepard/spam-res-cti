/**
 * In-call screen (ringing / active). Identical component in cti-web and
 * cti-desktop.
 */
import { useState } from 'react';
import { formatE164 } from '../format';
import { GridIcon, MicIcon, MicOffIcon, PhoneIcon, PhoneHangupIcon, PhoneOutgoingIcon, XIcon } from '../icons';
import { DTMF_KEYS } from '../dtmf';

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
  /**
   * Send one touch tone, for IVRs and call blockers that ask the rep to press a
   * digit to connect. Returns the digits to show in the readout.
   */
  onSendDigit: (key: string, sent: string) => string;
}

export function CallScreen(props: CallScreenProps): JSX.Element {
  const { phase, timer, muted } = props;
  // Tones can only go somewhere once the call is connected.
  const canSendDigits = phase === 'active';
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [sent, setSent] = useState('');

  if (keypadOpen && canSendDigits) {
    return (
      <div className="call-screen keypad-mode">
        <div className="to">{formatE164(props.toNumber)}</div>
        <div className="dtmf-sent tnum">{sent || 'Press a key to send a tone'}</div>
        <div className="dialpad dtmf">
          {DTMF_KEYS.map((k) => (
            <button key={k} className="key" onClick={() => setSent(props.onSendDigit(k, sent))}>
              <span className="num">{k}</span>
            </button>
          ))}
        </div>
        <div className="call-controls">
          <button className="cbtn" onClick={() => setKeypadOpen(false)} title="Back to call">
            <XIcon />
          </button>
          <button className="cbtn hangup" onClick={props.onHangup} title="End call">
            <PhoneHangupIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="call-screen">
      <div className={`call-avatar ${phase}`}><PhoneIcon /></div>
      <div className="to">{formatE164(props.toNumber)}</div>
      {props.recordName && (
        <div className="from record">{props.recordName}{props.objectType ? ` · ${props.objectType}` : ''}</div>
      )}
      <div className="callback-did" title="This is the number showing on their phone — give it to them as a callback number">
        <span className="cb-label"><PhoneOutgoingIcon /> Your callback number</span>
        <span className="cb-num">{formatE164(props.fromNumber)}</span>
      </div>
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
        {canSendDigits && (
          <button className="cbtn" onClick={() => setKeypadOpen(true)} title="Keypad — send touch tones">
            <GridIcon />
          </button>
        )}
        <button className="cbtn hangup" onClick={props.onHangup} title="End call">
          <PhoneHangupIcon />
        </button>
      </div>
    </div>
  );
}
