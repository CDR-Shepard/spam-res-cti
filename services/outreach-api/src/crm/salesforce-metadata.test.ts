/**
 * The Salesforce metadata that 1B deploys (B1) — pinned. Read from disk (no org
 * in the unit suite), so the files' text IS the contract, the same way
 * packages/db's migration-NNNN tests pin SQL. The field names and picklist
 * values are pinned against `consent-fields.ts`, the constants the outbox
 * writes with: rename one side and this fails before a deploy can.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONSENT_FIELDS, CONSENT_OBJECTS, CONSENT_SOURCES } from './consent-fields.js';

const here = dirname(fileURLToPath(import.meta.url));
/** services/outreach-api/src/crm → repo root. */
const FORCE_APP = resolve(here, '../../../../salesforce/force-app/main/default');
const read = (rel: string): string => readFileSync(resolve(FORCE_APP, rel), 'utf8');

/** Inner text of every `<tag>…</tag>` in document order (none of these tags nest in themselves). */
function tagValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!.trim());
}
function only(xml: string, tag: string): string {
  const values = tagValues(xml, tag);
  expect(values, `<${tag}> count`).toHaveLength(1);
  return values[0]!;
}
const fieldFile = (object: string, field: string): string => `objects/${object}/fields/${field}.field-meta.xml`;

/** Plan 1D: the write-back's record of what it changed after each AI call. */
const LAST_CALL_CHANGES = 'AI_Last_Call_Changes__c';
const LAST_CALL_CHANGES_OBJECTS = ['Lead', 'Opportunity'] as const;

describe.each(CONSENT_OBJECTS)('%s consent fields', (object) => {
  it('every field file exists and names itself', () => {
    for (const field of Object.values(CONSENT_FIELDS)) {
      expect(existsSync(resolve(FORCE_APP, fieldFile(object, field))), field).toBe(true);
      const xml = read(fieldFile(object, field));
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">')).toBe(true);
      expect(tagValues(xml, 'fullName')[0]).toBe(field);
    }
  });

  it('AI_Call_Consent__c is a checkbox that defaults to unticked', () => {
    const xml = read(fieldFile(object, CONSENT_FIELDS.checkbox));
    expect(only(xml, 'type')).toBe('Checkbox');
    expect(only(xml, 'defaultValue')).toBe('false');
    expect(only(xml, 'label')).toBe('AI Call Consent');
  });

  it('AI_Call_Consent_Date__c is a date/time', () => {
    const xml = read(fieldFile(object, CONSENT_FIELDS.date));
    expect(only(xml, 'type')).toBe('DateTime');
    expect(only(xml, 'label')).toBe('AI Call Consent Date');
    expect(only(xml, 'required')).toBe('false');
  });

  it('AI_Call_Consent_Source__c is a RESTRICTED picklist whose values are exactly CONSENT_SOURCES, in order, none default', () => {
    const xml = read(fieldFile(object, CONSENT_FIELDS.source));
    expect(only(xml, 'type')).toBe('Picklist');
    expect(only(xml, 'restricted')).toBe('true');
    expect(only(xml, 'sorted')).toBe('false');
    const values = tagValues(xml, 'value');
    expect(values.map((v) => tagValues(v, 'fullName')[0])).toEqual([...CONSENT_SOURCES]);
    expect(values.map((v) => tagValues(v, 'label')[0])).toEqual([...CONSENT_SOURCES]);
    expect(values.map((v) => tagValues(v, 'default')[0])).toEqual(CONSENT_SOURCES.map(() => 'false'));
  });
});

describe.each(LAST_CALL_CHANGES_OBJECTS)('%s AI_Last_Call_Changes__c (plan 1D write-back)', (object) => {
  it('is a 32,768-character long text area labelled AI Last Call Changes', () => {
    expect(existsSync(resolve(FORCE_APP, fieldFile(object, LAST_CALL_CHANGES)))).toBe(true);
    const xml = read(fieldFile(object, LAST_CALL_CHANGES));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">')).toBe(true);
    expect(only(xml, 'fullName')).toBe(LAST_CALL_CHANGES);
    expect(only(xml, 'type')).toBe('LongTextArea');
    expect(only(xml, 'length')).toBe('32768');
    expect(only(xml, 'visibleLines')).toBe('10');
    expect(only(xml, 'label')).toBe('AI Last Call Changes');
    expect(only(xml, 'externalId')).toBe('false');
  });

  it('is identical on Lead and Opportunity', () => {
    expect(read(fieldFile(object, LAST_CALL_CHANGES))).toBe(read(fieldFile('Lead', LAST_CALL_CHANGES)));
  });
});

describe('AI_Outreach permission set', () => {
  const xml = read('permissionsets/AI_Outreach.permissionset-meta.xml');
  const fieldPerms = new Map(
    tagValues(xml, 'fieldPermissions').map((b) => [only(b, 'field'), { readable: only(b, 'readable'), editable: only(b, 'editable') }]),
  );
  const objectPerms = new Map(tagValues(xml, 'objectPermissions').map((b) => [only(b, 'object'), b]));

  it('is labelled AI Outreach and bound to no license (assignable to an Integration user)', () => {
    expect(only(xml, 'label')).toBe('AI Outreach');
    expect(xml).not.toContain('<license>');
    expect(only(xml, 'hasActivationRequired')).toBe('false');
  });

  it('grants read + edit on all six consent fields', () => {
    for (const object of CONSENT_OBJECTS) {
      for (const field of Object.values(CONSENT_FIELDS)) {
        expect(fieldPerms.get(`${object}.${field}`), `${object}.${field}`).toEqual({ readable: 'true', editable: 'true' });
      }
    }
  });

  it('grants read + edit on AI Last Call Changes on Lead and Opportunity (plan 1D)', () => {
    for (const object of LAST_CALL_CHANGES_OBJECTS) {
      expect(fieldPerms.get(`${object}.${LAST_CALL_CHANGES}`), object).toEqual({ readable: 'true', editable: 'true' });
    }
  });

  it('keeps the field blocks in alphabetical order', () => {
    const fields = [...fieldPerms.keys()];
    expect(fields).toEqual([...fields].sort());
  });

  it('grants edit on the do-not-contact flags of Lead and Contact, and on the Task marker', () => {
    for (const f of ['Lead.DoNotCall', 'Lead.HasOptedOutOfEmail', 'Contact.DoNotCall', 'Contact.HasOptedOutOfEmail', 'Activity.CTI_Origin__c']) {
      expect(fieldPerms.get(f), f).toEqual({ readable: 'true', editable: 'true' });
    }
  });

  it('grants every other field read-only', () => {
    const editable = new Set([
      ...CONSENT_OBJECTS.flatMap((o) => Object.values(CONSENT_FIELDS).map((f) => `${o}.${f}`)),
      'Lead.DoNotCall', 'Lead.HasOptedOutOfEmail', 'Contact.DoNotCall', 'Contact.HasOptedOutOfEmail', 'Activity.CTI_Origin__c',
      ...LAST_CALL_CHANGES_OBJECTS.map((o) => `${o}.${LAST_CALL_CHANGES}`),
    ]);
    for (const [field, perm] of fieldPerms) {
      expect(perm.readable, field).toBe('true');
      if (!editable.has(field)) expect(perm.editable, field).toBe('false');
    }
    for (const f of ['Lead.Phone', 'Lead.MobilePhone', 'Lead.Email', 'Contact.Phone', 'Contact.MobilePhone', 'Contact.Email', 'Lead.Skip_on_Dialer__c', 'Opportunity.Skip_on_Dialer__c']) {
      expect(fieldPerms.has(f), f).toBe(true);
    }
  });

  it('Account, Contact, Lead and Opportunity: read, edit and View All; create only on what a conversion creates; never delete or Modify All', () => {
    expect([...objectPerms.keys()]).toEqual(['Account', 'Contact', 'Lead', 'Opportunity']);
    const creates = new Set(['Account', 'Contact', 'Opportunity']);
    for (const [object, block] of objectPerms) {
      expect({
        allowCreate: only(block, 'allowCreate'), allowDelete: only(block, 'allowDelete'), allowEdit: only(block, 'allowEdit'),
        allowRead: only(block, 'allowRead'), modifyAllRecords: only(block, 'modifyAllRecords'), viewAllRecords: only(block, 'viewAllRecords'),
      }, object).toEqual({
        allowCreate: creates.has(object) ? 'true' : 'false', allowDelete: 'false', allowEdit: 'true', allowRead: 'true', modifyAllRecords: 'false', viewAllRecords: 'true',
      });
    }
    expect(xml).not.toMatch(/<allowDelete>true<\/allowDelete>/);
    expect(xml).not.toMatch(/<modifyAllRecords>true<\/modifyAllRecords>/);
  });

  it('the system permissions are exactly Convert Leads, Edit Events and Edit Tasks', () => {
    const perms = tagValues(xml, 'userPermissions').map((b) => ({ name: only(b, 'name'), enabled: only(b, 'enabled') }));
    expect(perms).toEqual([
      { name: 'ConvertLeads', enabled: 'true' },
      { name: 'EditEvent', enabled: 'true' },
      { name: 'EditTask', enabled: 'true' },
    ]);
  });

  it('the comment and description say what 1D grants, and no longer that it never creates or converts', () => {
    expect(xml).not.toContain('never creates, converts or deletes');
    expect(xml).toContain('creates Events, Tasks and Chatter posts, and converts a Lead that booked an appointment; never deletes');
    expect(xml).toContain('AI_Outreach_Fields');
    expect(only(xml, 'description')).not.toContain('Grants no create');
    expect(only(xml, 'description').length).toBeLessThanOrEqual(255);
  });
});

describe('AI_Call_Consent_Access permission set (reps who start AI calls)', () => {
  const xml = read('permissionsets/AI_Call_Consent_Access.permissionset-meta.xml');
  const blocks = tagValues(xml, 'fieldPermissions').map((b) => ({ field: only(b, 'field'), readable: only(b, 'readable'), editable: only(b, 'editable') }));

  it('is labelled AI Call Consent Access and bound to no license', () => {
    expect(only(xml, 'label')).toBe('AI Call Consent Access');
    expect(xml).not.toContain('<license>');
    expect(only(xml, 'hasActivationRequired')).toBe('false');
  });

  it('grants read + edit on exactly the six consent fields, pinned to the same constants — nothing else', () => {
    const expected = CONSENT_OBJECTS.flatMap((o) => Object.values(CONSENT_FIELDS).map((f) => `${o}.${f}`)).sort();
    expect(blocks.map((b) => b.field).sort()).toEqual(expected);
    for (const b of blocks) expect(b, b.field).toMatchObject({ readable: 'true', editable: 'true' });
  });

  it('grants no object or system permissions', () => {
    expect(xml).not.toContain('<objectPermissions>');
    expect(xml).not.toContain('<userPermissions>');
  });
});
