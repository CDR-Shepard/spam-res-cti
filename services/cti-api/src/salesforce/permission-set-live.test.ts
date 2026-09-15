/**
 * Pins the SQL `adminsWithConnectionQuery` actually emits.
 *
 * Why a .toSQL() test and not a fake DB: the org filter is the only thing
 * standing between this feature and using one tenant's Salesforce token to act
 * on another tenant's user, and a fake DB records a `where` object without ever
 * proving what the database would match. Deleting that one `eq` passed the whole
 * suite before this file existed. Same convention as
 * packages/auth/src/user-queries.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { adminsWithConnectionQuery } from './permission-set-live.js';

// Lazy pool: drizzle only needs the dialect to render SQL, and nothing here
// opens a connection.
const db = drizzle(new Pool({ connectionString: 'postgres://unused/unused' }), {
  schema,
}) as unknown as Parameters<typeof adminsWithConnectionQuery>[0];

const sql = () => adminsWithConnectionQuery(db, 'org-1').toSQL();

describe('adminsWithConnectionQuery — the SQL Postgres actually receives', () => {
  it('scopes to ONE org — without this, another tenant\'s admin could be the acting deputy', () => {
    expect(sql().sql).toMatch(/"org_id"\s*=\s*\$/);
  });

  it('selects only admins', () => {
    expect(sql().sql).toMatch(/"is_admin"\s*=\s*\$/);
  });

  it('excludes service users, like every other user query in this repo', () => {
    expect(sql().sql).toMatch(/"kind"\s*=\s*\$/);
  });

  it('binds the org id given, not a literal', () => {
    expect(sql().params).toContain('org-1');
  });

  it('joins the connection table, so an admin who never connected is not returned', () => {
    expect(sql().sql).toMatch(/join\s+"salesforce_connections"/i);
  });

  it('orders by the connection freshness, newest first', () => {
    expect(sql().sql).toMatch(/order by[\s\S]*"updated_at"\s+desc/i);
  });
});
