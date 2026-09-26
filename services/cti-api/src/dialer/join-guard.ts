/**
 * May a softphone leg that NAMES a run (the `DialerSessionId` it joins with,
 * apps/cti-web dialer-leg.ts) enter the rep's power-dial room?
 *
 * The room is rep-scoped (`pd_<userId>`, twilio-telephony.ts `conferenceName`),
 * not per run, and the rep's one ACTIVE run owns it (the one-active-run
 * index). So the named run must still be live — active, or paused: Resume
 * after a callback re-joins a paused run BEFORE it resumes — and no OTHER run
 * of the rep's may be active. Otherwise a stale tab lands in the newer run's
 * room and, leaving it (every rep leg ends the room on exit), cuts that run's
 * call (spec 2026-09-26-callback-waiting-design.md decision 6).
 *
 * Deliberately not "the newest non-terminal run" by created_at: a newer run
 * that is only `ready` (a confirm block left open in another tab) or `paused`
 * (a dead tab's leftover) owns no room, and must not lock the rep out of the
 * run they are actually dialing.
 */
export function mayJoinNamedRun(sessionId: string, liveRuns: ReadonlyArray<{ id: string; status: string }>): boolean {
  if (!liveRuns.some((r) => r.id === sessionId)) return false;
  return !liveRuns.some((r) => r.id !== sessionId && r.status === 'active');
}
