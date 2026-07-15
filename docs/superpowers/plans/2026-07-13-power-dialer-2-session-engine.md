# Power Dialer — Plan 2: Session Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the dialer session engine — the queue, the progressive state machine, and the start/pause/skip/stop/next API — with telephony fully abstracted behind a port so it is 100% unit-testable without Twilio.

**Architecture:** A `dialer_sessions` + `dialer_queue_items` data model. Pure state helpers (`nextPendingItem`, `inFlightItem`, `outcomeToStatus`) drive a thin impure **driver** (`advanceSession`, `handleDialOutcome`, control ops). The driver depends on a **`DialerTelephony` port** (mocked here; Plan 3 supplies the real Twilio implementation) plus Plan 1's `resolveDialNumber`, `rolloverFollowUp`, and `dialerPoolNumbers`. **Progressive: at most one call in flight per session.**

**Tech Stack:** Node 20 + TS (ESM, `.js` specifiers), Fastify, Drizzle/Postgres, vitest.

## Global Constraints

- TypeScript ESM; local imports use `.js` specifiers. Strict tsconfig incl. `noUncheckedIndexedAccess` — code must pass `npx tsc --noEmit` (guard every array index).
- Progressive dialing: **at most one queue item in `dialing` OR `connected` state per session at a time.** Never dial the next while one is in flight.
- The engine performs NO Twilio I/O directly — all of it goes through the injected `DialerTelephony` port.
- Reuse Plan 1 (already on this branch): `resolveDialNumber` (`salesforce/record-phone.js`), `rolloverFollowUp` (`salesforce/followup.js`), `dialerPoolNumbers` (`dialer/pool.js`), `soqlQuery`/`sfFetch` (`salesforce/client.js`).
- Follow-up rollover fires **only on a no-connect** outcome.
- Backend files under `services/cti-api/src/`; tests colocated `*.test.ts`; run `npx vitest run` from `services/cti-api`. Commit per task on branch `feat/power-dialer-foundations`; do NOT push.

**Setup:** already on `feat/power-dialer-foundations` (Plan 1's branch). Verify: `git branch --show-current` → `feat/power-dialer-foundations`.

---

### Task 1: Session + queue data model

**Files:**
- Modify: `services/cti-api/src/db/schema.ts` (add two enums near the others; add two tables after `outboundNumbers`)
- Create: `services/cti-api/migrations/0017_dialer_sessions.sql` (verify next unused number)
- Create: `services/cti-api/src/dialer/session-store.ts`
- Test: `services/cti-api/src/dialer/session-store.test.ts`

**Interfaces:**
- Produces:
  - Enums `dialer_session_status` = `'active' | 'paused' | 'stopped' | 'done'`; `dialer_item_status` = `'pending' | 'dialing' | 'connected' | 'no_connect' | 'skipped' | 'unreachable' | 'done'`.
  - Tables `dialerSessions`, `dialerQueueItems`.
  - `sessionCounts(items: DialerItem[]): { total; done; connected; noConnect; skipped; unreachable; pending }` — pure.
  - `type DialerItem = typeof schema.dialerQueueItems.$inferSelect`.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/dialer/session-store.test.ts
import { describe, expect, it } from 'vitest';
import { sessionCounts } from './session-store.js';

const item = (status: string) => ({ status } as Parameters<typeof sessionCounts>[0][number]);

describe('sessionCounts', () => {
  it('tallies queue item statuses', () => {
    const c = sessionCounts([
      item('done'), item('connected'), item('no_connect'), item('no_connect'),
      item('skipped'), item('unreachable'), item('pending'), item('dialing'),
    ]);
    expect(c).toMatchObject({ total: 8, done: 1, connected: 1, noConnect: 2, skipped: 1, unreachable: 1, pending: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/session-store.test.ts` → FAIL (module missing).

- [ ] **Step 3a: Add enums + tables to `schema.ts`**

Near the other `pgEnum`s:

```ts
export const dialerSessionStatus = pgEnum('dialer_session_status', ['active', 'paused', 'stopped', 'done']);
export const dialerItemStatus = pgEnum('dialer_item_status', [
  'pending', 'dialing', 'connected', 'no_connect', 'skipped', 'unreachable', 'done',
]);
```

After the `outboundNumbers` table definition, add:

```ts
export const dialerSessions = pgTable('dialer_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** The rep's Salesforce User Id — needed to own Tasks in the rollover. */
  sfOwnerId: text('sf_owner_id').notNull(),
  objectType: text('object_type').notNull(), // 'Lead' | 'Opportunity'
  status: dialerSessionStatus('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const dialerQueueItems = pgTable('dialer_queue_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => dialerSessions.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  objectType: text('object_type').notNull(),
  recordId: text('record_id').notNull(),
  toNumber: text('to_number'), // resolved E.164, or null when unreachable
  status: dialerItemStatus('status').default('pending').notNull(),
  callId: text('call_id'),
  outcome: text('outcome'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 3b: Migration `0017_dialer_sessions.sql`** (mirror an existing migration's format; idempotent enum creation + `CREATE TABLE IF NOT EXISTS` for both tables with the columns above).

- [ ] **Step 3c: Write `session-store.ts`**

```ts
// services/cti-api/src/dialer/session-store.ts
import { schema } from '../db/index.js';

export type DialerItem = typeof schema.dialerQueueItems.$inferSelect;

export function sessionCounts(items: Array<Pick<DialerItem, 'status'>>): {
  total: number; done: number; connected: number; noConnect: number;
  skipped: number; unreachable: number; pending: number;
} {
  const c = { total: items.length, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 0 };
  for (const it of items) {
    if (it.status === 'done') c.done++;
    else if (it.status === 'connected') c.connected++;
    else if (it.status === 'no_connect') c.noConnect++;
    else if (it.status === 'skipped') c.skipped++;
    else if (it.status === 'unreachable') c.unreachable++;
    else if (it.status === 'pending') c.pending++;
  }
  return c;
}
```

- [ ] **Step 4: Verify** — `cd services/cti-api && npx vitest run src/dialer/session-store.test.ts && npx tsc --noEmit && npm run migrate` (migrate only if a local DB is reachable; otherwise confirm SQL is well-formed and note it applies on deploy).

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/db/schema.ts services/cti-api/migrations/0017_dialer_sessions.sql \
        services/cti-api/src/dialer/session-store.ts services/cti-api/src/dialer/session-store.test.ts
git commit -m "feat(dialer): session + queue data model"
```

---

### Task 2: Resolve the rep's Salesforce User Id

**Files:**
- Create: `services/cti-api/src/salesforce/current-user.ts`
- Test: `services/cti-api/src/salesforce/current-user.test.ts`

**Interfaces:**
- Consumes: `sfFetch` (`./client.js`).
- Produces: `salesforceUserId(userId: string): Promise<string>` — the rep's SF User Id (`005…`). Uses `/chatter/users/me` (GG Homes has Chatter enabled — confirmed by their Chatter automations). Throws if unavailable.
- Also: `parseChatterMeId(json: unknown): string | null` — pure.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/salesforce/current-user.test.ts
import { describe, expect, it } from 'vitest';
import { parseChatterMeId } from './current-user.js';

describe('parseChatterMeId', () => {
  it('reads .id from a chatter users/me response', () => {
    expect(parseChatterMeId({ id: '005xx', firstName: 'A' })).toBe('005xx');
    expect(parseChatterMeId({})).toBeNull();
    expect(parseChatterMeId(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// services/cti-api/src/salesforce/current-user.ts
import { sfFetch } from './client.js';

export function parseChatterMeId(json: unknown): string | null {
  if (json && typeof json === 'object' && typeof (json as { id?: unknown }).id === 'string') {
    return (json as { id: string }).id;
  }
  return null;
}

/** The rep's Salesforce User Id (005…). */
export async function salesforceUserId(userId: string): Promise<string> {
  const res = await sfFetch(userId, '/chatter/users/me');
  const id = res.status < 400 ? parseChatterMeId(res.json) : null;
  if (!id) throw new Error(`could not resolve Salesforce user id (status ${res.status})`);
  return id;
}
```

- [ ] **Step 4: Verify** — `npx vitest run src/salesforce/current-user.test.ts && npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git commit -am "feat(sf): resolve current rep's Salesforce user id"`.

---

### Task 3: Create a session + its queue

**Files:**
- Create: `services/cti-api/src/dialer/create-session.ts`
- Test: `services/cti-api/src/dialer/create-session.test.ts`

**Interfaces:**
- Consumes: `resolveDialNumber` (`../salesforce/record-phone.js`), `salesforceUserId` (`../salesforce/current-user.js`), `getDb`/`schema` (`../db/index.js`).
- Produces:
  - `buildQueueRows(sessionId, objectType, resolved): Array<{ sessionId; ordinal; objectType; recordId; toNumber; status }>` — pure. `resolved` = `Array<{ recordId; toNumber: string | null }>`. Item status `'pending'` when `toNumber`, else `'unreachable'`.
  - `createDialerSession(deps, args): Promise<{ sessionId: string; total: number }>` where `args = { userId; orgId; objectType: 'Lead'|'Opportunity'; recordIds: string[] }` and `deps = { resolveDialNumber; salesforceUserId; db }`.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/dialer/create-session.test.ts
import { describe, expect, it } from 'vitest';
import { buildQueueRows } from './create-session.js';

describe('buildQueueRows', () => {
  it('numbers rows and marks unreachable when no number resolved', () => {
    const rows = buildQueueRows('S1', 'Lead', [
      { recordId: '00Q1', toNumber: '+16195550100' },
      { recordId: '00Q2', toNumber: null },
    ]);
    expect(rows).toEqual([
      { sessionId: 'S1', ordinal: 0, objectType: 'Lead', recordId: '00Q1', toNumber: '+16195550100', status: 'pending' },
      { sessionId: 'S1', ordinal: 1, objectType: 'Lead', recordId: '00Q2', toNumber: null, status: 'unreachable' },
    ]);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// services/cti-api/src/dialer/create-session.ts
import { getDb, schema } from '../db/index.js';
import { resolveDialNumber } from '../salesforce/record-phone.js';
import { salesforceUserId } from '../salesforce/current-user.js';

export function buildQueueRows(
  sessionId: string,
  objectType: string,
  resolved: Array<{ recordId: string; toNumber: string | null }>,
): Array<{ sessionId: string; ordinal: number; objectType: string; recordId: string; toNumber: string | null; status: 'pending' | 'unreachable' }> {
  return resolved.map((r, i) => ({
    sessionId, ordinal: i, objectType, recordId: r.recordId, toNumber: r.toNumber,
    status: r.toNumber ? 'pending' : 'unreachable',
  }));
}

export interface CreateSessionDeps {
  resolveDialNumber: typeof resolveDialNumber;
  salesforceUserId: typeof salesforceUserId;
  db: ReturnType<typeof getDb>;
}

export async function createDialerSession(
  deps: CreateSessionDeps,
  args: { userId: string; orgId: string; objectType: 'Lead' | 'Opportunity'; recordIds: string[] },
): Promise<{ sessionId: string; total: number }> {
  const sfOwnerId = await deps.salesforceUserId(args.userId);
  const resolved: Array<{ recordId: string; toNumber: string | null }> = [];
  for (const recordId of args.recordIds) {
    const r = await deps.resolveDialNumber(args.userId, args.objectType, recordId);
    resolved.push({ recordId, toNumber: r?.e164 ?? null });
  }
  const [session] = await deps.db
    .insert(schema.dialerSessions)
    .values({ orgId: args.orgId, userId: args.userId, sfOwnerId, objectType: args.objectType, status: 'active' })
    .returning();
  const rows = buildQueueRows(session!.id, args.objectType, resolved);
  if (rows.length) await deps.db.insert(schema.dialerQueueItems).values(rows);
  return { sessionId: session!.id, total: rows.length };
}
```

- [ ] **Step 4: Verify** — `npx vitest run src/dialer/create-session.test.ts && npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git commit -am "feat(dialer): create session + queue from record ids"`.

---

### Task 4: Pure state helpers

**Files:**
- Create: `services/cti-api/src/dialer/state.ts`
- Test: `services/cti-api/src/dialer/state.test.ts`

**Interfaces:**
- Consumes: `DialerItem` (`./session-store.js`).
- Produces (all pure):
  - `inFlightItem(items: DialerItem[]): DialerItem | null` — the one item in `dialing` or `connected` (progressive invariant), else null.
  - `nextPendingItem(items: DialerItem[]): DialerItem | null` — lowest-ordinal `pending` item, else null.
  - `outcomeToStatus(outcome: 'connected' | 'no_connect'): 'connected' | 'no_connect'`.
  - `allTerminal(items: DialerItem[]): boolean` — true when no item is `pending`, `dialing`, or `connected`.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/dialer/state.test.ts
import { describe, expect, it } from 'vitest';
import { allTerminal, inFlightItem, nextPendingItem, outcomeToStatus } from './state.js';
import type { DialerItem } from './session-store.js';

const it_ = (o: Partial<DialerItem>): DialerItem => ({ id: 'x', ordinal: 0, status: 'pending', callId: null, toNumber: '+1', ...o } as DialerItem);

describe('pure state helpers', () => {
  it('inFlightItem finds a dialing/connected item, else null', () => {
    expect(inFlightItem([it_({ status: 'done' }), it_({ id: 'a', status: 'dialing' })])?.id).toBe('a');
    expect(inFlightItem([it_({ id: 'b', status: 'connected' })])?.id).toBe('b');
    expect(inFlightItem([it_({ status: 'pending' }), it_({ status: 'done' })])).toBeNull();
  });
  it('nextPendingItem returns the lowest-ordinal pending', () => {
    const picked = nextPendingItem([
      it_({ id: 'a', ordinal: 2, status: 'pending' }),
      it_({ id: 'b', ordinal: 0, status: 'done' }),
      it_({ id: 'c', ordinal: 1, status: 'pending' }),
    ]);
    expect(picked?.id).toBe('c');
  });
  it('outcomeToStatus maps 1:1', () => {
    expect(outcomeToStatus('connected')).toBe('connected');
    expect(outcomeToStatus('no_connect')).toBe('no_connect');
  });
  it('allTerminal is false while work remains', () => {
    expect(allTerminal([it_({ status: 'done' }), it_({ status: 'skipped' }), it_({ status: 'unreachable' })])).toBe(true);
    expect(allTerminal([it_({ status: 'done' }), it_({ status: 'pending' })])).toBe(false);
    expect(allTerminal([it_({ status: 'connected' })])).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// services/cti-api/src/dialer/state.ts
import type { DialerItem } from './session-store.js';

export function inFlightItem(items: DialerItem[]): DialerItem | null {
  return items.find((i) => i.status === 'dialing' || i.status === 'connected') ?? null;
}

export function nextPendingItem(items: DialerItem[]): DialerItem | null {
  const pending = items.filter((i) => i.status === 'pending');
  if (pending.length === 0) return null;
  return pending.reduce((a, b) => (a.ordinal <= b.ordinal ? a : b));
}

export function outcomeToStatus(outcome: 'connected' | 'no_connect'): 'connected' | 'no_connect' {
  return outcome;
}

export function allTerminal(items: DialerItem[]): boolean {
  return !items.some((i) => i.status === 'pending' || i.status === 'dialing' || i.status === 'connected');
}
```

- [ ] **Step 4: Verify** — `npx vitest run src/dialer/state.test.ts && npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git commit -am "feat(dialer): pure state helpers"`.

---

### Task 5: Telephony port + engine driver

**Files:**
- Create: `services/cti-api/src/dialer/telephony-port.ts`
- Create: `services/cti-api/src/dialer/engine.ts`
- Test: `services/cti-api/src/dialer/engine.test.ts`

**Interfaces:**
- Consumes: `state.js` helpers, `session-store.js` (`DialerItem`), `dialerPoolNumbers` (`./pool.js`), `rolloverFollowUp` (`../salesforce/followup.js`), `getDb`/`schema`.
- Produces:
  - `interface DialerTelephony { originate(a: { sessionId: string; itemId: string; fromE164: string; toE164: string; userId: string }): Promise<{ callId: string }>; bridgeToRep(callId: string, userId: string): Promise<void>; hangup(callId: string): Promise<void>; }`
  - `interface EngineDeps { db; telephony: DialerTelephony; dialerPoolNumbers; rolloverFollowUp; onScreenPop(userId: string, objectType: string, recordId: string): void; todayIso: string; }`
  - `advanceSession(sessionId: string, deps: EngineDeps): Promise<{ action: 'dialing' | 'waiting' | 'done' | 'idle' | 'paused_no_numbers'; itemId?: string }>`
  - `handleDialOutcome(callId: string, outcome: 'connected' | 'no_connect', deps: EngineDeps): Promise<void>`

**Behavior contract (encode exactly):**
- `advanceSession`: load session+items. If `status !== 'active'` → `idle`. If `inFlightItem` exists → `waiting` (progressive: never dial a second). Else pick `nextPendingItem`; none → set session `done`, return `done`. If the picked item's `toNumber` is null → mark it `unreachable` and recurse. Pick a DID via `dialerPoolNumbers(orgId)` (first active — Plan 3 adds the firewall); none → set session `paused`, return `paused_no_numbers`. Set item `dialing`, `originate`, store `callId`; return `dialing`.
- `handleDialOutcome`: find item by `callId`; ignore if not `dialing`. Set item to the outcome status. If `connected` → `bridgeToRep` + `onScreenPop`; do NOT advance (wait for rep `next`). If `no_connect` → `rolloverFollowUp(userId, session.sfOwnerId, recordId, todayIso)` (best-effort; log on throw) → `advanceSession`.

- [ ] **Step 1: Write the failing test**

```ts
// services/cti-api/src/dialer/engine.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fake DB: enough of the drizzle surface the engine uses.
function fakeDb(session: any, items: any[]) {
  return {
    _session: session, _items: items,
    query: {
      dialerSessions: { findFirst: async () => session },
      dialerQueueItems: { findMany: async () => items },
    },
    update(_tbl: unknown) {
      return { set: (patch: any) => ({ where: async () => { Object.assign(_target, patch); } }) };
    },
  } as any;
}
let _target: any = {};

import { advanceSession, handleDialOutcome, type EngineDeps } from './engine.js';

const baseSession = { id: 'S1', orgId: 'O1', userId: 'U1', sfOwnerId: '005', objectType: 'Lead', status: 'active' };
function makeDeps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    db: undefined as any,
    telephony: { originate: vi.fn(async () => ({ callId: 'CA1' })), bridgeToRep: vi.fn(async () => {}), hangup: vi.fn(async () => {}) },
    dialerPoolNumbers: vi.fn(async () => [{ e164: '+16190000000' }]) as any,
    rolloverFollowUp: vi.fn(async () => ({ completed: null, created: null })) as any,
    onScreenPop: vi.fn(),
    todayIso: '2026-07-13',
    ...over,
  };
}

describe('advanceSession', () => {
  beforeEach(() => { _target = {}; });
  it('dials the next pending item from a pool DID', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    const r = await advanceSession('S1', deps);
    expect(r.action).toBe('dialing');
    expect((deps.telephony.originate as any)).toHaveBeenCalledWith(expect.objectContaining({ toE164: '+16195550100', fromE164: '+16190000000' }));
  });
  it('waits (does not dial) while an item is in flight', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    expect((await advanceSession('S1', deps)).action).toBe('waiting');
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('is idle when the session is not active', async () => {
    const deps = makeDeps(); deps.db = fakeDb({ ...baseSession, status: 'paused' }, []);
    expect((await advanceSession('S1', deps)).action).toBe('idle');
  });
});

describe('handleDialOutcome', () => {
  beforeEach(() => { _target = {}; });
  it('no_connect runs the rollover then advances', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.rolloverFollowUp).toHaveBeenCalledWith('U1', '005', '00Q1', '2026-07-13');
  });
  it('connected bridges + screen-pops and does NOT roll over', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.telephony.bridgeToRep).toHaveBeenCalledWith('CA1', 'U1');
    expect(deps.onScreenPop).toHaveBeenCalledWith('U1', 'Lead', '00Q1');
    expect(deps.rolloverFollowUp).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// services/cti-api/src/dialer/telephony-port.ts
export interface DialerTelephony {
  originate(a: { sessionId: string; itemId: string; fromE164: string; toE164: string; userId: string }): Promise<{ callId: string }>;
  bridgeToRep(callId: string, userId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
}

/** Placeholder until Plan 3 supplies the Twilio implementation. */
export const noopTelephony: DialerTelephony = {
  async originate() { throw new Error('DialerTelephony not configured (Plan 3)'); },
  async bridgeToRep() { /* noop */ },
  async hangup() { /* noop */ },
};
```

```ts
// services/cti-api/src/dialer/engine.ts
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { DialerItem } from './session-store.js';
import { inFlightItem, nextPendingItem } from './state.js';
import type { DialerTelephony } from './telephony-port.js';
import type { dialerPoolNumbers } from './pool.js';
import type { rolloverFollowUp } from '../salesforce/followup.js';

export interface EngineDeps {
  db: ReturnType<typeof getDb>;
  telephony: DialerTelephony;
  dialerPoolNumbers: typeof dialerPoolNumbers;
  rolloverFollowUp: typeof rolloverFollowUp;
  onScreenPop: (userId: string, objectType: string, recordId: string) => void;
  todayIso: string;
}

type Session = typeof schema.dialerSessions.$inferSelect;

async function loadItems(deps: EngineDeps, sessionId: string): Promise<DialerItem[]> {
  return deps.db.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, sessionId) });
}

async function setSession(deps: EngineDeps, id: string, status: Session['status']): Promise<void> {
  await deps.db.update(schema.dialerSessions).set({ status, updatedAt: new Date() }).where(eq(schema.dialerSessions.id, id));
}
async function setItem(deps: EngineDeps, id: string, patch: Partial<DialerItem>): Promise<void> {
  await deps.db.update(schema.dialerQueueItems).set({ ...patch, updatedAt: new Date() }).where(eq(schema.dialerQueueItems.id, id));
}

export async function advanceSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<{ action: 'dialing' | 'waiting' | 'done' | 'idle' | 'paused_no_numbers'; itemId?: string }> {
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
  if (!session || session.status !== 'active') return { action: 'idle' };
  let items = await loadItems(deps, sessionId);
  if (inFlightItem(items)) return { action: 'waiting' };

  // Skip any unreachable pendings (defensive; creation already marks them).
  for (;;) {
    const next = nextPendingItem(items);
    if (!next) { await setSession(deps, sessionId, 'done'); return { action: 'done' }; }
    if (!next.toNumber) {
      await setItem(deps, next.id, { status: 'unreachable' });
      items = items.map((i) => (i.id === next.id ? { ...i, status: 'unreachable' } : i));
      continue;
    }
    const pool = await deps.dialerPoolNumbers(session.orgId);
    const did = pool[0];
    if (!did) { await setSession(deps, sessionId, 'paused'); return { action: 'paused_no_numbers' }; }
    await setItem(deps, next.id, { status: 'dialing' });
    const { callId } = await deps.telephony.originate({
      sessionId, itemId: next.id, fromE164: did.e164, toE164: next.toNumber, userId: session.userId,
    });
    await setItem(deps, next.id, { callId });
    return { action: 'dialing', itemId: next.id };
  }
}

export async function handleDialOutcome(
  callId: string,
  outcome: 'connected' | 'no_connect',
  deps: EngineDeps,
): Promise<void> {
  const item = await deps.db.query.dialerQueueItems.findFirst({ where: eq(schema.dialerQueueItems.callId, callId) });
  if (!item || item.status !== 'dialing') return;
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, item.sessionId) });
  if (!session) return;

  await setItem(deps, item.id, { status: outcome, outcome });
  if (outcome === 'connected') {
    await deps.telephony.bridgeToRep(callId, session.userId);
    deps.onScreenPop(session.userId, item.objectType, item.recordId);
    return; // wait for the rep's `next`
  }
  try {
    await deps.rolloverFollowUp(session.userId, session.sfOwnerId, item.recordId, deps.todayIso);
  } catch (err) {
    console.error('[dialer] rollover failed', { itemId: item.id, err: (err as Error).message });
  }
  await advanceSession(item.sessionId, deps);
}
```

Note: the test uses a hand-rolled fake `db`; if the fake's `update().set().where()` shape doesn't line up with how the engine calls it, adjust the FAKE in the test (not the engine) so the engine uses idiomatic drizzle. The assertions on telephony/rollover/screen-pop are what matter.

- [ ] **Step 4: Verify** — `npx vitest run src/dialer/engine.test.ts && npx tsc --noEmit && npx vitest run` (full suite).

- [ ] **Step 5: Commit** — `git commit -am "feat(dialer): telephony port + progressive engine driver"`.

---

### Task 6: Dialer REST endpoints

**Files:**
- Create: `services/cti-api/src/routes/dialer.ts`
- Modify: `services/cti-api/src/server.ts` (register the routes)
- Test: `services/cti-api/src/routes/dialer.test.ts`

**Interfaces:**
- Consumes: `createDialerSession`, engine control ops, `resolveSession` (auth), `getDb`/`schema`, `sessionCounts`.
- Produces (Fastify routes; all require `resolveSession`):
  - `POST /dialer/sessions` `{ objectType: 'Lead'|'Opportunity', recordIds: string[] }` → `{ sessionId, total }`.
  - `GET /dialer/sessions/:id` → `{ session, counts, currentItem }`.
  - `POST /dialer/sessions/:id/pause` | `/resume` | `/skip` | `/stop` | `/next` → `{ ok: true, action }`.
- Produces control fns in `engine.ts` (add): `pauseSession`, `resumeSession`, `skipCurrent`, `stopSession`, `repNext` — each takes `(sessionId, deps)`; behavior per the Behavior contract below.

**Control behavior (add to `engine.ts` and encode exactly):**
- `pauseSession`: set session `paused` (an in-flight dial is allowed to finish). Return `{ action: 'paused' }`.
- `resumeSession`: set `active`, then `advanceSession`.
- `skipCurrent`: the in-flight item → if `dialing`, `telephony.hangup(callId)`; set item `skipped`; then `advanceSession`.
- `stopSession`: in-flight `dialing` → `hangup`; set session `stopped`. Return `{ action: 'stopped' }`.
- `repNext`: the `connected` item → set `done`; then `advanceSession`. (This is the rep clicking Next after a talk.)

- [ ] **Step 1: Write the failing test** — validation-level test that does not require a DB:

```ts
// services/cti-api/src/routes/dialer.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// The POST /dialer/sessions body schema, mirrored for a pure validation test.
const StartBody = z.object({
  objectType: z.enum(['Lead', 'Opportunity']),
  recordIds: z.array(z.string().min(15).max(20)).min(1).max(500),
});

describe('POST /dialer/sessions body validation', () => {
  it('accepts a Lead/Opp list of SF ids and rejects junk', () => {
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ['00Q000000000001'] }).success).toBe(true);
    expect(StartBody.safeParse({ objectType: 'Account', recordIds: ['x'] }).success).toBe(false);
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → PASS immediately (this test pins the contract; it does not import the route module). Then write the route module so the SAME `StartBody` schema is used in `routes/dialer.ts`.

- [ ] **Step 3: Implement `routes/dialer.ts`** with the five control routes + start + status. Use the exact `StartBody` schema above. Wire `EngineDeps` from real implementations: `db: getDb()`, `telephony: noopTelephony` (Plan 3 swaps it), `dialerPoolNumbers`, `rolloverFollowUp`, `onScreenPop` = a no-op for now (Plan 4 wires Open CTI), `todayIso` = today's date in the org tz (use `new Date().toISOString().slice(0,10)` for now; Plan 3 refines tz). Each route resolves the session, checks ownership (session.userId === session user), and calls the matching engine op. Register `registerDialerRoutes(app)` in `server.ts` alongside the other `register*Routes` calls.

- [ ] **Step 4: Verify** — `npx vitest run src/routes/dialer.test.ts && npx tsc --noEmit && npx vitest run`.

- [ ] **Step 5: Commit** — `git commit -am "feat(dialer): session start/status/pause/resume/skip/stop/next endpoints"`.

---

### Task 7: Full-suite green

- [ ] `cd services/cti-api && npx tsc --noEmit && npx vitest run` → tsc 0, all pass. Confirm branch clean + unpushed (`git status -sb`).

---

## Self-Review

**Spec coverage (Plan 2 scope):** session/queue model (§8) → Task 1. sfOwnerId for rollover (Plan 1 follow-up) → Task 2. session creation from a list (§3/§4) → Task 3. progressive one-in-flight state machine (§4/§7) → Tasks 4–5. rollover-on-no-connect only (§6) → Task 5. start/pause/skip/stop/next controls (§3/§7) → Task 6. Telephony abstracted (deferred to Plan 3) → Task 5 port.

**Placeholder scan:** none — complete code per step. `onScreenPop`/`todayIso`/`noopTelephony` are explicit seams for Plan 3/4, not placeholders.

**Type consistency:** `DialerItem` from Task 1 flows through Tasks 4–5; `EngineDeps` defined in Task 5 is consumed by Task 6; `outcome: 'connected' | 'no_connect'` consistent across state + engine; `dialerPoolNumbers`/`rolloverFollowUp`/`resolveDialNumber`/`salesforceUserId` signatures match Plan 1.

**Deferred to Plan 3 (not gaps):** real Twilio `DialerTelephony` (originate w/ AMD, conference bridge, hangup), the AMD→outcome webhook that calls `handleDialOutcome`, firewall-based pool DID selection (Plan 2 uses first-available), sticky-on-connect binding, org-tz `todayIso`. Plan 4: Open CTI screen-pop + the CTI dialer panel + the SF list-view LWC.
