# AI calls that know the record, book appointments, and write back to Salesforce (plan 1D)

Date 2026-10-06. Base: `origin/main` 6d508ba. Plans 1A, 1C and the AI voice engine are live in production. Branch `feat/ai-call-1d`. The plan is `docs/superpowers/plans/2026-10-06-ai-call-1d.md`. The user's decisions are in `.superpowers/sdd/1d-decisions.md`.

## Decisions for the user

### Made (the user's answers, 2026-10-06)

1. **Who takes AI-booked appointments: one person, Grant Golden** (Sales Manager, America/Los_Angeles, `0058X00000Fsx39QAB`). "He will distribute them as he sees fit." Every slot comes from his calendar and every Event is his. There is no owner-first rule and no rotation. The settings keep an editable, ordered list whose first active user is the owner; the default list is Grant (from outreach-api config, so no user id is hard-coded). Booking is on once the list resolves to an active user.
2. **A Lead that books is converted by the AI**, the way the team converts: status Qualified, a new Person Account and Contact, an Opportunity named after the Lead and owned by Grant, then the Event on that Opportunity and stage Appointment Set (§5.7). It uses the standard SOAP API call `convertLead()`, so no Apex is deployed. The hold + "convert and book" Task path is kept **only as the fallback** when Salesforce refuses the conversion.
3. **Booking hours:** the defaults are kept (§4).
4. **Status and stage tables:** approved as written (§5.2, §5.3).
5. **Who the edits show as: not decided.** The write-back acts as whatever Salesforce user the integration connection signed in as. Nothing depends on which user that is. A dedicated "AI Outreach" user would make record history readable, but it needs its own paid Salesforce license (§9).

### Still open (new, from designing the conversion)

1. **Lead Manager on an Opportunity the AI converts.** The org's appointment flow gives the "Confirm Appointment" Task to the Opportunity's Lead Manager, and the team's Lead Manager is the setter who converted it (90% of the last 60 days' conversions).
   - **Recommendation:** the Lead's owner before conversion when that is an active user, otherwise Grant.
   - **The alternative** is always Grant, so he gets every confirmation Task as well as every appointment.
2. **When Salesforce refuses a conversion.** Some Leads cannot be converted by anyone but certain users: a Hunt-queue Lead (`Hunt_Winner_Owner_Change`), a Lead first owned by "spam" (`Spam_Status_Lock`), or a connected user without the Convert Leads permission.
   - **Recommendation:** keep the fallback. A hold goes on Grant's calendar so the time is not double-booked, and Grant gets an urgent Task: "AI booked <time> but could not convert this Lead — convert it and book it", with the reason. The Lead goes to Working and Hot, and the Chatter post goes on the Lead.
   - **The alternative** is a Task only, with no hold.
3. **Carrying values the org's lead mapping drops.** The org's Lead → Opportunity field mapping does not carry the AI call consent fields (`AI_Call_Consent__c`, `_Date__c`, `_Source__c`), `Spanish_Speaker__c` or `Skip_on_Dialer__c`.
   - **Recommendation, part one:** after converting, the AI copies them onto the new Opportunity, exactly and only into blanks. Consent is never created or upgraded.
   - **Recommendation, part two:** an admin also adds them to Setup → Lead → Map Lead Fields, so the team's own conversions carry them too. That part is optional.
4. **An Opportunity a closer owns.** Per decision 1, an appointment booked on a closer's Opportunity goes on Grant's calendar while the closer stays the owner.
   - **Recommendation:** keep it that way, as you said. The Chatter post tells the closer.
   - **The alternative** is the closer's own calendar when the closer is active. That would bring back the owner-first rule you turned down.

## 1. What changes, in one paragraph

1C calls a stale lead with a plan written from the whole Salesforce record. 1D adds three things:
- **The call treats the person as someone we already know.** It opens with "we spoke back in February about the house on Oak Street — are you still thinking about selling?" and asks only about what the record is missing.
- **The seller can book an appointment during the call,** either a phone consultation or an in-person walkthrough. The times come from the appointment owner's real Salesforce calendar (Grant Golden, who distributes them).
- **After the call, outreach-api writes the result to Salesforce once.**
  - It fills the empty or "didn't ask" qualification fields and never overwrites a rep's value.
  - It moves Status or Stage and the next follow-up.
  - When a Lead books, it converts the Lead the way the team does, then works on the new Opportunity.
  - It creates the appointment Event exactly the way reps do, so the org's own appointment flows run.
  - It writes a new field, **AI Last Call Changes**, that lists every change as old → new.
  - It posts a short Chatter summary.

An admin can also place a **practice call**: the real record's plan and the same appointment times, but the call rings the admin's own test number and nothing is written to Salesforce.

**The 1C carry-forward rules (CF-1 to CF-14) all still bind.** The plan's Global Constraints map each one to the tasks that honour it. The ones 1D touches most:
- **CF-1:** the activity check ignores the write-back's own Events and Tasks.
- **CF-5:** consent is copied exactly onto a converted Opportunity and never created.
- **CF-9 and CF-14:** slots are never plan text; the last-contact words have no digits.
- **CF-13:** slots go only on a freshly minted trigger key.

## 2. Production Salesforce facts this design rests on

All of these were read from org `_t2` on 2026-10-06, read-only.

- **Appointments are Events on Opportunities, never on Leads.**
  - `Subject` is "Property Consultation" (in person, 60 minutes, 845 in 90 days) or "Phone Consultation" (15 minutes, 595).
  - `WhatId` is the Opportunity and `WhoId` is null. `Location` is the property address and `ShowAs` is Busy.
  - The validation rule `Appointment_on_Lead` refuses any Event whose `WhoId` is a Lead.
- **The org's automation reacts to those Subjects.**
  - `Event_Stamp_Consultation_Type` sets `Consultation_Type__c`.
  - `Event_Appointment_Confirm_Task` creates the confirmation and "In Person Set" Tasks.
  - `Event_c_as` and `Event_After_Create` handle the PPC webhook and the lead source.
  - Once created, a Property Consultation cannot be re-timed, re-owned, re-linked or deleted without an Appointment Change Request: the `In_Person_Consult_*` validation rules plus the `EventDeleteGuard` trigger. **The AI must get it right the first time.**
- **The Opportunity's appointment fields are DLRS rollups from Events. The AI never writes them:**
  - `Appointment_Date_Time__c`, `Phone_Appointment_Date_Time__c`, `Latest_In_Person_Appointment_Date_Time__c`, `Non_In_Person_Appointment_DateTime__c`, `Latest_Appointment_Date__c`, `In_Person_Appointment_Count__c`;
  - `Appointment__c`, a formula: `In_Person_Appointment_Count__c > 0`;
  - `Last_Chatter_Date__c`, a rollup from FeedItem on both objects;
  - `NextStep` and `Next_Task_Due_Date__c`, Task rollups.
- **Closed Lost requires `Loss_Reason__c`** (validation `Closed_Lost_Reason`). `Closed_Lost_Reason__c` is a separate picklist.
- **A queue-owned Lead's Status can change only to Unqualified or Duplicate** (`Deny_Status_Change_While_Still_Queue`). About 36% of stale Leads are queue-owned.
- **A Chatter post on a Lead is at most 980 characters** (the `FeedItemTrigger` Apex trigger).
- **The picklist values the mapping uses:**
  - Lead `Status`: New | Working | Long Term Follow-Up | Unqualified | Duplicate | Qualified. "Qualified" means converted; 21k Leads are Qualified and converted.
  - Lead `Rating`: Hot | Warm | Cold. Opportunity `Rating__c`: Hot | Warm | Cool | Cold.
  - Lead `Unqualified_Reason__c` includes "Not Interested", "Already sold (MLS)", "Already sold (Other Investor)", "Went with Competition" and "Hostile/Remove from list".
  - Opportunity `Loss_Reason__c` includes "Sold on MLS", "Sold to Other Investor", "Sold to iBuyer", "Lost to Competitor", "Hostile/Remove From List" and "Other".
  - **The "didn't ask" style values** are I Didn't Ask, Didn't Ask, Seller Didn't Say, Seller Wouldn't Say, Seller Wouldn't Disclose and Unsure.
  - **Values change, so they are read from a describe at run time.** The tables below are defaults, validated against that describe before use.
- **Everyone who owns a consultation is in America/Los_Angeles** (`User.TimeZoneSidKey`), Grant Golden included.
- **How the team converts Leads** (1,187 conversions in the last 60 days):
  - **Status and records.** The converted status is "Qualified", the only `IsConverted` status. Every conversion created a **new** Account and Contact: 1,185 of 1,185. The Lead's Company is always blank, so the Account is a Person Account. The org has no active duplicate rules.
  - **Record types.** The Account is always "Person Account" and the Opportunity "Homeowner Opportunity".
  - **Opportunity name.** The Lead's name (985 of 1,185; reps renamed the rest later).
  - **Owner.** The converter picks a closer: the Opportunity owner differs from the Lead owner 73% of the time.
  - **Lead Manager.** `LeadManager__c` is the converting setter, the Lead's owner, in 90%.
  - **Stage.** The Opportunity starts at "New Opportunity" (284 of 285 sampled). A rep moves it to Appointment Set after booking the Event, a median of 8 minutes later. No flow does it.
  - **What runs on insert:**
    - the Opportunity flows `Opp_c_bs` (phones; address from the Person Account; Opportunity owner = the Account owner), `Opportunity_On_Create`, `Auto_Comp_on_Lead_Conversion` (a comp request, because `From_Lead__c` is mapped), `Lead_Conversion_Pull_Email_from_PA` and the drip assignment;
    - the Lead triggers `leadConvertChatter` and `LeadConverted`, which come from a managed package and are not readable;
    - `CallRail_Opp_Owner_Update` would re-own the Opportunity, but the Lead's CallRail field is not in the lead mapping, so it does not fire on a conversion.
  - **Validation rules that can refuse a conversion:** `Hunt_Winner_Owner_Change` (a Hunt-queue Lead given to someone other than the Hunt winner) and `Spam_Status_Lock`. Changing the owner after conversion would run owner-change flows and Task re-owning, so the AI sets the owner at conversion and never changes it afterwards.
  - **The lead field mapping** carries the qualification fields (Motivation, Timeline, Condition, repairs, Occupancy, asking price → `SellersAskingPrice__c`, Competition, Amount Owed and more). It does **not** carry the AI call consent fields, `Spanish_Speaker__c` or `Skip_on_Dialer__c`.
- **The REST API has no lead-convert resource.** The standard actions list only `invocableApplyLeadAssignmentRules`. The SOAP API's `convertLead()` is the standard path, and it accepts an OAuth access token as its session id.
- **The integration connection.** `AI_Outreach` is deployed but assigned to nobody. The org's `integration@gghomessd.com` is a System Administrator. Which user the outreach connection signed in as is not visible from Salesforce, so the runbook confirms it.

## 3. Flows

```
plan time (call.prepare)                 trigger time (ai_call.place)                    call (cti-api)                          after (ai_call.results → ai_call.writeback)
research snapshot                        fresh record read (1C)                           opener: "we spoke back in February…"     results tick counts the call once
  + last real contact (words)            owner (Grant) + free slots (his Events)          asks only what is missing                 → enqueues ONE write-back row (same tx)
  + what Salesforce is missing  ──plan──► context.returning, slots[] ──signed request──►  live transfer, or book_appointment     ─► write-back tick: describe, fresh read,
plan: reengagement, stillToLearn         (practice: same, to a test number)              → ai_calls.appointment                       a booked Lead: convert (SOAP) → new Opp,
                                                                                                                                       Claude maps answers → picklists,
                                                                                                                                       Event on the Opp (fallback: hold + Task),
                                                                                                                                       fields + AI Last Call Changes,
                                                                                                                                       Chatter post
```

### 3.1 Re-engagement (plan time)

**Research gains two computed facts.** Both are deterministic code, not the model.
- **The last real contact:**
  - the newest connected call Task, past consultation Event or email;
  - never one of our own AI call Tasks;
  - written in words with no digits ("back in February", "about a year ago").
- **What Salesforce is missing.** Each qualification topic maps to fields (§5.1). A topic is missing when every one of its fields is blank or holds a "didn't ask" value.

**The plan model receives both** inside a `<facts>` block and fills two new plan fields:
- **`reengagement`:**
  - `lastContact`, which is always overwritten with the computed words after parsing;
  - `lastTopic`, what was discussed, in its own words.
- **`stillToLearn`:** a subset of the missing topics. An empty answer falls back to all of them.

The goals and questions cover only those topics. The opener asks whether they are still thinking about selling the house on <street>. Both new fields reach the agent through the plan text, which passes `agentPlanTextIssues` as it always has. Month names pass; digits never do.

**Old stored plans still parse:** `reengagement` defaults to null and `stillToLearn` to `[]`.

### 3.2 Appointment slots (trigger time)

Right before the trigger, `ai_call.place` takes the appointment owner, the first active user on the list (decision 1: Grant Golden). It reads his user record and Events through the integration connection. The offer is the same for every Lead and Opportunity.

**Slot ids:**
- `p1`… are phone consultations and `w1`… are walkthroughs, at most 6 of each.
- Slots fall inside the business hours (decision 3), in the owner's time zone.
- A slot never overlaps an Event that is not Free: all-day Events block the whole day, and the walkthrough travel buffer applies.

**Where they go:** the slots travel in the signed trigger request, and cti-api stores them on `ai_calls.offered_slots`.

**When slots are empty:** any failure (booking off, nobody active on the list, no free time, Salesforce error) yields no slots. The call still goes ahead and offers a callback. A broken calendar never stops a call.

### 3.3 The call (cti-api)

**When the plan says we know them (`context.returning`):**
- After the disclosure, the agent opens with the plan's opener and never pitches us as strangers.
- Qualifying asks only the plan's still-to-learn topics.

**The hand-off order:**
1. Someone interested who wants to talk now is transferred live, as today.
2. Someone who would rather pick a time is offered a choice of a phone call with a specialist ("a quick call with Grant") or an in-person walkthrough, then two times of that kind in their own time zone.
   - A walkthrough needs the property address confirmed first ("that's the house on Oak Street, right?").
   - The agent then calls `book_appointment(slot_id, address_confirmed, note)`.
3. If no time works, a callback.

**What `book_appointment` does:**
- It checks the id against the offered slots and refuses a walkthrough without `address_confirmed`.
- It stores `ai_calls.appointment` and adds an "Appointment booked: …" line to the summary.
- The agent confirms in one line, says goodbye, and ends the call with the new outcome `appointment_set`.
- An `end_call` with `appointment_set` but no stored booking is recorded as `qualified_callback`.

**Unchanged:** the disclosure, the price rule, do-not-call and safety rules all stay, after the plan fence.

### 3.4 Write-back (after the call)

**Enqueue.** `ai_call.results` already counts each finished call once, through a compare-and-swap on `touches.counted_at`. In that same transaction it inserts one `ai_call_writebacks` row. The table has a unique index on `ai_call_id`, and the insert uses `on conflict do nothing`.
- **Only these outcomes enqueue:** qualified_transferred, qualified_callback, appointment_set, transfer_failed, not_interested, do_not_call, wrong_number, hung_up and other.
- **Never enqueued:** voicemail, no answer, busy, failed and blocked, and never a test or practice call, which has no touch.

**The tick.** `ai_call.writeback` runs every minute. It claims due rows with a lease and runs the steps below.
- Each step's result is saved before the next step starts, so a retry resumes and never redoes a step.

0. **Convert** (a Lead whose call booked an appointment; §5.7).
   - **The Lead is read first.**
     - Already converted: its Opportunity is adopted, never converted again.
     - Otherwise: `convertLead` with owner = Grant and status Qualified. The new ids are saved at once.
   - **Then one PATCH on the new Opportunity carries** the values the lead mapping drops (consent, Spanish speaker, Skip on Dialer; blanks only) and the Lead Manager. This happens before the Event, because the confirmation Task goes to the Lead Manager.
   - **Every later step writes to the new Opportunity,** exactly as for an Opportunity call.
   - **When the conversion is refused for good,** the steps target the Lead and take the fallback (step 2).

1. **Plan the write.** This runs once, and the result is frozen on the row.
   - **Read the current state:**
     - describe the record as the integration user, keeping only fields it can update that are not calculated and not on the rollup deny-list;
     - read the record fresh;
     - re-read Status or Stage as it was at research time.
   - **Map the answers.** Claude gets one forced tool call whose schema enums are built from that describe. Its input is the call's qualification, the caller's own words from the transcript, and the summary, all as escaped data. It returns:
     - per-field values with an evidence quote from the caller;
     - a disposition: interested, not_now, not_selling, sold_mls, sold_investor, sold_ibuyer, listed_with_agent or unknown.
   - **Build the patch** with the pure builder, applying the fill-blank rule and the §5 tables.
2. **Appointment** (when the call booked one):
   - **For an Opportunity, including a Lead just converted:**
     - re-check the owner's calendar for the slot;
     - if it is free, create the Event the way reps do (§5.4), first looking for one we already made (same owner, start, `WhatId` and `CTI_Origin__c = 'AI Outreach'`);
     - if it is taken, the stage moves to Followup instead and a conflict Task goes to the owner.
   - **For a Lead whose conversion was refused (the fallback):** a hold Event on Grant's calendar plus the "convert and book" Task to Grant.
3. **Fields.** One PATCH carries the patch plus `AI_Last_Call_Changes__c`.
   - If Salesforce refuses particular fields (a validation rule, a restricted value, a queue-owned Lead's Status), those fields are dropped, recorded as "not written: <reason>", and the PATCH is tried again, at most 3 times.
   - For an Opportunity, do-not-call also sets `DoNotCall` on the primary contact role's Contact.
4. **Task** (an appointment conflict or refusal, or the fallback), always owned by the appointment owner.
5. **Chatter.** One FeedItem on the record written to: after a conversion, the new Opportunity (§5.6).

**How a row ends:**

| Status | When |
|---|---|
| `done` | Every step succeeded |
| `partial` | A field or step was refused for good (including a refused conversion that took the fallback); the rest stands |
| `skipped` | The record is gone, or there was nothing to write (hung_up or other with nothing learned) |
| `failed` | Transient errors used up 6 attempts (backoff 1 m, 5 m, 30 m, 2 h, 6 h, 24 h). An admin can retry it from the results page |

Results show the status, the change list and, after a conversion, a link to the new Opportunity. Write-back never converts, books or writes for a test or practice call: there is no touch, and the worker also checks `is_test` before any Salesforce request.

## 4. Data model

Every migration starts with `SET LOCAL lock_timeout = '5s';` and uses `IF NOT EXISTS`.

**`0054_ai_call_booking.sql`.** This is CTI-owned (`schema.ts`). It adds columns to `ai_calls`:

| Column | Type | Meaning |
|---|---|---|
| `offered_slots` | jsonb not null default `'[]'` | The `AppointmentSlot[]` this call was given |
| `appointment` | jsonb null | The `BookedAppointment` from `book_appointment` |
| `practice` | boolean not null default false, `CHECK (NOT practice OR is_test)` | A practice call: real record context, a test number |

**`0055_ai_call_writebacks.sql`.** This is outreach-owned (`schema-outreach.ts`; foreign keys in SQL only).

`ai_call_writebacks`:
- **Ids:** `id` and `org_id`, plus `ai_call_id`, which is UNIQUE and cascades on delete.
- **What it is for:** `touch_id`, `enrollment_id`, `sf_object` (Lead or Opportunity), `sf_record_id` and `outcome`.
- **State:** `status` (pending, running, done, partial, failed or skipped), `attempts`, `next_attempt_at` and `locked_until`.
- **The frozen write plan:** `plan` jsonb.
- **Per-step results:** `steps` jsonb.
- **What it created:** `sf_event_id`, `sf_task_id` and `sf_feed_item_id`.
- **The conversion:** `converted_opportunity_id`, `converted_account_id` and `converted_contact_id`. They are set once, never replaced, and every step after the conversion writes to `converted_opportunity_id`.
- **Model use:** `model`, `input_tokens` and `output_tokens`.
- **Bookkeeping:** `last_error`, `created_at`, `updated_at` and `completed_at`.
- **Indexes:** the unique `ai_call_id`, and `(next_attempt_at) WHERE status IN ('pending','running')`.

`ai_practice_calls`:
- **Ids:** `id`, `org_id`, `campaign_id`, `enrollment_id`.
- **The plan:** `call_plan_id` and `plan_version`.
- **The call:** `ai_call_id`, `requested_by`, `to_e164` and `idempotency_key`.
- **The answer:** `result` jsonb (the internal response).
- **Timing:** `created_at`.
- **Index:** `(campaign_id, created_at desc)`.

**Settings** (`organizations.settings`, read tolerantly by `outreachSettings`):
- `aiCallBooking`:
  - `enabled`;
  - `specialists`, an ordered list of Salesforce user ids, at most 20. The first active one is the appointment owner. When the tenant has never saved a list, it comes from `AI_CALL_DEFAULT_SPECIALISTS` on outreach-api (production: Grant Golden);
  - `convertLeads`, default true. When it is off, every Lead booking takes the fallback;
  - `walkthrough` and `phone`, each with `enabled`, `durationMinutes`, `startHour`, `endHour`, `stepMinutes`, `minLeadMinutes`, `horizonBusinessDays`, `bufferMinutes` and `maxOffered`;
  - `days` (ISO weekdays).
- `aiCallWriteback`, a boolean, default true.

## 5. Salesforce write mapping

### 5.1 Fill blanks (both objects; a field is used only if the describe has it and the integration user may update it)

| Topic | Lead field | Opportunity field | Kind |
|---|---|---|---|
| motivation | `Motivation__c`, `SecondaryMotivation__c` | same | picklist |
| timeline | `Timeline__c` | same | picklist |
| condition | `Condition__c` | same | picklist |
| repairs | `Major_Repairs_Needed__c`; `Roof_Issues__c`, `Foundation_Issues__c`, `Mold__c` (set true only) | `Major_Repairs_Needed__c` | multipicklist / boolean |
| occupancy | `Occupancy__c` | same | picklist |
| price | `Seller_s_Asking_Price__c` | `SellersAskingPrice__c` | currency (the seller's own number) |
| competition | `Competition__c` | same | multipicklist |
| mortgage | `Amount_Owed__c` | `Amount_Owed__c` | currency |
| reason (Opp only) | — | `Reason_For_Selling__c` | text ≤ 255, the seller's words |
| language | `Spanish_Speaker__c` (true only) | same | boolean |

- **When a field may be written:**
  - It may be written only when it is blank (a multipicklist counts as blank when it holds only "didn't ask" values) or holds a "didn't ask" value.
  - A boolean is written only false → true.
  - A rep's value is never overwritten. When the seller said something different, it is listed under "Kept the rep's value" in the changes field.
- **Values the AI never writes:** I Didn't Ask and Didn't Ask. It writes Seller Didn't Say, Seller Wouldn't Say or Seller Wouldn't Disclose only when the seller explicitly declined, and only over a blank or "didn't ask" value.
- **Evidence:** every mapped value needs an evidence quote from the caller's own lines, or it is dropped.

### 5.2 Lead Status (only from New, Working, Long Term Follow-Up or Unqualified, and only when Status still equals what research saw)

| Call result | Status | Also |
|---|---|---|
| appointment booked | Qualified: **converted** (§5.7). Everything after that is written to the new Opportunity, under the "appointment booked" row of §5.3 | — |
| appointment booked, conversion refused (fallback) | Working | Rating Hot; a hold on Grant's calendar plus a "convert and book" Task to Grant |
| transferred live | Working | Rating Hot |
| callback / transfer missed | Working | Rating Warm (when blank or Cold); the engine's callback Task already exists |
| not interested, not now | Long Term Follow-Up | — |
| not interested, not selling | Unqualified | Unqualified Reason = Not Interested |
| sold on MLS | Unqualified | Unqualified Reason = Already sold (MLS) |
| sold to an investor or iBuyer | Unqualified | Unqualified Reason = Already sold (Other Investor) |
| listed with an agent | Unqualified | Unqualified Reason = Went with Competition |
| do not call | Unqualified | Unqualified Reason = Hostile/Remove from list; Removal Status = Remove me; Do Not Call = true; Skip on Dialer = true |
| wrong number, hung up, other | unchanged | fill blanks only |

### 5.3 Opportunity Stage (only from Closed Lost, Offer Rejected, Followup, Misqualified, New Opportunity or Pending Appointment, and only when Stage still equals what research saw)

| Call result | Stage | Also |
|---|---|---|
| appointment booked, Event created | Appointment Set | Rating Hot |
| appointment booked, slot taken since | Followup | Next Follow-Up = now; conflict Task to the appointment owner |
| transferred live | Followup | Next Follow-Up = now |
| callback / transfer missed | Followup | Next Follow-Up = the callback time, else next business day 10:00 Pacific |
| not interested, not now | unchanged | Rating Cold |
| not interested, not selling | Closed Lost, but only from Followup, New Opportunity or Pending Appointment | Loss Reason = Other |
| sold on MLS / investor / iBuyer | Closed Lost | Loss Reason = Sold on MLS / Sold to Other Investor / Sold to iBuyer; Closed Lost Reason (fill blank) = Sold on MLS / Sold To Other Investor / Sold to iBuyer |
| listed with an agent | Closed Lost | Loss Reason = Lost to Competitor |
| do not call | Closed Lost (from an open stage) | Loss Reason = Hostile/Remove From List; Skip on Dialer = true; the primary contact's Do Not Call = true |
| wrong number, hung up, other | unchanged | fill blanks only |

- **On an already Closed Lost Opportunity,** `Loss_Reason__c` is filled only when blank.
- **A freshly converted Opportunity** is at "New Opportunity" (in the "from" list). The research-time stage check does not apply, because it did not exist at research time.
- **Never written:** owner fields (an owner is set only by `convertLead`), the rollup and formula fields in §2, `NextStep`, or anything outside these tables and the conversion carry (§5.7). The writable list is an explicit allowlist in code, and it is intersected with the describe.

### 5.4 The appointment Event (Opportunity)

| Field | Phone consultation | Walkthrough |
|---|---|---|
| Subject | Phone Consultation | Property Consultation |
| WhatId / WhoId | the Opportunity / null | the Opportunity / null |
| OwnerId | the appointment owner (Grant Golden) | the appointment owner |
| StartDateTime / EndDateTime | the slot | the slot |
| Location | — | the property address from the record |
| ShowAs | Busy | Busy |
| Description | `Booked by the AI assistant on a call (AI call <id>). Seller's note: … Seller's time zone: …` | same, plus "Address confirmed with the seller" |
| CTI_Origin__c | `AI Outreach` | `AI Outreach` |

- `Consultation_Type__c` is left to `Event_Stamp_Consultation_Type`.
- **The Event is always the appointment owner's,** even on an Opportunity a closer owns (still-open decision 4).
- **The fallback hold** (only when a conversion was refused) is Subject `Hold: AI-booked <phone call/walkthrough> – convert <Lead name>` (≤ 255 characters), with no WhoId and no WhatId, the same owner, start and end, ShowAs Busy, and `CTI_Origin__c = 'AI Outreach'`. It has no consultation Subject, so none of the consultation flows fire, and a rep can delete it.

### 5.5 The new field: `AI_Last_Call_Changes__c` (Lead and Opportunity)

- **The field:** Long Text Area, 32,768 characters, 10 visible lines. Label "AI Last Call Changes". Help text: "Written by the AI assistant after each call it makes: what it changed on this record, old → new. Overwritten by the next AI call."
- **Permissions:** `AI_Outreach` grants read and edit. Reps get read through Setup field-level security (runbook).
- **What it holds** (plain text, rendered by code):

```
AI call on Tue Oct 6, 3:12 PM PT · Appointment set · AI call 6f0c…
Changed
- Status: Long Term Follow-Up → Working
- Timeline: I Didn't Ask → 90 Days
- Motivation: (blank) → Relocating OOS
Created
- Converted Lead "Jane Seller" into this Opportunity (owner Grant Golden); new Account and Contact
- Event: Phone Consultation, Wed Oct 7 11:00 AM PT, owner Grant Golden
- Chatter post
Kept the rep's value
- Condition: kept "5 - Cosmetic Fixer" (seller said: "the roof needs replacing")
Not written
- Rating: Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)
```

### 5.6 The Chatter post

- **Format:** a FeedItem, `Type` TextPost, plain text, at most 980 characters for both objects (the Lead trigger's limit).
- **Content:** built deterministically, and cut from the bottom: the summary is shortened first, then the change list.

```
AI call · Oct 6, 3:12 PM PT · Appointment set
Converted from Lead by the AI after the seller booked.
Booked: phone consultation with Grant, Wed Oct 7, 11:00 AM PT (seller: 2:00 PM ET)
Summary: <the call summary's narrative>
Seller said: Timeline 90 Days · Motivation Relocating OOS · Repairs Roof
Changed: Status → Working; Timeline → 90 Days; +1 more (see AI Last Call Changes)
Call details: https://<outreach>/campaigns/<id>?call=<aiCallId>
```

No @mentions: plain FeedItems cannot carry them, so the Task is what notifies a person. After a conversion the post goes on the new Opportunity only. A converted Lead is read-only and its feed is no longer shown, so nothing is posted there.

### 5.7 Lead conversion (decision 2)

**When:** only in the write-back, for a real call (never a test or practice call), when the outcome is `appointment_set` with a stored booking, the record is a Lead, and `convertLeads` is on.

**How:** the SOAP API's `convertLead()`, over the same OAuth connection (§9). The request matches the team's conversions (§2):

| Field | Value | Why |
|---|---|---|
| `leadId` | the Lead | |
| `convertedStatus` | the `IsConverted` LeadStatus, "Qualified" | the only converted status |
| `ownerId` | the appointment owner, Grant | decision 1. It owns the new Account, Contact and Opportunity; `Opp_c_bs` also sets the Opportunity's owner from the Account's |
| `opportunityName` | the Lead's Name (≤ 120) | what the team's conversions get |
| `doNotCreateOpportunity` | false | the appointment needs an Opportunity |
| `accountId`, `contactId` | not sent | the team always creates new ones; no duplicate rules are active |
| `overwriteLeadSource` | false | keep the Lead's source |
| `sendNotificationEmail` | false | the Event and the Chatter post tell Grant |

**Right after the conversion, one PATCH on the new Opportunity carries:**
- `AI_Call_Consent__c`, `AI_Call_Consent_Date__c`, `AI_Call_Consent_Source__c`, `Spanish_Speaker__c` and `Skip_on_Dialer__c`, copied from the Lead's values (read before converting) when the Opportunity's value is blank. Consent is copied exactly: never created, never upgraded, and `unknown` stays `unknown`;
- `LeadManager__c`: the Lead's prior owner when that is an active user, otherwise Grant (still-open decision 1). It is written before the Event, because `Event_Appointment_Confirm_Task` gives the confirmation Task to the Lead Manager.

**Then the normal write-back runs on the Opportunity:**
1. the plan: fill-blanks against the carried values, and the "appointment booked" row;
2. the Event, owned by Grant;
3. the PATCH: Appointment Set, Rating Hot, the filled blanks and AI Last Call Changes;
4. the Chatter post.

**Record types** are Salesforce's defaults for the converting user. The readiness check shows them, and they should be Person Account and Homeowner Opportunity. They are not changed after insert, because that would skip the org's insert-time flows (`Opp_c_bs` and `Auto_Comp_on_Lead_Conversion` filter on record type).

**Never twice:**
- the Lead's `IsConverted` and `ConvertedOpportunityId` are read before every attempt;
- the ids are saved the moment Salesforce answers;
- if a response is lost, the retry finds the Lead converted and adopts its Opportunity. It is "ours" when the Opportunity was created by the connected user after the call ended, and the carry PATCH then still runs;
- a Lead a rep converted in the meantime is adopted too, but its owner and Lead Manager are left alone.

**The fallback.** Salesforce refuses a conversion for good when:
- a validation rule fires, e.g. `Hunt_Winner_Owner_Change` or `Spam_Status_Lock`;
- the connected user lacks Convert Leads or create access;
- the user cannot use the SOAP API;
- `convertLeads` is off.

In each case the write-back targets the Lead instead:
- a hold on Grant's calendar;
- an urgent Task to Grant with the reason;
- Status Working and Rating Hot;
- a Chatter post on the Lead.

The row ends `partial`, with the refusal code. When conversion is simply turned off, it ends `done`.

## 6. Practice call

**Who and where:** an admin, from a plan card. The admin picks one of `AI_VOICE_TEST_NUMBERS` and the plan version shown, which may be proposed or approved.

**What outreach-api does:**
- renders the plan text, which must pass the same check;
- computes the context and real slots as at trigger time;
- records an `ai_practice_calls` row;
- sends a signed trigger with `target.kind = 'practice'` and key `practice:<uuid>`.

**What cti-api does:**
- loads the record through the integration connection, so the prompt has the real name, address and notes;
- skips the consent check, since the seller is not called;
- gates the call as a test (admin, and a listed number);
- dials the test number from `ai_pool`;
- builds the prompt exactly as the seller would hear it, without the "this is a test call" line;
- stores the row with `is_test = true` and `practice = true`.

**What it never does:** no Salesforce Task (`is_test`), no touch, no results counting and no write-back, so it **never books in Salesforce, never converts a Lead and never writes a field.** A booking is stored on our own `ai_calls` row and shown as "would have booked". Its only Salesforce traffic is read-only: the record load, and Grant's user record and Events for the slots. A test pins it end to end: a practice call that ended `appointment_set`, followed by the results and write-back ticks, produces no POST, PATCH or SOAP request.

**On the results page:** practice calls are listed in their own "Practice calls" section, with transcript, outcome and the would-be appointment.

## 7. Idempotency

- **The trigger:** unchanged (1C's idempotency keys). Practice keys are `practice:<uuid>`.
- **`book_appointment`:** it may be called again in the same call, and the last booking wins. It is only a database write.
- **The write-back row:** created once per `ai_call_id`, through the unique index plus the counted compare-and-swap.
- **The plan:** frozen on the row the first time, so a retry never re-runs the fill-blank decisions against values we wrote ourselves.
- **The conversion:** the Lead is read first (`IsConverted`, `ConvertedOpportunityId`); the ids are saved the moment Salesforce answers, and a retry adopts instead of converting (§5.7).
- **Each step's result** is saved before the next step starts. On a retry:
  - **The Event:** looked up in Salesforce first (same owner, start, WhatId and `CTI_Origin__c`), then created.
  - **The PATCH:** idempotent by nature.
  - **The Task:** looked up by `WhatId`/`WhoId`, `OwnerId`, Subject and `CTI_Origin__c`.
  - **The FeedItem:** its id is saved immediately. A crash between the create and that save is the one window that can duplicate a post, and it is accepted and documented.
- **The CF-1 activity check** also ignores Tasks and Events the write-back created (by their stored ids), so the AI's own writes never send a lead back to research.

## 8. Failure handling

- **Salesforce unavailable** (network, 5xx, an auth error or no connection): the row retries with backoff and keeps its step results.
- **A field refused:** that field is dropped and recorded, and the rest is written.
- **A record deleted or merged** (`ENTITY_IS_DELETED` or `NOT_FOUND`): the row is `skipped`.
- **The mapping model fails** (an error, invalid output or an exhausted budget):
  - Status, Stage and DNC moves come from the call's outcome and do not need the model, so they are still written.
  - Fill-blanks are skipped and noted in the changes field.
  - An exhausted budget waits until the next UTC day; it does not skip.
- **The Event create is refused:** the stage falls back to Followup, a Task goes to the appointment owner ("AI booked <time> but Salesforce refused the Event: <code>"), and the step is recorded.
- **A conversion is refused for good:** the fallback (§5.7), and the row ends `partial` with the code. A transient SOAP error retries, and the retry never converts twice.
- **A slot read fails at trigger time:** the call goes ahead without slots.
- **Nothing is silent:** every outcome shows on the results page (write-back status and changes), and errors are logged with ids and error codes, never record text or phone numbers.

## 9. Security

- **Which identity writes: the tenant's integration connection, used from outreach-api. Never the approver's token.**
  - **The work is unattended.** Write-back runs in a tick, minutes after the call. The approver may have no CTI Salesforce connection; 1C decision 3 already found this for research.
  - **The edits are the AI's.** They should read as the AI's in record history, not as a rep who never made them.
  - **One owner of the token.** outreach-api already owns this token and its refresh. cti-api only ever reads it.
  - **Which Salesforce user that is stays the user's choice (decision 5, open).**
    - Today it is whatever user signed in on Settings → Connections, possibly the shared System Administrator `integration@gghomessd.com`. Nothing in the design depends on which user it is.
    - A dedicated "AI Outreach" user would make history read "AI Outreach changed Timeline", but it needs its own **paid Salesforce user license**. It converts Leads and creates Accounts, Opportunities, Events and Chatter posts, which the free API-only integration license may not cover. Confirm with Salesforce before buying.
    - A non-administrator user also needs the `AI_Outreach` permission set and the in-org grants: Person Account and Homeowner Opportunity record types as its defaults, plus edit on `LeadManager__c`.
  - **The scope is enough.** `api refresh_token offline_access` covers REST and SOAP writes. What the user may write comes from its profile and permission sets. A SOAP call takes the same access token as its session id, and a 401 or `INVALID_SESSION_ID` refreshes it once.
- **Least privilege:**
  - `AI_Outreach` gains read and edit on `AI_Last_Call_Changes__c` (both objects), the `EditEvent` and `ConvertLeads` user permissions, and create on Account, Contact and Opportunity for conversion. It still grants no delete and no Modify All.
  - The tenant's own qualification fields get edit in the in-org `AI_Outreach_Fields` set (runbook).
  - A readiness check on the AI calls settings card lists what the connected user cannot update, read from the describe's `updateable` and `createable` flags. A field it cannot update is simply skipped and listed.
  - **The readiness check also proves conversion will work.** All three checks are read-only:
    - a SOAP `getUserInfo()`;
    - the Convert Leads permission, through `PermissionSetAssignment`;
    - Account, Contact and Opportunity are createable.

    It also shows the default record types and the resolved appointment owner.
- **No free-form write:**
  - **Fields** come only from the allowlist; values are describe-validated picklist values, booleans, or bounded numbers and short text.
  - **Model output** goes through a forced tool call, a zod schema built from the describe, and evidence quotes from caller lines.
  - **Data handling:** all call content reaches the model as escaped data. The changes field and Chatter text are rendered by our code.
- **Slots:**
  - They are structured data (ids, ISO times, and a first name passed through `oneLine`) that cti-api renders into the instructions.
  - They never go through the plan-text channel, and the agent can book only an id it was given.
  - Practice calls can only reach `AI_VOICE_TEST_NUMBERS`, through the engine's own test gate.
- **Compliance gates are unchanged:** the engine's consent, opt-out, DNC, state caps, hours and `ai_pool` rules apply to every real call.

## 10. Deploy notes (summary; full steps in the plan)

1. **Salesforce first.** Deploy the two new field files and `AI_Outreach` with `--test-level RunSpecifiedTests --tests PowerDialRelayTest`, naming exact files. No Apex is deployed.
   - Assign `AI_Outreach` to the connected user. It currently has no assignments.
   - Grant edit on the qualification fields, `LeadManager__c` and `Spanish_Speaker__c` in `AI_Outreach_Fields`.
   - Give reps read access to the new field through Setup.
   - Add the field to layouts in Setup, never from the repo.
   - Optionally, map the consent, Spanish-speaker and Skip-on-Dialer fields in Setup → Lead → Map Lead Fields (still-open decision 3).
2. **Migrations** 0054 and 0055 run in the pre-deploy migrate step.
3. **Set `AI_CALL_DEFAULT_SPECIALISTS=0058X00000Fsx39QAB`** (Grant Golden) on outreach-api.
4. **Deploy `@cti/api` and outreach-api together.** A trigger that reaches an old cti-api with the new fields gets a 400. That is treated as a transport error and retried with the same key, so the deploy window is safe.
5. **Before the first real campaign,** check readiness ("Lead conversion: ready", "Appointments go to: Grant Golden"). Then run practice calls on a real Opportunity and a real Lead, which never write. Then run a one-Lead live campaign and check the conversion by hand.
