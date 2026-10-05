/** One page of the lead picker: members in query order, read fresh from Salesforce, judged like enrollment. */
import { and, count, eq, inArray } from 'drizzle-orm';
import { CANDIDATE_PAGE_SIZE, SfObject, type CandidatePage, type EnrollmentStatus, type FieldMap } from '@cti/contracts';
import { schema, type CampaignRow, type Db } from '@cti/db';
import { blockedTargets } from '@cti/firewall';
import type { SalesforceClient } from '@cti/salesforce';
import { contactKeys, skipReasonFor } from './eligibility.js';
import { campaignMemberIds, type MemberIdCache } from './member-cache.js';
import { activeContactKeys } from './preview.js';
import { DESELECTED_EXIT_REASON } from './reenroll.js';
import { fetchRecords } from './records.js';
import { selectedAmong, selectedCount } from './selection.js';

export interface CandidateDeps {
  db: Db;
  client: SalesforceClient;
  cache: MemberIdCache;
  fieldMap: FieldMap;
}

type EnrollmentOnPage = { status: EnrollmentStatus; exitReason: string | null };

/** The enrollment (any status) of each Salesforce Id on this page, if the campaign has one. */
async function enrollmentsAmong(db: Db, campaignId: string, ids: readonly string[]): Promise<Map<string, EnrollmentOnPage>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.crmRecords.sfRecordId, status: schema.campaignEnrollments.status, exitReason: schema.campaignEnrollments.exitReason })
    .from(schema.campaignEnrollments)
    .innerJoin(schema.crmRecords, eq(schema.crmRecords.id, schema.campaignEnrollments.crmRecordId))
    .where(and(eq(schema.campaignEnrollments.campaignId, campaignId), inArray(schema.crmRecords.sfRecordId, [...ids])));
  return new Map(rows.map((r) => [r.id, { status: r.status, exitReason: r.exitReason }]));
}

/** What a deselected lead's exit is called; ticking such a lead again brings it back (reenroll.ts). */
const holdsTheLead = (e: EnrollmentOnPage | undefined): boolean => !!e && !(e.status === 'exited' && e.exitReason === DESELECTED_EXIT_REASON);

/** Enrollments still `active`: the leads "Clear" would stop at the next refresh. */
async function activeEnrolledCount(db: Db, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.campaignEnrollments)
    .where(and(eq(schema.campaignEnrollments.campaignId, campaignId), eq(schema.campaignEnrollments.status, 'active')));
  return Number(row?.n ?? 0);
}

export async function candidatePage(deps: CandidateDeps, campaign: CampaignRow, page: number): Promise<CandidatePage> {
  const { db, client, fieldMap } = deps;
  const ids = await campaignMemberIds({ client, cache: deps.cache }, campaign);
  const pages = Math.max(1, Math.ceil(ids.length / CANDIDATE_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const slice = ids.slice((current - 1) * CANDIDATE_PAGE_SIZE, current * CANDIDATE_PAGE_SIZE);
  const sfObject = SfObject.parse(campaign.sfObject);
  const snapshots = slice.length > 0 ? await fetchRecords(client, sfObject, slice, fieldMap[sfObject]) : [];
  const [blocks, enrollments, selected, total, activeEnrolled] = await Promise.all([
    blockedTargets(db, campaign.orgId, [...new Set(snapshots.flatMap((s) => s.phones.map((p) => p.e164)))]),
    enrollmentsAmong(db, campaign.id, slice),
    selectedAmong(db, campaign.id, slice),
    selectedCount(db, campaign.id),
    activeEnrolledCount(db, campaign.id),
  ]);
  const taken = await activeContactKeys(db, campaign.orgId, snapshots.filter((s) => !holdsTheLead(enrollments.get(s.sfRecordId))).flatMap(contactKeys));
  return {
    total: ids.length,
    page: current,
    pageSize: CANDIDATE_PAGE_SIZE,
    pages,
    selectedCount: total,
    activeEnrolledCount: activeEnrolled,
    records: snapshots.map((s) => {
      const enrollment = enrollments.get(s.sfRecordId);
      const isEnrolled = holdsTheLead(enrollment);
      return {
        sfRecordId: s.sfRecordId,
        name: s.name,
        ownerName: s.ownerName,
        consentAiCall: s.consentAiCall,
        skipReason: isEnrolled ? null : skipReasonFor(s, blocks, contactKeys(s).some((k) => taken.has(k))),
        selected: selected.has(s.sfRecordId),
        enrolled: isEnrolled,
        enrollmentStatus: enrollment?.status ?? null,
        exitReason: enrollment?.exitReason ?? null,
      };
    }),
  };
}
