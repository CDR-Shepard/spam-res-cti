/** A YouTube-mode call keeps the Twilio line silent while the rep listens to
 *  the browser player instead, so any sound on that line means a person
 *  joined (a ring-through beep or the prospect's own voice) — this module
 *  turns the SDK's raw volume stream into that one fact: how long ago was
 *  the line last loud. */
export const LOUD_LEVEL = 0.02;

export interface LineAudio {
  /** Record one `outputVolume` sample from the Twilio `Call`'s `'volume'` event. */
  push(level: number): void;
  /** Notify on every sample; returns an unsubscribe function. */
  subscribe(listener: (level: number) => void): () => void;
  /** Milliseconds since the last loud sample, or `Infinity` if the line has
   *  never been loud (still silent, or no samples yet). */
  quietForMs(): number;
}

/** `now` is injectable so tests can control the clock instead of racing real time. */
export function createLineAudio(now: () => number = Date.now): LineAudio {
  // A Set (not an array) so unsubscribe during a notify is O(1) and safe —
  // see the iteration-over-a-copy note in `push` below.
  const listeners = new Set<(level: number) => void>();
  let lastLoudAt: number | null = null;

  return {
    push(level) {
      if (level >= LOUD_LEVEL) {
        lastLoudAt = now();
      }
      // Snapshot before notifying: a listener that unsubscribes itself (or
      // another listener) mid-loop must not skip or crash the remaining ones.
      // Twilio calls this synchronously and schedules the NEXT sample only
      // once it returns, so a throwing listener (e.g. a YouTube player whose
      // methods aren't live yet) must never propagate — that would silently
      // stop volume sampling for the rest of the call.
      for (const listener of [...listeners]) {
        try {
          listener(level);
        } catch {
          // Swallowed — see the comment above.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    quietForMs() {
      return lastLoudAt === null ? Infinity : now() - lastLoudAt;
    },
  };
}

/** Narrows the Twilio SDK's `Call` (typed `unknown` here so this module never
 *  depends on the SDK's types) down to "has an event emitter" before wiring
 *  it up, so a missing or mocked connection is a no-op rather than a crash. */
function hasVolumeEvent(connection: unknown): connection is { on: (event: 'volume', cb: (inputVolume: number, outputVolume: number) => void) => void } {
  return (
    typeof connection === 'object' &&
    connection !== null &&
    'on' in connection &&
    typeof (connection as { on: unknown }).on === 'function'
  );
}

/** Feeds `audio` from the connection's `'volume'` events — `outputVolume` is
 *  what the rep hears, so that's the signal for "someone joined", not
 *  `inputVolume` (the rep's own mic). */
export function watchLineVolume(connection: unknown, audio: LineAudio): void {
  if (!hasVolumeEvent(connection)) return;
  connection.on('volume', (_inputVolume, outputVolume) => audio.push(outputVolume));
}
