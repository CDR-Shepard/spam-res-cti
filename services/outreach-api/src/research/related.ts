/** The lead's whole record plus the records around it (converted Contact/Account/Opportunity; an Opportunity's Account and contact roles). */
import type { AiConsentStatus } from '@cti/contracts';
import { soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import { describeObject, readableFields, type DescribeCache } from './describe.js';
import { RESEARCH_LIMITS } from './limits.js';
import { classifyReadError, type SourceRead } from './salesforce-errors.js';
import { clip, fieldValueText, soqlIdList } from './text.js';

export type RecordRelation = 'self' | 'converted_contact' | 'converted_account' | 'converted_opportunity' | 'account' | 'contact';
export interface RecordBlock {
  relation: RecordRelation;
  sfObject: string;
  id: string;
  role: string | null;
  fields: Array<{ name: string; label: string; value: string }>;
}
export interface LinkIds { whoIds: string[]; whatIds: string[]; parentIds: string[] }
export interface ResearchReadDeps { client: SalesforceClient; describes: DescribeCache; orgId: string }
export interface MainAndRelated { main: RecordBlock; consent: AiConsentStatus; related: SourceRead<RecordBlock>; links: LinkIds }

type Row = Record<string, unknown>;
const idOf = (v: unknown): string | null => (typeof v === 'string' && SF_ID.test(v) ? v : null);

/**
 * The SOQL travels in a GET URL, so the select list is cut (from the end) to stay far below the URI limit.
 * The first `keep` fields (Id and the consent field) are never cut.
 */
function withinSelectBudget<F extends { name: string }>(fields: F[], keep: number): F[] {
  let used = 0;
  return fields.filter((f, i) => (used += f.name.length + 2) <= RESEARCH_LIMITS.selectChars || i < keep);
}

export async function readRecordBlock(
  deps: ResearchReadDeps,
  sobject: string,
  id: string,
  relation: RecordRelation,
  role: string | null,
  maxFields: number,
  consentField: string | null = null,
): Promise<{ block: RecordBlock; row: Row; fieldNames: Set<string> } | null> {
  const d = await describeObject(deps.client, deps.describes, deps.orgId, sobject);
  const all = readableFields(d, maxFields, consentField);
  // Id, then the consent field when it is readable: both are always selected, whatever else is cut.
  const consentKey = consentField === null ? null : (all.find((f) => f.name !== 'Id' && f.name.toLowerCase() === consentField.toLowerCase())?.name ?? null);
  const fields = withinSelectBudget(all, consentKey === null ? 1 : 2);
  const [row] = await deps.client.query<Row>(`SELECT ${fields.map((f) => f.name).join(', ')} FROM ${sobject} WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  if (!row) return null;
  const values = fields.flatMap((f) => {
    const v = fieldValueText(row[f.name]);
    return v === null || f.name === 'Id' ? [] : [{ name: f.name, label: f.label, value: clip(v, RESEARCH_LIMITS.fieldValueChars).text }];
  });
  return { block: { relation, sfObject: sobject, id, role, fields: values }, row, fieldNames: new Set(d.fields.map((f) => f.name.toLowerCase())) };
}

/**
 * Fail-safe: only a boolean true is 'yes'. A configured field whose value did not come back
 * (absent from the row, or not a boolean) is 'unknown', never 'no' and never 'yes'.
 */
function consentOf(row: Row, fieldNames: Set<string>, consentField: string | null): AiConsentStatus {
  if (!consentField || !fieldNames.has(consentField.toLowerCase())) return 'field_missing';
  const key = Object.keys(row).find((k) => k.toLowerCase() === consentField.toLowerCase());
  if (key === undefined) return 'unknown';
  const value = row[key];
  if (value === true) return 'yes';
  return value === false || value === null ? 'no' : 'unknown';
}

interface RelatedTarget { sobject: string; id: string; relation: RecordRelation; role: string | null }

async function relatedTargets(deps: ResearchReadDeps, sfObject: 'Lead' | 'Opportunity', id: string, row: Row): Promise<RelatedTarget[]> {
  if (sfObject === 'Lead') {
    if (row.IsConverted !== true) return [];
    return [
      { sobject: 'Contact', id: idOf(row.ConvertedContactId), relation: 'converted_contact' as const },
      { sobject: 'Account', id: idOf(row.ConvertedAccountId), relation: 'converted_account' as const },
      { sobject: 'Opportunity', id: idOf(row.ConvertedOpportunityId), relation: 'converted_opportunity' as const },
    ].flatMap((t) => (t.id ? [{ ...t, id: t.id, role: null }] : []));
  }
  const account = idOf(row.AccountId);
  const roles = await deps.client.query<Row>(
    `SELECT ContactId, Role, IsPrimary FROM OpportunityContactRole WHERE OpportunityId = '${soqlEscape(id)}' ORDER BY IsPrimary DESC LIMIT ${RESEARCH_LIMITS.relatedRecords}`,
  );
  const contacts = roles.flatMap((r) => {
    const cid = idOf(r.ContactId);
    return cid ? [{ sobject: 'Contact', id: cid, relation: 'contact' as const, role: typeof r.Role === 'string' ? r.Role : r.IsPrimary === true ? 'Primary' : null }] : [];
  });
  return [...(account ? [{ sobject: 'Account', id: account, relation: 'account' as const, role: null }] : []), ...contacts].slice(0, RESEARCH_LIMITS.relatedRecords);
}

function linksFor(sfObject: 'Lead' | 'Opportunity', id: string, related: RecordBlock[]): LinkIds {
  const who = related.filter((b) => b.sfObject === 'Contact').map((b) => b.id);
  const what = related.filter((b) => b.sfObject !== 'Contact').map((b) => b.id);
  const whoIds = sfObject === 'Lead' ? [id, ...who] : who;
  const whatIds = sfObject === 'Opportunity' ? [id, ...what] : what;
  return { whoIds, whatIds, parentIds: [...new Set([id, ...who, ...what])] };
}

/** Null when Salesforce returns no row (deleted, or not visible to the integration user). */
export async function readMainAndRelated(
  deps: ResearchReadDeps,
  target: { sfObject: 'Lead' | 'Opportunity'; sfRecordId: string; consentField: string | null },
): Promise<MainAndRelated | null> {
  soqlIdList([target.sfRecordId]); // throws on a malformed id before any request
  const main = await readRecordBlock(deps, target.sfObject, target.sfRecordId, 'self', null, RESEARCH_LIMITS.recordFields, target.consentField);
  if (!main) return null;
  const blocks: RecordBlock[] = [];
  let summaryStatus: 'ok' | 'missing' | 'denied' | 'error' = 'ok';
  let note: string | null = null;
  try {
    for (const t of await relatedTargets(deps, target.sfObject, target.sfRecordId, main.row)) {
      try {
        const got = await readRecordBlock(deps, t.sobject, t.id, t.relation, t.role, RESEARCH_LIMITS.relatedFields);
        if (got) blocks.push(got.block);
      } catch (err) {
        ({ status: summaryStatus, note } = classifyReadError(err));
      }
    }
  } catch (err) {
    ({ status: summaryStatus, note } = classifyReadError(err));
  }
  return {
    main: main.block,
    consent: consentOf(main.row, main.fieldNames, target.consentField),
    related: { items: blocks, summary: { source: 'related', status: blocks.length > 0 && summaryStatus !== 'ok' ? 'ok' : summaryStatus, count: blocks.length, truncated: false, note } },
    links: linksFor(target.sfObject, target.sfRecordId, blocks),
  };
}
