/** Real Postgres: the plan board's cards, counts, paging and who may decide. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { seedConnection } from '../test/outreach-fixtures.js';
import { ctxOf, seedAiCallCampaign, seedPlanLead, seedUser, SEED_NOW } from '../test/call-plan-seed.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { CARD_PAGE_SIZE, decodeCardCursor, encodeCardCursor, loadCallPlanCard, loadCallPlanCards } from './cards.js';

const T = (minutes: number) => new Date(SEED_NOW.getTime() - minutes * 60_000);
const OWNER = '005000000000001AAA';

describe('cursor', () => {
  it('round-trips and rejects junk', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(decodeCardCursor(encodeCardCursor('2026-10-05T19:00:00.123456Z', id))).toEqual({ at: '2026-10-05T19:00:00.123456Z', id });
    expect(decodeCardCursor('!!')).toBeNull();
    expect(decodeCardCursor(null)).toBeNull();
    expect(decodeCardCursor(Buffer.from('not-a-date|x').toString('base64url'))).toBeNull();
  });
});

describe.skipIf(!pgLane)('call plan cards (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function board() {
    const base = await seedAiCallCampaign(db);
    await seedConnection(db, base.orgId);
    const admin = await seedUser(db, base.orgId);
    return { ...base, admin, ctx: ctxOf(base.orgId, admin, true) };
  }
  const opts = { cursor: null, stage: null, now: SEED_NOW };

  it('1: lists the active enrollments oldest first with counts per stage; the exited one is absent', async () => {
    const b = await board();
    const research = await seedPlanLead(db, b, { callStage: 'research', planStatus: null, enrolledAt: T(50) });
    const r1 = await seedPlanLead(db, b, { callStage: 'review', enrolledAt: T(40) });
    const r2 = await seedPlanLead(db, b, { callStage: 'review', enrolledAt: T(30) });
    const approved = await seedPlanLead(db, b, { callStage: 'approved', planStatus: 'approved', enrolledAt: T(20) });
    const queued = await seedPlanLead(db, b, { callStage: 'queued', planStatus: 'approved', enrolledAt: T(10) });
    await seedPlanLead(db, b, { callStage: 'done', status: 'exited', enrolledAt: T(5) });

    const res = await loadCallPlanCards(db, b.ctx, b.campaignId, opts);

    expect(res.cards.map((c) => c.enrollmentId)).toEqual([research, r1, r2, approved, queued].map((l) => l.enrollmentId));
    expect(res.counts).toEqual({ research: 1, review: 2, approved: 1, queued: 1, done: 0 });
    expect(res.nextCursor).toBeNull();
  });

  it('2: a card carries the record link, source summaries, the plan without doNotContact, the consent and the gate warnings', async () => {
    const b = await board();
    const lead = await seedPlanLead(db, b, { callStage: 'review', phones: [{ field: 'MobilePhone', e164: '+15125550142' }], recordOver: { sfDoNotCall: true } });
    await db.insert(schema.optOuts).values({ orgId: b.orgId, e164: '+15125550142', source: 'test' });

    const [card] = (await loadCallPlanCards(db, b.ctx, b.campaignId, opts)).cards;

    expect(card).toMatchObject({
      enrollmentId: lead.enrollmentId,
      sfObject: 'Lead',
      recordUrl: `https://example.my.salesforce.com/${lead.sfRecordId}`,
      name: 'Pat Seller',
      ownerName: 'Rep One',
      callStage: 'review',
      consent: 'yes',
      prepareError: null,
    });
    expect(card!.research!.version).toBe(1);
    expect(card!.research!.sources).toHaveLength(9);
    expect(card!.plan).toMatchObject({ version: 1, status: 'proposed', source: 'model', decidedAt: null, dncFlagDismissed: false });
    expect(card!.plan!.plan).not.toHaveProperty('doNotContact');
    expect(card!.warnings.map((w) => `${w.code}:${w.severity}`)).toEqual(['opted_out:block', 'sf_do_not_call:block']);
  });

  it('3: an admin may decide on everything; a rep only on records they own in Salesforce', async () => {
    const b = await board();
    await seedPlanLead(db, b, { ownerSfUserId: OWNER });
    await seedPlanLead(db, b, { ownerSfUserId: '005000000000099AAA' });
    const rep = await seedUser(db, b.orgId, { sfUserId: '005000000000001' });

    const asAdmin = await loadCallPlanCards(db, b.ctx, b.campaignId, opts);
    const asRep = await loadCallPlanCards(db, ctxOf(b.orgId, rep, false), b.campaignId, opts);

    expect(asAdmin.cards.map((c) => c.mayDecide)).toEqual([true, true]);
    expect(asRep.cards.map((c) => c.mayDecide)).toEqual([true, false]);
  });

  it('4: stage filters to that stage, but the counts still cover the campaign', async () => {
    const b = await board();
    await seedPlanLead(db, b, { callStage: 'review' });
    const approved = await seedPlanLead(db, b, { callStage: 'approved', planStatus: 'approved' });
    const res = await loadCallPlanCards(db, b.ctx, b.campaignId, { ...opts, stage: 'approved' });
    expect(res.cards.map((c) => c.enrollmentId)).toEqual([approved.enrollmentId]);
    expect(res.counts.review).toBe(1);
  });

  it('5: 30 enrollments page as 25 and 5', async () => {
    const b = await board();
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) ids.push((await seedPlanLead(db, b, { enrolledAt: T(100 - i) })).enrollmentId);
    const first = await loadCallPlanCards(db, b.ctx, b.campaignId, opts);
    expect(CARD_PAGE_SIZE).toBe(25);
    expect(first.cards).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = await loadCallPlanCards(db, b.ctx, b.campaignId, { ...opts, cursor: first.nextCursor });
    expect(second.cards).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect([...first.cards, ...second.cards].map((c) => c.enrollmentId)).toEqual(ids);
  });

  it('6: no Salesforce connection row: recordUrl is null, the cards still come back', async () => {
    const base = await seedAiCallCampaign(db);
    const admin = await seedUser(db, base.orgId);
    await seedPlanLead(db, base);
    const res = await loadCallPlanCards(db, ctxOf(base.orgId, admin, true), base.campaignId, opts);
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]!.recordUrl).toBeNull();
  });

  it("7: another tenant's campaign id gives no cards", async () => {
    const b = await board();
    await seedPlanLead(db, b);
    const other = await board();
    const res = await loadCallPlanCards(db, other.ctx, b.campaignId, opts);
    expect(res.cards).toEqual([]);
    expect(Object.values(res.counts).every((n) => n === 0)).toBe(true);
    expect(await loadCallPlanCard(db, other.ctx, (await seedPlanLead(db, b)).enrollmentId, SEED_NOW)).toBeNull();
  });

  it("8 (CF-6): the research on a card is the current plan's research, not the newest research", async () => {
    const b = await board();
    const lead = await seedPlanLead(db, b, { consent: 'yes' });
    // A newer research row that no current plan points at (for example one that was superseded or is mid-way): it must not leak in.
    await db.execute(sql`
      insert into call_research (org_id, enrollment_id, crm_record_id, version, snapshot, size_chars, content_hash)
      select org_id, enrollment_id, crm_record_id, 2, jsonb_set(snapshot, '{consent}', '"no"'), size_chars, 'other' from call_research where id = ${lead.researchId}::uuid`);
    const card = await loadCallPlanCard(db, b.ctx, lead.enrollmentId, SEED_NOW);
    expect(card!.research!.version).toBe(1);
    expect(card!.consent).toBe('yes');
    expect(card!.warnings).toEqual([]);
  });

  it("9 (CF-5): consent that could not be read is shown as such, never as consent; a card with no research has no consent", async () => {
    const b = await board();
    const unknown = await seedPlanLead(db, b, { consent: 'unknown' });
    const fresh = await seedPlanLead(db, b, { callStage: 'research', planStatus: null });
    const a = await loadCallPlanCard(db, b.ctx, unknown.enrollmentId, SEED_NOW);
    expect(a!.consent).toBe('unknown');
    expect(a!.warnings.map((w) => `${w.code}:${w.severity}`)).toEqual(['consent_unknown:block']);
    expect(a!.warnings[0]!.words).toContain('consent could not be read — research again');
    const f = await loadCallPlanCard(db, b.ctx, fresh.enrollmentId, SEED_NOW);
    expect(f).toMatchObject({ consent: null, research: null, plan: null });
  });

  describe('do-not-contact (CF-7, CF-10)', () => {
    const flagTriage = (orgId: string, recordId: string) =>
      db.execute(sql`
        insert into record_triage (org_id, crm_record_id, notes_hash, model, result, input_tokens, output_tokens)
        values (${orgId}::uuid, ${recordId}::uuid, 'h', 'm', ${JSON.stringify({ summary: 's', channels: [], timing: null, tags: [], doNotContact: { category: 'attorney', quote: 'Talk to my lawyer' } })}::jsonb, 1, 1)
        returning id`).then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows[0]!.id);

    it('a flagged plan whose flag a person dismissed shows who and when', async () => {
      const b = await board();
      const lead = await seedPlanLead(db, b, { dncFlagged: true });
      const triageId = await flagTriage(b.orgId, lead.crmRecordId);
      const dismisser = await seedUser(db, b.orgId, { displayName: 'Rita Rep' });
      await db.execute(sql`update crm_records set dnc_dismissed_triage_id = ${triageId}::uuid where id = ${lead.crmRecordId}::uuid`);
      await db.execute(sql`update call_plans set dnc_dismissed_by = ${dismisser}::uuid, dnc_dismissed_at = ${SEED_NOW.toISOString()}::timestamptz where id = ${lead.planId}::uuid`);

      const card = await loadCallPlanCard(db, b.ctx, lead.enrollmentId, SEED_NOW);

      expect(card!.plan).toMatchObject({ status: 'proposed', decidedAt: null, dncFlagDismissed: true, dncFlagDismissedBy: 'Rita Rep', dncFlagDismissedAt: SEED_NOW.toISOString() });
      expect(card!.warnings).toEqual([]);
    });

    it('an approved plan keeps the dismisser, apart from who approved it and when', async () => {
      const b = await board();
      const lead = await seedPlanLead(db, b, { dncFlagged: true, callStage: 'approved', planStatus: 'approved' });
      const triageId = await flagTriage(b.orgId, lead.crmRecordId);
      const dismisser = await seedUser(db, b.orgId, { displayName: 'Rita Rep' });
      const approver = await seedUser(db, b.orgId, { displayName: 'Sam Approver' });
      const approvedAt = new Date(SEED_NOW.getTime() + 3_600_000);
      await db.execute(sql`update crm_records set dnc_dismissed_triage_id = ${triageId}::uuid where id = ${lead.crmRecordId}::uuid`);
      await db.execute(sql`update call_plans set dnc_dismissed_by = ${dismisser}::uuid, dnc_dismissed_at = ${SEED_NOW.toISOString()}::timestamptz,
        decided_by = ${approver}::uuid, decided_at = ${approvedAt.toISOString()}::timestamptz where id = ${lead.planId}::uuid`);

      const card = await loadCallPlanCard(db, b.ctx, lead.enrollmentId, SEED_NOW);

      expect(card!.plan).toMatchObject({ status: 'approved', decidedAt: approvedAt.toISOString(), dncFlagDismissed: true, dncFlagDismissedBy: 'Rita Rep', dncFlagDismissedAt: SEED_NOW.toISOString() });
    });

    it("a person's dismissal of some other flag on the record is not this plan's dismissal (the plan's own columns decide)", async () => {
      const b = await board();
      const lead = await seedPlanLead(db, b, { dncFlagged: true });
      const triageId = await flagTriage(b.orgId, lead.crmRecordId);
      const other = await seedUser(db, b.orgId, { displayName: 'Not The Dismisser' });
      await db.execute(sql`update crm_records set dnc_dismissed_triage_id = ${triageId}::uuid where id = ${lead.crmRecordId}::uuid`);
      await db.execute(sql`update call_plans set decided_by = ${other}::uuid, decided_at = ${SEED_NOW.toISOString()}::timestamptz where id = ${lead.planId}::uuid`);
      const card = await loadCallPlanCard(db, b.ctx, lead.enrollmentId, SEED_NOW);
      expect(card!.plan).toMatchObject({ dncFlagDismissed: false, dncFlagDismissedBy: null, dncFlagDismissedAt: null });
      expect(card!.warnings.map((w) => `${w.code}:${w.severity}`)).toEqual(['dnc_not_dismissed:block']);
    });

    it('a flagged plan nobody dismissed blocks approval on the card', async () => {
      const b = await board();
      const lead = await seedPlanLead(db, b, { dncFlagged: true });
      const card = await loadCallPlanCard(db, b.ctx, lead.enrollmentId, SEED_NOW);
      expect(card!.plan!.dncFlagDismissed).toBe(false);
      expect(card!.warnings.map((w) => `${w.code}:${w.severity}`)).toEqual(['dnc_not_dismissed:block']);
    });

    it('a held enrollment (needs_review) shows the pending flag as blocking', async () => {
      const b = await board();
      const lead = await seedPlanLead(db, b, { dncFlagged: true, status: 'needs_review' });
      await flagTriage(b.orgId, lead.crmRecordId);
      const card = await loadCallPlanCard(db, b.ctx, lead.enrollmentId, SEED_NOW);
      expect(card!.enrollmentStatus).toBe('needs_review');
      expect(card!.warnings.map((w) => w.code)).toContain('dnc_pending');
      expect(card!.plan!.dncFlagDismissed).toBe(false);
    });
  });
});
