/**
 * The Salesforce field contract for AI-call consent (spec §11.1), in one place.
 *
 * The metadata that creates these fields lives in
 * `salesforce/force-app/main/default/objects/{Lead,Opportunity}/fields/` and is
 * pinned against THESE constants by `salesforce-metadata.test.ts` — rename one
 * side and that test fails, so the outbox can never write a field or a picklist
 * value the org does not have.
 */
export const CONSENT_FIELDS = {
  checkbox: 'AI_Call_Consent__c',
  date: 'AI_Call_Consent_Date__c',
  source: 'AI_Call_Consent_Source__c',
} as const;

/** Picklist values of `AI_Call_Consent_Source__c`, in picklist order. */
export const CONSENT_SOURCES = ['Text Reply', 'Email Reply', 'Web Form', 'Inbound Call', 'Rep'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** The objects that carry the consent fields. */
export const CONSENT_OBJECTS = ['Lead', 'Opportunity'] as const;

/** The CTI's Task marker field (salesforce/.../Activity/fields/CTI_Origin__c) and this system's value for it. */
export const CTI_ORIGIN_FIELD = 'CTI_Origin__c';
export const CTI_ORIGIN_AI_OUTREACH = 'AI Outreach';
