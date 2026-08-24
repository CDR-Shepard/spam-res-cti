# Already-Worked Skip Implementation Plan (Launch sub-project C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rep starting a power-dial run inherits the team's day: any resolved dial target the team already power-dialed since LA midnight enters the queue as a visible `skipped/already_worked` row, and the panel says so up front.

**Architecture:** One pure LA-midnight helper + one small DB module (`workedTodayNumbers` over the existing `dialer_dial_attempts` append-only log, keyed by number) injected into `createDialerSession` as a fail-open dep. The session view gains a per-outcome skip breakdown; the panel renders the inherited-day line. No schema changes — the attempts table and its `(org_id, to_number, dialed_at)` index already exist.

**Tech Stack:** TypeScript (Fastify + Drizzle, React 18), vitest both packages.

## Global Constraints

- "Already worked" = ANY `dialer_dial_attempts` row for this org with `to_number = <target>` and `dialed_at >=` **LA midnight** (America/Los_Angeles, DST-correct). Keyed by NUMBER — the same person via a different record is caught.
- Only the dialer engine writes `dialer_dial_attempts` (verified: the single insert lives in `dialer/engine.ts`'s originate transaction) — manual click-to-dial calls never mark a number worked, by construction; do not add writers.
- The check runs ONLY at session creation, against pre-run attempts — the run's own attempt-2 retries and requeues are untouched.
- Precedence in the queue row: `skip_on_dialer` (explicit rep intent) beats `already_worked` beats `unreachable`; a number-less record can never be `already_worked`.
- FAIL OPEN: any error in the check yields an empty worked-set plus one `console.warn` — the record dials. This is the spec's single deliberate fail-open (availability over dedupe).
- Skipped rows stay visible; the panel's start line reads like `50 records · 18 already worked today · dialing 32` (only non-zero parts shown).
- Verify each task with `npm test` + `npm run typecheck` in the touched package; client tasks also `npm run build`.
- `.claude/launch.json` is an unrelated pre-existing unstaged deletion — never stage, restore, or commit it.

---

### Task 1: LA-midnight helper (pure)

**Files:**
- Create: `services/cti-api/src/dialer/org-day.ts`, `services/cti-api/src/dialer/org-day.test.ts`

**Interfaces:**
- Produces: `ORG_TIMEZONE = 'America/Los_Angeles'` (exported); `orgMidnightUtc(now: Date, tz?: string): Date` — the UTC instant of the most recent local midnight in `tz` at time `now`.

- [ ] **Step 1: Failing test** — `org-day.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { orgMidnightUtc } from './org-day.js';

const laClock = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const laDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

describe('orgMidnightUtc', () => {
  it('is 00:00 LA on the same LA day, in winter (PST, UTC-8)', () => {
    const now = new Date('2026-01-15T20:30:00Z'); // 12:30 PST
    const m = orgMidnightUtc(now);
    expect(laClock(m)).toBe('00:00');
    expect(laDate(m)).toBe(laDate(now));
    expect(m.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });
  it('is 00:00 LA on the same LA day, in summer (PDT, UTC-7)', () => {
    const now = new Date('2026-08-24T18:00:00Z'); // 11:00 PDT
    const m = orgMidnightUtc(now);
    expect(laClock(m)).toBe('00:00');
    expect(m.toISOString()).toBe('2026-08-24T07:00:00.000Z');
  });
  it('handles the UTC-evening rollover (late LA night is still the same LA day)', () => {
    const now = new Date('2026-08-25T05:30:00Z'); // 22:30 PDT on Aug 24
    expect(orgMidnightUtc(now).toISOString()).toBe('2026-08-24T07:00:00.000Z');
  });
  it('is correct on both DST transition days of 2026', () => {
    for (const iso of ['2026-03-08T20:00:00Z', '2026-11-01T20:00:00Z']) {
      const m = orgMidnightUtc(new Date(iso));
      expect(laClock(m)).toBe('00:00');
      expect(laDate(m)).toBe(laDate(new Date(iso)));
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd services/cti-api && npx vitest run src/dialer/org-day.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — `org-day.ts`:

```ts
/** GG Homes operates out of America/Los_Angeles — "today" for the already-worked
 *  skip means the LA calendar day, not the server's (UTC on Railway). */
export const ORG_TIMEZONE = 'America/Los_Angeles';

const ymdIn = (tz: string, d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const hourIn = (tz: string, d: Date): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d));

/**
 * The UTC instant of the most recent local midnight in `tz`. Tries every
 * plausible UTC offset for that calendar day and keeps the candidate that
 * renders as 00:xx local — DST-proof without a timezone library.
 */
export function orgMidnightUtc(now: Date, tz: string = ORG_TIMEZONE): Date {
  const [y, m, d] = ymdIn(tz, now).split('-').map(Number);
  for (let offset = 0; offset <= 14; offset++) {
    const candidate = new Date(Date.UTC(y!, m! - 1, d!, offset, 0, 0));
    if (hourIn(tz, candidate) === 0 && ymdIn(tz, candidate) === ymdIn(tz, now)) return candidate;
  }
  // Unreachable for real timezones; fail loudly rather than silently mis-bucket a day.
  throw new Error(`orgMidnightUtc: no midnight found for ${tz}`);
}
```

- [ ] **Step 4: Verify** — the test file PASSES; `npm test && npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add services/cti-api/src/dialer/org-day.ts services/cti-api/src/dialer/org-day.test.ts && git commit -m "feat(cti-api): DST-proof LA-midnight helper for the already-worked window"`

---

### Task 2: `workedTodayNumbers` (DB read, fail-open wrapper)

**Files:**
- Create: `services/cti-api/src/dialer/already-worked.ts`, `services/cti-api/src/dialer/already-worked.test.ts`

**Interfaces:**
- Consumes: `orgMidnightUtc` (Task 1); `schema.dialerDialAttempts` (`orgId`, `toNumber`, `dialedAt`).
- Produces: `workedTodayNumbers(db: Db, orgId: string, numbers: readonly string[], now?: Date): Promise<Set<string>>` (one SELECT, distinct to_numbers); `workedTodaySafe(...same args): Promise<Set<string>>` — identical but never throws (error → empty Set + one `console.warn` per call naming the error).

- [ ] **Step 1: Failing test** — `already-worked.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { workedTodayNumbers, workedTodaySafe } from './already-worked.js';

function fakeDb(rows: Array<{ toNumber: string }>, fail = false) {
  const where = vi.fn();
  return {
    _where: where,
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async (cond: unknown) => { where(cond); if (fail) throw new Error('pg down'); return rows; }),
      })),
    })),
  } as never;
}

describe('workedTodayNumbers', () => {
  it('returns the distinct numbers the team dialed today', async () => {
    const db = fakeDb([{ toNumber: '+16195550100' }, { toNumber: '+12135550200' }]);
    const got = await workedTodayNumbers(db, 'O1', ['+16195550100', '+12135550200', '+19995550300']);
    expect(got).toEqual(new Set(['+16195550100', '+12135550200']));
  });
  it('short-circuits to an empty set with no candidate numbers (no query)', async () => {
    const db = fakeDb([]);
    expect(await workedTodayNumbers(db, 'O1', [])).toEqual(new Set());
    expect((db as { selectDistinct: ReturnType<typeof vi.fn> }).selectDistinct).not.toHaveBeenCalled();
  });
});

describe('workedTodaySafe — the one deliberate fail-open', () => {
  it('a query error yields an empty set and a warn, never a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = await workedTodaySafe(fakeDb([], true), 'O1', ['+16195550100']);
      expect(got).toEqual(new Set());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('already-worked');
    } finally {
      warn.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** — `already-worked.ts`:

```ts
/**
 * The cross-shift dedupe read (launch spec C): which of these numbers has the
 * TEAM power-dialed since LA midnight? Reads the append-only
 * dialer_dial_attempts log (written only by the engine's originate — manual
 * click-to-dial never lands here), so a second shift starting the same list
 * inherits the day's work. Keyed by number: the same person reached through a
 * different record is still caught.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { schema } from '../db/index.js';
import { orgMidnightUtc } from './org-day.js';

type Db = ReturnType<typeof getDb>;

export async function workedTodayNumbers(
  db: Db, orgId: string, numbers: readonly string[], now: Date = new Date(),
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ toNumber: schema.dialerDialAttempts.toNumber })
    .from(schema.dialerDialAttempts)
    .where(and(
      eq(schema.dialerDialAttempts.orgId, orgId),
      inArray(schema.dialerDialAttempts.toNumber, [...numbers]),
      gte(schema.dialerDialAttempts.dialedAt, orgMidnightUtc(now)),
    ));
  return new Set(rows.map((r) => r.toNumber));
}

/** Fail OPEN (the spec's one deliberate fail-open): a broken dedupe check must
 *  never stop the team dialing — worst case is a repeat call, not a dead queue. */
export async function workedTodaySafe(
  db: Db, orgId: string, numbers: readonly string[], now: Date = new Date(),
): Promise<Set<string>> {
  try {
    return await workedTodayNumbers(db, orgId, numbers, now);
  } catch (err) {
    console.warn('[already-worked] check failed — failing OPEN (no skips):', (err as Error).message);
    return new Set();
  }
}
```

- [ ] **Step 4: Verify** — PASSES; `npm test && npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add services/cti-api/src/dialer/already-worked.ts services/cti-api/src/dialer/already-worked.test.ts && git commit -m "feat(cti-api): the team-wide worked-today read, failing open by design"`

---

### Task 3: Wire session creation

**Files:**
- Modify: `services/cti-api/src/dialer/create-session.ts` (+`create-session.test.ts`), `services/cti-api/src/routes/dialer.ts` (both deps objects)

**Interfaces:**
- Consumes: `workedTodaySafe` (Task 2).
- Produces: `CreateSessionDeps` gains `workedToday: (orgId: string, numbers: readonly string[]) => Promise<Set<string>>`; `ResolvedRow` gains `alreadyWorked?: boolean`; new exported outcome const `ALREADY_WORKED_OUTCOME = 'already_worked'`; row precedence `skip_on_dialer` > `already_worked` > `pending`/`unreachable`.

- [ ] **Step 1: Failing tests** — append to `create-session.test.ts` (extend the file's `fakeDb`/deps helpers; give the existing tests a default `workedToday: async () => new Set()`):

```ts
describe('already-worked skip at queue build', () => {
  it('a number the team dialed today enters as skipped/already_worked; the rest stay pending', async () => {
    // two Leads resolving to different numbers; workedToday reports one of them
    // → rows: [skipped/already_worked, pending]; assert workedToday was called
    // ONCE with the org id and BOTH resolved numbers (batched, not per-record).
  });
  it('skip_on_dialer beats already_worked when both apply', async () => { /* flagged + worked → outcome skip_on_dialer */ });
  it('a Task-run target reached via a different record is still caught (number-keyed)', async () => {
    // Task resolves to a Contact whose phone equals the worked number → skipped/already_worked
  });
  it('a phone-less record cannot be already_worked (stays unreachable)', async () => { /* toNumber null */ });
  it('the fail-open dep returning an empty set leaves everything pending', async () => { /* workedToday: async () => new Set() */ });
});
```

Write each fully in the file's existing style (the comments above state the required assertions — turn each into real code with exact row expectations, matching how the Task-run and skip_on_dialer tests in this file assert on `db._itemRows`).

- [ ] **Step 2: Run to verify failure** → FAIL (deps missing `workedToday`).
- [ ] **Step 3: Implement** — in `createDialerSession`, after `resolveRows` and before `buildQueueRows`:

```ts
  const worked = await deps.workedToday(args.orgId, resolved.map((r) => r.toNumber).filter((n): n is string => !!n));
  const rows = buildQueueRows(session!.id, resolved.map((r) => ({ ...r, alreadyWorked: !!r.toNumber && worked.has(r.toNumber) })));
```

`buildQueueRows` row shape:

```ts
    status: r.skipOnDialer || r.alreadyWorked ? 'skipped' : r.toNumber ? 'pending' : 'unreachable',
    outcome: r.skipOnDialer ? SKIP_ON_DIALER_OUTCOME : r.alreadyWorked ? ALREADY_WORKED_OUTCOME : null,
```

`routes/dialer.ts`: both deps objects gain `workedToday: (orgId, numbers) => workedTodaySafe(db, orgId, numbers)` (import from `../dialer/already-worked.js`).

- [ ] **Step 4: Verify** — `npm test && npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add -u services/cti-api/src && git commit -m "feat(cti-api): queue builds skip numbers the team already power-dialed today"`

---

### Task 4: The inherited-day line (server breakdown + panel)

**Files:**
- Modify: `services/cti-api/src/dialer/session-store.ts` (+`session-store.test.ts`), `services/cti-api/src/routes/dialer.ts` (session view), `apps/cti-web/src/dialer-api.ts`, `apps/cti-web/src/components/DialerPanel.tsx` (+`DialerPanel.test.tsx`)

**Interfaces:**
- Produces (server): `skipBreakdown(items: Array<Pick<DialerItem, 'status' | 'outcome'>>): Record<string, number>` (counts per outcome over `status==='skipped'` rows, unknown/null outcome under `'other'`) exported from `session-store.ts`; the session view returns `skipBreakdown` alongside `counts`.
- Produces (client): `DialerSessionView` gains `skipBreakdown?: Record<string, number>`; pure `queueLine(counts: DialerSessionCounts, breakdown?: Record<string, number>): string` exported from `DialerPanel.tsx` — `"<total> records · <n> already worked today · <n> skipped by flag · dialing <pending+connected+…>"`, omitting zero parts; rendered above the progress label while a session is active.

- [ ] **Step 1: Failing tests**

`session-store.test.ts`:

```ts
describe('skipBreakdown', () => {
  it('counts skipped rows per outcome and ignores non-skipped rows', () => {
    expect(skipBreakdown([
      { status: 'skipped', outcome: 'already_worked' },
      { status: 'skipped', outcome: 'already_worked' },
      { status: 'skipped', outcome: 'skip_on_dialer' },
      { status: 'skipped', outcome: null },
      { status: 'pending', outcome: null },
    ])).toEqual({ already_worked: 2, skip_on_dialer: 1, other: 1 });
  });
});
```

`DialerPanel.test.tsx`:

```ts
describe('queueLine', () => {
  const counts = { total: 50, done: 0, connected: 0, noConnect: 0, skipped: 18, unreachable: 0, pending: 32 };
  it('reads like the spec example and omits zero parts', () => {
    expect(queueLine(counts, { already_worked: 18 })).toBe('50 records · 18 already worked today · dialing 32');
    expect(queueLine(counts, { already_worked: 15, skip_on_dialer: 3 }))
      .toBe('50 records · 15 already worked today · 3 skipped by flag · dialing 32');
    expect(queueLine({ ...counts, skipped: 0, pending: 50 }, {})).toBe('50 records · dialing 50');
  });
});
```

- [ ] **Step 2: verify failure** → **Step 3: Implement** (server: pure fn + `skipBreakdown: skipBreakdown(items)` in the view return; client: type + `queueLine` + render `<div className="dp-queue-line">{queueLine(view.counts, view.skipBreakdown)}</div>` above the progress label; append `.dp-queue-line { font-size: 11px; color: var(--text-muted); }` to `styles.css`).
- [ ] **Step 4: Verify** — api `npm test && npm run typecheck`; web `npm test && npm run typecheck && npm run build` → PASS.
- [ ] **Step 5: Commit** — `git add -u services/cti-api/src apps/cti-web/src && git commit -m "feat: the panel says what the second shift inherited (skip breakdown)"`

---

### Task 5: Post-push live verification (CONTROLLER-EXECUTED)

- [ ] After the user pushes and the deploy succeeds: power-dial the CTI DIAL TEST list once (attempt 1 dials land in `dialer_dial_attempts`), stop the run, then create a second session over the same list → every row with the dialed number reads `skipped/already_worked`, the view's `skipBreakdown.already_worked` matches, zero dials go out, and the run completes immediately. Clean up both sessions' SF side (none created — no connects).
