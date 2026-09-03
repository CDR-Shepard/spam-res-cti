/**
 * Pure derivation for accepting an inbound ring — isolated from App.tsx's
 * Device/state plumbing so it's unit-testable (same pattern as
 * opencti-log.ts's openCtiSavePlan).
 *
 * The server already matches the inbound caller against Salesforce and
 * threads the match through as Twilio custom parameters on the ringing
 * `<Client>` (see services/cti-api/src/routes/inbound-caller-params.ts).
 * The Voice JS SDK exposes those on `Call#customParameters: Map<string,
 * string>` (node_modules/@twilio/voice-sdk/es5/twilio/call.d.ts:28) —
 * present only when the caller matched a record; absent entirely otherwise.
 */

/** Minimal shape of a Twilio Voice SDK incoming Call this module needs. */
export interface IncomingCallLike {
  parameters?: Record<string, string>;
  customParameters?: Map<string, string>;
}

export interface IncomingCallerInfo {
  from: string;
  callerName?: string;
  recordId?: string;
  recordType?: string;
}

/** Pull the caller number + any Salesforce-match custom parameters off an incoming call. */
export function getIncomingCallerInfo(call: IncomingCallLike): IncomingCallerInfo {
  const from = call.parameters?.From ?? call.parameters?.from ?? '';
  const cp = call.customParameters;
  return {
    from,
    callerName: cp?.get('callerName'),
    recordId: cp?.get('recordId'),
    recordType: cp?.get('recordType'),
  };
}

export interface IncomingAcceptActiveCall {
  toNumber: string;
  fromNumber: string;
  /** The real Salesforce name when matched; the pre-existing literal
   *  "Incoming call" placeholder otherwise — flows into the wrap-up form and
   *  Task subject (buildCallSubject) exactly like a click-to-dial recordName. */
  recordName: string;
  recordId?: string;
  objectType?: string;
}

export interface IncomingAcceptPlan {
  activeCall: IncomingAcceptActiveCall;
  /** Record to screen-pop on accept (via the existing screenPopRecord), or
   *  undefined when the caller didn't match a record — never on ring. */
  screenPopRecordId?: string;
}

/** What accepting this inbound ring should do: the active-call state to set, and what (if anything) to screen-pop. */
export function planIncomingAccept(call: IncomingCallLike): IncomingAcceptPlan {
  const info = getIncomingCallerInfo(call);
  return {
    activeCall: {
      toNumber: info.from,
      fromNumber: info.from,
      recordName: info.callerName ?? 'Incoming call',
      recordId: info.recordId,
      objectType: info.recordType,
    },
    screenPopRecordId: info.recordId,
  };
}
