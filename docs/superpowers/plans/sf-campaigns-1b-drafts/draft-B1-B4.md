<!-- Draft of tasks B1–B4 for plan 1B (docs/superpowers/plans/2026-10-04-sf-campaigns-1b-live-calls.md), written to the shared skeleton (.superpowers/sdd/outreach3-plan-skeleton.md). Deviations are listed under "Skeleton corrections" at the end. Every code block was run in a prototype on top of the A3/A4/A5/A8/A10/A11/A12/A13 drafts. Results: outreach-api 163 unit tests passed (plus 7 real-Postgres tests on Postgres 17), cti-api 102 files / 2,074 tests passed, @cti/db 64, @cti/contracts 61, outreach-web 95, and strict `tsc` was clean in every workspace. -->

> **Packages are consumed through `dist/`.** `@cti/db` and `@cti/contracts` resolve to their built `dist/` files. After any task step that edits `packages/*`, run `npm run build:packages` before running a service's tests.

> **Cross-draft decisions applied here:**
> - A11's `onConfirmed(args, tx)` runs inside the confirm transaction, and B2 enqueues with that `tx`.
> - `@cti/salesforce` throws `SalesforceAuthError` when the token refresh fails and `SalesforceApiError` for 5xx or an unreadable response. `createRecords` and `updateRecords` throw `RangeError` above 200 records and return `[]` for empty input.
> - Tests reuse A5's extended `fakeDb` harness.
> - `opt_outs` has `source` and `note`.
> - Tick queues reuse A8's `TICK_QUEUE_OPTIONS` (`policy: 'stately'`).
> - No B1–B4 code pauses a campaign. A broken connection leaves outbox rows pending, and A8's `pauseOrgCampaigns(…, 'crm_broken')` does the pausing.

---

### Task B1: Salesforce consent fields, the `AI_Outreach` permission set, and the setup runbook

This task ships the three AI-call consent fields on Lead and Opportunity (spec §11.1) and the permission set for the company-wide Integration user (spec §5). It also adds the runbook section an operator follows to deploy them. A read-from-disk test pins the XML to the constants that B2 and B3 write with, so a renamed field or picklist value fails in CI instead of in Salesforce.

The permission set grants only what phase 1 needs:
- **Edit** on the consent fields, and on `DoNotCall` and `HasOptedOutOfEmail` for Lead and Contact.
- **Read** on the standard phone, email and description fields that the campaign engine reads.
- **Read, edit and View All** on Lead, Opportunity and Contact. No create, no delete, no Modify All.
- **Edit Tasks** and `Activity.CTI_Origin__c`, for the phase 2 Task marker.

Tenant-only custom fields (notes, extra phone fields, web-form source) cannot appear in a repo permission set, because a reference to a field the org lacks fails the whole deploy. The runbook grants them in the org instead.

**Files:**
- Create: `salesforce/force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml`, `AI_Call_Consent_Date__c.field-meta.xml`, `AI_Call_Consent_Source__c.field-meta.xml`
- Create: `salesforce/force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml`, `AI_Call_Consent_Date__c.field-meta.xml`, `AI_Call_Consent_Source__c.field-meta.xml`. These are byte-identical to the Lead files.
- Create: `salesforce/force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml`
- Create: `services/outreach-api/src/crm/consent-fields.ts`
- Test: `services/outreach-api/src/crm/salesforce-metadata.test.ts`
- Create: `docs/runbooks/outreach-sf-campaigns.md` (§0, Salesforce setup. B8 appends the deploy and go-live sections.)

**Interfaces:**
- Consumes: the existing `Activity.CTI_Origin__c` and the `Skip_on_Dialer__c` fields on Lead and Opportunity, plus the deploy rules in `salesforce/README.md`. Nothing from earlier tasks.
- Produces:
  ```ts
  // services/outreach-api/src/crm/consent-fields.ts
  export const CONSENT_FIELDS: { readonly checkbox: 'AI_Call_Consent__c'; readonly date: 'AI_Call_Consent_Date__c'; readonly source: 'AI_Call_Consent_Source__c' };
  export const CONSENT_SOURCES: readonly ['Text Reply', 'Email Reply', 'Web Form', 'Inbound Call', 'Rep'];
  export type ConsentSource = (typeof CONSENT_SOURCES)[number];
  export const CONSENT_OBJECTS: readonly ['Lead', 'Opportunity'];
  export const CTI_ORIGIN_FIELD = 'CTI_Origin__c';
  export const CTI_ORIGIN_AI_OUTREACH = 'AI Outreach';
  ```
  Salesforce metadata:
  - On Lead and Opportunity: `AI_Call_Consent__c` (Checkbox, default false), `AI_Call_Consent_Date__c` (DateTime), and `AI_Call_Consent_Source__c` (restricted Picklist with the five values in `CONSENT_SOURCES` order).
  - Permission set `AI_Outreach`.
  - Runbook `docs/runbooks/outreach-sf-campaigns.md` §0.

- [ ] **Step 1: Write the failing test**

`services/outreach-api/src/crm/salesforce-metadata.test.ts`:
```ts
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

  it('grants edit on the do-not-contact flags of Lead and Contact, and on the Task marker', () => {
    for (const f of ['Lead.DoNotCall', 'Lead.HasOptedOutOfEmail', 'Contact.DoNotCall', 'Contact.HasOptedOutOfEmail', 'Activity.CTI_Origin__c']) {
      expect(fieldPerms.get(f), f).toEqual({ readable: 'true', editable: 'true' });
    }
  });

  it('grants every other field read-only', () => {
    const editable = new Set([
      ...CONSENT_OBJECTS.flatMap((o) => Object.values(CONSENT_FIELDS).map((f) => `${o}.${f}`)),
      'Lead.DoNotCall', 'Lead.HasOptedOutOfEmail', 'Contact.DoNotCall', 'Contact.HasOptedOutOfEmail', 'Activity.CTI_Origin__c',
    ]);
    for (const [field, perm] of fieldPerms) {
      expect(perm.readable, field).toBe('true');
      if (!editable.has(field)) expect(perm.editable, field).toBe('false');
    }
    for (const f of ['Lead.Phone', 'Lead.MobilePhone', 'Lead.Email', 'Contact.Phone', 'Contact.MobilePhone', 'Contact.Email', 'Lead.Skip_on_Dialer__c', 'Opportunity.Skip_on_Dialer__c']) {
      expect(fieldPerms.has(f), f).toBe(true);
    }
  });

  it('Lead, Opportunity and Contact: read, edit and View All — never create, delete or Modify All', () => {
    expect([...objectPerms.keys()].sort()).toEqual(['Contact', 'Lead', 'Opportunity']);
    for (const [object, block] of objectPerms) {
      expect({
        allowCreate: only(block, 'allowCreate'), allowDelete: only(block, 'allowDelete'), allowEdit: only(block, 'allowEdit'),
        allowRead: only(block, 'allowRead'), modifyAllRecords: only(block, 'modifyAllRecords'), viewAllRecords: only(block, 'viewAllRecords'),
      }, object).toEqual({
        allowCreate: 'false', allowDelete: 'false', allowEdit: 'true', allowRead: 'true', modifyAllRecords: 'false', viewAllRecords: 'true',
      });
    }
  });

  it('the only system permission is Edit Tasks', () => {
    const perms = tagValues(xml, 'userPermissions').map((b) => ({ name: only(b, 'name'), enabled: only(b, 'enabled') }));
    expect(perms).toEqual([{ name: 'EditTask', enabled: 'true' }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/salesforce-metadata.test.ts
```

Expected: `FAIL src/crm/salesforce-metadata.test.ts`, with `Error: Failed to load url ./consent-fields.js (resolved id: ./consent-fields.js) in …/salesforce-metadata.test.ts. Does the file exist?` and `Tests  no tests`.

- [ ] **Step 3: Write the constants**

`services/outreach-api/src/crm/consent-fields.ts`:
```ts
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
```

- [ ] **Step 4: Write the six field files**

Write each of the three files below twice: once under `salesforce/force-app/main/default/objects/Lead/fields/`, and once with identical contents under `salesforce/force-app/main/default/objects/Opportunity/fields/`. A field file carries no object name.

`AI_Call_Consent__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>AI_Call_Consent__c</fullName>
    <defaultValue>false</defaultValue>
    <description>Checked = this person agreed to calls from the AI assistant. Set by AI Outreach when it captures consent (a text or email reply, a web form, an inbound call) or by a rep. AI Outreach never places an AI call to a record without this box. Where and when consent came from are in AI Call Consent Source and AI Call Consent Date. (Outreach spec 2026-10-04, section 11.1.)</description>
    <externalId>false</externalId>
    <inlineHelpText>Tick only when this person has agreed to calls from our AI assistant. If you tick it yourself, set AI Call Consent Source to Rep.</inlineHelpText>
    <label>AI Call Consent</label>
    <trackTrending>false</trackTrending>
    <type>Checkbox</type>
</CustomField>
```

`AI_Call_Consent_Date__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>AI_Call_Consent_Date__c</fullName>
    <description>When AI-call consent was captured. Set by AI Outreach together with AI Call Consent. (Outreach spec 2026-10-04, section 11.1.)</description>
    <externalId>false</externalId>
    <inlineHelpText>When this person agreed to calls from our AI assistant.</inlineHelpText>
    <label>AI Call Consent Date</label>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>DateTime</type>
</CustomField>
```

`AI_Call_Consent_Source__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>AI_Call_Consent_Source__c</fullName>
    <description>Where AI-call consent came from: Text Reply, Email Reply, Web Form, Inbound Call, or Rep (a person ticked AI Call Consent). Set by AI Outreach together with AI Call Consent. The values are written by code - do not rename them. (Outreach spec 2026-10-04, section 11.1.)</description>
    <externalId>false</externalId>
    <inlineHelpText>Where this person agreed to calls from our AI assistant. Choose Rep when you tick AI Call Consent yourself.</inlineHelpText>
    <label>AI Call Consent Source</label>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value>
                <fullName>Text Reply</fullName>
                <default>false</default>
                <label>Text Reply</label>
            </value>
            <value>
                <fullName>Email Reply</fullName>
                <default>false</default>
                <label>Email Reply</label>
            </value>
            <value>
                <fullName>Web Form</fullName>
                <default>false</default>
                <label>Web Form</label>
            </value>
            <value>
                <fullName>Inbound Call</fullName>
                <default>false</default>
                <label>Inbound Call</label>
            </value>
            <value>
                <fullName>Rep</fullName>
                <default>false</default>
                <label>Rep</label>
            </value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

- [ ] **Step 5: Write the permission set**

`salesforce/force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  The AI Outreach integration user's permission set (outreach spec 2026-10-04,
  section 5). Assign it to the Salesforce Integration user that
  services/outreach-api connects as - never to reps.

  What it grants, and why each part is needed:
  - read + edit on the three AI Call Consent fields on Lead and Opportunity:
    the outbox (services/outreach-api/src/crm/outbox.ts) writes captured consent;
  - read + edit on DoNotCall / HasOptedOutOfEmail on Lead and Contact: a
    confirmed do-not-contact sets them (Opportunity has no such fields, so the
    primary contact role's Contact is updated instead);
  - read on the standard phone, email and description fields the campaign
    engine reads, and on Skip_on_Dialer__c;
  - read + edit + View All on Lead, Opportunity and Contact - no create, no
    delete, no Modify All: v1 never creates, converts or deletes records;
  - Edit Tasks, and edit on Activity.CTI_Origin__c, for the AI Outreach Task
    marker (phase 2 writes Tasks; phase 1 writes none).

  Tenant-specific custom fields (notes, extra phone fields, web form source,
  lead manager) are NOT here: they exist only in that tenant's org, and a
  reference to a missing field fails the whole deploy. The runbook
  (docs/runbooks/outreach-sf-campaigns.md, Salesforce setup) grants them
  in-org instead.

  The API name is load-bearing: the runbook and salesforce-metadata.test.ts
  refer to it by AI_Outreach.
-->
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>For the AI Outreach integration user only. Reads campaign records and writes AI-call consent and do-not-contact flags. Grants no create, delete or Modify All. See the comment in this file.</description>
    <fieldPermissions>
        <editable>true</editable>
        <field>Activity.CTI_Origin__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Contact.DoNotCall</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.Email</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Contact.HasOptedOutOfEmail</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.MobilePhone</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.Phone</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.AI_Call_Consent_Date__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.AI_Call_Consent_Source__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.AI_Call_Consent__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Description</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.DoNotCall</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Email</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.HasOptedOutOfEmail</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.MobilePhone</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Phone</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Skip_on_Dialer__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Opportunity.AI_Call_Consent_Date__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Opportunity.AI_Call_Consent_Source__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Opportunity.AI_Call_Consent__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Opportunity.Description</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Opportunity.Skip_on_Dialer__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <hasActivationRequired>false</hasActivationRequired>
    <label>AI Outreach</label>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Contact</object>
        <viewAllRecords>true</viewAllRecords>
    </objectPermissions>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Lead</object>
        <viewAllRecords>true</viewAllRecords>
    </objectPermissions>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Opportunity</object>
        <viewAllRecords>true</viewAllRecords>
    </objectPermissions>
    <userPermissions>
        <enabled>true</enabled>
        <name>EditTask</name>
    </userPermissions>
</PermissionSet>
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/salesforce-metadata.test.ts && npm -w services/outreach-api run typecheck
```

Expected: `✓ src/crm/salesforce-metadata.test.ts (14 tests)`, then `Tests  14 passed (14)`. The typecheck exits 0 with no output.

- [ ] **Step 7: Write the runbook's Salesforce setup section**

`docs/runbooks/outreach-sf-campaigns.md`:
````markdown
# Outreach Salesforce campaigns — operator runbook

Everything here is a human step. The code ships with plan 1B (`docs/superpowers/plans/2026-10-04-sf-campaigns-1b-live-calls.md`); the design is `docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md`.

The target org is alias `_t2` (`gghsd.my.salesforce.com`). **It is PRODUCTION.** Read `salesforce/README.md` first: never deploy with `-d force-app` or `-d force-app/main/default`, because that pushes the stale `layouts/` snapshots over the org's live layouts.

## 0. Salesforce setup (one time, ~30 minutes)

outreach-api connects to Salesforce as one company-wide **Integration user**, never as a rep. That user gets exactly the access in the `AI_Outreach` permission set, plus an in-org permission set for the tenant's own custom fields.

1. **Create the Integration user.** Setup → Users → New User:
   - **User License:** `Salesforce Integration`. **Profile:** `Minimum Access - API Only Integrations`.
   - Name it so it reads well on records it touches, for example `AI Outreach`. Use a real mailbox you control for the email.
   - Save, then on the user's page → **Permission Set License Assignments** → **Edit Assignments** → tick `Salesforce API Integration` → Save.

   > **Risk to check before step 5:** an API-only user cannot sign in to the Salesforce web UI, and the Connections page (§0.5) signs in through the browser (OAuth web-server flow with PKCE). If the browser sign-in is refused for this user, use a dedicated full-license user named `AI Outreach` with the same permission sets instead, and raise it with the outreach-api owners. A client-credentials connection for the Integration user is a planned follow-up, not built yet.

2. **Validate, then deploy the consent fields and the `AI_Outreach` permission set.** From the repo root on `main`, in `salesforce/`. Name the seven files explicitly:

   ```bash
   cd salesforce
   SRC=(
     force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml
     force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml
     force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml
     force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml
   )
   sf project deploy validate -o _t2 $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Expect `Status: Succeeded`. If it is refused:
   - `Field … is not permissionable` (or a similar FLS error) on a standard field: delete that one `<fieldPermissions>` block from `AI_Outreach.permissionset-meta.xml`, then run `npm -w services/outreach-api run test -- src/crm/salesforce-metadata.test.ts`. Update the test's expected list to match, commit both, and validate again.
   - Anything about `layouts`: you passed a directory. Pass only the seven files above.

   Then deploy the same seven files:

   ```bash
   sf project deploy start -o _t2 $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Expect `Status: Succeeded` and seven `Created` rows. Reruns show `Unchanged`.

3. **Assign `AI_Outreach` to the Integration user.**

   ```bash
   sf org assign permset -n AI_Outreach -o _t2 -b <integration username>
   ```

   If the assignment is refused because **Edit Tasks** is not allowed by the user's license, remove the `<userPermissions>` block (`EditTask`) and the `Activity.CTI_Origin__c` `<fieldPermissions>` block, and update the metadata test to match. Then redeploy (step 2) and retry the assignment. Phase 1 writes no Tasks; restore both blocks before phase 2 starts writing them.

4. **Grant the tenant's own fields in the org.** These fields exist only in this org, so they cannot live in the repo permission set: a reference to a missing field fails the whole deploy. Setup → Permission Sets → New: Label `AI Outreach Fields`, API name `AI_Outreach_Fields`, no license. Under **Object Settings**, grant **Read** on:
   - **Lead:** Address (State), `Notes__c`, `Agent_Notes__c`, `Motivation__c`, `SecondaryMotivation__c`, `Appointment_Notes__c`, `Analyst_Notes__c`, `Lead_Form_Source__c`, `LeadManager__c`.
   - **Opportunity:** `Mobile_Phone__c`, `Phone__c`, `Other_Phone__c`, `Lead_Form_Source__c`, `LeadManager__c`, and whichever notes fields the tenant's Opportunity field map reads.
   - **Task:** Description.

   Grant only the fields this tenant's field map uses (Settings → Connections → field map). Assign the set to the Integration user. Skip any field the org doesn't have.

5. **Connected app** (Setup → App Manager → New Connected App, or New External Client App):
   - Callback URL: `${API_PUBLIC_URL}/api/connections/salesforce/callback`, using outreach-api's public URL from `outreach-api-deploy.md` §2.
   - OAuth scopes: `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)`.
   - Require **PKCE**. Refresh token policy: **valid until revoked**. Under **Manage → Edit Policies**, set Permitted Users to "Admin approved users are pre-authorized" and add the `AI Outreach` permission set, so only the Integration user can use the app.
   - Set the outreach-api Railway variables `SALESFORCE_CLIENT_ID` (consumer key), `SALESFORCE_CLIENT_SECRET` (consumer secret; outreach-api sends it when it is set), and `SALESFORCE_REDIRECT_URI` (the callback URL above). Then redeploy outreach-api.
   - In outreach-web, open **Settings → Connections** as an admin, choose **Connect Salesforce**, and sign in **as the Integration user**. The page should show it as connected with the Integration user's username.

6. **Optional, in Setup only:** to let reps see the consent fields, add them to the Lead and Opportunity page layouts through the Setup UI. **Do not** deploy layouts from the repo (`salesforce/README.md`). If reps should record consent themselves (source `Rep`), give their profile or permission set **edit** on the three fields.

**Check:** on any Lead, Setup → Object Manager → Lead → Fields shows `AI Call Consent`, `AI Call Consent Date`, and `AI Call Consent Source` with five values in order: Text Reply, Email Reply, Web Form, Inbound Call, Rep.
````

- [ ] **Step 8: (Operator, optional now) Validate against the org**

This is a check-only deploy, so it changes nothing in the org. Run it only if alias `_t2` is already authenticated on this machine. Otherwise B8's go-live runs runbook §0 in full.

```bash
cd "$(git rev-parse --show-toplevel)/salesforce" && sf project deploy validate -o _t2 \
  --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml \
  --source-dir force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml
```

Expected: `Status: Succeeded`. If a `<fieldPermissions>` block is refused as not permissionable, follow runbook §0.2: remove the block, update the test's expected list, rerun Step 6, then validate again.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  salesforce/force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml \
  salesforce/force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml \
  services/outreach-api/src/crm/consent-fields.ts \
  services/outreach-api/src/crm/salesforce-metadata.test.ts \
  docs/runbooks/outreach-sf-campaigns.md
git commit -m "feat(salesforce): add AI call consent fields and the AI_Outreach permission set"
```

---

### Task B2: The Salesforce write outbox (`sf_writes`) and the `sf.write` tick

All Salesforce writes go through the `sf_writes` table (spec §12). A caller queues a row inside its own transaction. The `sf.write` tick runs every minute and drains due rows per tenant in sObject Collections batches of up to 200:
- `consent` → updates the three consent fields.
- `do_not_contact` → sets `DoNotCall` and `HasOptedOutOfEmail` on a Lead. For an Opportunity it sets them on the opportunity's primary contact role's Contact, looked up when the row drains.
- `task` → creates a Task with `CTI_Origin__c = 'AI Outreach'`. On `INVALID_FIELD` it retries once without the marker. Nothing in 1B queues `task` rows; phase 2 does.

How each failure is handled:
- **A transient failure** (5xx, `SalesforceApiError`, `RangeError`, an unknown per-record code): counts one attempt and waits 1, 5, 30, 120, then 360 minutes, and 360 from then on. The first such failure stamps `first_failed_at`.
- **A row failing for 24 hours:** alerts once (`alerted_at`).
- **A per-record error no retry can fix** (deleted or malformed id, converted Lead, no primary contact, bad payload): the row becomes terminal `failed` at once.
- **A broken connection** (`CrmNotConnectedError`, or a `SalesforceAuthError` from a failed token refresh): the tenant's rows stay `pending` with nothing counted. A8's refresh already pauses the tenant's running campaigns (`crm_broken`), and the rows drain in order on the first tick after an admin reconnects.

A11's confirm-do-not-contact hook queues the `do_not_contact` row in A11's own transaction. The review dialog then says so.

**Files:**
- Create: `services/outreach-api/src/crm/outbox-store.ts` (database side), `services/outreach-api/src/crm/outbox-writes.ts` (Salesforce side), `services/outreach-api/src/crm/outbox.ts` (policy: enqueue, backoff, drain, alert)
- Test: `services/outreach-api/src/crm/outbox.test.ts`, `services/outreach-api/src/crm/outbox.pg.test.ts`, `services/outreach-api/src/crm/outbox-wiring.test.ts`
- Modify: `services/outreach-api/src/alerts.ts`: the `kind` union (lines 15–18), plus a new export appended at the end
- Modify: `services/outreach-api/src/jobs/queues.ts` and `services/outreach-api/src/jobs/schedules.ts` (A8's files): the `QUEUES` and `SCHEDULES` arrays
- Modify: `services/outreach-api/src/jobs/schedules.test.ts` (A8's test): its two exact-list assertions
- Modify: `services/outreach-api/src/server.ts`: the import list, A8's `handlers` object (`grep -n "handlers" services/outreach-api/src/server.ts`), and A11's `registerReviewRoutes` entry in `apiRoutes` (`grep -n "registerReviewRoutes" services/outreach-api/src/server.ts`)
- Modify: `apps/outreach-web/src/components/review-page.tsx` (A13): the `description` of the confirm `ConfirmAction`. Find it with `grep -n "out of everything:" apps/outreach-web/src/components/review-page.tsx`.
- Modify: `apps/outreach-web/src/components/review-page.test.tsx` (A13): one assertion in `it('confirms do-not-contact only after a dialog that explains it opts the person out of everything'`

**Interfaces:**
- Consumes:
  - **A3:** `schema.sfWrites` and the `SfWriteRow` type from `@cti/db`. `createTestDb()` and `pgLane` from `src/test/pg.ts`, and `npm run test:pg`.
  - **A5:**
    - From `src/crm/client-factory.ts`: `CrmNotConnectedError`, and `type SalesforceClientFactory = (orgId: string) => Promise<SalesforceClient>`.
    - From `@cti/salesforce`: `SalesforceClient` (`query`, `createRecords`, `updateRecords`), `SalesforceAuthError`, `SalesforceApiError`, `type CompositeResult`, `soqlEscape`.
    - From `src/test/harness.ts`: `fakeDb` (`tables`, `selectResults`, `insertDefaults`, `captured`).
    - The server wiring `const clients = liveClientFactory(db, cfg);`.
  - **A8:**
    - From `src/jobs/boss.ts`: `type RunnerLogger`, `type JobHandler`, and `JobRunner`'s `handlers`/`schedules`.
    - `TICK_QUEUE_OPTIONS` and `QUEUES` from `src/jobs/queues.ts`, and `SCHEDULES` from `src/jobs/schedules.ts`.
  - **A11:** `ReviewRouteDeps.onConfirmed?: (args: ConfirmedDoNotContact, tx: Db) => Promise<void>`, called inside the confirm transaction.
  - **B1:** `CONSENT_FIELDS`, `CONSENT_SOURCES`, `CTI_ORIGIN_FIELD`, `CTI_ORIGIN_AI_OUTREACH`.
  - **Existing:** `dispatchAlert` and `type AlertLogger` in `src/alerts.ts`.
- Produces:
  ```ts
  // src/crm/outbox.ts
  export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];   // a Db or a transaction on it
  export const BACKOFF_MINUTES: readonly [1, 5, 30, 120, 360];
  export const ALERT_AFTER_MS: number;          // 24 h
  export const DEFAULT_DRAIN_BATCH = 200;
  export function nextDelayMinutes(attempts: number): number;   // attempts after this failure → minutes
  export interface SfWriteInput { orgId: string; kind: SfWriteKind; sfObject: string; sfRecordId: string; payload: Record<string, unknown> }
  export function enqueueSfWrite(db: DbExecutor, w: SfWriteInput): Promise<void>;
  export interface DrainDeps { db: Db; clients: SalesforceClientFactory; now: Date; log: RunnerLogger; alert: (orgId: string, text: string) => Promise<void>; batch?: number /* 200 */; store?: OutboxStore }
  export interface DrainResult { done: number; failed: number }
  export function drainOutbox(deps: DrainDeps): Promise<DrainResult>;
  export function outboxJob(deps: Omit<DrainDeps, 'now'>): () => Promise<void>;   // the sf.write JobHandler
  export function doNotContactEnqueuer(db: Db): (args: { orgId: string; sfObject: string; sfRecordId: string }, tx?: DbExecutor) => Promise<void>;   // A11's onConfirmed
  // src/crm/outbox-store.ts
  export type SfWriteKind = SfWriteRow['kind'];   // 'task' | 'consent' | 'do_not_contact'
  export interface OutboxRow { id; orgId; kind: SfWriteKind; sfObject; sfRecordId; payload: Record<string, unknown>; attempts: number; firstFailedAt: Date | null; alertedAt: Date | null }
  export interface RetryStamp { attempts: number; nextAttemptAt: Date; lastError: string; firstFailedAt: Date; now: Date }
  export interface OutboxStore { due(now, limit): Promise<OutboxRow[]>; markDone(id, now); markRetry(id, stamp: RetryStamp); markFailed(id, lastError, now); markAlerted(ids, now) }
  export function dbOutboxStore(db: Db): OutboxStore;
  // src/crm/outbox-writes.ts
  export type RowOutcome = { id: string; ok: true } | { id: string; ok: false; error: string; permanent: boolean };
  export const SF_BATCH = 200;
  export const DO_NOT_CONTACT_FIELDS: Readonly<Record<string, unknown>>;   // { DoNotCall: true, HasOptedOutOfEmail: true }
  export function errorText(err: unknown): string;
  export function primaryContacts(client: SalesforceClient, opportunityIds: readonly string[]): Promise<Map<string /* 15-char opp id */, string /* ContactId */>>;
  export function writeRows(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<{ outcomes: RowOutcome[]; authFailed: boolean }>;
  // src/alerts.ts
  // AlertEvent['kind'] gains 'sf_write_failing'
  export function sfWriteAlert(logger: AlertLogger): (orgId: string, message: string) => Promise<void>;
  ```
  Row payloads:
  - `consent`: `{ consent: true, source: ConsentSource, at: ISO string }`, zod-checked at drain.
  - `do_not_contact`: `{ reason: 'do_not_contact_confirmed' }`. The fields come from the kind.
  - `task`: the Task fields.

  Queue: `sf.write` (`TICK_QUEUE_OPTIONS`), scheduled `* * * * *`, with a worker only when `cfg.salesforceEnabled`.

#### Part 1: the outbox

- [ ] **Step 1: Write the failing test**

`services/outreach-api/src/crm/outbox.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { SalesforceApiError, SalesforceAuthError, type CompositeResult, type SalesforceClient } from '@cti/salesforce';
import { fakeDb } from '../test/harness.js';
import { CrmNotConnectedError } from './client-factory.js';
import {
  ALERT_AFTER_MS, BACKOFF_MINUTES, doNotContactEnqueuer, drainOutbox, enqueueSfWrite, nextDelayMinutes, type DrainDeps,
} from './outbox.js';
import type { OutboxRow, OutboxStore, RetryStamp } from './outbox-store.js';

const NOW = new Date('2026-10-05T15:00:00.000Z');
const MIN = 60_000;
const ok = (id = '001000000000001AAA'): CompositeResult => ({ id, success: true, errors: [] });
const err = (statusCode: string, message = statusCode): CompositeResult => ({ success: false, errors: [{ statusCode, message }] });

function row(over: Partial<OutboxRow> & Pick<OutboxRow, 'id'>): OutboxRow {
  return {
    orgId: 'O1', kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA',
    payload: { consent: true, source: 'Web Form', at: '2026-10-05T14:00:00.000Z' },
    attempts: 0, firstFailedAt: null, alertedAt: null, ...over,
  };
}

/** In-memory OutboxStore: `due` hands back the rows given; every stamp is recorded. */
function memoryStore(rows: OutboxRow[]) {
  const calls = {
    done: [] as string[],
    retry: [] as Array<{ id: string } & RetryStamp>,
    failed: [] as Array<{ id: string; error: string }>,
    alerted: [] as string[][],
  };
  const store: OutboxStore = {
    due: async () => rows,
    markDone: async (id) => { calls.done.push(id); },
    markRetry: async (id, s) => { calls.retry.push({ id, ...s }); },
    markFailed: async (id, error) => { calls.failed.push({ id, error }); },
    markAlerted: async (ids) => { calls.alerted.push([...ids]); },
  };
  return { store, calls };
}

type Fn = (...args: never[]) => Promise<unknown>;
function fakeClient(over: { createRecords?: Fn; updateRecords?: Fn; query?: Fn } = {}) {
  const c = {
    createRecords: vi.fn(over.createRecords ?? (async (recs: unknown[]) => recs.map(() => ok('00T000000000001AAA')))),
    updateRecords: vi.fn(over.updateRecords ?? (async (recs: unknown[]) => recs.map(() => ok()))),
    query: vi.fn(over.query ?? (async () => [])),
  };
  return c as typeof c & SalesforceClient;
}

function deps(store: OutboxStore, client: SalesforceClient | Error, over: Partial<DrainDeps> = {}) {
  const alert = vi.fn(async () => {});
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const d: DrainDeps = {
    db: fakeDb().db, now: NOW, log, alert, store,
    clients: async () => { if (client instanceof Error) throw client; return client; },
    ...over,
  };
  return { d, alert, log };
}

describe('nextDelayMinutes — the retry schedule', () => {
  it.each([[1, 1], [2, 5], [3, 30], [4, 120], [5, 360], [6, 360], [40, 360], [0, 1]])('after failure #%i wait %i minutes', (attempts, minutes) => {
    expect(nextDelayMinutes(attempts)).toBe(minutes);
  });
  it('is exactly [1, 5, 30, 120, 360] then 360', () => {
    expect(BACKOFF_MINUTES).toEqual([1, 5, 30, 120, 360]);
  });
});

describe('enqueueSfWrite', () => {
  it('inserts one pending row with the given kind, target and payload', async () => {
    const { db, writes } = fakeDb();
    await enqueueSfWrite(db, { orgId: 'O1', kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q1', payload: { consent: true } });
    expect(writes).toEqual([{ op: 'insert', table: schema.sfWrites, values: { orgId: 'O1', kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q1', payload: { consent: true } } }]);
  });
  it("doNotContactEnqueuer is A11's onConfirmed: it queues the do_not_contact write in the confirm's own transaction", async () => {
    const outer = fakeDb();
    const tx = fakeDb();
    await doNotContactEnqueuer(outer.db)({ orgId: 'O1', sfObject: 'Opportunity', sfRecordId: '006000000000001AAA' }, tx.db);
    expect(outer.writes).toEqual([]);
    expect(tx.writes).toEqual([{ op: 'insert', table: schema.sfWrites, values: {
      orgId: 'O1', kind: 'do_not_contact', sfObject: 'Opportunity', sfRecordId: '006000000000001AAA', payload: { reason: 'do_not_contact_confirmed' },
    } }]);
  });
});

describe('drainOutbox — what gets sent', () => {
  it('consent: updates the three consent fields on the record itself', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', sfObject: 'Opportunity', sfRecordId: '006000000000001AAA' })]);
    const client = fakeClient();
    const { d } = deps(store, client);
    expect(await drainOutbox(d)).toEqual({ done: 1, failed: 0 });
    expect(client.updateRecords).toHaveBeenCalledWith([{
      sobject: 'Opportunity', id: '006000000000001AAA',
      fields: { AI_Call_Consent__c: true, AI_Call_Consent_Date__c: '2026-10-05T14:00:00.000Z', AI_Call_Consent_Source__c: 'Web Form' },
    }]);
    expect(calls.done).toEqual(['w1']);
  });

  it('a malformed consent payload is a terminal failure, never sent', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', payload: { consent: true, source: 'Carrier Pigeon', at: 'x' } })]);
    const client = fakeClient();
    await drainOutbox(deps(store, client).d);
    expect(client.updateRecords).not.toHaveBeenCalled();
    expect(calls.failed).toEqual([{ id: 'w1', error: expect.stringMatching(/^BAD_PAYLOAD/) }]);
  });

  it('do_not_contact on a Lead: DoNotCall + HasOptedOutOfEmail on the Lead', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', kind: 'do_not_contact', payload: {} })]);
    const client = fakeClient();
    await drainOutbox(deps(store, client).d);
    expect(client.updateRecords).toHaveBeenCalledWith([{ sobject: 'Lead', id: '00Q000000000001AAA', fields: { DoNotCall: true, HasOptedOutOfEmail: true } }]);
    expect(client.query).not.toHaveBeenCalled();
    expect(calls.done).toEqual(['w1']);
  });

  it('do_not_contact on an Opportunity: resolves the PRIMARY contact role and flags that Contact', async () => {
    const { store, calls } = memoryStore([
      row({ id: 'w1', kind: 'do_not_contact', sfObject: 'Opportunity', sfRecordId: '006000000000001AAA', payload: {} }),
      row({ id: 'w2', kind: 'do_not_contact', sfObject: 'Opportunity', sfRecordId: '006000000000002AAA', payload: {} }),
    ]);
    const client = fakeClient({ query: async () => [{ OpportunityId: '006000000000001AAA', ContactId: '003000000000009AAA' }] });
    await drainOutbox(deps(store, client).d);
    expect(client.query).toHaveBeenCalledWith(
      "SELECT OpportunityId, ContactId FROM OpportunityContactRole WHERE IsPrimary = true AND OpportunityId IN ('006000000000001AAA', '006000000000002AAA')",
    );
    expect(client.updateRecords).toHaveBeenCalledWith([{ sobject: 'Contact', id: '003000000000009AAA', fields: { DoNotCall: true, HasOptedOutOfEmail: true } }]);
    expect(calls.done).toEqual(['w1']);
    // No primary contact: nothing in Salesforce can carry the flag — terminal, not retried forever.
    expect(calls.failed).toEqual([{ id: 'w2', error: expect.stringMatching(/^NO_PRIMARY_CONTACT/) }]);
  });

  it('task: stamps CTI_Origin__c = AI Outreach on the created Task', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', kind: 'task', payload: { Subject: 'AI text sent', WhoId: '00Q000000000001AAA', Status: 'Completed' } })]);
    const client = fakeClient();
    await drainOutbox(deps(store, client).d);
    expect(client.createRecords).toHaveBeenCalledWith([{ sobject: 'Task', fields: { Subject: 'AI text sent', WhoId: '00Q000000000001AAA', Status: 'Completed', CTI_Origin__c: 'AI Outreach' } }]);
    expect(calls.done).toEqual(['w1']);
  });

  it('task: a per-record INVALID_FIELD retries once WITHOUT CTI_Origin__c, and the Task is still created', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', kind: 'task', payload: { Subject: 'AI text sent' } })]);
    const client = fakeClient({
      createRecords: vi.fn()
        .mockResolvedValueOnce([err('INVALID_FIELD', "No such column 'CTI_Origin__c' on sobject of type Task")])
        .mockResolvedValueOnce([ok('00T000000000002AAA')]) as Fn,
    });
    await drainOutbox(deps(store, client).d);
    expect(client.createRecords).toHaveBeenCalledTimes(2);
    expect(client.createRecords.mock.calls[1]![0]).toEqual([{ sobject: 'Task', fields: { Subject: 'AI text sent' } }]);
    expect(calls.done).toEqual(['w1']);
  });

  it('task: a whole-request 400 INVALID_FIELD retries once without CTI_Origin__c too', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', kind: 'task', payload: { Subject: 'AI text sent' } })]);
    const client = fakeClient({
      createRecords: vi.fn()
        .mockRejectedValueOnce(new SalesforceApiError('bad field', 400, [{ errorCode: 'INVALID_FIELD', message: "No such column 'CTI_Origin__c'" }]))
        .mockResolvedValueOnce([ok('00T000000000002AAA')]) as Fn,
    });
    await drainOutbox(deps(store, client).d);
    expect(client.createRecords.mock.calls[1]![0]).toEqual([{ sobject: 'Task', fields: { Subject: 'AI text sent' } }]);
    expect(calls.done).toEqual(['w1']);
  });
});

describe('drainOutbox — failures', () => {
  it.each([0, 1, 2, 3, 4, 5, 9])('a transient failure after %i earlier attempts retries on the exact schedule', async (attempts) => {
    const { store, calls } = memoryStore([row({ id: 'w1', attempts, firstFailedAt: attempts ? new Date(NOW.getTime() - MIN) : null })]);
    const client = fakeClient({ updateRecords: async () => { throw new SalesforceApiError('Service Unavailable', 503, null); } });
    expect(await drainOutbox(deps(store, client).d)).toEqual({ done: 0, failed: 1 });
    const expectedMinutes = [1, 5, 30, 120, 360, 360, 360][Math.min(attempts, 6)]!;
    expect(calls.retry).toEqual([{
      id: 'w1', attempts: attempts + 1, nextAttemptAt: new Date(NOW.getTime() + expectedMinutes * MIN),
      lastError: '503: Service Unavailable', firstFailedAt: attempts ? new Date(NOW.getTime() - MIN) : NOW, now: NOW,
    }]);
  });

  it('a per-record ENTITY_IS_DELETED is terminal (failed), not retried', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1' })]);
    const client = fakeClient({ updateRecords: async () => [err('ENTITY_IS_DELETED', 'entity is deleted')] });
    await drainOutbox(deps(store, client).d);
    expect(calls.failed).toEqual([{ id: 'w1', error: 'ENTITY_IS_DELETED: entity is deleted' }]);
    expect(calls.retry).toEqual([]);
  });

  it('alerts ONCE when a row has been failing for 24 hours, and stamps it so the next tick does not re-alert', async () => {
    const stale = row({ id: 'w1', attempts: 9, firstFailedAt: new Date(NOW.getTime() - ALERT_AFTER_MS - MIN) });
    const young = row({ id: 'w2', sfRecordId: '00Q000000000002AAA', attempts: 3, firstFailedAt: new Date(NOW.getTime() - ALERT_AFTER_MS + 60 * MIN) });
    const failing = { updateRecords: async (recs: unknown[]) => recs.map(() => err('UNABLE_TO_LOCK_ROW', 'locked')) };
    const first = memoryStore([stale, young]);
    const run1 = deps(first.store, fakeClient(failing));
    await drainOutbox(run1.d);
    expect(run1.alert).toHaveBeenCalledTimes(1);
    expect(run1.alert).toHaveBeenCalledWith('O1', expect.stringContaining('failing for over 24 hours'));
    expect(first.calls.alerted).toEqual([['w1']]);

    // Next tick: the stale row now carries alerted_at — no second alert.
    const second = memoryStore([{ ...stale, alertedAt: NOW }, young]);
    const run2 = deps(second.store, fakeClient(failing));
    await drainOutbox(run2.d);
    expect(run2.alert).not.toHaveBeenCalled();
    expect(second.calls.alerted).toEqual([]);
  });

  it('CrmNotConnectedError leaves that tenant\'s rows pending (no attempt spent) and still drains other tenants', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', orgId: 'O-BROKEN' }), row({ id: 'w2', orgId: 'O2' })]);
    const client = fakeClient();
    const { d } = deps(store, client, {
      clients: async (orgId) => { if (orgId === 'O-BROKEN') throw new CrmNotConnectedError('not connected'); return client; },
    });
    expect(await drainOutbox(d)).toEqual({ done: 1, failed: 0 });
    expect(calls.done).toEqual(['w2']);
    expect(calls.retry).toEqual([]);
    expect(calls.failed).toEqual([]);
  });

  it('a SalesforceAuthError mid-drain leaves the unattempted rows pending', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1' }), row({ id: 'w2', kind: 'do_not_contact', payload: {} })]);
    const client = fakeClient({ updateRecords: async () => { throw new SalesforceAuthError('refresh failed'); } });
    const { d, log } = deps(store, client);
    expect(await drainOutbox(d)).toEqual({ done: 0, failed: 0 });
    expect(calls.retry).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/outbox.test.ts
```

Expected: `FAIL src/crm/outbox.test.ts`, with `Error: Failed to load url ./outbox.js (resolved id: ./outbox.js) in …/outbox.test.ts. Does the file exist?`.

- [ ] **Step 3: Write the database side**

`services/outreach-api/src/crm/outbox-store.ts`:
```ts
/**
 * Where the Salesforce write outbox (`sf_writes`) is read and stamped. Behind an
 * interface so `drainOutbox`'s retry/alert rules are unit tested against an
 * in-memory store; `dbOutboxStore` is the production one, exercised against
 * real Postgres in outbox.pg.test.ts.
 */
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { schema, type Db, type SfWriteRow } from '@cti/db';

export type SfWriteKind = SfWriteRow['kind'];

/** The columns a drain needs (a projection of @cti/db's `SfWriteRow`). */
export interface OutboxRow {
  id: string;
  orgId: string;
  kind: SfWriteKind;
  sfObject: string;
  sfRecordId: string;
  payload: Record<string, unknown>;
  attempts: number;
  firstFailedAt: Date | null;
  alertedAt: Date | null;
}

export interface RetryStamp {
  attempts: number;
  nextAttemptAt: Date;
  lastError: string;
  firstFailedAt: Date;
  now: Date;
}

export interface OutboxStore {
  /** Pending rows whose `next_attempt_at` has come, oldest first. */
  due(now: Date, limit: number): Promise<OutboxRow[]>;
  markDone(id: string, now: Date): Promise<void>;
  markRetry(id: string, stamp: RetryStamp): Promise<void>;
  /** Terminal: Salesforce rejected the write for a reason a retry cannot fix. */
  markFailed(id: string, lastError: string, now: Date): Promise<void>;
  markAlerted(ids: readonly string[], now: Date): Promise<void>;
}

export function dbOutboxStore(db: Db): OutboxStore {
  const t = schema.sfWrites;
  return {
    async due(now, limit) {
      const rows = await db
        .select({
          id: t.id, orgId: t.orgId, kind: t.kind, sfObject: t.sfObject, sfRecordId: t.sfRecordId,
          payload: t.payload, attempts: t.attempts, firstFailedAt: t.firstFailedAt, alertedAt: t.alertedAt,
        })
        .from(t)
        .where(and(eq(t.status, 'pending'), lte(t.nextAttemptAt, now)))
        .orderBy(asc(t.nextAttemptAt), asc(t.createdAt))
        .limit(limit);
      return rows;
    },
    async markDone(id, now) {
      await db.update(t).set({ status: 'done', doneAt: now, lastError: null, updatedAt: now }).where(eq(t.id, id));
    },
    async markRetry(id, s) {
      await db
        .update(t)
        .set({ attempts: s.attempts, nextAttemptAt: s.nextAttemptAt, lastError: s.lastError, firstFailedAt: s.firstFailedAt, updatedAt: s.now })
        .where(eq(t.id, id));
    },
    async markFailed(id, lastError, now) {
      await db.update(t).set({ status: 'failed', lastError, updatedAt: now }).where(eq(t.id, id));
    },
    async markAlerted(ids, now) {
      if (ids.length === 0) return;
      await db.update(t).set({ alertedAt: now, updatedAt: now }).where(inArray(t.id, [...ids]));
    },
  };
}
```

- [ ] **Step 4: Write the Salesforce side**

`services/outreach-api/src/crm/outbox-writes.ts`:
```ts
/**
 * The Salesforce half of the outbox: turns due `sf_writes` rows into composite
 * create/update calls and reports one outcome per row. Pure of the database —
 * `drainOutbox` (outbox.ts) decides what each outcome does to the row.
 */
import { z } from 'zod';
import {
  SalesforceApiError,
  SalesforceAuthError,
  soqlEscape,
  type CompositeResult,
  type SalesforceClient,
} from '@cti/salesforce';
import { CONSENT_FIELDS, CONSENT_SOURCES, CTI_ORIGIN_AI_OUTREACH, CTI_ORIGIN_FIELD } from './consent-fields.js';
import type { OutboxRow } from './outbox-store.js';

export type RowOutcome =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string; permanent: boolean };

/** Salesforce's sObject Collections limit per request. */
export const SF_BATCH = 200;

/** Per-record status codes no retry can fix: the record is gone or the id is bad. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'ENTITY_IS_DELETED',
  'INVALID_CROSS_REFERENCE_KEY',
  'MALFORMED_ID',
  'INVALID_ID_FIELD',
  'NOT_FOUND',
  'CANNOT_UPDATE_CONVERTED_LEAD',
]);

export const DO_NOT_CONTACT_FIELDS: Readonly<Record<string, unknown>> = { DoNotCall: true, HasOptedOutOfEmail: true };

const ConsentPayload = z.object({ consent: z.literal(true), source: z.enum(CONSENT_SOURCES), at: z.string().datetime() });
const TaskPayload = z.record(z.unknown());

interface UpdateItem { rowId: string; sobject: string; id: string; fields: Record<string, unknown> }
interface UpdateTarget { sobject: string; id: string; fields: Record<string, unknown>; rowIds: string[] }

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function errorText(err: unknown): string {
  const text = err instanceof SalesforceApiError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return text.slice(0, 1000);
}

const fail = (id: string, error: string, permanent: boolean): RowOutcome => ({ id, ok: false, error, permanent });

function outcomeFor(id: string, r: CompositeResult | undefined): RowOutcome {
  if (!r) return fail(id, 'NO_RESULT: Salesforce returned fewer results than records sent', false);
  if (r.success) return { id, ok: true };
  const code = r.errors[0]?.statusCode ?? 'UNKNOWN';
  return fail(id, `${code}: ${r.errors[0]?.message ?? 'no message'}`, PERMANENT_CODES.has(code));
}

/** A whole-request 400 whose body names an unknown/invisible field (same test as cti-api's isInvalidFieldError). */
function isInvalidFieldBody(body: unknown): boolean {
  return (Array.isArray(body) ? body : [body]).some((e) => {
    const code = (e as { errorCode?: unknown } | null)?.errorCode;
    return typeof code === 'string' && code.startsWith('INVALID_FIELD');
  });
}
const isInvalidFieldResult = (r: CompositeResult | undefined): boolean =>
  !!r && !r.success && r.errors.some((e) => e.statusCode.startsWith('INVALID_FIELD'));

function withoutOrigin(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([k]) => k !== CTI_ORIGIN_FIELD));
}

/** Runs `fn`; any failure other than an auth failure becomes a retryable outcome for every row in the chunk. */
async function guarded(rowIds: readonly string[], fn: () => Promise<RowOutcome[]>): Promise<RowOutcome[]> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SalesforceAuthError) throw err;
    const message = errorText(err);
    return rowIds.map((id) => fail(id, message, false));
  }
}

async function createTaskChunk(client: SalesforceClient, chunk: Array<{ id: string; fields: Record<string, unknown> }>): Promise<RowOutcome[]> {
  const plain = () => client.createRecords(chunk.map((t) => ({ sobject: 'Task', fields: withoutOrigin(t.fields) })));
  let results: CompositeResult[];
  try {
    results = await client.createRecords(chunk.map((t) => ({ sobject: 'Task', fields: { ...t.fields, [CTI_ORIGIN_FIELD]: CTI_ORIGIN_AI_OUTREACH } })));
  } catch (err) {
    // The org (or the integration user's field access) has no CTI_Origin__c:
    // retry once without the marker rather than lose the Task.
    if (err instanceof SalesforceApiError && err.status === 400 && isInvalidFieldBody(err.body)) {
      const retried = await plain();
      return chunk.map((t, i) => outcomeFor(t.id, retried[i]));
    }
    throw err;
  }
  const retry = chunk.filter((_, i) => isInvalidFieldResult(results[i]));
  if (retry.length === 0) return chunk.map((t, i) => outcomeFor(t.id, results[i]));
  const retried = await client.createRecords(retry.map((t) => ({ sobject: 'Task', fields: withoutOrigin(t.fields) })));
  const second = new Map(retry.map((t, i) => [t.id, retried[i]]));
  return chunk.map((t, i) => outcomeFor(t.id, second.has(t.id) ? second.get(t.id) : results[i]));
}

async function writeTasks(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<RowOutcome[]> {
  const out: RowOutcome[] = [];
  const valid: Array<{ id: string; fields: Record<string, unknown> }> = [];
  for (const r of rows) {
    const p = TaskPayload.safeParse(r.payload);
    if (p.success) valid.push({ id: r.id, fields: p.data });
    else out.push(fail(r.id, 'BAD_PAYLOAD: task payload is not an object', true));
  }
  for (const chunk of chunks(valid, SF_BATCH)) {
    out.push(...(await guarded(chunk.map((c) => c.id), () => createTaskChunk(client, chunk))));
  }
  return out;
}

/** One update per Salesforce record, even when several rows target it; the latest row's fields win. */
function mergeTargets(items: readonly UpdateItem[]): UpdateTarget[] {
  const byKey = new Map<string, UpdateTarget>();
  for (const it of items) {
    const key = `${it.sobject}:${it.id}`;
    const prev = byKey.get(key);
    byKey.set(key, prev
      ? { ...prev, fields: { ...prev.fields, ...it.fields }, rowIds: [...prev.rowIds, it.rowId] }
      : { sobject: it.sobject, id: it.id, fields: it.fields, rowIds: [it.rowId] });
  }
  return [...byKey.values()];
}

async function writeUpdates(client: SalesforceClient, targets: readonly UpdateTarget[]): Promise<RowOutcome[]> {
  const out: RowOutcome[] = [];
  for (const chunk of chunks(targets, SF_BATCH)) {
    out.push(...(await guarded(chunk.flatMap((t) => t.rowIds), async () => {
      const results = await client.updateRecords(chunk.map(({ sobject, id, fields }) => ({ sobject, id, fields })));
      return chunk.flatMap((t, i) => t.rowIds.map((rowId) => outcomeFor(rowId, results[i])));
    })));
  }
  return out;
}

async function writeConsent(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<RowOutcome[]> {
  const out: RowOutcome[] = [];
  const items: UpdateItem[] = [];
  for (const r of rows) {
    const p = ConsentPayload.safeParse(r.payload);
    if (!p.success) {
      out.push(fail(r.id, 'BAD_PAYLOAD: consent payload must be { consent: true, source, at }', true));
      continue;
    }
    items.push({
      rowId: r.id, sobject: r.sfObject, id: r.sfRecordId,
      fields: { [CONSENT_FIELDS.checkbox]: true, [CONSENT_FIELDS.date]: p.data.at, [CONSENT_FIELDS.source]: p.data.source },
    });
  }
  return [...out, ...(await writeUpdates(client, mergeTargets(items)))];
}

/** 15-character form of a Salesforce id, so 15- and 18-character ids compare equal. */
const id15 = (id: string): string => id.slice(0, 15);

/** Opportunity id (15-char) → its primary contact role's ContactId. */
export async function primaryContacts(client: SalesforceClient, opportunityIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const chunk of chunks([...new Set(opportunityIds)], SF_BATCH)) {
    const ids = chunk.map((id) => `'${soqlEscape(id)}'`).join(', ');
    const rows = await client.query<{ OpportunityId?: string; ContactId?: string }>(
      `SELECT OpportunityId, ContactId FROM OpportunityContactRole WHERE IsPrimary = true AND OpportunityId IN (${ids})`,
    );
    for (const r of rows) if (r.OpportunityId && r.ContactId) out.set(id15(r.OpportunityId), r.ContactId);
  }
  return out;
}

/** Opportunity rows → update items on their primary contact role's Contact (looked up now: it may have changed since the row was queued). */
async function contactTargets(client: SalesforceClient, opps: readonly OutboxRow[]): Promise<{ items: UpdateItem[]; failures: RowOutcome[] }> {
  let contacts: Map<string, string>;
  try {
    contacts = await primaryContacts(client, opps.map((r) => r.sfRecordId));
  } catch (err) {
    if (err instanceof SalesforceAuthError) throw err;
    const message = errorText(err);
    return { items: [], failures: opps.map((r) => fail(r.id, message, false)) };
  }
  const items: UpdateItem[] = [];
  const failures: RowOutcome[] = [];
  for (const r of opps) {
    const contactId = contacts.get(id15(r.sfRecordId));
    if (contactId) items.push({ rowId: r.id, sobject: 'Contact', id: contactId, fields: { ...DO_NOT_CONTACT_FIELDS } });
    else failures.push(fail(r.id, 'NO_PRIMARY_CONTACT: the Opportunity has no primary contact role to flag', true));
  }
  return { items, failures };
}

/** Lead → DoNotCall + HasOptedOutOfEmail on the Lead; Opportunity (which has neither field) → on its primary contact role's Contact. */
async function writeDoNotContact(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<RowOutcome[]> {
  const leads: UpdateItem[] = [];
  const opps: OutboxRow[] = [];
  const unsupported: RowOutcome[] = [];
  for (const r of rows) {
    if (r.sfObject === 'Lead') leads.push({ rowId: r.id, sobject: 'Lead', id: r.sfRecordId, fields: { ...DO_NOT_CONTACT_FIELDS } });
    else if (r.sfObject === 'Opportunity') opps.push(r);
    else unsupported.push(fail(r.id, `UNSUPPORTED_OBJECT: ${r.sfObject}`, true));
  }
  const viaContacts = opps.length > 0 ? await contactTargets(client, opps) : { items: [], failures: [] };
  const written = await writeUpdates(client, mergeTargets([...leads, ...viaContacts.items]));
  return [...unsupported, ...viaContacts.failures, ...written];
}

/**
 * Write every row, kind by kind. A `SalesforceAuthError` stops the tenant:
 * rows not yet attempted get no outcome (they stay pending, no attempt spent)
 * and `authFailed` is true. Any other Salesforce failure is an outcome.
 */
export async function writeRows(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<{ outcomes: RowOutcome[]; authFailed: boolean }> {
  const steps: Array<() => Promise<RowOutcome[]>> = [
    () => writeTasks(client, rows.filter((r) => r.kind === 'task')),
    () => writeConsent(client, rows.filter((r) => r.kind === 'consent')),
    () => writeDoNotContact(client, rows.filter((r) => r.kind === 'do_not_contact')),
  ];
  const outcomes: RowOutcome[] = [];
  for (const step of steps) {
    try {
      outcomes.push(...(await step()));
    } catch (err) {
      if (err instanceof SalesforceAuthError) return { outcomes, authFailed: true };
      throw err;
    }
  }
  return { outcomes, authFailed: false };
}
```

- [ ] **Step 5: Write the policy**

`services/outreach-api/src/crm/outbox.ts`:
```ts
/**
 * The Salesforce write outbox (spec §11, §12). Everything this system writes to
 * Salesforce goes through `sf_writes`: a caller enqueues inside its own
 * transaction, and the `sf.write` job drains it every minute through the
 * tenant's integration-user connection. A Salesforce outage only delays writes:
 * a failed row retries on BACKOFF_MINUTES and alerts once after 24 hours.
 *
 * What counts as a failed attempt:
 * - A `SalesforceApiError` (or any other error from the request, or a per-record
 *   error) on a row → one attempt, backoff, `first_failed_at` on the first one.
 * - Per-record codes no retry can fix (deleted record, bad id, converted Lead,
 *   no primary contact role, a malformed payload) → `failed`, terminal.
 * - `CrmNotConnectedError` (no connection, or it is marked broken) and
 *   `SalesforceAuthError` (the token refresh failed) are the CONNECTION's
 *   failure, not the row's: the tenant's rows stay pending untouched — no
 *   attempt counted, no backoff, no 24-hour clock started. A broken connection
 *   already pauses the tenant's campaigns and alerts (A8/B7), and the rows go out
 *   in order on the first tick after an admin reconnects.
 */
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import type { RunnerLogger } from '../jobs/boss.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from './client-factory.js';
import { dbOutboxStore, type OutboxRow, type OutboxStore, type SfWriteKind } from './outbox-store.js';
import { errorText, writeRows, type RowOutcome } from './outbox-writes.js';

/** A Drizzle handle or a transaction on it — enqueue joins the caller's transaction. */
export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Minutes to wait after the Nth consecutive failure (N = 1..5), then 360 forever. */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 360] as const;
export const ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DRAIN_BATCH = 200;

export function nextDelayMinutes(attempts: number): number {
  const n = Math.min(Math.max(Math.trunc(attempts), 1), BACKOFF_MINUTES.length);
  return BACKOFF_MINUTES[n - 1]!;
}

export interface SfWriteInput {
  orgId: string;
  kind: SfWriteKind;
  sfObject: string;
  sfRecordId: string;
  payload: Record<string, unknown>;
}

export async function enqueueSfWrite(db: DbExecutor, w: SfWriteInput): Promise<void> {
  await db.insert(schema.sfWrites).values({
    orgId: w.orgId, kind: w.kind, sfObject: w.sfObject, sfRecordId: w.sfRecordId, payload: w.payload,
  });
}

export interface DrainDeps {
  db: Db;
  clients: SalesforceClientFactory;
  now: Date;
  log: RunnerLogger;
  /** Fires at most once per row, when the row has been failing for 24 hours. Must not throw. */
  alert: (orgId: string, text: string) => Promise<void>;
  batch?: number;
  /** Test seam; production uses `dbOutboxStore(db)`. */
  store?: OutboxStore;
}

export interface DrainResult { done: number; failed: number }
const NONE: DrainResult = { done: 0, failed: 0 };

function byOrg(rows: readonly OutboxRow[]): Map<string, OutboxRow[]> {
  const out = new Map<string, OutboxRow[]>();
  for (const r of rows) out.set(r.orgId, [...(out.get(r.orgId) ?? []), r]);
  return out;
}

async function applyOutcomes(store: OutboxStore, now: Date, rows: readonly OutboxRow[], outcomes: readonly RowOutcome[]): Promise<DrainResult> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let done = 0;
  let failed = 0;
  for (const o of outcomes) {
    const row = byId.get(o.id);
    if (!row) continue;
    if (o.ok) {
      await store.markDone(o.id, now);
      done += 1;
      continue;
    }
    failed += 1;
    if (o.permanent) {
      await store.markFailed(o.id, o.error, now);
      continue;
    }
    const attempts = row.attempts + 1;
    await store.markRetry(o.id, {
      attempts,
      nextAttemptAt: new Date(now.getTime() + nextDelayMinutes(attempts) * 60_000),
      lastError: o.error,
      firstFailedAt: row.firstFailedAt ?? now,
      now,
    });
  }
  return { done, failed };
}

/** One alert per tenant per tick, covering every retrying row that crossed 24 h and was never alerted on. */
async function alertIfStale(deps: DrainDeps, store: OutboxStore, orgId: string, rows: readonly OutboxRow[], outcomes: readonly RowOutcome[]): Promise<void> {
  const cutoff = deps.now.getTime() - ALERT_AFTER_MS;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const stale = outcomes
    .filter((o): o is Extract<RowOutcome, { ok: false }> => !o.ok && !o.permanent)
    .map((o) => ({ row: byId.get(o.id), error: o.error }))
    .filter((x): x is { row: OutboxRow; error: string } => !!x.row && !x.row.alertedAt && !!x.row.firstFailedAt && x.row.firstFailedAt.getTime() <= cutoff);
  if (stale.length === 0) return;
  const text = `Salesforce write-back has been failing for over 24 hours for tenant ${orgId}: ${stale.length} write(s) still retrying. Last error: ${stale[0]!.error}`;
  try {
    await deps.alert(orgId, text);
  } catch (err) {
    deps.log.error({ orgId, err: errorText(err) }, 'sf.write: alert failed; will retry next tick');
    return;
  }
  await store.markAlerted(stale.map((s) => s.row.id), deps.now);
}

async function drainTenant(deps: DrainDeps, store: OutboxStore, orgId: string, rows: OutboxRow[]): Promise<DrainResult> {
  let client: SalesforceClient;
  try {
    client = await deps.clients(orgId);
  } catch (err) {
    if (err instanceof CrmNotConnectedError) {
      deps.log.info({ orgId, pending: rows.length }, 'sf.write: Salesforce not connected; writes stay pending');
    } else {
      deps.log.error({ orgId, err: errorText(err) }, 'sf.write: could not build the Salesforce client; writes stay pending');
    }
    return NONE;
  }
  let written: Awaited<ReturnType<typeof writeRows>>;
  try {
    written = await writeRows(client, rows);
  } catch (err) {
    deps.log.error({ orgId, err: errorText(err) }, 'sf.write: unexpected failure; writes stay pending');
    return NONE;
  }
  if (written.authFailed) {
    deps.log.warn({ orgId }, 'sf.write: Salesforce auth failed mid-drain; unattempted writes stay pending');
  }
  const result = await applyOutcomes(store, deps.now, rows, written.outcomes);
  await alertIfStale(deps, store, orgId, rows, written.outcomes);
  return result;
}

export async function drainOutbox(deps: DrainDeps): Promise<DrainResult> {
  const store = deps.store ?? dbOutboxStore(deps.db);
  const rows = await store.due(deps.now, deps.batch ?? DEFAULT_DRAIN_BATCH);
  let done = 0;
  let failed = 0;
  for (const [orgId, orgRows] of byOrg(rows)) {
    const r = await drainTenant(deps, store, orgId, orgRows);
    done += r.done;
    failed += r.failed;
  }
  return { done, failed };
}

/** The `sf.write` job handler: one drain per tick, stamped with the tick's time. */
export function outboxJob(deps: Omit<DrainDeps, 'now'>): () => Promise<void> {
  return async () => {
    const r = await drainOutbox({ ...deps, now: new Date() });
    if (r.done > 0 || r.failed > 0) deps.log.info(r, 'sf.write drained');
  };
}

/**
 * A11's `onConfirmed` hook: a confirmed do-not-contact sets DoNotCall and
 * HasOptedOutOfEmail in Salesforce through the outbox. A11 passes its
 * transaction as `tx`, so the write commits or rolls back with the confirm.
 */
export function doNotContactEnqueuer(db: Db): (args: { orgId: string; sfObject: string; sfRecordId: string }, tx?: DbExecutor) => Promise<void> {
  return (args, tx) => enqueueSfWrite(tx ?? db, {
    orgId: args.orgId, kind: 'do_not_contact', sfObject: args.sfObject, sfRecordId: args.sfRecordId,
    payload: { reason: 'do_not_contact_confirmed' },
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/outbox.test.ts && npm -w services/outreach-api run typecheck
```

Expected: `✓ src/crm/outbox.test.ts (29 tests)`, then `Tests  29 passed (29)`. The typecheck exits 0.

- [ ] **Step 7: Add the real-Postgres test, then run it**

`services/outreach-api/src/crm/outbox.pg.test.ts`:
```ts
/** Real-Postgres lane (A3): the production OutboxStore against the real `sf_writes` table. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { createTestDb, pgLane } from '../test/pg.js';
import { drainOutbox, enqueueSfWrite } from './outbox.js';

describe.skipIf(!pgLane)('outbox against real Postgres', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let orgId: string;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [org] = await db.insert(schema.organizations).values({ name: 'Outbox Co', slug: `outbox-${Date.now()}` }).returning();
    orgId = org!.id;
  });
  afterAll(async () => { await t?.drop(); });

  it('a successful drain marks the row done; a failing one backs off 1 minute and records first_failed_at', async () => {
    const now = new Date('2026-10-05T15:00:00.000Z');
    await enqueueSfWrite(db, { orgId, kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', payload: { consent: true, source: 'Rep', at: now.toISOString() } });
    // Enqueued with next_attempt_at = now() (wall clock), so drain "later" than that.
    const later = new Date(Date.now() + 1000);
    const okClient = { updateRecords: async (r: unknown[]) => r.map(() => ({ id: 'x', success: true, errors: [] })) } as unknown as SalesforceClient;
    expect(await drainOutbox({ db, clients: async () => okClient, now: later, log, alert: async () => {} })).toEqual({ done: 1, failed: 0 });
    const [done] = await db.select().from(schema.sfWrites).where(eq(schema.sfWrites.orgId, orgId));
    expect(done).toMatchObject({ status: 'done', attempts: 0, lastError: null });
    expect(done!.doneAt).toEqual(later);

    await enqueueSfWrite(db, { orgId, kind: 'do_not_contact', sfObject: 'Lead', sfRecordId: '00Q000000000002AAA', payload: {} });
    const later2 = new Date(Date.now() + 1000);
    const downClient = { updateRecords: async () => { throw new Error('socket hang up'); } } as unknown as SalesforceClient;
    expect(await drainOutbox({ db, clients: async () => downClient, now: later2, log, alert: async () => {} })).toEqual({ done: 0, failed: 1 });
    const [retrying] = await db.select().from(schema.sfWrites).where(eq(schema.sfWrites.sfRecordId, '00Q000000000002AAA'));
    expect(retrying).toMatchObject({ status: 'pending', attempts: 1, lastError: 'socket hang up' });
    expect(retrying!.firstFailedAt).toEqual(later2);
    expect(retrying!.nextAttemptAt).toEqual(new Date(later2.getTime() + 60_000));
    // Not due yet: a drain one second later picks nothing up.
    expect(await drainOutbox({ db, clients: async () => downClient, now: new Date(later2.getTime() + 1000), log, alert: async () => {} })).toEqual({ done: 0, failed: 0 });
  });
});
```

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/outbox.pg.test.ts && npm run test:pg 2>&1 | tail -4; docker rm -f outreach-test-pg >/dev/null 2>&1; true
```

Expected:
- The plain run shows `↓ src/crm/outbox.pg.test.ts (1 test | 1 skipped)`.
- `npm run test:pg` passes, with `✓ src/crm/outbox.pg.test.ts (1 test)` among the files. This proves the Drizzle store's real SQL: the row goes `done`, a failing row goes `pending` with `attempts = 1` and `next_attempt_at = now + 1 min`.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  services/outreach-api/src/crm/outbox-store.ts \
  services/outreach-api/src/crm/outbox-writes.ts \
  services/outreach-api/src/crm/outbox.ts \
  services/outreach-api/src/crm/outbox.test.ts \
  services/outreach-api/src/crm/outbox.pg.test.ts
git commit -m "feat(outreach-api): add the Salesforce write outbox with backoff, terminal failures and a 24-hour alert"
```

#### Part 2: wire the `sf.write` tick and A11's hook

- [ ] **Step 9: Write the failing wiring test**

`services/outreach-api/src/crm/outbox-wiring.test.ts`:
```ts
/**
 * The outbox is only real if something runs it. server.ts calls main() on
 * import, so its text is the only thing that can pin the wiring (the same
 * approach as cti-api's no-answer-chatter-worker.test.ts).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { sfWriteAlert } from '../alerts.js';
import { QUEUES, TICK_QUEUE_OPTIONS } from '../jobs/queues.js';
import { SCHEDULES } from '../jobs/schedules.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(resolve(here, '../server.ts'), 'utf8');

describe('sf.write wiring', () => {
  it("reuses A8's stately tick options (one queued + one active drain, never a backlog) and runs every minute", () => {
    expect(QUEUES.find((q) => q.name === 'sf.write')?.options).toBe(TICK_QUEUE_OPTIONS);
    expect(TICK_QUEUE_OPTIONS.policy).toBe('stately');
    expect(SCHEDULES).toContainEqual({ queue: 'sf.write', cron: '* * * * *' });
  });

  it('server.ts registers the drain as the sf.write handler, alerting through sfWriteAlert', () => {
    expect(server).toContain("import { doNotContactEnqueuer, outboxJob } from './crm/outbox.js';");
    expect(server).toContain("'sf.write': outboxJob({ db, clients");
    expect(server).toContain('alert: sfWriteAlert(console)');
  });

  it("server.ts wires A11's onConfirmed hook to queue the do_not_contact write", () => {
    expect(server).toContain('onConfirmed: doNotContactEnqueuer(db)');
  });

  it('sfWriteAlert logs a sf_write_failing warning for the tenant', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await sfWriteAlert(logger)('O1', 'failing for over 24 hours');
    expect(logger.warn).toHaveBeenCalledWith({ alert: 'sf_write_failing', orgId: 'O1' }, 'alert: failing for over 24 hours');
  });
});
```

Then extend A8's exact-list assertions in `services/outreach-api/src/jobs/schedules.test.ts`. In the first `it`, rename it and add `'sf.write'` to the loop:

```ts
  it('declares the tick queues as stately, never retried, 15-minute expiry', () => {
    const byName = new Map(QUEUES.map((q) => [q.name, q.options]));
    for (const name of ['campaign.refresh', 'record.triage', 'touch.plan', 'sf.write']) {
```

In the second `it`, rename it and add the `sf.write` line:

```ts
  it('schedules refresh every 5 minutes and triage, planning and the Salesforce outbox every minute', () => {
    expect(SCHEDULES).toEqual([
      { queue: 'campaign.refresh', cron: '*/5 * * * *' },
      { queue: 'record.triage', cron: '* * * * *' },
      { queue: 'touch.plan', cron: '* * * * *' },
      { queue: 'sf.write', cron: '* * * * *' },
    ]);
  });
```

- [ ] **Step 10: Run them to verify they fail**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/outbox-wiring.test.ts src/jobs/schedules.test.ts
```

Expected: `Tests  6 failed | 1 passed (7)`.
- The four wiring tests fail with:
  - `AssertionError: expected undefined to be { Object (retryLimit, retryDelay, ...) }`
  - two `expected 'import \'dotenv/config\';…' to contain …` failures
  - `TypeError: sfWriteAlert is not a function`
- The two schedules assertions fail with no `sf.write` entry.
- `schedules only queues that exist` passes.

- [ ] **Step 11: Add the alert kind and `sfWriteAlert`**

In `services/outreach-api/src/alerts.ts`, replace lines 15–18:

```ts
  kind:
    | 'provisioning_failed'
    | 'job_dead_lettered'
    | 'auth_failure_spike';
```

with:

```ts
  kind:
    | 'provisioning_failed'
    | 'job_dead_lettered'
    | 'auth_failure_spike'
    | 'sf_write_failing';
```

and append at the end of the file:

```ts

/**
 * The outbox's 24-hour alert (crm/outbox.ts `DrainDeps.alert`), as a warning
 * through the same log + webhook path as every other alert.
 */
export function sfWriteAlert(logger: AlertLogger): (orgId: string, message: string) => Promise<void> {
  return (orgId, message) => dispatchAlert(logger, { kind: 'sf_write_failing', severity: 'warning', orgId, message });
}
```

- [ ] **Step 12: Declare the queue and its schedule**

In `services/outreach-api/src/jobs/queues.ts`, add the last entry of `QUEUES`, after `{ name: 'touch.plan', options: TICK_QUEUE_OPTIONS },`:

```ts
  // B2: drains the Salesforce write outbox (crm/outbox.ts).
  { name: 'sf.write', options: TICK_QUEUE_OPTIONS },
```

In `services/outreach-api/src/jobs/schedules.ts`, add the last entry of `SCHEDULES`, after `{ queue: 'touch.plan', cron: '* * * * *' },`:

```ts
  { queue: 'sf.write', cron: '* * * * *' },
```

- [ ] **Step 13: Wire the handler and the review hook in `server.ts`**

Add these imports to `services/outreach-api/src/server.ts`, keeping path order. Put `./alerts.js` directly before `./app.js`, and `./crm/outbox.js` directly after A5's `./crm/client-factory.js`:

```ts
import { sfWriteAlert } from './alerts.js';
import { doNotContactEnqueuer, outboxJob } from './crm/outbox.js';
```

In `main()`, add this entry at the end of the `handlers` object (after the last spread A8–A10 added). It follows A8's pattern, where an unconfigured feature gets no worker:

```ts
    ...(cfg.salesforceEnabled
      ? { 'sf.write': outboxJob({ db, clients, log: console, alert: sfWriteAlert(console) }) }
      : {}),
```

In `apiRoutes`, replace A11's entry `(scope) => registerReviewRoutes(scope, { db }),` with:

```ts
      (scope) => registerReviewRoutes(scope, { db, onConfirmed: doNotContactEnqueuer(db) }),
```

Rows queue even without Salesforce configured; they drain once it is. `doNotContactEnqueuer(db)` matches A11's `(args: ConfirmedDoNotContact, tx: Db) => Promise<void>` and writes through A11's `tx`.

- [ ] **Step 14: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm src/jobs && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test 2>&1 | tail -4
```

Expected: `outbox-wiring.test.ts (4 tests)` and `schedules.test.ts (3 tests)` pass, alongside the outbox and metadata files. The typecheck exits 0. The full suite passes, with the real-Postgres files skipped.

- [ ] **Step 15: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  services/outreach-api/src/crm/outbox-wiring.test.ts \
  services/outreach-api/src/alerts.ts \
  services/outreach-api/src/jobs/queues.ts \
  services/outreach-api/src/jobs/schedules.ts \
  services/outreach-api/src/jobs/schedules.test.ts \
  services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): drain the Salesforce outbox every minute and queue do-not-contact writes from review"
```

#### Part 3: the review dialog says what Salesforce gets

- [ ] **Step 16: Write the failing assertion**

In `apps/outreach-web/src/components/review-page.test.tsx`, in `it('confirms do-not-contact only after a dialog that explains it opts the person out of everything'`, add this directly after `expect(dialog).toHaveTextContent('This opts Jane Seller out of everything');`:

```ts
    expect(dialog).toHaveTextContent('Salesforce marks them Do Not Call and Email Opt Out');
```

- [ ] **Step 17: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test -- src/components/review-page.test.tsx
```

Expected: `Tests  1 failed | 4 passed (5)`. The failing test is `confirms do-not-contact only after a dialog that explains it opts the person out of everything`, with `expect(element).toHaveTextContent()`.

- [ ] **Step 18: Update the copy**

In `apps/outreach-web/src/components/review-page.tsx`, replace the confirm dialog's `description` line:

```tsx
            description={`This opts ${label} out of everything: their phone numbers go on your company's opt-out list, so no campaign or rep dialer will call or text them, and they leave this campaign. You can't undo this here.`}
```

with:

```tsx
            description={`This opts ${label} out of everything: their phone numbers go on your company's opt-out list, so no campaign or rep dialer will call or text them, they leave this campaign, and Salesforce marks them Do Not Call and Email Opt Out. You can't undo this here.`}
```

- [ ] **Step 19: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test -- src/components/review-page.test.tsx && npm -w apps/outreach-web run typecheck
```

Expected: `Tests  5 passed (5)`. The typecheck exits 0.

- [ ] **Step 20: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add apps/outreach-web/src/components/review-page.tsx apps/outreach-web/src/components/review-page.test.tsx
git commit -m "feat(outreach-web): say that confirming do-not-contact also marks Salesforce"
```

---

### Task B3: Consent capture, backfill, settings routes, and the Consent card

There are two tenant settings, both off by default (A10's `outreachSettings`). Each turns on one consent source (spec §11.1):
- **Web forms:** a record whose web-form source field is set counts as consented. Turning this on is the admin's confirmation that the forms carry consent language. The route stamps who confirmed it and when.
- **Inbound calls:** a record whose number called us, or that the CTI matched an inbound call to by Salesforce who/what id, counts as consented.

`recordConsent` is the one write path. In one transaction it:
1. Ticks `crm_records` with a compare-and-swap, so a second call is a no-op returning `false`.
2. Inserts one `consent_records` row per distinct number (`consent_type = 'ai_call'`, `notes = '<source>: <evidence>'`).
3. Queues one `consent` outbox row.

Consent is captured in two places. Each campaign refresh applies the switched-on sources to the records it just fetched. An admin's Backfill applies them to every not-yet-consented record of the tenant.

**Files:**
- Create: `packages/contracts/src/consent.ts`; Test: `packages/contracts/src/consent.test.ts`
- Modify: `packages/contracts/src/index.ts`: add `export * from './consent.js';` in alphabetical order, after `./campaigns.js`
- Create: `services/outreach-api/src/consent/rules.ts` (pure); Test: `services/outreach-api/src/consent/rules.test.ts`
- Create: `services/outreach-api/src/consent/capture.ts`; Test: `services/outreach-api/src/consent/capture.test.ts`, `services/outreach-api/src/consent/capture.pg.test.ts`
- Modify: `services/outreach-api/src/campaigns/refresh.ts` (A8): the import list, and the `if (fetchIds.length > 0) { … }` block in `refreshCampaign`; Test: `services/outreach-api/src/consent/refresh-hook.test.ts`
- Create: `services/outreach-api/src/routes/consent.ts`; Test: `services/outreach-api/src/routes/consent.test.ts`
- Modify: `services/outreach-api/src/server.ts`: the import list and `apiRoutes`
- Modify: `apps/outreach-web/src/lib/outreach-api.ts` (A12/A13): the `@cti/contracts` import, `outreachKeys`, and three functions appended
- Create: `apps/outreach-web/src/components/consent-card.tsx`; Test: `apps/outreach-web/src/components/consent-card.test.tsx`
- Modify: `apps/outreach-web/src/components/connections-page.tsx` (A12): one import, and one line after the `FieldMapEditor` block

**Interfaces:**
- Consumes:
  - **A3:** `schema.crmRecords` (`consentAiCall`, `consentSource`, `consentAt`), `schema.consentRecords` (`orgId`, `e164`, `consentType`, `capturedAt`, `notes`), `schema.calls` (`orgId`, `direction`, `fromNumber`, `salesforceWhoId`, `salesforceWhatId`, `createdAt`), and `schema.organizations.settings`. Also `createTestDb`/`pgLane`.
  - **A8:** `type SfRecordSnapshot` (`src/campaigns/records.ts`: `webFormSource`, `consentAiCall`, `phones: { field; e164 }[]`), and `upsertRecords(db, orgId, snapshots): Promise<Map<sfRecordId, { id; changed }>>` with `refreshCampaign` in `src/campaigns/refresh.ts`.
  - **A10:** `outreachSettings(org: { settings: unknown }): OutreachSettings` (`consentFromWebForms`, `consentFromInboundCalls`).
  - **A5:** `requireContext`, `requireAdmin`, `sendError`, `buildApp`, `fakeDb`, `testConfig`.
  - **B1:** `type ConsentSource`.
  - **B2:** `enqueueSfWrite`.
  - **`@cti/phone`:** `toE164`.
  - **A12:** web `api`, `json`, `outreachKeys`, `errorText`, `stubApi`, `renderWithProviders`, and the `connection()` fixture.
- Produces:
  ```ts
  // @cti/contracts (packages/contracts/src/consent.ts)
  export const ConsentSettings = z.object({ consentFromWebForms: z.boolean(), consentFromInboundCalls: z.boolean() });
  export const ConsentSettingsUpdate = ConsentSettings.partial();
  export const BackfillResult = z.object({ webForm: z.number().int().nonnegative(), inboundCall: z.number().int().nonnegative() });
  // src/consent/rules.ts (pure)
  export function consentFromRecord(s: Pick<SfRecordSnapshot, 'webFormSource' | 'consentAiCall'>, settings: Pick<OutreachSettings, 'consentFromWebForms'>): { source: 'Web Form' } | null;
  export interface InboundCallRow { id: string; fromNumber: string; salesforceWhoId: string | null; salesforceWhatId: string | null }
  export function inboundCallerMatches(records: ReadonlyArray<{ id: string; sfRecordId: string; phones: ReadonlyArray<{ e164: string }> }>, calls: readonly InboundCallRow[]): Map<string /* crmRecordId */, string /* callId */>;
  export interface ConsentCandidate { crmRecordId; sfObject: 'Lead' | 'Opportunity'; sfRecordId; phones: ReadonlyArray<{ e164: string }>; webFormSource: string | null }
  export interface PlannedConsent { crmRecordId; sfObject; sfRecordId; e164s: string[]; source: 'Web Form' | 'Inbound Call'; evidence: string }
  export function planConsent(settings, candidates: readonly ConsentCandidate[], calls: readonly InboundCallRow[]): PlannedConsent[];
  // src/consent/capture.ts
  export const AI_CALL_CONSENT_TYPE = 'ai_call';
  export const INBOUND_CALLS_CAP = 200_000;
  export interface RecordConsentInput { orgId; crmRecordId; sfObject: 'Lead' | 'Opportunity'; sfRecordId; e164s: string[]; source: ConsentSource; evidence: string; at: Date }
  export function recordConsent(db: Db, input: RecordConsentInput): Promise<boolean>;
  export function applyConsentPlan(db: Db, orgId: string, plan: readonly PlannedConsent[], at: Date): Promise<BackfillResult>;
  export function loadInboundCalls(db: Db, orgId: string): Promise<InboundCallRow[]>;
  export function backfillConsent(deps: { db: Db; orgId: string; now: Date }): Promise<BackfillResult>;
  export function captureConsentOnRefresh(db: Db, input: { orgId; snapshots: readonly SfRecordSnapshot[]; upserted: ReadonlyMap<string, { id: string }>; now: Date }): Promise<BackfillResult>;
  // src/routes/consent.ts
  export function registerConsentRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void>;
  // apps/outreach-web
  export function getConsentSettings(): Promise<ConsentSettings>;
  export function saveConsentSettings(update: ConsentSettingsUpdate): Promise<ConsentSettings>;
  export function backfillConsent(): Promise<BackfillResult>;
  export const WEB_FORM_CONFIRMATION = 'Our forms carry consent language for calls and texts.';
  export function ConsentCard(props: { canEdit: boolean }): JSX.Element;
  ```
  Routes (under `/api`):
  - `GET /settings/consent` (any member) → `ConsentSettings`.
  - `PUT /settings/consent` (admin, `ConsentSettingsUpdate`) → `ConsentSettings`. Errors: `400 VALIDATION`, `404 TENANT_NOT_FOUND`. Switching web forms on also stores `consentFromWebFormsConfirmedBy`/`…ConfirmedAt` in `organizations.settings`.
  - `POST /settings/consent/backfill` (admin, no body) → `BackfillResult`.

#### Part 1: contracts

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/consent.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BackfillResult, ConsentSettings, ConsentSettingsUpdate } from './index.js';

describe('consent contracts', () => {
  it('ConsentSettings needs both flags', () => {
    expect(ConsentSettings.safeParse({ consentFromWebForms: true, consentFromInboundCalls: false }).success).toBe(true);
    expect(ConsentSettings.safeParse({ consentFromWebForms: true }).success).toBe(false);
  });
  it('ConsentSettingsUpdate takes either flag alone and strips every other key', () => {
    expect(ConsentSettingsUpdate.parse({ consentFromInboundCalls: true })).toEqual({ consentFromInboundCalls: true });
    expect(ConsentSettingsUpdate.safeParse({ consentFromWebForms: 'yes' }).success).toBe(false);
    // The route merges exactly the parsed object into organizations.settings,
    // so a smuggled key (another setting) can never be written through it.
    expect(ConsentSettingsUpdate.parse({ aiDailyBudgetUsd: 999, consentFromWebForms: false })).toEqual({ consentFromWebForms: false });
  });
  it('BackfillResult counts are non-negative integers', () => {
    expect(BackfillResult.safeParse({ webForm: 3, inboundCall: 0 }).success).toBe(true);
    expect(BackfillResult.safeParse({ webForm: -1, inboundCall: 0 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test -- src/consent.test.ts
```

Expected: `FAIL src/consent.test.ts`, with `Error: Failed to load url ./consent.js (resolved id: ./consent.js) in …/consent.test.ts. Does the file exist?`.

- [ ] **Step 3: Write the contracts**

`packages/contracts/src/consent.ts`:
```ts
import { z } from 'zod';

/**
 * Which consent sources the tenant has switched on (spec §11.1). Stored in
 * `organizations.settings` under these same keys; both default to off.
 * `consentFromWebForms` is the admin's confirmation that the tenant's web
 * forms carry consent language covering calls and texts.
 */
export const ConsentSettings = z.object({
  consentFromWebForms: z.boolean(),
  consentFromInboundCalls: z.boolean(),
});
export type ConsentSettings = z.infer<typeof ConsentSettings>;

export const ConsentSettingsUpdate = ConsentSettings.partial();
export type ConsentSettingsUpdate = z.infer<typeof ConsentSettingsUpdate>;

/** How many records a backfill ticked, by source. */
export const BackfillResult = z.object({
  webForm: z.number().int().nonnegative(),
  inboundCall: z.number().int().nonnegative(),
});
export type BackfillResult = z.infer<typeof BackfillResult>;
```

In `packages/contracts/src/index.ts`, add after `export * from './campaigns.js';`:

```ts
export * from './consent.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test && npm run build:packages
```

Expected: `✓ src/consent.test.ts (3 tests)` and the whole contracts suite passes. `build:packages` exits 0.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add packages/contracts/src/consent.ts packages/contracts/src/consent.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add consent settings and backfill result contracts"
```

#### Part 2: the rules (pure)

- [ ] **Step 6: Write the failing test**

`services/outreach-api/src/consent/rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { consentFromRecord, inboundCallerMatches, planConsent, type ConsentCandidate, type InboundCallRow } from './rules.js';

const ON = { consentFromWebForms: true, consentFromInboundCalls: true };
const OFF = { consentFromWebForms: false, consentFromInboundCalls: false };

describe('consentFromRecord — the web-form rule', () => {
  it.each([
    ['setting on, form source set, not consented', { consentFromWebForms: true }, { webFormSource: 'Zillow form', consentAiCall: false }, { source: 'Web Form' }],
    ['setting OFF: never, whatever the record says', { consentFromWebForms: false }, { webFormSource: 'Zillow form', consentAiCall: false }, null],
    ['no form source', { consentFromWebForms: true }, { webFormSource: null, consentAiCall: false }, null],
    ['blank form source', { consentFromWebForms: true }, { webFormSource: '   ', consentAiCall: false }, null],
    ['already consented', { consentFromWebForms: true }, { webFormSource: 'Zillow form', consentAiCall: true }, null],
  ] as const)('%s', (_name, settings, record, expected) => {
    expect(consentFromRecord(record, settings)).toEqual(expected);
  });
});

describe('inboundCallerMatches', () => {
  const records = [
    { id: 'R-LEAD', sfRecordId: '00Q000000000001AAA', phones: [{ e164: '+15125550101' }] },
    { id: 'R-OPP', sfRecordId: '006000000000002AAA', phones: [{ e164: '+15125550202' }, { e164: '+15125550203' }] },
    { id: 'R-NONE', sfRecordId: '00Q000000000009AAA', phones: [{ e164: '+15125550999' }] },
  ];

  it('matches by the caller number, normalizing what the carrier sent', () => {
    const calls: InboundCallRow[] = [{ id: 'C1', fromNumber: '(512) 555-0203', salesforceWhoId: null, salesforceWhatId: null }];
    expect(inboundCallerMatches(records, calls)).toEqual(new Map([['R-OPP', 'C1']]));
  });

  it("matches by the call's Salesforce who id or what id, 15- or 18-character", () => {
    const calls: InboundCallRow[] = [
      { id: 'C1', fromNumber: '+19995550000', salesforceWhoId: '00Q000000000001', salesforceWhatId: null },
      { id: 'C2', fromNumber: 'anonymous', salesforceWhoId: '003000000000005AAA', salesforceWhatId: '006000000000002AAA' },
    ];
    expect(inboundCallerMatches(records, calls)).toEqual(new Map([['R-LEAD', 'C1'], ['R-OPP', 'C2']]));
  });

  it('the first matching call (in the order given) is the evidence; unmatched records are absent', () => {
    const calls: InboundCallRow[] = [
      { id: 'NEWEST', fromNumber: '+15125550101', salesforceWhoId: null, salesforceWhatId: null },
      { id: 'OLDER', fromNumber: '+15125550101', salesforceWhoId: null, salesforceWhatId: null },
    ];
    const m = inboundCallerMatches(records, calls);
    expect(m.get('R-LEAD')).toBe('NEWEST');
    expect(m.has('R-NONE')).toBe(false);
  });
});

describe('planConsent', () => {
  const cand = (over: Partial<ConsentCandidate> & Pick<ConsentCandidate, 'crmRecordId'>): ConsentCandidate => ({
    sfObject: 'Lead', sfRecordId: `00Q00000000000${over.crmRecordId.slice(-1)}AAA`, phones: [], webFormSource: null, ...over,
  });
  const candidates = [
    cand({ crmRecordId: 'R1', webFormSource: 'Website', phones: [{ e164: '+15125550101' }] }),
    cand({ crmRecordId: 'R2', phones: [{ e164: '+15125550102' }, { e164: '+15125550103' }] }),
    cand({ crmRecordId: 'R3', phones: [{ e164: '+15125550104' }] }),
  ];
  const calls: InboundCallRow[] = [
    { id: 'C1', fromNumber: '+15125550101', salesforceWhoId: null, salesforceWhatId: null },
    { id: 'C2', fromNumber: '+15125550103', salesforceWhoId: null, salesforceWhatId: null },
  ];

  it('both sources on: web form first, inbound for the rest, never the same record twice', () => {
    expect(planConsent(ON, candidates, calls)).toEqual([
      { crmRecordId: 'R1', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', e164s: ['+15125550101'], source: 'Web Form', evidence: 'form source Website' },
      { crmRecordId: 'R2', sfObject: 'Lead', sfRecordId: '00Q000000000002AAA', e164s: ['+15125550102', '+15125550103'], source: 'Inbound Call', evidence: 'call C2' },
    ]);
  });

  it('only the web-form source on', () => {
    expect(planConsent({ consentFromWebForms: true, consentFromInboundCalls: false }, candidates, calls).map((p) => [p.crmRecordId, p.source]))
      .toEqual([['R1', 'Web Form']]);
  });

  it('only the inbound source on: R1 qualifies by its call instead', () => {
    expect(planConsent({ consentFromWebForms: false, consentFromInboundCalls: true }, candidates, calls).map((p) => [p.crmRecordId, p.source, p.evidence]))
      .toEqual([['R1', 'Inbound Call', 'call C1'], ['R2', 'Inbound Call', 'call C2']]);
  });

  it('both off: nothing', () => {
    expect(planConsent(OFF, candidates, calls)).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/rules.test.ts
```

Expected: `FAIL src/consent/rules.test.ts`, with `Error: Failed to load url ./rules.js (resolved id: ./rules.js) in …/rules.test.ts. Does the file exist?`.

- [ ] **Step 8: Write the rules**

`services/outreach-api/src/consent/rules.ts`:
```ts
/**
 * AI-call consent rules (spec §11.1) — pure. Which records the tenant's switched-on
 * consent sources tick, and with what evidence. Capture (capture.ts) applies
 * the plan; nothing here touches the database or Salesforce.
 */
import { toE164 } from '@cti/phone';
import type { SfRecordSnapshot } from '../campaigns/records.js';
import type { OutreachSettings } from '../settings.js';

type ConsentSettingsView = Pick<OutreachSettings, 'consentFromWebForms' | 'consentFromInboundCalls'>;

/** Web-form rule: the tenant confirmed its forms carry consent language, and this record came from a form. */
export function consentFromRecord(
  s: Pick<SfRecordSnapshot, 'webFormSource' | 'consentAiCall'>,
  settings: Pick<OutreachSettings, 'consentFromWebForms'>,
): { source: 'Web Form' } | null {
  if (!settings.consentFromWebForms || s.consentAiCall) return null;
  return s.webFormSource && s.webFormSource.trim() !== '' ? { source: 'Web Form' } : null;
}

export interface InboundCallRow {
  id: string;
  fromNumber: string;
  salesforceWhoId: string | null;
  salesforceWhatId: string | null;
}

/** 15-character form, so a 15- and an 18-character Salesforce id compare equal. */
const id15 = (id: string): string => id.slice(0, 15);

/**
 * crmRecordId → the id of the first call (in the order given) the CTI logged
 * FROM this person: the call's Salesforce match names the record, or the
 * caller's number is one of the record's numbers.
 */
export function inboundCallerMatches(
  records: ReadonlyArray<{ id: string; sfRecordId: string; phones: ReadonlyArray<{ e164: string }> }>,
  calls: readonly InboundCallRow[],
): Map<string, string> {
  const byNumber = new Map<string, string>();
  const bySfId = new Map<string, string>();
  for (const c of calls) {
    const from = toE164(c.fromNumber);
    if (from && !byNumber.has(from)) byNumber.set(from, c.id);
    for (const sfId of [c.salesforceWhoId, c.salesforceWhatId]) {
      if (sfId && !bySfId.has(id15(sfId))) bySfId.set(id15(sfId), c.id);
    }
  }
  const out = new Map<string, string>();
  for (const r of records) {
    const callId = bySfId.get(id15(r.sfRecordId)) ?? r.phones.map((p) => byNumber.get(p.e164)).find((id) => id !== undefined);
    if (callId) out.set(r.id, callId);
  }
  return out;
}

export interface ConsentCandidate {
  crmRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  phones: ReadonlyArray<{ e164: string }>;
  webFormSource: string | null;
}

export interface PlannedConsent {
  crmRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  e164s: string[];
  source: 'Web Form' | 'Inbound Call';
  evidence: string;
}

/**
 * The consents the switched-on sources give these (not yet consented)
 * candidates. Web form first; a record the web form already covers is not
 * planned twice. Each source runs only when its setting is on.
 */
export function planConsent(settings: ConsentSettingsView, candidates: readonly ConsentCandidate[], calls: readonly InboundCallRow[]): PlannedConsent[] {
  const plan: PlannedConsent[] = [];
  const planned = new Set<string>();
  const base = (c: ConsentCandidate) => ({ crmRecordId: c.crmRecordId, sfObject: c.sfObject, sfRecordId: c.sfRecordId, e164s: c.phones.map((p) => p.e164) });
  for (const c of candidates) {
    if (!consentFromRecord({ webFormSource: c.webFormSource, consentAiCall: false }, settings)) continue;
    plan.push({ ...base(c), source: 'Web Form', evidence: `form source ${c.webFormSource!.trim()}` });
    planned.add(c.crmRecordId);
  }
  if (settings.consentFromInboundCalls) {
    const rest = candidates.filter((c) => !planned.has(c.crmRecordId));
    const matches = inboundCallerMatches(rest.map((c) => ({ id: c.crmRecordId, sfRecordId: c.sfRecordId, phones: c.phones })), calls);
    for (const c of rest) {
      const callId = matches.get(c.crmRecordId);
      if (callId) plan.push({ ...base(c), source: 'Inbound Call', evidence: `call ${callId}` });
    }
  }
  return plan;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/rules.test.ts
```

Expected: `✓ src/consent/rules.test.ts (12 tests)`.

#### Part 3: capture and backfill

- [ ] **Step 10: Write the failing tests**

`services/outreach-api/src/consent/capture.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import type { SfRecordSnapshot } from '../campaigns/records.js';
import { fakeDb } from '../test/harness.js';
import { backfillConsent, captureConsentOnRefresh, recordConsent } from './capture.js';

const dialect = new PgDialect();
const AT = new Date('2026-10-05T15:00:00.000Z');
const org = (settings: Record<string, unknown>) => [{ id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', settings }];
/** A consent UPDATE that matched its record (fakeDb's updateReturning); `[]` = it was already consented. */
const TICKS = [{ id: 'R' }];

const input = {
  orgId: 'O1', crmRecordId: 'R1', sfObject: 'Lead' as const, sfRecordId: '00Q000000000001AAA',
  e164s: ['+15125550101', '+15125550102', '+15125550101'], source: 'Web Form' as const, evidence: 'form source Website', at: AT,
};

describe('recordConsent', () => {
  it('ticks the record, writes one consent_records row per distinct number and ONE consent sf_write', async () => {
    const { db, writes } = fakeDb({ updateReturning: TICKS });
    expect(await recordConsent(db, input)).toBe(true);
    expect(writes.find((w) => w.table === schema.crmRecords)?.values).toEqual({ consentAiCall: true, consentSource: 'Web Form', consentAt: AT });
    expect(writes.filter((w) => w.table === schema.consentRecords).map((w) => w.values)).toEqual([[
      { orgId: 'O1', e164: '+15125550101', consentType: 'ai_call', capturedAt: AT, notes: 'Web Form: form source Website' },
      { orgId: 'O1', e164: '+15125550102', consentType: 'ai_call', capturedAt: AT, notes: 'Web Form: form source Website' },
    ]]);
    expect(writes.filter((w) => w.table === schema.sfWrites).map((w) => w.values)).toEqual([{
      orgId: 'O1', kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA',
      payload: { consent: true, source: 'Web Form', at: '2026-10-05T15:00:00.000Z' },
    }]);
  });

  it('is a no-op returning false when the record is already consented: no evidence row, no Salesforce write', async () => {
    const { db, writes } = fakeDb({ updateReturning: [] });
    expect(await recordConsent(db, input)).toBe(false);
    expect(writes.filter((w) => w.op === 'insert')).toEqual([]);
  });

  it('the tick is a compare-and-swap scoped to the org and to records not yet consented', async () => {
    const { db, captured } = fakeDb({ updateReturning: TICKS });
    await recordConsent(db, input);
    const q = dialect.sqlToQuery(captured.where[0] as SQL);
    expect(q.sql).toBe('("crm_records"."id" = $1 and "crm_records"."org_id" = $2 and "crm_records"."consent_ai_call" = $3)');
    expect(q.params).toEqual(['R1', 'O1', false]);
  });
});

describe('backfillConsent', () => {
  // The crm_records select, then the calls select — in the order backfillConsent awaits them.
  const records = [
    { crmRecordId: 'R1', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', phones: [{ field: 'MobilePhone', e164: '+15125550101' }], webFormSource: 'Website' },
    { crmRecordId: 'R2', sfObject: 'Opportunity', sfRecordId: '006000000000002AAA', phones: [{ field: 'Phone__c', e164: '+15125550102' }], webFormSource: null },
    { crmRecordId: 'R3', sfObject: 'Lead', sfRecordId: '00Q000000000003AAA', phones: [{ field: 'Phone', e164: '+15125550103' }], webFormSource: null },
    { crmRecordId: 'R4', sfObject: 'Lead', sfRecordId: '00Q000000000004AAA', phones: [], webFormSource: 'Facebook ad' },
  ];
  const calls = [
    { id: 'C1', fromNumber: '+15125550102', salesforceWhoId: null, salesforceWhatId: null },
    { id: 'C2', fromNumber: '+19995550000', salesforceWhoId: '00Q000000000003', salesforceWhatId: null },
  ];

  it('counts each source it ticked', async () => {
    const { db, writes } = fakeDb({ organizations: org({ consentFromWebForms: true, consentFromInboundCalls: true }), selectResults: [records, calls], updateReturning: TICKS });
    expect(await backfillConsent({ db, orgId: 'O1', now: AT })).toEqual({ webForm: 2, inboundCall: 2 });
    expect(writes.filter((w) => w.table === schema.sfWrites).map((w) => (w.values as { payload: { source: string } }).payload.source))
      .toEqual(['Web Form', 'Web Form', 'Inbound Call', 'Inbound Call']);
  });

  it('only the switched-on source runs; with both off nothing is read or written', async () => {
    const webOnly = fakeDb({ organizations: org({ consentFromWebForms: true }), selectResults: [records], updateReturning: TICKS });
    expect(await backfillConsent({ db: webOnly.db, orgId: 'O1', now: AT })).toEqual({ webForm: 2, inboundCall: 0 });
    const neither = fakeDb({ organizations: org({}), selectResults: [records, calls], updateReturning: TICKS });
    expect(await backfillConsent({ db: neither.db, orgId: 'O1', now: AT })).toEqual({ webForm: 0, inboundCall: 0 });
    expect(neither.writes).toEqual([]);
  });

  it('counts only records it actually ticked (a re-run over consented records counts nothing)', async () => {
    const { db } = fakeDb({ organizations: org({ consentFromWebForms: true, consentFromInboundCalls: true }), selectResults: [records, calls], updateReturning: [] });
    expect(await backfillConsent({ db, orgId: 'O1', now: AT })).toEqual({ webForm: 0, inboundCall: 0 });
  });
});

describe('captureConsentOnRefresh', () => {
  const snap = (over: Partial<SfRecordSnapshot>): SfRecordSnapshot => ({
    sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', name: null, ownerSfUserId: null, ownerName: null, leadManagerSfUserId: null,
    phones: [{ field: 'MobilePhone', e164: '+15125550101' }], email: null, state: null, webFormSource: 'Website', consentAiCall: false,
    sfDoNotCall: false, sfEmailOptOut: false, skipOnDialer: false, isClosed: false, lastModifiedAt: null, ...over,
  });
  const upserted = new Map([['00Q000000000001AAA', { id: 'R1', changed: true }], ['00Q000000000002AAA', { id: 'R2', changed: false }]]);

  it('applies the web-form rule to the refreshed records when the setting is on, skipping ones Salesforce already marks consented', async () => {
    const { db, writes } = fakeDb({ organizations: org({ consentFromWebForms: true }), updateReturning: TICKS });
    const result = await captureConsentOnRefresh(db, {
      orgId: 'O1', now: AT, upserted,
      snapshots: [snap({}), snap({ sfRecordId: '00Q000000000002AAA', consentAiCall: true })],
    });
    expect(result).toEqual({ webForm: 1, inboundCall: 0 });
    expect(writes.filter((w) => w.table === schema.sfWrites)).toHaveLength(1);
  });

  it('with the inbound source on, matches the refreshed records against inbound calls', async () => {
    const { db } = fakeDb({
      organizations: org({ consentFromInboundCalls: true }),
      selectResults: [[{ id: 'C9', fromNumber: '+15125550101', salesforceWhoId: null, salesforceWhatId: null }]],
      updateReturning: TICKS,
    });
    expect(await captureConsentOnRefresh(db, { orgId: 'O1', now: AT, upserted, snapshots: [snap({ webFormSource: null })] }))
      .toEqual({ webForm: 0, inboundCall: 1 });
  });

  it('does nothing when both settings are off', async () => {
    const { db, writes } = fakeDb({ organizations: org({}), updateReturning: TICKS });
    expect(await captureConsentOnRefresh(db, { orgId: 'O1', now: AT, upserted, snapshots: [snap({})] })).toEqual({ webForm: 0, inboundCall: 0 });
    expect(writes).toEqual([]);
  });
});
```

`services/outreach-api/src/consent/capture.pg.test.ts`:
```ts
/** Real-Postgres lane (A3): consent capture is idempotent in the database, not just in a fake. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { backfillConsent, recordConsent } from './capture.js';

describe.skipIf(!pgLane)('consent capture against real Postgres', () => {
  let t: TestDb;
  let db: Db;
  let orgId: string;
  const AT = new Date('2026-10-05T15:00:00.000Z');

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [org] = await db.insert(schema.organizations).values({
      name: 'Consent Co', slug: `consent-${Date.now()}`, settings: { consentFromWebForms: true, consentFromInboundCalls: true },
    }).returning();
    orgId = org!.id;
  }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('recordConsent twice: one tick, one consent_records row per number, one sf_writes row', async () => {
    const [rec] = await db.insert(schema.crmRecords).values({
      orgId, sfObject: 'Lead', sfRecordId: '00Q000000000001AAA',
      phones: [{ field: 'MobilePhone', e164: '+15125550101' }, { field: 'Phone', e164: '+15125550102' }],
    }).returning();
    const input = { orgId, crmRecordId: rec!.id, sfObject: 'Lead' as const, sfRecordId: rec!.sfRecordId, e164s: ['+15125550101', '+15125550102'], source: 'Rep' as const, evidence: 'ticked by admin', at: AT };
    expect(await recordConsent(db, input)).toBe(true);
    expect(await recordConsent(db, input)).toBe(false);
    const [after] = await db.select().from(schema.crmRecords).where(eq(schema.crmRecords.id, rec!.id));
    expect(after).toMatchObject({ consentAiCall: true, consentSource: 'Rep', consentAt: AT });
    expect(await db.select().from(schema.consentRecords).where(eq(schema.consentRecords.orgId, orgId))).toHaveLength(2);
    expect(await db.select().from(schema.sfWrites).where(eq(schema.sfWrites.orgId, orgId))).toHaveLength(1);
  });

  it('backfillConsent counts web-form and inbound-call consents, and a re-run counts nothing', async () => {
    const [user] = await db.insert(schema.users).values({ orgId, email: `rep-${Date.now()}@consent.co` }).returning();
    await db.insert(schema.crmRecords).values([
      { orgId, sfObject: 'Lead', sfRecordId: '00Q000000000002AAA', webFormSource: 'Website', phones: [] },
      { orgId, sfObject: 'Opportunity', sfRecordId: '006000000000003AAA', phones: [{ field: 'Phone__c', e164: '+15125550103' }] },
      { orgId, sfObject: 'Lead', sfRecordId: '00Q000000000004AAA', phones: [{ field: 'Phone', e164: '+15125550104' }] },
    ]);
    await db.insert(schema.calls).values({
      orgId, userId: user!.id, provider: 'twilio', fromNumber: '+15125550103', toNumber: '+15125550000', normalizedToNumber: '+15125550000', direction: 'inbound',
    });
    expect(await backfillConsent({ db, orgId, now: AT })).toEqual({ webForm: 1, inboundCall: 1 });
    expect(await backfillConsent({ db, orgId, now: AT })).toEqual({ webForm: 0, inboundCall: 0 });
  });
});
```

- [ ] **Step 11: Run them to verify they fail**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/capture.test.ts
```

Expected: `FAIL src/consent/capture.test.ts`, with `Error: Failed to load url ./capture.js (resolved id: ./capture.js) in …/capture.test.ts. Does the file exist?`.

- [ ] **Step 12: Write capture and backfill**

`services/outreach-api/src/consent/capture.ts`:
```ts
/**
 * Capturing AI-call consent (spec §11.1): tick our record, keep the evidence in
 * `consent_records` (one row per number), and queue the Salesforce write — all
 * in one transaction, and a no-op for a record that is already consented.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { BackfillResult } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { SfRecordSnapshot } from '../campaigns/records.js';
import type { ConsentSource } from '../crm/consent-fields.js';
import { enqueueSfWrite } from '../crm/outbox.js';
import { outreachSettings } from '../settings.js';
import { planConsent, type ConsentCandidate, type InboundCallRow, type PlannedConsent } from './rules.js';

/** consent_records.consent_type for this system's consent. */
export const AI_CALL_CONSENT_TYPE = 'ai_call';
/** Most recent inbound calls a backfill or refresh matches against. */
export const INBOUND_CALLS_CAP = 200_000;

export interface RecordConsentInput {
  orgId: string;
  crmRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  e164s: string[];
  source: ConsentSource;
  evidence: string;
  at: Date;
}

/** True when this call consented the record; false when it already was (nothing written). */
export async function recordConsent(db: Db, input: RecordConsentInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [ticked] = await tx
      .update(schema.crmRecords)
      .set({ consentAiCall: true, consentSource: input.source, consentAt: input.at })
      .where(and(
        eq(schema.crmRecords.id, input.crmRecordId),
        eq(schema.crmRecords.orgId, input.orgId),
        eq(schema.crmRecords.consentAiCall, false),
      ))
      .returning({ id: schema.crmRecords.id });
    if (!ticked) return false;
    const numbers = [...new Set(input.e164s)];
    if (numbers.length > 0) {
      await tx.insert(schema.consentRecords).values(numbers.map((e164) => ({
        orgId: input.orgId, e164, consentType: AI_CALL_CONSENT_TYPE, capturedAt: input.at, notes: `${input.source}: ${input.evidence}`,
      })));
    }
    await enqueueSfWrite(tx, {
      orgId: input.orgId, kind: 'consent', sfObject: input.sfObject, sfRecordId: input.sfRecordId,
      payload: { consent: true, source: input.source, at: input.at.toISOString() },
    });
    return true;
  });
}

/** Apply a plan; counts only the records this run actually ticked. */
export async function applyConsentPlan(db: Db, orgId: string, plan: readonly PlannedConsent[], at: Date): Promise<BackfillResult> {
  let webForm = 0;
  let inboundCall = 0;
  for (const p of plan) {
    const ticked = await recordConsent(db, { orgId, crmRecordId: p.crmRecordId, sfObject: p.sfObject, sfRecordId: p.sfRecordId, e164s: p.e164s, source: p.source, evidence: p.evidence, at });
    if (!ticked) continue;
    if (p.source === 'Web Form') webForm += 1;
    else inboundCall += 1;
  }
  return { webForm, inboundCall };
}

/** The tenant's inbound calls, newest first (so the newest call is a match's evidence). */
export async function loadInboundCalls(db: Db, orgId: string): Promise<InboundCallRow[]> {
  return db
    .select({ id: schema.calls.id, fromNumber: schema.calls.fromNumber, salesforceWhoId: schema.calls.salesforceWhoId, salesforceWhatId: schema.calls.salesforceWhatId })
    .from(schema.calls)
    .where(and(eq(schema.calls.orgId, orgId), eq(schema.calls.direction, 'inbound')))
    .orderBy(desc(schema.calls.createdAt))
    .limit(INBOUND_CALLS_CAP);
}

async function settingsFor(db: Db, orgId: string) {
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId), columns: { settings: true } });
  return outreachSettings({ settings: org?.settings ?? {} });
}

/**
 * Admin-run backfill (Settings → Connections → Consent): every not-yet-consented
 * record of the tenant, against the sources that are switched on. Safe to
 * re-run — recordConsent skips anything already consented.
 */
export async function backfillConsent(deps: { db: Db; orgId: string; now: Date }): Promise<BackfillResult> {
  const settings = await settingsFor(deps.db, deps.orgId);
  if (!settings.consentFromWebForms && !settings.consentFromInboundCalls) return { webForm: 0, inboundCall: 0 };
  const candidates: ConsentCandidate[] = await deps.db
    .select({
      crmRecordId: schema.crmRecords.id, sfObject: schema.crmRecords.sfObject, sfRecordId: schema.crmRecords.sfRecordId,
      phones: schema.crmRecords.phones, webFormSource: schema.crmRecords.webFormSource,
    })
    .from(schema.crmRecords)
    .where(and(eq(schema.crmRecords.orgId, deps.orgId), eq(schema.crmRecords.consentAiCall, false)));
  const calls = settings.consentFromInboundCalls && candidates.length > 0 ? await loadInboundCalls(deps.db, deps.orgId) : [];
  return applyConsentPlan(deps.db, deps.orgId, planConsent(settings, candidates, calls), deps.now);
}

/**
 * The refresh hook (A8's refreshCampaign calls this right after upsertRecords):
 * the same rules, for the records this refresh fetched. `upserted` is
 * upsertRecords' result, keyed by Salesforce record id.
 */
export async function captureConsentOnRefresh(
  db: Db,
  input: { orgId: string; snapshots: readonly SfRecordSnapshot[]; upserted: ReadonlyMap<string, { id: string }>; now: Date },
): Promise<BackfillResult> {
  const settings = await settingsFor(db, input.orgId);
  if (!settings.consentFromWebForms && !settings.consentFromInboundCalls) return { webForm: 0, inboundCall: 0 };
  const candidates: ConsentCandidate[] = input.snapshots.flatMap((s) => {
    const row = input.upserted.get(s.sfRecordId);
    return row && !s.consentAiCall
      ? [{ crmRecordId: row.id, sfObject: s.sfObject, sfRecordId: s.sfRecordId, phones: s.phones, webFormSource: s.webFormSource }]
      : [];
  });
  if (candidates.length === 0) return { webForm: 0, inboundCall: 0 };
  const calls = settings.consentFromInboundCalls ? await loadInboundCalls(db, input.orgId) : [];
  return applyConsentPlan(db, input.orgId, planConsent(settings, candidates, calls), input.now);
}
```

- [ ] **Step 13: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/rules.test.ts src/consent/capture.test.ts src/consent/capture.pg.test.ts && npm -w services/outreach-api run typecheck && npm run test:pg 2>&1 | tail -4; docker rm -f outreach-test-pg >/dev/null 2>&1; true
```

Expected:
- `✓ src/consent/capture.test.ts (9 tests)` and `rules.test.ts (12 tests)`, with `capture.pg.test.ts` skipped. The typecheck exits 0.
- `npm run test:pg` passes, including `✓ src/consent/capture.pg.test.ts (2 tests)`. One test proves a second `recordConsent` writes nothing. The other proves a backfill ticks 1 web-form record and 1 inbound caller, then 0/0 on a re-run.

- [ ] **Step 14: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  services/outreach-api/src/consent/rules.ts \
  services/outreach-api/src/consent/rules.test.ts \
  services/outreach-api/src/consent/capture.ts \
  services/outreach-api/src/consent/capture.test.ts \
  services/outreach-api/src/consent/capture.pg.test.ts
git commit -m "feat(outreach-api): capture AI-call consent from web forms and inbound callers, with backfill"
```

#### Part 4: capture on every campaign refresh

- [ ] **Step 15: Write the failing test**

`services/outreach-api/src/consent/refresh-hook.test.ts`:
```ts
/**
 * The refresh hook is wiring inside A8's refreshCampaign, whose collaborators
 * (Salesforce membership, field fetch, enrollment) are pinned by A8's own
 * tests. What B3 adds is one call in one place, so its text is pinned here:
 * captureConsentOnRefresh runs on exactly the snapshots that were upserted,
 * with upsertRecords' id map, before enrollment.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const refresh = readFileSync(resolve(here, '../campaigns/refresh.ts'), 'utf8');

describe('refreshCampaign → consent capture', () => {
  it('imports the hook', () => {
    expect(refresh).toContain("import { captureConsentOnRefresh } from '../consent/capture.js';");
  });

  it('captures consent on the fetched snapshots, right after they are upserted and before anything is enrolled', () => {
    const fetched = refresh.indexOf('const snapshots = await fetchRecords(');
    const upsert = refresh.indexOf('const upserted = await upsertRecords(db, campaign.orgId, snapshots);');
    const capture = refresh.indexOf('await captureConsentOnRefresh(db, { orgId: campaign.orgId, snapshots, upserted, now });');
    const enroll = refresh.indexOf('await enrollRecords(');
    expect(fetched).toBeGreaterThan(-1);
    expect(upsert).toBeGreaterThan(fetched);
    expect(capture).toBeGreaterThan(upsert);
    expect(enroll).toBeGreaterThan(capture);
  });
});
```

- [ ] **Step 16: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/refresh-hook.test.ts
```

Expected: `Tests  2 failed (2)`: `imports the hook` and `captures consent on the fetched snapshots, …`.

- [ ] **Step 17: Call the hook from `refreshCampaign`**

In `services/outreach-api/src/campaigns/refresh.ts`, add this import directly after `import { SalesforceAuthError, soqlEscape, type SalesforceClient } from '@cti/salesforce';`, so it comes before `../crm/client-factory.js` in path order:

```ts
import { captureConsentOnRefresh } from '../consent/capture.js';
```

In `refreshCampaign`, replace A8's block:

```ts
  if (fetchIds.length > 0) {
    await upsertRecords(db, campaign.orgId, await fetchRecords(client, sfObject, fetchIds, fieldMap[sfObject]));
  }
```

with:

```ts
  if (fetchIds.length > 0) {
    const snapshots = await fetchRecords(client, sfObject, fetchIds, fieldMap[sfObject]);
    const upserted = await upsertRecords(db, campaign.orgId, snapshots);
    // B3: the tenant's switched-on consent sources (web forms, inbound callers)
    // tick consent on the records this refresh fetched.
    await captureConsentOnRefresh(db, { orgId: campaign.orgId, snapshots, upserted, now });
  }
```

A consent failure throws like any other refresh failure, and A8's `refreshDueCampaigns` records it on the campaign. A8's upsert ORs `consent_ai_call`, so a later sync never un-ticks what this wrote.

- [ ] **Step 18: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent src/campaigns && npm -w services/outreach-api run typecheck
```

Expected: `✓ src/consent/refresh-hook.test.ts (2 tests)`, and A8's refresh tests still pass unchanged. The typecheck exits 0.

- [ ] **Step 19: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add services/outreach-api/src/campaigns/refresh.ts services/outreach-api/src/consent/refresh-hook.test.ts
git commit -m "feat(outreach-api): capture consent on the records each campaign refresh fetches"
```

#### Part 5: settings routes

- [ ] **Step 20: Write the failing test**

`services/outreach-api/src/routes/consent.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { registerConsentRoutes } from './consent.js';

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  backfillCalls: [] as Array<{ orgId: string }>,
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
vi.mock('../consent/capture.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../consent/capture.js')>()),
  backfillConsent: async (deps: { orgId: string }) => { state.backfillCalls.push({ orgId: deps.orgId }); return { webForm: 4, inboundCall: 2 }; },
}));

const ADMIN = { userId: '11111111-1111-4111-8111-111111111111', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: { consentFromInboundCalls: true, aiDailyBudgetUsd: 40 } };
const auth = { authorization: 'Bearer t' };
let app: FastifyInstance;
let writes: ReturnType<typeof fakeDb>['writes'];

async function build(updateReturning?: Array<Record<string, unknown>>): Promise<FastifyInstance> {
  const fx = fakeDb({ organizations: [org], updateReturning });
  writes = fx.writes;
  return buildApp({ cfg: testConfig(), readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(a) => registerConsentRoutes(a, { db: fx.db })] });
}

beforeEach(async () => {
  state.session = ADMIN;
  state.backfillCalls = [];
  app = await build();
});
afterEach(async () => { await app.close(); });

describe('consent settings routes', () => {
  it('GET returns the two flags from the tenant settings, defaults filled in', async () => {
    state.session = { ...ADMIN, isAdmin: false };
    const res = await app.inject({ method: 'GET', url: '/api/settings/consent', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ consentFromWebForms: false, consentFromInboundCalls: true });
  });

  it('PUT merges only the consent keys into settings (jsonb ||), stamping who confirmed web forms', async () => {
    await app.close();
    app = await build([{ settings: { consentFromWebForms: true, consentFromInboundCalls: true, aiDailyBudgetUsd: 40 } }]);
    const res = await app.inject({ method: 'PUT', url: '/api/settings/consent', headers: auth, payload: { consentFromWebForms: true, aiDailyBudgetUsd: 9999 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ consentFromWebForms: true, consentFromInboundCalls: true });
    const update = writes.find((w) => w.op === 'update' && w.table === schema.organizations)!;
    const q = new PgDialect().sqlToQuery(update.values.settings as SQL);
    expect(q.sql).toBe('"organizations"."settings" || $1::jsonb');
    const patch = JSON.parse(q.params[0] as string);
    expect(patch).toEqual({ consentFromWebForms: true, consentFromWebFormsConfirmedBy: ADMIN.userId, consentFromWebFormsConfirmedAt: expect.any(String) });
    expect(patch).not.toHaveProperty('aiDailyBudgetUsd');
  });

  it('PUT turning a source off writes just that key', async () => {
    await app.close();
    app = await build([{ settings: { consentFromInboundCalls: false } }]);
    await app.inject({ method: 'PUT', url: '/api/settings/consent', headers: auth, payload: { consentFromInboundCalls: false } });
    const update = writes.find((w) => w.op === 'update')!;
    expect(JSON.parse(new PgDialect().sqlToQuery(update.values.settings as SQL).params[0] as string)).toEqual({ consentFromInboundCalls: false });
  });

  it('PUT and backfill are admin-only; a bad body is 400', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/consent', headers: auth, payload: { consentFromWebForms: 'yes' } });
    expect(bad.statusCode).toBe(400);
    state.session = { ...ADMIN, isAdmin: false };
    expect((await app.inject({ method: 'PUT', url: '/api/settings/consent', headers: auth, payload: { consentFromWebForms: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/settings/consent/backfill', headers: auth })).statusCode).toBe(403);
    expect(state.backfillCalls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("POST backfill runs for the caller's tenant and returns the counts", async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/consent/backfill', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ webForm: 4, inboundCall: 2 });
    expect(state.backfillCalls).toEqual([{ orgId: 'O1' }]);
  });
});

describe('server wiring', () => {
  it('server.ts registers the consent routes under /api', () => {
    const server = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../server.ts'), 'utf8');
    expect(server).toContain("import { registerConsentRoutes } from './routes/consent.js';");
    expect(server).toContain('(scope) => registerConsentRoutes(scope, { db }),');
  });
});
```

- [ ] **Step 21: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/routes/consent.test.ts
```

Expected: `FAIL src/routes/consent.test.ts`, with `Error: Failed to load url ./consent.js (resolved id: ./consent.js) in …/routes/consent.test.ts. Does the file exist?`.

- [ ] **Step 22: Write the routes and register them**

`services/outreach-api/src/routes/consent.ts`:
```ts
/**
 * Consent settings (spec §11.1), under /api:
 *   GET  /settings/consent           → ConsentSettings (any member)
 *   PUT  /settings/consent           → ConsentSettings (admin; ConsentSettingsUpdate)
 *   POST /settings/consent/backfill  → BackfillResult (admin)
 */
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ConsentSettingsUpdate, type ConsentSettings } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { backfillConsent } from '../consent/capture.js';
import { sendError } from '../http/errors.js';
import { outreachSettings } from '../settings.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';

function toConsentSettings(settings: unknown): ConsentSettings {
  const s = outreachSettings({ settings });
  return { consentFromWebForms: s.consentFromWebForms, consentFromInboundCalls: s.consentFromInboundCalls };
}

export async function registerConsentRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  app.get('/settings/consent', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    return toConsentSettings(ctx.tenant.settings);
  });

  app.put('/settings/consent', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const body = ConsentSettingsUpdate.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid consent settings', body.error.flatten());
    // Switching web forms on IS the admin's confirmation that the forms carry
    // consent language (spec §11.1) — record who confirmed it, and when.
    const patch: Record<string, unknown> = body.data.consentFromWebForms === true
      ? { ...body.data, consentFromWebFormsConfirmedBy: ctx.session.userId, consentFromWebFormsConfirmedAt: new Date().toISOString() }
      : { ...body.data };
    // A jsonb merge in SQL, so a concurrent write to another settings key is never lost.
    const [row] = await db
      .update(schema.organizations)
      .set({ settings: sql`${schema.organizations.settings} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(schema.organizations.id, ctx.orgId))
      .returning({ settings: schema.organizations.settings });
    if (!row) return sendError(reply, 404, 'TENANT_NOT_FOUND', 'This tenant no longer exists');
    return toConsentSettings(row.settings);
  });

  app.post('/settings/consent/backfill', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    return backfillConsent({ db, orgId: ctx.orgId, now: new Date() });
  });
}
```

In `services/outreach-api/src/server.ts`, add `import { registerConsentRoutes } from './routes/consent.js';` among the `./routes/…` imports in path order (directly after A5's `./routes/connections.js`). Then add this as the last entry of `apiRoutes`:

```ts
      (scope) => registerConsentRoutes(scope, { db }),
```

- [ ] **Step 23: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/routes/consent.test.ts && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test 2>&1 | tail -4
```

Expected: `✓ src/routes/consent.test.ts (6 tests)`. The typecheck exits 0. The full suite passes, with the real-Postgres files skipped.

- [ ] **Step 24: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add services/outreach-api/src/routes/consent.ts services/outreach-api/src/routes/consent.test.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): add consent settings and backfill routes"
```

#### Part 6: the Consent card

- [ ] **Step 25: Write the failing test**

`apps/outreach-web/src/components/consent-card.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { connection } from '../test/outreach-fixtures';
import { stubApi } from '../test/stub-api';
import { ConnectionsPage } from './connections-page';
import { ConsentCard, WEB_FORM_CONFIRMATION } from './consent-card';

afterEach(() => vi.unstubAllGlobals());

const OFF = { consentFromWebForms: false, consentFromInboundCalls: false };

describe('ConsentCard', () => {
  it('shows both sources; a member sees them read-only and no Backfill', async () => {
    stubApi({ 'GET /api/settings/consent': { consentFromWebForms: true, consentFromInboundCalls: false } });
    renderWithProviders(<ConsentCard canEdit={false} />);
    const web = await screen.findByRole('checkbox', { name: 'Count web-form leads as consented' });
    expect(web).toBeChecked();
    expect(web).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Count people who have called us as consented' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Backfill consent' })).not.toBeInTheDocument();
  });

  it('turning web forms on asks for the confirmation first, and saves only on Confirm', async () => {
    const calls = stubApi({
      'GET /api/settings/consent': OFF,
      'PUT /api/settings/consent': { consentFromWebForms: true, consentFromInboundCalls: false },
    });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Count web-form leads as consented' }));
    expect(screen.getByText(WEB_FORM_CONFIRMATION)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ consentFromWebForms: true }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Count web-form leads as consented' })).toBeChecked());
    expect(screen.queryByText(WEB_FORM_CONFIRMATION)).not.toBeInTheDocument();
  });

  it('Cancel leaves web forms off and saves nothing', async () => {
    const calls = stubApi({ 'GET /api/settings/consent': OFF });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Count web-form leads as consented' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('checkbox', { name: 'Count web-form leads as consented' })).not.toBeChecked();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('the inbound-calls source saves straight away', async () => {
    const calls = stubApi({
      'GET /api/settings/consent': OFF,
      'PUT /api/settings/consent': { consentFromWebForms: false, consentFromInboundCalls: true },
    });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Count people who have called us as consented' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ consentFromInboundCalls: true }));
  });

  it('Backfill is disabled while no source is on', async () => {
    stubApi({ 'GET /api/settings/consent': OFF });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Backfill consent' })).toBeDisabled();
    expect(screen.getByText('Turn on a source to backfill.')).toBeInTheDocument();
  });

  it('Backfill reports what it ticked', async () => {
    const calls = stubApi({
      'GET /api/settings/consent': { consentFromWebForms: true, consentFromInboundCalls: true },
      'POST /api/settings/consent/backfill': { webForm: 3, inboundCall: 1 },
    });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Backfill consent' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Ticked 3 records from web forms and 1 record from inbound calls.');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/settings/consent/backfill']);
  });
});

describe('ConnectionsPage → Consent card', () => {
  it('appears once Salesforce is connected', async () => {
    stubApi({ 'GET /api/connections/salesforce': connection(), 'GET /api/settings/consent': OFF });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    expect(await screen.findByRole('checkbox', { name: 'Count web-form leads as consented' })).toBeInTheDocument();
  });

  it('is absent while Salesforce is not connected', async () => {
    const calls = stubApi({ 'GET /api/connections/salesforce': connection({ connected: false, status: null, fieldMap: null }) });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    await screen.findByRole('button', { name: 'Connect Salesforce' });
    expect(screen.queryByRole('checkbox', { name: 'Count web-form leads as consented' })).not.toBeInTheDocument();
    expect(calls.map((c) => c.url)).not.toContain('/api/settings/consent');
  });
});
```

- [ ] **Step 26: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test -- src/components/consent-card.test.tsx
```

Expected: `FAIL`, with `Error: Failed to resolve import "./consent-card" from "src/components/consent-card.test.tsx". Does the file exist?`.

- [ ] **Step 27: Add the API calls**

In `apps/outreach-web/src/lib/outreach-api.ts`:
1. Add `BackfillResult,` and `ConsentSettings,` to the value imports from `@cti/contracts`, and `type ConsentSettingsUpdate,` to the type imports, each in alphabetical order. The import list then begins `BackfillResult, Campaign, …, CampaignsResponse, ConsentSettings, CrmConnectionStatus, …`, and its types include `type CampaignStatusChange, type ConsentSettingsUpdate, type CreateCampaignRequest, …`.
2. Add this as the last key of `outreachKeys`:

```ts
  consent: ['settings', 'consent'] as const,
```

3. Append at the end of the file:

```ts

export function getConsentSettings(): Promise<ConsentSettings> {
  return api('/api/settings/consent', ConsentSettings);
}

export function saveConsentSettings(update: ConsentSettingsUpdate): Promise<ConsentSettings> {
  return api('/api/settings/consent', ConsentSettings, { method: 'PUT', body: json(update) });
}

export function backfillConsent(): Promise<BackfillResult> {
  return api('/api/settings/consent/backfill', BackfillResult, { method: 'POST' });
}
```

- [ ] **Step 28: Write the card and put it on the Connections page**

`apps/outreach-web/src/components/consent-card.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { backfillConsent, getConsentSettings, outreachKeys, saveConsentSettings } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

/** The sentence an admin confirms before web-form leads count as consented (spec §11.1). */
export const WEB_FORM_CONFIRMATION = 'Our forms carry consent language for calls and texts.';

const records = (n: number): string => `${n} record${n === 1 ? '' : 's'}`;

/**
 * Settings → Connections → Consent: which sources tick a record's AI Call
 * Consent, and a backfill over the records already synced. Turning web forms
 * on asks for the confirmation sentence first; nothing is saved until Confirm.
 */
export function ConsentCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: outreachKeys.consent, queryFn: getConsentSettings });
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: saveConsentSettings,
    onSuccess: (next) => {
      setConfirming(false);
      qc.setQueryData(outreachKeys.consent, next);
    },
  });
  const backfill = useMutation({ mutationFn: backfillConsent });
  const s = settings.data;
  const anySource = Boolean(s && (s.consentFromWebForms || s.consentFromInboundCalls));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Consent</CardTitle>
        <CardDescription>
          Which sources tick AI Call Consent on a record. Consent is recorded with its evidence and written to Salesforce.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {settings.error && <p role="alert" className="text-sm text-destructive">{errorText(settings.error)}</p>}
        {s && (
          <>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={s.consentFromWebForms}
                  disabled={!canEdit || save.isPending}
                  onChange={(e) => (e.target.checked ? setConfirming(true) : save.mutate({ consentFromWebForms: false }))}
                />
                Count web-form leads as consented
              </label>
              {confirming && (
                <div role="group" aria-label="Confirm web form consent" className="space-y-2 rounded-md border p-3">
                  <p className="text-sm">{WEB_FORM_CONFIRMATION}</p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ consentFromWebForms: true })}>Confirm</Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.consentFromInboundCalls}
                disabled={!canEdit || save.isPending}
                onChange={(e) => save.mutate({ consentFromInboundCalls: e.target.checked })}
              />
              Count people who have called us as consented
            </label>
            {save.error && <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p>}
            {canEdit && (
              <div className="space-y-2">
                <Button variant="outline" disabled={!anySource || backfill.isPending} onClick={() => backfill.mutate()}>
                  Backfill consent
                </Button>
                {!anySource && <p className="text-sm text-muted-foreground">Turn on a source to backfill.</p>}
                {backfill.data && (
                  <p role="status" className="text-sm">
                    Ticked {records(backfill.data.webForm)} from web forms and {records(backfill.data.inboundCall)} from inbound calls.
                  </p>
                )}
                {backfill.error && <p role="alert" className="text-sm text-destructive">{errorText(backfill.error)}</p>}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

In `apps/outreach-web/src/components/connections-page.tsx`, add `import { ConsentCard } from './consent-card';` directly after `import { ConfirmAction } from './confirm-action';`. Directly after the `{data?.fieldMap && (…) && (<FieldMapEditor … />)}` block, inside the page's outer `<div>`, add:

```tsx
      {data?.connected && <ConsentCard canEdit={isAdmin} />}
```

- [ ] **Step 29: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test && npm -w apps/outreach-web run typecheck
```

Expected: `✓ src/components/consent-card.test.tsx (8 tests)`, and A12's `connections-page.test.tsx` still passes unchanged. The whole web suite passes, and the typecheck exits 0.

- [ ] **Step 30: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  apps/outreach-web/src/lib/outreach-api.ts \
  apps/outreach-web/src/components/consent-card.tsx \
  apps/outreach-web/src/components/consent-card.test.tsx \
  apps/outreach-web/src/components/connections-page.tsx
git commit -m "feat(outreach-web): add the Consent card to the Connections settings page"
```

---

### Task B4: Campaign calls in the CTI dialer (claim, build, release)

A rep's **Campaign calls** picker (B6) lists the org's `active` campaigns that have queued `rep_call` touches due now (`GET /dialer/campaigns`). Starting one (`POST /dialer/sessions/from-campaign`) works like this:
1. Claim up to one run's worth (500) of that campaign's due touches, `queued` → `dialing`, in one statement with `FOR UPDATE … SKIP LOCKED`. Two reps pressing at once get disjoint touches.
2. Build a normal READY power-dial run over their records with the rep's own Salesforce token. `createDialerSession` stores the campaign on `dialer_sessions.campaign_id`, and every dialer gate applies unchanged.
3. Link the touches to the run.

The claim commits before the build, so no row lock is held across Salesforce HTTP. If the build or the link fails, the claim is released and the route answers 502.

**Where the claim lives, and how concurrency is proven.** The claim SQL is in `@cti/db` (`packages/db/src/campaign-calls.ts`), and cti-api re-exports it, so one definition serves cti-api and outreach-api. cti-api has no real-Postgres lane. The cleanest real-PG option is outreach-api's existing A3 lane (`createTestDb`, `npm run test:pg`), which already runs every outreach-api `*.pg.test.ts` against a throwaway database with all migrations applied. One test file there fires eight concurrent `limit: 1` claims through a 10-connection pool and asserts they return the five due touches exactly once. cti-api itself gets rendered-SQL assertions and route tests over a fake `execute`.

**Files:**
- Create: `packages/db/src/campaign-calls.ts`; Test: `packages/db/src/campaign-calls.test.ts`
- Modify: `packages/db/src/index.ts`: add `export * from './campaign-calls.js';` after `export { loadMigrationFiles } from './migration-files.js';` (A3)
- Create: `packages/contracts/src/campaign-calls.ts`; Test: `packages/contracts/src/campaign-calls.test.ts`
- Modify: `packages/contracts/src/index.ts`: add `export * from './campaign-calls.js';` as the first line (alphabetical)
- Test: `services/outreach-api/src/campaigns/campaign-calls.pg.test.ts`
- Create: `services/cti-api/src/dialer/campaign-calls.ts`; Test: `services/cti-api/src/dialer/campaign-calls.test.ts`
- Modify: `services/cti-api/src/dialer/create-session.ts`: the `createDialerSession` args (lines 360–363) and the session insert (lines 394–398)
- Modify: `services/cti-api/src/dialer/create-session.test.ts`: two tests appended inside `describe('createDialerSession — nothing dials at creation'`, which closes at line 168
- Modify: `services/cti-api/src/routes/dialer.ts`: the header comment (line 4), the imports (lines 31 and 37), and two handlers inserted after the `/dialer/sessions` handler (after line 395)
- Test: `services/cti-api/src/routes/dialer-campaigns.test.ts`

**Interfaces:**
- Consumes:
  - **A3:**
    - Tables `touches` (`channel`, `status`, `due_at`, `claimed_at`, `dialer_session_id`, `enrollment_id`, `org_id`), `campaign_enrollments` (`status`, `campaign_id`, `crm_record_id`), `campaigns` (`status`, `org_id`, `name`, `sf_object`) and `crm_records` (`sf_record_id`, `sf_object`).
    - The `dialer_sessions.campaign_id` column, as Drizzle `campaignId`.
    - `createTestDb`/`pgLane`, and `npm run test:pg`.
  - **A4:** `SfObject`.
  - **A10:** `active` campaigns' due `rep_call` touches are `queued`.
  - **Existing cti-api:** `createDialerSession(deps, args)` and its deps (`resolveDialNumber`, `fetchTasks`, `fetchContactNames`, `salesforceUserId`, `workedRecentlySafe`, `blockedTargetsSafe`, `preferredNumbersFor`, `listRunStart`), `requirePowerDialer`, `resolveSession`, `getDb`, and `MAX_RUN_RECORDS` (500).
- Produces:
  ```ts
  // @cti/db (packages/db/src/campaign-calls.ts)
  export type SqlExecutor = Pick<Db, 'execute'>;
  export interface DueCampaignCallRow { id: string; name: string; sfObject: 'Lead' | 'Opportunity'; due: number }
  export interface ClaimedCampaignTouch { touchId: string; sfRecordId: string; sfObject: 'Lead' | 'Opportunity' }
  export function dueCampaignCallsSql(orgId: string, now: Date): SQL;
  export function dueCampaignCallRows(db: SqlExecutor, orgId: string, now: Date): Promise<DueCampaignCallRow[]>;
  export function claimCampaignTouchesSql(args: { orgId: string; campaignId: string; now: Date; limit: number }): SQL;
  export function claimCampaignTouches(db: SqlExecutor, args: { orgId: string; campaignId: string; now: Date; limit: number }): Promise<ClaimedCampaignTouch[]>;   // earliest due first
  export function attachSessionSql(touchIds: readonly string[], sessionId: string): SQL;
  export function attachSession(db: SqlExecutor, touchIds: readonly string[], sessionId: string): Promise<void>;   // only touches still 'dialing'
  export function releaseTouchesSql(touchIds: readonly string[]): SQL;
  export function releaseTouches(db: SqlExecutor, touchIds: readonly string[]): Promise<void>;   // 'dialing' → 'queued', session and claim cleared
  // @cti/contracts (packages/contracts/src/campaign-calls.ts)
  export const CampaignCallsResponse = z.object({ campaigns: z.array(z.object({ id: z.string().uuid(), name: z.string(), sfObject: SfObject, due: z.number().int().nonnegative() })) });
  export const StartCampaignCallsRequest = z.object({ campaignId: z.string().uuid() });
  export const StartCampaignCallsResponse = z.object({ sessionId: z.string().uuid(), total: z.number().int().nonnegative() });
  // services/cti-api/src/dialer/campaign-calls.ts
  export { attachSession, claimCampaignTouches, releaseTouches } from '@cti/db';
  export const CAMPAIGN_CALL_BATCH = MAX_RUN_RECORDS;   // 500
  export function dueCampaignCalls(db: SqlExecutor, orgId: string, now: Date): Promise<CampaignCallsResponse>;
  export type StartCampaignCallsResult = { kind: 'started'; sessionId: string; total: number } | { kind: 'nothing_due' } | { kind: 'build_failed'; error: string };
  export interface StartCampaignCallsDeps { db: SqlExecutor; now: Date; build: (args: { objectType: 'Lead' | 'Opportunity'; recordIds: string[]; campaignId: string }) => Promise<{ sessionId: string; total: number }> }
  export function startCampaignCalls(deps: StartCampaignCallsDeps, args: { orgId: string; campaignId: string }): Promise<StartCampaignCallsResult>;
  // services/cti-api/src/dialer/create-session.ts
  createDialerSession(deps, args: { userId; orgId; objectType; recordIds; listViewId?; campaignId?: string })   // stored on dialer_sessions.campaign_id
  ```
  Routes (cti-api, both behind `requirePowerDialer`, with errors as `{ error }`):
  - `GET /dialer/campaigns` → `CampaignCallsResponse`. 401 without a session; 403 without the grant.
  - `POST /dialer/sessions/from-campaign` (`StartCampaignCallsRequest`) → `StartCampaignCallsResponse`.
    - 400 on a bad body.
    - 404 `No campaign calls are due right now.`
    - 502 `Could not build the call list from Salesforce — is the rep signed in? Try again.`, with the claim released.

#### Part 1: the shared claim in `@cti/db`

- [ ] **Step 1: Write the failing tests**

`packages/db/src/campaign-calls.test.ts` renders each statement with Drizzle's `PgDialect` and asserts on the SQL:
```ts
/**
 * Pins the campaign-call SQL as Postgres receives it. Rendered, not faked:
 * drop the org filter and one tenant's rep dials another tenant's people; drop
 * `c.status = 'active'` and a paused or dry-run campaign places real calls;
 * drop SKIP LOCKED and two reps get the same person. The concurrency itself is
 * proven on real Postgres in services/outreach-api/src/campaigns/campaign-calls.pg.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  attachSession, attachSessionSql, claimCampaignTouches, claimCampaignTouchesSql, dueCampaignCallRows, dueCampaignCallsSql,
  releaseTouches, releaseTouchesSql,
} from './campaign-calls.js';

const dialect = new PgDialect();
const flat = (q: SQL) => { const r = dialect.sqlToQuery(q); return { sql: r.sql.replace(/\s+/g, ' ').trim(), params: r.params }; };
const NOW = new Date('2026-10-05T15:00:00.000Z');
const ARGS = { orgId: 'org-1', campaignId: 'camp-1', now: NOW, limit: 500 };

describe('claimCampaignTouchesSql', () => {
  const q = flat(claimCampaignTouchesSql(ARGS));

  it("is scoped to the caller's org on both the touch and the campaign, and to the one campaign asked for", () => {
    expect(q.sql).toContain('where t.org_id = $1 and c.org_id = $2 and c.id = $3');
    expect(q.params.slice(0, 3)).toEqual(['org-1', 'org-1', 'camp-1']);
  });

  it('takes only due, queued rep calls of ACTIVE enrollments in an ACTIVE campaign', () => {
    expect(q.sql).toContain("and c.status = 'active' and e.status = 'active' and t.channel = 'rep_call' and t.status = 'queued' and t.due_at <= $4");
    expect(q.params[3]).toBe(NOW);
  });

  it('locks only the touch rows it picks, skipping rows another claimer holds, inside a CTE so the limit holds', () => {
    expect(q.sql).toMatch(/^with picked as \( select t\.id from touches t/);
    expect(q.sql).toContain('order by t.due_at, t.id limit $5 for update of t skip locked )');
    expect(q.params[4]).toBe(500);
  });

  it('flips them to dialing with the claim time and returns what the dialer needs', () => {
    expect(q.sql).toContain("update touches t set status = 'dialing', claimed_at = $6, updated_at = $7 from picked, campaign_enrollments e, crm_records r where t.id = picked.id");
    expect(q.sql).toMatch(/returning t\.id as touch_id, t\.due_at, r\.sf_record_id, r\.sf_object$/);
  });
});

describe('claimCampaignTouches', () => {
  it('maps and orders the claimed rows by due time', async () => {
    const execute = vi.fn(async () => ({ rows: [
      { touch_id: 'T2', due_at: '2026-10-05T14:00:00.000Z', sf_record_id: '00Q2', sf_object: 'Lead' },
      { touch_id: 'T1', due_at: '2026-10-05T13:00:00.000Z', sf_record_id: '00Q1', sf_object: 'Lead' },
    ] }));
    expect(await claimCampaignTouches({ execute } as never, ARGS)).toEqual([
      { touchId: 'T1', sfRecordId: '00Q1', sfObject: 'Lead' },
      { touchId: 'T2', sfRecordId: '00Q2', sfObject: 'Lead' },
    ]);
  });
});

describe('dueCampaignCallsSql', () => {
  it('counts due queued rep calls per active campaign of the org', () => {
    const q = flat(dueCampaignCallsSql('org-1', NOW));
    expect(q.sql).toContain('select c.id, c.name, c.sf_object, count(*)::int as due');
    expect(q.sql).toContain("where t.org_id = $1 and c.org_id = $2 and c.status = 'active' and e.status = 'active' and t.channel = 'rep_call' and t.status = 'queued' and t.due_at <= $3");
    expect(q.sql).toContain('group by c.id, c.name, c.sf_object order by c.name, c.id');
    expect(q.params).toEqual(['org-1', 'org-1', NOW]);
  });

  it('dueCampaignCallRows maps snake_case to the contract shape', async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: 'C1', name: 'Spring', sf_object: 'Opportunity', due: 7 }] }));
    expect(await dueCampaignCallRows({ execute } as never, 'org-1', NOW)).toEqual([{ id: 'C1', name: 'Spring', sfObject: 'Opportunity', due: 7 }]);
  });
});

describe('attachSession / releaseTouches', () => {
  it('attach links only touches still dialing', () => {
    const q = flat(attachSessionSql(['T1', 'T2'], 'S1'));
    expect(q.sql).toBe("update touches set dialer_session_id = $1, updated_at = now() where id in ($2, $3) and status = 'dialing'");
    expect(q.params).toEqual(['S1', 'T1', 'T2']);
  });

  it('release puts dialing touches back in the queue with no session and no claim', () => {
    const q = flat(releaseTouchesSql(['T1']));
    expect(q.sql).toBe("update touches set status = 'queued', dialer_session_id = null, claimed_at = null, updated_at = now() where id in ($1) and status = 'dialing'");
  });

  it('an empty id list touches nothing (no "in ()" ever reaches Postgres)', async () => {
    const execute = vi.fn();
    await attachSession({ execute } as never, [], 'S1');
    await releaseTouches({ execute } as never, []);
    expect(execute).not.toHaveBeenCalled();
  });
});
```

`services/outreach-api/src/campaigns/campaign-calls.pg.test.ts` is the real-Postgres concurrency proof:
```ts
/**
 * Real-Postgres lane (A3) for the campaign-call claim that cti-api runs
 * (@cti/db campaign-calls.ts). cti-api has no database lane of its own; the
 * claim is one shared definition, so it is proven here, once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { attachSession, claimCampaignTouches, dueCampaignCallRows, releaseTouches, schema, type Db } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';

describe.skipIf(!pgLane)('campaign call claims against real Postgres', () => {
  let t: TestDb;
  let db: Db;
  const now = new Date('2026-10-05T15:00:00.000Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  async function org(slug: string): Promise<string> {
    const [o] = await db.insert(schema.organizations).values({ name: slug, slug: `${slug}-${Date.now()}` }).returning();
    return o!.id;
  }
  async function campaign(orgId: string, name: string, status: 'active' | 'paused' | 'dry_run'): Promise<string> {
    const [c] = await db.insert(schema.campaigns).values({ orgId, name, sfObject: 'Lead', sourceKind: 'soql', soql: 'SELECT Id FROM Lead', status }).returning();
    return c!.id;
  }
  /** One record + enrollment + touch per call. */
  async function touch(orgId: string, campaignId: string, over: { status?: 'queued' | 'planned'; channel?: 'rep_call' | 'sms'; dueAt?: Date } = {}): Promise<string> {
    const [r] = await db.insert(schema.crmRecords).values({ orgId, sfObject: 'Lead', sfRecordId: `00Q${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}AAA` }).returning();
    const [e] = await db.insert(schema.campaignEnrollments).values({ orgId, campaignId, crmRecordId: r!.id }).returning();
    const [x] = await db.insert(schema.touches).values({
      orgId, enrollmentId: e!.id, seq: 1, channel: over.channel ?? 'rep_call', status: over.status ?? 'queued', dueAt: over.dueAt ?? minutesAgo(5),
    }).returning();
    return x!.id;
  }

  let orgA: string;
  let orgB: string;
  let active: string;
  let paused: string;
  let foreign: string;
  let due: string[];

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    orgA = await org('a');
    orgB = await org('b');
    active = await campaign(orgA, 'Spring sellers', 'active');
    paused = await campaign(orgA, 'Paused', 'paused');
    foreign = await campaign(orgB, 'Other tenant', 'active');
    due = [];
    for (let i = 0; i < 5; i++) due.push(await touch(orgA, active, { dueAt: minutesAgo(10 + i) }));
    await touch(orgA, active, { status: 'planned' });
    await touch(orgA, active, { dueAt: new Date(now.getTime() + 60 * 60_000) });
    await touch(orgA, active, { channel: 'sms' });
    await touch(orgA, paused);
    await touch(orgB, foreign);
  }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('lists only active campaigns of the org with due queued rep calls, with the count', async () => {
    expect(await dueCampaignCallRows(db, orgA, now)).toEqual([{ id: active, name: 'Spring sellers', sfObject: 'Lead', due: 5 }]);
  });

  it('never claims from a paused campaign or from another tenant', async () => {
    expect(await claimCampaignTouches(db, { orgId: orgA, campaignId: paused, now, limit: 500 })).toEqual([]);
    expect(await claimCampaignTouches(db, { orgId: orgA, campaignId: foreign, now, limit: 500 })).toEqual([]);
  });

  it('eight concurrent claims never return the same touch, and together take exactly the five due ones', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimCampaignTouches(db, { orgId: orgA, campaignId: active, now, limit: 1 })));
    const claimed = results.flat().map((c) => c.touchId);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual([...due].sort());
    const rows = await db.select().from(schema.touches).where(inArray(schema.touches.id, due));
    expect(rows.every((r) => r.status === 'dialing' && r.claimedAt?.getTime() === now.getTime())).toBe(true);
  });

  it('attach stamps the session; release puts the touches back in the queue', async () => {
    const sessionId = '6f1c7a4e-0000-4000-8000-000000000001';
    await attachSession(db, due.slice(0, 2), sessionId);
    const [attached] = await db.select().from(schema.touches).where(eq(schema.touches.id, due[0]!));
    expect(attached!.dialerSessionId).toBe(sessionId);
    await releaseTouches(db, due);
    const rows = await db.select().from(schema.touches).where(inArray(schema.touches.id, due));
    expect(rows.map((r) => [r.status, r.dialerSessionId, r.claimedAt])).toEqual(due.map(() => ['queued', null, null]));
    expect(await dueCampaignCallRows(db, orgA, now)).toEqual([{ id: active, name: 'Spring sellers', sfObject: 'Lead', due: 5 }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/db run test -- src/campaign-calls.test.ts
```

Expected: `FAIL src/campaign-calls.test.ts`, with `Error: Failed to load url ./campaign-calls.js (resolved id: ./campaign-calls.js) in …/campaign-calls.test.ts. Does the file exist?`.

- [ ] **Step 3: Write the claim module**

`packages/db/src/campaign-calls.ts`:
```ts
/**
 * Campaign rep calls (outreach spec §10.1): the claim protocol on `touches`
 * between outreach-api (which queues `rep_call` touches) and the CTI dialer
 * (which claims them into a power-dial run). It lives here, in the package
 * both services share, so there is ONE definition of the claim: cti-api's
 * routes use it (services/cti-api/src/dialer/campaign-calls.ts), and
 * outreach-api's real-Postgres lane proves two concurrent claims never take the
 * same touch (services/outreach-api/src/campaigns/campaign-calls.pg.test.ts).
 *
 * Every statement is built by a `*Sql` function so a unit test can render it —
 * each predicate here is a safety property (tenant, campaign state, due-ness),
 * and a fake database would let any of them go missing unnoticed.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './index.js';

/** Only what these functions use, so a caller can pass a transaction or a test double. */
export type SqlExecutor = Pick<Db, 'execute'>;

export interface DueCampaignCallRow {
  id: string;
  name: string;
  sfObject: 'Lead' | 'Opportunity';
  due: number;
}

export interface ClaimedCampaignTouch {
  touchId: string;
  sfRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

const idList = (ids: readonly string[]): SQL => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/** The org's `active` campaigns with queued rep calls due now, and how many. */
export function dueCampaignCallsSql(orgId: string, now: Date): SQL {
  return sql`
    select c.id, c.name, c.sf_object, count(*)::int as due
      from touches t
      join campaign_enrollments e on e.id = t.enrollment_id
      join campaigns c on c.id = e.campaign_id
     where t.org_id = ${orgId}
       and c.org_id = ${orgId}
       and c.status = 'active'
       and e.status = 'active'
       and t.channel = 'rep_call'
       and t.status = 'queued'
       and t.due_at <= ${now}
     group by c.id, c.name, c.sf_object
     order by c.name, c.id`;
}

export async function dueCampaignCallRows(db: SqlExecutor, orgId: string, now: Date): Promise<DueCampaignCallRow[]> {
  const rows = rowsOf<{ id: string; name: string; sf_object: 'Lead' | 'Opportunity'; due: number }>(await db.execute(dueCampaignCallsSql(orgId, now)));
  return rows.map((r) => ({ id: r.id, name: r.name, sfObject: r.sf_object, due: r.due }));
}

/**
 * Claim up to `limit` due rep-call touches of ONE active campaign of the
 * caller's org: `queued` → `dialing`, in one statement.
 *
 * - The pick and the write are one statement, and the pick takes row locks
 *   with SKIP LOCKED, so two reps pressing "Dial campaign calls" at once get
 *   disjoint touches instead of waiting or double-dialing.
 * - `for update OF t`: lock only the touch rows. A bare FOR UPDATE would also
 *   lock the joined campaign row, and with SKIP LOCKED the second claimer
 *   would then skip EVERY touch of that campaign and get nothing.
 * - A CTE, not `where id in (select … limit n for update skip locked)`: the
 *   planner may re-run an IN-subquery per outer row and hand back more than n;
 *   a locking CTE is materialized once (same reasoning as cti-api's
 *   fleet/auto-assign-live.ts).
 */
export function claimCampaignTouchesSql(args: { orgId: string; campaignId: string; now: Date; limit: number }): SQL {
  return sql`
    with picked as (
      select t.id
        from touches t
        join campaign_enrollments e on e.id = t.enrollment_id
        join campaigns c on c.id = e.campaign_id
       where t.org_id = ${args.orgId}
         and c.org_id = ${args.orgId}
         and c.id = ${args.campaignId}
         and c.status = 'active'
         and e.status = 'active'
         and t.channel = 'rep_call'
         and t.status = 'queued'
         and t.due_at <= ${args.now}
       order by t.due_at, t.id
       limit ${args.limit}
         for update of t skip locked
    )
    update touches t
       set status = 'dialing',
           claimed_at = ${args.now},
           updated_at = ${args.now}
      from picked, campaign_enrollments e, crm_records r
     where t.id = picked.id
       and e.id = t.enrollment_id
       and r.id = e.crm_record_id
    returning t.id as touch_id, t.due_at, r.sf_record_id, r.sf_object`;
}

/** Claimed touches, earliest due first (RETURNING order is not guaranteed, so it is sorted here). */
export async function claimCampaignTouches(
  db: SqlExecutor,
  args: { orgId: string; campaignId: string; now: Date; limit: number },
): Promise<ClaimedCampaignTouch[]> {
  const rows = rowsOf<{ touch_id: string; due_at: Date | string; sf_record_id: string; sf_object: 'Lead' | 'Opportunity' }>(
    await db.execute(claimCampaignTouchesSql(args)),
  );
  return [...rows]
    .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime() || a.touch_id.localeCompare(b.touch_id))
    .map((r) => ({ touchId: r.touch_id, sfRecordId: r.sf_record_id, sfObject: r.sf_object }));
}

/** Link claimed touches to the run they went into (only touches still `dialing`). */
export function attachSessionSql(touchIds: readonly string[], sessionId: string): SQL {
  return sql`
    update touches
       set dialer_session_id = ${sessionId}, updated_at = now()
     where id in (${idList(touchIds)})
       and status = 'dialing'`;
}

export async function attachSession(db: SqlExecutor, touchIds: readonly string[], sessionId: string): Promise<void> {
  if (touchIds.length === 0) return;
  await db.execute(attachSessionSql(touchIds, sessionId));
}

/** Give claimed touches back (`dialing` → `queued`, no session, no claim) — e.g. when the run could not be built. */
export function releaseTouchesSql(touchIds: readonly string[]): SQL {
  return sql`
    update touches
       set status = 'queued', dialer_session_id = null, claimed_at = null, updated_at = now()
     where id in (${idList(touchIds)})
       and status = 'dialing'`;
}

export async function releaseTouches(db: SqlExecutor, touchIds: readonly string[]): Promise<void> {
  if (touchIds.length === 0) return;
  await db.execute(releaseTouchesSql(touchIds));
}
```

In `packages/db/src/index.ts`, add after `export { loadMigrationFiles } from './migration-files.js';`:

```ts
export * from './campaign-calls.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/db run test && npm run build:packages && npm run test:pg 2>&1 | tail -4; docker rm -f outreach-test-pg >/dev/null 2>&1; true
```

Expected:
- `✓ src/campaign-calls.test.ts (10 tests)`, and the whole db suite passes.
- `build:packages` exits 0.
- `npm run test:pg` passes, including `✓ src/campaigns/campaign-calls.pg.test.ts (4 tests)`. Those tests cover: the due list; no claim from a paused or foreign campaign; eight concurrent claims taking the five due touches exactly once; attach and release.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add packages/db/src/campaign-calls.ts packages/db/src/campaign-calls.test.ts packages/db/src/index.ts services/outreach-api/src/campaigns/campaign-calls.pg.test.ts
git commit -m "feat(db): add the campaign-call claim (FOR UPDATE SKIP LOCKED), attach and release"
```

#### Part 2: contracts

- [ ] **Step 6: Write the failing test**

`packages/contracts/src/campaign-calls.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CampaignCallsResponse, StartCampaignCallsRequest, StartCampaignCallsResponse } from './index.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('campaign-call contracts', () => {
  it('CampaignCallsResponse: uuid, name, Lead/Opportunity, a non-negative due count', () => {
    expect(CampaignCallsResponse.safeParse({ campaigns: [{ id: ID, name: 'Spring', sfObject: 'Lead', due: 3 }] }).success).toBe(true);
    expect(CampaignCallsResponse.safeParse({ campaigns: [{ id: ID, name: 'Spring', sfObject: 'Account', due: 3 }] }).success).toBe(false);
    expect(CampaignCallsResponse.safeParse({ campaigns: [{ id: 'nope', name: 'Spring', sfObject: 'Lead', due: 3 }] }).success).toBe(false);
  });
  it('StartCampaignCallsRequest needs a campaign uuid', () => {
    expect(StartCampaignCallsRequest.safeParse({ campaignId: ID }).success).toBe(true);
    expect(StartCampaignCallsRequest.safeParse({ campaignId: '006000000000001' }).success).toBe(false);
    expect(StartCampaignCallsRequest.safeParse({}).success).toBe(false);
  });
  it('StartCampaignCallsResponse is the run id and its size', () => {
    expect(StartCampaignCallsResponse.parse({ sessionId: ID, total: 12 })).toEqual({ sessionId: ID, total: 12 });
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test -- src/campaign-calls.test.ts
```

Expected: `FAIL src/campaign-calls.test.ts`, with `Error: Failed to load url ./campaign-calls.js (resolved id: ./campaign-calls.js) in …/campaign-calls.test.ts. Does the file exist?`.

- [ ] **Step 8: Write the contracts**

`packages/contracts/src/campaign-calls.ts`:
```ts
import { z } from 'zod';
import { SfObject } from './crm.js';

/**
 * Campaign rep calls through the CTI power dialer (outreach spec §10.1), served
 * by cti-api: `GET /dialer/campaigns` and `POST /dialer/sessions/from-campaign`.
 */
export const CampaignCallsResponse = z.object({
  campaigns: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    sfObject: SfObject,
    /** Queued rep-call touches due now. */
    due: z.number().int().nonnegative(),
  })),
});
export type CampaignCallsResponse = z.infer<typeof CampaignCallsResponse>;

export const StartCampaignCallsRequest = z.object({ campaignId: z.string().uuid() });
export type StartCampaignCallsRequest = z.infer<typeof StartCampaignCallsRequest>;

/** The run that was built — the same shape POST /dialer/sessions answers with. */
export const StartCampaignCallsResponse = z.object({ sessionId: z.string().uuid(), total: z.number().int().nonnegative() });
export type StartCampaignCallsResponse = z.infer<typeof StartCampaignCallsResponse>;
```

In `packages/contracts/src/index.ts`, add as the first line:

```ts
export * from './campaign-calls.js';
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test && npm run build:packages
```

Expected: `✓ src/campaign-calls.test.ts (3 tests)`, and the whole contracts suite passes. `build:packages` exits 0.

- [ ] **Step 10: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add packages/contracts/src/campaign-calls.ts packages/contracts/src/campaign-calls.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add campaign calls contracts"
```

#### Part 3: cti-api — start campaign calls

- [ ] **Step 11: Write the failing test**

`services/cti-api/src/dialer/campaign-calls.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CAMPAIGN_CALL_BATCH, dueCampaignCalls, startCampaignCalls } from './campaign-calls.js';

const dialect = new PgDialect();
const NOW = new Date('2026-10-05T15:00:00.000Z');
const ARGS = { orgId: 'O1', campaignId: '11111111-1111-4111-8111-111111111111' };

/** Records every statement; the claim (the only SKIP LOCKED one) answers with `claimRows`. */
function fakeDb(claimRows: Array<Record<string, unknown>>) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn(async (q: SQL) => {
    const r = dialect.sqlToQuery(q);
    const flat = r.sql.replace(/\s+/g, ' ').trim();
    statements.push({ sql: flat, params: r.params });
    return { rows: flat.includes('skip locked') ? claimRows : [] };
  });
  return { db: { execute } as never, statements };
}
const claimRow = (n: number) => ({ touch_id: `T${n}`, due_at: `2026-10-05T1${n}:00:00.000Z`, sf_record_id: `00Q00000000000${n}AAA`, sf_object: 'Lead' });

describe('startCampaignCalls', () => {
  it('nothing due: no run is built', async () => {
    const { db } = fakeDb([]);
    const build = vi.fn();
    expect(await startCampaignCalls({ db, now: NOW, build }, ARGS)).toEqual({ kind: 'nothing_due' });
    expect(build).not.toHaveBeenCalled();
  });

  it("claims at most one run's worth, builds the run over the claimed records, and links the touches to it", async () => {
    const { db, statements } = fakeDb([claimRow(2), claimRow(1)]);
    const build = vi.fn(async () => ({ sessionId: 'S1', total: 2 }));
    expect(await startCampaignCalls({ db, now: NOW, build }, ARGS)).toEqual({ kind: 'started', sessionId: 'S1', total: 2 });
    expect(statements[0]!.params).toEqual(['O1', 'O1', ARGS.campaignId, NOW, CAMPAIGN_CALL_BATCH, NOW, NOW]);
    expect(CAMPAIGN_CALL_BATCH).toBe(500);
    expect(build).toHaveBeenCalledWith({ objectType: 'Lead', recordIds: ['00Q000000000001AAA', '00Q000000000002AAA'], campaignId: ARGS.campaignId });
    expect(statements[1]).toEqual({ sql: "update touches set dialer_session_id = $1, updated_at = now() where id in ($2, $3) and status = 'dialing'", params: ['S1', 'T1', 'T2'] });
    expect(statements).toHaveLength(2);
  });

  it('a Salesforce failure while building releases the claim', async () => {
    const { db, statements } = fakeDb([claimRow(1), claimRow(2)]);
    const build = vi.fn(async () => { throw new Error('could not resolve Salesforce user id (status 401)'); });
    expect(await startCampaignCalls({ db, now: NOW, build }, ARGS)).toEqual({ kind: 'build_failed', error: 'could not resolve Salesforce user id (status 401)' });
    expect(statements[1]).toEqual({
      sql: "update touches set status = 'queued', dialer_session_id = null, claimed_at = null, updated_at = now() where id in ($1, $2) and status = 'dialing'",
      params: ['T1', 'T2'],
    });
  });

  it('a failure linking the touches also releases them (the READY run never starts on its own)', async () => {
    const { db, statements } = fakeDb([claimRow(1)]);
    const execute = (db as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    const real = execute.getMockImplementation()!;
    execute.mockImplementation(async (q: SQL) => {
      if (dialect.sqlToQuery(q).sql.includes('dialer_session_id = $1')) throw new Error('connection reset');
      return real(q);
    });
    const result = await startCampaignCalls({ db, now: NOW, build: async () => ({ sessionId: 'S1', total: 1 }) }, ARGS);
    expect(result).toEqual({ kind: 'build_failed', error: 'connection reset' });
    expect(statements.at(-1)!.sql).toContain("set status = 'queued'");
  });
});

describe('dueCampaignCalls', () => {
  it('wraps the due rows in the CampaignCallsResponse shape', async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: ARGS.campaignId, name: 'Spring', sf_object: 'Lead', due: 4 }] }));
    expect(await dueCampaignCalls({ execute } as never, 'O1', NOW)).toEqual({ campaigns: [{ id: ARGS.campaignId, name: 'Spring', sfObject: 'Lead', due: 4 }] });
  });
});
```

- [ ] **Step 12: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/dialer/campaign-calls.test.ts
```

Expected: `FAIL src/dialer/campaign-calls.test.ts`, with `Error: Failed to load url ./campaign-calls.js (resolved id: ./campaign-calls.js) in …/dialer/campaign-calls.test.ts. Does the file exist?`.

- [ ] **Step 13: Write the module**

`services/cti-api/src/dialer/campaign-calls.ts`:
```ts
/**
 * Campaign calls (outreach spec §10.1): a rep starts a normal power-dial run
 * from a campaign's due rep-call touches. The claim protocol itself is shared
 * with outreach-api and lives in @cti/db (campaign-calls.ts) — re-exported here
 * so the dialer's imports stay in the dialer. This file adds only the
 * claim → build → attach sequence and its failure path.
 *
 * Every dialer rule still applies: the run is built by the same
 * `createDialerSession` (consent, DNC, Skip on Dialer, already-worked) and
 * dialed by the same engine (calling hours, daily caps, cadence, AMD).
 */
import { MAX_RUN_RECORDS, type CampaignCallsResponse } from '@cti/contracts';
import { attachSession, claimCampaignTouches, dueCampaignCallRows, releaseTouches, type SqlExecutor } from '@cti/db';

export { attachSession, claimCampaignTouches, releaseTouches } from '@cti/db';

/** At most one run's worth of touches per start — the dialer's own cap. */
export const CAMPAIGN_CALL_BATCH = MAX_RUN_RECORDS;

export async function dueCampaignCalls(db: SqlExecutor, orgId: string, now: Date): Promise<CampaignCallsResponse> {
  return { campaigns: await dueCampaignCallRows(db, orgId, now) };
}

export type StartCampaignCallsResult =
  | { kind: 'started'; sessionId: string; total: number }
  | { kind: 'nothing_due' }
  | { kind: 'build_failed'; error: string };

export interface StartCampaignCallsDeps {
  db: SqlExecutor;
  now: Date;
  /** Builds the READY run — in production `createDialerSession` with the rep's own Salesforce token. */
  build: (args: { objectType: 'Lead' | 'Opportunity'; recordIds: string[]; campaignId: string }) => Promise<{ sessionId: string; total: number }>;
}

/**
 * Claim the campaign's due touches, build the run over their records, then
 * link the touches to it. The claim commits BEFORE the build (which makes
 * Salesforce calls — no row lock is held across HTTP); if the build or the link
 * fails, the claim is released so the touches go back in the queue.
 */
export async function startCampaignCalls(
  deps: StartCampaignCallsDeps,
  args: { orgId: string; campaignId: string },
): Promise<StartCampaignCallsResult> {
  const claimed = await claimCampaignTouches(deps.db, { orgId: args.orgId, campaignId: args.campaignId, now: deps.now, limit: CAMPAIGN_CALL_BATCH });
  if (claimed.length === 0) return { kind: 'nothing_due' };
  const touchIds = claimed.map((c) => c.touchId);
  try {
    const run = await deps.build({
      objectType: claimed[0]!.sfObject,
      recordIds: [...new Set(claimed.map((c) => c.sfRecordId))],
      campaignId: args.campaignId,
    });
    await attachSession(deps.db, touchIds, run.sessionId);
    return { kind: 'started', sessionId: run.sessionId, total: run.total };
  } catch (err) {
    await releaseTouches(deps.db, touchIds);
    return { kind: 'build_failed', error: (err as Error).message };
  }
}
```

- [ ] **Step 14: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/dialer/campaign-calls.test.ts
```

Expected: `✓ src/dialer/campaign-calls.test.ts (5 tests)`.

- [ ] **Step 15: Write the failing `campaignId` tests for `createDialerSession`**

In `services/cti-api/src/dialer/create-session.test.ts`, inside `describe('createDialerSession — nothing dials at creation'`, insert after line 167 (the `  });` that closes its only `it`) and before line 168 (the `});` that closes the `describe`):

```ts

  it('stores the outreach campaign a run came from, so its touches can be reconciled against it', async () => {
    const db = fakeDb();
    await createDialerSession({ ...noResolveDeps, db: db as never }, { ...args, campaignId: '11111111-1111-4111-8111-111111111111' });
    expect(db._sessionInsert).toMatchObject({ campaignId: '11111111-1111-4111-8111-111111111111', listViewId: null });
  });

  it('a run that is not from a campaign stores campaign_id null', async () => {
    const db = fakeDb();
    await createDialerSession({ ...noResolveDeps, db: db as never }, args);
    expect(db._sessionInsert).toMatchObject({ campaignId: null });
  });
```

- [ ] **Step 16: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/dialer/create-session.test.ts
```

Expected: `Tests  2 failed | 58 passed (60)`. The failures are the two new tests: the insert has no `campaignId`.

- [ ] **Step 17: Store `campaign_id`**

In `services/cti-api/src/dialer/create-session.ts`, replace the `args` type of `createDialerSession` (line 362):

```ts
  args: { userId: string; orgId: string; objectType: DialerRunObject; recordIds: string[]; listViewId?: string },
```

with:

```ts
  args: {
    userId: string; orgId: string; objectType: DialerRunObject; recordIds: string[]; listViewId?: string;
    /** Outreach campaign the run's records came from (POST /dialer/sessions/from-campaign); reconciliation keys on it. */
    campaignId?: string;
  },
```

In the `dialer_sessions` insert's `.values({ … })`, add after `listViewId: args.listViewId ?? null,`:

```ts
      campaignId: args.campaignId ?? null,
```

- [ ] **Step 18: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/dialer/create-session.test.ts && npm -w services/cti-api run typecheck
```

Expected: `Tests  60 passed (60)`. The typecheck exits 0.

- [ ] **Step 19: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  services/cti-api/src/dialer/campaign-calls.ts \
  services/cti-api/src/dialer/campaign-calls.test.ts \
  services/cti-api/src/dialer/create-session.ts \
  services/cti-api/src/dialer/create-session.test.ts
git commit -m "feat(cti-api): claim due campaign calls into a READY run and record the campaign on the session"
```

#### Part 4: cti-api routes

- [ ] **Step 20: Write the failing test**

`services/cti-api/src/routes/dialer-campaigns.test.ts` runs the real claim functions over a fake `execute` that renders each statement:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Campaign calls (outreach spec §10.1) — the two routes, wired end to end
// through the REAL startCampaignCalls / @cti/db claim functions. Only the
// edges are faked, in this file's usual way (see dialer-handoffs.test.ts):
// the session (`@cti/auth`), the database handle (`getDb` → `state.db`, whose
// `execute` answers the claim with `state.claimRows`), and the run builder
// (`createDialerSession`). The claim SQL itself is pinned in
// packages/db/src/campaign-calls.test.ts and on real Postgres in
// services/outreach-api/src/campaigns/campaign-calls.pg.test.ts.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  authedUser: null as { userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean } | null,
  db: null as unknown,
  claimRows: [] as Array<Record<string, unknown>>,
  dueRows: [] as Array<Record<string, unknown>>,
  statements: [] as Array<{ sql: string; params: unknown[] }>,
  createCalls: [] as Array<Record<string, unknown>>,
  createResult: { sessionId: '22222222-2222-4222-8222-222222222222', total: 2 } as { sessionId: string; total: number } | Error,
}));

vi.mock('../config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.authedUser,
}));
vi.mock('@cti/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/db')>()),
  getDb: () => state.db,
}));
vi.mock('../dialer/create-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dialer/create-session.js')>()),
  createDialerSession: async (_deps: unknown, args: Record<string, unknown>) => {
    state.createCalls.push(args);
    if (state.createResult instanceof Error) throw state.createResult;
    return state.createResult;
  },
}));

import { registerDialerRoutes } from './dialer.js';

const dialect = new PgDialect();
const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const auth = { authorization: 'Bearer t' };

let app: FastifyInstance;
beforeEach(async () => {
  state.authedUser = REP;
  state.claimRows = [];
  state.dueRows = [];
  state.statements = [];
  state.createCalls = [];
  state.createResult = { sessionId: '22222222-2222-4222-8222-222222222222', total: 2 };
  state.db = {
    execute: async (q: SQL) => {
      const r = dialect.sqlToQuery(q);
      const sql = r.sql.replace(/\s+/g, ' ').trim();
      state.statements.push({ sql, params: r.params });
      if (sql.includes('skip locked')) return { rows: state.claimRows };
      if (sql.includes('count(*)')) return { rows: state.dueRows };
      return { rows: [] };
    },
  };
  app = Fastify();
  await registerDialerRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('GET /dialer/campaigns', () => {
  it("lists the caller's org's campaigns with due rep calls", async () => {
    state.dueRows = [{ id: CAMPAIGN, name: 'Spring sellers', sf_object: 'Lead', due: 12 }];
    const res = await app.inject({ method: 'GET', url: '/dialer/campaigns', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ campaigns: [{ id: CAMPAIGN, name: 'Spring sellers', sfObject: 'Lead', due: 12 }] });
    expect(state.statements[0]!.params.slice(0, 2)).toEqual(['O1', 'O1']);
  });

  it('401 without a session, 403 without the power-dialer grant — and no query either way', async () => {
    state.authedUser = null;
    expect((await app.inject({ method: 'GET', url: '/dialer/campaigns' })).statusCode).toBe(401);
    state.authedUser = { ...REP, powerDialerEnabled: false };
    const res = await app.inject({ method: 'GET', url: '/dialer/campaigns', headers: auth });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'power_dialer_disabled' });
    expect(state.statements).toEqual([]);
  });
});

describe('POST /dialer/sessions/from-campaign', () => {
  const start = (payload: unknown) => app.inject({ method: 'POST', url: '/dialer/sessions/from-campaign', headers: auth, payload: payload as Record<string, unknown> });

  it("claims the due touches, builds a READY run over their records with the campaign on it, and answers { sessionId, total }", async () => {
    state.claimRows = [
      { touch_id: 'T1', due_at: '2026-10-05T13:00:00.000Z', sf_record_id: '006000000000001AAA', sf_object: 'Opportunity' },
      { touch_id: 'T2', due_at: '2026-10-05T14:00:00.000Z', sf_record_id: '006000000000002AAA', sf_object: 'Opportunity' },
    ];
    const res = await start({ campaignId: CAMPAIGN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: '22222222-2222-4222-8222-222222222222', total: 2 });
    expect(state.statements[0]!.params.slice(0, 3)).toEqual(['O1', 'O1', CAMPAIGN]);
    expect(state.createCalls).toEqual([{
      userId: 'U-ME', orgId: 'O1', objectType: 'Opportunity', recordIds: ['006000000000001AAA', '006000000000002AAA'], campaignId: CAMPAIGN,
    }]);
    expect(state.statements[1]!.sql).toContain('set dialer_session_id = $1');
    expect(state.statements[1]!.params).toEqual(['22222222-2222-4222-8222-222222222222', 'T1', 'T2']);
  });

  it('404 when nothing is due — no run is built', async () => {
    const res = await start({ campaignId: CAMPAIGN });
    expect(res.statusCode).toBe(404);
    expect(state.createCalls).toEqual([]);
  });

  it('a Salesforce failure while building releases the claimed touches and answers 502', async () => {
    state.claimRows = [{ touch_id: 'T1', due_at: '2026-10-05T13:00:00.000Z', sf_record_id: '00Q000000000001AAA', sf_object: 'Lead' }];
    state.createResult = new Error('could not resolve Salesforce user id (status 401)');
    const res = await start({ campaignId: CAMPAIGN });
    expect(res.statusCode).toBe(502);
    expect(state.statements.at(-1)!.sql).toBe(
      "update touches set status = 'queued', dialer_session_id = null, claimed_at = null, updated_at = now() where id in ($1) and status = 'dialing'",
    );
    expect(state.statements.at(-1)!.params).toEqual(['T1']);
  });

  it('400 on a body without a campaign uuid; 403 without the grant; 401 without a session — nothing claimed', async () => {
    expect((await start({ campaignId: 'not-a-uuid' })).statusCode).toBe(400);
    state.authedUser = { ...REP, powerDialerEnabled: false };
    expect((await start({ campaignId: CAMPAIGN })).statusCode).toBe(403);
    state.authedUser = null;
    expect((await start({ campaignId: CAMPAIGN })).statusCode).toBe(401);
    expect(state.statements).toEqual([]);
  });
});
```

- [ ] **Step 21: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/routes/dialer-campaigns.test.ts
```

Expected: `Tests  5 failed | 1 passed (6)`. Neither route exists, so every request gets Fastify's 404. The `404 when nothing is due` test passes for that reason, and Step 24 makes it pass for the right one.

- [ ] **Step 22: Add the routes**

In `services/cti-api/src/routes/dialer.ts`, after the header line ` *  POST /dialer/sessions              → create a READY session over a Lead/Opportunity/Task id list (nothing dials yet)` (line 4), add:

```ts
 *  GET  /dialer/campaigns             → outreach campaigns with rep calls due now (the Campaign calls picker)
 *  POST /dialer/sessions/from-campaign → claim a campaign's due rep calls and build a READY session over them
```

Replace line 31:

```ts
import { MAX_RUN_RECORDS, type DialerRunSettings } from '@cti/contracts';
```

with:

```ts
import { MAX_RUN_RECORDS, StartCampaignCallsRequest, type DialerRunSettings, type StartCampaignCallsResponse } from '@cti/contracts';
```

After line 37, `import { createDialerSession } from '../dialer/create-session.js';`, add:

```ts
import { dueCampaignCalls, startCampaignCalls } from '../dialer/campaign-calls.js';
```

After the `POST /dialer/sessions` handler, which ends `    return result;\n  });` at line 395, insert:

```ts

  // Campaign calls (outreach spec §10.1): the org's active campaigns with
  // rep-call touches due now — what the softphone's Campaign calls picker lists.
  app.get('/dialer/campaigns', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    if (!requirePowerDialer(authed, reply)) return reply;
    return dueCampaignCalls(getDb(), authed.orgId, new Date());
  });

  // POST /dialer/sessions/from-campaign { campaignId } — claim the campaign's
  // due rep-call touches and build a normal READY run over their records with
  // the rep's own Salesforce token (every build-time gate applies). A failed
  // build gives the touches back to the queue.
  app.post('/dialer/sessions/from-campaign', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    if (!requirePowerDialer(authed, reply)) return reply;
    const parsed = StartCampaignCallsRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    const result = await startCampaignCalls(
      {
        db,
        now: new Date(),
        build: ({ objectType, recordIds, campaignId }) => createDialerSession(
          {
            resolveDialNumber, fetchTasks, fetchContactNames, salesforceUserId, db,
            workedRecently: (orgId, numbers) => workedRecentlySafe(db, orgId, numbers),
            consentBlocked: (orgId, numbers) => blockedTargetsSafe(db, orgId, numbers),
            preferredNumbers: (orgId, pairs) => preferredNumbersFor(db, orgId, pairs),
            listStartPosition: (orgId, listViewIdArg, now) => listRunStart(db, orgId, listViewIdArg, now),
          },
          { userId: authed.userId, orgId: authed.orgId, objectType, recordIds, campaignId },
        ),
      },
      { orgId: authed.orgId, campaignId: parsed.data.campaignId },
    );
    if (result.kind === 'nothing_due') return reply.code(404).send({ error: 'No campaign calls are due right now.' });
    if (result.kind === 'build_failed') {
      req.log.warn({ campaignId: parsed.data.campaignId, err: result.error }, 'campaign_calls_build_failed');
      return reply.code(502).send({ error: 'Could not build the call list from Salesforce — is the rep signed in? Try again.' });
    }
    const body: StartCampaignCallsResponse = { sessionId: result.sessionId, total: result.total };
    return body;
  });
```

The `createDialerSession` deps are exactly the ones `POST /dialer/sessions` passes, plus `campaignId`. Check them against that handler (lines 368–395) when you apply this. If that handler's deps have changed since, copy its object.

- [ ] **Step 23: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/routes/dialer-campaigns.test.ts src/dialer && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -4
```

Expected: `✓ src/routes/dialer-campaigns.test.ts (6 tests)` and the dialer files pass. The typecheck exits 0. The full cti-api suite passes; on the prototype base that was `Test Files  102 passed (102)`, `Tests  2074 passed (2074)`.

- [ ] **Step 24: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/dialer-campaigns.test.ts
git commit -m "feat(cti-api): add GET /dialer/campaigns and POST /dialer/sessions/from-campaign"
```

> **Note for B5 (reconciliation):** `createDialerSession` can gate a claimed record out at build time (opt-out, already worked, no dialable number). Its touch is still linked to the session as `dialing`, but no dial attempt for it will ever exist. B5 must treat "session ended, no attempt for this record" as not dialed, and requeue or skip that touch. Otherwise the touch stays `dialing` forever.

---

## Skeleton corrections

**B1**
1. **Permission set grants differ from "create/edit on Task; read on Lead/Opportunity/Contact/OpportunityContactRole".**
   - **Task:** Task is not granted through `objectPermissions`. The permset uses the `EditTask` user permission plus edit on `Activity.CTI_Origin__c`, which phase 2's Task marker needs.
   - **OpportunityContactRole:** OCR is not a permissionable object. Its access follows the parent Opportunity, so the primary-contact query works with Opportunity read and View All.
   - **Lead, Opportunity and Contact:** read **and edit**, because the outbox updates them. View All, so the Integration user sees every record regardless of sharing. No create, delete or Modify All.
   - **Field-level security:** the permset adds FLS that the skeleton didn't list. Read on Phone, MobilePhone, Email and Description, and on `Skip_on_Dialer__c`. Edit on `DoNotCall` and `HasOptedOutOfEmail` for Lead and Contact.
   - **Tenant-only custom fields** (notes, extra phone fields, `Lead_Form_Source__c`, `LeadManager__c`) are granted in the org (runbook §0.4). Referencing a field the org lacks fails the whole deploy.
2. **New file `services/outreach-api/src/crm/consent-fields.ts`.** It holds `CONSENT_FIELDS`, `CONSENT_SOURCES`, `ConsentSource`, `CONSENT_OBJECTS`, `CTI_ORIGIN_FIELD` and `CTI_ORIGIN_AI_OUTREACH`. The metadata test pins the XML to these, and B2 and B3 write with them, so a field or picklist rename cannot drift.
3. **Test location.** The metadata test is `services/outreach-api/src/crm/salesforce-metadata.test.ts`, not a `packages/db` file. outreach-api is the code that depends on the field names.
4. **Runbook risk (A5 follow-up).** A `Salesforce Integration`-license user is API-only. A5's Connections flow signs in through the browser (OAuth web-server flow with PKCE), which that user may be refused. Runbook §0.1 gives the fallback, a dedicated full-license `AI Outreach` user with the same permission sets. A client-credentials connection should be a follow-up to A5.

**B2**

5. **`drainOutbox` alert signature.** It is `alert: (orgId: string, text: string) => Promise<void>`, not `(text)`, because the alert must name the tenant.
   - `src/alerts.ts` gains the `'sf_write_failing'` kind and `sfWriteAlert(logger)`.
   - B7 should reuse this kind and function rather than add another.
6. **Code layout.** The outbox is split into `outbox-store.ts` (database), `outbox-writes.ts` (Salesforce) and `outbox.ts` (policy), each under 250 lines. `DrainDeps` gains `store?: OutboxStore` as a test seam.
   - Extra exports: `nextDelayMinutes`, `BACKOFF_MINUTES`, `ALERT_AFTER_MS`, `DEFAULT_DRAIN_BATCH`, `outboxJob`, `doNotContactEnqueuer`, `DbExecutor`, `SfWriteInput`, `DrainDeps`, `DrainResult`, `OutboxRow`, `RetryStamp`, `OutboxStore`, `dbOutboxStore`, `RowOutcome`, `writeRows`, `primaryContacts`, `SF_BATCH`, `DO_NOT_CONTACT_FIELDS`, `errorText`.
   - The row type is `OutboxRow`, a projection of A3's `SfWriteRow`.
7. **Terminal `failed` status.** The skeleton only described backoff. A per-record error that no retry can fix marks the row `failed` at once: `ENTITY_IS_DELETED`, `INVALID_CROSS_REFERENCE_KEY`, `MALFORMED_ID`, `INVALID_ID_FIELD`, `NOT_FOUND`, `CANNOT_UPDATE_CONVERTED_LEAD`, `NO_PRIMARY_CONTACT`, or a payload that fails its zod schema.
8. **Failure semantics, decided.**
   - `CrmNotConnectedError` and `SalesforceAuthError` are the connection's failure. They leave the tenant's rows `pending`, with no attempt counted and no 24-hour clock started. A8's `crm_broken` pause covers the outage, and B7's alerting applies.
   - `SalesforceApiError`, `RangeError` and transient per-record errors count an attempt with backoff.
9. **Enqueue inside the caller's transaction.** `enqueueSfWrite(db: DbExecutor, …)` accepts a transaction. `doNotContactEnqueuer(db)` is A11's `onConfirmed` and enqueues with A11's `tx`. The `do_not_contact` payload is `{ reason: 'do_not_contact_confirmed' }`, because the kind fixes the fields. The `consent` payload is `{ consent: true, source, at }`, zod-checked at drain.
10. **Queue registration.**
    - `sf.write` reuses A8's `TICK_QUEUE_OPTIONS` (`stately`).
    - Its worker registers only when `cfg.salesforceEnabled`, following A8's pattern.
    - A8's `schedules.test.ts` exact-list assertions are extended to include it.
11. **A13 copy.** B2 updates A13's confirm-do-not-contact dialog copy and its test, as A13's corrections asked.

**B3**

12. **No `BackfillRequest` contract.** The backfill takes no body; the skeleton's 1B contracts comment listed one. `BackfillResult` counts are `z.number().int().nonnegative()`.
13. **Narrower rule signatures.**
    - `consentFromRecord` takes `Pick<SfRecordSnapshot, 'webFormSource' | 'consentAiCall'>` and `Pick<OutreachSettings, 'consentFromWebForms'>`.
    - `inboundCallerMatches` takes records whose phones are `{ e164 }[]` (the `SfRecordSnapshot` shape) and calls typed `InboundCallRow`. It matches who/what ids on their 15-character form.
    - Added: `planConsent`, `applyConsentPlan`, `loadInboundCalls`, `captureConsentOnRefresh`, `AI_CALL_CONSENT_TYPE`, `INBOUND_CALLS_CAP` (200,000 most recent inbound calls).
14. **Audit keys on PUT.** `PUT /settings/consent` merges with a jsonb `||`, so a concurrent write to another settings key is never lost. When web forms is switched on, it also stores `consentFromWebFormsConfirmedBy` and `consentFromWebFormsConfirmedAt`, which record the admin's confirmation of the consent language. A10's `outreachSettings` ignores unknown keys.
15. **The refresh hook's exact shape.** It is `captureConsentOnRefresh(db, { orgId, snapshots, upserted, now })` inside A8's `if (fetchIds.length > 0)` block. It runs on exactly the records the refresh fetched, before enrollment.

**B4**

16. **The claim lives in `@cti/db`** (`packages/db/src/campaign-calls.ts`), not in cti-api, which re-exports `claimCampaignTouches`, `attachSession` and `releaseTouches`. That gives one definition for both services, and it can be proven in outreach-api's real-PG lane, since cti-api has none.
17. **Claim SQL shape.** It is still one statement, but a locking CTE (`… limit n for update of t skip locked`) followed by `UPDATE touches … FROM picked, campaign_enrollments, crm_records … RETURNING`, rather than `WHERE id IN (SELECT …)`.
    - `OF t` locks only the touch rows. A bare `FOR UPDATE` would also lock the campaign row, and with `SKIP LOCKED` a second rep's claim would then skip every touch of that campaign.
    - A CTE is materialized once, so the limit holds.
    - The claim and due queries also require `campaign_enrollments.status = 'active'`.
18. **Claim return and limit types.** The claim returns `sfObject` as well as `{ touchId, sfRecordId }`, so the run's `objectType` comes from the claimed rows. `limit` is a `number`; cti-api passes `CAMPAIGN_CALL_BATCH = MAX_RUN_RECORDS` (500).
19. **Extra contract and exports.** Added the `StartCampaignCallsResponse` contract for `{ sessionId, total }`. Also added `startCampaignCalls`, `StartCampaignCallsResult`, `StartCampaignCallsDeps` and `CAMPAIGN_CALL_BATCH` in cti-api, and `dueCampaignCallRows`, the `*Sql` builders, `SqlExecutor`, `DueCampaignCallRow` and `ClaimedCampaignTouch` in `@cti/db`.
20. **No transaction across the build.** The claim commits before the Salesforce build, so no lock is held across HTTP. Attach and release are separate statements that touch only rows still `dialing`. Release clears `dialer_session_id` and `claimed_at`. Both routes answer in cti-api's `{ error }` shape, not outreach-api's error envelope.
