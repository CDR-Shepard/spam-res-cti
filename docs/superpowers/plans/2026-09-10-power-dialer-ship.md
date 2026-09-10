# Power Dialer — Ship It Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the power dialer work on this org's real lists (phones live on the Opportunity), make every miss say why, let the rep confirm a list before the first ring, and pilot it with three reps.

**Architecture:** Four narrow changes to the existing server-originated AMD dialer, no redesign. (1) `resolveDialNumber` reads the Opportunity's own phone fields before the Contact Role. (2) The two Twilio webhook handlers stamp a real reason (`voicemail`, `busy`, …) into the queue row's existing `outcome` column; the engine's three-way decision is untouched. (3) A session is now created `ready` and only a new `start` control action moves it to `active` and dials; the panel shows a confirm block in between. (4) Rollout is an admin toggle, not code.

**Tech Stack:** Fastify + Drizzle/Postgres 18 (`services/cti-api`, shared code in `packages/db`, `packages/phone`), Twilio async AMD, Salesforce SOQL via the rep's token, React + vitest (`apps/cti-web`; no `@testing-library` — component tests are `renderToStaticMarkup` plus pure-function tests).

**Spec:** `docs/superpowers/specs/2026-09-10-power-dialer-ship-design.md` (read it once; the exact values below are copied from it).

## Global Constraints

- **Opportunity phone order** is exactly `Mobile_Phone__c`, `Phone__c`, `Other_Phone__c`. Primary = first non-empty; fallback = the next non-empty. The `OpportunityContactRole` query runs **only when all three are empty**. `skipOnDialer` is read from the Opportunity query. Lead and Contact branches are untouched.
- **Outcome type**, verbatim: `type DialOutcome = 'connected' | 'no_answer' | 'voicemail' | 'fax' | 'busy' | 'failed' | 'canceled' | 'hangup'`. `isNoConnect(o)` is `o !== 'connected' && o !== 'no_answer'`.
- **Engine decision unchanged:** bridge on `connected`; the fallback number is tried **only** on `no_answer`; every other outcome becomes a `no_connect` row with the reason in the row's text `outcome` column. The `dialer_item_status` enum does not change.
- **AMD mapping:** `AnsweredBy` starting with `machine` → `voicemail`; `fax` → `fax`; anything else (human, unknown, missing) → `connected`.
- **Status-callback mapping:** `no-answer` → `no_answer`, `busy` → `busy`, `failed` → `failed`, `canceled` → `canceled`, `completed` on a still-`dialing` item → `hangup`. The status handler stays an idempotent backstop and **must not overwrite** a reason the AMD handler stamped.
- **Migration** `packages/db/migrations/0037_dialer_session_ready.sql` runs exactly `ALTER TYPE dialer_session_status ADD VALUE IF NOT EXISTS 'ready';` and nothing that uses the value. The runner (`packages/db/src/migrate-runner.ts`) applies files in lexical order and records each by filename in `cti_schema_migrations`.
- **Session flow:** `createDialerSession` inserts `status: 'ready'`; `createAndStartSession` is deleted; `POST /dialer/sessions/:id/start` = compare-and-swap `ready → active` then `advanceSession`; a second `start` is a no-op; `stop` on a `ready` session → `stopped` with no dial, no rollover, no conference release.
- **Panel copy** (exact strings): picker button reads `Checking records…` while the create request is in flight; confirm block line reads like `187 will be dialed · 9 already worked · 4 no number · 2 blocked` (zero parts omitted); buttons are **Start dialing** (primary, full width) then **Choose a different list**; the run screen's miss line reads like `12 voicemail · 4 no answer · 2 bad number`; current-record labels are `Voicemail`, `No answer`, `Busy`, `Bad number` (failed), `No number` (unreachable).
- **Pilot reps:** Garrett Martorello, Norah Nazzaro, Edward Jerome Maglalang — enabled by an admin after deploy, never by an implementer.
- **Repo rules:** work in a harness worktree and run `git merge --ff-only main` before touching anything (harness worktrees start from a stale base). Never stage `.claude/launch.json` or anything under `docs/superpowers/specs/2026-09-03-*outreach*`. Never use bare `git stash`. Commit messages are `type(scope): summary` with no attribution trailer. Never place a call, never touch production, never run anything against Salesforce.
- **Commands:** server tests `npm --workspace services/cti-api test -- <path>`; web tests `npm --workspace apps/cti-web test -- <path>`; typecheck `npm --workspace services/cti-api run typecheck`, `npm --workspace apps/cti-web run typecheck`, `npm --workspace packages/db run typecheck`. Run the whole workspace suite once before the task's final commit.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `services/cti-api/src/salesforce/record-phone.ts` (modify) | Per-record phone lookup; Opportunity branch gains its own-fields query | 1 |
| `services/cti-api/src/salesforce/record-phone.test.ts` (modify) | Lookup tests | 1 |
| `services/cti-api/src/dialer/outcome.ts` (create) | `DialOutcome` union + `isNoConnect` — the one vocabulary every handler shares | 2 |
| `services/cti-api/src/dialer/outcome.test.ts` (create) | Table test for the union | 2 |
| `services/cti-api/src/dialer/amd.ts` (modify) | `AnsweredBy` → `DialOutcome` | 2 |
| `services/cti-api/src/routes/dialer.ts` (modify) | Webhook handlers stamp reasons; `GET` returns `missBreakdown`; create routes stop advancing; new `start` route | 2, 3 |
| `services/cti-api/src/routes/dialer-webhook.test.ts` (modify) | Handler tests | 2 |
| `services/cti-api/src/dialer/engine.ts` (modify) | `handleDialOutcome` takes `DialOutcome`; new `startSession`; `stopSession` skips conference release for `ready` | 2, 3 |
| `services/cti-api/src/dialer/engine.test.ts` (modify) | Reason, start, and stop tests; fake DB honors a session CAS | 2, 3 |
| `services/cti-api/src/dialer/session-store.ts` (modify) | `missBreakdown` beside `skipBreakdown` | 2 |
| `services/cti-api/src/dialer/session-store.test.ts` (modify) | Tally test | 2 |
| `packages/db/migrations/0037_dialer_session_ready.sql` (create) | Adds the enum value | 3 |
| `packages/db/src/schema.ts` (modify) | Drizzle enum gains `ready` | 3 |
| `services/cti-api/src/dialer/create-session.ts` (modify) | Inserts `ready`; loses `createAndStartSession` and the now-unreachable conflict catch | 3 |
| `services/cti-api/src/dialer/create-session.test.ts` (modify) | Creation tests | 3 |
| `apps/cti-web/src/dialer-api.ts` (modify) | Types gain `ready`, `start`, `missBreakdown`, `outcome` | 4 |
| `apps/cti-web/src/components/DialerPanel.tsx` (modify) | Confirm block, miss line, labels, `Checking records…` | 4 |
| `apps/cti-web/src/components/DialerPanel.test.tsx` (modify) | Pure-helper and SSR tests | 4 |
| `apps/cti-web/src/App.tsx` (modify) | Conference join moves from create to Start | 4 |
| `docs/superpowers/plans/2026-09-04-callsign-followups.md` (modify) | Records the out-of-scope follow-ups | 5 |

---

### Task 1: Opportunity phone fields first

**Files:**
- Modify: `services/cti-api/src/salesforce/record-phone.ts:108-124` (the `lookupOpportunity` block)
- Test: `services/cti-api/src/salesforce/record-phone.test.ts`

**Interfaces:**
- Consumes: `soqlToleratingMissingSkipField<T>(userId, withField, withoutField)`, `soqlQuery<T>(userId, soql)`, `SKIP_FIELD`, `PhoneFields`, `FoundRecord` — all already in the file.
- Produces: `export function opportunityPhones(row): PhoneFields` (pure fold of the three fields into the `{ MobilePhone, Phone }` shape the rest of the file dials). `resolveDialNumber`'s signature and return shape do not change, so `create-session.ts` needs no edit.

- [ ] **Step 1: Write the failing tests**

In `services/cti-api/src/salesforce/record-phone.test.ts`, change the import line to also pull `opportunityPhones`:

```ts
import { _resetSkipFieldWarnForTests, choosePhones, opportunityPhones, resolveDialNumber } from './record-phone.js';
```

Replace the test `'resolves an Opportunity via its primary contact'` (currently at lines 37-41) with:

```ts
  it('resolves an Opportunity via its primary contact ONLY when the Opportunity itself has no phone', async () => {
    mockSoql
      .mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: null, Other_Phone__c: null }])
      .mockResolvedValueOnce([{ Contact: { MobilePhone: null, Phone: '213-555-0199' } }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r?.e164).toMatch(/^\+1\d{10}$/);
  });
```

Delete the test `'reads the parent Opportunity checkbox through the contact-role query'` (currently at lines 116-124; it pins the SOQL this task replaces).

Append this describe block at the end of the file:

```ts
describe('resolveDialNumber — Opportunity phone fields (this org stores phones on the Opportunity)', () => {
  /** The SOQL text of the nth query the module issued. */
  const soqlOf = (n: number): string => String(mockSoql.mock.calls[n]?.[1] ?? '');
  beforeEach(() => {
    mockSoql.mockReset();
    _resetSkipFieldWarnForTests();
  });

  it('opportunityPhones folds the three fields in order: primary is the first non-empty, fallback the next', () => {
    expect(opportunityPhones({ Mobile_Phone__c: '213-555-0100', Phone__c: '213-555-0200', Other_Phone__c: '213-555-0300' }))
      .toEqual({ MobilePhone: '213-555-0100', Phone: '213-555-0200' });
    expect(opportunityPhones({ Mobile_Phone__c: '  ', Phone__c: null, Other_Phone__c: '213-555-0300' }))
      .toEqual({ MobilePhone: '213-555-0300', Phone: null });
    expect(opportunityPhones({})).toEqual({ MobilePhone: null, Phone: null });
  });

  it('dials Mobile_Phone__c and never asks the Contact Role when the Opportunity has a number', async () => {
    mockSoql.mockResolvedValueOnce([{ Mobile_Phone__c: '(213) 555-0199', Phone__c: null, Other_Phone__c: null, Skip_on_Dialer__c: false }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false });
    expect(mockSoql).toHaveBeenCalledTimes(1);
    expect(soqlOf(0)).toBe("SELECT Mobile_Phone__c, Phone__c, Other_Phone__c, Skip_on_Dialer__c FROM Opportunity WHERE Id = '006AAA' LIMIT 1");
  });

  it('Phone__c then Other_Phone__c: the second non-empty field is the fallback', async () => {
    mockSoql.mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: '213-555-0100', Other_Phone__c: '213-555-0200' }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550100', fallbackE164: '+12135550200', skipOnDialer: false });
    expect(mockSoql).toHaveBeenCalledTimes(1);
  });

  it('falls back to the primary Contact Role only when all three Opportunity fields are empty', async () => {
    mockSoql
      .mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: '', Other_Phone__c: null, Skip_on_Dialer__c: false }])
      .mockResolvedValueOnce([{ Contact: { MobilePhone: null, Phone: '213-555-0199' } }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false });
    expect(mockSoql).toHaveBeenCalledTimes(2);
    expect(soqlOf(1)).toBe("SELECT Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole WHERE OpportunityId = '006AAA' AND IsPrimary = true LIMIT 1");
  });

  it('reads Skip on Dialer from the Opportunity query; a flagged Opportunity with no number anywhere is found-but-empty', async () => {
    mockSoql
      .mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: null, Other_Phone__c: null, Skip_on_Dialer__c: true }])
      .mockResolvedValueOnce([]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: null, fallbackE164: null, skipOnDialer: true });
  });

  it('a missing Opportunity is null and the Contact Role is never asked', async () => {
    mockSoql.mockResolvedValueOnce([]);
    expect(await resolveDialNumber('u', 'Opportunity', '006AAA')).toBeNull();
    expect(mockSoql).toHaveBeenCalledTimes(1);
  });

  it('retries the Opportunity query without Skip_on_Dialer__c when the org has not got the field', async () => {
    mockSoql
      .mockRejectedValueOnce(new Error('INVALID_FIELD: No such column Skip_on_Dialer__c on entity Opportunity'))
      .mockResolvedValueOnce([{ Mobile_Phone__c: '213-555-0199' }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false });
    expect(soqlOf(1)).toBe("SELECT Mobile_Phone__c, Phone__c, Other_Phone__c FROM Opportunity WHERE Id = '006AAA' LIMIT 1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace services/cti-api test -- src/salesforce/record-phone.test.ts`
Expected: FAIL — `opportunityPhones` is not exported, and the Opportunity tests see the old `OpportunityContactRole` SOQL as the first query.

- [ ] **Step 3: Replace the Opportunity lookup**

In `services/cti-api/src/salesforce/record-phone.ts`, replace the whole `lookupOpportunity` block (the doc comment starting `/** Primary Opportunity Contact Role → Contact phone` through the function's closing brace, lines 108-124) with:

```ts
/** The Opportunity's own phone fields, in dial order. This org stores phones
 *  on the Opportunity — 92% of open Opportunities carry one of these, only 42%
 *  have any Contact Role — so these come first and the Contact Role is the
 *  fallback. Custom fields: a dev org without them fails the lookup loudly
 *  (INVALID_FIELD on the retry too), which is the right answer for an org this
 *  code was never configured for. */
const OPP_PHONE_FIELDS = ['Mobile_Phone__c', 'Phone__c', 'Other_Phone__c'] as const;
type OppPhoneRow = Partial<Record<(typeof OPP_PHONE_FIELDS)[number], string | null>> & {
  Skip_on_Dialer__c?: boolean | null;
};

/** Fold the three Opportunity fields into the two-slot shape the rest of the
 *  lookup dials: primary = the first non-empty in order, fallback = the next
 *  non-empty. Exported for its tests. */
export function opportunityPhones(row: OppPhoneRow): PhoneFields {
  const present = OPP_PHONE_FIELDS.map((f) => row[f]?.trim()).filter((v): v is string => !!v);
  return { MobilePhone: present[0] ?? null, Phone: present[1] ?? null };
}

/** Primary Opportunity Contact Role → Contact phone. Consulted only when the
 *  Opportunity's own fields are all empty; the checkbox was already read from
 *  the Opportunity, so it is not asked for again here. No primary contact role
 *  means there is nothing to dial. */
async function lookupOpportunityContactRole(userId: string, rid: string): Promise<PhoneFields | null> {
  type Row = { Contact?: PhoneFields | null };
  const rows = await soqlQuery<Row>(
    userId,
    `SELECT Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole WHERE OpportunityId = '${rid}' AND IsPrimary = true LIMIT 1`,
  );
  const row = rows[0];
  return row ? row.Contact ?? {} : null;
}

/** The Opportunity's own fields first (with its Skip on Dialer checkbox in the
 *  same round trip, tolerating an org without the field exactly as the Lead
 *  branch does); the primary Contact Role's phone only when all three are
 *  empty. A missing Opportunity is null; one with no number anywhere is
 *  found-but-empty, so the queue still honors its checkbox. */
async function lookupOpportunity(userId: string, rid: string): Promise<FoundRecord | null> {
  const fields = OPP_PHONE_FIELDS.join(', ');
  const rows = await soqlToleratingMissingSkipField<OppPhoneRow>(
    userId,
    `SELECT ${fields}, ${SKIP_FIELD} FROM Opportunity WHERE Id = '${rid}' LIMIT 1`,
    `SELECT ${fields} FROM Opportunity WHERE Id = '${rid}' LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  const skipOnDialer = row.Skip_on_Dialer__c === true;
  const own = opportunityPhones(row);
  if (own.MobilePhone) return { fields: own, skipOnDialer };
  const contact = await lookupOpportunityContactRole(userId, rid);
  return { fields: contact ?? {}, skipOnDialer };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace services/cti-api test -- src/salesforce/record-phone.test.ts`
Expected: PASS, every test in the file (the Lead, Contact, and Skip-on-Dialer tests are unchanged and must still pass).

- [ ] **Step 5: Typecheck and commit**

Run: `npm --workspace services/cti-api run typecheck`
Expected: clean.

```bash
git add services/cti-api/src/salesforce/record-phone.ts services/cti-api/src/salesforce/record-phone.test.ts
git commit -m "feat(dialer): resolve Opportunity phones from the Opportunity's own fields before the Contact Role"
```

---

### Task 2: Honest miss outcomes (server)

**Files:**
- Create: `services/cti-api/src/dialer/outcome.ts`
- Create: `services/cti-api/src/dialer/outcome.test.ts`
- Modify: `services/cti-api/src/dialer/amd.ts` (whole file)
- Modify: `services/cti-api/src/routes/dialer.ts:74-118` (`TERMINAL_NO_CONNECT_STATUSES`, `onDialerAmd`, `onDialerStatus`), imports at `:44-46`, and the `GET /dialer/sessions/:id` return object (`:283-297`)
- Modify: `services/cti-api/src/routes/dialer-webhook.test.ts`
- Modify: `services/cti-api/src/dialer/engine.ts:305-309` (signature) and the comment at `:337-344`
- Modify: `services/cti-api/src/dialer/engine.test.ts` (append a describe)
- Modify: `services/cti-api/src/dialer/session-store.ts` (add `missBreakdown`)
- Modify: `services/cti-api/src/dialer/session-store.test.ts`

**Interfaces:**
- Consumes: `handleDialOutcome(callId, outcome, deps)` in `engine.ts`; `EngineDeps.telephony.hangup(callSid)`; `skipBreakdown(items)` in `session-store.ts`.
- Produces: `export type DialOutcome` and `export function isNoConnect(outcome: DialOutcome): boolean` in `dialer/outcome.ts`; `mapAnsweredBy(answeredBy): Extract<DialOutcome, 'connected' | 'voicemail' | 'fax'>`; `export function missBreakdown(items: Array<Pick<DialerItem, 'status' | 'outcome'>>): Record<string, number>`; `GET /dialer/sessions/:id` gains `missBreakdown`. Task 4 reads `missBreakdown` and the row's `outcome`.

- [ ] **Step 1: Write the failing test for the outcome vocabulary**

Create `services/cti-api/src/dialer/outcome.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isNoConnect, type DialOutcome } from './outcome.js';

const EVERY_OUTCOME: DialOutcome[] = ['connected', 'no_answer', 'voicemail', 'fax', 'busy', 'failed', 'canceled', 'hangup'];

describe('isNoConnect', () => {
  it('is false only for connected (bridge the rep) and no_answer (try the fallback number)', () => {
    expect(EVERY_OUTCOME.filter((o) => !isNoConnect(o))).toEqual(['connected', 'no_answer']);
  });
  it('is true for every plain miss', () => {
    expect(EVERY_OUTCOME.filter(isNoConnect)).toEqual(['voicemail', 'fax', 'busy', 'failed', 'canceled', 'hangup']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --workspace services/cti-api test -- src/dialer/outcome.test.ts`
Expected: FAIL — cannot find module `./outcome.js`.

- [ ] **Step 3: Create the vocabulary**

Create `services/cti-api/src/dialer/outcome.ts`:

```ts
/**
 * What one power-dial call came to. `connected` bridges the rep; `no_answer`
 * (the number rang out) is the only miss that earns a try of the record's
 * fallback number; every other value is a plain miss the engine records as a
 * `no_connect` row, keeping the reason in the row's text `outcome` column so a
 * rep can tell a list of voicemails from a list of dead numbers.
 */
export type DialOutcome =
  | 'connected'
  | 'no_answer'
  | 'voicemail'
  | 'fax'
  | 'busy'
  | 'failed'
  | 'canceled'
  | 'hangup';

/** A miss that neither bridged the rep nor earns the fallback number. */
export function isNoConnect(outcome: DialOutcome): boolean {
  return outcome !== 'connected' && outcome !== 'no_answer';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --workspace services/cti-api test -- src/dialer/outcome.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing webhook-handler tests**

In `services/cti-api/src/routes/dialer-webhook.test.ts`, replace everything from `describe('onDialerAmd', () => {` to the end of the file with:

```ts
describe('onDialerAmd', () => {
  it('AnsweredBy=machine_start stamps voicemail BEFORE hanging up, so the completed-status backstop finds the row settled', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'machine_start' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'voicemail', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    const hangup = deps.telephony.hangup as unknown as { mock: { invocationCallOrder: number[] } };
    expect(runHandleDialOutcome.mock.invocationCallOrder[0]!).toBeLessThan(hangup.mock.invocationCallOrder[0]!);
  });

  it('AnsweredBy=machine_end_beep is voicemail too (every machine_* verdict)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'machine_end_beep' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'voicemail', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
  });

  it('AnsweredBy=fax stamps fax and hangs up', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'fax' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'fax', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
  });

  it('still hangs up a machine when stamping the outcome throws (the call must not play out its 30s hold)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => { throw new Error('db down'); });
    await expect(onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'machine_start' }, deps, runHandleDialOutcome)).rejects.toThrow('db down');
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
  });

  it('AnsweredBy=human does NOT hang up and reports connected', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1', AnsweredBy: 'human' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'connected', deps);
  });

  it('AnsweredBy=unknown (or missing) does NOT hang up and reports connected (bias to human)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerAmd({ CallSid: 'CA1' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'connected', deps);
  });
});

describe('onDialerStatus', () => {
  it('CallStatus=no-answer reports no_answer (the only fallback-eligible miss)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', CallStatus: 'no-answer' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'no_answer', deps);
  });

  it.each([
    ['busy', 'busy'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
    ['completed', 'hangup'],
  ])('CallStatus=%s stamps %s (a plain miss — never falls back to the Phone)', async (status, reason) => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', CallStatus: status }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', reason, deps);
  });

  it('falls back to DialCallStatus when CallStatus is absent (no-answer → no_answer)', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', DialCallStatus: 'no-answer' }, deps, runHandleDialOutcome);
    expect(runHandleDialOutcome).toHaveBeenCalledWith('CA1', 'no_answer', deps);
  });

  it.each(['queued', 'ringing', 'in-progress', 'initiated', ''])(
    'a non-terminal status (%s) is a no-op — AMD/connect owns that transition',
    async (status) => {
      const deps = fakeDeps();
      const runHandleDialOutcome = vi.fn(async () => {});
      await onDialerStatus({ CallSid: 'CA1', CallStatus: status }, deps, runHandleDialOutcome);
      expect(runHandleDialOutcome).not.toHaveBeenCalled();
    },
  );

  it('never touches telephony directly — status alone drives the miss, no hangup needed', async () => {
    const deps = fakeDeps();
    const runHandleDialOutcome = vi.fn(async () => {});
    await onDialerStatus({ CallSid: 'CA1', CallStatus: 'busy' }, deps, runHandleDialOutcome);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm --workspace services/cti-api test -- src/routes/dialer-webhook.test.ts`
Expected: FAIL — the handlers still report `no_connect`, and `completed` is ignored.

- [ ] **Step 7: Rewrite `amd.ts` and the two handlers**

Replace the whole of `services/cti-api/src/dialer/amd.ts` with:

```ts
import type { DialOutcome } from './outcome.js';

/** Map Twilio AMD AnsweredBy → dialer outcome. Bias to human: only an explicit
 *  machine/fax verdict is a miss; unknown/undefined counts as a live human. */
export function mapAnsweredBy(answeredBy: string | undefined): Extract<DialOutcome, 'connected' | 'voicemail' | 'fax'> {
  const a = (answeredBy ?? '').toLowerCase();
  if (a.startsWith('machine')) return 'voicemail';
  if (a === 'fax') return 'fax';
  return 'connected';
}
```

In `services/cti-api/src/routes/dialer.ts`, add to the imports (next to the `mapAnsweredBy` import at line 46):

```ts
import { isNoConnect, type DialOutcome } from '../dialer/outcome.js';
```

and change the `session-store` import at line 44 to:

```ts
import { sessionCounts, skipBreakdown, missBreakdown, rolloverSummary } from '../dialer/session-store.js';
```

Replace the block from `/** Terminal Twilio call statuses that mean the recipient never connected. */` through the end of `onDialerStatus` (lines 74-118) with:

```ts
/**
 * Terminal Twilio call statuses and the reason each stamps on a still-`dialing`
 * item. `completed` is the one that needs care: it fires for EVERY ended call.
 * A bridged conversation the rep finished is `connected` by then, and a machine
 * AMD hung up is `no_connect` by then (see onDialerAmd's ordering) — the engine
 * no-ops both. What remains is a `dialing` item whose call ended: the callee
 * answered and hung up before AMD classified. Before this mapping that item
 * stayed `dialing` forever and the run waited on it until the rep pressed Skip.
 */
const STATUS_OUTCOMES: Record<string, DialOutcome> = {
  'no-answer': 'no_answer',
  busy: 'busy',
  failed: 'failed',
  canceled: 'canceled',
  completed: 'hangup',
};

/**
 * Async-AMD callback handler: classify `AnsweredBy`, let the engine act on the
 * outcome (bridge-to-rep on connect; requeue/rollover + advance on a miss), and
 * hang up a machine/fax (a human never picked up). Extracted from the route so
 * it is unit-testable without a live Fastify request — `runHandleDialOutcome`
 * defaults to the real `handleDialOutcome` but tests inject a spy.
 *
 * The outcome is recorded BEFORE the hangup on purpose. Hanging up makes
 * Twilio send the `completed` status callback, and if that arrived while this
 * handler was still awaiting the hangup, the status backstop below would find
 * the item still `dialing` and stamp `hangup` over the voicemail/fax verdict.
 * Stamped first, the backstop finds the row already settled and does nothing.
 * The hangup runs even if stamping throws: a machine left alone plays the
 * 30-second hold TwiML and bills for it.
 */
export async function onDialerAmd(
  body: Record<string, string>,
  deps: EngineDeps,
  runHandleDialOutcome: typeof handleDialOutcome = handleDialOutcome,
): Promise<void> {
  const callSid = body.CallSid ?? '';
  const outcome = mapAnsweredBy(body.AnsweredBy);
  try {
    await runHandleDialOutcome(callSid, outcome, deps);
  } finally {
    if (isNoConnect(outcome)) await deps.telephony.hangup(callSid);
  }
}

/**
 * Call-status callback handler: a terminal status without ever reaching AMD
 * stamps its reason (see STATUS_OUTCOMES). Idempotent by construction —
 * `handleDialOutcome` no-ops for any item that isn't still 'dialing', so a
 * call AMD already classified is a harmless no-op here and its reason stands.
 */
export async function onDialerStatus(
  body: Record<string, string>,
  deps: EngineDeps,
  runHandleDialOutcome: typeof handleDialOutcome = handleDialOutcome,
): Promise<void> {
  const callSid = body.CallSid ?? '';
  const status = body.CallStatus ?? body.DialCallStatus ?? '';
  const outcome = STATUS_OUTCOMES[status];
  if (outcome) await runHandleDialOutcome(callSid, outcome, deps);
}
```

Also update the header comment lines 15-16 of the file to:

```ts
 *  POST /telephony/twilio/dialer-amd    → async AMD result → stamp voicemail/fax + hangup, or bridge a human
 *  POST /telephony/twilio/dialer-status → terminal call status → stamp its reason (idempotent backstop)
```

- [ ] **Step 8: Widen the engine's outcome type**

In `services/cti-api/src/dialer/engine.ts`, add to the imports:

```ts
import type { DialOutcome } from './outcome.js';
```

Change the `handleDialOutcome` signature (line 305-309) to:

```ts
export async function handleDialOutcome(
  callId: string,
  outcome: DialOutcome,
  deps: EngineDeps,
): Promise<void> {
```

Replace the comment sentence at lines 342-344 (`// very next call, through the normal pool-DID + attempt-count path. Only a` … `// mapped to 'no_connect' by the webhook handlers and never fall back.`) with:

```ts
  // very next call, through the normal pool-DID + attempt-count path. Only a
  // 'no_answer' outcome reaches here: voicemail / fax / busy / failed /
  // canceled / hangup are plain misses (see dialer/outcome.ts) that never
  // fall back — the row below becomes 'no_connect' with that reason in
  // `outcome`, and the decision here does not read the reason.
```

- [ ] **Step 9: Run the handler and engine tests**

Run: `npm --workspace services/cti-api test -- src/routes/dialer-webhook.test.ts src/dialer/engine.test.ts`
Expected: PASS — the webhook file entirely; every existing engine test unchanged (the engine's decision never depended on the reason).

- [ ] **Step 10: Write the failing engine tests for the reasons**

Append to `services/cti-api/src/dialer/engine.test.ts`:

```ts
describe('handleDialOutcome — honest miss reasons', () => {
  beforeEach(() => { _target = {}; });
  const dialing = (over: Record<string, unknown> = {}) => [{
    id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead',
    callId: 'CA1', attempt: 2, primaryNumber: '+16195550100', secondaryNumber: null, followupEligible: true, ...over,
  }];

  it.each(['voicemail', 'fax', 'busy', 'failed', 'canceled', 'hangup'] as const)(
    '%s settles the row as no_connect with that reason in `outcome`',
    async (reason) => {
      const deps = makeDeps(); const fdb = fakeDb(baseSession, dialing()); deps.db = fdb;
      await handleDialOutcome('CA1', reason, deps);
      expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: reason }) });
    },
  );

  it('a voicemail with a fallback number still untried is a MISS — only no_answer earns the fallback', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, dialing({ fallbackNumber: '+16195550200', attempt: 1 })); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'pending', toNumber: '+16195550200' }) });
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: 'voicemail' }) });
  });

  it('no_answer with a fallback number still swaps the fallback in (unchanged)', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, dialing({ fallbackNumber: '+16195550200', attempt: 1 })); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_answer', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'pending', toNumber: '+16195550200', fallbackNumber: null }) });
  });

  it('the status backstop never overwrites a settled row: a hangup for a call AMD already stamped writes nothing', async () => {
    const deps = makeDeps();
    const fdb = fakeDb(baseSession, dialing({ status: 'no_connect', outcome: 'voicemail' })); deps.db = fdb;
    await handleDialOutcome('CA1', 'hangup', deps);
    expect(fdb._writes).toEqual([]);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Run them**

Run: `npm --workspace services/cti-api test -- src/dialer/engine.test.ts`
Expected: PASS. (These pass against the widened signature from Step 8 with no further engine change — that is the point: the reason rides through untouched. If any of them fails, the engine is reading the reason somewhere it must not.)

- [ ] **Step 12: Write the failing `missBreakdown` test**

In `services/cti-api/src/dialer/session-store.test.ts`, change the import to:

```ts
import { missBreakdown, rolloverSummary, sessionCounts, skipBreakdown } from './session-store.js';
```

and append:

```ts
describe('missBreakdown', () => {
  it('counts no_connect rows per reason and ignores every other status', () => {
    expect(missBreakdown([
      { status: 'no_connect', outcome: 'voicemail' },
      { status: 'no_connect', outcome: 'voicemail' },
      { status: 'no_connect', outcome: 'no_answer' },
      { status: 'no_connect', outcome: null },
      { status: 'skipped', outcome: 'already_worked' },
      { status: 'done', outcome: 'connected' },
    ])).toEqual({ voicemail: 2, no_answer: 1, other: 1 });
  });
  it('is empty for a run with no misses', () => {
    expect(missBreakdown([{ status: 'pending', outcome: null }])).toEqual({});
  });
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `npm --workspace services/cti-api test -- src/dialer/session-store.test.ts`
Expected: FAIL — `missBreakdown` is not exported.

- [ ] **Step 14: Add `missBreakdown`**

In `services/cti-api/src/dialer/session-store.ts`, replace the `skipBreakdown` function (its doc comment through its closing brace) with:

```ts
/** Per-outcome tally of the rows in one status. A null/unrecognized outcome
 *  counts as 'other' so the tally's total always matches that status's count
 *  in `sessionCounts(items)`. */
function tallyOutcomes(
  items: Array<Pick<DialerItem, 'status' | 'outcome'>>,
  status: DialerItem['status'],
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const it of items) {
    if (it.status !== status) continue;
    const key = it.outcome ?? 'other';
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  return breakdown;
}

/** Per-outcome tally of skipped rows only — what a rep inherited when the run
 *  started (already worked today, flagged skip, consent-blocked, etc). */
export function skipBreakdown(items: Array<Pick<DialerItem, 'status' | 'outcome'>>): Record<string, number> {
  return tallyOutcomes(items, 'skipped');
}

/** Per-reason tally of no_connect rows — what the run's misses actually were
 *  (voicemail, no_answer, busy, failed, …; see dialer/outcome.ts). Attempt-2
 *  retries that miss again count as their own row, like every other miss. */
export function missBreakdown(items: Array<Pick<DialerItem, 'status' | 'outcome'>>): Record<string, number> {
  return tallyOutcomes(items, 'no_connect');
}
```

In `services/cti-api/src/routes/dialer.ts`, in the `GET /dialer/sessions/:id` return object, add one line directly after `skipBreakdown: skipBreakdown(items),`:

```ts
      missBreakdown: missBreakdown(items),
```

- [ ] **Step 15: Run everything for this task**

Run: `npm --workspace services/cti-api test -- src/dialer src/routes/dialer-webhook.test.ts && npm --workspace services/cti-api run typecheck`
Expected: PASS and clean.

- [ ] **Step 16: Commit**

```bash
git add services/cti-api/src/dialer/outcome.ts services/cti-api/src/dialer/outcome.test.ts services/cti-api/src/dialer/amd.ts services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/dialer-webhook.test.ts services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts services/cti-api/src/dialer/session-store.ts services/cti-api/src/dialer/session-store.test.ts
git commit -m "feat(dialer): stamp the real miss reason (voicemail/busy/failed/hangup) and report a miss breakdown"
```

**Reviewer note for this task (mutation check the spec asks for):** with the diff applied, temporarily change every reason the handlers pass to `'busy'` (or any single value) — every `engine.test.ts` transition test other than the new reason-stamping `it.each` must still pass. That proves the engine's decision does not depend on the reason. Revert before reporting.

---

### Task 3: Sessions start `ready`; `start` dials

**Files:**
- Create: `packages/db/migrations/0037_dialer_session_ready.sql`
- Modify: `packages/db/src/schema.ts:48`
- Modify: `services/cti-api/src/dialer/create-session.ts:14-21` (conflict helper), `:176-259` (`createDialerSession` insert + conflict catch, `createAndStartSession`)
- Modify: `services/cti-api/src/dialer/create-session.test.ts`
- Modify: `services/cti-api/src/dialer/engine.ts` (new `startSession`, `stopSession` guard, `advanceSession` comment)
- Modify: `services/cti-api/src/dialer/engine.test.ts` (fake DB session CAS, `startSession` + `stopSession` tests)
- Modify: `services/cti-api/src/routes/dialer.ts` (imports, both create routes, new `start` route, header comment)

**Interfaces:**
- Consumes: `createDialerSession(deps, args): Promise<{ sessionId, total }>`; `advanceSession(sessionId, deps)`; `requireOwnedSession(req, reply)` → `{ authed, session } | null`; `requirePowerDialer(authed, reply)`; `buildEngineDeps()`.
- Produces: `export async function startSession(sessionId: string, deps: EngineDeps): Promise<ReturnType<typeof advanceSession> | { action: Session['status'] | 'idle' | 'conflict' }>`; `POST /dialer/sessions/:id/start` → `{ ok: true, ...result }` or `409 { error }`. `POST /dialer/sessions` and `/from-listview` keep their response shapes but the session comes back `ready`. Task 4 calls `start`.

- [ ] **Step 1: Add the migration and the enum value**

Create `packages/db/migrations/0037_dialer_session_ready.sql`:

```sql
-- =============================================================================
-- 0037_dialer_session_ready.sql — a power-dial session is created 'ready'
-- (queue built, nothing dialed) and only becomes 'active' when the rep presses
-- Start dialing. Additive enum value in a file of its own: Postgres refuses to
-- USE a new enum value in the transaction that added it, so no row may be
-- written as 'ready' until this file has committed on its own.
-- Spec: docs/superpowers/specs/2026-09-10-power-dialer-ship-design.md §3
-- =============================================================================

ALTER TYPE dialer_session_status ADD VALUE IF NOT EXISTS 'ready';
```

In `packages/db/src/schema.ts` line 48, change the enum to:

```ts
export const dialerSessionStatus = pgEnum('dialer_session_status', ['ready', 'active', 'paused', 'stopped', 'done']);
```

Leave the column default (`'active'`) alone: every insert passes `status` explicitly, and the default is not what this change is about.

Run: `npm --workspace packages/db run typecheck && npm --workspace packages/db test`
Expected: clean and PASS.

- [ ] **Step 2: Write the failing creation tests**

In `services/cti-api/src/dialer/create-session.test.ts`:

Change the import at line 3 to:

```ts
import { buildQueueRows, createDialerSession } from './create-session.js';
```

Delete the `conflictDb` helper (lines 9-17) — the catch it exercised is removed below.

Replace the whole `describe('createAndStartSession', …)` block (lines 144-166) with:

```ts
describe('createDialerSession — nothing dials at creation', () => {
  it('inserts the session READY: the engine ignores anything not active, so the queue sits until the rep presses Start', async () => {
    const db = fakeDb();
    const result = await createDialerSession({ ...noResolveDeps, db: db as never }, args);
    expect(db._sessionInsert).toMatchObject({ userId: 'u1', orgId: 'o1', objectType: 'Lead', status: 'ready' });
    expect(result).toEqual({ sessionId: 'S1', total: 1 });
  });
});
```

Delete the whole `describe('createDialerSession — one active session per rep', …)` block (lines 168-192): with `ready` inserts the partial unique index on `status = 'active'` can no longer fire at creation; the conflict moves to `startSession` (tested in `engine.test.ts` below).

The three tests that still call `createAndStartSession` (`'leaves the flagged row out of what the engine\'s first advance can pick'` near line 265, `'a run whose every number was worked today builds an all-skipped queue and still kicks the engine'` near line 371, and `'a run whose every number is consent-blocked builds an all-skipped queue and still kicks the engine'` near line 549) each change the same way — for example the first becomes:

```ts
  it('leaves the flagged row out of what the engine\'s first advance can pick', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverFor(new Set(['00Q1']))) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] },
    );
```

i.e. drop the `const advance = vi.fn()…` line, drop `advance` from the deps object, call `createDialerSession` instead, and delete the `expect(advance).toHaveBeenCalledWith('S1');` line that follows. Rename the two `…and still kicks the engine` titles to `…and still creates the run` (the row assertions that follow each one stay exactly as they are).

- [ ] **Step 3: Run them to verify they fail**

Run: `npm --workspace services/cti-api test -- src/dialer/create-session.test.ts`
Expected: FAIL — the insert still says `status: 'active'`.

- [ ] **Step 4: Change creation**

In `services/cti-api/src/dialer/create-session.ts`:

Delete lines 16-21 (`/** Postgres unique-violation … */`, `const ACTIVE_SESSION_INDEX`, and `function isActiveSessionConflict`) — they move to `engine.ts` in Step 7.

Replace the body of `createDialerSession` from `let session: typeof schema.dialerSessions.$inferSelect | undefined;` through the closing `}` of the `catch` (lines 181-202) with:

```ts
  // Created READY: the queue is built and nothing dials. `advanceSession`
  // ignores any session that is not 'active', so a ready session cannot
  // originate by construction; only `startSession` (the rep's Start dialing)
  // flips it. That is also why no unique-index conflict is handled here any
  // more — the one-active-run-per-rep index fires on the flip, not the insert.
  const [session] = await deps.db
    .insert(schema.dialerSessions)
    .values({ orgId: args.orgId, userId: args.userId, sfOwnerId, objectType: args.objectType, status: 'ready' })
    .returning();
```

Delete `createAndStartSession` and its doc comment (everything from `/**` at line 240 to the end of the file), then re-check the two `session!.id` references left in the function still read `session!.id` (they do; `session` is now a `const` from destructuring and stays non-null by the `.returning()` contract).

Delete `import { and, eq } from 'drizzle-orm';` at the top of the file: its only two uses were inside the conflict branch just removed (`tsc` will not flag it — `noUnusedLocals` is off — so grep the file to be sure nothing else references `and(` or `eq(`).

- [ ] **Step 5: Run the creation tests**

Run: `npm --workspace services/cti-api test -- src/dialer/create-session.test.ts && npm --workspace services/cti-api run typecheck`
Expected: PASS; typecheck FAILS only in `routes/dialer.ts` (still imports `createAndStartSession`) — fixed in Step 9.

- [ ] **Step 6: Write the failing engine tests**

In `services/cti-api/src/dialer/engine.test.ts`, first teach the fake DB about a session compare-and-swap. Find the outer `update(_tbl)` stub's `returning` (the one commented `// Guarded \`UPDATE ... WHERE id = $1 AND status = 'pending' RETURNING id\``) and replace its body:

```ts
              returning: async () => {
                const { sql: text, params } = new PgDialect().sqlToQuery(w);
                if (/"status" =/.test(text)) {
                  if (_tbl === schema.dialerSessions) {
                    // startSession's `WHERE id = $1 AND status = 'ready'` flip:
                    // honor it against the fake's CURRENT session status so a
                    // second Start (session already active) claims 0 rows.
                    const current = { ...session, ...sessionOverride };
                    if (!params.includes(current.id) || !params.includes(current.status)) return [];
                  } else {
                    const target = items.find((i: any) => params.includes(i.id));
                    if (!target || target.status !== 'pending') return [];
                  }
                }
                apply();
                return [{ id: 'updated' }];
              },
```

Add `startSession` to the engine import list near line 205-212, then append:

```ts
describe('startSession — the rep pressed Start dialing', () => {
  beforeEach(() => { _target = {}; });
  const ready = { ...baseSession, status: 'ready' };
  const pending = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];

  it('flips ready → active, then originates the first call', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, pending); deps.db = fdb;
    const r = await startSession('S1', deps);
    expect(fdb._writes[0]).toEqual({ patch: expect.objectContaining({ status: 'active' }) });
    expect(deps.telephony.originate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ action: 'dialing' });
  });

  it('is idempotent: a second Start finds the session active, originates nothing, and reports the status it found', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    expect(await startSession('S1', deps)).toEqual({ action: 'active' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([]);
  });

  it('never revives a stopped session', async () => {
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, pending); deps.db = fdb;
    expect(await startSession('S1', deps)).toEqual({ action: 'stopped' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });

  it('reports conflict — and leaves the session ready — when the rep already has an active run', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, pending); deps.db = fdb;
    const violation = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505', constraint: 'dialer_sessions_one_active_per_user',
    });
    fdb.update = () => ({ set: () => ({ where: () => ({ returning: async () => { throw violation; } }) }) });
    expect(await startSession('S1', deps)).toEqual({ action: 'conflict' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });

  it('rethrows any other database error', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, pending); deps.db = fdb;
    fdb.update = () => ({ set: () => ({ where: () => ({ returning: async () => { throw new Error('connection reset'); } }) }) });
    await expect(startSession('S1', deps)).rejects.toThrow('connection reset');
  });
});
```

And inside the existing `describe('stopSession', …)` block, add:

```ts
  it('a ready session (never started) stops with only the status written — no hangup, no conference release, no rollover', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'ready' }, items); deps.db = fdb;
    expect(await stopSession('S1', deps)).toEqual({ action: 'stopped' });
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(deps.telephony.endConference).not.toHaveBeenCalled();
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([{ patch: expect.objectContaining({ status: 'stopped' }) }]);
  });
```

- [ ] **Step 7: Run them to verify they fail, then implement the engine**

Run: `npm --workspace services/cti-api test -- src/dialer/engine.test.ts`
Expected: FAIL — `startSession` is not exported; the ready-stop test sees `endConference` called.

In `services/cti-api/src/dialer/engine.ts`, insert directly above `export async function advanceSession(`:

```ts
/** Postgres unique-violation on the one-active-session-per-rep partial index
 *  (`dialer_sessions_one_active_per_user`, migration 0022). It fires on the
 *  ready → active flip below, which is the only place a session becomes
 *  'active' now that creation inserts 'ready'. */
const ACTIVE_SESSION_INDEX = 'dialer_sessions_one_active_per_user';
function isActiveSessionConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === ACTIVE_SESSION_INDEX;
}

/** The `ready → active` compare-and-swap. 'lost' = 0 rows matched (the session
 *  is not ready — a second Start, or a stopped run); 'conflict' = the rep has
 *  another active run and the unique index refused the flip. */
async function claimReadySession(deps: EngineDeps, sessionId: string): Promise<'claimed' | 'lost' | 'conflict'> {
  try {
    const rows = await deps.db
      .update(schema.dialerSessions)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(schema.dialerSessions.id, sessionId), eq(schema.dialerSessions.status, 'ready')))
      .returning({ id: schema.dialerSessions.id });
    return rows.length > 0 ? 'claimed' : 'lost';
  } catch (err) {
    if (isActiveSessionConflict(err)) return 'conflict';
    throw err;
  }
}

/**
 * The rep pressed Start dialing on a `ready` session: flip it to `active` and
 * originate the first call. This is the ONE place a run begins — a session is
 * created `ready`, and nothing else moves it (`resumeSession` needs `paused`,
 * `repNext` needs a connected item, the webhooks need a dial that started).
 *
 * Compare-and-swap on status, so a double-submitted Start (two tabs, a retry)
 * advances exactly once: the loser matches 0 rows and just reports the status
 * it finds. The partial unique index still enforces one active run per rep:
 * if another of the rep's sessions is active the flip is refused, THIS session
 * stays `ready`, and the caller gets `conflict` to explain to the rep.
 */
export async function startSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<ReturnType<typeof advanceSession> | { action: Session['status'] | 'idle' | 'conflict' }> {
  const claim = await claimReadySession(deps, sessionId);
  if (claim === 'conflict') return { action: 'conflict' };
  if (claim === 'lost') {
    const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
    return { action: session?.status ?? 'idle' };
  }
  return advanceSession(sessionId, deps);
}
```

In `stopSession`, replace the line `if (session) await releaseRepConference(deps, session.userId, sessionId);` and the comment above it with:

```ts
  // Released before the status flip, for the same cross-run reason as
  // advanceSession. A `ready` session never joined a conference — and the
  // conference name is rep-scoped, so releasing it here could end a DIFFERENT
  // run the rep has active in another tab (the very case that leaves a second
  // session stuck `ready`).
  if (session && session.status !== 'ready') await releaseRepConference(deps, session.userId, sessionId);
```

- [ ] **Step 8: Run the engine tests**

Run: `npm --workspace services/cti-api test -- src/dialer/engine.test.ts`
Expected: PASS, whole file.

- [ ] **Step 9: Rewire the routes**

In `services/cti-api/src/routes/dialer.ts`:

Change the import at line 30 to:

```ts
import { createDialerSession } from '../dialer/create-session.js';
```

Add `startSession,` to the `../dialer/engine.js` import list (lines 33-42), and remove `advanceSession` from that list — its only two uses were the create routes rewritten below.

In `POST /dialer/sessions/from-listview`, replace the `createAndStartSession(` call through its closing `);` with:

```ts
    const result = await createDialerSession(
      {
        resolveDialNumber, fetchTasks, salesforceUserId, db,
        workedToday: (orgId, numbers) => workedTodaySafe(db, orgId, numbers),
        consentBlocked: (orgId, numbers) => blockedTargetsSafe(db, orgId, numbers),
      },
      { userId: authed.userId, orgId: authed.orgId, objectType: object, recordIds },
    );
    return { ...result, recordCount: recordIds.length };
```

In `POST /dialer/sessions`, likewise:

```ts
    const db = getDb();
    const result = await createDialerSession(
      {
        resolveDialNumber, fetchTasks, salesforceUserId, db,
        workedToday: (orgId, numbers) => workedTodaySafe(db, orgId, numbers),
        consentBlocked: (orgId, numbers) => blockedTargetsSafe(db, orgId, numbers),
      },
      {
        userId: authed.userId,
        orgId: authed.orgId,
        objectType: parsed.data.objectType,
        recordIds: parsed.data.recordIds,
      },
    );
    return result;
```

Directly above `app.post('/dialer/sessions/:id/pause', …)` add:

```ts
  // The rep confirmed the list. Gated like the create routes — Start is the
  // moment calls go out, so a rep whose grant was revoked at the confirm block
  // must not be able to dial. (pause/skip/stop/next stay ungated so a mid-run
  // revoke never strands an in-flight run.)
  app.post('/dialer/sessions/:id/start', async (req, reply) => {
    const owned = await requireOwnedSession(req, reply);
    if (!owned) return;
    if (!requirePowerDialer(owned.authed, reply)) return reply;
    const result = await startSession(owned.session.id, buildEngineDeps());
    if (result.action === 'conflict') {
      return reply.code(409).send({ error: 'Another power-dial run is already active for you — finish or stop it first.' });
    }
    return { ok: true, ...result };
  });
```

Update the header comment: change line 4 to `*  POST /dialer/sessions              → create a READY session over a Lead/Opportunity/Task id list (nothing dials yet)` and insert after it `*  POST /dialer/sessions/:id/start    → ready → active, then originate the first call (idempotent; 409 if another run is active)`.

- [ ] **Step 10: Full server suite, typecheck, commit**

Run: `npm --workspace services/cti-api test && npm --workspace services/cti-api run typecheck && npm --workspace packages/db run typecheck`
Expected: PASS and clean. `grep -rn createAndStartSession services/cti-api/src` must print nothing.

```bash
git add packages/db/migrations/0037_dialer_session_ready.sql packages/db/src/schema.ts services/cti-api/src/dialer/create-session.ts services/cti-api/src/dialer/create-session.test.ts services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts services/cti-api/src/routes/dialer.ts
git commit -m "feat(dialer): sessions are created ready; a new start action flips them active and dials"
```

---

### Task 4: Confirm block, miss line, labels (web)

**Files:**
- Modify: `apps/cti-web/src/dialer-api.ts:14-49`
- Modify: `apps/cti-web/src/components/DialerPanel.tsx` (helpers at `:52-73`, `dotClassForItemStatus` at `:158-163`, props at `:165-197`, `CurrentRecord` at `:196-209`, picker button at `:289`, the session effect at `:325-397`, and the render from `:426` to the end)
- Modify: `apps/cti-web/src/components/DialerPanel.test.tsx`
- Modify: `apps/cti-web/src/App.tsx:582-645` (`beginRun`, `startPowerDial`, `startPowerDialFromListView`), the handoff-poll comment at `:748-753`, and the panel props at `:1245-1253`

**Interfaces:**
- Consumes: `GET /dialer/sessions/:id` now returns `session.status` possibly `ready` plus `missBreakdown`; `POST /dialer/sessions/:id/start` (Task 3); the row's `outcome` on `currentItem`.
- Produces: `DialerControlAction` gains `'start'`; `DialerPanelProps.onStart: () => Promise<boolean>` (the parent joins the softphone to the run's conference and resolves `true` when the leg is up, `false` if the run was superseded meanwhile; the panel sends `start` only on `true`); exported pure helpers `queueParts`, `confirmLine`, `missLine`, `itemStatusLabel`, `startDialingSequence`, and the `ConfirmBlock` component.

- [ ] **Step 1: Types**

In `apps/cti-web/src/dialer-api.ts`:

Add to `DialerCurrentItem` (after `fromNumber`):

```ts
  /** Why a miss missed — voicemail, no_answer, busy, failed, … (server
   *  `dialer/outcome.ts`). Set once the row settles; null while dialing. */
  outcome?: string | null;
```

Change `DialerSession.status` to:

```ts
  status: 'ready' | 'active' | 'paused' | 'stopped' | 'done';
```

Add to `DialerSessionView` (after `skipBreakdown`):

```ts
  /** Per-reason tally of no_connect rows (server `session-store.ts#missBreakdown`). */
  missBreakdown?: Record<string, number>;
```

Change the control action type to:

```ts
export type DialerControlAction = 'start' | 'pause' | 'resume' | 'skip' | 'stop' | 'next';
```

Change the doc comment above `startDialerFromListView` to `/** Pull a Salesforce list view's records and create a READY run over them — nothing dials until dialerControl(id, 'start'). */`, and add the same sentence as a comment above `startDialer`.

Run: `npm --workspace apps/cti-web run typecheck`
Expected: clean (nothing consumes the new members yet).

- [ ] **Step 2: Write the failing pure-helper tests**

In `apps/cti-web/src/components/DialerPanel.test.tsx`, extend the import from `./DialerPanel` with `confirmLine, missLine, itemStatusLabel, startDialingSequence, ConfirmBlock,` and change every `onStart={() => {}}` in the file (four places) to `onStart={async () => true}`. Then append:

```ts
describe('confirmLine — the confirm block before the first ring', () => {
  it('reads like the spec example: dialable count first, then what is left out', () => {
    expect(confirmLine(202, 4, { already_worked: 9, blocked: 2 }))
      .toBe('187 will be dialed · 9 already worked · 4 no number · 2 blocked');
  });
  it('omits zero parts and folds every consent reason into "blocked"', () => {
    expect(confirmLine(10, 0)).toBe('10 will be dialed');
    expect(confirmLine(10, 0, { opted_out: 1, dnc_blocked: 1, skip_on_dialer: 2 }))
      .toBe('6 will be dialed · 2 skipped by flag · 2 blocked');
  });
  it('shares its arithmetic with queueLine (same inputs, same dialable figure)', () => {
    expect(queueLine(202, 4, { already_worked: 9, blocked: 2 })).toContain('dialing 187');
  });
});

describe('missLine — what the misses were', () => {
  it('lists known reasons in a fixed order with rep-facing words', () => {
    expect(missLine({ failed: 2, voicemail: 12, no_answer: 4 })).toBe('12 voicemail · 4 no answer · 2 bad number');
  });
  it('is empty with no misses, and appends an unknown reason under its own key', () => {
    expect(missLine(undefined)).toBe('');
    expect(missLine({})).toBe('');
    expect(missLine({ voicemail: 1, something_new: 2 })).toBe('1 voicemail · 2 something new');
  });
});

describe('itemStatusLabel — the current record card', () => {
  it('names a miss by its reason', () => {
    expect(itemStatusLabel({ status: 'no_connect', outcome: 'voicemail' })).toBe('Voicemail');
    expect(itemStatusLabel({ status: 'no_connect', outcome: 'no_answer' })).toBe('No answer');
    expect(itemStatusLabel({ status: 'no_connect', outcome: 'busy' })).toBe('Busy');
    expect(itemStatusLabel({ status: 'no_connect', outcome: 'failed' })).toBe('Bad number');
  });
  it('names the other statuses, with No number for unreachable', () => {
    expect(itemStatusLabel({ status: 'unreachable', outcome: null })).toBe('No number');
    expect(itemStatusLabel({ status: 'dialing' })).toBe('Dialing');
    expect(itemStatusLabel({ status: 'connected' })).toBe('Connected');
    expect(itemStatusLabel({ status: 'no_connect', outcome: null })).toBe('No connect');
  });
});

describe('startDialingSequence — join the softphone first, then tell the engine', () => {
  it('sends start only after the conference leg is up', async () => {
    const join = vi.fn(async () => true);
    const control = vi.fn(async () => {});
    expect(await startDialingSequence(join, control)).toBe('started');
    expect(control).toHaveBeenCalledWith('start');
    expect(join.mock.invocationCallOrder[0]!).toBeLessThan(control.mock.invocationCallOrder[0]!);
  });
  it('sends nothing when the join reports the run was superseded', async () => {
    const control = vi.fn(async () => {});
    expect(await startDialingSequence(async () => false, control)).toBe('superseded');
    expect(control).not.toHaveBeenCalled();
  });
  it('sends nothing when the join throws (the error reaches the caller)', async () => {
    const control = vi.fn(async () => {});
    await expect(startDialingSequence(async () => { throw new Error('Device busy'); }, control)).rejects.toThrow('Device busy');
    expect(control).not.toHaveBeenCalled();
  });
});

describe('ConfirmBlock (SSR)', () => {
  const view: DialerSessionView = {
    session: { id: 'sess1', status: 'ready' },
    counts: { total: 202, done: 0, connected: 0, noConnect: 0, skipped: 11, unreachable: 4, pending: 187 },
    currentItem: null,
    skipBreakdown: { already_worked: 9, blocked: 2 },
    firstPassTotal: 202,
  };
  it('shows the breakdown line, Start dialing, and the way out', () => {
    const html = renderToStaticMarkup(<ConfirmBlock view={view} busy={false} error={null} onStartDialing={() => {}} onChooseAnother={() => {}} />);
    expect(html).toContain('187 will be dialed · 9 already worked · 4 no number · 2 blocked');
    expect(html).toContain('Start dialing');
    expect(html).toContain('Choose a different list');
  });
  it('reads Starting… and disables both buttons while busy; shows the error when there is one', () => {
    const html = renderToStaticMarkup(<ConfirmBlock view={view} busy={true} error="Another power-dial run is already active for you" onStartDialing={() => {}} onChooseAnother={() => {}} />);
    expect(html).toContain('Starting…');
    expect(html).toContain('Another power-dial run is already active');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm --workspace apps/cti-web test -- src/components/DialerPanel.test.tsx`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 4: Add the pure helpers and the confirm block**

In `apps/cti-web/src/components/DialerPanel.tsx`:

Add to the imports: `import { ApiError } from '../api';`

Replace the `queueLine` function (its doc comment through its closing brace, lines 52-73) with:

```ts
/**
 * Pure — the creation-stamped arithmetic the confirm block and the run line
 * share. Every input is fixed at queue build, so neither line drifts while the
 * rep watches: `firstPassTotal` counts attempt-1 rows only (an attempt-2 retry
 * row appended mid-run would inflate a live total), `unreachable` is fixed at
 * creation, and only the creation-stamped breakdown keys are read — an
 * out-of-hours skip the engine stamps at minute 40 adds a key this ignores.
 */
export function queueParts(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): {
  total: number; alreadyWorked: number; skipOnDialer: number; consent: number; unreachable: number; dialing: number;
} {
  const alreadyWorked = breakdown?.already_worked ?? 0;
  const skipOnDialer = breakdown?.skip_on_dialer ?? 0;
  // Consent skips are creation-stamped too (opted out / blocked list / DNC).
  const consent = (breakdown?.opted_out ?? 0) + (breakdown?.blocked ?? 0) + (breakdown?.dnc_blocked ?? 0);
  const dialing = firstPassTotal - alreadyWorked - skipOnDialer - consent - unreachable;
  return { total: firstPassTotal, alreadyWorked, skipOnDialer, consent, unreachable, dialing };
}

/** Pure — the run line, e.g. "50 records · 18 already worked today · dialing 32". Zero parts omitted. */
export function queueLine(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): string {
  const q = queueParts(firstPassTotal, unreachable, breakdown);
  const parts = [`${q.total} records`];
  if (q.alreadyWorked > 0) parts.push(`${q.alreadyWorked} already worked today`);
  if (q.skipOnDialer > 0) parts.push(`${q.skipOnDialer} skipped by flag`);
  if (q.consent > 0) parts.push(`${q.consent} blocked by consent`);
  parts.push(`dialing ${q.dialing}`);
  return parts.join(' · ');
}

/**
 * Pure — the confirm block's line, e.g.
 * "187 will be dialed · 9 already worked · 4 no number · 2 blocked".
 * Leads with the figure the rep is deciding on; zero parts omitted.
 */
export function confirmLine(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): string {
  const q = queueParts(firstPassTotal, unreachable, breakdown);
  const parts = [`${q.dialing} will be dialed`];
  if (q.alreadyWorked > 0) parts.push(`${q.alreadyWorked} already worked`);
  if (q.skipOnDialer > 0) parts.push(`${q.skipOnDialer} skipped by flag`);
  if (q.unreachable > 0) parts.push(`${q.unreachable} no number`);
  if (q.consent > 0) parts.push(`${q.consent} blocked`);
  return parts.join(' · ');
}

/** Miss reason → rep-facing words, in the order the miss line lists them.
 *  Keys are the server's `DialOutcome` values (plus the legacy `no_connect`
 *  rows written before reasons existed, and the tally's `other`). */
const MISS_LABELS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['voicemail', 'voicemail'],
  ['no_answer', 'no answer'],
  ['busy', 'busy'],
  ['failed', 'bad number'],
  ['fax', 'fax'],
  ['canceled', 'canceled'],
  ['hangup', 'hung up'],
  ['no_connect', 'no connect'],
  ['other', 'other'],
];

/** Pure — "12 voicemail · 4 no answer · 2 bad number"; '' with no misses.
 *  Known reasons in a fixed order; anything the server adds later trails
 *  under its own key so it is never silently dropped. */
export function missLine(breakdown?: Record<string, number>): string {
  if (!breakdown) return '';
  const known = new Set(MISS_LABELS.map(([k]) => k));
  const named = MISS_LABELS
    .filter(([k]) => (breakdown[k] ?? 0) > 0)
    .map(([k, label]) => `${breakdown[k]} ${label}`);
  const rest = Object.keys(breakdown)
    .filter((k) => !known.has(k) && breakdown[k] > 0)
    .sort()
    .map((k) => `${breakdown[k]} ${k.replace(/_/g, ' ')}`);
  return [...named, ...rest].join(' · ');
}

const OUTCOME_LABELS: Record<string, string> = {
  voicemail: 'Voicemail', no_answer: 'No answer', busy: 'Busy', failed: 'Bad number',
  fax: 'Fax', canceled: 'Canceled', hangup: 'Hung up',
};
const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued', dialing: 'Dialing', connected: 'Connected', done: 'Done',
  skipped: 'Skipped', unreachable: 'No number', no_connect: 'No connect',
};

/** Pure — the current record's one-phrase state; a miss shows its reason. */
export function itemStatusLabel(item: Pick<DialerCurrentItem, 'status' | 'outcome'>): string {
  if (item.status === 'no_connect' && item.outcome && OUTCOME_LABELS[item.outcome]) return OUTCOME_LABELS[item.outcome];
  return STATUS_LABELS[item.status] ?? item.status.replace(/_/g, ' ');
}

/**
 * Pure — the Start-dialing sequence. The softphone joins the run's conference
 * FIRST (`join` is the parent's onStart) so the first prospect that connects
 * finds the rep already in the room; only then is the engine told to dial.
 * A `join` that resolves false means a stop or a newer run superseded this one
 * mid-await — nothing is sent. A `join` that throws propagates untouched.
 */
export async function startDialingSequence(
  join: () => Promise<boolean>,
  control: (action: DialerControlAction) => Promise<void>,
): Promise<'started' | 'superseded'> {
  const joined = await join();
  if (!joined) return 'superseded';
  await control('start');
  return 'started';
}

/** The server's `{ error }` sentence when there is one; otherwise the fallback. */
function controlErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.data && typeof e.data === 'object') {
    const msg = (e.data as { error?: unknown }).error;
    if (typeof msg === 'string') return msg;
  }
  return e instanceof Error ? e.message : fallback;
}
```

Replace `CurrentRecord`'s meta line `{item.objectType} · {item.status.replace(/_/g, ' ')}` with:

```tsx
        {item.objectType} · {itemStatusLabel(item)}
```

Change `onStart`'s prop declaration and comment (in `DialerPanelProps`) to:

```ts
  /**
   * The rep pressed Start dialing on a ready run. The parent joins the
   * softphone to the run's Twilio conference and resolves true once the leg is
   * up (false if a stop or a newer run superseded it meanwhile). The panel
   * sends the `start` control only on true — see startDialingSequence.
   */
  onStart: () => Promise<boolean>;
```

In the picker, change the button text to:

```tsx
              {starting ? 'Checking records…' : 'Dial this list'}
```

Add the confirm block component directly above `export function DialerPanel(`:

```tsx
/**
 * The run was created READY: the queue is built, nothing has dialed. Show the
 * rep what the list came to and let them start it — or back out, which stops
 * the (never-started) session and returns to the picker.
 */
export function ConfirmBlock({
  view,
  busy,
  error,
  onStartDialing,
  onChooseAnother,
}: {
  view: DialerSessionView;
  busy: boolean;
  error: string | null;
  onStartDialing: () => void;
  onChooseAnother: () => void;
}): JSX.Element {
  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Ready to dial</div>
        <div className="dp-queue-line">
          {confirmLine(view.firstPassTotal ?? view.counts.total, view.counts.unreachable, view.skipBreakdown)}
        </div>
        {error && <div className="dp-error">{error}</div>}
        <button className="btn primary full" disabled={busy} onClick={onStartDialing}>
          {busy ? 'Starting…' : 'Start dialing'}
        </button>
        <button className="btn full" disabled={busy} onClick={onChooseAnother}>
          Choose a different list
        </button>
      </div>
    </div>
  );
}
```

(`dp-picker` already lays its children out as a 12px-gapped column — `apps/cti-web/src/styles.css:1104` — so no stylesheet change is needed.)

In `DialerPanel` itself:

1. In the session effect, delete the line `onStart();` (the one right after `if (!sessionId) { … return; }`). `onStart` is no longer "the panel began tracking"; it is the rep's confirmation.
2. Change `runControl`'s `.catch` to use the server's sentence:

```ts
      .catch((e: unknown) => {
        setError(controlErrorMessage(e, `Could not ${action} the run.`));
      })
```

3. Directly after `handleStop`, add:

```ts
  // Start dialing: join the softphone to the conference (onStart), THEN send
  // `start`. busy covers the whole sequence so the button cannot double-fire;
  // a superseded join sends nothing and shows nothing — the rep chose to leave.
  const handleStartDialing = useCallback(() => {
    if (!sessionId) return;
    void (async () => {
      setControlBusy(true);
      try {
        const result = await startDialingSequence(onStart, async (action) => {
          await dialerControl(sessionId, action);
          pollNowRef.current();
        });
        if (result === 'started') setError(null);
      } catch (e: unknown) {
        setError(controlErrorMessage(e, 'Could not start the run.'));
      } finally {
        setControlBusy(false);
      }
    })();
  }, [onStart, sessionId]);
```

4. Directly after the `if (!view) { … }` early return, add:

```tsx
  if (view.session.status === 'ready') {
    return (
      <ConfirmBlock
        view={view}
        busy={controlBusy}
        error={error}
        onStartDialing={handleStartDialing}
        onChooseAnother={handleStop}
      />
    );
  }
```

5. In the run screen's progress section, directly after the `dp-queue-line` div, add:

```tsx
        {missLine(view.missBreakdown) && <div className="dp-queue-line">{missLine(view.missBreakdown)}</div>}
```

6. In the terminal summary, directly after the `<div className="dp-summary-meta">{progressLabel(view.counts)}</div>` line, add:

```tsx
          {missLine(view.missBreakdown) && <div className="dp-summary-meta">{missLine(view.missBreakdown)}</div>}
```

7. Update the file's header comment: after the first paragraph add `A run is created READY and shows a confirm block (ConfirmBlock) until the rep presses Start dialing; only then does the softphone join the conference and the engine dial.`

- [ ] **Step 5: Run the panel tests**

Run: `npm --workspace apps/cti-web test -- src/components/DialerPanel.test.tsx`
Expected: PASS, whole file (the existing `queueLine` tests included — its output is unchanged).

- [ ] **Step 6: Move the conference join from create to Start in `App.tsx`**

In `apps/cti-web/src/App.tsx`, replace `beginRun` (the two comment blocks starting `// Start a server-originated power-dialer run:` through the `}, [ensureDevice]);` that closes it, lines 582-610) with:

```ts
  // A session was created READY (queue built, nothing dialed): show the confirm
  // block on the Power Dial tab. No conference leg yet, and no nav lock — those
  // come when the rep presses Start dialing (joinDialerConference).
  const beginRun = useCallback((sessionId: string): void => {
    setDialerSessionId(sessionId);
    setTab('powerdial');
  }, []);

  // The rep pressed Start dialing. Join the softphone to the run's Twilio
  // conference BEFORE the engine originates the first call (the panel sends
  // `start` only once this resolves true), so the first prospect that connects
  // finds the rep already in the room. Mirrors place()'s device.connect()
  // shape, but with DialerConference instead of To/CallerId/CallId — the
  // server's /voice DialerConference branch puts this leg in the conference
  // room instead of dialing a destination. Deliberately does NOT touch
  // phase/active/inCall: this leg is long-lived across many prospect calls,
  // not a single call. Resolves false — leg dropped, nothing started — when a
  // stop or a newer run superseded it mid-await. Idempotent: a retry after a
  // failed `start` (say, a 409) finds the leg already up and keeps it.
  const joinDialerConference = useCallback(async (): Promise<boolean> => {
    if (dialerConnRef.current) return true;
    const myRun = ++dialerRunRef.current;
    coordinatorRef.current?.promoteSelf();
    setDialerLive(true); // lock the nav to the Power Dial tab for the whole run
    try {
      const device = await ensureDevice();
      const connection = await (device as unknown as { connect: (o: unknown) => Promise<unknown> }).connect({
        params: { DialerConference: '1' },
      });
      if (dialerRunRef.current !== myRun) {
        try { (connection as { disconnect?: () => void }).disconnect?.(); } catch { /* already gone */ }
        return false;
      }
      dialerConnRef.current = connection;
      // Announce "busy" NOW rather than waiting up to a heartbeat — until peers see
      // it, a tab the rep alt-tabs to could still win the election and register a
      // second Device on top of this live run.
      coordinatorRef.current?.promoteSelf();
      return true;
    } catch (e) {
      if (dialerRunRef.current === myRun) setDialerLive(false); // only if a newer run didn't supersede us
      throw e;
    }
  }, [ensureDevice]);
```

Replace the body of `startPowerDial` from `// Capture the run generation BEFORE any await` through the closing `}` of its `catch` with:

```ts
    try {
      const { sessionId } = await startDialer(objectType as DialerObjectType, recordIds as string[]);
      beginRun(sessionId);
    } catch (e) {
      setToast({ text: dialerStartErrorMessage(e), type: 'error' });
    }
```

Replace the body of `startPowerDialFromListView` (from `const myRun = ++dialerRunRef.current;` through the closing `}` of its `catch`) with:

```ts
      try {
        const { sessionId } = await startDialerFromListView(object, listViewId);
        beginRun(sessionId);
      } catch (e) {
        setToast({ text: dialerStartErrorMessage(e), type: 'error' });
      }
```

(The "Power Dial started — dialing N record(s)" toast goes: the confirm block IS that feedback now.)

In the handoff-poll effect, replace the four comment lines beginning `// Don't auto-start a run while the rep is on/ringing a call — beginRun's` with:

```ts
        // Don't take a handoff while the rep is on/ringing a call: the confirm
        // block would pop over the call, and Start's device.connect() would
        // throw (Device busy). Take handoffs only when truly idle. (Manual
        // start is already blocked: the nav is hidden during a call, so the
        // rep can't reach the picker mid-call.)
```

Change the panel prop `onStart={() => { /* App already owns session start (see startPowerDial) */ }}` to:

```tsx
      onStart={joinDialerConference}
```

- [ ] **Step 7: Typecheck, full web suite, commit**

Run: `npm --workspace apps/cti-web run typecheck && npm --workspace apps/cti-web test`
Expected: clean and PASS. `grep -n "dialerRunRef\|dialerConnRef" apps/cti-web/src/App.tsx` must show both refs still used by `joinDialerConference` and `dropConferenceLeg` (nothing else needs them now).

```bash
git add apps/cti-web/src/dialer-api.ts apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/components/DialerPanel.test.tsx apps/cti-web/src/App.tsx
git commit -m "feat(cti-web): confirm a power-dial list before the first ring; show miss reasons"
```

---

### Task 5: Follow-ups on record, deploy verification, pilot enablement, live check

This task has one code-free commit and then a runbook the human runs. Nothing here places a call or writes to production from an implementer.

**Files:**
- Modify: `docs/superpowers/plans/2026-09-04-callsign-followups.md` §2

- [ ] **Step 1: Record the follow-ups the spec deferred**

Append to the bullet list under `## 2. Smaller Callsign items`:

```markdown
- Power dialer (spec 2026-09-10 §Out of scope): batched phone resolution so a
  200-record list reaches the confirm block in seconds — `create-session.ts`
  `resolveRows` awaits `resolveDialNumber` one record at a time.
- Power dialer: a per-record outcome list during and after a run (the panel
  shows only the tally from `missBreakdown`).
- Power dialer: retry policy by miss type — skip the 5-minute attempt-2 retry
  after a `voicemail`; today every miss retries the same way.
- Power dialer: a rep who closes the tab at the confirm block leaves a `ready`
  session behind forever. Harmless (it can never dial; nothing polls it) but
  worth a reaper (stop `ready` sessions older than a day) once real runs exist.
```

```bash
git add docs/superpowers/plans/2026-09-04-callsign-followups.md
git commit -m "docs(dialer): record the power-dialer follow-ups deferred by the ship-it spec"
```

- [ ] **Step 2: Whole-branch verification before handoff**

Run from the repo root: `npm --workspace packages/db test && npm --workspace services/cti-api test && npm --workspace apps/cti-web test && npm --workspace packages/db run typecheck && npm --workspace services/cti-api run typecheck && npm --workspace apps/cti-web run typecheck`
Expected: all PASS, all clean. Then the final whole-branch review (the controller dispatches it) and landing on `main`.

- [ ] **Step 3 (human): push and confirm the migration applied**

The user pushes `main` (`git push origin main`); Railway's pre-deploy runs the migrations. Then confirm the enum value exists — the healthz is not proof (a runner that finds nothing still reports success):

```bash
PUB=$(railway variables -s Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-); psql "$PUB" -At -c "select name, applied_at from cti_schema_migrations where name like '0037%';" -c "select enumlabel from pg_enum where enumtypid = 'dialer_session_status'::regtype order by enumsortorder;" 2>&1 | grep -vE 'postgres://|postgresql://|TOKEN|SECRET'
```

Expected: one `0037_dialer_session_ready.sql` row, and `ready` among the labels.

- [ ] **Step 4 (human): enable the three pilot reps**

Preferred: the admin Team panel in the softphone — toggle Power Dialer on for Garrett Martorello, Norah Nazzaro, and Edward Jerome Maglalang (it calls `PATCH /admin/team/:userId { powerDialerEnabled: true }`). Fallback, same effect, run by the user:

```bash
PUB=$(railway variables -s Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-); psql "$PUB" -c "update users set power_dialer_enabled = true where id in ('f67b22ae-4c27-4121-b499-9ca9762646a6','58afdce8-bd6f-439c-9112-7d1051c8763c','381fb5b3-2629-4871-8aa0-3c741371fb12') returning display_name, power_dialer_enabled;" 2>&1 | grep -vE 'postgres://|postgresql://|TOKEN|SECRET'
```

Expected: three rows, all `t`.

- [ ] **Step 5 (human): live check**

The admin (already enabled) opens Power Dial, picks the 2026-08-12 Opportunity list view, and confirms the confirm block reports the large majority as `will be dialed` (in August 23 of the first 24 were unreachable). Press **Start dialing** and let it run a few records; the run screen's miss line should read as voicemails and no-answers, not `bad number`. With a second Salesforce tab open, confirm the second tab does not take over the Device between picking the list and pressing **Start dialing** — the busy announcement to the other tabs now happens at Start, not at creation.

- [ ] **Step 6 (human, after one to two days): rollout gate**

```bash
PUB=$(railway variables -s Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-); psql "$PUB" -c "select u.display_name, i.status, coalesce(i.outcome,'-') outcome, count(*) from dialer_queue_items i join dialer_sessions s on s.id = i.session_id join users u on u.id = s.user_id where s.created_at > now() - interval '2 days' and i.attempt = 1 group by 1,2,3 order by 1,2,3;" 2>&1 | grep -vE 'postgres://|postgresql://|TOKEN|SECRET'
```

Enable the remaining fourteen when: the connect rate (`connected` + `done` over rows not `skipped`/`unreachable`) is above the ~4% the August test showed; misses read as `voicemail`/`no_answer` rather than `failed`; and the Railway logs show no `[dialer]` errors for the period.

---

## Self-review

**Spec coverage.** §1 phone resolution → Task 1 (order, fallback-only-when-empty, skip from the Opportunity query, 400-retry). §2 outcomes → Task 2 (type + `isNoConnect`, AMD and status mappings, `hangup`, no-overwrite by ordering, `missBreakdown` on the store and the route) and Task 4 (miss line, labels). §3 confirm-before-dial → Task 3 (migration, `ready` insert, `createAndStartSession` removed, `start` CAS + idempotent, `stop` from ready writes nothing) and Task 4 (`Checking records…`, confirm block line and buttons, `ready` and `missBreakdown` in the web types, conference join moved to Start). §4 pilot → Task 5. Testing section: each named test exists in Tasks 1-4; the live check is Task 5 Step 5. Out-of-scope list → Task 5 Step 1.

**Placeholders.** None: every code step carries the code; every command carries its expected result.

**Type consistency.** `DialOutcome` / `isNoConnect` are defined in Task 2 and consumed by name in Tasks 2 and 4's labels; `missBreakdown` is named identically on the server function, the route field, and the web type; `startSession` returns `{ action: 'conflict' }` and the route checks exactly that; `onStart: () => Promise<boolean>` is what `joinDialerConference` returns and what `startDialingSequence`'s `join` expects; `ConfirmBlock`'s props match the SSR test; `queueParts` feeds both `queueLine` and `confirmLine`.
