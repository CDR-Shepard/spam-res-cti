# AI outreach from Salesforce campaigns — design

**Date:** 2026-10-04
**Status:** approved section by section in brainstorming; awaiting review of this written spec
**Builds on:** `2026-09-03-ai-outreach-program-design.md` (program), `2026-09-03-outreach-foundation-design.md` (foundation), plan 1 (tenancy, deployed) and plan 2 (outreach-api / outreach-web skeleton, merged)
**Supersedes:** the program design's §5 sub-project order. The program put a CSV-import lead store first. Records now come from the tenant's Salesforce. CSV import for tenants without Salesforce moves to a later sub-project. It also replaces the program's choice of Retell or Vapi for AI voice with Twilio ConversationRelay (§10.4). Every other §2 decision in the program design still stands unless §2 below changes it.

---

## 1. What we are building

The product behaves like a power dialer (Convoso) and an AI sales rep (Artisan) combined, for cash homebuyers.

An admin drops in a Salesforce query or picks a list view of Leads or Opportunities. The system keeps that list current, reads the notes on every record, and reaches each person over AI text, AI email, or a phone call. The channel for each touch is chosen from the notes, within hard compliance rules. When someone is interested, the AI qualifies them and hands them to the record's owner: live on a call, or with a ping and a claim button on text and email. Everything is written back to Salesforce.

GG Homes is tenant one. Nothing in the design is GG-Homes-specific except defaults.

## 2. Decisions

| Question | Decision |
|---|---|
| AI phone call to someone with no consent | Never. The AI calls only records whose consent checkbox is ticked. Everyone else whose best channel is a call goes to a rep through the existing power dialer: silent screen, then live bridge. |
| What counts as consent | A **consent checkbox on the Salesforce record** is the single source of truth. Any source may tick it: a yes to "OK if we call?" in a text or email, a web form that carries consent language, a past inbound caller, or a rep. The system writes the checkbox when it captures consent and keeps its own evidence. |
| How a list is given | Both a Salesforce list view and a pasted SOQL query. A list view is turned into its SOQL, so one engine runs both. |
| Cadence | Always-on. The query re-runs on a schedule, new matches join, and each person gets a multi-touch sequence. The AI picks the channel for every touch. |
| How far the AI goes | Qualify (motivation, timeline, condition, price expectations), then hand off to the record owner. No calendar booking in v1. |
| Email sending identity | Separate look-alike outreach domains with Google Workspace mailboxes. The main domain never sends cold email. |
| Where reps take over | The outreach web app (inbox, pings, claim). Live call transfers ring the CTI softphone reps already use. |
| Build approach | Our own stack: Claude for reasoning and writing, the tenant's Twilio account for texts and AI voice, Workspace mailboxes for email, the CTI power dialer for calls to reps. No voice-AI, email-sequencing, or texting vendor. |

## 3. Phases

Each phase is its own plan → implementation cycle. Phases 2 and 3 have external lead times, so their registrations start now (§15).

| # | Phase | Delivers |
|---|---|---|
| 1 | **Salesforce campaigns, AI triage, calls through the dialer** | Company-wide Salesforce connection; campaigns from list view or SOQL with preview; scheduled refresh and enrollment; AI note triage; the touch planner and its gates; campaign call queue worked from the CTI softphone; consent fields in Salesforce plus backfill; Salesforce write-back outbox; dry-run mode; campaign screens in outreach-web. Text and email touches are planned and shown but held. |
| 2 | **AI texting, conversation engine, rep inbox** | 10DLC-registered SMS number pool; openers and replies by Claude; STOP/HELP; consent capture in conversation; hand-off with pings and claim; the inbox in outreach-web; the `ai-worker` deployable; litigator scrub before any first text or call. |
| 3 | **AI email** | Workspace mailboxes connected by OAuth; send and read through the Gmail API; per-mailbox caps and ramp; unsubscribe and CAN-SPAM footer; bounce and complaint handling; replies in the same threads and inbox. |
| 4 | **AI voice** | Outbound AI calls to consented records over Twilio ConversationRelay with Claude; live transfer into the owner's softphone conference; callback booking when no rep is free. |

Analytics, billing, and CSV import follow as later sub-projects.

## 4. Architecture

- **`services/outreach-api`** (exists) gains the campaign API, the inbox API (phase 2), and pg-boss queues for phase 1: `campaign.refresh`, `record.sync`, `record.triage`, `touch.plan`, `sf.write`. Phase 1 runs these jobs in the API process, using the pg-boss runner plan 2 already wired.
- **`services/ai-worker`** (new in phase 2) takes over conversation drafting, sending, inbound webhooks for the SMS pool, and (phase 4) the ConversationRelay WebSocket. It splits out once the work becomes long-running and streaming.
- **`apps/outreach-web`** (exists) gains Connections, Campaigns (list, builder, preview, plan view, approval queue), Needs Review, and, in phase 2, the Inbox.
- **`services/cti-api` and `apps/cti-web`** (exist) gain one thing in phase 1: a "Campaign calls" entry point that builds a normal power-dial run from a campaign's due call touches (§10.1).
- **`packages/salesforce`** (new, extracted). The CTI's Salesforce code moves here so both services share one client: OAuth and token refresh, `sfFetch`, `soqlQuery`, `soqlEscape`, and the record phone resolution. While moving, `soqlQuery` gains pagination: today it returns only the first page and never follows `nextRecordsUrl`. The CTI keeps its per-rep connections; the package takes a token source, so it serves both per-rep and company-wide connections.
- **`packages/firewall`** (exists) gains the recipient-local calling-hours check. Today that check lives in the CTI dialer's `pick-did.ts` as `withinCallingHours`; it moves into the package so the planner and the dialer share one rule. It also gains a text-hours variant (§10.2).
- **One Postgres**, as today. Suppression truth stays shared: `opt_outs`, `blocked_numbers`, `federal_dnc_entries`, and the dialer's contact history. A STOP from a text therefore stops the CTI dialer too, by construction.

## 5. Salesforce connection

- An admin connects Salesforce once per tenant in outreach-web (Settings → Connections), signing in as a Salesforce Integration user. Salesforce gives Enterprise-edition and higher orgs these licenses free.
- Tokens are stored encrypted with `TOKEN_ENCRYPTION_KEY` in a new `crm_connections` table, one row per tenant. Refresh is lazy on a 401, as in the CTI. A refresh failure marks the connection broken, pauses every campaign of that tenant, shows a banner, and sends an alert.
- At connect time, and on demand, the system describes Lead, Opportunity, and Contact and stores which fields exist. Defaults are derived from the describe:
  - **Notes fields:** every text or long-text field whose API name matches `notes`, `description`, or `motivation`. For GG Homes that includes `Notes__c`, `Agent_Notes__c`, `Description`, `Motivation__c`, `SecondaryMotivation__c`, `Appointment_Notes__c`, `Analyst_Notes__c`. An admin can edit the list per object.
  - **Phone fields:** the CTI's existing order (Lead `MobilePhone`, `Phone`; Opportunity `Mobile_Phone__c`, `Phone__c`, `Other_Phone__c`, then the primary contact role's Contact phones).
  - **Email:** Lead `Email`; for an Opportunity, the primary contact role's Contact `Email`.
  - **Suppression fields:** standard `DoNotCall` and `HasOptedOutOfEmail` on Lead and Contact, and `Skip_on_Dialer__c` where present.
- The integration user's own Salesforce permissions bound what the system can read. The query path never writes.

## 6. Campaigns

### 6.1 Source and membership

- **List view:** the admin picks a Lead or Opportunity list view. The system calls the list view's describe endpoint, which returns its SOQL, and stores that query. The query is re-described on every refresh, so edits to the list view in Salesforce take effect.
- **SOQL:** the admin pastes a query. It must be a single SELECT whose top-level object is `Lead` or `Opportunity`. Aggregate queries (`COUNT()`, `GROUP BY`) are rejected. Validation is done by Salesforce itself: the preview runs the query, and a Salesforce error is shown to the admin verbatim.
- **Membership is the set of record Ids the query returns**, run as written and paginated to the end. When the query does not select `Id`, the Id is read from each row's `attributes.url`. The system then fetches its own field set (§5) for those Ids in batches of 200. The admin's query decides who is in; our field list decides what is read.
- **Size cap:** 50,000 records per campaign. A bigger result is rejected with "narrow the query".

### 6.2 Preview

Before Start, the builder shows the total count, a sample of 20 records with name, owner, and available channels, and the number that would be skipped, broken down by reason: no phone and no email, opted out, DNC, Salesforce Do Not Call or Email Opt Out, Skip on Dialer, already in another active campaign.

### 6.3 Refresh, enrollment, and exits

- A `campaign.refresh` job re-runs membership every **240 minutes** by default (per-campaign setting). New Ids enroll. Records whose `LastModifiedDate` is newer than their last sync are re-fetched, and their triage re-runs if the notes fingerprint changed.
- An enrollment stops receiving touches when any of these happens: the person replies (it becomes a conversation), opts out on any channel, is handed off, finishes the sequence, leaves the query, has their Opportunity closed (`IsClosed`), the Lead converts (`IsConverted`), or the AI raises a do-not-contact flag (§7.3). An enrollment already in a conversation keeps its thread when it leaves the query; it just gets no new sequence touches.
- **One active campaign per person.** A person is keyed by every phone number (E.164) and email on their record. A record whose keys overlap an active enrollment in another campaign is skipped with reason `in_other_campaign`.
- **Respect human contact.** A touch is deferred by one day if a rep dialed any of the person's numbers through the CTI in the last 24 hours. The FL/OK/WA/MD rolling-24-hour cap counts campaign calls and CTI calls together.

### 6.4 Campaign states

`draft` → `dry_run` → `active` ⇄ `paused` → `archived`.

- **dry_run** enrolls, triages, and plans everything, and shows the full plan, but sends nothing and queues no calls. Every new campaign starts in dry run; an admin moves it to active.
- **paused** keeps enrollments and plans but executes nothing. The system pauses a campaign automatically on a broken Salesforce connection, an exhausted AI budget, or a carrier-filtering spike (§12).

## 7. AI triage and planning

### 7.1 Triage

A `record.triage` job runs when a record enrolls and whenever its notes fingerprint changes. The fingerprint is a hash of the configured notes fields plus the Ids and descriptions of its last 10 Tasks.

- **Model:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`).
- **Input:** the notes fields, the last 10 Task subjects and descriptions (newest first), and the campaign's touch history with this person. Input is capped at 8,000 characters, trimming oldest Tasks first.
- **Output:** a structured result, validated with zod before use:
  - `summary`: 2 or 3 sentences.
  - `channels`: an ordered list from `call`, `sms`, `email`, each with a `reason` quoting the note that supports it. An empty list means "no preference".
  - `timing`: free-text hints, such as "after 5pm" or "not before March".
  - `tags`: motivation and timeline tags from a fixed vocabulary.
  - `doNotContact`: `null`, or an object with a reason category (`sold`, `attorney`, `deceased`, `asked_no_contact`, `listed_with_agent`, `hostile`, `other`) and the quote.
- Results are stored per record with the fingerprint, so an unchanged record is never re-triaged.

### 7.2 The planner decides

The planner is plain code; the AI only proposes. For each due touch it takes triage's ordered channels (falling back to the campaign default order `sms`, `call`, `email`) and removes every channel that fails a rule:

1. The channel's phase is not live for the tenant.
2. No usable contact point (no mobile number for text, no number for a call, no email for email).
3. A `call` becomes an AI call only when phase 4 is live for the tenant **and** the consent checkbox is ticked. Otherwise it becomes a **rep call** through the dialer (§10.1). A call is therefore never removed for lack of consent; it changes who makes it.
4. Opted out, block-listed, federal DNC (per the tenant's `dnc_mode`), or Salesforce `DoNotCall` (calls and texts) or `HasOptedOutOfEmail` (email).
5. Text to a recipient in FL, OK, WA, or MD without the consent checkbox.
6. Outside recipient-local hours: 8am–9pm for calls (the dialer's rule), 9am–8pm for texts. Email has no window but is scheduled for 8am–6pm recipient-local.
7. A frequency cap: one touch per person per day across all channels, plus the per-number and per-mailbox caps of §10.
8. The same channel as the previous touch, unless triage's reason explicitly prefers it.

The first remaining channel wins. Rules 6 and 7 defer the touch to the next allowed time rather than removing the channel. When nothing remains, the enrollment exits with reason `no_allowed_channel`. Every decision, including each rule that removed a channel, is stored with the touch as its gate audit.

### 7.3 Do-not-contact is held, never guessed

A `doNotContact` result stops the enrollment and puts the record on the **Needs Review** list for its owner, with the quote. Nothing is sent and nothing is suppressed automatically. The owner either dismisses the flag (the enrollment resumes) or confirms it. Confirming writes a tenant opt-out for the person's numbers and emails and sets Salesforce `DoNotCall` and `HasOptedOutOfEmail`.

### 7.4 Sequence

The default sequence is **6 touches over 14 days**, on days 0, 1, 3, 6, 10, and 14 after enrollment. Touch count and length are per-campaign settings. Each touch is planned when it falls due, not up front, so it always uses current notes, consent, and suppression.

## 8. Writing and approval

- **Model:** Claude Sonnet 5 (`claude-sonnet-5`) drafts openers, follow-ups, and (phase 2) replies.
- **Playbook:** each campaign carries a playbook of who the company is, what it offers, the qualifying questions, the sender name, and things never to say. The defaults: never quote or promise a price, never give legal, tax, or financial advice, never pressure.
- **Disclosure:** the first message names the company and the sender. If asked whether it is a person, the AI says it is an AI assistant for the company. It never claims to be human.
- **Approval mode** is on by default: an admin approves each campaign's first **50** AI-written messages in an approval queue before they send, then the campaign switches to automatic. Calls to reps need no approval.
- **Safety:** notes, Tasks, and replies are passed to the model as quoted data, never as instructions. Every model output is schema-validated before use. Links are allowed only to domains on the tenant's allow-list.
- **Budget:** a per-tenant daily AI spend cap, default $25. Hitting it pauses drafting and triage for the day, pauses affected campaigns, and alerts.

## 9. Data model

New tables, all carrying `org_id`. Columns listed are the ones the design depends on.

- **`crm_connections`**: `provider` (`salesforce`), `instance_url`, `sf_org_id`, encrypted access and refresh tokens, `status` (`connected`, `broken`), `field_map jsonb` (notes, phone, email, and suppression fields per object), `connected_by`, timestamps. Unique on `org_id, provider`.
- **`campaigns`**: `name`, `sf_object` (`Lead`, `Opportunity`), `source_kind` (`list_view`, `soql`), `list_view_id`, `soql`, `status`, `refresh_minutes` (240), `touch_days int[]` (`{0,1,3,6,10,14}`), `approvals_remaining` (50), `playbook jsonb`, `created_by`, `last_refreshed_at`.
- **`crm_records`**: one row per Salesforce record per tenant. `sf_object`, `sf_record_id`, `name`, `phones jsonb` (ordered, with field names), `email`, `owner_sf_user_id`, `lead_manager_sf_user_id`, `state`, `consent_ai_call bool`, `consent_source`, `consent_at`, `sf_do_not_call`, `sf_email_opt_out`, `skip_on_dialer`, `is_closed`, `notes_hash`, `sf_last_modified_at`, `synced_at`. Unique on `org_id, sf_record_id`. Notes text is not stored; it is fetched for triage and discarded.
- **`record_triage`**: `crm_record_id`, `notes_hash`, `model`, `result jsonb`, `created_at`.
- **`campaign_enrollments`**: `campaign_id`, `crm_record_id`, `status` (`active`, `conversing`, `needs_review`, `handed_off`, `completed`, `exited`), `exit_reason`, `next_touch_at`, `touches_done`, `enrolled_at`.
- **`enrollment_contact_keys`**: `enrollment_id`, `key` (E.164 or lowercased email). A partial unique index on `org_id, key` for enrollments that are not exited or completed enforces one active campaign per person.
- **`touches`**: `enrollment_id`, `seq`, `channel` (`ai_call`, `rep_call`, `sms`, `email`), `status` (`planned`, `awaiting_approval`, `queued`, `claimed`, `sent`, `failed`, `skipped`, `deferred`), `due_at`, `sent_at`, `provider_ref`, `body`, `gate_audit jsonb`, `skip_reason`.
- **`sf_writes`**: the Salesforce write outbox. `kind` (`task`, `consent`, `do_not_contact`, `notification`), `payload jsonb`, `status`, `attempts`, `next_attempt_at`, `last_error`.
- **`dialer_sessions.campaign_id`** and **`dialer_queue_items.touch_id`**: nullable links added to existing CTI tables (§10.1).
- **`consent_records`** (exists, never written until now): the system writes one row for every consent it captures or backfills, with the source and the evidence (message Id, form source, or call Id). An `org_id` column is added.

Phase 2 and later add `conversations`, `messages`, SMS pool numbers (a new `outbound_numbers.kind`), `mailboxes`, and `litigator_entries`; their shape is settled in those phases' plans.

## 10. Channels and gates

A STOP, an unsubscribe, or a "don't contact me" in any channel opts the person out of **every** channel. It is written to `opt_outs` for their numbers and to a tenant email suppression, the enrollment exits, and Salesforce `DoNotCall` and `HasOptedOutOfEmail` are set through the outbox.

### 10.1 Calls to reps (phase 1)

- Due `rep_call` touches collect into the campaign's call queue.
- In the CTI softphone, a **Campaign calls** button lists campaigns with due calls. Starting one builds a normal power-dial run from those records through the existing `createDialerSession`, with `campaign_id` on the session and `touch_id` on each queue item.
- Every dialer rule applies unchanged: build-time consent and DNC checks, calling hours, the FL/OK/WA/MD daily cap, cadence, the per-customer ceiling, silent screening, AMD, and the bridge to the rep's conference. The campaign adds no new path to a phone line.
- A finished queue item marks its touch `sent` (connected or no-connect, with the dialer's outcome reason) or `skipped` (with the dialer's skip reason). A connected call counts as a reply: the enrollment becomes `conversing` and the rep owns it.

### 10.2 Texts (phase 2)

- A dedicated pool of local numbers in a Twilio Messaging Service, registered under the tenant's 10DLC brand and campaign. It is separate from calling numbers, so carrier filtering of texts cannot touch call reputation. Its webhooks point at the ai-worker, not at the CTI's inbound-text route.
- **Gates:** quiet hours 9am–8pm recipient-local; no text to FL, OK, WA, or MD without the consent checkbox; a per-number daily cap that ramps with the number's age; "Reply STOP to opt out" in the first message; STOP and HELP handled immediately; Twilio carrier-filtering errors (such as 30007) counted per number and per campaign, with an automatic pause above a threshold.
- **Litigator scrub:** from phase 2 on, before anyone's first text or call from a campaign, their numbers are checked against a paid known-litigator list (such as Blacklist Alliance), cached in `litigator_entries`. A hit exits the enrollment with reason `litigator`. In phase 1, campaign calls are rep calls through the dialer and carry the same exposure as the reps' dialing today; once the scrub ships, it applies to rep calls from campaigns too.

### 10.3 Email (phase 3)

- Google Workspace mailboxes on the outreach domains, connected by OAuth. Sending and reply reading go through the Gmail API.
- Warm-up runs in a third-party warm-up tool. The system ramps each mailbox's daily cap from 5 toward 40.
- Every email carries the tenant's physical address and a one-click unsubscribe (`List-Unsubscribe` and `List-Unsubscribe-Post`). Hard bounces and complaints suppress the address; a mailbox pauses when its bounce or complaint rate crosses its threshold.

### 10.4 AI calls (phase 4)

- Outbound calls over Twilio ConversationRelay, which handles speech-to-text and text-to-speech, with Claude driving the conversation over a WebSocket served by the ai-worker. Calls use the tenant's registered numbers and caller ID.
- **Gate at origination:** the consent checkbox is ticked and not revoked, plus every voice gate in §10.1. A consent revoked in any channel blocks the call.
- **Hand-off:** the AI says it is getting the owner and redirects the call into the owner's softphone conference (`pd_<userId>`, as the dialer's bridge does). If the owner is offline, the next available rep. If no rep is free, the AI books a callback, creates a Task, and pings the owner.
- Voicemail: the AI leaves a short message only on calls it is allowed to make, which means consented records only.

## 11. Hand-off, inbox, and Salesforce write-back

- **When the AI hands off:** the person is interested, asks for an offer, wants to talk, mentions an attorney or a lawsuit, or asks something the playbook does not cover. The AI calls a `hand_off` tool with a reason and a summary.
- **Who gets it:** the record owner, mapped from Salesforce `OwnerId` to a product user through the CTI's `salesforce_connections.sf_user_id`, then by email. The owner gets an in-app sound, a desktop notification, and a Salesforce bell notification. If the owner does not claim within **5 minutes** during the tenant's business hours, every rep in the tenant is pinged and the first claim wins (an atomic claim). An unmapped owner goes straight to everyone.
- **Take-over:** the rep replies from the inbox, from the same number or mailbox. The AI is paused on that thread. The rep can hand the thread back to the AI.
- **Salesforce writes,** all through the `sf_writes` outbox and the integration user:
  - A completed Task per touch (subject such as "AI text sent" or "Campaign call: no answer"), with `CTI_Origin__c` set to `AI Outreach`.
  - A hand-off Task assigned to the owner with the AI's summary and the qualifying answers.
  - The consent fields when consent is captured.
  - `DoNotCall` and `HasOptedOutOfEmail` on an opt-out or a confirmed do-not-contact.
- **v1 never changes** Lead status or Opportunity stage, and never creates or converts records.

### 11.1 Consent fields

Three fields on Lead and Opportunity, shipped from the repo's Salesforce metadata (`salesforce/force-app`) as the CTI's own fields are:

- `AI_Call_Consent__c`: checkbox.
- `AI_Call_Consent_Date__c`: date/time.
- `AI_Call_Consent_Source__c`: picklist with `Text Reply`, `Email Reply`, `Web Form`, `Inbound Call`, `Rep`.

Ticking the checkbox by any means is the tenant asserting consent; a rep tick is recorded with source `Rep`. A revocation (STOP, unsubscribe, "don't call") clears the checkbox through the outbox and marks the `consent_records` row revoked.

**Backfill**, run once by an admin from Settings and safe to re-run:

- **Web forms:** tick records whose `Lead_Form_Source__c` is set, with source `Web Form`. This backfill is disabled until an admin confirms, in the app, that the tenant's forms carry consent language covering calls and texts.
- **Inbound callers:** tick records the CTI has logged an inbound call from, with source `Inbound Call` and the call as evidence.

## 12. Failure handling

- **Exactly-once sends.** Every touch is planned, claimed by compare-and-swap, sent, then stamped with the provider's reference. Our touch Id is the idempotency key with every provider, so a retry after a crash never double-sends. A reaper returns stale claims, following the CTI dialer's pattern.
- **A fresh gate check right before every send.** Plans can go stale, so the gates of §7.2 run again at claim time.
- **Automatic pauses:** a broken Salesforce connection pauses the tenant's campaigns; an exhausted AI budget pauses drafting and triage; a carrier-filtering or bounce spike pauses the affected number, mailbox, or campaign. Each pause shows a banner in the app and fires an alert to `ALERT_WEBHOOK_URL`.
- **Kill switches:** per campaign (pause), per channel per tenant, and a global environment switch that stops all sends.
- **Salesforce outages** only delay writes. The outbox retries with backoff and alerts after 24 hours of failures.
- **AI failures** defer the touch. There is no canned fallback message.

## 13. Testing

- Table-driven unit tests for the planner and every gate, including each removal reason and each deferral.
- The **real-Postgres test lane** (a plan 2 follow-up) for enrollment uniqueness, touch claims, the reaper, and the outbox.
- Fake Salesforce, Twilio, Gmail, and Claude adapters behind ports, as plan 2 did for WorkOS.
- SOQL handling tests: list-view describe, pagination, Ids from `attributes.url`, aggregate rejection, the size cap.
- **Triage evals:** a fixed, anonymized set of sample notes with the expected channel order and do-not-contact result, run on every prompt or model change, with a pass threshold.
- **Dry-run first:** every campaign starts in dry run (§6.4).

## 14. Out of scope for v1

- Changing Lead status or Opportunity stage; creating or converting records.
- Calendar booking.
- One person in more than one active campaign.
- CSV list import, analytics, and billing (later sub-projects).
- Any synthetic voice on a call to a record without the consent checkbox, including voicemail drops.

## 15. Operator prerequisites

These are the tenant's steps. The ones with lead times should start now.

| Step | Needed by | Lead time |
|---|---|---|
| Push the pending IaC fix; deploy outreach-api per its runbook; set up WorkOS | Phase 1 | Hours |
| Create a Salesforce Integration user; deploy the three consent fields | Phase 1 | Hours |
| Anthropic API key in the outreach services' environment | Phase 1 | Minutes |
| Confirm the web forms' consent language (enables the web-form backfill) | Phase 1 backfill | Days |
| 10DLC brand and campaign registration for the SMS pool | Phase 2 | 1–3 weeks |
| Known-litigator list subscription | Phase 2 | Days |
| Buy 2–3 outreach domains; create Workspace mailboxes; start warm-up | Phase 3 | 2–3 weeks of warm-up |

## 16. Risks

- **10DLC approval.** Carriers scrutinize real-estate texting to people who did not opt in. The registration may be rejected or throttled. The program accepted this risk; the mitigations in §10.2 are mandatory.
- **Consent the tenant asserts.** The checkbox is trusted however it was ticked. A rep ticking it without real consent exposes the tenant on every AI call to that person. The source picklist and `consent_records` show where each consent came from.
- **Salesforce API limits.** Refresh every 4 hours across campaigns, batched field fetches, and composite writes keep usage small, but very large campaigns on a low-edition org could reach the daily API limit. The connection screen shows the org's remaining daily API calls.
- **Notes quality.** Triage is only as good as the notes. Thin notes give an empty channel preference and fall back to the campaign default order.
