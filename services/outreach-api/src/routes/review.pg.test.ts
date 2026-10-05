import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { testConfig } from '../test/harness.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { pendingDncFlag } from '../campaigns/dnc-hold.js';
import { planDueEnrollments } from '../planner/run.js';
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

  const q = async (text: string, params: unknown[]) => (await t.pool.query(text, params)).rows[0] as { id: string };
  const FLAG = { summary: 'Has a lawyer.', channels: [], timing: null, tags: [], doNotContact: { category: 'attorney', quote: 'Talk to my lawyer' } };
  const flagTriage = (orgId: string, recordId: string, at: Date) =>
    q(
      `insert into record_triage (org_id, crm_record_id, notes_hash, model, result, input_tokens, output_tokens, created_at)
       values ($1, $2, 'h', 'm', $3::jsonb, 1, 1, $4) returning id`,
      [orgId, recordId, JSON.stringify(FLAG), at],
    );

  async function seedFlagged(opts: { campaignStatus?: string } = {}): Promise<{ orgId: string; enrollmentId: string; recordId: string; triageId: string }> {
    const org = await q(`insert into organizations (name, slug) values ('T', $1) returning id`, [`t-${randomUUID().slice(0, 8)}`]);
    const campaign = await q(
      `insert into campaigns (org_id, name, sf_object, source_kind, soql, status) values ($1, 'C', 'Lead', 'soql', 'SELECT Id FROM Lead', $2) returning id`,
      [org.id, opts.campaignStatus ?? 'active'],
    );
    const record = await q(
      `insert into crm_records (org_id, sf_object, sf_record_id, phones) values ($1, 'Lead', $2, $3::jsonb) returning id`,
      [org.id, `00Q${randomUUID().replace(/-/g, '').slice(0, 15)}`, JSON.stringify([{ field: 'MobilePhone', e164: '+14155550101' }, { field: 'Phone', e164: '+14155550102' }])],
    );
    const triage = await flagTriage(org.id, record.id, new Date(Date.now() - 60_000));
    const enrollment = await q(
      `insert into campaign_enrollments (org_id, campaign_id, crm_record_id, status, review_category, review_quote, review_triage_id, flagged_at)
       values ($1, $2, $3, 'needs_review', 'attorney', 'Talk to my lawyer', $4, now()) returning id`,
      [org.id, campaign.id, record.id, triage.id],
    );
    await t.pool.query(`insert into enrollment_contact_keys (enrollment_id, org_id, key) values ($1, $2, '+14155550101'), ($1, $2, '+14155550102')`, [enrollment.id, org.id]);
    return { orgId: org.id, enrollmentId: enrollment.id, recordId: record.id, triageId: triage.id };
  }
  const asAdmin = (orgId: string) => {
    state.session = { userId: randomUUID(), orgId, email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
  };
  const decide = (enrollmentId: string, decision: string) =>
    app.inject({ method: 'POST', url: `/api/review/${enrollmentId}`, headers: { authorization: 'Bearer t' }, payload: { decision } });

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

  it('an onConfirmed failure rolls back the opt-outs and the exit, leaving the item waiting for review', async () => {
    const { orgId, enrollmentId } = await seedFlagged();
    state.session = { userId: randomUUID(), orgId, email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
    onConfirmed.mockRejectedValueOnce(new Error('outbox unavailable'));

    const res = await app.inject({ method: 'POST', url: `/api/review/${enrollmentId}`, headers: { authorization: 'Bearer t' }, payload: { decision: 'confirm' } });

    expect(res.statusCode).toBe(500);
    expect((await t.pool.query(`select count(*)::int as n from opt_outs where org_id = $1`, [orgId])).rows[0].n).toBe(0);
    const enrollment = await t.pool.query(`select status, exit_reason from campaign_enrollments where id = $1`, [enrollmentId]);
    expect(enrollment.rows[0]).toEqual({ status: 'needs_review', exit_reason: null });
    const keys = await t.pool.query(`select count(*)::int as n from enrollment_contact_keys where enrollment_id = $1 and active`, [enrollmentId]);
    expect(keys.rows[0].n).toBe(2);
  });

  it('dismiss puts the enrollment back in the planner queue', async () => {
    const { orgId, enrollmentId } = await seedFlagged();
    state.session = { userId: randomUUID(), orgId, email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
    const res = await app.inject({ method: 'POST', url: `/api/review/${enrollmentId}`, headers: { authorization: 'Bearer t' }, payload: { decision: 'dismiss' } });
    expect(res.statusCode).toBe(204);
    const row = await t.pool.query(`select status, review_category, flagged_at, next_touch_at <= now() as due from campaign_enrollments where id = $1`, [enrollmentId]);
    expect(row.rows[0]).toEqual({ status: 'active', review_category: null, flagged_at: null, due: true });
  });

  it('dismiss records which flag was dismissed: the planner then plans the person, and a newer flag holds them again', async () => {
    const { orgId, enrollmentId, recordId, triageId } = await seedFlagged();
    asAdmin(orgId);
    expect((await decide(enrollmentId, 'dismiss')).statusCode).toBe(204);
    const record = await t.pool.query(`select dnc_dismissed_triage_id from crm_records where id = $1`, [recordId]);
    expect(record.rows[0].dnc_dismissed_triage_id).toBe(triageId);
    expect(await pendingDncFlag(t.db, recordId)).toBeNull();

    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    await planDueEnrollments({ db: t.db, now: new Date(Date.now() + 1000), log });
    const touches = await t.pool.query(`select status from touches where enrollment_id = $1`, [enrollmentId]);
    expect(touches.rows).toEqual([{ status: 'planned' }]);

    const newer = await flagTriage(orgId, recordId, new Date(Date.now() + 1000));
    expect(await pendingDncFlag(t.db, recordId)).toMatchObject({ triageId: newer.id });
  });

  it('dismissing an item with an older flag never moves the dismissal marker back; a newer one moves it forward', async () => {
    const { orgId, enrollmentId, recordId, triageId: older } = await seedFlagged();
    const newer = await flagTriage(orgId, recordId, new Date(Date.now()));
    const marker = async () => (await t.pool.query(`select dnc_dismissed_triage_id as id from crm_records where id = $1`, [recordId])).rows[0].id;
    await t.pool.query(`update crm_records set dnc_dismissed_triage_id = $2 where id = $1`, [recordId, newer.id]);
    asAdmin(orgId);
    expect((await decide(enrollmentId, 'dismiss')).statusCode).toBe(204);
    expect(await marker()).toBe(newer.id);

    // The other way round: the marker sits on the older flag, the item dismissed carries the newer one.
    await t.pool.query(
      `update campaign_enrollments set status = 'needs_review', review_category = 'attorney', review_quote = 'q', review_triage_id = $2 where id = $1`,
      [enrollmentId, newer.id],
    );
    await t.pool.query(`update crm_records set dnc_dismissed_triage_id = $2 where id = $1`, [recordId, older]);
    expect((await decide(enrollmentId, 'dismiss')).statusCode).toBe(204);
    expect(await marker()).toBe(newer.id);
  });

  it('dismiss on an archived campaign exits the enrollment (campaign_archived) and frees its keys instead of resuming it', async () => {
    const { orgId, enrollmentId, recordId, triageId } = await seedFlagged({ campaignStatus: 'archived' });
    asAdmin(orgId);
    expect((await decide(enrollmentId, 'dismiss')).statusCode).toBe(204);
    const enrollment = await t.pool.query(`select status, exit_reason from campaign_enrollments where id = $1`, [enrollmentId]);
    expect(enrollment.rows[0]).toEqual({ status: 'exited', exit_reason: 'campaign_archived' });
    const keys = await t.pool.query(`select count(*)::int as n from enrollment_contact_keys where enrollment_id = $1 and active`, [enrollmentId]);
    expect(keys.rows[0].n).toBe(0);
    const record = await t.pool.query(`select dnc_dismissed_triage_id from crm_records where id = $1`, [recordId]);
    expect(record.rows[0].dnc_dismissed_triage_id).toBe(triageId);
  });

  it('a member lists only the items whose record they own; an admin lists all of them', async () => {
    const mine = await seedFlagged();
    await t.pool.query(`update crm_records set owner_sf_user_id = '005A0000001abcdEFG' where id = $1`, [mine.recordId]);
    const theirs = await q(`insert into crm_records (org_id, sf_object, sf_record_id, owner_sf_user_id) values ($1, 'Lead', $2, '005B0000009zzzzXYZ') returning id`, [
      mine.orgId,
      `00Q${randomUUID().replace(/-/g, '').slice(0, 15)}`,
    ]);
    const campaign = await q(`select campaign_id as id from campaign_enrollments where id = $1`, [mine.enrollmentId]);
    const other = await q(
      `insert into campaign_enrollments (org_id, campaign_id, crm_record_id, status, review_category, review_quote, flagged_at)
       values ($1, $2, $3, 'needs_review', 'sold', 'sold it', now()) returning id`,
      [mine.orgId, campaign.id, theirs.id],
    );
    const user = await q(`insert into users (org_id, email) values ($1, $2) returning id`, [mine.orgId, `rep-${randomUUID().slice(0, 8)}@gg.co`]);
    await t.pool.query(`insert into salesforce_connections (user_id, sf_user_id, sf_org_id, instance_url, access_token_enc) values ($1, '005A0000001abcd', '00D000000000001', 'https://x.my.salesforce.com', 'enc')`, [user.id]);
    const list = async () => (await app.inject({ method: 'GET', url: '/api/review', headers: { authorization: 'Bearer t' } })).json().items.map((i: { enrollmentId: string }) => i.enrollmentId).sort();

    state.session = { userId: user.id, orgId: mine.orgId, email: 'rep@gg.co', isAdmin: false, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
    expect(await list()).toEqual([mine.enrollmentId]);
    asAdmin(mine.orgId);
    expect(await list()).toEqual([mine.enrollmentId, other.id].sort());
  });

  it("lists an archived campaign's needs_review items, and confirm still works on them", async () => {
    const { orgId, enrollmentId } = await seedFlagged({ campaignStatus: 'archived' });
    asAdmin(orgId);
    const list = await app.inject({ method: 'GET', url: '/api/review', headers: { authorization: 'Bearer t' } });
    expect(list.json().items.map((i: { enrollmentId: string }) => i.enrollmentId)).toEqual([enrollmentId]);
    expect((await decide(enrollmentId, 'confirm')).statusCode).toBe(204);
    const enrollment = await t.pool.query(`select status, exit_reason from campaign_enrollments where id = $1`, [enrollmentId]);
    expect(enrollment.rows[0]).toEqual({ status: 'exited', exit_reason: 'do_not_contact_confirmed' });
  });
});
