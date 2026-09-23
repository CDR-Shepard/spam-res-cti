# Dialer Cadence & Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the power dialer treat a *person* as the unit of contact — a 3-hour spacing rule, a 3-per-24h legal cap in capped states, a per-day per-owner follow-up rollover, one shared position per list, one number per pass — and give the rep Redial/Resume/End controls and an inbound pop that lands on the Opportunity/Deal/Lead.

**Architecture:** One new read module, `dialer/contact-history` (pure decisions + a live reader over `dialer_dial_attempts` and outbound `calls`), feeds three consumers: the engine's dial-time gate, the miss-path rollover decision (dialer and click-to-dial), and queue creation's preferred-number choice. The engine gains a cross-run claim (per-number advisory lock + in-flight-elsewhere check), loses the immediate Mobile→Phone fallback, and learns two controls (`redial`, `end`) plus a "prospect hung up" stamp. Queue creation records list position and rotates a second run to the shared position. The firewall gains a daily-cap BLOCK. Inbound pop precedence is one pure function.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM (Postgres), vitest; React (cti-web); raw SQL migrations in `packages/db/migrations`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-23-dialer-cadence-and-controls-design.md`. Rulings table there is binding.
- **3 hours** minimum between dials to the same person (power dialer only); the same session's own dials are exempt. Constant name `COOLDOWN_MS = 3 * 60 * 60_000`.
- **3 dials per rolling 24 hours** in capped states `{'FL','OK','WA','MD'}`; every dial by anyone counts (dialer + click-to-dial). Constants `DAILY_DIAL_CAP = 3`, `DAILY_CAP_WINDOW_MS = 24 * 60 * 60_000`.
- Rollover: the **task owner's** second dial of the **org day** (`dialer/org-day.ts`, America/Los_Angeles) to the person ending without a connect. Other reps' dials never count for rollover.
- Skip outcomes (exact strings): `cooldown`, `daily_cap`, `daily_cap_unverified`, `in_progress_elsewhere`. Existing `already_worked` keeps its name (its window becomes 3 h).
- Shared-list window: **12 hours**. Reaper: a `connected` item whose `prospect_ended_at` is older than **10 minutes** is not presence.
- Inbound pop precedence: **Opportunity → Deal → Lead → Contact**, never an Account (`001`).
- Panel copy (exact): skip labels "called in the last 3 h", "daily limit (state law)", "in progress in another run"; card "They hung up"; buttons "Redial", "Resume", "End call", "Next"; confirm line `"{name} is on this list (record {pos} of {total}) — you'll start from {start}."`
- All work in `/Users/cdrshepard/spam-res-cti/.claude/worktrees/callsign-main` on `main` (never the shared checkout). Implementers in harness worktrees run `git merge --ff-only main` FIRST, then `npm install --no-audit --no-fund --prefer-offline` and `for p in auth contracts db firewall phone; do (cd packages/$p && npm run build); done`; rebuild `packages/db` after any schema change.
- TDD: every step's test is written and run RED before the implementation. Rendered SQL is pinned with `new PgDialect().sqlToQuery(...)`. Engine tests assert the ORDER of effects. Never `git stash`, never push, never touch production/Salesforce/Twilio.
- Commits: conventional, small, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Style: WHY comments, pure functions exported for tests, immutable updates, no `any` outside tests, no `console.log` (use `console.warn`/`console.error` like neighbours).

---

## File structure

| File | Responsibility |
|---|---|
| `packages/db/migrations/0042_dialer_cadence.sql` + `packages/db/src/schema.ts` | New columns and indexes (§7 of the spec) |
| `packages/firewall/src/state-calling-rules.ts` | `DAILY_DIAL_CAP_STATES`, `isDailyCapped` |
| `packages/firewall/src/daily-cap.ts` (new) | `dailyDialCount` read + the firewall check helper |
| `packages/firewall/src/evaluate.ts` | daily-cap BLOCK check |
| `services/cti-api/src/dialer/contact-history.ts` (new) | Pure: `Dial`, `Person`, `cadenceVerdict`, `rolloverDue`, `preferredNumber`, constants |
| `services/cti-api/src/dialer/contact-history-live.ts` (new) | `dialsToPerson`, `inFlightElsewhere`, `stampConnected`, `preferredNumbersFor` (batched) |
| `services/cti-api/src/dialer/engine.ts` | gate before `pickDid`; per-number lock; `record_id`/`connected_at`; no fallback; attempt-2 other number; per-day rollover; `prospect_ended_at`; `redialCurrent`, `endCurrent` |
| `services/cti-api/src/dialer/live-deps.ts` | wires the new deps |
| `services/cti-api/src/dialer/already-worked.ts` | 3-hour window |
| `services/cti-api/src/dialer/create-session.ts` | preferred number; `listViewId`/`listPosition`; rotation |
| `services/cti-api/src/dialer/list-position.ts` (new) | pure `rotateAfter`; live `listStartPosition` |
| `services/cti-api/src/routes/dialer.ts` | `redial`/`end` routes; `listContext` in GET |
| `services/cti-api/src/salesforce/sync.ts` | click-to-dial miss → rollover |
| `services/cti-api/src/salesforce/followup-worker.ts` | reaper: hung-up presence rule |
| `services/cti-api/src/salesforce/inbound-pop.ts` (new) + `routes/inbound.ts` + `routes/inbound-caller-params.ts` | pop precedence |
| `apps/cti-web/src/dialer-api.ts`, `components/DialerPanel.tsx` | skip labels, list context, hung-up card, controls |
| `docs/runbooks/dialer-cadence.md` | rules table + SQL checks |

---

### Task 1: Migration 0042 and schema

**Files:**
- Create: `packages/db/migrations/0042_dialer_cadence.sql`
- Create: `packages/db/src/migration-0042.test.ts`
- Modify: `packages/db/src/schema.ts` (`dialerSessions`, `dialerQueueItems`, `dialerDialAttempts`, `calls` indexes)

**Interfaces:**
- Produces columns: `dialerSessions.listViewId: text | null`; `dialerQueueItems.listPosition: integer | null`, `prospectEndedAt: timestamptz | null`, `redialOf: uuid | null`; `dialerDialAttempts.recordId: text | null`, `connectedAt: timestamptz | null`.

- [ ] **Step 1: Write the failing test** (`packages/db/src/migration-0042.test.ts`, mirror `migration-0041.test.ts`):

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { dialerDialAttempts, dialerQueueItems, dialerSessions } from './schema.js';

const sql = readFileSync(resolve(__dirname, '../migrations/0042_dialer_cadence.sql'), 'utf8');

describe('0042_dialer_cadence', () => {
  it('adds every column the cadence rules read, idempotently', () => {
    for (const stmt of [
      'ALTER TABLE dialer_sessions    ADD COLUMN IF NOT EXISTS list_view_id text;',
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS list_position integer;',
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS prospect_ended_at timestamptz;',
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS redial_of uuid;',
      'ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS record_id text;',
      'ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS connected_at timestamptz;',
    ]) expect(sql).toContain(stmt);
  });
  it('adds the two indexes the checks run on', () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS dialer_dial_attempts_record_idx ON dialer_dial_attempts (org_id, record_id, dialed_at);');
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS calls_outbound_target_idx ON calls (org_id, normalized_to_number, created_at) WHERE direction = 'outbound';");
  });
  it('the Drizzle schema matches: nullable, no defaults', () => {
    const s = getTableColumns(dialerSessions); const i = getTableColumns(dialerQueueItems); const a = getTableColumns(dialerDialAttempts);
    expect(s.listViewId.name).toBe('list_view_id'); expect(s.listViewId.notNull).toBe(false);
    expect(i.listPosition.name).toBe('list_position'); expect(i.prospectEndedAt.name).toBe('prospect_ended_at'); expect(i.redialOf.name).toBe('redial_of');
    expect(a.recordId.name).toBe('record_id'); expect(a.connectedAt.name).toBe('connected_at');
    for (const c of [s.listViewId, i.listPosition, i.prospectEndedAt, i.redialOf, a.recordId, a.connectedAt]) { expect(c.notNull).toBe(false); expect(c.hasDefault).toBe(false); }
  });
});
```

- [ ] **Step 2: Run it** — `cd packages/db && npx vitest run src/migration-0042.test.ts` → FAIL (file missing / columns undefined).

- [ ] **Step 3: Write the migration** (`packages/db/migrations/0042_dialer_cadence.sql`):

```sql
-- =============================================================================
-- 0042_dialer_cadence.sql — the person, not the run, as the unit of contact.
--
-- dialer_sessions.list_view_id        which list view a run came from, so a
--                                     second run on the same list starts where
--                                     the first has got to (shared position).
-- dialer_queue_items.list_position    the record's index in that list view at
--                                     pull time — NOT the queue ordinal, which
--                                     rotation changes.
-- dialer_queue_items.prospect_ended_at the prospect hung up on a connected call;
--                                     the rep chooses Redial or Resume.
-- dialer_queue_items.redial_of        the item a rep-requested redial copies.
-- dialer_dial_attempts.record_id      the record dialed (the log was keyed by
--                                     number only); the 3-hour rule matches on
--                                     either.
-- dialer_dial_attempts.connected_at   stamped on a human connect — the number
--                                     that reached the person is the one every
--                                     later run leads with.
-- Both indexes serve the dial-time checks (bounded to 24 h, a few rows each).
-- Nullable throughout; no backfill — the windows are hours, not history.
-- =============================================================================

ALTER TABLE dialer_sessions    ADD COLUMN IF NOT EXISTS list_view_id text;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS list_position integer;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS prospect_ended_at timestamptz;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS redial_of uuid;
ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS record_id text;
ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS connected_at timestamptz;

CREATE INDEX IF NOT EXISTS dialer_dial_attempts_record_idx ON dialer_dial_attempts (org_id, record_id, dialed_at);
CREATE INDEX IF NOT EXISTS calls_outbound_target_idx ON calls (org_id, normalized_to_number, created_at) WHERE direction = 'outbound';
```

- [ ] **Step 4: Schema.** In `packages/db/src/schema.ts` add, with the same comment style as `displayName`:
  - `dialerSessions`: `listViewId: text('list_view_id'),` after `repCallSid`.
  - `dialerQueueItems`: `listPosition: integer('list_position'), prospectEndedAt: timestamp('prospect_ended_at', { withTimezone: true }), redialOf: uuid('redial_of'),` after `displayName`.
  - `dialerDialAttempts`: `recordId: text('record_id'), connectedAt: timestamp('connected_at', { withTimezone: true }),` after `fromNumber`; and in its index block add `recordIdx: index('dialer_dial_attempts_record_idx').on(t.orgId, t.recordId, t.dialedAt),`.
  - `calls` index block: `outboundTargetIdx: index('calls_outbound_target_idx').on(t.orgId, t.normalizedToNumber, t.createdAt).where(sql\`${t.direction} = 'outbound'\`),`.

- [ ] **Step 5: Run** — `cd packages/db && npm run build && npx vitest run` → all pass (16 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0042_dialer_cadence.sql packages/db/src/migration-0042.test.ts packages/db/src/schema.ts
git commit -m "feat(db): 0042 dialer cadence — list position, hung-up stamp, redial link, record/connect on the dial log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Capped states (firewall rules file)

**Files:**
- Modify: `packages/firewall/src/state-calling-rules.ts`
- Test: `packages/firewall/src/state-calling-rules.test.ts` (append)

**Interfaces:**
- Produces: `DAILY_DIAL_CAP_STATES: ReadonlySet<string>`, `DAILY_DIAL_CAP = 3`, `DAILY_CAP_WINDOW_MS`, `isDailyCapped(state: string | null): boolean`.

- [ ] **Step 1: Failing test** (append to `state-calling-rules.test.ts`):

```ts
import { DAILY_DIAL_CAP, DAILY_CAP_WINDOW_MS, DAILY_DIAL_CAP_STATES, isDailyCapped } from './state-calling-rules.js';

describe('daily dial cap (state law: 3 calls per 24 h on the same subject)', () => {
  it('starts with the four states counsel confirmed', () => {
    expect([...DAILY_DIAL_CAP_STATES].sort()).toEqual(['FL', 'MD', 'OK', 'WA']);
  });
  it('is 3 per rolling 24 hours', () => {
    expect(DAILY_DIAL_CAP).toBe(3);
    expect(DAILY_CAP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
  it('isDailyCapped: capped states only; unknown state is NOT capped (the cap is a known law, not a guess)', () => {
    expect(isDailyCapped('FL')).toBe(true);
    expect(isDailyCapped('fl')).toBe(true);
    expect(isDailyCapped('CA')).toBe(false);
    expect(isDailyCapped(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** — `cd packages/firewall && npx vitest run src/state-calling-rules.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement** (append to `state-calling-rules.ts`):

```ts
/**
 * States whose telemarketing law caps calls to the same person at three per
 * 24 hours on the same subject (FL Stat. 501.059, OK Telephone Solicitation
 * Act, WA RCW 80.36, MD Stop the Spam Calls Act). Unanswered calls count.
 * Counsel owns this list; a state is added here and nowhere else.
 */
export const DAILY_DIAL_CAP_STATES: ReadonlySet<string> = new Set(['FL', 'OK', 'WA', 'MD']);
export const DAILY_DIAL_CAP = 3;
/** Rolling, not calendar: a calendar day would allow 3 at 23:00 and 3 more at 01:00. */
export const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Unknown state = not capped: the cap is a known law, not a precaution. */
export function isDailyCapped(state: string | null): boolean {
  return state != null && DAILY_DIAL_CAP_STATES.has(state.toUpperCase());
}
```

- [ ] **Step 4: Run** → PASS. Then `npm run build` in `packages/firewall`.

- [ ] **Step 5: Commit** — `git commit -m "feat(firewall): daily dial cap states — FL, OK, WA, MD at 3 per rolling 24 h" ` (+ trailer).

---

### Task 3: Contact history — pure decisions

**Files:**
- Create: `services/cti-api/src/dialer/contact-history.ts`
- Test: `services/cti-api/src/dialer/contact-history.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Dial { userId: string; sessionId: string | null; toNumber: string; at: Date; connected: boolean; source: 'dialer' | 'manual' }
export interface Person { numbers: readonly string[]; recordId: string | null }
export const COOLDOWN_MS = 3 * 60 * 60_000;
export type CadenceVerdict = 'ok' | 'cooldown' | 'daily_cap';
export function cadenceVerdict(dials: readonly Dial[], now: Date, opts: { sessionId: string; capped: boolean }): CadenceVerdict
export function rolloverDue(dials: readonly Dial[], ownerUserId: string, dayStart: Date): boolean
export function preferredNumber(dials: readonly Dial[], numbers: readonly string[]): string | null
```

- [ ] **Step 1: Failing tests** (`contact-history.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { cadenceVerdict, COOLDOWN_MS, preferredNumber, rolloverDue, type Dial } from './contact-history.js';
import { DAILY_CAP_WINDOW_MS } from '@cti/firewall';

const NOW = new Date('2026-09-23T18:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const dial = (o: Partial<Dial>): Dial => ({ userId: 'rep-1', sessionId: 'S1', toNumber: '+16195550100', at: ago(60_000), connected: false, source: 'dialer', ...o });
const H = 60 * 60_000;

describe('cadenceVerdict — 3 hours between dials to a person, power dialer only', () => {
  it('ok with no history', () => { expect(cadenceVerdict([], NOW, { sessionId: 'S1', capped: false })).toBe('ok'); });
  it('cooldown: another session dialed within 3 h', () => {
    expect(cadenceVerdict([dial({ sessionId: 'S-other', at: ago(3 * H - 1000) })], NOW, { sessionId: 'S1', capped: false })).toBe('cooldown');
  });
  it('ok: another session dialed exactly 3 h ago (boundary is inclusive of the wait)', () => {
    expect(cadenceVerdict([dial({ sessionId: 'S-other', at: ago(3 * H) })], NOW, { sessionId: 'S1', capped: false })).toBe('ok');
  });
  it('cooldown: a manual click-to-dial within 3 h counts', () => {
    expect(cadenceVerdict([dial({ sessionId: null, source: 'manual', at: ago(H) })], NOW, { sessionId: 'S1', capped: false })).toBe('cooldown');
  });
  it("ok: this session's own dial does not count (end-of-run retry, rep's Redial)", () => {
    expect(cadenceVerdict([dial({ sessionId: 'S1', at: ago(60_000) })], NOW, { sessionId: 'S1', capped: false })).toBe('ok');
  });
  it('daily_cap: capped state and 3 dials in 24 h, any rep, any source', () => {
    const d = [dial({ at: ago(23 * H), userId: 'a' }), dial({ at: ago(12 * H), userId: 'b', source: 'manual', sessionId: null }), dial({ at: ago(5 * H), sessionId: 'S1' })];
    expect(cadenceVerdict(d, NOW, { sessionId: 'S1', capped: true })).toBe('daily_cap');
    expect(cadenceVerdict(d, NOW, { sessionId: 'S1', capped: false })).toBe('ok');
  });
  it('daily_cap: a dial exactly 24 h ago has rolled out of the window', () => {
    const d = [dial({ at: ago(DAILY_CAP_WINDOW_MS) }), dial({ at: ago(12 * H) }), dial({ at: ago(5 * H) })];
    expect(cadenceVerdict(d, NOW, { sessionId: 'S1', capped: true })).toBe('ok');
  });
  it('daily_cap wins over cooldown when both apply', () => {
    const d = [dial({ at: ago(10 * H) }), dial({ at: ago(5 * H) }), dial({ sessionId: 'S-other', at: ago(H) })];
    expect(cadenceVerdict(d, NOW, { sessionId: 'S1', capped: true })).toBe('daily_cap');
  });
  it('COOLDOWN_MS is three hours', () => { expect(COOLDOWN_MS).toBe(3 * H); });
});

describe("rolloverDue — the task owner's second miss of the org day", () => {
  const DAY = new Date('2026-09-23T07:00:00Z'); // LA midnight
  it('false with one dial today', () => { expect(rolloverDue([dial({ at: ago(H) })], 'rep-1', DAY)).toBe(false); });
  it('true with two dials today by the owner, neither connected — any source, any session', () => {
    expect(rolloverDue([dial({ at: ago(5 * H), sessionId: 'S-a' }), dial({ at: ago(H), sessionId: null, source: 'manual' })], 'rep-1', DAY)).toBe(true);
  });
  it("false when another rep's dials make up the count", () => {
    expect(rolloverDue([dial({ at: ago(5 * H), userId: 'rep-2' }), dial({ at: ago(H) })], 'rep-1', DAY)).toBe(false);
  });
  it('false when any of the owner\'s dials today connected', () => {
    expect(rolloverDue([dial({ at: ago(5 * H), connected: true }), dial({ at: ago(H) })], 'rep-1', DAY)).toBe(false);
  });
  it("yesterday's dials do not count", () => {
    expect(rolloverDue([dial({ at: new Date(DAY.getTime() - 1000) }), dial({ at: ago(H) })], 'rep-1', DAY)).toBe(false);
  });
});

describe('preferredNumber — the number that reached them', () => {
  it('the most recent connected dial on one of the record\'s numbers', () => {
    const d = [dial({ toNumber: '+16195550100', connected: true, at: ago(48 * H) }), dial({ toNumber: '+12135550199', connected: true, at: ago(2 * H) })];
    expect(preferredNumber(d, ['+16195550100', '+12135550199'])).toBe('+12135550199');
  });
  it('null when nothing connected, or the connect was on a number the record no longer has', () => {
    expect(preferredNumber([dial({ connected: false })], ['+16195550100'])).toBeNull();
    expect(preferredNumber([dial({ toNumber: '+19995550000', connected: true })], ['+16195550100'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run** — `cd services/cti-api && npx vitest run src/dialer/contact-history.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`contact-history.ts`):

```ts
/**
 * Contact history — every dial the company made to a PERSON, and the three
 * decisions the dialer takes from it. Pure; the rows come from
 * contact-history-live.ts (the power-dial log and the click-to-dial call log).
 *
 * A person is the union of a record's numbers and the record itself: a dial to
 * either number, or logged against the record, is a dial to the person.
 */
import { DAILY_CAP_WINDOW_MS, DAILY_DIAL_CAP } from '@cti/firewall';

export interface Dial {
  userId: string;
  /** The power-dial run that made it; null for click-to-dial. */
  sessionId: string | null;
  toNumber: string;
  at: Date;
  connected: boolean;
  source: 'dialer' | 'manual';
}

export interface Person {
  numbers: readonly string[];
  recordId: string | null;
}

/** Courtesy, not law: three hours between dials to the same person. */
export const COOLDOWN_MS = 3 * 60 * 60_000;

export type CadenceVerdict = 'ok' | 'cooldown' | 'daily_cap';

/**
 * May the power dialer dial this person now? `daily_cap` (a law) outranks
 * `cooldown` (a courtesy). The run's OWN dials are exempt from the courtesy —
 * that is the end-of-run retry and the rep's explicit Redial — but never from
 * the cap: every dial by anyone counts toward the law.
 */
export function cadenceVerdict(
  dials: readonly Dial[],
  now: Date,
  opts: { sessionId: string; capped: boolean },
): CadenceVerdict {
  const t = now.getTime();
  if (opts.capped) {
    const inWindow = dials.filter((d) => t - d.at.getTime() < DAILY_CAP_WINDOW_MS).length;
    if (inWindow >= DAILY_DIAL_CAP) return 'daily_cap';
  }
  const recentByOthers = dials.some((d) => d.sessionId !== opts.sessionId && t - d.at.getTime() < COOLDOWN_MS);
  return recentByOthers ? 'cooldown' : 'ok';
}

/**
 * Roll the follow-up forward? The task OWNER has dialed the person at least
 * twice since the org day began, and none of those dials connected. Nobody
 * else's dials count: the task is theirs to work. Runs do not matter: two short
 * runs, a run's retry pass, or a power dial plus a manual call all read alike.
 */
export function rolloverDue(dials: readonly Dial[], ownerUserId: string, dayStart: Date): boolean {
  const own = dials.filter((d) => d.userId === ownerUserId && d.at.getTime() >= dayStart.getTime());
  return own.length >= 2 && own.every((d) => !d.connected);
}

/** The number that most recently reached the person, if it is still one of theirs. */
export function preferredNumber(dials: readonly Dial[], numbers: readonly string[]): string | null {
  const mine = new Set(numbers);
  const connects = dials.filter((d) => d.connected && mine.has(d.toNumber)).sort((a, b) => b.at.getTime() - a.at.getTime());
  return connects[0]?.toNumber ?? null;
}
```

If `@cti/firewall` does not already export `state-calling-rules` symbols from its index, add `export { DAILY_DIAL_CAP, DAILY_CAP_WINDOW_MS, DAILY_DIAL_CAP_STATES, isDailyCapped } from './state-calling-rules.js';` to `packages/firewall/src/index.ts` and rebuild.

- [ ] **Step 4: Run** → PASS (17 tests).
- [ ] **Step 5: Commit** — `feat(dialer): contact-history decisions — cadence verdict, per-day rollover, preferred number`.

---

### Task 4: Contact history — live reads and the connect stamp

**Files:**
- Create: `services/cti-api/src/dialer/contact-history-live.ts`
- Test: `services/cti-api/src/dialer/contact-history-live.test.ts`

**Interfaces:**
- Produces:
```ts
export async function dialsToPerson(db, orgId: string, person: Person, since: Date): Promise<Dial[]>
export async function inFlightElsewhere(db, orgId: string, person: Person, sessionId: string): Promise<boolean>
export async function stampConnected(tx: { update: Db['update'] }, itemId: string, at: Date): Promise<void>
export async function preferredNumbersFor(db, orgId: string, pairs: ReadonlyArray<readonly [string, string]>): Promise<Map<string, string>>  // key = primary, value = preferred
```
- `Db = ReturnType<typeof getDb>`.

- [ ] **Step 1: Failing tests** — mirror `already-worked.test.ts`'s fake (a chainable `select().from().where()` recording the `where` SQL) and pin:

```ts
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { dialsToPerson, inFlightElsewhere, preferredNumbersFor, stampConnected } from './contact-history-live.js';

const render = (s: SQL) => new PgDialect().sqlToQuery(s);
function fakeDb(results: unknown[][]) {
  const wheres: SQL[] = []; let call = 0;
  const chain: any = {
    from: () => chain, innerJoin: () => chain,
    where: (w: SQL) => { wheres.push(w); const rows = results[call++] ?? []; const p: any = Promise.resolve(rows); p.orderBy = () => p; p.limit = async () => rows; return p; },
  };
  return { db: { select: vi.fn(() => chain), selectDistinct: vi.fn(() => chain) } as any, wheres };
}
const PERSON = { numbers: ['+16195550100', '+12135550199'], recordId: '00Q1' };
const SINCE = new Date('2026-09-22T18:00:00Z');

describe('dialsToPerson', () => {
  it('reads the dial log AND the outbound call log, org-scoped, by number OR record, since the window start', async () => {
    const { db, wheres } = fakeDb([[], []]);
    await dialsToPerson(db, 'org-1', PERSON, SINCE);
    expect(wheres).toHaveLength(2);
    const a = render(wheres[0]!); const c = render(wheres[1]!);
    expect(a.sql).toContain('"dialer_dial_attempts"."org_id" = $1');
    expect(a.sql).toContain('"dialer_dial_attempts"."to_number" in ($2, $3)');
    expect(a.sql).toContain('"dialer_dial_attempts"."record_id" = $4');
    expect(a.sql).toContain('"dialer_dial_attempts"."dialed_at" >= $5');
    expect(a.params).toEqual(['org-1', '+16195550100', '+12135550199', '00Q1', SINCE.toISOString()]);
    expect(c.sql).toContain('"calls"."direction" = $');
    expect(c.sql).toContain('"calls"."normalized_to_number" in (');
    expect(c.sql).toContain('"calls"."salesforce_who_id" = $');
    expect(c.sql).toContain('"calls"."salesforce_what_id" = $');
    expect(c.params).toContain('outbound');
  });
  it('maps both sources onto Dial: connected = connected_at set / disposition Connected', async () => {
    const { db } = fakeDb([
      [{ userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connectedAt: null }],
      [{ userId: 'u2', normalizedToNumber: '+12135550199', createdAt: SINCE, disposition: 'Connected' }],
    ]);
    const dials = await dialsToPerson(db, 'org-1', PERSON, SINCE);
    expect(dials).toEqual([
      { userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connected: false, source: 'dialer' },
      { userId: 'u2', sessionId: null, toNumber: '+12135550199', at: SINCE, connected: true, source: 'manual' },
    ]);
  });
  it('a person with no numbers and no record makes no query', async () => {
    const { db } = fakeDb([]);
    expect(await dialsToPerson(db, 'org-1', { numbers: [], recordId: null }, SINCE)).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('inFlightElsewhere', () => {
  it('asks for dialing/connected items on OTHER live sessions of the org for this person', async () => {
    const { db, wheres } = fakeDb([[{ id: 'x' }]]);
    expect(await inFlightElsewhere(db, 'org-1', PERSON, 'S1')).toBe(true);
    const w = render(wheres[0]!);
    expect(w.sql).toContain('"dialer_sessions"."org_id" = $');
    expect(w.sql).toContain('"dialer_sessions"."id" <> $');
    expect(w.sql).toContain('"dialer_sessions"."status" in ($');
    expect(w.sql).toContain('"dialer_queue_items"."status" in ($');
    expect(w.params).toEqual(expect.arrayContaining(['S1', 'active', 'paused', 'dialing', 'connected', '+16195550100', '+12135550199', '00Q1']));
  });
});

describe('stampConnected', () => {
  it('sets connected_at on the attempt row for the item', async () => {
    const set = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    const tx = { update: vi.fn(() => ({ set })) } as any;
    const at = new Date('2026-09-23T18:00:00Z');
    await stampConnected(tx, 'item-1', at);
    expect(set).toHaveBeenCalledWith({ connectedAt: at });
  });
});

describe('preferredNumbersFor', () => {
  it('one query for every number of every pair, keyed back to the pair\'s primary; no query with no pairs', async () => {
    const { db, wheres } = fakeDb([[{ toNumber: '+12135550199', connectedAt: SINCE }, { toNumber: '+13105550000', connectedAt: null }]]);
    const m = await preferredNumbersFor(db, 'org-1', [['+16195550100', '+12135550199'], ['+13105550000', '+13105550001']]);
    expect(m.get('+16195550100')).toBe('+12135550199');
    expect(m.has('+13105550000')).toBe(false);
    const w = render(wheres[0]!);
    expect(w.sql).toContain('"dialer_dial_attempts"."connected_at" is not null');
    expect(w.params).toEqual(expect.arrayContaining(['+16195550100', '+12135550199', '+13105550000', '+13105550001']));
    expect(await preferredNumbersFor(db, 'org-1', [])).toEqual(new Map());
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** (`contact-history-live.ts`):

```ts
/**
 * The contact-history reads. Two sources, deliberately: the power-dial log
 * (`dialer_dial_attempts`, written by the engine at originate) and the
 * click-to-dial call log (`calls`, direction outbound). A person is matched by
 * any of their numbers OR by record id, so a Lead and the Opportunity it became
 * still read as one person. Every read is bounded by `since` (24 h at most), so
 * each is a few index rows.
 */
import { and, desc, eq, gte, inArray, isNotNull, ne, or, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import type { Dial, Person } from './contact-history.js';
import { preferredNumber } from './contact-history.js';

type Db = ReturnType<typeof getDb>;

function personMatch(numberCol: SQL | typeof schema.dialerDialAttempts.toNumber, recordCols: Array<typeof schema.dialerDialAttempts.recordId>, person: Person): SQL | undefined {
  const arms: SQL[] = [];
  if (person.numbers.length) arms.push(inArray(numberCol as never, [...person.numbers]));
  if (person.recordId) for (const col of recordCols) arms.push(eq(col, person.recordId));
  return arms.length ? or(...arms) : undefined;
}

export async function dialsToPerson(db: Db, orgId: string, person: Person, since: Date): Promise<Dial[]> {
  if (person.numbers.length === 0 && !person.recordId) return [];
  const a = schema.dialerDialAttempts;
  const c = schema.calls;
  const attempts = await db
    .select({ userId: a.userId, sessionId: a.sessionId, toNumber: a.toNumber, at: a.dialedAt, connectedAt: a.connectedAt })
    .from(a)
    .where(and(eq(a.orgId, orgId), personMatch(a.toNumber, [a.recordId], person), gte(a.dialedAt, since)));
  const calls = await db
    .select({ userId: c.userId, normalizedToNumber: c.normalizedToNumber, createdAt: c.createdAt, disposition: c.disposition })
    .from(c)
    .where(and(
      eq(c.orgId, orgId),
      eq(c.direction, 'outbound'),
      personMatch(c.normalizedToNumber as never, [c.salesforceWhoId as never, c.salesforceWhatId as never], person),
      gte(c.createdAt, since),
    ));
  return [
    ...attempts.map((r): Dial => ({ userId: r.userId, sessionId: r.sessionId, toNumber: r.toNumber, at: r.at, connected: r.connectedAt != null, source: 'dialer' })),
    ...calls.filter((r) => r.userId != null).map((r): Dial => ({ userId: r.userId!, sessionId: null, toNumber: r.normalizedToNumber, at: r.createdAt, connected: r.disposition === 'Connected', source: 'manual' })),
  ];
}

/** Is this person ringing or on a call in ANOTHER live run of the org right now? */
export async function inFlightElsewhere(db: Db, orgId: string, person: Person, sessionId: string): Promise<boolean> {
  const i = schema.dialerQueueItems; const s = schema.dialerSessions;
  const arms: SQL[] = [];
  if (person.numbers.length) arms.push(inArray(i.toNumber, [...person.numbers]));
  if (person.recordId) arms.push(eq(i.recordId, person.recordId));
  if (!arms.length) return false;
  const rows = await db
    .select({ id: i.id })
    .from(i)
    .innerJoin(s, eq(s.id, i.sessionId))
    .where(and(eq(s.orgId, orgId), ne(s.id, sessionId), inArray(s.status, ['active', 'paused']), inArray(i.status, ['dialing', 'connected']), or(...arms)))
    .limit(1);
  return rows.length > 0;
}

/** The connect, on the log: the number that reached them is the one to lead with. */
export async function stampConnected(tx: Pick<Db, 'update'>, itemId: string, at: Date): Promise<void> {
  await tx.update(schema.dialerDialAttempts).set({ connectedAt: at }).where(eq(schema.dialerDialAttempts.itemId, itemId));
}

/** For queue creation: one read for every pair's two numbers → primary → preferred. */
export async function preferredNumbersFor(db: Db, orgId: string, pairs: ReadonlyArray<readonly [string, string]>): Promise<Map<string, string>> {
  if (pairs.length === 0) return new Map();
  const a = schema.dialerDialAttempts;
  const all = [...new Set(pairs.flatMap(([p, s]) => [p, s]))];
  const rows = await db
    .select({ toNumber: a.toNumber, connectedAt: a.connectedAt })
    .from(a)
    .where(and(eq(a.orgId, orgId), inArray(a.toNumber, all), isNotNull(a.connectedAt)))
    .orderBy(desc(a.connectedAt));
  const dials: Dial[] = rows.map((r) => ({ userId: '', sessionId: null, toNumber: r.toNumber, at: r.connectedAt!, connected: true, source: 'dialer' }));
  const out = new Map<string, string>();
  for (const [primary, secondary] of pairs) {
    const pref = preferredNumber(dials, [primary, secondary]);
    if (pref) out.set(primary, pref);
  }
  return out;
}
```

(Adjust the `personMatch` typing to whatever compiles cleanly — the pinned SQL is the contract, not the helper's signature.)

- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit -p .` clean.
- [ ] **Step 5: Commit** — `feat(dialer): contact-history live reads — dials to a person, in-flight elsewhere, connect stamp, preferred numbers`.

---

### Task 5: Engine — dial-time gate, cross-run claim, connect stamp

**Files:**
- Modify: `services/cti-api/src/dialer/engine.ts` (`EngineDeps`, `advanceSession` before `pickDid`, the claim transaction, the attempt insert, the `connected` branch)
- Modify: `services/cti-api/src/dialer/live-deps.ts`
- Modify: `services/cti-api/src/dialer/session-store.ts` (no code change needed; `skipBreakdown` tallies any outcome)
- Test: `services/cti-api/src/dialer/engine.test.ts`

**Interfaces:**
- `EngineDeps` gains:
```ts
/** The person's contact history since `since`, both sources. */
contactHistory: (orgId: string, person: Person, since: Date) => Promise<Dial[]>;
/** Ringing/connected in another live run of the org. */
inFlightElsewhere: (orgId: string, person: Person, sessionId: string) => Promise<boolean>;
/** Is the number's state daily-capped? Pure, from the area code. */
isDailyCapped: (toE164: string) => boolean;
```
- `personOf(item)` exported from engine.ts: `{ numbers: [primaryNumber ?? toNumber, secondaryNumber ?? fallbackNumber].filter(Boolean), recordId: item.recordId }`.

- [ ] **Step 1: Failing tests** (append to `engine.test.ts`; extend `makeDeps` with `contactHistory: vi.fn(async () => [])`, `inFlightElsewhere: vi.fn(async () => false)`, `isDailyCapped: vi.fn(() => false)`):

```ts
describe('advanceSession — contact cadence gate', () => {
  beforeEach(() => { _target = {}; });
  const pending = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', primaryNumber: '+16195550100', secondaryNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
  const recent = (sessionId: string | null, hoursAgo: number, over: Record<string, unknown> = {}) =>
    ({ userId: 'U9', sessionId, toNumber: '+16195550100', at: new Date(Date.UTC(2026, 6, 13, 18 - hoursAgo, 0, 0)), connected: false, source: 'dialer', ...over });

  it('skips as cooldown when another run dialed the person in the last 3 h — and asks with BOTH numbers and the record', async () => {
    const deps = makeDeps({ contactHistory: vi.fn(async () => [recent('S-other', 1)]) }); const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'cooldown' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(deps.contactHistory).toHaveBeenCalledWith('O1', { numbers: ['+16195550100', '+12135550199'], recordId: '00Q1' }, expect.any(Date));
    expect(r.action).toBe('done');
  });
  it("dials when the only recent dial is this run's own (end-of-run retry)", async () => {
    const deps = makeDeps({ contactHistory: vi.fn(async () => [recent('S1', 1)]) }); deps.db = fakeDb(baseSession, pending);
    expect((await advanceSession('S1', deps)).action).toBe('dialing');
  });
  it('skips as daily_cap in a capped state with three dials in 24 h', async () => {
    const deps = makeDeps({ isDailyCapped: vi.fn(() => true), contactHistory: vi.fn(async () => [recent(null, 20), recent('S1', 10), recent('S1', 5)]) });
    const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    await advanceSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'daily_cap' }) });
    expect(deps.isDailyCapped).toHaveBeenCalledWith('+16195550100');
  });
  it('the history window is 24 h back from nowUtc (the longest any rule needs)', async () => {
    const deps = makeDeps(); deps.db = fakeDb(baseSession, pending);
    await advanceSession('S1', deps);
    const since = (deps.contactHistory as any).mock.calls[0][2] as Date;
    expect(deps.nowUtc.getTime() - since.getTime()).toBe(24 * 60 * 60_000);
  });
  it('a failed history read: capped state → skip as daily_cap_unverified; not capped → dial (fail open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const capped = makeDeps({ isDailyCapped: vi.fn(() => true), contactHistory: vi.fn(async () => { throw new Error('pool'); }) });
      const f1 = fakeDb(baseSession, pending); capped.db = f1;
      await advanceSession('S1', capped);
      expect(f1._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'daily_cap_unverified' }) });
      const open = makeDeps({ contactHistory: vi.fn(async () => { throw new Error('pool'); }) }); open.db = fakeDb(baseSession, pending);
      expect((await advanceSession('S1', open)).action).toBe('dialing');
    } finally { err.mockRestore(); }
  });
  it('skips as in_progress_elsewhere when another live run is ringing the person', async () => {
    const deps = makeDeps({ inFlightElsewhere: vi.fn(async () => true) }); const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    await advanceSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'in_progress_elsewhere' }) });
    expect(deps.inFlightElsewhere).toHaveBeenCalledWith('O1', { numbers: ['+16195550100', '+12135550199'], recordId: '00Q1' }, 'S1');
  });
  it('the in-flight check runs INSIDE the claim transaction, after the per-number lock', async () => {
    const order: string[] = [];
    const deps = makeDeps({ inFlightElsewhere: vi.fn(async () => { order.push('inflight'); return false; }) });
    const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => realTx(async (tx: any) => { const exec = tx.execute; tx.execute = async (q: any) => { const s = new PgDialect().sqlToQuery(q); order.push(`lock:${s.params.join(',')}`); return exec(q); }; order.push('tx'); return fn(tx); });
    await advanceSession('S1', deps);
    expect(order.slice(0, 4)).toEqual(['tx', 'lock:S1', 'lock:dial:+16195550100', 'inflight']);
  });
  it('the attempt row carries record_id', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    await advanceSession('S1', deps);
    expect(fdb._txInserts[0]!.values).toEqual(expect.objectContaining({ recordId: '00Q1' }));
  });
});

describe('handleDialOutcome — connect stamps the dial log', () => {
  it('connected writes connected_at on the attempt row in the same transaction as the status', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ connectedAt: expect.any(Date) }) });
  });
});
```

The fake db's `transaction` must expose `tx.update` for `schema.dialerDialAttempts` (it already routes any table through `writes`) and its `tx.execute` must accept a query (currently `async () => undefined`; change it to `async (_q?: unknown) => undefined`).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** In `engine.ts`:

```ts
import { cadenceVerdict, type Dial, type Person } from './contact-history.js';
import { stampConnected } from './contact-history-live.js';
import { DAILY_CAP_WINDOW_MS } from '@cti/firewall';

/** The person a queue item dials: both of the record's numbers, and the record. */
export function personOf(item: Pick<DialerItem, 'toNumber' | 'primaryNumber' | 'secondaryNumber' | 'fallbackNumber' | 'recordId'>): Person {
  const numbers = [...new Set([item.primaryNumber ?? item.toNumber, item.secondaryNumber ?? item.fallbackNumber].filter((n): n is string => !!n))];
  return { numbers, recordId: item.recordId };
}
```

Add the three deps to `EngineDeps` (doc-commented as in the Interfaces block). In `advanceSession`, after the calling-hours skip and before `runKind`:

```ts
    // Contact cadence: the PERSON is the unit, not this run. `daily_cap` is law
    // (fail closed on a broken read); `cooldown` is courtesy (fail open).
    const person = personOf(next);
    const capped = deps.isDailyCapped(next.toNumber);
    let verdict: 'ok' | 'cooldown' | 'daily_cap' | 'daily_cap_unverified' = 'ok';
    try {
      const history = await deps.contactHistory(session.orgId, person, new Date(deps.nowUtc.getTime() - DAILY_CAP_WINDOW_MS));
      verdict = cadenceVerdict(history, deps.nowUtc, { sessionId, capped });
    } catch (err) {
      console.error('[dialer] contact history read failed', { sessionId, itemId: next.id, err: (err as Error).message });
      verdict = capped ? 'daily_cap_unverified' : 'ok';
    }
    if (verdict !== 'ok') {
      if (await setItemIfPending(deps, next.id, { status: 'skipped', outcome: verdict })) {
        items = items.map((i) => (i.id === next.id ? { ...i, status: 'skipped', outcome: verdict } : i));
        continue;
      }
      const fresh = await reloadAfterLostSkip(deps, sessionId);
      if (!fresh) return { action: 'waiting' };
      items = fresh;
      continue;
    }
```

In the claim transaction, after the per-session lock:

```ts
      // Per-PERSON lock + in-flight check, inside the claim: two runs advancing
      // in the same instant on the same person serialise here, and the loser
      // sees the winner's `dialing` row and skips instead of double-dialing.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'dial:' + toE164Lock}))`);
      if (await deps.inFlightElsewhere(session.orgId, person, sessionId)) return 'elsewhere' as const;
```

where `const toE164Lock = next.toNumber;` is captured before the transaction; the transaction returns `true | false | 'elsewhere'`; on `'elsewhere'` stamp `setItem(deps, next.id, { status: 'skipped', outcome: 'in_progress_elsewhere' })` (the row is still pending — the CAS did not run), update `items`, and `continue`. Add `recordId: next.recordId` to the `dialerDialAttempts` insert. In the `connected` branch, replace `await setItem(deps, item.id, { status: 'connected', outcome: 'connected' });` with:

```ts
    await deps.db.transaction(async (tx) => {
      await tx.update(schema.dialerQueueItems).set({ status: 'connected', outcome: 'connected', updatedAt: new Date() }).where(eq(schema.dialerQueueItems.id, item.id));
      await stampConnected(tx, item.id, deps.nowUtc);
    });
```

In `live-deps.ts`:

```ts
import { dialsToPerson, inFlightElsewhere } from './contact-history-live.js';
import { isDailyCapped, stateForAreaCode } from '@cti/firewall';
// ...
    contactHistory: (orgId, person, since) => dialsToPerson(db, orgId, person, since),
    inFlightElsewhere: (orgId, person, sessionId) => inFlightElsewhere(db, orgId, person, sessionId),
    isDailyCapped: (toE164) => isDailyCapped(stateForAreaCode(toE164.slice(2, 5))),
```

(`stateForAreaCode` takes the 3-digit NPA; export it from the firewall index if it is not already.)

- [ ] **Step 4: Run** `npx vitest run src/dialer` → PASS; other engine tests that build `makeDeps` keep passing because the new deps default to "no history / not in flight / not capped".
- [ ] **Step 5: Commit** — `feat(dialer): dial-time cadence gate, per-person claim across runs, connect stamped on the dial log`.

---

### Task 6: Engine — no immediate fallback, attempt-2 dials the other number, per-day rollover

**Files:**
- Modify: `services/cti-api/src/dialer/engine.ts` (`handleDialOutcome` miss path; `RolloverEnqueue.sessionId` → `string | null`)
- Test: `services/cti-api/src/dialer/engine.test.ts` (update the fallback tests; add the per-day tests)

**Interfaces:**
- `EngineDeps` gains `orgDayStart: Date` (LA midnight for `nowUtc`; live-wired with `orgMidnightUtc(new Date())` from `org-day.ts`).
- The rollover decision: `rolloverDue(dialsByThisRep, session.userId, deps.orgDayStart)` where `dialsByThisRep = (await deps.contactHistory(orgId, personOf(item), orgDayStart))` — the current miss's own attempt row is already in the log (inserted at originate), so it counts.

- [ ] **Step 1: Update/add tests.** Replace the three existing "no_answer with a fallback" tests with:

```ts
  it('no_answer with a fallback number is a plain miss: NO immediate re-dial of the Phone', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: '+12135550199', primaryNumber: '+16195550100', secondaryNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_answer', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: 'no_answer' }) });
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'pending', toNumber: '+12135550199' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('the end-of-run retry dials the OTHER number when the record has one', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', primaryNumber: '+16195550100', secondaryNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2, toNumber: '+12135550199', primaryNumber: '+16195550100', secondaryNumber: '+12135550199' }) });
  });
  it('…and the same number again when it has only one', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', primaryNumber: '+16195550100', secondaryNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2, toNumber: '+16195550100' }) });
  });
```

and a new describe:

```ts
describe('handleDialOutcome — rollover is per day, per owner', () => {
  beforeEach(() => { _target = {}; });
  const DAY = new Date(Date.UTC(2026, 6, 13, 7, 0, 0));
  const miss = (over: Record<string, unknown> = {}) => [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', primaryNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, followupEligible: true, taskId: null, ...over }];
  const d = (userId: string, hoursAgo: number, connected = false) => ({ userId, sessionId: 'S-x', toNumber: '+1', at: new Date(Date.UTC(2026, 6, 13, 18 - hoursAgo)), connected, source: 'dialer' as const });

  it("first miss of the day (only this dial on the log): requeue, no rollover — even on a STOPPED run", async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 0)]) }); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, miss()); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
  it("the owner's second dial of the day misses → rollover, whatever run it was in and whether or not the run is live", async () => {
    for (const status of ['active', 'stopped']) {
      const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3), d('U1', 0)]) }); deps.db = fakeDb({ ...baseSession, status }, miss()); 
      await handleDialOutcome('CA1', 'voicemail', deps);
      expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U1', recordId: '00Q1', fromDate: '2026-07-13', sourceTaskId: null }), expect.anything());
    }
  });
  it('another rep\'s dial does not count toward the owner\'s two', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U2', 3), d('U1', 0)]) }); deps.db = fakeDb(baseSession, miss());
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
  it('a connect earlier today by the owner means no rollover', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3, true), d('U1', 0)]) }); deps.db = fakeDb(baseSession, miss());
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
  it('the history read for the rollover starts at the org day, and the enqueue still rides inside the CAS transaction', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3), d('U1', 0)]) }); deps.db = fakeDb(baseSession, miss());
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect((deps.contactHistory as any).mock.calls[0][2]).toEqual(DAY);
    expect((deps.enqueueRollover as any).mock.calls[0][1]).toBeDefined(); // the tx handle
  });
  it('a task the rep may not roll (followupEligible=false) still never rolls', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3), d('U1', 0)]) }); deps.db = fakeDb(baseSession, miss({ followupEligible: false }));
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Delete the whole `if (outcome === 'no_answer' && item.fallbackNumber) { … }` block (and its comment). Replace the truth-table block with:

```ts
  // One MISS. Two independent questions, decided before the transaction:
  //  - requeue: first miss in a LIVE run → an attempt-2 row at the END of the
  //    run (5-minute floor) dialing the record's OTHER number when it has one.
  //  - rollover: the rule is per DAY, per OWNER, not per run. This rep has now
  //    dialed the person twice today (any run, any source — the row for THIS
  //    dial is already on the log) and never connected → the follow-up rolls.
  //    Whether the run is live or stopped is irrelevant: a rep who stops after
  //    one pass and dials the person again three hours later rolls it then.
  const attempt = item.attempt ?? 1;
  const retryTo = item.secondaryNumber ?? item.primaryNumber ?? item.toNumber;
  const sessionLive = session.status === 'active' || session.status === 'paused';
  const requeue = attempt < 2 && retryTo != null && sessionLive;
  let enqueue = false;
  if (item.followupEligible) {
    try {
      const own = await deps.contactHistory(session.orgId, personOf(item), deps.orgDayStart);
      enqueue = rolloverDue(own, session.userId, deps.orgDayStart);
    } catch (err) {
      // Fail closed for the courtesy here: a missing rollover is a task that
      // stays open, which the rep sees; a spurious one rewrites their work.
      console.error('[dialer] rollover history read failed', { itemId: item.id, err: (err as Error).message });
    }
  }
```

and in the transaction: `if (requeue) { … toNumber: retryTo, fallbackNumber: null, … }` and `if (enqueue) { await deps.enqueueRollover(…) }` (both may happen for the same miss now — that is correct: the retry is queued AND the task rolls when the day's count is reached). Change `RolloverEnqueue.sessionId` to `string | null`. Add `orgDayStart: Date` to `EngineDeps`; in `live-deps.ts`: `orgDayStart: orgMidnightUtc(new Date()),`. Update `makeDeps` in the test with `orgDayStart: new Date(Date.UTC(2026, 6, 13, 7, 0, 0))`.

- [ ] **Step 4: Run** `npx vitest run src/dialer` → PASS; `npx tsc --noEmit -p .` clean. Fix any existing engine tests that asserted the old fallback or the old `enqueue` truth table (the "stopped session's second miss still enqueues" cases become "two dials today by the owner → enqueue" — rewrite their fixtures with a `contactHistory` of two own dials).
- [ ] **Step 5: Commit** — `feat(dialer): one number per pass, the other on the retry; rollover on the owner's second miss of the day`.

---

### Task 7: Click-to-dial misses roll the task too

**Files:**
- Modify: `services/cti-api/src/salesforce/sync.ts` (`SyncOneDeps`, `liveSyncOneDeps`, end of `syncOne` after the Task write)
- Test: `services/cti-api/src/salesforce/sync.test.ts`

**Interfaces:**
- `SyncOneDeps` gains `contactHistory: (orgId, person: Person, since: Date) => Promise<Dial[]>`, `orgDayStart: () => Date`, `enqueueRollover: (job: RolloverEnqueue) => Promise<void>`.

- [ ] **Step 1: Failing tests** (append to `sync.test.ts`, using its `syncDeps(over)` + `fakeDb(callRow)` harness):

```ts
describe('syncOne — a click-to-dial miss counts toward the owner\'s two dials of the day', () => {
  const DAY = new Date('2026-08-26T07:00:00Z');
  const d = (hoursAgo: number, connected = false) => ({ userId: 'user-1', sessionId: null, toNumber: '+16195550100', at: new Date(DAY.getTime() + (12 - hoursAgo) * 3_600_000), connected, source: 'manual' as const });
  it('second miss of the day → enqueues a record-keyed rollover for this rep', async () => {
    const deps = syncDeps({ contactHistory: vi.fn(async () => [d(3), d(0)]), orgDayStart: () => DAY });
    await syncOne('call-1', deps); // the harness's call row: outbound, disposition 'No answer', whoId set
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', recordId: expect.any(String), sourceTaskId: null, sessionId: null, fromDate: '2026-08-26' }));
  });
  it('a Connected disposition never rolls; a first miss of the day never rolls; inbound never rolls', async () => {
    const one = syncDeps({ contactHistory: vi.fn(async () => [d(0)]), orgDayStart: () => DAY });
    await syncOne('call-1', one);
    expect(one.enqueueRollover).not.toHaveBeenCalled();
    // (add a Connected-disposition call row and an inbound row to the harness for the other two cases)
  });
  it('a history or enqueue failure never fails the sync (logged)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = syncDeps({ contactHistory: vi.fn(async () => { throw new Error('pool'); }), orgDayStart: () => DAY });
      await expect(syncOne('call-1', deps)).resolves.toBeDefined();
    } finally { err.mockRestore(); }
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** After the `salesforceSyncJobs` update in `syncOne` (before the Chatter block):

```ts
  // The per-day rollover counts THIS call too (spec §2.3): the task owner's
  // second dial of the day to the person, from any run or a manual call,
  // rolls the follow-up when it misses. Best effort — a failure here is a task
  // that stays open, which the rep can see; it must never fail the sync.
  if (call.direction === 'outbound' && call.disposition !== 'Connected' && (whoId || whatId)) {
    try {
      const person = { numbers: [call.normalizedToNumber], recordId: whoId ?? whatId ?? null };
      const dayStart = deps.orgDayStart();
      const own = await deps.contactHistory(call.orgId, person, dayStart);
      if (rolloverDue(own, call.userId, dayStart)) {
        await deps.enqueueRollover({
          orgId: call.orgId, userId: call.userId, sfOwnerId: await deps.salesforceUserId(call.userId), sessionId: null,
          recordId: whoId ?? whatId!, objectType: objectTypeForId(whoId ?? whatId!), fromDate: orgTodayIso(dayStart), sourceTaskId: null,
        });
      }
    } catch (err) {
      console.error('[sf-sync] per-day rollover check failed', { callId: call.id, err: (err as Error).message });
    }
  }
```

with `orgTodayIso(d)` = `en-CA` formatting of `d` in `America/Los_Angeles` (extract the existing helper from `dialer/live-deps.ts` into `dialer/org-day.ts` as `orgTodayIso(now = new Date())` and import it in both places), `objectTypeForId` from `salesforce/ownership.ts`, `rolloverDue` from `dialer/contact-history.ts`. Live deps: `contactHistory: (o, p, s) => dialsToPerson(getDb(), o, p, s)`, `orgDayStart: () => orgMidnightUtc(new Date())`, `enqueueRollover: (job) => enqueueFollowupRollover(getDb(), job)`. (`followup-enqueue.ts` imports `RolloverEnqueue` from the engine — no cycle is introduced because `sync.ts` already sits below the engine.)

- [ ] **Step 4: Run** `npx vitest run src/salesforce/sync.test.ts src/dialer` → PASS; tsc clean.
- [ ] **Step 5: Commit** — `feat(sync): a click-to-dial miss is one of the owner's two dials of the day — the follow-up rolls on the second`.

---

### Task 8: Firewall — daily cap BLOCK for click-to-dial

**Files:**
- Create: `packages/firewall/src/daily-cap.ts`
- Modify: `packages/firewall/src/evaluate.ts` (after the blocklist check), `packages/firewall/src/reasons.ts` (`DAILY_CAP: 'DAILY_CAP'`, `DAILY_CAP_OK: 'DAILY_CAP_OK'`)
- Test: `packages/firewall/src/daily-cap.test.ts`, `packages/firewall/src/evaluate.test.ts`

**Interfaces:**
- `dailyDialCount(db, orgId: string, e164: string, now: Date): Promise<number>` — `dialer_dial_attempts` rows + outbound `calls` rows to the number in the last `DAILY_CAP_WINDOW_MS`.
- `dailyCapCheck(state: string | null, count: number): CheckResult`.

- [ ] **Step 1: Failing tests:**

```ts
// daily-cap.test.ts
describe('dailyCapCheck', () => {
  it('blocks at 3 in a capped state with the rep-facing sentence', () => {
    expect(dailyCapCheck('FL', 3)).toEqual({ name: 'daily_cap', passed: false, severity: 'block', reasonCode: 'DAILY_CAP', detail: 'This number has been called 3 times in the last 24 hours; state law limits calls to 3 per day.' });
  });
  it('passes below 3, and always in an uncapped or unknown state', () => {
    expect(dailyCapCheck('FL', 2).passed).toBe(true);
    expect(dailyCapCheck('CA', 9).passed).toBe(true);
    expect(dailyCapCheck(null, 9).passed).toBe(true);
  });
});
describe('dailyDialCount', () => {
  it('counts both logs, org-scoped, this number, last 24 h', async () => { /* fake db with two where captures; pin org_id, to_number / normalized_to_number, direction outbound, the 24 h bound */ });
});
// evaluate.test.ts (its existing harness): a capped-state number with 3 dials → decision BLOCK, reasons include DAILY_CAP; a read failure in a capped state → BLOCK with detail mentioning "could not be verified"; an uncapped state never calls the read.
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `daily-cap.ts`:

```ts
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema } from '@cti/db';
import type { CheckResult } from './types.js';
import { REASON } from './reasons.js';
import { DAILY_CAP_WINDOW_MS, DAILY_DIAL_CAP, isDailyCapped } from './state-calling-rules.js';

export const DAILY_CAP_DETAIL = `This number has been called ${DAILY_DIAL_CAP} times in the last 24 hours; state law limits calls to ${DAILY_DIAL_CAP} per day.`;

export function dailyCapCheck(state: string | null, count: number): CheckResult {
  if (isDailyCapped(state) && count >= DAILY_DIAL_CAP) {
    return { name: 'daily_cap', passed: false, severity: 'block', reasonCode: REASON.DAILY_CAP, detail: DAILY_CAP_DETAIL };
  }
  return { name: 'daily_cap', passed: true, severity: 'info', reasonCode: REASON.DAILY_CAP_OK };
}

/** Every dial by anyone to this number in the last 24 h: power dialer + click-to-dial. */
export async function dailyDialCount(db: any, orgId: string, e164: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - DAILY_CAP_WINDOW_MS);
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.dialerDialAttempts)
    .where(and(eq(schema.dialerDialAttempts.orgId, orgId), eq(schema.dialerDialAttempts.toNumber, e164), gte(schema.dialerDialAttempts.dialedAt, since)));
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.calls)
    .where(and(eq(schema.calls.orgId, orgId), eq(schema.calls.direction, 'outbound'), eq(schema.calls.normalizedToNumber, e164), gte(schema.calls.createdAt, since)));
  return (a?.n ?? 0) + (c?.n ?? 0);
}
```

(Use the package's existing `Db` type instead of `any`.) In `evaluate.ts`, once `resolvedState` is known (after the state resolution at ~line 131), add:

```ts
  // 3b. Daily cap — law in a handful of states (3 per 24 h, every dial counts).
  // Fail CLOSED: a read we cannot make in a capped state is a call we do not place.
  if (isDailyCapped(resolvedState)) {
    let count: number | null = null;
    try { count = await dailyDialCount(db, input.orgId, e164, now); } catch { count = null; }
    checks.push(count === null
      ? { name: 'daily_cap', passed: false, severity: 'block', reasonCode: REASON.DAILY_CAP, detail: 'The daily call count could not be verified; state law limits calls to 3 per day.' }
      : dailyCapCheck(resolvedState, count));
  }
```

- [ ] **Step 4: Run** `cd packages/firewall && npx vitest run && npm run build` → PASS.
- [ ] **Step 5: Commit** — `feat(firewall): block the fourth call in 24 h to a number in a daily-capped state`.

---

### Task 9: Queue creation — 3-hour "already worked", preferred number, one number per pass

**Files:**
- Modify: `services/cti-api/src/dialer/already-worked.ts` (rename semantics: `workedRecentlyNumbers`, window `COOLDOWN_MS`; keep `workedTodaySafe` as a deprecated alias for one release or rename call sites)
- Modify: `services/cti-api/src/dialer/create-session.ts` (`CreateSessionDeps.preferredNumbers`; apply before the gates; `buildQueueRows` writes `fallbackNumber: null`)
- Modify: `services/cti-api/src/routes/dialer.ts` (wire `preferredNumbers`)
- Tests: `already-worked.test.ts`, `create-session.test.ts`

- [ ] **Step 1: Failing tests.** `already-worked.test.ts`: the pinned window param becomes `now - COOLDOWN_MS` (3 h) instead of org midnight. `create-session.test.ts`:

```ts
  it('a record the person once answered on the Phone leads with the Phone and has no second number', async () => {
    const deps = makeDeps({ preferredNumbers: vi.fn(async () => new Map([['+16195550100', '+12135550199']])) });
    // resolveDialNumber → { e164: '+16195550100', fallbackE164: '+12135550199' }
    await createDialerSession(deps, args);
    expect(inserted[0]).toEqual(expect.objectContaining({ toNumber: '+12135550199', primaryNumber: '+12135550199', secondaryNumber: null, fallbackNumber: null }));
    expect(deps.preferredNumbers).toHaveBeenCalledWith('org-1', [['+16195550100', '+12135550199']]);
  });
  it('attempt-1 rows never carry a fallback: the second number lives only on secondaryNumber', async () => { /* default deps; assert fallbackNumber: null, secondaryNumber: '+12135550199' */ });
  it('a failed preferred-number read keeps the Mobile-then-Phone order (fail open)', async () => { /* preferredNumbers throws → row unchanged */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `already-worked.ts` replace `gte(..., orgMidnightUtc(now))` with `gte(..., new Date(now.getTime() - COOLDOWN_MS))` and rewrite the header comment ("the last three hours, matching the dial-time rule; an estimate for the confirm block — the engine's gate is authoritative"). In `create-session.ts`: add `preferredNumbers: (orgId, pairs) => Promise<Map<string, string>>` to deps; after `resolveRows`/`withContactNames`, compute `pairs` from rows with both numbers, call `deps.preferredNumbers` inside `try/catch` (fail open → empty map), and map rows: `pref ? { ...r, toNumber: pref, fallbackNumber: null } : r`. In `buildQueueRows`: `fallbackNumber: null` always, `secondaryNumber: fallback` (the consent-dropped value) unchanged. Wire in both routes: `preferredNumbers: (orgId, pairs) => preferredNumbersFor(db, orgId, pairs)` and rename `workedToday` wiring to the 3-hour read.
- [ ] **Step 4: Run** `npx vitest run src/dialer src/routes/dialer.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(dialer): 3-hour already-worked window; lead with the number that reached them; one number per pass`.

---

### Task 10: Shared list position

**Files:**
- Create: `services/cti-api/src/dialer/list-position.ts` + `.test.ts`
- Modify: `create-session.ts` (args `listViewId?`, `listPosition` per row, rotation), `routes/dialer.ts` (pass `listViewId`; `listContext` in GET), `apps/cti-web/src/dialer-api.ts` (`listContext`, `DialerCurrentItem.listPosition`), `DialerPanel.tsx` (confirm line, current-record position)
- Tests: `list-position.test.ts`, `create-session.test.ts`, `routes/dialer.test.ts`, `DialerPanel.test.tsx`

**Interfaces:**
- `rotateAfter<T>(records: readonly T[], position: number | null): { ordered: T[]; positions: number[]; startedFrom: number }` — `positions[i]` is the ORIGINAL index of `ordered[i]`; `startedFrom` = the original index the queue begins at (0 when `position` is null or past the end).
- `listStartPosition(db, orgId, listViewId, now): Promise<{ position: number; workedBy: string[] } | null>` — max `list_position` over attempts in the last 12 h on sessions with this `list_view_id`, plus the display names of those sessions' users.
- GET session: `listContext: { total: number; startedFrom: number; workedBy: string[] } | null`.

- [ ] **Step 1: Failing tests:**

```ts
// list-position.test.ts
describe('rotateAfter', () => {
  it('starts right after the furthest dialed position and wraps the rest to the end', () => {
    expect(rotateAfter(['a', 'b', 'c', 'd', 'e'], 1)).toEqual({ ordered: ['c', 'd', 'e', 'a', 'b'], positions: [2, 3, 4, 0, 1], startedFrom: 2 });
  });
  it('null or a position at the end → the list as it is', () => {
    expect(rotateAfter(['a', 'b'], null)).toEqual({ ordered: ['a', 'b'], positions: [0, 1], startedFrom: 0 });
    expect(rotateAfter(['a', 'b'], 1)).toEqual({ ordered: ['a', 'b'], positions: [0, 1], startedFrom: 0 });
  });
});
describe('listStartPosition', () => { it('pins: org, list view, 12 h, max(list_position), distinct display names', async () => { /* PgDialect pin of the where + params */ }); });
```

`create-session.test.ts`: a run with `listViewId: '00B1'` and `listStartPosition → { position: 1, workedBy: ['Garrett'] }` inserts rows in rotated order with `listPosition` = original index and the session row with `listViewId`; a run without a list id writes null positions and never calls `listStartPosition`. `routes/dialer.test.ts`: `GET /dialer/sessions/:id` returns `listContext: { total: 3, startedFrom: 2, workedBy: ['Garrett'] }` for a rotated session and `null` otherwise. `DialerPanel.test.tsx`: `confirmContextLine({ total: 220, startedFrom: 87, workedBy: ['Garrett'] })` → `"Garrett is on this list (record 87 of 220) — you'll start from 88."`; two names → `"Garrett and Danny are on this list …"`; `CurrentRecord` with `listPosition: 87` and `listTotal: 220` renders `record 88 of 220`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `list-position.ts`:

```ts
export function rotateAfter<T>(records: readonly T[], position: number | null): { ordered: T[]; positions: number[]; startedFrom: number } {
  const start = position == null || position + 1 >= records.length ? 0 : position + 1;
  const idx = records.map((_, i) => (start + i) % records.length);
  return { ordered: idx.map((i) => records[i]!), positions: idx, startedFrom: start };
}

export async function listStartPosition(db: Db, orgId: string, listViewId: string, now: Date): Promise<{ position: number; workedBy: string[] } | null> {
  const a = schema.dialerDialAttempts, i = schema.dialerQueueItems, s = schema.dialerSessions, u = schema.users;
  const rows = await db
    .select({ position: sql<number | null>`max(${i.listPosition})`, name: u.displayName })
    .from(a).innerJoin(i, eq(i.id, a.itemId)).innerJoin(s, eq(s.id, a.sessionId)).innerJoin(u, eq(u.id, s.userId))
    .where(and(eq(s.orgId, orgId), eq(s.listViewId, listViewId), gte(a.dialedAt, new Date(now.getTime() - LIST_SHARE_WINDOW_MS))))
    .groupBy(u.displayName);
  const positions = rows.map((r) => r.position).filter((p): p is number => p != null);
  if (!positions.length) return null;
  return { position: Math.max(...positions), workedBy: rows.map((r) => r.name ?? 'Someone') };
}
export const LIST_SHARE_WINDOW_MS = 12 * 60 * 60_000;
```

`createDialerSession(deps, args & { listViewId?: string })`: when `listViewId`, call `deps.listStartPosition(orgId, listViewId, now)` (fail open → null), `rotateAfter(recordIds, pos?.position ?? null)` BEFORE resolving rows, resolve in the rotated order, pass `positions[i]` into each `ResolvedRow.listPosition`, insert the session with `listViewId`. `buildQueueRows` writes `listPosition: r.listPosition ?? null`. Route: pass `listViewId` from `/from-listview`; GET computes `listContext` = session.listViewId ? `{ total: attempt-1 rows, startedFrom: min listPosition among ordinal 0 row, workedBy: names from listStartPosition }` : null (one read; fine per poll — or cache `workedBy` on the session row as `list_worked_by text[]`; keep it simple: recompute, it is an indexed read). Panel: `confirmContextLine` pure + render under `confirmLine`; `CurrentRecord` shows `record {listPosition+1} of {listTotal}` when both present (pass `listTotal` from `listContext.total`).
- [ ] **Step 4: Run** all three suites → PASS.
- [ ] **Step 5: Commit** — `feat(dialer): two reps, one list — a new run starts where the list has got to`.

---

### Task 11: Hang-up stamp, Redial, End (engine + routes)

**Files:**
- Modify: `engine.ts` (`handleDialOutcome` for `connected` items; `redialCurrent`; `endCurrent`), `routes/dialer.ts` (`/redial`, `/end`), `apps/cti-web/src/dialer-api.ts` (`DialerControlAction` adds `'redial' | 'end'`; `DialerCurrentItem.prospectEndedAt?: string | null`)
- Tests: `engine.test.ts`, `routes/dialer.test.ts`

**Interfaces:**
- `redialCurrent(sessionId, deps): ReturnType<typeof advanceSession>`; `endCurrent(sessionId, deps): Promise<{ action: 'paused' | Session['status'] | 'idle' }>`.

- [ ] **Step 1: Failing tests:**

```ts
describe('handleDialOutcome — the prospect hangs up on a connected call', () => {
  it('stamps prospect_ended_at, does NOT advance, does NOT redial', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }, { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'hangup', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ prospectEndedAt: expect.any(Date) }) });
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('a duplicate callback does not stamp twice (only a null prospect_ended_at is written)', async () => { /* item with prospectEndedAt set → no write */ });
});
describe('redialCurrent', () => {
  it('closes the connected item as done and dials the same person again next, on the number that connected, linked by redial_of', async () => {
    const items = [{ id: 'i1', ordinal: 3, status: 'connected', toNumber: '+12135550199', primaryNumber: '+16195550100', secondaryNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, prospectEndedAt: new Date(), displayName: 'Ada', taskId: null, followupEligible: true }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await redialCurrent('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(fdb._inserts).toContainEqual({ values: expect.objectContaining({ recordId: '00Q1', toNumber: '+12135550199', ordinal: 3, attempt: 1, redialOf: 'i1', displayName: 'Ada', status: 'pending' }) });
  });
  it('is a no-op (returns the session status) when nothing is connected', async () => { /* pending-only queue → { action: 'waiting' } or session status, no insert */ });
});
describe('endCurrent', () => {
  it('stamps the item done BEFORE hanging up, then pauses the run and does not advance', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }, { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const seen: boolean[] = [];
    deps.telephony.hangup = vi.fn(async () => { seen.push(fdb._writes.some((w: any) => w.patch.status === 'done')); });
    expect(await endCurrent('S1', deps)).toEqual({ action: 'paused' });
    expect(seen).toEqual([true]);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
});
```

Routes: `POST /dialer/sessions/:id/redial` → `redialCurrent`; `/end` → `endCurrent`; both gated by `requireOwnedSession` like `next`.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** At the top of `handleDialOutcome`, before `if (!item || item.status !== 'dialing') return;`:

```ts
  // The prospect's leg ended on a CONNECTED call: the person hung up. Stamp it
  // and stop — the rep chooses Redial or Resume (spec §5). Never advance, never
  // dial. Only a null stamp is written, so a redelivered callback is a no-op.
  if (item?.status === 'connected' && item.prospectEndedAt == null && outcome !== 'connected') {
    await deps.db.update(schema.dialerQueueItems)
      .set({ prospectEndedAt: deps.nowUtc, updatedAt: new Date() })
      .where(and(eq(schema.dialerQueueItems.id, item.id), isNull(schema.dialerQueueItems.prospectEndedAt)));
    return;
  }
```

`redialCurrent`:

```ts
export async function redialCurrent(sessionId: string, deps: EngineDeps): ReturnType<typeof advanceSession> {
  const items = await loadItems(deps, sessionId);
  const item = inFlightItem(items);
  if (!item || item.status !== 'connected') return advanceSession(sessionId, deps);
  // Close the conversation that just ended and queue the same person NEXT: the
  // copy shares the item's ordinal so `nextEligiblePendingItem` picks it before
  // the rest. Same session → exempt from the 3-hour courtesy by construction;
  // the 24-hour cap and the cross-run claim still apply at dial time.
  await setItem(deps, item.id, { status: 'done' });
  await deps.db.insert(schema.dialerQueueItems).values({
    sessionId, ordinal: item.ordinal, objectType: item.objectType, recordId: item.recordId,
    toNumber: item.toNumber, fallbackNumber: null, primaryNumber: item.primaryNumber, secondaryNumber: item.secondaryNumber,
    taskId: item.taskId, followupEligible: item.followupEligible, displayName: item.displayName, listPosition: item.listPosition,
    attempt: item.attempt, status: 'pending', redialOf: item.id,
  });
  return advanceSession(sessionId, deps);
}

export async function endCurrent(sessionId: string, deps: EngineDeps): Promise<{ action: Session['status'] | 'idle' }> {
  const [session, items] = await Promise.all([deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) }), loadItems(deps, sessionId)]);
  if (!session) return { action: 'idle' };
  if (session.status !== 'active') return { action: session.status };
  const item = inFlightItem(items);
  if (item && item.status === 'connected') {
    // Stamp BEFORE the hangup (skipCurrent's rule): the terminal callback must
    // find a settled row, not a `connected` one it would stamp as hung up.
    await setItem(deps, item.id, { status: 'done' });
    if (item.callId) { try { await deps.telephony.hangup(item.callId); } catch (err) { console.error('[dialer] end hangup failed', { itemId: item.id, err: (err as Error).message }); } }
  }
  await setSession(deps, sessionId, 'paused');
  return { action: 'paused' };
}
```

Note `inFlightItem` already treats `connected` as in flight; a `connected` item with `prospectEndedAt` set is still in flight for the engine (the run waits on the rep). Routes mirror `/next`.

- [ ] **Step 4: Run** → PASS; tsc clean.
- [ ] **Step 5: Commit** — `feat(dialer): a prospect hanging up is stamped, never redialed; Redial and End controls`.

---

### Task 12: Panel — skip labels, hung-up card, control sets

**Files:**
- Modify: `apps/cti-web/src/components/DialerPanel.tsx`, `apps/cti-web/src/dialer-api.ts`, `apps/cti-web/src/styles.css`
- Test: `apps/cti-web/src/components/DialerPanel.test.tsx`

- [ ] **Step 1: Failing tests** (SSR `renderToStaticMarkup` idiom):

```ts
describe('skip labels for the cadence rules', () => {
  it('confirm line names the three new reasons', () => {
    expect(confirmLine(10, 0, { cooldown: 2, daily_cap: 1, in_progress_elsewhere: 1 })).toBe('6 will be dialed · 2 called in the last 3 h · 1 daily limit (state law) · 1 in progress in another run');
  });
});
describe('controls', () => {
  const connected = { ...item, status: 'connected' };
  it('on a live connected call: End call and Next', () => {
    const html = render(view(connected));
    expect(html).toContain('End call'); expect(html).toContain('>Next<'); expect(html).not.toContain('Redial');
  });
  it('after the prospect hung up: the card says so and the controls are Redial and Resume', () => {
    const html = render(view({ ...connected, prospectEndedAt: '2026-09-23T18:00:00Z' }));
    expect(html).toContain('They hung up'); expect(html).toContain('Redial'); expect(html).toContain('Resume'); expect(html).not.toContain('End call');
  });
  it('controlsFor is pure: dialing → [Skip], connected → [End call, Next], hung up → [Redial, Resume]', () => {
    expect(controlsFor({ ...item, status: 'dialing' })).toEqual(['skip']);
    expect(controlsFor(connected)).toEqual(['end', 'next']);
    expect(controlsFor({ ...connected, prospectEndedAt: 'x' })).toEqual(['redial', 'next']);
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `queueParts`/`confirmLine`: add `cooldown`, `daily_cap` (+ `daily_cap_unverified` folded into it), `in_progress_elsewhere` with the exact labels. Export `controlsFor(item: DialerCurrentItem | null): Array<'skip' | 'end' | 'next' | 'redial'>` and render buttons from it: `redial` → "Redial" (`runControl('redial')`), `next` labelled "Resume" when `prospectEndedAt` is set, else "Next"; `end` → "End call" (`runControl('end')`, class `btn`). Keep Pause/Resume-session and Stop as they are. `CurrentRecord`: when `item.prospectEndedAt`, the meta line reads "They hung up" with the muted-red dot.
- [ ] **Step 4: Run** `npx vitest run src/components` → PASS; tsc clean.
- [ ] **Step 5: Commit** — `feat(cti-web): cadence skip labels; They hung up → Redial/Resume; End call`.

---

### Task 13: Reaper — a hung-up conversation is not presence

**Files:**
- Modify: `services/cti-api/src/salesforce/followup-worker.ts` (`expireAbandonedSessions` loop)
- Test: `followup-worker.test.ts`

- [ ] **Step 1: Failing test:**

```ts
  it('a connected item whose prospect hung up more than 10 minutes ago no longer counts as presence', async () => {
    const d = deps({ db: expireDb([session()], [[{ status: 'connected', prospectEndedAt: new Date(NOW.getTime() - 11 * 60_000) }]]) });
    expect(await expireAbandonedSessions(d)).toBe(1);
  });
  it('…but within 10 minutes it still does (the rep may be choosing Redial)', async () => {
    const d = deps({ db: expireDb([session()], [[{ status: 'connected', prospectEndedAt: new Date(NOW.getTime() - 5 * 60_000) }]]) });
    expect(await expireAbandonedSessions(d)).toBe(0);
  });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Export `HUNG_UP_PRESENCE_MS = 10 * 60_000` and replace `if (inFlightItem(items)) continue;` with:

```ts
    const live = inFlightItem(items);
    // A live dial IS presence — unless it is a connected call whose prospect
    // hung up long ago: that is a rep who closed the tab mid-conversation.
    const hungUpLongAgo = live?.status === 'connected' && live.prospectEndedAt != null && now.getTime() - live.prospectEndedAt.getTime() > HUNG_UP_PRESENCE_MS;
    if (live && !hungUpLongAgo) continue;
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `fix(dialer): reap a run abandoned mid-conversation once the prospect has been gone 10 minutes`.

---

### Task 14: Inbound pop precedence

**Files:**
- Create: `services/cti-api/src/salesforce/inbound-pop.ts` + `.test.ts`
- Modify: `services/cti-api/src/routes/inbound-caller-params.ts` (`MatchedCaller.popRecordId?`; `attachCallerParameters` uses `matched.popRecordId ?? matched.whoId ?? matched.whatId`), `services/cti-api/src/routes/inbound.ts` (compute `popRecordId`)
- Tests: `inbound-pop.test.ts`, `inbound-caller-params.test.ts`, `inbound.test.ts`

**Interfaces:**
- `popRecordFor(m: { whoId?: string; whatId?: string; openOpportunityId?: string | null }): string | null`.

- [ ] **Step 1: Failing tests:**

```ts
describe('popRecordFor — Opportunity → Deal → Lead → Contact, never an Account', () => {
  it('a Contact with an open Opportunity pops the Opportunity', () => { expect(popRecordFor({ whoId: '003A', openOpportunityId: '006B' })).toBe('006B'); });
  it('a matched Opportunity (whatId 006) pops itself', () => { expect(popRecordFor({ whoId: '003A', whatId: '006C' })).toBe('006C'); });
  it('a Deal (custom whatId) beats a Lead and a Contact', () => { expect(popRecordFor({ whoId: '00QL', whatId: 'a0XD' })).toBe('a0XD'); });
  it('a Lead beats a Contact', () => { expect(popRecordFor({ whoId: '00QL' })).toBe('00QL'); });
  it('a Contact with nothing else pops the Contact', () => { expect(popRecordFor({ whoId: '003A' })).toBe('003A'); });
  it('never an Account, and nothing when there is nothing', () => { expect(popRecordFor({ whatId: '001X' })).toBeNull(); expect(popRecordFor({})).toBeNull(); });
});
// inbound-caller-params.test.ts: popRecordId wins over whoId for the `recordId` parameter; recordType follows it.
// inbound.test.ts: a Contact match with findPrimaryOpenOpportunityId → '006B' rings with recordId=006B; a Lead match rings with the Lead; the call row's who/what ids are unchanged.
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `inbound-pop.ts`:

```ts
/** The record the softphone pops for an inbound match. The person's live deal
 *  first (Opportunity, then Deal), then the Lead, then the Contact itself —
 *  never an Account: a Contact page is the Account's page in practice. */
export function popRecordFor(m: { whoId?: string; whatId?: string; openOpportunityId?: string | null }): string | null {
  const what = m.whatId && !m.whatId.startsWith('001') ? m.whatId : undefined;
  if (what?.startsWith('006')) return what;
  if (m.openOpportunityId) return m.openOpportunityId;
  if (what) return what; // Deal__c (custom prefix)
  if (m.whoId?.startsWith('00Q')) return m.whoId;
  if (m.whoId?.startsWith('003')) return m.whoId;
  return null;
}
```

In `inbound.ts`, after `matched` is set: `const openOpp = matched?.whoId?.startsWith('003') && !matched.whatId?.startsWith('006') ? await findPrimaryOpenOpportunityId(handlerUserId, matched.whoId).catch(() => null) : null; const pop = matched ? { ...matched, popRecordId: popRecordFor({ ...matched, openOpportunityId: openOpp }) ?? undefined } : null;` and pass `pop` to both `dialClientWithCallerParams` calls. `attachCallerParameters`: `const recordId = matched.popRecordId ?? matched.whoId ?? matched.whatId;`.
- [ ] **Step 4: Run** `npx vitest run src/routes/inbound.test.ts src/routes/inbound-caller-params.test.ts src/salesforce/inbound-pop.test.ts` → PASS.
- [ ] **Step 5: Commit** — `fix(inbound): pop the Opportunity, Deal or Lead — never the Account`.

---

### Task 15: Runbook and final verification

**Files:**
- Create: `docs/runbooks/dialer-cadence.md`
- Modify: `docs/runbooks/number-fleet.md` (one line pointing at the new runbook from §8)

- [ ] **Step 1: Write the runbook** (≤ 60 lines): the rules table (3 h courtesy / 3-per-24 h law / per-day rollover / shared list / second number), the skip outcomes and their labels, the capped-state list and how to add one (`DAILY_DIAL_CAP_STATES`), three SQL reads: a person's contact history (both tables by number), a session's skips by outcome, a list's shared position (`max(list_position)` by `list_view_id` in 12 h), and the kill-switch note: none — the rules are org-wide; to relax the courtesy window change `COOLDOWN_MS`.
- [ ] **Step 2: Full verification** — `cd packages/db && npx vitest run`, `cd packages/firewall && npx vitest run`, `cd services/cti-api && npx tsc --noEmit -p . && npx vitest run`, `cd apps/cti-web && npx tsc --noEmit -p . && npx vitest run` — all green; record the counts in the commit body.
- [ ] **Step 3: Commit** — `docs(runbooks): dialer cadence — the rules, the skips, the SQL`.

---

## Self-review

- **Spec coverage:** §1 → Tasks 2–4; §2.1 → Task 5 (+9 for already-worked); §2.2 → Task 8; §2.3 → Tasks 6–7; §3 → Tasks 6, 9; §4 → Task 10; §5 → Tasks 11–13; §6 → Task 14; §7 → Task 1; §8 error handling → Tasks 5 (fail open/closed), 7 (best effort), 8 (fail closed), 9/10 (fail open); §9 testing → every task; §10 rollout → Task 15 + the deploy step is the operator's (off-hours, `preDeployCommand` migrates first).
- **Placeholders:** none; the two "(add … to the harness)" notes in Task 7 name the exact fixtures to add.
- **Type consistency:** `Person`/`Dial` (Task 3) are what Tasks 4–7 and 9 consume; `EngineDeps.contactHistory/inFlightElsewhere/isDailyCapped/orgDayStart` (Tasks 5–6) are wired in `live-deps.ts`; `rotateAfter`/`listStartPosition` (Task 10) match their tests; `controlsFor` returns `'redial' | 'end' | 'next' | 'skip'` matching `DialerControlAction` (Task 11 adds `'redial' | 'end'`).
