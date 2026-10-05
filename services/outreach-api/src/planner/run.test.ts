import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Db } from '@cti/db';
import { createTestDb, pgLane } from '../test/pg.js';
import { advanceAfterTouch, planDueEnrollments, planTick, promoteQueuedCalls } from './run.js';

// Tuesday 2026-10-06, 10:00 Pacific: inside the call window for a 415 number.
const NOW = new Date('2026-10-06T17:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CA_MOBILE = [{ field: 'MobilePhone', e164: '+14155550101' }];

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe.skipIf(!pgLane)('planner run (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let pool: pg.Pool;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDb();
    pool = t.pool;
    db = t.db;
  }, 120_000);
  afterAll(async () => {
    await t.drop();
  });

  async function one<T>(text: string, params: unknown[]): Promise<T> {
    const { rows } = await pool.query(text, params);
    return rows[0] as T;
  }

  async function seedOrg(settings: Record<string, unknown> = {}): Promise<string> {
    const row = await one<{ id: string }>(
      `insert into organizations (name, slug, settings) values ('Test', $1, $2::jsonb) returning id`,
      [`t-${randomUUID().slice(0, 8)}`, JSON.stringify(settings)],
    );
    return row.id;
  }

  async function seedCampaign(orgId: string, status: string, touchDays = '{0,1,3,6,10,14}'): Promise<string> {
    const row = await one<{ id: string }>(
      `insert into campaigns (org_id, name, sf_object, source_kind, soql, status, touch_days)
       values ($1, 'Campaign', 'Lead', 'soql', 'SELECT Id FROM Lead', $2, $3::integer[]) returning id`,
      [orgId, status, touchDays],
    );
    return row.id;
  }

  async function seedRecord(orgId: string, over: { phones?: unknown[]; email?: string | null; state?: string | null } = {}): Promise<string> {
    const row = await one<{ id: string }>(
      `insert into crm_records (org_id, sf_object, sf_record_id, name, phones, email, state)
       values ($1, 'Lead', $2, 'Pat Seller', $3::jsonb, $4, $5) returning id`,
      [orgId, `00Q${randomUUID().replace(/-/g, '').slice(0, 15)}`, JSON.stringify(over.phones ?? CA_MOBILE), over.email ?? null, over.state ?? 'CA'],
    );
    return row.id;
  }

  async function seedEnrollment(a: { orgId: string; campaignId: string; recordId: string; nextTouchAt?: Date; touchesDone?: number; enrolledAt?: Date }): Promise<string> {
    const row = await one<{ id: string }>(
      `insert into campaign_enrollments (org_id, campaign_id, crm_record_id, next_touch_at, touches_done, enrolled_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [a.orgId, a.campaignId, a.recordId, a.nextTouchAt ?? new Date(NOW.getTime() - 60_000), a.touchesDone ?? 0, a.enrolledAt ?? new Date(NOW.getTime() - HOUR)],
    );
    return row.id;
  }

  async function dueEnrollment(campaignStatus: string, record: Parameters<typeof seedRecord>[1] = {}, settings: Record<string, unknown> = {}) {
    const orgId = await seedOrg(settings);
    const campaignId = await seedCampaign(orgId, campaignStatus);
    const recordId = await seedRecord(orgId, record);
    const enrollmentId = await seedEnrollment({ orgId, campaignId, recordId });
    return { orgId, campaignId, recordId, enrollmentId };
  }

  async function touchesOf(enrollmentId: string): Promise<Array<{ id: string; seq: number; channel: string; status: string; gate_audit: unknown[] }>> {
    const { rows } = await pool.query(`select id, seq, channel, status, gate_audit from touches where enrollment_id = $1 order by seq`, [enrollmentId]);
    return rows;
  }

  async function enrollment(id: string): Promise<{ status: string; exit_reason: string | null; touches_done: number; next_touch_at: Date | null }> {
    return one(`select status, exit_reason, touches_done, next_touch_at from campaign_enrollments where id = $1`, [id]);
  }

  it('gives a due enrollment exactly one touch, seq = touches_done + 1, even with two planners racing', async () => {
    const orgId = await seedOrg();
    const campaignId = await seedCampaign(orgId, 'dry_run');
    const recordId = await seedRecord(orgId);
    const enrollmentId = await seedEnrollment({ orgId, campaignId, recordId, touchesDone: 2 });

    await Promise.all([planDueEnrollments({ db, now: NOW, log }), planDueEnrollments({ db, now: NOW, log })]);

    const touches = await touchesOf(enrollmentId);
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ seq: 3, channel: 'rep_call', status: 'planned' });
    expect(touches[0]!.gate_audit).toContainEqual(expect.objectContaining({ rule: 'rule1_live', channel: 'rep_call', verdict: 'kept' }));
  });

  it('does not plan an enrollment that already has an open touch, or one not yet due', async () => {
    const { enrollmentId } = await dueEnrollment('dry_run');
    await planDueEnrollments({ db, now: NOW, log });
    await planDueEnrollments({ db, now: new Date(NOW.getTime() + HOUR), log });
    expect(await touchesOf(enrollmentId)).toHaveLength(1);

    const orgId = await seedOrg();
    const campaignId = await seedCampaign(orgId, 'dry_run');
    const recordId = await seedRecord(orgId);
    const later = await seedEnrollment({ orgId, campaignId, recordId, nextTouchAt: new Date(NOW.getTime() + HOUR) });
    await planDueEnrollments({ db, now: NOW, log });
    expect(await touchesOf(later)).toEqual([]);
  });

  it('waits for triage when the AI is on, but never more than 24 hours after enrollment', async () => {
    const orgId = await seedOrg();
    const campaignId = await seedCampaign(orgId, 'dry_run');
    // crm_records.triage_needed defaults to true, as for a freshly enrolled record.
    const fresh = await seedEnrollment({ orgId, campaignId, recordId: await seedRecord(orgId), enrolledAt: new Date(NOW.getTime() - HOUR) });
    const stale = await seedEnrollment({ orgId, campaignId, recordId: await seedRecord(orgId), enrolledAt: new Date(NOW.getTime() - 25 * HOUR) });
    await planDueEnrollments({ db, now: NOW, log, waitForTriage: true });
    expect(await touchesOf(fresh)).toEqual([]);
    expect(await touchesOf(stale)).toHaveLength(1);

    await pool.query(
      `update crm_records set triage_needed = false where id = (select crm_record_id from campaign_enrollments where id = $1)`,
      [fresh],
    );
    await planDueEnrollments({ db, now: NOW, log, waitForTriage: true });
    expect(await touchesOf(fresh)).toHaveLength(1);
  });

  it('dry_run touches stay planned; promoteQueuedCalls queues only due rep calls of active campaigns', async () => {
    const dry = await dueEnrollment('dry_run');
    const live = await dueEnrollment('active');
    const emailOnly = await dueEnrollment('active', { phones: [], email: 'pat@example.com' });
    await planDueEnrollments({ db, now: NOW, log });
    const future = await seedEnrollment({ orgId: live.orgId, campaignId: live.campaignId, recordId: await seedRecord(live.orgId) });
    await pool.query(
      `insert into touches (org_id, enrollment_id, seq, channel, status, due_at) values ($1, $2, 1, 'rep_call', 'planned', $3)`,
      [live.orgId, future, new Date(NOW.getTime() + HOUR)],
    );

    const promoted = await promoteQueuedCalls(db, NOW);

    expect((await touchesOf(dry.enrollmentId))[0]).toMatchObject({ channel: 'rep_call', status: 'planned' });
    expect((await touchesOf(live.enrollmentId))[0]).toMatchObject({ channel: 'rep_call', status: 'queued' });
    expect((await touchesOf(emailOnly.enrollmentId))[0]).toMatchObject({ channel: 'email', status: 'held' });
    expect((await touchesOf(future))[0]).toMatchObject({ status: 'planned' });
    expect(promoted).toBeGreaterThanOrEqual(1);
  });

  it('a suppression read failure skips the enrollment this tick (fail closed) and the next tick plans it', async () => {
    const { enrollmentId } = await dueEnrollment('dry_run');
    const failing = vi.fn(async () => {
      throw new Error('connection reset');
    });
    log.warn.mockClear();

    await planDueEnrollments({ db, now: NOW, log, blockedTargets: failing });

    expect(failing).toHaveBeenCalled();
    expect(await touchesOf(enrollmentId)).toEqual([]);
    expect((await enrollment(enrollmentId)).status).toBe('active');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ enrollmentId }), expect.stringContaining('fail closed'));

    await planDueEnrollments({ db, now: NOW, log });
    expect(await touchesOf(enrollmentId)).toHaveLength(1);
  });

  it('an opted-out number with no email exits the enrollment with no_allowed_channel', async () => {
    const { orgId, enrollmentId } = await dueEnrollment('dry_run', { email: null });
    await pool.query(`insert into opt_outs (org_id, e164, source) values ($1, $2, 'manual')`, [orgId, CA_MOBILE[0]!.e164]);

    const result = await planDueEnrollments({ db, now: NOW, log });

    expect(result.exited).toBeGreaterThanOrEqual(1);
    expect(await enrollment(enrollmentId)).toMatchObject({ status: 'exited', exit_reason: 'no_allowed_channel' });
    expect(await touchesOf(enrollmentId)).toEqual([]);
  });

  it('a CTI dial in the last 24 hours defers the touch to 24 hours after that dial', async () => {
    const { orgId, enrollmentId } = await dueEnrollment('dry_run');
    const dial = new Date(NOW.getTime() - 3 * HOUR);
    await pool.query(
      `insert into dialer_dial_attempts (org_id, user_id, session_id, item_id, to_number, from_number, dialed_at)
       values ($1, $2, $3, $4, $5, '+14155550199', $6)`,
      [orgId, randomUUID(), randomUUID(), randomUUID(), CA_MOBILE[0]!.e164, dial],
    );

    await planDueEnrollments({ db, now: NOW, log });

    const { rows } = await pool.query(`select due_at, gate_audit from touches where enrollment_id = $1`, [enrollmentId]);
    expect(rows).toHaveLength(1);
    expect((rows[0].due_at as Date).getTime()).toBeGreaterThanOrEqual(dial.getTime() + DAY);
    expect(rows[0].gate_audit).toContainEqual(expect.objectContaining({ rule: 'human_dial', verdict: 'deferred' }));
  });

  it('planTick plans and queues an active campaign rep call in one tick', async () => {
    const { enrollmentId } = await dueEnrollment('active');
    const result = await planTick({ db, now: NOW, log });
    expect(result.planned).toBeGreaterThanOrEqual(1);
    expect((await touchesOf(enrollmentId))[0]).toMatchObject({ channel: 'rep_call', status: 'queued' });
  });

  it('completes an enrollment whose touches are already all done', async () => {
    const orgId = await seedOrg();
    const campaignId = await seedCampaign(orgId, 'dry_run', '{0,1}');
    const recordId = await seedRecord(orgId);
    const enrollmentId = await seedEnrollment({ orgId, campaignId, recordId, touchesDone: 2 });
    await planDueEnrollments({ db, now: NOW, log });
    expect(await enrollment(enrollmentId)).toMatchObject({ status: 'completed', exit_reason: 'sequence_complete' });
  });

  describe('advanceAfterTouch', () => {
    it('schedules the next touch from enrolled_at + touch_days[n], once per touch', async () => {
      const orgId = await seedOrg();
      const campaignId = await seedCampaign(orgId, 'active');
      const recordId = await seedRecord(orgId);
      const enrolledAt = new Date(NOW.getTime() - HOUR);
      const enrollmentId = await seedEnrollment({ orgId, campaignId, recordId, enrolledAt, nextTouchAt: enrolledAt });
      const touch = await one<{ id: string }>(
        `insert into touches (org_id, enrollment_id, seq, channel, status, due_at, sent_at) values ($1, $2, 1, 'rep_call', 'sent', $3, $3) returning id`,
        [orgId, enrollmentId, NOW],
      );

      await advanceAfterTouch(db, touch.id, NOW);
      await advanceAfterTouch(db, touch.id, NOW); // a repeat call is a no-op

      const e = await enrollment(enrollmentId);
      expect(e.touches_done).toBe(1);
      expect(e.status).toBe('active');
      expect(e.next_touch_at).toEqual(new Date(enrolledAt.getTime() + DAY)); // touch_days[1] = 1
    });

    it('never schedules in the past: a late touch is due now', async () => {
      const orgId = await seedOrg();
      const campaignId = await seedCampaign(orgId, 'active');
      const recordId = await seedRecord(orgId);
      const enrolledAt = new Date(NOW.getTime() - 5 * DAY);
      const enrollmentId = await seedEnrollment({ orgId, campaignId, recordId, enrolledAt, touchesDone: 1 });
      const touch = await one<{ id: string }>(
        `insert into touches (org_id, enrollment_id, seq, channel, status, due_at) values ($1, $2, 2, 'rep_call', 'failed', $3) returning id`,
        [orgId, enrollmentId, NOW],
      );
      await advanceAfterTouch(db, touch.id, NOW);
      // touch_days[2] = 3 → enrolled_at + 3 days is already past, so next = now.
      expect(await enrollment(enrollmentId)).toMatchObject({ touches_done: 2, next_touch_at: NOW });
    });

    it('completes the enrollment after the last day', async () => {
      const orgId = await seedOrg();
      const campaignId = await seedCampaign(orgId, 'active', '{0,1}');
      const recordId = await seedRecord(orgId);
      const enrollmentId = await seedEnrollment({ orgId, campaignId, recordId, touchesDone: 1 });
      const touch = await one<{ id: string }>(
        `insert into touches (org_id, enrollment_id, seq, channel, status, due_at) values ($1, $2, 2, 'rep_call', 'skipped', $3) returning id`,
        [orgId, enrollmentId, NOW],
      );
      await advanceAfterTouch(db, touch.id, NOW);
      expect(await enrollment(enrollmentId)).toMatchObject({ status: 'completed', exit_reason: 'sequence_complete', touches_done: 2 });
    });

    it('counts each touch exactly once even when seq has a gap (after a needs-review skip)', async () => {
      const orgId = await seedOrg();
      const campaignId = await seedCampaign(orgId, 'active');
      const recordId = await seedRecord(orgId);
      const enrollmentId = await seedEnrollment({ orgId, campaignId, recordId, touchesDone: 0 });
      // seq 1 was skipped for review without advancing; the resumed enrollment's touch is seq 2.
      const touch = await one<{ id: string }>(
        `insert into touches (org_id, enrollment_id, seq, channel, status, due_at, sent_at) values ($1, $2, 2, 'rep_call', 'sent', $3, $3) returning id`,
        [orgId, enrollmentId, NOW],
      );

      await Promise.all([advanceAfterTouch(db, touch.id, NOW), advanceAfterTouch(db, touch.id, NOW)]);
      await advanceAfterTouch(db, touch.id, NOW);

      expect((await enrollment(enrollmentId)).touches_done).toBe(1);
      const { rows } = await pool.query(`select counted_at from touches where id = $1`, [touch.id]);
      expect(rows[0].counted_at).not.toBeNull();
    });

    it('ignores a touch that is not terminal', async () => {
      const { orgId, enrollmentId } = await dueEnrollment('active');
      const touch = await one<{ id: string }>(
        `insert into touches (org_id, enrollment_id, seq, channel, status, due_at) values ($1, $2, 1, 'rep_call', 'queued', $3) returning id`,
        [orgId, enrollmentId, NOW],
      );
      await advanceAfterTouch(db, touch.id, NOW);
      expect((await enrollment(enrollmentId)).touches_done).toBe(0);
    });
  });

  describe('promoteQueuedCalls re-check', () => {
    async function plannedCall(over: { phones?: unknown[]; dueAt?: Date } = {}) {
      const orgId = await seedOrg();
      const campaignId = await seedCampaign(orgId, 'active');
      const recordId = await seedRecord(orgId, over.phones ? { phones: over.phones } : {});
      const enrollmentId = await seedEnrollment({ orgId, campaignId, recordId });
      const { rows } = await pool.query(
        `insert into touches (org_id, enrollment_id, seq, channel, status, due_at, gate_audit)
         values ($1, $2, 1, 'rep_call', 'planned', $3, $4::jsonb) returning id`,
        [orgId, enrollmentId, over.dueAt ?? new Date(NOW.getTime() - 3 * DAY), JSON.stringify([{ rule: 'rule1_live', channel: 'rep_call', verdict: 'kept', detail: 'First live channel' }])],
      );
      return { orgId, enrollmentId, touchId: rows[0].id as string };
    }
    const touch = async (id: string) => (await pool.query(`select status, due_at, skip_reason, gate_audit from touches where id = $1`, [id])).rows[0];

    it('queues an old planned call that still passes, and records the re-check in the audit', async () => {
      const { touchId } = await plannedCall();
      expect(await promoteQueuedCalls(db, NOW, { log })).toBeGreaterThanOrEqual(1);
      const t = await touch(touchId);
      expect(t.status).toBe('queued');
      expect(t.gate_audit).toHaveLength(2);
      expect(t.gate_audit[1]).toMatchObject({ rule: 'queue_recheck', channel: 'rep_call', verdict: 'kept' });
    });

    it('skips a call whose number was opted out since planning, and counts it', async () => {
      const { orgId, enrollmentId, touchId } = await plannedCall();
      await pool.query(`insert into opt_outs (org_id, e164, source) values ($1, $2, 'manual')`, [orgId, CA_MOBILE[0]!.e164]);
      await promoteQueuedCalls(db, NOW, { log });
      const t = await touch(touchId);
      expect(t).toMatchObject({ status: 'skipped', skip_reason: 'suppressed' });
      expect(t.gate_audit[1]).toMatchObject({ rule: 'queue_recheck', verdict: 'removed' });
      expect((await enrollment(enrollmentId)).touches_done).toBe(1);
    });

    it('skips a call when Salesforce Do Not Call is now set', async () => {
      const { enrollmentId, touchId } = await plannedCall();
      await pool.query(`update crm_records set sf_do_not_call = true where id = (select crm_record_id from campaign_enrollments where id = $1)`, [enrollmentId]);
      await promoteQueuedCalls(db, NOW, { log });
      expect(await touch(touchId)).toMatchObject({ status: 'skipped', skip_reason: 'suppressed' });
    });

    it('leaves the call planned and pushes it 24 hours past a recent CTI dial', async () => {
      const { orgId, touchId } = await plannedCall();
      const dial = new Date(NOW.getTime() - HOUR); // 09:00 PDT: 24 h later is inside the window
      await pool.query(
        `insert into dialer_dial_attempts (org_id, user_id, session_id, item_id, to_number, from_number, dialed_at)
         values ($1, $2, $3, $4, $5, '+14155550199', $6)`,
        [orgId, randomUUID(), randomUUID(), randomUUID(), CA_MOBILE[0]!.e164, dial],
      );
      await promoteQueuedCalls(db, NOW, { log });
      const t = await touch(touchId);
      expect(t.status).toBe('planned');
      expect(new Date(t.due_at)).toEqual(new Date(dial.getTime() + DAY)); // Wed 09:00 PDT, inside the window
      expect(t.gate_audit.map((g: { rule: string }) => g.rule)).toEqual(['rule1_live', 'human_dial', 'queue_recheck']);
      // Not due any more, so the next tick leaves it alone.
      expect(await promoteQueuedCalls(db, NOW, { log })).toBe(0);
      expect((await touch(touchId)).status).toBe('planned');
    });

    it('leaves the call planned until the next 08:00 recipient-local when the window is closed', async () => {
      const { touchId } = await plannedCall();
      const night = new Date('2026-10-07T05:30:00Z'); // Tue 22:30 PDT
      await promoteQueuedCalls(db, night, { log });
      const t = await touch(touchId);
      expect(t.status).toBe('planned');
      expect(new Date(t.due_at)).toEqual(new Date('2026-10-07T15:00:00Z'));
      expect(t.gate_audit[t.gate_audit.length - 1]).toMatchObject({ rule: 'queue_recheck', verdict: 'deferred' });
    });

    it('fails closed when the suppression read throws: the touch stays planned', async () => {
      const { touchId } = await plannedCall();
      const failing = vi.fn(async () => {
        throw new Error('connection reset');
      });
      expect(await promoteQueuedCalls(db, NOW, { log, blockedTargets: failing })).toBe(0);
      expect((await touch(touchId)).status).toBe('planned');
    });
  });

  it('a touch skipped for review does not block the next plan after the enrollment resumes', async () => {
    const { orgId, enrollmentId } = await dueEnrollment('dry_run');
    await pool.query(
      `insert into touches (org_id, enrollment_id, seq, channel, status, due_at, skip_reason) values ($1, $2, 1, 'rep_call', 'skipped', $3, 'needs_review')`,
      [orgId, enrollmentId, NOW],
    );
    await planDueEnrollments({ db, now: NOW, log });
    expect((await touchesOf(enrollmentId)).map((x) => `${x.seq}:${x.status}`)).toEqual(['1:skipped', '2:planned']);
  });
});
