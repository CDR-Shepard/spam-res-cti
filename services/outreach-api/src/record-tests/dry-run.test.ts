/**
 * Real Postgres + fake Salesforce: "What would be written to Salesforce" for a record test call (plan 1E Task 11). The
 * write-back's plan and texts are built from reads alone; the fake org records every request, so a test proves nothing was
 * sent (G-7). The result is stored on the call row, so a second press costs nothing.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { RecordTestDryRun, type BookedAppointment } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { addSpend } from '../ai/budget.js';
import { seedAiCall } from '../test/ai-call-seed.js';
import { ctxOf, seedUser } from '../test/call-plan-seed.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { RT_LEAD, RT_OPP } from '../test/record-test-org.js';
import { fakeModel, fakeOrg, GRANT, PHONE_BOOKING, quiet, SETTER, transportError, type OrgState } from '../test/writeback-harness.js';
import { DescribeCache } from '../research/describe.js';
import type { MappingModel } from '../writeback/mapping-model.js';
import { dryRunTestCall } from './dry-run.js';
import { CLAIM_STALE_MS, claimDryRun, releaseDryRun } from './dry-run-store.js';
import { insertRecordTest } from './store.js';

const NOW = new Date('2026-10-06T22:20:00.000Z');
const ENDED = new Date('2026-10-06T22:12:00.000Z');

/** Booking with a Lead's conversion on, and write-back on (1D: both are off until an admin turns them on). */
const BOOKING_ON = {
  enabled: true, specialists: [GRANT], convertLeads: true, days: [1, 2, 3, 4, 5],
  phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 },
  walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 },
};
const ALL_ON = { aiCallWriteback: true, aiCallBooking: BOOKING_ON };
const WRITEBACK_OFF = 'Write-back was off, so a real call would have written none of this to Salesforce (and offered no times). This is what it would write with write-back on.';

const snapshotWith = (field: string, value: string) => ({ records: [{ relation: 'self', fields: [{ name: field, label: field, value }] }] });

function orgState(sfObject: 'Lead' | 'Opportunity'): OrgState {
  const record =
    sfObject === 'Opportunity'
      ? { Name: 'Oak Street', OwnerId: SETTER, StageName: 'Closed Lost', Rating__c: null, Timeline__c: "Didn't Ask", LastModifiedDate: '2026-10-01T12:00:00.000+0000' }
      : { Name: 'Pat Seller', OwnerId: SETTER, Status: 'Working', IsConverted: false, Street: '12 Oak St', City: 'Fresno', State: 'CA', PostalCode: '93701', LastModifiedDate: '2026-10-01T12:00:00.000+0000' };
  return { records: new Map([[sfObject === 'Lead' ? RT_LEAD : RT_OPP, record]]), lead: null, busy: [], convertedBy: { id: SETTER, at: '2026-01-01T00:00:00.000+0000' } };
}

describe.skipIf(!pgLane)('dryRunTestCall (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  interface Setup {
    sfObject?: 'Lead' | 'Opportunity'; outcome?: string; status?: string; appointment?: BookedAppointment | null; model?: MappingModel | null;
    settings?: Record<string, unknown>;
  }
  async function setup(o: Setup = {}) {
    const sfObject = o.sfObject ?? 'Opportunity';
    const sfRecordId = sfObject === 'Lead' ? RT_LEAD : RT_OPP;
    const orgId = await seedOrg(db, o.settings ?? ALL_ON);
    const admin = await seedUser(db, orgId);
    const testId = await insertRecordTest(db, { orgId, requestedBy: admin, sfObject, sfRecordId });
    const research = sfObject === 'Lead' ? snapshotWith('Status', 'Working') : snapshotWith('StageName', 'Closed Lost');
    await db.update(schema.aiRecordTests).set({ status: 'ready', research, completedAt: NOW }).where(eq(schema.aiRecordTests.id, testId));
    const aiCallId = await seedAiCall(db, orgId, admin, {
      status: o.status ?? 'completed', outcome: o.outcome ?? 'appointment_set', sfObject, sfRecordId, isTest: true, practice: true,
      toE164: '+15125550111', endedAt: ENDED, appointment: o.appointment === undefined ? PHONE_BOOKING : o.appointment,
      summary: 'Pat wants to sell in about three months.', qualification: { timeline: 'about 90 days' },
      transcript: [{ role: 'caller', text: 'Probably in about 90 days.', at: ENDED.toISOString() }],
    });
    const [call] = await db.insert(schema.aiRecordTestCalls)
      .values({ orgId, recordTestId: testId, requestedBy: admin, mode: 'phone', toE164: '+15125550111', idempotencyKey: `rtest:${crypto.randomUUID()}`, aiCallId, result: { result: 'placed', aiCallId } })
      .returning({ id: schema.aiRecordTestCalls.id });
    const f = fakeOrg(orgState(sfObject));
    const model = o.model === undefined ? fakeModel() : o.model;
    const deps = { db, clients: async () => f.client, model, describes: new DescribeCache(), now: NOW, log: quiet, resultsBaseUrl: 'https://outreach.example' };
    return { orgId, admin, testId, callId: call!.id, f, model, deps, ctx: ctxOf(orgId, admin, true) };
  }
  const sent = (f: ReturnType<typeof fakeOrg>) => f.log.filter((l) => l !== 'query' && l !== 'describe');
  const stored = async (callId: string) => (await db.select().from(schema.aiRecordTestCalls).where(eq(schema.aiRecordTestCalls.id, callId)))[0]!.dryRun;

  it('1: an Opportunity that booked: Stage → Appointment Set, the Event it would create, and only reads were sent (G-7)', async () => {
    const s = await setup();
    const out = await dryRunTestCall(s.deps, s.ctx, s.callId);
    if (!('ok' in out) || !out.ok) throw new Error(`refused: ${JSON.stringify(out)}`);
    const d = RecordTestDryRun.parse(out.dryRun);
    expect(d.status).toBe('ready');
    expect(d.changes).toContainEqual({ label: 'Stage', before: 'Closed Lost', after: 'Appointment Set', kind: 'changed' });
    expect(d.wouldCreate).toContain('Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden');
    expect(d.wouldCreate).toContain('Chatter post');
    expect(d.changesText).toContain('Stage: Closed Lost → Appointment Set');
    expect(d.chatterText).toContain(`Call details: https://outreach.example/test-record?id=${s.testId}`);
    expect(d.conversion).toBeNull();
    expect(sent(s.f)).toEqual([]);
    expect(s.f.soapBodies).toEqual([]);
    expect(await stored(s.callId)).toEqual(out.dryRun);
  });

  it('2: a Lead that booked: the conversion line, and no conversion is sent', async () => {
    const s = await setup({ sfObject: 'Lead' });
    const out = await dryRunTestCall(s.deps, s.ctx, s.callId);
    if (!('ok' in out) || !out.ok) throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.dryRun.conversion).toMatch(/^Would convert this Lead \(owner Grant Golden, Lead Manager .+\) and write the rest to the new Opportunity\. The field list below is the Lead-side approximation\.$/);
    expect(out.dryRun.wouldCreate).toContain('Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden');
    expect(sent(s.f)).toEqual([]);
    expect(s.f.soapBodies).toEqual([]);
  });

  it("2b: a Lead that booked with conversion at its 1D default (off): no conversion line, the hold on Grant's calendar and his Task", async () => {
    const s = await setup({ sfObject: 'Lead', settings: { aiCallWriteback: true } });
    const out = await dryRunTestCall(s.deps, s.ctx, s.callId);
    if (!('ok' in out) || !out.ok) throw new Error(`refused: ${JSON.stringify(out)}`);
    expect(out.dryRun.conversion).toBeNull();
    expect(out.dryRun.wouldCreate).toEqual([
      "Hold on Grant Golden's calendar: Wed Oct 7, 11:00 AM PT", 'Task to Grant Golden: convert the Lead and book it', 'Chatter post',
    ]);
    expect(out.dryRun.note).toBeNull();
    expect(sent(s.f)).toEqual([]);
  });

  it('11: write-back off (the 1D default): the same changes, with the note that a real call would write none of them', async () => {
    const on = await setup();
    const off = await setup({ settings: {} });
    const [a, b] = [await dryRunTestCall(on.deps, on.ctx, on.callId), await dryRunTestCall(off.deps, off.ctx, off.callId)];
    if (!('ok' in a) || !a.ok || !('ok' in b) || !b.ok) throw new Error('refused');
    expect(a.dryRun.note).toBeNull();
    expect(b.dryRun.note).toBe(WRITEBACK_OFF);
    expect(b.dryRun.changes).toEqual(a.dryRun.changes);
    const failing: MappingModel = { modelId: 'claude-sonnet-5-5', map: async () => { throw new Error('overloaded'); } };
    const both = await setup({ settings: {}, model: failing });
    expect(await dryRunTestCall(both.deps, both.ctx, both.callId)).toMatchObject({ ok: true, dryRun: { note: `Couldn't map the seller's answers; status moves only. ${WRITEBACK_OFF}` } });
  });

  it('3: a voicemail writes nothing: no model call and no Salesforce read', async () => {
    const s = await setup({ outcome: 'voicemail', appointment: null });
    const out = await dryRunTestCall(s.deps, s.ctx, s.callId);
    expect(out).toMatchObject({ ok: true, dryRun: { status: 'nothing', note: 'A real call that ended this way writes nothing to Salesforce.', changes: [] } });
    expect((s.model as ReturnType<typeof fakeModel>).calls).toBe(0);
    expect(s.f.log).toEqual([]);
  });

  it('4: a call still going is not_finished, and nothing is stored', async () => {
    const s = await setup({ status: 'in_progress', outcome: undefined });
    expect(await dryRunTestCall(s.deps, s.ctx, s.callId)).toEqual({ ok: false, error: 'not_finished' });
    expect(await stored(s.callId)).toBeNull();
  });

  it('5: pressed twice: one model call and the same stored answer', async () => {
    const s = await setup();
    const first = await dryRunTestCall(s.deps, s.ctx, s.callId);
    const second = await dryRunTestCall(s.deps, s.ctx, s.callId);
    expect(second).toEqual(first);
    expect((s.model as ReturnType<typeof fakeModel>).calls).toBe(1);
  });

  it('6: the mapping model failing still gives the status moves, with the note', async () => {
    const failing: MappingModel = { modelId: 'claude-sonnet-5-5', map: async () => { throw new Error('overloaded'); } };
    const s = await setup({ model: failing });
    const out = await dryRunTestCall(s.deps, s.ctx, s.callId);
    if (!('ok' in out) || !out.ok) throw new Error('refused');
    expect(out.dryRun).toMatchObject({ status: 'ready', note: "Couldn't map the seller's answers; status moves only." });
    expect(out.dryRun.changes).toContainEqual({ label: 'Stage', before: 'Closed Lost', after: 'Appointment Set', kind: 'changed' });
    expect(out.dryRun.changesText).toContain('Fill-blanks skipped');
  });

  it('8: two presses at once make one model call: the second is told it is running, then reads the stored answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const model = fakeModel();
    const slow: MappingModel & { calls: number } = Object.assign(model, { map: async (...a: Parameters<MappingModel['map']>) => { const out = await fakeModel().map(...a); model.calls += 1; await gate; return out; } });
    const s = await setup({ model: slow });
    const first = dryRunTestCall(s.deps, s.ctx, s.callId);
    await new Promise((r) => setTimeout(r, 50));
    expect(await dryRunTestCall(s.deps, s.ctx, s.callId)).toEqual({ ok: false, error: 'running' });
    release();
    const done = await first;
    expect(done).toMatchObject({ ok: true, dryRun: { status: 'ready' } });
    expect(await dryRunTestCall(s.deps, s.ctx, s.callId)).toEqual(done);
    expect(slow.calls).toBe(1);
  });

  it('9: Salesforce failing after the model answered: salesforce_error, and the retry reuses the stored answers (one paid call)', async () => {
    const s = await setup();
    let down = true;
    s.f.queries.unshift([/^SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User/, () => { if (down) throw transportError(); return []; }]);
    expect(await dryRunTestCall(s.deps, s.ctx, s.callId)).toEqual({ ok: false, error: 'salesforce_error' });
    expect(await stored(s.callId)).toMatchObject({ pending: true, mapping: { failed: false } });
    down = false;
    s.f.queries.shift();
    const again = await dryRunTestCall(s.deps, s.ctx, s.callId);
    expect(again).toMatchObject({ ok: true, dryRun: { status: 'ready' } });
    expect((s.model as ReturnType<typeof fakeModel>).calls).toBe(1);
    expect(again).toMatchObject({ dryRun: { changes: expect.arrayContaining([{ label: 'Timeline', before: "Didn't Ask", after: '90 Days', kind: 'changed' }]) } });
  });

  it('10: a failure that is not Salesforce (a model with no price) is failed, not salesforce_error, and can be pressed again', async () => {
    const unpriced: MappingModel = { modelId: 'nope', map: async (...a) => ({ ...(await fakeModel().map(...a)), usage: { inputTokens: 1, outputTokens: 1, model: 'not-a-priced-model' } }) };
    const s = await setup({ model: unpriced });
    expect(await dryRunTestCall(s.deps, s.ctx, s.callId)).toEqual({ ok: false, error: 'failed' });
    expect(await dryRunTestCall({ ...s.deps, model: fakeModel() }, s.ctx, s.callId)).toMatchObject({ ok: true, dryRun: { status: 'ready' } });
  });

  it('12: a press that fails late releases only its own claim, never the claim of the press that took over from it', async () => {
    const s = await setup();
    const later = (ms: number) => new Date(NOW.getTime() + ms);
    const takeover = later(CLAIM_STALE_MS + 60_000);
    expect(await claimDryRun(db, s.orgId, s.callId, NOW)).toMatchObject({ claimed: true });
    expect(await claimDryRun(db, s.orgId, s.callId, takeover)).toMatchObject({ claimed: true });
    await releaseDryRun(db, s.orgId, s.callId, NOW);
    expect(await claimDryRun(db, s.orgId, s.callId, later(CLAIM_STALE_MS + 61_000))).toEqual({ claimed: false, done: null });
    await releaseDryRun(db, s.orgId, s.callId, takeover);
    expect(await claimDryRun(db, s.orgId, s.callId, later(CLAIM_STALE_MS + 62_000))).toMatchObject({ claimed: true });
  });

  it("7: another org's call is not_found (G-8)", async () => {
    const s = await setup();
    const other = await seedOrg(db);
    const stranger = await seedUser(db, other);
    expect(await dryRunTestCall(s.deps, ctxOf(other, stranger, true), s.callId)).toEqual({ ok: false, error: 'not_found' });
    expect(s.f.log).toEqual([]);
  });

  it('no mapping model is no_model; a spent budget is refused before any read', async () => {
    const none = await setup({ model: null });
    expect(await dryRunTestCall(none.deps, none.ctx, none.callId)).toEqual({ ok: false, error: 'no_model' });
    const spent = await setup();
    await addSpend(db, spent.orgId, NOW, 1_000_000_000);
    expect(await dryRunTestCall(spent.deps, spent.ctx, spent.callId)).toEqual({ ok: false, refusal: { code: 'AI_BUDGET_SPENT' } });
    expect(spent.f.log).toEqual([]);
  });
});

describe('dry-run.ts imports nothing that writes', () => {
  it('never imports the write steps, the Event/Task creates or the conversion', () => {
    for (const file of ['./dry-run.ts', './dry-run-store.ts', './dry-run-words.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const imports = [...source.matchAll(/^import[^;]+from '([^']+)';/gm)].map((m) => m[0]);
      expect(imports.join('\n')).not.toMatch(/steps-write|writeback\/appointment|convertStep|patch\.js|row-run/);
    }
  });
});
