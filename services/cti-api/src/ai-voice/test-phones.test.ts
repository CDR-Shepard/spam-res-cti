/**
 * The org's test-phones list (ai_test_phones, migration 0061): the inbound agent's allow-list and, together with
 * AI_VOICE_TEST_NUMBERS, the outbound test-call list. SQL rendered without a database.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { findTestPhone, findTestPhoneQuery, testPhoneNumbers, testPhoneNumbersQuery } from './test-phones.js';

const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
const ORG = '99999999-2222-4333-8444-555555555555';
const PHONE = '+16195550142';

/** Just enough of a select chain to hand back `rows` (every builder method returns the chain; awaiting it gives rows). */
function rowsDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  return chain as unknown as typeof db;
}

describe('test phones SQL, rendered', () => {
  it("testPhoneNumbers reads the org's numbers only", () => {
    const { sql, params } = testPhoneNumbersQuery(db, ORG).toSQL();
    expect(sql).toBe('select "e164" from "ai_test_phones" where "ai_test_phones"."org_id" = $1');
    expect(params).toEqual([ORG]);
  });

  it('findTestPhone matches the org and the exact E.164, one row', () => {
    const { sql, params } = findTestPhoneQuery(db, ORG, PHONE).toSQL();
    expect(sql).toBe(
      'select "id", "added_by", "label" from "ai_test_phones" where ("ai_test_phones"."org_id" = $1 and "ai_test_phones"."e164" = $2) limit $3',
    );
    expect(params).toEqual([ORG, PHONE, 1]);
  });
});

describe('test phone lookups', () => {
  it('testPhoneNumbers is the set of numbers', async () => {
    const set = await testPhoneNumbers(rowsDb([{ e164: PHONE }, { e164: '+15125550100' }]), ORG);
    expect([...set]).toEqual([PHONE, '+15125550100']);
  });

  it('findTestPhone returns the match (id, adder, label) or null', async () => {
    const row = { id: 'p-1', addedBy: 'u-admin', label: "Evren's cell" };
    expect(await findTestPhone(rowsDb([row]), ORG, PHONE)).toEqual(row);
    expect(await findTestPhone(rowsDb([]), ORG, PHONE)).toBeNull();
  });
});
