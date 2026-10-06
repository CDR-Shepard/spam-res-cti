/**
 * Plan 1D: the qualification topics a seller conversation should cover, the Salesforce fields that answer each one
 * (spec §5.1), and which topics a record leaves unanswered. The single source for the plan prompt's "missing" facts
 * (call-plans/plan-context.ts) and the write-back's field allowlist.
 *
 * Pure: no Salesforce reads. The research snapshot drops null and false values, so a field absent from the self block
 * reads as blank.
 */
import { QUALIFICATION_TOPICS, type QualificationTopic } from '@cti/contracts';

export type FieldKind = 'picklist' | 'multipicklist' | 'currency' | 'boolean' | 'text';
export interface TopicField {
  field: string;
  kind: FieldKind;
  /** booleans: only ever set false → true */
  trueOnly?: boolean;
}
type SfObject = 'Lead' | 'Opportunity';
type TopicMap = Readonly<Partial<Record<QualificationTopic, readonly TopicField[]>>>;

const pick = (field: string): TopicField => ({ field, kind: 'picklist' });
const flag = (field: string): TopicField => ({ field, kind: 'boolean', trueOnly: true });

const SHARED = {
  timeline: [pick('Timeline__c')],
  condition: [pick('Condition__c')],
  occupancy: [pick('Occupancy__c')],
  competition: [{ field: 'Competition__c', kind: 'multipicklist' }],
  mortgage: [{ field: 'Amount_Owed__c', kind: 'currency' }],
} as const satisfies TopicMap;
const MOTIVATION = [pick('Motivation__c'), pick('SecondaryMotivation__c')];
const MAJOR_REPAIRS: TopicField = { field: 'Major_Repairs_Needed__c', kind: 'multipicklist' };

/** decision_makers has no field: it is never missing and never written. */
export const QUALIFICATION_FIELDS: Readonly<Record<SfObject, TopicMap>> = {
  Lead: {
    motivation: MOTIVATION,
    timeline: SHARED.timeline,
    condition: SHARED.condition,
    repairs: [MAJOR_REPAIRS, flag('Roof_Issues__c'), flag('Foundation_Issues__c'), flag('Mold__c')],
    occupancy: SHARED.occupancy,
    price: [{ field: 'Seller_s_Asking_Price__c', kind: 'currency' }],
    competition: SHARED.competition,
    mortgage: SHARED.mortgage,
  },
  Opportunity: {
    motivation: [...MOTIVATION, { field: 'Reason_For_Selling__c', kind: 'text' }],
    timeline: SHARED.timeline,
    condition: SHARED.condition,
    repairs: [MAJOR_REPAIRS],
    occupancy: SHARED.occupancy,
    price: [{ field: 'SellersAskingPrice__c', kind: 'currency' }],
    competition: SHARED.competition,
    mortgage: SHARED.mortgage,
  },
};

/** Fields the write-back may fill that answer no topic. */
export const EXTRA_FIELDS: Readonly<Record<SfObject, Readonly<Record<'language', readonly TopicField[]>>>> = {
  Lead: { language: [flag('Spanish_Speaker__c')] },
  Opportunity: { language: [flag('Spanish_Speaker__c')] },
};

/** The AI never writes these. */
export const NEVER_WRITE_VALUES: ReadonlySet<string> = new Set(["i didn't ask", "didn't ask"]);
/** Written only when the seller explicitly declined, and only over a blank / never-write value. */
export const DECLINED_VALUES: ReadonlySet<string> = new Set(["seller didn't say", "seller wouldn't say", "seller wouldn't disclose"]);
/** Lower-cased. A field holding only these reads as blank. */
export const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([...NEVER_WRITE_VALUES, ...DECLINED_VALUES, 'unsure']);

const isPlaceholder = (v: string): boolean => PLACEHOLDER_VALUES.has(v.trim().toLowerCase());

export function isBlankish(value: string | null | undefined, kind: FieldKind): boolean {
  if (value === null || value === undefined || value.trim() === '') return true;
  switch (kind) {
    case 'boolean':
      return value.trim().toLowerCase() === 'false';
    case 'currency':
      return Number(value.trim()) === 0;
    case 'multipicklist':
      return value.split(';').every((v) => v.trim() === '' || isPlaceholder(v));
    default:
      return isPlaceholder(value);
  }
}

/**
 * Every field of QUALIFICATION_FIELDS and EXTRA_FIELDS for the object, once, topics first. Research always selects
 * these and never drops them for size (Fix 1, I-2), the way it treats the consent field.
 */
export function qualificationFieldNames(sfObject: SfObject): string[] {
  const all = [...Object.values(QUALIFICATION_FIELDS[sfObject]), ...Object.values(EXTRA_FIELDS[sfObject])].flatMap((fields) => (fields ?? []).map((f) => f.field));
  return [...new Set(all)];
}

/**
 * The topics no field of the record answers, in QUALIFICATION_TOPICS order.
 *
 * `fieldsRead` (Fix 1, I-2) names the fields research actually selected. A field it never read is unknown, not blank:
 * it is ignored, and a topic none of whose fields was read is never missing. Without the list (a snapshot from before
 * Fix 1) every field counts as read.
 */
export function missingTopics(sfObject: SfObject, selfFields: ReadonlyArray<{ name: string; value: string }>, fieldsRead?: readonly string[]): QualificationTopic[] {
  const values = new Map(selfFields.map((f) => [f.name.toLowerCase(), f.value]));
  const read = fieldsRead ? new Set(fieldsRead.map((f) => f.toLowerCase())) : null;
  const map = QUALIFICATION_FIELDS[sfObject];
  return QUALIFICATION_TOPICS.filter((topic) => {
    const fields = (map[topic] ?? []).filter((f) => read === null || read.has(f.field.toLowerCase()));
    return fields.length > 0 && fields.every((f) => isBlankish(values.get(f.field.toLowerCase()), f.kind));
  });
}
