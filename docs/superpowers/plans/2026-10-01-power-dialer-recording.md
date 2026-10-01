# Power-Dialer Call Recording + Connected-Call Task — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every power-dial call that is bridged to a rep, and log one completed Call Task per bridged call on the screen-popped Salesforce record, carrying the public recording link.

**Architecture:** A new dialer-owned table `dialer_connects` gets one row per bridged call, written by the engine right after `bridgeToRep`; the engine then starts a Twilio Recordings-API recording on the prospect's leg. The dialer's status callback stamps the hang-up, a new recording webhook stores the media URL, and a new scan-based worker creates the Task (as the rep, behind the click-to-dial ownership gate) and then PATCHes the recording link. `/recordings/:id` resolves `dialer_connects` ids too. Nothing that reads `calls` changes.

**Tech Stack:** TypeScript (Node ≥ 20.10, ESM), Fastify 4, drizzle-orm 0.36.4 on Postgres (hand-written SQL migrations), twilio-node 5.x, vitest 2. Spec: `docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md`.

## Global Constraints

- **Work only in the worktree** `/Users/cdrshepard/spam-res-cti-dialer-rec` on branch `feat/dialer-recording` (cut from `origin/main` 3746990). NEVER edit `/Users/cdrshepard/spam-res-cti` — that checkout holds another session's uncommitted work.
- **Pushing `main` deploys to production** (Railway). No push, merge, or deploy without the user's explicit go-ahead.
- `calls`, every reader of `calls`, the compliance counters (`firewall/attempts.ts`, `daily-cap.ts`, `evaluate.ts` state rules, `contact-history-live.ts`), the Recent list, the pending-disposition banner, no-answer Chatter, follow-up rollover, and the softphone UI are **not modified**.
- Only the **prospect's** leg is recorded, and only **after** `bridgeToRep` succeeds. The AMD screening and the rep's conference leg are never recorded.
- Recording happens only when `TWILIO_RECORD_CALLS` is true **and** `DIALER_RECORDING=on` **and** the org's `default` campaign is not `recordingConsentMode='two_party'`. A failed consent lookup fails closed (no recording).
- Kill switches: `DIALER_RECORDING` and `DIALER_CONNECT_TASKS`, each `z.enum(['on','off']).default('on')` — strict like `NO_ANSWER_CHATTER` (`false`/`0` fail the boot).
- Task subject = THE call-subject rule, `buildCallSubject({ inbound: false, disposition: 'Connected', counterpartyE164, recordName })` → `Outbound Call | Connected | (619) 555-1234 / Jane Doe`.
- Task date: `ActivityDate` is the org's (America/Los_Angeles) calendar day — `orgTodayIso` — never the UTC date. A power-dial Task is dated the day it was BRIDGED. (The reps' Salesforce talk-time report 00OUS000007DAyP2AW filters `Due Date = TODAY`, `Subject contains Outbound,Inbound`, `Assigned = $USER`, and sums Call Duration.)
- Task links: Lead / Contact → `WhoId`; Opportunity → `WhatId`. Ownership gate = `mayCreateTaskOn` (click-to-dial rule). No Chatter post.
- No backfill: a pending row bridged more than **24 h** ago becomes `expired`. A row bridged more than **4 h** ago with no hang-up stamp is logged without a duration.
- Retries: claim = lease; backoff **5 min, 15 min, 1 h, 3 h, 6 h**; the **6th** failed try is final (`MAX_TRIES = 6`). A Salesforce auth error on the Task phase is not counted and retries in 1 h (the 24 h window bounds it).
- Migration is `0047_dialer_connects.sql`, idempotent (`IF NOT EXISTS`), with a **FULL** (not partial) unique index on `call_sid`; inserts use the **bare** `onConflictDoNothing()`.
- Never log phone numbers, recording URLs, or Salesforce tokens. Log ids (`connectId`, `itemId`, `userId`) only.
- Commits: conventional (`feat:`, `test:`, `docs:` …) and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Map

| File | Change | Responsibility |
|---|---|---|
| `packages/db/migrations/0047_dialer_connects.sql` | create | the table, CHECKs, indexes |
| `packages/db/src/schema.ts` | modify | `dialerConnects` + state constants + `DialerConnect` type |
| `packages/db/src/migration-0047.test.ts` | create | pins the SQL |
| `services/cti-api/src/dialer/twilio-telephony.ts` | modify | `startRecording`, `DIALER_RECORDING_PATH` |
| `services/cti-api/src/dialer/connect-log.ts` | create | write side: row insert, recording decision, end stamp, URL store, consent lookup |
| `services/cti-api/src/dialer/engine.ts` | modify | `EngineDeps.onBridged`, called after the bridge |
| `services/cti-api/src/dialer/live-deps.ts` | modify | wires `onBridged` |
| `services/cti-api/src/config.ts` | modify | `DIALER_RECORDING`, `DIALER_CONNECT_TASKS` |
| `services/cti-api/src/routes/dialer.ts` | modify | hang-up stamp on `/dialer-status`; new `/dialer-recording` route |
| `services/cti-api/src/routes/recordings.ts` | modify | `resolveRecordingUrl` (calls, then dialer_connects) |
| `services/cti-api/src/salesforce/client.ts` | modify | `createCallTask` dates Tasks in the org's (Pacific) day, `activityDate` override |
| `services/cti-api/src/salesforce/dialer-connect-task.ts` | create | pure: backoff, links, Task payload |
| `services/cti-api/src/salesforce/dialer-connect-worker.ts` | create | the Task + link worker, loop, kill switch |
| `services/cti-api/src/server.ts` | modify | starts/stops the worker loop |
| `docs/runbooks/power-dial-recording.md` | create | switches + read-only checks |

---

### Task 0: Worktree setup and a green baseline

**Files:** none changed.

- [ ] **Step 1: Install dependencies in the worktree**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npm ci`
Expected: completes with `added N packages`.

- [ ] **Step 2: Build the workspace packages** (`services/cti-api` imports `@cti/db` from its `dist/`)

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npm run build:packages`
Expected: exits 0.

- [ ] **Step 3: Baseline the suites this plan touches**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer src/routes src/salesforce src/config.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS, typecheck clean. If anything already fails, STOP and report it — do not fix unrelated failures.

---

### Task 1: `dialer_connects` table

**Files:**
- Create: `packages/db/migrations/0047_dialer_connects.sql`
- Modify: `packages/db/src/schema.ts` (add after the `inboundTextDigests` block, before the `export type Call = …` lines near the end)
- Test: `packages/db/src/migration-0047.test.ts`

**Interfaces:**
- Produces: `dialerConnects` (drizzle table), `DIALER_CONNECT_RECORDING_STATES`, `DialerConnectRecordingState`, `DIALER_CONNECT_TASK_STATES`, `DialerConnectTaskState`, `DialerConnect` (= `typeof dialerConnects.$inferSelect`), all exported from `@cti/db`. Camel-case columns: `id, orgId, userId, sfUserId, sessionId, itemId, callSid, objectType, recordId, fromNumber, toNumber, bridgedAt, endedAt, talkSeconds, recordingState, recordingUrl, taskState, taskAttempts, nextAttemptAt, lastError, salesforceTaskId, linkAttempts, recordingLinkSyncedAt, createdAt, updatedAt`.

- [ ] **Step 1: Write the failing test** — `packages/db/src/migration-0047.test.ts`

```ts
/**
 * 0047_dialer_connects.sql — one row per bridged power-dial call, pinned.
 *
 * Read from disk rather than applied (no database in the unit suite), so the
 * file's text IS the contract. The load-bearing line is the FULL unique index
 * on call_sid: dialer/connect-log.ts inserts with a bare ON CONFLICT DO NOTHING
 * so a re-delivered AMD "human" for the same call writes nothing. A PARTIAL
 * unique index cannot arbitrate a bare ON CONFLICT (42P10 on every insert —
 * the calls_provider_call_id_unique incident).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DIALER_CONNECT_RECORDING_STATES, DIALER_CONNECT_TASK_STATES, dialerConnects } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0047_dialer_connects.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0047_dialer_connects', () => {
  it('creates the table idempotently with every column the design names, FK-free', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "dialer_connects" \(/);
    for (const col of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"org_id" uuid NOT NULL',
      '"user_id" uuid NOT NULL',
      '"sf_user_id" text NOT NULL',
      '"session_id" uuid NOT NULL',
      '"item_id" uuid NOT NULL',
      '"call_sid" text NOT NULL',
      '"object_type" text NOT NULL',
      '"record_id" text NOT NULL',
      '"from_number" text NOT NULL',
      '"to_number" text NOT NULL',
      '"bridged_at" timestamptz NOT NULL DEFAULT now()',
      '"ended_at" timestamptz',
      '"talk_seconds" integer',
      '"recording_state" text NOT NULL DEFAULT \'pending\'',
      '"recording_url" text',
      '"task_state" text NOT NULL DEFAULT \'pending\'',
      '"task_attempts" integer NOT NULL DEFAULT 0',
      '"next_attempt_at" timestamptz NOT NULL DEFAULT now()',
      '"last_error" text',
      '"salesforce_task_id" text',
      '"link_attempts" integer NOT NULL DEFAULT 0',
      '"recording_link_synced_at" timestamptz',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(col);
    }
    expect(create).not.toContain('REFERENCES');
  });

  it('CHECKs the two state columns against exactly the schema constants', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'))!;
    const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');
    expect(create).toContain(
      `CONSTRAINT "dialer_connects_recording_state_check" CHECK ("recording_state" IN (${list(DIALER_CONNECT_RECORDING_STATES)}))`,
    );
    expect(create).toContain(
      `CONSTRAINT "dialer_connects_task_state_check" CHECK ("task_state" IN (${list(DIALER_CONNECT_TASK_STATES)}))`,
    );
  });

  it('call_sid has a FULL unique index (no WHERE) — the bare ON CONFLICT arbiter', () => {
    const idx = statements.find((s) => s.includes('"dialer_connects_call_sid_unique"'));
    expect(idx).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "dialer_connects_call_sid_unique" ON "dialer_connects" ("call_sid")');
  });

  it('indexes the worker scan (task_state, next_attempt_at)', () => {
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS "dialer_connects_task_due_idx" ON "dialer_connects" ("task_state", "next_attempt_at")',
    );
  });

  it('the drizzle table matches: same name, same indexes, no foreign keys', () => {
    const cfg = getTableConfig(dialerConnects);
    expect(cfg.name).toBe('dialer_connects');
    expect(cfg.foreignKeys).toHaveLength(0);
    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([
      'dialer_connects_call_sid_unique',
      'dialer_connects_task_due_idx',
    ]);
    const unique = cfg.indexes.find((i) => i.config.name === 'dialer_connects_call_sid_unique')!;
    expect(unique.config.unique).toBe(true);
    expect(unique.config.where).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/packages/db && npx vitest run src/migration-0047.test.ts`
Expected: FAIL — `ENOENT … 0047_dialer_connects.sql` / missing export `dialerConnects`.

- [ ] **Step 3: Write the migration** — `packages/db/migrations/0047_dialer_connects.sql`

```sql
-- =============================================================================
-- 0047_dialer_connects.sql — one row per power-dial call bridged to a rep
-- (design: docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md).
--
-- Written by dialer/connect-log.ts right after the engine bridges a human into
-- the rep's room, BEFORE the recording starts, so the recording callback always
-- finds its row. Read by salesforce/dialer-connect-worker.ts, which logs ONE
-- completed Call Task per row and then attaches the public recording link.
--
-- FK-FREE ON PURPOSE (like dialer_dial_attempts): a recording link lives in a
-- Salesforce Task for good, so the row behind it must outlive any run, item,
-- or user cleanup.
--
-- call_sid          The prospect's leg. UNIQUE with a FULL index: a re-delivered
--                   AMD "human" inserts ON CONFLICT DO NOTHING, and a PARTIAL
--                   unique index cannot arbitrate that (42P10).
-- sf_user_id        The rep's Salesforce user id (dialer_sessions.sf_owner_id)
--                   — the ownership gate's caller, without a /users/me call.
-- bridged_at        When the prospect joined the rep. talk_seconds is measured
--                   from here, so the AMD screening seconds are not counted.
-- ended_at          Stamped from the prospect leg's `completed` status callback.
-- recording_state   pending (row written) -> requested | start_failed |
--                   skipped_consent (two-party org, or the lookup failed) |
--                   skipped_switch (TWILIO_RECORD_CALLS / DIALER_RECORDING off).
-- recording_url     Twilio media URL + `.mp3`, from the recording callback.
-- task_state        pending -> created | skipped_not_owner | expired (bridged
--                   > 24 h ago, never logged) | failed (gave up).
-- task_attempts / link_attempts / next_attempt_at
--                   The worker's claim IS its lease: a claim bumps the counter
--                   and pushes next_attempt_at out by that try's backoff.
-- recording_link_synced_at  The link PATCH landed (or was rejected for good).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "dialer_connects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "sf_user_id" text NOT NULL,
  "session_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "call_sid" text NOT NULL,
  "object_type" text NOT NULL,
  "record_id" text NOT NULL,
  "from_number" text NOT NULL,
  "to_number" text NOT NULL,
  "bridged_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  "talk_seconds" integer,
  "recording_state" text NOT NULL DEFAULT 'pending',
  "recording_url" text,
  "task_state" text NOT NULL DEFAULT 'pending',
  "task_attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "salesforce_task_id" text,
  "link_attempts" integer NOT NULL DEFAULT 0,
  "recording_link_synced_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dialer_connects_recording_state_check" CHECK ("recording_state" IN ('pending','requested','start_failed','skipped_consent','skipped_switch')),
  CONSTRAINT "dialer_connects_task_state_check" CHECK ("task_state" IN ('pending','created','skipped_not_owner','expired','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "dialer_connects_call_sid_unique" ON "dialer_connects" ("call_sid");

-- The worker's scan: pending rows whose next_attempt_at has passed.
CREATE INDEX IF NOT EXISTS "dialer_connects_task_due_idx" ON "dialer_connects" ("task_state", "next_attempt_at");
```

- [ ] **Step 4: Add the drizzle table** — in `packages/db/src/schema.ts`, insert after the `export type InboundTextDigest = …` line:

```ts
/** Every recording_state a dialer_connects row can hold (migration 0047's CHECK). */
export const DIALER_CONNECT_RECORDING_STATES = ['pending', 'requested', 'start_failed', 'skipped_consent', 'skipped_switch'] as const;
export type DialerConnectRecordingState = (typeof DIALER_CONNECT_RECORDING_STATES)[number];
/** Every task_state a dialer_connects row can hold (migration 0047's CHECK). */
export const DIALER_CONNECT_TASK_STATES = ['pending', 'created', 'skipped_not_owner', 'expired', 'failed'] as const;
export type DialerConnectTaskState = (typeof DIALER_CONNECT_TASK_STATES)[number];

/**
 * One row per power-dial call bridged to a rep (migration 0047). Written by
 * dialer/connect-log.ts right after the bridge, before the recording starts;
 * turned into ONE completed Call Task + recording link by
 * salesforce/dialer-connect-worker.ts. FK-free like dialerDialAttempts — a
 * recording link in Salesforce must outlive any run or item cleanup.
 */
export const dialerConnects = pgTable(
  'dialer_connects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** The rep's Salesforce user id — the ownership gate's caller. */
    sfUserId: text('sf_user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    itemId: uuid('item_id').notNull(),
    /** The prospect's leg. FULL unique index: the bare ON CONFLICT arbiter. */
    callSid: text('call_sid').notNull(),
    objectType: text('object_type').notNull(),
    recordId: text('record_id').notNull(),
    fromNumber: text('from_number').notNull(),
    toNumber: text('to_number').notNull(),
    bridgedAt: timestamp('bridged_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** ended_at − bridged_at: the screening seconds are not talk time. */
    talkSeconds: integer('talk_seconds'),
    recordingState: text('recording_state').$type<DialerConnectRecordingState>().default('pending').notNull(),
    recordingUrl: text('recording_url'),
    taskState: text('task_state').$type<DialerConnectTaskState>().default('pending').notNull(),
    taskAttempts: integer('task_attempts').default(0).notNull(),
    /** The worker's lease and backoff clock, for both phases. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastError: text('last_error'),
    salesforceTaskId: text('salesforce_task_id'),
    linkAttempts: integer('link_attempts').default(0).notNull(),
    recordingLinkSyncedAt: timestamp('recording_link_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // FULL, never partial: connect-log's bare ON CONFLICT DO NOTHING arbitrates on it.
    callSidUnique: uniqueIndex('dialer_connects_call_sid_unique').on(t.callSid),
    taskDueIdx: index('dialer_connects_task_due_idx').on(t.taskState, t.nextAttemptAt),
  }),
);
export type DialerConnect = typeof dialerConnects.$inferSelect;
```

- [ ] **Step 5: Run the test and the db suite**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/packages/db && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Rebuild the package so `services/cti-api` sees the new export**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npm -w packages/db run build`
Expected: exits 0; `grep -c dialerConnects packages/db/dist/schema.js` prints a number ≥ 1.

- [ ] **Step 7: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add packages/db/migrations/0047_dialer_connects.sql packages/db/src/schema.ts packages/db/src/migration-0047.test.ts
git commit -m "feat(db): dialer_connects — one row per bridged power-dial call (mig 0047)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `TwilioDialerTelephony.startRecording`

**Files:**
- Modify: `services/cti-api/src/dialer/twilio-telephony.ts`
- Test: `services/cti-api/src/dialer/twilio-telephony.test.ts`

**Interfaces:**
- Produces: `export const DIALER_RECORDING_PATH = '/telephony/twilio/dialer-recording'`; `TwilioDialerTelephony#startRecording(callSid: string, connectId: string): Promise<void>`; constructor gains a 2nd optional param `sleep: (ms: number) => Promise<void>`; `export const RECORDING_RETRY_DELAY_MS = 750`; `export const TWILIO_CALL_NOT_IN_PROGRESS = 21220`. `TwilioDialerClient['calls']` call context gains `recordings.create`. The `DialerTelephony` port is NOT changed (only connect-log calls this, through its own deps).

- [ ] **Step 1: Extend the test fake** — in `twilio-telephony.test.ts`, change `fakeClient`:
  - add `recordingFailures?: unknown[]` to its `opts` type;
  - add `recordingCreates: { callId: string; args: Record<string, unknown> }[];` to the return type and `const recordingCreates: { callId: string; args: Record<string, unknown> }[] = [];` next to `createCalls`;
  - give the `callsFn` context a `recordings` member, so the object it returns becomes:

```ts
  const callsFn = ((callSid: string) => ({
    update: async (args: Record<string, unknown>) => {
      if (fails(`call:${callSid}`)) throw new Error('Call is not in-progress');
      updateCalls.push({ callId: callSid, args });
      events.push(`call:${callSid}`);
      return {};
    },
    recordings: {
      create: async (args: Record<string, unknown>) => {
        recordingCreates.push({ callId: callSid, args });
        const failure = opts.recordingFailures?.shift();
        if (failure !== undefined) throw failure;
        return { sid: 'RE1' };
      },
    },
  })) as TwilioDialerClient['calls'];
```
  - include `recordingCreates` in the object `fakeClient` returns;
  - add `DIALER_RECORDING_PATH, RECORDING_RETRY_DELAY_MS` to the import from `./twilio-telephony.js`.

- [ ] **Step 2: Write the failing tests** — append to `twilio-telephony.test.ts`:

```ts
describe('TwilioDialerTelephony.startRecording', () => {
  const SID = 'CA' + 'a'.repeat(32);
  const CONNECT = '11111111-2222-4333-8444-555555555555';
  const noSleep = async () => {};

  it('records the prospect leg dual-channel, posting the finished recording to the dialer-recording route keyed by our row id', async () => {
    const { client, recordingCreates } = fakeClient();
    await new TwilioDialerTelephony(() => client, noSleep).startRecording(SID, CONNECT);
    expect(recordingCreates).toEqual([
      {
        callId: SID,
        args: {
          recordingChannels: 'dual',
          recordingStatusCallback: `https://api.test.example${DIALER_RECORDING_PATH}?connectId=${CONNECT}`,
          recordingStatusCallbackEvent: ['completed'],
          recordingStatusCallbackMethod: 'POST',
        },
      },
    ]);
    expect(DIALER_RECORDING_PATH).toBe('/telephony/twilio/dialer-recording');
  });

  it('retries ONCE after a short pause — Twilio may still be applying the bridge TwiML', async () => {
    const { client, recordingCreates } = fakeClient([], { recordingFailures: [new Error('transient')] });
    const sleep = vi.fn(async () => {});
    await new TwilioDialerTelephony(() => client, sleep).startRecording(SID, CONNECT);
    expect(recordingCreates).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(RECORDING_RETRY_DELAY_MS);
  });

  it('does NOT retry when the call already ended (21220) — there is nothing left to record', async () => {
    const ended = Object.assign(new Error('Call is not in-progress'), { code: 21220 });
    const { client, recordingCreates } = fakeClient([], { recordingFailures: [ended] });
    await expect(new TwilioDialerTelephony(() => client, noSleep).startRecording(SID, CONNECT)).rejects.toBe(ended);
    expect(recordingCreates).toHaveLength(1);
  });

  it('a second failure propagates to the caller (connect-log stamps start_failed)', async () => {
    const { client, recordingCreates } = fakeClient([], { recordingFailures: [new Error('a'), new Error('b')] });
    await expect(new TwilioDialerTelephony(() => client, noSleep).startRecording(SID, CONNECT)).rejects.toThrow('b');
    expect(recordingCreates).toHaveLength(2);
  });

  it('originate still never records the screening leg', async () => {
    const { client, createCalls, recordingCreates } = fakeClient();
    await new TwilioDialerTelephony(() => client, noSleep).originate({ sessionId: 's', itemId: 'i', fromE164: '+16195550101', toE164: '+16195559999', userId: 'u' });
    expect(createCalls[0]).not.toHaveProperty('record');
    expect(recordingCreates).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer/twilio-telephony.test.ts`
Expected: FAIL — `DIALER_RECORDING_PATH` undefined / `startRecording is not a function`.

- [ ] **Step 4: Implement** — in `twilio-telephony.ts`:

  (a) widen the client type's call context:

```ts
export interface TwilioDialerClient {
  calls: ((callSid: string) => {
    update(args: Record<string, unknown>): Promise<unknown>;
    /** Call Recordings API — start a recording on an in-progress call. */
    recordings: { create(args: Record<string, unknown>): Promise<{ sid: string }> };
  }) & {
    create(args: Record<string, unknown>): Promise<{ sid: string }>;
  };
```
  (leave the `conferences` member exactly as it is).

  (b) after `dialerRejoinUrl()`, add:

```ts
/** Where Twilio posts a finished power-dial recording (routes/dialer.ts). One
 *  constant for the URL `startRecording` names and the route that serves it. */
export const DIALER_RECORDING_PATH = '/telephony/twilio/dialer-recording';
/** The pause before the one retry of a failed recording start. */
export const RECORDING_RETRY_DELAY_MS = 750;
/** Twilio 21220: the call is no longer in progress — nothing left to record. */
export const TWILIO_CALL_NOT_IN_PROGRESS = 21220;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
```

  (c) give the constructor the sleep seam:

```ts
  constructor(
    private clientFactory: () => TwilioDialerClient = () => {
      const cfg = loadConfig();
      return twilio(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN) as unknown as TwilioDialerClient;
    },
    private sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}
```

  (d) replace the NOTE comment inside `originate`'s `calls.create` args with:

```ts
      // Never recorded: the prospect answers this leg before any rep is on it.
      // The bridged conversation is recorded by `startRecording`, which the
      // engine's bridge hook (dialer/connect-log.ts) calls only AFTER bridgeToRep.
```

  (e) add the method after `bridgeToRep`:

```ts
  /**
   * Record the PROSPECT's leg from now until it ends. Called only after
   * `bridgeToRep` (dialer/connect-log.ts), so the AMD screening is never on
   * it. Dual channel like click-to-dial: the prospect on track 1, what they
   * hear — the rep, via the room — on track 2. Twilio posts the finished file
   * to DIALER_RECORDING_PATH keyed by OUR row id (`connectId`), never by
   * anything the prospect could influence.
   *
   * One retry after a short pause: Twilio documents that a record request can
   * fail while a call's new TwiML is still being applied. Not after 21220 — the
   * call already ended. A retry whose first try secretly landed makes a second
   * recording of the same call; the callback just stores the later one.
   */
  async startRecording(callSid: string, connectId: string): Promise<void> {
    const cfg = loadConfig();
    const client = this.clientFactory();
    const args = {
      recordingChannels: 'dual',
      recordingStatusCallback: `${cfg.API_PUBLIC_URL}${DIALER_RECORDING_PATH}?connectId=${connectId}`,
      recordingStatusCallbackEvent: ['completed'],
      recordingStatusCallbackMethod: 'POST',
    };
    try {
      await client.calls(callSid).recordings.create(args);
    } catch (err) {
      if ((err as { code?: unknown }).code === TWILIO_CALL_NOT_IN_PROGRESS) throw err;
      await this.sleep(RECORDING_RETRY_DELAY_MS);
      await client.calls(callSid).recordings.create(args);
    }
  }
```

- [ ] **Step 5: Run the file and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer/twilio-telephony.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/dialer/twilio-telephony.ts services/cti-api/src/dialer/twilio-telephony.test.ts
git commit -m "feat(dialer): startRecording — dual-channel recording of the bridged prospect leg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The connect log (write side)

**Files:**
- Create: `services/cti-api/src/dialer/connect-log.ts`
- Test: `services/cti-api/src/dialer/connect-log.test.ts`

**Interfaces:**
- Consumes: `schema.dialerConnects`, `DialerConnectRecordingState` (Task 1).
- Produces:
  - `interface BridgedCall { orgId: string; userId: string; sfUserId: string; sessionId: string; itemId: string; callSid: string; objectType: string; recordId: string; fromNumber: string | null; toNumber: string | null }`
  - `interface ConnectLogDeps { db: Db; now: () => Date; recordingEnabled: boolean; isTwoParty: (orgId: string) => Promise<boolean>; startRecording: (callSid: string, connectId: string) => Promise<void> }`
  - `recordBridgedCall(call: BridgedCall, deps: ConnectLogDeps): Promise<void>` — never throws for a recording problem.
  - `insertConnect(db, row, at)`, `setRecordingState(db, id, state, at)`, `stampConnectEnded(db, callSid, at)`, `storeConnectRecording(db, connectId, callSid, recordingUrl, at)`, `orgIsTwoParty(db, orgId): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** — `connect-log.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  insertConnect,
  orgIsTwoParty,
  recordBridgedCall,
  stampConnectEnded,
  storeConnectRecording,
  type BridgedCall,
  type ConnectLogDeps,
} from './connect-log.js';

const NOW = new Date('2026-10-01T18:00:00Z');
const SID = 'CA' + 'a'.repeat(32);
const CALL: BridgedCall = {
  orgId: 'org-1', userId: 'rep-1', sfUserId: '005REP000000001', sessionId: 'sess-1', itemId: 'item-1',
  callSid: SID, objectType: 'Opportunity', recordId: '006000000000001AAA',
  fromNumber: '+16195550101', toNumber: '+16195559999',
};

function harness(over: Partial<ConnectLogDeps> = {}, inserted: Array<{ id: string }> = [{ id: 'conn-1' }]) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const order: string[] = [];
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => { order.push('insert'); return inserted; } }) };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => { updates.push(patch); order.push(`state:${String(patch.recordingState)}`); },
      }),
    }),
  } as unknown as ConnectLogDeps['db'];
  const deps: ConnectLogDeps = {
    db,
    now: () => NOW,
    recordingEnabled: true,
    isTwoParty: vi.fn(async () => false),
    startRecording: vi.fn(async () => { order.push('start'); }),
    ...over,
  };
  return { deps, inserts, updates, order };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('recordBridgedCall', () => {
  it('writes the row, THEN starts the recording keyed by the new row id, THEN stamps requested', async () => {
    const h = harness();
    await recordBridgedCall(CALL, h.deps);
    expect(h.order).toEqual(['insert', 'start', 'state:requested']);
    expect(h.deps.startRecording).toHaveBeenCalledWith(SID, 'conn-1');
    expect(h.inserts[0]).toMatchObject({
      orgId: 'org-1', userId: 'rep-1', sfUserId: '005REP000000001', sessionId: 'sess-1', itemId: 'item-1',
      callSid: SID, objectType: 'Opportunity', recordId: '006000000000001AAA',
      fromNumber: '+16195550101', toNumber: '+16195559999', bridgedAt: NOW,
    });
  });

  it('a re-delivered AMD "human" (the insert conflicts) records nothing a second time', async () => {
    const h = harness({}, []);
    await recordBridgedCall(CALL, h.deps);
    expect(h.deps.startRecording).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it('a row with no dialed number or DID writes nothing and says so', async () => {
    const h = harness();
    await recordBridgedCall({ ...CALL, toNumber: null }, h.deps);
    expect(h.inserts).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[dialer] bridged call not logged: no number', { itemId: 'item-1' });
  });

  it('a switch off → skipped_switch, no recording, but the row (and so the Task) stays', async () => {
    const h = harness({ recordingEnabled: false });
    await recordBridgedCall(CALL, h.deps);
    expect(h.inserts).toHaveLength(1);
    expect(h.deps.startRecording).not.toHaveBeenCalled();
    expect(h.updates).toEqual([expect.objectContaining({ recordingState: 'skipped_switch' })]);
  });

  it('a two-party org → skipped_consent: this path has no automated disclosure', async () => {
    const h = harness({ isTwoParty: vi.fn(async () => true) });
    await recordBridgedCall(CALL, h.deps);
    expect(h.deps.isTwoParty).toHaveBeenCalledWith('org-1');
    expect(h.deps.startRecording).not.toHaveBeenCalled();
    expect(h.updates).toEqual([expect.objectContaining({ recordingState: 'skipped_consent' })]);
  });

  it('a failed consent lookup fails CLOSED — skipped_consent, logged', async () => {
    const h = harness({ isTwoParty: vi.fn(async () => { throw new Error('db down'); }) });
    await recordBridgedCall(CALL, h.deps);
    expect(h.deps.startRecording).not.toHaveBeenCalled();
    expect(h.updates).toEqual([expect.objectContaining({ recordingState: 'skipped_consent' })]);
    expect(error).toHaveBeenCalledWith('[dialer] consent lookup failed — not recording', { connectId: 'conn-1', err: 'db down' });
  });

  it('a recording that will not start → start_failed, logged, and NO throw (the rep is on the call)', async () => {
    const h = harness({ startRecording: vi.fn(async () => { throw new Error('21220'); }) });
    await expect(recordBridgedCall(CALL, h.deps)).resolves.toBeUndefined();
    expect(h.updates).toEqual([expect.objectContaining({ recordingState: 'start_failed' })]);
    expect(error).toHaveBeenCalledWith('[dialer] recording did not start', { connectId: 'conn-1', err: '21220' });
  });
});

describe('orgIsTwoParty', () => {
  it('reads the org\'s default campaign', async () => {
    const findFirst = vi.fn(async () => ({ recordingConsentMode: 'two_party' }));
    const db = { query: { campaignConfigs: { findFirst } } } as unknown as ConnectLogDeps['db'];
    expect(await orgIsTwoParty(db, 'org-1')).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
  it('no campaign row, or any other mode, is not two-party', async () => {
    for (const row of [undefined, { recordingConsentMode: 'off' }, { recordingConsentMode: 'one_party' }]) {
      const db = { query: { campaignConfigs: { findFirst: vi.fn(async () => row) } } } as unknown as ConnectLogDeps['db'];
      expect(await orgIsTwoParty(db, 'org-1')).toBe(false);
    }
  });
});

describe('the connect-log SQL, rendered', () => {
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('insertConnect uses the BARE on conflict do nothing (a target would 42P10 on a partial index; ours is full, keep it bare)', () => {
    const { sql } = insertConnect(db, { ...CALL, fromNumber: '+16195550101', toNumber: '+16195559999' }, NOW).toSQL();
    expect(sql).toContain('on conflict do nothing');
    expect(sql).not.toContain('on conflict ("call_sid")');
    expect(sql).toContain('returning "id"');
  });

  it('stampConnectEnded only stamps a row still open, by call sid, and measures talk time from the bridge', () => {
    const { sql, params } = stampConnectEnded(db, SID, NOW).toSQL();
    expect(sql).toContain('"ended_at" = $');
    expect(sql).toContain('"talk_seconds" = greatest(0, round(extract(epoch from ($');
    expect(sql).toContain('"dialer_connects"."bridged_at"');
    expect(sql).toMatch(/where \("dialer_connects"\."call_sid" = \$\d+ and "dialer_connects"\."ended_at" is null\)/);
    expect(params).toContain(SID);
  });

  it('storeConnectRecording matches BOTH the row id and the call sid, and only hurries a row that already has its Task', () => {
    const { sql, params } = storeConnectRecording(db, 'conn-1', SID, 'https://api.twilio.com/x.mp3', NOW).toSQL();
    expect(sql).toMatch(/where \("dialer_connects"\."id" = \$\d+ and "dialer_connects"\."call_sid" = \$\d+\)/);
    expect(sql).toContain(`case when "dialer_connects"."task_state" = 'created' then`);
    expect(params).toEqual(expect.arrayContaining(['conn-1', SID, 'https://api.twilio.com/x.mp3']));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer/connect-log.test.ts`
Expected: FAIL — cannot resolve `./connect-log.js`.

- [ ] **Step 3: Implement** — `services/cti-api/src/dialer/connect-log.ts`

```ts
/**
 * The bridged-call log, write side (design: docs/superpowers/specs/
 * 2026-10-01-power-dialer-recording-design.md).
 *
 * The engine calls `recordBridgedCall` right after `bridgeToRep` succeeds —
 * never before, so a bridge that failed never becomes a Task for a call that
 * did not happen. Order inside: the row FIRST, then the recording, because the
 * recording's callback is keyed by the row id and must always find its row.
 *
 * Nothing here may break a live call: every recording problem is stamped on
 * the row and logged, never thrown. (A failed row insert does throw — the
 * engine catches and logs it; with no row there is nothing to record into.)
 *
 * The hang-up stamp and the recording URL are written by the dialer's webhooks
 * (routes/dialer.ts) through `stampConnectEnded` / `storeConnectRecording`.
 * salesforce/dialer-connect-worker.ts turns each row into one Call Task.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, schema, type DialerConnectRecordingState } from '@cti/db';

type Db = ReturnType<typeof getDb>;
const c = schema.dialerConnects;

export interface BridgedCall {
  orgId: string;
  userId: string;
  /** The rep's Salesforce user id (dialer_sessions.sf_owner_id). */
  sfUserId: string;
  sessionId: string;
  itemId: string;
  /** The prospect's leg — the call that was just bridged. */
  callSid: string;
  objectType: string;
  recordId: string;
  fromNumber: string | null;
  toNumber: string | null;
}

export interface ConnectLogDeps {
  db: Db;
  now: () => Date;
  /** TWILIO_RECORD_CALLS && DIALER_RECORDING === 'on' (live-deps.ts). */
  recordingEnabled: boolean;
  /** Is the org's default campaign set to the automated two-party disclosure? */
  isTwoParty: (orgId: string) => Promise<boolean>;
  startRecording: (callSid: string, connectId: string) => Promise<void>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function insertConnect(
  db: Db,
  call: BridgedCall & { fromNumber: string; toNumber: string },
  at: Date,
) {
  return db
    .insert(c)
    .values({
      orgId: call.orgId,
      userId: call.userId,
      sfUserId: call.sfUserId,
      sessionId: call.sessionId,
      itemId: call.itemId,
      callSid: call.callSid,
      objectType: call.objectType,
      recordId: call.recordId,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      bridgedAt: at,
    })
    // BARE on purpose: the call_sid index is full, and a target clause is what
    // turned every insert into 42P10 on the calls table's partial index.
    .onConflictDoNothing()
    .returning({ id: c.id });
}

export function setRecordingState(db: Db, id: string, state: DialerConnectRecordingState, at: Date) {
  return db.update(c).set({ recordingState: state, updatedAt: at }).where(eq(c.id, id));
}

/** The prospect's leg ended: stamp it once. Talk time runs from the bridge. */
export function stampConnectEnded(db: Db, callSid: string, at: Date) {
  const iso = at.toISOString();
  return db
    .update(c)
    .set({
      endedAt: at,
      talkSeconds: sql`greatest(0, round(extract(epoch from (${iso}::timestamptz - ${c.bridgedAt}))))::int`,
      updatedAt: at,
    })
    .where(and(eq(c.callSid, callSid), isNull(c.endedAt)));
}

/**
 * Store a finished recording. Matches the row id AND the call sid: the id is
 * public (it is in the playback link), so an id alone must not be enough to
 * point a row at someone else's audio. A row that already has its Task is
 * pulled forward so the worker attaches the link on its next tick; a row whose
 * Task is still pending keeps its clock — moving it could hand an in-flight
 * Task attempt's lease to a second worker.
 */
export function storeConnectRecording(db: Db, connectId: string, callSid: string, recordingUrl: string, at: Date) {
  return db
    .update(c)
    .set({
      recordingUrl,
      nextAttemptAt: sql`case when ${c.taskState} = 'created' then ${at.toISOString()}::timestamptz else ${c.nextAttemptAt} end`,
      updatedAt: at,
    })
    .where(and(eq(c.id, connectId), eq(c.callSid, callSid)))
    .returning({ id: c.id });
}

/** The same campaign the click-to-dial path reads (routes/telephony.ts). */
export async function orgIsTwoParty(db: Db, orgId: string): Promise<boolean> {
  const campaign = await db.query.campaignConfigs.findFirst({
    where: and(eq(schema.campaignConfigs.orgId, orgId), eq(schema.campaignConfigs.key, 'default')),
  });
  return campaign?.recordingConsentMode === 'two_party';
}

async function recordingDecision(orgId: string, connectId: string, deps: ConnectLogDeps): Promise<DialerConnectRecordingState> {
  if (!deps.recordingEnabled) return 'skipped_switch';
  try {
    return (await deps.isTwoParty(orgId)) ? 'skipped_consent' : 'requested';
  } catch (err) {
    console.error('[dialer] consent lookup failed — not recording', { connectId, err: errText(err) });
    return 'skipped_consent';
  }
}

export async function recordBridgedCall(call: BridgedCall, deps: ConnectLogDeps): Promise<void> {
  const { fromNumber, toNumber } = call;
  if (!fromNumber || !toNumber) {
    console.warn('[dialer] bridged call not logged: no number', { itemId: call.itemId });
    return;
  }
  const [row] = await insertConnect(deps.db, { ...call, fromNumber, toNumber }, deps.now());
  if (!row) return; // already logged — a re-delivered AMD "human" for this call
  const decision = await recordingDecision(call.orgId, row.id, deps);
  if (decision !== 'requested') {
    await setRecordingState(deps.db, row.id, decision, deps.now());
    return;
  }
  try {
    await deps.startRecording(call.callSid, row.id);
  } catch (err) {
    console.error('[dialer] recording did not start', { connectId: row.id, err: errText(err) });
    await setRecordingState(deps.db, row.id, 'start_failed', deps.now());
    return;
  }
  await setRecordingState(deps.db, row.id, 'requested', deps.now());
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer/connect-log.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; clean. If a rendered-SQL assertion differs only in drizzle's quoting/spacing, adjust the assertion to the rendered text — but keep each property it pins (bare on-conflict, `ended_at is null` guard, id+sid match, the `task_state = 'created'` case).

- [ ] **Step 5: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/dialer/connect-log.ts services/cti-api/src/dialer/connect-log.test.ts
git commit -m "feat(dialer): connect log — row first, then the recording; consent + switch fail closed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Engine hook, live wiring, `DIALER_RECORDING`, and the hang-up stamp

**Files:**
- Modify: `services/cti-api/src/dialer/engine.ts` (EngineDeps ~line 32; connected branch ~line 1043)
- Modify: `services/cti-api/src/dialer/live-deps.ts`
- Modify: `services/cti-api/src/config.ts` (after `INBOUND_TEXTS`)
- Modify: `services/cti-api/src/routes/dialer.ts` (`/telephony/twilio/dialer-status` route + a new exported helper)
- Test: `services/cti-api/src/dialer/engine.test.ts`, `services/cti-api/src/routes/dialer-webhook.test.ts`, `services/cti-api/src/config.test.ts`

**Interfaces:**
- Consumes: `BridgedCall`, `recordBridgedCall`, `orgIsTwoParty`, `stampConnectEnded` (Task 3); `TwilioDialerTelephony#startRecording` (Task 2).
- Produces: `EngineDeps.onBridged: (call: BridgedCall) => Promise<void>`; `cfg.DIALER_RECORDING: 'on' | 'off'`; `export async function endConnectOnTerminalStatus(body: Record<string, string>, stamp: (callSid: string, at: Date) => Promise<unknown>, now: Date): Promise<void>` in `routes/dialer.ts`.

- [ ] **Step 1: Write the failing engine tests**
  - In `engine.test.ts` `makeDeps`, add `onBridged: vi.fn(async () => {}),` right after `onScreenPop: vi.fn(),`.
  - Append at the end of the file:

```ts
describe('handleDialOutcome connected — the bridged-call log and its recording', () => {
  const connectedItems = () => [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fromNumber: '+16190000000', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];

  it('logs the call AFTER the bridge, with the run ids, the rep\'s Salesforce user and the dialed numbers', async () => {
    const deps = makeDeps(); deps.db = fakeDb(baseSession, connectedItems());
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.onBridged).toHaveBeenCalledWith({
      orgId: 'O1', userId: 'U1', sfUserId: '005', sessionId: 'S1', itemId: 'i1', callSid: 'CA1',
      objectType: 'Lead', recordId: '00Q1', fromNumber: '+16190000000', toNumber: '+16195550100',
    });
    const bridged = (deps.telephony.bridgeToRep as any).mock.invocationCallOrder[0];
    const logged = (deps.onBridged as any).mock.invocationCallOrder[0];
    expect(logged).toBeGreaterThan(bridged);
  });

  it('a failing log never touches the call: no throw, the screen-pop and the connected stamp still happen', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({ onBridged: vi.fn(async () => { throw new Error('db down'); }) });
    const fdb = fakeDb(baseSession, connectedItems()); deps.db = fdb;
    await expect(handleDialOutcome('CA1', 'connected', deps)).resolves.toBeUndefined();
    expect(deps.onScreenPop).toHaveBeenCalledWith('U1', 'Lead', '00Q1');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'connected' }) });
    expect(error).toHaveBeenCalledWith('[dialer] bridged-call log failed', { itemId: 'i1', err: 'db down' });
    error.mockRestore();
  });

  it('a lost connect claim (a duplicate AMD "human") logs nothing', async () => {
    const deps = makeDeps(); deps.db = fakeDb(baseSession, connectedItems(), { claimReturnsRows: false });
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.onBridged).not.toHaveBeenCalled();
  });

  it('a failed bridge logs nothing — no Task for a call that never reached the rep', async () => {
    const base = makeDeps();
    const deps = makeDeps({ telephony: { ...base.telephony, bridgeToRep: vi.fn(async () => { throw new Error('twilio 500'); }) } });
    deps.db = fakeDb(baseSession, connectedItems());
    await expect(handleDialOutcome('CA1', 'connected', deps)).rejects.toThrow('twilio 500');
    expect(deps.onBridged).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing webhook + config tests**
  - In `dialer-webhook.test.ts` `fakeDeps`, add `onBridged: vi.fn(unexpected('onBridged')) as unknown as EngineDeps['onBridged'],` after `onScreenPop`. Change the import line to `import { endConnectOnTerminalStatus, onDialerAmd, onDialerStatus } from './dialer.js';` and append:

```ts
describe('endConnectOnTerminalStatus — the bridged-call hang-up stamp', () => {
  const SID = 'CA' + 'b'.repeat(32);
  const AT = new Date('2026-10-01T18:02:05Z');

  it('a terminal status stamps the connect row for that call sid — whatever the item says', async () => {
    const stamp = vi.fn(async () => []);
    await endConnectOnTerminalStatus({ CallSid: SID, CallStatus: 'completed' }, stamp, AT);
    expect(stamp).toHaveBeenCalledWith(SID, AT);
  });

  it('a non-terminal status or a malformed sid stamps nothing', async () => {
    const stamp = vi.fn(async () => []);
    await endConnectOnTerminalStatus({ CallSid: SID, CallStatus: 'in-progress' }, stamp, AT);
    await endConnectOnTerminalStatus({ CallSid: 'nope', CallStatus: 'completed' }, stamp, AT);
    expect(stamp).not.toHaveBeenCalled();
  });

  it('a failed stamp is logged, never thrown — Twilio still gets its 200', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      endConnectOnTerminalStatus({ CallSid: SID, CallStatus: 'completed' }, vi.fn(async () => { throw new Error('db down'); }), AT),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[dialer] connect end stamp failed', { err: 'db down' });
    error.mockRestore();
  });
});
```

  - In `config.test.ts`, append (mirrors the `NO_ANSWER_CHATTER` block):

```ts
describe('DIALER_RECORDING — the power-dial recording kill switch', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.DIALER_RECORDING; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to ON', async () => {
    expect((await loadWith({ DIALER_RECORDING: undefined })).DIALER_RECORDING).toBe('on');
  });
  it('an empty value is treated as unset → on', async () => {
    expect((await loadWith({ DIALER_RECORDING: '' })).DIALER_RECORDING).toBe('on');
  });
  it('off turns it off', async () => {
    expect((await loadWith({ DIALER_RECORDING: 'off' })).DIALER_RECORDING).toBe('off');
  });
  it('anything else fails the boot loudly', async () => {
    await expect(loadWith({ DIALER_RECORDING: 'false' })).rejects.toThrow(/DIALER_RECORDING/);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer/engine.test.ts src/routes/dialer-webhook.test.ts src/config.test.ts`
Expected: FAIL — `onBridged` never called; `endConnectOnTerminalStatus` is not exported; `DIALER_RECORDING` undefined.

- [ ] **Step 4: Implement the engine hook** — `engine.ts`
  - Add `import type { BridgedCall } from './connect-log.js';` with the other imports.
  - In `EngineDeps`, after `onScreenPop`:

```ts
  /** The prospect was just bridged to the rep: log the call (dialer_connects)
   *  and start its recording (dialer/connect-log.ts). Called only AFTER
   *  bridgeToRep succeeds. Best-effort — the engine catches and logs a failure;
   *  it must never break a call the rep is on. */
  onBridged: (call: BridgedCall) => Promise<void>;
```
  - In `handleDialOutcome`'s connected branch, replace

```ts
    await deps.telephony.bridgeToRep(callId, session.userId, { repRejoins: !!session.repCallSid });
    deps.onScreenPop(session.userId, item.objectType, item.recordId);
```
  with

```ts
    await deps.telephony.bridgeToRep(callId, session.userId, { repRejoins: !!session.repCallSid });
    deps.onScreenPop(session.userId, item.objectType, item.recordId);
    // Log the bridged call and start its recording — AFTER the bridge, so a
    // failed bridge never becomes a Task. Best-effort like the sticky write
    // below: the rep is already talking to this person.
    try {
      await deps.onBridged({
        orgId: session.orgId,
        userId: session.userId,
        sfUserId: session.sfOwnerId,
        sessionId: session.id,
        itemId: item.id,
        callSid: callId,
        objectType: item.objectType,
        recordId: item.recordId,
        fromNumber: item.fromNumber ?? null,
        toNumber: dialedNumber ?? null,
      });
    } catch (err) {
      console.error('[dialer] bridged-call log failed', { itemId: item.id, err: (err as Error).message });
    }
```

- [ ] **Step 5: Add the config switch** — `config.ts`, after the `INBOUND_TEXTS` entry:

```ts
  /**
   * Kill switch for recording power-dial calls (dialer/connect-log.ts). `off` =
   * bridged calls are still logged (and still get their Task) but no recording
   * is started. TWILIO_RECORD_CALLS=false stops these recordings too. Default
   * `on`; strict enum like NO_ANSWER_CHATTER.
   */
  DIALER_RECORDING: z.enum(['on', 'off']).default('on'),
```

- [ ] **Step 6: Wire the live deps** — `live-deps.ts`
  - Add `import { orgIsTwoParty, recordBridgedCall } from './connect-log.js';`.
  - In `buildEngineDeps`, before `return {`, add:

```ts
  const telephony = new TwilioDialerTelephony();
  const recordingEnabled = cfg.TWILIO_RECORD_CALLS && cfg.DIALER_RECORDING === 'on';
```
  - Change `telephony: new TwilioDialerTelephony(),` to `telephony,` and after `onScreenPop: () => {}, …` add:

```ts
    onBridged: (call) =>
      recordBridgedCall(call, {
        db,
        now: () => new Date(),
        recordingEnabled,
        isTwoParty: (orgId) => orgIsTwoParty(db, orgId),
        startRecording: (callSid, connectId) => telephony.startRecording(callSid, connectId),
      }),
```

- [ ] **Step 7: The hang-up stamp** — `routes/dialer.ts`
  - Extend the webhooks import: `import { signedCallbackUrl, TWILIO_CALL_SID_RE } from '../telephony/webhooks.js';` and add `import { stampConnectEnded } from '../dialer/connect-log.js';`.
  - After `onDialerStatus`, add:

```ts
/**
 * Stamp the bridged-call log's hang-up from the same terminal status callback,
 * keyed by CallSid ALONE — not through the engine, because a rep's Next or End
 * settles the item before the prospect's `completed` arrives, and the call
 * still ended. Only a row still open is stamped (stampConnectEnded), so a
 * re-delivered callback is a no-op. Never throws: Twilio gets its 200.
 */
export async function endConnectOnTerminalStatus(
  body: Record<string, string>,
  stamp: (callSid: string, at: Date) => Promise<unknown>,
  now: Date,
): Promise<void> {
  const callSid = body.CallSid ?? '';
  const status = body.CallStatus ?? body.DialCallStatus ?? '';
  if (!TWILIO_CALL_SID_RE.test(callSid) || !STATUS_OUTCOMES.has(status)) return;
  try {
    await stamp(callSid, now);
  } catch (err) {
    console.error('[dialer] connect end stamp failed', { err: (err as Error).message });
  }
}
```
  - Replace the body of the `/telephony/twilio/dialer-status` handler after the signature check with:

```ts
    const body = req.body as Record<string, string>;
    try {
      await onDialerStatus(body, buildEngineDeps());
    } finally {
      await endConnectOnTerminalStatus(body, (callSid, at) => stampConnectEnded(getDb(), callSid, at), new Date());
    }
    return reply.type('text/xml').send(TWIML_EMPTY);
```

- [ ] **Step 8: Run the touched suites and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/dialer src/routes src/config.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS (existing engine and webhook tests included); clean. A type error naming `onBridged` in any other file means another `EngineDeps` literal exists — add the same `onBridged` stub there.

- [ ] **Step 9: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts services/cti-api/src/dialer/live-deps.ts services/cti-api/src/config.ts services/cti-api/src/config.test.ts services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/dialer-webhook.test.ts
git commit -m "feat(dialer): log + record every bridged call; stamp the hang-up; DIALER_RECORDING switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Recording webhook + playback

**Files:**
- Modify: `services/cti-api/src/routes/dialer.ts` (new route + exported handler)
- Modify: `services/cti-api/src/routes/recordings.ts`
- Test: `services/cti-api/src/routes/dialer-webhook.test.ts`, create `services/cti-api/src/routes/recordings.test.ts`

**Interfaces:**
- Consumes: `storeConnectRecording` (Task 3), `DIALER_RECORDING_PATH` (Task 2).
- Produces: `export async function onDialerRecording(body: Record<string, string>, query: { connectId?: string }, store: (connectId: string, callSid: string, recordingUrl: string, at: Date) => Promise<unknown[]>, now: Date): Promise<'stored' | 'ignored' | 'mismatch'>`; `export async function resolveRecordingUrl(db: Db, id: string): Promise<string | null>` in `routes/recordings.ts`.

- [ ] **Step 1: Write the failing webhook tests** — in `dialer-webhook.test.ts`, add `onDialerRecording` to the import from `./dialer.js` and append:

```ts
describe('onDialerRecording — a finished power-dial recording', () => {
  const SID = 'CA' + 'c'.repeat(32);
  const CONNECT = '11111111-2222-4333-8444-555555555555';
  const MEDIA = 'https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123';
  const AT = new Date('2026-10-01T18:02:10Z');
  const done = { CallSid: SID, RecordingStatus: 'completed', RecordingUrl: MEDIA };

  it('stores the .mp3 media URL against our row id AND the call sid', async () => {
    const store = vi.fn(async () => [{ id: CONNECT }]);
    expect(await onDialerRecording(done, { connectId: CONNECT }, store, AT)).toBe('stored');
    expect(store).toHaveBeenCalledWith(CONNECT, SID, `${MEDIA}.mp3`, AT);
  });

  it('a row id whose call sid does not match is a mismatch — nothing is repointed', async () => {
    expect(await onDialerRecording(done, { connectId: CONNECT }, vi.fn(async () => []), AT)).toBe('mismatch');
  });

  it('ignores a bad row id, a bad call sid, a not-completed status (absent / in-progress), or a non-Twilio URL', async () => {
    const store = vi.fn(async () => [{ id: CONNECT }]);
    const cases: Array<[Record<string, string>, { connectId?: string }]> = [
      [done, {}],
      [done, { connectId: 'not-a-uuid' }],
      [{ ...done, CallSid: 'XX1' }, { connectId: CONNECT }],
      [{ ...done, RecordingStatus: 'absent' }, { connectId: CONNECT }],
      [{ ...done, RecordingStatus: 'in-progress' }, { connectId: CONNECT }],
      [{ ...done, RecordingUrl: 'https://evil.example/x' }, { connectId: CONNECT }],
      [{ CallSid: SID, RecordingStatus: 'completed' }, { connectId: CONNECT }],
    ];
    for (const [body, query] of cases) expect(await onDialerRecording(body, query, store, AT)).toBe('ignored');
    expect(store).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing playback test** — `routes/recordings.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { resolveRecordingUrl } from './recordings.js';

const ID = '11111111-2222-4333-8444-555555555555';
function fakeDb(call: { recordingUrl: string | null } | undefined, connect: { recordingUrl: string | null } | undefined) {
  return {
    query: {
      calls: { findFirst: vi.fn(async () => call) },
      dialerConnects: { findFirst: vi.fn(async () => connect) },
    },
  } as unknown as Parameters<typeof resolveRecordingUrl>[0];
}

describe('resolveRecordingUrl — one link format for both kinds of call', () => {
  it('a click-to-dial call answers from calls and never reads dialer_connects', async () => {
    const db = fakeDb({ recordingUrl: 'https://api.twilio.com/a.mp3' }, undefined);
    expect(await resolveRecordingUrl(db, ID)).toBe('https://api.twilio.com/a.mp3');
    expect((db as any).query.dialerConnects.findFirst).not.toHaveBeenCalled();
  });
  it('a calls row with no recording yet is null (ids are UUIDs — the two tables never share one)', async () => {
    expect(await resolveRecordingUrl(fakeDb({ recordingUrl: null }, { recordingUrl: 'https://api.twilio.com/b.mp3' }), ID)).toBeNull();
  });
  it('a power-dial call answers from dialer_connects', async () => {
    expect(await resolveRecordingUrl(fakeDb(undefined, { recordingUrl: 'https://api.twilio.com/b.mp3' }), ID)).toBe('https://api.twilio.com/b.mp3');
  });
  it('neither → null', async () => {
    expect(await resolveRecordingUrl(fakeDb(undefined, undefined), ID)).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/routes/dialer-webhook.test.ts src/routes/recordings.test.ts`
Expected: FAIL — `onDialerRecording` / `resolveRecordingUrl` not exported.

- [ ] **Step 4: Implement the webhook** — `routes/dialer.ts`
  - Imports: extend to `import { signedCallbackUrl, TWILIO_CALL_SID_RE, TWILIO_RECORDING_MEDIA_RE, UUID_RE } from '../telephony/webhooks.js';`, change the connect-log import to `import { stampConnectEnded, storeConnectRecording } from '../dialer/connect-log.js';`, add `import { DIALER_RECORDING_PATH } from '../dialer/twilio-telephony.js';` (routes/dialer.ts has no import from that module yet).
  - Add the handler next to `endConnectOnTerminalStatus`:

```ts
/**
 * A finished power-dial recording (TwilioDialerTelephony#startRecording names
 * this route). Twilio signs the full URL including `?connectId=`, checked by
 * the route before this runs. The row id is public — it is in the playback
 * link — so the store matches the CallSid too. Only `completed` with a Twilio
 * media URL is stored; the worker attaches the link to the Task.
 */
export async function onDialerRecording(
  body: Record<string, string>,
  query: { connectId?: string },
  store: (connectId: string, callSid: string, recordingUrl: string, at: Date) => Promise<unknown[]>,
  now: Date,
): Promise<'stored' | 'ignored' | 'mismatch'> {
  const connectId = query.connectId;
  if (!connectId || !UUID_RE.test(connectId)) return 'ignored';
  const callSid = body.CallSid;
  if (!callSid || !TWILIO_CALL_SID_RE.test(callSid)) return 'ignored';
  if (body.RecordingStatus !== 'completed') return 'ignored';
  if (!body.RecordingUrl || !TWILIO_RECORDING_MEDIA_RE.test(body.RecordingUrl)) return 'ignored';
  const rows = await store(connectId, callSid, `${body.RecordingUrl}.mp3`, now);
  return rows.length > 0 ? 'stored' : 'mismatch';
}
```
  - Register the route after the `/telephony/twilio/dialer-status` route (same file, same `validTwilioSignature`):

```ts
  app.post(DIALER_RECORDING_PATH, async (req, reply) => {
    if (!validTwilioSignature(req)) {
      return reply.code(403).type('text/xml').send('<Response><Reject/></Response>');
    }
    const query = req.query as { connectId?: string };
    const outcome = await onDialerRecording(
      req.body as Record<string, string>,
      query,
      (connectId, callSid, url, at) => storeConnectRecording(getDb(), connectId, callSid, url, at),
      new Date(),
    );
    if (outcome === 'mismatch') req.log.warn({ connectId: query.connectId }, 'dialer_recording_callsid_mismatch');
    return reply.type('text/xml').send(TWIML_EMPTY);
  });
```

- [ ] **Step 5: Implement playback resolution** — `routes/recordings.ts`
  - Change the db import to `import { getDb, schema } from '@cti/db';` (already) and add after the imports:

```ts
type Db = ReturnType<typeof getDb>;

/**
 * The Twilio media URL behind a playback id. Click-to-dial calls (`calls`) and
 * bridged power-dial calls (`dialer_connects`) share one link format: both ids
 * are UUIDs, so they cannot collide, and the HMAC binds the link to its id.
 */
export async function resolveRecordingUrl(db: Db, id: string): Promise<string | null> {
  const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, id), columns: { recordingUrl: true } });
  if (call) return call.recordingUrl ?? null;
  const connect = await db.query.dialerConnects.findFirst({
    where: eq(schema.dialerConnects.id, id),
    columns: { recordingUrl: true },
  });
  return connect?.recordingUrl ?? null;
}
```
  - In the route, replace

```ts
    const db = getDb();
    const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) });
    if (!call || !call.recordingUrl || !TWILIO_RECORDING_MEDIA_RE.test(call.recordingUrl)) {
      return reply.code(404).send('Not found');
    }
```
  with

```ts
    const recordingUrl = await resolveRecordingUrl(getDb(), callId);
    if (!recordingUrl || !TWILIO_RECORDING_MEDIA_RE.test(recordingUrl)) {
      return reply.code(404).send('Not found');
    }
```
  and change `fetch(call.recordingUrl, {` to `fetch(recordingUrl, {`.

- [ ] **Step 6: Run and typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/routes && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/dialer-webhook.test.ts services/cti-api/src/routes/recordings.ts services/cti-api/src/routes/recordings.test.ts
git commit -m "feat(dialer): dialer-recording webhook; /recordings plays power-dial calls too

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Call Tasks are dated in the org's (Pacific) day

**Why:** `createCallTask` stamps `ActivityDate` with the UTC date (`new Date().toISOString().slice(0, 10)`). From 5 pm Pacific on, UTC is already tomorrow, so the Task is dated tomorrow — and the reps' Salesforce talk-time report (`Due Date = TODAY`) drops it from the day it happened. Measured 2026-10-01: 45 of the last 3 days' 627 "Call Log" Tasks were mis-dated, every one created 5 pm–midnight PT. The power-dial Tasks go through the same function, so fix it here once.

**Files:**
- Modify: `services/cti-api/src/salesforce/client.ts` (`CallTaskInput`, `createCallTask`)
- Test: `services/cti-api/src/salesforce/create-call-task.test.ts`

**Interfaces:**
- Consumes: `orgTodayIso(now?: Date): string` from `services/cti-api/src/dialer/org-day.ts` (America/Los_Angeles, `YYYY-MM-DD`).
- Produces: `CallTaskInput.activityDate?: string` (`YYYY-MM-DD`); when omitted, `createCallTask` uses `orgTodayIso(new Date())`.

- [ ] **Step 1: Write the failing tests** — in `create-call-task.test.ts`, change the vitest import to `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';` and append:

```ts
describe('createCallTask — ActivityDate is the org\'s (Pacific) calendar day, never UTC\'s', () => {
  beforeEach(() => {
    state.mockRequest.mockReset();
    state.mockRequest.mockResolvedValue(jsonResponse(201, { id: '00TNEW', success: true }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a call at 6 pm Pacific is dated that day — UTC has already rolled over to the next', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z')); // 18:00 PDT on Oct 1
    await createCallTask('u1', INPUT);
    expect(bodyOf(0).ActivityDate).toBe('2026-10-01');
  });

  it('a morning call is dated the same day either way', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T16:00:00Z')); // 09:00 PDT
    await createCallTask('u1', INPUT);
    expect(bodyOf(0).ActivityDate).toBe('2026-10-01');
  });

  it('an explicit activityDate wins (the power dialer dates a Task by the day it was bridged)', async () => {
    await createCallTask('u1', { ...INPUT, activityDate: '2026-09-30' });
    expect(bodyOf(0).ActivityDate).toBe('2026-09-30');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/salesforce/create-call-task.test.ts`
Expected: FAIL — the 6 pm test gets `'2026-10-02'`; the explicit-date test gets today's date (and may not typecheck until Step 3 adds the field).

- [ ] **Step 3: Implement** — in `client.ts`:
  - add `import { orgTodayIso } from '../dialer/org-day.js';` with the other imports;
  - in `CallTaskInput`, after `description?: string;`:

```ts
  /** The Task's date (ActivityDate, `YYYY-MM-DD`): the day the call happened in
   *  the org's timezone. Omitted = today in the org's timezone. */
  activityDate?: string;
```
  - in `createCallTask`, replace `const today = new Date().toISOString().slice(0, 10);` with:

```ts
  // The org's calendar day, never UTC's. From 5 pm Pacific UTC is already
  // tomorrow, and the reps' talk-time report (Due Date = TODAY) would drop the
  // call from the day it happened.
  const activityDate = input.activityDate ?? orgTodayIso(new Date());
```
  - and in `base`, change `ActivityDate: today,` to `ActivityDate: activityDate,`.

- [ ] **Step 4: Run the Salesforce suite and the typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/salesforce src/sms && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS; clean. (`grep -n "ActivityDate: today" src/salesforce/client.ts` must print nothing.)

- [ ] **Step 5: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/salesforce/client.ts services/cti-api/src/salesforce/create-call-task.test.ts
git commit -m "fix(sf): date call Tasks in the org's Pacific day, not UTC — 5pm+ calls fell out of today's talk-time report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Task payload (pure)

**Files:**
- Create: `services/cti-api/src/salesforce/dialer-connect-task.ts`
- Test: `services/cti-api/src/salesforce/dialer-connect-task.test.ts`

**Interfaces:**
- Consumes: `DialerConnect` (Task 1), `buildCallSubject` (`salesforce/call-subject.ts`), `CallTaskInput` incl. its new `activityDate` (Task 6, `salesforce/client.ts`), `orgTodayIso` (`dialer/org-day.ts`).
- Produces: `RETRY_DELAYS_MS`, `MAX_TRIES` (= 6), `leaseFor(attempt: number): number`, `CONNECT_DISPOSITION = 'Connected'`, `CONNECT_TASK_DESCRIPTION = 'Logged by the Power Dialer.'`, `type TaskLinks = { whoId?: string; whatId?: string }`, `taskLinks(objectType: string, recordId: string): TaskLinks | null`, `buildConnectTaskInput(row: ConnectTaskRow, links: TaskLinks, recordName: string | null): CallTaskInput` where `ConnectTaskRow = Pick<DialerConnect, 'id' | 'callSid' | 'fromNumber' | 'toNumber' | 'bridgedAt' | 'endedAt' | 'talkSeconds'>`.

- [ ] **Step 1: Write the failing tests** — `dialer-connect-task.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  CONNECT_TASK_DESCRIPTION,
  MAX_TRIES,
  RETRY_DELAYS_MS,
  buildConnectTaskInput,
  leaseFor,
  taskLinks,
} from './dialer-connect-task.js';

const ROW = {
  id: '11111111-2222-4333-8444-555555555555',
  callSid: 'CA' + 'a'.repeat(32),
  fromNumber: '+16195550101',
  toNumber: '+16195559999',
  bridgedAt: new Date('2026-10-01T18:00:00Z'),
  endedAt: new Date('2026-10-01T18:02:05Z'),
  talkSeconds: 125,
};

describe('backoff', () => {
  it('5 min, 15 min, 1 h, 3 h, 6 h — the 6th try is the last', () => {
    expect(RETRY_DELAYS_MS).toEqual([5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000]);
    expect(MAX_TRIES).toBe(6);
  });
  it('leaseFor(n) is try n\'s backoff, clamped at both ends; never under 5 min (a row\'s worst case is ~3 min)', () => {
    expect(leaseFor(1)).toBe(5 * 60_000);
    expect(leaseFor(3)).toBe(60 * 60_000);
    expect(leaseFor(6)).toBe(6 * 60 * 60_000);
    expect(leaseFor(99)).toBe(6 * 60 * 60_000);
    expect(leaseFor(0)).toBe(5 * 60_000);
  });
});

describe('taskLinks', () => {
  it('a Lead or a Contact is the WhoId; an Opportunity is the WhatId', () => {
    expect(taskLinks('Lead', '00Q1')).toEqual({ whoId: '00Q1' });
    expect(taskLinks('Contact', '0031')).toEqual({ whoId: '0031' });
    expect(taskLinks('Opportunity', '0061')).toEqual({ whatId: '0061' });
  });
  it('anything else has no link — the worker fails the row rather than log an orphan Task', () => {
    expect(taskLinks('Task', '00T1')).toBeNull();
    expect(taskLinks('Account', '0011')).toBeNull();
  });
});

describe('buildConnectTaskInput', () => {
  it('follows THE call-subject rule and logs a completed outbound "Connected" call with the talk time', () => {
    const input = buildConnectTaskInput(ROW, { whatId: '0061' }, 'Jane Doe');
    expect(input).toEqual({
      subject: 'Outbound Call | Connected | (619) 555-9999 / Jane Doe',
      callType: 'Outbound',
      callDisposition: 'Connected',
      callDurationInSeconds: 125,
      activityDate: '2026-10-01',
      whatId: '0061',
      description: CONNECT_TASK_DESCRIPTION,
      customFields: {
        External_Call_Id__c: ROW.id,
        Provider_Call_Id__c: ROW.callSid,
        From_Number__c: '+16195550101',
        To_Number__c: '+16195559999',
        Normalized_To_Number__c: '+16195559999',
        Call_Start_Time__c: '2026-10-01T18:00:00.000Z',
        Call_End_Time__c: '2026-10-01T18:02:05.000Z',
        CTI_Provider__c: 'twilio',
        Outbound_Caller_ID__c: '+16195550101',
      },
    });
  });
  it('is dated the Pacific day it was BRIDGED — a 6:30 pm PT call is still that day, though UTC has rolled over', () => {
    const late = buildConnectTaskInput({ ...ROW, bridgedAt: new Date('2026-10-02T01:30:00Z') }, { whoId: '00Q1' }, null);
    expect(late.activityDate).toBe('2026-10-01');
  });
  it('no name → number-only subject; no hang-up stamp → no duration, no end time', () => {
    const input = buildConnectTaskInput({ ...ROW, endedAt: null, talkSeconds: null }, { whoId: '00Q1' }, null);
    expect(input.subject).toBe('Outbound Call | Connected | (619) 555-9999');
    expect(input.callDurationInSeconds).toBeUndefined();
    expect(input.customFields?.Call_End_Time__c).toBeNull();
    expect(input.whoId).toBe('00Q1');
    expect(input).not.toHaveProperty('whatId');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/salesforce/dialer-connect-task.test.ts`
Expected: FAIL — cannot resolve `./dialer-connect-task.js`.

- [ ] **Step 3: Implement** — `dialer-connect-task.ts`

```ts
/**
 * The Call Task a bridged power-dial call becomes, and the worker's retry
 * schedule — pure, so salesforce/dialer-connect-worker.ts only does I/O.
 * Design: docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md.
 */
import type { DialerConnect } from '@cti/db';
import { orgTodayIso } from '../dialer/org-day.js';
import { buildCallSubject } from './call-subject.js';
import type { CallTaskInput } from './client.js';

/**
 * Backoff before tries 2..6, and the claim's lease for tries 1..6. Starts at
 * 5 minutes on purpose: the claim IS the lease (no in_flight state), so it must
 * outlast a row's worst case — three reads at 30 s, a create at 60 s, our
 * writes — or a second worker could take a row whose Task is still being made.
 */
export const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000] as const;
/** One try plus five retries. A row whose 6th try fails is `failed`. */
export const MAX_TRIES = RETRY_DELAYS_MS.length + 1;

export function leaseFor(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[i]!;
}

/** Nobody chose a disposition — the call connected, which is exactly what it says. */
export const CONNECT_DISPOSITION = 'Connected';
/** Lean on purpose, like click-to-dial: org automations repost Descriptions. */
export const CONNECT_TASK_DESCRIPTION = 'Logged by the Power Dialer.';

export type TaskLinks = { whoId?: string; whatId?: string };

/** The record the dialer screen-popped: a person is the Who, a deal is the What. */
export function taskLinks(objectType: string, recordId: string): TaskLinks | null {
  if (objectType === 'Lead' || objectType === 'Contact') return { whoId: recordId };
  if (objectType === 'Opportunity') return { whatId: recordId };
  return null;
}

export type ConnectTaskRow = Pick<DialerConnect, 'id' | 'callSid' | 'fromNumber' | 'toNumber' | 'bridgedAt' | 'endedAt' | 'talkSeconds'>;

export function buildConnectTaskInput(row: ConnectTaskRow, links: TaskLinks, recordName: string | null): CallTaskInput {
  return {
    subject: buildCallSubject({ inbound: false, disposition: CONNECT_DISPOSITION, counterpartyE164: row.toNumber, recordName }),
    callType: 'Outbound',
    callDisposition: CONNECT_DISPOSITION,
    callDurationInSeconds: row.talkSeconds ?? undefined,
    // The day the call happened, in the org's timezone — not the day the
    // worker got to it, and never the UTC date.
    activityDate: orgTodayIso(row.bridgedAt),
    ...links,
    description: CONNECT_TASK_DESCRIPTION,
    // Same custom fields as a click-to-dial Task (salesforce/sync.ts), so
    // reports read both alike. createCallTask stamps CTI_Origin__c itself.
    customFields: {
      External_Call_Id__c: row.id,
      Provider_Call_Id__c: row.callSid,
      From_Number__c: row.fromNumber,
      To_Number__c: row.toNumber,
      Normalized_To_Number__c: row.toNumber,
      Call_Start_Time__c: row.bridgedAt.toISOString(),
      Call_End_Time__c: row.endedAt?.toISOString() ?? null,
      CTI_Provider__c: 'twilio',
      Outbound_Caller_ID__c: row.fromNumber,
    },
  };
}
```

- [ ] **Step 4: Run and typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/salesforce/dialer-connect-task.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; clean. (`callDurationInSeconds: undefined` is dropped by `toEqual` in the first test only because it is 125 there; the second test asserts it is undefined.)

- [ ] **Step 5: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/salesforce/dialer-connect-task.ts services/cti-api/src/salesforce/dialer-connect-task.test.ts
git commit -m "feat(sf): the Call Task a bridged power-dial call becomes (pure)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Worker — the Task phase

**Files:**
- Create: `services/cti-api/src/salesforce/dialer-connect-worker.ts`
- Test: `services/cti-api/src/salesforce/dialer-connect-worker.test.ts`

**Interfaces:**
- Consumes: Task 1 (`dialerConnects`, `DialerConnect`), Task 7 (all exports), `createCallTask`/`updateCallTask` (`./client.js`), `fetchOwnership`/`mayCreateTaskOn` (`./ownership.js`), `fetchRecordName` (`./sync.js`), `isSalesforceAuthError`/`withTimeout` (`./followup-worker.js`), `RecordingLinkConfig` (`../telephony/recording-links.js`).
- Produces: `interface DialerConnectDeps { db; now: () => Date; link: RecordingLinkConfig; sf: { createCallTask; updateCallTask; fetchOwnership; fetchRecordName } }`; constants `LOOP_INTERVAL_MS`, `BATCH_LIMIT`, `TASK_WINDOW_MS`, `MISSED_END_AFTER_MS`, `AUTH_RETRY_MS`, `SF_CALL_TIMEOUT_MS`, `SF_CREATE_TIMEOUT_MS`; `expireStaleConnects(db, now)`, `selectDueConnectTasks(db, now)`, `claimConnectTask(db, row, now)`, `processConnectTask(row, deps): Promise<'created' | 'skipped_not_owner' | 'failed' | 'retry'>`.

- [ ] **Step 1: Write the failing tests** — `dialer-connect-worker.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema, type DialerConnect } from '@cti/db';
import { SalesforceUnauthorizedError } from './client.js';
import { MAX_TRIES } from './dialer-connect-task.js';
import {
  AUTH_RETRY_MS,
  claimConnectTask,
  expireStaleConnects,
  processConnectTask,
  selectDueConnectTasks,
  type DialerConnectDeps,
} from './dialer-connect-worker.js';

const NOW = new Date('2026-10-01T18:30:00Z');
const LEAD = '00Q000000000001AAA';
const OPP = '006000000000001AAA';
const REP_SF = '005REP000000001';

function connectRow(o: Partial<DialerConnect> = {}): DialerConnect {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    orgId: 'org-1', userId: 'rep-1', sfUserId: REP_SF, sessionId: 'sess-1', itemId: 'item-1',
    callSid: 'CA' + 'a'.repeat(32), objectType: 'Lead', recordId: LEAD,
    fromNumber: '+16195550101', toNumber: '+16195559999',
    bridgedAt: new Date('2026-10-01T18:00:00Z'), endedAt: new Date('2026-10-01T18:02:05Z'), talkSeconds: 125,
    recordingState: 'requested', recordingUrl: null,
    taskState: 'pending', taskAttempts: 1, nextAttemptAt: new Date(NOW.getTime() + 5 * 60_000), lastError: null,
    salesforceTaskId: null, linkAttempts: 0, recordingLinkSyncedAt: null,
    createdAt: new Date('2026-10-01T18:00:00Z'), updatedAt: NOW,
    ...o,
  };
}

function harness(sfOver: Partial<Record<keyof DialerConnectDeps['sf'], unknown>> = {}) {
  const writes: Record<string, unknown>[] = [];
  const db = {
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { writes.push(patch); } }) }),
  } as unknown as DialerConnectDeps['db'];
  const sf = {
    createCallTask: vi.fn(async () => ({ taskId: '00TNEW000000001' })),
    updateCallTask: vi.fn(async () => ({ updated: true })),
    fetchOwnership: vi.fn(async (_u: string, id: string) => ({ type: id.startsWith('006') ? 'Opportunity' : 'Lead', ownerId: REP_SF })),
    fetchRecordName: vi.fn(async () => 'Jane Doe'),
    ...sfOver,
  };
  const deps: DialerConnectDeps = {
    db,
    now: () => NOW,
    link: { apiPublicUrl: 'https://api.test', secret: 's'.repeat(32) },
    sf: sf as unknown as DialerConnectDeps['sf'],
  };
  return { deps, writes, sf };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('processConnectTask — the Task', () => {
  it('a Lead: creates the Task AS THE REP on the Lead (WhoId), then marks it created and due for its link', async () => {
    const h = harness();
    expect(await processConnectTask(connectRow(), h.deps)).toBe('created');
    expect(h.sf.createCallTask).toHaveBeenCalledWith('rep-1', expect.objectContaining({
      subject: 'Outbound Call | Connected | (619) 555-9999 / Jane Doe',
      whoId: LEAD,
      callDisposition: 'Connected',
      callDurationInSeconds: 125,
    }));
    expect(h.writes).toEqual([expect.objectContaining({ taskState: 'created', salesforceTaskId: '00TNEW000000001', lastError: null, nextAttemptAt: NOW })]);
  });

  it('an Opportunity: the Task relates to the Opportunity (WhatId)', async () => {
    const h = harness();
    await processConnectTask(connectRow({ objectType: 'Opportunity', recordId: OPP }), h.deps);
    const input = (h.sf.createCallTask as any).mock.calls[0][1];
    expect(input.whatId).toBe(OPP);
    expect(input.whoId).toBeUndefined();
  });

  it('the click-to-dial owner rule: not the rep\'s record → skipped_not_owner, no Task', async () => {
    const h = harness({ fetchOwnership: vi.fn(async () => ({ type: 'Lead', ownerId: '005SOMEONEELSE1' })) });
    expect(await processConnectTask(connectRow(), h.deps)).toBe('skipped_not_owner');
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
    expect(h.writes).toEqual([expect.objectContaining({ taskState: 'skipped_not_owner' })]);
  });

  it('a record type with no Task link fails the row, logged, no Task', async () => {
    const h = harness();
    expect(await processConnectTask(connectRow({ objectType: 'Task', recordId: '00T1' }), h.deps)).toBe('failed');
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
    expect(h.writes).toEqual([expect.objectContaining({ taskState: 'failed', lastError: 'no Task link for a Task' })]);
  });

  it('a missing name still logs the Task, number-only', async () => {
    const h = harness({ fetchRecordName: vi.fn(async () => null) });
    await processConnectTask(connectRow(), h.deps);
    expect((h.sf.createCallTask as any).mock.calls[0][1].subject).toBe('Outbound Call | Connected | (619) 555-9999');
  });

  it('an auth error is not the row\'s fault: the try is given back and it waits an hour', async () => {
    const h = harness({ createCallTask: vi.fn(async () => { throw new SalesforceUnauthorizedError(); }) });
    expect(await processConnectTask(connectRow({ taskAttempts: 2 }), h.deps)).toBe('retry');
    expect(h.writes).toEqual([expect.objectContaining({
      taskAttempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + AUTH_RETRY_MS),
      lastError: 'reconnect Salesforce',
    })]);
  });

  it('a transient error before the last try keeps the claim\'s backoff and records the error', async () => {
    const h = harness({ createCallTask: vi.fn(async () => { throw new Error('503 busy'); }) });
    expect(await processConnectTask(connectRow({ taskAttempts: 2 }), h.deps)).toBe('retry');
    expect(h.writes).toEqual([expect.objectContaining({ lastError: '503 busy' })]);
    expect(h.writes[0]).not.toHaveProperty('taskState');
    expect(h.writes[0]).not.toHaveProperty('nextAttemptAt');
  });

  it('an error on the last try fails the row, loudly', async () => {
    const h = harness({ createCallTask: vi.fn(async () => { throw new Error('validation rule'); }) });
    expect(await processConnectTask(connectRow({ taskAttempts: MAX_TRIES }), h.deps)).toBe('failed');
    expect(h.writes).toEqual([expect.objectContaining({ taskState: 'failed', lastError: 'validation rule' })]);
    expect(error).toHaveBeenCalledWith('[dialer-connect-worker] gave up — no Task for this power-dial call', expect.objectContaining({ connectId: connectRow().id }));
  });

  it('an ownership lookup that throws fails closed into a retry — never a Task on an unknown owner', async () => {
    const h = harness({ fetchOwnership: vi.fn(async () => { throw new Error('soql 500'); }) });
    expect(await processConnectTask(connectRow(), h.deps)).toBe('retry');
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
  });
});

describe('the Task-phase SQL, rendered', () => {
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('expire: only pending rows bridged more than 24 h ago', () => {
    const { sql, params } = expireStaleConnects(db, NOW).toSQL();
    expect(sql).toContain(`"task_state" = $`);
    expect(sql).toMatch(/"dialer_connects"\."bridged_at" < \$\d+/);
    expect(params).toEqual(expect.arrayContaining(['expired', 'pending', new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString()]));
  });

  it('due: pending, due, inside 24 h, and ended — or bridged 4 h ago with no hang-up heard', () => {
    const { sql, params } = selectDueConnectTasks(db, NOW).toSQL();
    expect(sql).toMatch(/"dialer_connects"\."next_attempt_at" <= \$\d+/);
    expect(sql).toMatch(/"dialer_connects"\."bridged_at" >= \$\d+/);
    expect(sql).toMatch(/\("dialer_connects"\."ended_at" is not null or "dialer_connects"\."bridged_at" <= \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining([
      'pending',
      new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString(),
      new Date(NOW.getTime() - 4 * 60 * 60_000).toISOString(),
    ]));
  });

  it('claim: a compare-and-swap on the attempt count that bumps it and takes the lease', () => {
    const { sql, params } = claimConnectTask(db, { id: 'conn-1', taskAttempts: 2 }, NOW).toSQL();
    expect(sql).toMatch(/"task_attempts" = \$\d+/);
    expect(sql).toMatch(/"dialer_connects"\."task_attempts" = \$\d+/);
    expect(sql).toContain('returning');
    expect(params).toEqual(expect.arrayContaining([3, new Date(NOW.getTime() + 60 * 60_000).toISOString(), 'conn-1', 2]));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/salesforce/dialer-connect-worker.test.ts`
Expected: FAIL — cannot resolve `./dialer-connect-worker.js`.

- [ ] **Step 3: Implement** — `dialer-connect-worker.ts` (the link phase, tick and loop are added in Task 9):

```ts
/**
 * Dialer-connect worker — every power-dial call that was bridged to a rep
 * (dialer_connects, written by dialer/connect-log.ts) becomes ONE completed
 * Call Task on the screen-popped record, as the rep, and then gets its public
 * recording link.
 *
 * TASK PHASE: rows whose call ended — or that were bridged 4 h ago and whose
 * hang-up was never heard — and that were bridged inside the last 24 h. The
 * click-to-dial ownership rule first (no Task on a record the rep does not
 * own), then createCallTask, then `created`.
 * LINK PHASE (Task 9): rows with a Task and a recording but no synced link.
 *
 * THE CLAIM IS THE LEASE. Claiming bumps the attempt counter and pushes
 * next_attempt_at out by that try's backoff (5 min at least, longer than a
 * row's worst case), so there is no in_flight state and no reaper: a crashed
 * try simply comes due again. Like the other Salesforce workers, a create that
 * landed after our timeout gave up on it can be made again by the retry.
 *
 * NO BACKFILL: pending rows bridged more than 24 h ago are expired, because
 * createCallTask dates the Task today — an old call must not read as today's.
 *
 * Kill switch: DIALER_CONNECT_TASKS=off never starts the loop.
 * Design: docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md.
 */
import { and, asc, eq, gte, isNotNull, lt, lte, or } from 'drizzle-orm';
import { getDb, schema, type DialerConnect } from '@cti/db';
import { createCallTask, updateCallTask } from './client.js';
import { fetchOwnership, mayCreateTaskOn } from './ownership.js';
import { fetchRecordName } from './sync.js';
import { isSalesforceAuthError, withTimeout } from './followup-worker.js';
import type { RecordingLinkConfig } from '../telephony/recording-links.js';
import { MAX_TRIES, buildConnectTaskInput, leaseFor, taskLinks } from './dialer-connect-task.js';

type Db = ReturnType<typeof getDb>;
const c = schema.dialerConnects;

export const LOOP_INTERVAL_MS = 5_000;
export const BATCH_LIMIT = 25;
/** No Task for a call bridged longer ago than this — the Task would be dated today. */
export const TASK_WINDOW_MS = 24 * 60 * 60_000;
/** A bridged call with no hang-up stamp by now is logged anyway, without a duration. */
export const MISSED_END_AFTER_MS = 4 * 60 * 60_000;
/** A disconnected rep: retry hourly, uncounted — the 24 h window bounds it. */
export const AUTH_RETRY_MS = 60 * 60_000;
export const SF_CALL_TIMEOUT_MS = 30_000;
export const SF_CREATE_TIMEOUT_MS = 60_000;
const RECONNECT = 'reconnect Salesforce';
export const LOG = '[dialer-connect-worker]';

export interface DialerConnectDeps {
  db: Db;
  now: () => Date;
  link: RecordingLinkConfig;
  sf: {
    createCallTask: typeof createCallTask;
    updateCallTask: typeof updateCallTask;
    fetchOwnership: typeof fetchOwnership;
    fetchRecordName: typeof fetchRecordName;
  };
}

export function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export function patchConnect(db: Db, id: string, patch: Partial<typeof c.$inferInsert>, now: Date) {
  return db.update(c).set({ ...patch, updatedAt: now }).where(eq(c.id, id));
}

export function expireStaleConnects(db: Db, now: Date) {
  return db
    .update(c)
    .set({ taskState: 'expired', updatedAt: now })
    .where(and(eq(c.taskState, 'pending'), lt(c.bridgedAt, new Date(now.getTime() - TASK_WINDOW_MS))))
    .returning({ id: c.id });
}

export function selectDueConnectTasks(db: Db, now: Date) {
  return db
    .select()
    .from(c)
    .where(
      and(
        eq(c.taskState, 'pending'),
        lte(c.nextAttemptAt, now),
        gte(c.bridgedAt, new Date(now.getTime() - TASK_WINDOW_MS)),
        or(isNotNull(c.endedAt), lte(c.bridgedAt, new Date(now.getTime() - MISSED_END_AFTER_MS))),
      ),
    )
    .orderBy(asc(c.bridgedAt))
    .limit(BATCH_LIMIT);
}

export function claimConnectTask(db: Db, row: Pick<DialerConnect, 'id' | 'taskAttempts'>, now: Date) {
  const attempt = row.taskAttempts + 1;
  return db
    .update(c)
    .set({ taskAttempts: attempt, nextAttemptAt: new Date(now.getTime() + leaseFor(attempt)), updatedAt: now })
    .where(
      and(
        eq(c.id, row.id),
        eq(c.taskState, 'pending'),
        eq(c.taskAttempts, row.taskAttempts),
        lte(c.nextAttemptAt, now),
      ),
    )
    .returning();
}

async function taskTryFailed(row: DialerConnect, err: unknown, deps: DialerConnectDeps): Promise<'retry' | 'failed'> {
  const now = deps.now();
  const message = errorText(err);
  if (isSalesforceAuthError(err)) {
    await patchConnect(deps.db, row.id, {
      taskAttempts: row.taskAttempts - 1,
      nextAttemptAt: new Date(now.getTime() + AUTH_RETRY_MS),
      lastError: RECONNECT,
    }, now);
    return 'retry';
  }
  if (row.taskAttempts >= MAX_TRIES) {
    await patchConnect(deps.db, row.id, { taskState: 'failed', lastError: message }, now);
    console.error(`${LOG} gave up — no Task for this power-dial call`, { connectId: row.id, userId: row.userId, err: message });
    return 'failed';
  }
  // next_attempt_at already holds this try's backoff — the claim set it.
  await patchConnect(deps.db, row.id, { lastError: message }, now);
  console.warn(`${LOG} Task try failed, will retry`, { connectId: row.id, attempt: row.taskAttempts, err: message });
  return 'retry';
}

/** One claimed row → its Task. `row.taskAttempts` already counts this try. */
export async function processConnectTask(
  row: DialerConnect,
  deps: DialerConnectDeps,
): Promise<'created' | 'skipped_not_owner' | 'failed' | 'retry'> {
  const links = taskLinks(row.objectType, row.recordId);
  if (!links) {
    await patchConnect(deps.db, row.id, { taskState: 'failed', lastError: `no Task link for a ${row.objectType}` }, deps.now());
    console.error(`${LOG} no Task link for this record type`, { connectId: row.id, objectType: row.objectType });
    return 'failed';
  }
  try {
    const allowed = await mayCreateTaskOn([links.whoId, links.whatId], row.sfUserId, (id) =>
      withTimeout(deps.sf.fetchOwnership(row.userId, id), SF_CALL_TIMEOUT_MS, 'ownership lookup'),
    );
    if (!allowed) {
      await patchConnect(deps.db, row.id, { taskState: 'skipped_not_owner', lastError: null }, deps.now());
      return 'skipped_not_owner';
    }
    // Cosmetic: fetchRecordName already swallows its own errors; a timeout is null too.
    const recordName = await withTimeout(deps.sf.fetchRecordName(row.userId, row.recordId), SF_CALL_TIMEOUT_MS, 'record name')
      .catch(() => null);
    const { taskId } = await withTimeout(
      deps.sf.createCallTask(row.userId, buildConnectTaskInput(row, links, recordName)),
      SF_CREATE_TIMEOUT_MS,
      'task create',
    );
    // Due now: the link phase attaches the recording on the next tick if it is in.
    await patchConnect(deps.db, row.id, { taskState: 'created', salesforceTaskId: taskId, lastError: null, nextAttemptAt: deps.now() }, deps.now());
    return 'created';
  } catch (err) {
    return taskTryFailed(row, err, deps);
  }
}
```

- [ ] **Step 4: Run and typecheck**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/salesforce/dialer-connect-worker.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; clean. If a rendered param shows a `Date` instead of an ISO string, assert on `NOW.getTime() - …` the way the rendered output actually presents it — keep the bound itself pinned.

- [ ] **Step 5: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/salesforce/dialer-connect-worker.ts services/cti-api/src/salesforce/dialer-connect-worker.test.ts
git commit -m "feat(sf): dialer-connect worker — one Call Task per bridged call, owner rule, capped retries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Worker — the link phase, the tick, the loop, `DIALER_CONNECT_TASKS`, server wiring

**Files:**
- Modify: `services/cti-api/src/salesforce/dialer-connect-worker.ts`
- Modify: `services/cti-api/src/config.ts`, `services/cti-api/src/server.ts`
- Test: `services/cti-api/src/salesforce/dialer-connect-worker.test.ts`, `services/cti-api/src/config.test.ts`

**Interfaces:**
- Consumes: Task 8 exports; `buildRecordingPublicUrl` (`../telephony/recording-links.js`); `loadConfig`, `AppConfig` (`../config.js`).
- Produces: `RECORDING_URL_FIELD = 'tdc_cti__Recording_URL__c'`, `selectDueLinks(db, now)`, `claimLink(db, row, now)`, `pushConnectLink(row, deps): Promise<'synced' | 'rejected' | 'retry' | 'failed'>`, `runDialerConnectTick(deps?): Promise<{ expired: number; tasks: number; links: number }>`, `startDialerConnectLoop(intervalMs?)`, `maybeStartDialerConnectLoop(cfg, start?)`; `cfg.DIALER_CONNECT_TASKS: 'on' | 'off'`.

- [ ] **Step 1: Write the failing tests** — append to `dialer-connect-worker.test.ts` (add the new names to the existing import from `./dialer-connect-worker.js`: `LOOP_INTERVAL_MS, RECORDING_URL_FIELD, claimLink, maybeStartDialerConnectLoop, pushConnectLink, runDialerConnectTick, selectDueLinks`; and add `import { buildRecordingPublicUrl } from '../telephony/recording-links.js';`):

```ts
describe('pushConnectLink — the recording link on the Task', () => {
  const withTask = (o: Partial<DialerConnect> = {}) =>
    connectRow({ taskState: 'created', salesforceTaskId: '00TNEW000000001', recordingUrl: 'https://api.twilio.com/r.mp3', linkAttempts: 1, ...o });

  it('PATCHes the PUBLIC playback URL (never the Twilio media URL) as the rep, then stamps it synced', async () => {
    const h = harness();
    expect(await pushConnectLink(withTask(), h.deps)).toBe('synced');
    expect(h.sf.updateCallTask).toHaveBeenCalledWith('rep-1', '00TNEW000000001', {
      [RECORDING_URL_FIELD]: buildRecordingPublicUrl(withTask().id, h.deps.link),
    });
    expect(RECORDING_URL_FIELD).toBe('tdc_cti__Recording_URL__c');
    expect(h.writes).toEqual([expect.objectContaining({ recordingLinkSyncedAt: NOW, lastError: null })]);
  });

  it('a rejected field (no tdc_cti license) stamps synced WITH a loud log — no retry can fix a license', async () => {
    const h = harness({ updateCallTask: vi.fn(async () => ({ updated: false })) });
    expect(await pushConnectLink(withTask(), h.deps)).toBe('rejected');
    expect(h.writes).toEqual([expect.objectContaining({ recordingLinkSyncedAt: NOW, lastError: 'recording link field rejected' })]);
    expect(error).toHaveBeenCalledWith(
      "[dialer-connect-worker] recording link field rejected — check the rep's tdc_cti package license",
      { connectId: withTask().id, userId: 'rep-1' },
    );
  });

  it('an error before the last try records it and waits for the claim\'s backoff', async () => {
    const h = harness({ updateCallTask: vi.fn(async () => { throw new Error('503'); }) });
    expect(await pushConnectLink(withTask(), h.deps)).toBe('retry');
    expect(h.writes).toEqual([expect.objectContaining({ lastError: '503' })]);
    expect(h.writes[0]).not.toHaveProperty('recordingLinkSyncedAt');
  });

  it('an error on the last try gives up, loudly (the select never offers it again)', async () => {
    const h = harness({ updateCallTask: vi.fn(async () => { throw new Error('503'); }) });
    expect(await pushConnectLink(withTask({ linkAttempts: MAX_TRIES }), h.deps)).toBe('failed');
    expect(error).toHaveBeenCalledWith('[dialer-connect-worker] gave up — recording link not on the Task', expect.objectContaining({ connectId: withTask().id }));
  });
});

describe('the link-phase SQL, rendered', () => {
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
  it('due links: a created Task, a recording, not yet synced, tries left, due', () => {
    const { sql, params } = selectDueLinks(db, NOW).toSQL();
    expect(sql).toContain('"dialer_connects"."salesforce_task_id" is not null');
    expect(sql).toContain('"dialer_connects"."recording_url" is not null');
    expect(sql).toContain('"dialer_connects"."recording_link_synced_at" is null');
    expect(sql).toMatch(/"dialer_connects"\."link_attempts" < \$\d+/);
    expect(params).toEqual(expect.arrayContaining(['created', MAX_TRIES]));
  });
  it('link claim: compare-and-swap on link_attempts, still unsynced', () => {
    const { sql, params } = claimLink(db, { id: 'conn-1', linkAttempts: 0 }, NOW).toSQL();
    expect(sql).toMatch(/"dialer_connects"\."link_attempts" = \$\d+/);
    expect(sql).toContain('"dialer_connects"."recording_link_synced_at" is null');
    expect(params).toEqual(expect.arrayContaining([1, 'conn-1', 0]));
  });
});

/**
 * A db fake for the tick: `select…limit()` answers from `selects` in order;
 * `update…where()` is awaitable (a plain write) and has `.returning()`, which
 * answers from `returns` in order: the expire, then each claim.
 */
function tickDb(selects: DialerConnect[][], returns: unknown[][]) {
  const writes: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => selects.shift() ?? [] }) }) }) }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          writes.push(patch);
          const done = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
          done.returning = async () => returns.shift() ?? [];
          return done;
        },
      }),
    }),
  } as unknown as DialerConnectDeps['db'];
  return { db, writes };
}

describe('runDialerConnectTick', () => {
  it('expires, then makes the Task for each row it wins, then attaches each due link', async () => {
    const due = connectRow({ taskAttempts: 0 });
    const claimed = connectRow({ taskAttempts: 1 });
    const linkDue = connectRow({ id: '22222222-2222-4333-8444-555555555555', taskState: 'created', salesforceTaskId: '00TOLD', recordingUrl: 'https://api.twilio.com/r.mp3', linkAttempts: 0 });
    const linkClaimed = { ...linkDue, linkAttempts: 1 };
    const { db } = tickDb([[due], [linkDue]], [[{ id: 'old-1' }], [claimed], [linkClaimed]]);
    const h = harness();
    const result = await runDialerConnectTick({ ...h.deps, db });
    expect(result).toEqual({ expired: 1, tasks: 1, links: 1 });
    expect(h.sf.createCallTask).toHaveBeenCalledTimes(1);
    expect(h.sf.updateCallTask).toHaveBeenCalledWith('rep-1', '00TOLD', expect.any(Object));
    expect(warn).toHaveBeenCalledWith('[dialer-connect-worker] power-dial calls expired without a Task (bridged over 24 h ago)', { count: 1 });
  });

  it('a lost claim (another worker has it) is skipped — no Salesforce call', async () => {
    const { db } = tickDb([[connectRow({ taskAttempts: 0 })], []], [[], []]);
    const h = harness();
    expect(await runDialerConnectTick({ ...h.deps, db })).toEqual({ expired: 0, tasks: 0, links: 0 });
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
  });

  it('a row claimed past its last try (a crash on try 6) fails without another Salesforce call', async () => {
    const past = connectRow({ taskAttempts: MAX_TRIES + 1 });
    const { db, writes } = tickDb([[connectRow({ taskAttempts: MAX_TRIES })], []], [[], [past]]);
    const h = harness();
    await runDialerConnectTick({ ...h.deps, db });
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
    expect(writes).toContainEqual(expect.objectContaining({ taskState: 'failed', lastError: `gave up after ${MAX_TRIES} tries` }));
  });

  it('a failing row does not stop the rest of the batch', async () => {
    const a = connectRow({ id: 'aaaaaaaa-2222-4333-8444-555555555555', taskAttempts: 0 });
    const b = connectRow({ id: 'bbbbbbbb-2222-4333-8444-555555555555', taskAttempts: 0 });
    const { db, writes } = tickDb([[a, b], []], [[], [{ ...a, taskAttempts: 1 }], [{ ...b, taskAttempts: 1 }]]);
    const h = harness({
      createCallTask: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ taskId: '00TNEW000000002' }),
    });
    const result = await runDialerConnectTick({ ...h.deps, db });
    expect(result.tasks).toBe(2);
    expect(h.sf.createCallTask).toHaveBeenCalledTimes(2);
    expect(writes).toContainEqual(expect.objectContaining({ lastError: 'boom' }));
    expect(writes).toContainEqual(expect.objectContaining({ taskState: 'created', salesforceTaskId: '00TNEW000000002' }));
  });
});

describe('DIALER_CONNECT_TASKS kill switch — the loop', () => {
  it('off never starts the loop', () => {
    const start = vi.fn();
    expect(maybeStartDialerConnectLoop({ DIALER_CONNECT_TASKS: 'off' }, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
  it('on starts it at the loop interval', () => {
    const timer = {} as NodeJS.Timeout;
    const start = vi.fn(() => timer);
    expect(maybeStartDialerConnectLoop({ DIALER_CONNECT_TASKS: 'on' }, start)).toBe(timer);
    expect(start).toHaveBeenCalledWith(LOOP_INTERVAL_MS);
  });
});
```

  And in `config.test.ts`, append:

```ts
describe('DIALER_CONNECT_TASKS — the power-dial Call Task kill switch', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.DIALER_CONNECT_TASKS; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to ON', async () => {
    expect((await loadWith({ DIALER_CONNECT_TASKS: undefined })).DIALER_CONNECT_TASKS).toBe('on');
  });
  it('an empty value is treated as unset → on', async () => {
    expect((await loadWith({ DIALER_CONNECT_TASKS: '' })).DIALER_CONNECT_TASKS).toBe('on');
  });
  it('off turns it off', async () => {
    expect((await loadWith({ DIALER_CONNECT_TASKS: 'off' })).DIALER_CONNECT_TASKS).toBe('off');
  });
  it('anything else fails the boot loudly', async () => {
    await expect(loadWith({ DIALER_CONNECT_TASKS: 'false' })).rejects.toThrow(/DIALER_CONNECT_TASKS/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run src/salesforce/dialer-connect-worker.test.ts src/config.test.ts`
Expected: FAIL — the new exports and `DIALER_CONNECT_TASKS` do not exist.

- [ ] **Step 3: Add the config switch** — `config.ts`, after `DIALER_RECORDING`:

```ts
  /**
   * Kill switch for the power-dial Call Tasks (salesforce/dialer-connect-worker.ts).
   * `off` = the worker loop is never started: no Task, no recording link. Bridged
   * calls are still logged (dialer_connects); turning it back on logs only calls
   * bridged in the last 24 h — older ones expire, never backfilled. Default `on`;
   * strict enum like NO_ANSWER_CHATTER.
   */
  DIALER_CONNECT_TASKS: z.enum(['on', 'off']).default('on'),
```

- [ ] **Step 4: Implement the link phase, tick and loop** — in `dialer-connect-worker.ts`:
  - Extend the drizzle import to `import { and, asc, eq, gte, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';`, add `import type { AppConfig } from '../config.js'; import { loadConfig } from '../config.js';` and change the recording-links import to `import { buildRecordingPublicUrl, type RecordingLinkConfig } from '../telephony/recording-links.js';`.
  - Append:

```ts
/** The writable recording field click-to-dial Tasks carry (salesforce/sync.ts). */
export const RECORDING_URL_FIELD = 'tdc_cti__Recording_URL__c';

export function selectDueLinks(db: Db, now: Date) {
  return db
    .select()
    .from(c)
    .where(
      and(
        eq(c.taskState, 'created'),
        isNotNull(c.salesforceTaskId),
        isNotNull(c.recordingUrl),
        isNull(c.recordingLinkSyncedAt),
        lt(c.linkAttempts, MAX_TRIES),
        lte(c.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(c.bridgedAt))
    .limit(BATCH_LIMIT);
}

export function claimLink(db: Db, row: Pick<DialerConnect, 'id' | 'linkAttempts'>, now: Date) {
  const attempt = row.linkAttempts + 1;
  return db
    .update(c)
    .set({ linkAttempts: attempt, nextAttemptAt: new Date(now.getTime() + leaseFor(attempt)), updatedAt: now })
    .where(
      and(
        eq(c.id, row.id),
        isNull(c.recordingLinkSyncedAt),
        eq(c.linkAttempts, row.linkAttempts),
        lte(c.nextAttemptAt, now),
      ),
    )
    .returning();
}

/**
 * One claimed row → its recording link on its Task, as the rep. The PUBLIC
 * playback URL (GET /recordings/:id?sig=), never the Twilio media URL. A field
 * Salesforce rejects (the rep has no tdc_cti package license — see the
 * recording-links memory) is stamped synced with a loud log, exactly like the
 * click-to-dial sweep: no retry can fix a license.
 */
export async function pushConnectLink(row: DialerConnect, deps: DialerConnectDeps): Promise<'synced' | 'rejected' | 'retry' | 'failed'> {
  const url = buildRecordingPublicUrl(row.id, deps.link);
  try {
    const { updated } = await withTimeout(
      deps.sf.updateCallTask(row.userId, row.salesforceTaskId!, { [RECORDING_URL_FIELD]: url }),
      SF_CALL_TIMEOUT_MS,
      'recording link',
    );
    await patchConnect(deps.db, row.id, {
      recordingLinkSyncedAt: deps.now(),
      lastError: updated ? null : 'recording link field rejected',
    }, deps.now());
    if (!updated) {
      console.error(`${LOG} recording link field rejected — check the rep's tdc_cti package license`, { connectId: row.id, userId: row.userId });
      return 'rejected';
    }
    return 'synced';
  } catch (err) {
    const message = errorText(err);
    await patchConnect(deps.db, row.id, { lastError: message }, deps.now());
    if (row.linkAttempts >= MAX_TRIES) {
      console.error(`${LOG} gave up — recording link not on the Task`, { connectId: row.id, userId: row.userId, err: message });
      return 'failed';
    }
    console.warn(`${LOG} recording link try failed, will retry`, { connectId: row.id, attempt: row.linkAttempts, err: message });
    return 'retry';
  }
}

async function guarded(connectId: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`${LOG} row failed`, { connectId, err: errorText(err) });
  }
}

function liveDeps(): DialerConnectDeps {
  const cfg = loadConfig();
  return {
    db: getDb(),
    now: () => new Date(),
    link: { apiPublicUrl: cfg.API_PUBLIC_URL, secret: cfg.SESSION_SECRET },
    sf: { createCallTask, updateCallTask, fetchOwnership, fetchRecordName },
  };
}

export async function runDialerConnectTick(
  deps: DialerConnectDeps = liveDeps(),
): Promise<{ expired: number; tasks: number; links: number }> {
  const expired = await expireStaleConnects(deps.db, deps.now());
  if (expired.length > 0) {
    console.warn(`${LOG} power-dial calls expired without a Task (bridged over 24 h ago)`, { count: expired.length });
  }
  let tasks = 0;
  for (const candidate of await selectDueConnectTasks(deps.db, deps.now())) {
    // `deps.now()` AT EACH CLAIM: the lease is measured from the claim itself.
    const [claimed] = await claimConnectTask(deps.db, candidate, deps.now());
    if (!claimed) continue; // another worker has it, or it is no longer due
    if (claimed.taskAttempts > MAX_TRIES) {
      // Its last try crashed mid-way; never a 7th.
      await patchConnect(deps.db, claimed.id, { taskState: 'failed', lastError: `gave up after ${MAX_TRIES} tries` }, deps.now());
      console.error(`${LOG} gave up — no Task for this power-dial call`, { connectId: claimed.id, userId: claimed.userId, err: 'tries exhausted' });
      continue;
    }
    await guarded(claimed.id, () => processConnectTask(claimed, deps));
    tasks++;
  }
  let links = 0;
  for (const candidate of await selectDueLinks(deps.db, deps.now())) {
    const [claimed] = await claimLink(deps.db, candidate, deps.now());
    if (!claimed) continue;
    await guarded(claimed.id, () => pushConnectLink(claimed, deps));
    links++;
  }
  return { expired: expired.length, tasks, links };
}

/** Single-flight: a slow tick is never overlapped. */
export function startDialerConnectLoop(intervalMs = LOOP_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runDialerConnectTick()
      .catch((err) => console.error(`${LOG} tick error`, { err: errorText(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}

/** The kill switch (config.ts DIALER_CONNECT_TASKS). `start` is a test seam. */
export function maybeStartDialerConnectLoop(
  cfg: Pick<AppConfig, 'DIALER_CONNECT_TASKS'>,
  start: (intervalMs: number) => NodeJS.Timeout = startDialerConnectLoop,
): NodeJS.Timeout | null {
  return cfg.DIALER_CONNECT_TASKS === 'on' ? start(LOOP_INTERVAL_MS) : null;
}
```

- [ ] **Step 5: Wire it into the server** — `server.ts`
  - Import: `import { maybeStartDialerConnectLoop } from './salesforce/dialer-connect-worker.js';`
  - After the `inboundTextTimer` line:

```ts
  // Bridged power-dial calls → one completed Call Task + recording link.
  // Null when DIALER_CONNECT_TASKS=off.
  const dialerConnectTimer = maybeStartDialerConnectLoop(cfg);
```
  - In `close`, after `if (inboundTextTimer) clearInterval(inboundTextTimer);`: `if (dialerConnectTimer) clearInterval(dialerConnectTimer);`

- [ ] **Step 6: Run the whole api suite, the typecheck and the build**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec/services/cti-api && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: every test PASSES; typecheck clean; build exits 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add services/cti-api/src/salesforce/dialer-connect-worker.ts services/cti-api/src/salesforce/dialer-connect-worker.test.ts services/cti-api/src/config.ts services/cti-api/src/config.test.ts services/cti-api/src/server.ts
git commit -m "feat(sf): attach the recording link; tick + loop + DIALER_CONNECT_TASKS switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Runbook

**Files:**
- Create: `docs/runbooks/power-dial-recording.md`

- [ ] **Step 1: Write the runbook** — `docs/runbooks/power-dial-recording.md`

````markdown
# Power-dial recordings and connected-call Tasks

Every power-dial call bridged to a rep gets a row in `dialer_connects`, a
dual-channel recording of the prospect's leg (from the bridge on), and ONE
completed Call Task on the screen-popped record with the public recording link
in `tdc_cti__Recording_URL__c`. Design:
`docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md`.

## Switches (Railway `@cti/api` variables — changing one restarts the service)

| Variable | Default | `off` means |
|---|---|---|
| `TWILIO_RECORD_CALLS` | `true` | NO calls are recorded — click-to-dial and power dial |
| `DIALER_RECORDING` | `on` | power-dial calls are not recorded; Tasks still logged |
| `DIALER_CONNECT_TASKS` | `on` | no power-dial Tasks or links; rows still written; turning it back on logs only the last 24 h |

A two-party org (`campaign_configs.recording_consent_mode = 'two_party'` on the
`default` campaign) never has power-dial calls recorded — that path has no
automated disclosure.

## Reading a row

- `recording_state`: `requested` (started) · `start_failed` (Twilio refused —
  usually the prospect hung up first) · `skipped_consent` · `skipped_switch`.
- `task_state`: `pending` · `created` · `skipped_not_owner` (the rep does not own
  the record — the click-to-dial rule) · `expired` (bridged > 24 h ago) ·
  `failed` (6 tries; see `last_error`).
- `recording_link_synced_at` set with `last_error = 'recording link field
  rejected'` → the rep lacks the tdc_cti package license (UserPackageLicense).

## Checks (read-only SQL, via `railway run -s Postgres`)

```sql
-- Today's bridged calls by outcome
select task_state, recording_state, count(*)
from dialer_connects
where bridged_at > now() - interval '1 day'
group by 1, 2 order by 3 desc;

-- Anything stuck or failing
select id, user_id, task_state, task_attempts, link_attempts, last_error, bridged_at
from dialer_connects
where (task_state = 'failed')
   or (task_state = 'pending' and bridged_at < now() - interval '30 minutes')
   or (task_state = 'created' and recording_url is not null and recording_link_synced_at is null
       and updated_at < now() - interval '30 minutes')
order by bridged_at desc limit 50;
```

## Not covered

Power-dial calls before this shipped were never recorded — there is no audio to
recover.
````

- [ ] **Step 2: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti-dialer-rec
git add docs/runbooks/power-dial-recording.md
git commit -m "docs: power-dial recording runbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Whole-branch review, then deploy + live check (USER-GATED)

**Files:** none (unless review findings require fixes).

- [ ] **Step 1: Whole-branch review** — run a code review of `git diff origin/main...HEAD` (all tasks together: cross-task issues hide between tasks). Fix every Critical/Important finding with a test first, commit each fix.

- [ ] **Step 2: Full verification**

Run: `cd /Users/cdrshepard/spam-res-cti-dialer-rec && npm run build:packages && npm -w packages/db test && npm -w services/cti-api test && npm -w services/cti-api run typecheck`
Expected: all PASS.

- [ ] **Step 3: STOP — ask the user** for the go-ahead to merge to `main` and deploy (pushing `main` deploys production; migration 0047 runs on deploy). Do nothing further without an explicit yes.

- [ ] **Step 4 (after the yes): Deploy** — fast-forward `main` to the branch, push, confirm the Railway `@cti/api` deploy succeeds and the log shows `[migrate] applying 0047_dialer_connects.sql`. Ship in a gap with no live power-dial run (the user's "ship fixes mid-day" rule).

- [ ] **Step 5: Live check** on the E2E harness: Chrome softphone signed in as Evren; `+16194737991` in human mode; power-dial the "CTI DIAL TEST" list; talk ~15 s; hang up from the far end. Expect within a minute:
  - `dialer_connects`: one row, `recording_state='requested'`, `ended_at` set, `talk_seconds` ≈ 15, `task_state='created'`, `recording_url` set, `recording_link_synced_at` set;
  - Salesforce: a completed Task on the test record, subject `Outbound Call | Connected | (619) 473-7991 / …`, duration ≈ 15 s, Recording URL set;
  - the Recording URL plays with no login, prospect on one channel and the rep on the other.
  Record the result (PASS/FAIL with the row) in the project memory.
````

