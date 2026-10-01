/**
 * The talk-time report's arithmetic (talk-time spec): validate the range,
 * bound the org's Pacific days, turn each rep's legs on the power dialer into
 * seconds per day, and assemble one row per rep. PURE — the SQL is in
 * reports/talk-time-query.ts.
 */
import { ORG_TIMEZONE, orgMidnightUtc } from '../dialer/org-day.js';

export const MAX_RANGE_DAYS = 92;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type TalkSource = 'outbound' | 'powerDial' | 'inbound';

export interface TalkRange {
  from: string;
  to: string;
  /** Every day from..to, inclusive. */
  days: string[];
  /** The UTC instant `from` begins in the org's timezone. */
  start: Date;
  /** The UTC instant the day after `to` begins (exclusive end). */
  end: Date;
}

/** `YYYY-MM-DD` + n calendar days (UTC arithmetic on the label — no DST). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC instant the org's day `day` begins. Noon UTC always falls inside
 *  that same Pacific day, and orgMidnightUtc is DST-safe. */
export function dayStartUtc(day: string): Date {
  return orgMidnightUtc(new Date(`${day}T12:00:00Z`));
}

/** A real calendar day: `2026-02-30` rolls over to March and `2026-13-01` does
 *  not parse — both rejected (toISOString would THROW on the second). */
function isRealDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function parseTalkRange(query: { from?: unknown; to?: unknown }): { ok: true; range: TalkRange } | { ok: false; error: string } {
  const { from, to } = query;
  if (!isRealDay(from) || !isRealDay(to)) return { ok: false, error: 'from and to must be dates (YYYY-MM-DD)' };
  if (from > to) return { ok: false, error: 'from must be on or before to' };
  const count = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (count > MAX_RANGE_DAYS) return { ok: false, error: `at most ${MAX_RANGE_DAYS} days` };
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  return { ok: true, range: { from, to, days, start: dayStartUtc(from), end: dayStartUtc(addDays(to, 1)) } };
}

export interface LegSpan {
  userId: string;
  joinedAt: Date;
  endedAt: Date | null;
}

interface Span {
  start: number;
  end: number;
}

/** PURE: spans → non-overlapping spans, so a leg that lingered beside its
 *  replacement is counted once. Empty spans are dropped. */
export function mergeIntervals(spans: readonly Span[]): Span[] {
  return [...spans]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .reduce<Span[]>((merged, s) => {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) {
        return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, s.end) }];
      }
      return [...merged, s];
    }, []);
}

/** PURE: seconds on the power dialer per user per day. An open leg runs to
 *  `now`; a leg is split at each Pacific midnight; time outside `days` is not
 *  counted. Days with no time are absent. */
export function dialerSecondsByUserDay(
  legs: readonly LegSpan[],
  days: readonly string[],
  now: Date,
): Record<string, Record<string, number>> {
  if (days.length === 0) return {};
  // `days.length + 1` midnights, computed ONCE (final review I1): the old code
  // called `dayStartUtc` twice per day (day i's start, then day i+1's start as
  // "day i's end"), so a 92-day range did 184 calls into `orgMidnightUtc`'s
  // ~113-candidate scan — the one synchronous hotspot this branch added to the
  // process serving live Twilio webhooks. The end of day i IS the start of day
  // i+1, so `starts[i+1]` is reused instead of recomputed. `days` must be
  // CONSECUTIVE (the only caller passes parseTalkRange's full range): with a
  // gap, a day's "end" would be the next listed day's start.
  const starts = [...days, addDays(days[days.length - 1]!, 1)].map((d) => dayStartUtc(d).getTime());
  const bounds = days.map((day, i) => ({ day, start: starts[i]!, end: starts[i + 1]! }));
  const userIds = [...new Set(legs.map((l) => l.userId))];
  return Object.fromEntries(
    userIds
      .map((userId) => {
        const spans = mergeIntervals(
          legs
            .filter((l) => l.userId === userId)
            .map((l) => ({ start: l.joinedAt.getTime(), end: (l.endedAt ?? now).getTime() })),
        );
        const perDay = bounds
          .map((b) => {
            const ms = spans.reduce((sum, s) => sum + Math.max(0, Math.min(s.end, b.end) - Math.max(s.start, b.start)), 0);
            return [b.day, Math.round(ms / 1000)] as const;
          })
          .filter(([, seconds]) => seconds > 0);
        return [userId, Object.fromEntries(perDay)] as const;
      })
      .filter(([, perDay]) => Object.keys(perDay).length > 0),
  );
}

export interface TalkRow {
  userId: string;
  day: string;
  source: TalkSource;
  calls: number;
  seconds: number;
}

export interface RepName {
  id: string;
  name: string;
}

export interface DayRow {
  day: string;
  talkSeconds: number;
  connectedCalls: number;
  dialerSeconds: number;
}

export interface SourceTotals {
  calls: number;
  seconds: number;
}

export interface RepRow {
  userId: string;
  name: string;
  talkSeconds: number;
  connectedCalls: number;
  bySource: Record<TalkSource, SourceTotals>;
  dialerSeconds: number;
  days: DayRow[];
}

export interface TalkTimeReport {
  from: string;
  to: string;
  timezone: string;
  reps: RepRow[];
  totals: { talkSeconds: number; connectedCalls: number; dialerSeconds: number };
}

const SOURCES: readonly TalkSource[] = ['outbound', 'powerDial', 'inbound'];
const UNKNOWN_USER = 'Unknown user';

const sumOf = (rows: readonly TalkRow[], key: 'calls' | 'seconds'): number => rows.reduce((t, r) => t + r[key], 0);

function repRow(userId: string, name: string, rows: readonly TalkRow[], dialerByDay: Record<string, number>): RepRow {
  const bySource = Object.fromEntries(
    SOURCES.map((source) => {
      const mine = rows.filter((r) => r.source === source);
      return [source, { calls: sumOf(mine, 'calls'), seconds: sumOf(mine, 'seconds') }];
    }),
  ) as Record<TalkSource, SourceTotals>;
  const days = [...new Set([...rows.map((r) => r.day), ...Object.keys(dialerByDay)])].sort().map((day) => {
    const mine = rows.filter((r) => r.day === day);
    return { day, talkSeconds: sumOf(mine, 'seconds'), connectedCalls: sumOf(mine, 'calls'), dialerSeconds: dialerByDay[day] ?? 0 };
  });
  return {
    userId,
    name,
    talkSeconds: sumOf(rows, 'seconds'),
    connectedCalls: sumOf(rows, 'calls'),
    bySource,
    dialerSeconds: Object.values(dialerByDay).reduce((t, s) => t + s, 0),
    days,
  };
}

/** PURE: one row per rep with any activity, highest talk time first. */
export function assembleTalkTimeReport(input: {
  range: TalkRange;
  names: readonly RepName[];
  talk: readonly TalkRow[];
  dialer: Record<string, Record<string, number>>;
}): TalkTimeReport {
  const nameOf = new Map(input.names.map((n) => [n.id, n.name]));
  const userIds = [...new Set([...input.talk.map((r) => r.userId), ...Object.keys(input.dialer)])];
  const reps = userIds
    .map((userId) => repRow(userId, nameOf.get(userId) ?? UNKNOWN_USER, input.talk.filter((r) => r.userId === userId), input.dialer[userId] ?? {}))
    .sort((a, b) => b.talkSeconds - a.talkSeconds || a.name.localeCompare(b.name));
  const totals = reps.reduce(
    (t, r) => ({
      talkSeconds: t.talkSeconds + r.talkSeconds,
      connectedCalls: t.connectedCalls + r.connectedCalls,
      dialerSeconds: t.dialerSeconds + r.dialerSeconds,
    }),
    { talkSeconds: 0, connectedCalls: 0, dialerSeconds: 0 },
  );
  return { from: input.range.from, to: input.range.to, timezone: ORG_TIMEZONE, reps, totals };
}
