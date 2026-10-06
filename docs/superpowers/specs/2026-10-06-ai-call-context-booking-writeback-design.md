# AI calls that know the record, book appointments, and write back to Salesforce (plan 1D)

Date 2026-10-06. Base: `origin/main` 6d508ba. Plans 1A, 1C and the AI voice engine are live in production. Branch `feat/ai-call-1d`. The plan is `docs/superpowers/plans/2026-10-06-ai-call-1d.md`. The user's decisions are in `.superpowers/sdd/1d-decisions.md`.

## Decisions for the user

Each of these is a real product choice. The plan is written to the recommendation, and changing any one of them changes one task, not the design.

1. **Who takes AI-booked appointments.** An appointment goes on a Salesforce user's calendar as an Event, so someone has to own it.
   - Today about 56% of consultations are owned by the Opportunity's owner (the closer). The rest are owned by the lead manager or another closer.
   - About 10% of stale Opportunities are owned by people who have left.
   - **Recommendation:** for an Opportunity, use its owner when that user is active and on a "specialists" list you give. Otherwise, and always for a Lead, use the specialist on that list with the earliest free time.
   - **Needed from you:** the names on that list.
   - Booking stays off until the list has at least one name.
2. **What happens when a Lead books.**
   - Salesforce refuses an appointment on a Lead (validation rule `Appointment_on_Lead`: "please convert it to an Opportunity").
   - Your conversion also hands the record to a closer, which the AI cannot do the way your team does.
   - **Recommendation:** the AI does not convert. It does four things:
     - puts a plain hold on the specialist's calendar, so the time is not double-booked;
     - gives the Lead's owner an urgent Task: "Seller agreed to a phone call or walkthrough at <time> with <specialist>. Convert this Lead and book it";
     - sets Status to Working and Rating to Hot;
     - posts to Chatter.
   - The hold is a "Hold: …" Event with no consultation subject, so none of your consultation flows fire and a rep can delete it.
   - **The alternative** is that the AI converts the Lead itself. That needs a small Apex action plus your conversion rules, and is a later plan.
3. **Booking hours.** These defaults come from the last 60 days of your Events.
   - **Walkthrough:** 60 minutes, Monday to Friday, starting on the hour from 9 AM to 4 PM Pacific. The earliest is about 20 hours ahead, the latest 5 business days out, with 30 minutes kept free on each side for travel.
   - **Phone consultation:** 15 minutes, Monday to Friday, every half hour from 10 AM to 5 PM Pacific. The earliest is 2 hours ahead, the latest 2 business days out.
   - The AI offers two times at a time, at most 6 per kind and at most 2 per day.
   - **Recommendation:** keep these defaults. They are editable on the AI calls settings card.
4. **Status and stage moves** (the tables in §5). Two of them have side effects in your org:
   - **"Not selling at all" on a Lead** sets Status = Unqualified with Unqualified Reason = Not Interested. Your flow `Reassign_Unqualified_Leas_to_Trash_Queue` then moves the Lead to the Trash queue.
   - **"Stop calling me"** sets Unqualified with "Hostile/Remove from list" (the only removal reason in your picklist). It also sets Removal Status = Remove me, Do Not Call and Skip on Dialer.
   - **Interest on a Closed Lost, Offer Rejected or Misqualified Opportunity** re-opens it to Followup, or to Appointment Set when a time was booked.
   - **Recommendation:** approve the tables as written.
5. **Who the edits show as.** Every write-back edit, Event, Task and Chatter post is made by the Salesforce user the integration connection signed in as (§9).
   - The production org has a System Administrator named "Integration User" (`integration@gghomessd.com`) that other systems may also use.
   - **Recommendation:** connect a dedicated user named "AI Outreach" so the record history reads "AI Outreach changed Timeline". Reconnect on Settings → Connections; the runbook has the steps.
   - Using the shared user works, but its edits are indistinguishable from the other systems'.

## 1. What changes, in one paragraph

1C calls a stale lead with a plan written from the whole Salesforce record. 1D adds three things:
- **The call treats the person as someone we already know.** It opens with "we spoke back in February about the house on Oak Street — are you still thinking about selling?" and asks only about what the record is missing.
- **The seller can book an appointment during the call,** either a phone consultation with a specialist or an in-person walkthrough. The times come from the specialist's real Salesforce calendar.
- **After the call, outreach-api writes the result to Salesforce once.**
  - It fills the empty or "didn't ask" qualification fields and never overwrites a rep's value.
  - It moves Status or Stage and the next follow-up.
  - It creates the appointment Event exactly the way reps do, so the org's own appointment flows run.
  - It writes a new field, **AI Last Call Changes**, that lists every change as old → new.
  - It posts a short Chatter summary.

An admin can also place a **practice call**: the real record's plan and the same appointment times, but the call rings the admin's own test number and nothing is written to Salesforce.

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
- **Everyone who owns a consultation is in America/Los_Angeles** (`User.TimeZoneSidKey`).
- **The integration connection.** `AI_Outreach` is deployed but assigned to nobody. The org's `integration@gghomessd.com` is a System Administrator. Which user the outreach connection signed in as is not visible from Salesforce, so the runbook confirms it.

## 3. Flows

```
plan time (call.prepare)                 trigger time (ai_call.place)                    call (cti-api)                          after (ai_call.results → ai_call.writeback)
research snapshot                        fresh record read (1C)                           opener: "we spoke back in February…"     results tick counts the call once
  + last real contact (words)            specialist + free slots (SF Events)              asks only what is missing                 → enqueues ONE write-back row (same tx)
  + what Salesforce is missing  ──plan──► context.returning, slots[] ──signed request──►  live transfer, or book_appointment     ─► write-back tick: describe, fresh read,
plan: reengagement, stillToLearn         (practice: same, to a test number)              → ai_calls.appointment                       Claude maps answers → picklists,
                                                                                                                                       Event (or Lead hold + Task),
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

Right before the trigger, `ai_call.place` resolves a specialist (decision 1) and reads that specialist's Events and user record through the integration connection.

**Slot ids:**
- `p1`… are phone consultations and `w1`… are walkthroughs, at most 6 of each.
- Slots fall inside the business hours (decision 3), in the specialist's time zone.
- A slot never overlaps an Event that is not Free: all-day Events block the whole day, and the walkthrough travel buffer applies.

**Where they go:** the slots travel in the signed trigger request, and cti-api stores them on `ai_calls.offered_slots`.

**When slots are empty:** any failure (booking off, no specialist, no free time, Salesforce error) yields no slots. The call still goes ahead and offers a callback. A broken calendar never stops a call.

### 3.3 The call (cti-api)

**When the plan says we know them (`context.returning`):**
- After the disclosure, the agent opens with the plan's opener and never pitches us as strangers.
- Qualifying asks only the plan's still-to-learn topics.

**The hand-off order:**
1. Someone interested who wants to talk now is transferred live, as today.
2. Someone who would rather pick a time is offered a choice of a phone call with the specialist (first name) or an in-person walkthrough, then two times of that kind in their own time zone.
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
   - **For an Opportunity:**
     - re-check the specialist's calendar for the slot;
     - if it is free, create the Event the way reps do (§5.4), first looking for one we already made (same owner, start, `WhatId` and `CTI_Origin__c = 'AI Outreach'`);
     - if it is taken, the stage moves to Followup instead and a conflict Task goes to the specialist.
   - **For a Lead:** the hold Event plus the convert-and-book Task (decision 2).
3. **Fields.** One PATCH carries the patch plus `AI_Last_Call_Changes__c`.
   - If Salesforce refuses particular fields (a validation rule, a restricted value, a queue-owned Lead's Status), those fields are dropped, recorded as "not written: <reason>", and the PATCH is tried again, at most 3 times.
   - For an Opportunity, do-not-call also sets `DoNotCall` on the primary contact role's Contact.
4. **Task** (an appointment conflict, or a Lead booking), owned by the specialist or the Lead owner.
5. **Chatter.** One FeedItem on the record (§5.6).

**How a row ends:**

| Status | When |
|---|---|
| `done` | Every step succeeded |
| `partial` | A field or step was refused for good; the rest stands |
| `skipped` | The record is gone, or there was nothing to write (hung_up or other with nothing learned) |
| `failed` | Transient errors used up 6 attempts (backoff 1 m, 5 m, 30 m, 2 h, 6 h, 24 h). An admin can retry it from the results page |

Results show the status and the change list. Write-back never writes for a test or practice call: there is no touch, and the worker also checks `is_test`.

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
  - `enabled` and `useRecordOwner`;
  - `specialists`, a list of Salesforce user ids, at most 20;
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
| appointment booked | Working | Rating Hot; hold Event + "convert and book" Task (decision 2) |
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
| appointment booked, slot taken since | Followup | Next Follow-Up = now; conflict Task to the specialist |
| transferred live | Followup | Next Follow-Up = now |
| callback / transfer missed | Followup | Next Follow-Up = the callback time, else next business day 10:00 Pacific |
| not interested, not now | unchanged | Rating Cold |
| not interested, not selling | Closed Lost, but only from Followup, New Opportunity or Pending Appointment | Loss Reason = Other |
| sold on MLS / investor / iBuyer | Closed Lost | Loss Reason = Sold on MLS / Sold to Other Investor / Sold to iBuyer; Closed Lost Reason (fill blank) = Sold on MLS / Sold To Other Investor / Sold to iBuyer |
| listed with an agent | Closed Lost | Loss Reason = Lost to Competitor |
| do not call | Closed Lost (from an open stage) | Loss Reason = Hostile/Remove From List; Skip on Dialer = true; the primary contact's Do Not Call = true |
| wrong number, hung up, other | unchanged | fill blanks only |

- **On an already Closed Lost Opportunity,** `Loss_Reason__c` is filled only when blank.
- **Never written:** owner fields, the rollup and formula fields in §2, `NextStep`, or anything outside these tables. The writable list is an explicit allowlist in code, and it is intersected with the describe.

### 5.4 The appointment Event (Opportunity)

| Field | Phone consultation | Walkthrough |
|---|---|---|
| Subject | Phone Consultation | Property Consultation |
| WhatId / WhoId | the Opportunity / null | the Opportunity / null |
| OwnerId | the specialist | the specialist |
| StartDateTime / EndDateTime | the slot | the slot |
| Location | — | the property address from the record |
| ShowAs | Busy | Busy |
| Description | `Booked by the AI assistant on a call (AI call <id>). Seller's note: … Seller's time zone: …` | same, plus "Address confirmed with the seller" |
| CTI_Origin__c | `AI Outreach` | `AI Outreach` |

- `Consultation_Type__c` is left to `Event_Stamp_Consultation_Type`.
- **The Lead hold** is Subject `Hold: AI-booked <phone call/walkthrough> – convert <Lead name>` (≤ 255 characters), with no WhoId and no WhatId, the same owner, start and end, ShowAs Busy, and `CTI_Origin__c = 'AI Outreach'`.

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
- Event: Phone Consultation, Wed Oct 7 11:00 AM PT, owner Seth Boisvert
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
Booked: phone consultation with Seth, Wed Oct 7, 11:00 AM PT (seller: 2:00 PM ET)
Summary: <the call summary's narrative>
Seller said: Timeline 90 Days · Motivation Relocating OOS · Repairs Roof
Changed: Status → Working; Timeline → 90 Days; +1 more (see AI Last Call Changes)
Call details: https://<outreach>/campaigns/<id>?call=<aiCallId>
```

No @mentions: plain FeedItems cannot carry them, so the Task is what notifies a person.

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

**What it never does:** no Salesforce Task (`is_test`), no touch, no results counting and no write-back. A booking is stored on the call and shown as "would have booked".

**On the results page:** practice calls are listed in their own "Practice calls" section, with transcript, outcome and the would-be appointment.

## 7. Idempotency

- **The trigger:** unchanged (1C's idempotency keys). Practice keys are `practice:<uuid>`.
- **`book_appointment`:** it may be called again in the same call, and the last booking wins. It is only a database write.
- **The write-back row:** created once per `ai_call_id`, through the unique index plus the counted compare-and-swap.
- **The plan:** frozen on the row the first time, so a retry never re-runs the fill-blank decisions against values we wrote ourselves.
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
- **The Event create is refused:** the stage falls back to Followup, a Task goes to the specialist ("AI booked <time> but Salesforce refused the Event: <code>"), and the step is recorded.
- **A slot read fails at trigger time:** the call goes ahead without slots.
- **Nothing is silent:** every outcome shows on the results page (write-back status and changes), and errors are logged with ids and error codes, never record text or phone numbers.

## 9. Security

- **Which identity writes: the tenant's integration connection, used from outreach-api. Never the approver's token.**
  - **The work is unattended.** Write-back runs in a tick, minutes after the call. The approver may have no CTI Salesforce connection; 1C decision 3 already found this for research.
  - **The edits are the AI's.** They should read as the AI's in record history, not as a rep who never made them.
  - **One owner of the token.** outreach-api already owns this token and its refresh. cti-api only ever reads it.
  - **The scope is enough.** `api refresh_token offline_access` covers writes. What the user may write comes from its profile and permission sets.
- **Least privilege:**
  - `AI_Outreach` gains read and edit on `AI_Last_Call_Changes__c` (both objects) and the `EditEvent` user permission.
  - The tenant's own qualification fields get edit in the in-org `AI_Outreach_Fields` set (runbook).
  - A readiness check on the AI calls settings card lists what the connected user cannot update, read from the describe's `updateable` and `createable` flags. A field it cannot update is simply skipped and listed.
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

1. **Salesforce first.** Deploy the two new field files and `AI_Outreach` with `--test-level RunSpecifiedTests --tests PowerDialRelayTest`, naming exact files.
   - Assign `AI_Outreach` to the connected user. It currently has no assignments.
   - Grant edit on the qualification fields in `AI_Outreach_Fields`.
   - Give reps read access to the new field through Setup.
   - Add the field to layouts in Setup, never from the repo.
2. **Migrations** 0054 and 0055 run in the pre-deploy migrate step.
3. **Deploy `@cti/api` and outreach-api together.** A trigger that reaches an old cti-api with the new fields gets a 400. That is treated as a transport error and retried with the same key, so the deploy window is safe.
4. **Booking is off** until an admin picks specialists. Write-back is on by default, and a per-tenant switch turns it off.
5. **Before the first real campaign,** run a practice call on a real Opportunity.
