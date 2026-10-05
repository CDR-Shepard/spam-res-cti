/**
 * Click-to-dial may NEVER dial from the AI voice agent's own numbers
 * (`ai_pool`). Two layers, both pinned here: the rotation pool's WHERE only
 * admits `REP_NUMBER_KINDS`, and an `ai_pool` row that reached the ranking
 * anyway (a stale query, a sticky row) is dropped before it can be picked.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { REP_NUMBER_KINDS } from '@cti/db';
import { isRepNumberKind, pickRotationNumber, repDialableWhere, repPoolWhere } from './rotation.js';

const TODAY = new Date().toISOString().slice(0, 10);
const dialect = new PgDialect();

function fakeDb(rows: unknown[], stickyE164: string | null = null): Parameters<typeof pickRotationNumber>[0] {
  const whereResult = {
    then: (resolve: (v: unknown) => void) => resolve(rows),
    limit: () => Promise.resolve(stickyE164 ? [{ e164: stickyE164 }] : []),
  };
  return { select: () => ({ from: () => ({ where: () => whereResult }) }) } as unknown as Parameters<
    typeof pickRotationNumber
  >[0];
}

const row = (e164: string, kind: string, over: Record<string, unknown> = {}) => ({
  e164,
  kind,
  active: true,
  health: 'healthy',
  dialsToday: 0,
  dialsTodayDate: TODAY,
  firstUsedAt: null,
  warmupOverrideCap: 100,
  lastDialAt: null,
  ...over,
});

describe('rep number kinds', () => {
  it('agent and dialer_pool are rep-dialable; ai_pool never is', () => {
    expect(REP_NUMBER_KINDS).toEqual(['agent', 'dialer_pool']);
    expect(isRepNumberKind('agent')).toBe(true);
    expect(isRepNumberKind('dialer_pool')).toBe(true);
    expect(isRepNumberKind('ai_pool')).toBe(false);
    expect(isRepNumberKind('')).toBe(false);
  });

  it("the rotation pool's WHERE admits only rep kinds", () => {
    const { sql, params } = dialect.sqlToQuery(repPoolWhere('O1', 'U1'));
    expect(sql).toBe(
      '("outbound_numbers"."org_id" = $1 and "outbound_numbers"."active" = $2 and "outbound_numbers"."assigned_user_id" = $3 and "outbound_numbers"."kind" in ($4, $5))',
    );
    expect(params).toEqual(['O1', true, 'U1', 'agent', 'dialer_pool']);
  });

  it("the firewall's from-number check (repDialableWhere) is the rep's own, rep-kind number", () => {
    const { sql, params } = dialect.sqlToQuery(repDialableWhere('O1', 'U1', '+16195550100'));
    expect(sql).toBe(
      '("outbound_numbers"."org_id" = $1 and "outbound_numbers"."e164" = $2 and "outbound_numbers"."assigned_user_id" = $3 and "outbound_numbers"."kind" in ($4, $5))',
    );
    expect(params).toEqual(['O1', '+16195550100', 'U1', 'agent', 'dialer_pool']);
  });
});

describe('pickRotationNumber never picks an ai_pool number', () => {
  it('even when it is the best-ranked row the query returned', async () => {
    // Local presence + most room + least recently used: the AI number would win on every rank.
    const rows = [
      row('+16197244374', 'ai_pool', { warmupOverrideCap: 1000 }),
      row('+13105550100', 'agent', { warmupOverrideCap: 10, lastDialAt: new Date() }),
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'O1', 'U1', '+16195559999')).toBe('+13105550100');
  });

  it('even when the sticky row points at it', async () => {
    const rows = [row('+16197244374', 'ai_pool'), row('+13105550100', 'agent')];
    expect(await pickRotationNumber(fakeDb(rows, '+16197244374'), 'O1', 'U1', '+16195559999')).toBe('+13105550100');
  });

  it('fails closed when the only candidate is an AI number', async () => {
    expect(await pickRotationNumber(fakeDb([row('+16197244374', 'ai_pool')]), 'O1', 'U1', '+16195559999')).toBeNull();
  });
});
