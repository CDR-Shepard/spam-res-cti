# Outreach Salesforce campaigns — operator runbook

Everything here is a human step. The code ships with plan 1B (`docs/superpowers/plans/2026-10-04-sf-campaigns-1b-live-calls.md`); the design is `docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md`.

The target org is alias `_t2` (`gghsd.my.salesforce.com`). **It is PRODUCTION.** Read `salesforce/README.md` first: never deploy with `-d force-app` or `-d force-app/main/default`, because that pushes the stale `layouts/` snapshots over the org's live layouts.

## Signing in to Outreach

People sign in to outreach-web with Salesforce, the same login as the CTI softphone. It uses the CTI's External Client App `Caller_Reputation_CTI` (PKCE, no client secret).

**Who can sign in.** Only people who already exist in the CTI, in a tenant the CTI already has for their Salesforce org. Outreach never creates a tenant or a user from a sign-in, and never changes admin rights. Signing in to the CTI softphone once is enough to create a person. Admin rights are the CTI's (set from the Salesforce profile when someone signs in to the CTI). The Salesforce token a sign-in obtains is revoked and dropped straight away: nothing is stored.

**The variables on outreach-api** (Railway, filled in the dashboard):

| Variable | Value |
|---|---|
| `SALESFORCE_CLIENT_ID` | The `Caller_Reputation_CTI` consumer key, the same as `@cti/api`'s |
| `SALESFORCE_LOGIN_URL` | `https://login.salesforce.com` |
| `SALESFORCE_SIGNIN_REDIRECT_URI` | `https://outreach-api-production-a07b.up.railway.app/api/auth/salesforce/callback` (already on the app's callback list) |
| `SALESFORCE_ALLOWED_ORG_ID` | Optional. Copy `@cti/api`'s, so only that org can sign in |

There is no client secret: the app requires PKCE. Redeploy outreach-api after changing them. Sign-in is on when `SALESFORCE_CLIENT_ID` and `SALESFORCE_SIGNIN_REDIRECT_URI` are both set.

**Error words.** A failed sign-in lands on `/sign-in?error=<reason>`:

| Reason | What it means, and the fix |
|---|---|
| `no_account` | The Salesforce org is known but this person is not in the CTI. Have them sign in to the CTI softphone once, or ask an admin to add them. |
| `no_tenant` | No CTI tenant has this Salesforce org. The CTI creates the tenant on its first Salesforce login. |
| `tenant_suspended` | The tenant is suspended. |
| `org_not_allowed` | `SALESFORCE_ALLOWED_ORG_ID` is set and this is another org. Sign in with the right org, or correct the variable. |
| `salesforce_unavailable` | Salesforce did not answer (or answered inconsistently). Try again in a minute. |
| `invalid_code` | The Salesforce code was refused (expired or already used). Start again. |
| `bad_state` | The attempt expired, or was started in another tab or browser. Start again. |
| `bad_return_to` | The link's return address was unsafe and was dropped. Sign in as usual. |
| `access_denied` / `missing_code` | The person cancelled in Salesforce, or Salesforce sent no code. |
| `forbidden` | The account cannot hold a session (a service user). |
| `sign_in_disabled` | Salesforce sign-in is not configured on outreach-api (see the variables above). |
| `server_error` | Something failed in outreach-api. Check its logs (the error name is logged, never the code or a token). |

**WorkOS is optional.** With `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` and `WORKOS_REDIRECT_URI` all set, the sign-in page also offers "Sign in with email". Leave them unset and the button is hidden.

**The integration connection is separate.** Settings → Connections (§0.5 below, `SALESFORCE_REDIRECT_URI`) signs in the Integration user through a different callback on the same app. Confirm `/api/connections/salesforce/callback` is on the app's callback list as well as `/api/auth/salesforce/callback`.

## How outreach-api is deployed

outreach-api is the Railway service `outreach-api` in project `endearing-comfort` (production), at `https://outreach-api-production-a07b.up.railway.app`. It also serves the built outreach-web bundle from the same origin, so there is no separate web service.

- **It was created with the Railway CLI, not with `railway config apply`. Never run `railway config apply`.** The `outreachApi` block in `.railway/railway.ts` is a record of the service (so a future apply does not blank its variables), not a way to create it.
- **One image for every service built from this repo.** Railway applies the repo's root `railway.json` (and so the root `Dockerfile`) to every service built from the repo and refuses per-service config files. The root `Dockerfile` therefore also builds `apps/outreach-web` and `services/outreach-api`. outreach-api runs that same image, with its **start command overridden in the dashboard** to `node services/outreach-api/dist/server.js` and `PORT` = `4100`. There is no `services/outreach-api/railway.json`.
- **Pre-deploy migrations.** The root `railway.json`'s pre-deploy step (`npm --workspace packages/db run migrate`) runs for outreach-api too, and needs `DATABASE_URL` (set). Migrations `0052_ai_call_campaigns.sql` and `0053_ai_call_requests.sql` run in whichever service deploys first.
- **After every deploy:** `TOKEN_ENCRYPTION_KEY` must be identical on `@cti/api` and outreach-api. `@cti/api` decrypts the integration token that outreach-api stores. If the keys differ, every AI call is refused with `salesforce_error` ("Salesforce did not answer" in the results). The leads wait and use no attempts, but nobody is called until the keys match.
- **Variables** are set in the dashboard (or with `railway variables --set ... --service outreach-api`). The names are listed in `.railway/railway.ts` and `services/outreach-api/.env.example`. The ones for AI call campaigns are in the next section.

**Known issue.** `@cti/web` has failed every deploy since 2026-09-28: the root `railway.json`'s pre-deploy migrate runs there too, and that service has no `DATABASE_URL`. It does not affect `@cti/api` or outreach-api.

## 0. Salesforce setup (one time, ~30 minutes)

outreach-api connects to Salesforce as one company-wide **Integration user**, never as a rep. That user gets exactly the access in the `AI_Outreach` permission set, plus an in-org permission set for the tenant's own custom fields.

1. **Create the Integration user.** Setup → Users → New User:
   - **User License:** `Salesforce Integration`. **Profile:** `Minimum Access - API Only Integrations`.
   - Name it so it reads well on records it touches, for example `AI Outreach`. Use a real mailbox you control for the email.
   - Save, then on the user's page → **Permission Set License Assignments** → **Edit Assignments** → tick `Salesforce API Integration` → Save.

   > **Risk to check before step 5:** an API-only user cannot sign in to the Salesforce web UI, and the Connections page (§0.5) signs in through the browser (OAuth web-server flow with PKCE). If the browser sign-in is refused for this user, use a dedicated full-license user named `AI Outreach` with the same permission sets instead, and raise it with the outreach-api owners. A client-credentials connection for the Integration user is a planned follow-up, not built yet.

2. **Validate, then deploy the consent fields and the `AI_Outreach` permission set.** From the repo root on `main`, in `salesforce/`. Name the seven files explicitly:

   ```bash
   cd salesforce
   SRC=(
     force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml
     force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml
     force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml
     force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml
   )
   sf project deploy validate -o _t2 $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Expect `Status: Succeeded`. If it is refused:
   - `Field … is not permissionable` (or a similar FLS error) on a standard field: delete that one `<fieldPermissions>` block from `AI_Outreach.permissionset-meta.xml`, then run `npm -w services/outreach-api run test -- src/crm/salesforce-metadata.test.ts`. Update the test's expected list to match, commit both, and validate again.
   - Anything about `layouts`: you passed a directory. Pass only the seven files above.

   Then deploy the same seven files:

   ```bash
   sf project deploy start -o _t2 $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Expect `Status: Succeeded` and seven `Created` rows. Reruns show `Unchanged`.

3. **Assign `AI_Outreach` to the Integration user.**

   ```bash
   sf org assign permset -n AI_Outreach -o _t2 -b <integration username>
   ```

   If the assignment is refused because **Edit Tasks** is not allowed by the user's license, remove the `<userPermissions>` block (`EditTask`) and the `Activity.CTI_Origin__c` `<fieldPermissions>` block, and update the metadata test to match. Then redeploy (step 2) and retry the assignment. Phase 1 writes no Tasks; restore both blocks before phase 2 starts writing them.

4. **Grant the tenant's own fields in the org.** These fields exist only in this org, so they cannot live in the repo permission set: a reference to a missing field fails the whole deploy. Setup → Permission Sets → New: Label `AI Outreach Fields`, API name `AI_Outreach_Fields`, no license. Under **Object Settings**, grant **Read** on:
   - **Lead:** Address (State), `Notes__c`, `Agent_Notes__c`, `Motivation__c`, `SecondaryMotivation__c`, `Appointment_Notes__c`, `Analyst_Notes__c`, `Lead_Form_Source__c`, `LeadManager__c`.
   - **Opportunity:** `Mobile_Phone__c`, `Phone__c`, `Other_Phone__c`, `Lead_Form_Source__c`, `LeadManager__c`, and whichever notes fields the tenant's Opportunity field map reads.
   - **Task:** Description.

   Grant only the fields this tenant's field map uses (Settings → Connections → field map). Assign the set to the Integration user. Skip any field the org doesn't have.

5. **Connected app** (Setup → App Manager → New Connected App, or New External Client App):
   - Callback URL: `${API_PUBLIC_URL}/api/connections/salesforce/callback`, using outreach-api's public URL from `outreach-api-deploy.md` §2.
   - OAuth scopes: `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)`.
   - Require **PKCE**. Refresh token policy: **valid until revoked**. Under **Manage → Edit Policies**, set Permitted Users to "Admin approved users are pre-authorized" and add the `AI Outreach` permission set, so only the Integration user can use the app.
   - Set the outreach-api Railway variables `SALESFORCE_CLIENT_ID` (consumer key) and `SALESFORCE_REDIRECT_URI` (the callback URL above). Leave `SALESFORCE_CLIENT_SECRET` unset: the External Client App is PKCE-only and has no secret (outreach-api sends a secret only when the variable is set). Then redeploy outreach-api.
   - In outreach-web, open **Settings → Connections** as an admin, choose **Connect Salesforce**, and sign in **as the Integration user**. The page should show it as connected with the Integration user's username.

6. **Optional, in Setup only:** to let reps see the consent fields, add them to the Lead and Opportunity page layouts through the Setup UI. **Do not** deploy layouts from the repo (`salesforce/README.md`). If reps should record consent themselves (source `Rep`), give their profile or permission set **edit** on the three fields.

**Check:** on any Lead, Setup → Object Manager → Lead → Fields shows `AI Call Consent`, `AI Call Consent Date`, and `AI Call Consent Source` with five values in order: Text Reply, Email Reply, Web Form, Inbound Call, Rep.


## AI call campaigns (plan 1C)

### What it is

A campaign mode where people pick the leads, the AI researches and plans each call, a person approves each plan, and the AI voice agent (cti-api) places the calls. Every engine gate still applies, at the moment of the call: consent (`AI_Call_Consent__c`), opt-outs, the block list, federal DNC, the state caps, the per-customer ceiling, calling hours and the AI caller IDs. The CTI softphone has no AI call button or tab any more; everything starts here.

### Before the first campaign

1. Complete `ai-voice.md` §2–§5: the AI number and the test call from outreach-web.
2. On outreach-api set the three variables below, and redeploy. On `@cti/api`, `OUTREACH_INTERNAL_SECRET` must hold the same value (`ai-voice.md` §3).

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | Claude key (call plans and note triage). Unset = both off |
   | `CTI_INTERNAL_URL` | `http://ctiapi.railway.internal:4000` (plain http on Railway's private network; an origin only, no path) |
   | `OUTREACH_INTERNAL_SECRET` | The same 32+ character secret as on `@cti/api` |

   `CALL_PLAN_MODEL` is optional (default `claude-sonnet-5-5`); any other value must be priced in `services/outreach-api/src/ai/model.ts` or plans are not drafted. Both outreach-api and `@cti/api` must also hold the same `TOKEN_ENCRYPTION_KEY`, because `@cti/api` decrypts the integration token that outreach-api stores.
3. The Integration user needs read access to Tasks, Events, Notes, ContentNote/ContentDocumentLink, EmailMessage and Chatter (FeedItem, FeedComment), and to Account (related records) as well as the Lead and Opportunity fields in §0. Missing access is not an error for the plan: its card lists the source as "the integration user cannot read it".

   **Tasks and Events are the exception.** Before every call the pacer checks Salesforce for a Task or Event newer than the research. If the Integration user cannot read Task or Event, that check fails every time and the tenant's due calls wait in 30-minute steps; the results show "could not check Salesforce for new activity". Nobody is called unchecked.
4. Check the link from outreach-api's shell (`railway ssh --service outreach-api`):

   ```bash
   curl -s -o /dev/null -w '%{http_code}' "$CTI_INTERNAL_URL/internal/ai-calls/availability"
   ```

   Expected: `401` (reachable, unsigned). `404` means `CTI_INTERNAL_URL` is not the `.railway.internal` host, or `OUTREACH_INTERNAL_SECRET` is unset on `@cti/api` (production hides the routes behind the same 404); `503` is the unset secret outside production; a connection error means private networking is not reaching it (`ai-voice.md` §11).

### Step by step

1. **New campaign.** Campaigns → New campaign. Under **What the campaign does** pick **AI calls to leads you pick**, then the Salesforce object (Leads or Opportunities).
2. **Pick the source:** a Salesforce list view or a SOQL query. **Create campaign** makes a draft.
3. **Tick leads** in the **Leads to call** picker (**Select this page**, **Select all N**, or tick rows; **Clear** unticks everything except leads held for review), then **Continue to campaign**. Only ticked leads are enrolled. Rows the campaign cannot use are greyed with the reason (no phone or email, opted out, on the block list, Do Not Call, Skip on Dialer, already in another active campaign, closed). A lead without AI consent in Salesforce can still be ticked; its card then shows "AI consent: no" and cannot be approved.
4. **Start dry run** first. A draft campaign is not refreshed, so nothing happens until then. The refresh runs every 5 minutes, enrolls the ticked leads, and the plans are drafted about a minute after. In a dry run the plans are drafted and nothing is called.
5. **Review each card** on the **Call plans** board: the record link, owner, AI consent badge, research sources (and whether each could be read), selling signals with their quotes, the opener, the four goals, talking points, questions, things to avoid, the best time to call, and any warnings. Then **Approve**, **Edit**, **Reject** (removes the lead from the campaign) or **Research again**. Only the record owner or an admin can decide. Approving does not place a call.
6. **Go live.** Press **Go live** and confirm (the board's hint calls this "Activate"). **Call all approved (N)** appears for admins on an active campaign.
7. **Call all approved.** This queues one call per approved lead for the pacer, which places them as the settings below allow (it may take several presses if more than one batch is waiting: "More approved leads are waiting").
8. **Watch the AI calls card** under the board (results table: Lead, Status, Outcome, Summary, Appointment, Salesforce, When; **Transcript** for the record owner or an admin). Before going live, admins can ring their own phone with any card's plan (**Practice call to my phone**, `ai-voice.md` §16); those calls are listed under **Practice calls** above the results.

### Pacing settings

Three per-tenant settings live in `organizations.settings` (jsonb). They have no screen; change them with SQL. Out-of-range or non-integer values are ignored and the default applies.

| Setting | Default | Range | Meaning |
|---|---|---|---|
| `aiCallConcurrency` | 2 | 1–5 | AI calls the tenant may have live at once. A placed call holds a slot until it ends, and at most one hour. |
| `aiCallDailyCap` | 50 | 0–500 (0 = no calls are placed) | AI calls placed per rolling 24 hours. It counts only calls outreach placed: not calls the engine refused, and not test calls. |
| `aiCallMaxAttempts` | 3 | 1–5 | Unanswered attempts per lead (no answer, busy, voicemail, failed) before the lead completes. |

```bash
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
echo "SELECT id, name FROM organizations;" | psql "$PUB"
echo "UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('aiCallConcurrency', 3) WHERE id = :'org' RETURNING settings;" | psql "$PUB" -v org='<org uuid>'
echo "UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('aiCallDailyCap', 100) WHERE id = :'org' RETURNING settings;" | psql "$PUB" -v org='<org uuid>'
echo "UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('aiCallMaxAttempts', 2) WHERE id = :'org' RETURNING settings;" | psql "$PUB" -v org='<org uuid>'
```

`$PUB` is a live credential: never print or share it. The pacer runs every minute and picks the new values up on its next tick.

How the pacer times calls:

- **Calling hours:** 08:00 to 21:00 in the person's local time. A lead's first call uses the plan's preferred window (morning 8–12, afternoon 12–5, evening 5–9, or any time); later calls use the whole calling window.
- **After no answer, busy, voicemail or failed:** the next try is at least 20 hours later, in the next calling window.
- **Retried refusals** wait before the next try: calling hours, until the window opens; daily state cap or per-customer ceiling, about 12 hours and then the window; no AI caller ID or AI calling switched off, 30 minutes; another call to them in progress, 10 minutes; the phone carrier refused the call (`twilio_error`), as after no answer (at least 20 hours, in the next calling window), because the carrier may already have rung them; any other, 5 minutes doubling to 2 hours. The same request key is kept for an in-flight or transport retry, and those wait at least 10 minutes. If cti-api answers 409 (`idempotency_conflict`), the pacer reads what cti-api stored under the key first; only when no call was placed under it is the key dropped and the retry goes once with a new key, at least 10 minutes later. A trigger whose tick died (a `dialing` touch with no call after 5 minutes) is tried again with the same key no sooner than 10 minutes after it was claimed; if its lead has ended meanwhile, the touch is skipped (`enrollment_ended`) instead. A claim the pacer could not make (the lead changed since it was queued) waits 15 minutes. If the lead is no longer queued, the touch is skipped (`not_claimable`) so "Call all approved" can queue it again. After 8 refusals in a row while the touch is due (time the campaign was paused does not count) the touch is skipped too, and a lead still queued goes back to approved. A touch that kept its request key is never skipped before the pacer has checked that key with cti-api (see "A touch waiting after transport errors" below). After 8 attempts the lead exits "gave up after repeated errors". Only attempts about the person count. A refusal about the system never uses an attempt and never ends the lead: AI calling switched off, no AI caller ID free, the state's daily call cap reached (`daily_cap`, which applies to the whole tenant), a Salesforce or compliance-check error in cti-api, or no answer from cti-api. The per-customer ceiling (`customer_ceiling`) is about the person, so it counts. While cti-api says AI calling is off, or does not answer, the pacer claims nothing at all.
- **New Salesforce activity.** If a Task or Event on the record is newer than the research, the call is not placed: the lead goes back to research and the card says "New activity in Salesforce since the research: researching again before any call." A rep's call Task between attempts does the same, by design. Tasks the AI's own calls logged are ignored.
- **Salesforce checkboxes** Do Not Call and Skip on Dialer stop the call (shown as "Do Not Call is checked in Salesforce" / "Skip on Dialer is checked in Salesforce"). The AI call consent checkbox is read fresh too: unchecked or empty, the lead ends with "no AI consent in Salesforce" (`ai_call_no_consent`) without a trigger.
- **A plan the voice agent refuses, or an approver who cannot place AI calls** (`plan_rejected`, `unknown_user`): the lead goes back to the review board with an error on its card. It is not ended: edit the plan and approve it again (or have someone who can place AI calls approve it).

### What each outcome does

| Call outcome (words in the results table) | What happens to the lead |
|---|---|
| Transferred to a person, Callback booked, Transfer missed — call them back, Appointment set | Handed off to the rep (the enrollment ends as `handed_off`); a real call's result is then written to Salesforce (§Appointments and Salesforce write-back) |
| Not interested | Leaves the campaign ("Not interested") |
| Asked not to be called | Leaves the campaign ("Asked not to be called"); the engine has already written the opt-out |
| Wrong number | Leaves the campaign ("Wrong number") |
| No answer, Busy, Voicemail, Call failed | Another call is planned for the next day, up to `aiCallMaxAttempts` attempts; then it completes as "No answer after every attempt" |
| Hung up, Other | Completes as "The call ended" |
| Blocked | Decided when the call is triggered: see "Not called" below |

### "Not called: …" reasons

These appear in the Status cell. **Retried** ones say "Waiting — next try …" with the last reason; **final** ones end the lead for good and read "Not called: …".

| Words | Code | Kind |
|---|---|---|
| no AI consent in Salesforce | `no_consent` | final |
| this Salesforce org has no AI consent field | `consent_field_missing` | final |
| the record has no phone number / the phone number is not valid | `no_phone` / `invalid_number` | final |
| they opted out of calls | `opted_out` | final |
| the number is on the block list | `blocked` | final |
| on the federal Do Not Call list | `dnc` | final |
| the Salesforce record was not found | `record_not_found` | final |
| test calls are for admins, to a number in AI_VOICE_TEST_NUMBERS | `not_admin_for_test` | final (test calls only) |
| outside calling hours where they live | `calling_hours` | retried |
| their state's daily call limit was reached | `daily_cap` | retried (uses no attempt) |
| the call limit for this person was reached | `customer_ceiling` | retried |
| no AI caller ID number is free | `no_caller_id` | retried (add an AI number: `ai-voice.md` §5) |
| AI calling is switched off | `ai_voice_unavailable` | retried (the kill switch) |
| another call to them is in progress | `call_in_progress` | retried |
| Salesforce did not answer / a compliance check could not run / the phone carrier refused the call / the call request was still being handled | `salesforce_error` / `gate_error` / `twilio_error` / `in_flight` | retried |
| the AI calling service did not answer | `transport` | retried |
| gave up after repeated errors | `gave_up` | final (after 8 attempts; refusals about the system do not count) |
| could not check Salesforce for new activity | `activity_check_failed` | waits 30 minutes |

### Cost

Each plan is one Claude call, counted with note triage against the tenant's daily budget (`aiDailyBudgetUsd`, default $25, per UTC day). Sonnet 5.5 costs $2 per million input tokens and $10 per million output tokens (`PRICE_MICROS_PER_TOKEN` in `services/outreach-api/src/ai/model.ts`), so a typical plan (about 12,000 tokens in, 1,500 out) costs about 4 cents. When the day's budget is spent, **every running campaign of the tenant pauses** (`pauseOrgCampaigns`, reason `ai_budget`): sequence and AI call campaigns alike, dry run or live, not just the campaign that spent it. The banner reads "Paused: today's AI budget is used up — it does not resume on its own: press Resume after midnight UTC or raise the budget". Nothing resumes these campaigns automatically: an admin presses **Resume** (or **Resume dry run**) on each one after the next UTC day starts, or after raising `aiDailyBudgetUsd` in the same way as the pacing settings. The voice call itself is billed separately (`ai-voice.md` §13).

### Troubleshooting

outreach-api's logs (`railway logs --service outreach-api`) carry one line per trigger, `ai_call.place: trigger answered`, with the org, touch, attempt and `result`; never the plan text or a phone number. When `result` is `retry:transport`, the `transport` field says what went wrong:

| `transport` | What it means and what to do |
|---|---|
| `HTTP 401 bad_signature` | cti-api refused the signature: the two `OUTREACH_INTERNAL_SECRET` values differ, or the clocks are more than 5 minutes apart. `@cti/api`'s logs say `ai-voice internal: signature refused` with the reason. |
| `HTTP 404` | `CTI_INTERNAL_URL` is not the `.railway.internal` host, or `OUTREACH_INTERNAL_SECRET` is unset on `@cti/api` (production hides the routes behind a 404). |
| `HTTP 503 internal_disabled` | `OUTREACH_INTERNAL_SECRET` is unset on `@cti/api` (outside production only). |
| `HTTP 403 forbidden` | The request carried an `Origin` header; only outreach-api's server calls the route. |
| `HTTP 429` | cti-api's rate limit for internal requests was hit; the pacer retries. |
| `HTTP 400 invalid_body` | cti-api could not read the request: the two services are on different versions. Deploy both from the same commit. |
| `HTTP 500 internal_error` (or another status) | cti-api failed on the request; its logs say `ai-voice internal: request failed`. The pacer retries with the same key. |
| `timeout` / `network` | cti-api did not answer within 20 seconds, or could not be reached: private networking (`ai-voice.md` §11). |
| `bad_response` | cti-api answered 200 with a body outreach-api cannot read: the two services are on different versions. Deploy both from the same commit. |

The curl probe in "Before the first campaign" step 4 tells the same cases apart by hand.

Transport failures never use up a lead's attempts: the pacer keeps retrying with the same key until cti-api answers.

Other lines to know:

- **`result: retry:idempotency_conflict`.** cti-api answered 409: the same request key arrived with a different body, for example when the plan text or target changed while the key was kept. The pacer first reads what cti-api stored under the old key (below): a placed call is linked and nothing is retried; a request still in flight keeps the key and waits (`retry:in_flight`). Only when cti-api has no call under it does the pacer drop the key and retry once with a new one, at least 10 minutes later; that attempt counts.
- **`ai_call.place: cti-api says AI calling is off, or did not answer; nothing is placed this tick`** (`availability: off` or `unreachable`). The kill switch is on, `OPENAI_API_KEY` is unset on `@cti/api`, or cti-api is down or unreachable. Nothing is claimed and no lead uses an attempt.
- **Every call ends `retry:salesforce_error`.** Check that `TOKEN_ENCRYPTION_KEY` is identical on `@cti/api` and outreach-api ("How outreach-api is deployed"), and that the tenant's Salesforce connection still works.

**A touch waiting after transport errors ("the AI calling service did not answer") may already have placed a call.** The request can reach cti-api even when its answer is lost. outreach-api now resolves a kept key itself, read-only, through the `ai_call_requests` table both services share: before the pacer re-sends, skips or parks a touch that kept its key, or replaces the key after a 409, it reads what cti-api stored under that key. A placed call is linked to the touch (it shows as sent, and nothing is dialed again). A request cti-api may still be handling makes the touch wait, keeping its key (`in_flight`). A reservation older than 10 minutes with no answer is matched to the call it left in `ai_calls` (same tenant, approver and record), as cti-api's own takeover does. Only a key cti-api never dialed under is dropped. The log line is `ai_call.place: kept key resolved in cti-api's request store` (`keptKey: placed` or `pending`), and a 409's `trigger answered` line carries `conflict: answered | pending | none`. Before calling the person by hand, you can still check by trigger key: the key is `touch:<touch id>:<attempt>:<claim time in ms>`, and cti-api stores it in `ai_call_requests.idempotency_key` with the call it placed in `ai_call_id`:

```bash
echo "SELECT idempotency_key, ai_call_id, response, created_at FROM ai_call_requests WHERE org_id = :'org' AND idempotency_key LIKE :'key';" | psql "$PUB" -v org='<org uuid>' -v key='touch:<touch id>:%'
```

### Stopping everything

- **Pause the campaign** (the **Pause** button): planned calls wait and nothing new is claimed. This is the normal way to stop a campaign.
- **The AI voice kill switch:** `AI_VOICE=off` on `@cti/api`. It pauses AI calls without using up any lead's attempts. While it is off the pacer claims nothing and logs `ai_call.place: cti-api says AI calling is off, or did not answer; nothing is placed this tick`. When it is back on, the waiting calls go out in their next calling window. `OUTREACH_KILL_SWITCH=on` stops all outreach, including AI calls, the same way.

## Appointments and Salesforce write-back (plan 1D)

After a **real** AI call is counted, outreach-api writes its result back to Salesforce once, through the tenant's connection, step by step (`ai_call.writeback`, every minute): a Lead that booked is converted, the appointment Event is put on the appointment owner's calendar, the record's fields are filled or moved, a Task is made when a person must act, and a Chatter post sums the call up. cti-api never writes any of it. Test and practice calls are never written.

### Setup (one time, in this order)

1. **Salesforce metadata.** From `salesforce/`, on `main`, name the three files exactly. Validate first, then deploy:

   ```bash
   cd salesforce
   SRC=(
     force-app/main/default/objects/Lead/fields/AI_Last_Call_Changes__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Last_Call_Changes__c.field-meta.xml
     force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml
   )
   sf project deploy validate -o _t2 --test-level RunSpecifiedTests --tests PowerDialRelayTest $(printf -- '--source-dir %s ' "${SRC[@]}")
   sf project deploy start    -o _t2 --test-level RunSpecifiedTests --tests PowerDialRelayTest $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Never pass a directory. The org's own tests fail and `NoTestRun` is refused, hence `PowerDialRelayTest`. The sandbox `gghsd-maindev` lacks some fields, so validate against `_t2`. No Apex is deployed: conversion uses the SOAP API.

2. **Find the connected user.** Settings → Connections shows the username. Every write-back edit, Event, Task, Chatter post and conversion shows as that user (Created By, Last Modified By). It may be the shared System Administrator `integration@gghomessd.com` (spec decision 5, not yet decided). A dedicated "AI Outreach" user would make the history readable, but it needs its own **paid** Salesforce user license: it converts Leads and creates Accounts, Opportunities and Events, which the free API-only `Salesforce Integration` license (§0 step 1) may not cover. Check with Salesforce before buying. **If `AI_Outreach` is assigned to an Integration-license user, Salesforce may refuse Convert Leads or Edit Events:** the assignment fails, or readiness (step 7) says conversion is not ready. Then connect a full-license user instead (same permission sets) and reconnect on Settings → Connections. Nothing in the code depends on which user it is. Then assign the permission set:

   ```bash
   sf org assign permset -n AI_Outreach -o _t2 -b <username>
   ```

   `AI_Outreach` has no assignments today. The new field's field-level security comes only from it, even for a System Administrator. For a non-administrator user it also supplies Convert Leads, Edit Events and Tasks, and create on Account, Contact and Opportunity. The Events and Tasks the write-back makes carry **CTI Origin = AI Outreach** (`Activity.CTI_Origin__c`, granted by `AI_Outreach`); if Salesforce refuses that field they are made once more without it, and the AI's own Events and Tasks are never taken for new activity before the next call. Conversions are made over the SOAP API with the same connection, so the readiness check asks SOAP who the user is (`getUserInfo`).

3. **Grant the tenant's fields** in the in-org `AI_Outreach_Fields` set (§0 step 4): **Edit** (not just Read) on every field the write-back writes and the status fields:
   - **Lead:** Status, Rating, `Unqualified_Reason__c`, `Removal_Status__c`, DoNotCall, `Skip_on_Dialer__c`;
   - **Opportunity:** StageName, `Rating__c`, `Loss_Reason__c`, `Closed_Lost_Reason__c`, `Next_Follow_Up_Date__c`, `Skip_on_Dialer__c`;
   - **Contact:** DoNotCall (for a Person Account this also covers the Account's Do Not Call, `PersonDoNotCall`);
   - **Opportunity, for conversions:** `LeadManager__c`, `Spanish_Speaker__c` (the consent fields and `Skip_on_Dialer__c` are already in `AI_Outreach`);
   - **Record types** (a non-administrator user only): Account "Person Account" and Opportunity "Homeowner Opportunity" visible, and set as that user's defaults, because a conversion uses the converting user's defaults. Readiness shows what they are.

   Record-type access and `LeadManager__c` edit go on `AI_Outreach_Fields` (in the org), never in the repo's `AI_Outreach`: a reference to an org-only field or record type fails the whole deploy.

4. **Let reps see the field.** Setup → Object Manager → Lead (and Opportunity) → **AI Last Call Changes** → Set Field-Level Security: visible (read-only) for the Sales, Sales Manager and Wholesale profiles. Add it to the page layouts **in Setup**, never from the repo.

5. **The connected user must see the appointment owner's calendar.** Run as that user:

   ```sql
   SELECT COUNT() FROM Event WHERE OwnerId = '0058X00000Fsx39QAB' AND StartDateTime = NEXT_N_DAYS:7
   ```

   It must match what Grant sees. "View All Data", or the System Administrator profile, covers it; otherwise the offered times may overlap private Events.

6. **The default appointment owner.** Set `AI_CALL_DEFAULT_SPECIALISTS=0058X00000Fsx39QAB` (Grant Golden) on outreach-api. The card shows "Appointments go to: Grant Golden"; an admin can change the list on the card (the first active person owns every AI-booked appointment).

7. **Readiness.** Settings → Connections → **AI calls** → "Salesforce write-back readiness" must say **Ready**, "Appointments go to: Grant Golden" and "Lead conversion: ready. New records will be Person Account / Homeowner Opportunity". Each problem is listed in words, for example "Lead · AI Last Call Changes: the connected Salesforce user can't edit it" or "Event: can't be created by the connected user". "Lead conversion: not ready (…)" names why (the SOAP API refused the connection, no Convert Leads permission, or Account/Contact/Opportunity not createable); until it is fixed, a Lead that books gets a calendar hold and a Task instead.

8. **Smoke checks as the connected user** (Developer Console signed in as that user, or `sf data query --target-org <alias> -q "<query>"` with one `--target-org` only: `_t2` is the deploy user, not the connected user). To get an alias for the connected user, run `sf org login web -a <alias> -r https://gghsd.my.salesforce.com` and sign in **as the connected user** (the user outreach-web's Salesforce connection uses, shown on Settings → Connections); `sf org list` then shows the alias with that username:
   - `SELECT Id, Body FROM FeedItem WHERE ParentId = '<an Opportunity id>' AND Type = 'TextPost' LIMIT 5` runs (the Chatter step looks for its own earlier post this way; if the user cannot run it, every Chatter step retries and fails);
   - post a test FeedItem on a **test Lead you own** (this is production: never a prospect's or another rep's Lead) whose first line starts `AI call test1234 ·`, and confirm the org's Lead FeedItem trigger keeps that **first line** intact (a real post starts with `AI call <8 characters of the call id> ·`, which is how a retry finds it). Then **delete the test post** from the Lead's Chatter feed;
   - on a Person Account, the connected user can edit **Do Not Call** (`PersonDoNotCall`; field-level security follows `Contact.DoNotCall`). A refusal is recorded as "Not written", never silent.

9. **Then check with practice calls** on a real Opportunity and a real Lead before any live campaign (`ai-voice.md` §16). They never write to Salesforce.

### Lead conversion

When a real call on a **Lead** books a time that still stands, the write-back converts the Lead the way the team does, exactly once (it reads `IsConverted` first, and saves the new ids the moment Salesforce answers):

- status: the org's converted Lead Status (Qualified);
- a new Person Account and Contact, and an Opportunity named after the Lead, owned by the appointment owner (Grant), with no notification email;
- Lead Manager: the Lead's prior owner when that is an active user, else Grant;
- the consent fields (`AI_Call_Consent__c`, `AI_Call_Consent_Date__c`, `AI_Call_Consent_Source__c`), `Spanish_Speaker__c` and `Skip_on_Dialer__c` copied from the Lead, exactly, only into blanks;
- then the Event on the new Opportunity, and Stage **Appointment Set** once the Event exists;
- a Lead a rep already converted is never converted again: the write-back writes to its Opportunity and says "Lead was already converted by <name>".

Turn conversion off on the card ("Convert a Lead that books an appointment"); every Lead booking then takes the fallback (a hold on Grant's calendar and a "convert and book" Task on the Lead).

**Optional, Setup only (spec decision 7):** add `AI_Call_Consent__c`, `AI_Call_Consent_Date__c`, `AI_Call_Consent_Source__c`, `Spanish_Speaker__c` and `Skip_on_Dialer__c` to Setup → Object Manager → Lead → Fields & Relationships → **Map Lead Fields**, so the team's own conversions carry them too.

### Write-back outcomes

The results table's **Salesforce** column shows the write-back's status; click it for what was written (changed old → new, kept, not written and why, created). **Converted to Opportunity** links to the new record.

| Status | Meaning |
|---|---|
| Pending | Queued, or waiting for its next try (backoff 1 m, 5 m, 30 m, 2 h, 6 h, 24 h; a non-booking call waits for the next UTC day when the AI budget is spent) |
| Writing | A tick is running it now |
| Done | Every step ran and nothing was refused (a value a rep changed since the call is kept, and listed as such) |
| Partial | It finished, but Salesforce refused something (a field, the Event, the conversion, the Task or the post); the error column names the first refusal. Not retried: fix by hand |
| Failed | Six transient errors in a row. An admin can **Retry** it |
| Skipped | Nothing to write: write-back is off for the tenant, a test or practice call, the record was deleted, or a hang-up with nothing learned |

- **AI Last Call Changes** (on the Lead or Opportunity) is rewritten after each AI call: a header line (time, outcome, call id), then **Changed** (old → new), **Not changed** (a Status or Stage move the plan left alone, with why: not editable, not in the org's picklist, changed since the AI's research, or not from a usual starting value), **Not changed — changed in Salesforce since the call** (someone, a rep or a flow, changed it after the call, so it is kept; a field shown "held: Stage was changed" was left because its Stage or Status moved), **Kept** (a rep's value kept over the seller's answer), **Not written** (with why) and **Created** (the conversion, the Event, the Task).
- **The Chatter post** on the record written to (the new Opportunity after a conversion): `AI call <id> · <date> · <outcome>`, what was booked, the summary (links removed), what the seller said, what changed, and **Call details**: a link to the campaign page with `?call=<AI call id>`, which opens that call on the results with its transcript and write-back.
- **Retry** (admins, failed rows only): the results row → **Failed** → **Retry**. Finished steps are kept, so nothing is done twice; a retry reads `IsConverted` first and never converts twice.
- **Turning write-back off** for a tenant: untick "Write call results back to Salesforce" on the AI calls card (`aiCallWriteback: false`). Calls counted from then on, and rows already queued or waiting to retry, are recorded `skipped` ("write-back is off") at their next tick without any Salesforce call.

### Troubleshooting

- **`Partial` with "Status: Salesforce refused" on a queue-owned Lead** is expected: the org's `Deny_Status_Change_While_Still_Queue` rule. The rest of the write-back went through.
- **A conflict Task** ("… but the calendar was taken: call the seller to set a time") means the time was taken between the call and the write. The Opportunity moves to Followup instead of Appointment Set.
- **A refused Event:** read `last_error` (the row's error) for Salesforce's code; the Task step asks the owner to set a time.
- **"Lead not converted" with a hold and a "convert and book" Task** means Salesforce refused the conversion. Common causes: `Hunt_Winner_Owner_Change` on a Hunt-queue Lead, `Spam_Status_Lock`, a missing Convert Leads permission, or the SOAP API unavailable to the user. `last_error` has the code. The row ends `partial` (not retried): convert the Lead by hand, book the time the Task names, then delete the hold. A row that ended `failed` (transient errors used up) can be retried; the retry reads `IsConverted` first, so it never converts twice.
- **The booked time passed before the write** (a late retry whose run starts at or after the slot's **start** time): no Event or conversion is made; the owner gets "Appointment time passed before it could be saved — call the seller to re-book". If an earlier attempt had already put a hold on the owner's calendar for that time, the Task and AI Last Call Changes name it ("the time passed: delete it"): delete that hold by hand.
- **A converted Lead whose Opportunity is not owned by Grant:** a flow changed the owner after conversion. The Event is still Grant's.
- **Every Chatter step fails:** the connected user cannot query FeedItem (Setup step 8).
- **Read a row by hand:**

  ```bash
  echo "SELECT status, attempts, last_error, sf_event_id, converted_opportunity_id, steps FROM ai_call_writebacks WHERE org_id = :'org' AND ai_call_id = :'call';" | psql "$PUB" -v org='<org uuid>' -v call='<ai call id>'
  ```

### Deploy order

1. **Salesforce first** (Setup steps 1–5): the three files with `RunSpecifiedTests PowerDialRelayTest`, `AI_Outreach` assigned to the connected user, Edit in `AI_Outreach_Fields` (including Opportunity `LeadManager__c` and `Spanish_Speaker__c`), reps' read field-level security in Setup.
2. **Variables** on outreach-api: `AI_CALL_DEFAULT_SPECIALISTS=0058X00000Fsx39QAB`. `WRITEBACK_MODEL` is optional (default `claude-sonnet-5-5`); any other value must be priced in `services/outreach-api/src/ai/model.ts`, or the write-back runs without the answer mapping.
3. **Migrations** `0055_ai_call_booking.sql`, `0056_ai_call_writebacks.sql` and `0057_ai_call_writeback_indexes.sql` (indexes only) run in the pre-deploy migrate of whichever service deploys first (production is at 0054, `0054_dialer_stop_reason.sql`, once the dialer idle-cutoff release is deployed). 0055 must be in place before the new `@cti/api` runs.
4. **Deploy `@cti/api` and outreach-api from the same merge,** `@cti/api` first or together. A trigger with slots that reaches an old `@cti/api` gets a 400 and is retried with the same key, so the window is safe.
5. **Check** `/healthz` on both, then Settings → Connections → AI calls: Ready, "Appointments go to: Grant Golden", "Lead conversion: ready" with Person Account / Homeowner Opportunity.
6. **Practice calls:** one on a real Opportunity and one on a real Lead, to your own test number. Listen for the "we spoke back in …" opener, book a phone time with Grant, and confirm nothing appears in Salesforce (no Event, no conversion, no field change).
7. **A one-lead live campaign on a Lead** you own (conversion is the riskiest path; pick a Lead the team would convert anyway). After the call, check: the Lead converted (Qualified), one new Person Account, Contact and Opportunity named after the Lead, owned by Grant, Lead Manager = the Lead's prior owner; the Event on Grant's calendar on the new Opportunity, and the org's confirmation Task made by its own flow; Stage Appointment Set; consent copied; the AI Last Call Changes text; the Chatter post on the Opportunity; the write-back `Done` on the results. Then one on an Opportunity.

