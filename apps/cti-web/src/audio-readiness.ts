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

// ---------------------------------------------------------------------------
// Local mic re-pinning.
//
// 2026-09-22: two reps reported "I can hear them but they can't hear me" after
// swapping headsets mid-shift. Voice Insights on one rep's conference leg
// showed 9,334 packets received against 1,796 sent — the microphone stream
// died and nothing re-acquired it. The Twilio SDK re-runs getUserMedia on a
// device change ONLY in browsers that expose Chrome's 'default' pseudo-device
// (and only via a silent setTimeout), so this watches the thing that actually
// goes wrong — the call's local audio track ending or muting — and re-pins the
// input to the current default. The SDK swaps the new track into the live call
// (`setInputDevice` during a call is supported; `unsetInputDevice` is not).
// ---------------------------------------------------------------------------

/** The subset of `device.audio` (Twilio AudioHelper) this needs. */
export interface AudioHelperLike {
  availableInputDevices: Map<string, { deviceId: string }>;
  inputDevice: { deviceId: string } | null;
  setInputDevice(deviceId: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/** A call that may expose its local media (Twilio Call#getLocalStream) and
 *  its lifecycle events. */
export interface LocalMicCall {
  getLocalStream?(): { getAudioTracks(): Array<{ addEventListener(e: string, cb: () => void): void }> } | null;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

export type MicRepinTrigger = 'track-ended' | 'track-muted' | 'device-change' | 'no-outbound-audio';
export type MicRepinResult = 'repinned' | 'no-device' | 'failed';

/** Pure — the input to pin: Chrome's 'default' (it follows the OS default) when
 *  present, else the first real device, else nothing. */
export function pickInputDevice(available: Map<string, { deviceId: string }>): string | null {
  if (available.has('default')) return 'default';
  const first = available.keys().next();
  return first.done ? null : first.value;
}

/**
 * Re-acquire the microphone. The public `setInputDevice` returns early when
 * the SAME device is already pinned and a stream object exists — even one
 * whose track is dead — so a second re-pin goes through the SDK's own forced
 * variant (what its device-change path calls). Never throws.
 */
export async function repinInputDevice(audio: AudioHelperLike): Promise<MicRepinResult> {
  const target = pickInputDevice(audio.availableInputDevices);
  if (!target) return 'no-device';
  try {
    if (audio.inputDevice?.deviceId !== target) {
      await audio.setInputDevice(target);
      return 'repinned';
    }
    // The SDK is pinned (2.18.3 has the forced variant). Anything cleverer —
    // hopping through another device and back — risks stranding the rep on a
    // webcam mic if the hop back fails.
    const forced = (audio as { _setInputDevice?: (id: string, force: boolean) => Promise<void> })._setInputDevice;
    if (typeof forced !== 'function') return 'failed';
    await forced.call(audio, target, true);
    return 'repinned';
  } catch {
    return 'failed';
  }
}

/** Re-pins at most this often: a headset swap fires several events at once. */
const REPIN_COOLDOWN_MS = 1000;

/**
 * Watch a live call's microphone and re-pin it the moment it goes dead:
 * the local audio track ends or mutes, or the device list changes. `onRepin`
 * reports what happened so the UI can say "microphone reconnected". Returns a
 * handle whose `repin` shares the throttle, for the SDK's own "nothing being
 * sent" warning.
 *
 * Twilio attaches the local stream AFTER `connect()` resolves — media opens
 * asynchronously and the SDK emits 'accept' once it has — so the track is
 * looked for now AND on 'accept'; and again after every re-pin, since the
 * swapped-in track is a new object nobody is watching yet.
 */
export function watchLocalMic(
  call: LocalMicCall,
  audio: AudioHelperLike,
  onRepin: (trigger: MicRepinTrigger, result: MicRepinResult) => void,
  now: () => number = Date.now,
): { repin: (trigger: MicRepinTrigger) => void } {
  let lastAt = -Infinity;
  const watched = new WeakSet<object>();
  const attach = (): void => {
    for (const track of call.getLocalStream?.()?.getAudioTracks() ?? []) {
      if (watched.has(track)) continue;
      watched.add(track);
      track.addEventListener('ended', () => repin('track-ended'));
      track.addEventListener('mute', () => repin('track-muted'));
    }
  };
  const repin = (trigger: MicRepinTrigger): void => {
    const t = now();
    if (t - lastAt < REPIN_COOLDOWN_MS) return;
    lastAt = t;
    void repinInputDevice(audio).then((result) => {
      attach();
      onRepin(trigger, result);
    });
  };
  attach();
  call.on?.('accept', attach);
  audio.on('deviceChange', () => repin('device-change'));
  return { repin };
}
