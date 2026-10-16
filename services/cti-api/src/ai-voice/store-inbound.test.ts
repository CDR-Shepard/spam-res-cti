/** store-inbound.ts, SQL rendered (no database): what only an inbound test call runs. */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { mergeCallerDetailsQuery, openInboundByCallSidQuery } from './store-inbound.js';

const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
const ORG = '99999999-2222-4333-8444-555555555555';
const SID = `CA${'b'.repeat(32)}`;
const ID = '11111111-2222-4333-8444-555555555555';

describe('inbound-only ai_calls SQL, rendered', () => {
  it("openInboundByCallSid: this org's open inbound row for the CallSid, one at most", () => {
    const { sql, params } = openInboundByCallSidQuery(db, ORG, SID).toSQL();
    expect(sql).toMatch(
      /where \("ai_calls"\."org_id" = \$1 and "ai_calls"\."call_sid" = \$2 and "ai_calls"\."direction" = \$3 and "ai_calls"\."ended_at" is null\) limit \$4$/,
    );
    expect(params).toEqual([ORG, SID, 'inbound', 1]);
  });

  it('mergeCallerDetails with a status: merges the fields, and sets the outcome to it only once the row has ended', () => {
    const fields = { location: 'Vista', status: 'callback' };
    const { sql, params } = mergeCallerDetailsQuery(db, ID, fields).toSQL();
    // Drizzle writes the SET list in column order; every SET expression reads the row as it was before the update.
    expect(sql).toBe(
      'update "ai_calls" set "outcome" = case when "ai_calls"."ended_at" is not null then $1 else "ai_calls"."outcome" end, ' +
        '"qualification" = "ai_calls"."qualification" || $2::jsonb, "updated_at" = now() ' +
        'where ("ai_calls"."id" = $3 and "ai_calls"."direction" = $4)',
    );
    expect(params).toEqual(['callback', JSON.stringify(fields), ID, 'inbound']);
  });

  it('mergeCallerDetails without a valid status never touches the outcome', () => {
    const cases: Array<Record<string, string>> = [{ location: 'Vista' }, { location: 'Vista', status: 'hot lead' }];
    for (const fields of cases) {
      const { sql, params } = mergeCallerDetailsQuery(db, ID, fields).toSQL();
      expect(sql).toBe(
        'update "ai_calls" set "qualification" = "ai_calls"."qualification" || $1::jsonb, "updated_at" = now() where ("ai_calls"."id" = $2 and "ai_calls"."direction" = $3)',
      );
      expect(params).toEqual([JSON.stringify(fields), ID, 'inbound']);
    }
  });
});
