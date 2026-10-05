import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TriageResult } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { createTestDb, pgLane } from '../test/pg.js';
import { leadId, seedCampaign, seedEnrollment, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { holdIfFlagged, pendingDncFlag } from './dnc-hold.js';

const NOW = new Date('2026-10-05T15:00:00.000Z');
const MIN = 60_000;
const PLAIN: TriageResult = { summary: 'Prefers texts.', channels: [{ channel: 'sms', reason: 'texts' }], timing: null, tags: [], doNotContact: null };
const flagged = (quote: string): TriageResult => ({ ...PLAIN, channels: [], doNotContact: { category: 'attorney', quote } });

describe.skipIf(!pgLane)('do-not-contact holds (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function setup() {
    const orgId = await seedOrg(db);
    const campaign = await seedCampaign(db, orgId, { status: 'active' });
    const recordId = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(1) }));
    const enrollmentId = await seedEnrollment(db, orgId, campaign.id, recordId, { nextTouchAt: NOW });
    return { orgId, campaignId: campaign.id, recordId, enrollmentId };
  }

  async function triage(orgId: string, recordId: string, result: unknown, at: Date): Promise<string> {
    const [row] = await db
      .insert(schema.recordTriage)
      .values({ orgId, crmRecordId: recordId, notesHash: `h${at.getTime()}`, model: 'm', result, inputTokens: 1, outputTokens: 1, createdAt: at })
      .returning({ id: schema.recordTriage.id });
    return row!.id;
  }

  async function dismissed(recordId: string, triageId: string | null): Promise<void> {
    await db.update(schema.crmRecords).set({ dncDismissedTriageId: triageId }).where(eq(schema.crmRecords.id, recordId));
  }

  describe('pendingDncFlag', () => {
    it('is null with no triage, or when no triage flagged do-not-contact', async () => {
      const t = await setup();
      expect(await pendingDncFlag(db, t.recordId)).toBeNull();
      await triage(t.orgId, t.recordId, PLAIN, new Date(NOW.getTime() - MIN));
      expect(await pendingDncFlag(db, t.recordId)).toBeNull();
    });

    it('returns the newest flag that nobody dismissed', async () => {
      const t = await setup();
      await triage(t.orgId, t.recordId, flagged('older'), new Date(NOW.getTime() - 2 * MIN));
      const newest = await triage(t.orgId, t.recordId, flagged('Talk to my lawyer'), new Date(NOW.getTime() - MIN));
      expect(await pendingDncFlag(db, t.recordId)).toEqual({ triageId: newest, category: 'attorney', quote: 'Talk to my lawyer' });
    });

    it('a dismissed flag no longer holds; a newer flag holds again', async () => {
      const t = await setup();
      const first = await triage(t.orgId, t.recordId, flagged('first'), new Date(NOW.getTime() - 3 * MIN));
      await dismissed(t.recordId, first);
      expect(await pendingDncFlag(db, t.recordId)).toBeNull();
      const second = await triage(t.orgId, t.recordId, flagged('second'), new Date(NOW.getTime() - MIN));
      expect(await pendingDncFlag(db, t.recordId)).toMatchObject({ triageId: second, quote: 'second' });
    });

    it('fails safe: an undismissed flag holds even when a later triage did not flag', async () => {
      const t = await setup();
      const flag = await triage(t.orgId, t.recordId, flagged('sold it'), new Date(NOW.getTime() - 2 * MIN));
      await triage(t.orgId, t.recordId, PLAIN, new Date(NOW.getTime() - MIN));
      expect(await pendingDncFlag(db, t.recordId)).toMatchObject({ triageId: flag });
    });

    it('fails safe: a dismissal pointing at a missing triage counts as no dismissal', async () => {
      const t = await setup();
      const flag = await triage(t.orgId, t.recordId, flagged('sold it'), new Date(NOW.getTime() - MIN));
      await dismissed(t.recordId, '00000000-0000-4000-8000-000000000000');
      expect(await pendingDncFlag(db, t.recordId)).toMatchObject({ triageId: flag });
    });

    it('fails safe: a stored flag that does not validate still holds, as category other', async () => {
      const t = await setup();
      const flag = await triage(t.orgId, t.recordId, { ...PLAIN, doNotContact: { category: 'nonsense' } }, new Date(NOW.getTime() - MIN));
      expect(await pendingDncFlag(db, t.recordId)).toEqual({ triageId: flag, category: 'other', quote: '' });
    });
  });

  describe('holdIfFlagged', () => {
    it('does nothing and returns false when there is no pending flag', async () => {
      const t = await setup();
      expect(await holdIfFlagged(db, { enrollmentId: t.enrollmentId, crmRecordId: t.recordId, now: NOW })).toBe(false);
      const [row] = await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, t.enrollmentId));
      expect(row).toMatchObject({ status: 'active' });
    });

    it('moves the enrollment to needs_review with the flag, and skips its unstarted touches', async () => {
      const t = await setup();
      const flag = await triage(t.orgId, t.recordId, flagged('Talk to my lawyer'), new Date(NOW.getTime() - MIN));
      await db.insert(schema.touches).values([
        { orgId: t.orgId, enrollmentId: t.enrollmentId, seq: 1, channel: 'rep_call', status: 'sent', dueAt: NOW },
        { orgId: t.orgId, enrollmentId: t.enrollmentId, seq: 2, channel: 'rep_call', status: 'planned', dueAt: NOW },
      ]);
      expect(await holdIfFlagged(db, { enrollmentId: t.enrollmentId, crmRecordId: t.recordId, now: NOW })).toBe(true);
      const [row] = await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, t.enrollmentId));
      expect(row).toMatchObject({ status: 'needs_review', reviewCategory: 'attorney', reviewQuote: 'Talk to my lawyer', reviewTriageId: flag, nextTouchAt: null });
      expect(row!.flaggedAt?.toISOString()).toBe(NOW.toISOString());
      const touches = await db.select().from(schema.touches).where(eq(schema.touches.enrollmentId, t.enrollmentId)).orderBy(schema.touches.seq);
      expect(touches.map((x) => [x.status, x.skipReason])).toEqual([
        ['sent', null],
        ['skipped', 'needs_review'],
      ]);
    });

    it('returns true (do not plan) even when the enrollment is no longer active', async () => {
      const t = await setup();
      await triage(t.orgId, t.recordId, flagged('sold it'), new Date(NOW.getTime() - MIN));
      await db.update(schema.campaignEnrollments).set({ status: 'exited' }).where(eq(schema.campaignEnrollments.id, t.enrollmentId));
      expect(await holdIfFlagged(db, { enrollmentId: t.enrollmentId, crmRecordId: t.recordId, now: NOW })).toBe(true);
      const [row] = await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, t.enrollmentId));
      expect(row).toMatchObject({ status: 'exited', reviewCategory: null });
    });
  });
});
