/**
 * Which fields hold a record's PROPERTY address, chosen from the object's
 * describe, and how to say it ("123 Main St, Austin, TX 78701").
 *
 * Lead and Contact use their standard compound-address parts. Opportunity has
 * no standard address, so the org's custom property fields are matched by API
 * name (case-insensitive, text-typed fields only), in priority order.
 */
import type { AiCallObject } from './record.js';

export interface DescribedField {
  name: string;
  type: string;
}

/** API names of the chosen fields; null when the object has none for that part. */
export interface AddressFields {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

type Matcher = string | RegExp;

const STANDARD: Record<Exclude<AiCallObject, 'Opportunity'>, Record<keyof AddressFields, string>> = {
  Lead: { street: 'Street', city: 'City', state: 'State', zip: 'PostalCode' },
  Contact: { street: 'MailingStreet', city: 'MailingCity', state: 'MailingState', zip: 'MailingPostalCode' },
};

/**
 * Any `*Property*Address*__c` text field that is not a previous / prior / old /
 * mailing address. Ranked above the generic `Address__c`.
 */
const PROPERTY_ADDRESS = /^(?!\w*(?:previous|prior|old|mailing))\w*property\w*address\w*__c$/i;

/** Opportunity custom fields, most specific first. */
const OPPORTUNITY: Record<keyof AddressFields, readonly Matcher[]> = {
  street: ['Property_Address__c', 'Property_Street__c', 'Street__c', PROPERTY_ADDRESS, 'Address__c'],
  city: ['Property_City__c', 'City__c'],
  state: ['Property_State__c', 'State__c'],
  zip: ['Property_Zip__c', 'Zip__c', 'Postal_Code__c'],
};

const TEXT_TYPES = new Set(['string', 'textarea']);

function matches(name: string, m: Matcher): boolean {
  return typeof m === 'string' ? name.toLowerCase() === m.toLowerCase() : m.test(name);
}

function firstMatch(fields: readonly DescribedField[], matchers: readonly Matcher[]): string | null {
  for (const m of matchers) {
    const hit = fields.find((f) => TEXT_TYPES.has(f.type) && matches(f.name, m));
    if (hit) return hit.name;
  }
  return null;
}

export function pickAddressFields(objectType: AiCallObject, fields: readonly DescribedField[]): AddressFields {
  if (objectType === 'Opportunity') {
    return {
      street: firstMatch(fields, OPPORTUNITY.street),
      city: firstMatch(fields, OPPORTUNITY.city),
      state: firstMatch(fields, OPPORTUNITY.state),
      zip: firstMatch(fields, OPPORTUNITY.zip),
    };
  }
  const names = new Set(fields.map((f) => f.name));
  const std = STANDARD[objectType];
  const has = (n: string) => (names.has(n) ? n : null);
  return { street: has(std.street), city: has(std.city), state: has(std.state), zip: has(std.zip) };
}

/** The chosen fields' API names, for the record SOQL. */
export function addressFieldNames(a: AddressFields): string[] {
  return [a.street, a.city, a.state, a.zip].filter((n): n is string => !!n);
}

function part(row: Record<string, unknown>, field: string | null): string | null {
  const v = field ? row[field] : null;
  // A multi-line street (textarea) reads as one comma-separated line.
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\s*\n\s*/g, ', ') : null;
}

/** `"<street>, <city>, <state> <zip>"`, skipping empty parts; null when nothing. */
export function formatAddress(row: Record<string, unknown>, a: AddressFields): string | null {
  const stateZip = [part(row, a.state), part(row, a.zip)].filter(Boolean).join(' ');
  return [part(row, a.street), part(row, a.city), stateZip].filter(Boolean).join(', ') || null;
}
