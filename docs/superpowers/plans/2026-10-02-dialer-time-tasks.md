# Power-Dialer Time in Salesforce — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write one completed "Power Dialer Time" Task per rep per Pacific day into Salesforce, kept current every 5 minutes, so Salesforce reports can show time on the power dialer.

**Architecture:** A new scan worker (`salesforce/dialer-time-worker.ts`) reads `dialer_rep_legs` for the last 3 Pacific days, computes each rep's merged line-open seconds per day with the existing `dialerSecondsByUserDay`, and creates/adopts/patches one Task per (rep, day) as the rep. A new `dialer_time_tasks` table (migration 0049) remembers each Task id and the seconds last written. Store (SQL), planner (pure), Salesforce client and worker are separate files with injected deps.

**Tech Stack:** TypeScript, Fastify service `services/cti-api`, Drizzle ORM 0.36 (`packages/db`, hand-written SQL migrations), vitest, Salesforce REST via `sfFetch`/`soqlQuery` in `salesforce/client.ts`.

**Spec:** `docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md`

## Global Constraints

- Task `Subject` is exactly `Power Dialer Time`; `Status` `Completed`; `Priority` `Normal`; `TaskSubtype` `Task` (NOT `Call`); no `CallType`, no `CallDisposition`, no `WhoId`, no `WhatId`.
- `ActivityDate` = the Pacific day (`YYYY-MM-DD`) the time belongs to; `CallDurationInSeconds` = that rep's merged line-open seconds for that day, from `dialerSecondsByUserDay` (`services/cti-api/src/reports/talk-time.ts`), integer.
- `Description` = `Time on the power dialer (line open) on <day>, Pacific. Kept up to date by the CTI.`
- `CTI_Origin__c` = `Power Dialer Time` (new `CTI_ORIGIN.dialerTime`); on `INVALID_FIELD` retry once without it.
- Created with the rep's own Salesforce connection (`userId` = the CTI user id passed to `sfFetch`), so the rep owns it.
- Worker interval `DIALER_TIME_INTERVAL_MS = 300_000`, also one run at start-up; window = the last 3 Pacific days (today and the two before).
- Before creating, look for an existing Task as the rep: `Subject = 'Power Dialer Time' AND ActivityDate = <day> AND OwnerId = '<rep sf_user_id>'` (ORDER BY CreatedDate ASC LIMIT 1) and adopt it.
- A PATCH answered 404 / `NOT_FOUND` / `ENTITY_IS_DELETED` clears the stored Task id so the next tick recreates it.
- `SalesforceUnauthorizedError` / `isSalesforceAuthError` → skip, uncounted. Any other error → `attempts + 1`, `next_attempt_at = now + backoff` (5 m, 15 m, 1 h, 3 h, 6 h, then 6 h), `last_error` = full text (DB only). Never gives up.
- Logs carry ids and Salesforce `errorCode`s only — never message bodies, phone numbers, recording URLs or tokens.
- Kill switch `DIALER_TIME_TASKS` = `z.enum(['on','off']).default('on')`; `off` = loop never started.
- `dialer_time_tasks`: FULL unique index on (`user_id`, `day`); inserts use bare `ON CONFLICT DO NOTHING` (a partial index fails every insert with 42P10). FK-free.
- Never edit `/Users/cdrshepard/spam-res-cti` (another checkout with someone else's uncommitted work). Work only in `/Users/cdrshepard/spam-res-cti-dialer-rec` on branch `feat/dialer-time-tasks`. No push.
- Commits: conventional (`feat:`, `test:`, `docs:`, `refactor:`), each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `services/cti-api` consumes `packages/db/dist`: run `npm run build:packages` after changing `packages/db`.

---

## File Structure

- Create `packages/db/migrations/0049_dialer_time_tasks.sql` — the table.
- Modify `packages/db/src/schema.ts` — `dialerTimeTasks` + `DialerTimeTask` type.
- Modify `packages/db/src/index.ts` — export `DialerTimeTask`.
- Create `packages/db/src/migration-0049.test.ts`.
- Modify `services/cti-api/src/salesforce/cti-origin.ts` — `dialerTime: 'Power Dialer Time'`.
- Create `services/cti-api/src/salesforce/dialer-time-client.ts` — create / patch / find the Task.
- Create `services/cti-api/src/salesforce/dialer-time-client.test.ts`.
- Create `services/cti-api/src/salesforce/dialer-time-plan.ts` — pure: window days, which (rep, day) need a write, backoff.
- Create `services/cti-api/src/salesforce/dialer-time-plan.test.ts`.
- Create `services/cti-api/src/salesforce/dialer-time-store.ts` — the SQL.
- Create `services/cti-api/src/salesforce/dialer-time-store.test.ts`.
- Create `services/cti-api/src/salesforce/error-summary.ts` — `errorText`, `sfErrorSummary`, `unexpectedErrorSummary` moved out of `dialer-connect-worker.ts` (re-exported there).
- Create `services/cti-api/src/salesforce/dialer-time-worker.ts` + `.test.ts`.
- Modify `services/cti-api/src/config.ts` — `DIALER_TIME_TASKS`.
- Modify `services/cti-api/src/server.ts` — start/stop the loop.
- Create `docs/runbooks/dialer-time-tasks.md`.

---

### Task 1: `dialer_time_tasks` table (migration 0049 + schema)

**Files:**
- Create: `packages/db/migrations/0049_dialer_time_tasks.sql`
- Modify: `packages/db/src/schema.ts` (append after the `dialerRepLegs` block, ~line 1066)
- Modify: `packages/db/src/index.ts` (the explicit `export type { … }` list, ~line 55-72)
- Test: `packages/db/src/migration-0049.test.ts`

**Interfaces:**
- Produces: `schema.dialerTimeTasks` (columns `id, orgId, userId, day, salesforceTaskId, syncedSeconds, attempts, nextAttemptAt, lastError, createdAt, updatedAt`), type `DialerTimeTask = typeof dialerTimeTasks.$inferSelect`, exported from `@cti/db`.

- [ ] **Step 1: Write the failing test** — `packages/db/src/migration-0049.test.ts`:

```ts
/**
 * 0049_dialer_time_tasks.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract. Load-bearing: the FULL unique
 * index on (user_id, day) — salesforce/dialer-time-store.ts inserts with a bare
 * ON CONFLICT DO NOTHING, which a PARTIAL index cannot arbitrate (42P10).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { dialerTimeTasks } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0049_dialer_time_tasks.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0049_dialer_time_tasks', () => {
  it('creates dialer_time_tasks idempotently with every column, FK-free', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "dialer_time_tasks" \(/);
    for (const col of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"org_id" uuid NOT NULL',
      '"user_id" uuid NOT NULL',
      '"day" text NOT NULL',
      '"salesforce_task_id" text',
      '"synced_seconds" integer',
      '"attempts" integer NOT NULL DEFAULT 0',
      '"next_attempt_at" timestamptz NOT NULL DEFAULT now()',
      '"last_error" text',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(col);
    }
    expect(create).not.toContain('REFERENCES');
  });

  it('CHECKs day is a YYYY-MM-DD string', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'))!;
    expect(create).toContain(`CONSTRAINT "dialer_time_tasks_day_check" CHECK ("day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`);
  });

  it('has a FULL (never partial) unique index on (user_id, day)', () => {
    const idx = statements.find((s) => s.includes('dialer_time_tasks_user_day_unique'));
    expect(idx).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dialer_time_tasks_user_day_unique" ON "dialer_time_tasks" ("user_id", "day")',
    );
    expect(idx).not.toMatch(/WHERE/i);
  });

  it('the schema mirrors the migration', () => {
    const cfg = getTableConfig(dialerTimeTasks);
    expect(cfg.name).toBe('dialer_time_tasks');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      ['id', 'org_id', 'user_id', 'day', 'salesforce_task_id', 'synced_seconds', 'attempts', 'next_attempt_at', 'last_error', 'created_at', 'updated_at'].sort(),
    );
    const unique = cfg.indexes.find((i) => i.config.name === 'dialer_time_tasks_user_day_unique');
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.where).toBeUndefined();
    expect(cfg.foreignKeys).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root packages/db src/migration-0049.test.ts`
Expected: FAIL — `ENOENT … 0049_dialer_time_tasks.sql` / `dialerTimeTasks` not exported.

- [ ] **Step 3: Write the migration** — `packages/db/migrations/0049_dialer_time_tasks.sql`:

```sql
-- =============================================================================
-- 0049_dialer_time_tasks.sql — power-dialer time in Salesforce
-- (design: docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md).
--
-- dialer_time_tasks   One row per (rep, Pacific day): the "Power Dialer Time"
--                     Task salesforce/dialer-time-worker.ts keeps in Salesforce
--                     for that day, and the seconds last written to it. The
--                     number itself is computed from dialer_rep_legs on every
--                     tick; this table only remembers what Salesforce has.
--                     FK-FREE like dialer_rep_legs.
--   day               YYYY-MM-DD, the org's Pacific day.
--   salesforce_task_id NULL until the Task is created or adopted; cleared when
--                     Salesforce says it was deleted, so the next tick recreates it.
--   synced_seconds    The CallDurationInSeconds last written; NULL until then.
--   attempts / next_attempt_at / last_error
--                     Backoff bookkeeping for failed writes (never gives up).
--   (user_id, day)    FULL unique index: the store inserts with a bare
--                     ON CONFLICT DO NOTHING, which a PARTIAL index cannot
--                     arbitrate (42P10).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "dialer_time_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "day" text NOT NULL,
  "salesforce_task_id" text,
  "synced_seconds" integer,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dialer_time_tasks_day_check" CHECK ("day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "dialer_time_tasks_user_day_unique" ON "dialer_time_tasks" ("user_id", "day");
```

- [ ] **Step 4: Add the schema** — append to `packages/db/src/schema.ts` right after `export type DialerRepLeg = typeof dialerRepLegs.$inferSelect;`:

```ts

// =============================================================================
// dialer_time_tasks — the "Power Dialer Time" Task per (rep, Pacific day)
// (migration 0049; salesforce/dialer-time-worker.ts).
// =============================================================================

export const dialerTimeTasks = pgTable(
  'dialer_time_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** YYYY-MM-DD, the org's Pacific day. */
    day: text('day').notNull(),
    /** NULL until created/adopted; cleared when Salesforce says it was deleted. */
    salesforceTaskId: text('salesforce_task_id'),
    /** The CallDurationInSeconds last written; NULL until then. */
    syncedSeconds: integer('synced_seconds'),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // FULL, never partial: dialer-time-store.ts's bare ON CONFLICT DO NOTHING arbitrates on it.
    userDayUnique: uniqueIndex('dialer_time_tasks_user_day_unique').on(t.userId, t.day),
  }),
);

export type DialerTimeTask = typeof dialerTimeTasks.$inferSelect;
```

(`integer`, `text`, `timestamp`, `uuid`, `uniqueIndex`, `pgTable` are already imported at the top of `schema.ts` — confirm with `grep -n "^import" packages/db/src/schema.ts`.)

- [ ] **Step 5: Export the type** — in `packages/db/src/index.ts`, add `DialerTimeTask,` to the `export type { … }` list directly after `DialerRepLegEndSource,`.

- [ ] **Step 6: Run the tests and build**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root packages/db src/migration-0049.test.ts && npm -w packages/db test && npm run build:packages`
Expected: 4/4 new tests pass; the whole db suite passes; build clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add packages/db/migrations/0049_dialer_time_tasks.sql packages/db/src/schema.ts packages/db/src/index.ts packages/db/src/migration-0049.test.ts
git commit -m "feat(db): dialer_time_tasks — one Power Dialer Time Task per rep per day (0049)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Salesforce client — create, patch and find the "Power Dialer Time" Task

**Files:**
- Modify: `services/cti-api/src/salesforce/cti-origin.ts:24-29` (the `CTI_ORIGIN` object)
- Create: `services/cti-api/src/salesforce/dialer-time-client.ts`
- Test: `services/cti-api/src/salesforce/dialer-time-client.test.ts`

**Interfaces:**
- Consumes: `sfFetch(userId, path, init)` → `{ status, json }` and `soqlQuery<T>(userId, soql)` → `T[]` from `./client.js`; `soqlEscape` from `./soql.js`; `CTI_ORIGIN`, `CTI_ORIGIN_FIELD`, `isInvalidFieldError`, `withoutCtiOrigin` from `./cti-origin.js`.
- Produces (used by Task 4):
  - `DIALER_TIME_SUBJECT = 'Power Dialer Time'`
  - `buildDialerTimeTaskFields(day: string, seconds: number): Record<string, unknown>`
  - `createDialerTimeTask(userId: string, day: string, seconds: number): Promise<{ taskId: string }>`
  - `updateDialerTimeTask(userId: string, taskId: string, seconds: number): Promise<'updated' | 'missing'>`
  - `findDialerTimeTask(userId: string, sfUserId: string, day: string): Promise<string | null>`

- [ ] **Step 1: Add the origin value** — in `services/cti-api/src/salesforce/cti-origin.ts`, inside `CTI_ORIGIN`, after `callLog: 'Call Log',` add:

```ts
  /** A rep's daily "Power Dialer Time" Task (salesforce/dialer-time-worker.ts). */
  dialerTime: 'Power Dialer Time',
```

- [ ] **Step 2: Write the failing test** — `services/cti-api/src/salesforce/dialer-time-client.test.ts`:

```ts
/**
 * dialer-time-client — the "Power Dialer Time" Task's create / patch / find.
 * Same fake-transport convention as create-call-task.test.ts: 'undici' is
 * mocked at the module boundary so the REAL client code runs against canned
 * HTTP responses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sfConn: {
    id: 'conn-1',
    userId: 'u1',
    accessTokenEnc: 'fake-access-token',
    refreshTokenEnc: null,
    instanceUrl: 'https://example.my.salesforce.com',
  } as Record<string, unknown> | null,
  mockRequest: vi.fn(),
}));

vi.mock('../config.js', () => ({ loadConfig: () => ({ SALESFORCE_API_VERSION: 'v60.0' }) }));
vi.mock('@cti/auth', () => ({ encryptString: (s: string) => s, decryptString: (s: string) => s }));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () =>
      ({
        query: { salesforceConnections: { findFirst: async () => state.sfConn } },
      }) as unknown as ReturnType<typeof import('@cti/db').getDb>,
  };
});
vi.mock('undici', () => ({ request: (...args: unknown[]) => state.mockRequest(...args) }));

import {
  DIALER_TIME_SUBJECT,
  buildDialerTimeTaskFields,
  createDialerTimeTask,
  findDialerTimeTask,
  updateDialerTimeTask,
} from './dialer-time-client.js';
import { CTI_ORIGIN, CTI_ORIGIN_FIELD } from './cti-origin.js';

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, body: { text: async () => (body === undefined ? '' : JSON.stringify(body)) } };
}
function call(i: number): { url: string; method: string; body: Record<string, unknown> } {
  const [url, opts] = state.mockRequest.mock.calls[i] as [string, { method: string; body?: string }];
  return { url, method: opts.method, body: opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : {} };
}

beforeEach(() => {
  state.mockRequest.mockReset();
});

describe('buildDialerTimeTaskFields', () => {
  it('is a completed, non-call Task dated the Pacific day with the seconds as Call Duration', () => {
    expect(buildDialerTimeTaskFields('2026-10-02', 3254)).toEqual({
      Subject: 'Power Dialer Time',
      Status: 'Completed',
      Priority: 'Normal',
      TaskSubtype: 'Task',
      ActivityDate: '2026-10-02',
      CallDurationInSeconds: 3254,
      Description: 'Time on the power dialer (line open) on 2026-10-02, Pacific. Kept up to date by the CTI.',
      [CTI_ORIGIN_FIELD]: CTI_ORIGIN.dialerTime,
    });
    expect(DIALER_TIME_SUBJECT).toBe('Power Dialer Time');
    expect(CTI_ORIGIN.dialerTime).toBe('Power Dialer Time');
  });

  it('never carries call or record fields', () => {
    const f = buildDialerTimeTaskFields('2026-10-02', 1);
    for (const k of ['CallType', 'CallDisposition', 'WhoId', 'WhatId']) expect(f).not.toHaveProperty(k);
  });
});

describe('createDialerTimeTask', () => {
  it('POSTs the Task as the rep and returns its id', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW1', success: true }));
    await expect(createDialerTimeTask('u1', '2026-10-02', 60)).resolves.toEqual({ taskId: '00TNEW1' });
    const c = call(0);
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://example.my.salesforce.com/services/data/v60.0/sobjects/Task');
    expect(c.body).toEqual(buildDialerTimeTaskFields('2026-10-02', 60));
  });

  it('retries once without the CTI marker when it is rejected as INVALID_FIELD', async () => {
    state.mockRequest
      .mockResolvedValueOnce(jsonResponse(400, [{ errorCode: 'INVALID_FIELD', message: 'No such column' }]))
      .mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW2', success: true }));
    await expect(createDialerTimeTask('u1', '2026-10-02', 60)).resolves.toEqual({ taskId: '00TNEW2' });
    expect(call(1).body).not.toHaveProperty(CTI_ORIGIN_FIELD);
    expect(call(1).body.Subject).toBe('Power Dialer Time');
  });

  it('throws with the status in the message on any other rejection', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(400, [{ errorCode: 'REQUIRED_FIELD_MISSING' }]));
    await expect(createDialerTimeTask('u1', '2026-10-02', 60)).rejects.toThrow(
      /^Salesforce Power Dialer Time create failed \(400\): .*REQUIRED_FIELD_MISSING/,
    );
    expect(state.mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe('updateDialerTimeTask', () => {
  it('PATCHes only the Call Duration', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(204, undefined));
    await expect(updateDialerTimeTask('u1', '00TX', 900)).resolves.toBe('updated');
    const c = call(0);
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe('https://example.my.salesforce.com/services/data/v60.0/sobjects/Task/00TX');
    expect(c.body).toEqual({ CallDurationInSeconds: 900 });
  });

  it.each([
    [404, [{ errorCode: 'NOT_FOUND' }]],
    [404, [{ errorCode: 'ENTITY_IS_DELETED' }]],
    [400, [{ errorCode: 'ENTITY_IS_DELETED' }]],
  ])('reports a deleted Task as missing (%s)', async (status, body) => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(status, body));
    await expect(updateDialerTimeTask('u1', '00TX', 900)).resolves.toBe('missing');
  });

  it('throws on any other rejection', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(500, [{ errorCode: 'UNKNOWN_EXCEPTION' }]));
    await expect(updateDialerTimeTask('u1', '00TX', 900)).rejects.toThrow(/^Salesforce Power Dialer Time update failed \(500\): /);
  });
});

describe('findDialerTimeTask', () => {
  it('queries the rep-owned Task for that day, oldest first, and returns its id', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { records: [{ Id: '00TOLD' }] }));
    await expect(findDialerTimeTask('u1', '005ABC', '2026-10-02')).resolves.toBe('00TOLD');
    const q = new URL(call(0).url).searchParams.get('q');
    expect(q).toBe(
      "SELECT Id FROM Task WHERE Subject = 'Power Dialer Time' AND ActivityDate = 2026-10-02 AND OwnerId = '005ABC' ORDER BY CreatedDate ASC LIMIT 1",
    );
  });

  it('returns null when there is none', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { records: [] }));
    await expect(findDialerTimeTask('u1', '005ABC', '2026-10-02')).resolves.toBeNull();
  });

  it('escapes the owner id and refuses a malformed day without calling Salesforce', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { records: [] }));
    await findDialerTimeTask('u1', "005' OR Id != '", '2026-10-02');
    expect(new URL(call(0).url).searchParams.get('q')).toContain("OwnerId = '005\\' OR Id != \\''");
    await expect(findDialerTimeTask('u1', '005ABC', '2026-10-02 OR x')).rejects.toThrow(/invalid day/);
    expect(state.mockRequest).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-time-client.test.ts`
Expected: FAIL — cannot resolve `./dialer-time-client.js`.

- [ ] **Step 4: Write the client** — `services/cti-api/src/salesforce/dialer-time-client.ts`:

```ts
/**
 * The "Power Dialer Time" Task — one per rep per Pacific day, holding the rep's
 * time on the power dialer (line open) as Call Duration so Salesforce reports
 * can sum it. Written as the rep (the CTI user id → their own Salesforce
 * connection), so the rep owns it. A plain Task, never a Call: call counts and
 * call metrics must not include it. Belongs to no record (no WhoId/WhatId).
 *
 * Design: docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md.
 */
import { sfFetch, soqlQuery } from './client.js';
import { soqlEscape } from './soql.js';
import { CTI_ORIGIN, CTI_ORIGIN_FIELD, isInvalidFieldError, withoutCtiOrigin } from './cti-origin.js';

/** Exact: both Salesforce reports filter on this literal. */
export const DIALER_TIME_SUBJECT = 'Power Dialer Time';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DELETED_CODES = new Set(['NOT_FOUND', 'ENTITY_IS_DELETED']);

export function buildDialerTimeTaskFields(day: string, seconds: number): Record<string, unknown> {
  return {
    Subject: DIALER_TIME_SUBJECT,
    Status: 'Completed',
    Priority: 'Normal',
    TaskSubtype: 'Task',
    ActivityDate: day,
    CallDurationInSeconds: seconds,
    Description: `Time on the power dialer (line open) on ${day}, Pacific. Kept up to date by the CTI.`,
    [CTI_ORIGIN_FIELD]: CTI_ORIGIN.dialerTime,
  };
}

function errorCodes(json: unknown): string[] {
  const entries = Array.isArray(json) ? json : [json];
  return entries
    .map((e) => (e as { errorCode?: unknown } | null)?.errorCode)
    .filter((c): c is string => typeof c === 'string');
}

export async function createDialerTimeTask(userId: string, day: string, seconds: number): Promise<{ taskId: string }> {
  const fields = buildDialerTimeTaskFields(day, seconds);
  let res = await sfFetch(userId, '/sobjects/Task', { method: 'POST', body: fields });
  // The marker is gated by per-rep field-level security: drop only it, once.
  if (res.status >= 400 && isInvalidFieldError(res.json)) {
    res = await sfFetch(userId, '/sobjects/Task', { method: 'POST', body: withoutCtiOrigin(fields) });
  }
  if (res.status >= 400) {
    throw new Error(`Salesforce Power Dialer Time create failed (${res.status}): ${JSON.stringify(res.json)}`);
  }
  return { taskId: (res.json as { id: string }).id };
}

/** 'missing' = Salesforce says the Task is gone (deleted): the caller recreates it. */
export async function updateDialerTimeTask(userId: string, taskId: string, seconds: number): Promise<'updated' | 'missing'> {
  const res = await sfFetch(userId, `/sobjects/Task/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: { CallDurationInSeconds: seconds },
  });
  if (res.status < 400) return 'updated';
  if (res.status === 404 || errorCodes(res.json).some((c) => DELETED_CODES.has(c))) return 'missing';
  throw new Error(`Salesforce Power Dialer Time update failed (${res.status}): ${JSON.stringify(res.json)}`);
}

/** The rep's existing Task for `day`, oldest first — so a crash between a
 *  create and its DB stamp is adopted on the next tick, never duplicated. */
export async function findDialerTimeTask(userId: string, sfUserId: string, day: string): Promise<string | null> {
  if (!DAY_RE.test(day)) throw new Error(`findDialerTimeTask: invalid day ${JSON.stringify(day)}`);
  const rows = await soqlQuery<{ Id: string }>(
    userId,
    `SELECT Id FROM Task WHERE Subject = '${soqlEscape(DIALER_TIME_SUBJECT)}' AND ActivityDate = ${day} AND OwnerId = '${soqlEscape(sfUserId)}' ORDER BY CreatedDate ASC LIMIT 1`,
  );
  return rows[0]?.Id ?? null;
}
```

Note: `encodeURIComponent('00TX')` is `00TX`, so the PATCH URL test holds. Check `soqlEscape` escapes `'` as `\'` (`sed -n 1,20p services/cti-api/src/salesforce/soql.ts`); if its escaping differs, adjust the escape test's expected string to what `soqlEscape` actually produces — the point of the test is that the quote cannot terminate the literal.

- [ ] **Step 5: Run the tests**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-time-client.test.ts src/salesforce/cti-origin.test.ts`
Expected: all pass (cti-origin.test.ts checks every value ≤ 64 chars and unique — `Power Dialer Time` is both).

- [ ] **Step 6: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/salesforce/cti-origin.ts services/cti-api/src/salesforce/dialer-time-client.ts services/cti-api/src/salesforce/dialer-time-client.test.ts
git commit -m "feat(salesforce): create, patch and find the daily Power Dialer Time Task

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The planner (pure) and the store (SQL)

**Files:**
- Create: `services/cti-api/src/salesforce/dialer-time-plan.ts`
- Test: `services/cti-api/src/salesforce/dialer-time-plan.test.ts`
- Create: `services/cti-api/src/salesforce/dialer-time-store.ts`
- Test: `services/cti-api/src/salesforce/dialer-time-store.test.ts`

**Interfaces:**
- Consumes: `addDays(day, n)`, `dayStartUtc(day)`, `dialerSecondsByUserDay(legs, days, now)` and type `LegSpan` from `../reports/talk-time.js`; `orgTodayIso(now)` from `../dialer/org-day.js`; `schema.dialerRepLegs`, `schema.dialerTimeTasks`, `schema.salesforceConnections`, type `DialerTimeTask` from `@cti/db` (Task 1).
- Produces (used by Task 4):
  - `DIALER_TIME_WINDOW_DAYS = 3`
  - `windowDays(now: Date): string[]` — `[today-2, today-1, today]`, Pacific
  - `interface WindowLeg extends LegSpan { orgId: string }`
  - `type SyncedRow = Pick<DialerTimeTask, 'id' | 'userId' | 'day' | 'salesforceTaskId' | 'syncedSeconds' | 'attempts' | 'nextAttemptAt'>`
  - `interface PlannedWrite { orgId: string; userId: string; day: string; seconds: number; row: SyncedRow | null }`
  - `planDialerTimeWrites(input: { legs: readonly WindowLeg[]; days: readonly string[]; now: Date; rows: readonly SyncedRow[] }): PlannedWrite[]`
  - `BACKOFF_MS = [5 min, 15 min, 1 h, 3 h, 6 h]`, `backoffMs(attempts: number): number` (attempts ≥ 1; beyond the list → 6 h)
  - `interface DialerTimeStore { loadLegs(start: Date, end: Date): Promise<WindowLeg[]>; loadRows(days: readonly string[]): Promise<SyncedRow[]>; ensureRow(orgId: string, userId: string, day: string): Promise<SyncedRow>; saveSynced(id: string, taskId: string, seconds: number, now: Date): Promise<void>; saveFailure(id: string, attempts: number, nextAttemptAt: Date, lastError: string, now: Date): Promise<void>; clearTaskId(id: string, now: Date): Promise<void>; sfUserIdFor(userId: string): Promise<string | null> }`
  - `liveDialerTimeStore(db: Db): DialerTimeStore`
  - Statement builders for tests: `windowLegsStatement(db, start, end)`, `rowsForDaysStatement(db, days)`, `insertRowStatement(db, orgId, userId, day)`

- [ ] **Step 1: Write the failing planner test** — `services/cti-api/src/salesforce/dialer-time-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BACKOFF_MS, DIALER_TIME_WINDOW_DAYS, backoffMs, planDialerTimeWrites, windowDays, type SyncedRow, type WindowLeg } from './dialer-time-plan.js';

const MIN = 60_000;
// 2026-10-02 10:00 PDT = 17:00Z
const NOW = new Date('2026-10-02T17:00:00Z');
const DAYS = ['2026-09-30', '2026-10-01', '2026-10-02'];

function leg(userId: string, joined: string, ended: string | null, orgId = 'org1'): WindowLeg {
  return { orgId, userId, joinedAt: new Date(joined), endedAt: ended ? new Date(ended) : null };
}
function row(over: Partial<SyncedRow> & Pick<SyncedRow, 'userId' | 'day'>): SyncedRow {
  return { id: `row-${over.userId}-${over.day}`, salesforceTaskId: '00TX', syncedSeconds: 0, attempts: 0, nextAttemptAt: new Date(0), ...over };
}

describe('windowDays', () => {
  it('is today and the two Pacific days before it', () => {
    expect(DIALER_TIME_WINDOW_DAYS).toBe(3);
    expect(windowDays(NOW)).toEqual(DAYS);
    // 2026-10-02 23:30 PDT is still Oct 2 in Pacific (06:30Z Oct 3)
    expect(windowDays(new Date('2026-10-03T06:30:00Z'))).toEqual(DAYS);
  });
});

describe('planDialerTimeWrites', () => {
  // Garrett: 09:00-09:30 PDT on Oct 2 = 1800 s
  const legs = [leg('g', '2026-10-02T16:00:00Z', '2026-10-02T16:30:00Z')];

  it('plans a create for a rep with time and no row yet', () => {
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows: [] })).toEqual([
      { orgId: 'org1', userId: 'g', day: '2026-10-02', seconds: 1800, row: null },
    ]);
  });

  it('plans nothing when the stored seconds already match', () => {
    const rows = [row({ userId: 'g', day: '2026-10-02', syncedSeconds: 1800 })];
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows })).toEqual([]);
  });

  it('plans an update when the seconds changed, carrying the row', () => {
    const r = row({ userId: 'g', day: '2026-10-02', syncedSeconds: 1200 });
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows: [r] })).toEqual([
      { orgId: 'org1', userId: 'g', day: '2026-10-02', seconds: 1800, row: r },
    ]);
  });

  it('skips a row whose backoff is not due yet', () => {
    const r = row({ userId: 'g', day: '2026-10-02', syncedSeconds: null, attempts: 2, nextAttemptAt: new Date(NOW.getTime() + MIN) });
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows: [r] })).toEqual([]);
  });

  it('counts an open leg up to now, and merges overlapping legs once', () => {
    const open = [
      leg('g', '2026-10-02T16:00:00Z', null), // 09:00 PDT → now (10:00) = 3600 s
      leg('g', '2026-10-02T16:10:00Z', '2026-10-02T16:20:00Z'), // inside the open one
    ];
    expect(planDialerTimeWrites({ legs: open, days: DAYS, now: NOW, rows: [] })[0]?.seconds).toBe(3600);
  });

  it('splits a leg across Pacific midnight onto both days', () => {
    // 23:50 PDT Oct 1 (06:50Z Oct 2) → 00:20 PDT Oct 2 (07:20Z) = 600 s + 1200 s
    const cross = [leg('g', '2026-10-02T06:50:00Z', '2026-10-02T07:20:00Z')];
    const planned = planDialerTimeWrites({ legs: cross, days: DAYS, now: NOW, rows: [] });
    expect(planned.map((p) => [p.day, p.seconds])).toEqual([
      ['2026-10-01', 600],
      ['2026-10-02', 1200],
    ]);
  });

  it('never plans a zero-second day, and keeps each rep with its own org', () => {
    const two = [leg('g', '2026-10-02T16:00:00Z', '2026-10-02T16:00:00Z'), leg('j', '2026-10-02T16:00:00Z', '2026-10-02T16:01:00Z', 'org2')];
    expect(planDialerTimeWrites({ legs: two, days: DAYS, now: NOW, rows: [] })).toEqual([
      { orgId: 'org2', userId: 'j', day: '2026-10-02', seconds: 60, row: null },
    ]);
  });
});

describe('backoffMs', () => {
  it('walks 5m, 15m, 1h, 3h, 6h and then stays at 6h', () => {
    expect(BACKOFF_MS).toEqual([5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN, 360 * MIN]);
    expect([1, 2, 3, 4, 5, 6, 50].map(backoffMs)).toEqual([5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN, 360 * MIN, 360 * MIN, 360 * MIN]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-time-plan.test.ts`
Expected: FAIL — cannot resolve `./dialer-time-plan.js`.

- [ ] **Step 3: Write the planner** — `services/cti-api/src/salesforce/dialer-time-plan.ts`:

```ts
/**
 * Which (rep, Pacific day) "Power Dialer Time" Tasks need a Salesforce write
 * this tick. PURE. The number is exactly the admin Talk time report's "On
 * dialer": dialerSecondsByUserDay — legs merged per rep (overlaps once), split
 * at Pacific midnight, an open leg counted up to `now`.
 */
import type { DialerTimeTask } from '@cti/db';
import { orgTodayIso } from '../dialer/org-day.js';
import { addDays, dialerSecondsByUserDay, type LegSpan } from '../reports/talk-time.js';

/** Today and the two days before: a leg crossing midnight, closing late or
 *  reconciled up to 48 h later still lands on the right day's Task. */
export const DIALER_TIME_WINDOW_DAYS = 3;

const MIN = 60_000;
export const BACKOFF_MS = [5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN, 360 * MIN] as const;

export interface WindowLeg extends LegSpan {
  orgId: string;
}

export type SyncedRow = Pick<DialerTimeTask, 'id' | 'userId' | 'day' | 'salesforceTaskId' | 'syncedSeconds' | 'attempts' | 'nextAttemptAt'>;

export interface PlannedWrite {
  orgId: string;
  userId: string;
  day: string;
  seconds: number;
  row: SyncedRow | null;
}

export function windowDays(now: Date): string[] {
  const today = orgTodayIso(now);
  return Array.from({ length: DIALER_TIME_WINDOW_DAYS }, (_, i) => addDays(today, i - (DIALER_TIME_WINDOW_DAYS - 1)));
}

/** Never gives up: past the list, every retry waits the last step. */
export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;
}

export function planDialerTimeWrites(input: {
  legs: readonly WindowLeg[];
  days: readonly string[];
  now: Date;
  rows: readonly SyncedRow[];
}): PlannedWrite[] {
  const { legs, days, now, rows } = input;
  const orgOf = new Map(legs.map((l) => [l.userId, l.orgId]));
  const rowOf = new Map(rows.map((r) => [`${r.userId}|${r.day}`, r]));
  const seconds = dialerSecondsByUserDay(legs, days, now);
  const planned: PlannedWrite[] = [];
  for (const [userId, byDay] of Object.entries(seconds)) {
    for (const day of days) {
      const s = byDay[day] ?? 0;
      if (s <= 0) continue;
      const row = rowOf.get(`${userId}|${day}`) ?? null;
      if (row && row.syncedSeconds === s) continue;
      if (row && row.nextAttemptAt.getTime() > now.getTime()) continue;
      planned.push({ orgId: orgOf.get(userId)!, userId, day, seconds: s, row });
    }
  }
  return planned;
}
```

Check `dialerSecondsByUserDay`'s return values are integers (`sed -n 84,120p services/cti-api/src/reports/talk-time.ts`). If it returns fractional seconds, wrap with `Math.round(byDay[day] ?? 0)` and say so in the report.

- [ ] **Step 4: Run the planner tests**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-time-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing store test** — `services/cti-api/src/salesforce/dialer-time-store.test.ts`:

```ts
/**
 * dialer-time-store — the SQL, pinned by rendering (no database in the unit
 * suite). Load-bearing: the bare ON CONFLICT DO NOTHING (a targeted one would
 * still work here, but the codebase rule is the bare form, and a PARTIAL index
 * would reject a targeted one with 42P10).
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema } from '@cti/db';
import { insertRowStatement, rowsForDaysStatement, windowLegsStatement } from './dialer-time-store.js';

const db = drizzle(new pg.Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

describe('dialer-time-store SQL', () => {
  it('loads every leg that overlaps the window, open legs included', () => {
    const start = new Date('2026-09-30T07:00:00Z');
    const end = new Date('2026-10-03T07:00:00Z');
    const q = windowLegsStatement(db, start, end).toSQL();
    expect(q.sql).toBe(
      'select "org_id", "user_id", "joined_at", "ended_at" from "dialer_rep_legs" where ("dialer_rep_legs"."joined_at" < $1 and ("dialer_rep_legs"."ended_at" is null or "dialer_rep_legs"."ended_at" > $2))',
    );
    expect(q.params).toEqual([end.toISOString(), start.toISOString()]);
  });

  it('loads the rows for exactly the window days', () => {
    const q = rowsForDaysStatement(db, ['2026-09-30', '2026-10-01', '2026-10-02']).toSQL();
    expect(q.sql).toContain('from "dialer_time_tasks" where "dialer_time_tasks"."day" in ($1, $2, $3)');
    expect(q.params).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('inserts with a bare ON CONFLICT DO NOTHING', () => {
    const q = insertRowStatement(db, 'org1', 'u1', '2026-10-02').toSQL();
    expect(q.sql).toMatch(/^insert into "dialer_time_tasks" /);
    expect(q.sql).toMatch(/on conflict do nothing$/);
    expect(q.sql).not.toMatch(/on conflict \(/);
  });
});
```

Before writing it, confirm how the existing `reports/talk-time-query.test.ts` builds its offline `db` (`sed -n 1,30p services/cti-api/src/reports/talk-time-query.test.ts`) and copy that exact import/construction instead if it differs (e.g. `import { Pool } from 'pg'`). Also confirm the timestamp params render as ISO strings there; if drizzle passes `Date` objects in `params`, compare against the `Date`s instead.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-time-store.test.ts`
Expected: FAIL — cannot resolve `./dialer-time-store.js`.

- [ ] **Step 7: Write the store** — `services/cti-api/src/salesforce/dialer-time-store.ts`:

```ts
/**
 * dialer_time_tasks + dialer_rep_legs access for salesforce/dialer-time-worker.ts.
 * The worker only sees the DialerTimeStore interface, so its tests run on an
 * in-memory store; this file's SQL is pinned in dialer-time-store.test.ts.
 */
import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import type { SyncedRow, WindowLeg } from './dialer-time-plan.js';

type Db = ReturnType<typeof getDb>;
const t = schema.dialerTimeTasks;
const l = schema.dialerRepLegs;

export interface DialerTimeStore {
  loadLegs(start: Date, end: Date): Promise<WindowLeg[]>;
  loadRows(days: readonly string[]): Promise<SyncedRow[]>;
  ensureRow(orgId: string, userId: string, day: string): Promise<SyncedRow>;
  saveSynced(id: string, taskId: string, seconds: number, now: Date): Promise<void>;
  saveFailure(id: string, attempts: number, nextAttemptAt: Date, lastError: string, now: Date): Promise<void>;
  clearTaskId(id: string, now: Date): Promise<void>;
  sfUserIdFor(userId: string): Promise<string | null>;
}

const rowColumns = {
  id: t.id,
  userId: t.userId,
  day: t.day,
  salesforceTaskId: t.salesforceTaskId,
  syncedSeconds: t.syncedSeconds,
  attempts: t.attempts,
  nextAttemptAt: t.nextAttemptAt,
};

export function windowLegsStatement(db: Db, start: Date, end: Date) {
  return db
    .select({ orgId: l.orgId, userId: l.userId, joinedAt: l.joinedAt, endedAt: l.endedAt })
    .from(l)
    .where(and(lt(l.joinedAt, end), or(isNull(l.endedAt), gt(l.endedAt, start))));
}

export function rowsForDaysStatement(db: Db, days: readonly string[]) {
  return db.select(rowColumns).from(t).where(inArray(t.day, [...days]));
}

export function insertRowStatement(db: Db, orgId: string, userId: string, day: string) {
  return db.insert(t).values({ orgId, userId, day }).onConflictDoNothing();
}

export function liveDialerTimeStore(db: Db): DialerTimeStore {
  return {
    loadLegs: (start, end) => windowLegsStatement(db, start, end),
    loadRows: (days) => (days.length === 0 ? Promise.resolve([]) : rowsForDaysStatement(db, days)),
    async ensureRow(orgId, userId, day) {
      await insertRowStatement(db, orgId, userId, day);
      const [row] = await db.select(rowColumns).from(t).where(and(eq(t.userId, userId), eq(t.day, day))).limit(1);
      if (!row) throw new Error('dialer_time_tasks row missing after insert');
      return row;
    },
    async saveSynced(id, taskId, seconds, now) {
      await db
        .update(t)
        .set({ salesforceTaskId: taskId, syncedSeconds: seconds, attempts: 0, nextAttemptAt: now, lastError: null, updatedAt: now })
        .where(eq(t.id, id));
    },
    async saveFailure(id, attempts, nextAttemptAt, lastError, now) {
      await db.update(t).set({ attempts, nextAttemptAt, lastError, updatedAt: now }).where(eq(t.id, id));
    },
    async clearTaskId(id, now) {
      await db.update(t).set({ salesforceTaskId: null, syncedSeconds: null, updatedAt: now }).where(eq(t.id, id));
    },
    async sfUserIdFor(userId) {
      const [conn] = await db
        .select({ sfUserId: schema.salesforceConnections.sfUserId })
        .from(schema.salesforceConnections)
        .where(eq(schema.salesforceConnections.userId, userId))
        .limit(1);
      return conn?.sfUserId ?? null;
    },
  };
}
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-time-plan.test.ts src/salesforce/dialer-time-store.test.ts && npm -w services/cti-api run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 9: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/salesforce/dialer-time-plan.ts services/cti-api/src/salesforce/dialer-time-plan.test.ts services/cti-api/src/salesforce/dialer-time-store.ts services/cti-api/src/salesforce/dialer-time-store.test.ts
git commit -m "feat(salesforce): plan which daily Power Dialer Time Tasks need a write; the store's SQL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The worker, its kill switch, server wiring and runbook

**Files:**
- Create: `services/cti-api/src/salesforce/error-summary.ts`
- Modify: `services/cti-api/src/salesforce/dialer-connect-worker.ts` (move `errorText`, `SF_ERROR_FALLBACK`, `sfErrorSummary`, `unexpectedErrorSummary` out; re-export them)
- Create: `services/cti-api/src/salesforce/dialer-time-worker.ts`
- Test: `services/cti-api/src/salesforce/dialer-time-worker.test.ts`
- Modify: `services/cti-api/src/config.ts` (after `DIALER_CONNECT_TASKS`, ~line 174)
- Modify: `services/cti-api/src/server.ts` (~line 139 and the `close` handler ~line 147)
- Create: `docs/runbooks/dialer-time-tasks.md`

**Interfaces:**
- Consumes: Task 2's `createDialerTimeTask`, `updateDialerTimeTask`, `findDialerTimeTask`; Task 3's `windowDays`, `planDialerTimeWrites`, `backoffMs`, `PlannedWrite`, `SyncedRow`, `DialerTimeStore`, `liveDialerTimeStore`; `dayStartUtc`, `addDays` from `../reports/talk-time.js`; `isSalesforceAuthError`, `withTimeout` from `./followup-worker.js`.
- Produces: `runDialerTimeTick(deps?)`, `startDialerTimeLoop(intervalMs?)`, `maybeStartDialerTimeLoop(cfg, start?)`, `DIALER_TIME_INTERVAL_MS = 300_000`; config `DIALER_TIME_TASKS`.

- [ ] **Step 1: Move the log helpers** — create `services/cti-api/src/salesforce/error-summary.ts` containing, moved VERBATIM from `dialer-connect-worker.ts` (with their doc comments): `export function errorText`, `const SF_ERROR_FALLBACK`, `export function sfErrorSummary`, `export function unexpectedErrorSummary`. Add this header:

```ts
/**
 * Console-safe error summaries shared by the Salesforce workers. `errorText`
 * is the full text (500 chars) for a row's last_error column; the two
 * summaries are what may reach a log line — Salesforce errorCodes, an HTTP
 * status, a Postgres SQLSTATE or an error class, never a message body
 * (Salesforce echoes field values such as phone numbers on some codes).
 */
```

Then in `dialer-connect-worker.ts` delete those four definitions and add, next to the other imports:

```ts
import { errorText, sfErrorSummary, unexpectedErrorSummary } from './error-summary.js';
export { errorText, sfErrorSummary, unexpectedErrorSummary } from './error-summary.js';
```

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-connect-worker.test.ts && npm -w services/cti-api run typecheck`
Expected: PASS unchanged (its tests import `sfErrorSummary` / `unexpectedErrorSummary` from `./dialer-connect-worker.js`, served by the re-export). Commit:

```bash
git add services/cti-api/src/salesforce/error-summary.ts services/cti-api/src/salesforce/dialer-connect-worker.ts
git commit -m "refactor(salesforce): share the console-safe error summaries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing worker test** — `services/cti-api/src/salesforce/dialer-time-worker.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SalesforceUnauthorizedError } from './client.js';
import type { DialerTimeStore } from './dialer-time-store.js';
import type { SyncedRow, WindowLeg } from './dialer-time-plan.js';
import { DIALER_TIME_INTERVAL_MS, maybeStartDialerTimeLoop, runDialerTimeTick, type DialerTimeDeps } from './dialer-time-worker.js';

const NOW = new Date('2026-10-02T17:00:00Z'); // 10:00 PDT
const MIN = 60_000;
// 09:00-09:30 PDT → 1800 s on 2026-10-02
const LEG: WindowLeg = { orgId: 'org1', userId: 'g', joinedAt: new Date('2026-10-02T16:00:00Z'), endedAt: new Date('2026-10-02T16:30:00Z') };

function memoryStore(init: { legs?: WindowLeg[]; rows?: SyncedRow[]; sfUserId?: string | null } = {}) {
  const rows = new Map<string, SyncedRow>((init.rows ?? []).map((r) => [r.id, { ...r }]));
  const calls: string[] = [];
  const store: DialerTimeStore & { rows: Map<string, SyncedRow>; failures: Array<{ id: string; attempts: number; next: Date; err: string }> } = {
    rows,
    failures: [],
    loadLegs: async () => init.legs ?? [LEG],
    loadRows: async (days) => [...rows.values()].filter((r) => days.includes(r.day)),
    async ensureRow(orgId, userId, day) {
      calls.push(`ensure ${userId} ${day}`);
      const found = [...rows.values()].find((r) => r.userId === userId && r.day === day);
      if (found) return found;
      const r: SyncedRow = { id: `row-${userId}-${day}`, userId, day, salesforceTaskId: null, syncedSeconds: null, attempts: 0, nextAttemptAt: new Date(0) };
      rows.set(r.id, r);
      return r;
    },
    async saveSynced(id, taskId, seconds) {
      const r = rows.get(id)!;
      rows.set(id, { ...r, salesforceTaskId: taskId, syncedSeconds: seconds, attempts: 0 });
    },
    async saveFailure(id, attempts, next, err) {
      store.failures.push({ id, attempts, next, err });
      const r = rows.get(id)!;
      rows.set(id, { ...r, attempts, nextAttemptAt: next });
    },
    async clearTaskId(id) {
      const r = rows.get(id)!;
      rows.set(id, { ...r, salesforceTaskId: null, syncedSeconds: null });
    },
    sfUserIdFor: async () => (init.sfUserId === undefined ? '005G' : init.sfUserId),
  };
  return { store, calls };
}

function deps(store: DialerTimeStore, sf: Partial<DialerTimeDeps['sf']> = {}): DialerTimeDeps {
  return {
    store,
    now: () => NOW,
    sf: {
      createDialerTimeTask: vi.fn(async () => ({ taskId: '00TNEW' })),
      updateDialerTimeTask: vi.fn(async () => 'updated' as const),
      findDialerTimeTask: vi.fn(async () => null),
      ...sf,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('runDialerTimeTick', () => {
  it('creates the day\'s Task as the rep and stamps its id and seconds', async () => {
    const { store } = memoryStore();
    const d = deps(store);
    await expect(runDialerTimeTick(d)).resolves.toEqual({ planned: 1, written: 1 });
    expect(d.sf.findDialerTimeTask).toHaveBeenCalledWith('g', '005G', '2026-10-02');
    expect(d.sf.createDialerTimeTask).toHaveBeenCalledWith('g', '2026-10-02', 1800);
    expect(store.rows.get('row-g-2026-10-02')).toMatchObject({ salesforceTaskId: '00TNEW', syncedSeconds: 1800 });
  });

  it('adopts a Task already in Salesforce instead of creating a second one', async () => {
    const { store } = memoryStore();
    const d = deps(store, { findDialerTimeTask: vi.fn(async () => '00TOLD') });
    await runDialerTimeTick(d);
    expect(d.sf.createDialerTimeTask).not.toHaveBeenCalled();
    expect(d.sf.updateDialerTimeTask).toHaveBeenCalledWith('g', '00TOLD', 1800);
    expect(store.rows.get('row-g-2026-10-02')).toMatchObject({ salesforceTaskId: '00TOLD', syncedSeconds: 1800 });
  });

  it('PATCHes the known Task when the seconds changed, and does nothing when they did not', async () => {
    const r: SyncedRow = { id: 'r1', userId: 'g', day: '2026-10-02', salesforceTaskId: '00TX', syncedSeconds: 1200, attempts: 0, nextAttemptAt: new Date(0) };
    const { store } = memoryStore({ rows: [r] });
    const d = deps(store);
    await runDialerTimeTick(d);
    expect(d.sf.updateDialerTimeTask).toHaveBeenCalledWith('g', '00TX', 1800);
    expect(d.sf.findDialerTimeTask).not.toHaveBeenCalled();
    expect(store.rows.get('r1')?.syncedSeconds).toBe(1800);
    await expect(runDialerTimeTick(d)).resolves.toEqual({ planned: 0, written: 0 });
  });

  it('clears the id when Salesforce says the Task is gone, and recreates it next tick', async () => {
    const r: SyncedRow = { id: 'r1', userId: 'g', day: '2026-10-02', salesforceTaskId: '00TGONE', syncedSeconds: 1200, attempts: 0, nextAttemptAt: new Date(0) };
    const { store } = memoryStore({ rows: [r] });
    const d = deps(store, { updateDialerTimeTask: vi.fn(async () => 'missing' as const) });
    await runDialerTimeTick(d);
    expect(store.rows.get('r1')).toMatchObject({ salesforceTaskId: null, syncedSeconds: null });
    await runDialerTimeTick(d);
    expect(d.sf.createDialerTimeTask).toHaveBeenCalledWith('g', '2026-10-02', 1800);
  });

  it('an auth error is skipped uncounted; any other error backs off with the full text in last_error only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = memoryStore();
    const d = deps(store, { createDialerTimeTask: vi.fn(async () => { throw new SalesforceUnauthorizedError(); }) });
    await runDialerTimeTick(d);
    expect(store.failures).toEqual([]);

    const body = [{ message: 'Subject: (619) 555-9999', errorCode: 'STRING_TOO_LONG' }];
    d.sf.createDialerTimeTask = vi.fn(async () => {
      throw new Error(`Salesforce Power Dialer Time create failed (400): ${JSON.stringify(body)}`);
    });
    await runDialerTimeTick(d);
    expect(store.failures).toHaveLength(1);
    expect(store.failures[0]).toMatchObject({ id: 'row-g-2026-10-02', attempts: 1, next: new Date(NOW.getTime() + 5 * MIN) });
    expect(store.failures[0]!.err).toContain('(619) 555-9999');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('STRING_TOO_LONG');
    expect(logged).not.toContain('555-9999');
  });

  it('skips a rep with no Salesforce connection without creating anything', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = memoryStore({ sfUserId: null });
    const d = deps(store);
    await runDialerTimeTick(d);
    expect(d.sf.createDialerTimeTask).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain('"userId":"g"');
  });

  it('one rep failing never stops the next rep', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const j: WindowLeg = { ...LEG, userId: 'j' };
    const { store } = memoryStore({ legs: [LEG, j] });
    store.ensureRow = vi.fn(async (orgId, userId, day) => {
      if (userId === 'g') throw new Error('db down');
      return { id: `row-${userId}-${day}`, userId, day, salesforceTaskId: null, syncedSeconds: null, attempts: 0, nextAttemptAt: new Date(0) };
    });
    const d = deps(store);
    await runDialerTimeTick(d);
    expect(d.sf.createDialerTimeTask).toHaveBeenCalledWith('j', '2026-10-02', 1800);
  });
});

describe('maybeStartDialerTimeLoop', () => {
  it('starts on, never off', () => {
    const start = vi.fn(() => ({}) as NodeJS.Timeout);
    expect(maybeStartDialerTimeLoop({ DIALER_TIME_TASKS: 'off' }, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
    maybeStartDialerTimeLoop({ DIALER_TIME_TASKS: 'on' }, start);
    expect(start).toHaveBeenCalledWith(DIALER_TIME_INTERVAL_MS);
    expect(DIALER_TIME_INTERVAL_MS).toBe(300_000);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-time-worker.test.ts`
Expected: FAIL — cannot resolve `./dialer-time-worker.js`.

- [ ] **Step 4: Write the worker** — `services/cti-api/src/salesforce/dialer-time-worker.ts`:

```ts
/**
 * Power-dialer time → Salesforce. Every 5 minutes (and once at start-up), for
 * the last 3 Pacific days: each rep's time on the power dialer (line open,
 * dialer_rep_legs, merged — the admin Talk time screen's "On dialer") is
 * written to ONE "Power Dialer Time" Task per (rep, day), as the rep, so
 * Salesforce reports can sum it. dialer_time_tasks remembers the Task id and
 * the seconds last written; a write happens only when they differ.
 *
 * No duplicates: before a create, the rep's existing Task for that day is
 * looked up and adopted — so a crash between create and stamp, or a lost row,
 * is repaired on the next tick. A Task deleted in Salesforce is recreated.
 * Errors: a Salesforce auth error waits for the rep to reconnect (uncounted);
 * anything else backs off 5 m → 6 h and keeps trying (the day's number must
 * converge). Logs carry ids and error codes only.
 *
 * Kill switch: DIALER_TIME_TASKS=off never starts the loop.
 * Design: docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md.
 */
import { getDb } from '@cti/db';
import type { AppConfig } from '../config.js';
import { addDays, dayStartUtc } from '../reports/talk-time.js';
import { createDialerTimeTask, findDialerTimeTask, updateDialerTimeTask } from './dialer-time-client.js';
import { backoffMs, planDialerTimeWrites, windowDays, type PlannedWrite } from './dialer-time-plan.js';
import { liveDialerTimeStore, type DialerTimeStore } from './dialer-time-store.js';
import { errorText, unexpectedErrorSummary } from './error-summary.js';
import { isSalesforceAuthError, withTimeout } from './followup-worker.js';

export const DIALER_TIME_INTERVAL_MS = 300_000;
export const SF_TIMEOUT_MS = 30_000;
export const LOG = '[dialer-time-worker]';

export interface DialerTimeDeps {
  store: DialerTimeStore;
  now: () => Date;
  sf: {
    createDialerTimeTask: typeof createDialerTimeTask;
    updateDialerTimeTask: typeof updateDialerTimeTask;
    findDialerTimeTask: typeof findDialerTimeTask;
  };
}

function liveDeps(): DialerTimeDeps {
  return {
    store: liveDialerTimeStore(getDb()),
    now: () => new Date(),
    sf: { createDialerTimeTask, updateDialerTimeTask, findDialerTimeTask },
  };
}

/** Create — or adopt the rep's existing Task for the day — and return its id; null = skipped. */
async function createOrAdopt(w: PlannedWrite, deps: DialerTimeDeps): Promise<string | null> {
  const sfUserId = await deps.store.sfUserIdFor(w.userId);
  if (!sfUserId) {
    console.warn(`${LOG} no Salesforce connection — skipped`, { userId: w.userId, day: w.day });
    return null;
  }
  const existing = await withTimeout(deps.sf.findDialerTimeTask(w.userId, sfUserId, w.day), SF_TIMEOUT_MS, 'Salesforce Task lookup');
  if (existing) {
    const r = await withTimeout(deps.sf.updateDialerTimeTask(w.userId, existing, w.seconds), SF_TIMEOUT_MS, 'Salesforce Task update');
    if (r === 'updated') return existing;
  }
  const { taskId } = await withTimeout(deps.sf.createDialerTimeTask(w.userId, w.day, w.seconds), SF_TIMEOUT_MS, 'Salesforce Task create');
  return taskId;
}

/** One (rep, day). Returns true when Salesforce now holds `w.seconds`. */
async function syncOne(w: PlannedWrite, deps: DialerTimeDeps): Promise<boolean> {
  const row = w.row ?? (await deps.store.ensureRow(w.orgId, w.userId, w.day));
  try {
    if (row.salesforceTaskId) {
      const r = await withTimeout(deps.sf.updateDialerTimeTask(w.userId, row.salesforceTaskId, w.seconds), SF_TIMEOUT_MS, 'Salesforce Task update');
      if (r === 'missing') {
        await deps.store.clearTaskId(row.id, deps.now());
        console.warn(`${LOG} Task was deleted in Salesforce — recreating next tick`, { userId: w.userId, day: w.day });
        return false;
      }
      await deps.store.saveSynced(row.id, row.salesforceTaskId, w.seconds, deps.now());
      return true;
    }
    const taskId = await createOrAdopt(w, deps);
    if (!taskId) return false;
    await deps.store.saveSynced(row.id, taskId, w.seconds, deps.now());
    return true;
  } catch (err) {
    if (isSalesforceAuthError(err)) return false; // the rep reconnects; uncounted
    const attempts = row.attempts + 1;
    const now = deps.now();
    await deps.store.saveFailure(row.id, attempts, new Date(now.getTime() + backoffMs(attempts)), errorText(err), now);
    console.warn(`${LOG} write failed, will retry`, { userId: w.userId, day: w.day, attempts, err: unexpectedErrorSummary(err) });
    return false;
  }
}

export async function runDialerTimeTick(deps: DialerTimeDeps = liveDeps()): Promise<{ planned: number; written: number }> {
  const now = deps.now();
  const days = windowDays(now);
  const legs = await deps.store.loadLegs(dayStartUtc(days[0]!), dayStartUtc(addDays(days[days.length - 1]!, 1)));
  const rows = await deps.store.loadRows(days);
  const planned = planDialerTimeWrites({ legs, days, now, rows });
  let written = 0;
  for (const w of planned) {
    try {
      if (await syncOne(w, deps)) written++;
    } catch (err) {
      // A store failure (the row insert, the failure stamp): log, move on to the next rep.
      console.error(`${LOG} rep failed`, { userId: w.userId, day: w.day, err: unexpectedErrorSummary(err) });
    }
  }
  return { planned: planned.length, written };
}

/** Single-flight: a slow tick is never overlapped. Runs once immediately. */
export function startDialerTimeLoop(intervalMs = DIALER_TIME_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runDialerTimeTick()
      .catch((err) => console.error(`${LOG} tick error`, { err: unexpectedErrorSummary(err) }))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, 0);
  return setInterval(tick, intervalMs);
}

/** The kill switch (config.ts DIALER_TIME_TASKS). `start` is a test seam. */
export function maybeStartDialerTimeLoop(
  cfg: Pick<AppConfig, 'DIALER_TIME_TASKS'>,
  start: (intervalMs: number) => NodeJS.Timeout = startDialerTimeLoop,
): NodeJS.Timeout | null {
  return cfg.DIALER_TIME_TASKS === 'on' ? start(DIALER_TIME_INTERVAL_MS) : null;
}
```

- [ ] **Step 5: Add the kill switch** — in `services/cti-api/src/config.ts`, directly after the `DIALER_CONNECT_TASKS: z.enum(['on', 'off']).default('on'),` line:

```ts

  /**
   * Kill switch for the daily "Power Dialer Time" Tasks
   * (salesforce/dialer-time-worker.ts). `off` = the loop is never started: no
   * Task is created or updated. dialer_rep_legs is still written, so turning
   * it back on catches up the last 3 days. Default `on`; strict enum like
   * NO_ANSWER_CHATTER.
   */
  DIALER_TIME_TASKS: z.enum(['on', 'off']).default('on'),
```

- [ ] **Step 6: Wire the server** — in `services/cti-api/src/server.ts`: add the import beside the dialer-connect one:

```ts
import { maybeStartDialerTimeLoop } from './salesforce/dialer-time-worker.js';
```

after `const dialerConnectTimer = maybeStartDialerConnectLoop(cfg);` add:

```ts
  // Each rep's time on the power dialer → one "Power Dialer Time" Task per day.
  // Null when DIALER_TIME_TASKS=off.
  const dialerTimeTimer = maybeStartDialerTimeLoop(cfg);
```

and in `close`, after `if (dialerConnectTimer) clearInterval(dialerConnectTimer);`:

```ts
    if (dialerTimeTimer) clearInterval(dialerTimeTimer);
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npx vitest run --root services/cti-api src/salesforce/dialer-time-worker.test.ts src/salesforce/dialer-connect-worker.test.ts && npm -w services/cti-api run typecheck`
Expected: PASS; typecheck clean. If any existing test builds a full `AppConfig` object literal and now fails typecheck for the missing `DIALER_TIME_TASKS`, add `DIALER_TIME_TASKS: 'on'` to that literal.

- [ ] **Step 8: Write the runbook** — `docs/runbooks/dialer-time-tasks.md`:

````markdown
# Power Dialer Time in Salesforce

Each rep gets ONE completed Task per Pacific day, Subject **Power Dialer
Time**, owned by the rep, whose **Call Duration** is their time on the power
dialer that day (line open: dialing, hold music and talking — the admin
Talk time screen's "On dialer"). The CTI updates it every 5 minutes while
they dial and re-checks the last 3 days. Design:
`docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md`.

## Switch (Railway `@cti/api` variable — changing it restarts the service)

| Variable | Default | `off` means |
|---|---|---|
| `DIALER_TIME_TASKS` | `on` | no Power Dialer Time Tasks are created or updated; turning it back on catches up the last 3 days |

## Reports

- The reps' talk-time report (`00OUS000007DAyP2AW`) filters Subject
  `contains Outbound,Inbound,Power Dialer Time`: each rep has a "Power Dialer
  Time" row beside their call rows. Its grand total adds dialer time to talk
  time — read the rows.
- **Power Dialer Time by Rep**: Subject equals `Power Dialer Time`, any date
  range, grouped by Assigned, Sum of Call Duration (seconds).

## Checks (read-only SQL)

```bash
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
PGOPTIONS='-c default_transaction_read_only=on' psql "$PUB"
```

```sql
-- Today's rows: Task id, seconds in Salesforce, failures
select user_id, day, salesforce_task_id, synced_seconds, attempts, next_attempt_at, left(last_error, 80)
from dialer_time_tasks
where day = to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD')
order by synced_seconds desc nulls last;

-- Anything failing
select user_id, day, attempts, next_attempt_at, left(last_error, 120)
from dialer_time_tasks where attempts > 0 order by next_attempt_at;
```

A row with no `salesforce_task_id` and nothing in `last_error` → the rep has
no Salesforce connection, or their sign-in expired (they reconnect; it
catches up on the next tick).

## Not covered

Days before 2026-10-01 19:15 PT: dialer time was not tracked before then.
````

- [ ] **Step 9: Full verification**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npm run build:packages && npm -w packages/db test && npm -w services/cti-api test && npm -w services/cti-api run typecheck`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/salesforce/dialer-time-worker.ts services/cti-api/src/salesforce/dialer-time-worker.test.ts services/cti-api/src/config.ts services/cti-api/src/server.ts docs/runbooks/dialer-time-tasks.md
git commit -m "feat(salesforce): daily Power Dialer Time Task per rep, kept current every 5 min

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After Task 4

1. **Whole-branch review** over `git merge-base origin/main HEAD..HEAD` with this plan's Global Constraints; fix Critical/Important findings with one fix subagent; re-review.
2. **Ship** (approved by the user 2026-10-02: "ship it in a quiet gap"): fast-forward `origin/main` to the branch in a gap with no live power-dial run (no `/telephony/twilio/dialer-status` requests for 15 min); confirm the `@cti/api` deploy and `[migrate] applying 0049_dialer_time_tasks.sql`.
3. **Live check:** within ~5 min of deploy, `dialer_time_tasks` has a row with a `salesforce_task_id` for each rep who dialed today, and its `synced_seconds` matches the read-only "on dialer" query (± one tick). Open one Task in Salesforce: Subject, Completed, Call Duration, owner = the rep.
4. **Reports (user-approved):** in the user's Chrome — edit `00OUS000007DAyP2AW`'s Subject filter to `contains Outbound,Inbound,Power Dialer Time`; create "Power Dialer Time by Rep" (Tasks and Events; Subject equals `Power Dialer Time`; Due Date range; group by Assigned; Sum of Call Duration) in the same folder. Stop and hand back to the user on any Salesforce login or permission prompt.
