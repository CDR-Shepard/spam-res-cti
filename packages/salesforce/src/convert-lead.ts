/**
 * Lead conversion over the SOAP API (plan 1D decision 9).
 *
 * The REST API has no lead-convert resource, so the write-back uses the partner
 * SOAP API's standard `convertLead()`, which accepts the connection's OAuth
 * access token as its session id (`SalesforceClient.soap`). No Apex is deployed.
 * Like the team's own conversions, the AI always creates a new Account (a Person
 * Account when the Lead has no Company), Contact and Opportunity: no accountId
 * or contactId is sent.
 */
import type { SalesforceClient } from './client.js';
import { SalesforceApiError } from './errors.js';
import { elements, soapFault, text, xmlEscape, xmlUnescape } from './xml.js';

export { xmlEscape } from './xml.js';

export interface ConvertLeadRequest {
  leadId: string;
  convertedStatus: string;
  ownerId: string;
  /** ≤ 120 characters (the Opportunity Name field). */
  opportunityName: string;
  /** false for the AI. */
  sendNotificationEmail: boolean;
}

export type ConvertLeadResult =
  | { success: true; leadId: string; accountId: string; contactId: string; opportunityId: string }
  | { success: false; errors: Array<{ statusCode: string; message: string; fields: string[] }> };

export interface SoapUserInfo {
  userId: string;
  userName: string;
  organizationId: string;
}

const LEAD_ID = /^00Q[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;
const USER_ID = /^005[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;
const OPPORTUNITY_NAME_MAX = 120;
const PARTNER_NS = 'urn:partner.soap.sforce.com';

function check(request: ConvertLeadRequest): void {
  if (!LEAD_ID.test(request.leadId)) throw new RangeError('convertLead: leadId is not a Salesforce Lead id');
  if (!USER_ID.test(request.ownerId)) throw new RangeError('convertLead: ownerId is not a Salesforce User id');
  if (request.convertedStatus.trim() === '') throw new RangeError('convertLead: convertedStatus is empty');
  const name = request.opportunityName.trim();
  if (name === '' || request.opportunityName.length > OPPORTUNITY_NAME_MAX) {
    throw new RangeError(`convertLead: opportunityName must be 1-${OPPORTUNITY_NAME_MAX} characters`);
  }
}

/** The `<urn:convertLead>` body for one Lead. Pure; ids are checked (RangeError) and every value is XML-escaped. */
export function convertLeadEnvelope(r: ConvertLeadRequest): string {
  check(r);
  const el = (name: string, value: string) => `<urn:${name}>${xmlEscape(value)}</urn:${name}>`;
  return (
    `<urn:convertLead xmlns:urn="${PARTNER_NS}"><urn:leadConverts>` +
    el('convertedStatus', r.convertedStatus) +
    el('doNotCreateOpportunity', 'false') +
    el('leadId', r.leadId) +
    el('opportunityName', r.opportunityName) +
    el('overwriteLeadSource', 'false') +
    el('ownerId', r.ownerId) +
    el('sendNotificationEmail', r.sendNotificationEmail ? 'true' : 'false') +
    '</urn:leadConverts></urn:convertLead>'
  );
}

function throwIfFault(xml: string, status: number, what: string): void {
  const fault = soapFault(xml);
  if (fault) throw new SalesforceApiError(`${what} fault ${fault.code}: ${fault.message}`, status, fault, fault.code);
}

/** The code of an answer that cannot be read although Salesforce said OK (2xx): permanent, never retried (D-5). */
export const MALFORMED_RESPONSE = 'MALFORMED_RESPONSE';

/**
 * A body we could not read. With a 2xx status it carries `MALFORMED_RESPONSE` (permanent: retrying gets the same answer);
 * a 5xx or other status carries no code, so it is retried like any server error (an HTML 503 page, a proxy error).
 */
function unusable(what: string, status: number, xml: string): SalesforceApiError {
  const code = status >= 200 && status < 300 ? MALFORMED_RESPONSE : undefined;
  return new SalesforceApiError(`${what} returned a body we could not read`, status, { raw: xml.slice(0, 2_000) }, code);
}

/** SOAP fault and result codes that retrying cannot fix (D-5): the write-back takes its fallback path instead. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'API_DISABLED_FOR_ORG',
  'API_CURRENTLY_DISABLED',
  'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  'FIELD_INTEGRITY_EXCEPTION',
  'CANNOT_UPDATE_CONVERTED_LEAD',
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
  'INVALID_CROSS_REFERENCE_KEY',
  'INVALID_ID_FIELD',
  'INVALID_FIELD',
  'INVALID_STATUS',
  'INVALID_TYPE',
  'REQUIRED_FIELD_MISSING',
  'DUPLICATES_DETECTED',
  'ENTITY_IS_DELETED',
  'NOT_FOUND',
  MALFORMED_RESPONSE,
  // SOAP 1.1: the request itself is bad (a malformed envelope); sending it again gets the same fault.
  'Client',
]);

/**
 * Whether a SOAP fault code, or a `convertLead` result's `statusCode`, is permanent (D-5). Classify by this code BEFORE the
 * HTTP status: every SOAP fault comes back as HTTP 500. `INSUFFICIENT_ACCESS*` is permanent; UNABLE_TO_LOCK_ROW,
 * REQUEST_LIMIT_EXCEEDED, UNKNOWN_EXCEPTION, SERVER_UNAVAILABLE, a `Server` fault and anything unknown are not (retried).
 */
export function isPermanentSoapFault(code: string): boolean {
  return code.startsWith('INSUFFICIENT_ACCESS') || PERMANENT_CODES.has(code);
}

/** Salesforce compares ids on their case-sensitive 15-character core. */
const idCore = (id: string): string => id.slice(0, 15);

/** Reads the one `<result>` of a convertLead response. Pure; a SOAP fault throws SalesforceApiError(code). */
export function parseConvertLeadResponse(xml: string, status = 200): ConvertLeadResult {
  throwIfFault(xml, status, 'convertLead');
  const result = elements(xml, 'result')[0];
  if (result === undefined) throw unusable('convertLead', status, xml);
  if (text(result, 'success') === 'true') {
    const leadId = text(result, 'leadId');
    const accountId = text(result, 'accountId');
    const contactId = text(result, 'contactId');
    const opportunityId = text(result, 'opportunityId');
    if (!leadId || !accountId || !contactId || !opportunityId) throw unusable('convertLead', status, xml);
    return { success: true, leadId, accountId, contactId, opportunityId };
  }
  const errors = elements(result, 'errors').map((e) => ({
    statusCode: text(e, 'statusCode') ?? 'UNKNOWN_ERROR',
    message: text(e, 'message') ?? '',
    fields: elements(e, 'fields')
      .map((f) => xmlUnescape(f).trim())
      .filter((f) => f !== ''),
  }));
  return { success: false, errors };
}

/**
 * Converts one Lead. A refusal (validation rule, already converted...) is `success: false`, never a throw. A success that
 * names another Lead than the one asked is not trusted: SalesforceApiError `MALFORMED_RESPONSE` (D-5).
 */
export async function convertLead(client: SalesforceClient, r: ConvertLeadRequest): Promise<ConvertLeadResult> {
  const body = convertLeadEnvelope(r);
  const res = await client.soap(body);
  const result = parseConvertLeadResponse(res.xml, res.status);
  if (result.success && idCore(result.leadId) !== idCore(r.leadId)) throw unusable('convertLead (another Lead id)', res.status, res.xml);
  return result;
}

/** Read-only proof that the token works on the SOAP API (readiness, Task 27). */
export async function getUserInfo(client: SalesforceClient): Promise<SoapUserInfo> {
  const res = await client.soap(`<urn:getUserInfo xmlns:urn="${PARTNER_NS}"/>`);
  throwIfFault(res.xml, res.status, 'getUserInfo');
  const result = elements(res.xml, 'result')[0];
  const userId = result === undefined ? null : text(result, 'userId');
  const userName = result === undefined ? null : text(result, 'userName');
  const organizationId = result === undefined ? null : text(result, 'organizationId');
  if (!userId || !userName || !organizationId) throw unusable('getUserInfo', res.status, res.xml);
  return { userId, userName, organizationId };
}
