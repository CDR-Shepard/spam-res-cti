# Power-dial run settings (calls per person, how many, where missed tasks go): Design

**Date:** 2026-09-28 · **Ask:** Garrett, via the user: "the option to select how many times we want to call through our list, how many people we want to call through, and where those tasks end up after being called." The second pass reaches very few people and costs him about 1.5 idle hours per 200-person list.

**User rulings (2026-09-28):**
- Reps pick these settings for each run, and their last choice is remembered.
- Calls per person is **Once** or **Twice**. There is no double tap.
- Missed tasks go to the **next business day** or **2 business days** out.
- Run size is a **number of people**. There is no time limit.
- Garrett's existing Sept 27 tasks are **not** moved. Leave them.

## Today (the baseline this changes)

- **Two passes.** A miss (voicemail, no answer, busy, failed) gets an end-of-run retry: `engine.ts` requeues when `attempt < 2`, with a 5-minute floor.
- **Rollover.**
  - A follow-up task "rolls" on the task owner's 2nd non-connect of the LA day, in a power dial or a click-to-dial. Rolling completes the task and creates one copy.
  - It never rolls if the person was reached today. Skip and Stop don't count as a non-connect.
  - It rolls at most once per person per day.
- **Where it lands.** `pickRolloverDay` starts at the next business day after the **dial day** and caps at 100 open follow-ups per day. A task worked ahead of its due date therefore "rolls" onto the date it already had. That is Garrett's Sept 27 report: 94 Monday tasks dialed on Sunday went Monday → Monday.

## What the rep sees

Three settings appear on the **Ready to dial** screen, above **Start dialing**:

| Setting | Choices | Default for a new rep |
|---|---|---|
| **Calls per person** | Once · Twice | Twice (today) |
| **How many** | All, or "Call the first [___] of 200" | All |
| **Missed tasks move to** | Next business day · In 2 business days | Next business day |

- "N will be dialed" updates live as the number changes.
- The number box only accepts a whole number from 1 up to the list size. Blank means All.
- Starting a run saves these three choices to the rep's account. They are the next run's defaults, in any tab or in Salesforce.
- While the run is going, a small line under the progress shows the choices, e.g. "Once · first 100 · missed → next business day".
- "Missed tasks move to" is always shown. It applies to every follow-up task the rollover touches today, on Lead, Opportunity and Task runs alike.

## Behaviour

1. **Once:**
   - No end-of-run retry.
   - The run is done after every queued person has been called once.
   - A follow-up rolls on the owner's **first** non-connect of the day in that run.
2. **Twice:** exactly today's behaviour. There is an end-of-run retry, and a follow-up rolls on the owner's 2nd non-connect of the day.
3. **Unchanged:**
   - Nothing rolls if the person was reached today.
   - Skip, Stop and a take-callback cancel don't count as a non-connect.
   - One rollover per person per day.
   - The 3-hour courtesy between power dials.
   - The FL/OK/WA/MD 3-per-24h cap and the per-customer ceiling.
4. **Click-to-dial rollovers** keep today's rule (the owner's 2nd non-connect of the day). "Calls per person" is a power-dial setting only. They use the rep's saved **"Missed tasks move to"** choice.
5. **Where a rolled task lands:** the 1st or 2nd business day after the **later of the dial day and the task's own due date**. The 100-per-day cap and the 30-business-day bound are unchanged.
   - A task due Monday and dialed Sunday lands Tuesday (next) or Wednesday (in 2).
   - A task due today or overdue lands tomorrow or in 2 business days, same as today.
6. **How many:**
   - The run queues only the next N people from the list's current position. That is the existing shared list position: the run starts after where the last run on that list stopped.
   - The next run on the list continues at N+1.
   - The "no number", cooldown, cap and ownership filters apply as today. N counts people actually queued.

## Decisions

1. **Where the settings are stored.**
   - `dialer_sessions.passes` (1|2, default 2) and `dialer_sessions.rollover_business_days` (1|2, default 1) hold the per-run values. These are what the engine reads, because misses and rollovers are decided server-side, sometimes minutes later.
   - `users.dialer_passes` and `users.dialer_rollover_business_days` hold the rep's saved defaults, with the same values and defaults.
   - `followup_rollover_jobs.business_days` (1|2, default 1) is captured when the job is queued, so the worker needs no session lookup and click-to-dial jobs get the rep's saved value.
   - One migration, numbered 0046 because Reset CTI's 0045 ships first, with CHECK constraints. Existing rows keep today's behaviour.
2. **API.**
   - The run-start request gains `passes`, `maxRecords` (optional; positive integer; null means all) and `rolloverBusinessDays`. Each is validated, and a bad value gets a 400 that names the field.
   - The server saves the three values to the user's defaults in the same transaction that creates the session.
   - `GET /auth/me` returns `dialerRunDefaults: { passes, rolloverBusinessDays }`.
3. **Engine.**
   - The requeue rule becomes `attempt < session.passes && …`.
   - `rolloverDue` takes the required number of non-connects, 1 or 2, from `session.passes`.
   - The "nothing rolls if reached today" and "one rollover per person per day" guards are untouched.
4. **Worker.**
   - `pickRolloverDay` receives `fromDate = max(dialDay, sourceTaskDueDate)` and `businessDays`.
   - It starts at the N-th business day after `fromDate`, then applies the cap loop as today.
   - The source task's due date comes from the task the worker already reads. A task with no due date uses the dial day.
5. **Run size.** Queue creation applies `maxRecords` after the start-position rotation and the existing filters. `firstPassTotal`, "record X of N" and the list position all key off the queued people, so a limited run reads "record 3 of 100".

## Out of scope

- Double tap, a time limit, admin/org defaults, and "leave it where it is" / "in 1 week".
- Moving Garrett's existing Sept 27 copies (the user said leave them).
- Changing the click-to-dial rollover threshold.

## Testing

- Pin the rendered SQL for every new query and write: session insert, defaults update, job insert, and the migration.
- Engine truth-table tests for passes 1 and 2: requeue, enqueue and the rollover threshold, including a Skip, a canceled dial, a connected-today record, and a redial copy.
- Worker tests for the landing day:
  - due in the future, due today, overdue, and no due date;
  - 1 and 2 business days;
  - over a weekend or holiday;
  - hitting the cap.
- Web: the three settings render, remember their values, and send the start body; "N will be dialed" updates; the run line shows.
- A rep who never touches the settings sends Twice / All / Next and gets exactly today's run.

## Tasks

1. API and data: migration 0046, schema, run-start validation plus saving defaults, `/auth/me` defaults, the engine's passes and rollover threshold, the job's `business_days`, and the worker's landing-day rule.
2. Web: the Ready-to-dial settings block, the start body, the run line, and the defaults from `/auth/me`.
3. Docs: the dialer-cadence runbook section and the rep guide paragraph (the guide stays unpublished until the user OKs it).
