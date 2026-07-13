/**
 * Date math on YYYY-MM-DD strings in a fixed calendar (the caller resolves the
 * org timezone before calling), so there is no timezone drift here.
 */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function dayOfWeek(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The working day strictly AFTER `fromIsoDate`, skipping non-working weekdays
 *  and holidays. `workingWeekdays`: 0=Sun … 6=Sat. `holidays`: YYYY-MM-DD. */
export function nextBusinessDay(
  fromIsoDate: string,
  workingWeekdays: ReadonlySet<number>,
  holidays: ReadonlySet<string>,
): string {
  if (workingWeekdays.size === 0) throw new Error('workingWeekdays must not be empty');
  let d = addDays(fromIsoDate, 1);
  for (let i = 0; i < 366; i++) {
    if (workingWeekdays.has(dayOfWeek(d)) && !holidays.has(d)) return d;
    d = addDays(d, 1);
  }
  throw new Error('no working day found within a year');
}
