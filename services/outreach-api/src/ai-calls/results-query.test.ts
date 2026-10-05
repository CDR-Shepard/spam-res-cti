/** Real Postgres: the AI call results table and the transcript. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { AiCallResultsResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { seedAiCall, seedReleasedLead } from '../test/ai-call-seed.js';
import { ctxOf, seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { seedConnection } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { listAiCallResults, loadTranscript, RESULTS_PAGE_SIZE, transcriptLines } from './results-query.js';

const OWNER = '005000000000001AAA';

describe('transcriptLines', () => {
  it('keeps well-formed lines in order and drops the rest', () => {
    expect(
      transcriptLines([
        { role: 'agent', text: 'Hi, I am an AI assistant.', at: '2026-10-05T23:00:01.000Z' },
        { role: 'caller', text: 'Who is this?' },
        { role: 'robot', text: 'x', at: null },
        { role: 'agent', text: 42 },
        'garbage',
        null,
        { role: 'system', text: 'Call ended', at: '2026-10-05T23:02:00.000Z' },
      ]),
    ).toEqual([
      { role: 'agent', text: 'Hi, I am an AI assistant.', at: '2026-10-05T23:00:01.000Z' },
      { role: 'caller', text: 'Who is this?', at: null },
      { role: 'system', text: 'Call ended', at: '2026-10-05T23:02:00.000Z' },
    ]);
    expect(transcriptLines({ not: 'an array' })).toEqual([]);
  });
});

describe.skipIf(!pgLane)('AI call results queries (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function setup() {
    const base = await seedAiCallCampaign(db, 'active');
    await seedConnection(db, base.orgId);
    const admin = await seedUser(db, base.orgId);
    const owner = await seedUser(db, base.orgId, { sfUserId: OWNER });
    const rep = await seedUser(db, base.orgId, { sfUserId: '005000000000002AAA' });
    return { base, admin, owner, rep };
  }
  const touchSet = (id: string, set: Partial<typeof schema.touches.$inferInsert>) => db.update(schema.touches).set(set).where(eq(schema.touches.id, id));

  it('lists the campaign\'s AI call touches newest first with the call, the record and the exit; planned and failed ones too', async () => {
    const s = await setup();
    const placed = await seedReleasedLead(db, s.base, { approver: s.admin });
    const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, {
      status: 'completed',
      outcome: 'qualified_callback',
      summary: 'Wants a call back Thursday.',
      qualification: { timeline: '3 months', condition: 'needs roof' },
      durationSeconds: 184,
      startedAt: new Date('2026-10-05T23:00:00.000Z'),
    });
    await touchSet(placed.touchId, { status: 'sent', aiCallId, sentAt: new Date(), createdAt: new Date('2026-10-05T10:00:00.000Z') });
    const refused = await seedReleasedLead(db, s.base, { approver: s.admin });
    await touchSet(refused.touchId, { status: 'failed', lastBlockReason: 'no_consent', createdAt: new Date('2026-10-05T11:00:00.000Z') });
    await db.update(schema.campaignEnrollments).set({ status: 'exited', exitReason: 'ai_call_no_consent' }).where(eq(schema.campaignEnrollments.id, refused.enrollmentId));
    const waiting = await seedReleasedLead(db, s.base, { approver: s.admin, touch: { attempts: 2, lastBlockReason: 'calling_hours' } });
    await touchSet(waiting.touchId, { createdAt: new Date('2026-10-05T12:00:00.000Z') });
    const other = await setup();
    await seedReleasedLead(db, other.base);

    const res = await listAiCallResults(db, ctxOf(s.base.orgId, s.admin, true), s.base.campaignId, null);

    expect(AiCallResultsResponse.parse(res)).toEqual(res);
    expect(res.items.map((i) => i.touchId)).toEqual([waiting.touchId, refused.touchId, placed.touchId]);
    expect(res.nextCursor).toBeNull();
    expect(res.items[2]).toMatchObject({
      name: 'Pat Seller',
      sfObject: 'Lead',
      sfRecordId: placed.sfRecordId,
      recordUrl: `https://example.my.salesforce.com/${placed.sfRecordId}`,
      touchStatus: 'sent',
      aiCallId,
      callStatus: 'completed',
      outcome: 'qualified_callback',
      summary: 'Wants a call back Thursday.',
      qualification: { timeline: '3 months', condition: 'needs roof' },
      durationSeconds: 184,
      startedAt: '2026-10-05T23:00:00.000Z',
      enrollmentStatus: 'active',
      mayReadTranscript: true,
    });
    expect(res.items[1]).toMatchObject({ touchStatus: 'failed', lastBlockReason: 'no_consent', enrollmentStatus: 'exited', exitReason: 'ai_call_no_consent', aiCallId: null, callStatus: null, mayReadTranscript: false });
    expect(res.items[0]).toMatchObject({ touchStatus: 'planned', attempts: 2, lastBlockReason: 'calling_hours', qualification: null });
  });

  it('pages by (created_at, id), 50 a page, with no row repeated or lost', async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < RESULTS_PAGE_SIZE + 3; i += 1) ids.push((await seedReleasedLead(db, s.base, { approver: s.admin })).touchId);
    // Several rows share one created_at: the id breaks the tie.
    await db.execute(sql`update touches set created_at = '2026-10-05T12:00:00.123456Z' where id in (${sql.join(ids.slice(0, 10).map((id) => sql`${id}::uuid`), sql`, `)})`);
    const ctx = ctxOf(s.base.orgId, s.admin, true);
    const first = await listAiCallResults(db, ctx, s.base.campaignId, null);
    expect(first.items).toHaveLength(RESULTS_PAGE_SIZE);
    const second = await listAiCallResults(db, ctx, s.base.campaignId, first.nextCursor);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.items, ...second.items].map((i) => i.touchId);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('a call\'s outcome or status cti-api wrote that the contract does not know reads as null', async () => {
    const s = await setup();
    const lead = await seedReleasedLead(db, s.base, { approver: s.admin });
    const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, { status: 'completed', outcome: 'something_new' });
    await touchSet(lead.touchId, { status: 'sent', aiCallId });
    const [item] = (await listAiCallResults(db, ctxOf(s.base.orgId, s.admin, true), s.base.campaignId, null)).items;
    expect(item).toMatchObject({ callStatus: 'completed', outcome: null });
  });

  it('the transcript: the owner and an admin read it, another rep is forbidden, an unknown or foreign call is null', async () => {
    const s = await setup();
    const lead = await seedReleasedLead(db, s.base, { approver: s.admin });
    const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, { status: 'completed', transcript: [{ role: 'agent', text: 'Hello', at: '2026-10-05T23:00:01.000Z' }, { bad: true }] });
    await touchSet(lead.touchId, { status: 'sent', aiCallId });

    const want = { aiCallId, lines: [{ role: 'agent', text: 'Hello', at: '2026-10-05T23:00:01.000Z' }] };
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.owner, false), aiCallId)).toEqual(want);
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.admin, true), aiCallId)).toEqual(want);
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.rep, false), aiCallId)).toBe('forbidden');
    const other = await setup();
    expect(await loadTranscript(db, ctxOf(other.base.orgId, other.admin, true), aiCallId)).toBeNull();
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.admin, true), '99999999-9999-4999-8999-999999999999')).toBeNull();
    const testCall = await seedAiCall(db, s.base.orgId, s.admin, { isTest: true, status: 'completed' });
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.admin, true), testCall)).toBeNull();
  });

  it('mayReadTranscript follows the owner rule for a rep', async () => {
    const s = await setup();
    const lead = await seedReleasedLead(db, s.base, { approver: s.admin });
    const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, { status: 'completed' });
    await touchSet(lead.touchId, { status: 'sent', aiCallId });
    const asOwner = await listAiCallResults(db, ctxOf(s.base.orgId, s.owner, false), s.base.campaignId, null);
    const asRep = await listAiCallResults(db, ctxOf(s.base.orgId, s.rep, false), s.base.campaignId, null);
    expect(asOwner.items[0]?.mayReadTranscript).toBe(true);
    expect(asRep.items[0]?.mayReadTranscript).toBe(false);
  });
});
