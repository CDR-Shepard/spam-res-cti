/** The Team panel's Reset CTI status line (spec "What an admin sees"). */
export interface ResetStamps {
  ctiResetRequestedAt: string | null;
  ctiResetCompletedAt: string | null;
}

/** "2:41 PM", in the admin's own locale and time zone. */
export function formatClock(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** Pending while the request is later than the last completion (or there is
 *  none); otherwise done at the completion. Null when never reset. */
export function resetStatusLine(u: ResetStamps, clock: (iso: string) => string = formatClock): string | null {
  const requested = u.ctiResetRequestedAt;
  if (!requested) return null;
  const completed = u.ctiResetCompletedAt;
  if (!completed || Date.parse(requested) > Date.parse(completed)) return `Reset pending since ${clock(requested)}`;
  return `Reset done ${clock(completed)}`;
}
