import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  activeCallToQuery,
  appendSummaryQuery,
  appointmentConflictQuery,
  appointmentLockQuery,
  setAppointmentQuery,
  appendTranscriptQuery,
  finalizeQuery,
  handoffUserQuery,
  listQuery,
  markFailedQuery,
  mergeQualificationQuery,
  setOutcomeQuery,
  uncountedPlacedQuery,
  updateWhereStatusQuery,
  upsertOptOutQuery,
} from './store.js';

const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
const ID = '11111111-2222-4333-8444-555555555555';
const ORG = '99999999-2222-4333-8444-555555555555';
const NOW = new Date('2026-10-05T18:00:00Z');

describe('ai_calls SQL, rendered', () => {
  it('appendTranscript concatenates onto the jsonb array (never replaces it)', () => {
    const { sql, params } = appendTranscriptQuery(db, ID, [{ role: 'agent', text: 'hi', at: NOW.toISOString() }]).toSQL();
    expect(sql).toContain('"transcript" = "ai_calls"."transcript" || $1::jsonb');
    expect(params[0]).toBe(JSON.stringify([{ role: 'agent', text: 'hi', at: NOW.toISOString() }]));
  });

  it('mergeQualification merges keys with jsonb ||', () => {
    const { sql } = mergeQualificationQuery(db, ID, { motivation: 'moving' }).toSQL();
    expect(sql).toContain('"qualification" = "ai_calls"."qualification" || $1::jsonb');
  });

  it('setOutcome never overwrites a do_not_call outcome', () => {
    const { sql, params } = setOutcomeQuery(db, ID, 'not_interested', 'nope').toSQL();
    expect(sql).toContain(`case when "ai_calls"."outcome" = 'do_not_call' then "ai_calls"."outcome" else $1 end`);
    expect(sql).toContain('"summary" = $2');
    expect(params.slice(0, 2)).toEqual(['not_interested', 'nope']);
    expect(setOutcomeQuery(db, ID, 'hung_up', null).toSQL().sql).not.toContain('"summary"');
  });

  it('appendSummary joins lines with concat_ws so a null summary is skipped', () => {
    const { sql } = appendSummaryQuery(db, ID, 'Callback requested: Thursday').toSQL();
    expect(sql).toContain(`"summary" = concat_ws(E'\\n', "ai_calls"."summary", $1::text)`);
  });

  it('upsertOptOut is the idempotent bare on-conflict-do-nothing insert', () => {
    const { sql, params } = upsertOptOutQuery(db, ORG, '+16195550100', 'stop calling').toSQL();
    expect(sql).toContain('insert into "opt_outs"');
    expect(sql).toContain('on conflict do nothing');
    expect(params).toEqual(expect.arrayContaining([ORG, '+16195550100', 'ai_call', 'stop calling']));
  });

  it('updateWhereStatus only moves a row that is in one of the given states', () => {
    const { sql, params } = updateWhereStatusQuery(db, ID, ['queued', 'ringing'], { status: 'in_progress' }).toSQL();
    expect(sql).toMatch(/where \("ai_calls"\."id" = \$\d+ and "ai_calls"\."status" in \(\$\d+, \$\d+\) and "ai_calls"\."ended_at" is null\)/);
    expect(params).toEqual(expect.arrayContaining([ID, 'queued', 'ringing', 'in_progress']));
  });

  it('markFailed keeps an outcome a tool already set and only touches a live row', () => {
    const { sql } = markFailedQuery(db, ID).toSQL();
    expect(sql).toContain(`"status" = 'failed'`);
    expect(sql).toContain(`"outcome" = coalesce("ai_calls"."outcome", 'failed')`);
    expect(sql).toContain('"ai_calls"."ended_at" is null');
  });

  it('finalize is a compare-and-swap on ended_at; status keeps a confirmed transfer, else follows the final outcome', () => {
    const { sql, params } = finalizeQuery(db, ID, {
      derivedOutcome: 'no_answer',
      durationSeconds: 0,
      endedAt: NOW,
      answeredBy: null,
      callSid: null,
    }).toSQL();
    expect(sql).toMatch(/"outcome" = coalesce\("ai_calls"\."outcome", \$\d+\)/);
    expect(sql).toContain(`case when "ai_calls"."status" = 'transferred' then 'transferred'`);
    expect(sql).toMatch(/when coalesce\("ai_calls"\."outcome", \$\d+\) = 'failed' then 'failed'/);
    expect(sql).toMatch(/"answered_by" = coalesce\("ai_calls"\."answered_by", \$\d+\)/);
    expect(sql).toContain(`else 'completed' end`);
    expect(sql).toMatch(/where \("ai_calls"\."id" = \$\d+ and "ai_calls"\."ended_at" is null\)/);
    expect(sql).toContain('returning');
    expect(params).toEqual(expect.arrayContaining(['no_answer', ID]));
  });

  it('handoffUser maps an SF user id to a users.id inside the org only', () => {
    const { sql, params } = handoffUserQuery(db, ORG, '005000000000001').toSQL();
    expect(sql).toContain('inner join "users"');
    expect(sql).toMatch(/"salesforce_connections"\."sf_user_id" = \$\d+ and "users"\."org_id" = \$\d+/);
    expect(params).toEqual(expect.arrayContaining([ORG, '005000000000001']));
  });

  it('list filters by org and (for a rep) by started_by, newest first, limited', () => {
    const rep = listQuery(db, ORG, { startedBy: 'u1', limit: 20 }).toSQL();
    expect(rep.sql).toMatch(/"ai_calls"\."org_id" = \$\d+ and "ai_calls"\."started_by" = \$\d+/);
    expect(rep.sql).toContain('order by "ai_calls"."created_at" desc');
    expect(rep.sql).toContain('limit $');
    const admin = listQuery(db, ORG, { limit: 20 }).toSQL();
    expect(admin.sql).not.toContain('started_by" = ');
  });

  it('activeCallTo finds a live AI call to the same number in the org', () => {
    const { sql } = activeCallToQuery(db, ORG, '+16195550100', NOW).toSQL();
    expect(sql).toContain('"ai_calls"."ended_at" is null');
    expect(sql).toMatch(/"ai_calls"\."status" in \(\$\d+, \$\d+, \$\d+, \$\d+\)/);
    expect(sql).toContain('"ai_calls"."created_at" >= $');
  });

  it('uncountedPlaced counts placed AI calls not yet mirrored into calls', () => {
    const { sql } = uncountedPlacedQuery(db, ORG, '+16195550100', NOW).toSQL();
    expect(sql).toContain('count(*)::int');
    expect(sql).toContain('"ai_calls"."call_sid" is not null');
    expect(sql).toContain('"ai_calls"."cti_call_id" is null');
  });
  const BOOKED = {
    slotId: 'p1', kind: 'phone' as const, start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
    specialistSfUserId: '0058X00000Fsx39QAB', addressConfirmed: false, note: '', bookedAt: NOW.toISOString(),
  };

  it('setAppointment writes the booking as jsonb on a live row only', () => {
    const { sql, params } = setAppointmentQuery(db, ID, BOOKED).toSQL();
    expect(sql).toBe(
      'update "ai_calls" set "updated_at" = now(), "appointment" = $1::jsonb where ("ai_calls"."id" = $2 and "ai_calls"."ended_at" is null) returning "id"',
    );
    expect(params).toEqual([JSON.stringify(BOOKED), ID]);
  });

  it('the booking lock is a transaction advisory lock on the owner (15-character id core)', () => {
    const { sql, params } = new PgDialect().sqlToQuery(appointmentLockQuery('0058X00000Fsx39QAB'));
    expect(sql).toBe('select pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(params).toEqual(['ai_call_appointment:0058X00000Fsx39']);
  });

  it('the conflict read: another real call in the org, same owner, overlapping times, recent', () => {
    const { sql, params } = appointmentConflictQuery(db, ID, BOOKED).toSQL();
    expect(sql).toContain('from "ai_calls"');
    expect(sql).toContain('"ai_calls"."org_id" = (select "org_id" from "ai_calls" "self" where "self"."id" = $');
    expect(sql).toMatch(/"ai_calls"\."id" <> \$\d+/);
    expect(sql).toContain('"ai_calls"."is_test" = false');
    expect(sql).toContain('"ai_calls"."appointment" is not null');
    expect(sql).toMatch(/"ai_calls"\."created_at" >= now\(\) - make_interval\(days => \$\d+\)/);
    expect(sql).toMatch(/left\("ai_calls"\."appointment"->>'specialistSfUserId', 15\) = \$\d+/);
    // Fix 1 I-3: each booking's blocked time (its buffer included), [blockStart ?? start, blockEnd ?? end).
    expect(sql).toMatch(/coalesce\("ai_calls"\."appointment"->>'blockStart', "ai_calls"\."appointment"->>'start'\)::timestamptz < \$\d+::timestamptz/);
    expect(sql).toMatch(/coalesce\("ai_calls"\."appointment"->>'blockEnd', "ai_calls"\."appointment"->>'end'\)::timestamptz > \$\d+::timestamptz/);
    expect(sql).toContain('limit $');
    expect(params).toEqual(expect.arrayContaining([ID, '0058X00000Fsx39', BOOKED.start, BOOKED.end, 30]));
  });

  it('Fix 1 I-3: a new booking that carries a block is compared by it', () => {
    const blocked = { ...BOOKED, blockStart: '2030-01-01T00:00:00.000Z', blockEnd: '2030-01-02T00:00:00.000Z' };
    const { params } = appointmentConflictQuery(db, ID, blocked).toSQL();
    expect(params).toEqual(expect.arrayContaining([blocked.blockStart, blocked.blockEnd]));
    expect(params).not.toContain(BOOKED.start);
  });

  it('Fix 1 I-1: only a standing booking holds the time (a live row with no outcome, or a keeping outcome)', () => {
    const { sql, params } = appointmentConflictQuery(db, ID, BOOKED).toSQL();
    expect(sql).toMatch(/\("ai_calls"\."outcome" in \(\$\d+, \$\d+, \$\d+\) or \("ai_calls"\."outcome" is null and "ai_calls"\."ended_at" is null\)\)/);
    expect(params).toEqual(expect.arrayContaining(['appointment_set', 'qualified_transferred', 'transfer_failed']));
  });
});
