import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  STALE_REQUEST_MS,
  completeQuery,
  findCallByIdQuery,
  findCallSinceQuery,
  findRequestQuery,
  linkCallQuery,
  requestHash,
  reserveQuery,
  takeOverQuery,
} from './request-store.js';

const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
const ORG = '99999999-2222-4333-8444-555555555555';
const USER = '11111111-2222-4333-8444-555555555555';
const CALL = '33333333-2222-4333-8444-555555555555';
const KEY = 'touch:44444444-2222-4333-8444-555555555555:1';
const SINCE = new Date('2026-10-05T11:50:00Z');

describe('ai_call_requests SQL, rendered', () => {
  it('pins the stale window and the body hash', () => {
    expect(STALE_REQUEST_MS).toBe(600_000);
    expect(requestHash('{"a":1}')).toBe(createHash('sha256').update('{"a":1}', 'utf8').digest('hex'));
  });

  it('1: reserve inserts the key and does nothing on conflict, returning the key', () => {
    const { sql, params } = reserveQuery(db, { orgId: ORG, key: KEY, hash: 'h', userId: USER }).toSQL();
    expect(sql).toMatch(/^insert into "ai_call_requests" \("org_id", "idempotency_key", "request_hash", "user_id", "ai_call_id", "response", "created_at", "updated_at"\) values \(\$1, \$2, \$3, \$4, default, default, default, default\) on conflict do nothing returning "idempotency_key"$/);
    expect(params).toEqual([ORG, KEY, 'h', USER]);
  });

  it('the existing row is read by its key', () => {
    const { sql, params } = findRequestQuery(db, ORG, KEY).toSQL();
    expect(sql).toContain('from "ai_call_requests" where ("ai_call_requests"."org_id" = $1 and "ai_call_requests"."idempotency_key" = $2) limit $3');
    expect(params).toEqual([ORG, KEY, 1]);
  });

  it('2: complete stores the answer and its call, by key', () => {
    const { sql, params } = completeQuery(db, ORG, KEY, { result: 'placed', aiCallId: CALL }).toSQL();
    expect(sql).toBe(
      'update "ai_call_requests" set "ai_call_id" = $1, "response" = $2, "updated_at" = now() where (("ai_call_requests"."org_id" = $3 and "ai_call_requests"."idempotency_key" = $4) and "ai_call_requests"."response" is null)',
    );
    expect(params).toEqual([CALL, JSON.stringify({ result: 'placed', aiCallId: CALL }), ORG, KEY]);
  });

  it('2: complete with a failure that has no call stores a null ai_call_id', () => {
    const { params } = completeQuery(db, ORG, KEY, { result: 'failed', reason: 'in_flight', aiCallId: null }).toSQL();
    expect(params[0]).toBeNull();
  });

  it('S-3/M-A: the takeover is ONE update: it stamps updated_at of an unanswered reservation not touched for the stale window, never created_at', () => {
    const { sql, params } = takeOverQuery(db, ORG, KEY).toSQL();
    expect(sql).toBe(
      'update "ai_call_requests" set "updated_at" = now() where (("ai_call_requests"."org_id" = $1 and "ai_call_requests"."idempotency_key" = $2) and "ai_call_requests"."response" is null and "ai_call_requests"."updated_at" < now() - make_interval(secs => $3)) returning "idempotency_key"',
    );
    expect(sql).not.toContain('"created_at"');
    expect(params).toEqual([ORG, KEY, 600]);
  });

  it('final review m3: linkCall records the inserted call on an unanswered, unlinked reservation, by key, leaving the stale clock alone', () => {
    const { sql, params } = linkCallQuery(db, ORG, KEY, CALL).toSQL();
    expect(sql).toBe(
      'update "ai_call_requests" set "ai_call_id" = $1 where (("ai_call_requests"."org_id" = $2 and "ai_call_requests"."idempotency_key" = $3) and "ai_call_requests"."response" is null and "ai_call_requests"."ai_call_id" is null)',
    );
    expect(params).toEqual([CALL, ORG, KEY]);
  });

  it('final review m3: findCall reads the linked call by id, org and starter', () => {
    const { sql, params } = findCallByIdQuery(db, ORG, USER, CALL).toSQL();
    expect(sql).toBe(
      'select "id", "status", "block_reason", "call_sid" from "ai_calls" where ("ai_calls"."org_id" = $1 and "ai_calls"."started_by" = $2 and "ai_calls"."id" = $3) limit $4',
    );
    expect(params).toEqual([ORG, USER, CALL, 1]);
  });

  it('3: findCallSince looks for a REAL record call by org, starter, record and time, newest first (Fix 1 I-2: never a practice call)', () => {
    const { sql, params } = findCallSinceQuery(db, { orgId: ORG, userId: USER, sfRecordId: '00Q5e00000AbCdEFGH', toE164: null, kind: 'record', since: SINCE }).toSQL();
    expect(sql).toBe(
      'select "id", "status", "block_reason", "call_sid" from "ai_calls" where ("ai_calls"."org_id" = $1 and "ai_calls"."started_by" = $2 and ("ai_calls"."sf_record_id" = $3 and "ai_calls"."is_test" = $4) and "ai_calls"."created_at" >= $5) order by "ai_calls"."created_at" desc limit $6',
    );
    expect(params).toEqual([ORG, USER, '00Q5e00000AbCdEFGH', false, SINCE.toISOString(), 1]);
  });

  it('3: a test call is found by its number instead, among test calls that are not practice calls', () => {
    const { sql, params } = findCallSinceQuery(db, { orgId: ORG, userId: USER, sfRecordId: null, toE164: '+15125550100', kind: 'test', since: SINCE }).toSQL();
    expect(sql).toContain('"ai_calls"."to_e164" = $3 and "ai_calls"."is_test" = $4 and "ai_calls"."practice" = $5');
    expect(sql).not.toContain('sf_record_id');
    expect(params.slice(2, 5)).toEqual(['+15125550100', true, false]);
  });

  it('3: a practice call is found by its number, among practice calls only', () => {
    const { sql, params } = findCallSinceQuery(db, { orgId: ORG, userId: USER, sfRecordId: null, toE164: '+15125550100', kind: 'practice', since: SINCE }).toSQL();
    expect(sql).toContain('"ai_calls"."to_e164" = $3 and "ai_calls"."is_test" = $4 and "ai_calls"."practice" = $5');
    expect(params.slice(2, 5)).toEqual(['+15125550100', true, true]);
  });
});
