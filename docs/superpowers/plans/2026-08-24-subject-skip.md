# Subject Format + Skip on Dialer Implementation Plan (Launch sub-project D+E)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Task subjects become `Outbound Call | Voicemail | (619) 555-1234 / Jane Doe` on both write paths, and a `Skip_on_Dialer__c` checkbox on Lead/Opportunity keeps flagged records out of every power-dial queue as visible skipped rows.

**Architecture:** One pure subject builder per package (no shared lib exists — two byte-identical modules with the same test vectors, cross-checked by review). The server resolves the record name from the phone-match (already returns `recordName`) or one Name retrieve; the client uses the click-to-dial context's `recordName`. The checkbox ships from the repo's existing `salesforce/` sfdx project to the prod org `_t2`, and queue-build code reads it with an INVALID_FIELD-tolerant fallback so deploy order can never break dialing.

**Tech Stack:** TypeScript (Fastify API + React 18 client, vitest), sf CLI v2 against org alias `_t2` (API 67.0), sfdx metadata in `salesforce/force-app`.

## Global Constraints

- Subject format, exact: `<Inbound|Outbound> Call | <disposition> | <number>` and, when a record name is known, `<number> / <name>`. Separators are ` | ` and ` / ` (single spaces). No trailing ` / ` when nameless.
- Number renders `(619) 555-1234` for NANP e164 (`+1XXXXXXXXXX`); anything else renders as-is. No `+1 ` prefix.
- Empty/null disposition renders as `Not dispositioned` (the existing `AUTO_DISPOSITION` constant — import it, never retype the string).
- `Skip_on_Dialer__c` exists on Lead and Opportunity ONLY. Contact-resolved Task targets are never flagged (no field on Contact). The checkbox affects power-dial queue builds only — click-to-dial and inbound are untouched.
- A flagged record enters the queue as `status='skipped'`, `outcome='skip_on_dialer'` (visible row; never silently dropped). Skip beats unreachable when both apply.
- Salesforce reads of the new field tolerate `INVALID_FIELD` (org not yet deployed): retry without the field, treat as unflagged, `console.warn` once per process — mirroring `salesforce/ownership.ts`.
- The sf CLI target is **`-o _t2`** (00D5f000005w2kWEAQ = gghsd.my.salesforce.com — PRODUCTION). The sandbox alias `gghsd-maindev` is NOT the target. Metadata lives in `salesforce/force-app/main/default/`.
- Verify code tasks with `npm test` + `npm run typecheck` in the touched package; the client task also `npm run build`.
- `.claude/launch.json` is an unrelated pre-existing unstaged deletion — never stage, restore, or commit it.

---

### Task 1: Server subject builder (pure)

**Files:**
- Create: `services/cti-api/src/salesforce/call-subject.ts`, `services/cti-api/src/salesforce/call-subject.test.ts`

**Interfaces:**
- Produces: `formatNanp(e164: string): string`; `buildCallSubject(args: { inbound: boolean; disposition: string | null | undefined; counterpartyE164: string; recordName?: string | null }): string`. Consumes `AUTO_DISPOSITION` from `./sync.js`.

- [ ] **Step 1: Failing test** — `call-subject.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildCallSubject, formatNanp } from './call-subject.js';

describe('formatNanp', () => {
  it('renders NANP as (XXX) XXX-XXXX and passes anything else through', () => {
    expect(formatNanp('+16195551234')).toBe('(619) 555-1234');
    expect(formatNanp('+442071234567')).toBe('+442071234567');
    expect(formatNanp('anonymous')).toBe('anonymous');
  });
});

describe('buildCallSubject', () => {
  it('outbound with disposition and name', () => {
    expect(buildCallSubject({ inbound: false, disposition: 'Voicemail', counterpartyE164: '+16195551234', recordName: 'Jane Doe' }))
      .toBe('Outbound Call | Voicemail | (619) 555-1234 / Jane Doe');
  });
  it('inbound, no record matched — no dangling slash', () => {
    expect(buildCallSubject({ inbound: true, disposition: 'Connected', counterpartyE164: '+16195551234' }))
      .toBe('Inbound Call | Connected | (619) 555-1234');
  });
  it('null/empty disposition renders as the auto-disposition', () => {
    expect(buildCallSubject({ inbound: false, disposition: null, counterpartyE164: '+16195551234', recordName: null }))
      .toBe('Outbound Call | Not dispositioned | (619) 555-1234');
    expect(buildCallSubject({ inbound: false, disposition: '', counterpartyE164: '+16195551234' }))
      .toBe('Outbound Call | Not dispositioned | (619) 555-1234');
  });
  it('whitespace-only names are treated as absent', () => {
    expect(buildCallSubject({ inbound: false, disposition: 'Voicemail', counterpartyE164: '+16195551234', recordName: '  ' }))
      .toBe('Outbound Call | Voicemail | (619) 555-1234');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd services/cti-api && npx vitest run src/salesforce/call-subject.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — `call-subject.ts`:

```ts
/**
 * THE call-log subject rule (launch spec D, user-approved 2026-08-24):
 *   "Outbound Call | Voicemail | (619) 555-1234 / Jane Doe"
 * Mirrored byte-for-byte in apps/cti-web/src/call-subject.ts (no shared package
 * exists) — change BOTH or the two write paths drift.
 */
import { AUTO_DISPOSITION } from './sync.js';

/** NANP e164 → "(XXX) XXX-XXXX"; anything else passes through untouched. */
export function formatNanp(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function buildCallSubject(args: {
  inbound: boolean;
  disposition: string | null | undefined;
  counterpartyE164: string;
  recordName?: string | null;
}): string {
  const dispo = args.disposition?.trim() || AUTO_DISPOSITION;
  const name = args.recordName?.trim();
  const who = name ? `${formatNanp(args.counterpartyE164)} / ${name}` : formatNanp(args.counterpartyE164);
  return `${args.inbound ? 'Inbound' : 'Outbound'} Call | ${dispo} | ${who}`;
}
```

(If importing `AUTO_DISPOSITION` from `./sync.js` creates an import cycle once sync.ts imports this module in Task 2, move the constant INTO `call-subject.ts` and re-export it from `sync.ts` so existing importers — `routes/calls.ts` — keep working. State in your report which way you went.)

- [ ] **Step 4: Verify** — test file PASSES; `npm test && npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add services/cti-api/src/salesforce/call-subject.ts services/cti-api/src/salesforce/call-subject.test.ts && git commit -m "feat(cti-api): the call-log subject builder"`

---

### Task 2: Wire the server write path (+ record name resolution)

**Files:**
- Modify: `services/cti-api/src/salesforce/sync.ts` (the `subject` line and `SyncOneDeps`), `services/cti-api/src/salesforce/sync.test.ts`

**Interfaces:**
- Consumes: `buildCallSubject` (Task 1); `findByPhone`'s match already carries `recordName: string | null` (`client.ts:122`); `objectTypeForId` from `./ownership.js`.
- Produces: `SyncOneDeps` gains `recordName: (userId: string, recordId: string) => Promise<string | null>` with live default `fetchRecordName` (exported).

- [ ] **Step 1: Failing tests** — extend `sync.test.ts`'s existing injected-deps `syncOne` cases:

```ts
  it('subject uses the new format with the matched record name', async () => {
    // findByPhone match with recordName 'Jane Doe' → createCallTask called with
    // subject 'Outbound Call | Voicemail | (619) 555-1234 / Jane Doe'
  });
  it('subject falls back to number-only when no name resolves', async () => { /* match null, recordName dep returns null */ });
  it('a call-row-attached record (no findByPhone) resolves its name via the recordName dep', async () => {
    // call.salesforceWhoId set → deps.recordName called with (call.userId, whoId); name lands in the subject
  });
```

Write them fully in the file's existing style (fake deps object; assert on the `createCallTask` fake's `subject` argument). The exact expected strings come from Task 1's vectors.

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**:
  - `fetchRecordName(userId, recordId)`: `objectTypeForId(recordId)` known → `SELECT Name FROM <Type> WHERE Id = '<esc>' LIMIT 1`; `'other'` prefix `a0…` (Deal__c) → `SELECT Name FROM Deal__c …` guarded by try/catch → null; failures return null (a name is cosmetic — never fail the sync for it).
  - In `syncOne`: name precedence = findByPhone match's `recordName` → else (whoId ?? whatId) via `deps.recordName` → else null. Then `const subject = buildCallSubject({ inbound, disposition: call.disposition, counterpartyE164: counterparty, recordName })`.
- [ ] **Step 4: Verify** — `npm test && npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(cti-api): sync worker writes the new call-log subject"`

---

### Task 3: Client mirror builder + Open CTI write

**Files:**
- Create: `apps/cti-web/src/call-subject.ts`, `apps/cti-web/src/call-subject.test.ts` (byte-identical logic + the SAME test vectors as Task 1; the client has no AUTO_DISPOSITION import — define `const AUTO_DISPOSITION = 'Not dispositioned';` locally with a comment naming the server source of truth `services/cti-api/src/salesforce/sync.ts`)
- Modify: `apps/cti-web/src/App.tsx` — `ActiveCall` gains `recordName?: string`; `place()`'s `setActive` adds `recordName: ctiContext?.recordName` (the click-to-dial event already carries it, `App.tsx:50`); `submitDisposition`'s `saveCallLog` call replaces ``Subject: `Outbound Call - ${active.toNumber}` `` with `Subject: buildCallSubject({ inbound: false, disposition, counterpartyE164: active.toNumber, recordName: active.recordName })`.

- [ ] **Step 1: Failing test** (vectors from Task 1) → **Step 2: verify failure** → **Step 3: implement** → **Step 4:** `npm test && npm run typecheck && npm run build` in apps/cti-web → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cti-web): softphone writes the new call-log subject"`

---

### Task 4: Org dependency sweep for the old prefix (read-only)

**Files:**
- Create: `docs/runbooks/subject-format-change.md` (findings + the residual)

- [ ] **Step 1:** From `salesforce/`: `sf project retrieve start -m Flow -m ApexClass -m ApexTrigger -m WorkflowRule -o _t2 --output-dir /private/tmp/claude-501/-Users-cdrshepard-spam-res-cti/afd1f56e-293d-4ea6-9400-11116185f1f2/scratchpad/org-sweep` (READ-ONLY retrieve to scratch — never commit the retrieved metadata, never deploy from it).
- [ ] **Step 2:** `grep -rn "Outbound Call" <that dir>` (and `"Inbound Call"`). Record every hit (file, automation name, what it does) in the runbook; zero hits is also a finding — state it.
- [ ] **Step 3:** The runbook notes the residual: Report column filters cannot be cheaply searched — an admin should check any report filtering on Task Subject `starts with "Outbound Call - "` and switch it to `contains "Outbound Call | "`.
- [ ] **Step 4: Commit** — `git commit -m "docs(cti): org sweep for call-subject dependencies"`

---

### Task 5: Deploy `Skip_on_Dialer__c` to the org

**Files:**
- Create: `salesforce/force-app/main/default/objects/Lead/fields/Skip_on_Dialer__c.field-meta.xml`, `salesforce/force-app/main/default/objects/Opportunity/fields/Skip_on_Dialer__c.field-meta.xml`, `salesforce/force-app/main/default/permissionsets/Skip_On_Dialer.permissionset-meta.xml`

- [ ] **Step 1: Field metadata** (both files, `<fullName>Skip_on_Dialer__c</fullName>`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Skip_on_Dialer__c</fullName>
    <label>Skip on Dialer</label>
    <type>Checkbox</type>
    <defaultValue>false</defaultValue>
    <description>Checked = the CTI power dialer never auto-dials this record. Manual click-to-dial is unaffected. (CTI launch spec 2026-08-24, item 6.)</description>
    <trackTrending>false</trackTrending>
</CustomField>
```

- [ ] **Step 2: Permission set** granting `<editable>true</editable>` + `<readable>true</readable>` on `Lead.Skip_on_Dialer__c` and `Opportunity.Skip_on_Dialer__c`, label `Skip On Dialer`.
- [ ] **Step 3: Deploy fields + permset** — from `salesforce/`: `sf project deploy start -d force-app/main/default/objects -d force-app/main/default/permissionsets -o _t2` → expect Succeeded. (Additive; touches nothing existing.)
- [ ] **Step 4: Assign the permset to every active user** — `sf org assign permset -n Skip_On_Dialer -o _t2 -b evren@gghomessd.com matt@sjoinvestments.com tyler@sjoinvestments.com jona@gghomessd.com` (check `sf org assign permset --help` for the multi-user flag shape; else one call per user).
- [ ] **Step 5: Layouts** — `sf org list metadata -m Layout -o _t2 | grep -E "^Lead-|^Opportunity-"`; retrieve each (`sf project retrieve start -m "Layout:Lead-<name>" -o _t2`), insert into the first `<layoutColumns>` of the last section: `<layoutItems><behavior>Edit</behavior><field>Skip_on_Dialer__c</field></layoutItems>`, deploy back. If a layout deploy errors on unrelated drift, SKIP that layout and list it in your report (the field is reachable via the record detail's field list regardless) — never force.
- [ ] **Step 6: Verify** — `sf data query -q "SELECT Id, Skip_on_Dialer__c FROM Lead LIMIT 1" -o _t2` and the same for Opportunity → both succeed with `false`.
- [ ] **Step 7: Commit** (metadata sources only) — `git add salesforce/force-app && git commit -m "feat(sf): Skip_on_Dialer__c on Lead + Opportunity, permset, layouts"`

---

### Task 6: Queue build honors the checkbox

**Files:**
- Modify: `services/cti-api/src/salesforce/record-phone.ts` (+`record-phone.test.ts`), `services/cti-api/src/dialer/create-session.ts` (+`create-session.test.ts`)

**Interfaces:**
- Produces: `resolveDialNumber` returns `{ e164, fallbackE164, skipOnDialer: boolean } | null`; `ResolvedRow` gains `skipOnDialer?: boolean`; queue rows for flagged records: `status: 'skipped'`, `outcome: 'skip_on_dialer'` (add `outcome` to `buildQueueRows`' row shape — the column exists).

- [ ] **Step 1: Failing tests** —
  - `record-phone.test.ts`: Lead SOQL includes `Skip_on_Dialer__c`; a checked Lead resolves with `skipOnDialer: true`; the Opportunity path reads `Opportunity.Skip_on_Dialer__c` through the OCR query; an `INVALID_FIELD` error retries WITHOUT the field, warns once, and resolves `skipOnDialer: false` (mirror `ownership.test.ts`'s warn-spy style).
  - `create-session.test.ts`: a flagged Lead in a Lead run → row `{ status: 'skipped', outcome: 'skip_on_dialer' }` with its number still recorded; a Task whose target Opportunity is flagged → same; a Contact-resolved Task target is NEVER flagged; a flagged record with no phone → still `skip_on_dialer` (skip beats unreachable); the engine's initial advance is not handed the flagged row (it stays non-pending).
- [ ] **Step 2: verify failure** → **Step 3: Implement**:
  - Lead query: `SELECT MobilePhone, Phone, Skip_on_Dialer__c FROM Lead …`; OCR query: `SELECT Contact.MobilePhone, Contact.Phone, Opportunity.Skip_on_Dialer__c FROM OpportunityContactRole …`; Contact query unchanged (`skipOnDialer: false`).
  - INVALID_FIELD fallback: module-level `warnedSkipField` boolean; on `/INVALID_FIELD/.test(message)` retry the field-less query and return `skipOnDialer: false`.
  - `resolveRows`: propagate; `buildQueueRows`: `status: r.skipOnDialer ? 'skipped' : r.toNumber ? 'pending' : 'unreachable'`, `outcome: r.skipOnDialer ? 'skip_on_dialer' : null`.
- [ ] **Step 4: Verify** — `npm test && npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(cti-api): Skip on Dialer keeps flagged records out of power-dial queues"`

---

### Task 7: Post-deploy live verification (CONTROLLER-EXECUTED, after the user pushes)

- [ ] Check `Skip_on_Dialer__c` on the CTI DIAL TEST 2 opportunity (`sf data update record -s Opportunity -i 006US00000gHqOdYAK -v "Skip_on_Dialer__c=true" -o _t2`).
- [ ] Create a dialer session over ONLY that record (server-side, minted session, objectType Opportunity) → expect one `skipped/skip_on_dialer` row, zero dials, session completes.
- [ ] One real dial + disposition on CTI DIAL TEST 1 → the SF Task subject reads `Outbound Call | <dispo> | (205) 430-3297 / CTI Dial Test 1`.
- [ ] Uncheck the box; delete the test session artifacts if any.
