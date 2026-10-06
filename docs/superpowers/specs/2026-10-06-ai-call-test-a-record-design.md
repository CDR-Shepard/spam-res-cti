# Test a record: preview the AI's call plan for any Lead or Opportunity, then run it to your phone or in the browser (plan 1E)

Date 2026-10-06. Branch `feat/ai-call-1e`, stacked on `feat/ai-call-1d` (still in review). The plan is `docs/superpowers/plans/2026-10-06-ai-call-1e.md`. It builds on the 1D spec, `docs/superpowers/specs/2026-10-06-ai-call-context-booking-writeback-design.md`, and reuses its research, plan writer, slot offer and practice call unchanged wherever it can.

## 1. What the owner asked for

> "We need an ability to test this where I can throw in a record ID, and it's going to tell me: here's how I'm going to approach that call. And I can actually run the call in the web app."

Asked how to run it, the owner chose **both**:
- **talk to the AI in the browser**, with the computer's mic and speakers, playing the seller;
- **ring my phone instead**.

## 2. What changes, in one paragraph

An admin opens **Test a record** in outreach-web and pastes a Salesforce Lead or Opportunity Id, or its Lightning URL. outreach-api runs the same research, plan writer and appointment offer a campaign call gets, **without a campaign**, and shows "how I'll approach this call": who the record is, the last real contact and the re-engagement line, what the AI still needs to learn, the opener, the full plan text the voice agent will be given, the appointment times it would offer, the consent status, and any reason the plan text cannot be given to the agent. The admin can regenerate it. Then the admin runs the call: **Ring my phone** (one of the admin test numbers) or **Talk in browser** (the AI calls the admin's browser tab, which answers on its own). The call is a 1D **practice call** in every way that matters: the real record and plan, the same prompt, tools, slots and transcript, and it never writes to Salesforce, never books a real slot, never converts, never opts a number out and never creates a touch. After the call the page shows the outcome, the summary, what it learned, "would have booked …", the transcript and, on request, "would have written to Salesforce: …".

## 3. What the code already gives us (verified on this branch)

| Need | Already there | Where |
|---|---|---|
| Research a record | `researchRecord(deps, { sfObject, sfRecordId, consentField, now })`, read-only, integration connection | `services/outreach-api/src/research/snapshot.ts` |
| Re-engagement facts | `planFacts(snapshot, now)`, `withPlanFacts(plan, facts)` | `call-plans/plan-context.ts` |
| Write the plan | `buildCallPlanPrompt` + `CallPlanModel.plan` (Anthropic, priced) | `call-plans/prompt.ts`, `ai/call-plan-model.ts` |
| The text the agent gets, checked | `renderPlanForAgent(plan, now)` → `{ ok, text }` or `issues` (CF-9 via `agentPlanTextIssues`); `describePlanTextIssues` words | `ai-calls/plan-text.ts`, `call-plans/plan-text-words.ts` |
| Appointment times | `readOfferCalendar` + `offerWithAiBookings` (read-only; practice bookings never block a real slot) | `appointments/offer.ts`, `appointments/booked.ts` |
| AI budget | `spentTodayMicros`, `addSpend`, `budgetMicros`; `isPricedModel`, `costMicros` | `ai/budget.ts`, `ai/model.ts` |
| A practice call | target `kind: 'practice'` (real record + plan, an admin test number), `is_test = practice = true`, no touch, no Salesforce Task, no write-back, no opt-out | `ai-calls/practice.ts`; cti-api `ai-voice/service-target.ts`, `gate.ts` (test branch) |
| The internal link | HMAC-signed `POST /internal/ai-calls` and `GET /internal/ai-calls/availability`, idempotent per key | `ai-calls/cti-client.ts`; cti-api `ai-voice/routes-internal.ts` |
| Browser voice | Twilio Voice JS SDK 2.12 in cti-web; cti-api mints Voice access tokens with `TWILIO_API_KEY_SID/SECRET` | `apps/cti-web/src/App.tsx`; cti-api `telephony/twilio.ts` |
| Practice transcript access for admins | `loadPracticeTranscript` | `ai-calls/results-query.ts` |
| Dry-run pieces for "would have written" | `writableFields`, `readCurrent` (GET only), `MappingModel.map`, `buildWritePlan` (pure), `changesFieldText`, `chatterText` (pure) | `writeback/fields.ts`, `mapping-model.ts`, `plan.ts`, `render.ts` |

Corrections to the brief, from the code:
- **`ai_practice_calls` cannot hold these rows as is.** Its `campaign_id`, `enrollment_id`, `plan_version` and `to_e164` are NOT NULL, and its list query joins the enrollment. 1D (which owns 0056 and 0057) is still in review. So 1E adds its own two tables in a new migration rather than altering 1D's (§6).
- **There is no per-route rate limiting in outreach-api today**, only the global 300/min `@fastify/rate-limit`. The limits here are counted in Postgres (§8.2), which also survives restarts and replicas.
- **`AI_VOICE_TEST_NUMBERS` is one shared list**, not per admin. "Your own test number" means a number on that list, exactly as the 1D practice call works today (open question 2).
- **cti-web's softphone identity is `rep_<user hex>`** and a Voice token there also carries the TwiML App's outgoing grant. The browser test must use neither (§5.2).

## 4. Flows

```
outreach-web (admin)                 outreach-api                                  cti-api                                  Twilio / OpenAI
paste Id or URL ── POST /record-tests ─► parse + limits + budget, insert 'running'
poll GET /record-tests/:id ◄──────────── (in process) research → facts → plan model
                                          → withPlanFacts → renderPlanForAgent → slots
                                          → 'ready' (or 'failed: <reason>')
"Ring my phone" ── POST …/calls {phone} ─► render again, fresh slots, insert call row ──► target practice (to = test number) ──► PSTN leg + AMD, <Connect><Stream>
"Talk in browser":
  mic permission
  POST /record-tests/browser-token ─────► cti.browserToken ───────────────────────► mint incoming-only token,
  ◄──────────────────────────────────── { token, identity }  ◄────────────────── identity aitest_<user>_<nonce>
  new Device(token).register()
  POST …/calls {browser, identity} ─────► same as phone ───────────────────────────► target practice_browser ─────────────► client:<identity> leg, no AMD,
  'incoming' → accept()  ◄──────────────────────────────────────────────────────────────────────────────────────────────── <Connect><Stream> (same bridge)
  mute / hang up; poll GET for status
after: GET /record-tests/:id (call joined to ai_calls) → outcome, summary, would have booked, learned, transcript
optional: POST …/calls/:callId/dry-run → describe + read + mapping model + buildWritePlan → "would have written" (nothing sent)
```

### 4.1 Input

- **Accepted:** an Id of 15 or 18 characters starting `00Q` (Lead) or `006` (Opportunity), or any URL containing one, such as `https://x.lightning.force.com/lightning/r/Lead/00Q…/view`, a related-list URL, or a Classic `https://x.my.salesforce.com/006…`.
- **The parser** (`parseSalesforceRecordRef`, pure, in `@cti/contracts` so the web validates as you type) finds the first `00Q`/`006` Id token, takes the object from the prefix, and normalises a 15-character Id to 18 with the standard checksum. An 18-character Id whose checksum does not match is refused.
- **Refusals, in words:** "That isn't a Salesforce Lead or Opportunity Id" (no token), "Only Leads (00Q…) and Opportunities (006…) can be tested" (another prefix, e.g. `001`), "That Id's last three characters don't match" (bad checksum).
- **The URL's domain is ignored.** The record is read through the tenant's own integration connection, so an Id from another org is simply "not found in your Salesforce".

### 4.2 Preview: "how I'll approach this call"

**Start.** `POST /api/record-tests { record }` (admin). outreach-api checks, in order: admin; the input parses; AI calls are configured (the plan model exists and is priced); the tenant's Salesforce connection and field map load; the limits (§8.2); the daily AI budget is not spent. Then it inserts an `ai_record_tests` row with `status = 'running'` and answers `202 { id }`. The work runs in the same process, after the reply:

1. `researchRecord` with the field map's consent field. A null snapshot ends `failed: not_found`.
2. `planFacts(snapshot, now)` → `buildCallPlanPrompt(snapshot, { companyName, today, facts })` → `model.plan(…)` with a 4-minute abort (`LEAD_TIMEOUT_MS`), then `withPlanFacts`. The spend is recorded with `addSpend` whether or not the output validates.
3. `renderPlanForAgent(plan, now)`: the text the agent will get, or its issues.
4. The offer: the 1D practice composition (`readOfferCalendar` + `offerWithAiBookings` with the tenant's `bookingSettings`). Any failure gives no times and a note; it never fails the preview.
5. Store everything on the row and set `ready`, or `failed` with a short code.

**A row left `running` for more than 6 minutes** (the process restarted mid-preview) reads as `failed: interrupted`. Nothing rewrites it.

**What the page shows** (`GET /api/record-tests/:id`, polled every 2 s while `running`):

| Section | Content | Source |
|---|---|---|
| The record | Name, Lead or Opportunity, "Open in Salesforce" link | snapshot self block; the connection's instance URL |
| Consent | "AI call consent: yes / no / unknown / field missing". Not "yes" adds: "A campaign would not call this person. A test only rings you." Never blocks a test | `snapshot.consent` |
| Do-not-contact | When the model raised one: the category and the quote, and "A campaign would hold this lead in Needs Review." Never blocks a test | `plan.doNotContact` |
| Last real contact | "We last spoke back in February about the roof" and "The agent will treat them as someone we know", or "No earlier conversation found: the agent will introduce us" | `plan.reengagement`, `context.returning` |
| Still to learn | The topics, in words | `plan.stillToLearn` (`TOPIC_WORDS`) |
| Opener | The opener, verbatim | `plan.opener` |
| Situation, signals, goals | The summary, the signals with their evidence, each goal's approach | `plan` |
| The plan text the agent gets | The exact rendered text, in a monospace block. Or, in red: "The voice agent can't be given this plan: <words>. Regenerate it." This **blocks running** | `renderPlanForAgent`, `describePlanTextIssues` |
| Appointment times | "Times it would offer now (Grant Golden's calendar)": each slot in Pacific time and in the seller's zone. Or the note in words: "Booking is off", "Nobody active on the appointment list", "No free time in the next N days", "Couldn't read the calendar". Run time reads them again | offer |
| What it read | The research sources line (count, denied, missing), as on the plan board | `snapshot.sources` (`sourceLine`) |
| Cost | "This preview cost about $0.04" | `cost_micros` |

**Regenerate** starts a new preview of the same record: a new row, counted against the same limits.

**What a preview never does:**
- no enrollment, no touch, no `call_plans` row: nothing appears on any campaign board or result list;
- no `crm_records` row, no do-not-contact hold;
- no Salesforce write: research and the offer are GET and SOQL only.

### 4.3 Running the call

`POST /api/record-tests/:id/calls` (admin), with body `{ mode: 'phone', to }` or `{ mode: 'browser', identity }`.

outreach-api, in order:
1. Loads the test, org-scoped. It must be `ready` and its plan must still parse (`EditableCallPlan`).
2. **Renders the plan text again** with `renderPlanForAgent(plan, now)`. Issues refuse the call: 409 `PLAN_TEXT_REJECTED`, with the words. This is the same CF-9 rule, and cti-api checks it again.
3. Checks the run limits and that the admin has no live test call (§8.2).
4. **The destination:**
   - phone: `to` must be on cti-api's test list (the 1D `testNumber` check);
   - browser: `identity` must be this admin's (`aitest_<their user id hex>_<12 hex>`).
5. Reads the times **fresh**, as the pacer does at trigger time.
6. Inserts an `ai_record_test_calls` row with key `rtest:<uuid>`.
7. Calls `cti.trigger`:
   - phone: `{ kind: 'practice', objectType, recordId, to, planText, context, slots? }`, the 1D target unchanged;
   - browser: `{ kind: 'practice_browser', objectType, recordId, clientIdentity, planText, context, slots? }`.

   `context = { returning: plan.reengagement?.lastContact != null }`, as the 1D practice call computes it.
8. Stores the answer (`placed`, `blocked`, `failed`) and the `ai_call_id`, and returns them. Refusals show in words (`BLOCK_REASON_WORDS`, `FAIL_REASON_WORDS`).

**cti-api treats `practice_browser` exactly like `practice`** (§5.3), except the leg it dials. So the call has the same things a real call has:
- the record loaded through the integration connection;
- the prompt as the seller would hear it, without the "this is a test call" line;
- the same tools, `book_appointment` included;
- the same transcript and summary;
- the same row flags, `is_test = practice = true`.

### 4.4 After the call

`GET /api/record-tests/:id` lists the test's calls, newest first, each joined to `ai_calls`. If the trigger's answer was lost, the call is found through `ai_call_requests` by its key, as the 1D practice list does. Each call shows:
- status and duration while live; outcome and summary when done;
- **what it learned**: `ai_calls.qualification` as label → value;
- a callback time if the seller asked for one;
- **"Would have booked: Phone call with Grant, Wed Oct 7, 11:00 AM PT"** from `ai_calls.appointment`;
- the transcript, through the existing `AiCallTranscriptPanel`. `loadPracticeTranscript` now also admits these calls;
- **"What would be written to Salesforce"**, an optional button (§4.5).

The page polls every 2 s while any call is non-terminal, and stops after that.

### 4.5 "Would have written to Salesforce" (optional; on request; nothing sent)

**Feasible, because every piece of the 1D write plan is a read or a pure function.** The steps:
1. `describeObject` → `writableFields`;
2. `readCurrent` (GET);
3. `MappingModel.map` over the call's outcome, qualification, transcript and summary (one model call, which counts against the budget);
4. `buildWritePlan`, with `practice: false` so the booking is not ignored, `researchStatus` taken from the preview's snapshot, and `converted: null`;
5. `changesFieldText` and `chatterText`, with `applied = { written: plan.changes, notWritten: [], created: <what would be created> }`.

**What the panel shows:**
- the change list (changed, kept the rep's value, not written), grouped like `WritebackChanges` but with no retry and no badge;
- the "AI Last Call Changes" text and the Chatter post text, as they would read;
- "Would create: Event Phone Consultation, Wed Oct 7 11:00 AM PT, owner Grant Golden".

**A booked Lead** adds: "Would convert this Lead (owner Grant Golden, Lead Manager <prior owner>) and write the rest to the new Opportunity." The field list shown is then the Lead-side approximation, and the panel says so.

**An outcome that writes nothing** (voicemail, no answer, busy, failed, blocked) shows "A real call that ended this way writes nothing to Salesforce" with no model call.

**Guarantees:**
- the module imports nothing that writes (`steps-write.ts`, `appointment.ts` create functions, `convert.ts`'s `convertStep`), and a test with a recording fake client asserts only GET/query/describe requests;
- the result is stored on the call row, so pressing again does not pay twice.

**Optional:** if it is cut, the rest of 1E stands (open question 4).

## 5. Talking to the AI in the browser

### 5.1 The choice

| Option | How | Verdict |
|---|---|---|
| **A. The AI calls the browser** (chosen) | cti-api places the practice call with `to = client:<identity>` through the same `startAiCall` → `placeCall` → `<Connect><Stream>` path. The browser registers a Twilio Voice JS `Device` with an **incoming-only** token and accepts the incoming call | Reuses every piece of the live pipeline: idempotent trigger, gate, `ai_calls` row, registry, stream bridge, tools, status callback, finalize, sweeper, summary. The only differences are the destination, AMD off, and no `calls` row. The browser can receive and never dial |
| B. The browser calls out through a TwiML App | `device.connect({ params })` → the TwiML App's Voice URL returns `<Connect><Stream>` into the AI | The TwiML App's Voice URL is the rep softphone's dial route (`/telephony/twilio/voice`, cti-web's critical path, edited by another session). The AI row would be born inside a webhook instead of the idempotent trigger, needing a second auth binding for user-supplied params. And an outgoing grant would let an outreach-web token reach that dial route, i.e. PSTN dialing from a test page |
| C. Browser ↔ OpenAI Realtime over WebRTC | An ephemeral OpenAI key in the browser | Bypasses cti-api's bridge, tools, `book_appointment`, transcript and summary: not the call a seller gets |
| D. Browser audio over our own WebSocket into the bridge | Pretend to be a Twilio Media Stream | A second audio stack (μ-law 8 kHz, echo cancellation, jitter) to build and maintain, for a test page |

**A wins.** The call is the real pipeline end to end, the token cannot dial anything, and cti-web's routes are untouched.

### 5.2 The token and the identity

- **Identity:** `aitest_<user id, 32 hex>_<nonce, 12 hex>`. It is minted by cti-api, new for each run, and never `rep_…`, so the admin's cti-web softphone (if open) never rings for it and no `rep_` parser ever matches it. One shared helper in `@cti/contracts` builds it and reads the user back out (`aiTestIdentityUser`).
- **Token:** a Voice access token from the existing `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`, with `VoiceGrant({ incomingAllow: true })` and **no `outgoingApplicationSid`**, so `device.connect()` cannot place a call.
  - TTL is `AI_VOICE_MAX_CALL_SECONDS + 600` (20 minutes by default), enough for registration, ringing and the longest call.
  - A new Device and token are used per run, so there is no refresh logic.
- **Minting:** `POST /internal/ai-calls/browser-token { orgId, userId }`, HMAC-signed like the trigger. cti-api:
  - looks up the session user (`unknown_user` → 403);
  - requires `isAdmin` (403 `not_admin`);
  - requires AI voice available and the three Twilio values set (503 `browser_calls_unavailable`);
  - answers `{ token, identity, expiresAt }`.
- **Relay:** outreach-api relays it to the admin from `POST /api/record-tests/browser-token` (admin, `Cache-Control: no-store`). The token is never logged on either side.
- **Availability:** `GET /internal/ai-calls/availability` gains `browserCalls: boolean`. It is optional in the contract, so an older cti-api reads as false and the page hides **Talk in browser**.

### 5.3 cti-api: the `practice_browser` target

It is a fourth target kind beside record, test and practice. Every switch on the kind is explicit (1D D-2), so the compiler finds every place it must be handled.

| Concern | `practice` (1D) | `practice_browser` (1E) |
|---|---|---|
| Record and prompt | real record via the integration connection; seller's version (no test line) | same |
| Plan text check (CF-9) | yes | yes |
| Slots, `book_appointment` | yes; stored on `ai_calls` only | same |
| Destination | a listed test number | `client:<identity>` |
| Gate | test branch: admin + `AI_VOICE_TEST_NUMBERS`, then opt-out, caps and `pickAiDid` | **browser branch:** AI voice available; admin (`not_admin_for_test`); the identity's user is the session's user (`invalid_number` otherwise); caller ID = a **read-only** pick of the org's first usable `ai_pool` number (`no_caller_id` if none). No phone number is dialed, so opt-out, DNC, state caps, calling hours and the per-customer ceiling do not apply and no DID dial is claimed |
| Caller ID | claimed `ai_pool` DID | the peeked `ai_pool` number (the agent's callback number sounds real) |
| AMD | on | **off** (no `machineDetection`, no async AMD callback; a browser is never a machine) |
| "Their local time" and slot words | the record's phone's zone | same (`sellerNumber` covers both kinds) |
| Transfer | rings the admin's own softphone | same. The `<Dial>` caller ID is the `from` number, because a `client:` value is not a phone number |
| Row | `is_test = practice = true`, `to_e164` = the test number | same flags, `to_e164 = 'client:<identity>'` |
| `calls` row at finalize | written, linked to no record | **not written**: no phone was dialed, so there is nothing for the cap, ceiling or contact history to count |
| Opt-out on "stop calling me" | never (is_test) | never (is_test) |
| Salesforce Task, touch, results, write-back | none | none |
| Crash recovery | key-linked only (1D m3) | same |
| Double click | `activeCallTo(org, candidate)` | same, with candidate `client:<identity>` |

### 5.4 The browser side

**Mechanics.**
- `@twilio/voice-sdk` (^2.12.3, the cti-web version) is added to outreach-web and loaded with a dynamic `import()` only on this page.
- `Device.isSupported` false hides **Talk in browser**.
- Everything runs in a `useBrowserCall` hook whose Device loader is injectable for tests.

**Steps:**
1. The admin clicks **Talk in browser**. The page asks for the microphone with `getUserMedia({ audio: true })` and releases the tracks; the SDK takes its own. A refusal shows: "Allow the microphone for this site, or use Ring my phone."
2. `POST /api/record-tests/browser-token`, then `new Device(token, { logLevel: 1 })`, `register()` and wait for `registered`, with a 15 s limit.
3. `POST /api/record-tests/:id/calls { mode: 'browser', identity }`. A `blocked` or `failed` answer destroys the Device and shows the words.
4. While waiting (45 s limit), the first `incoming` call is accepted with `call.accept()`. The identity is unique to this run and only our Twilio account can ring it, so no other check is needed.
5. Live: "Connected · 1:23", **Mute** (`call.mute`), **Hang up** (`call.disconnect`), and the server status from polling. The hint reads: "Use headphones so the AI doesn't hear itself. You are the seller."
6. On `disconnect`, `cancel` or `error`, or when the page unmounts: `device.destroy()`. Closing the tab ends the leg; cti-api's status callback finalizes it.

**What outreach-api needs:** no Content-Security-Policy or Permissions-Policy is sent today, so the microphone and Twilio's WebSocket and media work as they do in cti-web. The runbook warns that any future policy must allow `microphone=(self)` and Twilio's hosts.

## 6. Data model

**`0058_ai_record_tests.sql`** (outreach-owned, in `schema-outreach.ts`; foreign keys in SQL only; the number is re-checked against `origin/main` and 1D's final branch before use).

`ai_record_tests`, one row per preview:
- **Ids:** `id`, `org_id`, `requested_by`.
- **The record:** `sf_object` (Lead or Opportunity, CHECK) and `sf_record_id` (18 characters).
- **State:** `status` (running, ready or failed, CHECK) and `error` (a short code: not_found, salesforce_error, not_connected, plan_failed, timeout).
- **What it found:** `name`, `research` (the snapshot), `plan` (the `CallPlan`), `plan_text` (null when refused) and `plan_text_issues` (jsonb, `[]` default).
- **The offer:** `slots` (jsonb, `[]` default), `offer_note` and `owner_sf_user_id`.
- **Model use:** `model`, `input_tokens`, `output_tokens` and `cost_micros`.
- **Timing:** `created_at` and `completed_at`.
- **Indexes:** `(org_id, created_at desc)` and `(requested_by, created_at desc)`.

`ai_record_test_calls`, one row per run:
- **Ids:** `id`, `org_id`, `record_test_id` (cascades), `requested_by`.
- **The destination:** `mode` (phone or browser), with `to_e164` (phone) or `client_identity` (browser), exactly one by CHECK.
- **The call:** `idempotency_key` (unique), `ai_call_id`, `result` (the internal answer).
- **The dry run:** `dry_run` (jsonb, §4.5).
- **Timing:** `created_at`.
- **Indexes:** `(record_test_id, created_at desc)` and `(requested_by, created_at desc)`.

**No CTI migration.** `ai_calls.outcome` has no CHECK, and `to_e164` is plain text. A browser leg is recognised by `to_e164 LIKE 'client:%'`.

## 7. Guarantees (each pinned by a test in the plan)

| # | Guarantee |
|---|---|
| G-1 | A preview writes nothing to Salesforce and creates no enrollment, touch, `call_plans`, `crm_records` or hold row |
| G-2 | A test call never writes to Salesforce, never books or converts, never opts a number out, and never creates a touch or write-back row. It is `is_test = practice = true` for both modes, so every 1D practice guard applies unchanged |
| G-3 | A test call only ever dials a number on `AI_VOICE_TEST_NUMBERS`, or a `client:aitest_<the requesting admin>_…` identity. Both are checked in outreach-api for the words and in cti-api's gate as the authority |
| G-4 | The browser token can only receive calls (no outgoing grant). Its identity is bound to the admin, and it is never logged |
| G-5 | The agent gets plan text only after `agentPlanTextIssues` passes, at preview, at run (outreach-api) and at trigger (cti-api) |
| G-6 | Practice bookings never block a real slot and are refused a time a real call holds (1D's `bookedNotOnCalendar` excludes test calls) |
| G-7 | "Would have written" sends no POST, PATCH or SOAP request |
| G-8 | Everything is admin-only and org-scoped. Every query filters `org_id`, and a test or call of another org is a 404 |

## 8. Security, cost and limits

### 8.1 Access

- **Pages and routes:** admins only, with `requireAdmin`; a super admin acts in the selected tenant. The nav link shows only to admins.
- **Salesforce:** research and slot reads use the tenant's integration connection, read-only, as campaign research does. The admin's own Salesforce token is never used.
- **Untrusted content:** record content reaches the plan model only as escaped data (unchanged) and reaches the agent only through checked plan text.
- **Logs:** ids, codes and counts only. Never record text, phone numbers, tokens or identities beyond the run id.

### 8.2 Limits (counted in Postgres under a per-admin advisory lock, so two quick clicks cannot both pass)

| Limit | Value | Refusal |
|---|---|---|
| Previews per admin per hour | 10 | 429 `RATE_LIMITED` "You've run 10 previews in the last hour. Try again at 3:42 PM." |
| Previews per tenant per UTC day | 40 | 429 `RATE_LIMITED` |
| Previews running per admin | 1 | 409 `PREVIEW_RUNNING` |
| Tenant daily AI budget | the 1C budget (`budgetMicros`) | 409 `AI_BUDGET_SPENT` |
| Test calls per admin per hour | 6 | 429 `RATE_LIMITED` |
| Live test calls per admin | 1 (any of their calls not yet terminal, or less than 2 min old without an `ai_call_id`) | 409 `CALL_IN_PROGRESS` |
| Browser tokens | only through the run flow; the route also carries `config.rateLimit` 10/min per IP | 429 |
| Dry runs per call | 1 (stored) | the stored result |

### 8.3 Cost per use

- **A preview:** about 12–15 Salesforce REST requests plus 2–3 for the calendar, and one plan-model call, roughly 15–25k input and 1.5k output tokens, about **$0.04–0.07**.
- **A test call:** the OpenAI Realtime minutes as for any AI call (`ai-voice.md` §13), plus Twilio Client minutes for a browser leg (cents).
- **A dry run:** one mapping-model call, about $0.01–0.03.
- **The ceiling:** at 40 previews a tenant spends at most about $3 a day on previews, inside the existing AI budget.

## 9. Deploy and Twilio setup

1. **Twilio: nothing new to create.**
   - The browser leg uses the existing API key (`TWILIO_API_KEY_SID`/`SECRET`), which cti-web's softphone already needs.
   - No TwiML App is used (the token has no outgoing grant), and no new number is needed.
   - The owner only confirms the three values are set on `@cti/api` (the runbook gives the command that prints names only).
   - Browser legs bill as Twilio Client minutes.
2. **Migration 0058** runs in the pre-deploy migrate step, after 1D's 0055–0057.
3. **Deploy `@cti/api` and outreach-api from the same merge.**
   - An old cti-api answers a `practice_browser` trigger with 400 (outreach-api shows "The AI calling service did not answer") and has no token route (the page hides **Talk in browser** because `browserCalls` is absent).
   - Phone tests work across the window.
4. **No new environment variables.** `AI_VOICE_TEST_NUMBERS` must hold the admins' phones for **Ring my phone**.
5. **Smoke test:**
   - preview a real Opportunity and a real Lead;
   - run one phone test and one browser test (headphones);
   - book a phone time, check the page says "Would have booked …" and that nothing appears in Salesforce;
   - press "What would be written" once.

## 10. Out of scope (YAGNI)

- Editing the plan before a test (regenerate only).
- Tests of objects other than Lead and Opportunity.
- Rep (non-admin) access.
- Saving a test's plan to a campaign.
- Recording browser audio locally.
- Sharing a test link with another admin; the list shows the tenant's latest 20, so another admin can open one.

## 11. Open questions for the owner (each has a recommended default the plan implements)

1. **Who can use Test a record?** Recommended: **admins only**, as practice calls are today. The alternative is anyone who can approve plans; that needs per-user test-number rules first.
2. **Whose phone can "Ring my phone" ring?** Today any admin may pick any number on the shared `AI_VOICE_TEST_NUMBERS` list. Recommended: **keep the shared list** (they are the team's own phones). The alternative is binding numbers to admins (a new setting), worth it only once there are more admins.
3. **A transfer during a browser test.** Recommended: **identical to a phone practice call.** It rings your own CTI softphone if it is open, otherwise the AI says the specialist stepped away. The alternative is a simulated "would have transferred to <owner>", which changes the agent's tools for tests only.
4. **"Would have written to Salesforce."** Recommended: **build it, on request only** (a button; about 1–3¢ a press; nothing sent). It is the last task of the plan and can be dropped without touching the rest.
5. **Records with consent "no" or a do-not-contact flag.** Recommended: **allow the test**, with the warning shown in red, since only you are called. The alternative is refusing the run for those records.
