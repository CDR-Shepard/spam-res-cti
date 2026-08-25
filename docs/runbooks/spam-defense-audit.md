# Spam-defense gate audit

**Date:** 2026-08-24
**Audited build:** `6db8a4fa584779b33fbeb21f1cf7168825287808` (`origin/main` HEAD) — Railway deployment `f1790d34`, status SUCCESS, deployed 2026-08-23, is exactly that commit. Every code claim below was read from the deployed tree (`git show origin/main:<path>`), and each gate's probe independently confirmed `git diff origin/main -- <its files>` was empty before reasoning from the working tree.
**Method:** read-only. Code review + `SELECT`-only prod queries via `DATABASE_PUBLIC_URL` + read-only Twilio/Railway GETs + existing unit tests. No writes, no live dials.

## Summary

Ten spam-defense gates were probed against the deployed build and against real production telemetry (1,464 calls and 1,465 pre-call audits spanning 2026-06-17 to 2026-08-25T00:34Z, 221 active DIDs). Three gates are fully PASS with live evidence of correct behavior: warmup caps, attempt limits, and rotation health-exclusion — the last of which has a 45-day production proof (DID `+12137742225` flipped to `degraded` on 2026-07-10T17:28:34Z has taken exactly **0** calls since, while the same rep placed 600+ calls from ~20 other numbers). Six gates are DEGRADED — meaning the mechanism exists and is deployed but has a gap that materially reduces its protection — and one, NumberVerifier, is PENDING-USER because enrollment is a manual dashboard step nobody has performed (0/221 numbers enrolled). Two gaps are launch-relevant rather than cosmetic: the **power-dial path enforces no opt-out, no internal blocklist, and no federal DNC check at any layer** (verified across `create-session.ts`, `engine.ts`, `pick-did.ts`, `pick-agent-did.ts`, `twilio-telephony.ts` and the Apex `PowerDialListController.cls` — none of them reference `optOuts`/`blockedNumbers`/`federalDncEntries` or call `evaluate()`), and **NumberVerifier has never reported on a single DID**, which `docs/superpowers/specs/2026-08-24-inbound-launch-design.md` itself names as the missing launch dependency. Both sit directly on the path the 14-rep inbound launch will run on.

**Overall verdict: BLOCKERS-FOUND.** Nothing here endangers current 2-rep beta volume — click-to-dial, which carries 1,300 of the 1,464 calls in prod, is fail-closed and server-enforced end to end. But the 14-rep inbound launch routes all Lead/Opportunity runs through the ungated power-dial path, and two items must clear before that: power-dial compliance enforcement (code fix) and the NumberVerifier NV-1 enrollment proof (user action). The remaining four DEGRADED gates are fix tasks, not blockers.

## Verdicts at a glance

| Gate | Verdict | Strongest single line of evidence |
| --- | --- | --- |
| DNC / consent / opt-out / blocked list | DEGRADED | `src/dialer/{create-session,engine,pick-did,pick-agent-did,twilio-telephony}.ts` contain zero references to `optOuts`/`blockedNumbers`/`federalDncEntries` and never import `evaluate()` — power-dial has no compliance check at any layer. |
| Inbound answer hygiene | DEGRADED | 1 of 221 active DIDs (`+12054303297`) has `inbound_enabled=false` and has answered 22 carrier probes since 2026-07-23 with the generic decline message instead of the intended greeting/voicemail flow. |
| SHAKEN/STIR attestation + Trust Hub | DEGRADED | Trust Hub is 221/221 assigned on both approved profiles, but `baseline_attestation` is NULL on 221/221 rows and `calls.shaken_attestation`/`shaken_verstat` are 0/1464 — gate 7h has never had data to evaluate. |
| Answer-rate/duration auto-pause + alerts | DEGRADED | Auto-pause fired correctly once (2026-07-10, engagement leg, 4.5s avg over 11 calls) and has held for 45 days, but `ALERT_WEBHOOK_URL` is absent from the 30 prod vars, so every alert kind is log-only. |
| Calling-hours guard | DEGRADED | Both enforcement sites work live (2 hard BLOCKs + 1 dialer `out_of_hours` skip in prod), but they use different windows (08:00–20:00 firewall vs 08:00–20:59 dialer) and the power-dial path has no second-layer backstop. |
| Per-minute velocity cap | DEGRADED | The `< 10` clause is deployed identically in all three sites and the write path is live (23 rows incrementing correctly), but max ever observed is 3/min and the SQL predicate has zero automated test coverage. |
| NumberVerifier carrier monitoring | PENDING-USER | `scripts/nv-enrollment-manifest.ts` run against prod prints `enrolled=no` for 221/221 numbers; zero rows anywhere have `health_source='numberverifier'`. |
| Per-DID warmup caps | PASS | 1,453 of 1,465 pre-call audits carry a `warmup` check and every one is `NUMBER_WARMUP_OK`; 0 cap violations across the full historical top-15 by `dials_today`. |
| Per-number attempt limit + per-customer ceiling | PASS | 11 real `BLOCK` audits with `ATTEMPT_LIMIT_EXCEEDED` and `block_reason` literally `5 attempts in last 14d (limit 5)`. |
| Rotation excludes unhealthy numbers + fail-closed | PASS | 0 calls, 0 dial attempts, and 0 pre-call audits from `+12137742225` in the 45 days since it was flagged `degraded`, while the same rep kept dialing from ~20 other numbers. |

---

# Non-PASS gates

Ordered by launch impact, not by verdict label.

## 1. DNC / consent / opt-out / blocked list — DEGRADED

### Evidence

**Click-to-dial is genuinely fail-closed.** The opt-out check (`services/cti-api/src/firewall/index.ts:364-377`) and the blocklist check (`:379-393`) run unconditionally immediately after phone-number parsing, ahead of every other gate; a match sets `severity:'block'`. The federal DNC scrub (`:728-777`) always blocks on an exact `federal_dnc_entries` hit regardless of org mode; absent a hit, `org.dncMode==='external_prescrubbed'` passes green as `DNC_PRESCRUBBED` (labeled as policy, not as a registry check), otherwise `isDncListLoaded()` (`:130-147`, which excludes `source='demo_seed'`) decides between `DNC_OK` and an honestly-labeled `DNC_NOT_LOADED`. An unloaded list is a deliberate, truthfully-labeled fail-open — not a silent bypass. `aggregate()` (`:962-995`) forces `decision=BLOCK` on any failed block-severity check, and `routes/calls.ts` enforces it server-side: `BLOCK` → HTTP 403, `REQUIRE_REVIEW` without `acknowledged:true` → HTTP 412. Not client-bypassable.

**Power-dial enforces none of it.** All five dialer files are diff-clean against `origin/main` and contain zero references to `optOuts`, `blockedNumbers`, or `federalDncEntries`, and none imports `evaluate()` — only `routes/firewall.ts` calls it. `engine.ts` `advanceSession()` (~line 180) calls `deps.telephony.originate()` directly after only `withinCallingHours` (a coarse area-code pre-filter that fails **open** by its own doc comment) and `pickDid` (warmup/velocity/customer-ceiling only). On the Salesforce side, `salesforce/force-app/main/default/classes/PowerDialListController.cls` forwards whatever records the rep checkbox-selects via `PowerDialRelay.sendToCti` with no `DoNotCall`/opt-out SOQL filter — grepping both `.cls` files for `DoNotCall`/`opt` returns nothing but an unrelated Profile query.

**Prod state.** `federal_dnc_entries` = 2 rows, both `source='demo_seed'` (no real registry loaded). `opt_outs` = 0 rows. `blocked_numbers` = 0 rows. The real prod org (`Salesforce Org 00D5f000005w2kWEAQ`) has `dnc_mode='external_prescrubbed'`, matching the ratified beta decision; the only other org row is a `Dev Org` seed at the schema default `registry`.

**Prod telemetry.** Across 1,465 audits (1,427 ALLOW / 21 REQUIRE_REVIEW / 17 BLOCK): `FEDERAL_DNC_PRESCRUBBED` ×949, `FEDERAL_DNC_NOT_LOADED` ×499, `FEDERAL_DNC_CLEAR` ×13. `FEDERAL_DNC_LISTED`, `OPTED_OUT` and `BLOCKED_INTERNAL` have **never** fired — fully explained by empty `opt_outs`/`blocked_numbers` and no loaded list, not by a code defect. All 17 BLOCKs decompose as attempt-limit (11), invalid number (4), outside calling hours (2).

**Volume trajectory.** `calls` = 1,300 outbound + 164 inbound (gated paths). `dialer_dial_attempts` (ungated) = 23 rows total, 2026-07-23 to 2026-08-23. Click-to-dial dominates today, but `docs/superpowers/specs/2026-08-24-inbound-launch-design.md` routes **all** Lead/Opportunity power-dial runs for the incoming 14-rep team through the shared 50-number pool.

### Residual risk

A rep could power-dial a list containing an opted-out or manually-blocked number today and the call would be placed silently — no error, no skipped queue row, no audit trail at all, because the dialer never writes a `pre_call_audits` row. The only reason this has not already happened is that both tables are empty. Separately, the real org's DNC protection rests entirely on an out-of-band "leads are pre-scrubbed before loading into Salesforce" attestation that this system cannot verify; if that offline process lapses, nothing here catches it, since the loaded `federal_dnc_entries` table holds only 2 demo rows. And `opt_outs`/`blocked_numbers` can only be populated through the raw admin API (`routes/admin.ts`) — no rep-facing capture UI exists in `cti-web`, so even the working click-to-dial gate has no lightweight way for a rep to record a live opt-out.

### Fix

1. Give the power-dial path the same opt-out / blocklist / federal-DNC checks the firewall enforces — either call the equivalent sub-checks inside `engine.ts`'s `advanceSession()` before `originate()`, or filter at queue-build time in `create-session.ts`, mirroring the existing `skip_on_dialer`/`already_worked` pattern so the panel shows a visible `skipped/opted_out` or `skipped/dnc_blocked` row. Do this before the 50-number pool scales to launch volume.
2. Add a rep- or admin-facing opt-out/block capture path in `cti-web` instead of requiring the raw admin API.
3. Organizational, not code: reconfirm with the user that the offline pre-scrub behind `dnc_mode='external_prescrubbed'` is actually being followed for every lead list loaded, since the code trusts that attestation with no independent verification.

## 2. Inbound answer hygiene — DEGRADED

### Evidence

`routes/inbound.ts` is byte-identical to `origin/main`. Every inbound POST generates and returns TwiML synchronously in the same request (`:104-322`): the greeting/voicemail branch (owned + enabled), the ring-the-rep branch (assigned user / pool sticky agent), and the disabled-number branch (`!owned || !owned.inboundEnabled` → `"Sorry, this line cannot accept inbound calls right now. Goodbye."` + hangup, `:140-148`) all answer with a TTS response before hanging up. No code path leaves a call unanswered.

Prod fleet: 221 active numbers — 170 agent + 50 dialer_pool with `inbound_enabled=true` (220/221 = 99.5%). Exactly one exception: agent-kind, unassigned reserve number **`+12054303297`** (id `bcb6cb2d-4110-4dfc-962e-986499a4da67`), created 2026-06-18, `inbound_enabled=false`, `active=true`, has a `twilio_sid`. A live read-only Twilio GET on that SID confirms its `VoiceUrl` **is** correctly registered to `https://ctiapi-production.up.railway.app/telephony/twilio/inbound` — so calls reach our webhook and are answered with the decline message; this is not a dead ring or carrier error tone.

The path is live and continuous: 164 inbound `calls` rows total, 75 in the last 14 days, most recent 2026-08-24T23:29:30Z; 186 inbound webhook events, 0 with `signature_valid=false` in the last 30 days. Cross-referencing the 22 all-time webhook events with `processed_at=null` against `calls`: every one has `to_number=+12054303297` and none has a matching `calls` row — exactly the early-return decline branch, which by design skips the calls-insert and the `processedAt` update. The `error` column on `provider_webhook_events` was never populated and 0 rows are stuck `in_progress`, so no silent handler failures.

That number is being actively probed: 22 hits from 2026-07-23 through 2026-08-23, often in tight bursts seconds apart (10:57:53 / :57 / :58 / 10:58:01 / 10:58:07, then 11:02:58 / 11:03:02 / :08 / :12) — the carrier reverse-probe pattern this gate exists to defeat. It currently receives only the generic apology and hangup.

**Root cause.** `POST /admin/outbound-numbers` (`routes/admin.ts:121-165`) never sets `inboundEnabled`, so it silently takes the schema default `false` (`db/schema.ts:196`). Only the bulk `POST /admin/outbound-numbers/import-twilio` (`admin.ts:341`) and the INSERT path of `scripts/buy-agent-numbers.ts` (`:267-268`, hardcoded true) set it explicitly. `buy-agent-numbers.ts`'s UPDATE path for a pre-existing e164 (`:253-263`) never touches `inbound_enabled`, so a number first created via the plain admin endpoint stays disabled even after being "registered" into the launch fleet.

**Secondary finding (does not affect answer hygiene).** 61 of 164 inbound calls (37%) ended as `status='no_answer'` via the reaper in `salesforce/sync.ts` (`INBOUND_STALE_MS` = 10 min), all with `ended_at - started_at` ≈ 10:00 and `duration_seconds=null` — i.e. Twilio's follow-up dial-result/recording callback never arrived, ongoing through today. Since the initial TwiML answer is synchronous and guaranteed, this most likely reflects scanner probes hanging up right after being answered (arguably evidence the gate works), but a live Twilio call-log pull is needed to distinguish that from lost callbacks.

### Residual risk

One live, actively-probed active number has been answering carrier reverse-probes with a generic decline instead of the designed greeting/voicemail flow since 2026-06-18 (~2 months). It is invisible to any dashboard that checks "did the number answer" rather than "did it answer well" — `scripts/fleet-report.ts` reconciles DB↔Twilio VoiceUrl and Trust Hub but does not check `inbound_enabled`. The root cause is structural, not a one-off: any number created through the manual admin endpoint carries the same defect, and re-registering it does not self-heal.

### Fix

1. Immediate data fix: `UPDATE outbound_numbers SET inbound_enabled = true WHERE id = 'bcb6cb2d-4110-4dfc-962e-986499a4da67'` (or via `PATCH /admin/outbound-numbers/:id`) to bring the fleet to 221/221.
2. Structural: default `inboundEnabled: true` in the `POST /admin/outbound-numbers` insert (`admin.ts` ~`:145-155`) to match `import-twilio`, and add `inbound_enabled = true` to the coalesce/UPDATE branch of `scripts/buy-agent-numbers.ts` (~`:253-263`) so re-registering an existing row self-heals it.
3. Add `count(*) filter (where active and not inbound_enabled)` as a standing check in `scripts/fleet-report.ts` so this class of gap surfaces automatically instead of needing an ad hoc SQL sweep.
4. Lower priority: pull the Twilio call log for a sample of the 61 reaped `no_answer` calls to confirm whether they are probe hang-ups (expected, no action) or lost webhook callbacks (an infra reliability gap in outcome logging).

## 3. SHAKEN/STIR attestation + Trust Hub — DEGRADED

### Evidence

**The Trust Hub half is real and working.** Live Twilio GETs: `CustomerProfiles/BUfffd7ec178a44a108e81f2a1e03d0b2d` status `twilio-approved`, friendly name `Femund LLC`; `TrustProducts/BU9aacbc2ad2856cd5a8167c8d556d3a16` (SHAKEN/STIR) status `twilio-approved`, same friendly name. ChannelEndpointAssignments: **221/221** Twilio IncomingPhoneNumbers on the business profile and **221/221** on the SHAKEN product, 0 missing either way. Cross-referenced against `outbound_numbers`: 221/221 active rows exist in Twilio, 0 orphans. The repo's own gate script run live — `railway run -s @cti/api -- npx tsx services/cti-api/scripts/fleet-report.ts` — prints `trusthub✓ | shaken✓` on every row and exits `ALL PROVISIONED`.

**The monitoring half has never functioned.** Gate 7h (`src/firewall/index.ts:844-889`, `REASON.ATTESTATION_UNKNOWN`/`OK`/`DEGRADED`) reads `outboundNumbers.baselineAttestation`; if it is null the gate always passes with `ATTESTATION_UNKNOWN` (info severity) and never reaches the DEGRADED/block branch. Prod: `count(*) filter (where active and baseline_attestation is not null)` = **0 of 221**. In the `calls` table (1,464 rows, 2026-07-01 → 2026-08-25), `shaken_attestation` is non-null on **0** rows and `shaken_verstat` on **0** rows — the capture pipeline has never once populated either column in ~2 months of live traffic. Correspondingly, 1,453 of ~1,464 audit rows carry `STIR_SHAKEN_ATTESTATION_UNKNOWN` in their `reasons` array: every real call that reached this check landed on the permanent no-baseline-yet path.

**Root cause A — no outbound attestation data source exists.** `src/routes/telephony.ts:183-193` dials the outbound PSTN leg via `dial.number({ statusCallback: statusUrl, statusCallbackEvent: ['completed'] }, dest)` — only `completed` is requested. In prod, of 1,298 outbound-dial webhook events ever received, **0** contain a `StirVerstat` key at all (confirmed by listing the full key set of a sampled event: `SipResponseCode` is present, `StirVerstat` is not). Twilio does not send attestation on our own outbound legs on this account/tier. The one alternate source was checked and is unavailable: `GET https://insights.twilio.com/v1/Voice/{CallSid}/Summary` for three recent outbound parent CallSids and their child CallSids all returned **404 (code 20404)** — Voice Insights is not enabled on this account.

**Root cause B — the one place attestation does arrive can never match.** Of 3,065 total webhook events, 185 mention `verstat` and **100%** of them have `Direction='inbound'` — attestation of *other* callers dialing us (sample body: `To=+16197244412` (our DID), `From=+16192262727` (external), `StirVerstat='TN-Validation-Passed-B'`). For inbound calls `calls.fromNumber` is set to the external caller's raw number (`src/routes/inbound.ts:199-206`), never one of our DIDs. The baseline-set query is `outboundNumbers.findFirst({ where: e164 = call.fromNumber })` (`src/routes/telephony.ts:402-417`) — for an inbound row that can never match, so even the 185 events that *do* carry `StirVerstat` are silently discarded. Two independent defects compound to make `baseline_attestation` permanently unreachable.

**No alerting either.** Grepping around the attestation block in `firewall/index.ts` shows no `dispatchAlert` wired to `REASON.ATTESTATION_DEGRADED`, unlike the working `analytics_block_detected` path in `telephony.ts`. Even a data-capture fix would surface only as a per-call block reason to the rep, never a proactive admin alert.

**User-visible symptom.** `src/routes/reputation.ts:26,92-96,190` — the admin dashboard's `shakenAttestationDistribution` axis is fed by the same `calls.shakenAttestation` column, so it is permanently blank/`unknown` fleet-wide.

### Residual risk

Trust Hub provisioning is solid and low-risk: every active DID sits on an approved business profile and an approved SHAKEN/STIR product, so Twilio-side outbound attestation eligibility is correctly configured. The risk is entirely in the app's live-monitoring layer: this CTI has zero visibility into its own outbound attestation and zero ability to detect or react to a carrier-side downgrade on any of the 221 DIDs — no baseline is ever set, the DEGRADED block path can never fire, and no alert is wired even if it could. In practice the other reputation signals (SIP 607/608 analytics-block detection, answer-rate/engagement kill-thresholds, NumberVerifier once enrolled) are carrying the load this gate was meant to carry. Attestation-specific defense is a name, not a function, until fixed.

### Fix

Both bugs must be fixed for gate 7h to ever function.

1. There is currently no live data source for our own outbound attestation. `StirVerstat` only arrives on inbound-direction events, and Voice Insights Summary 404s — this likely needs Voice Insights Advanced Features enabled on the Twilio account (a separate paid opt-in), then a post-call poll of the Call Summary API instead of relying on StatusCallback params.
2. `src/routes/telephony.ts:402-417` keys the baseline-set lookup on `call.fromNumber`, which for an inbound call is the external caller's number. That match can never succeed and should not be used for outbound-DID baseline tracking regardless — inbound caller attestation is a different signal from our own outbound reputation.
3. Once real capture exists, wire `dispatchAlert` to `REASON.ATTESTATION_DEGRADED` (`src/firewall/index.ts` ~`:876`), matching the `analytics_block_detected` pattern in `telephony.ts`.

Per the design doc's stated process ("failures become fix tasks immediately"), file this now.

## 4. Answer-rate/duration reputation auto-pause + alerts — DEGRADED

### Evidence

**The mechanism is proven.** Thresholds (`src/reputation/signals.ts:15-26`): `WINDOW_MS`=24h, `ANSWER_RATE_MIN_SAMPLE`=20, `ANSWER_RATE_FLOOR`=0.05, `ENGAGEMENT_MIN_SAMPLE`=10, `ENGAGEMENT_AVG_SECONDS`=6s — covered by 10 unit tests in `signals.test.ts` (min-sample guard, strict-`<` floor, null-avg handling). `src/server.ts:112` calls `startReputationWorker(app.log, cfg.REPUTATION_WORKER_INTERVAL_MS)` unconditionally at boot with no feature flag, cleared on SIGTERM/SIGINT at `:117-121`. `config.ts:111` defaults the interval to 600,000 ms; `REPUTATION_WORKER_INTERVAL_MS` is present in prod.

`number_health_snapshots` holds exactly **one** row, ever: `source='reputation_worker'`, `health='degraded'`, `captured_at=2026-07-10T17:28:34.238Z`, details `{stats:{dials:13, connected:11, avgConnectedDuration:4.545…}, reasons:['engagement: 4.5s avg over 11 connected calls — below the 6s robocall-fingerprint floor']}`. The DID (`+12137742225`) still reads `health='degraded'`, `health_source='reputation_worker'`, `health_updated_at=2026-07-10T17:28:34Z`; the other 220 active numbers are `unknown`, 0 are `spam_likely`. Its last call was 2026-07-10T17:24:55.711Z — **four minutes before the flip** — and it has taken zero calls in the 45 days since. That proves both a ≤10-minute worker turnaround and that the block has held continuously, not just been written once and ignored.

Enforcement is multi-layered, not a single check: `firewall/index.ts:534` (`!outNum.active || health==='spam_likely' || health==='degraded'` → `severity:'block'`, `REASON.OUTBOUND_NUMBER_UNHEALTHY`), plus pool exclusion at `rotation.ts:93` and `dialer/pick-did.ts:111`.

**Alerting is the gap.** `alerts.ts:34-53` `dispatchAlert` always logs (info/warn) but POSTs only `if (cfg.ALERT_WEBHOOK_URL)` — the sole external channel, with no email/SMS/SF-task fallback anywhere (`grep -rn dispatchAlert` shows one webhook path and three call sites: `reputation/worker.ts`, `routes/integrations.ts`, `routes/telephony.ts`). The full 30-variable prod listing for `@cti/api` does **not** include `ALERT_WEBHOOK_URL`. Every alert kind — `did_auto_paused`, `analytics_block_detected`, `attestation_degraded`, `org_reputation_dropped` — falls through to log-only today.

**Why it has been quiet since.** Recomputing the same 24h stats query for all currently-active non-degraded DIDs with recent dials shows max 7 dials / 6 connected per number in the last 24 hours — below both the 20-dial and 10-connected minimum-sample floors. The post-2026-07-10 silence is low per-DID volume, not a stopped worker. There is also no auto-restore code anywhere (only an aspirational schema comment "Drives safe auto-restore"); `worker.ts:33-35` explicitly skips already-degraded DIDs "until a human or a real provider feed clears it," matching the observed 45-day unattended state.

### Residual risk

The deliverability protection works — the notification does not. With `ALERT_WEBHOOK_URL` unset, a team not tailing Railway logs or checking the admin-gated ReputationPanel would have no idea a number got pulled until they noticed it missing from rotation. Additionally, current volume (single-digit dials/DID per 24h, 1,464 calls fleet-wide since 2026-07-01) means most active numbers never reach the required minimum sample, so the gate's production track record is a single true-positive on the **engagement** leg only; the answer-rate leg (<5% over 20+ dials) has never fired outside unit tests, and there is no evidence of how it behaves on a real fresh or burned DID.

### Fix

Set `ALERT_WEBHOOK_URL` on the prod `@cti/api` Railway service to a real Slack-compatible incoming-webhook URL — it is an optional zod field, so today `dispatchAlert` silently no-ops past the log line for *every* alert kind, not just this gate. Until then, treat auto-pause events as log-only: nobody is proactively notified. Because `alerts.ts` has no non-webhook fallback, also file a follow-up to add a second delivery path (e.g. an SF Task or Chatter post, since this org is SF-centric) so notification survives a webhook misconfiguration or Slack outage.

## 5. Calling-hours guard — DEGRADED

### Evidence

**Two enforcement sites, both live, both proven in prod.**

*Click-to-dial (firewall).* Gate 6 (`firewall/index.ts` ~`:448-486`) calls `isWithinCallingHours(now, tz, campaign.callingHoursStart, campaign.callingHoursEnd, campaign.callingDays)`. Prod `campaign_configs` for both orgs: `calling_hours_start='08:00'`, `calling_hours_end='20:00'`, `calling_days=[1,2,3,4,5]` (Mon–Fri) — an 8am–8pm window (`nowMins < endMins`, end exclusive). `POST /firewall/precall` is registered in `server.ts:97`; `routes/calls.ts:190-204` hard-enforces the persisted audit (`BLOCK` → 403, `REQUIRE_REVIEW` → 412 unless `acknowledged:true`) — server-side authoritative, not UI trust.

*Dialer engine.* `engine.ts:132-138`: `if (!deps.withinCallingHours(next.toNumber, deps.nowUtc)) { setItemIfPending(..., {status:'skipped', outcome:'out_of_hours'}) }`, CAS-guarded against concurrent claims. Deps come from `live-deps.ts:buildEngineDeps()`, imported by `routes/dialer.ts` (9 call sites: session advance/pause/resume/skip/stop/AMD/status webhooks) and `salesforce/followup-worker.ts`.

*The dialer predicate itself.* `dialer/pick-did.ts:40-58`: `CALLING_HOUR_START=8`, `CALLING_HOUR_END_INCLUSIVE=20`, `withinCallingHours()` = `hour>=8 && hour<=20` — i.e. 08:00:00–20:59:59 recipient-local, effectively 8am through 9pm. Confirmed by `pick-did.test.ts` ("allows the 8:00 local boundary", "allows 20:59 local", "blocks 21:00 local", "blocks 07:59 local") and by the doc comment at `config.ts:87-93`. Timezone comes from `timezoneForNumber()` (area-code lookup), not UTC and not the campaign's `recipientTimezone`; an unresolvable TZ (toll-free, non-NANP) **fails open** (`pick-did.ts:44-51`, test "fails open (true) for a number with an unresolvable timezone").

**Live telemetry, click-to-dial.** Across 1,465 audits: `CALLING_HOURS_OK` ×1,446, `CALLING_HOURS_UNKNOWN_TZ` ×7 (→ REQUIRE_REVIEW, mostly toll-free/foreign), `OUTSIDE_CALLING_HOURS` ×2 — both real BLOCKs, same 215/Philadelphia number `+12156694969`, at 2026-07-15T00:13Z and 2026-07-16T00:07Z = ~8:07–8:13pm America/New_York on consecutive nights, correctly outside the 8am–8pm campaign window.

**Live telemetry, dialer.** `dialer_queue_items` = 227 rows: pending 177, unreachable 26, no_connect 22, connected 1, **out_of_hours 1**. That row: `to_number=+12012829900` (201/NJ, America/New_York), `updated_at=2026-07-23T10:34:09Z` = 6:34am ET — correctly before the 8am open, in a real production run.

**Exempt list.** `parseCallingHoursExempt` (`pick-did.ts:62-67`) parses `DIALER_CALLING_HOURS_EXEMPT` into an E.164 Set, wired **only** into the dialer path (`live-deps.ts:37,42`: `exempt.has(toE164) || withinCallingHours(...)`). It is not read anywhere in `firewall/index.ts`, so click-to-dial has no exemption mechanism at all. Prod value is `+12054303297` — an org-owned `kind='agent'`, `active=true` DID (same reserve number as the inbound-hygiene finding), not a prospect, matching the "OWNED test DIDs only" contract in both doc comments. It shows 20 `dialer_queue_items` dials (test runs) and 0 pre-call audits, as expected.

**Gap 1 — window mismatch.** The two sites use different thresholds: firewall 08:00–20:00 (end exclusive), dialer 08:00–20:59 (through the 20th hour). Both sit inside the legal 8am–9pm outer bound, so neither is a violation, but a call the firewall would BLOCK at 8:10pm local can still be attempted by the power dialer at that same instant. `pick-did.ts`'s header comment calls the separation deliberate; no shared constant or test keeps the two values in sync.

**Gap 2 — no backstop for power-dial.** `engine.ts` originates via `deps.telephony.originate(...)` and never calls `evaluate()` or persists a `pre_call_audits` row. For power-dial, the fixed, area-code-inferred, fail-open-on-unknown-TZ `pick-did.ts` predicate is the *only* calling-hours protection. A toll-free or foreign number entering a dialer queue would fail open and be dialable at any hour — the identical scenario on click-to-dial degrades safely to REQUIRE_REVIEW.

**Adjacent, flagged for context.** `db/schema.ts:496-504` defines `state_calling_rules.calling_hours_start/end` and `firewall/index.ts:95` declares `REASON.STATE_RULE_HOURS` (`STATE_RULE_CALLING_HOURS_VIOLATED`), but that reason code is referenced nowhere else in the file. The per-state hours field is stored (7 rows in prod) and rendered in check `detail` text but never gates a decision — so no code path enforces state-specific calling-hour variance narrower than the generic windows.

### Residual risk

The core mechanism is proven live for its documented scope: both windows sit inside the legal bound, both sites are wired into the build actually running in prod, and prod telemetry shows real out-of-hours attempts stopped by both paths. Residual risk is architectural: (1) the power-dial channel has no authoritative second layer behind its coarse pre-filter, so a non-NANP/toll-free number in a dialer queue would be dialable at any hour; (2) the two windows differ by an hour with no shared source of truth, so the click-to-dial vs power-dial boundary is inconsistent by design and undocumented as a risk; (3) `DIALER_CALLING_HOURS_EXEMPT` is a single global env var and nothing in code validates that an entry is an org-owned test DID — its safety today is operational discipline, not a code guarantee.

### Fix

Not required to ship (current prod behavior is safe and evidenced), but to close the gap:

1. Give the dialer engine an independent, server-persisted calling-hours check — or at minimum log and alert on a fail-open TZ resolution in that path — rather than relying solely on the pure `pick-did.ts` predicate.
2. Derive both sites' thresholds from one shared constant/config, or explicitly document and test the 8pm-vs-9pm delta as intentional, so they cannot silently drift further apart.
3. Add a startup-time guard (or a periodic report) validating that every `DIALER_CALLING_HOURS_EXEMPT` entry is a currently-active org-owned `outbound_numbers` row, so the exemption cannot accidentally point at a real customer number after a future edit.

## 6. Per-minute velocity cap — DEGRADED

### Evidence

`dialer/pick-did.ts:87-119` (`attemptIncrement`) is a single atomic `UPDATE … RETURNING` whose WHERE clause includes `(case when last_minute_window_start is null or now()-last_minute_window_start > interval '1 minute' then 0 else last_minute_dial_count end) < 10`, with a SET clause that resets to 1 / rolls the window forward on expiry and increments otherwise. Walking the boundary: calls 1–10 within a rolling minute succeed (pre-increment count 0…9), the 11th sees count=10 and is refused (0 rows updated).

`routes/calls.ts:249-270` (click-to-dial) contains an independently-written but byte-for-byte identical CASE/WHERE clause with the same threshold. There are three literal occurrences of the cap (`pick-did.ts:113`, `calls.ts:268`, `firewall/index.ts:608`) and no env var defines or overrides it (`railway variables -s @cti/api --kv` has no `VELOCITY_*` key) — so despite not being DRY there is no config-drift risk. `pick-agent-did.ts:118-127` (the agent/Task-run path) calls `attemptIncrement(db, args.orgId, e164, effectiveCapFor(row), 'agent')` — the same function and SQL, kind-filtered; `pick-agent-did.test.ts:156` pins that wiring (`expect(attemptIncrement).toHaveBeenCalledWith(db, 'O1', '+16195550001', 40, 'agent')`).

Schema matches: `information_schema.columns` on prod `outbound_numbers` gives `last_minute_dial_count integer not null default 0` and `last_minute_window_start timestamp with time zone` nullable — identical to `db/schema.ts:208-209` and `migrations/0005_spam_resistance.sql:14-15`. No drift.

Prod telemetry: 171 active `agent` DIDs, 50 active `dialer_pool` DIDs; 23 rows currently hold a nonzero `last_minute_dial_count` correlated with real `last_dial_at` timestamps, proving the write path executes on live dials rather than being dead or erroring; 0 rows were inside an active 1-minute window at query time (quiescent, as expected). **Max `last_minute_dial_count` ever observed across the entire table = 3** — no row has ever come within 7 of the cap. `engine.ts` (`advanceSession`) dials one queue item at a time (sequential progressive, not multi-line predictive) and rotates DIDs across a 50–221-number pool, which explains the 1–3/min ceiling; the gate's own detail message frames ≥10/min as an "autodialer fingerprint" burst signature, not a rate normal operation approaches.

**Coverage gap.** `grep -rln "evaluate(" **/*.test.ts` returns zero hits and no `routes/firewall.test.ts` exists, so the advisory `VELOCITY_BURST`/`VELOCITY_OK` check (`firewall/index.ts:594-627`) has no direct test. `pick-did.test.ts`, `pick-agent-did.test.ts` and `routes/calls.test.ts` all mock `attemptIncrement` or the db layer rather than exercising the real SQL predicate against Postgres — the enforcement arithmetic and the `< 10` boundary have zero automated regression coverage anywhere in the repo.

**Precedent that this matters.** Project memory (`cti-hardening-2026-06`) records that the sibling gate inside this same `attemptIncrement`/`calls.ts` UPDATE — the daily warmup cap — previously shipped to prod with a silent pg date-comparison bug that went undetected until it was found by hand, precisely because this raw-SQL gate style had no test net. Same risk class.

### Residual risk

The gate is correctly implemented, deployed at the exact live commit, shared identically by both DID kinds, and its write path is proven live by 23 correctly-incrementing prod rows. But because real dial rates have never approached 10/min (max ever = 3), no telemetry positively proves the *block* half of the WHERE clause refuses a call once crossed — only that it correctly permits low-volume dialing. Combined with zero test coverage of this SQL predicate, a future edit (refactoring the CASE expression, changing `effectiveCapFor`, a column-type change) could silently break the block path the same way the sibling daily cap broke before, and nothing in CI would catch it. That failure mode is demonstrated history for this org, not a hypothetical.

### Fix

Add a real-Postgres integration test (testcontainers or a disposable dev DB) that seeds `outbound_numbers` with `last_minute_dial_count=9`, `last_minute_window_start=now()` and asserts (a) `attemptIncrement(db, orgId, e164, cap, 'dialer_pool')` succeeds on the 10th call and fails on the 11th, and (b) the same assertion with `kind='agent'` through `pick-agent-did`'s claim path — both DID kinds on one shared fixture. Separately add a `routes/firewall.test.ts` (or `firewall/index.test.ts`) case feeding `evaluate()` an `outboundNumberRow` with `lastMinuteDialCount=10`, `lastMinuteWindowStart=now()`, asserting `REASON.VELOCITY_BURST` fires and `aggregate()` returns BLOCK. This is the same class of test that would have caught the earlier warmup-cap regression, applied here before a real burst has to prove it.

## 7. NumberVerifier carrier monitoring — PENDING-USER

### Evidence

`registerIntegrationRoutes(app)` is called unconditionally at startup in `server.ts` (no feature flag) and the route is explicitly exempted from the global 300/min rate limit alongside Twilio webhooks, with a comment noting it is secret-validated first. `routes/integrations.ts` — `POST /integrations/numberverifier/webhook` returns 503 if `cfg.NUMBERVERIFIER_VERIFY_KEY` is unset; otherwise it does a `timingSafeEqual` check against the `x-verifykey` header **before** touching any DB row, and on a flagged classification sets `health`/`health_source='numberverifier'`, inserts a `number_health_snapshots` row, and calls `dispatchAlert`.

The downstream effect is already wired and source-agnostic: `firewall/index.ts:534` and `routes/telephony.ts:141` gate DID eligibility on `health === 'spam_likely' || 'degraded'` regardless of `health_source` — proven live for a different source (the `reputation_worker` flag on `+12137742225`, excluded from rotation ever since). NumberVerifier only has to write the row for the same machinery to fire.

`npx vitest run src/integrations/numberverifier.test.ts` → **6/6 pass**: healthy-when-clean, `spam_likely` on a per-carrier flag, DNO/606/608 hard-block, 607 soft-degrade, comma-separated and array error parsing.

Prod config (names only, no values printed): `NUMBERVERIFIER_VERIFY_KEY` and `NUMBERVERIFIER_API_BASE` are present; `NUMBERVERIFIER_API_KEY` is absent — matching `config.ts`'s comment that the integration is webhook-only today. A live read-only probe of the deployed endpoint confirms the auth branch executes in the deployed build: `POST` with no `x-verifykey` → **401**; with a garbage key → **401 `{"error":"Invalid x-verifykey"}`**. Getting 401 rather than 503 proves the verify key is configured live. The request cannot mutate any row (the key check precedes all DB access) and no secret was sent or received.

Prod state: 221 active `outbound_numbers` — 220 with `health_source=NULL`/`health='unknown'`, 1 with `health_source='reputation_worker'`/`degraded`. **Zero rows anywhere with `health_source='numberverifier'`.** `number_health_snapshots` holds exactly one row (`source='reputation_worker'`, 2026-07-10) and zero from NumberVerifier. Running the runbook's own diagnostic, `services/cti-api/scripts/nv-enrollment-manifest.ts`, against prod prints `enrolled=no` for **221/221** numbers.

This is documented, not undiscovered: `docs/runbooks/numberverifier-enrollment.md` states "The webhook has never fired because no one has ever enrolled a number" and names its own proof gate (**NV-1**: force a check on one number, confirm the manifest's `enrolled` column flips no→yes). `docs/superpowers/specs/2026-08-24-inbound-launch-design.md` ("Evidence baseline") independently reaches the same conclusion the same day: "NumberVerifier has never reported … The webhook endpoint is wired; enrollment on the NumberVerifier side is the missing piece."

### Residual risk

With enrollment at 0/221, a real carrier-side spam flag on any DID will **not** be caught by this gate — it would only be caught by the separate `reputation_worker` behavioral heuristic or the analytics-block path, which are different signals with different blind spots. Because no real payload has ever hit the webhook, the route's compatibility with NumberVerifier's actual live payload shape is unverified beyond the unit-tested pure classifier and the runbook's synthetic-payload assumptions (v2 schema, DNO/606/607/608 codes) — INCONCLUSIVE until NV-1 is performed. There is also no route-level integration test for `routes/integrations.ts`; the live 401 probe confirms the auth branch, but the full authenticated round trip (DB match → health update → snapshot insert → alert dispatch) has no automated coverage and could not be exercised here, since it would require the real verify key.

### Fix

None in code — this is the pending human step the runbook already documents, not a defect. See the handoff at the end of this report.

---

# Appendix: PASS gates

Each PASS gate's single strongest piece of evidence. Full probe evidence is retained in the audit run.

**Per-DID warmup caps (dialer_pool + agent-kind DIDs).** Real production telemetry: of 1,465 `pre_call_audits` rows spanning 2026-06-17 to 2026-08-25, **1,453 include a `warmup` check and every single one carries `NUMBER_WARMUP_OK`** — zero `NUMBER_WARMUP_LIMIT_EXCEEDED` ever (the 12 without the check predate a resolved DID, per the `if (outboundNumberRow)` guard). Independently, computing each row's tier cap from `first_used_at` across the all-time top-15 by `dials_today` found 0 violations; the closest any number has come is 5 dials against a tier floor of 20. Supporting: `db/index.ts:19`'s `pg.types.setTypeParser(pg.types.builtins.DATE, v=>v)` — the fix for the earlier silent-disable bug — is confirmed present in `origin/main` and re-verified by round-tripping `dials_today_date` from prod as a plain `YYYY-MM-DD` string. Enforcement is three-layered (`rotation.ts:99` pre-filter, `firewall/index.ts:573-598` block-severity check, and TOCTOU-safe `UPDATE … WHERE dials_today < cap … RETURNING` at dial time in both `pick-did.ts:87-118` and `routes/calls.ts:250-276`), with 40/40 unit tests passing and no API surface anywhere for setting `warmup_override_cap` (0 overrides in prod). *Caveat carried forward:* the BLOCK/429 branch has never fired in prod because volume has stayed far under every tier — worth confirming a real `NUMBER_WARMUP_LIMIT_EXCEEDED` appears as beta volume ramps.

**Per-number attempt limit + per-customer ceiling.** Live-fire proof: `pre_call_audits` for the prod org contains **11 rows with `decision='BLOCK'` and `ATTEMPT_LIMIT_EXCEEDED`**, with `block_reason` reading literally `5 attempts in last 14d (limit 5)` and `9 attempts in last 14d (limit 5)`, dated 2026-06-18 through 2026-07-15 — this gate has stopped real click-to-dial attempts. `customerAttemptCounts()` unions grouped counts from **both** `calls` and `dialer_dial_attempts`, the single shared definition of an attempt. The per-customer ceiling half has no BLOCK telemetry, but that was tested rather than assumed: replaying every outbound attempt since the gate shipped (962 rows, 394 distinct customers, 2026-07-15 → today) through a trailing-14-day sliding window found max 9 total per customer against a ceiling of 15 and no `(customer, number)` pair over 5 — the ceiling was never in a position to fire. Prod `campaign_configs` for both orgs: `max_attempts=5`, `attempt_window_days=14`, `per_customer_max_attempts=15`, `paused=false`; `firewall/attempts.test.ts` pins the boundary at `atCustomerCeiling(14,15)=false / (15,15)=true / (16,15)=true`. *Caveat carried forward:* the ceiling's live BLOCK path and its power-dial skip path (shipped 2026-08-22, two days before this audit, with only 23 `dialer_dial_attempts` rows ever) remain unexercised by real traffic — with 221 numbers in the fleet a rep could in principle rotate across enough DIDs to reach a 16th contact before any single number hits its own cap of 5, a scenario that has never occurred in this org's history.

**Rotation excludes unhealthy numbers + fail-closed.** Six weeks of live production proof on the one real degraded number: `+12137742225` was flagged `degraded` at 2026-07-10T17:28:34.233Z (`health_source='reputation_worker'`, still `active=true` and still assigned, i.e. structurally eligible but for health), and since that instant it has **0 `calls` rows, 0 `dialer_dial_attempts` rows, and 0 `pre_call_audits` rows** — while the same rep placed 600+ calls from ~20 other assigned numbers between 2026-07-10T17:50Z and today, proving rotation swapped away rather than the rep going idle. Four independent enforcement points back this: `rotation.ts` `pickRotationNumber()` filters `health !== 'spam_likely' && health !== 'degraded'` before ranking and returns `eligible[0]?.n.e164 ?? null` (fails **closed**, no default-caller-ID fallback); `pick-did.ts` `attemptIncrement()` re-checks `notInArray(health, ['spam_likely','degraded'])` inside the same atomic claim UPDATE; `firewall/index.ts:489-551` independently blocks an explicitly-pinned unhealthy number with `OUTBOUND_NUMBER_UNHEALTHY`; and `routes/calls.ts:224-267` re-checks health atomically at the actual dial moment (0 rows updated → HTTP 429), closing the window between audit and dial. 51/51 unit tests pass across `rotation.test.ts`, `pick-did.test.ts`, `pick-agent-did.test.ts`, including "excludes spam_likely and degraded DIDs" and "returns null (fail-closed) when the pool is empty". No health/rotation feature flag exists in the 38 prod vars. *Caveat carried forward:* the `routes/calls.ts` re-check and the firewall's pinned-number block are hand-duplicated copies of the `attemptIncrement` predicate rather than calls into one shared function, and neither branch has route-level or live-DB test coverage.

---

## What this audit could not do

This was a **read-only** audit. Every finding above rests on deployed source, existing unit tests, `SELECT`-only prod queries, read-only Twilio/Railway GETs, and historical telemetry. Specifically out of scope:

- **No live dial probes.** No call was placed, no queue item advanced, no webhook replayed with a valid signature. Gates whose block branch has never fired against real traffic — the warmup 429, the per-customer ceiling BLOCK, the `< 10` velocity refusal, and the attestation DEGRADED path — were verified by code reading, boundary math, and unit tests, not by observing a refusal. Those confirmations ride the **post-push live verifications**, not this document.
- **No writes of any kind.** The one-line `inbound_enabled` data fix in §2 was identified but not applied. All temporary probe scripts (`.tmp-audit*.mjs`, `.tmp-warmup-audit*.mjs`) were deleted after use; `git status` confirms none remain.
- **No authenticated NumberVerifier round trip.** The live probe stopped at the 401 auth boundary; the full DB-match → health-update → snapshot-insert → alert-dispatch path was not exercised, since it would require the real verify key.
- **No Twilio call-log pull.** The 37% inbound `no_answer`-via-reaper rate (61 of 164) could not be resolved from the DB alone — distinguishing benign scanner hang-ups from genuinely lost dial-result/recording callbacks needs Twilio's own call log.
- **No coverage of unpushed work.** The audit baseline is the deployed commit `6db8a4f`. Local `main` was observed to be ~46 commits ahead of `origin/main` with no deploy evidence checked; nothing in that delta is covered here, and it should be confirmed before anyone treats local-tree state as authoritative for these gates.

## Handoff: NumberVerifier (PENDING-USER)

This gate cannot be resolved by code and is the one item on this list that needs the user directly. Follow `docs/runbooks/numberverifier-enrollment.md` end to end:

1. Generate the list — `npx tsx scripts/nv-enrollment-manifest.ts` from `services/cti-api` against prod, read-only. Today it prints `enrolled=no` for all 221 numbers.
2. Log into `app.numberverifier.com` and add all 221 fleet numbers to the **GG Homes** campaign.
3. Set the campaign's webhook URL to `https://ctiapi-production.up.railway.app/integrations/numberverifier/webhook`, with the webhook secret matching `NUMBERVERIFIER_VERIFY_KEY` on `@cti/api` in Railway (already set — the live 401 probe confirms it).
4. Force a check on one number and re-run the manifest to confirm that number's `enrolled` flips `no` → `yes`. That is the runbook's **NV-1** proof.

Only after that flip should NV-1 be marked satisfied and this gate re-audited to PASS or FAIL on real telemetry. Until then, carrier-side spam flags are invisible to this system except through the behavioral `reputation_worker` heuristic and the analytics-block path — different signals with different blind spots.
