/** The org's timezone — the report's days are its days (the server's too). */
export const ORG_TIMEZONE = 'America/Los_Angeles';
const DAY_MS = 86_400_000;

/** `h:mm:ss`; hours are not capped at 24 (a week of talk runs past it). */
export function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Today in the org's timezone, `YYYY-MM-DD` (en-CA formats in ISO order). */
export function orgToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ORG_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** `YYYY-MM-DD` + n calendar days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export type RangeShortcut = 'today' | 'week' | 'last7';

/** From/To for a shortcut. This week = Monday through today. */
export function rangeFor(shortcut: RangeShortcut, now: Date = new Date()): { from: string; to: string } {
  const today = orgToday(now);
  if (shortcut === 'today') return { from: today, to: today };
  if (shortcut === 'last7') return { from: addDays(today, -6), to: today };
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return { from: addDays(today, -((weekday + 6) % 7)), to: today };
}

/** A per-day row's label, e.g. `Thu 10/1`. */
export function formatDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(d);
  return `${weekday} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
