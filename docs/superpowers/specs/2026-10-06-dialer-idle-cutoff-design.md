# Power-dialer idle cutoff — design

**Date:** 2026-10-06 · **Status:** approved in chat ("1 and 2. and then fix the
current reports based on that 15 min")
**Changes:** `2026-10-01-talk-time-report-design.md` (what "On dialer" counts)
and `2026-10-02-dialer-time-tasks-design.md` (the Salesforce Task's number).

## Why

Christian asked how Matt Penrod spent 8 hours on the dialer on Mon 2026-10-05.
Here is what happened:

- He dialed from 1:32 to 2:07 pm.
- His last prospect hung up at 2:19 pm. He never pressed Next, so the run
  waited on him.
- His softphone line stayed in the dialer's room on hold music until 9:35 pm,
  with zero dials.
- Twilio cut the line at its 4-hour limit (5:57 pm), and the softphone
  reconnected it within 2 seconds, three times.

"On dialer" counted line-open time, so the admin screen and the Salesforce
"Power Dialer Time" Task both said 7 h 58 m. Over 6 days this happened 3 times
(Matt 2, Danny Arredondo 1).

## Decisions (user, 2026-10-06)

1. **Hang up idle lines.** If a rep's power-dial line goes 15 minutes with
   nothing happening, the CTI ends the run, as if the rep had pressed Stop.
2. **Count only active time.** Time on the dialer counts only while something
   has happened in the last 15 minutes.
3. **Fix the existing numbers** with the same 15-minute rule, for every day
   since the feature started (2026-10-01). This covers:
   - the admin Talk time screen;
   - the Salesforce Tasks, and so both Salesforce reports.

One constant serves both rules: `DIALER_IDLE_MS = 15 * 60_000`, in
`services/cti-api/src/dialer/idle.ts`.

## 1. Counting: `dialerSecondsByUserDay` (reports/talk-time.ts)

A rep's time on the dialer for a day is the time when both of these hold:

- the rep's line is open (their `dialer_rep_legs`, merged, the same as today);
- that moment falls inside an **active window**.

The result is still split at Pacific midnight.

There are two kinds of active window, both per rep:

| Activity | Source | Window |
|---|---|---|
| a dial placed | `dialer_dial_attempts.dialed_at` (one row per originate, append-only) | `[dialed_at, dialed_at + 15 min)` |
| a conversation | `dialer_connects` (one row per bridged call) | `[bridged_at, (ended_at ?? min(now, bridged_at + 4 h)) + 15 min)` |

Windows are merged per rep, then intersected with the merged legs.

**Not activity:**
- the line opening;
- the softphone reconnecting;
- hold music;
- Pause.

A line that opens and never dials therefore counts 0. The seconds between a
leg opening and its first dial are lost, which is a few seconds in practice
because a run dials as it starts.

This changes `dialerSecondsByUserDay(legs, days, now)` to
`dialerSecondsByUserDay(legs, activity, days, now)`. The new argument is
`activity: readonly ActivitySpan[]`, where
`ActivitySpan = { userId; start: Date; end: Date | null }`:

- a dial is `start = end = dialed_at`;
- a conversation is `bridged_at → ended_at`, with null meaning still talking.

Both callers load activity alongside legs:

- **The admin report** (`reports/talk-time-query.ts`) loads it for the org.
  Dials need `dialed_at >= start − 15 min and dialed_at < end`. Conversations
  need `bridged_at < end and ((ended_at is null and bridged_at >= start − 15 min − 4 h) or
  ended_at >= start − 15 min)`. The 4-hour floor on a row with no recorded end is
  the orphan cap (`MAX_CONVERSATION_MS`): a call row whose end callback was lost
  counts for at most 4 hours, so one bridged earlier than that before the lookback
  can no longer reach the range and is not read forever. The lookbacks are
  computed Date parameters, not SQL interval text.
- **The Salesforce worker** (`salesforce/dialer-time-store.ts`) uses the same
  predicates across all orgs.

The volume is small: about 700 dials a day and 11 k rows in all. Neither table
has a time index, and the scans are cheap at this size; the index stays a
follow-up.

## 2. Hanging up idle lines (`dialer/idle-runs.ts`)

The check runs every 30 s (`IDLE_CHECK_INTERVAL_MS`) on its own single-flight
timer.

**Which runs are looked at:** runs that are `active` or `paused` and have an
**open rep leg** (`dialer_rep_legs.ended_at is null`). A run parked while the
rep takes a callback has already dropped its leg, so it is never cut.

The query runs once per tick, and once more per idle candidate as a re-check
(see "Re-check before cutting" below). `idleRunCandidatesStatement(now, sessionId?)`;
`$1` is `now − MAX_CONVERSATION_MS` (4 h), and the `and s.id = $2` line is added
only for the re-check:

```sql
select s.id as session_id, s.user_id,
       greatest(s.updated_at, max(l.joined_at), max(i.updated_at)) as last_activity_at,
       coalesce(bool_or((i.status = 'dialing' or (i.status = 'connected' and i.prospect_ended_at is null)) and i.updated_at > $1::timestamptz), false) as live
from dialer_sessions s
join dialer_rep_legs l on l.session_id = s.id and l.ended_at is null
left join dialer_queue_items i on i.session_id = s.id
where s.status in ('active', 'paused')
  -- and s.id = $2   (re-check only)
group by s.id, s.user_id, s.updated_at
```

**`live` is bounded to 4 hours.** Twilio ends any call at 4 hours, so an item
still `dialing`, or `connected` with `prospect_ended_at` null, whose last change
is more than `MAX_CONVERSATION_MS` old is a lost status callback, not a live
call. Without the bound, one lost callback would block the cut forever and
re-create the original "line left open for hours" symptom. `MAX_CONVERSATION_MS`
is the same constant `reports/talk-time.ts` uses for the orphan cap.

What counts as the run's last change:

- `dialer_sessions.updated_at` is bumped by Start, Pause, Resume and a leg
  stamp. The 2-second poll writes only `last_polled_at`.
- An item's `updated_at` is bumped by a dial claimed, its outcome, a connect,
  the prospect hanging up, Next, Skip and Redial.

**Idle (pure `isIdleRun`):** `!live && now − last_activity_at >= DIALER_IDLE_MS`.
A ringing dial or a live conversation is never cut, however long it runs. This
matches `engine.ts` `isTalking` and the abandoned-run reaper.

**Re-check before cutting.** The tick snapshots the candidates once, then stops
them one by one, and each stop makes several Twilio calls, so a later candidate's
snapshot can be seconds old when its turn comes. For each candidate that is idle
in the snapshot, the tick re-reads that one run (`candidates(sessionId)`) with a
fresh clock and re-applies `isIdleRun`. It stops the run only if the fresh row is
still idle; a run that is no longer idle, or no longer a candidate (its leg closed,
it was stopped), is skipped silently. `stopIdleSession`'s conditional flip below
remains the last line of defence.

**What happens:** `stopIdleSession(sessionId, deps)` (engine.ts). It runs in the
REVERSE order of `stopSession`: it marks the run stopped first, then releases
the line.

1. **Flip first, conditionally.** One UPDATE sets `status = 'stopped'` and
   `stop_reason = 'idle'` where the run is still `active` or `paused`. If it
   matches no row, the run ended or changed since the tick's snapshot: the
   result is `skipped`, with no Twilio call at all. An ended run is never
   rewritten to stopped/idle.
2. **Release the rep's conference with the post-flip row** (status `stopped`):
   hang the leg up by sid (its time ends `run_end`), then the by-name teardown.
   The teardown is skipped whenever the rep already has another active run, so
   a new run started in the window keeps its room.
3. **Hang up a ringing dial last** (only if one started in the instant since
   the check; normally there is none, by definition).

It logs `[dialer] idle run stopped {sessionId, userId, idleMinutes}` (ids only)
only when the result is `stopped`; a `skipped` run is silent and not counted.

**Why flip first (the reverse of `stopSession`).** `stopSession` releases first
so a rep's own Stop cannot free the one-active-run slot before the rep-scoped
room is torn down. For the idle cut the softphone is the thing to beat. When
its leg drops it waits 1.5 s, reads the run's status, and REJOINS a run that
reads `active` or `paused` (`recoverDroppedLeg`); if that fails it POSTs Stop
itself. The release takes several Twilio REST calls and routinely outlasts 1.5
s. Hung up first, the rep would be put back on hold music ("audio
reconnected") and then see the run end, or the client's Stop would overwrite
the reason with null ("lost its audio connection"). Flipped first, the rejoin
reads a stopped run, stays down, and the panel reads "Stopped after 15 minutes
with no dialing." The rejoin route's `CallStatus=completed` backstop pauses an
ACTIVE run whose leg ended, so with the run already stopped it correctly does
nothing.

`stopSession` itself is unchanged and never writes `stop_reason`, so a later
rep or softphone Stop on an idle-stopped run keeps `'idle'`.

**Why stop and not pause:** the softphone's drop recovery (`apps/cti-web`
`dialer-leg.ts recoverDroppedLeg`) rejoins a run that reads `active` or
`paused`. Only a stopped run keeps the line down. The rep then starts a new run
from the list, which continues from the shared list position.

**Twilio's 4-hour limit:** an idle line is now cut at 15 minutes, so only a
rep who is actively dialing can reach 4 hours. For them, the existing
reconnect is the right behaviour, so nothing changes there.

**Accepted race:** a rep who presses Next in the same instant as the cut sees
the run stop. They would have been idle for 15 minutes.

**Kill switch:** `DIALER_IDLE_STOP` (`on`|`off`, default `on`, strict enum like
`DIALER_TIME_TASKS`). When it is `off`, the loop never starts.

### `stop_reason` (migration 0054)

```sql
SET LOCAL lock_timeout = '5s';
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS stop_reason text CONSTRAINT dialer_sessions_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN ('idle'));
```

- This follows 0046's style: the CHECK rides the `ADD COLUMN IF NOT EXISTS`,
  so a re-run is a no-op.
- `lock_timeout` makes the migration fail fast on this hot table.
- The column is nullable with no default, so adding it is instant.
- `stopIdleSession` writes `'idle'` in its one conditional flip. `stopSession`
  (the rep's Stop, the softphone's Stop, the reaper) never writes the column, so
  a run the rep or softphone then stops keeps `'idle'`; every other run stays
  NULL.

### The softphone

The session GET already returns the whole row, so `stopReason` comes for free.
The run summary for a stopped run with `stopReason === 'idle'` adds one line
under "Run stopped":

> Stopped after 15 minutes with no dialing.

`apps/cti-web/src/dialer-api.ts` `DialerSession` gains
`stopReason?: 'idle' | null`.

## 3. Fixing the existing numbers

- **The admin Talk time screen** recomputes on every read, so it is right as
  soon as the code ships.
- **Salesforce Tasks:**
  - The worker's window grows from 3 to **14** Pacific days
    (`DIALER_TIME_WINDOW_DAYS`), on every tick.
  - The planner already writes only where the number differs, including
    correcting down to 0. So the first tick after the deploy rewrites every
    changed day since 2026-10-01, and later ticks write nothing extra.
  - A day whose write fails, for example because a rep must reconnect
    Salesforce, keeps retrying for two weeks rather than three days.
  - The cost is about 10 k activity rows per 5-minute tick, which is a few
    milliseconds.
  - The leg and activity lookups use the same window.
- **Wording:** the Task `Description` becomes:
  `Time on the power dialer on <day>, Pacific: counted while dialing or talking; quiet stretches over 15 minutes are left out. Kept up to date by the CTI.`
  - It is set on create, as before.
  - It is now also sent with every PATCH, so existing Tasks lose the old
    "(line open)" text when their number is rewritten.
  - `updateDialerTimeTask` takes the day for this:
    `(userId, taskId, day, seconds)`.
- **Admin screen copy** (`TalkTimePanel.tsx`): "On dialer is how long the
  rep's line was open on the power dialer" becomes "On dialer counts the rep's
  power-dial time while dialing or talking; quiet stretches over 15 minutes are
  left out."
- The Salesforce reports themselves are untouched.

## Untouched

- Talk time and connected-call counts.
- Call Tasks.
- `dialer_rep_legs` itself: legs are still recorded exactly as before.
- The reconciler, the abandoned-run reaper and compliance counters.

## Testing

- **Pure counting:**
  - intersecting intervals;
  - a dial's window ends 15 minutes after it;
  - a long conversation counts in full, plus 15 minutes;
  - an open conversation counts to now, capped at 4 hours after the bridge;
  - a leg with no activity counts 0;
  - a reconnected leg counts nothing new;
  - the Pacific-midnight split still holds;
  - a Matt-shaped day comes out at under 1 h, not 8 h.
- **Queries:** the rendered SQL is pinned (org scope, the lookback parameter,
  both bounds).
- **Worker:**
  - activity reaches the planner;
  - the window is 14 days;
  - Description is sent on PATCH.
- **Idle cut:**
  - the `isIdleRun` table;
  - the tick stops exactly the idle ones through `stopIdleSession` and skips
    live ones; a `skipped` result is not logged or counted;
  - one failing stop does not block the others;
  - the kill switch;
  - the SQL is pinned, including the `session_id` / `user_id` aliases the row
    mapper reads;
  - `stopIdleSession` writes `stopped` + `'idle'` BEFORE any Twilio hangup
    (one ordered log of the flip and every call), for an `active` and a
    `paused` run;
  - `stopIdleSession` on a run that already ended returns `skipped` and makes
    no Twilio call; its flip is the conditional UPDATE;
  - the release uses the post-flip row (the room is left alone when the rep has
    a new active run), and a dial started since the check is hung up last;
  - `stopSession` writes no `stop_reason` key at all;
  - the migration is pinned.
- **Softphone:** the idle line shows for `stopReason: 'idle'` only.
- **Before deploy:** a read-only dry run on prod data prints, per rep per day,
  the old seconds next to the new.
- **After deploy:**
  - the Tasks equal the admin screen;
  - Matt's 2026-10-05 Task is under an hour;
  - `[dialer] idle run stopped` lines appear only for real idle lines.
