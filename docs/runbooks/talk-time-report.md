# Talk-time report

Admin-only. Softphone → **More → Talk time**. Also `GET /admin/talk-time?from=YYYY-MM-DD&to=YYYY-MM-DD`
(admin session; at most 92 days). Design: `docs/superpowers/specs/2026-10-01-talk-time-report-design.md`.

## The columns

| Column | What it counts |
|---|---|
| Talk time | Seconds on every connected call that started that Pacific day. Outbound click-to-dial: wrap-up disposition **Connected**. Power dial: every call bridged to the rep. Inbound: answered by the rep, not voicemail. |
| Connected | How many such calls. |
| Power-dial talk | The power-dial share of Talk time (bridge → hang-up; AMD screening excluded). |
| On dialer | How long the rep's line sat on the power dialer: from the softphone joining the dialer to that leg ending. Dialing, hold music and talking all count. A rep with two legs at once (a tab replaced its leg) is counted once. A leg still open counts up to now. |

Days are America/Los_Angeles. A call counts on the day it started. A dialer leg across midnight is split.

## Where the numbers come from

- **Regular calls:** `calls.talk_seconds`, the true talk time (ring time excluded), from the deploy of 0048 on. Older calls fall back to `calls.duration_seconds`, which includes ringing. So ranges before the deploy read high.
- **Power dial:** `dialer_connects.talk_seconds` (migration 0047).
- **On dialer:** `dialer_rep_legs` (migration 0048). Whichever of these HEARS the leg end FIRST stamps it — not a precedence order, a race (e.g. `run_end` and `rep_left` can each win depending on timing):
  - the leg's own Twilio status callback (`rep_left`);
  - the rejoin route (`rep_left` / `run_end`);
  - the run's end (`run_end`);
  - a newer leg on the same run (`replaced`);
  - only if NONE of those ever arrive, the reconcile loop (every 5 min, Twilio's call record, `reconciled`; after 48 h of Twilio errors a leg is closed at join + 12 h, `fallback`, logged `[dialer] rep leg closed by rule`).

## The Salesforce talk-time report

Report `00OUS000007DAyP2AW` sums Task Call Duration. From the deploy on, each Task's Call Duration is the true talk time:
- an unanswered click-to-dial logs 0, not its ringing;
- power-dial calls have their own Tasks (`Outbound Call | Connected | …`).

Past Tasks were not rewritten. Days before the deploy still include ring time.

`calls.duration_seconds`, which number reputation (answer rate, auto-pause) reads, is unchanged.

## Checks

Read-only SQL. `railway run` injects the PRIVATE `DATABASE_URL`, which a laptop
cannot reach, so open the public URL instead (never echo or paste `$PUB` — it is
a live DB credential):

    PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
    psql "$PUB"

- **Open legs right now:**
  ```sql
  select user_id, joined_at from dialer_rep_legs where ended_at is null order by joined_at;
  ```
  More than one per rep, or one far older than today, means end stamps are being missed. Look for `[dialer] rep leg` in the logs.
- **How each leg ended, last 7 days:**
  ```sql
  select end_source, count(*) from dialer_rep_legs where joined_at > now() - interval '7 days' group by 1;
  ```
  Mostly `rep_left` / `run_end` is healthy. Many `reconciled` means the status callback is not reaching `/telephony/twilio/status`.
- **True talk time is being written:**
  ```sql
  select count(*) filter (where talk_seconds is not null), count(*) from calls where created_at > now() - interval '1 day' and direction = 'outbound';
  ```
