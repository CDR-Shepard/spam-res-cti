# Talk-Time Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track every rep's talk time (click-to-dial, power dial, answered inbound) and their time on the power dialer. Show it in an admin-only CTI report by date range, one row per rep. Make the reps' Salesforce talk-time report carry true talk time.

**Architecture:**
- True talk time for regular calls goes into a NEW column, `calls.talk_seconds`. It is written only from Twilio durations that measure the customer's connected line. `calls.duration_seconds` is not touched, because the reputation engine reads it.
- Time on the dialer goes into a new table, `dialer_rep_legs`: one row per rep conference leg, stamped at the join and at the leg's end, with a Twilio reconcile loop as the backstop.
- A pure report module buckets everything into the org's Pacific days.
- An admin route serves the report.
- A softphone screen shows it.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM 0.36 (Postgres, hand-written SQL migrations), vitest, React (cti-web), Twilio Node SDK.

**Spec:** `docs/superpowers/specs/2026-10-01-talk-time-report-design.md`.

**Ships with:** `docs/superpowers/plans/2026-10-01-power-dialer-recording.md` (same branch). This plan reads that feature's `dialer_connects` table (migration 0047) and `services/cti-api/src/dialer/connect-log.ts`.

## Global Constraints

### Where and how to work
- **Work only in the worktree** `/Users/cdrshepard/spam-res-cti-dialer-rec` on branch `feat/dialer-recording`. NEVER edit `/Users/cdrshepard/spam-res-cti`.
- **Pushing `main` deploys to production.** No push, merge, or deploy without the user's explicit go-ahead.
- **Commits:** conventional (`feat:`, `fix:`, `test:`, `docs:` …), each ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Logging:** never log phone numbers, recording URLs, or Salesforce tokens. Log ids only.

### What must not change
- `calls.duration_seconds`, every reader of it (reputation signals, the firewall, the Recent list, `routes/calls.ts`, `/admin/calls/reconcile-durations`) and every compliance counter are **not modified**.
- True talk time goes **only** into the new `calls.talk_seconds`.

### The `talk_seconds` rule
- **`<Dial action>`** (`DialCallStatus` present): written **unconditionally**. The value is `DialCallDuration` when `DialCallStatus` is `completed` or `answered`, else `0`.
- **The dialed child leg's own status callback** (`ParentCallSid` present): written **only while `talk_seconds` IS NULL**. The value is its `CallDuration` on `completed`, or `0` when it ended `busy`/`no-answer`/`failed`/`canceled`.
- **The rep's own (parent) leg callback:** never writes it.
- **Inbound answered** (`/telephony/twilio/inbound/dial-result`, `DialCallStatus=completed`): `DialCallDuration`.

### Salesforce Task duration
- The Salesforce Task's Call Duration = `talk_seconds ?? duration_seconds` at sync time.
- Past Tasks are not rewritten.

### What counts in the report
- **Days** are the org's America/Los_Angeles days (`ORG_TIMEZONE`). Day boundaries come from `orgMidnightUtc` (DST-safe).
- **Which day a call belongs to:** the day it started. For regular calls that is `coalesce(started_at, created_at)`; for power dial it is `bridged_at`.
- **Counted calls:**
  - outbound: `disposition = 'Connected'`;
  - inbound: `status = 'completed' AND answered_at IS NOT NULL AND inbound_voicemail_url IS NULL`;
  - power dial: every `dialer_connects` row (`talk_seconds` NULL → 0).
- **Talk seconds per regular call:** `coalesce(talk_seconds, duration_seconds, 0)`.

### `dialer_rep_legs`
- Migration `0048_talk_time.sql`. FK-free.
- `call_sid` has a FULL unique index, and inserts use a bare `ON CONFLICT DO NOTHING`.
- The end is stamped **once** (`ended_at IS NULL` guard).
- `end_source` ∈ `rep_left` | `run_end` | `replaced` | `reconciled` | `fallback`.

### Time on the dialer
- A leg runs from `joined_at` to `ended_at`. An open leg runs to now.
- A leg is split across the days it spans.
- A rep's overlapping legs are counted **once** (union of intervals).

### Reconcile loop
- Runs every **5 min**, on up to **25** open legs, oldest first.
- **Twilio says the leg has ended:** end = Twilio `endTime`, else `startTime + duration`, else `joined_at`; `end_source = 'reconciled'`.
- **The Twilio fetch fails:**
  - leg joined less than **48 h** ago: retry on the next tick;
  - otherwise: end = `joined_at + 12 h`, `end_source = 'fallback'`, logged.

### Leg bookkeeping is best-effort
- It never blocks a join, delays a rejoin answer past its deadline, or fails a run's end.
- It never throws.

### API
- `GET /admin/talk-time?from=YYYY-MM-DD&to=YYYY-MM-DD`.
- 401 without a session; 403 for non-admins; 400 for a malformed date, `from > to`, or more than **92** days inclusive.
- Org-scoped.

### UI
- An admin-only **Talk time** screen in the More overflow, right after Team.
- Durations render as `h:mm:ss`.
- Shortcuts: Today / This week (Monday–today, Pacific) / Last 7 days.

## File Map

| File | Change | Responsibility |
|---|---|---|
| `packages/db/migrations/0048_talk_time.sql` | create | `calls.talk_seconds`; `dialer_rep_legs` |
| `packages/db/src/schema.ts` | modify | `calls.talkSeconds`; `dialerRepLegs`, `DIALER_REP_LEG_END_SOURCES` |
| `packages/db/src/index.ts` | modify | export `DialerRepLeg`, `DialerRepLegEndSource` |
| `packages/db/src/migration-0048.test.ts` | create | pins the SQL |
| `services/cti-api/src/telephony/talk-seconds.ts` | create | the rule (pure) + the conditional write |
| `services/cti-api/src/routes/telephony.ts` | modify | status route: talk time, rep-leg end; voice route: leg join; rejoin route: leg end; replaced leg |
| `services/cti-api/src/routes/telephony-status-talk-time.test.ts` | create | status-route wiring |
| `services/cti-api/src/routes/inbound.ts` | modify | inbound answered → `talkSeconds` |
| `services/cti-api/src/salesforce/sync.ts` | modify | Task Call Duration = `talkSeconds ?? durationSeconds` |
| `services/cti-api/src/dialer/rep-legs.ts` | create | leg join / end statements, best-effort writers |
| `services/cti-api/src/dialer/engine.ts` | modify | `EngineDeps.onRepLegReleased`, called by `releaseRepConference` |
| `services/cti-api/src/dialer/live-deps.ts` | modify | wires `onRepLegReleased` |
| `services/cti-api/src/dialer/twilio-telephony.ts` | modify | `calls(sid).fetch` on the client port; `callEndFrom`; `callEnd` |
| `services/cti-api/src/dialer/rep-leg-reconcile.ts` | create | the reconcile pass + loop |
| `services/cti-api/src/reports/talk-time.ts` | create | range, days, leg union/split, report assembly (pure) |
| `services/cti-api/src/reports/talk-time-query.ts` | create | the SQL + loaders |
| `services/cti-api/src/routes/admin-talk-time.ts` | create | `GET /admin/talk-time` |
| `services/cti-api/src/server.ts` | modify | register the route; start/stop the reconcile loop |
| `apps/cti-web/src/nav.ts` | modify | `talktime` tab |
| `apps/cti-web/src/talk-time-api.ts` | create | client + types |
| `apps/cti-web/src/talk-time-format.ts` | create | `h:mm:ss`, Pacific today, shortcuts, day label |
| `apps/cti-web/src/components/TalkTimePanel.tsx` | create | the screen |
| `apps/cti-web/src/App.tsx` | modify | render the screen |
| `docs/runbooks/talk-time-report.md` | create | how to read it, limits, checks |

Test files sit beside their modules (`*.test.ts` / `*.test.tsx`).

---

### Task 1: Migration 0048 + schema

**Files:**
- Create: `packages/db/migrations/0048_talk_time.sql`
- Modify: `packages/db/src/schema.ts`, `packages/db/src/index.ts`
- Test: `packages/db/src/migration-0048.test.ts`

**Interfaces:**
- Produces:
  - `schema.calls.talkSeconds` (`integer('talk_seconds')`, nullable);
  - `schema.dialerRepLegs` with columns `id`, `orgId`, `userId`, `sessionId`, `callSid`, `joinedAt`, `endedAt`, `endSource`, `createdAt`, `updatedAt`;
  - `DIALER_REP_LEG_END_SOURCES = ['rep_left', 'run_end', 'replaced', 'reconciled', 'fallback'] as const`;
  - `type DialerRepLegEndSource`;
  - `type DialerRepLeg = typeof dialerRepLegs.$inferSelect`.
- Both types are exported from `@cti/db`.

- [ ] **Step 1: Write the failing test** — `packages/db/src/migration-0048.test.ts`

```ts
/**
 * 0048_talk_time.sql — calls.talk_seconds + dialer_rep_legs, pinned.
 *
 * Read from disk rather than applied (no database in the unit suite), so the
 * file's text IS the contract. Load-bearing: talk time is a NEW column —
 * duration_seconds is untouched because the reputation engine reads it — and
 * dialer_rep_legs has a FULL unique index on call_sid, which
 * dialer/rep-legs.ts's bare ON CONFLICT DO NOTHING needs (a PARTIAL one fails
 * every insert with 42P10).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DIALER_REP_LEG_END_SOURCES, calls, dialerRepLegs } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0048_talk_time.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0048_talk_time', () => {
  it('adds calls.talk_seconds idempotently and touches no other calls column', () => {
    expect(statements.filter((s) => s.startsWith('ALTER TABLE'))).toEqual([
      'ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "talk_seconds" integer',
    ]);
    expect(statements.join(' ')).not.toContain('duration_seconds');
  });

  it('creates dialer_rep_legs idempotently with every column, FK-free', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "dialer_rep_legs" \(/);
    for (const col of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"org_id" uuid NOT NULL',
      '"user_id" uuid NOT NULL',
      '"session_id" uuid NOT NULL',
      '"call_sid" text NOT NULL',
      '"joined_at" timestamptz NOT NULL DEFAULT now()',
      '"ended_at" timestamptz',
      '"end_source" text',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(col);
    }
    expect(create).not.toContain('REFERENCES');
  });

  it('CHECKs end_source against exactly the schema constant, NULL while the leg is open', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'))!;
    const list = DIALER_REP_LEG_END_SOURCES.map((x) => `'${x}'`).join(',');
    expect(create).toContain(
      `CONSTRAINT "dialer_rep_legs_end_source_check" CHECK ("end_source" IS NULL OR "end_source" IN (${list}))`,
    );
  });

  it('call_sid has a FULL unique index (no WHERE) — the bare ON CONFLICT arbiter', () => {
    expect(statements).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dialer_rep_legs_call_sid_unique" ON "dialer_rep_legs" ("call_sid")',
    );
  });

  it('indexes the report scan (org_id, joined_at)', () => {
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS "dialer_rep_legs_org_joined_idx" ON "dialer_rep_legs" ("org_id", "joined_at")',
    );
  });

  it('the drizzle tables match: same names, same indexes, no foreign keys, a nullable integer talk_seconds', () => {
    const cfg = getTableConfig(dialerRepLegs);
    expect(cfg.name).toBe('dialer_rep_legs');
    expect(cfg.foreignKeys).toHaveLength(0);
    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([
      'dialer_rep_legs_call_sid_unique',
      'dialer_rep_legs_org_joined_idx',
    ]);
    const unique = cfg.indexes.find((i) => i.config.name === 'dialer_rep_legs_call_sid_unique')!;
    expect(unique.config.unique).toBe(true);
    expect(unique.config.where).toBeUndefined();
    const talk = getTableConfig(calls).columns.find((c) => c.name === 'talk_seconds');
    expect(talk?.columnType).toBe('PgInteger');
    expect(talk?.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/packages/db && npx vitest run src/migration-0048.test.ts`
Expected: FAIL — `ENOENT … 0048_talk_time.sql` (and the schema imports do not exist yet).

- [ ] **Step 3: Write the migration** — `packages/db/migrations/0048_talk_time.sql`

```sql
-- =============================================================================
-- 0048_talk_time.sql — the talk-time report
-- (design: docs/superpowers/specs/2026-10-01-talk-time-report-design.md).
--
-- calls.talk_seconds  TRUE talk time of a regular call: the customer's
--                     connected line only — the <Dial action>'s
--                     DialCallDuration, or the dialed leg's own CallDuration,
--                     and 0 when it was never answered. Written by
--                     telephony/talk-seconds.ts. calls.duration_seconds is left
--                     exactly as it was: the reputation engine (answer-rate
--                     floor, auto-pause) reads it. NULL on every older row.
--
-- dialer_rep_legs     One row per rep conference leg of the power dialer: how
--                     long the rep's line sat on the dialer (dialing, hold
--                     music and talking all count). Written by
--                     dialer/rep-legs.ts — the join (the voice route), the end
--                     (the leg's status callback, the rejoin route, the run's
--                     end, a newer leg replacing it) — and closed by
--                     dialer/rep-leg-reconcile.ts when every end was missed.
--                     FK-FREE like dialer_connects: report history outlives a
--                     run's cleanup.
--   call_sid          The rep leg. FULL unique index: the join inserts with a
--                     bare ON CONFLICT DO NOTHING, which a PARTIAL index
--                     cannot arbitrate (42P10).
--   ended_at          NULL while the leg is open; stamped once.
--   end_source        rep_left | run_end | replaced | reconciled | fallback.
-- =============================================================================

ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "talk_seconds" integer;

CREATE TABLE IF NOT EXISTS "dialer_rep_legs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "call_sid" text NOT NULL,
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  "end_source" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dialer_rep_legs_end_source_check" CHECK ("end_source" IS NULL OR "end_source" IN ('rep_left','run_end','replaced','reconciled','fallback'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "dialer_rep_legs_call_sid_unique" ON "dialer_rep_legs" ("call_sid");
CREATE INDEX IF NOT EXISTS "dialer_rep_legs_org_joined_idx" ON "dialer_rep_legs" ("org_id", "joined_at");
```

- [ ] **Step 4: Update the schema** — in `packages/db/src/schema.ts`:

  - In the `calls` table, directly after `durationSeconds: integer('duration_seconds'),` add:

```ts
    /** TRUE talk time (migration 0048): the customer's connected line only —
     *  the <Dial action>'s DialCallDuration or the dialed leg's own
     *  CallDuration, 0 when never answered (telephony/talk-seconds.ts).
     *  durationSeconds stays as it was: the reputation engine reads it.
     *  NULL on rows from before 0048. */
    talkSeconds: integer('talk_seconds'),
```

  - Directly after `export type DialerConnect = typeof dialerConnects.$inferSelect;` add:

```ts

/** Every end_source a dialer_rep_legs row can hold (migration 0048's CHECK). */
export const DIALER_REP_LEG_END_SOURCES = ['rep_left', 'run_end', 'replaced', 'reconciled', 'fallback'] as const;
export type DialerRepLegEndSource = (typeof DIALER_REP_LEG_END_SOURCES)[number];

/**
 * One row per rep conference leg of the power dialer (migration 0048): how long
 * the rep's line sat on the dialer — dialing, hold music and talking all count.
 * Written by dialer/rep-legs.ts, closed by dialer/rep-leg-reconcile.ts when
 * every end signal was missed, read by reports/talk-time-query.ts. FK-free.
 */
export const dialerRepLegs = pgTable(
  'dialer_rep_legs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    /** The rep leg. FULL unique index: the bare ON CONFLICT arbiter. */
    callSid: text('call_sid').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    /** NULL while the leg is open; stamped once. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endSource: text('end_source').$type<DialerRepLegEndSource>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // FULL, never partial: rep-legs.ts's bare ON CONFLICT DO NOTHING arbitrates on it.
    callSidUnique: uniqueIndex('dialer_rep_legs_call_sid_unique').on(t.callSid),
    orgJoinedIdx: index('dialer_rep_legs_org_joined_idx').on(t.orgId, t.joinedAt),
  }),
);
export type DialerRepLeg = typeof dialerRepLegs.$inferSelect;
```

  - In `packages/db/src/index.ts`'s explicit `export type { … }` list (alphabetical), add `DialerRepLeg,` and `DialerRepLegEndSource,` directly after `DialerHandoff,`.

- [ ] **Step 5: Run the db suite, typecheck, and rebuild** (`services/cti-api` reads `packages/db/dist`)

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/packages/db && npx vitest run && npm run typecheck && npm run build`
Expected: every test PASSES (the new file included); the typecheck is clean; the build emits `dist/`.

- [ ] **Step 6: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add packages/db/migrations/0048_talk_time.sql packages/db/src/schema.ts packages/db/src/index.ts packages/db/src/migration-0048.test.ts
git commit -m "feat(db): calls.talk_seconds + dialer_rep_legs (migration 0048) for the talk-time report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: True talk time on regular calls

**Files:**
- Create: `services/cti-api/src/telephony/talk-seconds.ts`, `services/cti-api/src/telephony/talk-seconds.test.ts`
- Create: `services/cti-api/src/routes/telephony-status-talk-time.test.ts`
- Modify:
  - `services/cti-api/src/routes/telephony.ts` (the `/telephony/twilio/status` handler)
  - `services/cti-api/src/routes/inbound.ts` (the dial-result answered branch)
  - `services/cti-api/src/salesforce/sync.ts` (the `createCallTask` call in `syncOne`)
- Modify tests: `services/cti-api/src/routes/inbound.test.ts`, `services/cti-api/src/salesforce/sync.test.ts`

**Interfaces:**
- Consumes: `schema.calls.talkSeconds` (Task 1).
- Produces:
  - `type TalkSecondsWrite = { mode: 'set'; seconds: number } | { mode: 'if_unset'; seconds: number }`;
  - `parseTwilioSeconds(raw: string | undefined): number | null`;
  - `talkSecondsWrite(body: Record<string, string | undefined>): TalkSecondsWrite | null`;
  - `applyTalkSeconds(db, callId: string, write: TalkSecondsWrite)` — a Drizzle update builder (awaitable; `.toSQL()` in tests).

- [ ] **Step 1: Write the failing unit tests** — `services/cti-api/src/telephony/talk-seconds.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { applyTalkSeconds, parseTwilioSeconds, talkSecondsWrite } from './talk-seconds.js';

const PARENT = `CA${'a'.repeat(32)}`;
const CHILD = `CA${'b'.repeat(32)}`;

describe('talkSecondsWrite — only durations that measure the connected line', () => {
  it('<Dial action>, connected: DialCallDuration, written unconditionally', () => {
    expect(talkSecondsWrite({ CallSid: PARENT, CallStatus: 'in-progress', DialCallStatus: 'completed', DialCallDuration: '37' }))
      .toEqual({ mode: 'set', seconds: 37 });
    expect(talkSecondsWrite({ CallSid: PARENT, DialCallStatus: 'answered', DialCallDuration: '12' }))
      .toEqual({ mode: 'set', seconds: 12 });
  });

  it('<Dial action>, never connected: 0 — ringing is not talk time', () => {
    for (const status of ['no-answer', 'busy', 'failed', 'canceled']) {
      expect(talkSecondsWrite({ CallSid: PARENT, DialCallStatus: status, DialCallDuration: '0' }))
        .toEqual({ mode: 'set', seconds: 0 });
    }
  });

  it('<Dial action>, connected but no usable duration: writes nothing', () => {
    expect(talkSecondsWrite({ CallSid: PARENT, DialCallStatus: 'completed' })).toBeNull();
    expect(talkSecondsWrite({ CallSid: PARENT, DialCallStatus: 'completed', DialCallDuration: 'abc' })).toBeNull();
  });

  it("the dialed leg's own completed callback: its CallDuration, only while nothing is there yet", () => {
    expect(talkSecondsWrite({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: 'completed', CallDuration: '41' }))
      .toEqual({ mode: 'if_unset', seconds: 41 });
  });

  it('a dialed leg that ended unanswered: 0, only while nothing is there yet', () => {
    for (const status of ['no-answer', 'busy', 'failed', 'canceled']) {
      expect(talkSecondsWrite({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: status }))
        .toEqual({ mode: 'if_unset', seconds: 0 });
    }
  });

  it("a dialed leg's non-final callback says nothing", () => {
    expect(talkSecondsWrite({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: 'ringing' })).toBeNull();
    expect(talkSecondsWrite({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: 'completed' })).toBeNull();
  });

  it("the rep's own (parent) leg callback NEVER writes — its CallDuration includes the ringing", () => {
    expect(talkSecondsWrite({ CallSid: PARENT, CallStatus: 'completed', CallDuration: '58' })).toBeNull();
  });
});

describe('parseTwilioSeconds', () => {
  it('accepts whole non-negative seconds only', () => {
    expect(parseTwilioSeconds('0')).toBe(0);
    expect(parseTwilioSeconds('17')).toBe(17);
    expect(parseTwilioSeconds(undefined)).toBeNull();
    expect(parseTwilioSeconds('')).toBeNull();
    expect(parseTwilioSeconds(' ')).toBeNull();
    expect(parseTwilioSeconds('-3')).toBeNull();
    expect(parseTwilioSeconds('1.5')).toBeNull();
    expect(parseTwilioSeconds('abc')).toBeNull();
  });
});

describe('applyTalkSeconds — the statement Postgres receives', () => {
  // No connection is opened — pg.Pool is lazy.
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('set: overwrites whatever is there (the <Dial action> is authoritative)', () => {
    const q = applyTalkSeconds(db, 'call-1', { mode: 'set', seconds: 37 }).toSQL();
    expect(q.sql).toContain('update "calls" set "talk_seconds" = $');
    expect(q.sql).not.toContain('is null');
    expect(q.params).toEqual(expect.arrayContaining([37, 'call-1']));
  });

  it('if_unset: only while talk_seconds is still NULL, so it never overrides the <Dial action>', () => {
    const q = applyTalkSeconds(db, 'call-1', { mode: 'if_unset', seconds: 41 }).toSQL();
    expect(q.sql).toContain('"calls"."talk_seconds" is null');
    expect(q.sql).toContain('"calls"."id" = $');
    expect(q.params).toEqual(expect.arrayContaining([41, 'call-1']));
  });
});
```

- [ ] **Step 2: Write the failing route-wiring test** — `services/cti-api/src/routes/telephony-status-talk-time.test.ts`

```ts
/**
 * POST /telephony/twilio/status writes TRUE talk time to calls.talk_seconds
 * (telephony/talk-seconds.ts) and leaves calls.duration_seconds on its old
 * last-write rule — the reputation engine reads that one. applyTalkSeconds is
 * replaced by a recorder (its SQL is pinned in talk-seconds.test.ts); the
 * rule itself runs for real. Harness idiom: telephony-status-ack.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  call: null as null | { id: string; orgId: string; fromNumber: string | null },
  sets: [] as Array<Record<string, unknown>>,
  talk: [] as Array<{ callId: string; write: unknown }>,
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ API_PUBLIC_URL: 'https://api.test', TWILIO_SKIP_SIGNATURE_CHECK: true }),
}));
vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({
    name: 'twilio',
    validateWebhook: () => ({ valid: true }),
    normalizeWebhook: (b: Record<string, unknown>) => {
      const raw = b.CallDuration ?? b.DialCallDuration;
      return {
        providerCallId: String(b.CallSid),
        status: 'completed',
        rawStatus: String(b.CallStatus ?? b.DialCallStatus ?? ''),
        durationSeconds: raw === undefined ? undefined : Number(raw),
        raw: b,
      };
    },
  }),
}));
vi.mock('../telephony/talk-seconds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telephony/talk-seconds.js')>()),
  applyTalkSeconds: async (_db: unknown, callId: string, write: unknown) => {
    state.talk.push({ callId, write });
  },
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => null,
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      insert: () => ({ values: async () => {} }),
      query: { calls: { findFirst: async () => state.call } },
      update: () => ({
        set: (v: Record<string, unknown>) => {
          state.sets.push(v);
          return { where: async () => {} };
        },
      }),
    }),
  };
});

import { registerTelephonyRoutes } from './telephony.js';

const PARENT = `CA${'a'.repeat(32)}`;
const CHILD = `CA${'b'.repeat(32)}`;
const CALL = { id: 'call-1', orgId: 'org-1', fromNumber: null };

let app: FastifyInstance;
beforeEach(async () => {
  state.call = CALL;
  state.sets = [];
  state.talk = [];
  app = Fastify();
  await registerTelephonyRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const post = (payload: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/telephony/twilio/status', payload });
const callUpdate = () => state.sets.find((s) => 'status' in s);

describe('POST /telephony/twilio/status — true talk time', () => {
  it('a <Dial action> for an unanswered dial writes talk time 0', async () => {
    const res = await post({ CallSid: PARENT, CallStatus: 'in-progress', DialCallStatus: 'no-answer', DialCallDuration: '0' });
    expect(res.statusCode).toBe(200);
    expect(state.talk).toEqual([{ callId: 'call-1', write: { mode: 'set', seconds: 0 } }]);
  });

  it('a connected <Dial action> writes DialCallDuration', async () => {
    await post({ CallSid: PARENT, CallStatus: 'in-progress', DialCallStatus: 'completed', DialCallDuration: '37' });
    expect(state.talk).toEqual([{ callId: 'call-1', write: { mode: 'set', seconds: 37 } }]);
  });

  it("the dialed leg's own callback (correlated by ParentCallSid) writes its CallDuration only if unset", async () => {
    await post({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: 'completed', CallDuration: '41' });
    expect(state.talk).toEqual([{ callId: 'call-1', write: { mode: 'if_unset', seconds: 41 } }]);
  });

  it("the rep leg's own completed callback writes NO talk time — and durationSeconds keeps its old rule (reputation reads it)", async () => {
    await post({ CallSid: PARENT, CallStatus: 'completed', CallDuration: '58' });
    expect(state.talk).toEqual([]);
    expect(callUpdate()).toMatchObject({ durationSeconds: 58 });
  });

  it('a callback that matches no call row writes no talk time', async () => {
    state.call = null;
    await post({ CallSid: PARENT, CallStatus: 'in-progress', DialCallStatus: 'completed', DialCallDuration: '37' });
    expect(state.talk).toEqual([]);
  });
});
```

- [ ] **Step 3: Add the failing inbound and sync tests**

In `services/cti-api/src/routes/inbound.test.ts`, inside `describe('POST /telephony/twilio/inbound/dial-result — answeredAt is the "rep picked up" signal', …)`, after the `'DialCallStatus=no-answer → nothing writes answeredAt …'` test, add:

```ts
  it('an answered inbound call stores its talk time (DialCallDuration) in talkSeconds too', async () => {
    await dialResult({ DialCallStatus: 'completed', DialCallDuration: '500' });
    const patch = state.updates.find((u) => u.status === 'completed');
    expect(patch?.talkSeconds).toBe(500);
  });

  it('an unanswered inbound call never writes talkSeconds', async () => {
    await dialResult({ DialCallStatus: 'no-answer' });
    expect(state.updates.some((u) => 'talkSeconds' in u)).toBe(false);
  });
```

In `services/cti-api/src/salesforce/sync.test.ts`, after the `describe('syncOne — the after-call ownership gate', …)` block, add:

```ts
describe('syncOne — Call Duration is true talk time (talk-time spec, fix 1)', () => {
  const owned = { salesforceWhoId: '00Q1', salesforceWhatId: '0061' };
  const durationSent = (d: ReturnType<typeof syncDeps>) => (d.createCallTask as any).mock.calls[0][1].callDurationInSeconds;

  it('uses talkSeconds — the ring-inclusive durationSeconds is not talk time', async () => {
    const d = syncDeps({ db: fakeDb(callRow({ ...owned, disposition: 'Connected', durationSeconds: 52, talkSeconds: 37 })) });
    await syncOne('call-1', d);
    expect(durationSent(d)).toBe(37);
  });

  it('an unanswered call logs 0, not its ringing', async () => {
    const d = syncDeps({ db: fakeDb(callRow({ ...owned, durationSeconds: 21, talkSeconds: 0 })) });
    await syncOne('call-1', d);
    expect(durationSent(d)).toBe(0);
  });

  it('falls back to durationSeconds for a call that has no talkSeconds (in flight across the deploy)', async () => {
    const d = syncDeps({ db: fakeDb(callRow({ ...owned, durationSeconds: 52, talkSeconds: null })) });
    await syncOne('call-1', d);
    expect(durationSent(d)).toBe(52);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/telephony/talk-seconds.test.ts src/routes/telephony-status-talk-time.test.ts src/routes/inbound.test.ts src/salesforce/sync.test.ts`
Expected: FAIL in four places:
- `talk-seconds.test.ts`: the module is missing.
- the status-route test: `state.talk` stays empty.
- the inbound test: `talkSeconds` is `undefined`.
- the sync tests: they get `52` / `21`.

- [ ] **Step 5: Implement the rule** — `services/cti-api/src/telephony/talk-seconds.ts`

```ts
/**
 * TRUE talk time for a regular call (talk-time spec, fix 1).
 *
 * Three Twilio requests carry a duration for one click-to-dial call, and only
 * two of them measure the customer's connected line:
 *  - the `<Dial action>` (DialCallStatus present): DialCallDuration is the
 *    dialed leg from answer to hang-up — authoritative, written
 *    unconditionally; a dial that never connected is 0;
 *  - the dialed CHILD leg's own status callback (ParentCallSid present): its
 *    CallDuration — written only while nothing is there, so it never
 *    overrides the action, whichever arrives first;
 *  - the rep's own (parent) leg callback: its CallDuration spans the whole
 *    dial INCLUDING ringing. Never used here. It is what
 *    calls.duration_seconds usually ends as, and the reputation engine reads
 *    that column — which is why talk time has its own.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';

type Db = ReturnType<typeof getDb>;

export type TalkSecondsWrite =
  | { mode: 'set'; seconds: number }
  | { mode: 'if_unset'; seconds: number };

/** DialCallStatus values that mean the dialed party was connected. */
const CONNECTED_DIAL_STATUSES = new Set(['completed', 'answered']);
/** A dialed leg's final statuses when it never connected. */
const UNANSWERED_END_STATUSES = new Set(['busy', 'no-answer', 'failed', 'canceled']);

/** A Twilio duration field as whole seconds; anything else is unknown (null). */
export function parseTwilioSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** PURE: what this callback says about the call's talk time, if anything. */
export function talkSecondsWrite(body: Record<string, string | undefined>): TalkSecondsWrite | null {
  const dialStatus = body.DialCallStatus;
  if (dialStatus) {
    if (!CONNECTED_DIAL_STATUSES.has(dialStatus)) return { mode: 'set', seconds: 0 };
    const seconds = parseTwilioSeconds(body.DialCallDuration);
    return seconds === null ? null : { mode: 'set', seconds };
  }
  if (body.ParentCallSid) {
    const status = body.CallStatus ?? '';
    if (status === 'completed') {
      const seconds = parseTwilioSeconds(body.CallDuration);
      return seconds === null ? null : { mode: 'if_unset', seconds };
    }
    return UNANSWERED_END_STATUSES.has(status) ? { mode: 'if_unset', seconds: 0 } : null;
  }
  return null;
}

/** Write it: `set` always; `if_unset` only while talk_seconds is still NULL. */
export function applyTalkSeconds(db: Db, callId: string, write: TalkSecondsWrite) {
  const c = schema.calls;
  const where = write.mode === 'set' ? eq(c.id, callId) : and(eq(c.id, callId), isNull(c.talkSeconds));
  return db.update(c).set({ talkSeconds: write.seconds }).where(where);
}
```

- [ ] **Step 6: Wire the status route** — in `services/cti-api/src/routes/telephony.ts`:
  - add the import beside the other `../telephony/…` imports:

```ts
import { applyTalkSeconds, talkSecondsWrite } from '../telephony/talk-seconds.js';
```

  - in the `/telephony/twilio/status` handler, directly after `await db.update(schema.calls).set(updates).where(eq(schema.calls.id, call.id));`, add:

```ts
        // True talk time (telephony/talk-seconds.ts) — its own column, so the
        // durationSeconds above, which the reputation engine reads, keeps its rule.
        const talk = talkSecondsWrite(body);
        if (talk) await applyTalkSeconds(db, call.id, talk);
```

- [ ] **Step 7: Wire inbound** — in `services/cti-api/src/routes/inbound.ts`:
  - add `import { parseTwilioSeconds } from '../telephony/talk-seconds.js';`;
  - in the dial-result `if (answered)` branch's `.set({ … })`, directly after the `durationSeconds: …` line, add:

```ts
          // The talk-time report and the Task's Call Duration read this one
          // (talk-time spec, fix 1); an answered inbound leg IS its talk time.
          talkSeconds: parseTwilioSeconds(body.DialCallDuration) ?? undefined,
```

- [ ] **Step 8: Wire the Salesforce Task** — in `services/cti-api/src/salesforce/sync.ts` `syncOne`, replace

```ts
    callDurationInSeconds: call.durationSeconds ?? undefined,
```

with

```ts
    // True talk time (talk-time spec, fix 1): durationSeconds usually holds the
    // rep leg's ring-inclusive length. A call with no talkSeconds (in flight
    // across the deploy) keeps the old number.
    callDurationInSeconds: call.talkSeconds ?? call.durationSeconds ?? undefined,
```

- [ ] **Step 9: Run the tests and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/telephony src/routes src/salesforce && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS (the four new/changed files and every existing route/salesforce test); typecheck clean.

- [ ] **Step 10: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/telephony/talk-seconds.ts services/cti-api/src/telephony/talk-seconds.test.ts \
  services/cti-api/src/routes/telephony.ts services/cti-api/src/routes/telephony-status-talk-time.test.ts \
  services/cti-api/src/routes/inbound.ts services/cti-api/src/routes/inbound.test.ts \
  services/cti-api/src/salesforce/sync.ts services/cti-api/src/salesforce/sync.test.ts
git commit -m "feat(calls): true talk time in calls.talk_seconds; Salesforce Call Duration uses it

Ring time no longer counts as talk: the <Dial action>'s DialCallDuration (0 when
never answered) or the dialed leg's own CallDuration. duration_seconds keeps its
rule because the reputation engine reads it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rep legs — join and end

**Files:**
- Create: `services/cti-api/src/dialer/rep-legs.ts`, `services/cti-api/src/dialer/rep-legs.test.ts`
- Modify:
  - `services/cti-api/src/routes/telephony.ts`: the voice route's dialer-conference branch, `stampRepCallSid`, the rejoin route, and the status route;
  - `services/cti-api/src/dialer/engine.ts`: `EngineDeps`, `releaseRepConference`;
  - `services/cti-api/src/dialer/live-deps.ts`.
- Modify tests:
  - `services/cti-api/src/routes/telephony-voice-conference.test.ts`
  - `services/cti-api/src/routes/telephony-status-talk-time.test.ts`
  - `services/cti-api/src/dialer/engine.test.ts`
  - `services/cti-api/src/routes/dialer-webhook.test.ts`

**Interfaces:**
- Consumes: `schema.dialerRepLegs`, `DialerRepLegEndSource` (Task 1); `TWILIO_CALL_SID_RE` (`telephony/webhooks.ts`).
- Produces:
  - `repLegJoinStatement(userId: string, callSid: string, joinedAt: Date): SQL`;
  - `recordRepLegJoined(db, userId: string, callSid: string, joinedAt: Date): Promise<void>`;
  - `repLegEndStatement(db, callSid: string, endedAt: Date, source: DialerRepLegEndSource)` (a Drizzle update builder);
  - `recordRepLegEnded(db, callSid: string | undefined, endedAt: Date, source: DialerRepLegEndSource): Promise<void>`;
  - `EngineDeps.onRepLegReleased: (repCallSid: string) => Promise<void>`.
- Neither `record…` function ever throws.

- [ ] **Step 1: Write the failing unit tests** — `services/cti-api/src/dialer/rep-legs.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { recordRepLegEnded, recordRepLegJoined, repLegEndStatement, repLegJoinStatement } from './rep-legs.js';

const USER = 'c9c45940-0f17-4c1e-bb3e-d084ba93eb86';
const LEG = 'CA0123456789abcdef0123456789abcdef';
const AT = new Date('2026-10-01T17:00:00Z');
// No connection is opened — pg.Pool is lazy.
const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

afterEach(() => { vi.restoreAllMocks(); });

describe('repLegJoinStatement — one statement, the run read from the stamp', () => {
  it('opens the leg for the run whose rep_call_sid it was just stamped as, idempotently (bare ON CONFLICT)', () => {
    const q = new PgDialect().sqlToQuery(repLegJoinStatement(USER, LEG, AT));
    const text = q.sql.replace(/\s+/g, ' ').trim();
    expect(text).toContain('insert into dialer_rep_legs (org_id, user_id, session_id, call_sid, joined_at)');
    expect(text).toContain('select org_id, user_id, id, rep_call_sid, $1::timestamptz from dialer_sessions');
    expect(text).toContain('where user_id = $2 and rep_call_sid = $3 limit 1');
    expect(text).toMatch(/on conflict do nothing$/);
    expect(q.params).toEqual([AT.toISOString(), USER, LEG]);
  });
});

describe('repLegEndStatement — the end is stamped once', () => {
  it('a leg that already ended keeps its first end', () => {
    const q = repLegEndStatement(db, LEG, AT, 'rep_left').toSQL();
    expect(q.sql).toContain('update "dialer_rep_legs" set');
    expect(q.sql).toContain('"ended_at" = $');
    expect(q.sql).toContain('"end_source" = $');
    expect(q.sql).toContain('"dialer_rep_legs"."call_sid" = $');
    expect(q.sql).toContain('"dialer_rep_legs"."ended_at" is null');
    expect(q.params).toEqual(expect.arrayContaining([AT.toISOString(), 'rep_left', LEG]));
  });
});

describe('best-effort writers — they log and never throw', () => {
  it('a failed join insert is logged with the user id only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { execute: async () => { throw new Error('pool exhausted'); } } as never;
    await expect(recordRepLegJoined(broken, USER, LEG, AT)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('[dialer] rep leg join not recorded', { userId: USER, err: 'pool exhausted' });
  });

  it('a failed end stamp is logged with its source only', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { update: () => { throw new Error('pool exhausted'); } } as never;
    await expect(recordRepLegEnded(broken, LEG, AT, 'run_end')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('[dialer] rep leg end not recorded', { source: 'run_end', err: 'pool exhausted' });
  });

  it('a missing or malformed sid writes nothing', async () => {
    const update = vi.fn();
    await recordRepLegEnded({ update } as never, undefined, AT, 'rep_left');
    await recordRepLegEnded({ update } as never, 'nope', AT, 'rep_left');
    expect(update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer/rep-legs.test.ts`
Expected: FAIL — `Cannot find module './rep-legs.js'`.

- [ ] **Step 3: Implement** — `services/cti-api/src/dialer/rep-legs.ts`

```ts
/**
 * Time on the power dialer (talk-time spec): one dialer_rep_legs row per rep
 * conference leg, from the join to the leg's end — dialing, hold music and
 * talking all count.
 *
 * Opened by the voice route right after it stamps the leg on its run. Ended by
 * whichever hears it first: the leg's own status callback (status route), the
 * rejoin route (the rep hung up, or the server answers Hangup), the engine's
 * run end (`releaseRepConference`), or a newer leg replacing it on the same run.
 * A leg whose every end was missed is closed by dialer/rep-leg-reconcile.ts.
 *
 * Everything here is best-effort and NEVER throws: a failed stamp must never
 * keep a rep out of their room, delay a rejoin answer, or fail a run's end.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb, schema, type DialerRepLegEndSource } from '@cti/db';
import { TWILIO_CALL_SID_RE } from '../telephony/webhooks.js';

type Db = ReturnType<typeof getDb>;

/** PURE: open a leg for the run whose rep_call_sid it was just stamped as —
 *  one statement, so the row carries the run's org and id without another
 *  read. Bare ON CONFLICT DO NOTHING (the call_sid index is FULL): a repeated
 *  join request writes nothing. */
export function repLegJoinStatement(userId: string, callSid: string, joinedAt: Date): SQL {
  return sql`
    insert into dialer_rep_legs (org_id, user_id, session_id, call_sid, joined_at)
    select org_id, user_id, id, rep_call_sid, ${joinedAt.toISOString()}::timestamptz from dialer_sessions
    where user_id = ${userId} and rep_call_sid = ${callSid} limit 1
    on conflict do nothing`;
}

export async function recordRepLegJoined(db: Db, userId: string, callSid: string, joinedAt: Date): Promise<void> {
  try {
    await db.execute(repLegJoinStatement(userId, callSid, joinedAt));
  } catch (err) {
    console.error('[dialer] rep leg join not recorded', { userId, err: (err as Error).message });
  }
}

/** Close an open leg, once: a leg that already ended keeps its first end. */
export function repLegEndStatement(db: Db, callSid: string, endedAt: Date, source: DialerRepLegEndSource) {
  const l = schema.dialerRepLegs;
  return db
    .update(l)
    .set({ endedAt, endSource: source, updatedAt: new Date() })
    .where(and(eq(l.callSid, callSid), isNull(l.endedAt)));
}

export async function recordRepLegEnded(
  db: Db,
  callSid: string | undefined,
  endedAt: Date,
  source: DialerRepLegEndSource,
): Promise<void> {
  if (!callSid || !TWILIO_CALL_SID_RE.test(callSid)) return;
  try {
    await repLegEndStatement(db, callSid, endedAt, source);
  } catch (err) {
    console.error('[dialer] rep leg end not recorded', { source, err: (err as Error).message });
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer/rep-legs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing route tests**

**5a. `services/cti-api/src/routes/telephony-voice-conference.test.ts`**

Directly after the `const state = vi.hoisted(…)` block, add:

```ts
// The talk-time report's leg bookkeeping (dialer/rep-legs.ts) — recorded, never
// run, so the fake database's update log below stays exactly what these tests
// already assert.
const legs = vi.hoisted(() => ({ joined: [] as unknown[][], ended: [] as unknown[][] }));
vi.mock('../dialer/rep-legs.js', () => ({
  recordRepLegJoined: async (...args: unknown[]) => { legs.joined.push(args); },
  recordRepLegEnded: async (...args: unknown[]) => { legs.ended.push(args); },
}));
```

In the top-level `beforeEach`, add `legs.joined = []; legs.ended = [];`.

At the end of the file, add:

```ts
describe('time on the power dialer — dialer_rep_legs bookkeeping', () => {
  const OLD_LEG = 'CAfedcba9876543210fedcba9876543210';

  it('a join opens the leg, for this rep and this sid', async () => {
    const res = await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    expect(res.body).toContain('<Conference');
    expect(legs.joined).toHaveLength(1);
    expect(legs.joined[0]!.slice(1, 3)).toEqual([REP_ID, REP_CALL_SID]);
    expect(legs.joined[0]![3]).toBeInstanceOf(Date);
  });

  it('a refused join (<Reject/>) opens no leg', async () => {
    state.liveRuns = [{ id: SESSION_ID, status: 'paused' }, { id: '0d6f2e1b-3c5a-4e7d-8f90-a1b2c3d4e5f6', status: 'active' }];
    await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    expect(legs.joined).toEqual([]);
  });

  it('a join that replaces an older leg on the run ends the older one as replaced', async () => {
    state.stampedBefore = { repCallSid: OLD_LEG };
    await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    await vi.waitFor(() => expect(legs.ended.map((a) => [a[1], a[3]])).toContainEqual([OLD_LEG, 'replaced']));
  });

  it('the rep hung up (rejoin, CallStatus=completed): the leg ends as rep_left', async () => {
    await rejoin({ CallStatus: 'completed' });
    expect(legs.ended.map((a) => [a[1], a[3]])).toEqual([[REP_CALL_SID, 'rep_left']]);
  });

  it('a leg the server hangs up (its run is over) ends as run_end', async () => {
    state.legSession = null;
    state.liveSession = null;
    const res = await rejoin();
    expect(res.body).toContain('<Hangup');
    expect(legs.ended.map((a) => [a[1], a[3]])).toEqual([[REP_CALL_SID, 'run_end']]);
  });

  it('a <Dial> that FAILED is hung up and ends as run_end', async () => {
    await rejoin({ DialCallStatus: 'failed' });
    expect(legs.ended.map((a) => [a[1], a[3]])).toEqual([[REP_CALL_SID, 'run_end']]);
  });

  it('a leg merely between rooms ends nothing', async () => {
    const res = await rejoin();
    expect(res.body).toContain('<Conference');
    expect(legs.ended).toEqual([]);
  });
});
```

**5b. `services/cti-api/src/routes/telephony-status-talk-time.test.ts`**

After the `vi.mock('../telephony/talk-seconds.js', …)` block, add:

```ts
const legs = vi.hoisted(() => ({ ended: [] as unknown[][] }));
vi.mock('../dialer/rep-legs.js', () => ({
  recordRepLegJoined: async () => {},
  recordRepLegEnded: async (...args: unknown[]) => { legs.ended.push(args); },
}));
```

In its `beforeEach`, add `legs.ended = [];`.

At the end of the file, add:

```ts
describe('POST /telephony/twilio/status — a rep conference leg that ends', () => {
  const REP_LEG = `CA${'c'.repeat(32)}`;

  it("a final callback that matches no call row (the dialer rep leg's own) ends its time on the dialer", async () => {
    state.call = null;
    await post({ CallSid: REP_LEG, CallStatus: 'completed', CallDuration: '3600' });
    expect(legs.ended).toHaveLength(1);
    expect(legs.ended[0]![1]).toBe(REP_LEG);
    expect(legs.ended[0]![2]).toBeInstanceOf(Date);
    expect(legs.ended[0]![3]).toBe('rep_left');
  });

  it('a callback for a real call row never touches a rep leg', async () => {
    await post({ CallSid: PARENT, CallStatus: 'completed', CallDuration: '58' });
    expect(legs.ended).toEqual([]);
  });

  it('a non-final callback, a child leg, or a <Dial action> ends nothing', async () => {
    state.call = null;
    await post({ CallSid: REP_LEG, CallStatus: 'in-progress' });
    await post({ CallSid: CHILD, ParentCallSid: REP_LEG, CallStatus: 'completed', CallDuration: '9' });
    await post({ CallSid: REP_LEG, CallStatus: 'completed', DialCallStatus: 'completed' });
    expect(legs.ended).toEqual([]);
  });
});
```

- [ ] **Step 6: Write the failing engine tests**

In `services/cti-api/src/dialer/engine.test.ts`, add `onRepLegReleased: vi.fn(async () => {}),` to `makeDeps` directly after `onBridged: vi.fn(async () => {}),`.

After the test `'a run whose rep never joined (no stamped leg) hangs up nothing'`, add:

```ts
  it('the run end closes the rep leg on the talk-time report — even when the hangup is refused', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps(); deps.db = fakeDb({ ...baseSession, repCallSid: REP_LEG }, items);
    deps.telephony.hangup = vi.fn(async () => { throw new Error('Call is not in-progress'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await advanceSession('S1', deps);
      expect(deps.onRepLegReleased).toHaveBeenCalledWith(REP_LEG);
    } finally { err.mockRestore(); }
  });
  it('a failing leg close never fails the run end', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps({ onRepLegReleased: vi.fn(async () => { throw new Error('db down'); }) });
    deps.db = fakeDb({ ...baseSession, repCallSid: REP_LEG }, items);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await advanceSession('S1', deps)).action).toBe('done');
      expect(deps.telephony.endConference).toHaveBeenCalledWith('U1');
    } finally { err.mockRestore(); }
  });
  it('a run whose rep never joined closes no leg', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    await advanceSession('S1', deps);
    expect(deps.onRepLegReleased).not.toHaveBeenCalled();
  });
```

In `services/cti-api/src/routes/dialer-webhook.test.ts`'s deps factory, add directly after the `onBridged:` line:

```ts
    onRepLegReleased: vi.fn(unexpected('onRepLegReleased')) as unknown as EngineDeps['onRepLegReleased'],
```

- [ ] **Step 7: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/routes/telephony-voice-conference.test.ts src/routes/telephony-status-talk-time.test.ts src/dialer/engine.test.ts`
Expected: FAIL:
- the new leg tests: `legs.joined` / `legs.ended` stay empty;
- the engine test: `onRepLegReleased` is never called.

The typecheck also fails until Step 9 adds `onRepLegReleased` to `EngineDeps`.

- [ ] **Step 8: Wire the routes** — in `services/cti-api/src/routes/telephony.ts`:

  - add the import beside the other `../dialer/…` imports:

```ts
import { recordRepLegEnded, recordRepLegJoined } from '../dialer/rep-legs.js';
```

  - in `stampRepCallSid`, replace

```ts
    if (before?.repCallSid && before.repCallSid !== callSid) void hangUpReplacedLeg(userId, before.repCallSid);
```

    with

```ts
    if (before?.repCallSid && before.repCallSid !== callSid) {
      void hangUpReplacedLeg(userId, before.repCallSid);
      // The talk-time report counts the rep's line once: the old leg's time on
      // the dialer ends where the new one starts, whenever Twilio reaps it.
      void recordRepLegEnded(db, before.repCallSid, new Date(), 'replaced');
    }
```

  - directly after the `stampRepCallSid` function, add:

```ts
/**
 * Open this rep leg's time-on-the-dialer row (dialer/rep-legs.ts). Runs right
 * after `stampRepCallSid`, whose stamp it reads to find the run. Bounded by
 * the rejoin deadline: a slow insert costs the report a leg, never the join.
 */
async function recordRepLegJoin(from: string, callSid: string | undefined): Promise<void> {
  const userId = repUserIdFromClientIdentity(from);
  if (!userId || !callSid || !TWILIO_CALL_SID_RE.test(callSid)) return;
  await orDefaultAfter(recordRepLegJoined(getDb(), userId, callSid, new Date()), undefined);
}
```

  - in the voice route's `if (body.DialerConference)` branch, replace

```ts
      await stampRepCallSid(body.From ?? '', body.CallSid, body.DialerSessionId);
      return reply.type('text/xml').send(twiml);
```

    with

```ts
      await stampRepCallSid(body.From ?? '', body.CallSid, body.DialerSessionId);
      await recordRepLegJoin(body.From ?? '', body.CallSid);
      return reply.type('text/xml').send(twiml);
```

  - in the rejoin route (`app.post(DIALER_REJOIN_PATH, …)`), replace

```ts
    if (body.CallStatus === 'completed') {
      await orDefaultAfter(pauseRunThatLostItsLeg(body.From ?? '', body.CallSid), undefined);
      return reply.type('text/xml').send(new VoiceResponse().toString());
    }
    const hangup = (): string => {
      const response = new VoiceResponse();
      response.hangup();
      return response.toString();
    };
```

    with

```ts
    if (body.CallStatus === 'completed') {
      // In parallel: both share the ~15 s Twilio gives this request.
      await Promise.all([
        orDefaultAfter(pauseRunThatLostItsLeg(body.From ?? '', body.CallSid), undefined),
        orDefaultAfter(recordRepLegEnded(getDb(), body.CallSid, new Date(), 'rep_left'), undefined),
      ]);
      return reply.type('text/xml').send(new VoiceResponse().toString());
    }
    // Every Hangup answered here ends the rep's leg: its time on the dialer
    // ends now (no further callback reaches this route for it).
    const hangup = async (): Promise<string> => {
      await orDefaultAfter(recordRepLegEnded(getDb(), body.CallSid, new Date(), 'run_end'), undefined);
      const response = new VoiceResponse();
      response.hangup();
      return response.toString();
    };
```

    and in the same route change the two `reply.type('text/xml').send(hangup())` calls to `reply.type('text/xml').send(await hangup())`.

  - in the `/telephony/twilio/status` handler, the `if (call) { … }` block ends with the `callEvents` insert. Directly after that block's closing brace (still inside `if (event) { … }`), add:

```ts
      else if (endsARepLeg(body)) {
        // No call row: the power dialer's rep conference leg, whose own final
        // status callback is the surest end of its time on the dialer.
        await recordRepLegEnded(db, body.CallSid, new Date(), 'rep_left');
      }
```

  - and add, next to `sanitizeHeaders` at the bottom of the file:

```ts
const FINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

/** A leg's OWN final status callback — not a dialed child leg, not a <Dial action>. */
function endsARepLeg(body: Record<string, string>): boolean {
  return !body.ParentCallSid && !body.DialCallStatus && FINAL_CALL_STATUSES.has(body.CallStatus ?? '');
}
```

- [ ] **Step 9: Wire the engine** — in `services/cti-api/src/dialer/engine.ts`:

  - in `EngineDeps`, directly after the `onBridged` member, add:

```ts
  /** The run is over and its rep leg was just hung up: close the leg's time on
   *  the dialer (dialer/rep-legs.ts — the talk-time report). Best-effort; the
   *  engine also catches a failure, which must never fail the run's end. */
  onRepLegReleased: (repCallSid: string) => Promise<void>;
```

  - in `releaseRepConference`, replace

```ts
  if (session.repCallSid) {
    try {
      await deps.telephony.hangup(session.repCallSid);
    } catch (err) {
      console.error('[dialer] rep leg hangup failed', { sessionId: session.id, userId: session.userId, err: (err as Error).message });
    }
  }
```

    with

```ts
  if (session.repCallSid) {
    try {
      await deps.telephony.hangup(session.repCallSid);
    } catch (err) {
      console.error('[dialer] rep leg hangup failed', { sessionId: session.id, userId: session.userId, err: (err as Error).message });
    }
    // Time on the dialer ends here, hung up or not: a refused hangup means the
    // leg had already gone, and an end it was already given wins.
    try {
      await deps.onRepLegReleased(session.repCallSid);
    } catch (err) {
      console.error('[dialer] rep leg end not recorded', { sessionId: session.id, err: (err as Error).message });
    }
  }
```

  - in `services/cti-api/src/dialer/live-deps.ts`, add `import { recordRepLegEnded } from './rep-legs.js';` and, directly after the `onBridged: …` entry, add:

```ts
    onRepLegReleased: (repCallSid) => recordRepLegEnded(db, repCallSid, new Date(), 'run_end'),
```

- [ ] **Step 10: Run the tests and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer src/routes && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS — the new tests and every existing voice-conference, rejoin, dialer and engine test unchanged; typecheck clean.

- [ ] **Step 11: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/dialer/rep-legs.ts services/cti-api/src/dialer/rep-legs.test.ts \
  services/cti-api/src/routes/telephony.ts services/cti-api/src/routes/telephony-voice-conference.test.ts \
  services/cti-api/src/routes/telephony-status-talk-time.test.ts \
  services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts \
  services/cti-api/src/dialer/live-deps.ts services/cti-api/src/routes/dialer-webhook.test.ts
git commit -m "feat(dialer): record each rep leg's time on the power dialer (join → end)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Close legs whose end was missed (Twilio reconcile)

**Files:**
- Modify: `services/cti-api/src/dialer/twilio-telephony.ts`, `services/cti-api/src/server.ts`
- Create: `services/cti-api/src/dialer/rep-leg-reconcile.ts`, `services/cti-api/src/dialer/rep-leg-reconcile.test.ts`
- Modify test: `services/cti-api/src/dialer/twilio-telephony.test.ts`

**Interfaces:**
- Consumes: `repLegEndStatement` (Task 3); `schema.dialerRepLegs`, `DialerRepLeg` (Task 1).
- Produces:
  - `TwilioDialerClient.calls(sid).fetch(): Promise<TwilioCallRecord>`;
  - `type TwilioCallRecord = { status: string; startTime: Date | null; endTime: Date | null; duration: string | null }`;
  - `type CallEnd = { ended: false } | { ended: true; endedAt: Date | null }`;
  - `callEndFrom(call: TwilioCallRecord): CallEnd`;
  - `TwilioDialerTelephony.callEnd(callSid: string): Promise<CallEnd>`;
  - `RECONCILE_INTERVAL_MS`, `RECONCILE_BATCH`, `GIVE_UP_AFTER_MS`, `FALLBACK_LEG_MS`;
  - `interface ReconcileDeps { db; now: () => Date; callEnd: (callSid: string) => Promise<CallEnd> }`;
  - `selectOpenLegs(db)`;
  - `reconcileLeg(leg, deps): Promise<'open' | 'reconciled' | 'fallback' | 'retry'>`;
  - `reconcileRepLegsTick(deps): Promise<void>`;
  - `startRepLegReconcileLoop(intervalMs?, deps?): NodeJS.Timeout`.

- [ ] **Step 1: Write the failing Twilio tests** — append to `services/cti-api/src/dialer/twilio-telephony.test.ts` (add `callEndFrom` to the existing import from `./twilio-telephony.js`):

```ts
describe('callEndFrom — has a rep leg ended, and when, per Twilio', () => {
  const start = new Date('2026-10-01T16:00:00Z');

  it('a live call has not ended', () => {
    for (const status of ['queued', 'ringing', 'in-progress']) {
      expect(callEndFrom({ status, startTime: start, endTime: null, duration: null })).toEqual({ ended: false });
    }
  });

  it("an ended call ends at Twilio's endTime", () => {
    const end = new Date('2026-10-01T17:30:00Z');
    expect(callEndFrom({ status: 'completed', startTime: start, endTime: end, duration: '5400' }))
      .toEqual({ ended: true, endedAt: end });
  });

  it('without an endTime, at start + duration', () => {
    expect(callEndFrom({ status: 'completed', startTime: start, endTime: null, duration: '600' }))
      .toEqual({ ended: true, endedAt: new Date('2026-10-01T16:10:00Z') });
  });

  it('with neither, ended at an unknown time', () => {
    expect(callEndFrom({ status: 'failed', startTime: null, endTime: null, duration: null }))
      .toEqual({ ended: true, endedAt: null });
  });
});

describe('TwilioDialerTelephony.callEnd', () => {
  it('fetches the call by sid and reads its end', async () => {
    const end = new Date('2026-10-01T17:30:00Z');
    const fetched: string[] = [];
    const client = {
      calls: Object.assign(
        (sid: string) => ({
          update: async () => ({}),
          recordings: { create: async () => ({ sid: 'RE1' }) },
          fetch: async () => {
            fetched.push(sid);
            return { status: 'completed', startTime: null, endTime: end, duration: '60' };
          },
        }),
        { create: async () => ({ sid: 'CA1' }) },
      ),
      conferences: Object.assign(() => ({ update: async () => ({}), participants: { list: async () => [] } }), { list: async () => [] }),
    } as unknown as TwilioDialerClient;
    const t = new TwilioDialerTelephony(() => client);
    await expect(t.callEnd('CA0123456789abcdef0123456789abcdef')).resolves.toEqual({ ended: true, endedAt: end });
    expect(fetched).toEqual(['CA0123456789abcdef0123456789abcdef']);
  });
});
```

(If `TwilioDialerClient` is not already imported in that test file, add it to the type import from `./twilio-telephony.js`.)

- [ ] **Step 2: Write the failing reconcile tests** — `services/cti-api/src/dialer/rep-leg-reconcile.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  FALLBACK_LEG_MS,
  RECONCILE_BATCH,
  reconcileLeg,
  reconcileRepLegsTick,
  selectOpenLegs,
  startRepLegReconcileLoop,
  type ReconcileDeps,
} from './rep-leg-reconcile.js';

const NOW = new Date('2026-10-03T18:00:00Z');
const LEG = { id: 'leg-1', callSid: 'CA0123456789abcdef0123456789abcdef', joinedAt: new Date('2026-10-03T16:00:00Z') };

function fakeDb(openLegs: unknown[] = []) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => openLegs }) }) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => { writes.push(v); },
      }),
    }),
  };
  return { db: db as unknown as ReconcileDeps['db'], writes };
}

const deps = (db: ReconcileDeps['db'], callEnd: ReconcileDeps['callEnd']): ReconcileDeps => ({ db, now: () => NOW, callEnd });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('reconcileLeg', () => {
  it('a leg Twilio says is still live stays open', async () => {
    const { db, writes } = fakeDb();
    expect(await reconcileLeg(LEG, deps(db, async () => ({ ended: false })))).toBe('open');
    expect(writes).toEqual([]);
  });

  it("an ended leg is closed at Twilio's end, as reconciled", async () => {
    const end = new Date('2026-10-03T17:10:00Z');
    const { db, writes } = fakeDb();
    expect(await reconcileLeg(LEG, deps(db, async () => ({ ended: true, endedAt: end })))).toBe('reconciled');
    expect(writes).toEqual([expect.objectContaining({ endedAt: end, endSource: 'reconciled' })]);
  });

  it('an ended leg with no known end is closed at its join (counts nothing)', async () => {
    const { db, writes } = fakeDb();
    await reconcileLeg(LEG, deps(db, async () => ({ ended: true, endedAt: null })));
    expect(writes).toEqual([expect.objectContaining({ endedAt: LEG.joinedAt, endSource: 'reconciled' })]);
  });

  it('a Twilio error on a recent leg retries next tick and writes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, writes } = fakeDb();
    expect(await reconcileLeg(LEG, deps(db, async () => { throw new Error('20429 too many requests'); }))).toBe('retry');
    expect(writes).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[dialer] rep leg reconcile failed; retrying next tick', { legId: 'leg-1', err: '20429 too many requests' });
  });

  it('a leg Twilio cannot answer for after 48 h is closed by rule at join + 12 h, loudly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const old = { ...LEG, joinedAt: new Date('2026-10-01T10:00:00Z') };
    const { db, writes } = fakeDb();
    expect(await reconcileLeg(old, deps(db, async () => { throw new Error('20404 not found'); }))).toBe('fallback');
    expect(writes).toEqual([expect.objectContaining({ endedAt: new Date(old.joinedAt.getTime() + FALLBACK_LEG_MS), endSource: 'fallback' })]);
    expect(err).toHaveBeenCalledWith('[dialer] rep leg closed by rule — Twilio could not give its end', { legId: 'leg-1' });
  });
});

describe('reconcileRepLegsTick', () => {
  it('one leg failing to write never stops the next', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = { ...LEG, id: 'leg-2', callSid: 'CAfedcba9876543210fedcba9876543210' };
    const { db } = fakeDb([LEG, second]);
    let calls = 0;
    const flaky = {
      ...db,
      update: () => ({
        set: () => ({
          where: async () => {
            calls++;
            if (calls === 1) throw new Error('db down');
          },
        }),
      }),
    } as unknown as ReconcileDeps['db'];
    const ended = vi.fn(async () => ({ ended: true as const, endedAt: NOW }));
    await reconcileRepLegsTick(deps(flaky, ended));
    expect(ended).toHaveBeenCalledTimes(2);
    expect(calls).toBe(2);
    expect(err).toHaveBeenCalledWith('[dialer] rep leg reconcile write failed', { legId: 'leg-1', err: 'db down' });
  });
});

describe('selectOpenLegs — the statement Postgres receives', () => {
  it('open legs only, oldest first, capped', () => {
    const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
    const q = selectOpenLegs(db).toSQL();
    expect(q.sql).toContain('"dialer_rep_legs"."ended_at" is null');
    expect(q.sql).toContain('order by "dialer_rep_legs"."joined_at" asc');
    expect(q.sql).toMatch(/limit \$\d+$/);
    expect(q.params).toContain(RECONCILE_BATCH);
  });
});

describe('startRepLegReconcileLoop', () => {
  it('is single-flight: a slow tick is never overlapped', async () => {
    vi.useFakeTimers();
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => new Promise(() => {}) }) }) }) }));
    const db = { select } as unknown as ReconcileDeps['db'];
    const timer = startRepLegReconcileLoop(1000, () => deps(db, async () => ({ ended: false })));
    await vi.advanceTimersByTimeAsync(3500);
    clearInterval(timer);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer/twilio-telephony.test.ts src/dialer/rep-leg-reconcile.test.ts`
Expected: FAIL. `callEndFrom` / `callEnd` are not exported, and `./rep-leg-reconcile.js` is missing.

- [ ] **Step 4: Implement the Twilio side** — in `services/cti-api/src/dialer/twilio-telephony.ts`:

  - in `TwilioDialerClient.calls`'s per-call object, after the `recordings` member, add:

```ts
    /** The call's own record — the rep-leg reconcile reads its end. */
    fetch(): Promise<TwilioCallRecord>;
```

  - directly above `export interface TwilioDialerClient`, add:

```ts
/** The fields of Twilio's call record the rep-leg reconcile reads. */
export interface TwilioCallRecord {
  status: string;
  startTime: Date | null;
  endTime: Date | null;
  duration: string | null;
}

/** Has a call ended, and when (null = ended, time unknown). */
export type CallEnd = { ended: false } | { ended: true; endedAt: Date | null };

const ENDED_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

/** PURE: Twilio's record of a call → has it ended, and when. endTime first,
 *  else startTime + duration, else unknown. */
export function callEndFrom(call: TwilioCallRecord): CallEnd {
  if (!ENDED_CALL_STATUSES.has(call.status)) return { ended: false };
  if (call.endTime) return { ended: true, endedAt: call.endTime };
  const seconds = call.duration == null ? NaN : Number(call.duration);
  if (call.startTime && Number.isFinite(seconds)) {
    return { ended: true, endedAt: new Date(call.startTime.getTime() + seconds * 1000) };
  }
  return { ended: true, endedAt: null };
}
```

  - in `class TwilioDialerTelephony`, directly after `hangup`, add:

```ts
  /** Twilio's own record of a call's end, for a rep leg whose end callback we
   *  never heard (dialer/rep-leg-reconcile.ts). Throws on a Twilio error. */
  async callEnd(callSid: string): Promise<CallEnd> {
    return callEndFrom(await this.clientFactory().calls(callSid).fetch());
  }
```

- [ ] **Step 5: Implement the reconcile** — `services/cti-api/src/dialer/rep-leg-reconcile.ts`

```ts
/**
 * Close rep legs whose end we never heard (talk-time spec). The leg's status
 * callback, the rejoin route, the run end and a replacing leg each stamp an
 * end; a lost callback leaves a leg open, and the report counts an open leg up
 * to "now". Every few minutes, ask Twilio about each open leg.
 *
 * At most RECONCILE_BATCH legs a tick, oldest first: a handful of reps are on
 * the dialer at once, so the batch always reaches today's legs.
 */
import { asc, isNull } from 'drizzle-orm';
import { getDb, schema, type DialerRepLeg } from '@cti/db';
import { repLegEndStatement } from './rep-legs.js';
import { TwilioDialerTelephony, type CallEnd } from './twilio-telephony.js';

type Db = ReturnType<typeof getDb>;

export const RECONCILE_INTERVAL_MS = 5 * 60_000;
export const RECONCILE_BATCH = 25;
/** A leg Twilio cannot answer for this long is closed by rule… */
export const GIVE_UP_AFTER_MS = 48 * 3_600_000;
/** …at this length (a long shift): the report never shows an endless leg. */
export const FALLBACK_LEG_MS = 12 * 3_600_000;

export interface ReconcileDeps {
  db: Db;
  now: () => Date;
  callEnd: (callSid: string) => Promise<CallEnd>;
}

type OpenLeg = Pick<DialerRepLeg, 'id' | 'callSid' | 'joinedAt'>;

export function selectOpenLegs(db: Db) {
  const l = schema.dialerRepLegs;
  return db
    .select({ id: l.id, callSid: l.callSid, joinedAt: l.joinedAt })
    .from(l)
    .where(isNull(l.endedAt))
    .orderBy(asc(l.joinedAt))
    .limit(RECONCILE_BATCH);
}

/** One open leg. A failed DB write propagates (the tick logs it); only the
 *  Twilio question has a fallback. */
export async function reconcileLeg(leg: OpenLeg, deps: ReconcileDeps): Promise<'open' | 'reconciled' | 'fallback' | 'retry'> {
  let end: CallEnd;
  try {
    end = await deps.callEnd(leg.callSid);
  } catch (err) {
    if (deps.now().getTime() - leg.joinedAt.getTime() < GIVE_UP_AFTER_MS) {
      console.warn('[dialer] rep leg reconcile failed; retrying next tick', { legId: leg.id, err: (err as Error).message });
      return 'retry';
    }
    await repLegEndStatement(deps.db, leg.callSid, new Date(leg.joinedAt.getTime() + FALLBACK_LEG_MS), 'fallback');
    console.error('[dialer] rep leg closed by rule — Twilio could not give its end', { legId: leg.id });
    return 'fallback';
  }
  if (!end.ended) return 'open';
  await repLegEndStatement(deps.db, leg.callSid, end.endedAt ?? leg.joinedAt, 'reconciled');
  return 'reconciled';
}

export async function reconcileRepLegsTick(deps: ReconcileDeps): Promise<void> {
  for (const leg of await selectOpenLegs(deps.db)) {
    try {
      await reconcileLeg(leg, deps);
    } catch (err) {
      console.error('[dialer] rep leg reconcile write failed', { legId: leg.id, err: (err as Error).message });
    }
  }
}

function liveReconcileDeps(): ReconcileDeps {
  const telephony = new TwilioDialerTelephony();
  return { db: getDb(), now: () => new Date(), callEnd: (callSid) => telephony.callEnd(callSid) };
}

/** Single-flight: a slow tick is never overlapped. `deps` is a test seam. */
export function startRepLegReconcileLoop(
  intervalMs: number = RECONCILE_INTERVAL_MS,
  deps: () => ReconcileDeps = liveReconcileDeps,
): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    reconcileRepLegsTick(deps())
      .catch((err) => console.error('[dialer] rep leg reconcile tick failed', { err: (err as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
```

- [ ] **Step 6: Start and stop the loop** — in `services/cti-api/src/server.ts`:
  - add `import { startRepLegReconcileLoop } from './dialer/rep-leg-reconcile.js';` with the other worker imports;
  - directly after the `const directoryTimer = …` line, add:

```ts
  // Talk-time report: close rep legs whose end callback never came (Twilio's own record).
  const repLegTimer = startRepLegReconcileLoop();
```

  - in `close`, after `clearInterval(directoryTimer);`, add `clearInterval(repLegTimer);`.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; typecheck clean.

If the typecheck flags an existing test fake for `TwilioDialerClient` missing `fetch`, add `fetch: async () => ({ status: 'in-progress', startTime: null, endTime: null, duration: null })` to that fake's per-call object. Do not change the interface.

- [ ] **Step 8: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/dialer/twilio-telephony.ts services/cti-api/src/dialer/twilio-telephony.test.ts \
  services/cti-api/src/dialer/rep-leg-reconcile.ts services/cti-api/src/dialer/rep-leg-reconcile.test.ts \
  services/cti-api/src/server.ts
git commit -m "feat(dialer): reconcile rep legs whose end was missed, from Twilio's call record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add any test fake you had to touch in Step 7 to the same commit.)

---

### Task 5: The report's arithmetic (pure)

**Files:**
- Create: `services/cti-api/src/reports/talk-time.ts`, `services/cti-api/src/reports/talk-time.test.ts`

**Interfaces:**
- Consumes: `ORG_TIMEZONE`, `orgMidnightUtc` (`dialer/org-day.ts`).
- Produces:
  - `MAX_RANGE_DAYS = 92`;
  - `type TalkSource = 'outbound' | 'powerDial' | 'inbound'`;
  - `interface TalkRange { from: string; to: string; days: string[]; start: Date; end: Date }`;
  - `addDays(day, n)`, `dayStartUtc(day)`;
  - `parseTalkRange(query): { ok: true; range: TalkRange } | { ok: false; error: string }`;
  - `interface LegSpan { userId: string; joinedAt: Date; endedAt: Date | null }`;
  - `mergeIntervals(spans)`;
  - `dialerSecondsByUserDay(legs, days, now): Record<string, Record<string, number>>`;
  - `interface TalkRow { userId: string; day: string; source: TalkSource; calls: number; seconds: number }`;
  - `interface RepName { id: string; name: string }`;
  - `DayRow`, `SourceTotals`, `RepRow`, `TalkTimeReport`;
  - `assembleTalkTimeReport({ range, names, talk, dialer }): TalkTimeReport`.

- [ ] **Step 1: Write the failing tests** — `services/cti-api/src/reports/talk-time.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_RANGE_DAYS,
  addDays,
  assembleTalkTimeReport,
  dayStartUtc,
  dialerSecondsByUserDay,
  mergeIntervals,
  parseTalkRange,
  type TalkRange,
} from './talk-time.js';

const range = (from: string, to: string): TalkRange => {
  const r = parseTalkRange({ from, to });
  if (!r.ok) throw new Error(r.error);
  return r.range;
};

describe('days — the org\'s Pacific calendar', () => {
  it('a day starts at Pacific midnight in UTC, DST-safe', () => {
    expect(dayStartUtc('2026-10-01').toISOString()).toBe('2026-10-01T07:00:00.000Z'); // PDT
    expect(dayStartUtc('2026-12-01').toISOString()).toBe('2026-12-01T08:00:00.000Z'); // PST
    expect(dayStartUtc('2026-11-01').toISOString()).toBe('2026-11-01T07:00:00.000Z'); // fall-back day starts in PDT
  });

  it('addDays crosses month and year ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-01', -6)).toBe('2026-09-25');
  });
});

describe('parseTalkRange', () => {
  it('lists every day, inclusive, and bounds the range from first midnight to the midnight after the last day', () => {
    const r = range('2026-09-28', '2026-10-01');
    expect(r.days).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
    expect(r.start.toISOString()).toBe('2026-09-28T07:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-02T07:00:00.000Z');
  });

  it('one day is fine', () => {
    expect(range('2026-10-01', '2026-10-01').days).toEqual(['2026-10-01']);
  });

  it('rejects malformed or impossible dates, a reversed range, and more than 92 days', () => {
    expect(parseTalkRange({ from: '2026-10-1', to: '2026-10-01' }).ok).toBe(false);
    expect(parseTalkRange({ from: '2026-02-30', to: '2026-03-01' }).ok).toBe(false);
    expect(parseTalkRange({ from: '2026-13-01', to: '2026-13-02' }).ok).toBe(false);
    expect(parseTalkRange({ to: '2026-10-01' }).ok).toBe(false);
    expect(parseTalkRange({ from: ['2026-10-01'], to: '2026-10-01' }).ok).toBe(false);
    expect(parseTalkRange({ from: '2026-10-02', to: '2026-10-01' })).toEqual({ ok: false, error: 'from must be on or before to' });
    expect(parseTalkRange({ from: '2026-01-01', to: addDays('2026-01-01', MAX_RANGE_DAYS - 1) }).ok).toBe(true);
    expect(parseTalkRange({ from: '2026-01-01', to: addDays('2026-01-01', MAX_RANGE_DAYS) })).toEqual({ ok: false, error: 'at most 92 days' });
  });
});

describe('mergeIntervals — a rep\'s line is counted once', () => {
  it('merges overlapping and touching spans, drops empty ones, keeps gaps', () => {
    expect(mergeIntervals([
      { start: 50, end: 60 },
      { start: 0, end: 10 },
      { start: 5, end: 20 },
      { start: 20, end: 25 },
      { start: 30, end: 30 },
    ])).toEqual([{ start: 0, end: 25 }, { start: 50, end: 60 }]);
  });
});

describe('dialerSecondsByUserDay', () => {
  const days = ['2026-09-30', '2026-10-01'];
  const NOW = new Date('2026-10-02T03:00:00Z');

  it('splits a leg across Pacific midnight', () => {
    // 23:30 → 00:15 PDT across Sep 30 / Oct 1 (Pacific midnight = 07:00Z).
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: new Date('2026-10-01T06:30:00Z'), endedAt: new Date('2026-10-01T07:15:00Z') }],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-09-30': 1800, '2026-10-01': 900 } });
  });

  it('counts a replaced leg that lingered beside its successor once', () => {
    const out = dialerSecondsByUserDay(
      [
        { userId: 'u1', joinedAt: new Date('2026-10-01T16:00:00Z'), endedAt: new Date('2026-10-01T17:00:00Z') },
        { userId: 'u1', joinedAt: new Date('2026-10-01T16:30:00Z'), endedAt: new Date('2026-10-01T18:00:00Z') },
      ],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-01': 7200 } });
  });

  it('an open leg counts up to now; time outside the range is not counted', () => {
    const out = dialerSecondsByUserDay(
      [
        { userId: 'u1', joinedAt: new Date('2026-10-02T02:00:00Z'), endedAt: null },
        { userId: 'u2', joinedAt: new Date('2026-09-29T15:00:00Z'), endedAt: new Date('2026-09-29T16:00:00Z') },
      ],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-01': 3600 } });
  });
});

describe('assembleTalkTimeReport', () => {
  const r = range('2026-09-30', '2026-10-01');
  const names = [{ id: 'u1', name: 'Garrett Martorello' }, { id: 'u2', name: 'Norah Lee' }];
  const talk = [
    { userId: 'u1', day: '2026-09-30', source: 'outbound' as const, calls: 3, seconds: 600 },
    { userId: 'u1', day: '2026-10-01', source: 'powerDial' as const, calls: 2, seconds: 900 },
    { userId: 'u1', day: '2026-10-01', source: 'inbound' as const, calls: 1, seconds: 120 },
    { userId: 'u2', day: '2026-10-01', source: 'outbound' as const, calls: 5, seconds: 2400 },
  ];
  const dialer = { u1: { '2026-10-01': 5400 }, u3: { '2026-09-30': 60 } };

  it('one row per rep, highest talk time first, with per-source totals and per-day detail', () => {
    const report = assembleTalkTimeReport({ range: r, names, talk, dialer });
    expect(report).toMatchObject({ from: '2026-09-30', to: '2026-10-01', timezone: 'America/Los_Angeles' });
    expect(report.reps.map((x) => x.userId)).toEqual(['u2', 'u1', 'u3']);
    const u1 = report.reps.find((x) => x.userId === 'u1')!;
    expect(u1).toEqual({
      userId: 'u1',
      name: 'Garrett Martorello',
      talkSeconds: 1620,
      connectedCalls: 6,
      bySource: { outbound: { calls: 3, seconds: 600 }, powerDial: { calls: 2, seconds: 900 }, inbound: { calls: 1, seconds: 120 } },
      dialerSeconds: 5400,
      days: [
        { day: '2026-09-30', talkSeconds: 600, connectedCalls: 3, dialerSeconds: 0 },
        { day: '2026-10-01', talkSeconds: 1020, connectedCalls: 3, dialerSeconds: 5400 },
      ],
    });
  });

  it('a rep with only dialer time still appears; an unknown user id is named as such', () => {
    const u3 = assembleTalkTimeReport({ range: r, names, talk, dialer }).reps.find((x) => x.userId === 'u3')!;
    expect(u3).toMatchObject({ name: 'Unknown user', talkSeconds: 0, connectedCalls: 0, dialerSeconds: 60 });
  });

  it('totals sum the reps', () => {
    expect(assembleTalkTimeReport({ range: r, names, talk, dialer }).totals)
      .toEqual({ talkSeconds: 4020, connectedCalls: 11, dialerSeconds: 5460 });
  });

  it('nothing in the range → no reps, zero totals', () => {
    expect(assembleTalkTimeReport({ range: r, names: [], talk: [], dialer: {} }))
      .toMatchObject({ reps: [], totals: { talkSeconds: 0, connectedCalls: 0, dialerSeconds: 0 } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/reports/talk-time.test.ts`
Expected: FAIL — `Cannot find module './talk-time.js'`.

- [ ] **Step 3: Implement** — `services/cti-api/src/reports/talk-time.ts`

```ts
/**
 * The talk-time report's arithmetic (talk-time spec): validate the range,
 * bound the org's Pacific days, turn each rep's legs on the power dialer into
 * seconds per day, and assemble one row per rep. PURE — the SQL is in
 * reports/talk-time-query.ts.
 */
import { ORG_TIMEZONE, orgMidnightUtc } from '../dialer/org-day.js';

export const MAX_RANGE_DAYS = 92;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type TalkSource = 'outbound' | 'powerDial' | 'inbound';

export interface TalkRange {
  from: string;
  to: string;
  /** Every day from..to, inclusive. */
  days: string[];
  /** The UTC instant `from` begins in the org's timezone. */
  start: Date;
  /** The UTC instant the day after `to` begins (exclusive end). */
  end: Date;
}

/** `YYYY-MM-DD` + n calendar days (UTC arithmetic on the label — no DST). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC instant the org's day `day` begins. Noon UTC always falls inside
 *  that same Pacific day, and orgMidnightUtc is DST-safe. */
export function dayStartUtc(day: string): Date {
  return orgMidnightUtc(new Date(`${day}T12:00:00Z`));
}

/** A real calendar day: `2026-02-30` rolls over to March and `2026-13-01` does
 *  not parse — both rejected (toISOString would THROW on the second). */
function isRealDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function parseTalkRange(query: { from?: unknown; to?: unknown }): { ok: true; range: TalkRange } | { ok: false; error: string } {
  const { from, to } = query;
  if (!isRealDay(from) || !isRealDay(to)) return { ok: false, error: 'from and to must be dates (YYYY-MM-DD)' };
  if (from > to) return { ok: false, error: 'from must be on or before to' };
  const count = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (count > MAX_RANGE_DAYS) return { ok: false, error: `at most ${MAX_RANGE_DAYS} days` };
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  return { ok: true, range: { from, to, days, start: dayStartUtc(from), end: dayStartUtc(addDays(to, 1)) } };
}

export interface LegSpan {
  userId: string;
  joinedAt: Date;
  endedAt: Date | null;
}

interface Span {
  start: number;
  end: number;
}

/** PURE: spans → non-overlapping spans, so a leg that lingered beside its
 *  replacement is counted once. Empty spans are dropped. */
export function mergeIntervals(spans: readonly Span[]): Span[] {
  return [...spans]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .reduce<Span[]>((merged, s) => {
      const last = merged[merged.length - 1];
      if (last && s.start <= last.end) {
        return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, s.end) }];
      }
      return [...merged, s];
    }, []);
}

/** PURE: seconds on the power dialer per user per day. An open leg runs to
 *  `now`; a leg is split at each Pacific midnight; time outside `days` is not
 *  counted. Days with no time are absent. */
export function dialerSecondsByUserDay(
  legs: readonly LegSpan[],
  days: readonly string[],
  now: Date,
): Record<string, Record<string, number>> {
  const bounds = days.map((day) => ({ day, start: dayStartUtc(day).getTime(), end: dayStartUtc(addDays(day, 1)).getTime() }));
  const userIds = [...new Set(legs.map((l) => l.userId))];
  return Object.fromEntries(
    userIds
      .map((userId) => {
        const spans = mergeIntervals(
          legs
            .filter((l) => l.userId === userId)
            .map((l) => ({ start: l.joinedAt.getTime(), end: (l.endedAt ?? now).getTime() })),
        );
        const perDay = bounds
          .map((b) => {
            const ms = spans.reduce((sum, s) => sum + Math.max(0, Math.min(s.end, b.end) - Math.max(s.start, b.start)), 0);
            return [b.day, Math.round(ms / 1000)] as const;
          })
          .filter(([, seconds]) => seconds > 0);
        return [userId, Object.fromEntries(perDay)] as const;
      })
      .filter(([, perDay]) => Object.keys(perDay).length > 0),
  );
}

export interface TalkRow {
  userId: string;
  day: string;
  source: TalkSource;
  calls: number;
  seconds: number;
}

export interface RepName {
  id: string;
  name: string;
}

export interface DayRow {
  day: string;
  talkSeconds: number;
  connectedCalls: number;
  dialerSeconds: number;
}

export interface SourceTotals {
  calls: number;
  seconds: number;
}

export interface RepRow {
  userId: string;
  name: string;
  talkSeconds: number;
  connectedCalls: number;
  bySource: Record<TalkSource, SourceTotals>;
  dialerSeconds: number;
  days: DayRow[];
}

export interface TalkTimeReport {
  from: string;
  to: string;
  timezone: string;
  reps: RepRow[];
  totals: { talkSeconds: number; connectedCalls: number; dialerSeconds: number };
}

const SOURCES: readonly TalkSource[] = ['outbound', 'powerDial', 'inbound'];
const UNKNOWN_USER = 'Unknown user';

const sumOf = (rows: readonly TalkRow[], key: 'calls' | 'seconds'): number => rows.reduce((t, r) => t + r[key], 0);

function repRow(userId: string, name: string, rows: readonly TalkRow[], dialerByDay: Record<string, number>): RepRow {
  const bySource = Object.fromEntries(
    SOURCES.map((source) => {
      const mine = rows.filter((r) => r.source === source);
      return [source, { calls: sumOf(mine, 'calls'), seconds: sumOf(mine, 'seconds') }];
    }),
  ) as Record<TalkSource, SourceTotals>;
  const days = [...new Set([...rows.map((r) => r.day), ...Object.keys(dialerByDay)])].sort().map((day) => {
    const mine = rows.filter((r) => r.day === day);
    return { day, talkSeconds: sumOf(mine, 'seconds'), connectedCalls: sumOf(mine, 'calls'), dialerSeconds: dialerByDay[day] ?? 0 };
  });
  return {
    userId,
    name,
    talkSeconds: sumOf(rows, 'seconds'),
    connectedCalls: sumOf(rows, 'calls'),
    bySource,
    dialerSeconds: Object.values(dialerByDay).reduce((t, s) => t + s, 0),
    days,
  };
}

/** PURE: one row per rep with any activity, highest talk time first. */
export function assembleTalkTimeReport(input: {
  range: TalkRange;
  names: readonly RepName[];
  talk: readonly TalkRow[];
  dialer: Record<string, Record<string, number>>;
}): TalkTimeReport {
  const nameOf = new Map(input.names.map((n) => [n.id, n.name]));
  const userIds = [...new Set([...input.talk.map((r) => r.userId), ...Object.keys(input.dialer)])];
  const reps = userIds
    .map((userId) => repRow(userId, nameOf.get(userId) ?? UNKNOWN_USER, input.talk.filter((r) => r.userId === userId), input.dialer[userId] ?? {}))
    .sort((a, b) => b.talkSeconds - a.talkSeconds || a.name.localeCompare(b.name));
  const totals = reps.reduce(
    (t, r) => ({
      talkSeconds: t.talkSeconds + r.talkSeconds,
      connectedCalls: t.connectedCalls + r.connectedCalls,
      dialerSeconds: t.dialerSeconds + r.dialerSeconds,
    }),
    { talkSeconds: 0, connectedCalls: 0, dialerSeconds: 0 },
  );
  return { from: input.range.from, to: input.range.to, timezone: ORG_TIMEZONE, reps, totals };
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/reports/talk-time.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/reports/talk-time.ts services/cti-api/src/reports/talk-time.test.ts
git commit -m "feat(reports): talk-time arithmetic — Pacific days, dialer legs split and counted once, one row per rep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The report's SQL + `GET /admin/talk-time`

**Files:**
- Create: `services/cti-api/src/reports/talk-time-query.ts`, `services/cti-api/src/reports/talk-time-query.test.ts`
- Create: `services/cti-api/src/routes/admin-talk-time.ts`, `services/cti-api/src/routes/admin-talk-time.test.ts`
- Modify: `services/cti-api/src/server.ts`

**Interfaces:**
- Consumes:
  - Task 5: `TalkRange`, `TalkRow`, `TalkSource`, `LegSpan`, `RepName`, `TalkTimeReport`, `parseTalkRange`, `dialerSecondsByUserDay`, `assembleTalkTimeReport`;
  - `schema.dialerRepLegs` (Task 1), `schema.users`;
  - `ORG_TIMEZONE`.
- Produces:
  - `talkRowsStatement(orgId, start: Date, end: Date): SQL`;
  - `loadTalkRows(db, orgId, range): Promise<TalkRow[]>`;
  - `legsStatement(db, orgId, range)`;
  - `loadRepNames(db, orgId, userIds): Promise<RepName[]>`;
  - `loadTalkTimeReport(db, orgId, range, now): Promise<TalkTimeReport>`;
  - `interface TalkTimeRouteDeps { load; now }`;
  - `registerAdminTalkTimeRoutes(app, deps?)`.

- [ ] **Step 1: Write the failing query tests** — `services/cti-api/src/reports/talk-time-query.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { legsStatement, loadRepNames, loadTalkRows, loadTalkTimeReport, talkRowsStatement } from './talk-time-query.js';
import { parseTalkRange, type TalkRange } from './talk-time.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const r = parseTalkRange({ from: '2026-09-30', to: '2026-10-01' });
if (!r.ok) throw new Error(r.error);
const RANGE: TalkRange = r.range;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('talkRowsStatement — what counts as talk', () => {
  const q = new PgDialect().sqlToQuery(talkRowsStatement(ORG, RANGE.start, RANGE.end));
  const text = flat(q.sql);

  it('outbound counts only Connected; inbound only answered and not voicemail', () => {
    expect(text).toContain("(direction = 'outbound' and disposition = 'Connected')");
    expect(text).toContain("(direction = 'inbound' and status = 'completed' and answered_at is not null and inbound_voicemail_url is null)");
  });

  it('regular talk is true talk time when known, the old duration otherwise', () => {
    expect(text).toContain('coalesce(sum(coalesce(talk_seconds, duration_seconds, 0)), 0)::int as seconds');
  });

  it('every bridged power-dial call counts, null talk as 0', () => {
    expect(text).toContain("'powerDial' as source");
    expect(text).toContain('from dialer_connects');
    expect(text).toContain('coalesce(sum(coalesce(talk_seconds, 0)), 0)::int as seconds');
  });

  it("buckets by the org's day, by when the call started, org-scoped and range-bound on both sources", () => {
    expect(text).toContain("to_char(coalesce(started_at, created_at) at time zone 'America/Los_Angeles', 'YYYY-MM-DD') as day");
    expect(text).toContain("to_char(bridged_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD') as day");
    expect(text.match(/org_id = \$\d+/g)).toHaveLength(2);
    expect(q.params.filter((p) => p === ORG)).toHaveLength(2);
    expect(q.params).toEqual(expect.arrayContaining([RANGE.start.toISOString(), RANGE.end.toISOString()]));
  });
});

describe('legsStatement — legs that overlap the range', () => {
  it('org-scoped; joined before the range ends; still open or ended after it starts', () => {
    const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
    const q = legsStatement(db, ORG, RANGE).toSQL();
    expect(q.sql).toContain('"dialer_rep_legs"."org_id" = $');
    expect(q.sql).toContain('"dialer_rep_legs"."joined_at" < $');
    expect(q.sql).toContain('("dialer_rep_legs"."ended_at" is null or "dialer_rep_legs"."ended_at" > $');
    expect(q.params).toEqual(expect.arrayContaining([ORG, RANGE.start.toISOString(), RANGE.end.toISOString()]));
  });
});

describe('loaders', () => {
  it('loadTalkRows maps the driver rows (numbers may arrive as strings)', async () => {
    const db = { execute: async () => ({ rows: [{ user_id: 'u1', day: '2026-10-01', source: 'outbound', calls: '3', seconds: '600' }] }) } as never;
    expect(await loadTalkRows(db, ORG, RANGE)).toEqual([{ userId: 'u1', day: '2026-10-01', source: 'outbound', calls: 3, seconds: 600 }]);
  });

  it('loadRepNames: display name, else email; no query for no ids', async () => {
    let queried = 0;
    const db = {
      select: () => {
        queried++;
        return { from: () => ({ where: async () => [{ id: 'u1', displayName: 'Garrett M', email: 'g@x.com' }, { id: 'u2', displayName: null, email: 'n@x.com' }] }) };
      },
    } as never;
    expect(await loadRepNames(db, ORG, [])).toEqual([]);
    expect(queried).toBe(0);
    expect(await loadRepNames(db, ORG, ['u1', 'u2'])).toEqual([{ id: 'u1', name: 'Garrett M' }, { id: 'u2', name: 'n@x.com' }]);
  });

  it('loadTalkTimeReport joins the three reads into the report', async () => {
    const db = {
      execute: async () => ({ rows: [{ user_id: 'u1', day: '2026-10-01', source: 'powerDial', calls: 2, seconds: 900 }] }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () =>
            table === schema.users
              ? [{ id: 'u1', displayName: 'Garrett M', email: 'g@x.com' }]
              : [{ userId: 'u1', joinedAt: new Date('2026-10-01T16:00:00Z'), endedAt: new Date('2026-10-01T17:00:00Z') }],
        }),
      }),
    } as never;
    const report = await loadTalkTimeReport(db, ORG, RANGE, new Date('2026-10-02T00:00:00Z'));
    expect(report.reps).toEqual([
      expect.objectContaining({ userId: 'u1', name: 'Garrett M', talkSeconds: 900, connectedCalls: 2, dialerSeconds: 3600 }),
    ]);
  });
});
```

- [ ] **Step 2: Write the failing route tests** — `services/cti-api/src/routes/admin-talk-time.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  session: null as null | { userId: string; orgId: string; isAdmin: boolean },
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

import { registerAdminTalkTimeRoutes, type TalkTimeRouteDeps } from './admin-talk-time.js';

const NOW = new Date('2026-10-01T18:00:00Z');
const REPORT = { from: '2026-10-01', to: '2026-10-01', timezone: 'America/Los_Angeles', reps: [], totals: { talkSeconds: 0, connectedCalls: 0, dialerSeconds: 0 } };

let app: FastifyInstance;
let load: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  state.session = { userId: 'admin-1', orgId: 'org-1', isAdmin: true };
  load = vi.fn(async () => REPORT);
  app = Fastify();
  await registerAdminTalkTimeRoutes(app, { load: load as unknown as TalkTimeRouteDeps['load'], now: () => NOW });
  await app.ready();
});
afterEach(async () => { await app.close(); });

const get = (qs: string) => app.inject({ method: 'GET', url: `/admin/talk-time${qs}`, headers: { authorization: 'Bearer t' } });

describe('GET /admin/talk-time', () => {
  it('401 without a session', async () => {
    state.session = null;
    expect((await get('?from=2026-10-01&to=2026-10-01')).statusCode).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it('403 for a rep who is not an admin', async () => {
    state.session = { userId: 'rep-1', orgId: 'org-1', isAdmin: false };
    expect((await get('?from=2026-10-01&to=2026-10-01')).statusCode).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it('400 for a bad, reversed or too-long range', async () => {
    for (const qs of ['', '?from=2026-10-01', '?from=10/01/2026&to=2026-10-01', '?from=2026-10-02&to=2026-10-01', '?from=2026-01-01&to=2026-12-31']) {
      const res = await get(qs);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty('error');
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("returns the report for the admin's own org", async () => {
    const res = await get('?from=2026-09-28&to=2026-10-01');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(REPORT);
    expect(load).toHaveBeenCalledWith('org-1', expect.objectContaining({ from: '2026-09-28', to: '2026-10-01' }), NOW);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/reports/talk-time-query.test.ts src/routes/admin-talk-time.test.ts`
Expected: FAIL — both modules missing.

- [ ] **Step 4: Implement the SQL** — `services/cti-api/src/reports/talk-time-query.ts`

```ts
/**
 * The talk-time report's reads (talk-time spec). Three reads per request:
 * connected calls aggregated per rep / Pacific day / source (one statement over
 * calls + dialer_connects), the rep legs that overlap the range, and the reps'
 * names. The arithmetic is in reports/talk-time.ts.
 */
import { and, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { ORG_TIMEZONE } from '../dialer/org-day.js';
import {
  assembleTalkTimeReport,
  dialerSecondsByUserDay,
  type LegSpan,
  type RepName,
  type TalkRange,
  type TalkRow,
  type TalkSource,
  type TalkTimeReport,
} from './talk-time.js';

type Db = ReturnType<typeof getDb>;

/** A constant, never input — inlined so the GROUP BY ordinals carry no parameter. */
const TZ = sql.raw(`'${ORG_TIMEZONE}'`);

/** PURE (statement only). A regular call counts on the day it started (its
 *  start, else its creation); a power-dial call on the day it was bridged. */
export function talkRowsStatement(orgId: string, start: Date, end: Date): SQL {
  const from = start.toISOString();
  const to = end.toISOString();
  return sql`
    select user_id,
           to_char(coalesce(started_at, created_at) at time zone ${TZ}, 'YYYY-MM-DD') as day,
           case when direction = 'outbound' then 'outbound' else 'inbound' end as source,
           count(*)::int as calls,
           coalesce(sum(coalesce(talk_seconds, duration_seconds, 0)), 0)::int as seconds
    from calls
    where org_id = ${orgId}
      and coalesce(started_at, created_at) >= ${from}::timestamptz
      and coalesce(started_at, created_at) < ${to}::timestamptz
      and ((direction = 'outbound' and disposition = 'Connected')
        or (direction = 'inbound' and status = 'completed' and answered_at is not null and inbound_voicemail_url is null))
    group by 1, 2, 3
    union all
    select user_id,
           to_char(bridged_at at time zone ${TZ}, 'YYYY-MM-DD') as day,
           'powerDial' as source,
           count(*)::int as calls,
           coalesce(sum(coalesce(talk_seconds, 0)), 0)::int as seconds
    from dialer_connects
    where org_id = ${orgId}
      and bridged_at >= ${from}::timestamptz
      and bridged_at < ${to}::timestamptz
    group by 1, 2`;
}

interface TalkRowRaw {
  user_id: string;
  day: string;
  source: TalkSource;
  calls: number | string;
  seconds: number | string;
}

export async function loadTalkRows(db: Db, orgId: string, range: TalkRange): Promise<TalkRow[]> {
  const result = await db.execute(talkRowsStatement(orgId, range.start, range.end));
  const rows = (result as unknown as { rows: TalkRowRaw[] }).rows;
  return rows.map((r) => ({ userId: r.user_id, day: r.day, source: r.source, calls: Number(r.calls), seconds: Number(r.seconds) }));
}

export function legsStatement(db: Db, orgId: string, range: TalkRange) {
  const l = schema.dialerRepLegs;
  return db
    .select({ userId: l.userId, joinedAt: l.joinedAt, endedAt: l.endedAt })
    .from(l)
    .where(and(eq(l.orgId, orgId), lt(l.joinedAt, range.end), or(isNull(l.endedAt), gt(l.endedAt, range.start))));
}

export async function loadRepNames(db: Db, orgId: string, userIds: readonly string[]): Promise<RepName[]> {
  if (userIds.length === 0) return [];
  const u = schema.users;
  const rows = await db
    .select({ id: u.id, displayName: u.displayName, email: u.email })
    .from(u)
    .where(and(eq(u.orgId, orgId), inArray(u.id, [...userIds])));
  return rows.map((r) => ({ id: r.id, name: r.displayName ?? r.email }));
}

export async function loadTalkTimeReport(db: Db, orgId: string, range: TalkRange, now: Date): Promise<TalkTimeReport> {
  const [talk, legs] = await Promise.all([loadTalkRows(db, orgId, range), legsStatement(db, orgId, range) as Promise<LegSpan[]>]);
  const dialer = dialerSecondsByUserDay(legs, range.days, now);
  const names = await loadRepNames(db, orgId, [...new Set([...talk.map((t) => t.userId), ...legs.map((l) => l.userId)])]);
  return assembleTalkTimeReport({ range, names, talk, dialer });
}
```

- [ ] **Step 5: Implement the route** — `services/cti-api/src/routes/admin-talk-time.ts`

```ts
/**
 * GET /admin/talk-time?from=YYYY-MM-DD&to=YYYY-MM-DD — the talk-time report
 * (talk-time spec): one row per rep, with per-day detail, over the org's
 * Pacific days `from`..`to` inclusive (at most 92). Admin-only and org-scoped,
 * exactly like the other /admin/* routes.
 */
import type { FastifyInstance } from 'fastify';
import { resolveSession } from '@cti/auth';
import { getDb } from '@cti/db';
import { parseTalkRange, type TalkRange, type TalkTimeReport } from '../reports/talk-time.js';
import { loadTalkTimeReport } from '../reports/talk-time-query.js';

export interface TalkTimeRouteDeps {
  load: (orgId: string, range: TalkRange, now: Date) => Promise<TalkTimeReport>;
  now: () => Date;
}

const liveDeps: TalkTimeRouteDeps = {
  load: (orgId, range, now) => loadTalkTimeReport(getDb(), orgId, range, now),
  now: () => new Date(),
};

export async function registerAdminTalkTimeRoutes(app: FastifyInstance, deps: TalkTimeRouteDeps = liveDeps): Promise<void> {
  app.get('/admin/talk-time', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const parsed = parseTalkRange(req.query as { from?: unknown; to?: unknown });
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return deps.load(s.orgId, parsed.range, deps.now());
  });
}
```

- [ ] **Step 6: Register it** — in `services/cti-api/src/server.ts`:
  - add `import { registerAdminTalkTimeRoutes } from './routes/admin-talk-time.js';` beside the other route imports;
  - add `await registerAdminTalkTimeRoutes(app);` directly after `await registerAdminRoutes(app);`.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/reports src/routes/admin-talk-time.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/reports/talk-time-query.ts services/cti-api/src/reports/talk-time-query.test.ts \
  services/cti-api/src/routes/admin-talk-time.ts services/cti-api/src/routes/admin-talk-time.test.ts \
  services/cti-api/src/server.ts
git commit -m "feat(admin): GET /admin/talk-time — talk time and time on the dialer per rep, by Pacific day

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Talk time screen + runbook

**Files:**
- Modify: `apps/cti-web/src/nav.ts`, `apps/cti-web/src/nav.test.ts`, `apps/cti-web/src/App.tsx`
- Create:
  - `apps/cti-web/src/talk-time-api.ts`
  - `apps/cti-web/src/talk-time-format.ts`, `apps/cti-web/src/talk-time-format.test.ts`
  - `apps/cti-web/src/components/TalkTimePanel.tsx`, `apps/cti-web/src/components/TalkTimePanel.test.tsx`
  - `docs/runbooks/talk-time-report.md`

**Interfaces:**
- Consumes: the `GET /admin/talk-time` response shape (Task 6 / Task 5 `TalkTimeReport`).
- Produces:
  - `Tab` gains `'talktime'`;
  - `getTalkTime(from, to)`;
  - `formatHms`, `orgToday`, `addDays`, `rangeFor`, `formatDay`;
  - `TalkTimePanel`.

- [ ] **Step 1: Write the failing tests**

`apps/cti-web/src/talk-time-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addDays, formatDay, formatHms, orgToday, rangeFor } from './talk-time-format';

describe('formatHms', () => {
  it('h:mm:ss, hours uncapped', () => {
    expect(formatHms(0)).toBe('0:00:00');
    expect(formatHms(59)).toBe('0:00:59');
    expect(formatHms(3725)).toBe('1:02:05');
    expect(formatHms(90_000)).toBe('25:00:00');
  });
});

describe("the org's (Pacific) calendar", () => {
  it('today is the Pacific day, not the UTC one', () => {
    expect(orgToday(new Date('2026-10-02T01:00:00Z'))).toBe('2026-10-01'); // 18:00 PDT
  });

  it('addDays crosses month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
  });

  it('Today / This week (Monday–today) / Last 7 days', () => {
    const thu = new Date('2026-10-01T18:00:00Z'); // Thu Oct 1, 11:00 PDT
    expect(rangeFor('today', thu)).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(rangeFor('week', thu)).toEqual({ from: '2026-09-28', to: '2026-10-01' });
    expect(rangeFor('last7', thu)).toEqual({ from: '2026-09-25', to: '2026-10-01' });
    expect(rangeFor('week', new Date('2026-09-28T18:00:00Z'))).toEqual({ from: '2026-09-28', to: '2026-09-28' }); // a Monday
    expect(rangeFor('week', new Date('2026-10-04T18:00:00Z'))).toEqual({ from: '2026-09-28', to: '2026-10-04' }); // a Sunday
  });

  it('a day label reads like "Thu 10/1"', () => {
    expect(formatDay('2026-10-01')).toBe('Thu 10/1');
  });
});
```

`apps/cti-web/src/components/TalkTimePanel.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TalkTimePanel } from './TalkTimePanel';
import * as talkApi from '../talk-time-api';

vi.mock('../talk-time-api');

const REPORT: talkApi.TalkTimeReport = {
  from: '2026-10-01',
  to: '2026-10-01',
  timezone: 'America/Los_Angeles',
  reps: [
    {
      userId: 'u1',
      name: 'Garrett Martorello',
      talkSeconds: 3725,
      connectedCalls: 9,
      bySource: { outbound: { calls: 4, seconds: 1200 }, powerDial: { calls: 3, seconds: 1925 }, inbound: { calls: 2, seconds: 600 } },
      dialerSeconds: 7200,
      days: [{ day: '2026-10-01', talkSeconds: 3725, connectedCalls: 9, dialerSeconds: 7200 }],
    },
  ],
  totals: { talkSeconds: 3725, connectedCalls: 9, dialerSeconds: 7200 },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T18:00:00Z')); // Thu Oct 1, 11:00 PDT
  vi.mocked(talkApi.getTalkTime).mockResolvedValue(REPORT);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('TalkTimePanel', () => {
  it('loads today (Pacific): one row per rep, h:mm:ss, and a totals row', async () => {
    render(<TalkTimePanel />);
    expect(await screen.findByRole('button', { name: 'Garrett Martorello' })).toBeTruthy();
    expect(talkApi.getTalkTime).toHaveBeenCalledWith('2026-10-01', '2026-10-01');
    expect(screen.getAllByText('1:02:05')).toHaveLength(2); // the rep and the total
    expect(screen.getAllByText('0:32:05')).toHaveLength(2); // power-dial talk
    expect(screen.getAllByText('2:00:00')).toHaveLength(2); // time on the dialer
    expect(screen.getByText('Total')).toBeTruthy();
  });

  it('This week asks for Monday through today', async () => {
    render(<TalkTimePanel />);
    await screen.findByRole('button', { name: 'Garrett Martorello' });
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() => expect(talkApi.getTalkTime).toHaveBeenLastCalledWith('2026-09-28', '2026-10-01'));
  });

  it('Last 7 days asks for today and the six days before', async () => {
    render(<TalkTimePanel />);
    await screen.findByRole('button', { name: 'Garrett Martorello' });
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(talkApi.getTalkTime).toHaveBeenLastCalledWith('2026-09-25', '2026-10-01'));
  });

  it('a From after To pulls To along, so the range never reverses', async () => {
    render(<TalkTimePanel />);
    await screen.findByRole('button', { name: 'Garrett Martorello' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-03' } });
    await waitFor(() => expect(talkApi.getTalkTime).toHaveBeenLastCalledWith('2026-10-03', '2026-10-03'));
  });

  it('tapping a rep shows their per-day rows', async () => {
    render(<TalkTimePanel />);
    const rep = await screen.findByRole('button', { name: 'Garrett Martorello' });
    expect(screen.queryByText('Thu 10/1')).toBeNull();
    fireEvent.click(rep);
    expect(screen.getByText('Thu 10/1')).toBeTruthy();
    expect(rep.getAttribute('aria-expanded')).toBe('true');
  });

  it('a failed load says so', async () => {
    vi.mocked(talkApi.getTalkTime).mockRejectedValue(new Error('500'));
    render(<TalkTimePanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load talk time.');
  });

  it('an empty range says nobody talked', async () => {
    vi.mocked(talkApi.getTalkTime).mockResolvedValue({ ...REPORT, reps: [], totals: { talkSeconds: 0, connectedCalls: 0, dialerSeconds: 0 } });
    render(<TalkTimePanel />);
    expect(await screen.findByText('No talk time in this range.')).toBeTruthy();
    expect(screen.queryByText('Total')).toBeNull();
  });
});
```

In `apps/cti-web/src/nav.test.ts`:

- replace the test `'admins get Team in the More overflow, beside Reputation'` with:

```ts
  it('admins get Team and Talk time in the More overflow, beside Reputation', () => {
    const ids = navTabsFor({ isAdmin: true, powerDialerEnabled: true }).map((t) => t.id);
    expect(ids).toEqual(['dialer', 'powerdial', 'recent', 'team', 'talktime', 'reputation', 'admin', 'calls', 'settings']);
    expect(NAV_OVERFLOW_IDS).toEqual(['team', 'talktime', 'reputation', 'admin', 'calls']);
  });

  it('reps never see Talk time', () => {
    expect(navTabsFor({ ...rep, powerDialerEnabled: true }).map((t) => t.id)).not.toContain('talktime');
  });
```

- in `'labels are stable'`, change the `toMatchObject` to:

```ts
    expect(byId).toMatchObject({ team: 'Team', talktime: 'Talk time', admin: 'Numbers', reputation: 'Reputation', dialer: 'Dial' });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/apps/cti-web && npx vitest run src/talk-time-format.test.ts src/components/TalkTimePanel.test.tsx src/nav.test.ts`
Expected: FAIL. The format/panel modules are missing, and the nav arrays lack `talktime`.

- [ ] **Step 3: Implement the client and helpers**

`apps/cti-web/src/talk-time-api.ts`:

```ts
import { api } from './api';

export type TalkSource = 'outbound' | 'powerDial' | 'inbound';

export interface TalkDay {
  day: string;
  talkSeconds: number;
  connectedCalls: number;
  dialerSeconds: number;
}

export interface TalkRep {
  userId: string;
  name: string;
  talkSeconds: number;
  connectedCalls: number;
  bySource: Record<TalkSource, { calls: number; seconds: number }>;
  dialerSeconds: number;
  days: TalkDay[];
}

export interface TalkTimeReport {
  from: string;
  to: string;
  timezone: string;
  reps: TalkRep[];
  totals: { talkSeconds: number; connectedCalls: number; dialerSeconds: number };
}

/** Admin-only: talk time per rep over the org's Pacific days from..to (inclusive). */
export async function getTalkTime(from: string, to: string): Promise<TalkTimeReport> {
  return api(`/admin/talk-time?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: 'GET' });
}
```

`apps/cti-web/src/talk-time-format.ts`:

```ts
/** The org's timezone — the report's days are its days (the server's too). */
export const ORG_TIMEZONE = 'America/Los_Angeles';
const DAY_MS = 86_400_000;

/** `h:mm:ss`; hours are not capped at 24 (a week of talk runs past it). */
export function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Today in the org's timezone, `YYYY-MM-DD` (en-CA formats in ISO order). */
export function orgToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ORG_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** `YYYY-MM-DD` + n calendar days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export type RangeShortcut = 'today' | 'week' | 'last7';

/** From/To for a shortcut. This week = Monday through today. */
export function rangeFor(shortcut: RangeShortcut, now: Date = new Date()): { from: string; to: string } {
  const today = orgToday(now);
  if (shortcut === 'today') return { from: today, to: today };
  if (shortcut === 'last7') return { from: addDays(today, -6), to: today };
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return { from: addDays(today, -((weekday + 6) % 7)), to: today };
}

/** A per-day row's label, e.g. `Thu 10/1`. */
export function formatDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(d);
  return `${weekday} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
```

- [ ] **Step 4: Implement the screen** — `apps/cti-web/src/components/TalkTimePanel.tsx`

```tsx
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { getTalkTime, type TalkTimeReport } from '../talk-time-api';
import { formatDay, formatHms, rangeFor, type RangeShortcut } from '../talk-time-format';

const SHORTCUTS: ReadonlyArray<{ id: RangeShortcut; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'last7', label: 'Last 7 days' },
];

/**
 * Admin-only Talk time report (talk-time spec): per rep, over the org's Pacific
 * days From–To — talk time on every connected call (click-to-dial, power dial,
 * answered inbound), connected calls, power-dial talk, and time on the power
 * dialer (the rep's line open: dialing and hold music included). Tap a rep for
 * their days.
 */
export function TalkTimePanel(): JSX.Element {
  const [range, setRange] = useState(() => rangeFor('today'));
  const [report, setReport] = useState<TalkTimeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Only the latest request may land: a quick second range must not be
  // overwritten by the first one's slower answer.
  const latest = useRef(0);

  const load = useCallback(async (from: string, to: string) => {
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getTalkTime(from, to);
      if (mine === latest.current) setReport(next);
    } catch {
      if (mine === latest.current) setError('Could not load talk time.');
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range.from, range.to);
  }, [load, range.from, range.to]);

  const setFrom = (from: string): void => {
    if (from) setRange((r) => ({ from, to: from > r.to ? from : r.to }));
  };
  const setTo = (to: string): void => {
    if (to) setRange((r) => ({ from: to < r.from ? to : r.from, to }));
  };
  const powerDialTotal = report ? report.reps.reduce((t, r) => t + r.bySource.powerDial.seconds, 0) : 0;

  return (
    <div className="calllog">
      <div className="calllog-head">
        <div className="calllog-title">Talk time</div>
      </div>
      <div className="calllog-head">
        <input type="date" className="calllog-filter" aria-label="From" value={range.from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="calllog-filter" aria-label="To" value={range.to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="calllog-head">
        {SHORTCUTS.map((s) => (
          <button key={s.id} className="btn ghost" onClick={() => setRange(rangeFor(s.id))}>{s.label}</button>
        ))}
      </div>
      <div className="calllog-summary">
        Pacific time. Talk time counts connected calls — click-to-dial, power dial and answered inbound. On dialer is how
        long the rep&rsquo;s line was open on the power dialer.
      </div>
      {error && <div className="admin-err" role="alert">{error}</div>}
      {loading && !report && <div className="empty-state"><span className="spinner lg" /></div>}
      {report && (
        <div className="calllog-scroll">
          <table className="calllog-table">
            <thead>
              <tr>
                <th>Rep</th><th>Talk time</th><th>Connected</th><th>Power-dial talk</th><th>On dialer</th>
              </tr>
            </thead>
            <tbody>
              {report.reps.map((r) => (
                <Fragment key={r.userId}>
                  <tr>
                    <td>
                      <button className="btn ghost" aria-expanded={open === r.userId} onClick={() => setOpen(open === r.userId ? null : r.userId)}>
                        {r.name}
                      </button>
                    </td>
                    <td className="dur">{formatHms(r.talkSeconds)}</td>
                    <td className="dur">{r.connectedCalls}</td>
                    <td className="dur">{formatHms(r.bySource.powerDial.seconds)}</td>
                    <td className="dur">{formatHms(r.dialerSeconds)}</td>
                  </tr>
                  {open === r.userId &&
                    r.days.map((d) => (
                      <tr key={d.day}>
                        <td className="nowrap">{formatDay(d.day)}</td>
                        <td className="dur">{formatHms(d.talkSeconds)}</td>
                        <td className="dur">{d.connectedCalls}</td>
                        <td />
                        <td className="dur">{formatHms(d.dialerSeconds)}</td>
                      </tr>
                    ))}
                </Fragment>
              ))}
              {report.reps.length === 0 ? (
                <tr><td colSpan={5} className="calllog-empty">No talk time in this range.</td></tr>
              ) : (
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="dur">{formatHms(report.totals.talkSeconds)}</td>
                  <td className="dur">{report.totals.connectedCalls}</td>
                  <td className="dur">{formatHms(powerDialTotal)}</td>
                  <td className="dur">{formatHms(report.totals.dialerSeconds)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add the tab** — in `apps/cti-web/src/nav.ts`:
  - `Tab` becomes `'dialer' | 'powerdial' | 'recent' | 'team' | 'talktime' | 'reputation' | 'admin' | 'calls' | 'settings'`;
  - `NAV_OVERFLOW_IDS` becomes `['team', 'talktime', 'reputation', 'admin', 'calls']`;
  - in `navTabsFor`'s admin list, directly after `{ id: 'team', label: 'Team' },`, add `{ id: 'talktime', label: 'Talk time' },`;
  - in the doc comment above `navTabsFor`, change "Team, Reputation, Numbers (`admin`) and Calls are admin-only." to "Team, Talk time, Reputation, Numbers (`admin`) and Calls are admin-only.".

  In `apps/cti-web/src/App.tsx`:
  - add `import { TalkTimePanel } from './components/TalkTimePanel';` beside the `TeamPanel` import;
  - directly after the `) : tab === 'team' ? ( <TeamPanel />` branch, add:

```tsx
  ) : tab === 'talktime' ? (
    <TalkTimePanel />
```

  Then run `grep -rn "'team'" apps/cti-web/src --include='*.ts' --include='*.tsx'`. If any other list of tab ids exists outside `nav.ts`, `App.tsx` and tests (for example a persisted-tab validator), add `'talktime'` beside `'team'` there too, and say so in your report.

- [ ] **Step 6: Write the runbook** — `docs/runbooks/talk-time-report.md`

```markdown
# Talk-time report

Admin-only. Softphone → **More → Talk time**. Also `GET /admin/talk-time?from=YYYY-MM-DD&to=YYYY-MM-DD`
(admin session; at most 92 days). Design: `docs/superpowers/specs/2026-10-01-talk-time-report-design.md`.

## The columns

| Column | What it counts |
|---|---|
| Talk time | Seconds on every connected call that started that Pacific day. Outbound click-to-dial: wrap-up disposition **Connected**. Power dial: every call bridged to the rep. Inbound: answered by the rep, not voicemail. |
| Connected | How many such calls. |
| Power-dial talk | The power-dial share of Talk time (bridge → hang-up; AMD screening excluded). |
| On dialer | How long the rep's line sat on the power dialer: from the softphone joining the dialer to that leg ending. Dialing, hold music and talking all count. A rep with two legs at once (a tab replaced its leg) is counted once. A leg still open counts up to now. |

Days are America/Los_Angeles. A call counts on the day it started. A dialer leg across midnight is split.

## Where the numbers come from

- **Regular calls:** `calls.talk_seconds`, the true talk time (ring time excluded), from the deploy of 0048 on. Older calls fall back to `calls.duration_seconds`, which includes ringing. So ranges before the deploy read high.
- **Power dial:** `dialer_connects.talk_seconds` (migration 0047).
- **On dialer:** `dialer_rep_legs` (migration 0048). How a leg's end gets stamped, in order:
  1. the leg's own Twilio status callback (`rep_left`);
  2. the rejoin route (`rep_left` / `run_end`);
  3. the run's end (`run_end`);
  4. a newer leg on the same run (`replaced`);
  5. failing all of those, the reconcile loop (every 5 min, Twilio's call record, `reconciled`; after 48 h of Twilio errors a leg is closed at join + 12 h, `fallback`, logged `[dialer] rep leg closed by rule`).

## The Salesforce talk-time report

Report `00OUS000007DAyP2AW` sums Task Call Duration. From the deploy on, each Task's Call Duration is the true talk time:
- an unanswered click-to-dial logs 0, not its ringing;
- power-dial calls have their own Tasks (`Outbound Call | Connected | …`).

Past Tasks were not rewritten. Days before the deploy still include ring time.

`calls.duration_seconds`, which number reputation (answer rate, auto-pause) reads, is unchanged.

## Checks

- **Open legs right now:**
  ```sql
  select user_id, joined_at from dialer_rep_legs where ended_at is null order by joined_at;
  ```
  More than one per rep, or one far older than today, means end stamps are being missed. Look for `[dialer] rep leg` in the logs.
- **How each leg ended, last 7 days:**
  ```sql
  select end_source, count(*) from dialer_rep_legs where joined_at > now() - interval '7 days' group by 1;
  ```
  Mostly `rep_left` / `run_end` is healthy. Many `reconciled` means the status callback is not reaching `/telephony/twilio/status`.
- **True talk time is being written:**
  ```sql
  select count(*) filter (where talk_seconds is not null), count(*) from calls where created_at > now() - interval '1 day' and direction = 'outbound';
  ```
```

- [ ] **Step 7: Run the web suite and typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/apps/cti-web && npx vitest run && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add apps/cti-web/src/nav.ts apps/cti-web/src/nav.test.ts apps/cti-web/src/App.tsx \
  apps/cti-web/src/talk-time-api.ts apps/cti-web/src/talk-time-format.ts apps/cti-web/src/talk-time-format.test.ts \
  apps/cti-web/src/components/TalkTimePanel.tsx apps/cti-web/src/components/TalkTimePanel.test.tsx \
  docs/runbooks/talk-time-report.md
git commit -m "feat(web): admin Talk time screen — per rep, date range, per-day detail; runbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add any other file Step 5's grep made you touch to the same commit.)

---

## After Task 7

The recording plan's Task 11 is the whole-branch review. It now covers BOTH plans: run it over `git merge-base origin/main HEAD..HEAD`, give the reviewer both plans' Global Constraints and the Minor-findings list in `.superpowers/sdd/progress.md`, and then go through the user-gated deploy and the live checks.

Live checks for this plan, run on the E2E harness (`+16194737991`, CTI DIAL TEST, softphone as Evren):
1. One click-to-dial no-answer. Expect `calls.talk_seconds = 0` and a Task Call Duration of 0.
2. One connected click-to-dial. Expect `talk_seconds` ≈ the conversation length.
3. A short power-dial run. Expect a `dialer_rep_legs` row with `end_source` `run_end` or `rep_left`.
4. **Talk time** for today shows all three.
