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

/**
 * Do two task subjects name the same piece of work? Used to decide which
 * same-day tasks a rollover clears alongside the one the rep dialed.
 *
 * Follow-ups are matched by the shared rule above, because the rep's org writes
 * them a dozen ways ('Follow up', 'F/U', 'follow-up call'). Anything else is
 * matched by its literal subject, trimmed and case-insensitive: a 'set appt'
 * rollover must clear other 'set appt' tasks and MUST NOT touch a follow-up the
 * rep never dialed.
 */
export function sameTaskKind(a: string | null | undefined, b: string | null | undefined): boolean {
  if (isFollowUpSubject(a)) return isFollowUpSubject(b);
  if (isFollowUpSubject(b)) return false;
  const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  const left = norm(a);
  return left !== '' && left === norm(b);
}

/**
 * How many of a day's open tasks the CTI put there.
 *
 * This is what the daily cap counts. It used to count follow-ups by subject,
 * which was the same population back when only follow-ups rolled. Now that every
 * dialed task rolls, subject no longer identifies the dialer's output — but
 * `CTI_Origin__c` does, exactly. Counting it keeps the cap meaning what it was
 * always meant to mean: the dialer will not put more than N new items on a rep's
 * plate for any one day. A rep's own hand-made tasks do not eat that budget.
 */
export function countCtiCreated(
  tasks: ReadonlyArray<{ CTI_Origin__c?: string | null }>,
): number {
  return tasks.reduce((n, t) => n + (t.CTI_Origin__c ? 1 : 0), 0);
}
