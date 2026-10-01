import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { legsStatement, loadRepNames, loadTalkRows, loadTalkTimeReport, talkRowsStatement } from './talk-time-query.js';
import { parseTalkRange, type TalkRange } from './talk-time.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const r = parseTalkRange({ from: '2026-09-30', to: '2026-10-01' });
if (!r.ok) throw new Error(r.error);
const RANGE: TalkRange = r.range;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('talkRowsStatement — what counts as talk', () => {
  const q = new PgDialect().sqlToQuery(talkRowsStatement(ORG, RANGE.start, RANGE.end));
  const text = flat(q.sql);

  it('outbound counts only Connected; inbound only answered and not voicemail', () => {
    expect(text).toContain("(direction = 'outbound' and disposition = 'Connected')");
    expect(text).toContain("(direction = 'inbound' and status = 'completed' and answered_at is not null and inbound_voicemail_url is null)");
  });

  it('regular talk is true talk time when known, the old duration otherwise', () => {
    expect(text).toContain('coalesce(sum(coalesce(talk_seconds, duration_seconds, 0)), 0)::int as seconds');
  });

  it('every bridged power-dial call counts, null talk as 0', () => {
    expect(text).toContain("'powerDial' as source");
    expect(text).toContain('from dialer_connects');
    expect(text).toContain('coalesce(sum(coalesce(talk_seconds, 0)), 0)::int as seconds');
  });

  it("buckets by the org's day, by when the call started, org-scoped and range-bound on both sources", () => {
    expect(text).toContain("to_char(coalesce(started_at, created_at) at time zone 'America/Los_Angeles', 'YYYY-MM-DD') as day");
    expect(text).toContain("to_char(bridged_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD') as day");
    expect(text.match(/org_id = \$\d+/g)).toHaveLength(2);
    expect(q.params.filter((p) => p === ORG)).toHaveLength(2);
    expect(q.params).toEqual(expect.arrayContaining([RANGE.start.toISOString(), RANGE.end.toISOString()]));
  });

  // Final review M11: a sargable created_at range beside the coalesce
  // predicate, so calls_org_created_idx (org_id, created_at) can narrow the
  // scan — the coalesce expression on its own can't use that index. Both
  // bounds carry a day of slack, so the pair never drops a row the coalesce
  // predicate would keep (started_at and created_at are ms apart either way).
  it('the calls branch also filters on the plain, indexable created_at (sargable alongside the coalesce)', () => {
    expect(text).toContain('and created_at >= $');
    expect(text).toContain("interval '1 day'");
    expect(text).toContain('and created_at < $');
    // Re-review N1: an inbound row's started_at is stamped just BEFORE its
    // insert, so created_at can land a few ms past the range end while the
    // coalesce keeps the row — the upper bound needs the same day of slack.
    expect(text).toMatch(/and created_at < \$\d+::timestamptz \+ interval '1 day'/);
    expect(text).toMatch(/and created_at >= \$\d+::timestamptz - interval '1 day'/);
    // 3 each: the calls-branch coalesce bound, the new sargable bound, and the
    // dialer_connects branch's own bridged_at bound.
    expect(q.params.filter((p) => p === RANGE.start.toISOString())).toHaveLength(3);
    expect(q.params.filter((p) => p === RANGE.end.toISOString())).toHaveLength(3);
  });
});

describe('legsStatement — legs that overlap the range', () => {
  it('org-scoped; joined before the range ends; still open or ended after it starts', () => {
    const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
    const q = legsStatement(db, ORG, RANGE).toSQL();
    expect(q.sql).toContain('"dialer_rep_legs"."org_id" = $');
    expect(q.sql).toContain('"dialer_rep_legs"."joined_at" < $');
    expect(q.sql).toContain('("dialer_rep_legs"."ended_at" is null or "dialer_rep_legs"."ended_at" > $');
    expect(q.params).toEqual(expect.arrayContaining([ORG, RANGE.start.toISOString(), RANGE.end.toISOString()]));
  });
});

describe('loaders', () => {
  it('loadTalkRows maps the driver rows (numbers may arrive as strings)', async () => {
    const db = { execute: async () => ({ rows: [{ user_id: 'u1', day: '2026-10-01', source: 'outbound', calls: '3', seconds: '600' }] }) } as never;
    expect(await loadTalkRows(db, ORG, RANGE)).toEqual([{ userId: 'u1', day: '2026-10-01', source: 'outbound', calls: 3, seconds: 600 }]);
  });

  it('loadRepNames: display name, else email; no query for no ids', async () => {
    let queried = 0;
    const db = {
      select: () => {
        queried++;
        return { from: () => ({ where: async () => [{ id: 'u1', displayName: 'Garrett M', email: 'g@x.com' }, { id: 'u2', displayName: null, email: 'n@x.com' }] }) };
      },
    } as never;
    expect(await loadRepNames(db, ORG, [])).toEqual([]);
    expect(queried).toBe(0);
    expect(await loadRepNames(db, ORG, ['u1', 'u2'])).toEqual([{ id: 'u1', name: 'Garrett M' }, { id: 'u2', name: 'n@x.com' }]);
  });

  it('loadTalkTimeReport joins the three reads into the report', async () => {
    const db = {
      execute: async () => ({ rows: [{ user_id: 'u1', day: '2026-10-01', source: 'powerDial', calls: 2, seconds: 900 }] }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () =>
            table === schema.users
              ? [{ id: 'u1', displayName: 'Garrett M', email: 'g@x.com' }]
              : [{ userId: 'u1', joinedAt: new Date('2026-10-01T16:00:00Z'), endedAt: new Date('2026-10-01T17:00:00Z') }],
        }),
      }),
    } as never;
    const report = await loadTalkTimeReport(db, ORG, RANGE, new Date('2026-10-02T00:00:00Z'));
    expect(report.reps).toEqual([
      expect.objectContaining({ userId: 'u1', name: 'Garrett M', talkSeconds: 900, connectedCalls: 2, dialerSeconds: 3600 }),
    ]);
  });
});
