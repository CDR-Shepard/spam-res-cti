import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import type { AttemptState } from '../dialer/pick-agent-did.js';
import { aiCallbackRepQuery, lastAiFromQuery, pickAiDid, type AiPickDeps } from './number-pool.js';

const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
const ARGS = { orgId: 'O1', userId: 'U1', toE164: '+16195559999' };
const AI_NUMBER = '+16197244374';
const NOW = new Date('2026-10-05T18:00:00Z');

function deps(over: Partial<AiPickDeps> & { state?: AttemptState } = {}): AiPickDeps & { [k: string]: unknown } {
  const state: AttemptState = over.state ?? { attemptsByNumber: new Map(), customerAttemptsTotal: 0, campaign: null };
  return {
    attemptState: vi.fn(async () => state),
    pickPool: vi.fn(async () => ({ e164: AI_NUMBER })),
    lastFrom: vi.fn(async () => AI_NUMBER),
    ...over,
  };
}

describe('pickAiDid — the AI dials only from its own pool', () => {
  it('walks the ai_pool, never the dialer pool, with its own sticky source', async () => {
    const d = deps();
    expect(await pickAiDid(db, ARGS, d)).toEqual({ e164: AI_NUMBER });
    expect(d.pickPool).toHaveBeenCalledTimes(1);
    const [, args, poolDeps] = vi.mocked(d.pickPool).mock.calls[0]!;
    expect(args).toEqual({ ...ARGS, kind: 'ai_pool' });
    // The sticky is the number the AI last called this person from — never the
    // rep's sticky_numbers row (a rep number).
    expect(await poolDeps!.stickyE164!()).toBe(AI_NUMBER);
    expect(d.lastFrom).toHaveBeenCalledWith(db, 'O1', '+16195559999');
  });

  it('honours the per-customer ceiling before claiming any number', async () => {
    const d = deps({
      state: { attemptsByNumber: new Map(), customerAttemptsTotal: 3, campaign: { maxAttempts: 2, perCustomerMaxAttempts: 3 } },
    });
    expect(await pickAiDid(db, ARGS, d)).toEqual({ skip: 'customer_ceiling' });
    expect(d.pickPool).not.toHaveBeenCalled();
  });

  it('under the ceiling it picks', async () => {
    const d = deps({
      state: { attemptsByNumber: new Map(), customerAttemptsTotal: 2, campaign: { maxAttempts: 2, perCustomerMaxAttempts: 3 } },
    });
    expect(await pickAiDid(db, ARGS, d)).toEqual({ e164: AI_NUMBER });
  });

  it('no claimable AI number is null (the gate refuses no_caller_id; nothing falls back)', async () => {
    const d = deps({ pickPool: vi.fn(async () => null) });
    expect(await pickAiDid(db, ARGS, d)).toBeNull();
  });
});

describe('the AI pool SQL, rendered', () => {
  it('lastAiFrom: the newest AI call to this person in this org that had a caller ID', () => {
    const { sql, params } = lastAiFromQuery(db, 'O1', '+16195559999').toSQL();
    expect(sql).toBe(
      'select "from_e164" from "ai_calls" where ("ai_calls"."org_id" = $1 and "ai_calls"."to_e164" = $2 and "ai_calls"."from_e164" is not null) order by "ai_calls"."created_at" desc limit $3',
    );
    expect(params).toEqual(['O1', '+16195559999', 1]);
  });

  it('aiCallbackRep: hand-off user (else starter) of the newest placed AI call to the caller, same AI number first, 14 days, human users only', () => {
    const { sql, params } = aiCallbackRepQuery(db, 'O1', '+16195559999', AI_NUMBER, NOW).toSQL();
    expect(sql).toContain('coalesce("ai_calls"."handoff_user_id", "ai_calls"."started_by")');
    expect(sql).toContain('"ai_calls"."org_id" = $');
    expect(sql).toContain('"ai_calls"."to_e164" = $');
    expect(sql).toContain('"ai_calls"."call_sid" is not null');
    expect(sql).toContain('"ai_calls"."created_at" >= $');
    expect(sql).toContain(`"users"."kind" = $`);
    expect(sql).toMatch(/order by "ai_calls"\."from_e164" = \$\d+ desc, "ai_calls"\."created_at" desc limit \$\d+$/);
    expect(params).toContain('O1');
    expect(params).toContain('+16195559999');
    expect(params).toContain(AI_NUMBER);
    expect(params).toContain('human');
    expect(params).toContain(new Date(NOW.getTime() - 14 * 24 * 3600 * 1000).toISOString());
  });
});
