/**
 * Kills the "answer to silence" failure two ways: prevention (prime the mic and
 * resume the AudioContext so accept() isn't a cold start) and detection (flag a
 * call whose inbound audio never arrives so the UI can surface it instead of
 * failing silently).
 */
export const NO_AUDIO_MS = 4000;

/** Need at least this many volume samples before judging a call dead-audio. */
const MIN_SAMPLES = 3;

/** True only when we have enough samples AND every one is pure silence. */
export function isLikelyDeadAudio(inboundSamples: readonly number[]): boolean {
  if (inboundSamples.length < MIN_SAMPLES) return false;
  return inboundSamples.every((v) => v === 0);
}

type MediaStreamish = { getTracks(): Array<{ stop(): void }> };

/**
 * Prime the microphone permission/stream so the Twilio Device's accept() has an
 * already-granted mic. Best-effort: returns false (never throws) if denied.
 * Immediately stops the primed tracks; the SDK re-acquires on accept.
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

/** Resume a suspended AudioContext (browsers suspend audio until a user gesture). */
export function resumeAudio(ctx?: { state: string; resume(): Promise<void> } | null): void {
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => { /* best-effort */ });
  }
}
