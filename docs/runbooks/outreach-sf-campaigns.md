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
8. **Watch the AI calls card** under the board (results table: Lead, Status, Outcome, Summary, When; **Transcript** for the record owner or an admin).

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
- **Retried refusals** wait before the next try: calling hours, until the window opens; daily state cap or per-customer ceiling, about 12 hours and then the window; no AI caller ID or AI calling switched off, 30 minutes; another call to them in progress, 10 minutes; the phone carrier refused the call (`twilio_error`), as after no answer (at least 20 hours, in the next calling window), because the carrier may already have rung them; any other, 5 minutes doubling to 2 hours. The same request key is kept for an in-flight or transport retry, and those wait at least 10 minutes. If cti-api answers 409 (`idempotency_conflict`), the key is dropped and the retry goes once with a new key, at least 10 minutes later. A trigger whose tick died (a `dialing` touch with no call after 5 minutes) is tried again with the same key no sooner than 10 minutes after it was claimed; if its lead has ended meanwhile, the touch is skipped (`enrollment_ended`) instead. A claim the pacer could not make (the lead changed since it was queued) waits 15 minutes. If the lead is no longer queued, the touch is skipped (`not_claimable`) so "Call all approved" can queue it again. After 8 refusals in a row the touch is skipped too, and a lead still queued goes back to approved. After 8 attempts the lead exits "gave up after repeated errors". Only attempts about the person count. A refusal about the system never uses an attempt and never ends the lead: AI calling switched off, no AI caller ID free, a Salesforce or compliance-check error in cti-api, or no answer from cti-api. While cti-api says AI calling is off, or does not answer, the pacer claims nothing at all.
- **New Salesforce activity.** If a Task or Event on the record is newer than the research, the call is not placed: the lead goes back to research and the card says "New activity in Salesforce since the research: researching again before any call." A rep's call Task between attempts does the same, by design. Tasks the AI's own calls logged are ignored.
- **Salesforce checkboxes** Do Not Call and Skip on Dialer stop the call (shown as "Do Not Call is checked in Salesforce" / "Skip on Dialer is checked in Salesforce"). The AI call consent checkbox is read fresh too: unchecked or empty, the lead ends with "no AI consent in Salesforce" (`ai_call_no_consent`) without a trigger.
- **A plan the voice agent refuses, or an approver who cannot place AI calls** (`plan_rejected`, `unknown_user`): the lead goes back to the review board with an error on its card. It is not ended: edit the plan and approve it again (or have someone who can place AI calls approve it).

### What each outcome does

| Call outcome (words in the results table) | What happens to the lead |
|---|---|
| Transferred to a person, Callback booked, Transfer missed — call them back | Handed off to the rep (the enrollment ends as `handed_off`) |
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
| their state's daily call limit was reached | `daily_cap` | retried |
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

- **`result: retry:idempotency_conflict`.** cti-api answered 409: the same request key arrived with a different body, for example when the plan text or target changed while the key was kept. The pacer drops the key and retries once with a new one, at least 10 minutes later; that attempt counts. Check `ai_call_requests` for the old key (below).
- **`ai_call.place: cti-api says AI calling is off, or did not answer; nothing is placed this tick`** (`availability: off` or `unreachable`). The kill switch is on, `OPENAI_API_KEY` is unset on `@cti/api`, or cti-api is down or unreachable. Nothing is claimed and no lead uses an attempt.
- **Every call ends `retry:salesforce_error`.** Check that `TOKEN_ENCRYPTION_KEY` is identical on `@cti/api` and outreach-api ("How outreach-api is deployed"), and that the tenant's Salesforce connection still works.

**A touch waiting after transport errors ("the AI calling service did not answer") may already have placed a call.** The request can reach cti-api even when its answer is lost, and outreach-api has no read-only way to ask cti-api about a request key. The pacer's retry reuses the key, so it never dials twice. Before calling the person by hand, check `ai_calls` by trigger key: the key is `touch:<touch id>:<attempt>:<claim time in ms>`, and cti-api stores it in `ai_call_requests.idempotency_key` with the call it placed in `ai_call_id`:

```bash
echo "SELECT idempotency_key, ai_call_id, response, created_at FROM ai_call_requests WHERE org_id = :'org' AND idempotency_key LIKE :'key';" | psql "$PUB" -v org='<org uuid>' -v key='touch:<touch id>:%'
```

### Stopping everything

- **Pause the campaign** (the **Pause** button): planned calls wait and nothing new is claimed. This is the normal way to stop a campaign.
- **The AI voice kill switch:** `AI_VOICE=off` on `@cti/api`. It pauses AI calls without using up any lead's attempts. While it is off the pacer claims nothing and logs `ai_call.place: cti-api says AI calling is off, or did not answer; nothing is placed this tick`. When it is back on, the waiting calls go out in their next calling window. `OUTREACH_KILL_SWITCH=on` stops all outreach, including AI calls, the same way.
