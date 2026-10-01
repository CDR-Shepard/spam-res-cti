# Power-dialer call recording + connected-call Task — design

**Date:** 2026-10-01 · **Status:** approved in chat (approach 1), awaiting spec review

## Why

Jona asked for the recording of a call Garrett power-dialed (Opportunity
`006iL00000A6IkYQAV`). There is none, and there is none for ANY power-dialed
call:

- `TwilioDialerTelephony.originate` deliberately records nothing — the
  screening leg is answered before a rep is present.
- Recording the bridged conversation was deferred when the dialer shipped
  (power-dialer-2026-07, "Deferred non-blocking") and never built: neither
  conference leg carries a `record` attribute.
- A bridged call never becomes a `calls` row, so the CTI writes **no
  Salesforce Task** for it either. Click-to-dial calls get a Task through the
  wrap-up; power-dial connects get nothing.

Past calls cannot be recovered — no audio was ever captured.

## Decisions (user, 2026-10-01)

1. Record connected power-dial calls.
2. Log a **completed Call Task** for **every bridged call** — no minimum talk
   time. (The dialer's AMD is biased toward "human", so an occasional bridged
   voicemail will get a Task too. Accepted.) The existing outbound ownership
   rule still applies: no Task on a record the rep does not own.
3. Approach 1: a **dialer-owned connect log**, not rows in `calls`.

### Why not rows in `calls` (approach 2, rejected)

Every compliance counter already counts power-dial attempts from
`dialer_dial_attempts` and click-to-dial from `calls`: the per-customer ceiling
(`firewall/attempts.ts`), the state 3-per-24h rule (`evaluate.ts`), the daily
cap (`daily-cap.ts`), cadence/courtesy (`contact-history-live.ts`), plus the
reputation stats, the Recent list and the pending-disposition banner. A bridged
call in `calls` would double-count in each of them unless every one were
patched, and a missed one blocks reps early. Approach 1 touches none of them.

### Why not conference recording (approach 3, rejected)

`<Conference record>` yields one mixed mono track (click-to-dial is dual
channel), its callback is keyed by ConferenceSid, and a run started before the
hold-music rejoin fix keeps one standing room — several conversations in one
file.

## What is recorded

- **Only the prospect's call leg, from the moment it is bridged** to the rep.
  The engine starts it with the Twilio Call Recordings API
  (`POST /Calls/{CallSid}/Recordings`, `RecordingChannels=dual`) right AFTER
  `bridgeToRep` succeeds. Dual channel = prospect on one track, the conference
  (the rep) on the other — same shape as click-to-dial. The recording ends when
  the prospect's leg ends.
- **Never recorded:** the AMD screening seconds (recording starts only after
  the bridge) and the rep's long-lived conference leg (hold music, the whole
  run).
- **Disclosure:** unchanged — reps give it verbally, exactly as on
  click-to-dial. If the org's `default` campaign is
  `recordingConsentMode='two_party'` the dialer does **not** record (this path
  has no automated disclosure). The Task is still logged.
- **Switches:** `TWILIO_RECORD_CALLS=false` (the existing global switch) stops
  dialer recording too. New `DIALER_RECORDING` (`on`|`off`, default `on`, strict
  enum like `NO_ANSWER_CHATTER`) stops only dialer recording.
  New `DIALER_CONNECT_TASKS` (`on`|`off`, default `on`) stops only the Task
  worker; the log rows are still written, see "No backfill".

## Data: `dialer_connects`

One row per bridged call. FK-free like `dialer_dial_attempts`, so a recording
link outlives any run/item cleanup.

| column | notes |
|---|---|
| `id` uuid pk | also the playback-link id and `External_Call_Id__c` |
| `org_id`, `user_id`, `session_id`, `item_id` | uuid, no FKs |
| `call_sid` text **unique (full, not partial)** | the prospect leg; dedupes a re-delivered AMD "human" |
| `object_type`, `record_id` | the item's own record (Lead / Contact / Opportunity) |
| `from_number`, `to_number` | the DID and the number dialed |
| `bridged_at` | set at insert |
| `sf_user_id` | the rep's Salesforce user id (`dialer_sessions.sf_owner_id`) — the ownership gate's caller |
| `ended_at`, `talk_seconds` | stamped from the prospect leg's `completed` callback; `talk_seconds` = `ended_at − bridged_at` (excludes screening) |
| `recording_state` | `pending` (row written) / `requested` / `start_failed` / `skipped_consent` / `skipped_switch` |
| `recording_url` | Twilio media URL (`.mp3`), validated by `TWILIO_RECORDING_MEDIA_RE` |
| `salesforce_task_id`, `task_state`, `task_attempts`, `next_attempt_at`, `last_error` | Task worker bookkeeping; `task_state` = `pending` / `created` / `skipped_not_owner` / `expired` / `failed`. `next_attempt_at` is the lease + backoff clock for both phases |
| `recording_link_synced_at`, `link_attempts` | link PATCH bookkeeping |
| `created_at`, `updated_at` | |

## Flow

1. **Bridge** (`engine.ts handleDialOutcome`, connected branch). After the CAS
   claim and a successful `bridgeToRep`: insert the `dialer_connects` row
   (`ON CONFLICT (call_sid) DO NOTHING` — bare form, the index is not partial),
   THEN start the recording with
   `recordingStatusCallback = /telephony/twilio/dialer-recording?connectId=<id>`.
   Row before recording, so the callback always finds its row. The row is not
   written before the bridge, so a failed bridge never yields a Task for a call
   that did not happen. Recording start is best-effort: one retry after
   750 ms (Twilio warns a record request can land while the new TwiML is still
   being applied), none after error 21220 (the call already ended); a failure stamps
   `start_failed`, logs loudly, and never touches the live call. A failed row
   insert skips the recording (nothing could receive its callback) and logs.
2. **Hang-up.** The dialer's existing status route (`/telephony/twilio/dialer-status`)
   stamps `ended_at` / `talk_seconds` on the row matching `CallSid` whenever it
   is still null — **independent of the item's state**, because a rep's
   Next/End settles the item before the prospect's `completed` arrives. This
   runs alongside, not inside, the engine's existing handling.
3. **Task** — new scan-based worker `salesforce/dialer-connect-worker.ts`
   (deps injection, single-flight loop, kill switch = loop never started, like
   `inbound-text-worker.ts`). **The claim is the lease:** claiming bumps the
   attempt counter by compare-and-swap and pushes `next_attempt_at` out by that
   try's backoff, so there is no in-flight state and no reaper — a crashed try
   simply comes due again. Picks rows with `ended_at` set and `task_state='pending'`, plus rows
   bridged more than 4 h ago whose `ended_at` never arrived (logged with no
   duration). Per row, as the rep (`createCallTask`, `userId` = the rep):
   - Subject — THE call-subject rule: `buildCallSubject({ inbound: false,
     disposition: 'Connected', counterpartyE164: to_number, recordName })`
     → `Outbound Call | Connected | (619) 555-1234 / Jane Doe`. Record name via
     the same lookup click-to-dial sync uses.
   - `Status=Completed`, `TaskSubtype=Call`, `CallType=Outbound`,
     `CallDisposition=Connected`, `CallDurationInSeconds=talk_seconds`,
     `CTI_Origin__c` marker (createCallTask stamps it), Description = a lean
     fixed line naming the Power Dialer (`'Logged by the Power Dialer.'`, like
     click-to-dial — org automations repost Descriptions). The call's time is
     not in the Description; it lives on `Call_Start_Time__c` below.
   - Lead / Contact → `WhoId`; Opportunity → `WhatId`.
   - Custom fields as click-to-dial: `External_Call_Id__c` = row id,
     `Provider_Call_Id__c` = `call_sid`, From/To/Normalized_To,
     `Call_Start_Time__c` = `bridged_at`, `Call_End_Time__c`, `CTI_Provider__c`,
     `Outbound_Caller_ID__c` = `from_number`.
   - **Ownership gate** identical to click-to-dial (`gatedIds` +
     `mayCreateTaskOn`): not the rep's record → `skipped_not_owner`, no Task.
     The recording still exists in the CTI.
   - No Chatter post.
   - After the create the row is due at once, so the link phase (step 4)
     attaches the recording on the next tick if it is already in.
   - Failures back off (5 min, 15 min, 1 h, 3 h, 6 h — the first wait outlasts
     a row's worst case, which the lease requires); the 6th failure →
     `failed` + a loud log line (no retry-forever, unlike
     `sweepUnpushedRecordingLinks`). A Salesforce auth error does not count
     as an attempt (the rep reconnecting fixes it), matching the follow-up
     worker.
4. **Recording completed** — new route `POST /telephony/twilio/dialer-recording?connectId=`:
   signature validated against the full URL (`signedCallbackUrl`), `connectId`
   UUID-checked, `RecordingStatus=completed` only, media URL regex-checked, and
   `CallSid` cross-checked against `call_sid` (the id is public — it is in the
   link). Stores `recording_url` — the webhook itself never calls Salesforce.
   The worker's link phase PATCHes `tdc_cti__Recording_URL__c`
   (`updateCallTask`, as the rep) with the public playback URL on its next
   tick (≤ 5 s) once the Task exists, and stamps `recording_link_synced_at`.
   A rejected field (no tdc_cti license) stamps it too, with a loud log —
   same as the click-to-dial sweep. Capped at 6 `link_attempts` on the same
   backoff.
5. **Playback** — `GET /recordings/:id?sig=` resolves `calls` first, then
   `dialer_connects`. Same HMAC signer (`buildRecordingPublicUrl`); the ids are
   UUIDs, so the two id spaces cannot collide. Same SSRF pin, Range support,
   uniform 404.

## The reps' Salesforce talk-time report

Report `00OUS000007DAyP2AW` ("Copy of SMS 360 Full Report", Activity report):
`Subject contains Outbound,Inbound`, `Assigned = $USER`, `Due Date = TODAY`,
grouped by Assigned + Subject, summing Call Duration. A power-dial Task
qualifies: subject `Outbound Call | Connected | …`, owned by the rep (created
with the rep's token), `CallDurationInSeconds = talk_seconds`.

**Date bug found and fixed here (affects click-to-dial too):** `createCallTask`
dated Tasks with the UTC date, so every call from 5 pm Pacific on was dated
tomorrow and missing from that day's report — 45 of 627 "Call Log" Tasks in the
3 days to 2026-10-01, all created 5 pm–midnight PT. `ActivityDate` is now the
org's (America/Los_Angeles) day; a power-dial Task is dated the day it was
bridged. Already-mis-dated Tasks are not corrected by this change.

## No backfill

Rows only exist from deploy onward, and the worker only logs a Task for a row
bridged within the last **24 h**; older pending rows become `expired`. The
window is not about the Task's date (`createCallTask` dates it the day it was
bridged, not today — see the "Date bug found and fixed here" note above) — it
exists so a stale call can never backfill into a rep's reports days after the
fact, and so a disconnected Salesforce connection's hourly retry
(`AUTH_RETRY_MS`) cannot keep trying forever.

## Untouched

`calls` and every reader of it, all compliance counters, the Recent list, the
pending-disposition banner, the no-answer Chatter, follow-up rollover, and the
softphone UI (no client change).

## Testing

- Unit (TDD): `TwilioDialerTelephony.startRecording` arguments; engine connect
  path ordering — bridge → row → recording; a recording failure leaves the
  bridge and the run alone; a duplicate AMD "human" makes one row; a failed
  bridge makes no row; consent and switches skip recording but keep the row.
- Status route: stamps `ended_at` regardless of the item's state; idempotent.
- Recording route: bad signature 403, CallSid mismatch no-op, non-`completed`
  no-op, Task present → PATCH + stamp.
- Worker: Who/What mapping, subject, ownership skip, 24 h expiry, the 4 h
  missed-callback path, attempt caps, kill switch.
- Playback: resolves a `dialer_connects` id; bad signature 404.
- **Live check** on the E2E harness (`+16194737991` in human mode, CTI DIAL
  TEST list, Chrome softphone as Evren): talk ~15 s, hang up → a Task on the
  test record with `Outbound Call | Connected | …`, a duration, and a Recording
  URL that plays both sides.

## Risk to confirm early

That a Recordings-API recording started on the prospect's leg AFTER it is
re-pointed into `<Dial><Conference>` keeps recording until the leg ends. Check
the Twilio docs during planning; the live check proves it.

## Out of scope

Recovering past calls; the source follow-up Task's `WhatId` on Task runs; a
Chatter post for connects; showing power-dial calls in the softphone's Recent
list; a rep-chosen disposition for power-dial connects.
