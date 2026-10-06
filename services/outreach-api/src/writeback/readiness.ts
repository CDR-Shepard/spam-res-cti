/**
 * Plan 1D write-back readiness (Task 27), all read-only: can the tenant's integration connection write call results back
 * (the fields it needs, Events, Tasks and Chatter posts) and convert a Lead that booked (SOAP reachable with the token, the
 * Convert Leads permission, Account/Contact/Opportunity createable)? Shown on the AI call settings card.
 */
import type { AiCallBookingSettings, SalesforceUserOption, WritebackReadiness, WritebackReadinessProblem } from '@cti/contracts';
import { getUserInfo, SalesforceApiError, SalesforceAuthError, soqlEscape, type SalesforceClient, type SObjectDescribe } from '@cti/salesforce';
import { readUsers } from '../appointments/calendar.js';
import { appointmentOwner } from '../appointments/owner.js';
import { SF_ID } from '../campaigns/records.js';
import { describeObject, type DescribeCache } from '../research/describe.js';
import { QUALIFICATION_FIELDS } from '../research/qualification.js';
import { CHANGES_FIELD, STATUS_FIELDS } from './fields.js';

type Item = WritebackReadiness['items'][number];
type SfObject = 'Lead' | 'Opportunity';

const STATUS: Readonly<Record<SfObject, string>> = { Lead: 'Status', Opportunity: 'StageName' };
const item = (object: string, field: string | null, label: string, problem: WritebackReadinessProblem): Item => ({ object, field, label, problem });

/** The fields write-back needs on one object (tenant-optional EXTRA_FIELDS are not checked), each named once. */
function neededFields(sfObject: SfObject): string[] {
  const topic = Object.values(QUALIFICATION_FIELDS[sfObject]).flatMap((fs) => (fs ?? []).map((f) => f.field));
  return [...new Set([CHANGES_FIELD, ...STATUS_FIELDS[sfObject], ...topic])];
}

/** `missing` or `not_updateable` items for one object, and whether the fields that gate `ready` are fine. */
function fieldItems(d: SObjectDescribe, sfObject: SfObject): { items: Item[]; changesOk: boolean; statusOk: boolean } {
  const byName = new Map(d.fields.map((f) => [f.name.toLowerCase(), f]));
  const items: Item[] = [];
  for (const name of neededFields(sfObject)) {
    const f = byName.get(name.toLowerCase());
    if (!f) items.push(item(sfObject, name, name, 'missing'));
    else if (f.updateable !== true || f.calculated === true) items.push(item(sfObject, f.name, f.label, 'not_updateable'));
  }
  const fine = (name: string) => !items.some((i) => i.field?.toLowerCase() === name.toLowerCase());
  return { items, changesOk: fine(CHANGES_FIELD), statusOk: fine(STATUS[sfObject]) };
}

const createItems = (describes: ReadonlyArray<SObjectDescribe>): Item[] => describes.filter((d) => d.createable === false).map((d) => item(d.name, null, d.name, 'cannot_create'));

/** The name of the connected user's default record type on an object, or null. */
const defaultRecordType = (d: SObjectDescribe): string | null => d.recordTypeInfos?.find((r) => r.defaultRecordTypeMapping)?.name ?? null;

/** The connected user's id when the token works on the SOAP API; null when SOAP refuses it. */
async function soapUser(client: SalesforceClient): Promise<string | null> {
  try {
    return (await getUserInfo(client)).userId;
  } catch (err) {
    if (err instanceof SalesforceApiError || err instanceof SalesforceAuthError) return null;
    throw err;
  }
}

/** Convert Leads, from a profile or a permission set (a profile's permissions are its own permission set). */
async function canConvert(client: SalesforceClient, userId: string): Promise<boolean> {
  if (!SF_ID.test(userId)) return false;
  const rows = await client.query(`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${soqlEscape(userId)}' AND PermissionSet.PermissionsConvertLeads = true LIMIT 1`);
  return rows.length > 0;
}

async function owner(client: SalesforceClient, booking: AiCallBookingSettings): Promise<SalesforceUserOption | null> {
  if (booking.specialists.length === 0) return null;
  const u = appointmentOwner(booking, await readUsers(client, booking.specialists));
  return u ? { id: u.sfUserId, name: u.name, title: null, isActive: u.isActive } : null;
}

export async function writebackReadiness(client: SalesforceClient, describes: DescribeCache, orgId: string, booking: AiCallBookingSettings): Promise<WritebackReadiness> {
  const describe = (name: string) => describeObject(client, describes, orgId, name);
  const [lead, opp, event, task, feed, account, contact] = await Promise.all(['Lead', 'Opportunity', 'Event', 'Task', 'FeedItem', 'Account', 'Contact'].map(describe));
  const leadFields = fieldItems(lead!, 'Lead');
  const oppFields = fieldItems(opp!, 'Opportunity');
  const writeItems = [...leadFields.items, ...oppFields.items, ...createItems([event!, task!, feed!])];
  const ready = leadFields.changesOk && oppFields.changesOk && leadFields.statusOk && oppFields.statusOk && event!.createable !== false && feed!.createable !== false;

  const userId = await soapUser(client);
  const convertItems: Item[] = [];
  if (userId === null) convertItems.push(item('Lead', null, 'SOAP API (Lead conversion)', 'soap_unavailable'));
  else if (!(await canConvert(client, userId))) convertItems.push(item('Lead', null, 'Convert Leads permission', 'cannot_convert'));
  convertItems.push(...createItems([account!, contact!, opp!]));

  return {
    ready,
    convertReady: convertItems.length === 0,
    convertRecordTypes: { account: defaultRecordType(account!), opportunity: defaultRecordType(opp!) },
    appointmentOwner: await owner(client, booking),
    items: [...writeItems, ...convertItems],
  };
}
