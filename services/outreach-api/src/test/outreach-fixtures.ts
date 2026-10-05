/**
 * Row builders for real-Postgres tests of campaigns, enrollment, and triage. Every test
 * seeds its own organization, so tests sharing one test database never see each other's
 * rows (the contact-key uniqueness is per org).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FieldMap, ObjectFieldMap } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { SfRecordSnapshot } from '../campaigns/records.js';

const LEAD_MAP: ObjectFieldMap = {
  notes: ['Notes__c', 'Description'],
  phones: ['MobilePhone', 'Phone'],
  email: 'Email',
  doNotCall: 'DoNotCall',
  emailOptOut: 'HasOptedOutOfEmail',
  skipOnDialer: null,
  consent: null,
  webFormSource: null,
  state: 'State',
  leadManager: null,
};
export const TEST_FIELD_MAP: FieldMap = {
  Lead: LEAD_MAP,
  Opportunity: { ...LEAD_MAP, notes: ['Notes__c'], phones: ['Mobile_Phone__c'], email: null, doNotCall: null, emailOptOut: null, state: null },
};

export async function seedOrg(db: Db, settings: Record<string, unknown> = {}): Promise<string> {
  const slug = `t-${randomUUID().slice(0, 12)}`;
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug, settings }).returning({ id: schema.organizations.id });
  return org!.id;
}

export async function seedConnection(db: Db, orgId: string, fieldMap: FieldMap = TEST_FIELD_MAP): Promise<void> {
  await db.insert(schema.crmConnections).values({
    orgId,
    instanceUrl: 'https://example.my.salesforce.com',
    sfOrgId: '00D000000000001AAA',
    sfUserId: '005000000000001AAA',
    accessTokenEnc: 'enc',
    fieldMap,
  });
}

export async function seedCampaign(
  db: Db,
  orgId: string,
  over: Partial<typeof schema.campaigns.$inferInsert> = {},
): Promise<typeof schema.campaigns.$inferSelect> {
  const [row] = await db
    .insert(schema.campaigns)
    .values({
      orgId,
      name: 'Test campaign',
      sfObject: 'Lead',
      sourceKind: 'list_view',
      listViewId: '00B000000000001AAA',
      soql: "SELECT Id FROM Lead WHERE Status = 'Open'",
      status: 'dry_run',
      ...over,
    })
    .returning();
  return row!;
}

/** An 18-character Lead Id ending in `n` (zero-padded). */
export function leadId(n: number): string {
  return `00Q${String(n).padStart(15, '0')}`;
}

export function snapshot(over: Partial<SfRecordSnapshot> & { sfRecordId: string }): SfRecordSnapshot {
  return {
    sfObject: 'Lead',
    name: 'Pat Seller',
    ownerSfUserId: '005000000000001AAA',
    ownerName: 'Rep One',
    leadManagerSfUserId: null,
    phones: [{ field: 'MobilePhone', e164: '+15125550100' }],
    email: null,
    state: 'TX',
    webFormSource: null,
    consentAiCall: false,
    sfDoNotCall: false,
    sfEmailOptOut: false,
    skipOnDialer: false,
    isClosed: false,
    lastModifiedAt: new Date('2026-10-01T12:00:00.000Z'),
    ...over,
  };
}

export async function seedRecord(db: Db, orgId: string, s: SfRecordSnapshot, over: Partial<typeof schema.crmRecords.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(schema.crmRecords)
    .values({
      orgId,
      sfObject: s.sfObject,
      sfRecordId: s.sfRecordId,
      name: s.name,
      ownerSfUserId: s.ownerSfUserId,
      ownerName: s.ownerName,
      phones: s.phones,
      email: s.email,
      state: s.state,
      consentAiCall: s.consentAiCall,
      sfDoNotCall: s.sfDoNotCall,
      sfEmailOptOut: s.sfEmailOptOut,
      skipOnDialer: s.skipOnDialer,
      isClosed: s.isClosed,
      sfLastModifiedAt: s.lastModifiedAt,
      ...over,
    })
    .returning({ id: schema.crmRecords.id });
  return row!.id;
}

export async function enrollmentsOf(db: Db, campaignId: string) {
  return db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.campaignId, campaignId));
}

export async function campaignById(db: Db, id: string) {
  const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
  return row!;
}

/** An enrollment row without contact keys (for tests that do not exercise the key rule). */
export async function seedEnrollment(
  db: Db,
  orgId: string,
  campaignId: string,
  crmRecordId: string,
  over: Partial<typeof schema.campaignEnrollments.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.campaignEnrollments)
    .values({ orgId, campaignId, crmRecordId, status: 'active', ...over })
    .returning({ id: schema.campaignEnrollments.id });
  return row!.id;
}
