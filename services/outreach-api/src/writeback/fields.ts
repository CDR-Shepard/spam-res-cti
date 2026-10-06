/**
 * Plan 1D write-back (spec §5): which fields the write-back may write, as an explicit allowlist intersected with a
 * describe made as the integration user, and the fresh read of the record just before the write plan is built.
 *
 * The allowlist is the qualification and extra fields (research/qualification.ts, spec §5.1), the status fields of the
 * outcome tables (§5.2, §5.3) and AI Last Call Changes (§5.5). Nothing else is ever written.
 */
import { soqlEscape, type SalesforceClient, type SObjectDescribe, type SObjectField } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import { FIELD_API_NAME } from '../crm/field-map.js';
import { EXTRA_FIELDS, QUALIFICATION_FIELDS, type FieldKind, type TopicField } from '../research/qualification.js';

type SfObject = 'Lead' | 'Opportunity';

export const CHANGES_FIELD = 'AI_Last_Call_Changes__c';
/** `CTI_Origin__c` on the Events and Tasks the write-back creates. */
export const AI_OUTREACH_ORIGIN = 'AI Outreach';

const lowerSet = (names: readonly string[]): ReadonlySet<string> => new Set(names.map((n) => n.toLowerCase()));

/**
 * Org-derived fields (DLRS rollups and formulas, spec §2): never written whatever the describe says. Lower-cased; use
 * `isDenied` to test a name.
 */
export const ROLLUP_DENY: Readonly<Record<SfObject, ReadonlySet<string>>> = {
  Opportunity: new Set(
    [
      'Appointment_Date_Time__c', 'Phone_Appointment_Date_Time__c', 'Latest_In_Person_Appointment_Date_Time__c', 'Non_In_Person_Appointment_DateTime__c',
      'Latest_Appointment_Date__c', 'In_Person_Appointment_Count__c', 'Non_In_Person_Appointment_Count__c', 'Appointment__c', 'Last_Chatter_Date__c',
      'NextStep', 'Next_Task_Due_Date__c', 'Next_Task_Owners__c', 'Number_of_Open_Tasks__c',
    ],
  ),
  Lead: new Set(['Last_Chatter_Date__c', 'Next_Task_Due_Date__c', 'Next_Step__c', 'Next_Task_Owners__c', 'Number_of_Open_Tasks__c', 'First_Call__c', 'First_Text__c']),
};
const DENY_LOWER: Readonly<Record<SfObject, ReadonlySet<string>>> = {
  Opportunity: lowerSet([...ROLLUP_DENY.Opportunity]),
  Lead: lowerSet([...ROLLUP_DENY.Lead]),
};

/** The fields the outcome tables move (spec §5.2, §5.3). */
export const STATUS_FIELDS: Readonly<Record<SfObject, readonly string[]>> = {
  Lead: ['Status', 'Rating', 'Unqualified_Reason__c', 'Removal_Status__c', 'DoNotCall', 'Skip_on_Dialer__c'],
  Opportunity: ['StageName', 'Rating__c', 'Loss_Reason__c', 'Closed_Lost_Reason__c', 'Next_Follow_Up_Date__c', 'Skip_on_Dialer__c'],
};

/**
 * One field the write-back may write. `name` is the org's spelling; `kind` is the qualification kind, or `status` for
 * the fields only the outcome tables and the write-back itself write (never offered to the mapping model).
 */
export interface WritableField {
  name: string;
  label: string;
  type: string;
  /** Active values only, for picklist and multipicklist fields; null otherwise. */
  picklist: string[] | null;
  kind: FieldKind | 'status';
}

/** Describe types a qualification kind may be written to: an org that changed a field's type loses it, never gets junk. */
const KIND_TYPES: Readonly<Record<FieldKind, ReadonlySet<string>>> = {
  picklist: new Set(['picklist']),
  multipicklist: new Set(['multipicklist']),
  currency: new Set(['currency', 'double', 'int']),
  boolean: new Set(['boolean']),
  text: new Set(['string', 'textarea']),
};

function allowlist(sfObject: SfObject): Map<string, FieldKind | 'status'> {
  const topic = [...Object.values(QUALIFICATION_FIELDS[sfObject]), ...Object.values(EXTRA_FIELDS[sfObject])].flatMap((fs): readonly TopicField[] => fs ?? []);
  const out = new Map<string, FieldKind | 'status'>();
  for (const t of topic) out.set(t.field, t.kind);
  for (const s of STATUS_FIELDS[sfObject]) out.set(s, 'status');
  out.set(CHANGES_FIELD, 'status');
  return out;
}

const isPicklist = (f: SObjectField): boolean => f.type === 'picklist' || f.type === 'multipicklist';

/**
 * The allowlist ∩ the describe, keyed by the allowlist's name. A field is kept when the org has it (matched
 * case-insensitively), `updateable === true` (unknown means no: 5a Fix 1, M-5), `calculated !== true`, it is not on
 * `ROLLUP_DENY`, its name passes `FIELD_API_NAME`, and (for qualification fields) its type still fits its kind.
 */
export function writableFields(d: SObjectDescribe, sfObject: SfObject): Map<string, WritableField> {
  const byName = new Map(d.fields.map((f) => [f.name.toLowerCase(), f]));
  const out = new Map<string, WritableField>();
  for (const [name, kind] of allowlist(sfObject)) {
    const f = byName.get(name.toLowerCase());
    if (!f || f.updateable !== true || f.calculated === true) continue;
    if (DENY_LOWER[sfObject].has(f.name.toLowerCase()) || !FIELD_API_NAME.test(f.name)) continue;
    if (kind !== 'status' && !KIND_TYPES[kind].has(f.type)) continue;
    const picklist = isPicklist(f) ? (f.picklistValues ?? []).filter((p) => p.active).map((p) => p.value) : null;
    out.set(name, { name: f.name, label: f.label, type: f.type, picklist, kind });
  }
  return out;
}

export interface CurrentRecord {
  /** The row as Salesforce returned it, minus `attributes`. */
  values: Record<string, unknown>;
  ownerId: string | null;
  name: string | null;
  /** "<street>, <city>, <state> <zip>" from the parts the record has; null when it has none. */
  address: string | null;
  lastModifiedDate: string | null;
}

const BASE = ['Id', 'Name', 'OwnerId', 'LastModifiedDate'] as const;
const LEAD_EXTRA = ['Street', 'City', 'State', 'PostalCode', 'IsConverted'] as const;

/**
 * Opportunity has no standard address. Probed through the describe, most specific first per part. On _t2 (read-only
 * `sf sobject describe -o _t2 -s Opportunity`, 2026-10-06) the property address is Street__c, City__c, State__c (a
 * restricted picklist) and Zipcode__c; Property_Address__c and Zip__c do not exist there, and Full_Address__c /
 * Opportunity_Address__c are formulas. Zipcode__c is probed because it is the org's real ZIP field.
 */
const OPP_ADDRESS: Readonly<Record<'street' | 'city' | 'state' | 'zip', readonly string[]>> = {
  street: ['Property_Address__c', 'Street__c'],
  city: ['City__c'],
  state: ['State__c'],
  zip: ['Zip__c', 'Zipcode__c'],
};
const LEAD_ADDRESS = { street: ['Street'], city: ['City'], state: ['State'], zip: ['PostalCode'] } as const;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.replace(/\s+/g, ' ').trim() : null);

function firstText(row: Record<string, unknown>, names: readonly string[]): string | null {
  for (const n of names) {
    const v = text(row[n]);
    if (v !== null) return v;
  }
  return null;
}

function joinAddress(row: Record<string, unknown>, parts: Readonly<Record<'street' | 'city' | 'state' | 'zip', readonly string[]>>): string | null {
  const stateZip = [firstText(row, parts.state), firstText(row, parts.zip)].filter((p) => p !== null).join(' ');
  const all = [firstText(row, parts.street), firstText(row, parts.city), stateZip].filter((p): p is string => p !== null && p !== '');
  return all.length > 0 ? all.join(', ') : null;
}

/** Each part's probe names the org has, in probe order. */
function oppAddressFields(d: SObjectDescribe): Record<'street' | 'city' | 'state' | 'zip', string[]> {
  const has = new Set(d.fields.map((f) => f.name));
  const keep = (names: readonly string[]) => names.filter((n) => has.has(n));
  return { street: keep(OPP_ADDRESS.street), city: keep(OPP_ADDRESS.city), state: keep(OPP_ADDRESS.state), zip: keep(OPP_ADDRESS.zip) };
}

/** Appends each name once, case-insensitively, keeping the first spelling. */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The record as it is now, read as the integration user. No row, or a converted Lead, gives null: write-back skips it.
 * `describe` is used for the Opportunity address probe; without it the Opportunity is described here.
 */
export async function readCurrent(
  client: SalesforceClient,
  sfObject: SfObject,
  id: string,
  fields: readonly string[],
  describe?: SObjectDescribe,
): Promise<CurrentRecord | null> {
  if (!SF_ID.test(id)) throw new RangeError('readCurrent: not a Salesforce record id');
  const bad = fields.find((f) => !FIELD_API_NAME.test(f));
  if (bad !== undefined) throw new RangeError('readCurrent: not a field API name');
  const address = sfObject === 'Lead' ? LEAD_ADDRESS : oppAddressFields(describe ?? (await client.describe(sfObject)));
  const extra = sfObject === 'Lead' ? [...LEAD_EXTRA] : [...address.street, ...address.city, ...address.state, ...address.zip];
  const select = uniqueNames([...BASE, ...fields, ...extra]);
  const rows = await client.query<Record<string, unknown>>(`SELECT ${select.join(', ')} FROM ${sfObject} WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  const row = rows[0];
  if (!row || (sfObject === 'Lead' && row.IsConverted === true)) return null;
  const { attributes: _attributes, ...values } = row;
  return {
    values,
    ownerId: text(row.OwnerId),
    name: text(row.Name),
    address: joinAddress(row, address),
    lastModifiedDate: text(row.LastModifiedDate),
  };
}
