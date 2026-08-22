# Task Dialing from the Rep's Own Numbers + Ownership Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rep can power-dial a Task list view; each call goes out from one of their own numbers chosen by the existing rotation; the dialed follow-up task rolls over under the two-attempt/daily-cap rules; and the CTI never creates a Salesforce Task on a record the caller doesn't own or manage.

**Architecture:** `'Task'` becomes a third dialer object type. At session creation each Task resolves to the person behind it (Lead / **Contact** / Opportunity-via-contact-role); the queue item keeps `record_id` = that person and gains `task_id` + `followup_eligible`. The engine's `pickDid` gains a run kind: Task sessions use a new `pickAgentDid` (the existing `pickRotationNumber` + a kind-parameterized atomic claim + the per-customer ceiling), Lead/Opp keep `pickPoolDid`. A second miss on an eligible item enqueues a job carrying `source_task_id`, which the worker rolls by identity. One pure `callerMayCreateTaskOn` gates the rollover copy, the after-call sync task, and (via `taskAllowed` on `POST /calls`) the softphone's Open CTI write.

**Tech Stack:** Fastify + Drizzle/Postgres (raw-SQL migrations), Salesforce REST via `sfFetch`/`soqlQuery`, Vitest node env in both packages (`apps/cti-web` = SSR/pure tests only), React 18.

## Global Constraints

- Next migration is **`0027_task_dialing.sql`**; every statement additive/idempotent.
- Follow-up subject rule (ONE shared constant): whole-word, case-insensitive match of `follow-up`, `follow up`, `followup`, `FU`, `F/U`, `F-U`. Bare substring `FU` must NOT match (`refund`, `FUEL`).
- Task → person precedence: `WhoId` Lead → Mobile/Phone; `WhoId` Contact → Mobile/Phone; no Who + `WhatId` Opportunity → primary contact role; else `unreachable`.
- `pickDid(args) → { e164 } | { skip: 'customer_ceiling' } | null`; `runKind = session.objectType === 'Task' ? 'agent' : 'pool'`. Pool path behavior unchanged except the shared per-customer ceiling. Fail closed (null → `paused_no_numbers`). Ceiling → item `skipped`, `outcome: 'customer_ceiling'`, run continues.
- Ownership: Lead → `OwnerId`; Contact → `OwnerId`; Opportunity → `OwnerId` OR `Lead_Manager__c`; Task → `OwnerId`. Object types the rule does not name (e.g. `Deal__c`) are **allowed**. `Lead_Manager__c` `INVALID_FIELD` → owner-only + one `console.warn` per process. Lookup failure fails **closed** (transient → retry).
- The gate never blocks placing a call — only writing Salesforce Tasks.
- Connect on a Task run does NOT auto-complete the task.
- Tests: pure logic with injected deps; `App.tsx` verified by typecheck + build. Verify each task with `npm test` + `npm run typecheck` in the package touched; the client task also `npm run build`.
- `.claude/launch.json` shows as an unstaged deletion that predates this work — never stage, restore, or commit it.

---

### Task 1: Migration + schema + the shared follow-up subject rule

**Files:**
- Create: `services/cti-api/migrations/0027_task_dialing.sql`
- Create: `services/cti-api/src/salesforce/followup-subject.ts`
- Create: `services/cti-api/src/salesforce/followup-subject.test.ts`
- Modify: `services/cti-api/src/db/schema.ts`, `services/cti-api/src/salesforce/followup.ts` (use the shared rule)

**Interfaces:**
- Produces: `FOLLOW_UP_SUBJECT_RE: RegExp`; `isFollowUpSubject(subject: string | null | undefined): boolean`; `countFollowUps(tasks: ReadonlyArray<{ Subject?: string | null }>): number`. Schema: `dialerQueueItems.taskId: text`, `dialerQueueItems.followupEligible: boolean (default true)`, `followupRolloverJobs.sourceTaskId: text`.

- [ ] **Step 1: Failing test** — `src/salesforce/followup-subject.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countFollowUps, isFollowUpSubject } from './followup-subject.js';

describe('isFollowUpSubject', () => {
  it('matches every agreed spelling, any case, anywhere in the subject', () => {
    for (const s of ['Follow-up', 'follow up with Maria', 'FOLLOWUP', 'FU: call back', 'F/U re: offer', 'F-U', '2nd f/u', 'Call - FU']) {
      expect(isFollowUpSubject(s), s).toBe(true);
    }
  });
  it('does NOT match FU inside another word', () => {
    for (const s of ['Refund request', 'FUEL surcharge', 'Send contract', 'Check in', null, undefined, '']) {
      expect(isFollowUpSubject(s), String(s)).toBe(false);
    }
  });
});

describe('countFollowUps', () => {
  it('counts only subject matches', () => {
    expect(countFollowUps([{ Subject: 'FU' }, { Subject: 'Refund' }, { Subject: null }, { Subject: 'Follow up' }])).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd services/cti-api && npx vitest run src/salesforce/followup-subject.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/salesforce/followup-subject.ts`:

```ts
/**
 * The ONE definition of "this task is a follow-up". Used by the rollover worker
 * (which task to roll), the daily-cap count, and Task-run eligibility.
 * Whole-word on purpose: a bare `FU` substring would match "refund".
 */
export const FOLLOW_UP_SUBJECT_RE = /(?:^|[^a-z])(?:follow[ -]?up|f[\/-]?u)(?![a-z])/i;

export function isFollowUpSubject(subject: string | null | undefined): boolean {
  return !!subject && FOLLOW_UP_SUBJECT_RE.test(subject);
}

/** Count the follow-ups in a fetched task list (replaces a SOQL COUNT that could not express the FU rule). */
export function countFollowUps(tasks: ReadonlyArray<{ Subject?: string | null }>): number {
  return tasks.reduce((n, t) => n + (isFollowUpSubject(t.Subject) ? 1 : 0), 0);
}
```

In `src/salesforce/followup.ts` replace `const FOLLOW_UP_RE = /follow[ -]?up/i;` and its use in `pickFollowUpTask` with `isFollowUpSubject(t.Subject)` (import from `./followup-subject.js`). Run `npx vitest run src/salesforce/followup.test.ts` — still green.

- [ ] **Step 4: Migration** — `migrations/0027_task_dialing.sql`:

```sql
-- Task dialing: a power-dial run can be built from a Task list view.
-- dialer_queue_items.record_id stays the PERSON/RECORD dialed (Lead, Contact,
-- or Opportunity id); task_id is the Task the item came from (null on Lead/Opp
-- runs). followup_eligible is decided once at creation from the shared
-- follow-up subject rule — only eligible items roll over on a second miss.
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "task_id" text;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "followup_eligible" boolean NOT NULL DEFAULT true;
-- The exact task to roll (Task runs); null = search the record (Lead/Opp runs).
ALTER TABLE "followup_rollover_jobs" ADD COLUMN IF NOT EXISTS "source_task_id" text;
```

- [ ] **Step 5: Schema** — in `dialerQueueItems` after `retryNotBefore` add:

```ts
    /** The Task this item came from (Task runs); null on Lead/Opp runs. */
    taskId: text('task_id'),
    /** Decided at creation from the follow-up subject rule; only eligible items roll over. */
    followupEligible: boolean('followup_eligible').default(true).notNull(),
```

In `followupRolloverJobs` after `nextDay` add `sourceTaskId: text('source_task_id'),` with a one-line comment. (`boolean` is already imported from drizzle in schema.ts — confirm.)

- [ ] **Step 6: Verify + commit**

`npx vitest run src/salesforce/followup-subject.test.ts src/salesforce/followup.test.ts && npm run typecheck` → PASS.
```bash
git add services/cti-api/migrations/0027_task_dialing.sql services/cti-api/src/db/schema.ts services/cti-api/src/salesforce/followup-subject.ts services/cti-api/src/salesforce/followup-subject.test.ts services/cti-api/src/salesforce/followup.ts
git commit -m "feat(cti-api): task-dialing schema + the shared follow-up subject rule"
```

---

### Task 2: Task → person resolution (+ Contact phones)

**Files:**
- Create: `services/cti-api/src/salesforce/task-targets.ts`, `services/cti-api/src/salesforce/task-targets.test.ts`
- Modify: `services/cti-api/src/salesforce/record-phone.ts` (add `'Contact'`), `services/cti-api/src/salesforce/record-phone.test.ts`

**Interfaces:**
- Produces: `type TargetObject = 'Lead' | 'Contact' | 'Opportunity'`; `interface TaskRow { Id: string; Subject: string | null; OwnerId: string; WhoId: string | null; WhatId: string | null; Who?: { Type?: string } | null; What?: { Type?: string } | null }`; `resolveTaskTarget(task: TaskRow): { recordId: string; objectType: TargetObject; followupEligible: boolean } | null` (pure); `fetchTasks(userId: string, taskIds: string[]): Promise<TaskRow[]>` (batched ≤200); `resolveDialNumber(userId, objectType: 'Lead' | 'Contact' | 'Opportunity', recordId)`.

- [ ] **Step 1: Failing tests** — `task-targets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveTaskTarget, type TaskRow } from './task-targets.js';

const t = (o: Partial<TaskRow>): TaskRow => ({ Id: '00T1', Subject: 'Follow-up', OwnerId: '005', WhoId: null, WhatId: null, ...o });

describe('resolveTaskTarget', () => {
  it('a Lead Who wins', () => {
    expect(resolveTaskTarget(t({ WhoId: '00Q1', Who: { Type: 'Lead' }, WhatId: '0061', What: { Type: 'Opportunity' } })))
      .toEqual({ recordId: '00Q1', objectType: 'Lead', followupEligible: true });
  });
  it('a Contact Who is dialable (new object)', () => {
    expect(resolveTaskTarget(t({ WhoId: '0031', Who: { Type: 'Contact' } }))?.objectType).toBe('Contact');
  });
  it('no Who but an Opportunity What → the opportunity', () => {
    expect(resolveTaskTarget(t({ WhatId: '0061', What: { Type: 'Opportunity' } }))?.objectType).toBe('Opportunity');
  });
  it('anything else is unreachable (null)', () => {
    expect(resolveTaskTarget(t({ WhatId: '0011', What: { Type: 'Account' } }))).toBeNull();
    expect(resolveTaskTarget(t({}))).toBeNull();
  });
  it('followupEligible comes from the subject rule', () => {
    expect(resolveTaskTarget(t({ WhoId: '00Q1', Who: { Type: 'Lead' }, Subject: 'Check in' }))?.followupEligible).toBe(false);
    expect(resolveTaskTarget(t({ WhoId: '00Q1', Who: { Type: 'Lead' }, Subject: 'F/U' }))?.followupEligible).toBe(true);
  });
});
```

Append to `record-phone.test.ts` (mirror its existing `vi.mock('./client.js')` style):

```ts
  it('resolves a Contact by Mobile then Phone', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '(619) 555-0100', Phone: '(619) 555-0199' }]);
    const r = await resolveDialNumber('u1', 'Contact', '0031');
    expect(mockSoql.mock.calls[0][1]).toMatch(/FROM Contact WHERE Id = '0031'/);
    expect(r).toEqual({ e164: '+16195550100', fallbackE164: '+16195550199' });
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/salesforce/task-targets.test.ts src/salesforce/record-phone.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `record-phone.ts`: widen the type to `objectType: 'Lead' | 'Contact' | 'Opportunity'` and add a branch:

```ts
  } else if (objectType === 'Contact') {
    const rows = await soqlQuery<{ MobilePhone?: string | null; Phone?: string | null }>(
      userId,
      `SELECT MobilePhone, Phone FROM Contact WHERE Id = '${rid}' LIMIT 1`,
    );
    fields = rows[0] ?? null;
  } else {
```

`task-targets.ts`:

```ts
import { soqlEscape, soqlQuery } from './client.js';
import { isFollowUpSubject } from './followup-subject.js';

export type TargetObject = 'Lead' | 'Contact' | 'Opportunity';
export interface TaskRow {
  Id: string; Subject: string | null; OwnerId: string;
  WhoId: string | null; WhatId: string | null;
  Who?: { Type?: string } | null; What?: { Type?: string } | null;
}

/** Pure — the person/record a Task dials, in the agreed precedence; null = unreachable. */
export function resolveTaskTarget(task: TaskRow): { recordId: string; objectType: TargetObject; followupEligible: boolean } | null {
  const eligible = isFollowUpSubject(task.Subject);
  const whoType = task.Who?.Type;
  if (task.WhoId && (whoType === 'Lead' || whoType === 'Contact')) {
    return { recordId: task.WhoId, objectType: whoType, followupEligible: eligible };
  }
  if (task.WhatId && task.What?.Type === 'Opportunity') {
    return { recordId: task.WhatId, objectType: 'Opportunity', followupEligible: eligible };
  }
  return null;
}

const CHUNK = 200;
/** Batched fetch of the Tasks in a list view, with the polymorphic Who/What types. */
export async function fetchTasks(userId: string, taskIds: string[]): Promise<TaskRow[]> {
  const out: TaskRow[] = [];
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const ids = taskIds.slice(i, i + CHUNK).map((id) => `'${soqlEscape(id)}'`).join(',');
    out.push(...await soqlQuery<TaskRow>(
      userId,
      `SELECT Id, Subject, OwnerId, WhoId, WhatId, Who.Type, What.Type FROM Task WHERE Id IN (${ids})`,
    ));
  }
  return out;
}
```

- [ ] **Step 4: Verify + commit** — both test files PASS; `npm run typecheck` clean.
```bash
git add services/cti-api/src/salesforce/task-targets.ts services/cti-api/src/salesforce/task-targets.test.ts services/cti-api/src/salesforce/record-phone.ts services/cti-api/src/salesforce/record-phone.test.ts
git commit -m "feat(cti-api): resolve a Task to the person it dials; Contact phone resolution"
```

---

### Task 3: `'Task'` as a third run type (session creation + routes + relay)

**Files:**
- Modify: `services/cti-api/src/dialer/create-session.ts` (+ `create-session.test.ts`), `services/cti-api/src/routes/dialer.ts`, `services/cti-api/src/dialer/handoff-store.ts`, `services/cti-api/src/db/schema.ts` (comments only)

**Interfaces:**
- Consumes: `fetchTasks`, `resolveTaskTarget` (Task 2); `resolveDialNumber` with `'Contact'`.
- Produces: `type DialerRunObject = 'Lead' | 'Opportunity' | 'Task'` (export from `create-session.ts`); `CreateSessionDeps` gains `fetchTasks: typeof fetchTasks`; `buildQueueRows(sessionId, rows: Array<{ recordId; objectType: 'Lead'|'Contact'|'Opportunity'; toNumber; fallbackNumber?; taskId?: string | null; followupEligible?: boolean }>)` — note the per-ROW `objectType`.

- [ ] **Step 1: Failing test** — append to `create-session.test.ts`:

```ts
describe('createDialerSession — Task runs', () => {
  it('resolves each Task to its person, keeps the task id + eligibility on the row, and marks the session a Task run', async () => {
    const fetchTasks = vi.fn(async () => [
      { Id: '00T1', Subject: 'Follow-up', OwnerId: '005', WhoId: '00Q1', WhatId: null, Who: { Type: 'Lead' } },
      { Id: '00T2', Subject: 'Check in', OwnerId: '005', WhoId: '0031', WhatId: null, Who: { Type: 'Contact' } },
      { Id: '00T3', Subject: 'FU', OwnerId: '005', WhoId: null, WhatId: '0011', What: { Type: 'Account' } },
    ]);
    const resolveDialNumber = vi.fn(async (_u: string, obj: string, id: string) =>
      obj === 'Lead' ? { e164: '+16195550100', fallbackE164: null } : obj === 'Contact' ? { e164: '+16195550200', fallbackE164: null } : null);
    const db = fakeDb(); // use this file's existing fake; it records session insert + item rows
    const r = await createDialerSession({ db, resolveDialNumber, fetchTasks, salesforceUserId: async () => '005' } as any,
      { userId: 'U1', orgId: 'O1', objectType: 'Task', recordIds: ['00T1', '00T2', '00T3'] });
    expect(r.total).toBe(3);
    expect(db._sessionInsert.objectType).toBe('Task');
    expect(db._itemRows.map((x: any) => [x.recordId, x.objectType, x.taskId, x.followupEligible, x.status])).toEqual([
      ['00Q1', 'Lead', '00T1', true, 'pending'],
      ['0031', 'Contact', '00T2', false, 'pending'],
      ['00T3', 'Task', '00T3', true, 'unreachable'],
    ]);
  });
});
```

(Adapt `fakeDb()` to expose `_sessionInsert` and `_itemRows` if the file's fake doesn't already — keep its existing tests green. For an unreachable Task the row keeps `recordId = taskId, objectType = 'Task'` so the panel can still show what was skipped.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/dialer/create-session.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `create-session.ts`:

```ts
export type DialerRunObject = 'Lead' | 'Opportunity' | 'Task';

export interface CreateSessionDeps {
  resolveDialNumber: typeof resolveDialNumber;
  fetchTasks: typeof fetchTasks;
  salesforceUserId: typeof salesforceUserId;
  db: ReturnType<typeof getDb>;
}

type ResolvedRow = { recordId: string; objectType: 'Lead' | 'Contact' | 'Opportunity' | 'Task'; toNumber: string | null; fallbackNumber?: string | null; taskId?: string | null; followupEligible?: boolean };

export function buildQueueRows(sessionId: string, resolved: ResolvedRow[]) {
  return resolved.map((r, i) => ({
    sessionId, ordinal: i, objectType: r.objectType, recordId: r.recordId, toNumber: r.toNumber,
    fallbackNumber: r.fallbackNumber ?? null,
    attempt: 1, primaryNumber: r.toNumber, secondaryNumber: r.fallbackNumber ?? null,
    taskId: r.taskId ?? null, followupEligible: r.followupEligible ?? true,
    status: r.toNumber ? ('pending' as const) : ('unreachable' as const),
  }));
}

async function resolveRows(deps: CreateSessionDeps, userId: string, objectType: DialerRunObject, recordIds: string[]): Promise<ResolvedRow[]> {
  if (objectType !== 'Task') {
    const out: ResolvedRow[] = [];
    for (const recordId of recordIds) {
      const r = await deps.resolveDialNumber(userId, objectType, recordId);
      out.push({ recordId, objectType, toNumber: r?.e164 ?? null, fallbackNumber: r?.fallbackE164 ?? null });
    }
    return out;
  }
  const tasks = await deps.fetchTasks(userId, recordIds);
  const byId = new Map(tasks.map((t) => [t.Id, t]));
  const out: ResolvedRow[] = [];
  for (const taskId of recordIds) {
    const task = byId.get(taskId);
    const target = task ? resolveTaskTarget(task) : null;
    if (!target) { out.push({ recordId: taskId, objectType: 'Task', toNumber: null, taskId, followupEligible: true }); continue; }
    const r = await deps.resolveDialNumber(userId, target.objectType, target.recordId);
    out.push({ recordId: target.recordId, objectType: target.objectType, toNumber: r?.e164 ?? null, fallbackNumber: r?.fallbackE164 ?? null, taskId, followupEligible: target.followupEligible });
  }
  return out;
}
```

`createDialerSession`/`createAndStartSession` take `objectType: DialerRunObject`; replace the inline resolve loop with `const resolved = await resolveRows(deps, args.userId, args.objectType, args.recordIds);` and `buildQueueRows(session!.id, resolved)` (the old 3-arg call drops its `objectType` argument — update the existing `buildQueueRows` tests accordingly; per-row `objectType` now comes from the row). Update schema comments `// 'Lead' | 'Opportunity'` → `// 'Lead' | 'Opportunity' | 'Task' (session) / 'Lead' | 'Contact' | 'Opportunity' | 'Task' (item)`.

`routes/dialer.ts`: both `z.enum(['Lead', 'Opportunity'])` → `z.enum(['Lead', 'Opportunity', 'Task'])`; the list-view fetch already interpolates `${object}`, so `/sobjects/Task/listviews` works; pass `fetchTasks` into the deps objects handed to `createAndStartSession` (import from `'../salesforce/task-targets.js'`). `handoff-store.ts`: the three `'Lead' | 'Opportunity'` unions and the cast become the 3-value union.

- [ ] **Step 4: Verify + commit** — `npm test && npm run typecheck` → all PASS.
```bash
git add services/cti-api/src/dialer/create-session.ts services/cti-api/src/dialer/create-session.test.ts services/cti-api/src/routes/dialer.ts services/cti-api/src/dialer/handoff-store.ts services/cti-api/src/db/schema.ts
git commit -m "feat(cti-api): Task list views as a third power-dial run type"
```

---

### Task 4: Number selection — `pickAgentDid`, kind-aware engine, shared per-customer ceiling

**Files:**
- Modify: `services/cti-api/src/rotation.ts` (add `exclude`), `services/cti-api/src/dialer/pick-did.ts` (export `attemptIncrement(db, orgId, e164, cap, kind)` + `effectiveCapFor`), `services/cti-api/src/dialer/engine.ts` (+ `engine.test.ts`), `services/cti-api/src/dialer/live-deps.ts`
- Create: `services/cti-api/src/dialer/pick-agent-did.ts`, `services/cti-api/src/dialer/pick-agent-did.test.ts`

**Interfaces:**
- Produces: `type PickDidArgs = { orgId: string; userId: string; toE164: string; runKind: 'pool' | 'agent' }`; `type PickDidResult = { e164: string } | { skip: 'customer_ceiling' } | null`; `EngineDeps.pickDid: (args: PickDidArgs) => Promise<PickDidResult>`; `customerAttemptState(db, orgId, toE164): Promise<{ attemptsByNumber: Map<string, number>; customerAttemptsTotal: number; campaign: { maxAttempts; perCustomerMaxAttempts } | null }>`; `pickAgentDid(db, args, deps?)`; `pickDidForRun(db, args)` (the router used by live-deps: ceiling check for both kinds, then agent or pool).

- [ ] **Step 1: Failing tests** — `pick-agent-did.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { pickAgentDid, type AgentPickDeps } from './pick-agent-did.js';

function deps(over: Partial<AgentPickDeps> = {}): AgentPickDeps {
  return {
    attemptState: vi.fn(async () => ({ attemptsByNumber: new Map(), customerAttemptsTotal: 0, campaign: { maxAttempts: 5, perCustomerMaxAttempts: 15 } })),
    rotate: vi.fn(async () => '+16195550001'),
    claim: vi.fn(async () => true),
    ...over,
  };
}
const args = { orgId: 'O1', userId: 'U1', toE164: '+16195559999' };

describe('pickAgentDid', () => {
  it('skips the customer (does not pause the run) at the per-customer ceiling', async () => {
    const d = deps({ attemptState: vi.fn(async () => ({ attemptsByNumber: new Map(), customerAttemptsTotal: 15, campaign: { maxAttempts: 5, perCustomerMaxAttempts: 15 } })) });
    expect(await pickAgentDid(args, d)).toEqual({ skip: 'customer_ceiling' });
    expect(d.rotate).not.toHaveBeenCalled();
  });
  it('returns the rotation pick once its atomic claim succeeds, passing the per-customer caps through', async () => {
    const d = deps();
    expect(await pickAgentDid(args, d)).toEqual({ e164: '+16195550001' });
    expect(d.rotate).toHaveBeenCalledWith('+16195559999', { attemptsByNumber: expect.any(Map), maxAttemptsPerNumber: 5 }, undefined);
    expect(d.claim).toHaveBeenCalledWith('+16195550001');
  });
  it('retries rotation once excluding a number whose claim lost a race', async () => {
    const rotate = vi.fn().mockResolvedValueOnce('+16195550001').mockResolvedValueOnce('+16195550002');
    const claim = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const d = deps({ rotate, claim });
    expect(await pickAgentDid(args, d)).toEqual({ e164: '+16195550002' });
    expect(rotate.mock.calls[1][2]).toEqual(new Set(['+16195550001']));
  });
  it('fails closed when nothing is eligible', async () => {
    expect(await pickAgentDid(args, deps({ rotate: vi.fn(async () => null) }))).toBeNull();
    const claim = vi.fn(async () => false);
    expect(await pickAgentDid(args, deps({ claim }))).toBeNull();
  });
  it('with no campaign config there is no ceiling and no per-number cap', async () => {
    const d = deps({ attemptState: vi.fn(async () => ({ attemptsByNumber: new Map(), customerAttemptsTotal: 99, campaign: null })) });
    expect(await pickAgentDid(args, d)).toEqual({ e164: '+16195550001' });
    expect(d.rotate).toHaveBeenCalledWith('+16195559999', undefined, undefined);
  });
});
```

Add to `engine.test.ts` (`advanceSession` describe), after updating `makeDeps` to `pickDid: vi.fn(async () => ({ e164: '+16190000000' })) as any`:

```ts
  it('asks pickDid with runKind "agent" for a Task session and "pool" otherwise', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+16195550100', secondaryNumber: null, followupEligible: true }];
    const d1 = makeDeps(); d1.db = fakeDb({ ...baseSession, objectType: 'Task' }, items);
    await advanceSession('S1', d1);
    expect(d1.pickDid).toHaveBeenCalledWith(expect.objectContaining({ runKind: 'agent', toE164: '+16195550100' }));
    const d2 = makeDeps(); d2.db = fakeDb(baseSession, items);
    await advanceSession('S1', d2);
    expect(d2.pickDid).toHaveBeenCalledWith(expect.objectContaining({ runKind: 'pool' }));
  });
  it('a customer_ceiling skip marks the item skipped and moves on without pausing', async () => {
    const items = [
      { id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+1', secondaryNumber: null, followupEligible: true },
      { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+2', secondaryNumber: null, followupEligible: true },
    ];
    const pickDid = vi.fn().mockResolvedValueOnce({ skip: 'customer_ceiling' }).mockResolvedValueOnce({ e164: '+16190000000' });
    const deps = makeDeps({ pickDid } as any); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'customer_ceiling' }) });
    expect(r.action).toBe('dialing');
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/dialer/pick-agent-did.test.ts src/dialer/engine.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`rotation.ts`: add a 6th param `exclude?: ReadonlySet<string>` and filter `.filter((n) => !exclude?.has(n.e164))` on the pool before ranking; the sticky branch must also skip an excluded sticky.

`pick-did.ts`: export `effectiveCapFor`; change `attemptIncrement` to `export async function attemptIncrement(db, orgId, e164, effectiveCap, kind: 'agent' | 'dialer_pool' = 'dialer_pool')` and use `eq(schema.outboundNumbers.kind, kind)`.

`pick-agent-did.ts`:

```ts
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema } from '../db/index.js';
import { tallyAttempts } from '../firewall/index.js';
import { pickRotationNumber, type AttemptCaps } from '../rotation.js';
import { attemptIncrement, effectiveCapFor, pickPoolDid, type Db } from './pick-did.js';

export type PickDidArgs = { orgId: string; userId: string; toE164: string; runKind: 'pool' | 'agent' };
export type PickDidResult = { e164: string } | { skip: 'customer_ceiling' } | null;

export interface AttemptState {
  attemptsByNumber: Map<string, number>;
  customerAttemptsTotal: number;
  campaign: { maxAttempts: number; perCustomerMaxAttempts: number } | null;
}

/** The firewall's per-customer attempt query, reused: this org's calls to `toE164` in the campaign window, by from-number. */
export async function customerAttemptState(db: Db, orgId: string, toE164: string): Promise<AttemptState> {
  const campaign = await db.query.campaignConfigs.findFirst({ where: and(eq(schema.campaignConfigs.orgId, orgId), eq(schema.campaignConfigs.key, 'default')) });
  if (!campaign) return { attemptsByNumber: new Map(), customerAttemptsTotal: 0, campaign: null };
  const windowStart = new Date(Date.now() - campaign.attemptWindowDays * 24 * 3600 * 1000);
  const grouped = await db
    .select({ from: schema.calls.fromNumber, n: sql<number>`count(*)::int` })
    .from(schema.calls)
    .where(and(eq(schema.calls.orgId, orgId), eq(schema.calls.normalizedToNumber, toE164), gte(schema.calls.createdAt, windowStart)))
    .groupBy(schema.calls.fromNumber);
  return { ...tallyAttempts(grouped), campaign: { maxAttempts: campaign.maxAttempts, perCustomerMaxAttempts: campaign.perCustomerMaxAttempts } };
}

export interface AgentPickDeps {
  attemptState: () => Promise<AttemptState>;
  rotate: (toE164: string, caps: AttemptCaps | undefined, exclude: ReadonlySet<string> | undefined) => Promise<string | null>;
  claim: (e164: string) => Promise<boolean>;
}

/** Agent-number pick for Task runs: ceiling → rotation → atomic claim (one retry excluding a lost race) → fail closed. */
export async function pickAgentDid(_args: { orgId: string; userId: string; toE164: string }, deps: AgentPickDeps): Promise<PickDidResult> {
  const state = await deps.attemptState();
  if (state.campaign && state.customerAttemptsTotal >= state.campaign.perCustomerMaxAttempts) return { skip: 'customer_ceiling' };
  const caps = state.campaign ? { attemptsByNumber: state.attemptsByNumber, maxAttemptsPerNumber: state.campaign.maxAttempts } : undefined;
  let exclude: Set<string> | undefined;
  for (let i = 0; i < 2; i++) {
    const e164 = await deps.rotate(_args.toE164, caps, exclude);
    if (!e164) return null;
    if (await deps.claim(e164)) return { e164 };
    exclude = new Set([...(exclude ?? []), e164]);
  }
  return null;
}

/** Live router used by the engine: the per-customer ceiling applies to BOTH kinds; per-number rotation is agent-only. */
export async function pickDidForRun(db: Db, args: PickDidArgs): Promise<PickDidResult> {
  const attemptState = () => customerAttemptState(db, args.orgId, args.toE164);
  if (args.runKind === 'agent') {
    return pickAgentDid(args, {
      attemptState,
      rotate: (to, caps, exclude) => pickRotationNumber(db, args.orgId, args.userId, to, caps, exclude),
      claim: async (e164) => {
        const row = await db.query.outboundNumbers.findFirst({ where: and(eq(schema.outboundNumbers.orgId, args.orgId), eq(schema.outboundNumbers.e164, e164), eq(schema.outboundNumbers.assignedUserId, args.userId)) });
        return !!row && attemptIncrement(db, args.orgId, e164, effectiveCapFor(row), 'agent');
      },
    });
  }
  const state = await attemptState();
  if (state.campaign && state.customerAttemptsTotal >= state.campaign.perCustomerMaxAttempts) return { skip: 'customer_ceiling' };
  return pickPoolDid(db, { orgId: args.orgId, userId: args.userId, toE164: args.toE164 });
}
```

(`tallyAttempts` is already exported from `firewall/index.ts`.)

`engine.ts`: `pickDid: (args: PickDidArgs) => Promise<PickDidResult>;` (import the types from `./pick-agent-did.js`). In `advanceSession` replace the pick block with:

```ts
    const runKind = session.objectType === 'Task' ? 'agent' : 'pool';
    const did = await deps.pickDid({ orgId: session.orgId, userId: session.userId, toE164: next.toNumber, runKind });
    if (did && 'skip' in did) {
      // Over-contacted customer: skip THIS record, keep the run going.
      await setItem(deps, next.id, { status: 'skipped', outcome: did.skip });
      items = items.map((i) => (i.id === next.id ? { ...i, status: 'skipped', outcome: did.skip } : i));
      continue;
    }
    if (!did) { await setSession(deps, sessionId, 'paused'); return { action: 'paused_no_numbers' }; }
```

`live-deps.ts`: `pickDid: (args) => pickDidForRun(db, args),` (import from `./pick-agent-did.js`; drop the unused `pickPoolDid` import if nothing else uses it). Update `routes/dialer-webhook.test.ts`'s `pickDid` stub signature if typecheck complains.

- [ ] **Step 4: Verify + commit** — `npm test && npm run typecheck` → PASS.
```bash
git add services/cti-api/src/rotation.ts services/cti-api/src/dialer/pick-did.ts services/cti-api/src/dialer/pick-agent-did.ts services/cti-api/src/dialer/pick-agent-did.test.ts services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts services/cti-api/src/dialer/live-deps.ts services/cti-api/src/routes/dialer-webhook.test.ts
git commit -m "feat(cti-api): Task runs dial from the rep's own numbers via rotation; per-customer ceiling on every run"
```

---

### Task 5: Roll over the dialed task by identity; cap count in code

**Files:**
- Modify: `services/cti-api/src/dialer/engine.ts` (+test), `services/cti-api/src/salesforce/followup-worker.ts` (+test), `services/cti-api/src/salesforce/followup-day.ts` (+test)

**Interfaces:**
- Consumes: `isFollowUpSubject`, `countFollowUps` (Task 1); `schema.followupRolloverJobs.sourceTaskId` (Task 1).
- Produces: `RolloverEnqueue` gains `sourceTaskId: string | null`; `followUpTasksSoql(sfOwnerId, isoDate): string` (replaces `followUpCountSoql`); `WorkerDeps.sf` no longer needs `soqlCount`; `countOn` fetches tasks and counts in code.

- [ ] **Step 1: Failing tests**

`engine.test.ts` (`handleDialOutcome` describe):

```ts
  it('a Task run: the second miss enqueues the rollover with the dialed task id', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, taskId: '00T1', followupEligible: true }];
    const deps = makeDeps(); deps.db = fakeDb({ ...baseSession, objectType: 'Task' }, items);
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({ sourceTaskId: '00T1', recordId: '00Q1' }), expect.anything());
  });
  it('a Task run: a non-follow-up task is dialed twice but never enqueues a rollover', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '0031', objectType: 'Contact', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, taskId: '00T2', followupEligible: false }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, objectType: 'Task' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
  });
```

`followup-day.test.ts`: replace the `followUpCountSoql` describe with:

```ts
describe('followUpTasksSoql', () => {
  it('fetches the owner\'s OPEN tasks due that day (subjects are matched in code — SOQL cannot express the FU rule)', () => {
    const q = followUpTasksSoql('005ABC', '2026-08-21');
    expect(q).toMatch(/^SELECT Id, Subject FROM Task WHERE /);
    expect(q).toContain("OwnerId = '005ABC'"); expect(q).toContain('IsClosed = false'); expect(q).toContain('ActivityDate = 2026-08-21');
    expect(q).toMatch(/LIMIT 500$/); expect(q).not.toMatch(/LIKE/);
  });
});
```

`followup-worker.test.ts`: update `deps()` — replace `soqlCount` with the fetch shape: `soqlQuery` is called for the count too, so make the fake `soqlQuery` answer by query text: `vi.fn(async (_u, q: string) => /FROM Task WHERE OwnerId/.test(q) ? [{ Subject: 'FU' }, { Subject: 'Refund' }] : [openTask])` (1 follow-up on the day → under cap). Add:

```ts
  it('rolls the SOURCE task by id on a Task-run job (no search), and no-ops if it is closed/reassigned', async () => {
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async (_u: string, q: string) =>
      /Id = '00T9'/.test(q) ? [{ ...openTask, Id: '00T9' }] : /FROM Task WHERE OwnerId/.test(q) ? [] : []) } });
    await processRolloverJob(job({ sourceTaskId: '00T9' } as any), d);
    expect((d.sf.sfFetch as any).mock.calls.map((c: any[]) => c[1])).toEqual(['/sobjects/Task', '/sobjects/Task/00T9']);
    const d2 = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async () => []) } });
    await processRolloverJob(job({ sourceTaskId: '00T9' } as any), d2);
    expect(d2.sf.sfFetch).not.toHaveBeenCalled();
    expect(d2.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', lastError: 'no-task' }) });
  });
  it('counts the day\'s follow-ups in code with the shared subject rule (FU counts, Refund does not)', async () => {
    const seen: string[] = [];
    const d = deps({ capFor: vi.fn(async () => 1), sf: { ...deps().sf, soqlQuery: vi.fn(async (_u: string, q: string) => {
      if (/FROM Task WHERE OwnerId/.test(q)) { seen.push(q); return /2026-08-21/.test(q) ? [{ Subject: 'F/U' }, { Subject: 'Refund' }] : []; }
      return [openTask];
    }) } });
    await processRolloverJob(job(), d);
    expect((d.sf.sfFetch as any).mock.calls[0][2].body.ActivityDate).toBe('2026-08-24'); // 8/21 had 1 FU = at cap 1 → pushed
  });
```

- [ ] **Step 2: Run to verify failure** — the three files → FAIL.

- [ ] **Step 3: Implement**

`engine.ts`: `RolloverEnqueue` gains `sourceTaskId: string | null`. The enqueue predicate becomes `enqueue = !requeue && item.followupEligible && (attempt >= 2 || (retryTo == null && sessionLive))` and the enqueue call adds `sourceTaskId: item.taskId ?? null`.

`followup-day.ts`: replace `followUpCountSoql` with:

```ts
/** The owner's OPEN tasks due `isoDate`; subjects are matched in code (`countFollowUps`). Bounded: >500 on one day is over any cap. */
export function followUpTasksSoql(sfOwnerId: string, isoDate: string): string {
  return `SELECT Id, Subject FROM Task WHERE OwnerId = '${soqlEscape(sfOwnerId)}' AND IsClosed = false AND ActivityDate = ${isoDate} LIMIT 500`;
}
```

`followup-worker.ts`: `countOn: async (d) => countFollowUps(await withTimeout(deps.sf.soqlQuery<{ Subject?: string | null }>(job.userId, followUpTasksSoql(job.sfOwnerId, d)), SF_CALL_TIMEOUT_MS, 'follow-up count'))`; remove `soqlCount` from `WorkerDeps.sf` and `liveDeps`. Add:

```ts
async function findSourceTask(deps: WorkerDeps, job: FollowupRolloverJob, sourceTaskId: string): Promise<FollowUpTask | null> {
  const rows = await withTimeout(deps.sf.soqlQuery<FollowUpTask>(job.userId,
    'SELECT Id, Subject, Type, Priority, OwnerId, WhoId, WhatId, ActivityDate FROM Task ' +
    `WHERE Id = '${soqlEscape(sourceTaskId)}' AND IsClosed = false AND OwnerId = '${soqlEscape(job.sfOwnerId)}' LIMIT 1`), SF_CALL_TIMEOUT_MS, 'source task');
  return rows[0] ?? null;
}
```

and in `processRolloverJob`: `const task = job.sourceTaskId ? await findSourceTask(deps, job, job.sourceTaskId) : await findOpenFollowUp(deps, job);`. `findOpenFollowUp` drops its three `LIKE` clauses (the `pickFollowUpTask` filter already applies the shared rule in code) but keeps `LIMIT 50`. Remove `soqlCount`/`parseSoqlCount` from `client.ts` and their test if nothing else imports them (grep).

- [ ] **Step 4: Verify + commit** — `npm test && npm run typecheck` → PASS.
```bash
git add services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts services/cti-api/src/salesforce/followup-worker.ts services/cti-api/src/salesforce/followup-worker.test.ts services/cti-api/src/salesforce/followup-day.ts services/cti-api/src/salesforce/followup-day.test.ts services/cti-api/src/salesforce/client.ts services/cti-api/src/salesforce/client-count.test.ts
git commit -m "feat(cti-api): roll the dialed task by id on Task runs; follow-up cap counted in code with the shared rule"
```

---

### Task 6: Ownership gate — rollover copies, after-call sync tasks, `taskAllowed` on `POST /calls`

**Files:**
- Create: `services/cti-api/src/salesforce/ownership.ts`, `services/cti-api/src/salesforce/ownership.test.ts`
- Modify: `services/cti-api/src/salesforce/followup-worker.ts` (+test), `services/cti-api/src/salesforce/sync.ts`, `services/cti-api/src/routes/calls.ts`

**Interfaces:**
- Produces: `type OwnedObject = 'Lead' | 'Contact' | 'Opportunity' | 'Task'`; `objectTypeForId(id: string): OwnedObject | 'other'` (`00Q`→Lead, `003`→Contact, `006`→Opportunity, `00T`→Task); `interface OwnershipSnapshot { type: OwnedObject | 'other'; ownerId: string | null; leadManagerId?: string | null }`; `callerMayCreateTaskOn(snapshot, callerSfUserId): boolean` (pure); `fetchOwnership(userId, recordId): Promise<OwnershipSnapshot>` (cached 5 min; `INVALID_FIELD` on `Lead_Manager__c` → owner-only + one warn); `WorkerDeps.ownership: (userId, recordId) => Promise<OwnershipSnapshot>`; `POST /calls` response gains `taskAllowed: boolean`; `GET /calls` rows gain `syncError: string | null`.

- [ ] **Step 1: Failing tests** — `ownership.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { callerMayCreateTaskOn, objectTypeForId } from './ownership.js';

describe('objectTypeForId', () => {
  it('maps standard key prefixes; custom objects are "other"', () => {
    expect(objectTypeForId('00Q000000000001AAA')).toBe('Lead');
    expect(objectTypeForId('003000000000001')).toBe('Contact');
    expect(objectTypeForId('006000000000001')).toBe('Opportunity');
    expect(objectTypeForId('00T000000000001')).toBe('Task');
    expect(objectTypeForId('a0B000000000001')).toBe('other');
  });
});

describe('callerMayCreateTaskOn', () => {
  const me = '005ME';
  it('Lead / Contact: owner only', () => {
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: '005X' }, me)).toBe(false);
    expect(callerMayCreateTaskOn({ type: 'Contact', ownerId: me }, me)).toBe(true);
  });
  it('Opportunity: owner OR Lead_Manager__c', () => {
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: '005X', leadManagerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: me, leadManagerId: null }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: '005X', leadManagerId: '005Y' }, me)).toBe(false);
  });
  it('Task: the assignee', () => {
    expect(callerMayCreateTaskOn({ type: 'Task', ownerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Task', ownerId: '005X' }, me)).toBe(false);
  });
  it('objects the rule does not name are allowed', () => {
    expect(callerMayCreateTaskOn({ type: 'other', ownerId: '005X' }, me)).toBe(true);
  });
});
```

`followup-worker.test.ts` — `deps()` gains `ownership: vi.fn(async () => ({ type: 'Lead', ownerId: '005' }))` (the fixture owner); add:

```ts
  it('does not create the copy on a record the rep neither owns nor manages (not-owner), leaves the source open', async () => {
    const d = deps({ ownership: vi.fn(async () => ({ type: 'Opportunity', ownerId: '005X', leadManagerId: '005Y' })) });
    await processRolloverJob(job(), d);
    expect(d.sf.sfFetch).not.toHaveBeenCalled();
    expect(d.db._writes).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', lastError: 'not-owner' }) });
  });
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement** — `ownership.ts`:

```ts
import { soqlEscape, soqlQuery } from './client.js';

export type OwnedObject = 'Lead' | 'Contact' | 'Opportunity' | 'Task';
export interface OwnershipSnapshot { type: OwnedObject | 'other'; ownerId: string | null; leadManagerId?: string | null }

export function objectTypeForId(id: string): OwnedObject | 'other' {
  const p = id.slice(0, 3);
  return p === '00Q' ? 'Lead' : p === '003' ? 'Contact' : p === '006' ? 'Opportunity' : p === '00T' ? 'Task' : 'other';
}

/** The rule: Lead/Contact/Task → owner; Opportunity → owner OR Lead_Manager__c; unnamed objects → allowed. */
export function callerMayCreateTaskOn(s: OwnershipSnapshot, callerSfUserId: string): boolean {
  if (s.type === 'other') return true;
  if (s.ownerId === callerSfUserId) return true;
  return s.type === 'Opportunity' && !!s.leadManagerId && s.leadManagerId === callerSfUserId;
}

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; snap: OwnershipSnapshot }>();
let warnedLeadManager = false;

export async function fetchOwnership(userId: string, recordId: string): Promise<OwnershipSnapshot> {
  const hit = cache.get(recordId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.snap;
  const type = objectTypeForId(recordId);
  let snap: OwnershipSnapshot;
  if (type === 'other') snap = { type, ownerId: null };
  else if (type === 'Opportunity') {
    try {
      const r = await soqlQuery<{ OwnerId: string; Lead_Manager__c?: string | null }>(userId, `SELECT OwnerId, Lead_Manager__c FROM Opportunity WHERE Id = '${soqlEscape(recordId)}' LIMIT 1`);
      snap = { type, ownerId: r[0]?.OwnerId ?? null, leadManagerId: r[0]?.Lead_Manager__c ?? null };
    } catch (err) {
      if (!/INVALID_FIELD/.test((err as Error).message)) throw err;
      if (!warnedLeadManager) { warnedLeadManager = true; console.warn('[ownership] Lead_Manager__c not found on Opportunity — gate is owner-only'); }
      const r = await soqlQuery<{ OwnerId: string }>(userId, `SELECT OwnerId FROM Opportunity WHERE Id = '${soqlEscape(recordId)}' LIMIT 1`);
      snap = { type, ownerId: r[0]?.OwnerId ?? null, leadManagerId: null };
    }
  } else {
    const r = await soqlQuery<{ OwnerId: string }>(userId, `SELECT OwnerId FROM ${type} WHERE Id = '${soqlEscape(recordId)}' LIMIT 1`);
    snap = { type, ownerId: r[0]?.OwnerId ?? null };
  }
  cache.set(recordId, { at: Date.now(), snap });
  return snap;
}
```

`followup-worker.ts`: `WorkerDeps.ownership`; in `processRolloverJob` after `task` is resolved and before the calendar fetch: `if (!callerMayCreateTaskOn(await withTimeout(deps.ownership(job.userId, job.recordId), SF_CALL_TIMEOUT_MS, 'ownership'), job.sfOwnerId)) { await patchJob(deps, job.id, { status: 'succeeded', lastError: 'not-owner', completedAt: deps.now() }); return; }`. `liveDeps`: `ownership: fetchOwnership`.

`sync.ts` `syncOne`: after `whoId`/`whatId` are resolved and before `createCallTask`, add:

```ts
  // Ownership gate: never write a Task on a record the caller doesn't own/manage.
  // The call stays fully logged in the CTI; the job records why no Task exists.
  const targetId = whoId ?? whatId;
  if (targetId) {
    const me = await salesforceUserId(call.userId);
    if (!callerMayCreateTaskOn(await fetchOwnership(call.userId, targetId), me)) return { skipped: 'not-owner' as const };
  }
```

Change `syncOne` to return `Promise<{ skipped?: 'not-owner' } | void>` and in the tick, when it returns `{ skipped }`, mark the job `succeeded` with `lastError: skipped` (the existing success write gains `lastError`). Import `salesforceUserId` from `./current-user.js`.

`routes/calls.ts` `POST /calls`: after the row is created, compute `const taskAllowed = parsed.data.recipientRecordId ? callerMayCreateTaskOn(await fetchOwnership(session.userId, parsed.data.recipientRecordId), await salesforceUserId(session.userId)).catch(() => true) : true;` — wrap the two awaits in a try/catch that defaults to `true` (a lookup failure must not block dialing; the server-side sync gate still applies later). Return `{ call: row, taskAllowed }`. `GET /calls`: after fetching rows, query `salesforceSyncJobs` for those call ids and map `syncError: job?.lastError ?? null` onto each row.

- [ ] **Step 4: Verify + commit** — `npm test && npm run typecheck` → PASS.
```bash
git add services/cti-api/src/salesforce/ownership.ts services/cti-api/src/salesforce/ownership.test.ts services/cti-api/src/salesforce/followup-worker.ts services/cti-api/src/salesforce/followup-worker.test.ts services/cti-api/src/salesforce/sync.ts services/cti-api/src/routes/calls.ts
git commit -m "feat(cti-api): ownership gate for rollover copies and after-call tasks; taskAllowed on POST /calls"
```

---

### Task 7: Client — Tasks toggle, from-number on the card, `taskAllowed`, Recents label

**Files:**
- Modify: `apps/cti-web/src/dialer-api.ts`, `apps/cti-web/src/components/DialerPanel.tsx` (+test), `apps/cti-web/src/App.tsx`, `apps/cti-web/src/components/RecentCalls.tsx`, `apps/cti-web/src/api.ts` only if a type lives there

**Interfaces:**
- Consumes: `taskAllowed` on `POST /calls`; `syncError` on `GET /calls` rows; `fromNumber` on `currentItem`.
- Produces: `DialerObjectType = 'Lead' | 'Opportunity' | 'Task'`; `OBJECT_LABELS`; `recentSyncLabel(row): 'Synced' | 'Local' | 'Not synced · not owner'` (pure).

- [ ] **Step 1: Failing tests** — append to `DialerPanel.test.tsx`:

```tsx
describe('Tasks in the picker', () => {
  it('offers Leads, Opportunities, and Tasks', () => {
    const html = renderToStaticMarkup(<DialerPanel sessionId={null} onScreenPop={() => {}} onStartFromListView={async () => {}} onStart={() => {}} onStop={() => {}} onComplete={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('Tasks');
  });
});
```

Create `apps/cti-web/src/components/RecentCalls.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { recentSyncLabel } from './RecentCalls';
describe('recentSyncLabel', () => {
  it('explains a gated call instead of a bare "Local"', () => {
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: 'not-owner' })).toBe('Not synced · not owner');
    expect(recentSyncLabel({ salesforceTaskId: '00T1', syncError: null })).toBe('Synced');
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: null })).toBe('Local');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/cti-web && npx vitest run src/components/DialerPanel.test.tsx src/components/RecentCalls.test.tsx` → FAIL.

- [ ] **Step 3: Implement**
- `dialer-api.ts`: `export type DialerObjectType = 'Lead' | 'Opportunity' | 'Task';` `export const OBJECT_LABELS: Record<DialerObjectType, string> = { Lead: 'Leads', Opportunity: 'Opportunities', Task: 'Tasks' };` `DialerCurrentItem` gains `fromNumber?: string | null`.
- `DialerPanel.tsx` picker: `(['Lead', 'Opportunity', 'Task'] as const).map(...)` with `{OBJECT_LABELS[o]}`; the empty hint uses `OBJECT_LABELS[object]`. `CurrentRecord`: after the meta line add `{item.fromNumber && <div className="dp-current-from">from {formatE164(item.fromNumber)}</div>}` and append `.dp-current-from { font-size: 11px; color: var(--text-muted); margin-top: 2px; }` to `styles.css`.
- `App.tsx`: `ActiveCall` gains `taskAllowed?: boolean`; in `place()` the `api<{ call: … }>` call for `POST /calls` types `taskAllowed?: boolean` and `setActive({ …, taskAllowed: created.taskAllowed ?? true })`; in `submitDisposition` the Open CTI write condition becomes `if (active.recordId && active.taskAllowed !== false && !openCtiTaskWrittenRef.current)`.
- `RecentCalls.tsx`: `CallRow` gains `syncError: string | null`; export `recentSyncLabel`; the right-hand span renders it (`className` `sync ok` for Synced, `sync warn` for the gated label, `sync` otherwise); add `.sync.warn { color: var(--warn); }` to `styles.css`.

- [ ] **Step 4: Verify + commit** — `npm test && npm run typecheck && npm run build` → PASS.
```bash
git add apps/cti-web/src/dialer-api.ts apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/components/DialerPanel.test.tsx apps/cti-web/src/components/RecentCalls.tsx apps/cti-web/src/components/RecentCalls.test.tsx apps/cti-web/src/App.tsx apps/cti-web/src/styles.css
git commit -m "feat(cti-web): Tasks in the power-dial picker; from-number on the card; honor taskAllowed; explain gated Recents"
```

---

### Task 8: Deploy + live verification

- [ ] Merge/push `main`; confirm `/healthz` 200 and the new `/cti/` bundle; `select column_name from information_schema.columns where table_name='dialer_queue_items' and column_name in ('task_id','followup_eligible')` → 2 rows; `… table_name='followup_rollover_jobs' and column_name='source_task_id'` → 1.
- [ ] Put follow-up tasks owned by Evren on the three **CTI DIAL TEST** opps + one titled "Check in"; create a Task list view covering them; Power Dial it from the **Tasks** toggle. Expect: calls from Evren's **agent** numbers (check `dialer_queue_items.from_number` ∉ the pool DIDs) rotating across them; "Attempt 2 of 2" after the 5-min floor; three jobs `succeeded` with `source_task_id` set and the copies created; "Check in" dialed twice, untouched; the card shows "from (213) …".
- [ ] Dial a lead owned by another rep via click-to-dial: `GET /calls` row shows `syncError: 'not-owner'`, Recents reads "Not synced · not owner", no Salesforce Task on the lead.
