import { and, eq, inArray } from 'drizzle-orm';
import type { CampaignPreview, FieldMap, PreviewRecord, PreviewRequest, SkipReason } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { blockedTargets } from '@cti/firewall';
import type { SalesforceClient } from '@cti/salesforce';
import { availableChannels, contactKeys, skipReasonFor } from './eligibility.js';
import { fetchRecords, type SfRecordSnapshot } from './records.js';
import { fetchMemberIds, membershipSoql } from './source.js';

/** Members whose fields a preview checks: 10 record batches, so a preview stays one quick request. The UI says "of the first N checked". */
export const PREVIEW_EXAMINE_LIMIT = 2_000;
export const PREVIEW_SAMPLE_SIZE = 20;
const KEY_CHUNK = 1_000;

export interface PreviewDeps {
  db: Db;
  client: SalesforceClient;
  orgId: string;
  fieldMap: FieldMap;
}

/** The subset of `keys` held by an active enrollment of this tenant (one active campaign per person). */
export async function activeContactKeys(db: Db, orgId: string, keys: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  const k = schema.enrollmentContactKeys;
  const taken = new Set<string>();
  for (let i = 0; i < unique.length; i += KEY_CHUNK) {
    const rows = await db
      .select({ key: k.key })
      .from(k)
      .where(and(eq(k.orgId, orgId), eq(k.active, true), inArray(k.key, unique.slice(i, i + KEY_CHUNK))));
    for (const row of rows) taken.add(row.key);
  }
  return taken;
}

function countReasons(reasons: ReadonlyArray<SkipReason | null>): Partial<Record<SkipReason, number>> {
  return reasons.reduce<Partial<Record<SkipReason, number>>>((acc, r) => (r ? { ...acc, [r]: (acc[r] ?? 0) + 1 } : acc), {});
}

function toPreviewRecord(s: SfRecordSnapshot, channels: PreviewRecord['channels'], skipReason: SkipReason | null): PreviewRecord {
  return { sfRecordId: s.sfRecordId, name: s.name, ownerName: s.ownerName, channels, skipReason };
}

/**
 * Who the campaign would reach, without writing anything: every member Id
 * for `total`, fields for the first PREVIEW_EXAMINE_LIMIT, and eligibility
 * over those with the same rules enrollment uses (A8).
 */
export async function previewCampaign(deps: PreviewDeps, input: PreviewRequest): Promise<CampaignPreview> {
  const soql = await membershipSoql(deps.client, input);
  const ids = await fetchMemberIds(deps.client, soql);
  const snapshots = await fetchRecords(deps.client, input.sfObject, ids.slice(0, PREVIEW_EXAMINE_LIMIT), deps.fieldMap[input.sfObject]);
  const numbers = [...new Set(snapshots.flatMap((s) => s.phones.map((p) => p.e164)))];
  const blocks = await blockedTargets(deps.db, deps.orgId, numbers);
  const taken = await activeContactKeys(deps.db, deps.orgId, snapshots.flatMap(contactKeys));
  const judged = snapshots.map((s) => ({ s, reason: skipReasonFor(s, blocks, contactKeys(s).some((key) => taken.has(key))) }));
  return {
    total: ids.length,
    examined: snapshots.length,
    eligible: judged.filter((j) => j.reason === null).length,
    skipped: countReasons(judged.map((j) => j.reason)),
    sample: judged.slice(0, PREVIEW_SAMPLE_SIZE).map(({ s, reason }) => toPreviewRecord(s, availableChannels(s, blocks), reason)),
  };
}
