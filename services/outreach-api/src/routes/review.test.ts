import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema, type Db } from '@cti/db';
import { buildApp } from '../app.js';
import { testConfig } from '../test/harness.js';
import { registerReviewRoutes, type ReviewRouteDeps } from './review.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
const enroll = vi.hoisted(() => ({ exitEnrollment: vi.fn(async () => undefined) }));
vi.mock('../campaigns/enroll.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../campaigns/enroll.js')>()),
  exitEnrollment: enroll.exitEnrollment,
}));

type Row = Record<string, unknown>;
const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const ENROLLMENT_ID = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN_ID = '44444444-4444-4444-8444-444444444444';
const OWNER_SF_ID_18 = '005A0000001abcdEFG';
const OWNER_SF_ID_15 = '005A0000001abcd';
const FLAGGED_AT = new Date('2026-10-05T16:00:00Z');
const NOW = new Date('2026-10-06T17:00:00Z');
const admin = { userId: 'U-ADMIN', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, userId: 'U-REP', email: 'rep@gg.co', isAdmin: false };
const auth = { authorization: 'Bearer t' };

/** The joined row both the list and the decision routes select (projection keys as in review.ts). */
const reviewRow: Row = {
  enrollmentId: ENROLLMENT_ID,
  campaignId: CAMPAIGN_ID,
  campaignName: 'Probate leads',
  sfObject: 'Lead',
  sfRecordId: '00Q000000000001AAA',
  name: 'Pat Seller',
  ownerName: 'Rita Rep',
  category: 'attorney',
  quote: 'Talk to my lawyer',
  flaggedAt: FLAGGED_AT,
  status: 'needs_review',
  ownerSfUserId: OWNER_SF_ID_18,
  phones: [
    { field: 'MobilePhone', e164: '+14155550101' },
    { field: 'Phone', e164: '+14155550102' },
  ],
};

/**
 * A fake Drizzle handle for these routes, in the harness's conventions (no
 * predicate filtering; every `where` captured; writes recorded) but answering
 * each `select` by the table passed to `from`, because these routes read
 * campaign_enrollments and salesforce_connections in one request.
 */
function reviewDb(fx: { enrollments?: Row[]; connections?: Row[]; updateReturning?: Row[] } = {}) {
  const writes: Array<{ op: 'insert' | 'update'; table: unknown; values: unknown }> = [];
  const captured: { where: unknown[] } = { where: [] };
  const rowsFor = (table: unknown): Row[] =>
    table === schema.campaignEnrollments ? (fx.enrollments ?? []) : table === schema.salesforceConnections ? (fx.connections ?? []) : [];
  const db = {
    query: { organizations: { findFirst: async () => ORG } },
    select: () => {
      let table: unknown;
      const chain = {
        from: (t: unknown) => {
          table = t;
          return chain;
        },
        innerJoin: () => chain,
        where: (cond: unknown) => {
          captured.where.push(cond);
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (rows: Row[]) => void) => resolve(rowsFor(table)),
      };
      return chain;
    },
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: (cond: unknown) => {
          captured.where.push(cond);
          writes.push({ op: 'update', table, values });
          const rows = fx.updateReturning ?? [{ id: ENROLLMENT_ID }];
          return { returning: async () => rows, then: (resolve: (v: Row[]) => void) => resolve(rows) };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        writes.push({ op: 'insert', table, values });
        return { onConflictDoNothing: async () => undefined, returning: async () => [] };
      },
    }),
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db as unknown as Db),
  };
  return { db: db as unknown as Db, writes, captured };
}

let app: FastifyInstance;
let fixture: ReturnType<typeof reviewDb>;
let onConfirmed: ReturnType<typeof vi.fn<NonNullable<ReviewRouteDeps['onConfirmed']>>>;
const warn = vi.fn();

async function build(fx: Parameters<typeof reviewDb>[0] = {}): Promise<FastifyInstance> {
  fixture = reviewDb(fx);
  onConfirmed = vi.fn<NonNullable<ReviewRouteDeps['onConfirmed']>>(async () => undefined);
  return buildApp({
    cfg: testConfig(),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [(scope) => registerReviewRoutes(scope, { db: fixture.db, onConfirmed, log: { warn } })],
  });
}

const decide = (decision: string, id = ENROLLMENT_ID) => app.inject({ method: 'POST', url: `/api/review/${id}`, headers: auth, payload: { decision } });
const render = (cond: unknown) => new PgDialect().sqlToQuery(cond as SQL);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.session = admin;
  enroll.exitEnrollment.mockClear();
  warn.mockClear();
  app = await build({ enrollments: [reviewRow] });
});
afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});

describe('GET /api/review', () => {
  it("lists the tenant's needs_review enrollments, newest first, scoped to the tenant", async () => {
    state.session = rep;
    const res = await app.inject({ method: 'GET', url: '/api/review', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          enrollmentId: ENROLLMENT_ID,
          campaignId: CAMPAIGN_ID,
          campaignName: 'Probate leads',
          sfObject: 'Lead',
          sfRecordId: '00Q000000000001AAA',
          name: 'Pat Seller',
          ownerName: 'Rita Rep',
          category: 'attorney',
          quote: 'Talk to my lawyer',
          flaggedAt: FLAGGED_AT.toISOString(),
        },
      ],
    });
    const where = render(fixture.captured.where.at(-1));
    expect(where.sql).toContain('"campaign_enrollments"."org_id" = ');
    expect(where.sql).toContain('"campaign_enrollments"."status" = ');
    expect(where.params).toEqual(expect.arrayContaining(['O1', 'needs_review']));
  });

  it('requires a session', async () => {
    state.session = null;
    const res = await app.inject({ method: 'GET', url: '/api/review' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/review/:enrollmentId', () => {
  it('403 NOT_OWNER for a member who does not own the record, with no writes', async () => {
    await app.close();
    app = await build({ enrollments: [reviewRow], connections: [{ sfUserId: '005B0000009zzzzXYZ' }] });
    state.session = rep;
    const res = await decide('dismiss');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'NOT_OWNER' });
    expect(fixture.writes).toEqual([]);
    const lookup = render(fixture.captured.where.at(-1));
    expect(lookup.sql).toContain('"salesforce_connections"."user_id" = ');
    expect(lookup.params).toEqual(['U-REP']);
  });

  it('403 NOT_OWNER for a member with no Salesforce connection', async () => {
    state.session = rep;
    const res = await decide('confirm');
    expect(res.statusCode).toBe(403);
    expect(enroll.exitEnrollment).not.toHaveBeenCalled();
  });

  it('the owner (mapped through salesforce_connections.sf_user_id, 15- or 18-character) may decide', async () => {
    await app.close();
    app = await build({ enrollments: [reviewRow], connections: [{ sfUserId: OWNER_SF_ID_15 }] });
    state.session = rep;
    const res = await decide('dismiss');
    expect(res.statusCode).toBe(204);
  });

  it('an admin may decide without owning the record', async () => {
    const res = await decide('dismiss');
    expect(res.statusCode).toBe(204);
  });

  it('dismiss reactivates the enrollment with next_touch_at = now and clears the review fields', async () => {
    const res = await decide('dismiss');
    expect(res.statusCode).toBe(204);
    expect(fixture.writes).toEqual([
      {
        op: 'update',
        table: schema.campaignEnrollments,
        values: { status: 'active', reviewCategory: null, reviewQuote: null, flaggedAt: null, nextTouchAt: NOW, updatedAt: NOW },
      },
    ]);
    const where = render(fixture.captured.where.at(-1));
    expect(where.sql).toContain('"campaign_enrollments"."status" = ');
    expect(where.params).toEqual(expect.arrayContaining([ENROLLMENT_ID, 'O1', 'needs_review']));
    expect(enroll.exitEnrollment).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('confirm writes an opt-out for every phone, exits the enrollment, and calls onConfirmed once', async () => {
    const res = await decide('confirm');
    expect(res.statusCode).toBe(204);
    const optOuts = fixture.writes.filter((w) => w.op === 'insert' && w.table === schema.optOuts);
    expect(optOuts).toHaveLength(1);
    expect(optOuts[0]!.values).toEqual([
      { orgId: 'O1', e164: '+14155550101', source: 'do_not_contact_review', note: 'Do-not-contact confirmed by admin@gg.co: attorney — "Talk to my lawyer"' },
      { orgId: 'O1', e164: '+14155550102', source: 'do_not_contact_review', note: 'Do-not-contact confirmed by admin@gg.co: attorney — "Talk to my lawyer"' },
    ]);
    expect(enroll.exitEnrollment).toHaveBeenCalledTimes(1);
    expect(enroll.exitEnrollment).toHaveBeenCalledWith(fixture.db, ENROLLMENT_ID, 'do_not_contact_confirmed');
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith({ orgId: 'O1', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA' }, fixture.db);
  });

  it('confirm on a record with no phones still exits and calls onConfirmed', async () => {
    await app.close();
    app = await build({ enrollments: [{ ...reviewRow, phones: [] }] });
    const res = await decide('confirm');
    expect(res.statusCode).toBe(204);
    expect(fixture.writes.some((w) => w.table === schema.optOuts)).toBe(false);
    expect(enroll.exitEnrollment).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('409 NOT_IN_REVIEW when another decision got there first', async () => {
    await app.close();
    app = await build({ enrollments: [reviewRow], updateReturning: [] });
    const res = await decide('confirm');
    expect(res.statusCode).toBe(409);
    expect(enroll.exitEnrollment).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('dismiss: 409 NOT_IN_REVIEW when another decision got there first (the guarded update matches no row)', async () => {
    await app.close();
    app = await build({ enrollments: [reviewRow], updateReturning: [] });
    const res = await decide('dismiss');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NOT_IN_REVIEW' });
    expect(fixture.writes).toHaveLength(1);
    expect(render(fixture.captured.where.at(-1)).params).toEqual(expect.arrayContaining(['needs_review']));
  });

  it('confirm keeps the valid numbers of a malformed phones list and logs a warning without PII', async () => {
    await app.close();
    app = await build({
      enrollments: [{ ...reviewRow, phones: [{ field: 'MobilePhone', e164: '+14155550101' }, { field: 'Phone' }, { field: 'Other', e164: '4155550102' }, 'junk'] }],
    });
    const res = await decide('confirm');
    expect(res.statusCode).toBe(204);
    const optOuts = fixture.writes.filter((w) => w.op === 'insert' && w.table === schema.optOuts);
    expect((optOuts[0]!.values as Array<{ e164: string }>).map((v) => v.e164)).toEqual(['+14155550101']);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toEqual({ orgId: 'O1', enrollmentId: ENROLLMENT_ID, dropped: 3, kept: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/415|junk/);
    expect(message).toEqual(expect.stringContaining('phone'));
    expect(enroll.exitEnrollment).toHaveBeenCalledTimes(1);
  });

  it('confirm with no valid number (phones not even a list) still exits, and warns', async () => {
    await app.close();
    app = await build({ enrollments: [{ ...reviewRow, phones: 'oops' }] });
    const res = await decide('confirm');
    expect(res.statusCode).toBe(204);
    expect(fixture.writes.some((w) => w.table === schema.optOuts)).toBe(false);
    expect(warn).toHaveBeenCalledWith({ orgId: 'O1', enrollmentId: ENROLLMENT_ID, dropped: 0, kept: 0 }, expect.stringContaining('phone'));
    expect(enroll.exitEnrollment).toHaveBeenCalledTimes(1);
  });

  it('a clean phones list logs nothing', async () => {
    await decide('confirm');
    expect(warn).not.toHaveBeenCalled();
  });

  it('confirm on a record of an unknown Salesforce object does not call onConfirmed with a guessed type, but still suppresses and exits', async () => {
    await app.close();
    app = await build({ enrollments: [{ ...reviewRow, sfObject: 'Contact' }] });
    const res = await decide('confirm');
    expect(res.statusCode).toBe(204);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(fixture.writes.some((w) => w.table === schema.optOuts)).toBe(true);
    expect(enroll.exitEnrollment).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ orgId: 'O1', enrollmentId: ENROLLMENT_ID, sfObject: 'Contact' }, expect.stringContaining('sf_object'));
  });

  it('409 NOT_IN_REVIEW when the enrollment is not waiting for review', async () => {
    await app.close();
    app = await build({ enrollments: [{ ...reviewRow, status: 'active' }] });
    const res = await decide('dismiss');
    expect(res.statusCode).toBe(409);
    expect(fixture.writes).toEqual([]);
  });

  it('404 for an unknown or other-tenant enrollment, and for a malformed id; the lookup is tenant-scoped', async () => {
    await app.close();
    app = await build({ enrollments: [] });
    const missing = await decide('dismiss');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    const lookup = render(fixture.captured.where.at(-1));
    expect(lookup.sql).toContain('"campaign_enrollments"."org_id" = ');
    expect(lookup.params).toEqual(expect.arrayContaining([ENROLLMENT_ID, 'O1']));
    const malformed = await decide('dismiss', 'not-a-uuid');
    expect(malformed.statusCode).toBe(404);
  });

  it('400 for an invalid decision', async () => {
    const res = await decide('delete');
    expect(res.statusCode).toBe(400);
    expect(fixture.writes).toEqual([]);
  });
});
