# Power Dialer Time in Salesforce

Each rep gets ONE completed Task per Pacific day, Subject **Power Dialer
Time**, owned by the rep, whose **Call Duration** is their time on the power
dialer that day (line open: dialing, hold music and talking — the admin
Talk time screen's "On dialer"). The CTI updates it every 5 minutes while
they dial and re-checks the last 3 days. Design:
`docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md`.

## Switch (Railway `@cti/api` variable — changing it restarts the service)

| Variable | Default | `off` means |
|---|---|---|
| `DIALER_TIME_TASKS` | `on` | no Power Dialer Time Tasks are created or updated; turning it back on catches up the last 3 days |

## Reports

- The reps' talk-time report (`00OUS000007DAyP2AW`) filters Subject
  `contains Outbound,Inbound,Power Dialer Time`: each rep has a "Power Dialer
  Time" row beside their call rows. Its grand total adds dialer time to talk
  time — read the rows.
- **Power Dialer Time by Rep**: Subject equals `Power Dialer Time`, any date
  range, grouped by Assigned, Sum of Call Duration (seconds).
- **`CTI_Origin__c` overlap:** this Task's `CTI_Origin__c` is `Power Dialer
  Time`, which shares the `Power Dialer` prefix with `Power Dialer Follow-Up`
  (click-to-dial follow-up Tasks). Any existing report or list view that
  filters `CTI Origin contains "Power Dialer"` now also picks up these Tasks —
  check that filter in Salesforce before trusting its numbers.

## Duplicates

Two Tasks for the same rep and day should never happen — the worker claims
each row with an atomic lease before any Salesforce write (so two API
instances overlapping during a deploy never write the same rep and day), and
it looks up the rep's existing Task before creating one — but if one somehow
shows up:

```sql
SELECT OwnerId, ActivityDate, COUNT(Id) c FROM Task
WHERE Subject = 'Power Dialer Time'
GROUP BY OwnerId, ActivityDate
HAVING COUNT(Id) > 1
```

## Checks (read-only SQL)

```bash
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
PGOPTIONS='-c default_transaction_read_only=on' psql "$PUB"
```

```sql
-- Today's rows: Task id, seconds in Salesforce, failures
select user_id, day, salesforce_task_id, synced_seconds, attempts, next_attempt_at, left(last_error, 80)
from dialer_time_tasks
where day = to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD')
order by synced_seconds desc nulls last;

-- Anything failing
select user_id, day, attempts, next_attempt_at, left(last_error, 120)
from dialer_time_tasks where attempts > 0 order by next_attempt_at;

-- Reps waiting to reconnect Salesforce (attempts stays 0 for these — the
-- "Anything failing" query above won't show them)
select user_id, day, next_attempt_at
from dialer_time_tasks where last_error = 'reconnect Salesforce' order by next_attempt_at;
```

A row with no `salesforce_task_id` and nothing in `last_error` → the rep has
no Salesforce connection (once they connect, it catches up on the next
tick).

`last_error = 'reconnect Salesforce'` → the rep's Salesforce sign-in expired
(an auth error). `attempts` is NOT bumped for this — it's not a failure, it's
a wait for the rep to reconnect — and the row retries every 15 minutes
(`AUTH_RETRY_MS`) instead of every tick until they do.

## Cleanup / rollback

1. Set the Railway `@cti/api` variable `DIALER_TIME_TASKS=off` first (stops
   the worker from recreating what you're about to delete).
2. Find the Tasks in Salesforce by `Subject = 'Power Dialer Time'` (or
   `CTI_Origin__c = 'Power Dialer Time'`) and delete them.
3. Re-enabling (`DIALER_TIME_TASKS=on`) does NOT bring deleted Tasks back on
   its own for a day whose number has stopped changing: the worker writes
   only when the computed seconds differ from `synced_seconds`, so it never
   touches Salesforce for that day again. To recreate them, BEFORE
   re-enabling reset the last 3 days' rows (a production write — run it
   deliberately, without the read-only `PGOPTIONS`):

   ```sql
   update dialer_time_tasks
   set salesforce_task_id = null, synced_seconds = null, next_attempt_at = now(), updated_at = now()
   where day >= to_char((now() at time zone 'America/Los_Angeles') - interval '2 days', 'YYYY-MM-DD');
   ```

   The next tick then looks up (finds nothing) and creates each Task again.
   Days older than the 3-day window are not recreated.

## Not covered

Days before 2026-10-01 19:15 PT: dialer time was not tracked before then.
