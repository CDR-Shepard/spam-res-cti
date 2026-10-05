import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  existingCtiCallQuery,
  failTransferQuery,
  insertCtiCallQuery,
  linkCtiCallQuery,
  markTransferredQuery,
  sfTaskOnAiCallQuery,
  sfTaskOnCtiCallQuery,
  staleOpenQuery,
} from './store-end.js';
import { finalizeQuery } from './store.js';

const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
const ID = '11111111-2222-4333-8444-555555555555';
const CALL = '22222222-2222-4333-8444-555555555555';
const SID = `CA${'b'.repeat(32)}`;
const NOW = new Date('2026-10-05T18:00:00Z');

describe('the end of an AI call, SQL rendered', () => {
  it('finalize keeps a transfer the transfer-result already confirmed, and never invents one', () => {
    const { sql } = finalizeQuery(db, ID, { derivedOutcome: 'hung_up', durationSeconds: 5, endedAt: NOW, answeredBy: null, callSid: SID }).toSQL();
    expect(sql).toContain(`case when "ai_calls"."status" = 'transferred' then 'transferred'`);
    expect(sql).not.toMatch(/= 'qualified_transferred' then 'transferred'/);
    expect(sql).toMatch(/when coalesce\("ai_calls"\."outcome", \$\d+\) = 'failed' then 'failed' else 'completed' end/);
  });

  it('finalize stores the CallSid from the callback when the row never got one', () => {
    const { sql, params } = finalizeQuery(db, ID, { derivedOutcome: 'hung_up', durationSeconds: 5, endedAt: NOW, answeredBy: null, callSid: SID }).toSQL();
    expect(sql).toMatch(/"call_sid" = coalesce\("ai_calls"\."call_sid", \$\d+\)/);
    expect(params).toContain(SID);
  });

  it('markTransferred: only a qualified_transferred row, live (transferring) or just ended (completed) — the single late upgrade', () => {
    const { sql, params } = markTransferredQuery(db, ID).toSQL();
    expect(sql).toContain('"status" = $1');
    expect(params[0]).toBe('transferred');
    expect(sql).toMatch(/"ai_calls"\."outcome" = \$\d+ and "ai_calls"\."status" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining([ID, 'qualified_transferred', 'transferring', 'completed']));
    expect(sql).toContain('returning');
  });

  it('failTransfer replaces qualified_transferred and returns ended_at, so the caller knows whether finalize already ran', () => {
    const { sql, params } = failTransferQuery(db, ID).toSQL();
    expect(sql).toContain('"outcome" = $1');
    expect(params[0]).toBe('transfer_failed');
    expect(sql).toMatch(/"ai_calls"\."outcome" = \$\d+\)/);
    expect(sql).toContain('returning "ended_at"');
  });

  it('the calls row insert is the bare on-conflict-do-nothing (the provider-id index is partial)', () => {
    const { sql } = insertCtiCallQuery(db, {
      orgId: ID,
      userId: ID,
      provider: 'twilio',
      providerCallId: SID,
      fromNumber: '+16195550000',
      toNumber: '+16195550100',
      normalizedToNumber: '+16195550100',
    }).toSQL();
    expect(sql).toContain('insert into "calls"');
    expect(sql).toContain('on conflict do nothing');
    expect(sql).toContain('returning "id"');
  });

  it('an already-inserted calls row is found by provider + CallSid', () => {
    const { sql, params } = existingCtiCallQuery(db, SID).toSQL();
    expect(sql).toMatch(/"calls"\."provider" = \$\d+ and "calls"\."provider_call_id" = \$\d+/);
    expect(params).toEqual(expect.arrayContaining(['twilio', SID]));
  });

  it('linking the calls row never overwrites an existing link', () => {
    const { sql, params } = linkCtiCallQuery(db, ID, CALL).toSQL();
    expect(sql).toContain('"cti_call_id" = $1');
    expect(sql).toContain('"ai_calls"."cti_call_id" is null');
    expect(params).toEqual(expect.arrayContaining([CALL, ID]));
  });

  it('the Task id lands on ai_calls and, if still empty, on the calls row', () => {
    expect(sfTaskOnAiCallQuery(db, ID, '00T1').toSQL().sql).toContain('returning "cti_call_id"');
    const { sql } = sfTaskOnCtiCallQuery(db, CALL, '00T1').toSQL();
    expect(sql).toContain('"salesforce_task_id" = $1');
    expect(sql).toContain('"calls"."salesforce_task_id" is null');
  });

  it('staleOpen: unfinished rows, placed ones after one cutoff and never-placed ones after another, oldest first, capped', () => {
    const placed = new Date(NOW.getTime() - 3 * 60_000);
    const unplaced = new Date(NOW.getTime() - 10 * 60_000);
    const { sql, params } = staleOpenQuery(db, placed, unplaced, 50).toSQL();
    expect(sql).toContain('"ai_calls"."ended_at" is null');
    expect(sql).toMatch(/\("ai_calls"\."call_sid" is not null and "ai_calls"\."created_at" < \$\d+\) or \("ai_calls"\."call_sid" is null and "ai_calls"\."created_at" < \$\d+\)/);
    expect(sql).toContain('order by "ai_calls"."created_at" asc');
    expect(params).toEqual(expect.arrayContaining([placed.toISOString(), unplaced.toISOString(), 50]));
  });
});
