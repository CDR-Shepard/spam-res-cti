/**
 * Plan 1D write-back, Lead conversion (spec §5.7, decision 2): a Lead whose call booked an appointment is converted the way
 * the team converts (read from _t2: status Qualified, a new Person Account and Contact, an Opportunity named after the Lead),
 * owned by the appointment owner, through the SOAP API's standard convertLead so every flow and trigger runs as for a rep.
 *
 * Never twice: the Lead's IsConverted / ConvertedOpportunityId are read before every attempt, and a converted Lead's
 * Opportunity is adopted. A refusal Salesforce will repeat is `refused` (the caller takes the hold + Task fallback); a
 * transient failure throws, the tick retries, and the retry finds the Lead converted if Salesforce did convert it.
 */
import {
  convertLead,
  getUserInfo,
  isPermanentSoapFault,
  MALFORMED_RESPONSE,
  SalesforceApiError,
  SalesforceAuthError,
  soqlEscape,
  type SalesforceClient,
  type SObjectDescribe,
} from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import { cutUtf16 } from '../research/text.js';

export const CONVERT_FIELDS_READ = ['Id', 'Name', 'OwnerId', 'IsConverted', 'ConvertedOpportunityId', 'ConvertedAccountId', 'ConvertedContactId',
  'AI_Call_Consent__c', 'AI_Call_Consent_Date__c', 'AI_Call_Consent_Source__c', 'Spanish_Speaker__c', 'Skip_on_Dialer__c'] as const;
/** Lead → Opportunity values the org's lead field mapping does NOT carry (read from LeadConvertSettings on _t2, 2026-10-06). Copied only into blanks. */
export const CARRY_FIELDS = ['AI_Call_Consent__c', 'AI_Call_Consent_Date__c', 'AI_Call_Consent_Source__c', 'Spanish_Speaker__c', 'Skip_on_Dialer__c'] as const;
export const LEAD_MANAGER_FIELD = 'LeadManager__c';

export type ConvertOutcome =
  | { kind: 'converted'; opportunityId: string; accountId: string; contactId: string; adopted: false }
  | { kind: 'adopted'; opportunityId: string; accountId: string | null; contactId: string | null; adopted: true; ours: boolean }
  | { kind: 'no_opportunity'; accountId: string | null } // converted (by someone) without an Opportunity → Task to the owner, row partial
  | { kind: 'refused'; code: string; message: string } // permanent → fallback path
  | { kind: 'not_converted' } // `adoptOnly` and the Lead stands unconverted: nothing was asked of SOAP
  | { kind: 'gone' }; // Lead deleted → row skipped

type Row = Record<string, unknown>;

const OPPORTUNITY_NAME_MAX = 120;
/** convertLead result codes that are transient although Salesforce answered (D-5): thrown, so the tick retries. */
const TRANSIENT_RESULT_CODES: ReadonlySet<string> = new Set(['UNABLE_TO_LOCK_ROW', 'REQUEST_LIMIT_EXCEEDED']);
const SOAP_UNAVAILABLE = 'SOAP_UNAVAILABLE';
const MESSAGE_MAX = 500;

const core = (id: string): string => id.slice(0, 15);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const sfId = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && SF_ID.test(s) ? s : null;
};
const oneLine = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

/** The LeadStatus a conversion sets ('Qualified' on _t2, the only one). Several: 'Qualified' when present, else the first by SortOrder. */
export async function convertedStatus(client: SalesforceClient): Promise<string> {
  const rows = await client.query<Row>('SELECT MasterLabel, SortOrder FROM LeadStatus WHERE IsConverted = true ORDER BY SortOrder');
  const labels = rows.flatMap((r) => str(r.MasterLabel) ?? []);
  const status = labels.find((l) => l === 'Qualified') ?? labels[0];
  if (status === undefined) throw new Error('this org has no converted LeadStatus');
  return status;
}

/** The Lead fields to read: all of CONVERT_FIELDS_READ, or (given the Lead describe) the carry fields the org has. */
function leadSelect(describe: SObjectDescribe | undefined): string[] {
  if (!describe) return [...CONVERT_FIELDS_READ];
  const has = new Set(describe.fields.map((f) => f.name.toLowerCase()));
  const carry = new Set<string>(CARRY_FIELDS);
  return CONVERT_FIELDS_READ.filter((f) => !carry.has(f) || has.has(f.toLowerCase()));
}

async function readLead(client: SalesforceClient, leadId: string, select: readonly string[]): Promise<Row | null> {
  const rows = await client.query<Row>(`SELECT ${select.join(', ')} FROM Lead WHERE Id = '${soqlEscape(leadId)}' LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  const { attributes: _attributes, ...values } = row;
  return values;
}

/**
 * Whether `userId` is the connected user (SOAP getUserInfo). When SOAP is closed to this connection for good, the AI cannot
 * have converted anything (it converts only over SOAP), so the answer is no; a transient failure throws (retried).
 */
async function connectedUserIs(client: SalesforceClient, userId: string): Promise<boolean> {
  try {
    return core((await getUserInfo(client)).userId) === core(userId);
  } catch (err) {
    if (err instanceof SalesforceAuthError || (err instanceof SalesforceApiError && err.code !== undefined && isPermanentSoapFault(err.code))) return false;
    throw err;
  }
}

/** A converted Lead's outcome: its Opportunity adopted (ours when we made it after the call), or none to adopt. */
async function adopt(client: SalesforceClient, lead: Row, callEndedAt: Date): Promise<ConvertOutcome> {
  const oppId = sfId(lead.ConvertedOpportunityId);
  const accountId = sfId(lead.ConvertedAccountId);
  if (oppId === null) return { kind: 'no_opportunity', accountId };
  const [opp] = await client.query<Row>(`SELECT Id, CreatedById, CreatedDate FROM Opportunity WHERE Id = '${soqlEscape(oppId)}' LIMIT 1`);
  if (!opp) return { kind: 'no_opportunity', accountId };
  const created = new Date(String(opp.CreatedDate ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  const after = !Number.isNaN(created.getTime()) && created.getTime() > callEndedAt.getTime();
  const createdBy = sfId(opp.CreatedById);
  // Only a recent Opportunity can be ours, so the connected user is looked up only then.
  const ours = after && createdBy !== null && (await connectedUserIs(client, createdBy));
  return { kind: 'adopted', opportunityId: oppId, accountId, contactId: sfId(lead.ConvertedContactId), adopted: true, ours };
}

const refused = (code: string, message: string): ConvertOutcome => ({ kind: 'refused', code, message: cutUtf16(oneLine(message), MESSAGE_MAX) });

/** What a convertLead failure means: an outcome, or a throw for the tick to retry. */
async function onConvertError(err: unknown, client: SalesforceClient, i: { leadId: string; callEndedAt: Date; select: readonly string[] }): Promise<ConvertOutcome> {
  if (err instanceof SalesforceAuthError) {
    // soap() refreshed once and was refused again. If REST takes the same token, SOAP itself is closed to this user.
    await readLead(client, i.leadId, i.select);
    return refused(SOAP_UNAVAILABLE, 'Salesforce refused this connection on the SOAP API (INVALID_SESSION_ID) while the REST API accepts it');
  }
  if (err instanceof SalesforceApiError && err.code === MALFORMED_RESPONSE) {
    // Salesforce may have converted it: look before calling it a refusal (D-5).
    const again = await readLead(client, i.leadId, i.select);
    if (again?.IsConverted === true) return adopt(client, again, i.callEndedAt);
    return refused(MALFORMED_RESPONSE, err.message);
  }
  // SOAP faults are classified by their code before any HTTP status (every fault is HTTP 500).
  if (err instanceof SalesforceApiError && err.code !== undefined && isPermanentSoapFault(err.code)) return refused(err.code, err.message);
  throw err;
}

/**
 * Adopt-or-convert one Lead. Returns the outcome and the Lead's values before conversion (saved on the row, so a retry
 * never needs the Lead again). `leadDescribe` narrows the read to the carry fields the org has. `adoptOnly` (the booked
 * time has passed, Fix 1 I-1): a converted Lead is still adopted (an earlier attempt's conversion is kept), but an
 * unconverted one is never converted: `not_converted`.
 */
export async function convertStep(
  client: SalesforceClient,
  i: { leadId: string; ownerId: string; callEndedAt: Date; leadDescribe?: SObjectDescribe; adoptOnly?: boolean },
): Promise<{ outcome: ConvertOutcome; lead: Row | null }> {
  if (!SF_ID.test(i.leadId)) throw new RangeError('convertStep: not a Salesforce id');
  const select = leadSelect(i.leadDescribe);
  const lead = await readLead(client, i.leadId, select);
  if (lead === null) return { outcome: { kind: 'gone' }, lead: null };
  if (lead.IsConverted === true) return { outcome: await adopt(client, lead, i.callEndedAt), lead };
  if (i.adoptOnly === true) return { outcome: { kind: 'not_converted' }, lead };

  let status: string;
  try {
    status = await convertedStatus(client);
  } catch (err) {
    if (err instanceof Error && /no converted LeadStatus/.test(err.message)) return { outcome: refused('NO_CONVERTED_STATUS', err.message), lead };
    throw err;
  }
  const name = cutUtf16(oneLine(str(lead.Name) ?? ''), OPPORTUNITY_NAME_MAX) || 'Seller';
  try {
    const result = await convertLead(client, { leadId: i.leadId, convertedStatus: status, ownerId: i.ownerId, opportunityName: name, sendNotificationEmail: false });
    if (result.success) {
      return { outcome: { kind: 'converted', opportunityId: result.opportunityId, accountId: result.accountId, contactId: result.contactId, adopted: false }, lead };
    }
    const first = result.errors[0] ?? { statusCode: 'UNKNOWN_ERROR', message: '' };
    if (TRANSIENT_RESULT_CODES.has(first.statusCode)) throw new SalesforceApiError(`convertLead: ${first.statusCode}`, 0, null, first.statusCode);
    return { outcome: refused(first.statusCode, first.message), lead };
  } catch (err) {
    return { outcome: await onConvertError(err, client, { leadId: i.leadId, callEndedAt: i.callEndedAt, select }), lead };
  }
}

/** Blank for carrying: null, missing, an empty string, or an unticked checkbox. */
const isBlank = (v: unknown): boolean => v === null || v === undefined || v === false || (typeof v === 'string' && v.trim() === '');

/**
 * The PATCH on a new Opportunity: each carry value the Lead has and the Opportunity lacks, copied EXACTLY (consent is never
 * created or upgraded: CF-5), plus the Lead Manager; only fields the connected user may update, in the org's spelling. It
 * deliberately bypasses the write-back allowlist (D-17): these are not answers from the call.
 */
export function carryPatch(i: { lead: Record<string, unknown>; opp: Record<string, unknown>; updateable: ReadonlySet<string>; leadManager: string | null }): Record<string, unknown> {
  const spelling = new Map([...i.updateable].map((n) => [n.toLowerCase(), n]));
  const valueOf = (row: Record<string, unknown>, name: string): unknown => {
    const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : row[key];
  };
  const patch: Record<string, unknown> = {};
  for (const field of CARRY_FIELDS) {
    const name = spelling.get(field.toLowerCase());
    const value = valueOf(i.lead, field);
    if (name === undefined || isBlank(value) || !isBlank(valueOf(i.opp, field))) continue;
    patch[name] = value;
  }
  const manager = spelling.get(LEAD_MANAGER_FIELD.toLowerCase());
  if (i.leadManager !== null && manager !== undefined) patch[manager] = i.leadManager;
  return patch;
}

/** Lead Manager on a converted Opportunity: the Lead's prior owner when that is an active user, else the appointment owner. */
export async function leadManagerFor(client: SalesforceClient, priorOwnerId: string | null, appointmentOwnerId: string): Promise<string> {
  if (priorOwnerId === null || !priorOwnerId.startsWith('005') || !SF_ID.test(priorOwnerId)) return appointmentOwnerId;
  const [row] = await client.query<Row>(`SELECT Id, IsActive FROM User WHERE Id = '${soqlEscape(priorOwnerId)}' LIMIT 1`);
  return row?.IsActive === true ? priorOwnerId : appointmentOwnerId;
}
