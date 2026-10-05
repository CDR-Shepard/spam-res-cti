import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  STALE_REQUEST_MS,
  completeQuery,
  findCallSinceQuery,
  findRequestQuery,
  releaseQuery,
  requestHash,
  reserveQuery,
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
      'update "ai_call_requests" set "ai_call_id" = $1, "response" = $2, "updated_at" = now() where ("ai_call_requests"."org_id" = $3 and "ai_call_requests"."idempotency_key" = $4)',
    );
    expect(params).toEqual([CALL, JSON.stringify({ result: 'placed', aiCallId: CALL }), ORG, KEY]);
  });

  it('2: complete with a failure that has no call stores a null ai_call_id', () => {
    const { params } = completeQuery(db, ORG, KEY, { result: 'failed', reason: 'in_flight', aiCallId: null }).toSQL();
    expect(params[0]).toBeNull();
  });

  it('release deletes only an unanswered reservation', () => {
    const { sql, params } = releaseQuery(db, ORG, KEY).toSQL();
    expect(sql).toBe(
      'delete from "ai_call_requests" where ("ai_call_requests"."org_id" = $1 and "ai_call_requests"."idempotency_key" = $2 and "ai_call_requests"."response" is null)',
    );
    expect(params).toEqual([ORG, KEY]);
  });

  it('3: findCallSince looks for a record call by org, starter, record and time, newest first', () => {
    const { sql, params } = findCallSinceQuery(db, { orgId: ORG, userId: USER, sfRecordId: '00Q5e00000AbCdEFGH', toE164: null, since: SINCE }).toSQL();
    expect(sql).toBe(
      'select "id", "status", "block_reason", "call_sid" from "ai_calls" where ("ai_calls"."org_id" = $1 and "ai_calls"."started_by" = $2 and "ai_calls"."sf_record_id" = $3 and "ai_calls"."created_at" >= $4) order by "ai_calls"."created_at" desc limit $5',
    );
    expect(params).toEqual([ORG, USER, '00Q5e00000AbCdEFGH', SINCE.toISOString(), 1]);
  });

  it('3: a test call is found by its number instead', () => {
    const { sql, params } = findCallSinceQuery(db, { orgId: ORG, userId: USER, sfRecordId: null, toE164: '+15125550100', since: SINCE }).toSQL();
    expect(sql).toContain('"ai_calls"."to_e164" = $3');
    expect(sql).not.toContain('sf_record_id');
    expect(params[2]).toBe('+15125550100');
  });
});
