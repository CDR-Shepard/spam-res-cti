/** The Team panel's Reset CTI status line (spec "What an admin sees"). */
export interface ResetStamps {
  ctiResetRequestedAt: string | null;
  ctiResetCompletedAt: string | null;
}

/** "2:41 PM", in the admin's own locale and time zone. */
export function formatClock(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** "2:41 PM" today; "Sep 27, 2:41 PM" another day (with the year when it
 *  isn't this one) — an old stamp must not read as today's (Task 3 review M-b). */
export function formatStamp(iso: string, now: Date = new Date(), locale?: string): string {
  const at = new Date(iso);
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) return formatClock(iso, locale);
  return at.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Still waiting on the rep: the request is later than the last completion (or there is none). */
export function resetPending(u: ResetStamps): boolean {
  const requested = u.ctiResetRequestedAt;
  if (!requested) return false;
  const completed = u.ctiResetCompletedAt;
  return !completed || Date.parse(requested) > Date.parse(completed);
}

/** "Reset requested …" while pending, otherwise "Reset done …" at the
 *  completion. Null when never reset. */
export function resetStatusLine(u: ResetStamps, stamp: (iso: string) => string = (iso) => formatStamp(iso)): string | null {
  if (!u.ctiResetRequestedAt) return null;
  if (resetPending(u)) return `Reset requested ${stamp(u.ctiResetRequestedAt)}`;
  return `Reset done ${stamp(u.ctiResetCompletedAt ?? u.ctiResetRequestedAt)}`;
}
