/**
 * Wall-clock time in an IANA zone, with `Intl` only (no library). Business hours and
 * appointment slots are local times in the specialist's zone; Salesforce stores instants.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = Monday … 7 = Sunday. */
  isoWeekday: number;
}

export interface LocalDay {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(timeZone: string): Intl.DateTimeFormat {
  const known = formats.get(timeZone);
  if (known) return known;
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  formats.set(timeZone, f);
  return f;
}

/** The wall clock at `ms` in `timeZone`, read back as if it were UTC (whole seconds). */
function wallMs(ms: number, timeZone: string): number {
  const n: Record<string, number> = {};
  for (const p of formatFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') n[p.type] = Number(p.value);
  }
  return Date.UTC(n.year!, n.month! - 1, n.day!, n.hour! % 24, n.minute!, n.second!);
}

/** The zone's offset from UTC at instant `ms`, in ms (west of UTC is negative). */
const offsetAt = (ms: number, timeZone: string): number => wallMs(ms, timeZone) - Math.floor(ms / 1000) * 1000;

const isoWeekdayOf = (y: number, m: number, d: number): number => {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
};

export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const wall = new Date(wallMs(at.getTime(), timeZone));
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth() + 1;
  const day = wall.getUTCDate();
  return { year, month, day, hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), isoWeekday: isoWeekdayOf(year, month, day) };
}

/**
 * The instant whose wall clock in `timeZone` is y-m-d hh:mm (DST gap → the instant after the gap; overlap → the earlier instant).
 * Two passes: the offsets a day either side are the only ones that can apply; each candidate is kept when its wall clock
 * reads back exactly. None reads back only inside a gap, where the earlier offset moves the time forward past the gap.
 */
export function zonedInstant(timeZone: string, y: number, m: number, d: number, hh: number, mm: number): Date {
  const local = Date.UTC(y, m - 1, d, hh, mm);
  const before = offsetAt(local - DAY_MS, timeZone);
  const after = offsetAt(local + DAY_MS, timeZone);
  const candidates = [...new Set([local - before, local - after])].filter((t) => wallMs(t, timeZone) === local);
  return new Date(candidates.length > 0 ? Math.min(...candidates) : local - before);
}

/** The local calendar day `n` days after `at`'s local day, as { year, month, day }. */
export function addLocalDays(at: Date, n: number, timeZone: string): LocalDay {
  const p = zonedParts(at, timeZone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
}
