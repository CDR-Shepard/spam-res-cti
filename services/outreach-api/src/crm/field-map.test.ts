import { describe, expect, it } from 'vitest';
import type { FieldMap } from '@cti/contracts';
import type { SObjectDescribe, SObjectField } from '@cti/salesforce';
import { defaultFieldMap, fieldMapProblems, mappedFieldNames, NOTES_FIELD_PATTERN } from './field-map.js';

const f = (name: string, type = 'string'): SObjectField => ({ name, type, label: name });

/** GG Homes-shaped describes (field order as Salesforce returns it). */
const lead: SObjectDescribe = {
  name: 'Lead',
  fields: [
    f('Id', 'id'), f('Name'), f('MobilePhone', 'phone'), f('Phone', 'phone'), f('Email', 'email'),
    f('DoNotCall', 'boolean'), f('HasOptedOutOfEmail', 'boolean'), f('State'), f('Description', 'textarea'),
    f('Notes__c', 'textarea'), f('Agent_Notes__c', 'textarea'), f('Motivation__c'), f('SecondaryMotivation__c', 'textarea'),
    f('Appointment_Notes__c', 'textarea'), f('Analyst_Notes__c', 'textarea'), f('Notes_Count__c', 'double'),
    f('Skip_on_Dialer__c', 'boolean'), f('Lead_Form_Source__c', 'picklist'), f('LeadManager__c', 'reference'),
  ],
};
const opportunity: SObjectDescribe = {
  name: 'Opportunity',
  fields: [
    f('Id', 'id'), f('Name'), f('Description', 'textarea'), f('Mobile_Phone__c', 'phone'), f('Phone__c', 'phone'),
    f('Other_Phone__c', 'phone'), f('Skip_on_Dialer__c', 'boolean'), f('AI_Call_Consent__c', 'boolean'),
  ],
};

describe('defaultFieldMap', () => {
  it('derives the GG Homes defaults from describe, in describe order', () => {
    expect(defaultFieldMap({ Lead: lead, Opportunity: opportunity })).toEqual({
      Lead: {
        notes: ['Description', 'Notes__c', 'Agent_Notes__c', 'Motivation__c', 'SecondaryMotivation__c', 'Appointment_Notes__c', 'Analyst_Notes__c'],
        phones: ['MobilePhone', 'Phone'],
        email: 'Email',
        doNotCall: 'DoNotCall',
        emailOptOut: 'HasOptedOutOfEmail',
        skipOnDialer: 'Skip_on_Dialer__c',
        consent: null,
        webFormSource: 'Lead_Form_Source__c',
        state: 'State',
        leadManager: 'LeadManager__c',
      },
      Opportunity: {
        notes: ['Description'],
        phones: ['Mobile_Phone__c', 'Phone__c', 'Other_Phone__c'],
        email: null,
        doNotCall: null,
        emailOptOut: null,
        skipOnDialer: 'Skip_on_Dialer__c',
        consent: 'AI_Call_Consent__c',
        webFormSource: null,
        state: null,
        leadManager: null,
      },
    } satisfies FieldMap);
  });

  it('drops phone and flag fields the org does not have', () => {
    const bare: SObjectDescribe = { name: 'Opportunity', fields: [f('Id', 'id'), f('Phone__c', 'phone')] };
    const map = defaultFieldMap({ Lead: { name: 'Lead', fields: [f('Id', 'id'), f('Phone', 'phone')] }, Opportunity: bare });
    expect(map.Lead).toMatchObject({ phones: ['Phone'], email: null, doNotCall: null, emailOptOut: null, skipOnDialer: null, state: null, leadManager: null });
    expect(map.Opportunity.phones).toEqual(['Phone__c']);
  });

  it('keeps at most 20 notes fields and only text types', () => {
    const many: SObjectDescribe = { name: 'Lead', fields: [...Array.from({ length: 25 }, (_, i) => f(`Notes_${i}__c`, 'textarea')), f('Motivation_Score__c', 'double')] };
    const map = defaultFieldMap({ Lead: many, Opportunity: opportunity });
    expect(map.Lead.notes).toHaveLength(20);
    expect(map.Lead.notes).not.toContain('Motivation_Score__c');
  });

  it.each([
    ['Notes__c', true], ['agent_notes__c', true], ['Description', true], ['SecondaryMotivation__c', true], ['Phone', false], ['Name', false],
  ])('NOTES_FIELD_PATTERN %s → %s', (name, expected) => {
    expect(NOTES_FIELD_PATTERN.test(name)).toBe(expected);
  });
});

describe('fieldMapProblems', () => {
  const good = defaultFieldMap({ Lead: lead, Opportunity: opportunity });

  it('accepts the default map against its own describe', () => {
    expect(fieldMapProblems(good, { Lead: lead, Opportunity: opportunity })).toEqual([]);
  });

  it('rejects anything that is not a plain field API name, without needing describe', () => {
    const bad: FieldMap = { ...good, Lead: { ...good.Lead, notes: ['Notes__c', 'Id FROM Lead WHERE'], email: "Email'" } };
    expect(fieldMapProblems(bad)).toEqual(['Lead.Id FROM Lead WHERE: not a field API name', "Lead.Email': not a field API name"]);
  });

  it('flags fields missing from the describe, case-insensitively', () => {
    const map: FieldMap = { ...good, Opportunity: { ...good.Opportunity, phones: ['mobile_phone__c', 'Cell__c'] } };
    expect(fieldMapProblems(map, { Lead: lead, Opportunity: opportunity })).toEqual(['Opportunity.Cell__c: no such field']);
  });

  it('mappedFieldNames lists every named field except notes, once', () => {
    expect(mappedFieldNames(good.Lead)).toEqual(['MobilePhone', 'Phone', 'Email', 'DoNotCall', 'HasOptedOutOfEmail', 'Skip_on_Dialer__c', 'Lead_Form_Source__c', 'State', 'LeadManager__c']);
  });
});
