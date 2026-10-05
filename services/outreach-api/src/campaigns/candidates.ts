/** One page of the lead picker: members in query order, read fresh from Salesforce, judged like enrollment. */
import { and, eq, inArray } from 'drizzle-orm';
import { CANDIDATE_PAGE_SIZE, SfObject, type CandidatePage, type FieldMap } from '@cti/contracts';
import { schema, type CampaignRow, type Db } from '@cti/db';
import { blockedTargets } from '@cti/firewall';
import type { SalesforceClient } from '@cti/salesforce';
import { contactKeys, skipReasonFor } from './eligibility.js';
import { campaignMemberIds, type MemberIdCache } from './member-cache.js';
import { activeContactKeys } from './preview.js';
import { fetchRecords } from './records.js';
import { selectedAmong, selectedCount } from './selection.js';

export interface CandidateDeps {
  db: Db;
  client: SalesforceClient;
  cache: MemberIdCache;
  fieldMap: FieldMap;
}

/** Salesforce Ids on this page already enrolled in this campaign (any status). */
async function enrolledAmong(db: Db, campaignId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.crmRecords.sfRecordId })
    .from(schema.campaignEnrollments)
    .innerJoin(schema.crmRecords, eq(schema.crmRecords.id, schema.campaignEnrollments.crmRecordId))
    .where(and(eq(schema.campaignEnrollments.campaignId, campaignId), inArray(schema.crmRecords.sfRecordId, [...ids])));
  return new Set(rows.map((r) => r.id));
}

export async function candidatePage(deps: CandidateDeps, campaign: CampaignRow, page: number): Promise<CandidatePage> {
  const { db, client, fieldMap } = deps;
  const ids = await campaignMemberIds({ client, cache: deps.cache }, campaign);
  const pages = Math.max(1, Math.ceil(ids.length / CANDIDATE_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const slice = ids.slice((current - 1) * CANDIDATE_PAGE_SIZE, current * CANDIDATE_PAGE_SIZE);
  const sfObject = SfObject.parse(campaign.sfObject);
  const snapshots = slice.length > 0 ? await fetchRecords(client, sfObject, slice, fieldMap[sfObject]) : [];
  const [blocks, enrolled, selected, total] = await Promise.all([
    blockedTargets(db, campaign.orgId, [...new Set(snapshots.flatMap((s) => s.phones.map((p) => p.e164)))]),
    enrolledAmong(db, campaign.id, slice),
    selectedAmong(db, campaign.id, slice),
    selectedCount(db, campaign.id),
  ]);
  const taken = await activeContactKeys(db, campaign.orgId, snapshots.filter((s) => !enrolled.has(s.sfRecordId)).flatMap(contactKeys));
  return {
    total: ids.length,
    page: current,
    pageSize: CANDIDATE_PAGE_SIZE,
    pages,
    selectedCount: total,
    records: snapshots.map((s) => {
      const isEnrolled = enrolled.has(s.sfRecordId);
      return {
        sfRecordId: s.sfRecordId,
        name: s.name,
        ownerName: s.ownerName,
        consentAiCall: s.consentAiCall,
        skipReason: isEnrolled ? null : skipReasonFor(s, blocks, contactKeys(s).some((k) => taken.has(k))),
        selected: selected.has(s.sfRecordId),
        enrolled: isEnrolled,
      };
    }),
  };
}
