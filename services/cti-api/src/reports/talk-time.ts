/**
 * The talk-time report's arithmetic (talk-time spec, idle-cutoff spec): validate
 * the range, bound the org's Pacific days, turn each rep's legs on the power
 * dialer into seconds per day — their open line (legs) intersected with their
 * activity windows (a dial or a conversation, plus 15 minutes) — and assemble one
 * row per rep. PURE — the SQL is in reports/talk-time-query.ts.
 */
import { DIALER_IDLE_MS } from '../dialer/idle.js';
import { ORG_TIMEZONE, orgMidnightUtc } from '../dialer/org-day.js';

export const MAX_RANGE_DAYS = 92;
/** Twilio ends any call at its default 4-hour time limit, so a conversation whose
 *  `ended_at` was never recorded (a lost status callback) is counted as talking
 *  for at most that long, never "until now" forever. */
export const MAX_CONVERSATION_MS = 4 * 3_600_000;
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

/** Something happening on a rep's power-dial line (idle-cutoff spec): a dial
 *  placed (`start` = `end` = dialed_at) or a conversation (bridged_at →
 *  ended_at; null = still talking, counted to `now`). */
export interface ActivitySpan {
  userId: string;
  start: Date;
  end: Date | null;
}

export interface Span {
  start: number;
  end: number;
}

/** PURE: spans → non-overlapping spans, so a leg that lingered beside its
 *  replacement is counted once. Empty spans are dropped. */
export function mergeIntervals(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  // Mutates a LOCAL result: the inputs can be tens of thousands of dial windows,
  // and copying the array on every step made this quadratic.
  const merged: Span[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ start: s.start, end: s.end });
  }
  return merged;
}

/** PURE: the overlap of two lists of sorted, non-overlapping spans
 *  (mergeIntervals output). Two-pointer walk; touching spans share no time. */
export function intersectIntervals(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    // Local result array, never the caller's: linear on tens of thousands of spans.
    if (end > start) out.push({ start, end });
    // Advance whichever span ends first; the other may still overlap the next.
    if (a[i]!.end < b[j]!.end) i++;
    else j++;
  }
  return out;
}

/** Group items by userId in one pass. */
function groupByUser<T extends { userId: string }>(items: readonly T[]): Map<string, T[]> {
  const byUser = new Map<string, T[]>();
  for (const item of items) {
    // Local map and arrays, never the caller's: one linear pass over tens of thousands of spans.
    const mine = byUser.get(item.userId);
    if (mine) mine.push(item);
    else byUser.set(item.userId, [item]);
  }
  return byUser;
}

/** When an activity span stops counting as talking, before the idle limit is
 *  added: its recorded end, else (still talking, or the end was never recorded)
 *  `now`, but never more than MAX_CONVERSATION_MS after it began. */
function activityEndMs(a: ActivitySpan, now: Date): number {
  if (a.end) return a.end.getTime();
  return Math.min(now.getTime(), a.start.getTime() + MAX_CONVERSATION_MS);
}

/** PURE: a user's counted spans — the open line (legs; an open leg runs to
 *  `now`) intersected with the active windows (a dial counts the idle limit after
 *  it; a conversation from its start to its end — `now`, capped at the 4-hour
 *  call limit, when none was recorded — plus the idle limit). */
function countedSpans(legs: readonly LegSpan[], activity: readonly ActivitySpan[], now: Date): Span[] {
  const open = mergeIntervals(legs.map((l) => ({ start: l.joinedAt.getTime(), end: (l.endedAt ?? now).getTime() })));
  const active = mergeIntervals(
    activity.map((a) => ({ start: a.start.getTime(), end: activityEndMs(a, now) + DIALER_IDLE_MS })),
  );
  return intersectIntervals(open, active);
}

/** PURE: seconds on the power dialer per user per day — the time the rep's line
 *  was open AND something happened in the last 15 minutes (a dial placed, or a
 *  conversation in progress or ended less than 15 minutes ago; idle-cutoff spec).
 *  An open leg runs to `now`; counted time is split at each Pacific midnight;
 *  time outside `days` is not counted. Days with no time are absent. */
export function dialerSecondsByUserDay(
  legs: readonly LegSpan[],
  activity: readonly ActivitySpan[],
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
  const activityByUser = groupByUser(activity);
  return Object.fromEntries(
    [...groupByUser(legs)]
      .map(([userId, userLegs]) => {
        const spans = countedSpans(userLegs, activityByUser.get(userId) ?? [], now);
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
