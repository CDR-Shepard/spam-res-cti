/**
 * Local ringback tone for OUTBOUND calls. The Twilio Voice SDK doesn't reliably
 * pass carrier ringback to the browser, so the rep can hear silence until the
 * callee answers. We synthesize the standard US ringback (440 Hz + 480 Hz, 2s
 * on / 4s off) with the Web Audio API while the call is ringing.
 */
let ctx: AudioContext | null = null;
let cadenceTimer: number | null = null;
let live: OscillatorNode[] = [];

function tone(context: AudioContext): void {
  const gain = context.createGain();
  gain.gain.value = 0.12;
  gain.connect(context.destination);
  const now = context.currentTime;
  const osc = [440, 480].map((f) => {
    const o = context.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(gain);
    o.start(now);
    o.stop(now + 2); // 2-second ring burst
    return o;
  });
  live = osc;
}

export function startRingback(): void {
  stopRingback();
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    void ctx.resume().catch(() => { /* autoplay may block; best-effort */ });
    tone(ctx);
    cadenceTimer = window.setInterval(() => {
      if (ctx) tone(ctx);
    }, 6000); // 2s tone + 4s silence
  } catch {
    ctx = null;
  }
}

export function stopRingback(): void {
  if (cadenceTimer !== null) {
    clearInterval(cadenceTimer);
    cadenceTimer = null;
  }
  for (const o of live) {
    try { o.stop(); } catch { /* already stopped */ }
  }
  live = [];
  if (ctx) {
    try { void ctx.close(); } catch { /* */ }
    ctx = null;
  }
}
