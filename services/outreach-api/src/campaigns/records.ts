import type { ObjectFieldMap, SfObject } from '@cti/contracts';
import { toE164 } from '@cti/phone';
import { recordIdFromRow, soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { FIELD_API_NAME, mappedFieldNames, uniqueFieldNames } from '../crm/field-map.js';

/** What this service reads about one record (spec §5). Notes are not here: triage fetches them separately and never stores them. */
export interface SfRecordSnapshot {
  sfObject: SfObject;
  sfRecordId: string;
  name: string | null;
  ownerSfUserId: string | null;
  ownerName: string | null;
  leadManagerSfUserId: string | null;
  /** E.164 numbers in field-map order (Opportunity: then the primary contact's), each number once under the first field that held it. */
  phones: Array<{ field: string; e164: string }>;
  email: string | null;
  state: string | null;
  webFormSource: string | null;
  consentAiCall: boolean;
  sfDoNotCall: boolean;
  sfEmailOptOut: boolean;
  skipOnDialer: boolean;
  /** Lead: IsConverted. Opportunity: IsClosed. */
  isClosed: boolean;
  lastModifiedAt: Date | null;
}

/** SOQL's practical IN (...) bound, as in the CTI (spec §6.1: batches of 200). */
export const RECORD_BATCH_SIZE = 200;
const BASE_FIELDS = ['Id', 'Name', 'OwnerId', 'Owner.Name', 'LastModifiedDate'] as const;
const CLOSED_FIELD: Readonly<Record<SfObject, string>> = { Lead: 'IsConverted', Opportunity: 'IsClosed' };
/** Opportunity's person is its primary contact role's Contact (spec §5). */
export const PRIMARY_CONTACT_SUBQUERY =
  '(SELECT Contact.Email, Contact.MobilePhone, Contact.Phone, Contact.DoNotCall, Contact.HasOptedOutOfEmail FROM OpportunityContactRoles WHERE IsPrimary = true LIMIT 1)';
/** A 15- or 18-character Salesforce record Id. */
export const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

type Row = Record<string, unknown>;

/** Pure: the field fetch for up to 200 ids. Mapped field names and ids are shape-checked before they reach the SOQL text. */
export function recordSelectSoql(sfObject: SfObject, fieldMap: ObjectFieldMap, ids: readonly string[]): string {
  const valid = ids.filter((id) => SF_ID.test(id));
  if (valid.length === 0) throw new Error('recordSelectSoql needs at least one valid record id');
  const mapped = mappedFieldNames(fieldMap).filter((name) => FIELD_API_NAME.test(name));
  const fields = uniqueFieldNames([...BASE_FIELDS, CLOSED_FIELD[sfObject], ...mapped]);
  const select = sfObject === 'Opportunity' ? [...fields, PRIMARY_CONTACT_SUBQUERY] : fields;
  const idList = valid.map((id) => `'${soqlEscape(id)}'`).join(', ');
  return `SELECT ${select.join(', ')} FROM ${sfObject} WHERE Id IN (${idList})`;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A Salesforce checkbox: true only when it is exactly `true`. */
function checked(value: unknown): boolean {
  return value === true;
}

/**
 * Reads mapped fields case-insensitively: Salesforce answers with canonical
 * field-name case, while the field map accepts any case (SOQL does too). A
 * miss on `donotcall` would read a Do Not Call record as callable.
 */
function rowReader(row: Row): (field: string | null) => unknown {
  const keys = new Map<string, string>();
  for (const key of Object.keys(row)) keys.set(key.toLowerCase(), key);
  return (field) => {
    if (!field) return undefined;
    const actual = keys.get(field.toLowerCase());
    return actual === undefined ? undefined : row[actual];
  };
}

function dateOrNull(value: unknown): Date | null {
  const s = text(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function primaryContact(row: Row): Row | null {
  const roles = row.OpportunityContactRoles as { records?: unknown } | null | undefined;
  const first: unknown = Array.isArray(roles?.records) ? roles.records[0] : undefined;
  const contact = (first as { Contact?: unknown } | undefined)?.Contact;
  return contact && typeof contact === 'object' ? (contact as Row) : null;
}

/** Normalize to E.164, drop what does not parse, keep each number once under its first field. */
function toPhones(raw: Array<{ field: string; value: unknown }>): Array<{ field: string; e164: string }> {
  const seen = new Set<string>();
  return raw.flatMap(({ field, value }) => {
    const s = text(value);
    const e164 = s ? toE164(s) : null;
    if (!e164 || seen.has(e164)) return [];
    seen.add(e164);
    return [{ field, e164 }];
  });
}

/** Pure: one query row → snapshot; null when the row carries no record Id. */
export function snapshotFromRow(sfObject: SfObject, m: ObjectFieldMap, row: Row): SfRecordSnapshot | null {
  const sfRecordId = recordIdFromRow(row);
  if (!sfRecordId) return null;
  const read = rowReader(row);
  const contact = sfObject === 'Opportunity' ? primaryContact(row) : null;
  const ownPhones = m.phones.map((field) => ({ field, value: read(field) }));
  const contactPhones = contact ? [{ field: 'Contact.MobilePhone', value: contact.MobilePhone }, { field: 'Contact.Phone', value: contact.Phone }] : [];
  return {
    sfObject,
    sfRecordId,
    name: text(row.Name),
    ownerSfUserId: text(row.OwnerId),
    ownerName: text((row.Owner as Row | null | undefined)?.Name),
    leadManagerSfUserId: text(read(m.leadManager)),
    phones: toPhones([...ownPhones, ...contactPhones]),
    email: text(read(m.email)) ?? text(contact?.Email),
    state: text(read(m.state)),
    webFormSource: text(read(m.webFormSource)),
    consentAiCall: checked(read(m.consent)),
    sfDoNotCall: checked(read(m.doNotCall)) || checked(contact?.DoNotCall),
    sfEmailOptOut: checked(read(m.emailOptOut)) || checked(contact?.HasOptedOutOfEmail),
    skipOnDialer: checked(read(m.skipOnDialer)),
    isClosed: checked(read(CLOSED_FIELD[sfObject])),
    lastModifiedAt: dateOrNull(row.LastModifiedDate),
  };
}

/** A 15- and an 18-character Id of the same record share their first 15 characters. */
const idKey = (id: string): string => id.slice(0, 15);

/** Snapshots for these ids, fetched 200 at a time, in input order; ids Salesforce does not return (deleted, not visible) are left out. */
export async function fetchRecords(client: SalesforceClient, sfObject: SfObject, ids: readonly string[], fieldMap: ObjectFieldMap): Promise<SfRecordSnapshot[]> {
  const valid = ids.filter((id) => SF_ID.test(id));
  const byId = new Map<string, SfRecordSnapshot>();
  for (let i = 0; i < valid.length; i += RECORD_BATCH_SIZE) {
    const batch = valid.slice(i, i + RECORD_BATCH_SIZE);
    const rows = await client.queryAll<Row>(recordSelectSoql(sfObject, fieldMap, batch), { maxRecords: batch.length });
    for (const row of rows) {
      const snapshot = snapshotFromRow(sfObject, fieldMap, row);
      if (snapshot) byId.set(idKey(snapshot.sfRecordId), snapshot);
    }
  }
  return valid.map((id) => byId.get(idKey(id))).filter((s): s is SfRecordSnapshot => s !== undefined);
}
