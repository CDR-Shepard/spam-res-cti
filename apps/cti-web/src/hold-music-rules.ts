import type { DialerCurrentItem, DialerSession } from './dialer-api';
import { LOUD_LEVEL } from './line-audio';

/** A single loud sample is a click or a stray pop; two in a row is a join
 *  beep or the start of a voice — that's the line differentiating "someone
 *  connected" from noise. */
export const HEARD_SAMPLES = 2;

/** The line must sit quiet this long after a call ends before hold music
 *  resumes, so a settling beep or the last word of a hangup doesn't restart
 *  it immediately. */
export const QUIET_BEFORE_RESUME_MS = 1500;

/** True when the last `HEARD_SAMPLES` levels were all loud — see the module
 *  comment above for why one sample isn't enough. */
export function heardSomeone(recentLevels: readonly number[]): boolean {
  if (recentLevels.length < HEARD_SAMPLES) return false;
  const lastFew = recentLevels.slice(-HEARD_SAMPLES);
  return lastFew.every((level) => level >= LOUD_LEVEL);
}

export interface PlayContext {
  sessionStatus: DialerSession['status'];
  currentItem: Pick<DialerCurrentItem, 'status' | 'prospectEndedAt'> | null;
  lineQuietForMs: number;
}

/** Hold music plays only while an active run is ringing the next number and
 *  the line has been quiet long enough to be sure no one is on it —
 *  never mid-conversation, and never during the rep's "They hung up" choice
 *  (`prospectEndedAt` set), which is a decision point, not silence to fill. */
export function shouldPlay(ctx: PlayContext): boolean {
  return (
    ctx.sessionStatus === 'active' &&
    ctx.currentItem?.status !== 'connected' &&
    !ctx.currentItem?.prospectEndedAt &&
    ctx.lineQuietForMs >= QUIET_BEFORE_RESUME_MS
  );
}
