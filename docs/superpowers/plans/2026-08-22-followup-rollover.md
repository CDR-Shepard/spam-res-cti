# Follow-up Rollover (2 attempts, daily cap, queued creation) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Follow-up task rolls over only after the dialer has tried the record twice that day, lands on the first business day with fewer than the org's cap (default 100) of the rep's follow-ups, is created through a retrying single-flight queue, and the record screen-pops only when a human is on the line.

**Architecture:** The engine (`dialer/engine.ts`) stops calling Salesforce on a miss. A first miss re-queues the record as a new attempt-2 row (5-minute floor); a second miss inserts one idempotent row into a new `followup_rollover_jobs` table. A new single-flight worker (`salesforce/followup-worker.ts`, a sibling of the existing sync worker) drains that table: find the rep's open Follow-up, pick the first business day under the cap via a live `COUNT()`, create the copy, then complete the original — recording `created_task_id` before completing so retries never duplicate. The client pops only on `connected` and shows attempt/retry state.

**Tech Stack:** Fastify + Drizzle/Postgres + raw-SQL migrations (`services/cti-api`), Salesforce REST via `sfFetch`/`soqlQuery`, Vitest (node env, no jsdom) on both packages, React 18 in `apps/cti-web` (SSR + pure-function tests only).

## Global Constraints

- Migrations are raw SQL files in `services/cti-api/migrations/`, numbered; the next is **`0024_followup_rollover.sql`**. Every statement must be `IF NOT EXISTS`/additive — current runs keep working during deploy.
- Constants, exact values: `RETRY_FLOOR_MS = 5 * 60_000`; `FOLLOWUP_DAILY_CAP_DEFAULT = 100`; `MAX_ROLLOVER_BUSINESS_DAYS = 30`; worker `MAX_ATTEMPTS = 8`, `BACKOFF_BASE_MS = 30_000` (×2ⁿ), `STUCK_AFTER_MS = 2 * 60_000`, tick interval `5000` ms.
- A **miss** = any terminal outcome that did not reach a human, after the existing Mobile→Phone fallback is exhausted. The `connected` path is unchanged.
- Duplicate Twilio webhooks must be harmless: the attempt-2 insert rides inside the existing compare-and-swap; the job insert is `ON CONFLICT DO NOTHING` on `(user_id, record_id, from_date)`.
- **Create before complete**, and stamp `created_task_id` on the job immediately after create, before the PATCH.
- The count query counts ALL of the rep's open Follow-up tasks due that day (`OwnerId = rep AND IsClosed = false AND ActivityDate = :day AND Subject LIKE follow-up variants`) — hand-created included.
- `SalesforceUnauthorizedError` → job `failed` immediately with error `reconnect Salesforce`.
- Client: pop only when `currentItem.status === 'connected'`. Tests in `apps/cti-web` are pure functions + `renderToStaticMarkup` only (no jsdom, no testing-library).
- Verify each task with `npm test` + `npm run typecheck` in the package touched. The last task also runs `npm run build` in `apps/cti-web`.
- Follow existing idioms: `fakeDb` in `dialer/engine.test.ts`; `vi.mock('./client.js', …)` in `salesforce/followup.test.ts`; pure helper + thin wrapper everywhere.

---

### Task 1: Migration + schema + queue rows carry the immutable number pair

**Files:**
- Create: `services/cti-api/migrations/0024_followup_rollover.sql`
- Modify: `services/cti-api/src/db/schema.ts` (dialer_queue_items columns; new `followupRolloverJobs` table; `campaignConfigs.followupDailyCap`)
- Modify: `services/cti-api/src/dialer/create-session.ts` (`buildQueueRows`)
- Test: `services/cti-api/src/dialer/create-session.test.ts`

**Interfaces:**
- Produces: `schema.dialerQueueItems` gains `attempt: integer` (default 1), `primaryNumber: text`, `secondaryNumber: text`, `retryNotBefore: timestamptz`. New `schema.followupRolloverJobs` (see Step 3). `schema.campaignConfigs.followupDailyCap: integer` (default 100). `buildQueueRows` rows include `attempt: 1, primaryNumber, secondaryNumber`.

- [ ] **Step 1: Write the failing test** — append to `services/cti-api/src/dialer/create-session.test.ts`:

```ts
describe('buildQueueRows — immutable number pair + attempt', () => {
  it('records the resolved Mobile/Phone as primary/secondary, attempt 1, so a retry can restore them', () => {
    const rows = buildQueueRows('S1', 'Lead', [
      { recordId: '00Q1', toNumber: '+16195550100', fallbackNumber: '+16195550199' },
      { recordId: '00Q2', toNumber: '+16195550200', fallbackNumber: null },
      { recordId: '00Q3', toNumber: null },
    ]);
    expect(rows[0]).toMatchObject({ attempt: 1, primaryNumber: '+16195550100', secondaryNumber: '+16195550199' });
    expect(rows[1]).toMatchObject({ attempt: 1, primaryNumber: '+16195550200', secondaryNumber: null });
    expect(rows[2]).toMatchObject({ attempt: 1, primaryNumber: null, secondaryNumber: null, status: 'unreachable' });
  });
});
```

(Ensure `buildQueueRows` is imported at the top of the test file; it is exported from `./create-session.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/create-session.test.ts`
Expected: FAIL — `attempt`/`primaryNumber` missing from the row objects.

- [ ] **Step 3: Write the migration** — create `services/cti-api/migrations/0024_followup_rollover.sql`:

```sql
-- Follow-up rollover v2: two attempts per record per day, a per-rep daily cap on
-- Follow-up tasks, and queued (retrying, idempotent) task creation.
--
-- dialer_queue_items: one row = one dial attempt. `attempt` is 1 or 2; a retry is
-- a NEW row for the same record. `primary_number`/`secondary_number` are the
-- record's Mobile/Phone as resolved at creation and are never mutated (the
-- fallback overwrites to_number/fallback_number, so a retry needs these to
-- restore "Mobile first, Phone fallback"). `retry_not_before` is the 5-minute
-- floor on attempt-2 rows.
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 1;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "primary_number" text;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "secondary_number" text;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "retry_not_before" timestamptz;

-- Per-org daily cap on Follow-up tasks per rep (counted live in Salesforce).
ALTER TABLE "campaign_configs" ADD COLUMN IF NOT EXISTS "followup_daily_cap" integer NOT NULL DEFAULT 100;

-- Rollover jobs: mirrors salesforce_sync_jobs. Drained single-flight by
-- salesforce/followup-worker.ts. UNIQUE(user_id, record_id, from_date) makes a
-- duplicated Twilio webhook's second enqueue a no-op.
CREATE TABLE IF NOT EXISTS "followup_rollover_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "sf_owner_id" text NOT NULL,
  "session_id" uuid REFERENCES "dialer_sessions"("id") ON DELETE SET NULL,
  "record_id" text NOT NULL,
  "object_type" text NOT NULL,
  "from_date" text NOT NULL,
  "status" "sync_status" NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "completed_task_id" text,
  "created_task_id" text,
  "target_date" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "followup_rollover_unique" ON "followup_rollover_jobs" ("user_id", "record_id", "from_date");
CREATE INDEX IF NOT EXISTS "followup_rollover_status_idx" ON "followup_rollover_jobs" ("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "followup_rollover_session_idx" ON "followup_rollover_jobs" ("session_id");
```

- [ ] **Step 4: Update the Drizzle schema** — in `services/cti-api/src/db/schema.ts`:

Inside the `dialerQueueItems` column object, after `outcome: text('outcome'),` add:

```ts
    /** 1 or 2. A retry is a NEW row for the same record (see engine.ts). */
    attempt: integer('attempt').default(1).notNull(),
    /** Resolved Mobile/Phone at creation — never mutated; a retry restores from these. */
    primaryNumber: text('primary_number'),
    secondaryNumber: text('secondary_number'),
    /** 5-minute floor on attempt-2 rows: not dialable before this instant. */
    retryNotBefore: timestamp('retry_not_before', { withTimezone: true }),
```

Inside `campaignConfigs`, after `perCustomerMaxAttempts`, add:

```ts
    /** Max open Follow-up tasks a rep may have due on one day; rollover overflow
     *  walks forward business day by business day. Counted live in Salesforce. */
    followupDailyCap: integer('followup_daily_cap').default(100).notNull(),
```

After the `salesforceSyncJobs` table definition, add:

```ts
/**
 * Follow-up rollover jobs — the dialer enqueues one on a record's SECOND miss of
 * the day; salesforce/followup-worker.ts drains them single-flight (create the
 * next-day copy under the daily cap, then complete the original). Mirrors
 * salesforce_sync_jobs. UNIQUE(user, record, from_date) = duplicate-webhook safe.
 */
export const followupRolloverJobs = pgTable(
  'followup_rollover_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sfOwnerId: text('sf_owner_id').notNull(),
    sessionId: uuid('session_id').references(() => dialerSessions.id, { onDelete: 'set null' }),
    recordId: text('record_id').notNull(),
    objectType: text('object_type').notNull(),
    /** Org-local YYYY-MM-DD of the second miss. */
    fromDate: text('from_date').notNull(),
    status: syncStatusEnum('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedTaskId: text('completed_task_id'),
    /** Stamped the instant the copy is created — a retry must NOT create again. */
    createdTaskId: text('created_task_id'),
    /** The business day the copy landed on (for the run summary). */
    targetDate: text('target_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    jobUnique: uniqueIndex('followup_rollover_unique').on(t.userId, t.recordId, t.fromDate),
    statusIdx: index('followup_rollover_status_idx').on(t.status, t.nextAttemptAt),
    sessionIdx: index('followup_rollover_session_idx').on(t.sessionId),
  }),
);
export type FollowupRolloverJob = typeof followupRolloverJobs.$inferSelect;
```

(`dialerSessions` is declared above this point in the file; if the new table must precede it for ordering, place it after `dialerQueueItems` instead.)

- [ ] **Step 5: Make `buildQueueRows` populate the pair** — in `services/cti-api/src/dialer/create-session.ts`, replace the `buildQueueRows` body:

```ts
export function buildQueueRows(
  sessionId: string,
  objectType: string,
  resolved: Array<{ recordId: string; toNumber: string | null; fallbackNumber?: string | null }>,
): Array<{
  sessionId: string; ordinal: number; objectType: string; recordId: string;
  toNumber: string | null; fallbackNumber: string | null;
  attempt: number; primaryNumber: string | null; secondaryNumber: string | null;
  status: 'pending' | 'unreachable';
}> {
  return resolved.map((r, i) => ({
    sessionId, ordinal: i, objectType, recordId: r.recordId, toNumber: r.toNumber,
    fallbackNumber: r.fallbackNumber ?? null,
    // Immutable copy of the resolved pair: the fallback later overwrites
    // toNumber/fallbackNumber, and an attempt-2 row restores from these.
    attempt: 1, primaryNumber: r.toNumber, secondaryNumber: r.fallbackNumber ?? null,
    status: r.toNumber ? 'pending' : 'unreachable',
  }));
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd services/cti-api && npx vitest run src/dialer/create-session.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add services/cti-api/migrations/0024_followup_rollover.sql services/cti-api/src/db/schema.ts services/cti-api/src/dialer/create-session.ts services/cti-api/src/dialer/create-session.test.ts
git commit -m "feat(cti-api): schema for follow-up rollover v2 (attempt, immutable number pair, rollover jobs, daily cap)"
```

---

### Task 2: Retry eligibility (pure)

**Files:**
- Modify: `services/cti-api/src/dialer/state.ts`
- Create: `services/cti-api/src/dialer/state.test.ts`

**Interfaces:**
- Produces: `RETRY_FLOOR_MS = 300_000`; `nextEligiblePendingItem(items: DialerItem[], now: Date): DialerItem | null` (lowest-ordinal pending whose `retryNotBefore` is null or `<= now`); `earliestRetryAt(items: DialerItem[], now: Date): Date | null` (soonest `retryNotBefore` among pending rows still in the future). `nextPendingItem` stays exported (unchanged) for existing callers.

- [ ] **Step 1: Write the failing test** — create `services/cti-api/src/dialer/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { earliestRetryAt, nextEligiblePendingItem, RETRY_FLOOR_MS } from './state.js';
import type { DialerItem } from './session-store.js';

const now = new Date('2026-08-22T17:00:00Z');
const row = (o: Partial<DialerItem>): DialerItem =>
  ({ id: 'x', ordinal: 0, status: 'pending', retryNotBefore: null, attempt: 1, ...o }) as DialerItem;

describe('nextEligiblePendingItem', () => {
  it('is the lowest-ordinal pending row when nothing is floor-gated', () => {
    const r = nextEligiblePendingItem([row({ id: 'b', ordinal: 2 }), row({ id: 'a', ordinal: 1 })], now);
    expect(r?.id).toBe('a');
  });
  it('skips an attempt-2 row still inside its 5-minute floor, even if it has the lowest ordinal', () => {
    const gated = row({ id: 'retry', ordinal: 0, attempt: 2, retryNotBefore: new Date(now.getTime() + 60_000) });
    const r = nextEligiblePendingItem([gated, row({ id: 'fresh', ordinal: 5 })], now);
    expect(r?.id).toBe('fresh');
  });
  it('dials the retry once its floor has passed', () => {
    const due = row({ id: 'retry', ordinal: 9, attempt: 2, retryNotBefore: new Date(now.getTime() - 1) });
    expect(nextEligiblePendingItem([due], now)?.id).toBe('retry');
  });
  it('returns null when only floor-gated retries remain', () => {
    const gated = row({ id: 'retry', attempt: 2, retryNotBefore: new Date(now.getTime() + RETRY_FLOOR_MS) });
    expect(nextEligiblePendingItem([gated], now)).toBeNull();
  });
});

describe('earliestRetryAt', () => {
  it('is the soonest future floor among pending rows, else null', () => {
    const a = row({ id: 'a', attempt: 2, retryNotBefore: new Date(now.getTime() + 120_000) });
    const b = row({ id: 'b', attempt: 2, retryNotBefore: new Date(now.getTime() + 30_000) });
    expect(earliestRetryAt([a, b], now)?.toISOString()).toBe(new Date(now.getTime() + 30_000).toISOString());
    expect(earliestRetryAt([row({ id: 'c' })], now)).toBeNull();
  });
  it('ignores rows that are no longer pending', () => {
    const done = row({ id: 'd', status: 'no_connect', attempt: 2, retryNotBefore: new Date(now.getTime() + 30_000) });
    expect(earliestRetryAt([done], now)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/state.test.ts`
Expected: FAIL — `nextEligiblePendingItem is not a function`.

- [ ] **Step 3: Implement** — append to `services/cti-api/src/dialer/state.ts`:

```ts
/** Attempt-2 rows are not dialable until this long after attempt 1 ended. Keeps a
 *  2-record list from ringing the same person twice in 30 seconds. */
export const RETRY_FLOOR_MS = 5 * 60_000;

function floorPassed(i: DialerItem, now: Date): boolean {
  return i.retryNotBefore == null || i.retryNotBefore.getTime() <= now.getTime();
}

/** Lowest-ordinal pending row that is past its retry floor (or has none). */
export function nextEligiblePendingItem(items: DialerItem[], now: Date): DialerItem | null {
  const eligible = items.filter((i) => i.status === 'pending' && floorPassed(i, now));
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) => (a.ordinal <= b.ordinal ? a : b));
}

/** Soonest future retry floor among pending rows — when the run can advance again. */
export function earliestRetryAt(items: DialerItem[], now: Date): Date | null {
  let best: Date | null = null;
  for (const i of items) {
    if (i.status !== 'pending' || i.retryNotBefore == null) continue;
    if (i.retryNotBefore.getTime() <= now.getTime()) continue;
    if (!best || i.retryNotBefore.getTime() < best.getTime()) best = i.retryNotBefore;
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/cti-api && npx vitest run src/dialer/state.test.ts && npm run typecheck`
Expected: PASS (6 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/dialer/state.ts services/cti-api/src/dialer/state.test.ts
git commit -m "feat(cti-api): retry eligibility with a 5-minute floor (pure)"
```

---

### Task 3: Engine — attempt-2 requeue, rollover enqueue, waiting_retry

**Files:**
- Modify: `services/cti-api/src/dialer/engine.ts`
- Modify: `services/cti-api/src/routes/dialer.ts` (`buildEngineDeps`)
- Test: `services/cti-api/src/dialer/engine.test.ts`

**Interfaces:**
- Consumes: `nextEligiblePendingItem`, `earliestRetryAt`, `RETRY_FLOOR_MS` (Task 2); `schema.followupRolloverJobs` (Task 1).
- Produces: `EngineDeps.enqueueRollover: (job: RolloverEnqueue) => Promise<void>` **replaces** `EngineDeps.rolloverFollowUp`. `export interface RolloverEnqueue { orgId: string; userId: string; sfOwnerId: string; sessionId: string; recordId: string; objectType: string; fromDate: string }`. `advanceSession` return union gains `'waiting_retry'` with `nextRetryAt?: string` (ISO).

- [ ] **Step 1: Write the failing tests** — in `services/cti-api/src/dialer/engine.test.ts`:

First, extend the fake: in `fakeDb`, make the outer `insert(...).values(...)` awaitable and give the transaction `tx` an `insert` too. Replace the existing `insert(_tbl: unknown)` method with:

```ts
    insert(_tbl: unknown) {
      return {
        values: (values: any) => {
          inserts.push({ values });
          const p = Promise.resolve() as Promise<void> & { onConflictDoUpdate: () => Promise<void>; onConflictDoNothing: () => Promise<void> };
          p.onConflictDoUpdate = async () => {};
          p.onConflictDoNothing = async () => {};
          return p;
        },
      };
    },
```

and inside `transaction(fn)`, add to the `tx` object:

```ts
        insert(_tbl: unknown) {
          return { values: async (values: any) => { inserts.push({ values }); } };
        },
```

Then replace every `rolloverFollowUp: vi.fn(...)` in `makeDeps` with `enqueueRollover: vi.fn(async () => {})`, and update the existing `handleDialOutcome` test `'no_connect runs the rollover then advances'` to assert enqueue instead of rollover — it becomes:

```ts
  it('a SECOND miss enqueues exactly one rollover job, then advances', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).toHaveBeenCalledTimes(1);
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'O1', userId: 'U1', sfOwnerId: '005', sessionId: 'S1', recordId: '00Q1', objectType: 'Lead', fromDate: '2026-07-13',
    }));
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
  });
```

Add these new tests in the `handleDialOutcome` describe:

```ts
  it('a FIRST miss re-queues the record as an attempt-2 row at the end, with the original numbers and a 5-min floor — and does NOT roll over', async () => {
    const items = [
      { id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550199', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+16195550100', secondaryNumber: '+16195550199' },
      { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+2', secondaryNumber: null },
    ];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._inserts).toContainEqual({ values: expect.objectContaining({
      sessionId: 'S1', recordId: '00Q1', objectType: 'Lead', attempt: 2, ordinal: 2,
      toNumber: '+16195550100', fallbackNumber: '+16195550199',
      primaryNumber: '+16195550100', secondaryNumber: '+16195550199', status: 'pending',
    }) });
    const ins = fdb._inserts.find((x: any) => x.values.attempt === 2)!.values;
    expect(ins.retryNotBefore.getTime() - deps.nowUtc.getTime()).toBe(5 * 60_000);
  });
  it('a duplicated webhook for the first miss does not insert a second attempt-2 row', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(fdb._inserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
  });
  it('a connect never requeues or enqueues', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null, fromNumber: '+16190000000' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._inserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
  });
```

And in the `advanceSession` describe:

```ts
  it('returns waiting_retry (session stays active) when only floor-gated retries remain', async () => {
    const soon = new Date(Date.UTC(2026, 6, 13, 18, 3, 0));
    const items = [{ id: 'r1', ordinal: 3, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 2, retryNotBefore: soon }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(r).toEqual({ action: 'waiting_retry', nextRetryAt: soon.toISOString() });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/cti-api && npx vitest run src/dialer/engine.test.ts`
Expected: FAIL — `enqueueRollover` not called / no attempt-2 insert / `waiting_retry` not returned (and a type error on `rolloverFollowUp` until Step 3).

- [ ] **Step 3: Implement in `engine.ts`**

Imports: replace `import type { rolloverFollowUp } from '../salesforce/followup.js';` with nothing, and change the state import to `import { earliestRetryAt, inFlightItem, nextEligiblePendingItem, RETRY_FLOOR_MS } from './state.js';`.

`EngineDeps`: replace `rolloverFollowUp: typeof rolloverFollowUp;` with:

```ts
  /** Queue the rep's follow-up rollover for this record (drained by the follow-up
   *  worker). Idempotent on (user, record, fromDate). Must never throw into the webhook. */
  enqueueRollover: (job: RolloverEnqueue) => Promise<void>;
```

and add above the interface:

```ts
export interface RolloverEnqueue {
  orgId: string; userId: string; sfOwnerId: string; sessionId: string;
  recordId: string; objectType: string; fromDate: string;
}
```

`advanceSession`: change the return type to
`Promise<{ action: 'dialing' | 'waiting' | 'waiting_retry' | 'done' | 'idle' | 'paused_no_numbers'; itemId?: string; nextRetryAt?: string }>`
and replace the loop head `const next = nextPendingItem(items);` + its `if (!next)` with:

```ts
    const next = nextEligiblePendingItem(items, deps.nowUtc);
    if (!next) {
      // Pending rows may remain but all be inside their retry floor — leave the
      // session active and tell the caller when it can advance (the follow-up
      // worker tick nudges it then).
      const retryAt = earliestRetryAt(items, deps.nowUtc);
      if (retryAt) return { action: 'waiting_retry', nextRetryAt: retryAt.toISOString() };
      await releaseRepConference(deps, session.userId, sessionId);
      await setSession(deps, sessionId, 'done');
      return { action: 'done' };
    }
```

(Keep every other line of `advanceSession` as-is; `nextPendingItem` is no longer imported here.)

`handleDialOutcome` tail: replace the block from `// No fallback left (or a non-no-answer miss)…` through the end of the function with:

```ts
  // No fallback left (or a non-no-answer miss) = one MISS. First miss: re-queue
  // the record as an attempt-2 row at the END of the run (numbers restored from
  // the immutable pair, 5-min floor). Second miss: queue the follow-up rollover.
  // Both ride inside the same compare-and-swap that flips this row out of
  // 'dialing', so a duplicated webhook can neither double-requeue nor double-enqueue.
  const claimed = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.dialerQueueItems)
      .set({ status: 'no_connect', outcome, updatedAt: new Date() })
      .where(and(
        eq(schema.dialerQueueItems.id, item.id),
        eq(schema.dialerQueueItems.callId, callId),
        eq(schema.dialerQueueItems.status, 'dialing'),
      ))
      .returning({ id: schema.dialerQueueItems.id });
    if (rows.length === 0) return false;
    if (item.attempt < 2) {
      const all = await deps.db.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, item.sessionId) });
      const maxOrdinal = all.reduce((m, i) => Math.max(m, i.ordinal), -1);
      await tx.insert(schema.dialerQueueItems).values({
        sessionId: item.sessionId, ordinal: maxOrdinal + 1, objectType: item.objectType, recordId: item.recordId,
        toNumber: item.primaryNumber, fallbackNumber: item.secondaryNumber,
        primaryNumber: item.primaryNumber, secondaryNumber: item.secondaryNumber,
        attempt: 2, status: 'pending',
        retryNotBefore: new Date(deps.nowUtc.getTime() + RETRY_FLOOR_MS),
      });
    }
    return true;
  });
  if (!claimed) return; // duplicate/redelivered webhook lost the race
  if (item.attempt >= 2) {
    try {
      await deps.enqueueRollover({
        orgId: session.orgId, userId: session.userId, sfOwnerId: session.sfOwnerId, sessionId: session.id,
        recordId: item.recordId, objectType: item.objectType, fromDate: deps.todayIso,
      });
    } catch (err) {
      console.error('[dialer] rollover enqueue failed', { itemId: item.id, err: (err as Error).message });
    }
  }
  await advanceSession(item.sessionId, deps);
}
```

Note: the existing early `await setItem(deps, item.id, { status: 'no_connect', outcome })` line is removed — the CAS above now performs that write.

`routes/dialer.ts` `buildEngineDeps`: replace `rolloverFollowUp,` with
`enqueueRollover: (job) => enqueueFollowupRollover(db, job),` and add
`import { enqueueFollowupRollover } from '../salesforce/followup-worker.js';` (that function is created in Task 5; to keep this task green, create a stub file now — `services/cti-api/src/salesforce/followup-worker.ts`:)

```ts
import type { RolloverEnqueue } from '../dialer/engine.js';
import { getDb, schema } from '../db/index.js';

/** Idempotent: a duplicated webhook's second enqueue is a no-op. */
export async function enqueueFollowupRollover(db: ReturnType<typeof getDb>, job: RolloverEnqueue): Promise<void> {
  await db.insert(schema.followupRolloverJobs).values({ ...job, status: 'pending' }).onConflictDoNothing();
}
```

Also update any other `EngineDeps` constructions in the repo (`grep -rn "rolloverFollowUp:" services/cti-api/src`) — e.g. `routes/dialer-webhook.test.ts` — to provide `enqueueRollover: vi.fn(async () => {})` instead.

- [ ] **Step 4: Run the engine tests, the whole suite, and typecheck**

Run: `cd services/cti-api && npx vitest run src/dialer/engine.test.ts && npm test && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts services/cti-api/src/routes/dialer.ts services/cti-api/src/salesforce/followup-worker.ts services/cti-api/src/routes/dialer-webhook.test.ts
git commit -m "feat(cti-api): two attempts per record — requeue on first miss, enqueue rollover on second, waiting_retry"
```

---

### Task 4: `soqlCount` + the cap-aware day picker (pure)

**Files:**
- Modify: `services/cti-api/src/salesforce/client.ts` (add `soqlCount`)
- Create: `services/cti-api/src/salesforce/followup-day.ts`
- Test: `services/cti-api/src/salesforce/followup-day.test.ts`, append to `services/cti-api/src/salesforce/soql.test.ts`

**Interfaces:**
- Produces: `soqlCount(userId: string, soql: string): Promise<number>`; `FOLLOWUP_DAILY_CAP_DEFAULT = 100`; `MAX_ROLLOVER_BUSINESS_DAYS = 30`; `pickRolloverDay(opts: { fromDate: string; cap: number; workingWeekdays: ReadonlySet<number>; holidays: ReadonlySet<string>; countOn: (isoDate: string) => Promise<number>; maxBusinessDays?: number }): Promise<string | null>`; `followUpCountSoql(sfOwnerId: string, isoDate: string): string`.

- [ ] **Step 1: Write the failing tests** — create `services/cti-api/src/salesforce/followup-day.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { followUpCountSoql, pickRolloverDay } from './followup-day.js';

const weekdays = new Set([1, 2, 3, 4, 5]);
const none = new Set<string>();
// 2026-08-21 is a Friday.
describe('pickRolloverDay', () => {
  it('takes the next business day when it has room', async () => {
    const countOn = vi.fn(async () => 30);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-21');
    expect(countOn).toHaveBeenCalledWith('2026-08-21');
  });
  it('skips a full day and lands on the following business day (weekend skipped)', async () => {
    const counts: Record<string, number> = { '2026-08-21': 100, '2026-08-24': 70 };
    const countOn = vi.fn(async (d: string) => counts[d] ?? 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
  });
  it('treats exactly-at-cap as full', async () => {
    const countOn = vi.fn(async (d: string) => (d === '2026-08-21' ? 100 : 0));
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
  });
  it('skips holidays', async () => {
    const countOn = vi.fn(async () => 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: new Set(['2026-08-21']), countOn })).resolves.toBe('2026-08-24');
  });
  it('returns null when every day within the bound is full', async () => {
    const countOn = vi.fn(async () => 999);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', cap: 100, workingWeekdays: weekdays, holidays: none, countOn, maxBusinessDays: 3 })).resolves.toBeNull();
    expect(countOn).toHaveBeenCalledTimes(3);
  });
});

describe('followUpCountSoql', () => {
  it('counts the owner\'s OPEN follow-ups due that day, all spellings, hand-made included', () => {
    const q = followUpCountSoql('005ABC', '2026-08-21');
    expect(q).toMatch(/^SELECT COUNT\(\) FROM Task WHERE /);
    expect(q).toContain("OwnerId = '005ABC'");
    expect(q).toContain('IsClosed = false');
    expect(q).toContain('ActivityDate = 2026-08-21');
    expect(q).toContain("Subject LIKE '%Follow-up%'");
    expect(q).toContain("Subject LIKE '%Followup%'");
    expect(q).toContain("Subject LIKE '%Follow up%'");
  });
  it('escapes the owner id', () => {
    expect(followUpCountSoql("005'x", '2026-08-21')).toContain("OwnerId = '005\\'x'");
  });
});
```

Append to `services/cti-api/src/salesforce/soql.test.ts` (it already mocks/tests the client; if it does not import `sfFetch` mocking, add the `vi.mock('./client.js')` pattern from `followup.test.ts` in a new file `client-count.test.ts` instead):

```ts
describe('soqlCount', () => {
  it('reads totalSize — COUNT() queries return no records', async () => {
    mockFetch.mockResolvedValueOnce({ status: 200, json: { totalSize: 42, done: true, records: [] } });
    await expect(soqlCount('u1', 'SELECT COUNT() FROM Task')).resolves.toBe(42);
  });
  it('throws on a 4xx', async () => {
    mockFetch.mockResolvedValueOnce({ status: 400, json: [{ message: 'bad' }] });
    await expect(soqlCount('u1', 'SELECT COUNT() FROM Task')).rejects.toThrow(/SOQL count failed \(400\)/);
  });
});
```

(Where `mockFetch` is `sfFetch as unknown as ReturnType<typeof vi.fn>` under `vi.mock('./client.js', async (orig) => ({ ...(await orig()), sfFetch: vi.fn() }))` so the real `soqlCount` runs against a mocked `sfFetch`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/cti-api && npx vitest run src/salesforce/followup-day.test.ts src/salesforce/soql.test.ts`
Expected: FAIL — module `./followup-day.js` not found; `soqlCount` not exported.

- [ ] **Step 3: Implement `soqlCount`** — append to `services/cti-api/src/salesforce/client.ts` right after `soqlQuery`:

```ts
/** `SELECT COUNT() …` — Salesforce returns the number in `totalSize` with an
 *  empty `records` array, which `soqlQuery` would discard. */
export async function soqlCount(userId: string, soql: string): Promise<number> {
  const res = await sfFetch(userId, '/query', { query: { q: soql } });
  if (res.status >= 400) throw new Error(`SOQL count failed (${res.status}): ${JSON.stringify(res.json)}`);
  return Number((res.json as { totalSize?: number }).totalSize ?? 0);
}
```

- [ ] **Step 4: Implement the day picker** — create `services/cti-api/src/salesforce/followup-day.ts`:

```ts
/**
 * Which business day a rolled-over Follow-up lands on: the first one after
 * `fromDate` where the rep has fewer than `cap` open Follow-ups due. Pure apart
 * from the injected `countOn` (a live Salesforce COUNT — the source of truth,
 * so hand-created tasks count too).
 */
import { nextBusinessDay } from '../dialer/next-business-day.js';
import { soqlEscape } from './client.js';

export const FOLLOWUP_DAILY_CAP_DEFAULT = 100;
export const MAX_ROLLOVER_BUSINESS_DAYS = 30;

export function followUpCountSoql(sfOwnerId: string, isoDate: string): string {
  return (
    'SELECT COUNT() FROM Task WHERE ' +
    `OwnerId = '${soqlEscape(sfOwnerId)}' AND IsClosed = false AND ActivityDate = ${isoDate} ` +
    "AND (Subject LIKE '%Follow-up%' OR Subject LIKE '%Followup%' OR Subject LIKE '%Follow up%')"
  );
}

export async function pickRolloverDay(opts: {
  fromDate: string;
  cap: number;
  workingWeekdays: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  countOn: (isoDate: string) => Promise<number>;
  maxBusinessDays?: number;
}): Promise<string | null> {
  const max = opts.maxBusinessDays ?? MAX_ROLLOVER_BUSINESS_DAYS;
  let candidate = nextBusinessDay(opts.fromDate, opts.workingWeekdays, opts.holidays);
  for (let i = 0; i < max; i++) {
    const n = await opts.countOn(candidate);
    if (n < opts.cap) return candidate;
    candidate = nextBusinessDay(candidate, opts.workingWeekdays, opts.holidays);
  }
  return null;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd services/cti-api && npx vitest run src/salesforce/followup-day.test.ts src/salesforce/soql.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add services/cti-api/src/salesforce/client.ts services/cti-api/src/salesforce/followup-day.ts services/cti-api/src/salesforce/followup-day.test.ts services/cti-api/src/salesforce/soql.test.ts
git commit -m "feat(cti-api): soqlCount + cap-aware rollover day picker (pure)"
```

---

### Task 5: The rollover worker (single-flight, idempotent) + server wiring

**Files:**
- Modify: `services/cti-api/src/salesforce/followup-worker.ts` (replace the Task 3 stub)
- Modify: `services/cti-api/src/server.ts`
- Test: `services/cti-api/src/salesforce/followup-worker.test.ts`

**Interfaces:**
- Consumes: `pickFollowUpTask`, `followUpCopyFields`, `FollowUpTask` (`./followup.js`); `pickRolloverDay`, `followUpCountSoql`, `FOLLOWUP_DAILY_CAP_DEFAULT` (Task 4); `fetchBusinessCalendar` (`./business-calendar.js`); `sfFetch`, `soqlQuery`, `soqlCount`, `soqlEscape`, `SalesforceUnauthorizedError` (`./client.js`); `advanceSession`, `RolloverEnqueue` (engine).
- Produces: `enqueueFollowupRollover(db, job)` (kept); `processRolloverJob(job, deps): Promise<void>` with `export interface WorkerDeps { db; sf: { soqlQuery; soqlCount; sfFetch }; calendarFor(userId): Promise<{workingWeekdays; holidays}>; capFor(orgId): Promise<number>; now(): Date }`; `runFollowupTick(): Promise<{ processed: number; nudged: number }>`; `startFollowupLoop(intervalMs = 5000): NodeJS.Timeout`; `nudgeDueRetries(deps)`.

- [ ] **Step 1: Write the failing tests** — create `services/cti-api/src/salesforce/followup-worker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processRolloverJob, type WorkerDeps } from './followup-worker.js';
import { SalesforceUnauthorizedError } from './client.js';
import type { FollowupRolloverJob } from '../db/schema.js';

const openTask = { Id: '00T1', Subject: 'Follow-up', Type: 'Call', Priority: 'Normal', OwnerId: '005', WhoId: '00Q1', WhatId: null, ActivityDate: '2026-08-20' };

function fakeDb() {
  const writes: Array<{ patch: Record<string, unknown> }> = [];
  return {
    _writes: writes,
    update(_t: unknown) { return { set: (patch: any) => ({ where: async () => { writes.push({ patch }); } }) }; },
  } as any;
}
function job(o: Partial<FollowupRolloverJob> = {}): FollowupRolloverJob {
  return {
    id: 'J1', orgId: 'O1', userId: 'U1', sfOwnerId: '005', sessionId: 'S1', recordId: '00Q1', objectType: 'Lead',
    fromDate: '2026-08-20', status: 'in_flight', attempts: 1, lastError: null, nextAttemptAt: new Date(),
    completedAt: null, completedTaskId: null, createdTaskId: null, targetDate: null, createdAt: new Date(), updatedAt: new Date(),
    ...o,
  } as FollowupRolloverJob;
}
function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db: fakeDb(),
    sf: {
      soqlQuery: vi.fn(async () => [openTask]),
      soqlCount: vi.fn(async () => 10),
      sfFetch: vi.fn(async (_u: string, path: string, init?: any) =>
        init?.method === 'POST' ? { status: 201, json: { id: '00TNEW' } } : { status: 204, json: null }),
    },
    calendarFor: vi.fn(async () => ({ workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set<string>() })),
    capFor: vi.fn(async () => 100),
    now: () => new Date('2026-08-22T17:00:00Z'),
    ...over,
  };
}

describe('processRolloverJob', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates the copy on the next business day with room, THEN completes the original, and succeeds', async () => {
    const d = deps(); const fetch = d.sf.sfFetch as any;
    await processRolloverJob(job(), d);
    const calls = fetch.mock.calls.map((c: any[]) => [c[1], c[2]?.method]);
    expect(calls[0]).toEqual(['/sobjects/Task', 'POST']);          // create first
    expect(calls[1]).toEqual(['/sobjects/Task/00T1', 'PATCH']);    // then complete
    expect(fetch.mock.calls[0][2].body).toMatchObject({ ActivityDate: '2026-08-21', OwnerId: '005', Status: 'Not Started' });
    expect(d.db._writes).toContainEqual({ patch: expect.objectContaining({ createdTaskId: '00TNEW', targetDate: '2026-08-21' }) });
    expect(d.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', completedTaskId: '00T1' }) });
  });

  it('pushes to a later day when the next business day is at the cap', async () => {
    const d = deps({ sf: { ...deps().sf, soqlCount: vi.fn(async (_u: string, q: string) => (q.includes('2026-08-21') ? 100 : 3)) } });
    await processRolloverJob(job(), d);
    expect((d.sf.sfFetch as any).mock.calls[0][2].body.ActivityDate).toBe('2026-08-24');
  });

  it('is idempotent on retry: a job that already created its copy only completes (no second create)', async () => {
    const d = deps(); const fetch = d.sf.sfFetch as any;
    await processRolloverJob(job({ createdTaskId: '00TNEW', targetDate: '2026-08-21', attempts: 2 }), d);
    expect(fetch.mock.calls.map((c: any[]) => c[2]?.method)).toEqual(['PATCH']);
    expect(d.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded' }) });
  });

  it('succeeds as no-task (creates nothing) when the rep has no open follow-up on the record', async () => {
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async () => []) } });
    await processRolloverJob(job(), d);
    expect(d.sf.sfFetch).not.toHaveBeenCalled();
    expect(d.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', lastError: 'no-task' }) });
  });

  it('fails immediately (no retry) on a Salesforce auth error', async () => {
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async () => { throw new SalesforceUnauthorizedError('expired'); }) } });
    await processRolloverJob(job(), d);
    expect(d.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'failed', lastError: 'reconnect Salesforce' }) });
  });

  it('backs off and retries on a transient error, failing for good after 8 attempts', async () => {
    const boom = vi.fn(async () => { throw new Error('503'); });
    const d = deps({ sf: { ...deps().sf, soqlQuery: boom } });
    await processRolloverJob(job({ attempts: 1 }), d);
    expect(d.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'pending', lastError: '503' }) });
    const d2 = deps({ sf: { ...deps().sf, soqlQuery: boom } });
    await processRolloverJob(job({ attempts: 8 }), d2);
    expect(d2.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'failed' }) });
  });

  it('fails loudly when no business day within the bound has room', async () => {
    const d = deps({ sf: { ...deps().sf, soqlCount: vi.fn(async () => 999) } });
    await processRolloverJob(job(), d);
    expect(d.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'failed', lastError: expect.stringMatching(/no business day with room/) }) });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/cti-api && npx vitest run src/salesforce/followup-worker.test.ts`
Expected: FAIL — `processRolloverJob` is not exported.

- [ ] **Step 3: Implement the worker** — replace `services/cti-api/src/salesforce/followup-worker.ts` with:

```ts
/**
 * Follow-up rollover worker — drains followup_rollover_jobs single-flight.
 *
 * Per job: find the rep's open Follow-up on the record → pick the first business
 * day under the org's daily cap (live COUNT in Salesforce) → CREATE the copy →
 * stamp created_task_id → COMPLETE the original. Create-before-complete means a
 * create failure leaves the original open (retryable) instead of lost; stamping
 * created_task_id before the PATCH means a crash in between is retried by
 * completing only — never a duplicate task.
 *
 * Single-flight is what makes the cap correct: two rollovers can't both read 99.
 * Mirrors salesforce/sync.ts (attempts, backoff, stuck-job reaper).
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb, schema, type FollowupRolloverJob } from '../db/index.js';
import { advanceSession, type RolloverEnqueue } from '../dialer/engine.js';
import { buildEngineDeps } from '../routes/dialer.js';
import { fetchBusinessCalendar } from './business-calendar.js';
import { SalesforceUnauthorizedError, sfFetch, soqlCount, soqlEscape, soqlQuery } from './client.js';
import { FOLLOWUP_DAILY_CAP_DEFAULT, followUpCountSoql, pickRolloverDay } from './followup-day.js';
import { followUpCopyFields, pickFollowUpTask, type FollowUpTask } from './followup.js';

export const MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 30_000;
export const STUCK_AFTER_MS = 2 * 60_000;

export interface WorkerDeps {
  db: ReturnType<typeof getDb>;
  sf: { soqlQuery: typeof soqlQuery; soqlCount: typeof soqlCount; sfFetch: typeof sfFetch };
  calendarFor: (userId: string) => Promise<{ workingWeekdays: ReadonlySet<number>; holidays: ReadonlySet<string> }>;
  capFor: (orgId: string) => Promise<number>;
  now: () => Date;
}

/** Idempotent: a duplicated webhook's second enqueue is a no-op. */
export async function enqueueFollowupRollover(db: ReturnType<typeof getDb>, job: RolloverEnqueue): Promise<void> {
  await db.insert(schema.followupRolloverJobs).values({ ...job, status: 'pending' }).onConflictDoNothing();
}

async function patchJob(deps: WorkerDeps, id: string, patch: Partial<FollowupRolloverJob>): Promise<void> {
  await deps.db.update(schema.followupRolloverJobs).set({ ...patch, updatedAt: deps.now() }).where(eq(schema.followupRolloverJobs.id, id));
}

async function findOpenFollowUp(deps: WorkerDeps, job: FollowupRolloverJob): Promise<FollowUpTask | null> {
  const rid = soqlEscape(job.recordId);
  const owner = soqlEscape(job.sfOwnerId);
  const tasks = await deps.sf.soqlQuery<FollowUpTask>(
    job.userId,
    'SELECT Id, Subject, Type, Priority, OwnerId, WhoId, WhatId, ActivityDate FROM Task ' +
      `WHERE IsClosed = false AND OwnerId = '${owner}' AND (WhoId = '${rid}' OR WhatId = '${rid}') ` +
      "AND (Subject LIKE '%Follow-up%' OR Subject LIKE '%Followup%' OR Subject LIKE '%Follow up%') " +
      'ORDER BY ActivityDate ASC NULLS LAST LIMIT 50',
  );
  return pickFollowUpTask(tasks);
}

export async function processRolloverJob(job: FollowupRolloverJob, deps: WorkerDeps): Promise<void> {
  try {
    const task = await findOpenFollowUp(deps, job);
    if (!task) {
      await patchJob(deps, job.id, { status: 'succeeded', lastError: 'no-task', completedAt: deps.now() });
      return;
    }

    let createdId = job.createdTaskId;
    let targetDate = job.targetDate;
    if (!createdId) {
      const cal = await deps.calendarFor(job.userId);
      const cap = await deps.capFor(job.orgId);
      targetDate = await pickRolloverDay({
        fromDate: job.fromDate, cap, workingWeekdays: cal.workingWeekdays, holidays: cal.holidays,
        countOn: (d) => deps.sf.soqlCount(job.userId, followUpCountSoql(job.sfOwnerId, d)),
      });
      if (!targetDate) {
        await patchJob(deps, job.id, { status: 'failed', lastError: 'no business day with room within 30 days', completedAt: deps.now() });
        return;
      }
      const created = await deps.sf.sfFetch(job.userId, '/sobjects/Task', { method: 'POST', body: followUpCopyFields(task, targetDate) });
      if (created.status >= 400) throw new Error(`create failed: ${JSON.stringify(created.json)}`);
      createdId = (created.json as { id: string }).id;
      // Stamp BEFORE completing: a crash from here on is retried by completing only.
      await patchJob(deps, job.id, { createdTaskId: createdId, targetDate });
    }

    const done = await deps.sf.sfFetch(job.userId, `/sobjects/Task/${task.Id}`, { method: 'PATCH', body: { Status: 'Completed' } });
    if (done.status >= 400) throw new Error(`complete failed: ${JSON.stringify(done.json)}`);
    await patchJob(deps, job.id, { status: 'succeeded', completedTaskId: task.Id, completedAt: deps.now(), lastError: null });
  } catch (err) {
    if (err instanceof SalesforceUnauthorizedError) {
      await patchJob(deps, job.id, { status: 'failed', lastError: 'reconnect Salesforce', completedAt: deps.now() });
      return;
    }
    const msg = (err as Error).message;
    if (job.attempts >= MAX_ATTEMPTS) {
      await patchJob(deps, job.id, { status: 'failed', lastError: msg, completedAt: deps.now() });
      return;
    }
    const delay = BACKOFF_BASE_MS * 2 ** (job.attempts - 1);
    await patchJob(deps, job.id, { status: 'pending', lastError: msg, nextAttemptAt: new Date(deps.now().getTime() + delay) });
  }
}

/** Kick any active session whose earliest retry floor has passed (Task 2/3 leave
 *  such sessions 'active' with nothing eligible until now). */
export async function nudgeDueRetries(deps: WorkerDeps): Promise<number> {
  const due = await deps.db
    .selectDistinct({ sessionId: schema.dialerQueueItems.sessionId })
    .from(schema.dialerQueueItems)
    .innerJoin(schema.dialerSessions, eq(schema.dialerSessions.id, schema.dialerQueueItems.sessionId))
    .where(and(
      eq(schema.dialerSessions.status, 'active'),
      eq(schema.dialerQueueItems.status, 'pending'),
      lte(schema.dialerQueueItems.retryNotBefore, deps.now()),
    ));
  for (const { sessionId } of due) {
    try { await advanceSession(sessionId, buildEngineDeps()); } catch (err) {
      console.error('[followup-worker] nudge failed', { sessionId, err: (err as Error).message });
    }
  }
  return due.length;
}

function liveDeps(): WorkerDeps {
  const db = getDb();
  return {
    db,
    sf: { soqlQuery, soqlCount, sfFetch },
    calendarFor: fetchBusinessCalendar,
    capFor: async (orgId) => {
      const cfg = await db.query.campaignConfigs.findFirst({
        where: and(eq(schema.campaignConfigs.orgId, orgId), eq(schema.campaignConfigs.key, 'default')),
      });
      return cfg?.followupDailyCap ?? FOLLOWUP_DAILY_CAP_DEFAULT;
    },
    now: () => new Date(),
  };
}

export async function runFollowupTick(): Promise<{ processed: number; nudged: number }> {
  const deps = liveDeps();
  const now = deps.now();
  // Reap orphans (a tick that died mid-job).
  await deps.db.update(schema.followupRolloverJobs)
    .set({ status: 'pending', updatedAt: now })
    .where(and(eq(schema.followupRolloverJobs.status, 'in_flight'), lte(schema.followupRolloverJobs.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS))));
  const nudged = await nudgeDueRetries(deps);
  const jobs = await deps.db.query.followupRolloverJobs.findMany({
    where: and(eq(schema.followupRolloverJobs.status, 'pending'), lte(schema.followupRolloverJobs.nextAttemptAt, now)),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
    limit: 25,
  });
  let processed = 0;
  for (const j of jobs) {
    await patchJob(deps, j.id, { status: 'in_flight', attempts: sql`${schema.followupRolloverJobs.attempts} + 1` as unknown as number });
    await processRolloverJob({ ...j, attempts: j.attempts + 1 }, deps);
    processed++;
  }
  return { processed, nudged };
}

/** Drive from server.ts. Single-flight — a slow tick is never overlapped. */
export function startFollowupLoop(intervalMs = 5000): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runFollowupTick()
      .catch((err) => console.error('[followup-worker] tick error', err))
      .finally(() => { running = false; });
  }, intervalMs);
}
```

If `db/index.ts` does not re-export `FollowupRolloverJob`, import it from `'../db/schema.js'` instead. If `buildEngineDeps` is not exported from `routes/dialer.ts`, export it (add `export` to the function) — it is the live deps factory the route already uses.

- [ ] **Step 4: Wire into `server.ts`** — add the import `import { startFollowupLoop } from './salesforce/followup-worker.js';` and, directly after `const syncTimer = startSyncLoop(5000);`, add `const followupTimer = startFollowupLoop(5000);`; in `close`, add `clearInterval(followupTimer);`.

- [ ] **Step 5: Run tests, suite, typecheck**

Run: `cd services/cti-api && npx vitest run src/salesforce/followup-worker.test.ts && npm test && npm run typecheck`
Expected: all PASS; typecheck clean. (If `npm test` reports a circular-import warning between `routes/dialer.ts` and `followup-worker.ts`, move `buildEngineDeps` into `dialer/live-deps.ts` and import it from both — keep the function body identical.)

- [ ] **Step 6: Commit**

```bash
git add services/cti-api/src/salesforce/followup-worker.ts services/cti-api/src/salesforce/followup-worker.test.ts services/cti-api/src/server.ts services/cti-api/src/routes/dialer.ts
git commit -m "feat(cti-api): single-flight follow-up rollover worker (cap-aware, idempotent create-before-complete)"
```

---

### Task 6: Session view + admin endpoint

**Files:**
- Modify: `services/cti-api/src/dialer/session-store.ts` (add `rolloverSummary`)
- Modify: `services/cti-api/src/routes/dialer.ts` (`GET /dialer/sessions/:id`)
- Modify: `services/cti-api/src/routes/admin.ts` (`GET /admin/followup-rollovers`)
- Test: `services/cti-api/src/dialer/session-store.test.ts` (create if absent)

**Interfaces:**
- Produces: `rolloverSummary(jobs: Array<Pick<FollowupRolloverJob,'status'|'fromDate'|'targetDate'>>, nextDayOf: (from: string) => string): { moved: number; pushed: number; failed: number; pending: number }`. `GET /dialer/sessions/:id` returns `{ session, counts, currentItem: (item & { attempt }) | null, waitingRetry: { nextRetryAt: string } | null, rollovers }`. `GET /admin/followup-rollovers?since=YYYY-MM-DD` (admin-only) returns `{ succeeded: number, failed: Array<{ recordId; userEmail; lastError; attempts; updatedAt }> }`.

- [ ] **Step 1: Write the failing test** — create/append `services/cti-api/src/dialer/session-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rolloverSummary } from './session-store.js';

describe('rolloverSummary', () => {
  const nextDay = (d: string) => (d === '2026-08-20' ? '2026-08-21' : 'x');
  it('splits succeeded jobs into moved (next business day) vs pushed (later, by the cap)', () => {
    const s = rolloverSummary([
      { status: 'succeeded', fromDate: '2026-08-20', targetDate: '2026-08-21' },
      { status: 'succeeded', fromDate: '2026-08-20', targetDate: '2026-08-24' },
      { status: 'failed', fromDate: '2026-08-20', targetDate: null },
      { status: 'pending', fromDate: '2026-08-20', targetDate: null },
    ], nextDay);
    expect(s).toEqual({ moved: 1, pushed: 1, failed: 1, pending: 1 });
  });
  it('a no-task success (no targetDate) counts as neither moved nor pushed', () => {
    expect(rolloverSummary([{ status: 'succeeded', fromDate: '2026-08-20', targetDate: null }], nextDay)).toEqual({ moved: 0, pushed: 0, failed: 0, pending: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/session-store.test.ts`
Expected: FAIL — `rolloverSummary` not exported.

- [ ] **Step 3: Implement** — append to `services/cti-api/src/dialer/session-store.ts`:

```ts
/** Run-summary counts from a session's rollover jobs. `nextDayOf` resolves the
 *  plain next business day so "moved" (landed there) vs "pushed" (cap sent it
 *  later) needs no extra Salesforce call. */
export function rolloverSummary(
  jobs: Array<{ status: string; fromDate: string; targetDate: string | null }>,
  nextDayOf: (fromIsoDate: string) => string,
): { moved: number; pushed: number; failed: number; pending: number } {
  const s = { moved: 0, pushed: 0, failed: 0, pending: 0 };
  for (const j of jobs) {
    if (j.status === 'failed') s.failed++;
    else if (j.status === 'pending' || j.status === 'in_flight') s.pending++;
    else if (j.status === 'succeeded' && j.targetDate) {
      if (j.targetDate === nextDayOf(j.fromDate)) s.moved++; else s.pushed++;
    }
  }
  return s;
}
```

- [ ] **Step 4: Extend `GET /dialer/sessions/:id`** in `routes/dialer.ts` — replace the handler body's return with:

```ts
    const items = await db.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, session.id) });
    const now = new Date();
    const current = inFlightItem(items);
    const nextRetry = !current && session.status === 'active' && !nextEligiblePendingItem(items, now) ? earliestRetryAt(items, now) : null;
    const jobs = await db.query.followupRolloverJobs.findMany({ where: eq(schema.followupRolloverJobs.sessionId, session.id) });
    const cal = await fetchBusinessCalendar(session.userId).catch(() => ({ workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set<string>() }));
    return {
      session,
      counts: sessionCounts(items),
      currentItem: current,
      waitingRetry: nextRetry ? { nextRetryAt: nextRetry.toISOString() } : null,
      rollovers: rolloverSummary(jobs, (d) => nextBusinessDay(d, cal.workingWeekdays, cal.holidays)),
    };
```

Add the imports: `earliestRetryAt, nextEligiblePendingItem` from `'../dialer/state.js'`; `rolloverSummary` from `'../dialer/session-store.js'`; `fetchBusinessCalendar` from `'../salesforce/business-calendar.js'`; `nextBusinessDay` from `'../dialer/next-business-day.js'`. (`currentItem` already serializes every column, so `attempt` rides along.)

- [ ] **Step 5: Admin endpoint** — in `routes/admin.ts`, next to `GET /admin/reps`, add:

```ts
  // Follow-up rollover health: a failed job is a task that silently did not move.
  app.get('/admin/followup-rollovers', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const q = req.query as { since?: string };
    const since = q.since && /^\d{4}-\d{2}-\d{2}$/.test(q.since) ? new Date(`${q.since}T00:00:00Z`) : new Date(Date.now() - 24 * 3600_000);
    const db = getDb();
    const rows = await db
      .select({
        status: schema.followupRolloverJobs.status, recordId: schema.followupRolloverJobs.recordId,
        lastError: schema.followupRolloverJobs.lastError, attempts: schema.followupRolloverJobs.attempts,
        updatedAt: schema.followupRolloverJobs.updatedAt, userEmail: schema.users.email,
      })
      .from(schema.followupRolloverJobs)
      .innerJoin(schema.users, eq(schema.users.id, schema.followupRolloverJobs.userId))
      .where(and(eq(schema.followupRolloverJobs.orgId, s.orgId), gte(schema.followupRolloverJobs.updatedAt, since)));
    return {
      succeeded: rows.filter((r) => r.status === 'succeeded').length,
      failed: rows.filter((r) => r.status === 'failed').map(({ status: _s, ...r }) => r),
    };
  });
```

(Use the same `resolveSession` import the file already uses for the other admin routes; add `gte` to the drizzle-orm import.)

- [ ] **Step 6: Run suite + typecheck**

Run: `cd services/cti-api && npm test && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add services/cti-api/src/dialer/session-store.ts services/cti-api/src/dialer/session-store.test.ts services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/admin.ts
git commit -m "feat(cti-api): session view carries attempt/retry/rollover state; admin follow-up rollover endpoint"
```

---

### Task 7: Client — human-only pop, attempt badge, retry countdown, summary, admin line

**Files:**
- Modify: `apps/cti-web/src/dialer-api.ts`
- Modify: `apps/cti-web/src/components/DialerPanel.tsx`
- Modify: `apps/cti-web/src/components/AdminPanel.tsx`
- Test: `apps/cti-web/src/components/DialerPanel.test.tsx`

**Interfaces:**
- Consumes: the Task 6 session view shape.
- Produces: `shouldScreenPop(item: DialerCurrentItem | null): boolean`; `retryCountdown(nextRetryAt: string, now: number): string` ("m:ss"); `rolloverLine(r: { moved; pushed; failed }): string`.

- [ ] **Step 1: Write the failing tests** — append to `apps/cti-web/src/components/DialerPanel.test.tsx` (import the three helpers from `./DialerPanel`):

```tsx
describe('shouldScreenPop — humans only', () => {
  it('pops only once the record is connected (AMD drops machines before bridging, so connected = human)', () => {
    const base = { id: 'i1', recordId: '00Q1', objectType: 'Lead', toNumber: '+16195551234' };
    expect(shouldScreenPop({ ...base, status: 'connected' })).toBe(true);
    expect(shouldScreenPop({ ...base, status: 'dialing' })).toBe(false);
    expect(shouldScreenPop({ ...base, status: 'no_connect' })).toBe(false);
    expect(shouldScreenPop(null)).toBe(false);
  });
});

describe('retryCountdown', () => {
  it('formats the time until the next retry as m:ss, never negative', () => {
    const now = Date.parse('2026-08-22T17:00:00Z');
    expect(retryCountdown('2026-08-22T17:03:40Z', now)).toBe('3:40');
    expect(retryCountdown('2026-08-22T17:00:05Z', now)).toBe('0:05');
    expect(retryCountdown('2026-08-22T16:59:00Z', now)).toBe('0:00');
  });
});

describe('rolloverLine', () => {
  it('reads naturally and omits zero parts', () => {
    expect(rolloverLine({ moved: 12, pushed: 3, failed: 0 })).toBe('12 follow-ups moved to tomorrow · 3 pushed later (daily limit)');
    expect(rolloverLine({ moved: 1, pushed: 0, failed: 0 })).toBe('1 follow-up moved to tomorrow');
    expect(rolloverLine({ moved: 0, pushed: 0, failed: 2 })).toBe('2 follow-ups could not be moved — see admin');
    expect(rolloverLine({ moved: 0, pushed: 0, failed: 0 })).toBe('');
  });
});

describe('DialerPanel render (SSR)', () => {
  it('shows the attempt badge and the retry countdown from the view', () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue({
      session: { id: 'sess1', status: 'active' },
      counts: { total: 2, done: 0, connected: 0, noConnect: 1, skipped: 0, unreachable: 0, pending: 1 },
      currentItem: { id: 'i2', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234', attempt: 2 },
      waitingRetry: null, rollovers: { moved: 0, pushed: 0, failed: 0, pending: 0 },
    });
    // SSR never runs the effect, so we render the pure pieces directly:
    expect(renderToStaticMarkup(<AttemptBadge attempt={2} />)).toContain('Attempt 2 of 2');
    expect(renderToStaticMarkup(<AttemptBadge attempt={1} />)).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cti-web && npx vitest run src/components/DialerPanel.test.tsx`
Expected: FAIL — `shouldScreenPop`/`retryCountdown`/`rolloverLine`/`AttemptBadge` not exported.

- [ ] **Step 3: Extend the client types** — in `apps/cti-web/src/dialer-api.ts`:

```ts
export interface DialerCurrentItem {
  id: string;
  recordId: string;
  objectType: string;
  status: string;
  toNumber: string | null;
  /** 1 or 2 — the second try of the day for this record. */
  attempt?: number;
}

export interface DialerRollovers { moved: number; pushed: number; failed: number; pending: number }

export interface DialerSessionView {
  session: DialerSession;
  counts: DialerSessionCounts;
  currentItem: DialerCurrentItem | null;
  /** Set when the run is idle only because its retries are inside the 5-min floor. */
  waitingRetry?: { nextRetryAt: string } | null;
  rollovers?: DialerRollovers;
}
```

- [ ] **Step 4: Implement in `DialerPanel.tsx`**

Add the pure helpers next to `isNextEnabled`:

```ts
/** Pure — pop the record ONLY for a live human. AMD hangs up machines before the
 *  rep is bridged, so `connected` ⇒ a person; voicemail never pops. */
export function shouldScreenPop(item: DialerCurrentItem | null): boolean {
  return item?.status === 'connected';
}

/** Pure — "m:ss" until the next retry; clamps at 0:00. */
export function retryCountdown(nextRetryAt: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(nextRetryAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Pure — the run-summary rollover line; '' when there is nothing to say. */
export function rolloverLine(r: { moved: number; pushed: number; failed: number }): string {
  const parts: string[] = [];
  if (r.moved) parts.push(`${r.moved} follow-up${r.moved === 1 ? '' : 's'} moved to tomorrow`);
  if (r.pushed) parts.push(`${r.pushed} pushed later (daily limit)`);
  if (!parts.length && r.failed) return `${r.failed} follow-up${r.failed === 1 ? '' : 's'} could not be moved — see admin`;
  return parts.join(' · ');
}

export function AttemptBadge({ attempt }: { attempt?: number }): JSX.Element | null {
  return attempt === 2 ? <span className="dp-attempt">Attempt 2 of 2</span> : null;
}
```

In the poll effect, replace the screen-pop block with:

```ts
        // Pop the record only for a live human (see shouldScreenPop) — not while
        // it is still ringing, and never for voicemail. Once per item.
        const current = next.currentItem;
        if (shouldScreenPop(current) && current && lastPoppedIdRef.current !== current.id) {
          lastPoppedIdRef.current = current.id;
          onScreenPop(current.recordId);
        }
```

Add a 1-second ticker for the countdown near the other state: `const [now, setNow] = useState(() => Date.now());` and an effect `useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);`.

In `CurrentRecord`, after the `dp-current-meta` div, add `<AttemptBadge attempt={item.attempt} />`.

In the active (non-terminal) render, directly above the `dp-controls` row, add:

```tsx
          {view.waitingRetry && (
            <div className="dp-waiting">Next retry in {retryCountdown(view.waitingRetry.nextRetryAt, now)}</div>
          )}
```

In the terminal summary, after `<div className="dp-summary-meta">{progressLabel(view.counts)}</div>`, add:

```tsx
          {view.rollovers && rolloverLine(view.rollovers) && (
            <div className="dp-summary-meta">{rolloverLine(view.rollovers)}</div>
          )}
```

Update the `onScreenPop` prop doc to say "once the record connects to a human".

Append to `apps/cti-web/src/styles.css`:

```css
/* Power dialer: attempt badge + retry countdown */
.dp-attempt { display: inline-block; margin-top: 4px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.dp-waiting { text-align: center; font-size: 12px; color: var(--text-muted); margin: 6px 0; }
```

- [ ] **Step 5: Admin line** — in `AdminPanel.tsx`: add `interface RolloverHealth { succeeded: number; failed: Array<{ recordId: string; userEmail: string; lastError: string | null; attempts: number }> }` and `const [rollovers, setRollovers] = useState<RolloverHealth | null>(null);`. In `load`, add a fourth call to `Promise.all`: `api<RolloverHealth>('/admin/followup-rollovers')` and `setRollovers(...)`. After the `admin-compliance` block, render:

```tsx
      {rollovers && (
        <div className="admin-compliance">
          <div className="admin-group-head"><ShieldIcon /> Follow-up rollovers (24h)</div>
          <div className="admin-rollovers">
            {rollovers.succeeded} ok · {rollovers.failed.length} failed
            {rollovers.failed.length > 0 && (
              <ul>
                {rollovers.failed.map((f) => (
                  <li key={`${f.recordId}-${f.userEmail}`}>{f.userEmail} · {f.recordId} — {f.lastError ?? 'unknown'} ({f.attempts}×)</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
```

and append `.admin-rollovers { font-size: 12px; color: var(--text-muted); } .admin-rollovers ul { margin: 6px 0 0 16px; color: var(--bad); }` to `styles.css`.

- [ ] **Step 6: Run tests, typecheck, build**

Run: `cd apps/cti-web && npm test && npm run typecheck && npm run build`
Expected: all PASS; typecheck clean; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/cti-web/src/dialer-api.ts apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/components/DialerPanel.test.tsx apps/cti-web/src/components/AdminPanel.tsx apps/cti-web/src/styles.css
git commit -m "feat(cti-web): pop only on human connect; attempt badge, retry countdown, rollover summary, admin health line"
```

---

### Task 8: Deploy + live verification

**Files:** none (operational).

- [ ] **Step 1: Merge/push `main`** (Railway auto-deploys; migration 0024 runs via `preDeployCommand`). Watch: `curl -s https://ctiapi-production.up.railway.app/healthz` stays 200; the served `/cti/` bundle hash changes.
- [ ] **Step 2: Confirm the migration applied** — via `railway run -s Postgres`: `select column_name from information_schema.columns where table_name='dialer_queue_items' and column_name in ('attempt','primary_number','retry_not_before')` (3 rows) and `select count(*) from followup_rollover_jobs` (0).
- [ ] **Step 3: Two-attempt run** — in the softphone, Power Dial the **CTI Dial Test** list (3 opps → the benign target, read as a machine ⇒ a guaranteed miss). Expect: each record shows **Attempt 2 of 2** on its second pass after a ~5-minute "Next retry in m:ss" wait; no screen-pop at any point (no human). Then in Postgres: `select record_id, attempt, status from dialer_queue_items where session_id = '<sid>' order by ordinal` → 6 rows, 3 at attempt 2; `select status, target_date, last_error from followup_rollover_jobs where session_id='<sid>'` → 3 rows `succeeded` (or `no-task` if those test opps carry no Follow-up — create one on each first).
- [ ] **Step 4: Cap overflow** — `update campaign_configs set followup_daily_cap = 1 where org_id='<test org>' and key='default'`; re-run with fresh Follow-up tasks on the 3 opps; expect `target_date` = next business day for the first job and successive later business days for the other two. Reset the cap to 100.
- [ ] **Step 5: Admin** — open Numbers → confirm "Follow-up rollovers (24h): N ok · 0 failed".
