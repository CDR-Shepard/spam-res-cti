# Power-dialer time in Salesforce — design

**Date:** 2026-10-02 · **Status:** approved in chat
**Builds on:** `2026-10-01-talk-time-report-design.md` (its `dialer_rep_legs`
table and `dialerSecondsByUserDay` are the source of the number).

## Why

The user: "i need it pulling into a report in salesforce". Time on the power
dialer (the rep's line open: join → leave, dialing + hold music + talking)
exists only in the CTI (`dialer_rep_legs`, the admin Talk time screen).
Salesforce has no record of it, so no Salesforce report can show it.

## Decisions (user, 2026-10-02)

1. It shows in **both** the reps' existing talk-time report
   (`00OUS000007DAyP2AW`) as its own row, AND a new manager report: date
   range, one row per rep.
2. **Approach: one "Power Dialer Time" Task per rep per Pacific day**, kept
   current every 5 minutes while they dial. (Rejected: a Task per sitting —
   time appears only after the rep stops, and overlapping legs double-count;
   a custom object — needs a metadata deploy and cannot sit in the existing
   Activity report.)
3. I edit the existing report's filter and create the new report in the
   user's Chrome after the Tasks are flowing.

## The Task

| Field | Value |
|---|---|
| `Subject` | `Power Dialer Time` (exact; both reports filter on it) |
| `Status` | `Completed` |
| `Priority` | `Normal` |
| `TaskSubtype` | `Task` — NOT `Call`, so call counts/metrics never include it |
| `ActivityDate` | the Pacific day (`YYYY-MM-DD`) the time belongs to |
| `CallDurationInSeconds` | the rep's merged line-open seconds for that day |
| `Description` | `Time on the power dialer (line open) on <day>, Pacific. Kept up to date by the CTI.` |
| `CTI_Origin__c` | `Power Dialer Time` (new `CTI_ORIGIN` value; Text(64) field) |
| Owner | the rep — created with the rep's own Salesforce connection, like every CTI Task |
| `WhoId` / `WhatId` | none — it belongs to no record, so no record timeline shows it |

No `CallType` / `CallDisposition`. If the marker is rejected (per-rep FLS,
`INVALID_FIELD`), retry once without it — same rule as `createCallTask`.

## The number

Exactly the admin report's "On dialer" for that rep and day:
`dialerSecondsByUserDay(legs, days, now)` from `reports/talk-time.ts` —
legs merged per rep so overlaps count once, split at Pacific midnight, an
open leg counted up to `now`. Seconds, integer.

## Sync worker — `salesforce/dialer-time-worker.ts`

Same shape as the other scan workers (deps injection, single-flight
`setInterval`, kill switch = loop never started).

- **Every 5 min** (`DIALER_TIME_INTERVAL_MS = 300_000`). Also once at start-up.
- **Window:** the last 3 Pacific days (today and the two before), so a leg
  that crosses midnight, closes late, or is reconciled up to 48 h later still
  lands on the right day's Task.
- **Per tick:** load legs overlapping the window (all orgs; `org_id`,
  `user_id`, `joined_at`, `ended_at`); compute seconds per (rep, day); load
  the `dialer_time_tasks` rows for those days; for each (rep, day) whose
  `next_attempt_at` is due: a Task is created only when seconds > 0 and the
  row is missing or its `synced_seconds` differs; an existing Task (one with a
  `salesforce_task_id`) is PATCHed whenever the computed number differs from
  what was last synced, including down to 0 — a day can fall back to 0 after
  the reconciler's 48 h fallback closes a leg, and Salesforce must converge to
  match, never a CREATE for 0 seconds:
  - **No Task id yet:** first look for one already in Salesforce (SOQL as the
    rep: `Subject = 'Power Dialer Time' AND ActivityDate = <day> AND OwnerId =
    <rep's sf_user_id>`, LIMIT 1) and adopt it; otherwise create it. Then
    stamp `salesforce_task_id` + `synced_seconds`. The lookup makes a crash
    between create and stamp harmless (next tick adopts, never duplicates).
  - **Task id known:** PATCH `CallDurationInSeconds` only, then stamp
    `synced_seconds`. A 404 (Task deleted in Salesforce) clears the id so the
    next tick recreates it.
- **Errors:** `SalesforceUnauthorizedError` (rep must reconnect) → skip, retry
  next tick, does not count. Any other error → `attempts + 1`,
  `next_attempt_at = now + backoff` (5 m, 15 m, 1 h, 3 h, 6 h, then 6 h),
  `last_error` = full text (DB only). Never gives up: the day's number must
  converge. Logs carry ids and Salesforce `errorCode`s only (the existing
  `sfErrorSummary` / `unexpectedErrorSummary`, moved to a shared
  `salesforce/error-summary.ts`) — never message bodies.
- A rep with no `salesforce_connections` row is skipped (logged once per tick
  with the user id).
- **Kill switch:** `DIALER_TIME_TASKS` (`on`|`off`, default `on`, strict enum).

## Data: `dialer_time_tasks` (migration 0049)

| column | notes |
|---|---|
| `id` uuid pk | |
| `org_id`, `user_id` | uuid, no FKs (like `dialer_rep_legs`) |
| `day` | text `YYYY-MM-DD`, the Pacific day |
| `salesforce_task_id` | null until created/adopted |
| `synced_seconds` | integer, null until first write |
| `attempts` integer default 0, `next_attempt_at` timestamptz default now(), `last_error` text | backoff bookkeeping |
| `created_at`, `updated_at` | |

FULL unique index on (`user_id`, `day`); inserts use bare
`ON CONFLICT DO NOTHING` (the partial-index 42P10 gotcha).

## Reports (after deploy, in the user's Chrome, user-approved)

- **Existing `00OUS000007DAyP2AW`:** Subject filter `contains
  Outbound,Inbound` → `contains Outbound,Inbound,Power Dialer Time`. Each rep
  gets a "Power Dialer Time" row beside the call rows. Its grand total then
  adds dialer time to talk time — the rows, not the total, are the read.
- **New "Power Dialer Time by Rep":** Tasks and Events report; Subject
  equals `Power Dialer Time`; Date filter on Due Date (default This Week,
  any range); grouped by Assigned; Sum of Call Duration. Saved to the same
  folder as the existing report.

## History

None before the 2026-10-01 19:15 PT deploy: `dialer_rep_legs` starts there.
The worker's 3-day window writes Oct 1 (evening only) and Oct 2 on its first
run.

## Untouched

Talk-time numbers, call Tasks, the admin Talk time screen, compliance
counters, reputation.

## Testing

- Client: payload (Subject, TaskSubtype `Task`, no CallType, ActivityDate,
  duration, marker) and the marker-rejected retry; the PATCH; the lookup SOQL
  (escaped, exact filters).
- Pure diff: which (rep, day) pairs need a write — missing row, changed
  seconds, zero seconds skipped, backoff not due skipped.
- Worker: create → stamp; adopt an existing Task; PATCH on change; 404 →
  id cleared; auth error not counted; other error backs off; no connection
  skipped; kill switch.
- SQL: rendered statements pinned (bare ON CONFLICT, window predicate).
- Live: after deploy, the reps dialing that day have a Task whose duration
  matches the admin Talk time screen's "On dialer" (± one tick).

## Out of scope

History before the deploy; a joined report; per-sitting detail in Salesforce.
