/**
 * Persistent, at-a-glance indicator of whether returning calls will actually
 * ring THIS softphone. Replaces the easy-to-miss "inbound degraded" toast with
 * a header pill; when another tab owns inbound it offers a one-click takeover.
 */
export type InboundPill = 'on' | 'reconnecting' | 'elsewhere';

export function inboundPillState(input: { isLeader: boolean; registered: boolean; degraded: boolean }): InboundPill {
  if (!input.isLeader) return 'elsewhere';
  if (!input.registered || input.degraded) return 'reconnecting';
  return 'on';
}

const LABEL: Record<InboundPill, string> = {
  on: 'Inbound on',
  reconnecting: 'Reconnecting…',
  elsewhere: 'Active in another tab',
};

export function InboundStatusPill(props: { state: InboundPill; onUseHere: () => void }): JSX.Element {
  return (
    <div className={`inbound-pill ${props.state}`} title="Where returning calls will ring">
      <span className="dot" />
      <span className="label">{LABEL[props.state]}</span>
      {props.state === 'elsewhere' && (
        <button type="button" className="use-here" onClick={props.onUseHere}>Use here</button>
      )}
    </div>
  );
}
