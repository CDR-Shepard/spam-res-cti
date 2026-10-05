import type { FieldMap, ObjectFieldMap, SfObject } from '@cti/contracts';
import type { SObjectDescribe } from '@cti/salesforce';

/** A notes field is a text field whose API name says it holds notes (spec §5). */
export const NOTES_FIELD_PATTERN = /notes|description|motivation/i;
const NOTES_TYPES: ReadonlySet<string> = new Set(['textarea', 'string']);
const MAX_NOTES_FIELDS = 20;

/**
 * A Salesforce field API name: letters, digits, underscores, starting with a
 * letter (custom fields end `__c`). Every field name this service puts into
 * SOQL passes this first — an admin-edited field map is never interpolated
 * unchecked.
 */
export const FIELD_API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** The CTI dialer's phone order (spec §5); filtered to the fields the org has. */
const DEFAULT_PHONES: Readonly<Record<SfObject, readonly string[]>> = {
  Lead: ['MobilePhone', 'Phone'],
  Opportunity: ['Mobile_Phone__c', 'Phone__c', 'Other_Phone__c'],
};

export interface ObjectDescribes {
  Lead: SObjectDescribe;
  Opportunity: SObjectDescribe;
}

function fieldSet(d: SObjectDescribe): ReadonlySet<string> {
  return new Set(d.fields.map((f) => f.name.toLowerCase()));
}

function objectDefaults(sfObject: SfObject, d: SObjectDescribe): ObjectFieldMap {
  const names = fieldSet(d);
  const ifPresent = (name: string): string | null => (names.has(name.toLowerCase()) ? name : null);
  const isLead = sfObject === 'Lead';
  return {
    notes: d.fields
      .filter((f) => NOTES_TYPES.has(f.type) && NOTES_FIELD_PATTERN.test(f.name))
      .map((f) => f.name)
      .slice(0, MAX_NOTES_FIELDS),
    phones: DEFAULT_PHONES[sfObject].filter((name) => names.has(name.toLowerCase())),
    // Opportunity email is the primary contact role's Contact.Email (null = use the contact role).
    email: isLead ? ifPresent('Email') : null,
    doNotCall: isLead ? ifPresent('DoNotCall') : null,
    emailOptOut: isLead ? ifPresent('HasOptedOutOfEmail') : null,
    skipOnDialer: ifPresent('Skip_on_Dialer__c'),
    consent: ifPresent('AI_Call_Consent__c'),
    webFormSource: ifPresent('Lead_Form_Source__c'),
    state: isLead ? ifPresent('State') : null,
    leadManager: ifPresent('LeadManager__c'),
  };
}

/** Pure: the field map a fresh connection starts with, derived from Lead and Opportunity describe. */
export function defaultFieldMap(d: ObjectDescribes): FieldMap {
  return { Lead: objectDefaults('Lead', d.Lead), Opportunity: objectDefaults('Opportunity', d.Opportunity) };
}

/** Every non-notes field the map names, in map order, each once (SOQL rejects a field selected twice, case-insensitively). */
export function mappedFieldNames(m: ObjectFieldMap): string[] {
  const named = [...m.phones, m.email, m.doNotCall, m.emailOptOut, m.skipOnDialer, m.consent, m.webFormSource, m.state, m.leadManager];
  return uniqueFieldNames(named.filter((n): n is string => n !== null));
}

/** Case-insensitive de-duplication, first spelling kept. */
export function uniqueFieldNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pure: what is wrong with an admin's field map, as display lines
 * (`Lead.Foo: not a field API name`, `Opportunity.Bar__c: no such field`).
 * Without `describes` only the name shape is checked.
 */
export function fieldMapProblems(map: FieldMap, describes?: ObjectDescribes): string[] {
  const problems: string[] = [];
  for (const sfObject of ['Lead', 'Opportunity'] as const) {
    const m = map[sfObject];
    const known = describes ? fieldSet(describes[sfObject]) : null;
    for (const name of uniqueFieldNames([...m.notes, ...mappedFieldNames(m)])) {
      if (!FIELD_API_NAME.test(name)) problems.push(`${sfObject}.${name}: not a field API name`);
      else if (known && !known.has(name.toLowerCase())) problems.push(`${sfObject}.${name}: no such field`);
    }
  }
  return problems;
}
