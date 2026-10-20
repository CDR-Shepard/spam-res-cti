/**
 * Real Postgres: the tick that logs timeline events to Salesforce as Tasks, with a fake Salesforce (the real
 * one is never reached). What these protect: every email, flag and stop reaches the seller's record exactly
 * once (a retry or a lost answer never doubles a Task, and two same-subject replies never share one), a
 * converted Lead's Task lands on its Opportunity, a failing org backs off and ends in one alert, a practice
 * event never leaves the database, and nothing a seller wrote reaches a log line or an error column.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { soqlEscape } from '@cti/salesforce';
import type { AlertEvent } from '../alerts.js';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { fakeSfWrites, newSfId, ok, refused, type FakeSfWrites } from '../test/fake-sf-writes.js';
import { seedAiCall } from '../test/ai-call-seed.js';
import { seedUser } from '../test/call-plan-seed.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { leadId, seedConnection, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { appendEvent, ensureConversation, flagConversation, stopSeller, type SellerConversationRow } from './store.js';
import { logEventsToSalesforce, SF_LOG_MAX_ATTEMPTS, type SfLogCounts, type SfLogDeps } from './sf-log.js';

const MINUTE = 60_000;
/** The tick's clock: the database stamps a new event `now()`, so the tick runs a little after that. */
const T0 = new Date(Date.now() + 5 * MINUTE);
const APP = 'https://app.example.com';
const ADDRESS = 'delivered@resend.dev';
const SECRET_SUBJECT = 'Re: Oak Street secret subject';
const SECRET_BODY = 'Please call me about the Oak Street house, my number is 5125550123.';
const CONNECTION_USER = '005000000000001AAA';
const REP = '005000000000009AAA';
const GROUP_OWNER = '00G000000000002AAA';
const OPP = '0068X00000Oppt1QAA';

const after = (minutes: number): Date => new Date(T0.getTime() + minutes * MINUTE);
const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

interface FakeTask {
  id: string;
  fields: Record<string, unknown>;
}

/** A lookup's record and Subject, as createTaskOnce writes them, against a Task the org holds. */
const matches = (q: string, f: Record<string, unknown>): boolean =>
  (['WhoId', 'WhatId'] as const).some((k) => typeof f[k] === 'string' && q.includes(`${k} = '${f[k] as string}'`)) && q.includes(`Subject = '${soqlEscape(String(f.Subject))}'`);

/** The ids a lookup leaves out (`AND Id NOT IN ('...', '...')`). */
const excludedBy = (q: string): string[] => [...(/ AND Id NOT IN \(([^)]*)\)/.exec(q)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);

/**
 * A Salesforce org that remembers the Tasks it was given and finds them again when a lookup names their record and Subject
 * (and does not leave their id out). It hands back what Salesforce would: the Description with its line endings normalised.
 */
function fakeOrg(over: { converted?: string | null } = {}) {
  const tasks: FakeTask[] = [];
  const sf: FakeSfWrites = fakeSfWrites({
    queries: [
      [
        /^SELECT Id, Description FROM Task /,
        (q) =>
          tasks
            .filter((t) => matches(q, t.fields) && !excludedBy(q).includes(t.id))
            .map((t) => ({ Id: t.id, Description: String(t.fields.Description).replace(/\n/g, '\r\n') })),
      ],
      [/^SELECT ConvertedOpportunityId FROM Lead WHERE Id = /, () => [{ ConvertedOpportunityId: over.converted ?? null }]],
    ],
  });
  const store = (c: { fields: Record<string, unknown> }): string => {
    const id = newSfId('Task');
    tasks.push({ id, fields: c.fields });
    return id;
  };
  sf.onCreate = (c) => ok(store(c));
  return { sf, tasks, store };
}

describe.skipIf(!pgLane)('Salesforce log tick (real Postgres)', () => {
  let t: TestDb;
  let db: Db;
  let seq = 0;
  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });
  // The tick scans every tenant's due rows, so a row left over from one test must not reach the next.
  afterEach(async () => {
    await t.pool.query('delete from conversation_events');
  });

  interface Seller {
    orgId: string;
    crmRecordId: string;
    sfRecordId: string;
    conv: SellerConversationRow;
  }

  /** A fresh tenant with a connection and one seller (a Lead unless told otherwise) and their conversation. */
  async function seedSeller(over: { sfObject?: 'Lead' | 'Opportunity'; ownerSfUserId?: string | null; timezone?: string } = {}): Promise<Seller> {
    // Taken before the first await: sellers seeded together must not share an id.
    seq += 1;
    const n = seq;
    const orgId = await seedOrg(db);
    await seedConnection(db, orgId);
    if (over.timezone) await db.update(schema.organizations).set({ timezone: over.timezone }).where(eq(schema.organizations.id, orgId));
    const sfObject = over.sfObject ?? 'Lead';
    const sfRecordId = sfObject === 'Lead' ? leadId(n) : `006${String(n).padStart(15, '0')}`;
    const crmRecordId = await seedRecord(
      db,
      orgId,
      snapshot({ sfObject, sfRecordId, email: ADDRESS, ownerSfUserId: over.ownerSfUserId === undefined ? REP : over.ownerSfUserId }),
    );
    return { orgId, crmRecordId, sfRecordId, conv: await ensureConversation(db, { orgId, crmRecordId }) };
  }

  /** What src/email/inbound.ts writes for a seller's reply: kind email, direction in, actor seller, logged. */
  const inbound = (s: Seller, over: { subject?: string; body?: string; occurredAt?: Date } = {}) =>
    appendEvent(db, {
      orgId: s.orgId,
      conversationId: s.conv.id,
      kind: 'email',
      direction: 'in',
      actor: 'seller',
      occurredAt: over.occurredAt ?? new Date('2026-10-20T17:00:00.000Z'),
      subject: over.subject ?? SECRET_SUBJECT,
      body: over.body ?? SECRET_BODY,
      meta: { autoReply: false },
      sfLog: true,
    });

  async function eventOf(id: string) {
    const [row] = await db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.id, id));
    return row!;
  }

  function harness(org: ReturnType<typeof fakeOrg> = fakeOrg()) {
    const log = fakeLog();
    const alerts: AlertEvent[] = [];
    const alert = vi.fn(async (event: AlertEvent) => {
      alerts.push(event);
    });
    const run = (over: Partial<SfLogDeps> = {}, now: Date = T0) =>
      logEventsToSalesforce({ db, clients: async () => org.sf.client, appPublicUrl: APP, now, log, alert, ...over });
    return { org, log, alerts, alert, run };
  }

  /** Every alert and log line, flattened: none may carry the address, the subject or the seller's words. */
  function assertNoPii(h: ReturnType<typeof harness>, extra: string[] = []): void {
    const everything = JSON.stringify([h.alert.mock.calls, h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls]);
    for (const secret of [ADDRESS, SECRET_SUBJECT, SECRET_BODY, 'Oak Street', '5125550123', 'Pat Seller', ...extra]) expect(everything).not.toContain(secret);
  }

  describe('what gets logged', () => {
    it("a seller's reply on a Lead becomes a completed Email Task on the Lead, owned by its rep, and the event is done", async () => {
      const s = await seedSeller();
      const id = await inbound(s, { occurredAt: new Date('2026-10-21T02:30:00.000Z') });
      const h = harness();

      expect(await h.run()).toEqual({ done: 1, retried: 0, failed: 0 });

      expect(h.org.sf.creates).toHaveLength(1);
      expect(h.org.sf.creates[0]).toMatchObject({ sobject: 'Task' });
      expect(h.org.sf.creates[0]!.fields).toMatchObject({
        Subject: `Email reply from seller: ${SECRET_SUBJECT}`,
        Status: 'Completed',
        TaskSubtype: 'Email',
        WhoId: s.sfRecordId,
        OwnerId: REP,
        // 02:30Z on the 21st is 19:30 PDT on the 20th in the org's zone.
        ActivityDate: '2026-10-20',
        CTI_Origin__c: 'AI Outreach',
        Description: `${SECRET_BODY}\n\nConversation: ${APP}/sellers/${s.sfRecordId}#event-${id}`,
      });
      expect(h.org.sf.creates[0]!.fields).not.toHaveProperty('WhatId');
      const row = await eventOf(id);
      expect(row).toMatchObject({ sfLogStatus: 'done', sfTaskId: h.org.tasks[0]!.id, sfLogError: null });
      expect(row.sfLogNextAt).toBeNull();
      assertNoPii(h);
    });

    it('a reply stored as from another address (meta.otherSender) is logged as "Email from another address" (M8)', async () => {
      const s = await seedSeller();
      const id = await appendEvent(db, {
        orgId: s.orgId,
        conversationId: s.conv.id,
        kind: 'email',
        direction: 'in',
        actor: 'seller',
        subject: SECRET_SUBJECT,
        body: SECRET_BODY,
        meta: { autoReply: false, otherSender: true },
        sfLog: true,
      });
      const h = harness();
      expect(await h.run()).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(h.org.sf.creates[0]!.fields).toMatchObject({ Subject: `Email from another address: ${SECRET_SUBJECT}`, TaskSubtype: 'Email', WhoId: s.sfRecordId });
      expect((await eventOf(id)).sfLogStatus).toBe('done');
    });

    it("Sam's outbound email, once Resend accepted it, is logged as an email from Sam", async () => {
      const s = await seedSeller();
      const id = await appendEvent(db, { orgId: s.orgId, conversationId: s.conv.id, kind: 'email', direction: 'out', actor: 'sam', subject: 'Your home on Oak Street', body: 'Hi, this is Sam.', sfLog: true });
      const h = harness();
      expect(await h.run()).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(h.org.sf.creates[0]!.fields).toMatchObject({ Subject: 'Email from Sam (AI): Your home on Oak Street', TaskSubtype: 'Email', Status: 'Completed', WhoId: s.sfRecordId });
      expect((await eventOf(id)).sfLogStatus).toBe('done');
    });

    it('a flag is an open, high-priority Task for the record owner', async () => {
      const s = await seedSeller();
      await flagConversation(db, { conversationId: s.conv.id, reason: 'offer_or_price', now: new Date() });
      const h = harness();
      expect(await h.run()).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(h.org.sf.creates[0]!.fields).toMatchObject({
        Subject: 'Sam (AI) needs a person: asked about an offer or price',
        Status: 'Open',
        Priority: 'High',
        OwnerId: REP,
        WhoId: s.sfRecordId,
      });
      expect(h.org.sf.creates[0]!.fields).not.toHaveProperty('TaskSubtype');
    });

    it('an opt-out is logged by stopSeller, and so is every other stop reason', async () => {
      const cases: Array<[Parameters<typeof stopSeller>[1]['reason'], string]> = [
        ['opted_out', 'Opted out of Sam (AI)'],
        ['complained', "Spam complaint about Sam's email"],
        ['asked_to_stop', 'Asked Sam (AI) to stop'],
        ['not_interested', 'Not interested (Sam AI)'],
      ];
      for (const [reason, subject] of cases) {
        const s = await seedSeller();
        await stopSeller(db, { conversationId: s.conv.id, reason, now: new Date() });
        const h = harness();
        expect(await h.run()).toEqual({ done: 1, retried: 0, failed: 0 });
        expect(h.org.sf.creates[0]!.fields).toMatchObject({ Subject: subject, Status: 'Completed', WhoId: s.sfRecordId });
      }
    });

    it('an Opportunity seller gets the Task on WhatId', async () => {
      const s = await seedSeller({ sfObject: 'Opportunity' });
      await inbound(s);
      const h = harness();
      await h.run();
      expect(h.org.sf.creates[0]!.fields).toMatchObject({ WhatId: s.sfRecordId });
      expect(h.org.sf.creates[0]!.fields).not.toHaveProperty('WhoId');
    });

    it('the Task is dated in the organization time zone', async () => {
      const s = await seedSeller({ timezone: 'Pacific/Auckland' });
      await inbound(s, { occurredAt: new Date('2026-10-21T02:30:00.000Z') });
      const h = harness();
      await h.run();
      expect(h.org.sf.creates[0]!.fields).toMatchObject({ ActivityDate: '2026-10-21' });
    });

    it('a done event is never logged again', async () => {
      const s = await seedSeller();
      await inbound(s);
      const h = harness();
      await h.run();
      expect(await h.run({}, after(60))).toEqual({ done: 0, retried: 0, failed: 0 });
      expect(h.org.sf.creates).toHaveLength(1);
    });
  });

  describe('who owns the Task', () => {
    it.each<[string, string | null, string]>([
      ['the record owner when it is a user (005…)', REP, REP],
      ['the connection user when the owner is a queue (00G…)', GROUP_OWNER, CONNECTION_USER],
      ['the connection user when the record has no owner', null, CONNECTION_USER],
    ])('%s', async (_name, owner, expected) => {
      const s = await seedSeller({ ownerSfUserId: owner });
      await inbound(s);
      const h = harness();
      await h.run();
      expect(h.org.sf.creates[0]!.fields).toMatchObject({ OwnerId: expected });
    });

    it('a queue-owned record in an org with no stored connection has nobody to own the Task: a not-connected attempt', async () => {
      const s = await seedSeller({ ownerSfUserId: GROUP_OWNER });
      const id = await inbound(s);
      await db.delete(schema.crmConnections).where(eq(schema.crmConnections.orgId, s.orgId));
      const h = harness();
      expect(await h.run()).toEqual({ done: 0, retried: 1, failed: 0 });
      expect((await eventOf(id)).sfLogError).toBe('CrmNotConnectedError');
      expect(h.org.sf.creates).toEqual([]);
    });
  });

  describe('a Lead that was converted', () => {
    async function writeback(s: Seller, convertedOpportunityId: string | null) {
      const user = await seedUser(db, s.orgId);
      const aiCallId = await seedAiCall(db, s.orgId, user);
      await db.insert(schema.aiCallWritebacks).values({ orgId: s.orgId, aiCallId, sfObject: 'Lead', sfRecordId: s.sfRecordId, outcome: 'appointment_set', convertedOpportunityId });
    }

    it('uses the Opportunity the write-back recorded, and never touches the Lead', async () => {
      const s = await seedSeller();
      await writeback(s, OPP);
      const id = await inbound(s);
      const h = harness();
      expect(await h.run()).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(h.org.sf.creates).toHaveLength(1);
      expect(h.org.sf.creates[0]!.fields).toMatchObject({ WhatId: OPP });
      expect(h.org.sf.creates[0]!.fields).not.toHaveProperty('WhoId');
      expect((await eventOf(id)).sfLogStatus).toBe('done');
    });

    it('Review Focus 2: Salesforce refuses the Lead as converted, the Lead is read, the Task is made on its Opportunity in the same attempt', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness(fakeOrg({ converted: OPP }));
      const { store } = h.org;
      h.org.sf.onCreate = (c) => (c.fields.WhoId ? refused('CANNOT_UPDATE_CONVERTED_LEAD', 'converted lead') : ok(store(c)));

      expect(await h.run()).toEqual({ done: 1, retried: 0, failed: 0 });

      expect(h.org.sf.soql.some((q) => q === `SELECT ConvertedOpportunityId FROM Lead WHERE Id = '${s.sfRecordId}'`)).toBe(true);
      expect(h.org.sf.creates.map((c) => c.fields.WhoId ?? c.fields.WhatId)).toEqual([s.sfRecordId, OPP]);
      const row = await eventOf(id);
      expect(row).toMatchObject({ sfLogStatus: 'done', sfTaskId: h.org.tasks[0]!.id, sfLogAttempts: 0 });
    });

    it('a converted Lead with no Opportunity is a failed attempt with the code recorded, and no second create', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness(fakeOrg({ converted: null }));
      h.org.sf.onCreate = () => refused('CANNOT_UPDATE_CONVERTED_LEAD', 'Cannot update a converted lead: Pat Seller');

      expect(await h.run()).toEqual({ done: 0, retried: 1, failed: 0 });

      expect(h.org.sf.creates).toHaveLength(1);
      const row = await eventOf(id);
      expect(row).toMatchObject({ sfLogStatus: 'pending', sfLogAttempts: 1, sfTaskId: null });
      expect(row.sfLogError).toContain('CANNOT_UPDATE_CONVERTED_LEAD');
      // Salesforce's message text is never kept.
      expect(row.sfLogError).not.toContain('Pat Seller');
      expect(row.sfLogError).not.toContain('Cannot update');
    });
  });

  describe('no Task is ever doubled or shared', () => {
    it('two replies with the same subject on one Lead become two Tasks, each event done with its own', async () => {
      const s = await seedSeller();
      const first = await inbound(s, { subject: 'Re: Your home', body: 'First reply.', occurredAt: new Date('2026-10-20T17:00:00.000Z') });
      const second = await inbound(s, { subject: 'Re: Your home', body: 'Second reply.', occurredAt: new Date('2026-10-20T17:05:00.000Z') });
      const h = harness();

      expect(await h.run()).toEqual({ done: 2, retried: 0, failed: 0 });

      expect(h.org.sf.creates).toHaveLength(2);
      const [a, b] = await Promise.all([eventOf(first), eventOf(second)]);
      expect(a.sfTaskId).toBeTruthy();
      expect(b.sfTaskId).toBeTruthy();
      expect(a.sfTaskId).not.toBe(b.sfTaskId);
      expect(new Set([a.sfTaskId, b.sfTaskId])).toEqual(new Set(h.org.tasks.map((x) => x.id)));
      // Each Task carries its own event's words.
      const byId = new Map(h.org.tasks.map((x) => [x.id, x.fields.Description as string]));
      expect(byId.get(a.sfTaskId!)).toContain('First reply.');
      expect(byId.get(b.sfTaskId!)).toContain('Second reply.');
    });

    it('a create whose answer was lost: the retry adopts the Task that was made, no duplicate', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness();
      const { store } = h.org;
      let calls = 0;
      h.org.sf.onCreate = (c) => {
        calls += 1;
        if (calls > 1) return ok(store(c));
        store(c);
        return new Error('socket hang up');
      };

      expect(await h.run()).toEqual({ done: 0, retried: 1, failed: 0 });
      expect(await eventOf(id)).toMatchObject({ sfLogStatus: 'pending', sfLogAttempts: 1, sfLogError: 'Error' });

      expect(await h.run({}, after(2))).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(h.org.sf.creates).toHaveLength(1);
      expect(h.org.tasks).toHaveLength(1);
      expect(await eventOf(id)).toMatchObject({ sfLogStatus: 'done', sfTaskId: h.org.tasks[0]!.id, sfLogError: null });
    });

    it('a lost answer next to a Task another event already owns: the retry skips the owned one and adopts its own', async () => {
      const s = await seedSeller();
      const first = await inbound(s, { subject: 'Re: Your home', occurredAt: new Date('2026-10-20T17:00:00.000Z') });
      const h = harness();
      await h.run();
      const second = await inbound(s, { subject: 'Re: Your home', occurredAt: new Date('2026-10-20T17:05:00.000Z') });
      const { store } = h.org;
      let calls = 0;
      h.org.sf.onCreate = (c) => {
        calls += 1;
        if (calls > 1) return ok(store(c));
        store(c);
        return new Error('socket hang up');
      };

      await h.run({}, after(10));
      expect(await eventOf(second)).toMatchObject({ sfLogStatus: 'pending' });
      await h.run({}, after(20));

      const [a, b] = await Promise.all([eventOf(first), eventOf(second)]);
      expect(h.org.tasks).toHaveLength(2);
      expect(a.sfTaskId).toBe(h.org.tasks[0]!.id);
      expect(b.sfTaskId).toBe(h.org.tasks[1]!.id);
      // The second event's last lookup asked Salesforce to leave the first event's Task out, ten candidates at most, oldest first.
      const lookups = h.org.sf.soql.filter((q) => q.startsWith('SELECT Id, Description FROM Task'));
      expect(lookups[lookups.length - 1]).toContain(`AND Id NOT IN ('${a.sfTaskId}')`);
      expect(lookups[lookups.length - 1]).toMatch(/ORDER BY CreatedDate LIMIT 10$/);
    });
  });

  describe('an event adopts only its own Task', () => {
    it('a lost create answer must not let a same-subject reply adopt the Task: each event ends with its own, exactly two Tasks', async () => {
      const s = await seedSeller();
      const e1 = await inbound(s, { subject: 'Re: Your home', body: 'First reply.', occurredAt: new Date('2026-10-20T17:00:00.000Z') });
      const e2 = await inbound(s, { subject: 'Re: Your home', body: 'Second reply.', occurredAt: new Date('2026-10-20T17:05:00.000Z') });
      const h = harness();
      const { store } = h.org;
      let calls = 0;
      h.org.sf.onCreate = (c) => {
        calls += 1;
        store(c);
        // E1's create succeeds in Salesforce but its answer is lost.
        return calls === 1 ? new Error('socket hang up') : ok(h.org.tasks[h.org.tasks.length - 1]!.id);
      };

      // One tick: E1 (oldest) loses its answer, then E2 looks for a Task and finds E1's T1 waiting, unowned.
      expect(await h.run()).toEqual({ done: 1, retried: 1, failed: 0 });
      const [t1, t2] = h.org.tasks;
      expect(t1!.fields.Description).toContain('First reply.');
      expect(t2!.fields.Description).toContain('Second reply.');
      expect(await eventOf(e2)).toMatchObject({ sfLogStatus: 'done', sfTaskId: t2!.id });
      expect(await eventOf(e1)).toMatchObject({ sfLogStatus: 'pending', sfLogAttempts: 1, sfTaskId: null });

      // E1's retry finds T1 by the tag only it carries, and creates nothing.
      expect(await h.run({}, after(2))).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(h.org.tasks).toHaveLength(2);
      expect(h.org.sf.creates).toHaveLength(2);
      expect(await eventOf(e1)).toMatchObject({ sfLogStatus: 'done', sfTaskId: t1!.id });
    });

    it('the lookup leaves out the conversation\'s 200 most recent stored Task ids, and only ones that look like Salesforce ids', async () => {
      const s = await seedSeller();
      // 205 earlier events, each with its own Task id, one a minute apart; one more holds something that is not an id.
      await t.pool.query(
        `insert into conversation_events (org_id, conversation_id, kind, direction, actor, occurred_at, sf_log_status, sf_task_id)
         select $1, $2, 'email', 'in', 'seller', '2026-10-01T00:00:00Z'::timestamptz + (i || ' minutes')::interval, 'done', '00T8X' || lpad(i::text, 10, '0') || 'AAA'
         from generate_series(1, 205) i`,
        [s.orgId, s.conv.id],
      );
      await t.pool.query(
        `insert into conversation_events (org_id, conversation_id, kind, direction, actor, occurred_at, sf_log_status, sf_task_id)
         values ($1, $2, 'email', 'in', 'seller', '2026-10-01T06:00:00Z', 'done', $3)`,
        [s.orgId, s.conv.id, "x' OR Id != '"],
      );
      await inbound(s);
      const h = harness();
      await h.run();

      const lookup = h.org.sf.soql.find((q) => q.startsWith('SELECT Id, Description FROM Task'))!;
      const ids = excludedBy(lookup);
      // The 200 most recent events are the odd one (newest) and Tasks 205 down to 7: 199 real ids, the odd one dropped.
      expect(ids).toHaveLength(199);
      expect(ids).toContain('00T8X0000000205AAA');
      expect(ids).toContain('00T8X0000000007AAA');
      expect(ids).not.toContain('00T8X0000000006AAA');
      expect(lookup).not.toContain("x'");
    });

    it('a Task id another tenant holds does not stop this event adopting its own Task (the claim is per tenant)', async () => {
      const mine = await seedSeller();
      const theirs = await seedSeller();
      const id = await inbound(mine);
      const h = harness();
      const { store } = h.org;
      let calls = 0;
      h.org.sf.onCreate = (c) => {
        calls += 1;
        if (calls > 1) return ok(store(c));
        store(c);
        return new Error('socket hang up');
      };
      await h.run();
      const own = h.org.tasks[0]!.id;
      // Another tenant's event has stored the very same id (ids are only unique inside one Salesforce org).
      const other = await inbound(theirs);
      await t.pool.query(`update conversation_events set sf_log_status = 'done', sf_log_next_at = null, sf_task_id = $2 where id = $1`, [other, own]);

      expect(await h.run({}, after(2))).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(h.org.tasks).toHaveLength(1);
      expect(await eventOf(id)).toMatchObject({ sfLogStatus: 'done', sfTaskId: own });
    });

    it('two events can never hold one Task: a settle that hits the unique index is a failed attempt, retried later', async () => {
      const s = await seedSeller();
      const first = await inbound(s, { subject: 'Re: one', occurredAt: new Date('2026-10-20T17:00:00.000Z') });
      const second = await inbound(s, { subject: 'Re: two', occurredAt: new Date('2026-10-20T17:05:00.000Z') });
      const h = harness();
      // A Salesforce that hands out the same Task id twice (a bug on its side or ours).
      h.org.sf.onCreate = () => ok('00T8X00000Same01AAA');

      expect(await h.run()).toEqual({ done: 1, retried: 1, failed: 0 });
      expect(await eventOf(first)).toMatchObject({ sfLogStatus: 'done', sfTaskId: '00T8X00000Same01AAA' });
      const row = await eventOf(second);
      expect(row).toMatchObject({ sfLogStatus: 'pending', sfLogAttempts: 1, sfTaskId: null });
      expect(row.sfLogError).toContain('23505');
      assertNoPii(h);
    });
  });

  describe('failures and the backoff', () => {
    it('a client that is not connected counts an attempt each time: 1, 5, 30, 120 and 720 minutes apart, then failed with ONE alert', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness();
      // A still tick clock: the waits count from the failure, which is then the tick's `now`.
      const notConnected = { clients: async () => Promise.reject(new CrmNotConnectedError()), clock: () => 0 };
      const waits = [1, 5, 30, 120, 720];
      let now = T0;

      for (let attempt = 1; attempt < SF_LOG_MAX_ATTEMPTS; attempt += 1) {
        expect(await h.run(notConnected, now)).toEqual({ done: 0, retried: 1, failed: 0 });
        const row = await eventOf(id);
        expect(row).toMatchObject({ sfLogStatus: 'pending', sfLogAttempts: attempt, sfLogError: 'CrmNotConnectedError' });
        const due = new Date(now.getTime() + waits[attempt - 1]! * MINUTE);
        expect(row.sfLogNextAt!.getTime()).toBe(due.getTime());
        // One minute early it is not due.
        expect(await h.run(notConnected, new Date(due.getTime() - MINUTE))).toEqual({ done: 0, retried: 0, failed: 0 });
        now = due;
      }

      expect(h.alert).not.toHaveBeenCalled();
      expect(await h.run(notConnected, now)).toEqual({ done: 0, retried: 0, failed: 1 });
      expect(await eventOf(id)).toMatchObject({ sfLogStatus: 'failed', sfLogAttempts: SF_LOG_MAX_ATTEMPTS, sfLogError: 'CrmNotConnectedError' });
      expect(h.alerts).toEqual([expect.objectContaining({ kind: 'sf_log_failed', orgId: s.orgId, context: { count: 1, eventIds: [id] } })]);

      // A failed event is left alone, and no second alert is raised.
      expect(await h.run(notConnected, after(100_000))).toEqual({ done: 0, retried: 0, failed: 0 });
      expect(h.alert).toHaveBeenCalledTimes(1);
      assertNoPii(h);
    });

    it("an error's message never reaches the row or a log line: only its name (and code)", async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness();
      h.org.sf.onCreate = () => new Error(`Salesforce said ${ADDRESS} and ${SECRET_SUBJECT}`);
      await h.run();
      expect((await eventOf(id)).sfLogError).toBe('Error');
      assertNoPii(h);
    });

    it('one event failing does not stop the next', async () => {
      const bad = await seedSeller();
      const good = await seedSeller();
      const badId = await inbound(bad, { occurredAt: new Date('2026-10-20T17:00:00.000Z') });
      const goodId = await inbound(good, { occurredAt: new Date('2026-10-20T17:01:00.000Z') });
      const h = harness();
      const { store } = h.org;
      h.org.sf.onCreate = (c) => (c.fields.WhoId === bad.sfRecordId ? refused('INSUFFICIENT_ACCESS_OR_READONLY', 'no') : ok(store(c)));
      expect(await h.run()).toEqual({ done: 1, retried: 1, failed: 0 });
      expect((await eventOf(badId)).sfLogError).toBe('WriteRefusedError:INSUFFICIENT_ACCESS_OR_READONLY');
      expect((await eventOf(goodId)).sfLogStatus).toBe('done');
    });

    it('events of one organization failing for good in one tick raise ONE alert: the count and the first five ids', async () => {
      const s = await seedSeller();
      const other = await seedSeller();
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) ids.push(await inbound(s, { subject: `Re: ${i}`, occurredAt: new Date(Date.UTC(2026, 9, 20, 17, i)) }));
      const otherId = await inbound(other, { occurredAt: new Date('2026-10-20T18:00:00.000Z') });
      await t.pool.query('update conversation_events set sf_log_attempts = $1 where id = any($2::uuid[])', [SF_LOG_MAX_ATTEMPTS - 1, [...ids, otherId]]);
      const h = harness();

      expect(await h.run({ clients: async () => Promise.reject(new CrmNotConnectedError()) })).toEqual({ done: 0, retried: 0, failed: 8 });

      expect(h.alerts).toHaveLength(2);
      const bySeller = new Map(h.alerts.map((a) => [a.orgId, a]));
      expect(bySeller.get(s.orgId)).toMatchObject({ kind: 'sf_log_failed', context: { count: 7, eventIds: ids.slice(0, 5) } });
      expect(bySeller.get(other.orgId)).toMatchObject({ kind: 'sf_log_failed', context: { count: 1, eventIds: [otherId] } });
      expect(Object.keys(bySeller.get(s.orgId)!.context!).sort()).toEqual(['count', 'eventIds']);
      assertNoPii(h);
    });

    it('three events failing their 6th attempt together are one alert with a count of 3', async () => {
      const s = await seedSeller();
      const ids = [
        await inbound(s, { subject: 'Re: a', occurredAt: new Date('2026-10-20T17:00:00.000Z') }),
        await inbound(s, { subject: 'Re: b', occurredAt: new Date('2026-10-20T17:01:00.000Z') }),
        await inbound(s, { subject: 'Re: c', occurredAt: new Date('2026-10-20T17:02:00.000Z') }),
      ];
      await t.pool.query('update conversation_events set sf_log_attempts = $1 where id = any($2::uuid[])', [SF_LOG_MAX_ATTEMPTS - 1, ids]);
      const h = harness();
      expect(await h.run({ clients: async () => Promise.reject(new CrmNotConnectedError()) })).toEqual({ done: 0, retried: 0, failed: 3 });
      expect(h.alert).toHaveBeenCalledTimes(1);
      expect(h.alerts[0]).toMatchObject({ kind: 'sf_log_failed', orgId: s.orgId, context: { count: 3, eventIds: ids } });
    });

    it('a tick that throws after an event failed for good still sends that event\'s alert (the alerts go out in a finally)', async () => {
      const failing = await seedSeller();
      const next = await seedSeller();
      const failedId = await inbound(failing, { occurredAt: new Date('2026-10-20T17:00:00.000Z') });
      const nextId = await inbound(next, { occurredAt: new Date('2026-10-20T17:01:00.000Z') });
      await t.pool.query('update conversation_events set sf_log_attempts = $2 where id = $1', [failedId, SF_LOG_MAX_ATTEMPTS - 1]);
      const h = harness();
      // The database refuses the next event's lease RENEWAL (a lease past the claim's T0 + 10 min; the tick clock moves a
      // minute per event), so the tick throws mid-batch after the first event has failed for good.
      await t.pool.query(`create or replace function test_block_next_lease() returns trigger language plpgsql as $$
        begin
          if new.id = '${nextId}'::uuid and new.sf_log_next_at > '${after(10).toISOString()}'::timestamptz then raise exception 'blocked for the test'; end if;
          return new;
        end $$`);
      await t.pool.query('create trigger test_block_next_lease before update on conversation_events for each row execute function test_block_next_lease()');
      try {
        const clients = async (orgId: string) => (orgId === failing.orgId ? Promise.reject(new CrmNotConnectedError()) : h.org.sf.client);
        let tick = 0;
        const clock = () => (tick += MINUTE);
        await expect(h.run({ clients, clock })).rejects.toThrow();
      } finally {
        await t.pool.query('drop trigger test_block_next_lease on conversation_events');
      }
      expect((await eventOf(failedId)).sfLogStatus).toBe('failed');
      expect(h.alerts).toEqual([expect.objectContaining({ kind: 'sf_log_failed', orgId: failing.orgId, context: { count: 1, eventIds: [failedId] } })]);
    });

    it('the backoff counts from the tick clock, not the tick\'s start: a failure 4 minutes into a slow batch waits 1 minute from then', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness();
      const clock = vi.fn<() => number>().mockReturnValueOnce(1_000).mockReturnValue(1_000 + 4 * MINUTE);
      expect(await h.run({ clock, clients: async () => Promise.reject(new CrmNotConnectedError()) })).toEqual({ done: 0, retried: 1, failed: 0 });
      expect((await eventOf(id)).sfLogNextAt!.getTime()).toBe(after(4 + 1).getTime());
    });

    it('an alert that throws does not break the tick', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      await t.pool.query('update conversation_events set sf_log_attempts = $2 where id = $1', [id, SF_LOG_MAX_ATTEMPTS - 1]);
      const h = harness();
      const failing = { clients: async () => Promise.reject(new CrmNotConnectedError()), alert: async () => Promise.reject(new Error('webhook down')) };
      expect(await h.run(failing)).toEqual({ done: 0, retried: 0, failed: 1 });
      expect((await eventOf(id)).sfLogStatus).toBe('failed');
      expect(h.log.error).toHaveBeenCalled();
    });
  });

  describe('what the tick may pick up', () => {
    it('never a practice conversation, even an event forced to pending', async () => {
      const s = await seedSeller();
      const admin = await seedUser(db, s.orgId);
      const practice = await ensureConversation(db, { orgId: s.orgId, crmRecordId: s.crmRecordId, practiceUserId: admin });
      const id = await appendEvent(db, { orgId: s.orgId, conversationId: practice.id, kind: 'email', direction: 'in', actor: 'seller', subject: 'x', body: 'y', sfLog: true });
      // appendEvent already refuses to log it; force the worst case the store should have made impossible.
      expect((await eventOf(id)).sfLogStatus).toBe('skipped');
      await t.pool.query(`update conversation_events set sf_log_status = 'pending', sf_log_next_at = now() where id = $1`, [id]);
      const h = harness();
      expect(await h.run()).toEqual({ done: 0, retried: 0, failed: 0 });
      expect(h.org.sf.creates).toEqual([]);
      expect((await eventOf(id)).sfLogStatus).toBe('pending');
    });

    it('not a skipped event, and not a pending one whose time has not come', async () => {
      const s = await seedSeller();
      const skipped = await appendEvent(db, { orgId: s.orgId, conversationId: s.conv.id, kind: 'handler', direction: 'none', actor: 'system', detail: 'taken_over', sfLog: false });
      const later = await inbound(s);
      await t.pool.query(`update conversation_events set sf_log_next_at = $2 where id = $1`, [later, after(30)]);
      const h = harness();
      expect(await h.run()).toEqual({ done: 0, retried: 0, failed: 0 });
      expect(h.org.sf.creates).toEqual([]);
      expect((await eventOf(skipped)).sfLogStatus).toBe('skipped');
      expect(await h.run({}, after(30))).toEqual({ done: 1, retried: 0, failed: 0 });
    });

    it('a claimed event is leased for 10 minutes: a tick that starts meanwhile leaves it alone', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness();
      let meanwhile: SfLogCounts | undefined;
      // While the first tick is out talking to Salesforce, a second one starts nine minutes later.
      const during = {
        clients: async () => {
          meanwhile = await h.run({}, after(9));
          return h.org.sf.client;
        },
      };
      expect(await h.run(during)).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(meanwhile).toEqual({ done: 0, retried: 0, failed: 0 });
      expect(h.org.sf.creates).toHaveLength(1);
      expect((await eventOf(id)).sfLogStatus).toBe('done');
    });

    it('an event whose lease ran out (its tick died) is taken again', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness();
      await t.pool.query(`update conversation_events set sf_log_next_at = $2 where id = $1`, [id, after(10)]);
      expect(await h.run({}, after(9))).toEqual({ done: 0, retried: 0, failed: 0 });
      expect(await h.run({}, after(10))).toEqual({ done: 1, retried: 0, failed: 0 });
    });

    it('two ticks running at once log each event once', async () => {
      const sellers = await Promise.all([seedSeller(), seedSeller(), seedSeller(), seedSeller()]);
      const ids = await Promise.all(sellers.map((s) => inbound(s)));
      const h = harness();
      const [a, b] = await Promise.all([h.run({ batch: 2 }), h.run({ batch: 2 })]);
      expect(a.done + b.done).toBe(4);
      expect(h.org.sf.creates).toHaveLength(4);
      const rows = await Promise.all(ids.map(eventOf));
      expect(new Set(rows.map((r) => r.sfTaskId)).size).toBe(4);
    });

    it('takes at most `batch` events a tick, oldest first', async () => {
      const s = await seedSeller();
      const older = await inbound(s, { subject: 'Re: one', occurredAt: new Date('2026-10-20T17:00:00.000Z') });
      const newer = await inbound(s, { subject: 'Re: two', occurredAt: new Date('2026-10-20T17:05:00.000Z') });
      await t.pool.query(`update conversation_events set sf_log_next_at = $2 where id = $1`, [older, new Date(T0.getTime() - 3 * MINUTE)]);
      await t.pool.query(`update conversation_events set sf_log_next_at = $2 where id = $1`, [newer, new Date(T0.getTime() - MINUTE)]);
      const h = harness();
      expect(await h.run({ batch: 1 })).toEqual({ done: 1, retried: 0, failed: 0 });
      expect((await eventOf(older)).sfLogStatus).toBe('done');
      expect((await eventOf(newer)).sfLogStatus).toBe('pending');
    });

    it('right before an event is worked its lease is renewed (from the tick clock): a slow batch does not lose its later rows', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness();
      // The tick clock reads 0 at the start and 4 minutes when the event comes up.
      const clock = vi.fn<() => number>().mockReturnValueOnce(1_000).mockReturnValue(1_000 + 4 * MINUTE);
      let during: Date | null = null;
      const watching = {
        clock,
        clients: async () => {
          during = (await eventOf(id)).sfLogNextAt;
          return h.org.sf.client;
        },
      };
      expect(await h.run(watching)).toEqual({ done: 1, retried: 0, failed: 0 });
      expect(during!.getTime()).toBe(after(14).getTime());
    });

    it('a row whose lease was taken over between the claim and its turn is skipped: nothing is created for it', async () => {
      const first = await seedSeller();
      const second = await seedSeller();
      const firstId = await inbound(first, { occurredAt: new Date('2026-10-20T17:00:00.000Z') });
      const secondId = await inbound(second, { occurredAt: new Date('2026-10-20T17:01:00.000Z') });
      const h = harness();
      const stolen = after(500);
      // While the first event is worked, another tick takes the second one over.
      const stealing = {
        clients: async (orgId: string) => {
          if (orgId === first.orgId) await t.pool.query(`update conversation_events set sf_log_next_at = $2 where id = $1`, [secondId, stolen]);
          return h.org.sf.client;
        },
      };

      expect(await h.run(stealing)).toEqual({ done: 1, retried: 0, failed: 0 });

      expect(h.org.sf.creates).toHaveLength(1);
      expect(h.org.sf.creates[0]!.fields).toMatchObject({ WhoId: first.sfRecordId });
      expect((await eventOf(firstId)).sfLogStatus).toBe('done');
      const row = await eventOf(secondId);
      expect(row).toMatchObject({ sfLogStatus: 'pending', sfTaskId: null, sfLogAttempts: 0 });
      expect(row.sfLogNextAt!.getTime()).toBe(stolen.getTime());
    });

    it('a tick whose lease was taken over settles nothing and counts nothing', async () => {
      const s = await seedSeller();
      const id = await inbound(s);
      const h = harness();
      const { store } = h.org;
      const stolen = after(500);
      h.org.sf.onCreate = (c) => {
        // While this tick talks to Salesforce, another tick re-leases the event (this one ran past its lease).
        store(c);
        return ok(h.org.tasks[0]!.id);
      };
      const stealing = {
        clients: async () => {
          await t.pool.query(`update conversation_events set sf_log_next_at = $2 where id = $1`, [id, stolen]);
          return h.org.sf.client;
        },
      };
      expect(await h.run(stealing)).toEqual({ done: 0, retried: 0, failed: 0 });
      const row = await eventOf(id);
      expect(row).toMatchObject({ sfLogStatus: 'pending', sfTaskId: null });
      expect(row.sfLogNextAt!.getTime()).toBe(stolen.getTime());
    });
  });

  describe('logs', () => {
    it('carry ids and counts only', async () => {
      const s = await seedSeller();
      await inbound(s);
      const h = harness();
      await h.run();
      assertNoPii(h);
      const tickLine = h.log.info.mock.calls.find(([obj]) => (obj as { claimed?: number }).claimed !== undefined);
      expect(tickLine?.[0]).toMatchObject({ claimed: 1, done: 1, retried: 0, failed: 0 });
    });
  });
});
