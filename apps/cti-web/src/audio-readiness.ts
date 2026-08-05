/**
 * Call-media health.
 *
 * HISTORY (read before "improving" this): we previously tried to detect a silent
 * call by sampling the SDK's `volume` event and by resuming our own AudioContext.
 * Both were verified INEFFECTIVE against @twilio/voice-sdk 2.18.x — the SDK plays
 * remote audio through a plain `new Audio()` + srcObject that never routes through
 * any AudioContext (rtc/peerconnection.ts), and the `volume` tap reads the raw
 * remote stream rather than the element that is actually audible, so it both
 * missed real failures and false-alarmed on healthy calls.
 *
 * The SDK already ships the correct signal: its stats monitor raises a warning
 * when RTP stops flowing. We map those to plain English, and — critically — the
 * warning name tells us WHICH DIRECTION is broken, which is the whole diagnosis:
 *   low-bytes-received → nothing is arriving FROM the far end (they sound silent)
 *   low-bytes-sent     → nothing is leaving OUR mic (they can't hear us)
 */

/** Which side of the call has no media. */
export type MediaIssue = 'no-inbound-audio' | 'no-outbound-audio';

/**
 * Map a Twilio Call `warning` name to a media issue, or null when the warning is
 * about quality (jitter/rtt/packet loss) rather than a dead direction.
 * Names come from the SDK's WARNING_PREFIXES + WARNING_NAMES tables.
 */
export function mediaIssueForWarning(warningName: string): MediaIssue | null {
  if (warningName === 'low-bytes-received') return 'no-inbound-audio';
  if (warningName === 'low-bytes-sent') return 'no-outbound-audio';
  return null;
}

/** Rep-facing copy. Says what is wrong and what to do — never just "error". */
export const MEDIA_ISSUE_MESSAGE: Record<MediaIssue, string> = {
  'no-inbound-audio': "No audio is coming from the caller — their line isn't sending any. Try calling them back.",
  'no-outbound-audio': "Your microphone isn't sending audio — check your mic and its browser permission.",
};

/** The subset of a Twilio Call we need in order to watch its media. */
export interface MediaWatchable {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Subscribe to a call's media warnings. `onIssue` fires when a direction goes
 * dead, `onCleared` when it recovers (the SDK raises and clears independently,
 * and never disconnects the call for a dead direction — so without this the rep
 * just sits in silence).
 */
export function watchCallMedia(
  call: MediaWatchable,
  onIssue: (issue: MediaIssue) => void,
  onCleared?: (issue: MediaIssue) => void,
): void {
  call.on('warning', (...args: unknown[]) => {
    const issue = typeof args[0] === 'string' ? mediaIssueForWarning(args[0]) : null;
    if (issue) onIssue(issue);
  });
  call.on('warning-cleared', (...args: unknown[]) => {
    const issue = typeof args[0] === 'string' ? mediaIssueForWarning(args[0]) : null;
    if (issue && onCleared) onCleared(issue);
  });
}

type MediaStreamish = { getTracks(): Array<{ stop(): void }> };

/**
 * Prime the microphone permission/stream so the Twilio Device's accept() has an
 * already-granted mic. Best-effort: returns false (never throws) if denied.
 * Immediately stops the primed tracks; the SDK re-acquires on accept.
 * CALLERS MUST NOT IGNORE THE RESULT — a false means the rep is inaudible.
 */
export async function prewarmMic(
  getMedia: () => Promise<MediaStreamish> = () => navigator.mediaDevices.getUserMedia({ audio: true }) as unknown as Promise<MediaStreamish>,
): Promise<boolean> {
  try {
    const stream = await getMedia();
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* already stopped */ }
    }
    return true;
  } catch {
    return false;
  }
}
