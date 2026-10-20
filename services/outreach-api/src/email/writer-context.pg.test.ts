/** Real Postgres: what Sam's writer is told about one seller (first name, the approved call plan, the history, the local time). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { seedAiCallCampaign } from '../test/call-plan-seed.js';
import { seedAiCall, seedReleasedLead, type ReleasedLead } from '../test/ai-call-seed.js';
import { seedCampaign, seedEnrollment, seedOrg, seedRecord, snapshot, leadId } from '../test/outreach-fixtures.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { appendEvent, ensureConversation } from '../conversations/store.js';
import { loadWriterContext } from './writer-context.js';

/** 14:05 UTC = 9:05 AM in Chicago (CDT), and the 512 area code is Central. */
const NOW = new Date('2026-10-20T14:05:00.000Z');
const COMPANY = 'GG Homes';

describe.skipIf(!pgLane)('loadWriterContext (real Postgres)', () => {
  let db: Db;
  let pool: TestDb['pool'];
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, pool, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  /** A fresh tenant with one AI-call lead: a record named "Pat Seller" (512 number), an enrollment and an approved plan. */
  async function seedSeller(over: Parameters<typeof seedReleasedLead>[2] = {}): Promise<ReleasedLead> {
    return seedReleasedLead(db, await seedAiCallCampaign(db, 'active'), over);
  }

  const contextOf = (lead: { orgId: string; crmRecordId: string }, conversationId: string | null = null, now: Date = NOW) =>
    loadWriterContext(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId, now, companyName: COMPANY });

  it('reads one query at a time, so it can run on one client inside a transaction (M2: no "client.query() already executing")', async () => {
    const lead = await seedSeller();
    const client = await pool.connect();
    let inFlight = 0;
    let most = 0;
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        return await query(...args);
      } finally {
        inFlight -= 1;
      }
    };
    try {
      const single = drizzle(client, { schema }) as unknown as Db;
      const ctx = await loadWriterContext(single, { orgId: lead.orgId, crmRecordId: lead.crmRecordId, conversationId: null, now: NOW, companyName: COMPANY });
      expect(ctx.firstName).toBe('Pat');
      expect(ctx.planText).not.toBeNull();
    } finally {
      client.release();
    }
    expect(most).toBe(1);
  });

  it('a seeded record with an approved plan has the plan text and the first word of the name', async () => {
    const lead = await seedSeller();
    const ctx = await contextOf(lead);
    expect(ctx.firstName).toBe('Pat');
    expect(ctx.companyName).toBe(COMPANY);
    expect(ctx.planText).not.toBeNull();
    // Rendered for the voice agent: the opener and goals, never the situation summary.
    expect(ctx.planText).toContain('Opener: Ask whether the family has decided what to do with the house on Oak Street.');
    expect(ctx.planText).not.toContain('Inherited the house');
  });

  it('writes the local time as "Weekday, Month D, YYYY, h:mm AM" in the zone of the first phone', async () => {
    const central = await seedSeller();
    expect((await contextOf(central)).localTime).toBe('Tuesday, October 20, 2026, 9:05 AM');

    // 415 is San Francisco (Pacific): 7:05 AM the same morning.
    const pacific = await seedSeller({ phones: [{ field: 'MobilePhone', e164: '+14155550100' }, { field: 'Phone', e164: '+15125550100' }] });
    expect((await contextOf(pacific)).localTime).toBe('Tuesday, October 20, 2026, 7:05 AM');

    // The afternoon says PM, and a single-digit hour has no leading zero.
    expect((await contextOf(central, null, new Date('2026-10-20T21:30:00.000Z'))).localTime).toBe('Tuesday, October 20, 2026, 4:30 PM');
  });

  it('with no phone the local time is Central, the dialer\'s own fallback', async () => {
    const lead = await seedSeller({ phones: [] });
    expect((await contextOf(lead)).localTime).toBe('Tuesday, October 20, 2026, 9:05 AM');
  });

  it('takes the first word of a name, and null when there is none', async () => {
    const named = async (name: string | null) => {
      const lead = await seedSeller({ recordOver: { name } });
      return (await contextOf(lead)).firstName;
    };
    expect(await named('  Maria   Elena Lopez ')).toBe('Maria');
    expect(await named('Madonna')).toBe('Madonna');
    expect(await named('')).toBeNull();
    expect(await named('   ')).toBeNull();
    expect(await named(null)).toBeNull();
  });

  it('has no plan text when the plan is only proposed, or the record has no AI call enrollment', async () => {
    const proposed = await seedSeller({ planStatus: 'proposed' });
    expect((await contextOf(proposed)).planText).toBeNull();

    const orgId = await seedOrg(db);
    const recordId = await seedRecord(db, orgId, snapshot({ sfRecordId: leadId(777_001), name: 'Lee Owner' }));
    const bare = await contextOf({ orgId, crmRecordId: recordId });
    expect(bare).toMatchObject({ firstName: 'Lee', planText: null, history: '' });
  });

  it('uses the newest AI call enrollment: a newer one with no approved plan hides an older approved plan, a newer sequence one does not', async () => {
    const lead = await seedSeller();
    const later = new Date(Date.now() + 60_000);
    const sequence = await seedCampaign(db, lead.orgId, { mode: 'sequence', status: 'active' });
    await seedEnrollment(db, lead.orgId, sequence.id, lead.crmRecordId, { enrolledAt: later, callStage: null });
    expect((await contextOf(lead)).planText).not.toBeNull();

    const second = await seedCampaign(db, lead.orgId, { mode: 'ai_call', status: 'active' });
    await seedEnrollment(db, lead.orgId, second.id, lead.crmRecordId, { enrolledAt: new Date(later.getTime() + 60_000), callStage: 'research' });
    expect((await contextOf(lead)).planText).toBeNull();
  });

  it('has no plan text when the stored plan no longer parses or fails the voice agent text check', async () => {
    const priced = await seedSeller({ planOver: { opener: 'Tell them we can offer $450,000 today.' } });
    expect((await contextOf(priced)).planText).toBeNull();

    const broken = await seedSeller();
    await db.update(schema.callPlans).set({ plan: { not: 'a plan' } }).where(eq(schema.callPlans.id, broken.planId!));
    expect((await contextOf(broken)).planText).toBeNull();
  });

  it('reads nothing of another tenant\'s record', async () => {
    const lead = await seedSeller();
    const other = await seedOrg(db);
    const ctx = await contextOf({ orgId: other, crmRecordId: lead.crmRecordId });
    expect(ctx).toMatchObject({ firstName: null, planText: null, history: '' });
  });

  it('the history is the digest of the timeline: the real calls, and the conversation\'s emails', async () => {
    const lead = await seedSeller();
    const aiCallId = await seedAiCall(db, lead.orgId, lead.approver, { status: 'completed', outcome: 'voicemail', startedAt: new Date('2026-10-18T17:00:00.000Z'), summary: 'Left a voicemail about the house.' });
    await db.update(schema.touches).set({ status: 'sent', aiCallId }).where(eq(schema.touches.id, lead.touchId));

    expect(await contextOf(lead)).toMatchObject({ history: expect.stringMatching(/^2026-10-18 Call — .*Left a voicemail about the house\.$/) });

    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    const eventId = await appendEvent(db, {
      orgId: lead.orgId,
      conversationId: conv.id,
      kind: 'email',
      direction: 'in',
      actor: 'seller',
      occurredAt: new Date('2026-10-19T18:00:00.000Z'),
      subject: 'Re: Your home',
      body: 'Still thinking about it.',
      sfLog: false,
    });
    await db.insert(schema.emailMessages).values({
      orgId: lead.orgId,
      conversationId: conv.id,
      eventId,
      direction: 'in',
      status: 'received',
      purpose: 'inbound',
      toAddress: 'sam@example.com',
      fromAddress: 'seller@example.com',
    });
    const { history } = await contextOf(lead, conv.id);
    expect(history.split('\n')).toEqual([
      expect.stringMatching(/^2026-10-18 Call — /),
      '2026-10-19 Email from the seller — "Re: Your home": Still thinking about it.',
    ]);
  });

  it('keeps the history within 3,000 characters, newest lines whole', async () => {
    const lead = await seedSeller();
    const conv = await ensureConversation(db, { orgId: lead.orgId, crmRecordId: lead.crmRecordId });
    for (let i = 0; i < 40; i += 1) {
      await appendEvent(db, { orgId: lead.orgId, conversationId: conv.id, kind: 'status', direction: 'none', actor: 'system', occurredAt: new Date(NOW.getTime() - (40 - i) * 3_600_000), detail: `Note number ${i} ${'x'.repeat(200)}`, sfLog: false });
    }
    const { history } = await contextOf(lead, conv.id);
    expect(history.length).toBeLessThanOrEqual(3_000);
    expect(history.split('\n').at(-1)).toContain('Note number 39');
    expect(history).not.toContain('Note number 0 ');
  });
});
