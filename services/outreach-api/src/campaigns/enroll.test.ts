import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { createTestDb, pgLane } from '../test/pg.js';
import { enrollmentsOf, leadId, seedCampaign, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { enrollRecords, exitEnrollment, upsertRecords } from './enroll.js';

const NOW = new Date('2026-10-05T15:00:00.000Z');
const TOUCH_DAYS = [0, 1, 3, 6, 10, 14];

describe.skipIf(!pgLane)('enrollment (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  });
  afterAll(async () => {
    await drop?.();
  });

  async function recordRow(orgId: string, sfRecordId: string) {
    const [row] = await db
      .select()
      .from(schema.crmRecords)
      .where(and(eq(schema.crmRecords.orgId, orgId), eq(schema.crmRecords.sfRecordId, sfRecordId)));
    return row!;
  }

  async function activeKeys(orgId: string) {
    return db
      .select()
      .from(schema.enrollmentContactKeys)
      .where(and(eq(schema.enrollmentContactKeys.orgId, orgId), eq(schema.enrollmentContactKeys.active, true)));
  }

  describe('upsertRecords', () => {
    it('inserts new records as changed and needing triage', async () => {
      const orgId = await seedOrg(db);
      const out = await upsertRecords(db, orgId, [snapshot({ sfRecordId: leadId(1) }), snapshot({ sfRecordId: leadId(2), email: 'a@b.co' })]);
      expect(out.get(leadId(1))).toEqual({ id: expect.any(String), changed: true });
      expect(out.get(leadId(2))?.changed).toBe(true);
      const row = await recordRow(orgId, leadId(2));
      expect(row.triageNeeded).toBe(true);
      expect(row.email).toBe('a@b.co');
      expect(row.phones).toEqual([{ field: 'MobilePhone', e164: '+15125550100' }]);
    });

    it('reports unchanged when LastModifiedDate did not move, and keeps triage_needed as it was', async () => {
      const orgId = await seedOrg(db);
      const first = await upsertRecords(db, orgId, [snapshot({ sfRecordId: leadId(1) })]);
      await db.update(schema.crmRecords).set({ triageNeeded: false }).where(eq(schema.crmRecords.id, first.get(leadId(1))!.id));
      const again = await upsertRecords(db, orgId, [snapshot({ sfRecordId: leadId(1), name: 'Renamed' })]);
      expect(again.get(leadId(1))).toEqual({ id: first.get(leadId(1))!.id, changed: false });
      const row = await recordRow(orgId, leadId(1));
      expect(row.triageNeeded).toBe(false);
      expect(row.name).toBe('Renamed');
    });

    it('marks a record changed and needing triage when LastModifiedDate moved', async () => {
      const orgId = await seedOrg(db);
      const first = await upsertRecords(db, orgId, [snapshot({ sfRecordId: leadId(1) })]);
      await db.update(schema.crmRecords).set({ triageNeeded: false }).where(eq(schema.crmRecords.id, first.get(leadId(1))!.id));
      const moved = await upsertRecords(db, orgId, [snapshot({ sfRecordId: leadId(1), lastModifiedAt: new Date('2026-10-04T09:30:00.000Z') })]);
      expect(moved.get(leadId(1))?.changed).toBe(true);
      expect((await recordRow(orgId, leadId(1))).triageNeeded).toBe(true);
    });

    it('never clears a consent that is already true, and records a new one', async () => {
      const orgId = await seedOrg(db);
      await upsertRecords(db, orgId, [snapshot({ sfRecordId: leadId(1), consentAiCall: true }), snapshot({ sfRecordId: leadId(2) })]);
      await upsertRecords(db, orgId, [snapshot({ sfRecordId: leadId(1), consentAiCall: false }), snapshot({ sfRecordId: leadId(2), consentAiCall: true })]);
      expect((await recordRow(orgId, leadId(1))).consentAiCall).toBe(true);
      expect((await recordRow(orgId, leadId(2))).consentAiCall).toBe(true);
    });

    it('accepts the same Id twice in one call (last snapshot wins)', async () => {
      const orgId = await seedOrg(db);
      await upsertRecords(db, orgId, [snapshot({ sfRecordId: leadId(1), name: 'First' }), snapshot({ sfRecordId: leadId(1), name: 'Second' })]);
      expect((await recordRow(orgId, leadId(1))).name).toBe('Second');
    });
  });

  describe('enrollRecords', () => {
    it('enrolls with next_touch_at = now + touchDays[0] days and stores every key active', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const recordId = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(1) }));
      const out = await enrollRecords(db, { orgId, campaignId: campaign.id, touchDays: [2, 5], now: NOW, records: [{ crmRecordId: recordId, keys: ['+15125550100', 'pat@example.com', '+15125550100'] }] });
      expect(out).toEqual({ enrolled: 1, skippedInOtherCampaign: 0, skippedNoKeys: 0 });
      const [enrollment] = await enrollmentsOf(db, campaign.id);
      expect(enrollment).toMatchObject({ status: 'active', crmRecordId: recordId, touchesDone: 0 });
      expect(enrollment!.nextTouchAt?.toISOString()).toBe('2026-10-07T15:00:00.000Z');
      expect(enrollment!.enrolledAt.toISOString()).toBe(NOW.toISOString());
      expect((await activeKeys(orgId)).map((k) => k.key).sort()).toEqual(['+15125550100', 'pat@example.com']);
    });

    it('skips a record with no contact keys instead of enrolling it', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const keyless = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(1), phones: [] }));
      const keyed = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(2) }));
      const out = await enrollRecords(db, {
        orgId,
        campaignId: campaign.id,
        touchDays: TOUCH_DAYS,
        now: NOW,
        records: [{ crmRecordId: keyless, keys: [] }, { crmRecordId: keyed, keys: ['+15125550100'] }],
      });
      expect(out).toEqual({ enrolled: 1, skippedInOtherCampaign: 0, skippedNoKeys: 1 });
      expect((await enrollmentsOf(db, campaign.id)).map((e) => e.crmRecordId)).toEqual([keyed]);
    });

    it('leaves a record already enrolled in the same campaign alone', async () => {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const recordId = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(1) }));
      const input = { orgId, campaignId: campaign.id, touchDays: TOUCH_DAYS, now: NOW, records: [{ crmRecordId: recordId, keys: ['+15125550100'] }] };
      await enrollRecords(db, input);
      expect(await enrollRecords(db, input)).toEqual({ enrolled: 0, skippedInOtherCampaign: 0, skippedNoKeys: 0 });
      expect(await enrollmentsOf(db, campaign.id)).toHaveLength(1);
    });

    it('skips a person whose phone is held by an active enrollment in another campaign', async () => {
      const orgId = await seedOrg(db);
      const a = await seedCampaign(db, orgId, { name: 'A' });
      const b = await seedCampaign(db, orgId, { name: 'B' });
      const x = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(1) }));
      const y = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(2), email: 'pat@example.com' }));
      await enrollRecords(db, { orgId, campaignId: a.id, touchDays: TOUCH_DAYS, now: NOW, records: [{ crmRecordId: x, keys: ['+15125550100'] }] });
      const out = await enrollRecords(db, { orgId, campaignId: b.id, touchDays: TOUCH_DAYS, now: NOW, records: [{ crmRecordId: y, keys: ['+15125550100', 'pat@example.com'] }] });
      expect(out).toEqual({ enrolled: 0, skippedInOtherCampaign: 1, skippedNoKeys: 0 });
      expect(await enrollmentsOf(db, b.id)).toEqual([]);
      expect((await activeKeys(orgId)).map((k) => k.key)).toEqual(['+15125550100']);
    });

    it('lets the person join another campaign once the first enrollment exits', async () => {
      const orgId = await seedOrg(db);
      const a = await seedCampaign(db, orgId, { name: 'A' });
      const b = await seedCampaign(db, orgId, { name: 'B' });
      const x = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(1) }));
      await enrollRecords(db, { orgId, campaignId: a.id, touchDays: TOUCH_DAYS, now: NOW, records: [{ crmRecordId: x, keys: ['+15125550100'] }] });
      const [first] = await enrollmentsOf(db, a.id);
      await exitEnrollment(db, first!.id, 'left_query');
      const out = await enrollRecords(db, { orgId, campaignId: b.id, touchDays: TOUCH_DAYS, now: NOW, records: [{ crmRecordId: x, keys: ['+15125550100'] }] });
      expect(out).toEqual({ enrolled: 1, skippedInOtherCampaign: 0, skippedNoKeys: 0 });
    });

    it('keeps the same phone in two different tenants independent', async () => {
      const orgA = await seedOrg(db);
      const orgB = await seedOrg(db);
      const ca = await seedCampaign(db, orgA);
      const cb = await seedCampaign(db, orgB);
      const ra = await seedRecord(db, orgA, snapshot({ sfRecordId: leadId(1) }));
      const rb = await seedRecord(db, orgB, snapshot({ sfRecordId: leadId(1) }));
      await enrollRecords(db, { orgId: orgA, campaignId: ca.id, touchDays: TOUCH_DAYS, now: NOW, records: [{ crmRecordId: ra, keys: ['+15125550100'] }] });
      const out = await enrollRecords(db, { orgId: orgB, campaignId: cb.id, touchDays: TOUCH_DAYS, now: NOW, records: [{ crmRecordId: rb, keys: ['+15125550100'] }] });
      expect(out.enrolled).toBe(1);
    });

    it('race: two campaigns enrolling the same people at once leave exactly one enrollment per person', async () => {
      const orgId = await seedOrg(db);
      const a = await seedCampaign(db, orgId, { name: 'A' });
      const b = await seedCampaign(db, orgId, { name: 'B' });
      const people = 12;
      const inA: Array<{ crmRecordId: string; keys: string[] }> = [];
      const inB: Array<{ crmRecordId: string; keys: string[] }> = [];
      for (let i = 0; i < people; i++) {
        const phone = `+1512555${String(1000 + i)}`;
        // Two different Salesforce records (a duplicate Lead) for one person, one per campaign.
        inA.push({ crmRecordId: await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(100 + i), phones: [{ field: 'MobilePhone', e164: phone }] })), keys: [phone] });
        inB.push({ crmRecordId: await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(200 + i), phones: [{ field: 'Phone', e164: phone }] })), keys: [phone, `person${i}@example.com`] });
      }
      const [ra, rb] = await Promise.all([
        enrollRecords(db, { orgId, campaignId: a.id, touchDays: TOUCH_DAYS, now: NOW, records: inA }),
        enrollRecords(db, { orgId, campaignId: b.id, touchDays: TOUCH_DAYS, now: NOW, records: inB }),
      ]);
      expect(ra.enrolled + rb.enrolled).toBe(people);
      expect(ra.skippedInOtherCampaign + rb.skippedInOtherCampaign).toBe(people);
      const all = [...(await enrollmentsOf(db, a.id)), ...(await enrollmentsOf(db, b.id))];
      expect(all).toHaveLength(people);
      const keys = await activeKeys(orgId);
      for (let i = 0; i < people; i++) {
        expect(keys.filter((k) => k.key === `+1512555${String(1000 + i)}`)).toHaveLength(1);
      }
      // Every surviving enrollment kept all of its keys (no half-written enrollments).
      const keysByEnrollment = new Map<string, number>();
      for (const k of keys) keysByEnrollment.set(k.enrollmentId, (keysByEnrollment.get(k.enrollmentId) ?? 0) + 1);
      for (const e of all) expect(keysByEnrollment.get(e.id)).toBe(e.campaignId === a.id ? 1 : 2);
    });
  });

  describe('exitEnrollment', () => {
    async function enrolledWithTouches() {
      const orgId = await seedOrg(db);
      const campaign = await seedCampaign(db, orgId);
      const recordId = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(1) }));
      await enrollRecords(db, { orgId, campaignId: campaign.id, touchDays: TOUCH_DAYS, now: NOW, records: [{ crmRecordId: recordId, keys: ['+15125550100'] }] });
      const [enrollment] = await enrollmentsOf(db, campaign.id);
      const statuses = ['planned', 'held', 'queued', 'dialing', 'sent'] as const;
      await db.insert(schema.touches).values(
        statuses.map((status, i) => ({ orgId, enrollmentId: enrollment!.id, seq: i + 1, channel: 'rep_call' as const, status, dueAt: NOW })),
      );
      return { orgId, enrollmentId: enrollment!.id };
    }

    async function touchStatuses(enrollmentId: string) {
      const rows = await db.select().from(schema.touches).where(eq(schema.touches.enrollmentId, enrollmentId)).orderBy(schema.touches.seq);
      return rows.map((t) => [t.status, t.skipReason]);
    }

    it('exits, frees the keys, and skips the touches that have not started', async () => {
      const { orgId, enrollmentId } = await enrolledWithTouches();
      await exitEnrollment(db, enrollmentId, 'left_query');
      const [row] = await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, enrollmentId));
      expect(row).toMatchObject({ status: 'exited', exitReason: 'left_query', nextTouchAt: null });
      expect(await activeKeys(orgId)).toEqual([]);
      expect(await touchStatuses(enrollmentId)).toEqual([
        ['skipped', 'left_query'],
        ['skipped', 'left_query'],
        ['skipped', 'left_query'],
        ['dialing', null],
        ['sent', null],
      ]);
    });

    it('joins a caller transaction and rolls back with it', async () => {
      const { orgId, enrollmentId } = await enrolledWithTouches();
      await expect(
        db.transaction(async (tx) => {
          await exitEnrollment(tx, enrollmentId, 'do_not_contact_confirmed');
          throw new Error('caller aborts');
        }),
      ).rejects.toThrow('caller aborts');
      const [row] = await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, enrollmentId));
      expect(row).toMatchObject({ status: 'active', exitReason: null });
      expect(await activeKeys(orgId)).toHaveLength(1);
    });

    it('can complete instead of exit, and never rewrites a finished enrollment', async () => {
      const { enrollmentId } = await enrolledWithTouches();
      await exitEnrollment(db, enrollmentId, 'sequence_complete', 'completed');
      await exitEnrollment(db, enrollmentId, 'left_query');
      const [row] = await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, enrollmentId));
      expect(row).toMatchObject({ status: 'completed', exitReason: 'sequence_complete' });
    });
  });
});
