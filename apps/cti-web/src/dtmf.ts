/**
 * In-call DTMF (touch tones).
 *
 * Reps hit call blockers and IVRs that say "press 1 to connect" — without this
 * the call is unanswerable, because the softphone's dialpad is only reachable
 * before a call starts.
 *
 * Tones must be sent PER KEYPRESS, the moment the key is pressed. Batching them
 * up and sending on close would arrive too late (and as one burst) for an IVR
 * that is waiting on a single digit.
 */

/** The keys a phone keypad can send. */
export const DTMF_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/** Only these characters are valid DTMF; anything else must never reach the SDK. */
export function isDtmfKey(key: string): boolean {
  return DTMF_KEYS.includes(key);
}

/** The subset of a Twilio Call needed to send tones. */
export interface DtmfSendable {
  sendDigits(digits: string): void;
}

/**
 * Send one key as a tone. Returns the digits string to display after this press,
 * or the unchanged `sent` when the key was invalid or the call could not take it
 * (a call that just ended throws — that must never break the UI).
 *
 * `maxDisplay` bounds the on-screen readout only; every valid key is still sent.
 */
export function sendDtmfKey(
  call: DtmfSendable | null | undefined,
  key: string,
  sent: string,
  maxDisplay = 32,
): string {
  if (!call || !isDtmfKey(key)) return sent;
  try {
    call.sendDigits(key);
  } catch {
    return sent; // call already gone — keep the UI honest, don't show it as sent
  }
  return (sent + key).slice(-maxDisplay);
}
