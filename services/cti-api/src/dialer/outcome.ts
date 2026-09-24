/**
 * What one power-dial call came to. `connected` bridges the rep; every other
 * value is a plain miss the engine records as a `no_connect` row, keeping the
 * reason in the row's text `outcome` column so a rep can tell a list of
 * voicemails from a list of dead numbers. `no_answer` is not special any
 * more: the immediate Mobile→Phone fallback is gone, so no reason earns the
 * record's other number right away — that number is tried only by the
 * end-of-run retry (engine.ts `handleDialOutcome`'s `requeue`), same as any
 * other miss.
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

/**
 * A miss where the call may still be live and needs a forced hangup — every
 * value except a connect (bridged, never hung up) and `no_answer`. Excluding
 * `no_answer` is not about the fallback number any more: it is always the
 * terminal Twilio call-status ("no-answer"), which only reaches the engine
 * after Twilio has already torn the call down — there is no live leg left to
 * hang up.
 */
export function isNoConnect(outcome: DialOutcome): boolean {
  return outcome !== 'connected' && outcome !== 'no_answer';
}
