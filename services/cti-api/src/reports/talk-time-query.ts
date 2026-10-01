/**
 * The talk-time report's reads (talk-time spec). Three reads per request:
 * connected calls aggregated per rep / Pacific day / source (one statement over
 * calls + dialer_connects), the rep legs that overlap the range, and the reps'
 * names. The arithmetic is in reports/talk-time.ts.
 */
import { and, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { ORG_TIMEZONE } from '../dialer/org-day.js';
import {
  assembleTalkTimeReport,
  dialerSecondsByUserDay,
  type LegSpan,
  type RepName,
  type TalkRange,
  type TalkRow,
  type TalkSource,
  type TalkTimeReport,
} from './talk-time.js';

type Db = ReturnType<typeof getDb>;

/** A constant, never input — inlined so the GROUP BY ordinals carry no parameter. */
const TZ = sql.raw(`'${ORG_TIMEZONE}'`);

/** PURE (statement only). A regular call counts on the day it started (its
 *  start, else its creation); a power-dial call on the day it was bridged. */
export function talkRowsStatement(orgId: string, start: Date, end: Date): SQL {
  const from = start.toISOString();
  const to = end.toISOString();
  return sql`
    select user_id,
           to_char(coalesce(started_at, created_at) at time zone ${TZ}, 'YYYY-MM-DD') as day,
           case when direction = 'outbound' then 'outbound' else 'inbound' end as source,
           count(*)::int as calls,
           coalesce(sum(coalesce(talk_seconds, duration_seconds, 0)), 0)::int as seconds
    from calls
    where org_id = ${orgId}
      and coalesce(started_at, created_at) >= ${from}::timestamptz
      and coalesce(started_at, created_at) < ${to}::timestamptz
      -- Sargable alongside the coalesce above (final review M11): a row is
      -- CREATED before it starts, so created_at >= range-start minus a day's
      -- slack never drops a row the coalesce predicate would keep, while
      -- letting calls_org_created_idx (org_id, created_at) narrow the scan —
      -- the coalesce expression alone can't use that index.
      and created_at >= ${from}::timestamptz - interval '1 day'
      and created_at < ${to}::timestamptz
      and ((direction = 'outbound' and disposition = 'Connected')
        or (direction = 'inbound' and status = 'completed' and answered_at is not null and inbound_voicemail_url is null))
    group by 1, 2, 3
    union all
    select user_id,
           to_char(bridged_at at time zone ${TZ}, 'YYYY-MM-DD') as day,
           'powerDial' as source,
           count(*)::int as calls,
           coalesce(sum(coalesce(talk_seconds, 0)), 0)::int as seconds
    from dialer_connects
    where org_id = ${orgId}
      and bridged_at >= ${from}::timestamptz
      and bridged_at < ${to}::timestamptz
    group by 1, 2`;
}

interface TalkRowRaw {
  user_id: string;
  day: string;
  source: TalkSource;
  calls: number | string;
  seconds: number | string;
}

export async function loadTalkRows(db: Db, orgId: string, range: TalkRange): Promise<TalkRow[]> {
  const result = await db.execute(talkRowsStatement(orgId, range.start, range.end));
  const rows = (result as unknown as { rows: TalkRowRaw[] }).rows;
  return rows.map((r) => ({ userId: r.user_id, day: r.day, source: r.source, calls: Number(r.calls), seconds: Number(r.seconds) }));
}

export function legsStatement(db: Db, orgId: string, range: TalkRange) {
  const l = schema.dialerRepLegs;
  return db
    .select({ userId: l.userId, joinedAt: l.joinedAt, endedAt: l.endedAt })
    .from(l)
    .where(and(eq(l.orgId, orgId), lt(l.joinedAt, range.end), or(isNull(l.endedAt), gt(l.endedAt, range.start))));
}

export async function loadRepNames(db: Db, orgId: string, userIds: readonly string[]): Promise<RepName[]> {
  if (userIds.length === 0) return [];
  const u = schema.users;
  const rows = await db
    .select({ id: u.id, displayName: u.displayName, email: u.email })
    .from(u)
    .where(and(eq(u.orgId, orgId), inArray(u.id, [...userIds])));
  return rows.map((r) => ({ id: r.id, name: r.displayName ?? r.email }));
}

export async function loadTalkTimeReport(db: Db, orgId: string, range: TalkRange, now: Date): Promise<TalkTimeReport> {
  const [talk, legs] = await Promise.all([loadTalkRows(db, orgId, range), legsStatement(db, orgId, range) as Promise<LegSpan[]>]);
  const dialer = dialerSecondsByUserDay(legs, range.days, now);
  const names = await loadRepNames(db, orgId, [...new Set([...talk.map((t) => t.userId), ...legs.map((l) => l.userId)])]);
  return assembleTalkTimeReport({ range, names, talk, dialer });
}
