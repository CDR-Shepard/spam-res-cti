# Power Dialer — Design Spec

**Date:** 2026-07-13
**Status:** Approved design, pending implementation plan
**Feature:** Server-originated, answering-machine-screened power dialer for the CTI, driven from Salesforce list views inside the Sales Console.

---

## 1. Summary

Reps work a list of Leads/Opportunities hands-free. From a Salesforce **list view**, a rep multi-selects records and clicks **"Power Dial."** The CTI backend then dials down the list one record at a time, **screens out answering machines/no-answers automatically**, and **bridges only live humans** to the rep — opening (screen-popping) the record in the Sales Console the instant they connect. No-connects are auto-logged and, where a follow-up task exists, rolled forward to the next business day. Connected calls are dispositioned by the rep, who then clicks **Next** to continue.

The dialer uses a **dedicated pool of numbers** for its cold volume so the reps' warmed "good" numbers are never stained; a number that reaches a live person becomes the **sticky callback number for that lead**, bound to the agent who connected.

This is a **new telephony subsystem** (server-originated calls + AMD + per-rep conference) layered on the existing firewall, recording, disposition, and sticky/rotation logic.

---

## 2. Decisions locked during brainstorming

| Topic | Decision |
|---|---|
| List source | **Native Salesforce list-view button** ("Power Dial") on Lead & Opportunity list views; hands selected record IDs to the CTI. |
| Records / phone | **Leads + Opportunities.** Lead → Mobile then Phone. Opp → **primary Opportunity Contact Role**'s Mobile then Phone. No reachable number → skip. |
| Loop cadence | **Auto through misses, pause after talks.** Misses auto-advance; a connected call pauses the loop until the rep dispositions and clicks **Next**. |
| Voicemail | **AMD (answering-machine detection)** auto-skips machines — full AMD build from day one (chosen "Path B"). |
| Follow-up task match | The calling rep's **open (`IsClosed=false`) Task** on the record whose **Subject matches `/follow[ -]?up/i`** ("Follow-up" / "Followup" / "Follow up"), overdue included. |
| Rollover timing | **Only on no-connects.** Connected calls: the rep sets their own next step; no auto rollover. |
| Next business day | **Salesforce Business Hours working days + Holiday records.** Org has a Default Business Hours set; **0 Holidays configured today → effectively weekends-only** until holidays are added (no code change needed then). |
| New follow-up task | **Copy the original** (Subject/Type/Priority, same rep, same record) due next business day; shift any follow-up datetime field too. No match → create nothing. |
| Number strategy | **Dedicated dialer pool** for cold volume, isolated from reps' good numbers. On connect, the pool DID becomes **sticky to that lead, bound to the agent**, and **stays in the pool**. |
| Screen-pop | **On connect** (when a live human is bridged), not on every dial attempt. |
| Dialing model | **Progressive, not predictive** — exactly one live call per rep at a time → no abandoned calls / TCPA exposure. |

**Named trade-off (accepted):** because the connecting pool DID stays in the pool, it is simultaneously "warm" for connected leads and still cold-blasting others — so a connected lead's follow-ups ride a number that is also doing cold volume.

---

## 3. Architecture & components

1. **Salesforce "Power Dial" list-view action (new LWC).** A list-view button/quick action on Lead & Opportunity list views. The rep multi-selects records → clicks it → an LWC collects the selected record IDs + object type, opens the CTI utility bar, and hands the IDs to the backend to start a session (via the CTI's Open CTI channel / an authenticated call to our API using the rep's session).

2. **Dialer session engine (new backend service).** One active session per rep. Owns the state machine: the queue, current index, and status (`idle → dialing → screening → connected → wrapup → paused → stopped`). Drives the per-record loop. Persists to Postgres so a reload/brief drop can resume.

3. **Number resolution.** Server resolves each record's dial number via the Salesforce REST API using the rep's OAuth token (Lead: Mobile→Phone; Opp: primary Opportunity Contact Role Contact Mobile→Phone), normalized through existing `phone.ts`.

4. **Server-originated dialing + AMD.** Per record: run the existing firewall, then create a Twilio call to the lead from a **dialer-pool DID** with **async machine-detection** + dual-channel recording. Async AMD result routes: **human → bridge into the rep's conference; machine/no-answer → hang up + auto-log + rollover + advance.**

5. **Per-rep conference bridge.** When a run starts, the rep's softphone joins a personal Twilio `<Conference>` (e.g. `pd_<userId>`) and stays in it. Live humans are added to that conference for an instant bridge; misses never reach the rep. Between connects the rep waits in-conference with an on-screen status.

6. **Screen-pop.** On connect, the CTI navigates the Sales Console to the record via Open CTI `navigateToSObject`.

7. **CTI dialer panel (softphone UI).** Shows run progress (X of N, connects, skips, current record) and controls: **Pause / Skip / Stop**, plus the normal wrap-up on a connected call.

---

## 4. The dial loop (per record)

1. Pull next queue item → resolve number → no number = auto-skip (logged, advance).
2. **Firewall** for the record: calling-hours by lead timezone (out-of-window = skip+log), DNC-prescrubbed gate, and DID selection **from the dialer pool** — sticky pool DID if this lead was reached before, else rotate the pool under warmup-cap / health / 10-per-minute-velocity gates. Chosen DID capped → try another pool DID; **whole pool momentarily maxed → pause the run** with a message; resumes as windows free / caps reset.
3. **Originate** the Twilio call from the pool DID → lead, with async AMD + recording + status/AMD callbacks.
4. **Classify the outcome:**
   - **No-answer / busy / failed** → auto-log the attempt (disposition "No answer" / "Busy") → **rollover** → advance.
   - **Machine** (`AnsweredBy=machine`) → hang up (no voicemail-drop in v1) → auto-log ("Left voicemail") → **rollover** → advance.
   - **Human** (`AnsweredBy=human`) → **redirect the callee into the rep's conference** → **screen-pop** → record the **sticky binding** (pool DID ↔ lead ↔ agent) → **pause**. Rep talks, dispositions in the wrap-up, clicks **Next** → advance.
5. **Controls:** Pause (finish current, then hold), Skip (abandon the current dial and move on), Stop (end the session).
6. **The "connecting…" pause:** async AMD needs ~1–2s after answer to classify before the human is bridged (the inherent "telemarketer pause"). Detection is tuned for speed and **biased toward "human"** — we would rather occasionally bridge a voicemail (rep dispositions it) than skip a real person. Rep sees "Connecting…"; the callee hears ringing/brief silence.

---

## 5. Number model

- **`outbound_numbers.kind`** — `'agent'` (assigned to a rep; the warm/good numbers used by manual click-to-dial; existing numbers default here) or `'dialer_pool'` (shared; dedicated to power-dial cold volume). Admins tag numbers into the pool via the existing Numbers admin UI.
- **The power dialer draws only from `dialer_pool` DIDs** — never a rep's agent numbers — so cold-blast churn is isolated to the pool.
- **Sticky-on-connect:** on a live connection, upsert a sticky binding (org, **agent**, **lead E164**) → the pool DID that connected. The DID stays in the pool.
- **Continuity:** the rep's manual callback to that lead and the lead's inbound callback both use/route via that pool DID + agent (reusing `sticky_numbers`).
- **Inbound routing for pool numbers:** a shared pool DID can't route by "the DID's owner." On inbound to a `dialer_pool` DID, look up the sticky binding **by the caller's number** (`sticky_numbers` reverse lookup: org + recipientE164 = caller + e164 = the dialed pool DID) → ring **that agent**'s softphone (`<Dial><Client>rep_<agentId>`), voicemail fallback if none / agent offline. **Agent DIDs keep today's `assignedUserId` routing unchanged.**

---

## 6. Follow-up rollover (only on no-connects)

Runs server-side with the rep's Salesforce token when a record does not reach a live person:

1. **Find** the rep's open Task on that record (`WhoId` or `WhatId` = the record, `OwnerId` = rep, `IsClosed = false`) with Subject matching `/follow[ -]?up/i`, overdue included. If several, act on the **earliest-due** one.
2. **Complete** it (`Status = 'Completed'`).
3. **Create a copy:** same Subject/Type/Priority, same OwnerId, same Who/What, **`ActivityDate` = next business day**. Preserve time-of-day / shift any follow-up datetime custom field. 
4. **No match → create nothing.**

**Next-business-day computation:** read the org's **Default Business Hours** working days (Mon–Fri typically) + **Holiday** records; step forward from today until a working, non-holiday day. Today (0 holidays) this is weekends-only; adding Holiday records changes behavior with no code change. Computed in the org's timezone.

**Idempotency:** the rollover is tied to a single processed call attempt; a record is not re-rolled within the same run.

---

## 7. Safety & edge cases

- **Progressive only (never predictive):** one live call per rep at a time; we only dial while the rep is connected in their conference. No over-dialing → **no abandoned calls / TCPA abandonment exposure.** If the rep drops, the run pauses.
- **Pool reputation protection:** pool DIDs keep warmup cap + 10/min velocity + health gates; rotate on cap, **pause when the whole pool is momentarily maxed.**
- **Calling hours** enforced per lead timezone; out-of-window records are skipped and logged, never dialed.
- **AMD misclassification:** tuned toward "human" to avoid skipping real people; the cost is occasionally bridging a voicemail.
- **Disposition gate coexistence:** misses are auto-dispositioned server-side (they don't trip the "disposition before next" gate); a connected call must be dispositioned by the rep before **Next**.
- **Session recovery:** session + queue state persisted; a reload/brief drop rejoins the conference at the current record; gone too long → pause. One active session per rep.
- **Recording + disclosure:** dual-channel recording as today; the recipient recording disclosure stays **off** (per the prior decision) — no pre-bridge announcement that would add delay.

---

## 8. Data model

**Backend (Postgres / Drizzle):**
- `outbound_numbers`: add **`kind`** enum (`agent` | `dialer_pool`, default `agent`).
- **`dialer_sessions`**: `id, orgId, userId, status, sourceObject, sourceListView?, createdAt, startedAt, endedAt, currentIndex, counts{dialed,connected,skipped,noConnect}`.
- **`dialer_queue_items`**: `id, sessionId, ordinal, objectType, recordId, resolvedNumber?, status(pending|dialing|no_connect|connected|skipped|done), callId?, outcome?, updatedAt`.
- Reuse **`calls`** for each dial (add `dialerSessionId` + `dialerQueueItemId` links).
- Reuse/extend **`sticky_numbers`** for the connect binding + the caller→agent inbound reverse lookup.

**Salesforce:**
- A **"Power Dial" LWC list-view action** on Lead & Opportunity, plus Sales Console app config (CTI in the utility bar; `navigateToSObject`).
- Number resolution + the follow-up rollover use the **Salesforce REST API** from the backend with the rep's OAuth token — **no new Apex**.

**Telephony (Twilio):**
- Server-originated calls via REST `Calls.create` with `machineDetection: 'Enable'`, `asyncAmd: true`, an AMD status callback, dual-channel recording.
- A per-rep `<Conference>`; the rep's softphone joins it; the human leg is redirected into it on `AnsweredBy=human`.

---

## 9. Testing

- **Unit:** number resolution (Lead / Opp primary contact); next-business-day (weekends + holidays; 0-holiday fallback); follow-up match `/follow[ -]?up/i` + copy field mapping; session state-machine transitions; pool DID selection (sticky → rotate → all-capped-pause); inbound caller→agent routing.
- **Integration:** the dial loop against mocked AMD outcomes (human / machine / no-answer paths); the rollover against the `gghsd-maindev` sandbox; the list-view handoff.
- **E2E / manual:** a full run in the Sales Console sandbox with a small test list.
- **Adversarial review** before ship (parallel-lens review, same bar used for recording + disposition-UX).

---

## 10. Out of scope (v-next)

- **Voicemail-drop** on machine-detect (auto-leave a pre-recorded message).
- **Predictive dialing** / multi-line (kept single-line progressive for compliance).
- **Number graduation** (moving a connecting DID out of the pool into a rep's own pool) — chose sticky-in-pool instead.
- Contacts as a dial source (Leads + Opps only for v1).

---

## 11. Open items to confirm during planning

- Exact list-view → CTI handoff mechanism (Open CTI message vs. authenticated POST from the LWC) — decide in the plan.
- Twilio async-AMD tuning params (`machineDetectionTimeout`, speech thresholds) — validate against real calls in sandbox.
- Whether the org uses a follow-up **datetime** custom field that must be shifted alongside `ActivityDate` (verify on Task in `gghsd`).
