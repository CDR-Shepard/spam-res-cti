import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { testConfig } from '../test/harness.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { registerReviewRoutes } from './review.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

describe.skipIf(!pgLane)('review decisions (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let app: FastifyInstance;
  const onConfirmed = vi.fn(async () => undefined);

  beforeAll(async () => {
    t = await createTestDb();
    app = await buildApp({
      cfg: testConfig(),
      readiness: async () => ({ dbOk: true, jobsOk: true }),
      apiRoutes: [(scope) => registerReviewRoutes(scope, { db: t.db, onConfirmed })],
    });
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await t.drop();
  });

  async function seedFlagged(): Promise<{ orgId: string; enrollmentId: string }> {
    const q = async (text: string, params: unknown[]) => (await t.pool.query(text, params)).rows[0] as { id: string };
    const org = await q(`insert into organizations (name, slug) values ('T', $1) returning id`, [`t-${randomUUID().slice(0, 8)}`]);
    const campaign = await q(
      `insert into campaigns (org_id, name, sf_object, source_kind, soql, status) values ($1, 'C', 'Lead', 'soql', 'SELECT Id FROM Lead', 'active') returning id`,
      [org.id],
    );
    const record = await q(
      `insert into crm_records (org_id, sf_object, sf_record_id, phones) values ($1, 'Lead', $2, $3::jsonb) returning id`,
      [org.id, `00Q${randomUUID().replace(/-/g, '').slice(0, 15)}`, JSON.stringify([{ field: 'MobilePhone', e164: '+14155550101' }, { field: 'Phone', e164: '+14155550102' }])],
    );
    const enrollment = await q(
      `insert into campaign_enrollments (org_id, campaign_id, crm_record_id, status, review_category, review_quote, flagged_at)
       values ($1, $2, $3, 'needs_review', 'attorney', 'Talk to my lawyer', now()) returning id`,
      [org.id, campaign.id, record.id],
    );
    await t.pool.query(`insert into enrollment_contact_keys (enrollment_id, org_id, key) values ($1, $2, '+14155550101'), ($1, $2, '+14155550102')`, [enrollment.id, org.id]);
    return { orgId: org.id, enrollmentId: enrollment.id };
  }

  it('confirm suppresses every number, exits the enrollment, frees its keys, and survives a double click', async () => {
    const { orgId, enrollmentId } = await seedFlagged();
    state.session = { userId: randomUUID(), orgId, email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
    onConfirmed.mockClear();

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/review/${enrollmentId}`, headers: { authorization: 'Bearer t' }, payload: { decision: 'confirm' } }),
      app.inject({ method: 'POST', url: `/api/review/${enrollmentId}`, headers: { authorization: 'Bearer t' }, payload: { decision: 'confirm' } }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([204, 409]);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    const optOuts = await t.pool.query(`select e164, source from opt_outs where org_id = $1 order by e164`, [orgId]);
    expect(optOuts.rows).toEqual([
      { e164: '+14155550101', source: 'do_not_contact_review' },
      { e164: '+14155550102', source: 'do_not_contact_review' },
    ]);
    const enrollment = await t.pool.query(`select status, exit_reason from campaign_enrollments where id = $1`, [enrollmentId]);
    expect(enrollment.rows[0]).toEqual({ status: 'exited', exit_reason: 'do_not_contact_confirmed' });
    const keys = await t.pool.query(`select count(*)::int as n from enrollment_contact_keys where enrollment_id = $1 and active`, [enrollmentId]);
    expect(keys.rows[0].n).toBe(0);
  });

  it('dismiss puts the enrollment back in the planner queue', async () => {
    const { orgId, enrollmentId } = await seedFlagged();
    state.session = { userId: randomUUID(), orgId, email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
    const res = await app.inject({ method: 'POST', url: `/api/review/${enrollmentId}`, headers: { authorization: 'Bearer t' }, payload: { decision: 'dismiss' } });
    expect(res.statusCode).toBe(204);
    const row = await t.pool.query(`select status, review_category, flagged_at, next_touch_at <= now() as due from campaign_enrollments where id = $1`, [enrollmentId]);
    expect(row.rows[0]).toEqual({ status: 'active', review_category: null, flagged_at: null, due: true });
  });
});
