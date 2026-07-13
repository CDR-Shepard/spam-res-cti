/**
 * Date math on YYYY-MM-DD strings in a fixed calendar (the caller resolves the
 * org timezone before calling), so there is no timezone drift here.
 */
export function addDays(isoDate: string, days: number): string {
  const parts = isoDate.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function dayOfWeek(isoDate: string): number {
  const parts = isoDate.split('-');
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))).getUTCDay();
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
