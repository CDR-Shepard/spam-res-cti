# Power-Dial Run Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Ready-to-dial screen gets three settings: **Calls per person** (Once or Twice), **How many** (All, or the first N people), and **Missed tasks move to** (next business day, or in 2 business days). The rep's last Calls-per-person and Missed-tasks choices are remembered. A rolled task lands N business days after the *later* of the dial day and its own due date.

**Architecture:** Migration 0046 adds three integer columns to `dialer_sessions` (`passes`, `max_records`, `rollover_business_days`), two to `users` (`dialer_passes`, `dialer_rollover_business_days`) and one to `followup_rollover_jobs` (`business_days`). Each has a CHECK constraint and a default that matches today's behaviour.

The session and its queue are built *before* the Ready screen (`POST /dialer/sessions[/from-listview]`), so the settings arrive with **Start dialing** (`POST /dialer/sessions/:id/start`). They are applied inside the `ready → active` claim, which becomes one transaction:
- the flip's own UPDATE writes the three settings;
- the already-built queue is cut after the N-th dialable row;
- the rep's two choices are saved.

On a miss, the engine reads `session.passes` for both the end-of-run requeue and the rollover threshold, and it stamps `session.rollover_business_days` on the rollover job. Click-to-dial keeps the 2-miss rule and uses the rep's saved choice. The worker computes the landing base as `max(dial day, template's ActivityDate)` from the task it already reads, then starts the cap loop at the N-th business day.

**Tech Stack:** TypeScript; Fastify 4 + Drizzle 0.36 (Postgres) + zod 3; React 18 + Vite; vitest (API v2; web v4 with @testing-library/react + jsdom).

## Global Constraints

Verbatim from the task:
- A rep who never touches the settings (Twice / All / Next business day) gets EXACTLY today's run: same requeue, same rollover threshold, same landing day for tasks due today or overdue.
- These stay unchanged:
  - nothing rolls for a person reached today;
  - Skip, Stop and a take-callback cancel never count as a non-connect;
  - one rollover per person per day;
  - the 3 h courtesy, the FL/OK/WA/MD 3-per-24h cap, and the per-customer ceiling;
  - the 100/day rollover cap and the 30-business-day bound.
- A redial copy never gets its own end-of-run retry, whatever `passes` is.
- House ordering rules: settle the row BEFORE hanging up; pause FIRST; hang up LAST. Don't reorder anything in the miss transaction.
- Pinned SQL tests (`new PgDialect().sqlToQuery(...)`) for every new query and write. Partial-index gotcha: use a bare `onConflictDoNothing()` only.
- Every new value is validated at the route boundary, and a bad value returns 400 naming the field. New columns get CHECK constraints and defaults, so existing rows behave as today.
- No console.log, and no `any` outside tests.
- Commits end with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>".

Implied by the spec (`docs/superpowers/specs/2026-09-28-run-settings-design.md`, binding):
- Calls per person is **Once** or **Twice**; there is no double tap. Missed tasks go to the **next business day** or **2 business days** out. Run size is a **number of people**; there is no time limit.
- Garrett's existing Sept 27 tasks are **not** moved. No backfill, and no data fix.
- "Missed tasks move to" is always shown. It applies to every follow-up the rollover touches, on Lead, Opportunity and Task runs alike.
- Click-to-dial rollovers keep the owner's-2nd-non-connect rule, and they use the rep's saved "Missed tasks move to".
- One migration, `0046_run_settings.sql`, because 0045 ships first. It follows 0045's style: `SET LOCAL lock_timeout = '5s'` first, then additive, idempotent statements.
- Out of scope: double tap, a time limit, admin/org defaults, "leave it where it is" / "in 1 week", moving the Sept 27 copies, and changing the click-to-dial threshold.
- Rep-facing strings (exact):
  - `Calls per person`, `Once`, `Twice`
  - `How many`, `Call the first`, `of <list size>`, placeholder `All`, `Enter a whole number from 1 to <list size>, or leave it blank for all.`
  - `Missed tasks move to`, `Next business day`, `In 2 business days`
  - the run line `<Once|Twice> · <all|first N> · missed → <next business day|in 2 business days>`
- The rep guide (`~/Documents/gg-guides-site/public/power-dial.html`) is outside the repo. It's edited locally and **not published**: no tar, and no gHost `ship`, until the user OKs it.
- Every command runs from the worktree root `/Users/cdrshepard/spam-res-cti/.claude/worktrees/callsign-main`. `cd <dir> && …` is relative to that root. In a harness worktree, first run `git merge --ff-only main`, then `npm install --no-audit --no-fund --prefer-offline` and `npm run build:packages`.
- How SQL is pinned:
  - A full statement is pinned with the builder's `.toSQL()` on a never-connecting drizzle instance, `drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema })`. That renders through the same `PgDialect`, and it's the house idiom in `sms/inbound-text-worker.test.ts`.
  - A WHERE captured by a fake is pinned with `new PgDialect().sqlToQuery(...)`.
  - Every expected string in this plan was rendered from a patched copy of the schema while the plan was written.
- `@cti/db` and `@cti/contracts` are consumed from their `dist/`. Rebuild (`npm -w packages/<name> run build`, or `npm run build:packages`) before running API/web tests that depend on a change in them.
- TDD: red first. Never `git stash`, never push, never deploy, never touch production.

## Design decisions this plan settles (one line of why each)

1. **Where the settings are applied:** in `POST /dialer/sessions/:id/start`, inside the `ready → active` claim. The claim becomes one transaction: the flip's UPDATE carries the three settings, then the queue is trimmed, then the defaults are saved. **Why:** the queue and the session already exist when the rep chooses. One transaction means a refused Start (the one-active-run index) changes nothing, and the rep can press Start again with other choices.
2. **`rolloverDue`'s threshold:** a power-dial miss passes `session.passes` (1 or 2), read off the session row the miss handler already loads. Click-to-dial passes `CLICK_TO_DIAL_ROLLOVER_MISSES = 2`. **Why:** the run's own setting governs its misses, and click-to-dial has no run, so the spec keeps its rule.
3. **A Once run's rollover is enqueued at the same site, inside the same miss transaction, as today's.** Only the threshold changes. **Why:** it keeps the "enqueue commits or rolls back with the CAS" guarantee, the ordering, and the one-per-person-per-day key untouched.
4. **The job's `business_days`:** a power-dial miss copies `session.rolloverBusinessDays` into the enqueue. Click-to-dial reads `users.dialer_rollover_business_days` through a new `SyncOneDeps.rolloverBusinessDays(userId)`, only when a rollover is due; a failed read fails closed and is logged. **Why:** the worker then needs no session lookup, and a sync failure stays a visible open task, never a mis-dated one.
5. **The source task's due date:** the worker reuses `task.ActivityDate` from the template it already resolved: the by-id read for Task runs, or the record search for Lead/Opp runs. A null date, or one that isn't `YYYY-MM-DD`, falls back to the dial day. The dial day is `job.fromDate`, the LA calendar date of the miss (`orgTodayIso`). **Why:** there's no extra Salesforce query and no new column, and `from_date` stays the one-rollover-per-day key and the sibling day.
6. **`next_day` becomes the uncapped landing day** (`firstLandingDay(base, businessDays)`). **Why:** the run summary's `moved` vs `pushed` then still means "the cap pushed it", instead of calling every 2-day rollover "pushed".
7. **`maxRecords` vs rotation and the filters:** the queue was built at session creation, already rotated from the shared list position and already filtered, so `pending` rows are the dialable people. At Start, the cut falls after the N-th `pending` row (`runSizeCutoff`), and every row past it is deleted, whatever its status. N counts people actually queued. The settled rows in front of the cut stay, so the run still reports them. **Why:** the rotation and the filters are untouched, and a ready session has no calls or dial attempts, so the delete removes only queue.
8. **The shared list position:** this stays the existing rule, the furthest `list_position` *dialed* on the list in 12 h. Once a limited run has dialed its N people, the next run starts at N+1. If a run stops early, the next run resumes where it stopped, not past people nobody called. **Why:** changing `listStartPosition` isn't in the spec, and "past the last dialed" is the safer reading of "past the last queued".
9. **"N will be dialed" when N is larger than the dialable count:** it shows the dialable count, `min(N, dialable)`. The box still accepts any whole number up to the list size, as the spec says. **Why:** the screen must never promise calls the list can't give.
10. **Where the run-settings line reads from:** `GET /dialer/sessions/:id` already returns the whole session row as `session`, so after migration 0046 it carries `passes`, `maxRecords` and `rolloverBusinessDays`. The web reads `view.session.*`, and a route test pins it. **Why:** no new endpoint and no new poll.
11. **A Start with no body** (a tab loaded before this release) starts today's run. The column defaults hold and nothing is saved. A body that is present must be complete and valid. **Why:** Salesforce console tabs live for days, and they must neither break nor overwrite a rep's saved choices.
12. **`maxRecords` is validated as an integer from 1 to 500** (`MAX_RUN_RECORDS`, the most records a run can hold). It may be absent or null, and both mean All. **Why:** a value past any possible list is a 400, never a silent All.
13. **"record X of N" on a limited run** counts the run's own queue (`ordinal + 1` of `firstPassTotal`), and an attempt-2 retry gets no count. A full run keeps today's Salesforce list position. **Why:** list positions run 0–199 while a limited queue holds ~100 rows. Keeping the list position there would read "record 150 of 100".
14. **How many is not remembered.** Only Calls per person and Missed tasks get user columns and come back from `/auth/me`. **Why:** that is spec decision 1, and a count only means something for one list.
15. **After an accepted Start, App re-reads `/auth/me`** (`onRunDefaultsSaved={refreshMe}`). **Why:** the next run in the same tab starts from the choices just saved; Settings already refreshes this way.

## Where this plan reads the spec differently (flagged to the user, not silent)

- The spec saves the defaults "in the same transaction that creates the session" and applies `maxRecords` at "queue creation". The session and queue are created *before* the Ready screen, though, so both happen in the Start claim transaction instead (decisions 1 and 7).
- The spec's decision 1 lists no `dialer_sessions.max_records`. The run line ("first 100") and the session view need it, so the plan adds it: nullable, `CHECK (max_records IS NULL OR max_records >= 1)`.
- "Starting a run saves these three choices" conflicts with the spec's two user columns and its `/auth/me` shape. The plan remembers two (decision 14).
- The spec says "record X of N ... key off the queued people". Today that line is the Salesforce list position, so it changes for limited runs only (decision 13).

## File structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/dialer-run.ts` (new) | The shared vocabulary: `DialerPasses`, `RolloverBusinessDays`, `DialerRunDefaults`, `DialerRunSettings`, the defaults, `MAX_RUN_RECORDS`, and tolerant readers. |
| `packages/db/migrations/0046_run_settings.sql` (new) + `packages/db/src/schema.ts` | Six checked columns with today's defaults. |
| `services/cti-api/src/dialer/run-settings.ts` (new) | `runSizeCutoff`, plus the pinned builders: the claim with settings, the queue trim, saving the defaults, and reading the saved Missed-tasks choice. |
| `services/cti-api/src/dialer/contact-history.ts` | `rolloverDue(…, requiredMisses)` and `CLICK_TO_DIAL_ROLLOVER_MISSES`. |
| `services/cti-api/src/dialer/engine.ts` | The claim transaction with settings; the requeue and rollover threshold from `session.passes`; `businessDays` on the enqueue. |
| `services/cti-api/src/salesforce/followup-enqueue.ts` | `rolloverJobInsert` (a pinned builder); the job carries `businessDays`. |
| `services/cti-api/src/salesforce/sync.ts` | Click-to-dial: threshold 2, plus the rep's saved choice. |
| `services/cti-api/src/salesforce/followup-day.ts` | `rolloverBase`, `firstLandingDay`, and `pickRolloverDay({ businessDays })`. |
| `services/cti-api/src/salesforce/followup-worker.ts` | The landing base from the template's due date; `nextDay` = the uncapped landing day. |
| `services/cti-api/src/routes/dialer.ts` | `RunSettingsBody`, `parseRunSettings`, and the Start route's validation. |
| `services/cti-api/src/routes/auth.ts` | `/auth/me` returns `dialerRunDefaults`. |
| `apps/cti-web/src/run-settings.ts` (new) | Pure web helpers: the draft, the box parsing, the Start body, the run line, and "record X of N". |
| `apps/cti-web/src/components/RunSettingsBlock.tsx` (new) | The three settings: prop-only, SSR-testable. |
| `apps/cti-web/src/components/DialerPanel.tsx` | ConfirmBlock hosts the block. The panel owns the draft, sends it with Start, and shows the run line. |
| `apps/cti-web/src/dialer-api.ts`, `App.tsx`, `styles.css` | `startDialerRun`, the session and item fields, the `/auth/me` wiring, and styles. |
| `docs/runbooks/dialer-cadence.md` | The operator's section. |
| `~/Documents/gg-guides-site/public/power-dial.html` (outside the repo, unpublished) | The rep paragraph. |

---

### Task 1: API and data — contracts, migration 0046, schema, the Start claim with settings, the miss path, click-to-dial, the worker's landing day, the routes, `/auth/me`

**Files:**
- Create: `packages/contracts/src/dialer-run.ts`, `packages/contracts/src/dialer-run.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/db/migrations/0046_run_settings.sql`, `packages/db/src/migration-0046.test.ts`
- Modify: `packages/db/src/schema.ts` (users ~line 133, dialerSessions ~line 288, followupRolloverJobs ~lines 830–840), `services/cti-api/src/salesforce/no-answer-chatter-worker.test.ts:56` (a fully typed session fixture)
- Create: `services/cti-api/src/dialer/run-settings.ts`, `services/cti-api/src/dialer/run-settings.test.ts`
- Modify: `services/cti-api/src/dialer/contact-history.ts:55-69`, `services/cti-api/src/dialer/contact-history.test.ts`
- Modify: `services/cti-api/src/dialer/engine.ts:1-23,200-247,1018-1117`, `services/cti-api/src/dialer/engine.test.ts`
- Modify: `services/cti-api/src/salesforce/followup-enqueue.ts` (full replacement), `services/cti-api/src/salesforce/followup-enqueue.test.ts`
- Modify: `services/cti-api/src/salesforce/sync.ts:11-28,261-283,503-525`, `services/cti-api/src/salesforce/sync.test.ts`
- Modify: `services/cti-api/src/salesforce/followup-day.ts` (full replacement), `services/cti-api/src/salesforce/followup-day.test.ts` (full replacement)
- Modify: `services/cti-api/src/salesforce/followup-worker.ts:49,54,454-465`, `services/cti-api/src/salesforce/followup-worker.test.ts`
- Modify: `services/cti-api/src/routes/dialer.ts:1-80,357-370`, `services/cti-api/src/routes/dialer.test.ts`
- Modify: `services/cti-api/src/routes/auth.ts:14-22,203-231`, `services/cti-api/src/routes/auth-me.test.ts`

**Interfaces:**
- Consumes: `schema`, `type Db` from `@cti/db`; `nextBusinessDay` from `dialer/next-business-day.ts`; `orgTodayIso` / `orgMidnightUtc` (unchanged).
- Produces (Tasks 2–3 rely on these exact names and shapes):
  ```ts
  // @cti/contracts (packages/contracts/src/dialer-run.ts)
  export const DIALER_PASSES: readonly [1, 2];
  export type DialerPasses = 1 | 2;
  export const ROLLOVER_BUSINESS_DAYS: readonly [1, 2];
  export type RolloverBusinessDays = 1 | 2;
  export const MAX_RUN_RECORDS = 500;
  export interface DialerRunDefaults { passes: DialerPasses; rolloverBusinessDays: RolloverBusinessDays }
  export interface DialerRunSettings extends DialerRunDefaults { maxRecords: number | null }
  export const DEFAULT_DIALER_RUN_DEFAULTS: DialerRunDefaults; // { passes: 2, rolloverBusinessDays: 1 }
  export function toDialerPasses(v: unknown): DialerPasses;                 // only 1 → 1, else 2
  export function toRolloverBusinessDays(v: unknown): RolloverBusinessDays; // only 2 → 2, else 1
  export function toDialerRunDefaults(v: { passes?: unknown; rolloverBusinessDays?: unknown } | null | undefined): DialerRunDefaults;

  // @cti/db
  users.dialerPasses: 1 | 2;                       // dialer_passes integer NOT NULL DEFAULT 2
  users.dialerRolloverBusinessDays: 1 | 2;         // dialer_rollover_business_days integer NOT NULL DEFAULT 1
  dialerSessions.passes: 1 | 2;                    // passes integer NOT NULL DEFAULT 2
  dialerSessions.maxRecords: number | null;        // max_records integer NULL
  dialerSessions.rolloverBusinessDays: 1 | 2;      // rollover_business_days integer NOT NULL DEFAULT 1
  followupRolloverJobs.businessDays: 1 | 2;        // business_days integer NOT NULL DEFAULT 1

  // services/cti-api
  export function startSession(sessionId: string, deps: EngineDeps, settings?: DialerRunSettings | null): Promise<…unchanged union…>;
  export interface RolloverEnqueue { …; businessDays: RolloverBusinessDays }
  export function rolloverDue(dials: readonly Dial[], ownerUserId: string, dayStart: Date, requiredMisses: DialerPasses): boolean;
  export const CLICK_TO_DIAL_ROLLOVER_MISSES = 2;
  export function rolloverBase(dialDay: string, dueDate: string | null | undefined): string;
  export function firstLandingDay(fromDate: string, businessDays: RolloverBusinessDays, workingWeekdays: ReadonlySet<number>, holidays: ReadonlySet<string>): string;
  export const RunSettingsBody: z.ZodObject<…>;  // strict
  export function parseRunSettings(body: unknown): { ok: true; settings: DialerRunSettings | null } | { ok: false; field: string };
  ```
  HTTP:
  - `POST /dialer/sessions/:id/start` takes either no body (today's run; nothing saved) or `{ passes: 1|2, rolloverBusinessDays: 1|2, maxRecords?: integer 1..500 | null }` (strict).
    - `400 { error: 'Invalid <field>', field: '<field>' }` when the body is bad.
    - `403`, `404`, and `409` behave exactly as today.
  - `GET /dialer/sessions/:id` → `session.passes`, `session.maxRecords`, `session.rolloverBusinessDays`.
  - `GET /auth/me` → `user.dialerRunDefaults: { passes: 1|2, rolloverBusinessDays: 1|2 }`.

#### Part A — the shared vocabulary

- [ ] **Step 1: Write the failing contracts test**. Create `packages/contracts/src/dialer-run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIALER_RUN_DEFAULTS,
  DIALER_PASSES,
  MAX_RUN_RECORDS,
  ROLLOVER_BUSINESS_DAYS,
  toDialerPasses,
  toDialerRunDefaults,
  toRolloverBusinessDays,
} from './index.js';

describe('Power Dial run settings (spec 2026-09-28)', () => {
  it("the choices, and defaults that are exactly today's run", () => {
    expect(DIALER_PASSES).toEqual([1, 2]);
    expect(ROLLOVER_BUSINESS_DAYS).toEqual([1, 2]);
    expect(DEFAULT_DIALER_RUN_DEFAULTS).toEqual({ passes: 2, rolloverBusinessDays: 1 });
    expect(MAX_RUN_RECORDS).toBe(500);
  });

  it('toDialerPasses: only 1 is Once; anything else is Twice', () => {
    expect(toDialerPasses(1)).toBe(1);
    for (const v of [2, 0, 3, '1', null, undefined, 1.5]) expect(toDialerPasses(v)).toBe(2);
  });

  it('toRolloverBusinessDays: only 2 is two days; anything else is the next business day', () => {
    expect(toRolloverBusinessDays(2)).toBe(2);
    for (const v of [1, 0, 3, '2', null, undefined]) expect(toRolloverBusinessDays(v)).toBe(1);
  });

  it("toDialerRunDefaults reads a row; a missing one is today's run", () => {
    expect(toDialerRunDefaults({ passes: 1, rolloverBusinessDays: 2 })).toEqual({ passes: 1, rolloverBusinessDays: 2 });
    expect(toDialerRunDefaults(undefined)).toEqual({ passes: 2, rolloverBusinessDays: 1 });
    expect(toDialerRunDefaults(null)).toEqual({ passes: 2, rolloverBusinessDays: 1 });
    expect(toDialerRunDefaults({ passes: 'once', rolloverBusinessDays: 7 })).toEqual({ passes: 2, rolloverBusinessDays: 1 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/contracts && npx vitest run src/dialer-run.test.ts`
Expected: FAIL. `DIALER_PASSES` is `undefined`, and `toDialerPasses is not a function`.

- [ ] **Step 3: Implement**. Create `packages/contracts/src/dialer-run.ts`:

```ts
/**
 * Power Dial run settings (spec docs/superpowers/specs/2026-09-28-run-settings-design.md)
 * — the one definition the API (route validation, engine, rollover worker,
 * `/auth/me`) and the softphone (Ready to dial, the run line) share.
 *
 * Every default here is TODAY'S run: Twice, the whole list, next business day.
 * A value that cannot be read falls back to it, so a bad row or an older
 * client never changes how a rep's run behaves.
 */

/** Calls per person: 1 = Once (no end-of-run retry), 2 = Twice (today). */
export const DIALER_PASSES = [1, 2] as const;
export type DialerPasses = (typeof DIALER_PASSES)[number];

/** Missed tasks move to: 1 = next business day (today), 2 = in 2 business days. */
export const ROLLOVER_BUSINESS_DAYS = [1, 2] as const;
export type RolloverBusinessDays = (typeof ROLLOVER_BUSINESS_DAYS)[number];

/** The most records one run can hold — POST /dialer/sessions caps `recordIds` at 500. */
export const MAX_RUN_RECORDS = 500;

/** What `/auth/me` returns as `dialerRunDefaults`, and what a Start saves. */
export interface DialerRunDefaults {
  passes: DialerPasses;
  rolloverBusinessDays: RolloverBusinessDays;
}

/** The Start dialing body. `maxRecords` null = the whole list. */
export interface DialerRunSettings extends DialerRunDefaults {
  maxRecords: number | null;
}

export const DEFAULT_DIALER_RUN_DEFAULTS: DialerRunDefaults = { passes: 2, rolloverBusinessDays: 1 };

export function toDialerPasses(v: unknown): DialerPasses {
  return v === 1 ? 1 : 2;
}

export function toRolloverBusinessDays(v: unknown): RolloverBusinessDays {
  return v === 2 ? 2 : 1;
}

export function toDialerRunDefaults(
  v: { passes?: unknown; rolloverBusinessDays?: unknown } | null | undefined,
): DialerRunDefaults {
  return { passes: toDialerPasses(v?.passes), rolloverBusinessDays: toRolloverBusinessDays(v?.rolloverBusinessDays) };
}
```

In `packages/contracts/src/index.ts`, add as the first line:

```ts
export * from './dialer-run.js';
```

- [ ] **Step 4: Run it to verify it passes, then build**

Run: `cd packages/contracts && npx vitest run && npm run build`
Expected: every contracts test passes, including the 4 new ones, and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/dialer-run.ts packages/contracts/src/dialer-run.test.ts packages/contracts/src/index.ts
git commit -m "$(cat <<'EOF'
feat(contracts): power-dial run settings vocabulary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

#### Part B — migration 0046 and the schema

- [ ] **Step 6: Write the failing migration test**. Create `packages/db/src/migration-0046.test.ts`:

```ts
/**
 * 0046_run_settings.sql — pinned. Read from disk rather than applied (the unit
 * suite has no database), so the file's text IS the contract: the
 * lock_timeout guard (0045's M5 rule — migrate-runner.ts wraps each file in
 * one transaction, which is what makes SET LOCAL cover it all), then six
 * columns, each with the default that is today's behaviour and a named CHECK
 * riding its own ADD COLUMN IF NOT EXISTS, so re-running the file is a no-op.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { dialerSessions, followupRolloverJobs, users } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0046_run_settings.sql'), 'utf8');
/** Statements only: comments stripped, whitespace collapsed, split on `;`. */
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0046_run_settings', () => {
  it("sets the lock_timeout guard, then adds six checked columns whose defaults are today's run, idempotently", () => {
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_passes integer NOT NULL DEFAULT 2 CONSTRAINT users_dialer_passes_check CHECK (dialer_passes IN (1, 2))',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_rollover_business_days integer NOT NULL DEFAULT 1 CONSTRAINT users_dialer_rollover_business_days_check CHECK (dialer_rollover_business_days IN (1, 2))',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS passes integer NOT NULL DEFAULT 2 CONSTRAINT dialer_sessions_passes_check CHECK (passes IN (1, 2))',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS max_records integer CONSTRAINT dialer_sessions_max_records_check CHECK (max_records IS NULL OR max_records >= 1)',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS rollover_business_days integer NOT NULL DEFAULT 1 CONSTRAINT dialer_sessions_rollover_business_days_check CHECK (rollover_business_days IN (1, 2))',
      'ALTER TABLE followup_rollover_jobs ADD COLUMN IF NOT EXISTS business_days integer NOT NULL DEFAULT 1 CONSTRAINT followup_rollover_jobs_business_days_check CHECK (business_days IN (1, 2))',
    ]);
  });

  it("the Drizzle schema matches: integer, NOT NULL with today's default — max_records nullable with none", () => {
    const u = getTableColumns(users);
    const s = getTableColumns(dialerSessions);
    const j = getTableColumns(followupRolloverJobs);
    for (const [col, name, dflt] of [
      [u.dialerPasses, 'dialer_passes', 2],
      [u.dialerRolloverBusinessDays, 'dialer_rollover_business_days', 1],
      [s.passes, 'passes', 2],
      [s.rolloverBusinessDays, 'rollover_business_days', 1],
      [j.businessDays, 'business_days', 1],
    ] as const) {
      expect(col.name).toBe(name);
      expect(col.columnType).toBe('PgInteger');
      expect(col.notNull).toBe(true);
      expect(col.default).toBe(dflt);
    }
    expect(s.maxRecords.name).toBe('max_records');
    expect(s.maxRecords.columnType).toBe('PgInteger');
    expect(s.maxRecords.notNull).toBe(false);
    expect(s.maxRecords.hasDefault).toBe(false);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd packages/db && npx vitest run src/migration-0046.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open '…/migrations/0046_run_settings.sql'`.

- [ ] **Step 8: Write the migration**. Create `packages/db/migrations/0046_run_settings.sql`:

```sql
-- =============================================================================
-- 0046_run_settings.sql — Power Dial run settings
-- (design: docs/superpowers/specs/2026-09-28-run-settings-design.md).
--
-- dialer_sessions.passes                  Calls per person for THIS run: 1 (Once,
--                                         no end-of-run retry, a follow-up rolls on
--                                         the owner's first non-connect of the day)
--                                         or 2 (Twice, today's run).
-- dialer_sessions.max_records             How many dialable people the run queued.
--                                         NULL = the whole list (today).
-- dialer_sessions.rollover_business_days  Missed tasks move to: 1 = next business
--                                         day (today), 2 = in 2 business days.
-- users.dialer_passes                     The rep's saved choices, written when a
-- users.dialer_rollover_business_days     run starts and read back as the next
--                                         run's defaults (and, for the second,
--                                         by click-to-dial rollovers).
-- followup_rollover_jobs.business_days    Captured when the job is queued, so the
--                                         worker needs no session lookup.
--
-- Every default is today's behaviour, so every existing row, and every write
-- from a container still running the previous release, behaves exactly as
-- before. Each CHECK rides its own ADD COLUMN IF NOT EXISTS, so re-running the
-- file is a no-op. users and dialer_sessions are hot tables: fail fast rather
-- than queue behind a conflicting lock (same guard as 0045. migrate-runner.ts
-- wraps the file in one transaction, which is what makes SET LOCAL cover it).
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_passes integer NOT NULL DEFAULT 2 CONSTRAINT users_dialer_passes_check CHECK (dialer_passes IN (1, 2));
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_rollover_business_days integer NOT NULL DEFAULT 1 CONSTRAINT users_dialer_rollover_business_days_check CHECK (dialer_rollover_business_days IN (1, 2));
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS passes integer NOT NULL DEFAULT 2 CONSTRAINT dialer_sessions_passes_check CHECK (passes IN (1, 2));
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS max_records integer CONSTRAINT dialer_sessions_max_records_check CHECK (max_records IS NULL OR max_records >= 1);
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS rollover_business_days integer NOT NULL DEFAULT 1 CONSTRAINT dialer_sessions_rollover_business_days_check CHECK (rollover_business_days IN (1, 2));
ALTER TABLE followup_rollover_jobs ADD COLUMN IF NOT EXISTS business_days integer NOT NULL DEFAULT 1 CONSTRAINT followup_rollover_jobs_business_days_check CHECK (business_days IN (1, 2));
```

(This SQL was checked against a throwaway Postgres 14 while the plan was written. It applies cleanly, a re-run only emits "already exists, skipping" notices, existing rows read 2/1/NULL/1/1, and `3` and `0` are refused by the CHECKs.)

- [ ] **Step 9: Add the columns to the Drizzle schema**. In `packages/db/src/schema.ts`:

In `users`, replace

```ts
    dialerYoutubeVideoId: text('dialer_youtube_video_id'),
```

with

```ts
    dialerYoutubeVideoId: text('dialer_youtube_video_id'),
    /** Power Dial run settings the rep last STARTED a run with (migration 0046;
     *  spec docs/superpowers/specs/2026-09-28-run-settings-design.md) — the next
     *  run's defaults. Calls per person: 1 (Once) or 2 (Twice, today's run). */
    dialerPasses: integer('dialer_passes').$type<1 | 2>().default(2).notNull(),
    /** Missed tasks move to: 1 (next business day, today's rule) or 2 business
     *  days out. Also what a click-to-dial rollover lands by. */
    dialerRolloverBusinessDays: integer('dialer_rollover_business_days').$type<1 | 2>().default(1).notNull(),
```

In `dialerSessions`, replace

```ts
    listViewId: text('list_view_id'),
```

with

```ts
    listViewId: text('list_view_id'),
    /** Run settings chosen on Ready to dial (migration 0046), written by the
     *  ready → active claim (engine.ts `claimReadySession`). A Start that sends
     *  none keeps these defaults, which are today's run. 1 = Once, 2 = Twice. */
    passes: integer('passes').$type<1 | 2>().default(2).notNull(),
    /** How many dialable people the run queued; null = the whole list. */
    maxRecords: integer('max_records'),
    /** Missed tasks move to: 1 = next business day, 2 = in 2 business days. */
    rolloverBusinessDays: integer('rollover_business_days').$type<1 | 2>().default(1).notNull(),
```

In `followupRolloverJobs`, replace

```ts
    /** The plain next business day after fromDate — lets the run summary tell "moved" from "pushed" without a Salesforce call. */
    nextDay: text('next_day'),
```

with

```ts
    /** The uncapped landing day — `business_days` business days after the later
     *  of fromDate and the task's own due date — so the run summary can tell
     *  "moved" from "pushed by the cap" without a Salesforce call. */
    nextDay: text('next_day'),
```

and replace

```ts
    completedTaskIds: text('completed_task_ids').array(),
```

with

```ts
    completedTaskIds: text('completed_task_ids').array(),
    /** Missed tasks move to (migration 0046): the copy starts at the 1st or 2nd
     *  business day after the landing base. Captured at enqueue — the run's
     *  setting for power dial, the rep's saved choice for click-to-dial — so the
     *  worker needs no session lookup. */
    businessDays: integer('business_days').$type<1 | 2>().default(1).notNull(),
```

The API has one test fixture typed as a full `dialer_sessions` row, and it has to name the three new columns or the API typecheck fails. In `services/cti-api/src/salesforce/no-answer-chatter-worker.test.ts`, replace

```ts
    lastPolledAt: null, repCallSid: null, listViewId: null,
```

with

```ts
    lastPolledAt: null, repCallSid: null, listViewId: null, passes: 2, maxRecords: null, rolloverBusinessDays: 1,
```

- [ ] **Step 10: Run the db suite, build, and typecheck the API against the new schema**

Run: `cd packages/db && npx vitest run && npm run build && cd ../../services/cti-api && npx tsc -p tsconfig.json --noEmit`
Expected: every db test passes, including the 2 new ones, and both `tsc` runs exit 0 with no output.

- [ ] **Step 11: Commit**

```bash
git add packages/db/migrations/0046_run_settings.sql packages/db/src/migration-0046.test.ts packages/db/src/schema.ts services/cti-api/src/salesforce/no-answer-chatter-worker.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration 0046 — power-dial run settings columns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

#### Part C — the run-settings module (pure cutoff + pinned SQL builders)

- [ ] **Step 12: Write the failing tests**. Create `services/cti-api/src/dialer/run-settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import type { DialerItem } from './session-store.js';
import {
  claimReadySessionQuery,
  runSizeCutoff,
  saveRunDefaultsQuery,
  savedRolloverBusinessDays,
  savedRolloverBusinessDaysQuery,
  trimQueueQuery,
} from './run-settings.js';

// Never connects: drizzle only needs the dialect to render SQL (the house
// idiom — sms/inbound-text-worker.test.ts, salesforce/permission-set-live.test.ts).
const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
const NOW = new Date('2026-09-28T17:00:00Z');

describe('runSizeCutoff — the last row a run of N people keeps', () => {
  const row = (ordinal: number, status: DialerItem['status']) => ({ ordinal, status });
  // Dialable (pending) ordinals: 1, 3, 4, 6. Settled at build: 0, 2, 5.
  const queue = [
    row(0, 'skipped'), row(1, 'pending'), row(2, 'unreachable'), row(3, 'pending'),
    row(4, 'pending'), row(5, 'skipped'), row(6, 'pending'),
  ];

  it('All (null) keeps every row', () => {
    expect(runSizeCutoff(queue, null)).toBeNull();
  });
  it('N counts DIALABLE rows only: the 2nd pending row is ordinal 3', () => {
    expect(runSizeCutoff(queue, 2)).toBe(3);
  });
  it('N = 1 keeps the settled rows in front of the first person', () => {
    expect(runSizeCutoff(queue, 1)).toBe(1);
  });
  it('no more dialable rows than N keeps everything', () => {
    expect(runSizeCutoff(queue, 4)).toBeNull();
    expect(runSizeCutoff(queue, 500)).toBeNull();
  });
  it('queue order is ordinal order, whatever order the rows were read in', () => {
    expect(runSizeCutoff([...queue].reverse(), 3)).toBe(4);
  });
});

describe('the run-settings SQL Postgres receives', () => {
  it('the claim flips ready → active and writes the three settings in the SAME update', () => {
    const { sql, params } = claimReadySessionQuery(db, 'S1', { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }, NOW).toSQL();
    expect(sql).toBe(
      'update "dialer_sessions" set "status" = $1, "passes" = $2, "max_records" = $3, "rollover_business_days" = $4, "updated_at" = $5 ' +
        'where ("dialer_sessions"."id" = $6 and "dialer_sessions"."status" = $7) returning "id", "user_id"',
    );
    expect(params).toEqual(['active', 1, 100, 2, NOW.toISOString(), 'S1', 'ready']);
  });

  it("a Start with no settings flips the status only — the columns keep today's defaults", () => {
    const { sql, params } = claimReadySessionQuery(db, 'S1', null, NOW).toSQL();
    expect(sql).toBe(
      'update "dialer_sessions" set "status" = $1, "updated_at" = $2 ' +
        'where ("dialer_sessions"."id" = $3 and "dialer_sessions"."status" = $4) returning "id", "user_id"',
    );
    expect(params).toEqual(['active', NOW.toISOString(), 'S1', 'ready']);
  });

  it('All writes max_records NULL', () => {
    expect(claimReadySessionQuery(db, 'S1', { passes: 2, maxRecords: null, rolloverBusinessDays: 1 }, NOW).toSQL().params)
      .toEqual(['active', 2, null, 1, NOW.toISOString(), 'S1', 'ready']);
  });

  it("the trim deletes only THIS run's rows past the cutoff ordinal", () => {
    const { sql, params } = trimQueueQuery(db, 'S1', 3).toSQL();
    expect(sql).toBe('delete from "dialer_queue_items" where ("dialer_queue_items"."session_id" = $1 and "dialer_queue_items"."ordinal" > $2)');
    expect(params).toEqual(['S1', 3]);
  });

  it('saving the defaults writes Calls per person and Missed tasks for ONE user — never How many', () => {
    const { sql, params } = saveRunDefaultsQuery(db, 'U1', { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }).toSQL();
    expect(sql).toBe('update "users" set "dialer_passes" = $1, "dialer_rollover_business_days" = $2 where "users"."id" = $3');
    expect(params).toEqual([1, 2, 'U1']);
  });

  it("the click-to-dial read takes ONE user's saved Missed-tasks choice", () => {
    const { sql, params } = savedRolloverBusinessDaysQuery(db, 'U1').toSQL();
    expect(sql).toBe('select "dialer_rollover_business_days" from "users" where "users"."id" = $1 limit $2');
    expect(params).toEqual(['U1', 1]);
  });
});

describe('savedRolloverBusinessDays', () => {
  const fake = (rows: unknown[]) =>
    ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) }) as unknown as Parameters<typeof savedRolloverBusinessDays>[0];

  it("reads the rep's saved choice", async () => {
    await expect(savedRolloverBusinessDays(fake([{ businessDays: 2 }]), 'U1')).resolves.toBe(2);
    await expect(savedRolloverBusinessDays(fake([{ businessDays: 1 }]), 'U1')).resolves.toBe(1);
  });

  it("a missing row is today's rule: the next business day", async () => {
    await expect(savedRolloverBusinessDays(fake([]), 'U1')).resolves.toBe(1);
  });
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `npm run build:packages && cd services/cti-api && npx vitest run src/dialer/run-settings.test.ts`
Expected: FAIL with `Failed to load url ./run-settings.js` (the module does not exist).

- [ ] **Step 14: Implement**. Create `services/cti-api/src/dialer/run-settings.ts`:

```ts
/**
 * Power Dial run settings, server side (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md).
 *
 * The rep chooses on Ready to dial — AFTER the queue was built — and the
 * choices arrive with Start dialing, so everything here runs inside the
 * ready → active claim (engine.ts `claimReadySession`): the settings land on
 * the session in the flip's own UPDATE, the queue is cut to the run size, and
 * the rep's choices are saved as their next defaults. One transaction, so a
 * refused Start (the rep's other run holds the one-active-run slot) changes
 * nothing.
 *
 * Every write is a builder returned unawaited, so its rendered SQL is pinned
 * in run-settings.test.ts.
 */
import { and, eq, gt } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { toRolloverBusinessDays, type DialerRunSettings, type RolloverBusinessDays } from '@cti/contracts';
import type { DialerItem } from './session-store.js';

/**
 * The ordinal of the last row a run of `maxRecords` people keeps: the
 * `maxRecords`-th PENDING row in queue order. The queue order is already the
 * list's rotated order (create-session.ts), so this is "the next N people from
 * where the list stands". Rows the build already settled — no number, Skip on
 * Dialer, consent, called in the last 3 h — are not people this run will dial,
 * so they do not count toward N; the ones in front of the cutoff stay so the
 * run still reports them. Null = keep every row: no limit, or no more
 * dialable rows than the limit.
 */
export function runSizeCutoff(
  items: ReadonlyArray<Pick<DialerItem, 'ordinal' | 'status'>>,
  maxRecords: number | null,
): number | null {
  if (maxRecords === null) return null;
  const pending = items.filter((i) => i.status === 'pending').map((i) => i.ordinal).sort((a, b) => a - b);
  if (pending.length <= maxRecords) return null;
  return pending[maxRecords - 1] ?? null;
}

/** The ready → active compare-and-swap, carrying the run's settings when the
 *  Start sent them. Returns the rep's id so the defaults can be saved in the
 *  same transaction without another read. */
export function claimReadySessionQuery(
  db: Pick<Db, 'update'>,
  sessionId: string,
  settings: DialerRunSettings | null,
  now: Date,
) {
  const s = schema.dialerSessions;
  return db
    .update(s)
    .set({
      status: 'active',
      updatedAt: now,
      ...(settings
        ? { passes: settings.passes, maxRecords: settings.maxRecords, rolloverBusinessDays: settings.rolloverBusinessDays }
        : {}),
    })
    .where(and(eq(s.id, sessionId), eq(s.status, 'ready')))
    .returning({ id: s.id, userId: s.userId });
}

/** Drop every row of this run past the run size (the cutoff row itself stays). */
export function trimQueueQuery(db: Pick<Db, 'delete'>, sessionId: string, cutoffOrdinal: number) {
  const i = schema.dialerQueueItems;
  return db.delete(i).where(and(eq(i.sessionId, sessionId), gt(i.ordinal, cutoffOrdinal)));
}

/** The rep's next defaults. How many is about one list, so it is never saved. */
export function saveRunDefaultsQuery(db: Pick<Db, 'update'>, userId: string, settings: DialerRunSettings) {
  return db
    .update(schema.users)
    .set({ dialerPasses: settings.passes, dialerRolloverBusinessDays: settings.rolloverBusinessDays })
    .where(eq(schema.users.id, userId));
}

export function savedRolloverBusinessDaysQuery(db: Pick<Db, 'select'>, userId: string) {
  return db
    .select({ businessDays: schema.users.dialerRolloverBusinessDays })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
}

/** The rep's saved "Missed tasks move to" — what a click-to-dial rollover lands
 *  by. A missing row is today's rule (next business day). */
export async function savedRolloverBusinessDays(db: Pick<Db, 'select'>, userId: string): Promise<RolloverBusinessDays> {
  const [row] = await savedRolloverBusinessDaysQuery(db, userId);
  return toRolloverBusinessDays(row?.businessDays);
}
```

- [ ] **Step 15: Run it to verify it passes**

Run: `cd services/cti-api && npx vitest run src/dialer/run-settings.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 16: Commit**

```bash
git add services/cti-api/src/dialer/run-settings.ts services/cti-api/src/dialer/run-settings.test.ts
git commit -m "$(cat <<'EOF'
feat(dialer): run-settings cutoff and pinned claim/trim/defaults SQL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

#### Part D — a miss follows the run's settings (requeue, rollover threshold, `business_days`), and click-to-dial

- [ ] **Step 17: Write the failing tests**

**(a)** Update `services/cti-api/src/dialer/contact-history.test.ts`. Every existing call now names today's threshold. Run:

```bash
sed -i '' "s/'rep-1', DAY))/'rep-1', DAY, 2))/g" services/cti-api/src/dialer/contact-history.test.ts
grep -c "'rep-1', DAY, 2))" services/cti-api/src/dialer/contact-history.test.ts
```

Expected: `7`.

Then replace the import line

```ts
import { cadenceVerdict, COOLDOWN_MS, preferredNumber, rolloverDue, type Dial } from './contact-history.js';
```

with

```ts
import { CLICK_TO_DIAL_ROLLOVER_MISSES, cadenceVerdict, COOLDOWN_MS, preferredNumber, rolloverDue, type Dial } from './contact-history.js';
```

and append to the end of the file:

```ts
describe("rolloverDue — the threshold is the run's Calls per person (spec 2026-09-28)", () => {
  const DAY = new Date('2026-09-23T07:00:00Z');
  it("Once (1): the owner's FIRST non-connect of the day rolls", () => {
    expect(rolloverDue([dial({ at: ago(H) })], 'rep-1', DAY, 1)).toBe(true);
  });
  it('Once never rolls a person reached today', () => {
    expect(rolloverDue([dial({ at: ago(5 * H), connected: true }), dial({ at: ago(H) })], 'rep-1', DAY, 1)).toBe(false);
  });
  it('Once: a Skip alone is not a non-connect', () => {
    expect(rolloverDue([dial({ at: ago(H), skipped: true })], 'rep-1', DAY, 1)).toBe(false);
  });
  it("Once: another rep's miss is not the owner's, and yesterday's does not count", () => {
    expect(rolloverDue([dial({ at: ago(H), userId: 'rep-2' })], 'rep-1', DAY, 1)).toBe(false);
    expect(rolloverDue([dial({ at: new Date(DAY.getTime() - 1000) })], 'rep-1', DAY, 1)).toBe(false);
  });
  it("Twice (2) is today's rule: one miss leaves it, two roll it", () => {
    expect(rolloverDue([dial({ at: ago(H) })], 'rep-1', DAY, 2)).toBe(false);
    expect(rolloverDue([dial({ at: ago(5 * H) }), dial({ at: ago(H) })], 'rep-1', DAY, 2)).toBe(true);
  });
  it('click-to-dial keeps the 2-miss rule', () => {
    expect(CLICK_TO_DIAL_ROLLOVER_MISSES).toBe(2);
  });
});
```

**(b)** Update `services/cti-api/src/salesforce/followup-enqueue.test.ts`. Replace

```ts
import { describe, it, expect } from 'vitest';
import { enqueueFollowupRollover } from './followup-enqueue.js';
import type { RolloverEnqueue } from '../dialer/engine.js';
```

with

```ts
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { enqueueFollowupRollover, rolloverJobInsert } from './followup-enqueue.js';
import type { RolloverEnqueue } from '../dialer/engine.js';
```

In `job()`, replace

```ts
    sourceTaskId: null,
    ...over,
```

with

```ts
    sourceTaskId: null,
    businessDays: 1,
    ...over,
```

and append to the end of the file:

```ts
// The job carries the run's "Missed tasks move to" (spec 2026-09-28), and the
// insert Postgres receives is pinned: every column the job names, and a BARE
// ON CONFLICT DO NOTHING — never a target (the partial-index trap, 42P10).
describe('rolloverJobInsert — the SQL Postgres receives', () => {
  // Never connects: drizzle only needs the dialect to render SQL.
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('writes business_days with the rest of the job, bare ON CONFLICT DO NOTHING', () => {
    const { sql, params } = rolloverJobInsert(db, job({ businessDays: 2 })).toSQL();
    expect(sql).toBe(
      'insert into "followup_rollover_jobs" ("id", "org_id", "user_id", "sf_owner_id", "session_id", "record_id", "object_type", "from_date", ' +
        '"status", "attempts", "last_error", "next_attempt_at", "completed_at", "completed_task_id", "created_task_id", "target_date", "next_day", ' +
        '"source_task_id", "completed_task_ids", "business_days", "created_at", "updated_at") ' +
        'values (default, $1, $2, $3, $4, $5, $6, $7, $8, default, default, default, default, default, default, default, default, $9, default, $10, default, default) ' +
        'on conflict do nothing',
    );
    expect(params).toEqual(['org1', 'user1', '005ABC', 'sess1', '0031', 'Contact', '2026-08-21', 'pending', null, 2]);
  });

  it('enqueueFollowupRollover carries businessDays onto the row', async () => {
    const f = fakeDb();
    await enqueueFollowupRollover(f.db as never, job({ businessDays: 2 }));
    expect(f.rows[0]).toEqual(expect.objectContaining({ businessDays: 2, status: 'pending' }));
  });
});
```

**(c)** Update `services/cti-api/src/dialer/engine.test.ts`. After `import { schema } from '@cti/db';` (line 4), add:

```ts
import type { DialerRunSettings } from '@cti/contracts';
import type { Dial } from './contact-history.js';
import type { DialOutcome } from './outcome.js';
```

Replace

```ts
const baseSession = { id: 'S1', orgId: 'O1', userId: 'U1', sfOwnerId: '005', objectType: 'Lead', status: 'active' };
```

with

```ts
// Run settings (migration 0046) at their defaults — today's run: Twice, the
// whole list, next business day. A session missing them would read `passes`
// as undefined and never requeue.
const baseSession = {
  id: 'S1', orgId: 'O1', userId: 'U1', sfOwnerId: '005', objectType: 'Lead', status: 'active',
  passes: 2, maxRecords: null, rolloverBusinessDays: 1,
};
```

Then append to the end of the file:

```ts
// ---------------------------------------------------------------------------
// Run settings (spec docs/superpowers/specs/2026-09-28-run-settings-design.md):
// a miss follows the run's Calls per person, and the rollover carries its
// Missed-tasks choice.
// ---------------------------------------------------------------------------
describe('handleDialOutcome — Calls per person (session.passes)', () => {
  beforeEach(() => { _target = {}; });
  const DAY = new Date(Date.UTC(2026, 6, 13, 7, 0, 0));
  const miss = (over: Record<string, unknown> = {}) => [{
    id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', primaryNumber: '+1', secondaryNumber: '+2',
    recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, followupEligible: true, taskId: null, redialOf: null,
    ...over,
  }];
  // The owner's dials to the person today. `d(0)` is THIS dial's own attempt
  // row (written at originate), which the pre-CAS history read always finds.
  const d = (hoursAgo: number, over: Partial<Dial> = {}): Dial => ({
    userId: 'U1', sessionId: 'S1', toNumber: '+1', at: new Date(Date.UTC(2026, 6, 13, 18 - hoursAgo)),
    connected: false, source: 'dialer', skipped: false, ...over,
  });
  type Row = [label: string, passes: 1 | 2, history: Dial[], outcome: DialOutcome, item: Record<string, unknown>, requeues: boolean, rolls: boolean];

  it.each<Row>([
    ['Once · first miss of the day: no retry, the follow-up rolls', 1, [d(0)], 'voicemail', {}, false, true],
    ["Twice · first miss of the day: retry, no roll (today's run)", 2, [d(0)], 'voicemail', {}, true, false],
    ["Twice · the retry misses (2nd of the day): no retry, rolls (today's run)", 2, [d(3), d(0)], 'no_answer', { attempt: 2 }, false, true],
    ['Once · reached earlier today: no retry, never rolls', 1, [d(3, { connected: true }), d(0)], 'voicemail', {}, false, false],
    ['Twice · reached earlier today: retry, never rolls', 2, [d(3, { connected: true }), d(0)], 'voicemail', {}, true, false],
    ['Once · a Stop/hang-up before answer (canceled) is not a non-connect', 1, [d(0)], 'canceled', {}, false, false],
    ['Once · an earlier Skip does not count, but this real miss rolls', 1, [d(3, { skipped: true }), d(0)], 'busy', {}, false, true],
    ['Twice · an earlier Skip + this miss is ONE miss: retry, no roll', 2, [d(3, { skipped: true }), d(0)], 'busy', {}, true, false],
    ['Once · a missed redial copy: no retry, and the earlier connect keeps it from rolling', 1, [d(3, { connected: true }), d(0)], 'voicemail', { redialOf: 'i0' }, false, false],
    ['Twice · a missed redial copy never gets its own retry', 2, [d(3, { connected: true }), d(0)], 'voicemail', { redialOf: 'i0' }, false, false],
  ])('%s', async (_label, passes, history, outcome, item, requeues, rolls) => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => history) });
    const fdb = fakeDb({ ...baseSession, passes }, miss(item)); deps.db = fdb;
    await handleDialOutcome('CA1', outcome, deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome }) });
    expect(fdb._txInserts.some((x: any) => x.values.attempt === 2)).toBe(requeues);
    expect((deps.enqueueRollover as any).mock.calls.length).toBe(rolls ? 1 : 0);
  });

  it("the queued rollover carries the run's Missed-tasks choice as businessDays", async () => {
    for (const rolloverBusinessDays of [1, 2] as const) {
      const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d(3), d(0)]) });
      deps.db = fakeDb({ ...baseSession, rolloverBusinessDays }, miss());
      await handleDialOutcome('CA1', 'voicemail', deps);
      expect(deps.enqueueRollover).toHaveBeenCalledWith(
        expect.objectContaining({ businessDays: rolloverBusinessDays, fromDate: '2026-07-13', recordId: '00Q1' }),
        expect.anything(),
      );
    }
  });

  it('a Skip or a take-callback cancel settles the row before its callback lands: a Once run neither retries nor rolls it', async () => {
    for (const settled of [{ status: 'skipped', outcome: null }, { status: 'skipped', outcome: 'canceled' }]) {
      const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d(0)]) });
      const fdb = fakeDb({ ...baseSession, passes: 1 }, miss(settled)); deps.db = fdb;
      await handleDialOutcome('CA1', 'canceled', deps);
      expect(fdb._writes).toEqual([]);
      expect(fdb._txInserts).toEqual([]);
      expect(deps.enqueueRollover).not.toHaveBeenCalled();
    }
  });
});
```

**(d)** Update `services/cti-api/src/salesforce/sync.test.ts`. In `syncDeps`, replace

```ts
    enqueueRollover: vi.fn(async () => {}) as unknown as SyncOneDeps['enqueueRollover'],
    ...over,
```

with

```ts
    enqueueRollover: vi.fn(async () => {}) as unknown as SyncOneDeps['enqueueRollover'],
    rolloverBusinessDays: vi.fn(async () => 1 as const) as unknown as SyncOneDeps['rolloverBusinessDays'],
    ...over,
```

The two exact enqueue expectations now include the saved choice. Using a replace-all edit, replace every occurrence of

```ts
      sourceTaskId: null,
    });
```

with

```ts
      sourceTaskId: null,
      businessDays: 1,
    });
```

Then check it: `grep -c "      businessDays: 1," services/cti-api/src/salesforce/sync.test.ts` should print `2`.

Append to the end of the file:

```ts
// ---------------------------------------------------------------------------
// Run settings (spec 2026-09-28 §4): a click-to-dial rollover keeps the 2-miss
// rule — "Calls per person" is a power-dial setting only — and lands where the
// rep's saved "Missed tasks move to" says. The choice is read only when a
// rollover is actually due, and a failed read fails closed like the rest of
// the check.
// ---------------------------------------------------------------------------
describe("syncOne — a click-to-dial rollover uses the rep's saved Missed-tasks choice", () => {
  const DAY = new Date('2026-08-26T07:00:00Z');
  const d = (hoursAgo: number) => ({
    userId: 'user-1', sessionId: null, toNumber: '+16195550100',
    at: new Date(DAY.getTime() + (12 - hoursAgo) * 3_600_000), connected: false, source: 'manual' as const, skipped: false,
  });
  const rollable = () => fakeDb(callRow({ userId: 'user-1', salesforceWhoId: '00Q1' }));

  it('carries the saved choice (2 business days) onto the job', async () => {
    const rolloverBusinessDays = vi.fn(async () => 2 as const);
    const deps = syncDeps({ db: rollable(), contactHistory: vi.fn(async () => [d(3), d(0)]), orgDayStart: () => DAY, rolloverBusinessDays });
    await syncOne('call-1', deps);
    expect(rolloverBusinessDays).toHaveBeenCalledWith('user-1');
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({ recordId: '00Q1', sessionId: null, businessDays: 2 }));
  });

  it('never reads the saved choice when nothing rolls (a first miss keeps the 2-miss rule)', async () => {
    const rolloverBusinessDays = vi.fn(async () => 1 as const);
    const deps = syncDeps({ db: rollable(), contactHistory: vi.fn(async () => [d(0)]), orgDayStart: () => DAY, rolloverBusinessDays });
    await syncOne('call-1', deps);
    expect(rolloverBusinessDays).not.toHaveBeenCalled();
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });

  it('a failed read fails closed: logged, no rollover, and the sync still succeeds', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = syncDeps({
        db: rollable(), contactHistory: vi.fn(async () => [d(3), d(0)]), orgDayStart: () => DAY,
        rolloverBusinessDays: vi.fn(async () => { throw new Error('pool'); }),
      });
      await expect(syncOne('call-1', deps)).resolves.toBeUndefined();
      expect(deps.enqueueRollover).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(
        '[sf-sync] per-day rollover check failed',
        expect.objectContaining({ callId: 'call-1', err: 'pool' }),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 18: Run them to verify they fail**

Run: `cd services/cti-api && npx vitest run src/dialer/contact-history.test.ts src/salesforce/followup-enqueue.test.ts src/dialer/engine.test.ts src/salesforce/sync.test.ts`
Expected: FAIL.
- contact-history: the Once cases fail with `expected false to be true`, and `CLICK_TO_DIAL_ROLLOVER_MISSES` is `undefined`.
- followup-enqueue: `rolloverJobInsert is not a function`.
- engine: the Once rows requeue when they shouldn't and never roll, and the `businessDays` expectation is not met.
- sync: the enqueue has no `businessDays`, and the saved choice is never read.

- [ ] **Step 19: Implement the threshold**. In `services/cti-api/src/dialer/contact-history.ts`, replace

```ts
import { DAILY_CAP_WINDOW_MS, DAILY_DIAL_CAP } from '@cti/firewall';
```

with

```ts
import { DAILY_CAP_WINDOW_MS, DAILY_DIAL_CAP } from '@cti/firewall';
import type { DialerPasses } from '@cti/contracts';
```

and replace the whole `rolloverDue` doc comment and function (lines 55–69):

```ts
/**
 * Roll the follow-up forward? The task OWNER has dialed the person at least
 * twice since the org day began, and none of those dials connected. Nobody
 * else's dials count: the task is theirs to work. Runs do not matter: two short
 * runs, a run's retry pass, or a power dial plus a manual call all read alike.
 *
 * A Skip is not a dial for this rule (ruling 2026-09-23): the rep chose not to
 * wait, so it neither counts toward the two nor as a connect. It still counts
 * for `cadenceVerdict` above — the phone rang, which is what that rule cares
 * about.
 */
export function rolloverDue(dials: readonly Dial[], ownerUserId: string, dayStart: Date): boolean {
  const own = dials.filter((d) => d.userId === ownerUserId && d.at.getTime() >= dayStart.getTime() && !d.skipped);
  return own.length >= 2 && own.every((d) => !d.connected);
}
```

with

```ts
/** Click-to-dial's threshold: "Calls per person" is a power-dial setting only
 *  (spec 2026-09-28 §4), so a manual miss keeps the owner's-2nd rule. */
export const CLICK_TO_DIAL_ROLLOVER_MISSES = 2;

/**
 * Roll the follow-up forward? The task OWNER has dialed the person at least
 * `requiredMisses` times since the org day began, and none of those dials
 * connected. `requiredMisses` is the power-dial run's Calls per person (Once =
 * 1, Twice = 2 — spec 2026-09-28) for a power-dial miss, and
 * `CLICK_TO_DIAL_ROLLOVER_MISSES` for a manual one. Nobody else's dials count:
 * the task is theirs to work. Runs do not matter: two short runs, a run's retry
 * pass, or a power dial plus a manual call all read alike.
 *
 * A Skip is not a dial for this rule (ruling 2026-09-23): the rep chose not to
 * wait, so it neither counts toward the threshold nor as a connect. It still
 * counts for `cadenceVerdict` above — the phone rang, which is what that rule
 * cares about.
 */
export function rolloverDue(dials: readonly Dial[], ownerUserId: string, dayStart: Date, requiredMisses: DialerPasses): boolean {
  const own = dials.filter((d) => d.userId === ownerUserId && d.at.getTime() >= dayStart.getTime() && !d.skipped);
  return own.length >= requiredMisses && own.every((d) => !d.connected);
}
```

- [ ] **Step 20: Implement the engine's miss path**. In `services/cti-api/src/dialer/engine.ts`:

Replace

```ts
import type { DialOutcome } from './outcome.js';
```

with

```ts
import type { DialOutcome } from './outcome.js';
import type { DialerRunSettings, RolloverBusinessDays } from '@cti/contracts';
import { claimReadySessionQuery, runSizeCutoff, saveRunDefaultsQuery, trimQueueQuery } from './run-settings.js';
```

(Part E uses `DialerRunSettings` and the three run-settings builders. They're imported now so this file only changes its imports once. `tsc` doesn't flag unused imports in this repo, because `noUnusedLocals` is off.)

In `RolloverEnqueue`, replace

```ts
  sourceTaskId: string | null;
}
```

with

```ts
  sourceTaskId: string | null;
  /** Missed tasks move to (spec 2026-09-28): the copy starts at the 1st or 2nd
   *  business day after the landing base — the run's setting for power dial,
   *  the rep's saved choice for click-to-dial. Captured here so the worker
   *  needs no session lookup. */
  businessDays: RolloverBusinessDays;
}
```

Replace these comment lines (inside `handleDialOutcome`)

```ts
  // Two independent questions, decided before the transaction:
  //  - requeue: first miss in a LIVE run (active/paused) → an attempt-2 row at
  //    the END of the run (5-minute floor) dialing the record's OTHER number
  //    when it has one; the same number again when it has only one (legacy
  //    pre-0024 rows with no pair retry whatever they were last dialing).
  //  - rollover: the rule is per DAY, per OWNER, not per run. This rep has now
  //    dialed the person twice today (any run, any source — the row for THIS
  //    dial is already on the log, written at originate) and never connected
  //    → the follow-up rolls. Whether the run is live or stopped is
  //    irrelevant: a rep who stops after one pass and dials the person again
  //    three hours later rolls it then. One dial in a day leaves it open.
```

with

```ts
  // Two independent questions, decided before the transaction. Both follow the
  // run's Calls per person (`session.passes`, spec 2026-09-28): Twice (2, the
  // default) is exactly the rule below; Once (1) has no end-of-run retry and
  // rolls on the owner's FIRST non-connect of the day.
  //  - requeue: a miss before the run's last pass, in a LIVE run
  //    (active/paused) → an attempt-2 row at the END of the run (5-minute
  //    floor) dialing the record's OTHER number when it has one; the same
  //    number again when it has only one (legacy pre-0024 rows with no pair
  //    retry whatever they were last dialing).
  //  - rollover: the rule is per DAY, per OWNER, not per run. This rep has now
  //    dialed the person `session.passes` times today (any run, any source —
  //    the row for THIS dial is already on the log, written at originate) and
  //    never connected → the follow-up rolls. Whether the run is live or
  //    stopped is irrelevant: a rep who stops after one pass and dials the
  //    person again three hours later rolls it then.
```

Replace

```ts
  const requeue = attempt < 2 && retryTo != null && sessionLive && item.redialOf == null;
```

with

```ts
  const requeue = attempt < session.passes && retryTo != null && sessionLive && item.redialOf == null;
```

Replace

```ts
    enqueue = today !== null && rolloverDue(today, session.userId, deps.orgDayStart);
```

with

```ts
    enqueue = today !== null && rolloverDue(today, session.userId, deps.orgDayStart, session.passes);
```

Replace

```ts
        recordId: item.recordId, objectType: item.objectType, fromDate: deps.todayIso,
        sourceTaskId: item.taskId ?? null,
      }, tx);
```

with

```ts
        recordId: item.recordId, objectType: item.objectType, fromDate: deps.todayIso,
        sourceTaskId: item.taskId ?? null,
        businessDays: session.rolloverBusinessDays,
      }, tx);
```

- [ ] **Step 21: Implement the enqueue builder**. Replace `services/cti-api/src/salesforce/followup-enqueue.ts` with:

```ts
import type { RolloverEnqueue } from '../dialer/engine.js';
import { getDb, schema } from '@cti/db';

/** The subset of the DB surface `enqueueFollowupRollover` needs — satisfied by
 *  both a plain `getDb()` handle and a `PgTransaction`, so the engine's
 *  miss-path CAS (dialer/engine.ts `handleDialOutcome`) can enqueue the
 *  rollover job INSIDE its transaction instead of after it. */
export type RolloverDb = Pick<ReturnType<typeof getDb>, 'insert'>;

/** The insert itself, returned unawaited so its rendered SQL is pinned
 *  (followup-enqueue.test.ts). A BARE `onConflictDoNothing()` on purpose —
 *  see `enqueueFollowupRollover` for the key it relies on; naming a target is
 *  the partial-index trap (42P10) the house rules forbid. */
export function rolloverJobInsert(db: RolloverDb, job: RolloverEnqueue) {
  return db.insert(schema.followupRolloverJobs).values({ ...job, status: 'pending' }).onConflictDoNothing();
}

/** Idempotent: a duplicated webhook's second enqueue is a no-op — the conflict
 *  is on `followup_rollover_unique`, UNIQUE(user_id, record_id, from_date).
 *  That key is also the product rule: ONE rollover per person per day. On a Task
 *  run two follow-up tasks for the SAME person both miss and both call this, and
 *  this single INSERT ... ON CONFLICT DO NOTHING collapses them into ONE job —
 *  the FIRST miss's `sourceTaskId` (and `businessDays`) wins and names the
 *  template the copy is made from. That is intended, not a dropped write: the
 *  worker completes EVERY same-day follow-up on that person and creates exactly
 *  one copy, so the rep gets one item instead of a pile.
 *
 *  Runs INSIDE the engine's row-locked transaction (dialer/engine.ts
 *  `handleDialOutcome`), so this MUST stay a single local INSERT — no network
 *  I/O, no retries, no extra queries; anything slower here stalls the rep's
 *  dialing run. */
export async function enqueueFollowupRollover(db: RolloverDb, job: RolloverEnqueue): Promise<void> {
  await rolloverJobInsert(db, job);
}
```

- [ ] **Step 22: Implement click-to-dial**. In `services/cti-api/src/salesforce/sync.ts`:

Replace

```ts
import { rolloverDue, type Dial, type Person } from '../dialer/contact-history.js';
```

with

```ts
import type { RolloverBusinessDays } from '@cti/contracts';
import { CLICK_TO_DIAL_ROLLOVER_MISSES, rolloverDue, type Dial, type Person } from '../dialer/contact-history.js';
import { savedRolloverBusinessDays } from '../dialer/run-settings.js';
```

In `SyncOneDeps`, replace

```ts
  enqueueRollover: (job: RolloverEnqueue) => Promise<void>;
}
```

with

```ts
  enqueueRollover: (job: RolloverEnqueue) => Promise<void>;
  /** The rep's saved "Missed tasks move to" (1 or 2 business days, spec
   *  2026-09-28 §4) — where a click-to-dial rollover lands. Read only when a
   *  rollover is actually due. */
  rolloverBusinessDays: (userId: string) => Promise<RolloverBusinessDays>;
}
```

In `liveSyncOneDeps`, replace

```ts
    enqueueRollover: (job) => enqueueFollowupRollover(db, job),
  };
```

with

```ts
    enqueueRollover: (job) => enqueueFollowupRollover(db, job),
    rolloverBusinessDays: (userId) => savedRolloverBusinessDays(db, userId),
  };
```

Replace the rollover hook block

```ts
  // The per-day rollover counts THIS call too (spec §2.3): the task owner's
  // second dial of the day to the person, from any run or a manual call,
  // rolls the follow-up when it misses. Best effort — a failure here is a
  // task that stays open, which the rep can see; it must never fail the sync.
  if (call.direction === 'outbound' && call.disposition !== 'Connected' && (whoId || whatId)) {
    try {
      const person: Person = { numbers: [call.normalizedToNumber], recordId: whoId ?? whatId ?? null };
      const dayStart = deps.orgDayStart();
      const own = await deps.contactHistory(call.orgId, person, dayStart);
      if (rolloverDue(own, call.userId, dayStart)) {
        await deps.enqueueRollover({
          orgId: call.orgId,
          userId: call.userId,
          sfOwnerId: await deps.salesforceUserId(call.userId),
          sessionId: null,
          recordId: whoId ?? whatId!,
          objectType: objectTypeForId(whoId ?? whatId!),
          fromDate: orgTodayIso(dayStart),
          sourceTaskId: null,
        });
      }
```

with

```ts
  // The per-day rollover counts THIS call too (spec §2.3): the task owner's
  // second dial of the day to the person, from any run or a manual call,
  // rolls the follow-up when it misses. Click-to-dial keeps that 2-miss rule
  // — "Calls per person" is a power-dial setting only — but lands where the
  // rep's saved "Missed tasks move to" says (spec 2026-09-28 §4). Best
  // effort — a failure here is a task that stays open, which the rep can see;
  // it must never fail the sync.
  if (call.direction === 'outbound' && call.disposition !== 'Connected' && (whoId || whatId)) {
    try {
      const person: Person = { numbers: [call.normalizedToNumber], recordId: whoId ?? whatId ?? null };
      const dayStart = deps.orgDayStart();
      const own = await deps.contactHistory(call.orgId, person, dayStart);
      if (rolloverDue(own, call.userId, dayStart, CLICK_TO_DIAL_ROLLOVER_MISSES)) {
        await deps.enqueueRollover({
          orgId: call.orgId,
          userId: call.userId,
          sfOwnerId: await deps.salesforceUserId(call.userId),
          sessionId: null,
          recordId: whoId ?? whatId!,
          objectType: objectTypeForId(whoId ?? whatId!),
          fromDate: orgTodayIso(dayStart),
          sourceTaskId: null,
          businessDays: await deps.rolloverBusinessDays(call.userId),
        });
      }
```

- [ ] **Step 23: Run them to verify they pass, and typecheck**

Run: `cd services/cti-api && npx vitest run src/dialer/contact-history.test.ts src/salesforce/followup-enqueue.test.ts src/dialer/engine.test.ts src/salesforce/sync.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: all four files PASS, including every existing test in them, and `tsc` prints nothing and exits 0.

- [ ] **Step 24: Commit**

```bash
git add services/cti-api/src/dialer/contact-history.ts services/cti-api/src/dialer/contact-history.test.ts services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts services/cti-api/src/salesforce/followup-enqueue.ts services/cti-api/src/salesforce/followup-enqueue.test.ts services/cti-api/src/salesforce/sync.ts services/cti-api/src/salesforce/sync.test.ts
git commit -m "$(cat <<'EOF'
feat(dialer): a miss follows the run's calls-per-person; jobs carry business days

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

#### Part E — Start applies the settings inside the claim

- [ ] **Step 25: Write the failing tests** in `services/cti-api/src/dialer/engine.test.ts`.

**(a)** Teach the fake the claim transaction. After

```ts
  const txWrites: Array<{ patch: Record<string, unknown>; where: unknown }> = [];
```

add

```ts
  // Deletes made through `tx.delete(...)` — the run-size trim inside the Start
  // claim (run-settings.ts) — with the `where` they were guarded by.
  const txDeletes: Array<{ table: unknown; where: unknown }> = [];
```

After

```ts
    _txWrites: txWrites,
```

add

```ts
    _txDeletes: txDeletes,
```

In the fake `transaction`'s `tx` object, directly before

```ts
        update(_tbl: unknown) {
          return {
            set: (patch: any) => ({
              where: (w?: any) => {
```

add

```ts
        delete(_tbl: unknown) {
          return { where: async (w: unknown) => { txDeletes.push({ table: _tbl, where: w }); } };
        },
```

and in that same `tx.update`, replace

```ts
                  returning: async () => {
                    if (_tbl !== schema.dialerSessions) {
                      if (!claimReturnsRows) return [];
```

with

```ts
                  returning: async () => {
                    if (_tbl === schema.dialerSessions && w) {
                      // startSession's ready → active claim runs in a transaction
                      // now (the run settings ride with it — run-settings.ts).
                      // Honor its `status = 'ready'` guard against the CURRENT
                      // session exactly as the outer fake does, and hand back the
                      // user id the claim returns. takeCallback's pause guard
                      // renders as `status in (...)`, which this does not match.
                      const { sql: text, params } = new PgDialect().sqlToQuery(w);
                      const current = { ...session, ...sessionOverride };
                      if (/"status" = /.test(text) && (!params.includes(current.id) || !params.includes(current.status))) return [];
                      apply();
                      return [{ id: current.id, userId: current.userId }];
                    }
                    if (_tbl !== schema.dialerSessions) {
                      if (!claimReturnsRows) return [];
```

**(b)** The refused-flip tests now refuse the claim *transaction*. In `describe('startSession — the rep pressed Start dialing')`, replace both occurrences (a replace-all edit) of

```ts
    fdb.update = () => ({ set: () => ({ where: () => ({ returning: async () => { throw violation; } }) }) });
```

with

```ts
    fdb.transaction = async () => { throw violation; };
```

and replace

```ts
    fdb.update = () => ({ set: () => ({ where: () => ({ returning: async () => { throw new Error('connection reset'); } }) }) });
```

with

```ts
    fdb.transaction = async () => { throw new Error('connection reset'); };
```

**(c)** Append to the end of the file:

```ts
describe('startSession — run settings ride the ready → active claim', () => {
  beforeEach(() => { _target = {}; });
  const ready = { ...baseSession, status: 'ready' };
  const row = (ordinal: number, status: string) => ({
    id: `i${ordinal}`, ordinal, status, toNumber: status === 'unreachable' ? null : `+1619555010${ordinal}`,
    recordId: `00Q${ordinal}`, objectType: 'Lead', callId: null, attempt: 1,
  });
  // Pending (dialable) ordinals: 1, 3, 4, 6. Settled at build: 0, 2, 5.
  const queue = () => [row(0, 'skipped'), row(1, 'pending'), row(2, 'unreachable'), row(3, 'pending'), row(4, 'pending'), row(5, 'skipped'), row(6, 'pending')];
  const rendered = (w: unknown) => {
    const { sql, params } = new PgDialect().sqlToQuery(w as SQL);
    return { sql, params };
  };
  const once2: DialerRunSettings = { passes: 1, maxRecords: 2, rolloverBusinessDays: 2 };

  it('writes the settings onto the session in the SAME guarded update that flips it active', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, queue()); deps.db = fdb;
    expect(await startSession('S1', deps, { passes: 1, maxRecords: null, rolloverBusinessDays: 2 })).toMatchObject({ action: 'dialing' });
    expect(fdb._txWrites[0].patch).toEqual(expect.objectContaining({ status: 'active', passes: 1, maxRecords: null, rolloverBusinessDays: 2 }));
    expect(rendered(fdb._txWrites[0].where)).toEqual({
      sql: '("dialer_sessions"."id" = $1 and "dialer_sessions"."status" = $2)', params: ['S1', 'ready'],
    });
  });

  it("saves Calls per person and Missed tasks as the rep's next defaults — How many is never saved", async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, queue()); deps.db = fdb;
    await startSession('S1', deps, once2);
    const saved = fdb._txWrites.filter((w: any) => 'dialerPasses' in w.patch);
    expect(saved).toHaveLength(1);
    expect(saved[0].patch).toEqual({ dialerPasses: 1, dialerRolloverBusinessDays: 2 });
    expect(rendered(saved[0].where)).toEqual({ sql: '"users"."id" = $1', params: ['U1'] });
  });

  it('trims the queue after the N-th DIALABLE row: settled rows before it stay, every row after it goes', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, queue()); deps.db = fdb;
    await startSession('S1', deps, once2);
    // The run's rows were read INSIDE the claim transaction, scoped to this run.
    const read = fdb._txQueryReads.find((r: any) => r.table === 'dialerQueueItems');
    expect(rendered(read.where)).toEqual({ sql: '"dialer_queue_items"."session_id" = $1', params: ['S1'] });
    // Pending ordinals 1, 3, 4, 6 → the 2nd is ordinal 3: keep 0–3, delete 4–6.
    expect(fdb._txDeletes).toHaveLength(1);
    expect(fdb._txDeletes[0].table).toBe(schema.dialerQueueItems);
    expect(rendered(fdb._txDeletes[0].where)).toEqual({
      sql: '("dialer_queue_items"."session_id" = $1 and "dialer_queue_items"."ordinal" > $2)', params: ['S1', 3],
    });
  });

  it.each([null, 4, 50])('maxRecords %s keeps every row — All, or no more dialable rows than asked for', async (maxRecords) => {
    const deps = makeDeps(); const fdb = fakeDb(ready, queue()); deps.db = fdb;
    await startSession('S1', deps, { passes: 2, maxRecords, rolloverBusinessDays: 1 });
    expect(fdb._txDeletes).toEqual([]);
  });

  it('ORDER: flip → trim → save defaults inside ONE transaction, and only then the first call', async () => {
    const order: string[] = [];
    const deps = makeDeps(); const fdb = fakeDb(ready, queue()); deps.db = fdb;
    const realTx = fdb.transaction.bind(fdb);
    let txn = 0;
    fdb.transaction = async (fn: any) => realTx(async (tx: any) => {
      const n = ++txn;
      const realUpdate = tx.update.bind(tx); const realDelete = tx.delete.bind(tx);
      tx.update = (tbl: any) => {
        order.push(`tx${n}:update:${tbl === schema.users ? 'users' : tbl === schema.dialerSessions ? 'sessions' : 'items'}`);
        return realUpdate(tbl);
      };
      tx.delete = (tbl: any) => { order.push(`tx${n}:delete`); return realDelete(tbl); };
      return fn(tx);
    });
    (deps.telephony.originate as any).mockImplementation(async () => { order.push('originate'); return { callId: 'CA1' }; });
    await startSession('S1', deps, once2);
    expect(order.slice(0, 3)).toEqual(['tx1:update:sessions', 'tx1:delete', 'tx1:update:users']);
    expect(order.indexOf('originate')).toBeGreaterThan(2);
  });

  it('a second Start on a run already going changes nothing: no settings, no trim, no saved defaults', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [{ ...row(1, 'dialing'), callId: 'CA1' }]); deps.db = fdb;
    expect(await startSession('S1', deps, once2)).toEqual({ action: 'waiting' });
    expect(fdb._writes).toEqual([]);
    expect(fdb._txDeletes).toEqual([]);
  });

  it("a Start with no settings (a tab from before this release) flips the status only — today's run, nothing saved", async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, queue()); deps.db = fdb;
    await startSession('S1', deps);
    expect(fdb._txWrites[0].patch).toEqual({ status: 'active', updatedAt: expect.any(Date) });
    expect(fdb._txWrites.some((w: any) => 'dialerPasses' in w.patch)).toBe(false);
    expect(fdb._txDeletes).toEqual([]);
    expect(fdb._txQueryReads.filter((r: any) => r.table === 'dialerQueueItems')).toEqual([]);
  });
});
```

- [ ] **Step 26: Run it to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/engine.test.ts`
Expected: FAIL.
- The new describe fails: the flip still goes through the outer `update`, so `_txWrites[0]` is undefined or the item claim, and nothing is trimmed or saved.
- The two `conflict` tests fail too: the flip still goes through the outer `update`, so the throwing `transaction` is only hit later, by `advanceSession`'s claim, and it surfaces as a rejection. The "rethrows any other database error" test already passes, and keeps passing.

- [ ] **Step 27: Implement**. In `services/cti-api/src/dialer/engine.ts`, replace `claimReadySession` and its doc comment:

```ts
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
```

with

```ts
/**
 * The `ready → active` compare-and-swap and — in the SAME transaction — the
 * run's settings (spec 2026-09-28): written onto the session by the flip's own
 * UPDATE, the already-built queue cut to the run size (`runSizeCutoff`), and
 * the rep's Calls per person / Missed tasks saved as their next defaults.
 *
 * 'lost' = 0 rows matched (the session is not ready — a second Start, or a
 * stopped run): nothing else is written, so a second Start never re-trims or
 * changes a live run's settings. 'conflict' = the rep has another active run
 * and the unique index refused the flip: the transaction rolls back whole, so
 * the queue and the saved defaults are untouched and the rep can press Start
 * again with other choices. `settings` null (a tab from before run settings)
 * flips the status only — the columns keep their defaults, today's run.
 *
 * A ready session has nothing in flight and no dial attempts, so the rows past
 * the cutoff are only queue — never a call, never a dial on anyone's log. The
 * rows are read through `tx.query`, never `deps.db.query`: a second pool
 * checkout while the transaction holds one is the deadlock every `tx` handle
 * in this file exists to avoid.
 */
async function claimReadySession(
  deps: EngineDeps,
  sessionId: string,
  settings: DialerRunSettings | null,
): Promise<'claimed' | 'lost' | 'conflict'> {
  try {
    return await deps.db.transaction(async (tx) => {
      const [claimed] = await claimReadySessionQuery(tx, sessionId, settings, new Date());
      if (!claimed) return 'lost' as const;
      if (settings) {
        if (settings.maxRecords !== null) {
          const items = await tx.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, sessionId) });
          const cutoff = runSizeCutoff(items, settings.maxRecords);
          if (cutoff !== null) await trimQueueQuery(tx, sessionId, cutoff);
        }
        await saveRunDefaultsQuery(tx, claimed.userId, settings);
      }
      return 'claimed' as const;
    });
  } catch (err) {
    if (isActiveSessionConflict(err)) return 'conflict';
    throw err;
  }
}
```

In `startSession`'s doc comment, replace

```ts
 * see `pausedRunWithDialInFlight`.
 */
export async function startSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<Awaited<ReturnType<typeof advanceSession>> | { action: Session['status'] | 'idle' } | { action: 'conflict'; activeSessionId: string | null }> {
```

with

```ts
 * see `pausedRunWithDialInFlight`.
 *
 * `settings` are the rep's Ready-to-dial choices (spec 2026-09-28). They ride
 * the flip itself — see `claimReadySession` — so they are on the session
 * before the first originate, and only a Start that actually flips the run
 * applies them.
 */
export async function startSession(
  sessionId: string,
  deps: EngineDeps,
  settings: DialerRunSettings | null = null,
): Promise<Awaited<ReturnType<typeof advanceSession>> | { action: Session['status'] | 'idle' } | { action: 'conflict'; activeSessionId: string | null }> {
```

and replace

```ts
  const claim = await claimReadySession(deps, sessionId);
```

with

```ts
  const claim = await claimReadySession(deps, sessionId, settings);
```

- [ ] **Step 28: Run it to verify it passes, and typecheck**

Run: `cd services/cti-api && npx vitest run src/dialer/engine.test.ts src/dialer/run-settings.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS for both files. That covers every existing startSession test, including the three refused-flip tests, and the new describe. `tsc` exits 0.

- [ ] **Step 29: Commit**

```bash
git add services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts
git commit -m "$(cat <<'EOF'
feat(dialer): Start applies run settings inside the ready→active claim

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

#### Part F — where a rolled task lands

- [ ] **Step 30: Write the failing tests**

**(a)** Replace `services/cti-api/src/salesforce/followup-day.test.ts` with:

```ts
import { describe, expect, it, vi } from 'vitest';
import { firstLandingDay, followUpTasksSoql, pickRolloverDay, rolloverBase } from './followup-day.js';

const weekdays = new Set([1, 2, 3, 4, 5]);
const none = new Set<string>();
// 2026-08-20 is a Thursday, 2026-08-21 a Friday; 2026-09-27 a Sunday.
describe('pickRolloverDay', () => {
  it('takes the next business day when it has room', async () => {
    const countOn = vi.fn(async () => 30);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-21');
    expect(countOn).toHaveBeenCalledWith('2026-08-21');
  });
  it('skips a full day and lands on the following business day (weekend skipped)', async () => {
    const counts: Record<string, number> = { '2026-08-21': 100, '2026-08-24': 70 };
    const countOn = vi.fn(async (d: string) => counts[d] ?? 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
  });
  it('treats exactly-at-cap as full', async () => {
    const countOn = vi.fn(async (d: string) => (d === '2026-08-21' ? 100 : 0));
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
  });
  it('skips holidays', async () => {
    const countOn = vi.fn(async () => 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: new Set(['2026-08-21']), countOn })).resolves.toBe('2026-08-24');
  });
  it('returns null when every day within the bound is full', async () => {
    const countOn = vi.fn(async () => 999);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 1, cap: 100, workingWeekdays: weekdays, holidays: none, countOn, maxBusinessDays: 3 })).resolves.toBeNull();
    expect(countOn).toHaveBeenCalledTimes(3);
  });
  it('in 2 business days starts at the SECOND business day, over the weekend', async () => {
    const countOn = vi.fn(async () => 0);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 2, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-24');
    expect(countOn).toHaveBeenCalledTimes(1);
    expect(countOn).toHaveBeenCalledWith('2026-08-24');
  });
  it('in 2 business days: a full start day still pushes on one business day at a time (the cap loop is unchanged)', async () => {
    const countOn = vi.fn(async (d: string) => (d === '2026-08-24' ? 100 : 0));
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 2, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBe('2026-08-25');
  });
  it('the 30-business-day bound counts candidates from the start day, whatever businessDays is', async () => {
    const countOn = vi.fn(async (_d: string) => 999);
    await expect(pickRolloverDay({ fromDate: '2026-08-20', businessDays: 2, cap: 100, workingWeekdays: weekdays, holidays: none, countOn })).resolves.toBeNull();
    expect(countOn).toHaveBeenCalledTimes(30);
    expect(countOn.mock.calls[0]![0]).toBe('2026-08-24');
  });
});

describe("rolloverBase — the later of the dial day and the task's own due date", () => {
  it('due in the future: the due date', () => {
    expect(rolloverBase('2026-09-27', '2026-09-28')).toBe('2026-09-28');
  });
  it('due today: the dial day', () => {
    expect(rolloverBase('2026-09-28', '2026-09-28')).toBe('2026-09-28');
  });
  it('overdue: the dial day', () => {
    expect(rolloverBase('2026-09-28', '2026-09-14')).toBe('2026-09-28');
  });
  it('no due date: the dial day', () => {
    expect(rolloverBase('2026-09-28', null)).toBe('2026-09-28');
    expect(rolloverBase('2026-09-28', undefined)).toBe('2026-09-28');
  });
  it('a due date in a shape we do not recognise: the dial day', () => {
    expect(rolloverBase('2026-09-28', '9/30/2026')).toBe('2026-09-28');
    expect(rolloverBase('2026-09-28', '2026-09-30T00:00:00Z')).toBe('2026-09-28');
  });
});

describe('firstLandingDay', () => {
  it('1 is exactly the next business day', () => {
    expect(firstLandingDay('2026-08-21', 1, weekdays, none)).toBe('2026-08-24');
  });
  it('2 is the business day after that', () => {
    expect(firstLandingDay('2026-08-21', 2, weekdays, none)).toBe('2026-08-25');
  });
  it('skips a holiday on the way', () => {
    expect(firstLandingDay('2026-08-20', 2, weekdays, new Set(['2026-08-21']))).toBe('2026-08-25');
  });
  it("Garrett's Sunday: a Monday task dialed on Sunday lands Tuesday (1) or Wednesday (2) — never back on Monday", () => {
    const base = rolloverBase('2026-09-27', '2026-09-28');
    expect(firstLandingDay(base, 1, weekdays, none)).toBe('2026-09-29');
    expect(firstLandingDay(base, 2, weekdays, none)).toBe('2026-09-30');
  });
});

describe('followUpTasksSoql', () => {
  it('can omit CTI_Origin__c, for a rep who cannot read it', () => {
    expect(followUpTasksSoql('005ABC', '2026-08-21', false)).toMatch(/^SELECT Id, Subject FROM Task WHERE /);
  });

  it('fetches the owner\'s OPEN tasks due that day (subjects are matched in code — SOQL cannot express the FU rule)', () => {
    const q = followUpTasksSoql('005ABC', '2026-08-21');
    // CTI_Origin__c is what the cap counts now that every dialed task rolls —
    // subject no longer identifies the dialer's own output.
    expect(q).toMatch(/^SELECT Id, Subject, CTI_Origin__c FROM Task WHERE /);
    expect(q).toContain("OwnerId = '005ABC'"); expect(q).toContain('IsClosed = false'); expect(q).toContain('ActivityDate = 2026-08-21');
    expect(q).toMatch(/LIMIT 500$/); expect(q).not.toMatch(/LIKE/);
  });
  it('escapes the owner id', () => {
    expect(followUpTasksSoql("005'x", '2026-08-21')).toContain("OwnerId = '005\\'x'");
  });
});
```

**(b)** In `services/cti-api/src/salesforce/followup-worker.test.ts`, in `job()`, replace

```ts
    completedAt: null, completedTaskId: null, completedTaskIds: null, createdTaskId: null, targetDate: null, sourceTaskId: null, createdAt: new Date(), updatedAt: new Date(),
```

with

```ts
    completedAt: null, completedTaskId: null, completedTaskIds: null, createdTaskId: null, targetDate: null, sourceTaskId: null, businessDays: 1, createdAt: new Date(), updatedAt: new Date(),
```

and append to the end of the file:

```ts
// ---------------------------------------------------------------------------
// Where the copy lands (spec 2026-09-28 §5): `business_days` business days
// after the LATER of the dial day (the job's from_date) and the template's own
// due date — read off the task the job already reads, never a second query.
// The fixture's dial day, 2026-08-20, is a Thursday.
// ---------------------------------------------------------------------------
describe('processRolloverJob — where the copy lands', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** Deps whose task reads return ONE open follow-up due `due`; the cap query
   *  says every day in `fullDays` is at the cap and every other day is empty. */
  function dueDeps(due: string | null, fullDays: ReadonlySet<string> = new Set(), over: Partial<WorkerDeps> = {}): WorkerDeps {
    const full = Array.from({ length: 100 }, () => ({ Subject: 'Follow-up', CTI_Origin__c: 'Power Dialer Follow-Up' }));
    return deps({
      sf: {
        ...deps().sf,
        soqlQuery: vi.fn(async (_u: string, q: string) => {
          if (/FROM Task WHERE OwnerId/.test(q)) return [...fullDays].some((day) => q.includes(day)) ? full : [];
          return [{ ...openTask, ActivityDate: due }];
        }) as unknown as WorkerDeps['sf']['soqlQuery'],
      },
      ...over,
    });
  }
  const landed = (d: WorkerDeps): unknown =>
    (d.sf.sfFetch as any).mock.calls.find((c: any[]) => c[2]?.method === 'POST')[2].body.ActivityDate;

  it.each([
    ["due today, next business day (today's run)", '2026-08-20', 1, '2026-08-21'],
    ['due today, in 2 business days (over the weekend)', '2026-08-20', 2, '2026-08-24'],
    ["overdue, next business day — counted from the dial day (today's run)", '2026-08-11', 1, '2026-08-21'],
    ['overdue, in 2 business days', '2026-08-11', 2, '2026-08-24'],
    ['due in the future (Mon), next business day → the day AFTER its due date', '2026-08-24', 1, '2026-08-25'],
    ['due in the future (Mon), in 2 business days', '2026-08-24', 2, '2026-08-26'],
    ['no due date → counted from the dial day', null, 1, '2026-08-21'],
  ] as const)('%s', async (_label, due, businessDays, expected) => {
    const d = dueDeps(due);
    await processRolloverJob(job({ businessDays }), d);
    expect(landed(d)).toBe(expected);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ targetDate: expected, nextDay: expected }) });
  });

  it("Garrett's Sunday: a Monday task dialed on Sunday lands Tuesday (next) or Wednesday (in 2) — never back on Monday", async () => {
    for (const [businessDays, expected] of [[1, '2026-09-29'], [2, '2026-09-30']] as const) {
      const d = dueDeps('2026-09-28');
      await processRolloverJob(job({ fromDate: '2026-09-27', businessDays }), d);
      expect(landed(d)).toBe(expected);
    }
  });

  it('skips a holiday on the way (Thu dial, Fri holiday, 2 business days → Tue)', async () => {
    const d = dueDeps('2026-08-20', new Set(), {
      calendarFor: vi.fn(async () => ({ workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set(['2026-08-21']) })),
    });
    await processRolloverJob(job({ businessDays: 2 }), d);
    expect(landed(d)).toBe('2026-08-25');
  });

  it('the daily cap still pushes it on from the new start day, and nextDay stays the uncapped day (so the summary reads "pushed")', async () => {
    const d = dueDeps('2026-08-24', new Set(['2026-08-25']));
    await processRolloverJob(job({ businessDays: 1 }), d);
    expect(landed(d)).toBe('2026-08-26');
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ targetDate: '2026-08-26', nextDay: '2026-08-25' }) });
  });

  it('a Task run reads the due date off the task it dialed — no extra Salesforce query', async () => {
    const d = dueDeps('2026-08-24');
    await processRolloverJob(job({ sourceTaskId: '00T1', businessDays: 1 }), d);
    expect(landed(d)).toBe('2026-08-25');
    // The by-id read plus the sibling listing — exactly what a Task-run job read before.
    const taskReads = (d.sf.soqlQuery as any).mock.calls.filter((c: any[]) => !/FROM Task WHERE OwnerId/.test(c[1]));
    expect(taskReads).toHaveLength(2);
  });
});
```

- [ ] **Step 31: Run them to verify they fail**

Run: `cd services/cti-api && npx vitest run src/salesforce/followup-day.test.ts src/salesforce/followup-worker.test.ts`
Expected: FAIL. `rolloverBase` and `firstLandingDay` are not functions. The 2-business-day and future-due worker rows land on the next business day after the dial day.

- [ ] **Step 32: Implement the landing day**. Replace `services/cti-api/src/salesforce/followup-day.ts` with:

```ts
/**
 * Which business day a rolled-over task lands on (spec 2026-09-28 §5): the
 * `businessDays`-th business day after `fromDate`, or the first business day
 * after that where the rep has fewer than `cap` open tasks due. `fromDate` is
 * the LANDING BASE — the later of the dial day and the task's own due date
 * (`rolloverBase`) — not simply the dial day. Pure apart from the injected
 * `countOn` (a live Salesforce read — the source of truth, so hand-created
 * tasks count too).
 */
import type { RolloverBusinessDays } from '@cti/contracts';
import { nextBusinessDay } from '../dialer/next-business-day.js';
import { soqlEscape } from './client.js';

export const FOLLOWUP_DAILY_CAP_DEFAULT = 100;
export const MAX_ROLLOVER_BUSINESS_DAYS = 30;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day a rolled task's landing is counted from: the LATER of the dial day
 * (the LA calendar date of the miss — the job's `from_date`) and the task's own
 * due date. A task worked AHEAD of its due date must not "roll" onto the date
 * it already had (Garrett, 2026-09-27: Monday tasks dialed on Sunday went
 * Monday → Monday). A task with no due date, or one Salesforce sent in a shape
 * we do not recognise, counts from the dial day — today's rule. YYYY-MM-DD
 * strings compare correctly as text.
 */
export function rolloverBase(dialDay: string, dueDate: string | null | undefined): string {
  if (!dueDate || !ISO_DAY.test(dueDate)) return dialDay;
  return dueDate > dialDay ? dueDate : dialDay;
}

/** The `businessDays`-th business day strictly after `fromDate` — where the
 *  copy lands when the cap has room. With 1 it is exactly `nextBusinessDay`. */
export function firstLandingDay(
  fromDate: string,
  businessDays: RolloverBusinessDays,
  workingWeekdays: ReadonlySet<number>,
  holidays: ReadonlySet<string>,
): string {
  let day = fromDate;
  for (let i = 0; i < businessDays; i++) day = nextBusinessDay(day, workingWeekdays, holidays);
  return day;
}

/** The owner's OPEN tasks due `isoDate`; subjects are matched in code (`countFollowUps`). Bounded: >500 on one day is over any cap. */
export function followUpTasksSoql(sfOwnerId: string, isoDate: string, withCtiOrigin = true): string {
  const origin = withCtiOrigin ? ', CTI_Origin__c' : '';
  return `SELECT Id, Subject${origin} FROM Task WHERE OwnerId = '${soqlEscape(sfOwnerId)}' AND IsClosed = false AND ActivityDate = ${isoDate} LIMIT 500`;
}

/** The cap loop is unchanged: it scans at most `maxBusinessDays` (30) candidate
 *  days, starting at `firstLandingDay` instead of the next business day. */
export async function pickRolloverDay(opts: {
  fromDate: string;
  businessDays: RolloverBusinessDays;
  cap: number;
  workingWeekdays: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  countOn: (isoDate: string) => Promise<number>;
  maxBusinessDays?: number;
}): Promise<string | null> {
  const max = opts.maxBusinessDays ?? MAX_ROLLOVER_BUSINESS_DAYS;
  let candidate = firstLandingDay(opts.fromDate, opts.businessDays, opts.workingWeekdays, opts.holidays);
  for (let i = 0; i < max; i++) {
    const n = await opts.countOn(candidate);
    if (n < opts.cap) return candidate;
    candidate = nextBusinessDay(candidate, opts.workingWeekdays, opts.holidays);
  }
  return null;
}
```

- [ ] **Step 33: Implement the worker**. In `services/cti-api/src/salesforce/followup-worker.ts`:

Delete the line

```ts
import { nextBusinessDay } from '../dialer/next-business-day.js';
```

Replace

```ts
import { FOLLOWUP_DAILY_CAP_DEFAULT, MAX_ROLLOVER_BUSINESS_DAYS, followUpTasksSoql, pickRolloverDay } from './followup-day.js';
```

with

```ts
import { FOLLOWUP_DAILY_CAP_DEFAULT, MAX_ROLLOVER_BUSINESS_DAYS, firstLandingDay, followUpTasksSoql, pickRolloverDay, rolloverBase } from './followup-day.js';
```

Replace

```ts
    const cap = await deps.capFor(job.orgId);
    // The plain next business day (no cap applied) — stamped alongside the
    // actual target so the session-view summary can tell "moved" from
    // "pushed" without ever calling Salesforce itself.
    const nextDay = nextBusinessDay(job.fromDate, cal.workingWeekdays, cal.holidays);
    const targetDate = await pickRolloverDay({
      fromDate: job.fromDate, cap, workingWeekdays: cal.workingWeekdays, holidays: cal.holidays,
      countOn: (d) => countDayLoad(deps, job, d),
    });
```

with

```ts
    const cap = await deps.capFor(job.orgId);
    // Where the copy may land (spec 2026-09-28 §5): `business_days` (the run's
    // "Missed tasks move to", or the rep's saved choice for click-to-dial)
    // business days after the LATER of the dial day and the template's own due
    // date. The due date comes off the task this job already read — by id on a
    // Task run, by the record search otherwise — never a second query.
    // `nextDay` is that uncapped day, stamped alongside the actual target so
    // the session-view summary can still tell "moved" from "pushed by the cap"
    // without ever calling Salesforce itself.
    const base = rolloverBase(job.fromDate, task.ActivityDate);
    const nextDay = firstLandingDay(base, job.businessDays, cal.workingWeekdays, cal.holidays);
    const targetDate = await pickRolloverDay({
      fromDate: base, businessDays: job.businessDays, cap, workingWeekdays: cal.workingWeekdays, holidays: cal.holidays,
      countOn: (d) => countDayLoad(deps, job, d),
    });
```

(`sameDaySiblings(…, job.fromDate, …)` is deliberately unchanged: the clear set is still "same-day follow-ups on the missed day".)

- [ ] **Step 34: Run them to verify they pass, and typecheck**

Run: `cd services/cti-api && npx vitest run src/salesforce/followup-day.test.ts src/salesforce/followup-worker.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS for both files, every existing worker test included, and `tsc` exits 0.

- [ ] **Step 35: Commit**

```bash
git add services/cti-api/src/salesforce/followup-day.ts services/cti-api/src/salesforce/followup-day.test.ts services/cti-api/src/salesforce/followup-worker.ts services/cti-api/src/salesforce/followup-worker.test.ts
git commit -m "$(cat <<'EOF'
feat(followup): land rolled tasks N business days after the later of dial day and due date

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

#### Part G — the routes: the Start body, the session view, `/auth/me`

- [ ] **Step 36: Write the failing tests**

**(a)** In `services/cti-api/src/routes/dialer.test.ts`, in the hoisted `state`, replace

```ts
  takeCallbackCalls: [] as string[],
}));
```

with

```ts
  takeCallbackCalls: [] as string[],
  startCalls: [] as Array<{ sessionId: string; settings: unknown }>,
}));
```

In the `vi.mock('../dialer/engine.js', …)` factory, replace

```ts
  takeCallback: async (sessionId: string) => {
    state.takeCallbackCalls.push(sessionId);
    return state.takeCallbackResult;
  },
}));
```

with

```ts
  takeCallback: async (sessionId: string) => {
    state.takeCallbackCalls.push(sessionId);
    return state.takeCallbackResult;
  },
  // The Start route's own job is parsing and forwarding the run settings;
  // what the engine does with them is pinned in dialer/engine.test.ts.
  startSession: async (sessionId: string, _deps: unknown, settings: unknown) => {
    state.startCalls.push({ sessionId, settings });
    return { action: 'dialing', itemId: 'i1' };
  },
}));
```

Replace

```ts
import { StartBody, registerDialerRoutes } from './dialer.js';
```

with

```ts
import { RunSettingsBody, StartBody, parseRunSettings, registerDialerRoutes } from './dialer.js';
```

and append to the end of the file:

```ts
// ---------------------------------------------------------------------------
// Run settings (spec docs/superpowers/specs/2026-09-28-run-settings-design.md):
// the Start body, validated at the boundary, and the session view the run line
// reads. The engine side (claim, trim, saved defaults) is pinned in
// dialer/engine.test.ts; this file proves the ROUTE parses and forwards.
// ---------------------------------------------------------------------------
describe('parseRunSettings', () => {
  it("no body is a tab from before run settings: null — today's run, nothing saved", () => {
    expect(parseRunSettings(undefined)).toEqual({ ok: true, settings: null });
    expect(parseRunSettings(null)).toEqual({ ok: true, settings: null });
  });

  it('a full body parses; maxRecords absent or null is the whole list', () => {
    expect(parseRunSettings({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }))
      .toEqual({ ok: true, settings: { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 } });
    expect(parseRunSettings({ passes: 2, rolloverBusinessDays: 1 }))
      .toEqual({ ok: true, settings: { passes: 2, maxRecords: null, rolloverBusinessDays: 1 } });
    expect(parseRunSettings({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 }))
      .toEqual({ ok: true, settings: { passes: 2, maxRecords: null, rolloverBusinessDays: 1 } });
    expect(parseRunSettings({ passes: 2, maxRecords: 500, rolloverBusinessDays: 1 }).ok).toBe(true);
  });

  it.each([
    [{ passes: 3, rolloverBusinessDays: 1 }, 'passes'],
    [{ passes: '1', rolloverBusinessDays: 1 }, 'passes'],
    [{ rolloverBusinessDays: 1 }, 'passes'],
    [{ passes: 2, rolloverBusinessDays: 3 }, 'rolloverBusinessDays'],
    [{ passes: 2 }, 'rolloverBusinessDays'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecords: 0 }, 'maxRecords'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecords: 1.5 }, 'maxRecords'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecords: '100' }, 'maxRecords'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecords: 501 }, 'maxRecords'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecord: 5 }, 'maxRecord'],
    [[1, 2], 'body'],
  ] as const)('%j is refused, naming %s', (body, field) => {
    expect(parseRunSettings(body)).toEqual({ ok: false, field });
  });

  it('RunSettingsBody is strict: an unknown key never starts a run with a default the rep did not pick', () => {
    expect(RunSettingsBody.safeParse({ passes: 1, rolloverBusinessDays: 2, extra: true }).success).toBe(false);
  });
});

describe('POST /dialer/sessions/:id/start — run settings', () => {
  const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
  let app: FastifyInstance;

  beforeEach(async () => {
    state.authedUser = REP;
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'ready' };
    state.startCalls = [];
    app = Fastify();
    await registerDialerRoutes(app);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const start = (payload?: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/dialer/sessions/S1/start', headers: { authorization: 'Bearer t' },
    ...(payload === undefined ? {} : { payload }),
  });

  it('forwards the chosen settings to the engine and answers with its result', async () => {
    const res = await start({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'dialing', itemId: 'i1' });
    expect(state.startCalls).toEqual([{ sessionId: 'S1', settings: { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 } }]);
  });

  it("no body (a tab from before this release) starts today's run: settings null", async () => {
    expect((await start()).statusCode).toBe(200);
    expect(state.startCalls).toEqual([{ sessionId: 'S1', settings: null }]);
  });

  it('a bad value is a 400 naming the field, and nothing starts', async () => {
    const res = await start({ passes: 3, rolloverBusinessDays: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid passes', field: 'passes' });
    expect(state.startCalls).toEqual([]);
  });

  it('a rep without the grant is refused before the body is read (403), and nothing starts', async () => {
    state.authedUser = { ...REP, powerDialerEnabled: false };
    const res = await start({ passes: 3 });
    expect(res.statusCode).toBe(403);
    expect(state.startCalls).toEqual([]);
  });
});

describe('GET /dialer/sessions/:id — run settings', () => {
  const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
  let app: FastifyInstance;

  beforeEach(async () => {
    state.authedUser = REP;
    state.items = [];
    state.jobs = [];
    state.positionRows = [];
    app = Fastify();
    await registerDialerRoutes(app);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it('exposes passes, maxRecords and rolloverBusinessDays on the session — what the run line reads', async () => {
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null, passes: 1, maxRecords: 100, rolloverBusinessDays: 2 };
    const res = await app.inject({ method: 'GET', url: '/dialer/sessions/S1', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().session).toMatchObject({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 });
  });
});
```

**(b)** In `services/cti-api/src/routes/auth-me.test.ts`, replace

```ts
    dialerYoutubeListId: string | null;
    dialerYoutubeVideoId: string | null;
  } | null,
```

with

```ts
    dialerYoutubeListId: string | null;
    dialerYoutubeVideoId: string | null;
    dialerPasses?: number;
    dialerRolloverBusinessDays?: number;
  } | null,
```

and append to the end of the file:

```ts
describe('GET /auth/me — Power Dial run defaults (spec 2026-09-28)', () => {
  it('returns the saved Calls per person and Missed tasks choices as dialerRunDefaults', async () => {
    state.userRow = { ...state.userRow!, dialerPasses: 1, dialerRolloverBusinessDays: 2 };
    const me = (await app.inject({ method: 'GET', url: '/auth/me' })).json();
    expect(me.user.dialerRunDefaults).toEqual({ passes: 1, rolloverBusinessDays: 2 });
  });

  it("a missing profile row is today's run: Twice, next business day", async () => {
    state.userRow = null;
    const me = (await app.inject({ method: 'GET', url: '/auth/me' })).json();
    expect(me.user.dialerRunDefaults).toEqual({ passes: 2, rolloverBusinessDays: 1 });
  });
});
```

- [ ] **Step 37: Run them to verify they fail**

Run: `cd services/cti-api && npx vitest run src/routes/dialer.test.ts src/routes/auth-me.test.ts`
Expected: FAIL.
- `parseRunSettings is not a function`, and `RunSettingsBody` is undefined.
- The Start route never forwards any settings (`startCalls` holds `settings: undefined`), and a bad body answers 200.
- `me.user.dialerRunDefaults` is `undefined`.

- [ ] **Step 38: Implement the Start route**. In `services/cti-api/src/routes/dialer.ts`:

Replace

```ts
 *  POST /dialer/sessions/:id/start    → ready → active, then originate the first call (idempotent; 409 if another run is active)
```

with

```ts
 *  POST /dialer/sessions/:id/start    → ready → active with the run settings, then originate the first call (idempotent; 409 if another run is active)
```

Replace

```ts
import { getDb, schema } from '@cti/db';
```

with

```ts
import { getDb, schema } from '@cti/db';
import { MAX_RUN_RECORDS, type DialerRunSettings } from '@cti/contracts';
```

Replace

```ts
export const StartBody = z.object({
  objectType: z.enum(['Lead', 'Opportunity', 'Task']),
  recordIds: z.array(z.string().refine(isValidSfId, 'invalid record id')).min(1).max(500),
});
```

with

```ts
export const StartBody = z.object({
  objectType: z.enum(['Lead', 'Opportunity', 'Task']),
  recordIds: z.array(z.string().refine(isValidSfId, 'invalid record id')).min(1).max(500),
});

/**
 * The POST /dialer/sessions/:id/start body — the run settings chosen on Ready
 * to dial (spec docs/superpowers/specs/2026-09-28-run-settings-design.md).
 * Exported so routes/dialer.test.ts pins THIS schema. Strict: an unknown key is
 * a 400 too, so a typo can never quietly start a run with a default the rep
 * did not pick. `maxRecords` absent or null = the whole list; the cap is the
 * most records a run can hold.
 */
export const RunSettingsBody = z
  .object({
    passes: z.union([z.literal(1), z.literal(2)]),
    maxRecords: z.number().int().min(1).max(MAX_RUN_RECORDS).nullable().optional(),
    rolloverBusinessDays: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();

/** The first field a bad run-settings body trips on — what the 400 names. */
function firstInvalidField(err: z.ZodError): string {
  const issue = err.issues[0];
  if (issue?.code === 'unrecognized_keys') return issue.keys[0] ?? 'body';
  const key = issue?.path[0];
  return typeof key === 'string' ? key : 'body';
}

/**
 * Start's body → the run's settings. No body at all is a softphone tab loaded
 * before run settings existed: `null`, which starts today's run and saves
 * nothing. Any body must be complete and valid.
 */
export function parseRunSettings(body: unknown):
  | { ok: true; settings: DialerRunSettings | null }
  | { ok: false; field: string } {
  if (body === undefined || body === null) return { ok: true, settings: null };
  const parsed = RunSettingsBody.safeParse(body);
  if (!parsed.success) return { ok: false, field: firstInvalidField(parsed.error) };
  const { passes, maxRecords, rolloverBusinessDays } = parsed.data;
  return { ok: true, settings: { passes, maxRecords: maxRecords ?? null, rolloverBusinessDays } };
}
```

Replace

```ts
    if (!requirePowerDialer(owned.authed, reply)) return reply;
    const result = await startSession(owned.session.id, buildEngineDeps());
```

with

```ts
    if (!requirePowerDialer(owned.authed, reply)) return reply;
    // The run settings ride the ready → active claim, so a bad one is refused
    // BEFORE anything flips or dials.
    const run = parseRunSettings(req.body);
    if (!run.ok) return reply.code(400).send({ error: `Invalid ${run.field}`, field: run.field });
    const result = await startSession(owned.session.id, buildEngineDeps(), run.settings);
```

- [ ] **Step 39: Implement `/auth/me`**. In `services/cti-api/src/routes/auth.ts`:

Replace

```ts
  toHoldMusicChoice,
  type HoldMusicChoice,
```

with

```ts
  toDialerRunDefaults,
  toHoldMusicChoice,
  type HoldMusicChoice,
```

Replace (in the GET `/auth/me` handler's `columns`)

```ts
          dialerYoutubeVideoId: true,
        },
      }),
```

with

```ts
          dialerYoutubeVideoId: true,
          dialerPasses: true,
          dialerRolloverBusinessDays: true,
        },
      }),
```

Replace

```ts
        dialerHoldMusic: holdMusicSettingFor(profile).choice !== 'off',
      },
```

with

```ts
        dialerHoldMusic: holdMusicSettingFor(profile).choice !== 'off',
        // Power Dial run settings (spec 2026-09-28): the choices the rep last
        // STARTED a run with — Ready to dial's defaults. A missing profile row
        // reads as today's run.
        dialerRunDefaults: toDialerRunDefaults(
          profile ? { passes: profile.dialerPasses, rolloverBusinessDays: profile.dialerRolloverBusinessDays } : null,
        ),
      },
```

- [ ] **Step 40: Run them to verify they pass**

Run: `cd services/cti-api && npx vitest run src/routes/dialer.test.ts src/routes/auth-me.test.ts`
Expected: PASS for both files, every existing test included.

- [ ] **Step 41: Full verification for Task 1**

Run: `npm run build:packages && npm -w packages/contracts test && npm -w packages/db test && npm -w packages/db run typecheck && npm -w services/cti-api run typecheck && npm -w services/cti-api test`
Expected: every suite passes, and both typechecks exit 0 with no output.

Then run: `grep -n "console.log" packages/contracts/src/dialer-run.ts services/cti-api/src/dialer/run-settings.ts services/cti-api/src/dialer/contact-history.ts services/cti-api/src/dialer/engine.ts services/cti-api/src/salesforce/followup-enqueue.ts services/cti-api/src/salesforce/sync.ts services/cti-api/src/salesforce/followup-day.ts services/cti-api/src/salesforce/followup-worker.ts services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/auth.ts`
Expected: no output.

- [ ] **Step 42: Commit**

```bash
git add services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/dialer.test.ts services/cti-api/src/routes/auth.ts services/cti-api/src/routes/auth-me.test.ts
git commit -m "$(cat <<'EOF'
feat(api): run settings on Start (validated), session view, and /auth/me defaults

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Web — the Ready-to-dial settings block, the Start body, the run line, and the defaults from `/auth/me`

**Files:**
- Create: `apps/cti-web/src/run-settings.ts`, `apps/cti-web/src/run-settings.test.ts`
- Create: `apps/cti-web/src/components/RunSettingsBlock.tsx`, `apps/cti-web/src/components/RunSettingsBlock.test.tsx`
- Create: `apps/cti-web/src/components/DialerPanel.run-settings.test.tsx`
- Modify: `apps/cti-web/src/dialer-api.ts`, `apps/cti-web/src/dialer-api.test.ts`
- Modify: `apps/cti-web/src/components/DialerPanel.tsx` (imports; `confirmLine` 136–151; `CurrentRecord` 568–580; `ConfirmBlock` 755–801; props 472–538; state/effect/handler 829–1053; render 1092–1142), `apps/cti-web/src/components/DialerPanel.test.tsx`
- Modify: `apps/cti-web/src/App.tsx:2,4,72-80,2215-2240`, `apps/cti-web/src/styles.css` (after line 1165)

**Interfaces:**
- Consumes (Task 1): `DIALER_PASSES`, `ROLLOVER_BUSINESS_DAYS`, `DEFAULT_DIALER_RUN_DEFAULTS`, `toDialerRunDefaults`, `type DialerPasses`, `type RolloverBusinessDays`, `type DialerRunDefaults` and `type DialerRunSettings` from `@cti/contracts`.
  - HTTP: `POST /dialer/sessions/:id/start` with a `DialerRunSettings` body.
  - `GET /dialer/sessions/:id` → `session.passes | maxRecords | rolloverBusinessDays`; `currentItem.ordinal`.
  - `GET /auth/me` → `user.dialerRunDefaults`.
  - Run `npm run build:packages` first, so the web resolves the new contracts `dist/`.
- Produces:
  ```ts
  // apps/cti-web/src/run-settings.ts
  export interface RunDraft { passes: DialerPasses; rolloverBusinessDays: RolloverBusinessDays; howMany: string }
  export const PASS_LABELS: Readonly<Record<DialerPasses, string>>;              // Once / Twice
  export const ROLLOVER_LABELS: Readonly<Record<RolloverBusinessDays, string>>;  // Next business day / In 2 business days
  export function draftFromDefaults(defaults: DialerRunDefaults): RunDraft;
  export function runDefaultsFromMe(user: { dialerRunDefaults?: { passes?: unknown; rolloverBusinessDays?: unknown } | null }): DialerRunDefaults;
  export function digitsOnly(raw: string): string;
  export type HowMany = { ok: true; maxRecords: number | null } | { ok: false; error: string };
  export function parseHowMany(raw: string, listSize: number): HowMany;
  export function runSettingsFor(draft: RunDraft, listSize: number): DialerRunSettings | null;
  export function runSettingsLine(session: { passes?: DialerPasses; maxRecords?: number | null; rolloverBusinessDays?: RolloverBusinessDays }): string | null;
  export function recordPositionLine(item: { listPosition?: number | null; ordinal?: number; attempt?: number }, ctx: { listTotal: number | null; runSize: number | null }): string | null;
  // apps/cti-web/src/dialer-api.ts
  export async function startDialerRun(id: string, settings: DialerRunSettings): Promise<{ ok: boolean }>;
  // DialerSession gains passes?, maxRecords?, rolloverBusinessDays?; DialerCurrentItem gains ordinal?
  // apps/cti-web/src/components/RunSettingsBlock.tsx
  export function RunSettingsBlock(props: { draft: RunDraft; listSize: number; busy: boolean; onChange: (d: RunDraft) => void }): JSX.Element;
  // DialerPanel: confirmLine(…, maxRecords?: number | null); CurrentRecord gains runSize?;
  // ConfirmBlock gains draft?, onDraftChange?; DialerPanelProps gains runDefaults?, onRunDefaultsSaved?
  ```

- [ ] **Step 1: Write the failing API-client test**. In `apps/cti-web/src/dialer-api.test.ts`, replace

```ts
import { dialerControlPath, startBody, startDialer, getDialer, dialerControl, getPendingHandoff, takeDialerCallback } from './dialer-api';
```

with

```ts
import { dialerControlPath, startBody, startDialer, startDialerRun, getDialer, dialerControl, getPendingHandoff, takeDialerCallback } from './dialer-api';
```

and append to the end of the file:

```ts
describe('startDialerRun (spec 2026-09-28)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POSTs the run settings to /dialer/sessions/:id/start', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({ ok: true });
    await startDialerRun('abc', { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 });
    expect(mockApi).toHaveBeenCalledWith('/dialer/sessions/abc/start', {
      method: 'POST',
      body: { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:packages && cd apps/cti-web && npx vitest run src/dialer-api.test.ts`
Expected: FAIL with `startDialerRun is not a function`.

- [ ] **Step 3: Implement**. In `apps/cti-web/src/dialer-api.ts`:

Replace

```ts
import { api } from './api';
```

with

```ts
import type { DialerPasses, DialerRunSettings, RolloverBusinessDays } from '@cti/contracts';
import { api } from './api';
```

Replace

```ts
  prospectEndedAt?: string | null;
}
```

with

```ts
  prospectEndedAt?: string | null;
  /** The row's place in THIS run's queue (0-based). A limited run counts its
   *  "record X of N" by it (spec 2026-09-28 decision 5). Absent: an older server. */
  ordinal?: number;
}
```

Replace

```ts
export interface DialerSession {
  id: string;
  status: 'ready' | 'active' | 'paused' | 'stopped' | 'done';
}
```

with

```ts
export interface DialerSession {
  id: string;
  status: 'ready' | 'active' | 'paused' | 'stopped' | 'done';
  /** Run settings (spec 2026-09-28) — what the run line under the progress
   *  shows. Absent: an older server. */
  passes?: DialerPasses;
  maxRecords?: number | null;
  rolloverBusinessDays?: RolloverBusinessDays;
}
```

After the `dialerControl` function, add:

```ts
/** Start dialing with the Ready-to-dial choices (spec 2026-09-28). The server
 *  applies them in the same step that flips the run active, and saves Calls
 *  per person / Missed tasks as the rep's next defaults. */
export async function startDialerRun(id: string, settings: DialerRunSettings): Promise<{ ok: boolean }> {
  return api(dialerControlPath(id, 'start'), {
    method: 'POST',
    body: settings,
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/dialer-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing pure-helper tests**. Create `apps/cti-web/src/run-settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  digitsOnly,
  draftFromDefaults,
  parseHowMany,
  recordPositionLine,
  runDefaultsFromMe,
  runSettingsFor,
  runSettingsLine,
} from './run-settings';

describe('run settings on Ready to dial (spec 2026-09-28)', () => {
  it('a fresh draft is the saved choices plus All', () => {
    expect(draftFromDefaults({ passes: 1, rolloverBusinessDays: 2 })).toEqual({ passes: 1, rolloverBusinessDays: 2, howMany: '' });
  });

  it("runDefaultsFromMe: the server's saved choices; an older API (none) or junk is today's run", () => {
    expect(runDefaultsFromMe({ dialerRunDefaults: { passes: 1, rolloverBusinessDays: 2 } })).toEqual({ passes: 1, rolloverBusinessDays: 2 });
    expect(runDefaultsFromMe({})).toEqual({ passes: 2, rolloverBusinessDays: 1 });
    expect(runDefaultsFromMe({ dialerRunDefaults: null })).toEqual({ passes: 2, rolloverBusinessDays: 1 });
    expect(runDefaultsFromMe({ dialerRunDefaults: { passes: 'once', rolloverBusinessDays: 7 } })).toEqual({ passes: 2, rolloverBusinessDays: 1 });
  });

  it('the box keeps digits only', () => {
    expect(digitsOnly('1,000')).toBe('1000');
    expect(digitsOnly('50 people')).toBe('50');
    expect(digitsOnly('-3')).toBe('3');
    expect(digitsOnly('abc')).toBe('');
  });

  it('parseHowMany: blank is All; 1 to the list size is a number; anything else is refused', () => {
    expect(parseHowMany('', 200)).toEqual({ ok: true, maxRecords: null });
    expect(parseHowMany('  ', 200)).toEqual({ ok: true, maxRecords: null });
    expect(parseHowMany('1', 200)).toEqual({ ok: true, maxRecords: 1 });
    expect(parseHowMany('200', 200)).toEqual({ ok: true, maxRecords: 200 });
    for (const bad of ['0', '201', '1.5', '-1', 'abc', '99999999999999999999']) {
      expect(parseHowMany(bad, 200)).toEqual({ ok: false, error: 'Enter a whole number from 1 to 200, or leave it blank for all.' });
    }
  });

  it('runSettingsFor: the Start body, or null while the box is invalid', () => {
    expect(runSettingsFor({ passes: 2, rolloverBusinessDays: 1, howMany: '' }, 200)).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
    expect(runSettingsFor({ passes: 1, rolloverBusinessDays: 2, howMany: '100' }, 200)).toEqual({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 });
    expect(runSettingsFor({ passes: 1, rolloverBusinessDays: 2, howMany: '0' }, 200)).toBeNull();
  });

  it('runSettingsLine reads like the spec, and is absent for an older server', () => {
    expect(runSettingsLine({ passes: 1, maxRecords: 100, rolloverBusinessDays: 1 })).toBe('Once · first 100 · missed → next business day');
    expect(runSettingsLine({ passes: 2, maxRecords: null, rolloverBusinessDays: 2 })).toBe('Twice · all · missed → in 2 business days');
    expect(runSettingsLine({})).toBeNull();
  });

  it('recordPositionLine: a limited run counts its own queue; a retry has no place in it; a full run keeps the list position', () => {
    expect(recordPositionLine({ ordinal: 2, attempt: 1, listPosition: 150 }, { runSize: 100, listTotal: 100 })).toBe('record 3 of 100');
    expect(recordPositionLine({ ordinal: 100, attempt: 2, listPosition: null }, { runSize: 100, listTotal: 100 })).toBeNull();
    expect(recordPositionLine({ attempt: 1, listPosition: 86 }, { runSize: 100, listTotal: 100 })).toBeNull(); // older server: no ordinal
    expect(recordPositionLine({ ordinal: 2, attempt: 1, listPosition: 86 }, { runSize: null, listTotal: 220 })).toBe('record 87 of 220');
    expect(recordPositionLine({ ordinal: 2, attempt: 1, listPosition: null }, { runSize: null, listTotal: 220 })).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/run-settings.test.ts`
Expected: FAIL with `Failed to resolve import "./run-settings"`.

- [ ] **Step 7: Implement**. Create `apps/cti-web/src/run-settings.ts`:

```ts
/**
 * Power Dial run settings on Ready to dial (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md): the draft the rep
 * edits, the Start dialing body, the run line under the progress, and a limited
 * run's "record X of N". Pure — DialerPanel owns the state.
 */
import {
  toDialerRunDefaults,
  type DialerPasses,
  type DialerRunDefaults,
  type DialerRunSettings,
  type RolloverBusinessDays,
} from '@cti/contracts';

/** What the rep is editing. `howMany` is the raw box: '' means All. */
export interface RunDraft {
  passes: DialerPasses;
  rolloverBusinessDays: RolloverBusinessDays;
  howMany: string;
}

export const PASS_LABELS: Readonly<Record<DialerPasses, string>> = { 1: 'Once', 2: 'Twice' };
export const ROLLOVER_LABELS: Readonly<Record<RolloverBusinessDays, string>> = { 1: 'Next business day', 2: 'In 2 business days' };

/** A fresh Ready screen: the rep's saved choices, and All — a number is about
 *  one list, so it is never carried to the next. */
export function draftFromDefaults(defaults: DialerRunDefaults): RunDraft {
  return { passes: defaults.passes, rolloverBusinessDays: defaults.rolloverBusinessDays, howMany: '' };
}

/** `/auth/me`'s saved choices. An older API (no field) or a value this build
 *  does not know reads as today's run. */
export function runDefaultsFromMe(user: {
  dialerRunDefaults?: { passes?: unknown; rolloverBusinessDays?: unknown } | null;
}): DialerRunDefaults {
  return toDialerRunDefaults(user.dialerRunDefaults);
}

/** The box keeps digits only, so a paste of "1,000" or "50 people" can never
 *  become a number the rep did not see. */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '');
}

export type HowMany = { ok: true; maxRecords: number | null } | { ok: false; error: string };

/** Blank = All; otherwise a whole number from 1 up to the list size. */
export function parseHowMany(raw: string, listSize: number): HowMany {
  const text = raw.trim();
  if (text === '') return { ok: true, maxRecords: null };
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > listSize) {
    return { ok: false, error: `Enter a whole number from 1 to ${listSize}, or leave it blank for all.` };
  }
  return { ok: true, maxRecords: n };
}

/** The Start dialing body — or null while the box holds something Start must not send. */
export function runSettingsFor(draft: RunDraft, listSize: number): DialerRunSettings | null {
  const howMany = parseHowMany(draft.howMany, listSize);
  if (!howMany.ok) return null;
  return { passes: draft.passes, maxRecords: howMany.maxRecords, rolloverBusinessDays: draft.rolloverBusinessDays };
}

/** The line under a run's progress, e.g. "Once · first 100 · missed → next
 *  business day". Null when the server sent no settings (an older API). */
export function runSettingsLine(session: {
  passes?: DialerPasses;
  maxRecords?: number | null;
  rolloverBusinessDays?: RolloverBusinessDays;
}): string | null {
  if (session.passes === undefined || session.rolloverBusinessDays === undefined) return null;
  const size = session.maxRecords == null ? 'all' : `first ${session.maxRecords}`;
  const missed = session.rolloverBusinessDays === 2 ? 'in 2 business days' : 'next business day';
  return `${PASS_LABELS[session.passes]} · ${size} · missed → ${missed}`;
}

/**
 * The current record's "record X of N". A limited run (spec 2026-09-28
 * decision 5) counts its OWN queue: "record 3 of 100" — the Salesforce list
 * position would read "record 150 of 100" there. A full run keeps the list
 * position ("two reps, one list", spec 2026-09-23 §4). An attempt-2 retry sits
 * past the end of the queue, so it gets no count; nor does a row an older
 * server sent without an ordinal.
 */
export function recordPositionLine(
  item: { listPosition?: number | null; ordinal?: number; attempt?: number },
  ctx: { listTotal: number | null; runSize: number | null },
): string | null {
  if (ctx.runSize !== null) {
    if (item.attempt === 2 || item.ordinal === undefined) return null;
    return `record ${item.ordinal + 1} of ${ctx.runSize}`;
  }
  if (item.listPosition != null && ctx.listTotal !== null) return `record ${item.listPosition + 1} of ${ctx.listTotal}`;
  return null;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/run-settings.test.ts`
Expected: the 7 tests in `run-settings.test.ts` PASS. The filter is a substring match, so once Step 18 exists it also runs `DialerPanel.run-settings.test.tsx`.

- [ ] **Step 9: Write the failing settings-block test**. Create `apps/cti-web/src/components/RunSettingsBlock.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunSettingsBlock } from './RunSettingsBlock';
import type { RunDraft } from '../run-settings';

const noop = (): void => {};
const html = (draft: RunDraft, busy = false): string =>
  renderToStaticMarkup(<RunSettingsBlock draft={draft} listSize={202} busy={busy} onChange={noop} />);
const today: RunDraft = { passes: 2, rolloverBusinessDays: 1, howMany: '' };

describe('RunSettingsBlock (SSR)', () => {
  it("shows the three settings with today's run pressed and the box blank (All) of the list size", () => {
    const out = html(today);
    expect(out).toContain('Calls per person');
    expect(out).toContain('How many');
    expect(out).toContain('Missed tasks move to');
    expect(out).toMatch(/aria-pressed="true">Twice<\/button>/);
    expect(out).toMatch(/aria-pressed="false">Once<\/button>/);
    expect(out).toMatch(/aria-pressed="true">Next business day<\/button>/);
    expect(out).toMatch(/aria-pressed="false">In 2 business days<\/button>/);
    expect(out).toContain('placeholder="All"');
    expect(out).toContain('<span>Call the first</span>');
    expect(out).toContain('<span>of 202</span>');
    expect(out).not.toContain('Enter a whole number');
  });

  it('reflects Once, a number, and In 2 business days', () => {
    const out = html({ passes: 1, rolloverBusinessDays: 2, howMany: '100' });
    expect(out).toMatch(/aria-pressed="true">Once<\/button>/);
    expect(out).toMatch(/aria-pressed="true">In 2 business days<\/button>/);
    expect(out).toContain('value="100"');
  });

  it('says why an out-of-range number cannot start', () => {
    const out = html({ ...today, howMany: '203' });
    expect(out).toContain('Enter a whole number from 1 to 202, or leave it blank for all.');
    expect(out).toContain('aria-invalid="true"');
  });

  it('locks every choice while a Start is in flight (four buttons and the box)', () => {
    expect((html(today, true).match(/disabled=""/g) ?? []).length).toBe(5);
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/components/RunSettingsBlock.test.tsx`
Expected: FAIL with `Failed to resolve import "./RunSettingsBlock"`.

- [ ] **Step 11: Implement**. Create `apps/cti-web/src/components/RunSettingsBlock.tsx`:

```tsx
/**
 * The three run settings on Ready to dial (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md): Calls per person,
 * How many, Missed tasks move to. Prop-only — DialerPanel owns the draft — so
 * it renders under renderToStaticMarkup like ConfirmBlock.
 */
import { DIALER_PASSES, ROLLOVER_BUSINESS_DAYS } from '@cti/contracts';
import { digitsOnly, parseHowMany, PASS_LABELS, ROLLOVER_LABELS, type RunDraft } from '../run-settings';

export interface RunSettingsBlockProps {
  draft: RunDraft;
  /** The run's list size — the box's upper bound and its "of N". */
  listSize: number;
  /** A Start is in flight: nothing here may change under it. */
  busy: boolean;
  onChange: (draft: RunDraft) => void;
}

export function RunSettingsBlock({ draft, listSize, busy, onChange }: RunSettingsBlockProps): JSX.Element {
  const howMany = parseHowMany(draft.howMany, listSize);
  return (
    <div className="dp-run-settings-block">
      <div className="dp-setting">
        <div className="dp-setting-label" id="dp-passes-label">Calls per person</div>
        <div className="row dp-setting-choices" role="group" aria-labelledby="dp-passes-label">
          {DIALER_PASSES.map((value) => (
            <button
              key={value}
              type="button"
              className={`btn ${draft.passes === value ? 'active' : ''}`}
              aria-pressed={draft.passes === value}
              disabled={busy}
              onClick={() => onChange({ ...draft, passes: value })}
            >
              {PASS_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      <div className="dp-setting">
        <label className="dp-setting-label" htmlFor="dp-how-many">How many</label>
        <div className="row dp-setting-howmany">
          <span>Call the first</span>
          <input
            id="dp-how-many"
            className="dp-how-many-input"
            type="text"
            inputMode="numeric"
            placeholder="All"
            value={draft.howMany}
            disabled={busy}
            aria-invalid={!howMany.ok}
            onChange={(e) => onChange({ ...draft, howMany: digitsOnly(e.target.value) })}
          />
          <span>{`of ${listSize}`}</span>
        </div>
        {!howMany.ok && <div className="dp-error">{howMany.error}</div>}
      </div>
      <div className="dp-setting">
        <div className="dp-setting-label" id="dp-rollover-label">Missed tasks move to</div>
        <div className="row dp-setting-choices" role="group" aria-labelledby="dp-rollover-label">
          {ROLLOVER_BUSINESS_DAYS.map((value) => (
            <button
              key={value}
              type="button"
              className={`btn ${draft.rolloverBusinessDays === value ? 'active' : ''}`}
              aria-pressed={draft.rolloverBusinessDays === value}
              disabled={busy}
              onClick={() => onChange({ ...draft, rolloverBusinessDays: value })}
            >
              {ROLLOVER_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/components/RunSettingsBlock.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 13: Commit**

```bash
git add apps/cti-web/src/dialer-api.ts apps/cti-web/src/dialer-api.test.ts apps/cti-web/src/run-settings.ts apps/cti-web/src/run-settings.test.ts apps/cti-web/src/components/RunSettingsBlock.tsx apps/cti-web/src/components/RunSettingsBlock.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): run-settings helpers, settings block, and the Start-with-settings call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 14: Write the failing Ready-screen SSR tests** in `apps/cti-web/src/components/DialerPanel.test.tsx`.

In `describe('ConfirmBlock (SSR)')`, replace

```tsx
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
```

with

```tsx
    // Start and the way out — and, while a Start is in flight, the settings too
    // (four choices and the How many box: 7 in all).
    expect(html).toMatch(/<button class="btn primary full" disabled="">Starting…<\/button>/);
    expect(html).toMatch(/<button class="btn full" disabled="">Choose a different list<\/button>/);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(7);
```

In the same describe, directly after the test named `'does not offer it when the 409 named no run'`, add:

```tsx
  it("shows the run settings above Start dialing, prefilled with today's run", () => {
    const html = renderToStaticMarkup(<ConfirmBlock view={view} busy={false} error={null} onStartDialing={() => {}} onChooseAnother={() => {}} />);
    expect(html).toMatch(/aria-pressed="true">Twice<\/button>/);
    expect(html).toMatch(/aria-pressed="true">Next business day<\/button>/);
    expect(html).toContain('<span>of 202</span>');
    expect(html.indexOf('Calls per person')).toBeLessThan(html.indexOf('Start dialing'));
  });
  it('"N will be dialed" follows the box, capped at what the list can dial', () => {
    const at = (howMany: string) => renderToStaticMarkup(
      <ConfirmBlock view={view} busy={false} error={null} onStartDialing={() => {}} onChooseAnother={() => {}} draft={{ passes: 2, rolloverBusinessDays: 1, howMany }} />,
    );
    expect(at('100')).toContain('100 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked');
    expect(at('195')).toContain('187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked');
    expect(at('')).toContain('187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked');
  });
  it('an out-of-range number holds Start dialing back', () => {
    const html = renderToStaticMarkup(
      <ConfirmBlock view={view} busy={false} error={null} onStartDialing={() => {}} onChooseAnother={() => {}} draft={{ passes: 2, rolloverBusinessDays: 1, howMany: '203' }} />,
    );
    expect(html).toContain('Enter a whole number from 1 to 202, or leave it blank for all.');
    expect(html).toMatch(/<button class="btn primary full" disabled="">Start dialing<\/button>/);
  });
```

Append to the end of the file:

```tsx
describe('confirmLine — a run size (spec 2026-09-28)', () => {
  it('leads with the run size, never more than the list can dial', () => {
    const b = { already_worked: 9, blocked: 2 };
    expect(confirmLine(202, 4, b, 100)).toBe('100 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked');
    expect(confirmLine(202, 4, b, 195)).toBe('187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked');
    expect(confirmLine(202, 4, b, null)).toBe('187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked');
  });
});

describe('CurrentRecord — a limited run counts its own queue (spec 2026-09-28)', () => {
  const item: DialerCurrentItem = {
    id: 'i3', recordId: '00Q3', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234', ordinal: 2, attempt: 1, listPosition: 150,
  };
  it('reads "record X of N" from the run\'s queue, not the Salesforce list', () => {
    expect(renderToStaticMarkup(<CurrentRecord item={item} listTotal={104} runSize={104} />)).toContain('record 3 of 104');
  });
  it('a full run keeps the list position, as today', () => {
    expect(renderToStaticMarkup(<CurrentRecord item={item} listTotal={220} />)).toContain('record 151 of 220');
  });
});
```

- [ ] **Step 15: Run it to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/components/DialerPanel.test.tsx`
Expected: FAIL. ConfirmBlock has no settings block, it ignores `draft`, and `confirmLine` ignores its 4th argument. `CurrentRecord` shows `record 151 of 104`, and the busy count is 2.

- [ ] **Step 16: Implement ConfirmBlock, `confirmLine` and `CurrentRecord`**. In `apps/cti-web/src/components/DialerPanel.tsx`:

Replace

```tsx
import type { HoldMusicSetting } from '@cti/contracts';
```

with

```tsx
import { DEFAULT_DIALER_RUN_DEFAULTS, type DialerRunDefaults, type HoldMusicSetting } from '@cti/contracts';
```

Replace

```tsx
import {
  dialerControl,
  getDialer,
```

with

```tsx
import {
  dialerControl,
  getDialer,
  startDialerRun,
```

Replace

```tsx
import { CallbackBanner, type CallbackBannerProps } from './CallbackBanner';
```

with

```tsx
import { CallbackBanner, type CallbackBannerProps } from './CallbackBanner';
import { RunSettingsBlock } from './RunSettingsBlock';
import { draftFromDefaults, parseHowMany, recordPositionLine, runSettingsFor, runSettingsLine, type RunDraft } from '../run-settings';
```

Replace the whole `confirmLine` doc comment and function:

```tsx
/**
 * Pure — the confirm block's line, e.g.
 * "187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked".
 * Leads with the figure the rep is deciding on; zero parts omitted.
 */
export function confirmLine(firstPassTotal: number, unreachable: number, breakdown?: Record<string, number>): string {
  const q = queueParts(firstPassTotal, unreachable, breakdown);
  const parts = [`${q.dialing} will be dialed`];
```

with

```tsx
/**
 * Pure — the confirm block's line, e.g.
 * "187 will be dialed · 9 called in the last 3 h · 4 no number · 2 blocked".
 * Leads with the figure the rep is deciding on; zero parts omitted. A run size
 * (`maxRecords`, spec 2026-09-28) caps the lead figure at what the list can
 * actually give: asking for 195 of a list with 187 dialable reads "187".
 */
export function confirmLine(
  firstPassTotal: number,
  unreachable: number,
  breakdown?: Record<string, number>,
  maxRecords: number | null = null,
): string {
  const q = queueParts(firstPassTotal, unreachable, breakdown);
  const dialing = maxRecords === null ? q.dialing : Math.min(q.dialing, maxRecords);
  const parts = [`${dialing} will be dialed`];
```

Replace

```tsx
export function CurrentRecord({ item, listTotal }: { item: DialerCurrentItem; listTotal?: number | null }): JSX.Element {
```

with

```tsx
export function CurrentRecord({ item, listTotal, runSize }: {
  item: DialerCurrentItem;
  listTotal?: number | null;
  /** A limited run's queue size (spec 2026-09-28): "record X of N" then counts
   *  THIS run's queue, not the Salesforce list. Null/absent: a full run. */
  runSize?: number | null;
}): JSX.Element {
```

Replace

```tsx
  // Two reps, one list (spec §4): 1-based from the 0-based `listPosition` —
  // shown only when BOTH the item's own position and the run's list total are
  // known (a non-list-view run, or an older server, has neither).
  const listLine = item.listPosition != null && listTotal != null
    ? `record ${item.listPosition + 1} of ${listTotal}`
    : null;
```

with

```tsx
  // Two reps, one list (spec §4): 1-based from the 0-based `listPosition` —
  // shown only when BOTH the item's own position and the run's list total are
  // known (a non-list-view run, or an older server, has neither). A limited
  // run counts its own queue instead — see `recordPositionLine`.
  const listLine = recordPositionLine(item, { listTotal: listTotal ?? null, runSize: runSize ?? null });
```

Replace the whole `ConfirmBlock` doc comment and function:

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
  onStopOther,
}: {
  view: DialerSessionView;
  busy: boolean;
  error: string | null;
  onStartDialing: () => void;
  onChooseAnother: () => void;
  /** Present only when a refused Start named the rep's OTHER active run —
   *  renders the way to stop it without leaving this screen. */
  onStopOther?: () => void;
}): JSX.Element {
  const contextLine = confirmContextLine(view.listContext);
  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Ready to dial</div>
        <div className="dp-queue-line">
          {confirmLine(view.firstPassTotal ?? view.counts.total, view.counts.unreachable, view.skipBreakdown)}
        </div>
        {contextLine && <div className="dp-queue-line dp-list-context">{contextLine}</div>}
        {error && <div className="dp-error">{error}</div>}
        <button className="btn primary full" disabled={busy} onClick={onStartDialing}>
          {busy ? 'Starting…' : 'Start dialing'}
        </button>
```

with

```tsx
/** Today's run — what Ready to dial shows when the parent passes no draft. */
const TODAYS_DRAFT: RunDraft = draftFromDefaults(DEFAULT_DIALER_RUN_DEFAULTS);

/**
 * The run was created READY: the queue is built, nothing has dialed. Show the
 * rep what the list came to, let them choose the run settings (spec
 * 2026-09-28 — above Start dialing, prefilled from their saved defaults), and
 * start it — or back out, which stops the (never-started) session and returns
 * to the picker. "N will be dialed" follows the How many box as it changes.
 */
export function ConfirmBlock({
  view,
  busy,
  error,
  onStartDialing,
  onChooseAnother,
  onStopOther,
  draft = TODAYS_DRAFT,
  onDraftChange = () => {},
}: {
  view: DialerSessionView;
  busy: boolean;
  error: string | null;
  onStartDialing: () => void;
  onChooseAnother: () => void;
  /** Present only when a refused Start named the rep's OTHER active run —
   *  renders the way to stop it without leaving this screen. */
  onStopOther?: () => void;
  /** The run settings on screen; absent renders today's run. */
  draft?: RunDraft;
  onDraftChange?: (draft: RunDraft) => void;
}): JSX.Element {
  const contextLine = confirmContextLine(view.listContext);
  const listSize = view.firstPassTotal ?? view.counts.total;
  const howMany = parseHowMany(draft.howMany, listSize);
  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Ready to dial</div>
        <div className="dp-queue-line">
          {confirmLine(listSize, view.counts.unreachable, view.skipBreakdown, howMany.ok ? howMany.maxRecords : null)}
        </div>
        {contextLine && <div className="dp-queue-line dp-list-context">{contextLine}</div>}
        <RunSettingsBlock draft={draft} listSize={listSize} busy={busy} onChange={onDraftChange} />
        {error && <div className="dp-error">{error}</div>}
        <button className="btn primary full" disabled={busy || !howMany.ok} onClick={onStartDialing}>
          {busy ? 'Starting…' : 'Start dialing'}
        </button>
```

(`runSettingsFor`, `runSettingsLine`, `startDialerRun` and `DialerRunDefaults` are used in Step 20.)

- [ ] **Step 17: Run it to verify it passes, and typecheck**

Run: `cd apps/cti-web && npx vitest run src/components/DialerPanel.test.tsx && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, every existing DialerPanel test included, and `tsc` exits 0.

- [ ] **Step 18: Write the failing mounted-panel test**. Create `apps/cti-web/src/components/DialerPanel.run-settings.test.tsx`:

```tsx
/** @vitest-environment jsdom */
/**
 * Ready to dial's run settings (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md), in a mounted
 * panel: the choices start from the rep's saved defaults, "N will be dialed"
 * follows the box as the rep types, Start sends exactly what is on screen, and
 * App hears that the server saved the choices only once it accepted the Start.
 * The pieces are pinned pure/SSR in run-settings.test.ts,
 * RunSettingsBlock.test.tsx and DialerPanel.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialerPanel, type DialerPanelProps } from './DialerPanel';
import * as dialerApi from '../dialer-api';
import type { DialerSessionView } from '../dialer-api';
import { ApiError } from '../api';

const READY: DialerSessionView = {
  session: { id: 'sess1', status: 'ready' },
  counts: { total: 202, done: 0, connected: 0, noConnect: 0, skipped: 11, unreachable: 4, pending: 187 },
  currentItem: null,
  skipBreakdown: { already_worked: 9, blocked: 2 },
  firstPassTotal: 202,
};

const noop = (): void => {};
const mount = (props: Partial<DialerPanelProps> = {}) => render(
  <DialerPanel
    sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}}
    onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop}
    {...props}
  />,
);
const pressed = (name: string): string | null => screen.getByRole('button', { name }).getAttribute('aria-pressed');
const startButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Start dialing' }) as HTMLButtonElement;

describe('Ready to dial — run settings', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("starts from the rep's saved choices, and How many is always All", async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    mount({ runDefaults: { passes: 1, rolloverBusinessDays: 2 } });
    await screen.findByRole('button', { name: 'Once' });
    expect(pressed('Once')).toBe('true');
    expect(pressed('Twice')).toBe('false');
    expect(pressed('In 2 business days')).toBe('true');
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('');
  });

  it("with no saved choices (an older API) it is today's run: Twice, All, next business day", async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    mount();
    await screen.findByRole('button', { name: 'Twice' });
    expect(pressed('Twice')).toBe('true');
    expect(pressed('Next business day')).toBe('true');
  });

  it('"N will be dialed" follows the box as the rep types, capped at what the list can dial', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    mount();
    const box = await screen.findByLabelText('How many');
    expect(screen.getByText(/^187 will be dialed/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '100' } });
    expect(screen.getByText(/^100 will be dialed/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '195' } });
    expect(screen.getByText(/^187 will be dialed/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByText(/^187 will be dialed/)).toBeTruthy();
  });

  it('the box keeps digits only, and an out-of-range number holds Start back with the reason', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    mount();
    const box = (await screen.findByLabelText('How many')) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '12a' } });
    expect(box.value).toBe('12');
    fireEvent.change(box, { target: { value: '0' } });
    expect(screen.getByText('Enter a whole number from 1 to 202, or leave it blank for all.')).toBeTruthy();
    expect(startButton().disabled).toBe(true);
    fireEvent.change(box, { target: { value: '202' } });
    expect(startButton().disabled).toBe(false);
  });

  it('Start sends exactly what is on screen, then tells App the choices were saved', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    const start = vi.spyOn(dialerApi, 'startDialerRun').mockResolvedValue({ ok: true });
    const saved = vi.fn();
    mount({ onRunDefaultsSaved: saved });
    fireEvent.click(await screen.findByRole('button', { name: 'Once' }));
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'In 2 business days' }));
    fireEvent.click(startButton());
    await waitFor(() => expect(start).toHaveBeenCalledWith('sess1', { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  });

  it("a rep who never touches the settings sends Twice / All / Next business day — today's run", async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    const start = vi.spyOn(dialerApi, 'startDialerRun').mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Start dialing' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('sess1', { passes: 2, maxRecords: null, rolloverBusinessDays: 1 }));
  });

  it('a refused Start (409) saved nothing, so App is not told to re-read', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    vi.spyOn(dialerApi, 'startDialerRun').mockRejectedValue(
      new ApiError(409, { error: 'Another power-dial run of yours is still live — stop it first.', activeSessionId: null }),
    );
    const saved = vi.fn();
    mount({ onRunDefaultsSaved: saved });
    fireEvent.click(await screen.findByRole('button', { name: 'Start dialing' }));
    expect(await screen.findByText('Another power-dial run of yours is still live — stop it first.')).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
  });

  it('a running run shows its settings under the progress', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue({
      ...READY,
      session: { id: 'sess1', status: 'active', passes: 1, maxRecords: 100, rolloverBusinessDays: 1 },
      counts: { total: 100, done: 3, connected: 0, noConnect: 3, skipped: 0, unreachable: 0, pending: 97 },
      firstPassTotal: 100,
      skipBreakdown: {},
    });
    mount();
    expect(await screen.findByText('Once · first 100 · missed → next business day')).toBeTruthy();
  });
});
```

- [ ] **Step 19: Run it to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/components/DialerPanel.run-settings.test.tsx`
Expected: FAIL.
- `runDefaults` is ignored, so Twice is pressed.
- Typing never changes "N will be dialed", because ConfirmBlock gets no `onDraftChange`.
- `startDialerRun` is never called, because Start still sends a bare `start`.
- There is no run line.

- [ ] **Step 20: Implement the panel wiring**. In `apps/cti-web/src/components/DialerPanel.tsx`:

In `DialerPanelProps`, replace

```tsx
  popLedger?: MutableRefObject<PopLedger>;
}
```

with

```tsx
  popLedger?: MutableRefObject<PopLedger>;
  /** The rep's saved run settings (`/auth/me` `dialerRunDefaults`, via
   *  `runDefaultsFromMe` in App.tsx) — what Ready to dial starts from. Absent:
   *  today's run (Twice, next business day). */
  runDefaults?: DialerRunDefaults;
  /** Called once a Start the server accepted has saved the choices, so App can
   *  re-read `/auth/me` and the next run starts from them. */
  onRunDefaultsSaved?: () => void;
}
```

Replace

```tsx
    lineAudio, onRunSnapshot, callback, needsRejoin, onRejoin, popLedger: sharedPopLedger,
  } = props;
```

with

```tsx
    lineAudio, onRunSnapshot, callback, needsRejoin, onRejoin, popLedger: sharedPopLedger,
    runDefaults, onRunDefaultsSaved,
  } = props;
```

Replace

```tsx
  // Ticks every second so the retry countdown re-renders without waiting on
  // the ~2 s (1 s while a dial is ringing) poll.
  const [now, setNow] = useState(() => Date.now());
```

with

```tsx
  // Ticks every second so the retry countdown re-renders without waiting on
  // the ~2 s (1 s while a dial is ringing) poll.
  const [now, setNow] = useState(() => Date.now());
  // The Ready-to-dial choices (spec 2026-09-28). Re-seeded from the rep's saved
  // defaults for every new run (the per-session effect below), read through a
  // ref so an `/auth/me` refresh mid-choice never overwrites what the rep picked.
  const runDefaultsRef = useRef(runDefaults);
  runDefaultsRef.current = runDefaults;
  const [runDraft, setRunDraft] = useState<RunDraft>(() => draftFromDefaults(runDefaults ?? DEFAULT_DIALER_RUN_DEFAULTS));
```

Replace

```tsx
    pollNowRef.current = () => {};
    completedRef.current = false;
    firstTerminalAtRef.current = null;
    stopRequestedRef.current = false;
```

with

```tsx
    pollNowRef.current = () => {};
    completedRef.current = false;
    firstTerminalAtRef.current = null;
    stopRequestedRef.current = false;
    setRunDraft(draftFromDefaults(runDefaultsRef.current ?? DEFAULT_DIALER_RUN_DEFAULTS));
```

Replace the whole `handleStartDialing` block, from its leading comment to the end of the `useCallback`:

```tsx
  // Start dialing: ready the softphone (onPrepare), send `start`, THEN join the
  // conference (onJoin) — see startDialingSequence for why that order and no
  // other. busy covers the whole sequence so the button cannot double-fire; a
  // superseded join sends nothing and shows nothing — the rep chose to leave.
  const handleStartDialing = useCallback(() => {
    if (!sessionId) return;
    // Synchronously, before the first await: from the click on, a reset waits.
    onStartingChange?.(true);
    void (async () => {
      setControlBusy(true);
      setControlError(null);
      setConflictSessionId(null);
      try {
        // On success ('started' or 'superseded') there is nothing to show here —
        // the run screen takes over on the next poll, or the rep already left.
        await startDialingSequence(onPrepare, async (action) => {
          await dialerControl(sessionId, action);
          pollNowRef.current();
        }, onJoin);
      } catch (e: unknown) {
        setControlError(controlErrorMessage(e, 'Could not start the run.'));
        setConflictSessionId(conflictingSessionId(e));
      } finally {
        setControlBusy(false);
        onStartingChange?.(false);
      }
    })();
  }, [onPrepare, onJoin, onStartingChange, sessionId]);
```

with

```tsx
  // Start dialing: ready the softphone (onPrepare), send `start` WITH the run
  // settings (spec 2026-09-28), THEN join the conference (onJoin) — see
  // startDialingSequence for why that order and no other. busy covers the whole
  // sequence so the button cannot double-fire; a superseded join sends nothing
  // and shows nothing — the rep chose to leave. Once the server has accepted
  // `start` it has also saved Calls per person / Missed tasks as the rep's
  // defaults, so App re-reads them (a refused Start saved nothing).
  const handleStartDialing = useCallback(() => {
    if (!sessionId || !view) return;
    const settings = runSettingsFor(runDraft, view.firstPassTotal ?? view.counts.total);
    if (!settings) return; // the box holds something Start must not send — the button is disabled too
    // Synchronously, before the first await: from the click on, a reset waits.
    onStartingChange?.(true);
    void (async () => {
      setControlBusy(true);
      setControlError(null);
      setConflictSessionId(null);
      let startAccepted = false;
      try {
        // On success ('started' or 'superseded') there is nothing to show here —
        // the run screen takes over on the next poll, or the rep already left.
        await startDialingSequence(onPrepare, async (action) => {
          if (action === 'start') {
            await startDialerRun(sessionId, settings);
            startAccepted = true;
          } else {
            await dialerControl(sessionId, action);
          }
          pollNowRef.current();
        }, onJoin);
      } catch (e: unknown) {
        setControlError(controlErrorMessage(e, 'Could not start the run.'));
        setConflictSessionId(conflictingSessionId(e));
      } finally {
        setControlBusy(false);
        onStartingChange?.(false);
        if (startAccepted) onRunDefaultsSaved?.();
      }
    })();
  }, [onPrepare, onJoin, onStartingChange, onRunDefaultsSaved, sessionId, view, runDraft]);
```

Replace

```tsx
        onStartDialing={handleStartDialing}
        onChooseAnother={handleStop}
        onStopOther={conflictSessionId ? handleStopOther : undefined}
      />
```

with

```tsx
        onStartDialing={handleStartDialing}
        onChooseAnother={handleStop}
        onStopOther={conflictSessionId ? handleStopOther : undefined}
        draft={runDraft}
        onDraftChange={setRunDraft}
      />
```

Replace

```tsx
  const isTerminal = TERMINAL_STATUSES.has(view.session.status);
```

with

```tsx
  const isTerminal = TERMINAL_STATUSES.has(view.session.status);
  // The choices this run started with (spec 2026-09-28), under the progress.
  const settingsLine = runSettingsLine(view.session);
```

Replace

```tsx
        <div className="meterbar tall">
          <div className="meterfill" style={{ width: `${pct}%` }} />
        </div>
      </div>
```

with

```tsx
        <div className="meterbar tall">
          <div className="meterfill" style={{ width: `${pct}%` }} />
        </div>
        {settingsLine && <div className="dp-queue-line dp-run-line">{settingsLine}</div>}
      </div>
```

Replace

```tsx
      {view.currentItem && <CurrentRecord item={view.currentItem} listTotal={view.listContext?.total ?? null} />}
```

with

```tsx
      {view.currentItem && (
        <CurrentRecord
          item={view.currentItem}
          listTotal={view.listContext?.total ?? null}
          runSize={view.session.maxRecords != null ? (view.firstPassTotal ?? null) : null}
        />
      )}
```

- [ ] **Step 21: Run it to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/components/DialerPanel.run-settings.test.tsx src/components/DialerPanel.test.tsx src/components/DialerPanel.poll.test.tsx src/components/DialerPanel.callback.test.tsx`
Expected: PASS for all four files.

- [ ] **Step 22: Commit**

```bash
git add apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/components/DialerPanel.test.tsx apps/cti-web/src/components/DialerPanel.run-settings.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Ready-to-dial run settings, Start body, run line, limited-run record count

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 23: Wire App and the styles**. In `apps/cti-web/src/App.tsx`:

Replace

```tsx
import type { HoldMusicSetting } from '@cti/contracts';
```

with

```tsx
import type { DialerRunDefaults, HoldMusicSetting } from '@cti/contracts';
```

Replace

```tsx
import { holdMusicFromMe } from './hold-music-from-me';
```

with

```tsx
import { holdMusicFromMe } from './hold-music-from-me';
import { runDefaultsFromMe } from './run-settings';
```

In `MeResponse`, replace

```tsx
    dialerHoldMusic?: boolean;
    holdMusic?: HoldMusicSetting;
```

with

```tsx
    dialerHoldMusic?: boolean;
    holdMusic?: HoldMusicSetting;
    /** Power Dial run settings the rep last started with (spec 2026-09-28).
     *  Absent from an older API — `runDefaultsFromMe` reads that as today's run. */
    dialerRunDefaults?: DialerRunDefaults;
```

In the `<DialerPanel …>` element, replace

```tsx
      holdMusic={holdMusicFromMe(me.user)}
      lineAudio={lineAudio}
```

with

```tsx
      holdMusic={holdMusicFromMe(me.user)}
      lineAudio={lineAudio}
      runDefaults={runDefaultsFromMe(me.user)}
      onRunDefaultsSaved={refreshMe}
```

In `apps/cti-web/src/styles.css`, replace

```css
.dp-summary-cta { margin-top: 16px; }
```

with

```css
.dp-summary-cta { margin-top: 16px; }
/* Run settings on Ready to dial (spec 2026-09-28). */
.dp-run-settings-block { display: flex; flex-direction: column; gap: 10px; }
.dp-setting { display: flex; flex-direction: column; gap: 6px; }
.dp-setting-label { font-size: 11px; font-weight: 600; color: var(--text-muted); }
.dp-setting-choices { gap: 8px; }
.dp-setting-choices .btn { flex: 1; font-size: 12px; }
.dp-setting-howmany { gap: 6px; font-size: 12px; color: var(--text); }
.dp-how-many-input {
  width: 64px;
  padding: 6px 8px;
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--hairline);
  border-radius: var(--r-sm);
  font-variant-numeric: tabular-nums;
}
.dp-how-many-input[aria-invalid="true"] { border-color: var(--bad); }
.dp-run-line { margin-top: 6px; }
```

- [ ] **Step 24: Full verification for Task 2**

Run: `npm run build:packages && npm -w apps/cti-web run typecheck && npm -w apps/cti-web test && npm -w apps/cti-web run build`
Expected:
- the typecheck exits 0;
- every web test passes, including every `App.*.test.tsx`: after a Start they now also see one `/auth/me` re-read, which their fake fetch already answers;
- `vite build` finishes without errors.

- [ ] **Step 25: Commit**

```bash
git add apps/cti-web/src/App.tsx apps/cti-web/src/styles.css
git commit -m "$(cat <<'EOF'
feat(web): Ready-to-dial starts from /auth/me run defaults; refresh after Start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Docs — the dialer-cadence runbook section and the rep-guide paragraph (unpublished)

**Files:**
- Modify: `docs/runbooks/dialer-cadence.md` (the two rules-table rows, lines 12–13; a new section before `## SQL`)
- Modify, outside the repo and **not published**: `~/Documents/gg-guides-site/public/power-dial.html` (lines 340, 372, 387, 410, 451)

**Interfaces:**
- Consumes (Tasks 1–2): the column names (`dialer_sessions.passes | max_records | rollover_business_days`, `users.dialer_passes | dialer_rollover_business_days`, `followup_rollover_jobs.business_days`), `claimReadySession`, `run-settings.ts`, `CLICK_TO_DIAL_ROLLOVER_MISSES`, `rolloverBase` / `firstLandingDay`, `GET /auth/me` `dialerRunDefaults`, and the exact rep-facing strings in Global Constraints.
- Produces: operator and rep documentation only.

- [ ] **Step 1: Update the runbook's rules table**. In `docs/runbooks/dialer-cadence.md`, replace

```markdown
| Follow-up rollover: the task owner's 2nd dial of the org day that doesn't connect rolls the follow-up to the next business day. It counts power dial and click-to-dial, but only the owner's own dials. A Skip does not count. | `dialer/contact-history.ts` `rolloverDue`; `salesforce/sync.ts` hook | 2 per LA day |
| One number per pass: attempt 1 dials the lead number and the other is tried once, at the end-of-run retry. A number the person once answered on leads, and the other is never dialed. | `dialer/create-session.ts` | — |
```

with

```markdown
| Follow-up rollover: the task owner's Nth dial of the org day that doesn't connect rolls the follow-up. For a power-dial miss N is the run's Calls per person (Once = 1st, Twice = 2nd); for click-to-dial it is always 2. It counts power dial and click-to-dial, but only the owner's own dials. A Skip does not count. Where it lands: see Run settings below. | `dialer/contact-history.ts` `rolloverDue`; `salesforce/sync.ts` hook (`CLICK_TO_DIAL_ROLLOVER_MISSES`) | 1 or 2 per LA day |
| One number per pass: attempt 1 dials the lead number and the other is tried once, at the end-of-run retry (Twice runs only; a Once run has no retry). A number the person once answered on leads, and the other is never dialed. | `dialer/create-session.ts` | — |
```

- [ ] **Step 2: Add the Run settings section**. In the same file, directly before the line `## SQL (read-only; use the `$PUB` pattern from the number-fleet runbook)`, insert:

````markdown
## Run settings (Ready to dial)

Spec: `docs/superpowers/specs/2026-09-28-run-settings-design.md`. Three choices sit above **Start dialing**. They arrive with `POST /dialer/sessions/:id/start` and are applied in the one transaction that flips the run `ready → active` (`dialer/engine.ts` `claimReadySession`, `dialer/run-settings.ts`). A refused Start (another run holds the one-active-run slot) changes nothing.

| Setting | Values | Stored on | What it changes |
|---|---|---|---|
| Calls per person | Once · Twice (default) | `dialer_sessions.passes` (1/2) | Once: no end-of-run retry, and a follow-up rolls on the owner's 1st non-connect of the day. Twice: today's single retry, and it rolls on the 2nd. |
| How many | All (default) · first N | `dialer_sessions.max_records` (NULL = all) | At Start the queue is cut after the N-th dialable (`pending`) row, and every row after it is deleted. Rows the build already settled (no number, flag, consent, called in the last 3 h) don't count toward N. The panel then reads "record X of N" from the run's own queue. |
| Missed tasks move to | Next business day (default) · In 2 business days | `dialer_sessions.rollover_business_days` (1/2) → `followup_rollover_jobs.business_days` | The copy lands 1 or 2 business days after the LATER of the dial day (`from_date`) and the task's own due date. Then the 100/day cap pushes it on as before. `next_day` is that uncapped day. |

- Starting saves Calls per person and Missed tasks to `users.dialer_passes` and `users.dialer_rollover_business_days`, and `GET /auth/me` returns them as `dialerRunDefaults`. How many is never saved, because it depends on the list.
- Click-to-dial keeps the 2-miss rule and lands where the rep's saved Missed-tasks choice says.
- A Start with no body (a tab from before this release) is today's run: Twice, All, next business day. Nothing is saved.
- Unchanged:
  - nothing rolls for a person reached today;
  - Skip, Stop and a take-callback cancel are not non-connects;
  - one rollover per person per day;
  - the 3 h courtesy, the state-law cap and the per-customer ceiling;
  - the 100/day cap and the 30-business-day bound.

  A redial copy never gets its own retry.
- Known edges:
  - The shared list position is the furthest `list_position` DIALED on the list in 12 h. After a full first-N run, the next run starts at N+1, and a run stopped early resumes where it stopped. A run that wraps past the end of the list sets the position to the last record, so the next run starts at the top. Anyone called in the last 3 h is skipped there anyway.
  - A rolled task's same-day siblings are still matched on the dial day, not on the template's due date.
  - The run summary still says "moved to tomorrow" whatever the choice.

A run's settings, and what its rollovers did:
```sql
SELECT s.id, s.passes, s.max_records, s.rollover_business_days, s.status, s.created_at
  FROM dialer_sessions s WHERE s.id = '<uuid>';

SELECT j.record_id, j.from_date, j.business_days, j.next_day, j.target_date, j.status, j.last_error
  FROM followup_rollover_jobs j WHERE j.session_id = '<uuid>' ORDER BY j.created_at;
```

A rep's saved choices:
```sql
SELECT email, dialer_passes, dialer_rollover_business_days FROM users WHERE email = '<rep email>';
```

````

- [ ] **Step 3: Verify, and commit**

Run: `grep -n "## Run settings (Ready to dial)\|CLICK_TO_DIAL_ROLLOVER_MISSES\|1 or 2 per LA day" docs/runbooks/dialer-cadence.md`
Expected: two matching lines. One is the rollover row (~line 12), which carries both `CLICK_TO_DIAL_ROLLOVER_MISSES` and `1 or 2 per LA day`. The other is the new section heading.

```bash
git add docs/runbooks/dialer-cadence.md
git commit -m "$(cat <<'EOF'
docs(runbook): power-dial run settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Edit the rep guide, locally only**. This file is outside the repo and not in git. **Do not publish it**: no tar, no gHost `ship`, until the user OKs it. In `~/Documents/gg-guides-site/public/power-dial.html`, make these exact replacements with the Edit tool. The file carries large inline images, so never rewrite it whole.

Step 5 of the guide (line 340). Replace

```html
      <p class="step-desc">Tap <span class="kbd primary">Start dialing</span> to begin. Wrong list? <span class="kbd">Choose a different list</span> takes you back to the picker and nothing is dialed.</p>
```

with

```html
      <p class="step-desc">Above <span class="kbd primary">Start dialing</span> are three choices. <strong>Calls per person</strong>: <span class="kbd">Twice</span> tries everyone you missed once more at the end of the run; <span class="kbd">Once</span> calls each person one time and the run is done. With Once, a missed person's follow-up moves after that one call; with Twice, after the second. <strong>How many</strong>: leave the box blank to call the whole list, or type a number to call only the next that many people. The next run on the same list picks up after them. <strong>Missed tasks move to</strong>: <span class="kbd">Next business day</span> or <span class="kbd">In 2 business days</span>, counted from the task's due date when that is later than today. Your Calls per person and Missed tasks choices are kept for your next run.</p>
      <p class="step-desc">Tap <span class="kbd primary">Start dialing</span> to begin. Wrong list? <span class="kbd">Choose a different list</span> takes you back to the picker and nothing is dialed.</p>
```

Step 7 (line 372). Replace

```html
      <p class="step-desc">A missed record is tried once more, five minutes later. <strong>Next retry in 4:43</strong> means the dialer is waiting for that window, not stuck.</p>
```

with

```html
      <p class="step-desc">With <strong>Twice</strong>, a missed record is tried once more, at least five minutes after the first try. <strong>Next retry in 4:43</strong> means the dialer is waiting for that window, not stuck. The line under the progress, for example <strong>Once · first 100 · missed → next business day</strong>, shows the choices this run started with.</p>
```

Step 8 (line 387). Replace

```html
Follow-up tasks for records you did not reach are moved to the next business day for you.</p>
```

with

```html
Follow-up tasks for records you did not reach are moved to the day you picked under <strong>Missed tasks move to</strong>.</p>
```

The table (line 410). Replace

```html
          <tr><td>Next retry in 4:43</td><td>Missed records get one more try, five minutes after the first. The run waits for that window.</td></tr>
```

with

```html
          <tr><td>Next retry in 4:43</td><td>With Twice, missed records get one more try, five minutes after the first. The run waits for that window.</td></tr>
          <tr><td>Once · first 100 · missed → next business day</td><td>The choices this run started with: calls per person, how many, and where missed tasks go.</td></tr>
```

Good to know (line 451). Replace

```html
      <li>Records that did not connect keep their follow-up task; the dialer moves it to the next business day.</li>
```

with

```html
      <li>Records that did not connect keep their follow-up task; the dialer moves it to the next business day, or two business days out if you picked that. A task due later than today moves from its due date, not from today.</li>
```

- [ ] **Step 5: Verify the guide, and hand it back unpublished**

Run: `grep -c "Calls per person\|Missed tasks move to" ~/Documents/gg-guides-site/public/power-dial.html`
Expected: `2`. That's the new Step 5 paragraph (one line, both phrases) and the Step 8 line. Don't commit anything for this file, because it isn't in git. Tell the user that the guide is edited but unpublished, and that the Step 5 screenshot still shows the old Ready screen without the settings.

---

## Self-review (run by the plan author)

- **Spec coverage:**
  - Settings on the Ready screen: Task 2, Steps 9–21.
  - Remembered choices: Task 1 Parts E and G, Task 2 Step 23.
  - "N will be dialed" is live: Task 2, Steps 14 and 18.
  - Box from 1 to the list size: `parseHowMany`.
  - Saved on Start: Part E.
  - The run line: Task 2, Step 20.
  - "Missed tasks" always shown: `RunSettingsBlock`.
  - Once or Twice for the requeue and the rollover: Part D.
  - Unchanged guards: the Part D truth table, plus untouched code.
  - Click-to-dial rule and saved choice: Part D (d).
  - Landing base and N-th business day, with the cap and bound: Part F.
  - How many against the list position and filters: Part E, plus decisions 7–8.
  - Migration 0046 with CHECKs and defaults: Part B.
  - Validation 400s: Part G.
  - `/auth/me`: Part G.
  - Pinned SQL (claim, trim, defaults, saved read, job insert, migration): Parts B, C and D.
  - Web tests: Task 2.
  - Docs: Task 3.
- **Placeholder scan:** no TBD/TODO. Every code step carries its full code and every run step its command and expected result.
- **Dry run:** every code block in this plan was applied mechanically, in order, to a scratch `git archive` copy of `831ad1d`, and every replacement anchor matched exactly once. The result:
  - API: 84 files / 1779 tests pass.
  - Web: 54 files / 854 tests pass.
  - db: 39 tests pass. Contracts: 53 tests pass.
  - Both typechecks exit 0, and `vite build` succeeds.

  That run surfaced two fixes, both folded in: the fully typed session fixture in `no-answer-chatter-worker.test.ts` (Part B), and a typed `countOn` mock in `followup-day.test.ts`. The migration was also applied twice to a throwaway Postgres 14.
- **Type consistency:**
  - `DialerRunSettings`, `DialerPasses` and `RolloverBusinessDays` come from `@cti/contracts` everywhere.
  - The schema's `$type<1 | 2>()` is structurally the same type.
  - `RolloverEnqueue.businessDays` is set in both `engine.ts` and `sync.ts`.
  - `startSession(sessionId, deps, settings)` matches the route's `run.settings`.
  - `pickRolloverDay({ businessDays })` matches the worker.
  - The web's `startDialerRun(id, settings)` matches `DialerPanel`, and the `RunDraft` fields match across `run-settings.ts`, `RunSettingsBlock` and `ConfirmBlock`.
