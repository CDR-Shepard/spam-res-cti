/**
 * The ONE definition of "this task is a follow-up". Used by the rollover worker
 * (which task to roll), the daily-cap count, and Task-run eligibility.
 * Whole-word on purpose: a bare `FU` substring would match "refund".
 */
export const FOLLOW_UP_SUBJECT_RE = /(?:^|[^a-z])(?:follow[ -]?up|f[\/-]?u)(?![a-z])/i;

export function isFollowUpSubject(subject: string | null | undefined): boolean {
  return !!subject && FOLLOW_UP_SUBJECT_RE.test(subject);
}

/** Count the follow-ups in a fetched task list (replaces a SOQL COUNT that could not express the FU rule). */
export function countFollowUps(tasks: ReadonlyArray<{ Subject?: string | null }>): number {
  return tasks.reduce((n, t) => n + (isFollowUpSubject(t.Subject) ? 1 : 0), 0);
}
