/**
 * Fifteen minutes with nothing happening on a rep's power-dial line (idle-cutoff
 * spec, docs/superpowers/specs/2026-10-06-dialer-idle-cutoff-design.md): the
 * line is hung up (dialer/idle-runs.ts) and the time past it is not counted as
 * time on the dialer (reports/talk-time.ts). Something happening = a dial
 * placed, or a conversation in progress / ended less than this long ago.
 */
export const DIALER_IDLE_MS = 15 * 60_000;
