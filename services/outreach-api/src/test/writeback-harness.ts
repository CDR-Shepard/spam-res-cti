/**
 * Plan 1D `ai_call.writeback` tests (real Postgres): a counted AI call with its write-back row (enqueued by the real SQL), and
 * a fake Salesforce org that remembers what was written: the record, the Lead's conversion, the Events, Tasks and FeedItems.
 */
import { eq, sql } from 'drizzle-orm';
import type { AiCallBookingSettings, BookedAppointment } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceApiError, type SObjectDescribe } from '@cti/salesforce';
import { DescribeCache } from '../research/describe.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import type { MappedAnswers, MappingModel } from '../writeback/mapping-model.js';
import type { WritebackDeps } from '../writeback/run.js';
import { enqueueWritebackSql } from '../writeback/store.js';
import { seedAiCall, seedReleasedLead } from './ai-call-seed.js';
import { seedAiCallCampaign, seedUser } from './call-plan-seed.js';
import { convertOk, fakeSfWrites, userInfoAnswer, type FakeSfWrites } from './fake-sf-writes.js';
import { prodDescribe } from './writeback-describes.js';

type Row = Record<string, unknown>;

export const GRANT = '0058X00000Fsx39QAB';
/** A booking blob an admin turned on (final review WEB I-2: the defaults are off), Grant as the appointment owner. */
export const BOOKING_ON: AiCallBookingSettings = { ...DEFAULT_AI_CALL_BOOKING, enabled: true, convertLeads: true, specialists: [GRANT] };
/** The settings of a tenant that turned write-back, booking and conversion on. */
export const WRITEBACK_ON = { aiCallWriteback: true, aiCallBooking: BOOKING_ON } as const;
export const SETTER = '0058X00000Setr1QAA';
export const US = '0058X0000Integ1QAA';
export const NEW_OPP = '0068X00000NewOpQAA';
export const ACCOUNT = '0018X00000Acct1QAA';
export const CONTACT = '0038X00000Cont1QAA';
export const CALL_ENDED = new Date('2026-10-06T22:12:00.000Z');
export const RUN_AT = new Date('2026-10-06T22:20:00.000Z');
export const quiet = { info: () => {}, warn: () => {}, error: () => {} };

export const PHONE_BOOKING: BookedAppointment = {
  slotId: 'p1',
  kind: 'phone',
  start: '2026-10-07T18:00:00.000Z',
  end: '2026-10-07T18:15:00.000Z',
  specialistSfUserId: GRANT,
  addressConfirmed: false,
  note: '',
  bookedAt: '2026-10-06T22:05:00.000Z',
};

const CARRY_SPECS: Array<[string, string]> = [
  ['AI_Call_Consent__c', 'boolean'],
  ['AI_Call_Consent_Date__c', 'date'],
  ['AI_Call_Consent_Source__c', 'picklist'],
];
const withFields = (d: SObjectDescribe, extra: Array<[string, string]>): SObjectDescribe => ({
  ...d,
  fields: [...d.fields, ...extra.map(([name, type]) => ({ name, type, label: name, updateable: true, calculated: false }))],
});

export interface SeedInput {
  sfObject: 'Lead' | 'Opportunity';
  outcome: string;
  /** Status (Lead) or StageName (Opportunity) as the plan's research saw it. */
  researchStatus: string;
  appointment?: BookedAppointment | null;
  settings?: Record<string, unknown>;
  summary?: string;
}

let n = 0;
/** A counted real AI call on a fresh tenant, its write-back row enqueued by enqueueWritebackSql. */
export async function seedWriteback(db: Db, s: SeedInput): Promise<{ orgId: string; campaignId: string; aiCallId: string; writebackId: string; recordId: string }> {
  n += 1;
  const base = await seedAiCallCampaign(db, 'active');
  // Final review WEB I-2: write-back, booking and conversion are off by default; these tenants have turned them on.
  await db.update(schema.organizations).set({ settings: { ...WRITEBACK_ON, ...(s.settings ?? {}) } }).where(eq(schema.organizations.id, base.orgId));
  const recordId = s.sfObject === 'Lead' ? `00Q8X${String(n).padStart(10, '0')}AAA` : `0068X${String(n).padStart(10, '0')}AAA`;
  const lead = await seedReleasedLead(db, base, { recordOver: { sfObject: s.sfObject, sfRecordId: recordId } });
  const statusName = s.sfObject === 'Lead' ? 'Status' : 'StageName';
  const fields = [{ name: 'Name', label: 'Name', value: 'Jane Seller' }, { name: statusName, label: statusName, value: s.researchStatus }];
  await db.execute(sql`update call_research set snapshot = jsonb_set(snapshot, '{records,0,fields}', ${JSON.stringify(fields)}::jsonb) where id = ${lead.researchId}::uuid`);
  const handoff = await seedUser(db, base.orgId, { displayName: 'Evren Rep' });
  const aiCallId = await seedAiCall(db, base.orgId, lead.approver, {
    status: 'completed',
    outcome: s.outcome,
    sfObject: s.sfObject,
    sfRecordId: recordId,
    endedAt: CALL_ENDED,
    handoffUserId: handoff,
    appointment: s.appointment ?? null,
    summary: s.summary ?? 'Jane wants to sell within about three months. See https://example.com/listing for photos.',
    qualification: { timeline: 'about 90 days' },
    transcript: [
      { role: 'agent', text: 'When are you hoping to sell?', at: CALL_ENDED.toISOString() },
      { role: 'caller', text: 'Probably in about 90 days, we are moving.', at: CALL_ENDED.toISOString() },
    ],
  });
  await db.update(schema.touches).set({ status: 'sent', aiCallId, sentAt: CALL_ENDED, countedAt: CALL_ENDED, outcome: s.outcome }).where(eq(schema.touches.id, lead.touchId));
  await db.execute(enqueueWritebackSql({ touchId: lead.touchId, now: CALL_ENDED, writebackOn: true }));
  const [row] = await db.select({ id: schema.aiCallWritebacks.id }).from(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.aiCallId, aiCallId));
  return { orgId: base.orgId, campaignId: base.campaignId, aiCallId, writebackId: row!.id, recordId };
}

export interface OrgState {
  /** The record as Salesforce has it now, by id; missing = deleted. */
  records: Map<string, Row>;
  /** The Lead's conversion fields (the converting read). */
  lead: Row | null;
  busy: Row[];
  /** The Opportunity's Account is a Person Account (M8); default false. */
  personAccount?: boolean;
  /** Who created the converted Opportunity (and their name, when Salesforce returns it), and when. */
  convertedBy: { id: string; at: string; name?: string };
}

/** A fake org: the describes of production plus the carry fields, and stateful reads over what the test has written. */
export function fakeOrg(state: OrgState): FakeSfWrites {
  const f = fakeSfWrites({
    describes: {
      Lead: withFields(prodDescribe('Lead'), CARRY_SPECS),
      Opportunity: withFields(prodDescribe('Opportunity'), [...CARRY_SPECS, ['Spanish_Speaker__c', 'boolean'], ['LeadManager__c', 'reference']]),
      Account: {
        name: 'Account',
        fields: [
          { name: 'Id', type: 'id', label: 'Account ID', updateable: false, calculated: false },
          { name: 'IsPersonAccount', type: 'boolean', label: 'Is Person Account', updateable: false, calculated: false },
          { name: 'PersonDoNotCall', type: 'boolean', label: 'Do Not Call', updateable: true, calculated: false },
        ],
      },
    },
  });
  const idIn = (q: string): string => /WHERE Id = '([^']+)'/.exec(q)?.[1] ?? '';
  const created = (sobject: string) => f.creates.filter((c) => c.sobject === sobject);
  f.queries.push(
    [/^SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User/, [{ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles' }]],
    [/^SELECT Id, IsActive FROM User/, (q) => [{ Id: idIn(q), IsActive: idIn(q) === SETTER }]],
    [/^SELECT MasterLabel, SortOrder FROM LeadStatus/, [{ MasterLabel: 'Qualified', SortOrder: 6 }]],
    [/^SELECT Id, Name, OwnerId, IsConverted, ConvertedOpportunityId/, () => (state.lead ? [{ ...state.lead }] : [])],
    [/^SELECT Id, CreatedById, CreatedBy\.Name, CreatedDate FROM Opportunity/, (q) => [{ Id: idIn(q), CreatedById: state.convertedBy.id, CreatedBy: state.convertedBy.name ? { Name: state.convertedBy.name } : null, CreatedDate: state.convertedBy.at }]],
    [/^SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event/, () => state.busy],
    [/^SELECT Id FROM Event WHERE WhatId = '/, (q) => created('Event').filter((c) => q.includes(`'${String(c.fields.WhatId)}'`)).map((_c, i) => ({ Id: `00U8X0000000${i}0AAA` }))],
    [/^SELECT Id FROM Event WHERE WhatId = null/, () => created('Event').filter((c) => !('WhatId' in c.fields)).map(() => ({ Id: '00U8X00000Hold1QAA' }))],
    [/^SELECT Id FROM Task /, (q) => created('Task').filter((c) => q.includes(String(c.fields.Subject).replace(/'/g, "\\'"))).map(() => ({ Id: '00T8X00000Task1QAA' }))],
    [/^SELECT ContactId FROM OpportunityContactRole/, [{ ContactId: CONTACT }]],
    // The posts made on the record so far, newest first (a create whose answer was lost is still in Salesforce).
    [/^SELECT Id, Body FROM FeedItem WHERE ParentId = '/, (q) =>
      created('FeedItem')
        .filter((c) => q.includes(`'${String(c.fields.ParentId)}'`))
        .map((c, i) => ({ Id: `0D58X00000000${i}0AAA`, Body: c.fields.Body }))
        .reverse()],
    [/^SELECT AccountId, Account\.IsPersonAccount FROM Opportunity/, [{ AccountId: ACCOUNT, Account: { IsPersonAccount: state.personAccount === true } }]],
    [/ FROM (Lead|Opportunity) WHERE Id = /, (q) => {
      const rec = state.records.get(idIn(q));
      return rec ? [{ Id: idIn(q), ...rec }] : [];
    }],
  );
  f.onSoap = (body) => {
    if (body.includes('getUserInfo')) return userInfoAnswer(US);
    const leadId = /<urn:leadId>([^<]+)</.exec(body)?.[1] ?? '';
    state.lead = { ...state.lead, IsConverted: true, ConvertedOpportunityId: NEW_OPP, ConvertedAccountId: ACCOUNT, ConvertedContactId: CONTACT };
    state.convertedBy = { id: US, at: '2026-10-06T22:20:01.000+0000' };
    return convertOk({ leadId, accountId: ACCOUNT, contactId: CONTACT, opportunityId: NEW_OPP });
  };
  return f;
}

/** A mapping model that always answers Timeline 90 Days from the caller's line; `null` = no model configured. */
export function fakeModel(answers: Partial<MappedAnswers> = {}): MappingModel & { calls: number } {
  const m = {
    modelId: 'claude-sonnet-5-5',
    calls: 0,
    async map() {
      m.calls += 1;
      return {
        disposition: 'interested' as const,
        values: { Timeline__c: { value: '90 Days', evidence: 'Probably in about 90 days' } },
        ...answers,
        usage: { inputTokens: 1_000, outputTokens: 200, model: 'claude-sonnet-5-5' },
      };
    },
  };
  return m;
}

export function depsFor(db: Db, f: FakeSfWrites, over: Partial<WritebackDeps> = {}): WritebackDeps {
  return {
    db,
    clients: async () => f.client,
    describes: new DescribeCache(),
    model: fakeModel(),
    appPublicUrl: 'https://outreach.example',
    now: RUN_AT,
    log: quiet,
    defaultSpecialists: [GRANT],
    ...over,
  };
}

export async function writebackById(db: Db, id: string) {
  const [row] = await db.select().from(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.id, id));
  return row!;
}

/** A transport failure, as the client throws it. */
export const transportError = (): SalesforceApiError => new SalesforceApiError('Salesforce request failed: TypeError: fetch failed', 0, null);
