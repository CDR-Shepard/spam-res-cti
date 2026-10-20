/**
 * The seller conversation API on real tables: who may see and change a seller's conversation, why Sam may not
 * email them (the block the page shows), Sam's draft and the admin's Send (a practice copy to the admin's own
 * address included), and the guard that keeps a double click from queueing two first emails.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { ConversationView, EmailDraftResponse, EmailSendResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { buildApp } from '../app.js';
import { appendEvent, ensureConversation, flagConversation, stopSeller, suppressAddress } from '../conversations/store.js';
import type { EmailDecision, EmailWriter } from '../email/writer.js';
import { seedAiCallCampaign, seedPlanLead, type PlanLeadOptions } from '../test/call-plan-seed.js';
import { leadId, seedConnection, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { testConfig } from '../test/harness.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { registerSellerRoutes } from './sellers.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

// 11:00 in Austin (the seeded phone is +1 512): inside the seller's sending hours.
const NOW = new Date('2026-10-20T16:00:00.000Z');
const SELLER_EMAIL = 'delivered@resend.dev';
const OWNER_SF = '005000000000777AAA';
const auth = { authorization: 'Bearer t' };
const EMAIL_CFG = { RESEND_API_KEY: 're_test_key', RESEND_WEBHOOK_SECRET: 'whsec_dGVzdHNlY3JldA==' };

const SEND: EmailDecision = {
  action: 'send',
  flagReason: null,
  subject: 'Your home on Maple Street',
  body: "Hi Pat, I'm Sam, GG Homes' AI assistant. Is the house on Maple Street still for sale?",
};

describe.skipIf(!pgLane)('seller conversation routes (real Postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let unconfigured: FastifyInstance;
  let logLines: string[] = [];
  let sellerSeq = 0;
  const write = vi.fn();
  const writer: EmailWriter = { write };

  beforeAll(async () => {
    t = await createTestDb();
    app = await buildApp({
      // development logs at debug level, so the request log lines exist to be read.
      cfg: testConfig({ ...EMAIL_CFG, NODE_ENV: 'development' }),
      readiness: async () => ({ dbOk: true, jobsOk: true }),
      logStream: { write: (line) => logLines.push(line) },
      apiRoutes: [(scope) => registerSellerRoutes(scope, { db: t.db, writer, cfg: testConfig(EMAIL_CFG), now: () => NOW })],
    });
    unconfigured = await buildApp({
      cfg: testConfig(),
      readiness: async () => ({ dbOk: true, jobsOk: true }),
      apiRoutes: [(scope) => registerSellerRoutes(scope, { db: t.db, writer: null, cfg: testConfig(), now: () => NOW })],
    });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await unconfigured?.close();
    await t?.drop();
  });
  beforeEach(() => {
    logLines = [];
    write.mockReset().mockResolvedValue({ decision: SEND, model: 'claude-haiku-4-5-20251001', inputTokens: 100, outputTokens: 50 });
  });

  async function seedPerson(db: Db, orgId: string, o: { sfUserId?: string; displayName?: string } = {}) {
    const [user] = await db
      .insert(schema.users)
      .values({ orgId, email: `person-${randomUUID().slice(0, 8)}@example.com`, displayName: o.displayName ?? null })
      .returning({ id: schema.users.id, email: schema.users.email });
    if (o.sfUserId) {
      await db.insert(schema.salesforceConnections).values({ userId: user!.id, sfUserId: o.sfUserId, sfOrgId: '00D000000000001', instanceUrl: 'https://x.my.salesforce.com', accessTokenEnc: 'enc' });
    }
    return user!;
  }

  const sessionFor = (orgId: string, userId: string, isAdmin: boolean) => {
    state.session = { userId, orgId, email: 'session@example.com', isAdmin, isSuperAdmin: false, kind: 'human', powerDialerEnabled: false };
  };

  /**
   * A tenant with Sam's email on, a Salesforce connection, an admin, the record's owner and another rep, and one approved
   * seller. Each seller's id differs in its 15-character core, as real Salesforce ids do.
   */
  async function seedSeller(o: PlanLeadOptions & { settings?: Record<string, unknown> } = {}) {
    const { orgId, campaignId } = await seedAiCallCampaign(t.db);
    await t.db.update(schema.organizations).set({ settings: o.settings ?? { samEmail: { enabled: true } } }).where(eq(schema.organizations.id, orgId));
    await seedConnection(t.db, orgId);
    sellerSeq += 1;
    const sfRecordId = `00Q${String(sellerSeq).padStart(12, '0')}AAA`;
    const lead = await seedPlanLead(t.db, { orgId, campaignId }, { planStatus: 'approved', ownerSfUserId: OWNER_SF, ...o, recordOver: { sfRecordId, email: SELLER_EMAIL, ...o.recordOver } });
    const admin = await seedPerson(t.db, orgId, { displayName: 'Ada Admin' });
    const owner = await seedPerson(t.db, orgId, { sfUserId: OWNER_SF, displayName: 'Owen Owner' });
    const other = await seedPerson(t.db, orgId, { sfUserId: '005000000000888AAA' });
    return { ...lead, sfRecordId, admin, owner, other };
  }

  const url = (sfRecordId: string, path: string) => `/api/sellers/${sfRecordId}/${path}`;
  const get = (sfRecordId: string, on = app) => on.inject({ method: 'GET', url: url(sfRecordId, 'conversation'), headers: auth });
  const putHandler = (sfRecordId: string, handler: string) => app.inject({ method: 'PUT', url: url(sfRecordId, 'handler'), headers: auth, payload: { handler } });
  const draft = (sfRecordId: string, practice = false, on = app) => on.inject({ method: 'POST', url: url(sfRecordId, 'email/draft'), headers: auth, payload: { practice } });
  const send = (sfRecordId: string, practice = false, over: Partial<EmailDecision> = {}) =>
    app.inject({ method: 'POST', url: url(sfRecordId, 'email/send'), headers: auth, payload: { subject: over.subject ?? SEND.subject, body: over.body ?? SEND.body, practice } });

  const conversationsOf = (crmRecordId: string) => t.db.select().from(schema.sellerConversations).where(eq(schema.sellerConversations.crmRecordId, crmRecordId));
  const emailsOf = (conversationId: string) => t.db.select().from(schema.emailMessages).where(eq(schema.emailMessages.conversationId, conversationId));

  describe('GET /sellers/:sfRecordId/conversation', () => {
    it('a person who neither owns the record nor is an admin gets 403 FORBIDDEN', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.other.id, false);
      const res = await get(s.sfRecordId);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
    });

    it('a record that is not in this tenant\'s records is 404 NOT_FOUND, another tenant\'s included', async () => {
      const s = await seedSeller();
      const elsewhere = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      expect((await get(leadId(123_456))).json()).toMatchObject({ code: 'NOT_FOUND' });
      const res = await get(elsewhere.sfRecordId);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    });

    it('finds the record by its 15-character id (the case-sensitive prefix) as well as its 18-character one; never another tenant\'s', async () => {
      const s = await seedSeller();
      const elsewhere = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      const short = await get(s.sfRecordId.slice(0, 15));
      expect(short.statusCode).toBe(200);
      expect(short.json().sfRecordId).toBe(s.sfRecordId);
      expect((await get(s.sfRecordId)).statusCode).toBe(200);
      // Salesforce's 15-character id is case-sensitive, and an 18-character id is matched whole.
      expect((await get(s.sfRecordId.slice(0, 15).toLowerCase())).statusCode).toBe(404);
      expect((await get(`${s.sfRecordId.slice(0, 15)}ZZZ`)).statusCode).toBe(404);
      const theirs = await get(elsewhere.sfRecordId.slice(0, 15));
      expect(theirs.statusCode).toBe(404);
      expect(theirs.json().code).toBe('NOT_FOUND');
    });

    it('the owner sees the seller: mayEmail false, mayChangeHandler true, and no conversation row is created', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.owner.id, false);
      const res = await get(s.sfRecordId);
      expect(res.statusCode).toBe(200);
      const view = ConversationView.parse(res.json());
      expect(view).toMatchObject({
        sfRecordId: s.sfRecordId,
        sfObject: 'Lead',
        name: 'Pat Seller',
        recordUrl: `https://example.my.salesforce.com/${s.sfRecordId}`,
        conversationId: null,
        handler: 'sam',
        handlerName: null,
        status: 'open',
        stopReason: null,
        flagReason: null,
        emailAddress: SELLER_EMAIL,
        emailBlock: null,
        mayEmail: false,
        mayChangeHandler: true,
        items: [],
      });
      expect(await conversationsOf(s.crmRecordId)).toEqual([]);
    });

    it('an admin on a record without an approved plan sees not_approved, and may not email', async () => {
      const s = await seedSeller({ planStatus: 'proposed' });
      sessionFor(s.orgId, s.admin.id, true);
      expect((await get(s.sfRecordId)).json()).toMatchObject({ emailBlock: 'not_approved', mayEmail: false, mayChangeHandler: true });
    });

    it('an approved plan on a sequence (non-AI call) campaign does not count as approval', async () => {
      const s = await seedSeller({ planStatus: 'proposed' });
      await t.db.update(schema.campaigns).set({ mode: 'sequence' }).where(eq(schema.campaigns.id, s.campaignId));
      await t.db.update(schema.callPlans).set({ status: 'approved' }).where(eq(schema.callPlans.id, s.planId!));
      sessionFor(s.orgId, s.admin.id, true);
      expect((await get(s.sfRecordId)).json().emailBlock).toBe('not_approved');
    });

    it('an admin on an approved seller with Sam\'s email on may email', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      expect((await get(s.sfRecordId)).json()).toMatchObject({ emailBlock: null, mayEmail: true });
    });

    it('explains a block in order: not_configured, disabled, paused, no_address, not_approved, closed, then the seller rules', async () => {
      const blocked = async (o: Parameters<typeof seedSeller>[0], on = app) => {
        const s = await seedSeller(o);
        sessionFor(s.orgId, s.admin.id, true);
        return (await get(s.sfRecordId, on)).json().emailBlock;
      };
      expect(await blocked({}, unconfigured)).toBe('not_configured');
      expect(await blocked({ settings: {} })).toBe('disabled');
      expect(await blocked({ settings: { samEmail: { enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint' } } })).toBe('paused');
      expect(await blocked({ planStatus: 'proposed', recordOver: { email: null } })).toBe('no_address');
      expect(await blocked({ planStatus: 'proposed', recordOver: { isClosed: true } })).toBe('not_approved');
      expect(await blocked({ recordOver: { isClosed: true, sfEmailOptOut: true } })).toBe('closed');
      expect(await blocked({ recordOver: { sfEmailOptOut: true } })).toBe('sf_opt_out');
    });

    it('Salesforce Email Opt Out on ANOTHER record with the same address (any case) blocks the email too: sf_opt_out (I2b)', async () => {
      const s = await seedSeller();
      await seedRecord(t.db, s.orgId, snapshot({ sfRecordId: leadId(880_000 + (sellerSeq += 1)), email: ` ${SELLER_EMAIL.toUpperCase()} ` }), { sfEmailOptOut: true });
      sessionFor(s.orgId, s.admin.id, true);
      expect((await get(s.sfRecordId)).json()).toMatchObject({ emailBlock: 'sf_opt_out', mayEmail: false });
      // Another tenant's opted-out record with that address says nothing here.
      const other = await seedSeller();
      sessionFor(other.orgId, other.admin.id, true);
      expect((await get(other.sfRecordId)).json()).toMatchObject({ emailBlock: null, mayEmail: true });
    });

    it('an email from another address shows on the page as the seller\'s email, without the server-only otherSender key (M8)', async () => {
      const s = await seedSeller();
      const conv = await ensureConversation(t.db, { orgId: s.orgId, crmRecordId: s.crmRecordId });
      const eventId = await appendEvent(t.db, { orgId: s.orgId, conversationId: conv.id, kind: 'email', direction: 'in', actor: 'seller', subject: 'Re: hi', body: 'Neighbour here.', meta: { autoReply: false, otherSender: true }, sfLog: false });
      await t.db.insert(schema.emailMessages).values({ orgId: s.orgId, conversationId: conv.id, eventId, direction: 'in', status: 'received', purpose: 'inbound', toAddress: 'sam@example.com', fromAddress: 'neighbour@example.com' });
      sessionFor(s.orgId, s.admin.id, true);
      const body = (await get(s.sfRecordId)).json() as { items: Array<Record<string, unknown>> };
      expect(body.items).toEqual([expect.objectContaining({ id: eventId, type: 'email', direction: 'in', actor: 'seller', body: 'Neighbour here.' })]);
      expect(body.items[0]).not.toHaveProperty('otherSender');
    });

    it('the seller rules read the real conversation: stopped, taken over, flagged, suppressed', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      const conversation = await ensureConversation(t.db, { orgId: s.orgId, crmRecordId: s.crmRecordId });
      await suppressAddress(t.db, { orgId: s.orgId, address: SELLER_EMAIL.toUpperCase(), reason: 'bounced', conversationId: conversation.id });
      expect((await get(s.sfRecordId)).json()).toMatchObject({ conversationId: conversation.id, emailBlock: 'suppressed' });
      await flagConversation(t.db, { conversationId: conversation.id, reason: 'wants_appointment', now: NOW });
      expect((await get(s.sfRecordId)).json()).toMatchObject({ flagReason: 'wants_appointment', emailBlock: 'flagged' });
      await stopSeller(t.db, { conversationId: conversation.id, reason: 'not_interested', now: NOW });
      expect((await get(s.sfRecordId)).json()).toMatchObject({ status: 'stopped', stopReason: 'not_interested', emailBlock: 'stopped', mayEmail: false });
    });

    it('shows the real conversation only: a practice conversation of the same seller is never the one returned', async () => {
      const s = await seedSeller();
      const practice = await ensureConversation(t.db, { orgId: s.orgId, crmRecordId: s.crmRecordId, practiceUserId: s.admin.id });
      await stopSeller(t.db, { conversationId: practice.id, reason: 'opted_out', now: NOW });
      sessionFor(s.orgId, s.admin.id, true);
      expect((await get(s.sfRecordId)).json()).toMatchObject({ conversationId: null, status: 'open', emailBlock: null, items: [] });
    });
  });

  describe('PUT /sellers/:sfRecordId/handler', () => {
    it('the owner takes over: handler person with their name and a note on the timeline; giving back clears it', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.owner.id, false);
      const taken = await putHandler(s.sfRecordId, 'person');
      expect(taken.statusCode).toBe(200);
      const view = ConversationView.parse(taken.json());
      expect(view).toMatchObject({ handler: 'person', handlerName: 'Owen Owner', mayChangeHandler: true });
      expect(view.conversationId).not.toBeNull();
      expect(view.items).toMatchObject([{ type: 'note', kind: 'handler', detail: 'taken_over', byName: 'Owen Owner' }]);
      sessionFor(s.orgId, s.admin.id, true);
      expect((await get(s.sfRecordId)).json()).toMatchObject({ handler: 'person', emailBlock: 'taken_over' });
      sessionFor(s.orgId, s.owner.id, false);
      expect((await putHandler(s.sfRecordId, 'sam')).json()).toMatchObject({ handler: 'sam', handlerName: null });
    });

    it('someone else gets 403 and nothing is created; a bad body is 400', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.other.id, false);
      expect((await putHandler(s.sfRecordId, 'person')).statusCode).toBe(403);
      expect(await conversationsOf(s.crmRecordId)).toEqual([]);
      sessionFor(s.orgId, s.owner.id, false);
      expect((await putHandler(s.sfRecordId, 'robot')).statusCode).toBe(400);
    });
  });

  describe('POST /sellers/:sfRecordId/email/draft', () => {
    it('returns Sam\'s draft and the seller\'s address; the draft is never written to a log line', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      const res = await draft(s.sfRecordId);
      expect(res.statusCode).toBe(200);
      expect(EmailDraftResponse.parse(res.json())).toEqual({ subject: SEND.subject, body: SEND.body, to: SELLER_EMAIL });
      // Sam was asked for a first email and given the seller's approved plan.
      const [prompt] = write.mock.calls[0]!;
      expect(prompt.system).toContain('This is the first email to this seller.');
      expect(prompt.user).toContain('First name: Pat');
      expect(prompt.user).not.toContain('<call_plan>\n(none)');
      const logs = logLines.join('\n');
      for (const secret of [SELLER_EMAIL, SEND.subject, SEND.body, 'Pat Seller']) expect(logs).not.toContain(secret);
    });

    it('a practice draft goes to the admin\'s own address', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      expect((await draft(s.sfRecordId, true)).json()).toEqual({ subject: SEND.subject, body: SEND.body, to: s.admin.email });
    });

    it('Sam answering anything but a send is 422 DRAFT_REFUSED', async () => {
      const s = await seedSeller();
      write.mockResolvedValue({ decision: { action: 'no_reply', flagReason: null, subject: '', body: '' }, model: 'claude-haiku-4-5-20251001', inputTokens: 10, outputTokens: 5 });
      sessionFor(s.orgId, s.admin.id, true);
      const res = await draft(s.sfRecordId);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('DRAFT_REFUSED');
    });

    it('a spent AI budget is 429 AI_BUDGET and the model is never asked; a model failure is 502 MODEL_ERROR', async () => {
      const spent = await seedSeller({ settings: { samEmail: { enabled: true }, aiDailyBudgetUsd: 0 } });
      sessionFor(spent.orgId, spent.admin.id, true);
      const over = await draft(spent.sfRecordId);
      expect(over.statusCode).toBe(429);
      expect(over.json().code).toBe('AI_BUDGET');
      expect(write).not.toHaveBeenCalled();

      const s = await seedSeller();
      write.mockRejectedValue(new Error('overloaded'));
      sessionFor(s.orgId, s.admin.id, true);
      const failed = await draft(s.sfRecordId);
      expect(failed.statusCode).toBe(502);
      expect(failed.json().code).toBe('MODEL_ERROR');
    });

    it('a blocked seller is 409 with the block; a practice draft ignores the seller\'s blocks but not the setup', async () => {
      const s = await seedSeller({ planStatus: 'proposed' });
      sessionFor(s.orgId, s.admin.id, true);
      const res = await draft(s.sfRecordId);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('not_approved');
      expect(write).not.toHaveBeenCalled();
      expect((await draft(s.sfRecordId, true)).statusCode).toBe(200);
      const none = await draft(s.sfRecordId, true, unconfigured);
      expect(none.statusCode).toBe(409);
      expect(none.json().code).toBe('not_configured');
    });

    it('with Sam\'s email off or paused an admin can still read the draft (real or practice); sending stays refused (owner, 2026-10-20)', async () => {
      for (const settings of [{}, { samEmail: { enabled: false } }, { samEmail: { enabled: true, pausedAt: NOW.toISOString(), pausedReason: 'complaint' } }]) {
        const s = await seedSeller({ settings });
        sessionFor(s.orgId, s.admin.id, true);
        const real = await draft(s.sfRecordId);
        expect(real.statusCode).toBe(200);
        expect(real.json()).toEqual({ subject: SEND.subject, body: SEND.body, to: SELLER_EMAIL });
        expect((await draft(s.sfRecordId, true)).json()).toEqual({ subject: SEND.subject, body: SEND.body, to: s.admin.email });
        for (const practice of [false, true]) {
          const sent = await send(s.sfRecordId, practice);
          expect(sent.statusCode).toBe(409);
          expect(['disabled', 'paused']).toContain(sent.json().code);
        }
        expect(await conversationsOf(s.crmRecordId)).toEqual([]);
      }
    });

    it('with the switch off, a seller block still refuses the real draft', async () => {
      const s = await seedSeller({ planStatus: 'proposed', settings: {} });
      sessionFor(s.orgId, s.admin.id, true);
      const res = await draft(s.sfRecordId);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('not_approved');
      expect(write).not.toHaveBeenCalled();
    });

    it('only admins may ask for a draft', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.owner.id, false);
      expect((await draft(s.sfRecordId)).json().code).toBe('ADMIN_ONLY');
    });
  });

  describe('POST /sellers/:sfRecordId/email/send', () => {
    it('queues Sam\'s first email to the seller, for now (inside their hours), requested by the admin', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      const res = await send(s.sfRecordId);
      expect(res.statusCode).toBe(200);
      const queued = EmailSendResponse.parse(res.json());
      expect(queued).toMatchObject({ sendAfter: NOW.toISOString(), to: SELLER_EMAIL });
      const [conversation] = await conversationsOf(s.crmRecordId);
      expect(conversation).toMatchObject({ practiceUserId: null });
      expect(await emailsOf(conversation!.id)).toMatchObject([
        { id: queued.emailId, status: 'queued', purpose: 'first', toAddress: SELLER_EMAIL, requestedBy: s.admin.id, sendAfter: NOW },
      ]);
      const logs = logLines.join('\n');
      for (const secret of [SELLER_EMAIL, SEND.subject, SEND.body]) expect(logs).not.toContain(secret);
    });

    it('a draft that claims to be a person is 422 DRAFT_INVALID with the problems, and nothing is queued', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      const res = await send(s.sfRecordId, false, { body: "Hi Pat, I'm a real person on the GG Homes team." });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('DRAFT_INVALID');
      expect(res.json().details).toEqual([expect.stringMatching(/claims to be a human/)]);
      expect(await conversationsOf(s.crmRecordId)).toEqual([]);
    });

    it('a practice send queues to the admin\'s email on their own conversation, while a real send to a stopped seller is 409 stopped', async () => {
      const s = await seedSeller();
      const real = await ensureConversation(t.db, { orgId: s.orgId, crmRecordId: s.crmRecordId });
      await stopSeller(t.db, { conversationId: real.id, reason: 'not_interested', now: NOW });
      sessionFor(s.orgId, s.admin.id, true);

      const refused = await send(s.sfRecordId);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('stopped');
      expect(await emailsOf(real.id)).toEqual([]);

      const practice = await send(s.sfRecordId, true);
      expect(practice.statusCode).toBe(200);
      expect(practice.json()).toMatchObject({ to: s.admin.email, sendAfter: NOW.toISOString() });
      const [mine] = await t.db
        .select()
        .from(schema.sellerConversations)
        .where(and(eq(schema.sellerConversations.crmRecordId, s.crmRecordId), eq(schema.sellerConversations.practiceUserId, s.admin.id)));
      expect(await emailsOf(mine!.id)).toMatchObject([{ id: practice.json().emailId, purpose: 'practice', toAddress: s.admin.email, requestedBy: s.admin.id }]);
    });

    it('a second Send while the first is still queued or sending is 409 EMAIL_ALREADY_QUEUED; a practice send is not held up by it', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      const first = await send(s.sfRecordId);
      expect(first.statusCode).toBe(200);
      const again = await send(s.sfRecordId);
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe('EMAIL_ALREADY_QUEUED');
      expect((await send(s.sfRecordId, true)).statusCode).toBe(200);
      await t.db.execute(sql`update email_messages set status = 'sending' where id = ${first.json().emailId}::uuid`);
      expect((await send(s.sfRecordId)).json().code).toBe('EMAIL_ALREADY_QUEUED');
      // Once it is out, another first email may be queued.
      await t.db.execute(sql`update email_messages set status = 'sent' where id = ${first.json().emailId}::uuid`);
      expect((await send(s.sfRecordId)).statusCode).toBe(200);
    });

    it('a double click (two Sends at once, no conversation yet) queues exactly one email', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.admin.id, true);
      const answers = await Promise.all([send(s.sfRecordId), send(s.sfRecordId)]);
      expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const [conversation, ...more] = await conversationsOf(s.crmRecordId);
      expect(more).toEqual([]);
      expect(await emailsOf(conversation!.id)).toHaveLength(1);
    });

    it('only admins may send', async () => {
      const s = await seedSeller();
      sessionFor(s.orgId, s.owner.id, false);
      expect((await send(s.sfRecordId)).json().code).toBe('ADMIN_ONLY');
    });
  });
});

describe.skipIf(!pgLane)('seller conversation routes: a seller with no Salesforce connection', () => {
  let t: TestDb;
  let app: FastifyInstance;
  beforeAll(async () => {
    t = await createTestDb();
    app = await buildApp({
      cfg: testConfig(EMAIL_CFG),
      readiness: async () => ({ dbOk: true, jobsOk: true }),
      apiRoutes: [(scope) => registerSellerRoutes(scope, { db: t.db, writer: null, cfg: testConfig(EMAIL_CFG), now: () => NOW })],
    });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('has an empty record link rather than failing', async () => {
    const { orgId } = await seedAiCallCampaign(t.db);
    const sfRecordId = leadId(424_242);
    await seedRecord(t.db, orgId, snapshot({ sfRecordId }), { name: null });
    const [admin] = await t.db.insert(schema.users).values({ orgId, email: 'admin-x@example.com' }).returning({ id: schema.users.id });
    state.session = { userId: admin!.id, orgId, email: 'admin-x@example.com', isAdmin: true, isSuperAdmin: false, kind: 'human', powerDialerEnabled: false };
    const res = await app.inject({ method: 'GET', url: `/api/sellers/${sfRecordId}/conversation`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recordUrl: '', name: sfRecordId, emailBlock: 'not_configured' });
  });
});
