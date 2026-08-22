# Follow-up Rollover: 2 Attempts, Daily Cap, Queued Creation — Design Spec

**Date:** 2026-08-22
**Status:** Approved (Approach 2 — queued rollover jobs)
**Scope:** `services/cti-api` (engine + new worker) and `apps/cti-web` (DialerPanel). This is
sub-project **B** of the larger power-dialer request, with **C** (human-only pop) and **E**
(queued, retrying task creation) folded in because they are small and land on the same code.

## Problem

The power dialer rolls a rep's open **Follow-up** task over after a **single** miss, creates the
replacement for the next business day unconditionally, and does the Salesforce work inline in the
Twilio status webhook. Three consequences the business wants changed:

1. A task is closed out after one try. The rule should be **two calls** per record per day.
2. There is no limit on how many follow-ups land on one day. Reps drown. Cap it at **100 per rep
   per day**; overflow must spill onto the *following* business day (and onward).
3. Salesforce calls inside the webhook are slow, unretried, and — for the cap — racy. Creation
   must be **queued and retried** so a burst from the dialer cannot lose tasks.

Separately, the record screen-pops while it is still *ringing*, so reps get pulled into a
record for a call that goes to voicemail. They only want to be popped for a **human**.

## Goal

One sentence: **A Follow-up task rolls over only after the dialer has tried the record twice
that day, lands on the first business day with fewer than 100 of the rep's follow-ups, is
created through a retrying queue, and the record pops only when a human is on the line.**

## Decisions (locked, with the user)

| Question | Decision |
| --- | --- |
| What is one "attempt"? | One **pass** through the record: Mobile, then the existing Phone fallback on a true ring-out. |
| How does the 2nd attempt happen? | **Auto-requeue at the end of the same run.** Counter lives in the run; a rep who stops after one pass leaves those tasks open (no rollover). |
| Spacing between attempts | A **5-minute floor**: an attempt-2 row is not dialed until 5 min after its attempt-1 ended. If only retries remain, the run waits and shows a countdown; the worker tick nudges it when due. |
| What counts as a miss? | Anything that did not reach a human: rang out with no numbers left, busy, voicemail/machine, failed. |
| Cap counting basis | **All** open Follow-up tasks due that day for that owner, including hand-created ones (per the "30 set → only 70 more" example). |
| Cap value | `campaign_configs.followup_daily_cap` (the per-org config row, key `default`), default **100**. |
| Where the SF work runs | A **single-flight worker** draining a job table — not the webhook. |
| Pop rule | Only when the queue item becomes `connected`. AMD hangs up machines before bridging, so `connected` ⇒ human. |

## Data model (additive only; migration is backward-compatible)

### `dialer_queue_items` — three new columns
- `attempt integer NOT NULL DEFAULT 1` — 1 or 2.
- `primary_number text`, `secondary_number text` — the record's Mobile/Phone **as resolved at
  creation**, never mutated. Today the fallback overwrites `to_number`/`fallback_number`; the
  immutable pair lets a retry restore "Mobile first, Phone fallback" without a Salesforce call.
- `retry_not_before timestamptz` — set on attempt-2 rows to (attempt-1 end + 5 min); null otherwise.

A retry is a **new row** (same `record_id`, `attempt = 2`, `ordinal = max(ordinal)+1`). One row
still equals one call ID and one outcome, which every existing webhook path assumes.

### `followup_rollover_jobs` — new table (mirrors `salesforce_sync_jobs`)
```
id uuid pk
org_id uuid, user_id uuid, sf_owner_id text
record_id text, object_type text, session_id uuid (nullable — for the run summary)
from_date text            -- org-local YYYY-MM-DD of the 2nd miss (todayIso from EngineDeps)
status enum pending|in_flight|succeeded|failed
attempts int default 0, last_error text
next_attempt_at timestamptz default now(), completed_at timestamptz
completed_task_id text, created_task_id text, target_date text (the day the copy landed on)
created_at, updated_at timestamptz
UNIQUE (user_id, record_id, from_date)   -- duplicate webhook ⇒ onConflictDoNothing
INDEX (status, next_attempt_at)
```

### `campaign_configs` — one new column
- `followup_daily_cap integer NOT NULL DEFAULT 100` (beside `max_attempts`, `per_customer_max_attempts`; loaded with the same `(org_id, key='default')` lookup the firewall uses).

## Engine (`services/cti-api/src/dialer/engine.ts`)

`handleDialOutcome` on a **miss** (any non-connected terminal outcome, after the existing
Mobile→Phone fallback has been exhausted):
- `attempt = 1` → inside the **same compare-and-swap** that flips the row out of `dialing`,
  insert the attempt-2 row (numbers restored from `primary_number`/`secondary_number`,
  `retry_not_before = now + 5 min`, `ordinal = max+1`). **Do not roll over.**
- `attempt = 2` → `INSERT … ON CONFLICT DO NOTHING` into `followup_rollover_jobs`. Then advance
  as today.

A duplicated Twilio webhook cannot insert two retries or two jobs: the retry insert is guarded by
the CAS (only the invocation that wins the `dialing →` flip inserts), the job by the unique index.

`advanceSession` / `nextPendingItem`: a pending row with `retry_not_before > now` is **not
eligible**. If the only pending rows are ineligible retries, the session returns
`{ action: 'waiting_retry', nextRetryAt }` and is left `active`. The worker tick (below) calls
`advanceSession` for any active session whose earliest `retry_not_before` has passed.

`connected` path is unchanged (bridge, sticky). A connect never requeues.

Per-customer attempt ceilings and the pool-DID warmup/velocity path apply to attempt-2 dials
exactly as to any other dial — no bypass.

## Rollover worker (`services/cti-api/src/salesforce/followup-worker.ts`)

A `setInterval` tick, **single-flight**, scheduled beside the existing sync worker. Per tick:
reap `in_flight` jobs older than 2 min back to `pending`; nudge retry-eligible sessions; then
claim `pending` jobs with `next_attempt_at <= now`, oldest first, mark `in_flight`, process.
Retry policy: 8 attempts, backoff 30s·2ⁿ. Terminal: `succeeded` or `failed`.

Per job:
1. **Find** the rep's open Follow-up task on the record — the existing `pickFollowUpTask`
   lookup (`OwnerId = rep`, subject matches `/follow[ -]?up/i`, earliest due). **None → mark
   `succeeded` with note `no-task`; create nothing.**
2. **Pick the day.** `candidate = nextBusinessDay(from_date)`. Loop (max 30 business days):
   `count = soqlCount("SELECT COUNT() FROM Task WHERE OwnerId=:rep AND IsClosed=false AND
   ActivityDate=:candidate AND (Subject LIKE '%Follow-up%' OR …)")`. If `count < cap` → use it;
   else `candidate = nextBusinessDay(candidate)`. Exhausted → `failed`, error
   `"no business day with room within 30 days"`.
   *New helper:* `soqlCount(userId, soql)` reads `totalSize` (the existing `soqlQuery` returns
   `records`, which is empty for `COUNT()`).
3. **Create first, then complete.** POST the copy due `candidate` (existing
   `followUpCopyFields`); stamp `created_task_id` **immediately**; then PATCH the original
   `Status = Completed`; stamp `completed_task_id`.
4. Mark `succeeded`.

**Idempotent retry:** if a job already has `created_task_id` when claimed, step 3 skips the
create and only completes. A crash between create and complete therefore never yields a
duplicate task.

**Cap serialization:** single-flight ⇒ two rollovers cannot both read 99 and both land on the
same day. A rep hand-creating tasks in Salesforce concurrently can push a day to 101; the cap is
a ceiling we honor, not a lock we hold on Salesforce.

## Error handling

- Enqueue (webhook): one idempotent insert; on error, log and still ack/advance — the dial must
  never be blocked by the rollover.
- Worker: `SalesforceUnauthorizedError` → `failed` immediately, error `"reconnect Salesforce"`
  (cannot self-heal; do not burn retries). Other errors → backoff and retry. Day-search
  exhaustion → `failed` with the exact message.
- Retry rows stuck by a stopped run: the run ending (Stop, complete, or remote stop) leaves
  un-dialed attempt-2 rows non-terminal only until the session is `stopped`/`done`, after which
  they are ignored. No rollover is enqueued for them (one pass only ⇒ task stays open, by design).

## Client (`apps/cti-web/src/components/DialerPanel.tsx`)

- **Pop rule:** replace "pop when `currentItem` changes" with a pure
  `shouldScreenPop(item): boolean` = `item.status === 'connected'`, still once per item id.
- **Current record card:** show `Attempt 2 of 2` when `item.attempt === 2`.
- **Waiting state:** when the session view reports `waitingRetry` with `nextRetryAt`, show
  `Next retry in m:ss` in place of the dial status.
- **Run summary line:** `"{n} follow-ups moved to tomorrow · {m} pushed later (daily limit)"` —
  derived from the session's rollover job outcomes (`GET /dialer/sessions/:id` gains
  `rollovers: { moved, pushed, failed }`).

## Admin visibility

`GET /admin/followup-rollovers?since=today` → `{ succeeded, failed: [{ recordId, userEmail,
lastError, attempts }] }`. The admin ("Numbers") panel shows one line: **Follow-up rollovers —
{succeeded} ok · {failed} failed**, expandable to the failure list. This is the only way an
un-moved task is caught before the rep notices a day later.

## Testing

Pure logic first (node test env, no Salesforce/Twilio):
- `pickRolloverDay(counts, cal, cap, from)` — first day with room; skips weekends/holidays;
  respects the 30-day bound.
- Engine: attempt-1 miss inserts an attempt-2 row at `max+1` with restored numbers and
  `retry_not_before`; attempt-2 miss enqueues **exactly one** job under a duplicated webhook;
  `connected` never requeues; ineligible retries yield `waiting_retry`.
- Worker (fake SF): create→complete ordering; crash-after-create retry completes without a
  second create; `SalesforceUnauthorizedError` fails fast; `no-task` succeeds with no writes.
- `soqlCount` reads `totalSize`.
- Client: `shouldScreenPop` only for `connected` (pure); SSR render of the attempt badge and the
  retry countdown.

Live (user-run): the **CTI DIAL TEST** list (3 test opps → the benign auto-answer target, which
AMD reads as a machine ⇒ guaranteed miss). Expect each record tried twice (5-min floor visible),
each task rolled over once. Then set the test org's `followup_daily_cap = 1` and confirm the
2nd and 3rd rollovers land on successive later business days.

## Out of scope (explicit — separate specs)

- **A** — dialing Task list views from the rep's *own* numbers with smart splitting (items 1, 3).
- **D** — ownership gate: never create a task on a record where the caller is not Lead Owner /
  Opportunity Owner / `Lead_Manager__c` / Task assignee (item 5). Its single check slots in
  before worker step 3. `Lead_Manager__c` is not yet referenced anywhere in this repo; confirm
  the field exists on Opportunity before building D.
- **#8 — number registration** is an ops task, not a feature: the Twilio account already has
  an approved **Femund LLC** business profile and an approved **SHAKEN/STIR** trust product,
  but only **2 of 29 numbers** are assigned to them. Assigning all 29 yields A-attestation on
  every call with no business name displayed (no CNAM product exists, and none should be added
  given the "just the number" requirement). One script; tracked separately.
- Cross-run attempt counting ("a later run still counts") — not chosen.
