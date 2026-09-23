# Dialer Cadence & Controls: Design

**Date:** 2026-09-23
**Goal:** Make the power dialer treat a *person* as the unit of contact — across
reps, runs and call types — and give the rep the controls a live call needs.
**Sub-project 1 of 4** from the 2026-09-23 change list. Voicemail drop (2),
texting (3) and parallel dialing (4) are separate specs.

## What changes, in one paragraph

Every dial the company makes to a person — power dialer or click-to-dial, any
rep — is one **contact history**. Three rules read it: nobody dials the same
person within **3 hours** (power dialer only; a run's own end-of-run retry is
exempt); nobody dials a number in a **capped state** more than **3 times in 24
hours** (everywhere, it is the law); and a follow-up task **rolls forward the
moment its owner's second dial of the day misses**, whatever run or call type
those dials were. Two reps on one list work it together from one shared
position and never dial the same person at once. A record's second number is
tried three hours later, not two seconds later, and never once the person has
answered on the other. When a prospect hangs up the rep chooses Redial or
Resume; while they are on the line the rep can End the call without moving on.
An inbound call pops the person's Opportunity, Deal or Lead — never the Account.

## Why (what the data says, 2026-09-21..23)

- **The end-of-run retry almost never happens.** In two days, 753 second
  attempts across 48 stopped runs were never dialed, against 129 that were.
  Reps run many short runs (Scott: 12 stopped runs in one afternoon). The
  follow-up rollover fires only on a second miss *in the same run*, so first-miss
  tasks mostly never move — while the end-of-run "No answer" Chatter post fires
  on stop regardless. Scott's `Follow-up (Jeremiah Opp)` task (due 9/18) was
  dialed once yesterday and once today, missed both, and stayed put with two
  Chatter posts under it.
- **"Already worked" is a calendar-day rule** (`dialer/already-worked.ts`): a
  record the team dialed at 08:00 is skipped until midnight. The user wants it
  dialable again after three hours.
- **The immediate Mobile→Phone retry** (`engine.ts:536`, a true no-answer
  re-dials the record's Phone within seconds) reads to prospects as a double
  call and to reps as "it redialed him automatically."
- **A prospect hanging up is invisible.** `handleDialOutcome` ignores the
  terminal callback for a `connected` item; the screen says "connected" until
  the rep presses Next. The only cue is the hold music returning.
- **Inbound pops the Contact** when a Contact matches (`findByPhone` prefers
  Contact over Lead; `dialClientWithCallerParams` passes that id), and a Contact
  page is the Account's page in practice. The open Opportunity we already look
  up for the after-call sync is not what gets popped.

## Decisions (rulings from the 2026-09-23 conversation)

| # | Ruling |
|---|---|
| 1 | Kill the immediate Mobile→Phone retry. The other number may be tried later (the end-of-run retry, a later day), never once the person has answered on either. |
| 2 | **3 hours** minimum between dials to the same person, org-wide, power dialer only. The same run's end-of-run retry is exempt. |
| 3 | **3 dials per rolling 24 hours** for numbers in states where that is law (FL, OK, WA, MD to start; counsel owns the list). Every dial by anyone counts. Power dialer skips; click-to-dial is blocked. |
| 4 | Rollover is **per day, per person, per task owner**: when the owner's second dial of the day to the person ends without a connect, the task rolls. Not per run. Other reps' dials do not count. |
| 5 | Two reps on one list **work it together**: one shared position, never the same person at once. |
| 6 | Prospect hangs up → **Redial / Resume**, never automatic. **End call** = hang up and pause on the record. |
| 7 | Inbound pop precedence: open **Opportunity → Deal → Lead → Contact**; never the Account. |

Not legal advice; the capped-state list and the "every dial counts" reading go
to counsel with the weekend-calling rules already on their desk.

---

## 1. Contact history (the one source of truth)

**Module:** `services/cti-api/src/dialer/contact-history.ts` — pure decisions
over rows read by `contact-history-live.ts` (same split as `fleet/auto-assign`).

**What a "person" is:** the union of the record's numbers (`primaryNumber`,
`secondaryNumber` on the queue item) and the record id. A dial matches the
person if it went to any of those numbers, or was logged against that record.

**Sources (read, never written by this module):**

| Source | Rows | Match on | Connect signal |
|---|---|---|---|
| `dialer_dial_attempts` (every power dial) | `org_id, user_id, session_id, to_number, dialed_at` + **new** `record_id`, `connected_at` | `to_number` in numbers OR `record_id` = record | `connected_at IS NOT NULL` |
| `calls` where `direction='outbound'` (every click-to-dial) | `org_id, user_id, normalized_to_number, salesforce_who_id, salesforce_what_id, disposition, created_at` | `normalized_to_number` in numbers OR who/what id = record | `disposition = 'Connected'` |

New indexes: `dialer_dial_attempts (org_id, record_id, dialed_at)` and
`calls (org_id, normalized_to_number, created_at)`; the existing
`dialer_dial_attempts_target_idx (org_id, to_number, dialed_at)` serves the
number match. Two indexed queries per check, window-bounded (24 h is the longest
any rule needs), so each check is a few rows and well under a millisecond.

**The read:** `dialsToPerson(db, orgId, person, since): Promise<Dial[]>` where
`Dial = { userId, sessionId: string | null, toNumber, at: Date, connected: boolean, source: 'dialer' | 'manual' }`.

**The decisions (pure, each with its own tests):**

- `cadenceVerdict(dials, now, { sessionId, capped })` →
  `'ok' | 'cooldown' | 'daily_cap'`.
  *cooldown:* any dial from a **different session** (or any manual dial) within
  3 h. Dials from `sessionId` itself do not count — that is the end-of-run
  retry and the rep's explicit Redial.
  *daily_cap:* `capped` and ≥ 3 dials (any source, any rep) in the last 24 h.
  `daily_cap` wins over `cooldown` when both apply.
- `rolloverDue(dials, ownerUserId, today)` → boolean: the owner has ≥ 2 dials
  today (org day, `dialer/org-day.ts`) to the person and none of them connected.
- `preferredNumber(dials, numbers)` → the number of the most recent connected
  dial that is one of `numbers`, else null.

**Where `connected_at` is written:** `handleDialOutcome`'s `connected` branch
updates the attempt row for the item (`dialer_dial_attempts.item_id = item.id`)
in the same transaction as the `connected` status write. Click-to-dial connects
are already the `Connected` disposition on `calls`.

**Capped states:** `packages/firewall/src/state-calling-rules.ts` gains
`DAILY_DIAL_CAP_STATES: ReadonlySet<string>` = `{'FL','OK','WA','MD'}` and
`isDailyCapped(state | null): boolean` (unknown state = not capped), resolved
through the same area-code→state map the calling-hours rules use. The rolling
24-hour window is the choice; a calendar day would let 3 dials at 23:00 and 3
more at 01:00.

---

## 2. Where the rules bite

### 2.1 The power dialer (engine)

In `advanceSession`, immediately before `pickDid` (beside the calling-hours
check, same `setItemIfPending` skip idiom), the engine calls a new injected
dep `deps.cadence(person, sessionId)` → `cadenceVerdict` plus the cross-run
check below. Outcomes stamped on the skipped row:

| `outcome` | Summary / confirm-block label |
|---|---|
| `cooldown` | "called in the last 3 h" |
| `daily_cap` | "daily limit (state law)" |
| `in_progress_elsewhere` | "in progress in another run" |

These join `skipBreakdown` and the existing skip labels in
`DialerPanel.tsx` (`skipLabel`). The start-of-run line already lists skips by
reason; nothing new to design there.

**Cross-run claim:** a record whose number (or record id) is `dialing` or
`connected` on an item in any *other* session with status `active`/`paused` in
the org is skipped as `in_progress_elsewhere`. Enforced inside the existing
pending→dialing transaction: the advisory lock becomes
`pg_advisory_xact_lock(hashtext('dial:' || <primary number>))` **in addition
to** the per-session lock, and the in-flight-elsewhere query runs inside the
lock so two engines advancing in the same instant cannot both originate.

**Already-worked at creation** (`already-worked.ts`) becomes "dialed in the
last 3 hours" (`workedRecentlyNumbers`, window = the same 3 h constant), keeps
its outcome name `already_worked` for the confirm block, and remains an
estimate: the dial-time gate is authoritative.

### 2.2 Click-to-dial (firewall)

`packages/firewall/src/evaluate.ts` gains one rule: if the destination's state
is daily-capped and the org has ≥ 3 dials to the number in the last 24 h (the
contact-history read, both sources), the verdict is **BLOCK** with reason
`daily_cap` and the message *"This number has been called 3 times in the last
24 hours; state law limits calls to 3 per day."* The 3-hour courtesy rule does
**not** apply to click-to-dial: a rep calling back someone who asked to be
called back must never be stopped.

### 2.3 Rollover (per day, per owner)

`handleDialOutcome`'s miss path replaces its attempt/stopped truth table with:

- **requeue** (unchanged): first miss, a number to retry with, run live →
  attempt-2 row at the end of the run (5-minute floor). Attempt 2 dials the
  **other** number when the record has one (see §3).
- **enqueue rollover**: `rolloverDue(dialsByThisRep, session.userId, today)`
  — i.e. this rep now has ≥ 2 dials today to the person, none connected.
  Independent of `attempt` and of session status. The rollover job key
  (`user, sourceTaskId ?? record, fromDate`) stays; two triggers in one day
  collapse to one job. `followupEligible` and the ownership gate in the worker
  are unchanged.

**Click-to-dial misses trigger it too.** In `salesforce/sync.ts`, after an
outbound call syncs with a disposition other than `Connected`, if
`rolloverDue(dialsByThisRep, call.userId, today)` then
`enqueueFollowupRollover({ recordId: whoId ?? whatId, sourceTaskId: null, … })`.
`Wrong number` is a miss like any other for this rule; a wrong number's
follow-up rolling forward is the lesser evil next to it silently going stale
(flagged for a later ruling).

**Consequence to state plainly:** a run stopped after one pass no longer
strands its tasks. The rep's next dial to the person that day — from any run
or a manual call — rolls the task if it misses. One dial in a day leaves the
task open.

---

## 3. The second number

- `resolveDialNumber` keeps returning `{ e164, fallbackE164 }`; `buildQueueRows`
  keeps writing `primaryNumber`/`secondaryNumber`. **`fallbackNumber` and
  `toNumber` on the attempt-1 row are the primary only** — the immediate
  fallback path in `handleDialOutcome` (`engine.ts:536-566`) is deleted, and
  `no_answer` becomes a plain miss like the others.
- **Attempt 2 dials the other number:** the requeue insert sets
  `toNumber = item.secondaryNumber ?? item.primaryNumber`.
- **Once they've answered, that's their number.** At queue creation, for each
  resolved record with two numbers, `preferredNumber(history, [e164, fallbackE164])`
  (any rep, any time — one batched read per run, keyed by the records' numbers)
  replaces the pair: `primaryNumber := preferred, secondaryNumber := null`.
  Within a run, a connect on attempt 1 ends the record; there is no attempt 2 to
  worry about.

---

## 4. Two reps, one list

- `dialer_sessions.list_view_id text` (new; null for record-handoff runs) and
  `dialer_queue_items.list_position integer` (new; the record's index in the
  list view at pull time — **not** the queue ordinal, which rotation changes).
- **Start position:** creating a run from list view *L* reads
  `max(list_position)` over attempts on *L* in the last 12 hours (org-wide:
  `dialer_dial_attempts` joined to items on `list_view_id`). The queue is the
  list in list order **rotated to begin after that position**; the records
  before it go to the end. If nobody has dialed *L* in 12 h, the queue starts
  at the top (today's behaviour).
- **Confirm block:** when a start position exists, one extra line:
  *"Garrett is on this list (record 87 of 220) — you'll start from 88."*
  (`GET /dialer/sessions/:id` gains `listContext: { name, total, startedFrom, workedBy: [displayName] } | null`.)
- **Run screen:** the current-record card shows `record 88 of 220` when
  `list_position` is set.
- **Never the same person at once:** §2.1's `in_progress_elsewhere` + the
  per-number advisory lock. Nothing else is needed for a third rep.

---

## 5. Hang-up, Redial, Resume, End

- `dialer_queue_items.prospect_ended_at timestamptz` (new).
- **They hang up:** the terminal status callback for a `connected` item — which
  `handleDialOutcome` currently ignores — stamps `prospect_ended_at`. No
  advance, no dial. (The rep's own leg has already looped back onto hold music
  via the rejoin route; that is the audible cue.)
- **Panel:** `currentItem.prospectEndedAt` set → the card reads *"They hung up"*
  and the controls are **[Redial] [Resume]**.
  - `POST /dialer/sessions/:id/redial` → engine `redialCurrent`: marks the
    connected item `done` (outcome `connected`) and inserts a pending copy —
    same record, `toNumber` = the number that connected, same `ordinal` (so it
    is picked before the rest), `attempt` = the item's attempt, new column
    `redial_of uuid` pointing at the original — then `advanceSession`. Exempt
    from the 3-hour rule by construction (same session); the 24-hour cap and
    `in_progress_elsewhere` still apply.
  - **Resume** = today's `next` (hang up if still up, item `done`, advance).
- **While they are on the line:** **[End call] [Next]**. `Next` unchanged.
  `POST /dialer/sessions/:id/end` → engine `endCurrent`: hang up the prospect,
  item `done`, session `paused` (the existing status; the panel already
  renders Resume for it). Ordering rule: stamp the item **before** the hangup,
  exactly as `skipCurrent` does, so the terminal callback finds a settled row.
- **Reaper:** `expireAbandonedSessions` currently leaves any session with a
  `dialing`/`connected` item alone ("the call is the presence"). A `connected`
  item whose `prospect_ended_at` is older than 10 minutes is no longer
  presence; such a run is stopped like any other abandoned one.

---

## 6. Inbound pop

In `routes/inbound.ts`, the id handed to `dialClientWithCallerParams` as the
pop record follows this precedence, computed once from what `findByPhone`
returns:

1. the matched Contact's primary **open Opportunity** (`findPrimaryOpenOpportunityId`, already used by the sync) — or a matched Opportunity directly;
2. a matched **`Deal__c`**;
3. an unconverted **Lead**;
4. the **Contact** itself, only when none of the above exist.

Never an Account id. The ring-screen name, `salesforce_who_id`/`what_id` on the
call row and the Task sync are unchanged. Pure function `popRecordFor(match)`
in `salesforce/inbound-pop.ts`, tested on every combination.

---

## 7. Data changes (migration 0042, idempotent, house style)

```sql
ALTER TABLE dialer_sessions    ADD COLUMN IF NOT EXISTS list_view_id text;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS list_position integer;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS prospect_ended_at timestamptz;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS redial_of uuid;
ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS record_id text;
ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS connected_at timestamptz;
CREATE INDEX IF NOT EXISTS dialer_dial_attempts_record_idx ON dialer_dial_attempts (org_id, record_id, dialed_at);
CREATE INDEX IF NOT EXISTS calls_outbound_target_idx ON calls (org_id, normalized_to_number, created_at) WHERE direction = 'outbound';
```

No backfill. Rows without `record_id` match by number only; the 3-hour and
24-hour windows mean history older than a day is never consulted.

## 8. Error handling

- A contact-history read that **fails**: the state comes from the area code,
  not the database, so the engine still knows whether the number is capped.
  Capped state → skip as `daily_cap_unverified` (fail closed, logged: a
  database hiccup must never make us break the law). Not capped → dial (fail
  open: a hiccup must never freeze a run for a courtesy rule).
- The firewall's daily-cap read failing → BLOCK with the same reason (fail
  closed; the rep sees why and can retry).
- Rollover enqueue stays inside the miss transaction (unchanged); the
  click-to-dial trigger is best-effort in the sync worker (logged, retried on
  the job's normal schedule).
- `redial`/`end` on a session that is not `active`, or with no connected item,
  return the session's status like `pause` does; the panel re-polls.

## 9. Testing

- Every pure decision (`cadenceVerdict`, `rolloverDue`, `preferredNumber`,
  `popRecordFor`, `isDailyCapped`, the list rotation) gets table-driven tests
  including the boundaries (3 h − 1 s, 24 h, the org-day edge).
- Every rendered query in `contact-history-live.ts` is pinned with
  `new PgDialect().sqlToQuery` (org scope, both match arms, the window, the
  `direction = 'outbound'` filter, the `connected_at` stamp).
- Engine tests drive `advanceSession` / `handleDialOutcome` / `redialCurrent` /
  `endCurrent` over the existing fake db and assert the **order** of effects
  (stamp before hangup; lock before claim; skip write before the next pick) —
  the lesson from every review this month.
- Route tests pin `redial` and `end`; `inbound.test.ts` pins the pop precedence
  through the real route.
- Panel tests: the two control sets, the "They hung up" card, the list-context
  line, the new skip labels.
- Firewall tests: the BLOCK reason and message; the 3-hour rule *not* applying.
- Independent adversarial review + mutation testing per task, and a whole-branch
  review before merge — the house process.

## 10. Rollout

- One deploy, off-hours (the migration runs first via `preDeployCommand`).
  The rules are org-wide by nature; no per-rep flag.
- Order of work, each landing on its own: contact history + cadence rules →
  rollover-per-day (dialer and click-to-dial) → second number → shared list
  position → hang-up/End → inbound pop.
- Runbook: `docs/runbooks/dialer-cadence.md` — the rules in one table, how to
  check a person's contact history in SQL, how to add a capped state.

## Out of scope (noted for later)

- Power-dial calls create **no Salesforce Task** today; only click-to-dial calls
  are logged, and the rollover writes follow-ups. Connected power-dial
  conversations are logged only by hand. Its own item.
- A Salesforce field showing "last power dialed" on the record (list-view
  filtering by hand). The CTI-side gate covers the need; revisit if managers
  want it in reports.
- `Wrong number` as a rollover trigger (see §2.3).
- Voicemail drop, texting, parallel dialing — sub-projects 2–4.
