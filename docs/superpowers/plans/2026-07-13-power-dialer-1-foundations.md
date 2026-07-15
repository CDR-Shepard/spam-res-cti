# Power Dialer — Plan 1: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure backend units the power dialer composes — next-business-day, the follow-up-task rollover, per-record number resolution, and the dialer-pool number `kind` — with no telephony.

**Architecture:** Each unit splits **pure logic** (unit-tested with vitest) from a thin **Salesforce I/O wrapper** (calls `sfFetch`/`soqlQuery`). Later plans (session engine, telephony, LWC) consume these functions by the exact signatures in each task's **Produces** block.

**Tech Stack:** Node 20 + TypeScript (ESM, `.js` import specifiers), Fastify, Drizzle ORM (Postgres), vitest, `undici` (via existing `sfFetch`), Salesforce REST API v60.

## Global Constraints

- Language: TypeScript, ESM. Import local files with a `.js` extension (e.g. `import { x } from './y.js'`). — verbatim repo convention.
- Salesforce I/O goes through `sfFetch` in `services/cti-api/src/salesforce/client.ts` (handles token refresh). Never call Salesforce URLs directly.
- Dates handled as `YYYY-MM-DD` strings; construct `Date` only with explicit `Date.UTC(...)` args (deterministic, testable). Never `new Date()` with no args in tested logic.
- Follow-up task subject match: `/follow[ -]?up/i` (matches "Follow-up", "Followup", "Follow up").
- New backend files live under `services/cti-api/src/`; tests are colocated `*.test.ts`; run with `npx vitest run <path>` from `services/cti-api`.
- Commit after every task with a `feat:`/`chore:` message. Do NOT push to `main` (that deploys) — this plan only lands local commits on a feature branch.

**Setup (once, before Task 1):**

```bash
cd /Users/cdrshepard/spam-res-cti
git checkout -b feat/power-dialer-foundations
```

---

### Task 1: `nextBusinessDay` pure function

**Files:**
- Create: `services/cti-api/src/dialer/next-business-day.ts`
- Test: `services/cti-api/src/dialer/next-business-day.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `nextBusinessDay(fromIsoDate: string, workingWeekdays: ReadonlySet<number>, holidays: ReadonlySet<string>): string` — the working day strictly after `fromIsoDate`. Weekdays are `0=Sun … 6=Sat`; holidays are `YYYY-MM-DD`.
  - `addDays(isoDate: string, days: number): string`
  - `dayOfWeek(isoDate: string): number`

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/dialer/next-business-day.test.ts
import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, nextBusinessDay } from './next-business-day.js';

const MON_FRI = new Set([1, 2, 3, 4, 5]);

describe('addDays / dayOfWeek', () => {
  it('adds days across month boundaries and reports weekday', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(dayOfWeek('2026-07-13')).toBe(1); // Monday
    expect(dayOfWeek('2026-07-18')).toBe(6); // Saturday
  });
});

describe('nextBusinessDay', () => {
  it('advances one weekday', () => {
    expect(nextBusinessDay('2026-07-13', MON_FRI, new Set())).toBe('2026-07-14'); // Mon→Tue
  });
  it('rolls Friday to Monday', () => {
    expect(nextBusinessDay('2026-07-17', MON_FRI, new Set())).toBe('2026-07-20'); // Fri→Mon
  });
  it('skips a holiday and the weekend', () => {
    // Thu 7/2 → Fri 7/3 (holiday) → Sat/Sun → Mon 7/6
    expect(nextBusinessDay('2026-07-02', MON_FRI, new Set(['2026-07-03']))).toBe('2026-07-06');
  });
  it('throws on an empty working-week', () => {
    expect(() => nextBusinessDay('2026-07-13', new Set(), new Set())).toThrow(/workingWeekdays/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/next-business-day.test.ts`
Expected: FAIL — cannot find module `./next-business-day.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// services/cti-api/src/dialer/next-business-day.ts
/**
 * Date math on YYYY-MM-DD strings in a fixed calendar (the caller resolves the
 * org timezone before calling), so there is no timezone drift here.
 */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function dayOfWeek(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The working day strictly AFTER `fromIsoDate`, skipping non-working weekdays
 *  and holidays. `workingWeekdays`: 0=Sun … 6=Sat. `holidays`: YYYY-MM-DD. */
export function nextBusinessDay(
  fromIsoDate: string,
  workingWeekdays: ReadonlySet<number>,
  holidays: ReadonlySet<string>,
): string {
  if (workingWeekdays.size === 0) throw new Error('workingWeekdays must not be empty');
  let d = addDays(fromIsoDate, 1);
  for (let i = 0; i < 366; i++) {
    if (workingWeekdays.has(dayOfWeek(d)) && !holidays.has(d)) return d;
    d = addDays(d, 1);
  }
  throw new Error('no working day found within a year');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cti-api && npx vitest run src/dialer/next-business-day.test.ts`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/dialer/next-business-day.ts services/cti-api/src/dialer/next-business-day.test.ts
git commit -m "feat(dialer): next-business-day date helper"
```

---

### Task 2: `soqlQuery` + `soqlEscape` + export `sfFetch`

**Files:**
- Modify: `services/cti-api/src/salesforce/client.ts` (add exports near the existing `sfFetch` definition, ~line 55)
- Test: `services/cti-api/src/salesforce/soql.test.ts`

**Interfaces:**
- Consumes: existing module-private `sfFetch(userId, path, {method?, body?, query?}): Promise<{status, json}>`.
- Produces:
  - `export async function sfFetch(...)` — same signature, now exported.
  - `soqlQuery<T = Record<string, unknown>>(userId: string, soql: string): Promise<T[]>` — runs `/query?q=`, returns `.records`.
  - `soqlEscape(value: string): string` — escapes `\` and `'` for embedding in SOQL string literals.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/salesforce/soql.test.ts
import { describe, expect, it } from 'vitest';
import { soqlEscape } from './client.js';

describe('soqlEscape', () => {
  it("escapes single quotes and backslashes", () => {
    expect(soqlEscape("O'Brien")).toBe("O\\'Brien");
    expect(soqlEscape('a\\b')).toBe('a\\\\b');
    expect(soqlEscape('00Q123')).toBe('00Q123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/salesforce/soql.test.ts`
Expected: FAIL — `soqlEscape` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `services/cti-api/src/salesforce/client.ts`, change `async function sfFetch(` to `export async function sfFetch(`, then add below it:

```ts
/** Escape a value for safe interpolation into a SOQL string literal. */
export function soqlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Run a SOQL query as the given user; returns the `records` array. */
export async function soqlQuery<T = Record<string, unknown>>(
  userId: string,
  soql: string,
): Promise<T[]> {
  const res = await sfFetch(userId, '/query', { query: { q: soql } });
  if (res.status >= 400) throw new Error(`SOQL failed (${res.status}): ${JSON.stringify(res.json)}`);
  return ((res.json as { records?: T[] }).records ?? []);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cti-api && npx vitest run src/salesforce/soql.test.ts && npx tsc --noEmit`
Expected: PASS + tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/salesforce/client.ts services/cti-api/src/salesforce/soql.test.ts
git commit -m "feat(sf): export sfFetch + soqlQuery/soqlEscape helpers"
```

---

### Task 3: Business calendar → next business day for an org

**Files:**
- Create: `services/cti-api/src/salesforce/business-calendar.ts`
- Test: `services/cti-api/src/salesforce/business-calendar.test.ts`

**Interfaces:**
- Consumes: `nextBusinessDay` (Task 1); `soqlQuery` (Task 2).
- Produces:
  - `parseBusinessCalendar(bh: Record<string, unknown> | null, holidays: Array<{ ActivityDate?: string | null }>): { workingWeekdays: Set<number>; holidays: Set<string> }` — pure.
  - `fetchBusinessCalendar(userId: string): Promise<{ workingWeekdays: Set<number>; holidays: Set<string> }>`
  - `nextBusinessDayFor(userId: string, fromIsoDate: string): Promise<string>`

**Note (from spec §6):** a Salesforce day is a working day when its `<Day>StartTime` is non-null on the Default Business Hours. Holidays use `Holiday.ActivityDate` (non-recurring; recurring holidays are out of scope for v1 — the org has 0 holidays today). If Business Hours can't be read, fall back to Mon–Fri.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/salesforce/business-calendar.test.ts
import { describe, expect, it } from 'vitest';
import { parseBusinessCalendar } from './business-calendar.js';

describe('parseBusinessCalendar', () => {
  it('maps non-null <Day>StartTime to working weekdays and collects holidays', () => {
    const bh = {
      SundayStartTime: null, MondayStartTime: '08:00:00.000Z', TuesdayStartTime: '08:00:00.000Z',
      WednesdayStartTime: '08:00:00.000Z', ThursdayStartTime: '08:00:00.000Z',
      FridayStartTime: '08:00:00.000Z', SaturdayStartTime: null,
    };
    const cal = parseBusinessCalendar(bh, [{ ActivityDate: '2026-12-25' }, { ActivityDate: null }]);
    expect([...cal.workingWeekdays].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(cal.holidays.has('2026-12-25')).toBe(true);
    expect(cal.holidays.size).toBe(1);
  });
  it('falls back to Mon-Fri when Business Hours is missing/empty', () => {
    const cal = parseBusinessCalendar(null, []);
    expect([...cal.workingWeekdays].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/salesforce/business-calendar.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// services/cti-api/src/salesforce/business-calendar.ts
import { soqlQuery } from './client.js';
import { nextBusinessDay } from '../dialer/next-business-day.js';

const DOW_START_FIELD: ReadonlyArray<readonly [string, number]> = [
  ['SundayStartTime', 0], ['MondayStartTime', 1], ['TuesdayStartTime', 2],
  ['WednesdayStartTime', 3], ['ThursdayStartTime', 4], ['FridayStartTime', 5],
  ['SaturdayStartTime', 6],
];

export function parseBusinessCalendar(
  bh: Record<string, unknown> | null,
  holidays: Array<{ ActivityDate?: string | null }>,
): { workingWeekdays: Set<number>; holidays: Set<string> } {
  const workingWeekdays = new Set<number>();
  if (bh) for (const [field, dow] of DOW_START_FIELD) if (bh[field] != null) workingWeekdays.add(dow);
  if (workingWeekdays.size === 0) for (const d of [1, 2, 3, 4, 5]) workingWeekdays.add(d);
  const hset = new Set<string>();
  for (const h of holidays) if (h.ActivityDate) hset.add(h.ActivityDate);
  return { workingWeekdays, holidays: hset };
}

export async function fetchBusinessCalendar(
  userId: string,
): Promise<{ workingWeekdays: Set<number>; holidays: Set<string> }> {
  const bhRows = await soqlQuery<Record<string, unknown>>(
    userId,
    'SELECT SundayStartTime, MondayStartTime, TuesdayStartTime, WednesdayStartTime, ' +
      'ThursdayStartTime, FridayStartTime, SaturdayStartTime FROM BusinessHours ' +
      'WHERE IsDefault = true LIMIT 1',
  );
  const holidays = await soqlQuery<{ ActivityDate?: string | null }>(
    userId,
    'SELECT ActivityDate FROM Holiday WHERE ActivityDate >= LAST_N_DAYS:7',
  );
  return parseBusinessCalendar(bhRows[0] ?? null, holidays);
}

export async function nextBusinessDayFor(userId: string, fromIsoDate: string): Promise<string> {
  const cal = await fetchBusinessCalendar(userId);
  return nextBusinessDay(fromIsoDate, cal.workingWeekdays, cal.holidays);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cti-api && npx vitest run src/salesforce/business-calendar.test.ts && npx tsc --noEmit`
Expected: PASS + tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/salesforce/business-calendar.ts services/cti-api/src/salesforce/business-calendar.test.ts
git commit -m "feat(sf): business-calendar → next business day for an org"
```

---

### Task 4: Follow-up rollover

**Files:**
- Create: `services/cti-api/src/salesforce/followup.ts`
- Test: `services/cti-api/src/salesforce/followup.test.ts`

**Interfaces:**
- Consumes: `soqlQuery`, `soqlEscape`, `sfFetch` (Task 2); `nextBusinessDayFor` (Task 3).
- Produces:
  - `type FollowUpTask = { Id: string; Subject: string | null; Type: string | null; Priority: string | null; OwnerId: string; WhoId: string | null; WhatId: string | null; ActivityDate: string | null }`
  - `pickFollowUpTask(tasks: FollowUpTask[]): FollowUpTask | null` — the earliest-due task whose Subject matches `/follow[ -]?up/i` (nulls last). Pure.
  - `followUpCopyFields(task: FollowUpTask, dueDate: string): Record<string, string>` — the new-Task field map. Pure.
  - `rolloverFollowUp(userId: string, sfOwnerId: string, recordId: string, fromIsoDate: string): Promise<{ completed: string | null; created: string | null }>` — completes the matched follow-up and creates its next-business-day copy; `{completed:null, created:null}` when none match.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/salesforce/followup.test.ts
import { describe, expect, it } from 'vitest';
import { followUpCopyFields, pickFollowUpTask, type FollowUpTask } from './followup.js';

const t = (o: Partial<FollowUpTask>): FollowUpTask => ({
  Id: 'x', Subject: 'Follow-up', Type: 'Call', Priority: 'Normal',
  OwnerId: '005', WhoId: '00Q1', WhatId: null, ActivityDate: '2026-07-10', ...o,
});

describe('pickFollowUpTask', () => {
  it('ignores non-follow-up subjects', () => {
    expect(pickFollowUpTask([t({ Subject: 'Send contract' })])).toBeNull();
  });
  it('matches the three spellings, case-insensitively', () => {
    for (const s of ['Follow-up', 'Followup', 'follow up call', 'FOLLOW-UP']) {
      expect(pickFollowUpTask([t({ Subject: s })])).not.toBeNull();
    }
  });
  it('returns the earliest-due matching task', () => {
    const picked = pickFollowUpTask([
      t({ Id: 'a', ActivityDate: '2026-07-12' }),
      t({ Id: 'b', ActivityDate: '2026-07-08' }),
      t({ Id: 'c', ActivityDate: null }),
    ]);
    expect(picked?.Id).toBe('b');
  });
});

describe('followUpCopyFields', () => {
  it('copies core fields, drops null Who/What, sets due date + open status', () => {
    const f = followUpCopyFields(t({ WhatId: null, WhoId: '00Q9' }), '2026-07-14');
    expect(f).toMatchObject({
      Subject: 'Follow-up', Type: 'Call', Priority: 'Normal', OwnerId: '005',
      WhoId: '00Q9', Status: 'Not Started', ActivityDate: '2026-07-14',
    });
    expect('WhatId' in f).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/salesforce/followup.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// services/cti-api/src/salesforce/followup.ts
import { sfFetch, soqlEscape, soqlQuery } from './client.js';
import { nextBusinessDayFor } from './business-calendar.js';

export interface FollowUpTask {
  Id: string;
  Subject: string | null;
  Type: string | null;
  Priority: string | null;
  OwnerId: string;
  WhoId: string | null;
  WhatId: string | null;
  ActivityDate: string | null;
}

const FOLLOW_UP_RE = /follow[ -]?up/i;

export function pickFollowUpTask(tasks: FollowUpTask[]): FollowUpTask | null {
  const matches = tasks.filter((t) => t.Subject != null && FOLLOW_UP_RE.test(t.Subject));
  if (matches.length === 0) return null;
  // Earliest ActivityDate first; null dates sort last.
  matches.sort((a, b) => (a.ActivityDate ?? '9999-99-99').localeCompare(b.ActivityDate ?? '9999-99-99'));
  return matches[0]!;
}

export function followUpCopyFields(task: FollowUpTask, dueDate: string): Record<string, string> {
  const fields: Record<string, string> = {
    Subject: task.Subject ?? 'Follow-up',
    Status: 'Not Started',
    ActivityDate: dueDate,
    OwnerId: task.OwnerId,
  };
  if (task.Type) fields.Type = task.Type;
  if (task.Priority) fields.Priority = task.Priority;
  if (task.WhoId) fields.WhoId = task.WhoId;
  if (task.WhatId) fields.WhatId = task.WhatId;
  return fields;
}

/**
 * Complete the rep's open follow-up task on `recordId` and create a copy due the
 * next business day. No-op returning nulls when no follow-up task matches.
 * `sfOwnerId` is the rep's Salesforce User Id.
 */
export async function rolloverFollowUp(
  userId: string,
  sfOwnerId: string,
  recordId: string,
  fromIsoDate: string,
): Promise<{ completed: string | null; created: string | null }> {
  const rid = soqlEscape(recordId);
  const owner = soqlEscape(sfOwnerId);
  const tasks = await soqlQuery<FollowUpTask>(
    userId,
    'SELECT Id, Subject, Type, Priority, OwnerId, WhoId, WhatId, ActivityDate FROM Task ' +
      `WHERE IsClosed = false AND OwnerId = '${owner}' ` +
      `AND (WhoId = '${rid}' OR WhatId = '${rid}') ` +
      "AND (Subject LIKE '%Follow-up%' OR Subject LIKE '%Followup%' OR Subject LIKE '%Follow up%') " +
      'ORDER BY ActivityDate ASC NULLS LAST LIMIT 50',
  );
  const task = pickFollowUpTask(tasks);
  if (!task) return { completed: null, created: null };

  const complete = await sfFetch(userId, `/sobjects/Task/${task.Id}`, {
    method: 'PATCH',
    body: { Status: 'Completed' },
  });
  if (complete.status >= 400) {
    throw new Error(`follow-up complete failed: ${JSON.stringify(complete.json)}`);
  }

  const due = await nextBusinessDayFor(userId, fromIsoDate);
  const created = await sfFetch(userId, '/sobjects/Task', {
    method: 'POST',
    body: followUpCopyFields(task, due),
  });
  if (created.status >= 400) {
    throw new Error(`follow-up copy create failed: ${JSON.stringify(created.json)}`);
  }
  return { completed: task.Id, created: (created.json as { id: string }).id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cti-api && npx vitest run src/salesforce/followup.test.ts && npx tsc --noEmit`
Expected: PASS (6 assertions) + tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/salesforce/followup.ts services/cti-api/src/salesforce/followup.test.ts
git commit -m "feat(sf): follow-up rollover (complete + next-business-day copy)"
```

---

### Task 5: Per-record dial-number resolution

**Files:**
- Create: `services/cti-api/src/salesforce/record-phone.ts`
- Test: `services/cti-api/src/salesforce/record-phone.test.ts`

**Interfaces:**
- Consumes: `soqlQuery`, `soqlEscape` (Task 2); `normalize` from `services/cti-api/src/phone.ts` (existing: `normalize(raw) → { ok: boolean; value?: { e164: string } }`).
- Produces:
  - `selectRawPhone(fields: { MobilePhone?: string | null; Phone?: string | null }): string | null` — Mobile then Phone. Pure.
  - `resolveDialNumber(userId: string, objectType: 'Lead' | 'Opportunity', recordId: string): Promise<{ e164: string } | null>` — resolves + normalizes; `null` when unreachable.

**Note (spec §2):** Lead → `MobilePhone`→`Phone`. Opportunity → the **primary** `OpportunityContactRole` Contact's `MobilePhone`→`Phone`.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/salesforce/record-phone.test.ts
import { describe, expect, it } from 'vitest';
import { selectRawPhone } from './record-phone.js';

describe('selectRawPhone', () => {
  it('prefers Mobile, falls back to Phone, else null', () => {
    expect(selectRawPhone({ MobilePhone: '619-555-0001', Phone: '619-555-0002' })).toBe('619-555-0001');
    expect(selectRawPhone({ MobilePhone: null, Phone: '619-555-0002' })).toBe('619-555-0002');
    expect(selectRawPhone({ MobilePhone: '', Phone: '' })).toBeNull();
    expect(selectRawPhone({})).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/salesforce/record-phone.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// services/cti-api/src/salesforce/record-phone.ts
import { soqlEscape, soqlQuery } from './client.js';
import { normalize } from '../phone.js';

export function selectRawPhone(fields: { MobilePhone?: string | null; Phone?: string | null }): string | null {
  const m = fields.MobilePhone?.trim();
  if (m) return m;
  const p = fields.Phone?.trim();
  if (p) return p;
  return null;
}

export async function resolveDialNumber(
  userId: string,
  objectType: 'Lead' | 'Opportunity',
  recordId: string,
): Promise<{ e164: string } | null> {
  const rid = soqlEscape(recordId);
  let raw: string | null = null;

  if (objectType === 'Lead') {
    const rows = await soqlQuery<{ MobilePhone?: string | null; Phone?: string | null }>(
      userId,
      `SELECT MobilePhone, Phone FROM Lead WHERE Id = '${rid}' LIMIT 1`,
    );
    raw = rows[0] ? selectRawPhone(rows[0]) : null;
  } else {
    // Primary Opportunity Contact Role → Contact phone.
    const rows = await soqlQuery<{ Contact?: { MobilePhone?: string | null; Phone?: string | null } | null }>(
      userId,
      'SELECT Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole ' +
        `WHERE OpportunityId = '${rid}' AND IsPrimary = true LIMIT 1`,
    );
    raw = rows[0]?.Contact ? selectRawPhone(rows[0].Contact) : null;
  }

  if (!raw) return null;
  const norm = normalize(raw);
  return norm.ok && norm.value ? { e164: norm.value.e164 } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cti-api && npx vitest run src/salesforce/record-phone.test.ts && npx tsc --noEmit`
Expected: PASS + tsc exit 0. (If `normalize`'s return shape differs, adjust the mapping in `resolveDialNumber` — confirm against `src/phone.ts`.)

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/salesforce/record-phone.ts services/cti-api/src/salesforce/record-phone.test.ts
git commit -m "feat(sf): resolve dial number for Lead/Opportunity"
```

---

### Task 6: Dialer-pool number `kind`

**Files:**
- Modify: `services/cti-api/src/db/schema.ts` (add enum near line 36; add column in `outboundNumbers` near line 168)
- Create: `services/cti-api/migrations/0016_dialer_pool_kind.sql` (use the next unused number — verify the highest existing file in `migrations/` first)
- Modify: `services/cti-api/src/routes/admin.ts` (the `PATCH /admin/outbound-numbers/:id` zod schema + set-clause)
- Create: `services/cti-api/src/dialer/pool.ts`
- Test: `services/cti-api/src/dialer/pool.test.ts`

**Interfaces:**
- Consumes: `getDb`, `schema` from `services/cti-api/src/db/index.js`.
- Produces:
  - `outbound_numbers.kind` column, enum `number_kind` = `'agent' | 'dialer_pool'`, default `'agent'`.
  - `isDialerPoolKind(kind: string): boolean` — pure.
  - `dialerPoolNumbers(orgId: string): Promise<Array<typeof schema.outboundNumbers.$inferSelect>>` — active `dialer_pool` DIDs for an org.

- [ ] **Step 1: Write the failing test (pure guard)**

```ts
// services/cti-api/src/dialer/pool.test.ts
import { describe, expect, it } from 'vitest';
import { isDialerPoolKind } from './pool.js';

describe('isDialerPoolKind', () => {
  it('recognizes the dialer pool kind only', () => {
    expect(isDialerPoolKind('dialer_pool')).toBe(true);
    expect(isDialerPoolKind('agent')).toBe(false);
    expect(isDialerPoolKind('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/pool.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3a: Add the enum + column to `schema.ts`**

Near the other enums (~line 36) add:

```ts
export const numberKindEnum = pgEnum('number_kind', ['agent', 'dialer_pool']);
```

Inside `outboundNumbers` (after the `health` columns, ~line 170) add:

```ts
    /** 'agent' = a rep's own warm number (manual click-to-dial). 'dialer_pool' =
     *  a shared number the power dialer uses for cold volume so agent numbers
     *  aren't stained. */
    kind: numberKindEnum('kind').default('agent').notNull(),
```

- [ ] **Step 3b: Write the migration**

Verify the highest file in `services/cti-api/migrations/`, then create the next number (example `0016`):

```sql
-- services/cti-api/migrations/0016_dialer_pool_kind.sql
DO $$ BEGIN
  CREATE TYPE "number_kind" AS ENUM ('agent', 'dialer_pool');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "outbound_numbers"
  ADD COLUMN IF NOT EXISTS "kind" "number_kind" NOT NULL DEFAULT 'agent';
```

- [ ] **Step 3c: Write `pool.ts`**

```ts
// services/cti-api/src/dialer/pool.ts
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

export function isDialerPoolKind(kind: string): boolean {
  return kind === 'dialer_pool';
}

/** Active dialer-pool DIDs for an org (the numbers the power dialer may use). */
export async function dialerPoolNumbers(
  orgId: string,
): Promise<Array<typeof schema.outboundNumbers.$inferSelect>> {
  const db = getDb();
  return db
    .select()
    .from(schema.outboundNumbers)
    .where(
      and(
        eq(schema.outboundNumbers.orgId, orgId),
        eq(schema.outboundNumbers.active, true),
        eq(schema.outboundNumbers.kind, 'dialer_pool'),
      ),
    );
}
```

- [ ] **Step 3d: Let admins tag a number's kind**

In `services/cti-api/src/routes/admin.ts`, in the `PATCH /admin/outbound-numbers/:id` zod object (near `assignedUserId`), add:

```ts
        kind: z.enum(['agent', 'dialer_pool']).optional(),
```

and in the `.set({ ... })` update object add:

```ts
        ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
```

- [ ] **Step 4: Run tests + typecheck + apply migration locally**

Run:
```bash
cd services/cti-api
npx vitest run src/dialer/pool.test.ts
npx tsc --noEmit
npm run migrate   # applies 0016 to the local/dev DB
```
Expected: test PASS, tsc exit 0, migration applies without error.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/db/schema.ts services/cti-api/migrations/0016_dialer_pool_kind.sql \
        services/cti-api/src/routes/admin.ts services/cti-api/src/dialer/pool.ts \
        services/cti-api/src/dialer/pool.test.ts
git commit -m "feat(dialer): dialer_pool number kind + admin tagging + pool query"
```

---

### Task 7: Full-suite green + branch check

- [ ] **Step 1: Run the whole backend suite + typecheck**

Run: `cd services/cti-api && npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0; ALL test files pass (existing 72 + the new foundations tests).

- [ ] **Step 2: Confirm no push occurred**

Run: `cd /Users/cdrshepard/spam-res-cti && git status -sb`
Expected: on `feat/power-dialer-foundations`, clean tree, ahead of `main` by the task commits (NOT pushed).

---

## Self-Review

**Spec coverage (Plan 1 scope only):**
- Next business day (§6) → Tasks 1, 3. ✓
- Follow-up match `/follow[ -]?up/i` + complete + copy, no-match→nothing (§6) → Task 4. ✓
- Lead/Opp primary-contact number resolution (§2) → Task 5. ✓
- Dialer-pool `kind` isolated from agent numbers (§5) → Task 6. ✓
- Salesforce I/O via `sfFetch` (Global Constraint) → Task 2. ✓
- Deferred to later plans (out of Plan 1 scope): session engine, telephony/AMD/conference, sticky-on-connect, inbound caller→agent routing, LWC + CTI UI.

**Placeholder scan:** none — every step has complete code + exact commands.

**Type consistency:** `nextBusinessDay` signature matches its use in `business-calendar.ts`; `FollowUpTask` shape is defined in Task 4 and used consistently; `soqlQuery`/`soqlEscape`/`sfFetch` exports (Task 2) are consumed by Tasks 3–5; `resolveDialNumber` returns `{ e164 } | null`; `dialerPoolNumbers` returns `outboundNumbers.$inferSelect[]`.

**Known follow-ups for later plans (not gaps in Plan 1):**
- `rolloverFollowUp` needs the rep's Salesforce `sfOwnerId`; Plan 2 (session engine) resolves/stores it (via the OAuth identity) and passes it in.
- `resolveDialNumber` + `rolloverFollowUp` are exercised end-to-end against the `gghsd-maindev` sandbox in Plan 2's integration tests.
