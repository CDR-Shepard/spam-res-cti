/**
 * What one power-dial call came to. `connected` bridges the rep; `no_answer`
 * (the number rang out) is the only miss that earns a try of the record's
 * fallback number; every other value is a plain miss the engine records as a
 * `no_connect` row, keeping the reason in the row's text `outcome` column so a
 * rep can tell a list of voicemails from a list of dead numbers.
 */
export type DialOutcome =
  | 'connected'
  | 'no_answer'
  | 'voicemail'
  | 'fax'
  | 'busy'
  | 'failed'
  | 'canceled'
  | 'hangup';

/** A miss that neither bridged the rep nor earns the fallback number. */
export function isNoConnect(outcome: DialOutcome): boolean {
  return outcome !== 'connected' && outcome !== 'no_answer';
}
