import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { recordRepLegEnded, recordRepLegJoined, repLegEndStatement, repLegJoinStatement } from './rep-legs.js';

const USER = 'c9c45940-0f17-4c1e-bb3e-d084ba93eb86';
const LEG = 'CA0123456789abcdef0123456789abcdef';
const AT = new Date('2026-10-01T17:00:00Z');
// No connection is opened — pg.Pool is lazy.
const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

afterEach(() => { vi.restoreAllMocks(); });

describe('repLegJoinStatement — one statement, the run read from the stamp', () => {
  it('opens the leg for the run whose rep_call_sid it was just stamped as, idempotently (bare ON CONFLICT)', () => {
    const q = new PgDialect().sqlToQuery(repLegJoinStatement(USER, LEG, AT));
    const text = q.sql.replace(/\s+/g, ' ').trim();
    expect(text).toContain('insert into dialer_rep_legs (org_id, user_id, session_id, call_sid, joined_at)');
    expect(text).toContain('select org_id, user_id, id, rep_call_sid, $1::timestamptz from dialer_sessions');
    expect(text).toContain('where user_id = $2 and rep_call_sid = $3 limit 1');
    expect(text).toMatch(/on conflict do nothing$/);
    expect(q.params).toEqual([AT.toISOString(), USER, LEG]);
  });
});

describe('repLegEndStatement — the end is stamped once', () => {
  it('a leg that already ended keeps its first end', () => {
    const q = repLegEndStatement(db, LEG, AT, 'rep_left').toSQL();
    expect(q.sql).toContain('update "dialer_rep_legs" set');
    expect(q.sql).toContain('"ended_at" = $');
    expect(q.sql).toContain('"end_source" = $');
    expect(q.sql).toContain('"dialer_rep_legs"."call_sid" = $');
    expect(q.sql).toContain('"dialer_rep_legs"."ended_at" is null');
    expect(q.params).toEqual(expect.arrayContaining([AT.toISOString(), 'rep_left', LEG]));
  });
});

describe('best-effort writers — they log and never throw', () => {
  it('a failed join insert is logged with the user id only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { execute: async () => { throw new Error('pool exhausted'); } } as never;
    await expect(recordRepLegJoined(broken, USER, LEG, AT)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('[dialer] rep leg join not recorded', { userId: USER, err: 'pool exhausted' });
  });

  it('a failed end stamp is logged with its source only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { update: () => { throw new Error('pool exhausted'); } } as never;
    await expect(recordRepLegEnded(broken, LEG, AT, 'run_end')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('[dialer] rep leg end not recorded', { source: 'run_end', err: 'pool exhausted' });
  });

  it('a missing or malformed sid writes nothing', async () => {
    const update = vi.fn();
    await recordRepLegEnded({ update } as never, undefined, AT, 'rep_left');
    await recordRepLegEnded({ update } as never, 'nope', AT, 'rep_left');
    expect(update).not.toHaveBeenCalled();
  });
});
