/**
 * The unsubscribe page on real tables: a GET (a mail scanner's prefetch) leaves the conversation open, a POST
 * (the page's button or a mailbox provider's one-click) stops the seller and suppresses the address, and the
 * address that was actually emailed stays suppressed even when the record's email later changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@cti/db';
import { buildApp } from '../app.js';
import { appendEvent, ensureConversation, type SellerConversationRow } from '../conversations/store.js';
import { leadId, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { seedUser } from '../test/call-plan-seed.js';
import { testConfig } from '../test/harness.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { registerEmailUnsubscribeRoutes } from './email-unsubscribe.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const ONE_CLICK = { 'content-type': 'application/x-www-form-urlencoded' };

describe.skipIf(!pgLane)('email unsubscribe (real Postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    app = await buildApp({
      cfg: testConfig(),
      readiness: async () => ({ dbOk: true, jobsOk: true }),
      apiRoutes: [(scope) => registerEmailUnsubscribeRoutes(scope, { db: t.db, companyName: 'GG Homes', now: () => NOW })],
    });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  const urlOf = (c: SellerConversationRow) => `/api/email/unsubscribe/${c.token}`;
  const post = (c: SellerConversationRow) => app.inject({ method: 'POST', url: urlOf(c), headers: ONE_CLICK, payload: 'List-Unsubscribe=One-Click' });

  async function seedSeller(email: string | null) {
    seq += 1;
    const orgId = await seedOrg(t.db);
    const crmRecordId = await seedRecord(t.db, orgId, snapshot({ sfRecordId: leadId(seq), email }));
    const conversation = await ensureConversation(t.db, { orgId, crmRecordId });
    return { orgId, crmRecordId, conversation };
  }

  async function conversationRow(id: string) {
    const [row] = await t.db.select().from(schema.sellerConversations).where(eq(schema.sellerConversations.id, id));
    return row!;
  }
  const suppressions = (orgId: string) => t.db.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.orgId, orgId));
  const events = (conversationId: string) => t.db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.conversationId, conversationId));

  async function queueEmail(orgId: string, conversationId: string, toAddress: string) {
    const eventId = await appendEvent(t.db, { orgId, conversationId, kind: 'email', direction: 'out', actor: 'sam', occurredAt: NOW, subject: 'Your house', body: 'Hello.', sfLog: false });
    await t.db
      .insert(schema.emailMessages)
      .values({ orgId, conversationId, eventId, direction: 'out', status: 'sent', purpose: 'first', toAddress, fromAddress: 'sam@example.com' });
  }

  it('GET shows the button and leaves the conversation open and the address unsuppressed', async () => {
    const { orgId, conversation } = await seedSeller('seller@example.com');
    const res = await app.inject({ method: 'GET', url: urlOf(conversation) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<button type="submit">Unsubscribe</button>');
    expect(await conversationRow(conversation.id)).toMatchObject({ status: 'open', stopReason: null });
    expect(await suppressions(orgId)).toEqual([]);
    expect(await events(conversation.id)).toEqual([]);
  });

  it('POST (one-click) stops the conversation as opted_out, suppresses the address and logs the stop for Salesforce', async () => {
    const { orgId, conversation } = await seedSeller('Seller@Example.com');
    const res = await post(conversation);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('unsubscribed');
    expect(await conversationRow(conversation.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
    expect(await suppressions(orgId)).toMatchObject([{ address: 'seller@example.com', reason: 'opted_out', conversationId: conversation.id }]);
    expect(await events(conversation.id)).toMatchObject([{ kind: 'status', detail: 'opted_out', sfLogStatus: 'pending' }]);
  });

  it('a scanner prefetching the link (GET), then the person pressing the button (POST), stops once', async () => {
    const { conversation } = await seedSeller('seller@example.com');
    await app.inject({ method: 'GET', url: urlOf(conversation) });
    expect(await conversationRow(conversation.id)).toMatchObject({ status: 'open' });
    expect((await post(conversation)).statusCode).toBe(200);
    expect(await conversationRow(conversation.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
  });

  it('POST twice answers 200 both times and writes one event', async () => {
    const { orgId, conversation } = await seedSeller('seller@example.com');
    expect((await post(conversation)).statusCode).toBe(200);
    expect((await post(conversation)).statusCode).toBe(200);
    expect(await events(conversation.id)).toHaveLength(1);
    expect(await suppressions(orgId)).toHaveLength(1);
  });

  it('still shows the page for a conversation that is already stopped, and an opt-out upgrades a not_interested stop', async () => {
    const { orgId, conversation } = await seedSeller('seller@example.com');
    await t.db.update(schema.sellerConversations).set({ status: 'stopped', stopReason: 'not_interested' }).where(eq(schema.sellerConversations.id, conversation.id));
    expect((await app.inject({ method: 'GET', url: urlOf(conversation) })).statusCode).toBe(200);
    expect((await post(conversation)).statusCode).toBe(200);
    expect(await conversationRow(conversation.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
    expect(await suppressions(orgId)).toMatchObject([{ address: 'seller@example.com', reason: 'opted_out' }]);
  });

  it('suppresses the address that was emailed even after the record email changed in Salesforce', async () => {
    const { orgId, crmRecordId, conversation } = await seedSeller('old@example.com');
    await queueEmail(orgId, conversation.id, 'old@example.com');
    await t.db.update(schema.crmRecords).set({ email: 'new@example.com' }).where(eq(schema.crmRecords.id, crmRecordId));
    expect((await post(conversation)).statusCode).toBe(200);
    expect((await suppressions(orgId)).map((r) => r.address).sort()).toEqual(['new@example.com', 'old@example.com']);
  });

  it('a practice conversation stops only its own row: nothing is suppressed and the seller stays open', async () => {
    const { orgId, crmRecordId, conversation: real } = await seedSeller('seller@example.com');
    const admin = await seedUser(t.db, orgId);
    const practice = await ensureConversation(t.db, { orgId, crmRecordId, practiceUserId: admin });
    await queueEmail(orgId, practice.id, 'seller@example.com');
    expect((await post(practice)).statusCode).toBe(200);
    expect(await conversationRow(practice.id)).toMatchObject({ status: 'stopped', stopReason: 'opted_out' });
    expect(await conversationRow(real.id)).toMatchObject({ status: 'open', stopReason: null });
    expect(await suppressions(orgId)).toEqual([]);
  });

  it('a well-formed token that belongs to no conversation is 404 and changes nothing', async () => {
    const { orgId, conversation } = await seedSeller('seller@example.com');
    const unknown = 'a'.repeat(26);
    const get = await app.inject({ method: 'GET', url: `/api/email/unsubscribe/${unknown}` });
    const posted = await app.inject({ method: 'POST', url: `/api/email/unsubscribe/${unknown}`, headers: ONE_CLICK, payload: 'List-Unsubscribe=One-Click' });
    expect([get.statusCode, posted.statusCode]).toEqual([404, 404]);
    expect(get.body).toContain('This link is not valid.');
    expect(await conversationRow(conversation.id)).toMatchObject({ status: 'open' });
    expect(await suppressions(orgId)).toEqual([]);
  });
});
