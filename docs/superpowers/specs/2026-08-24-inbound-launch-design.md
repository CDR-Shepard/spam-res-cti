# Inbound-Team Launch — Design

**Date:** 2026-08-24 · **Approved by:** Evren (section-by-section)
**Goal:** Launch the CTI fully for the inbound team — 14 reps (4 current + 10 hires) each holding 12 personal numbers (6 LA, 6 SD), a 50-number dialer pool, verified spam defenses, cleaner task subjects, a do-not-power-dial flag, and cross-shift queue handoff.

## Decisions (locked, with the user)

| Decision | Ruling |
|---|---|
| Who gets 12 numbers | All 14 reps: Evren, Matt, Tyler, Jona + 10 inbound hires |
| Pool size | 50 (10 existing + 40 new) |
| Purchase strategy | **Pre-buy all 192 now** (152 agent + 40 pool); hires' numbers sit assigned-and-ready (warmup is usage-based, so nothing ripens early) |
| Lead/Opp runs dial from | The shared pool (keep the split); Task runs + click-to-dial from personal numbers |
| Queue handoff (#3) | **Skip already-worked**: team-wide, keyed by dialed number, same-day (org TZ), power-dial attempts only; visible `skipped/already_worked` rows; fail-open on check error |
| Task subject (#5) | `Outbound Call \| [Disposition] \| (619) 555-1234 / Jane Doe` (number-only when no record matched); `Inbound Call \| …` inbound; both write sites (sync worker + Open CTI client log) |
| Skip on Dialer (#6) | `Skip_on_Dialer__c` checkbox on Lead + Opportunity; excludes from ALL power-dial queues (incl. Task-run targets) as visible `skipped/skip_on_dialer`; click-to-dial unaffected |
| Parked | #4 Opp Hunt random, #7 mobile app, #8 cadence tracking |

## Evidence baseline (2026-08-24)

- **NumberVerifier has never reported**: 28/29 active numbers `health='unknown'`, zero rows with `health_source='numberverifier'`; the only flag ever set came from our reputation worker (+12137742225 `degraded`, 2026-07-10). The webhook endpoint is wired; **enrollment on the NumberVerifier side is the missing piece**.
- Existing usable agent numbers toward the 12-target: Evren 5 (0 LA/5 SD), Matt 5 (2/3, degraded 213 excluded), Tyler 6 (3/3), Jona 0.
- Inbound routing already rings a DID's `assigned_user_id` (sticky caller→agent on pool numbers) — 12 personal numbers need no routing work.
- `scripts/buy-pool-numbers.mjs` exists (search + purchase); Trust Hub assignment script proven 2026-08-23 (29/29); warmup caps: 20/day wk1 → 40 → 70 → 80/day wk4+, keyed to **first use**.

## Sub-project A — Number fleet (192 new numbers)

Extend the buy script into `scripts/buy-agent-numbers.mjs` (+ keep a pool mode): per rep, buy to the 6 LA (213/323) + 6 SD (619/858) target counting existing holdings — Evren 7 (6 LA/1 SD), Matt 7 (4/3), Tyler 6 (3/3), Jona 12, each hire 12 (6/6) = 152 agent; +40 pool (`kind='dialer_pool'`). One pass per number: purchase → Twilio voice webhooks (existing `register-twilio-inbound` flow) → `outbound_numbers` row (`kind`, `assigned_user_id`, active) → Trust Hub business profile + SHAKEN assignment (promote the scratchpad script into `scripts/trusthub-assign.mjs`) → NumberVerifier enrollment (mechanism per B). Repeatable per future hire: `buy-agent-numbers --rep <email>`. The degraded 213 stays benched and uncounted. Fleet ≈ 221; ~$250/mo Twilio; NumberVerifier per-line cost to be confirmed by the user on their plan. Deliverable: a fleet report — every number registered ✓ / enrolled ✓ / assigned ✓ / webhook-confirmed ✓. Capacity during warmup: fresh numbers add ~20 dials/day each from day one; rotation naturally prefers warm numbers.

## Sub-project B — Spam-defense audit (#1, #2)

1. **NumberVerifier end-to-end:** enroll all fleet numbers (their API if the plan has it, else documented dashboard procedure), confirm their webhook targets prod, force a check on one number, and verify `health_source='numberverifier'` lands + the number leaves rotation + an alert fires.
2. **Gate-by-gate live audit** with a controlled probe or prod telemetry per gate: attestation, warmup caps, per-number attempt limit, per-customer ceiling, calling hours, DNC/consent, opt-out, blocked list, answer-rate/duration auto-pause, per-minute rate cap — plus verifying reputation-alert delivery destination. Deliverable: pass/fail report committed to `docs/`; failures become fix tasks immediately.

## Sub-project D+E — Subject format + Skip on Dialer (one branch)

- **D:** one shared pure builder produces the subject for both write sites; name from the phone-match/attached record (`findByPhone` already returns `Name`; click-to-dial carries the name in call state); number formatted `(XXX) XXX-XXXX`; no trailing ` / ` when nameless. Implementation lists org reports/automations matching the old `Outbound Call - ` prefix before shipping.
- **E:** deploy `Skip_on_Dialer__c` (checkbox, default false) on Lead + Opportunity via sf CLI metadata + layout placement; queue build selects the field alongside phones and emits `skipped/skip_on_dialer` rows; Task-run targets inherit the check from their resolved record.

## Sub-project C — Already-worked skip (#3)

At session creation, resolved targets are checked against `dialer_dial_attempts` for any org dial to that E.164 since local midnight (America/Los_Angeles): matches enter as `skipped/already_worked`. The check reads a single indexed query batched over the queue's numbers; an error in it fails OPEN (record dials — availability over dedupe; the one deliberate fail-open, user-approved). The run's own retries are unaffected (check only at creation, against pre-run attempts). Click-to-dial calls do not mark a number worked. Panel shows "N records · K already worked today · dialing M" at start.

## Build order & process

A first (warmup clock + enrollment urgency), B in parallel, then D+E, then C. Each sub-project: spec-referencing plan → subagent-driven implementation → per-task review → whole-branch review → live verification on the CTI DIAL TEST list (D+E: subject lands in SF, Skip box produces the row; C: same-day second run shows `already_worked`). Fail-closed posture everywhere except C's stated exception.
