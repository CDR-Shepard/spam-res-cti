# Power-dialer idle cutoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rep's time on the power dialer counts only while something
happened in the last 15 minutes. An idle power-dial line is hung up after 15
minutes. The Salesforce "Power Dialer Time" Tasks since 2026-10-01 are
rewritten with the new number.

**Architecture:**
- **Counting:** a pure interval intersection. The rep's open line
  (`dialer_rep_legs`) is intersected with activity windows: each dial
  (`dialer_dial_attempts`) and each conversation (`dialer_connects`), plus 15
  minutes. This happens in `reports/talk-time.ts`, which feeds both the admin
  screen and the Salesforce worker. The worker's window grows to 14 days, so
  the deploy rewrites history.
- **The live cut:** a 30-second loop (`dialer/idle-runs.ts`) stops runs whose
  open line had no change for 15 minutes. It uses the existing `stopSession`,
  which now records `stop_reason = 'idle'` (migration 0054). The softphone
  shows why the run stopped.

**Tech Stack:**
- TypeScript, Fastify, drizzle-orm (node-postgres), vitest. Run tests with
  `pnpm --filter @cti/api test` / `pnpm --filter @cti/web test` /
  `pnpm --filter @cti/db test`, or `npx vitest run <file>` inside the package.
- React (cti-web).

**Spec:** `docs/superpowers/specs/2026-10-06-dialer-idle-cutoff-design.md`.

## Global Constraints

> Superseded detail: the idle cut uses engine.ts stopIdleSession (flip first), not stopSession(..., { reason }); stopSession never writes stop_reason. See the spec §2.

- One constant: `export const DIALER_IDLE_MS = 15 * 60_000;` in
  `services/cti-api/src/dialer/idle.ts`. Both the counting and the live cut
  import it. No other literal 15-minute value anywhere.
- **Activity windows:**
  - a dial is `[dialed_at, dialed_at + DIALER_IDLE_MS)`;
  - a conversation is `[bridged_at, (ended_at ?? now) + DIALER_IDLE_MS)`.
- **Not activity:**
  - the line opening;
  - the softphone reconnecting;
  - hold music;
  - Pause.
- **Idle run:** `!live && now − last_activity_at >= DIALER_IDLE_MS`.
  - `live` means an item is `dialing`, or it is `connected` with
    `prospect_ended_at is null`.
  - `last_activity_at` is
    `greatest(s.updated_at, max(l.joined_at), max(i.updated_at))`.
  - Candidates are runs in status `active` or `paused` that have an open rep
    leg (`dialer_rep_legs.ended_at is null`).
- The idle cut **stops** the run (never pauses it), via
  `stopSession(sessionId, deps, { reason: 'idle' })`.
- **Kill switch:** `DIALER_IDLE_STOP: z.enum(['on', 'off']).default('on')`.
  When it is `off`, the loop never starts.
- **Migration 0054** is exactly:
  `SET LOCAL lock_timeout = '5s';` followed by
  `ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS stop_reason text CONSTRAINT dialer_sessions_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN ('idle'));`
- **Softphone summary line** (exact):
  `Stopped after 15 minutes with no dialing.`
- **Salesforce Task Description** (exact; `<day>` is `YYYY-MM-DD`):
  `Time on the power dialer on <day>, Pacific: counted while dialing or talking; quiet stretches over 15 minutes are left out. Kept up to date by the CTI.`
- **Admin screen copy** (exact, replacing the "On dialer is how long…"
  sentence):
  `On dialer counts the rep's power-dial time while dialing or talking; quiet stretches over 15 minutes are left out.`
- `DIALER_TIME_WINDOW_DAYS = 14`.
- **Logs** carry ids and counts only: never phone numbers, recording URLs or
  Salesforce message bodies.
- **Coding rules:**
  - Follow the surrounding code's style and comment density.
  - Small functions.
  - No new dependencies.
  - Local array mutation is allowed inside a pure function only for
    performance on large inputs, and must be commented.

---

### Task 1: Counting only active time (pure + admin report)

**Files:**
- Create: `services/cti-api/src/dialer/idle.ts`
- Modify: `services/cti-api/src/reports/talk-time.ts`
- Modify: `services/cti-api/src/reports/talk-time-query.ts`
- Modify: `apps/cti-web/src/components/TalkTimePanel.tsx` (copy only, lines ~29 and ~89-90)
- Test: `services/cti-api/src/reports/talk-time.test.ts`, `services/cti-api/src/reports/talk-time-query.test.ts`, `apps/cti-web/src/components/TalkTimePanel.test.tsx` (only if it asserts the old copy)

**Interfaces:**
- Produces:
  - `DIALER_IDLE_MS` (dialer/idle.ts).
  - `ActivitySpan { userId: string; start: Date; end: Date | null }` and
    `intersectIntervals(a, b)`.
  - `dialerSecondsByUserDay(legs, activity, days, now)`.
  - `loadActivity(db, orgId: string | null, start: Date, end: Date): Promise<ActivitySpan[]>`
    and the two statement builders `dialActivityStatement` /
    `conversationActivityStatement`, all exported from
    `reports/talk-time-query.ts`. Task 2 uses `loadActivity(db, null, …)`.

- [ ] **Step 1: Create `dialer/idle.ts`**

```ts
/**
 * Fifteen minutes with nothing happening on a rep's power-dial line (idle-cutoff
 * spec, docs/superpowers/specs/2026-10-06-dialer-idle-cutoff-design.md): the
 * line is hung up (dialer/idle-runs.ts) and the time past it is not counted as
 * time on the dialer (reports/talk-time.ts). Something happening = a dial
 * placed, or a conversation in progress / ended less than this long ago.
 */
export const DIALER_IDLE_MS = 15 * 60_000;
```

- [ ] **Step 2: Write the failing tests in `reports/talk-time.test.ts`**

Update the existing `dialerSecondsByUserDay` tests to pass an activity list
that keeps their meaning. For example, give each leg a conversation spanning
the whole leg, so the expected numbers are unchanged:
`{ userId, start: joinedAt, end: endedAt }`. For the open leg, use `end: null`.
Then add:

```ts
describe('intersectIntervals', () => {
  it('keeps only the overlap of two sorted, merged lists', () => {
    expect(intersectIntervals(
      [{ start: 0, end: 10 }, { start: 20, end: 30 }],
      [{ start: 5, end: 25 }],
    )).toEqual([{ start: 5, end: 10 }, { start: 20, end: 25 }]);
  });
  it('touching spans share no time; either side empty gives nothing', () => {
    expect(intersectIntervals([{ start: 0, end: 10 }], [{ start: 10, end: 20 }])).toEqual([]);
    expect(intersectIntervals([], [{ start: 0, end: 10 }])).toEqual([]);
  });
});

describe('dialerSecondsByUserDay — only active time counts (idle-cutoff spec)', () => {
  const days = ['2026-10-05'];
  const NOW = new Date('2026-10-06T16:00:00Z');
  const at = (hhmmss: string) => new Date(`2026-10-05T${hhmmss}-07:00`); // PDT
  const MIN = 60;

  it('a dial counts the 15 minutes after it, inside the open line only', () => {
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: at('12:00:00') }],
      [{ userId: 'u1', start: at('10:00:00'), end: at('10:00:00') }],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-05': 15 * MIN } });
  });

  it('dials less than 15 minutes apart count continuously', () => {
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: at('12:00:00') }],
      [
        { userId: 'u1', start: at('10:00:00'), end: at('10:00:00') },
        { userId: 'u1', start: at('10:10:00'), end: at('10:10:00') },
      ],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-05': 25 * MIN } });
  });

  it('a long conversation counts in full plus 15 minutes after it ends', () => {
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: at('12:00:00') }],
      [{ userId: 'u1', start: at('10:00:00'), end: at('10:40:00') }],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-05': 55 * MIN } });
  });

  it('a conversation still going (end null) counts to now, inside the open line', () => {
    const now = at('10:30:00');
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: null }],
      [{ userId: 'u1', start: at('10:05:00'), end: null }],
      days, now,
    );
    expect(out).toEqual({ u1: { '2026-10-05': 25 * MIN } });
  });

  it('an open line with no activity counts nothing, and activity on no open line counts nothing', () => {
    expect(dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: at('12:00:00') }],
      [{ userId: 'u2', start: at('10:00:00'), end: at('10:00:00') }],
      days, NOW,
    )).toEqual({});
  });

  it("Matt's 2026-10-05: an hour of dialing, then a line left open until 9:35 pm, counts about an hour, not 8", () => {
    const legs = [
      { userId: 'u1', joinedAt: at('13:32:29'), endedAt: at('13:33:55') },
      { userId: 'u1', joinedAt: at('13:34:43'), endedAt: at('13:53:56') },
      { userId: 'u1', joinedAt: at('13:57:56'), endedAt: at('17:57:56') },
      { userId: 'u1', joinedAt: at('17:57:58'), endedAt: at('18:01:35') },
      { userId: 'u1', joinedAt: at('18:01:36'), endedAt: at('18:04:39') },
      { userId: 'u1', joinedAt: at('18:04:40'), endedAt: at('21:35:14') },
    ];
    const activity = [
      { userId: 'u1', start: at('13:32:30'), end: at('13:32:30') },
      { userId: 'u1', start: at('13:40:00'), end: at('13:40:00') },
      { userId: 'u1', start: at('13:58:00'), end: at('13:58:00') },
      { userId: 'u1', start: at('14:07:00'), end: at('14:19:03') }, // last call, prospect hung up 2:19 pm
    ];
    const seconds = dialerSecondsByUserDay(legs, activity, days, NOW).u1!['2026-10-05']!;
    // windows 13:32:30–13:55:00 and 13:58:00–14:34:03, inside the legs:
    // 13:32:30–13:33:55 (85 s) + 13:34:43–13:53:56 (1153 s) + 13:58:00–14:34:03 (2163 s);
    // the three reconnected legs after 17:57 had no activity at all.
    expect(seconds).toBe(85 + 1153 + 2163);
  });

  it('still splits at Pacific midnight', () => {
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: new Date('2026-10-05T06:50:00Z'), endedAt: new Date('2026-10-05T07:30:00Z') }],
      [{ userId: 'u1', start: new Date('2026-10-05T06:50:00Z'), end: new Date('2026-10-05T07:10:00Z') }],
      ['2026-10-04', '2026-10-05'], NOW,
    );
    // active 06:50 → 07:25Z; Pacific midnight is 07:00Z
    expect(out).toEqual({ u1: { '2026-10-04': 600, '2026-10-05': 1500 } });
  });
});
```

- Keep the existing performance tests by passing `[]` as activity.
- Add a test that `mergeIntervals` of 50 000 spans returns the right result.
  Build 50 000 one-second spans every 2 s, expect 50 000 output spans. The
  current implementation copies the array on every step, which is quadratic,
  so this test guards against that.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd services/cti-api && npx vitest run src/reports/talk-time.test.ts`
Expected: FAIL. `intersectIntervals` is not exported, and the arity changed.

- [ ] **Step 4: Implement in `reports/talk-time.ts`**

- Import `DIALER_IDLE_MS` from `../dialer/idle.js`.
- Rewrite `mergeIntervals` as a linear pass with the same semantics: drop
  empty spans, sort by start, merge overlapping or touching spans. Mutate a
  local result array, with a comment saying why: inputs can be tens of
  thousands of dial windows.
- Add:

```ts
/** Something happening on a rep's power-dial line (idle-cutoff spec): a dial
 *  placed (`start` = `end` = dialed_at) or a conversation (bridged_at →
 *  ended_at; null = still talking, counted to `now`). */
export interface ActivitySpan {
  userId: string;
  start: Date;
  end: Date | null;
}

/** PURE: the overlap of two lists of sorted, non-overlapping spans
 *  (mergeIntervals output). Two-pointer walk; touching spans share no time. */
export function intersectIntervals(a: readonly Span[], b: readonly Span[]): Span[] { /* two pointers */ }
```

- Export `Span` so the test can type its literals.
- Change `dialerSecondsByUserDay(legs, activity, days, now)`. For each user
  who has legs:
  - `open = mergeIntervals(legs → [joinedAt, endedAt ?? now))`;
  - `active = mergeIntervals(activity → [start, (end ?? now) + DIALER_IDLE_MS))`;
  - counted spans = `intersectIntervals(open, active)`;
  - then the same per-day split as today.
- Group legs and activity by user once, with a Map built by a local loop,
  rather than filtering the full lists per user.
- Update the docblock: "time on the power dialer" now means the line is open
  AND something happened in the last 15 minutes.

- [ ] **Step 5: Add the activity load to `reports/talk-time-query.ts`, test first**

Tests to add to `talk-time-query.test.ts`, in the file's existing style
(render with `new PgDialect().sqlToQuery(stmt.getSQL())`, or `.toSQL()` on
the drizzle builder as `legsStatement`'s tests do; copy whichever that file
uses):
- `dialActivityStatement(db, ORG, start, end)` selects `user_id` and
  `dialed_at` from `dialer_dial_attempts`. It filters `org_id = ORG`,
  `dialed_at >= (start − 15 min)` and `dialed_at < end`.
- With `orgId` null, there is no `org_id` predicate (the Salesforce worker
  reads every org).
- `conversationActivityStatement(db, ORG, start, end)` selects `user_id`,
  `bridged_at` and `ended_at` from `dialer_connects`. It filters `org_id`,
  `bridged_at < end` and `(ended_at is null or ended_at >= start − 15 min)`.
- In both, the lookback is a parameter equal to
  `new Date(start.getTime() - DIALER_IDLE_MS).toISOString()` (not SQL
  interval text).

Implementation:

```ts
export function dialActivityStatement(db: Db, orgId: string | null, start: Date, end: Date) {
  const d = schema.dialerDialAttempts;
  const lookback = new Date(start.getTime() - DIALER_IDLE_MS);
  return db
    .select({ userId: d.userId, dialedAt: d.dialedAt })
    .from(d)
    .where(and(orgId ? eq(d.orgId, orgId) : undefined, gte(d.dialedAt, lookback), lt(d.dialedAt, end)));
}

export function conversationActivityStatement(db: Db, orgId: string | null, start: Date, end: Date) {
  const c = schema.dialerConnects;
  const lookback = new Date(start.getTime() - DIALER_IDLE_MS);
  return db
    .select({ userId: c.userId, bridgedAt: c.bridgedAt, endedAt: c.endedAt })
    .from(c)
    .where(and(orgId ? eq(c.orgId, orgId) : undefined, lt(c.bridgedAt, end), or(isNull(c.endedAt), gte(c.endedAt, lookback))));
}

/** Dials and conversations whose 15-minute window can reach [start, end) —
 *  one org's, or every org's (orgId null: the Salesforce worker). */
export async function loadActivity(db: Db, orgId: string | null, start: Date, end: Date): Promise<ActivitySpan[]> {
  const [dials, talks] = await Promise.all([
    dialActivityStatement(db, orgId, start, end),
    conversationActivityStatement(db, orgId, start, end),
  ]);
  return [
    ...dials.map((r) => ({ userId: r.userId, start: r.dialedAt, end: r.dialedAt })),
    ...talks.map((r) => ({ userId: r.userId, start: r.bridgedAt, end: r.endedAt })),
  ];
}
```

- `loadTalkTimeReport` loads legs, talk rows and
  `loadActivity(db, orgId, range.start, range.end)` in parallel, then calls
  `dialerSecondsByUserDay(legs, activity, range.days, now)`.
- Update the file's header comment: there are four reads now.

- [ ] **Step 6: Admin screen copy (`TalkTimePanel.tsx`)**

- Replace "On dialer is how long the rep&rsquo;s line was open on the power
  dialer." with the exact Global Constraints sentence. Write the apostrophe as
  `&rsquo;`, as the file does.
- Update the line-29 doc comment the same way.
- Update the TalkTimePanel test only if it asserts the old text.

- [ ] **Step 7: Run the tests and confirm they pass, then typecheck**

Run: `cd services/cti-api && npx vitest run src/reports && npx tsc --noEmit -p .`
Then: `cd apps/cti-web && npx vitest run src/components/TalkTimePanel.test.tsx`

`dialer-time-plan.ts` will now fail the typecheck. That is expected and is
Task 2's job: note it in the report, and do NOT change salesforce/ files here.

- [ ] **Step 8: Commit**

```bash
git add services/cti-api/src/dialer/idle.ts services/cti-api/src/reports apps/cti-web/src/components/TalkTimePanel.tsx apps/cti-web/src/components/TalkTimePanel.test.tsx
git commit -m "feat(talk-time): time on the dialer counts only within 15 minutes of a dial or a conversation"
```

---

### Task 2: The Salesforce Tasks use the new number, over 14 days

**Files:**
- Modify: `services/cti-api/src/salesforce/dialer-time-plan.ts`, `dialer-time-store.ts`, `dialer-time-worker.ts`, `dialer-time-client.ts`
- Modify: `services/cti-api/src/config.ts` (only the `DIALER_TIME_TASKS` comment: "catches up the last 3 days" becomes "the last 14 days")
- Test: `dialer-time-plan.test.ts`, `dialer-time-store.test.ts`, `dialer-time-worker.test.ts`, `dialer-time-client.test.ts`

**Interfaces:**
- Consumes (Task 1):
  - `dialerSecondsByUserDay(legs, activity, days, now)`;
  - `ActivitySpan`;
  - `loadActivity(db, orgId | null, start, end)` from `../reports/talk-time-query.js`.
- Produces:
  - `planDialerTimeWrites({ legs, activity, days, now, rows })`;
  - `DialerTimeStore.loadActivity(start, end): Promise<ActivitySpan[]>`;
  - `updateDialerTimeTask(userId, taskId, day, seconds)`;
  - `dialerTimeDescription(day)`.

- [ ] **Step 1: Write the failing tests**
- **plan:** `DIALER_TIME_WINDOW_DAYS` is 14. `windowDays(now)` returns 14 days
  ending today, oldest first. `planDialerTimeWrites` passes `activity` through:
  - a rep with a leg but no activity gets no create;
  - an existing Task for such a day is corrected to 0;
  - a leg with a dial gets the 15-minute number.

  Update the existing plan tests so every leg also has activity covering it,
  so their expectations hold. The simplest way is a conversation spanning the
  leg.
- **client:** `dialerTimeDescription('2026-10-05')` equals the exact Global
  Constraints Description. `buildDialerTimeTaskFields` uses it.
  `updateDialerTimeTask(userId, taskId, day, seconds)` PATCHes exactly
  `{ CallDurationInSeconds: seconds, Description: dialerTimeDescription(day) }`.
  The 404 and deleted-code paths are unchanged.
- **store:** `liveDialerTimeStore(db).loadActivity` is wired to
  `loadActivity(db, null, start, end)`. If the store test only pins SQL,
  assert that the rendered dial statement for the all-orgs call has no
  `org_id` predicate. Task 1 already covers that statement, so a light check
  is enough.
- **worker:**
  - The in-memory store gets `loadActivity`.
  - A tick loads activity over the same `[start, end)` as legs: the first
    window day's start, through the day after the last.
  - The plan receives that activity.
  - The adopt path (`findDialerTimeTask` found a Task) and the
    known-Task-id path both call `updateDialerTimeTask(userId, taskId, day, seconds)`
    with the day.
  - Update the existing expectations that assumed 3 days.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd services/cti-api && npx vitest run src/salesforce/dialer-time-*.test.ts`

- [ ] **Step 3: Implement**
- **plan:**
  - Set `DIALER_TIME_WINDOW_DAYS = 14`. Its comment: "two weeks: the
    idle-cutoff deploy rewrites every day since the feature began, and a write
    that keeps failing (a rep must reconnect Salesforce) keeps converging for
    two weeks".
  - Add `activity: readonly ActivitySpan[]` to the input and pass it to
    `dialerSecondsByUserDay`.
  - The header comment now describes "the line open AND something happened in
    the last 15 minutes".
- **store:**
  - Add `loadActivity` to the interface and the live store.
  - Recheck `LEG_LOOKBACK_MS` (3 days before the window start). It is still
    correct with a 14-day window, so leave it.
- **worker:**
  - `runDialerTimeTick` loads legs, rows and activity: legs and activity in
    parallel over the same start/end.
  - Pass `w.day` to both `updateDialerTimeTask` calls.
  - Header comment: "the last 14 Pacific days" and the new meaning.
- **client:**
  - Add `export function dialerTimeDescription(day: string): string`.
  - Use it in `buildDialerTimeTaskFields`.
  - Change `updateDialerTimeTask`'s signature and body.
  - Header comment: drop "(line open)".
- **config.ts:** update the `DIALER_TIME_TASKS` comment only.

- [ ] **Step 4: Run all tests, then typecheck**

Run: `cd services/cti-api && npx vitest run src/salesforce src/reports && npx tsc --noEmit -p .`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/salesforce services/cti-api/src/config.ts
git commit -m "feat(dialer-time): Salesforce Tasks carry active time only and re-sync the last 14 days"
```

---

### Task 3: Hang up idle lines (server)

**Files:**
- Create: `packages/db/migrations/0054_dialer_stop_reason.sql`, `packages/db/src/migration-0054.test.ts`
- Modify: `packages/db/src/schema.ts` (dialerSessions + the stop-reason constants)
- Modify: `services/cti-api/src/dialer/engine.ts` (`stopSession`)
- Create: `services/cti-api/src/dialer/idle-runs.ts`, `services/cti-api/src/dialer/idle-runs.test.ts`
- Modify: `services/cti-api/src/config.ts` (+ its test, if one pins the switches), `services/cti-api/src/server.ts`
- Test: `services/cti-api/src/dialer/engine.test.ts` (stopSession reason)

**Interfaces:**
- Consumes: `DIALER_IDLE_MS` (Task 1, `dialer/idle.ts`).
- Produces:
  - `DIALER_STOP_REASONS = ['idle'] as const` and `type DialerStopReason`,
    exported from `@cti/db`;
  - `dialerSessions.stopReason`;
  - `stopSession(sessionId, deps, opts?: { reason?: DialerStopReason })`;
  - `maybeStartIdleRunLoop(cfg)`.

- [ ] **Step 1: Migration, test first**

Copy the shape of `migration-0049.test.ts`: read the file from disk, split it
into statements, and pin:
- `SET LOCAL lock_timeout = '5s'`;
- the exact `ALTER TABLE` from Global Constraints;
- that schema.ts's `dialerSessions` has a `stop_reason` text column
  (`getTableConfig`).

The migration file gets a header comment in the 0046 style:
- what the column is: why a run stopped, null = the rep, or anything else
  that does not say;
- `'idle'` = the 15-minute cut (dialer/idle-runs.ts);
- that it is nullable with no default, so adding it is instant.

Check `migration-files.ts` / `migration-files.test.ts`. If migrations are
listed or counted anywhere, add 0054.

- [ ] **Step 2: Schema**

```ts
/** Every stop_reason a dialer_sessions row can hold (migration 0054's CHECK). */
export const DIALER_STOP_REASONS = ['idle'] as const;
export type DialerStopReason = (typeof DIALER_STOP_REASONS)[number];
```

Add to `dialerSessions`, after `runSize`, with a doc comment:
`stopReason: text('stop_reason').$type<DialerStopReason>(),`
The comment: "Why the run stopped when the CTI stopped it: 'idle' = 15
minutes with nothing happening on an open line (dialer/idle-runs.ts). NULL:
the rep's Stop, or any other end (migration 0054)."

Make sure `@cti/db` exports the constant and the type, as it does
`DIALER_REP_LEG_END_SOURCES`.

- [ ] **Step 3: `stopSession` records the reason, test first**

engine.test.ts, following how the file's existing stopSession tests
inspect DB writes:
- `stopSession(id, deps, { reason: 'idle' })` writes `status: 'stopped'` AND
  `stopReason: 'idle'`;
- `stopSession(id, deps)` writes `stopReason: null`.

Implementation:
- Add `opts: { reason?: DialerStopReason } = {}`.
- Replace `await setSession(deps, sessionId, 'stopped');` in `stopSession`
  with a direct update setting
  `{ status: 'stopped', stopReason: opts.reason ?? null, updatedAt: new Date() }`.
- Keep the release-first / flip / hang-up-last ORDER and its comment exactly
  as they are.

- [ ] **Step 4: `dialer/idle-runs.ts`, test first**

Tests (`idle-runs.test.ts`):
- **`isIdleRun`:**
  - `{ live: false }`, last activity exactly 15 min ago → true;
  - 14:59 → false;
  - `{ live: true }`, 3 h ago → false.
- **`idleRunCandidatesStatement()`:** the rendered SQL is pinned. Assert
  these substrings:
  - `join dialer_rep_legs l on l.session_id = s.id and l.ended_at is null`;
  - `left join dialer_queue_items i on i.session_id = s.id`;
  - `where s.status in ('active', 'paused')`;
  - `greatest(s.updated_at, max(l.joined_at), max(i.updated_at)) as last_activity_at`;
  - `coalesce(bool_or(i.status = 'dialing' or (i.status = 'connected' and i.prospect_ended_at is null)), false) as live`;
  - `group by s.id, s.user_id, s.updated_at`.
- **`stopIdleRunsTick(deps)`**, with `deps = { candidates: () => Promise<IdleCandidate[]>, now: () => Date, stop: (sessionId) => Promise<unknown> }`:
  - it stops exactly the idle candidates, by id;
  - it skips live and recent ones;
  - one `stop` that rejects is logged and the next idle run is still stopped;
  - it returns the number stopped;
  - the log line `[dialer] idle run stopped` carries
    `{ sessionId, userId, idleMinutes }` and nothing else. Assert with a
    `console.info` spy.
- **`last_activity_at`:** a raw row whose `last_activity_at` arrives as an
  ISO string (drizzle's raw execute may not parse timestamptz) is read
  correctly. Test the row mapper `toCandidate(raw)`: it accepts a Date or a
  string, and `live` as a boolean or the strings `'t'`/`'true'`.
- **`maybeStartIdleRunLoop`:** with `{ DIALER_IDLE_STOP: 'off' }` it returns
  null and never calls `start`. With `'on'` it calls
  `start(IDLE_CHECK_INTERVAL_MS)`.

Implementation:
- Shape: header docblock explaining the rule and why stop rather than pause
  (copy the spec's reasoning briefly). Exports:
  - `IDLE_CHECK_INTERVAL_MS = 30_000`;
  - `interface IdleCandidate { sessionId: string; userId: string; lastActivityAt: Date; live: boolean }`;
  - `isIdleRun(c, now)`;
  - `idleRunCandidatesStatement(): SQL` (the spec's SQL, via drizzle `sql`);
  - `toCandidate(raw)`;
  - `interface IdleRunDeps`;
  - `stopIdleRunsTick(deps)`;
  - `startIdleRunLoop(intervalMs = IDLE_CHECK_INTERVAL_MS, deps = liveIdleRunDeps)`,
    single-flight `setInterval`, like `startRepLegReconcileLoop`;
  - `maybeStartIdleRunLoop(cfg: Pick<AppConfig, 'DIALER_IDLE_STOP'>, start = startIdleRunLoop)`.
- Live deps:
  - `candidates` runs `db.execute(idleRunCandidatesStatement())` and maps the
    rows through `toCandidate`;
  - `stop` is `(id) => stopSession(id, buildEngineDeps(), { reason: 'idle' })`.
    Import `buildEngineDeps` from where `followup-worker.ts` gets it.
- Log line:
  `console.info('[dialer] idle run stopped', { sessionId, userId, idleMinutes: Math.floor((now - lastActivityAt) / 60_000) })`.
- Stop failures:
  `console.error('[dialer] idle run stop failed', { sessionId, err: (err as Error).message })`.

- [ ] **Step 5: Config and wiring**

config.ts, next to `DIALER_TIME_TASKS`, with a comment in the same style:

```ts
  /**
   * Kill switch for hanging up idle power-dial lines (dialer/idle-runs.ts):
   * a run whose open line had no dial, conversation, or rep action for 15
   * minutes is stopped. `off` = the loop is never started. Default `on`;
   * strict enum like NO_ANSWER_CHATTER.
   */
  DIALER_IDLE_STOP: z.enum(['on', 'off']).default('on'),
```

- If a config test enumerates defaults or strict enums (search for
  `DIALER_TIME_TASKS` in `config*.test.ts`), add the new switch the same way.
- In server.ts:
  - `const idleRunTimer = maybeStartIdleRunLoop(cfg);` next to the rep-leg
    reconcile loop, with a one-line comment;
  - `if (idleRunTimer) clearInterval(idleRunTimer);` in `close`.

- [ ] **Step 6: Run all tests, then typecheck**

Run:
- `cd packages/db && npx vitest run`
- `cd services/cti-api && npx vitest run src/dialer src/config* && npx tsc --noEmit -p .`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db services/cti-api/src/dialer services/cti-api/src/config.ts services/cti-api/src/config*.test.ts services/cti-api/src/server.ts
git commit -m "feat(dialer): stop a run whose open line had nothing happen for 15 minutes (stop_reason idle)"
```

---

### Task 4: The softphone says why, and the runbooks

**Files:**
- Modify: `apps/cti-web/src/dialer-api.ts` (`DialerSession.stopReason`)
- Modify: `apps/cti-web/src/components/DialerPanel.tsx` (run summary)
- Test: `apps/cti-web/src/components/DialerPanel.test.tsx`
- Modify: `docs/runbooks/dialer-time-tasks.md`, `docs/runbooks/talk-time-report.md`, `docs/runbooks/dialer-cadence.md` (or whichever runbook covers live power-dial operation; add a short "Idle lines" section)

**Interfaces:**
- Consumes: the session GET returns the full `dialer_sessions` row, so the
  JSON now carries `stopReason` (Task 3).

- [ ] **Step 1: Failing test**

In `DialerPanel.test.tsx`, using the file's existing way of rendering a
terminal (stopped) run:
- A stopped run with `stopReason: 'idle'` shows
  `Stopped after 15 minutes with no dialing.` under "Run stopped".
- A stopped run with `stopReason: null` or absent does not.
- A `done` run with `stopReason: 'idle'` (impossible, but guard it) does not.

- [ ] **Step 2: Implement**
- `dialer-api.ts`: `stopReason?: 'idle' | null;` on `DialerSession`. Doc
  comment: "Why the server stopped the run: 'idle' = 15 minutes with nothing
  happening on the open line. Absent: an older server."
- In `DialerPanel.tsx`, in the `dp-summary` block, right after the title div:

```tsx
{view.session.status === 'stopped' && view.session.stopReason === 'idle' && (
  <div className="dp-summary-meta">Stopped after 15 minutes with no dialing.</div>
)}
```

- [ ] **Step 3: Run the tests and typecheck**

Run: `cd apps/cti-web && npx vitest run src/components/DialerPanel*.test.tsx && npx tsc --noEmit -p .`

- [ ] **Step 4: Runbooks**
- **`dialer-time-tasks.md`:**
  - The number is now active time: the line open AND a dial or conversation
    in the last 15 minutes. Link the spec.
  - The window is 14 days.
  - The Description wording.
  - The idle-cutoff deploy rewrote every day since 2026-10-01.
  - A SQL recipe to compare `dialer_time_tasks.synced_seconds` with the admin
    screen. Reuse any existing recipe in the file; otherwise skip it.
- **`talk-time-report.md`:** "On dialer" means active time, with the same
  sentence as the admin screen, and how it is computed (legs ∩ windows).
- **The power-dial runbook** gets an "Idle lines" section:
  - the rule (15 minutes, what counts as something happening);
  - the log line `[dialer] idle run stopped`;
  - `dialer_sessions.stop_reason = 'idle'`;
  - what the rep sees;
  - the kill switch `DIALER_IDLE_STOP=off`;
  - a query listing today's idle stops:
    `select id, user_id, updated_at from dialer_sessions where stop_reason = 'idle' and updated_at >= now() - interval '1 day' order by updated_at;`

- [ ] **Step 5: Commit**

```bash
git add apps/cti-web/src/dialer-api.ts apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/components/DialerPanel.test.tsx docs/runbooks
git commit -m "feat(cti-web): a run stopped for idling says so; runbooks for the idle cutoff"
```
