import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { humanUserByEmail, humanUsersInOrg } from './user-queries.js';

const dialect = new PgDialect();

describe('user-queries', () => {
  it('humanUsersInOrg scopes by org and excludes service users', () => {
    const q = dialect.sqlToQuery(humanUsersInOrg('O1'));
    expect(q.sql).toContain('"users"."org_id" = $1');
    expect(q.sql).toContain('"users"."kind" = $2');
    expect(q.params).toEqual(['O1', 'human']);
  });

  it('humanUserByEmail scopes by org and email and excludes service users', () => {
    const q = dialect.sqlToQuery(humanUserByEmail('O1', 'rep@example.com'));
    expect(q.params).toEqual(['O1', 'rep@example.com', 'human']);
    expect(q.sql).toContain('"users"."email" = $2');
  });
});
