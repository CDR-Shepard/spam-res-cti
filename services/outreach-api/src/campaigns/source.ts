import type { CampaignSource, SfObject } from '@cti/contracts';
import { QueryTooLargeError, recordIdFromRow, SalesforceApiError, type SalesforceClient } from '@cti/salesforce';
import { salesforceErrorText } from '../crm/salesforce-error.js';

/** Spec §6.1: a bigger result is rejected with "narrow the query". */
export const MAX_CAMPAIGN_RECORDS = 50_000;

export type CampaignSourceErrorCode = 'invalid_soql' | 'object_mismatch' | 'too_large' | 'salesforce_error';

/** The campaign's list view or SOQL cannot be used; routes answer 422 INVALID_SOURCE with `code` in details. */
export class CampaignSourceError extends Error {
  constructor(message: string, readonly code: CampaignSourceErrorCode) {
    super(message);
    this.name = 'CampaignSourceError';
  }
}

export type SoqlCheck = { ok: true; sfObject: SfObject } | { ok: false; reason: string };

const STRING_LITERAL = /'(?:\\.|[^'\\])*'/g;
const AGGREGATE = /\b(?:COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX)\s*\(|\bGROUP\s+BY\b/i;
/** FOR VIEW / FOR REFERENCE update the user's recently-viewed data: the query path never writes. */
const FOR_CLAUSE = /\bFOR\s+(?:UPDATE|VIEW|REFERENCE)\b/i;
const TOP_LEVEL_FROM = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i;
const LIST_VIEW_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** The text outside every (...) group (groups blanked out), or null when the parentheses do not balance. */
function outsideParentheses(text: string): string | null {
  let depth = 0;
  const kept: string[] = [];
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) return null;
    kept.push(depth === 0 && ch !== ')' ? ch : ' ');
  }
  return depth === 0 ? kept.join('') : null;
}

/**
 * Pure: is this a single, non-aggregate SELECT whose top-level object is Lead
 * or Opportunity? A cheap local check before Salesforce sees it; Salesforce
 * itself remains the judge of everything else (the preview runs the query).
 */
export function validateSoql(soql: string): SoqlCheck {
  const text = soql.trim();
  if (text.includes(';')) return { ok: false, reason: 'Use one query with no semicolon' };
  const bare = text.replace(STRING_LITERAL, "''");
  if (!/^SELECT\s/i.test(bare)) return { ok: false, reason: 'The query must start with SELECT' };
  if (AGGREGATE.test(bare)) return { ok: false, reason: 'Aggregate queries (COUNT(), GROUP BY) are not allowed' };
  if (FOR_CLAUSE.test(bare)) return { ok: false, reason: 'FOR UPDATE, FOR VIEW, and FOR REFERENCE are not allowed' };
  const outer = outsideParentheses(bare);
  if (outer === null) return { ok: false, reason: 'The parentheses do not balance' };
  const from = TOP_LEVEL_FROM.exec(outer);
  if (!from) return { ok: false, reason: 'The query has no FROM' };
  const object = from[1]!;
  if (object.toLowerCase() === 'lead') return { ok: true, sfObject: 'Lead' };
  if (object.toLowerCase() === 'opportunity') return { ok: true, sfObject: 'Opportunity' };
  return { ok: false, reason: `The query must select from Lead or Opportunity, not ${object}` };
}

function checked(soql: string, sfObject: SfObject, origin: string): string {
  const result = validateSoql(soql);
  if (!result.ok) throw new CampaignSourceError(`${origin}: ${result.reason}`, 'invalid_soql');
  if (result.sfObject !== sfObject) {
    throw new CampaignSourceError(`${origin} selects from ${result.sfObject}, but this campaign is for ${sfObject}`, 'object_mismatch');
  }
  return soql.trim();
}

/** The query that decides membership: a list view's described SOQL (re-described on every refresh), or the pasted SOQL. */
export async function membershipSoql(client: SalesforceClient, input: { sfObject: SfObject; source: CampaignSource }): Promise<string> {
  const { sfObject, source } = input;
  if (source.kind === 'soql') return checked(source.soql, sfObject, 'The query');
  if (!LIST_VIEW_ID.test(source.listViewId)) throw new CampaignSourceError('That is not a Salesforce list view id', 'invalid_soql');
  let soql: string;
  try {
    soql = await client.listViewSoql(sfObject, source.listViewId);
  } catch (err) {
    if (err instanceof SalesforceApiError) throw new CampaignSourceError(`Salesforce could not describe that list view: ${salesforceErrorText(err)}`, 'salesforce_error');
    throw err;
  }
  return checked(soql, sfObject, "The list view's query");
}

/** Every record Id the query returns, paginated to the end, de-duplicated in query order. More than `max` → too_large. */
export async function fetchMemberIds(client: SalesforceClient, soql: string, max = MAX_CAMPAIGN_RECORDS): Promise<string[]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await client.queryAll<Record<string, unknown>>(soql, { maxRecords: max });
  } catch (err) {
    if (err instanceof QueryTooLargeError) {
      throw new CampaignSourceError(`The query returns more than ${max.toLocaleString('en-US')} records. Narrow the query.`, 'too_large');
    }
    if (err instanceof SalesforceApiError) throw new CampaignSourceError(salesforceErrorText(err), 'salesforce_error');
    throw err;
  }
  const ids = rows.map((row) => recordIdFromRow(row)).filter((id): id is string => id !== null);
  return [...new Set(ids)];
}
