/**
 * Silence check-ins (spec 2026-10-09 §4.2). Semantic VAD has no idle timeout, so the bridge times
 * the silence after the agent finished speaking and hands the agent a hidden note; the prompt says
 * to check in once, then say goodbye. At most MAX_SILENCE_CHECKS notes until the caller is heard.
 */
import type { ClearTimer, SetTimer } from './bridge-playback.js';

/** Silence after the agent's turn before a check-in. */
export const SILENCE_CHECK_MS = 8000;
/** The same after the agent called wait_for_user (they asked it to hold on). */
export const HOLD_CHECK_MS = 30_000;
export const MAX_SILENCE_CHECKS = 2;

export function silenceNoteItem(seconds: number): object {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `(No one has said anything for ${seconds} seconds.)` }],
    },
  };
}

export interface SilenceCheckDeps {
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  onSilence(seconds: number): void;
}

export class SilenceCheck {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sent = 0;

  constructor(private readonly deps: SilenceCheckDeps) {}

  arm(ms: number): void {
    this.cancel();
    if (this.sent >= MAX_SILENCE_CHECKS) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.sent += 1;
      this.deps.onSilence(Math.round(ms / 1000));
    }, ms);
  }

  cancel(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  /** The caller spoke: cancel, and allow check-ins again. */
  heard(): void {
    this.cancel();
    this.sent = 0;
  }
}
