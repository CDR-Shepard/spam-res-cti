/**
 * Number display + 12-key pad + call dock. Identical component in cti-web
 * and cti-desktop.
 */
import { formatDialString, formatE164 } from '../format';
import { BackspaceIcon, PhoneIcon } from '../icons';

const DIAL_KEYS: Array<{ k: string; sub?: string }> = [
  { k: '1' }, { k: '2', sub: 'ABC' }, { k: '3', sub: 'DEF' },
  { k: '4', sub: 'GHI' }, { k: '5', sub: 'JKL' }, { k: '6', sub: 'MNO' },
  { k: '7', sub: 'PQRS' }, { k: '8', sub: 'TUV' }, { k: '9', sub: 'WXYZ' },
  { k: '*' }, { k: '0', sub: '+' }, { k: '#' },
];

interface DialpadProps {
  raw: string;
  placeholder: string;
  /** E.164 the firewall normalized to, shown under the number when it adds info. */
  normalized?: string | null;
  busy: boolean;
  primaryDisabled: boolean;
  primaryTitle: string;
  onAppend: (key: string) => void;
  onBackspace: () => void;
  onPrimary: () => void;
}

export function Dialpad(props: DialpadProps): JSX.Element {
  const formatted = formatDialString(props.raw);
  const hint = props.normalized && formatE164(props.normalized) !== formatted
    ? formatE164(props.normalized)
    : null;
  return (
    <>
      <div className="numdisplay">
        {props.raw ? (
          <div>
            <div className={`number ${formatted.length > 14 ? 'long' : ''}`}>{formatted}</div>
            {hint && <div className="hint">{hint}</div>}
          </div>
        ) : (
          <div className="placeholder">{props.placeholder}</div>
        )}
      </div>
      <div className="dialpad">
        {DIAL_KEYS.map(({ k, sub }) => (
          <button key={k} className="key" onClick={() => props.onAppend(k)}>
            <span className="num">{k}</span>
            {/* Non-breaking space keeps 1 / * / # vertically aligned with lettered keys. */}
            <span className="sub">{sub ?? ' '}</span>
          </button>
        ))}
      </div>
      <div className="calldock">
        <button className="side" onClick={props.onBackspace} disabled={!props.raw} title="Backspace">
          <BackspaceIcon />
        </button>
        <button
          className="call-btn"
          onClick={props.onPrimary}
          disabled={props.primaryDisabled}
          title={props.primaryTitle}
        >
          {props.busy ? <span className="spinner" /> : <PhoneIcon />}
        </button>
        <div className="side spacer" />
      </div>
    </>
  );
}
