import { soqlQuery } from './client.js';
import { nextBusinessDay } from '../dialer/next-business-day.js';

const DOW_START_FIELD: ReadonlyArray<readonly [string, number]> = [
  ['SundayStartTime', 0], ['MondayStartTime', 1], ['TuesdayStartTime', 2],
  ['WednesdayStartTime', 3], ['ThursdayStartTime', 4], ['FridayStartTime', 5],
  ['SaturdayStartTime', 6],
];

export function parseBusinessCalendar(
  bh: Record<string, unknown> | null,
  holidays: Array<{ ActivityDate?: string | null }>,
): { workingWeekdays: Set<number>; holidays: Set<string> } {
  const workingWeekdays = new Set<number>();
  if (bh) for (const [field, dow] of DOW_START_FIELD) if (bh[field] != null) workingWeekdays.add(dow);
  if (workingWeekdays.size === 0) for (const d of [1, 2, 3, 4, 5]) workingWeekdays.add(d);
  const hset = new Set<string>();
  for (const h of holidays) if (h.ActivityDate) hset.add(h.ActivityDate);
  return { workingWeekdays, holidays: hset };
}

export async function fetchBusinessCalendar(
  userId: string,
): Promise<{ workingWeekdays: Set<number>; holidays: Set<string> }> {
  const bhRows = await soqlQuery<Record<string, unknown>>(
    userId,
    'SELECT SundayStartTime, MondayStartTime, TuesdayStartTime, WednesdayStartTime, ' +
      'ThursdayStartTime, FridayStartTime, SaturdayStartTime FROM BusinessHours ' +
      'WHERE IsDefault = true LIMIT 1',
  );
  const holidays = await soqlQuery<{ ActivityDate?: string | null }>(
    userId,
    'SELECT ActivityDate FROM Holiday WHERE ActivityDate >= LAST_N_DAYS:7',
  );
  return parseBusinessCalendar(bhRows[0] ?? null, holidays);
}

export async function nextBusinessDayFor(userId: string, fromIsoDate: string): Promise<string> {
  const cal = await fetchBusinessCalendar(userId);
  return nextBusinessDay(fromIsoDate, cal.workingWeekdays, cal.holidays);
}
