# Talk-time report — design

**Date:** 2026-10-01 · **Status:** decisions made in chat; awaiting spec review
**Ships with:** `2026-10-01-power-dialer-recording-design.md` (same branch,
`feat/dialer-recording`) — it reads that feature's `dialer_connects.talk_seconds`.

## Why

The user: "we need to track talk time including power dialer talk time (how
long they sat on the power dialer)". Today:

- Power-dial conversations leave no trace with a duration (fixed by the
  recording feature: `dialer_connects.talk_seconds` + a Task with Call Duration).
- Nothing records how long a rep's line sat on the power dialer.
- The reps' Salesforce talk-time report (`00OUS000007DAyP2AW`) overstates talk
  time. Measured on the 7 days to 2026-10-01 (outbound CTI call-log Tasks):
  519 "No answer" Tasks carry 1.6 h of Call Duration and 47 voicemails 0.5 h,
  against 3.7 h for 113 Connected calls — about a third of the total is not
  conversation. Cause: three Twilio callbacks write `calls.duration_seconds`
  last-write-wins, and the last one is the rep's own browser leg, whose
  `CallDuration` spans the whole dial including ringing.

## Decisions (user, 2026-10-01)

1. **Time on the power dialer = the rep's line open**: from the moment the
   softphone's conference leg joins the dialer until that leg ends — dialing,
   hold music and talking all count.
2. **Where:** a CTI admin report, **date range, one row per rep** (and per-day
   detail). The Salesforce report must also show power-dial calls.
3. **Talk time = all connected calls**: regular outbound, power dial, answered
   inbound.
4. **Regular calls store true talk time** (answer → hang-up) from now on. The
   Salesforce report's numbers drop accordingly; past Tasks are not rewritten.

## What counts

| Source | Counted when | Duration |
|---|---|---|
| Regular outbound (`calls`, direction outbound) | `disposition = 'Connected'` — the only "talked to a person" signal (the rep's wrap-up chip) | `coalesce(talk_seconds, duration_seconds)` (fix 1) |
| Inbound (`calls`, direction inbound) | `status = 'completed'` and `answered_at` not null and `inbound_voicemail_url` null | `coalesce(talk_seconds, duration_seconds)` (already the answered `DialCallDuration`) |
| Power dial (`dialer_connects`) | every bridged call (recording-feature ruling) | `talk_seconds` (null → 0) |
| Time on the power dialer (`dialer_rep_legs`, new) | every rep conference leg | `ended_at − joined_at`, clipped to the reported days |

Days are the org's Pacific days (`dialer/org-day.ts`: `ORG_TIMEZONE`,
`orgMidnightUtc`). A call belongs to the day it started (regular: `started_at`,
falling back to `created_at`; power dial: `bridged_at`). A dialer leg that spans
midnight is split across the two days.

## Fix 1 — true talk time on regular calls (a NEW column, `calls.talk_seconds`)

`calls.duration_seconds` stays exactly as it is. It is last-write-wins across
three Twilio callbacks and usually ends as the rep-browser leg's ring-inclusive
`CallDuration` — and the reputation engine reads it: a call counts as
"answered" when `answered_at` is set OR its duration is above 0
(`firewall/reputation/query.ts`, `routes/reputation.ts`), feeding the 5 %
answer-rate floor and the 6 s robocall floor that the firewall gate and the
auto-pause worker enforce. Zeroing unanswered durations would swing every DID's
answer rate to its true value overnight and could pause numbers — a behavior
change nobody asked for here (flagged separately as its own task).

So talk time gets its own column, **`calls.talk_seconds`** (migration 0048),
written only from durations that measure the customer's connected line:

- the `<Dial action>` request (`DialCallStatus` present): `DialCallDuration`
  when `DialCallStatus` is `completed` or `answered`, else **0**;
- a CHILD leg's own status callback (carries `ParentCallSid`): its
  `CallDuration`, when present;
- never the row's own (parent, rep-browser) leg `CallDuration`;
- inbound answered (`routes/inbound.ts` dial-result, `DialCallStatus=completed`):
  `DialCallDuration`; an inbound voicemail never sets it.

A later callback never raises a value the `<Dial action>` already set (it is the
authoritative one): `talk_seconds` is written by `<Dial action>`
unconditionally, by a child callback only while it is still null.

The Salesforce Task's Call Duration becomes `coalesce(talk_seconds,
duration_seconds)` at sync time (`salesforce/sync.ts`), so the reps' report shows
true talk time from deploy on; a call already in flight across the deploy falls
back to the old number. Past Tasks keep their old numbers.

## Fix 2 — Task date in the org's day

Already in the recording plan (Task 6): `createCallTask` dated Tasks in UTC, so
calls after 5 pm Pacific landed on tomorrow and fell out of the report.

## Time on the power dialer: `dialer_rep_legs`

One row per rep conference leg. FK-free (like `dialer_dial_attempts`).

| column | notes |
|---|---|
| `id` uuid pk | |
| `org_id`, `user_id`, `session_id` | the run the leg joined |
| `call_sid` text, FULL unique index | the rep leg; bare `ON CONFLICT DO NOTHING` |
| `joined_at` | stamped by the join (the voice route's dialer-conference branch, where `stampRepCallSid` already runs) |
| `ended_at` | null while open |
| `end_source` | `rep_left` (the leg's own final status callback, or the rejoin route saw `CallStatus=completed`), `run_end` (the server ended it — `releaseRepConference`, or the rejoin route answered Hangup), `replaced` (a newer leg joined the same run), `reconciled` (Twilio's call record), `fallback` (closed by rule) |
| `created_at`, `updated_at` | |

- **Join:** the voice route inserts the row where it stamps
  `dialer_sessions.rep_call_sid` (best-effort; a failure never blocks the join).
- **Leave:** stamped once (`ended_at is null` guard) by whichever hears it
  first: (a) the leg's own final status callback on `/telephony/twilio/status`
  (it matches no `calls` row); (b) the rejoin route — `CallStatus=completed`
  (`rep_left`) or a Hangup it answers (`run_end`); (c) the engine's
  `releaseRepConference`, which ends the leg over REST (`run_end`); (d) a newer
  leg joining the same run (`replaced`, at the new leg's join).
- **Reconcile:** its own loop (`dialer/rep-leg-reconcile.ts`), every 5 min, up
  to 25 open legs oldest first: Twilio's call record (`calls(sid).fetch()` →
  `endTime`, else `startTime + duration`) closes an ended leg,
  `end_source='reconciled'`. A fetch that fails leaves the row for the next
  tick; after 48 h it is closed at `joined_at + 12 h` (`fallback`) and logged,
  so the report never shows an endless leg.
- **Counted once:** a rep's overlapping legs (an old leg lingering beside its
  replacement) are merged before they are summed.
- **Open legs in the report:** an open leg counts up to `now` (a rep on the
  dialer right now shows live time).

## The report

**API:** `GET /admin/talk-time?from=YYYY-MM-DD&to=YYYY-MM-DD` — admin-gated and
org-scoped exactly like the other `/admin/*` routes (`resolveSession` → 401,
`!isAdmin` → 403, `orgId` filter). Both dates required, `from ≤ to`, range at
most 92 days (400 otherwise). Response:

```json
{
  "from": "2026-09-28", "to": "2026-10-01", "timezone": "America/Los_Angeles",
  "reps": [
    {
      "userId": "…", "name": "Garrett Martorello",
      "talkSeconds": 13240, "connectedCalls": 72,
      "bySource": { "outbound": { "calls": 41, "seconds": 6100 },
                    "powerDial": { "calls": 22, "seconds": 5400 },
                    "inbound": { "calls": 9, "seconds": 1740 } },
      "dialerSeconds": 21600,
      "days": [ { "day": "2026-09-28", "talkSeconds": 3100, "connectedCalls": 18, "dialerSeconds": 5400 } ]
    }
  ],
  "totals": { "talkSeconds": 0, "connectedCalls": 0, "dialerSeconds": 0 }
}
```

Every rep in the org with any activity in the range appears (a user id with no
user row reads "Unknown user"); reps with none are omitted. Sorted by talk time, highest first.

**UI (cti-web):** an admin-only **Talk time** screen in the softphone's More
menu, next to Team. From/To date inputs (default today/today) with Today /
This week / Last 7 days shortcuts; a table — Rep, Talk time, Connected calls,
Power-dial talk, Time on dialer — with a totals row; tapping a rep expands its
per-day rows. Durations render as `h:mm:ss`.

## Untouched

The compliance counters, `calls.duration_seconds` and every reputation /
firewall reader of it, the Recent list, the pending-disposition banner, and
the dispositions themselves. The Salesforce report definition is not edited.

## Testing

- Fix 1: each callback shape (child completed, `<Dial action>` completed /
  answered / no-answer, parent completed) writes the right `talk_seconds` or
  none, in every arrival order; `duration_seconds` and its reputation readers
  are unchanged; the Task gets `coalesce(talk_seconds, duration_seconds)`.
- Legs: join inserts once; rejoin `completed` and `releaseRepConference` stamp
  once; reconcile closes from Twilio, and the 48 h fallback.
- Report: day bucketing across midnight (Pacific, DST-safe via
  `orgMidnightUtc`), the three talk sources and their predicates, leg clipping,
  open legs, range validation, admin gating, org scoping.
- UI: renders rows/totals, expands a rep, date shortcuts, non-admins never see
  the entry.
- Live: after deploy, one click-to-dial no-answer (expect 0 s on its Task) and
  one connected call; a short power-dial run; the report shows all three.

## Out of scope

Rewriting past Salesforce Tasks' durations; per-org timezones (one org,
Pacific); editing the Salesforce report; exporting the CTI report.
