# AI voice calls — operator runbook

**First call checklist** (the minimum to hear the AI on your own phone):

1. On Railway service `@cti/api`, set `OPENAI_API_KEY` and `AI_VOICE_TEST_NUMBERS=<your mobile, E.164>` (§3).

   1b. On both `@cti/api` and `outreach-api`, set `OUTREACH_INTERNAL_SECRET` to the same 32+ character random value, and on `outreach-api` set `CTI_INTERNAL_URL` (§3).
2. Push the branch to `main` (the default branch `@cti/api` deploys from).
3. Wait for the `@cti/api` deploy to show **Success** (dashboard → `@cti/api` → Deployments). It also serves the softphone.
4. Confirm the migration applied. `$PUB` is a live credential: never print or share it:

   ```bash
   PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
   ```

   ```bash
   echo "SELECT filename FROM cti_schema_migrations WHERE filename = '0050_ai_calls.sql';" | psql "$PUB"
   ```

   Expected: one row, `0050_ai_calls.sql`. Zero rows means the pre-deploy migration did not run: check the deploy log before placing any call.
5. **Give the AI its own number** (the AI never dials from a rep's number, the power dialer's pool, or `TWILIO_DEFAULT_CALLER_ID`; with no AI number every AI call is refused `no_caller_id`). Full steps and fallbacks in §5 "Pre-flight: the AI's caller ID":
   1. Twilio Console → **Phone Numbers → Buy a number**. Set its **Friendly Name** to contain `(ai_pool)`, for example `AI calls (ai_pool)`. Point its Voice webhook ("A call comes in", HTTP POST) at the same URL as the other CTI numbers, `<API_PUBLIC_URL>/telephony/twilio/inbound`, and its Messaging webhook at `<API_PUBLIC_URL>/telephony/twilio/sms` (open any existing CTI number in the Twilio Console to copy them; step 2 also sets both). Done on 2026-10-05: `+16197244374`, Friendly Name `AI calls (ai_pool)`, webhooks set.
   2. **Only once steps 3 and 4 show the deploy and migration live:** softphone as an **admin** → bottom bar **More** → **Numbers** → **Import from Twilio**. The number appears under **AI calls** because of its Twilio name.
   3. Run the pre-flight query in §5 and expect one `ai_pool` row.
6. Open **outreach-web** (the outreach-api URL) as an **admin** → **Settings → Connections** → **Test call to my phone** → pick your number → **Test call to my phone**.
7. Answer. The first sentence must say it is an AI assistant on a recorded line. No Salesforce record or consent tick is needed for a test call.

Everything here is a human step. The design is `docs/superpowers/plans/2026-10-05-ai-voice-calls.md`; the code is `services/cti-api/src/ai-voice/`.

## 1. What it does

AI calls start only from **outreach-web**:

- an admin builds an **AI call campaign** from a Salesforce query or list view and ticks the leads;
- the AI researches each lead's whole record, related records, activity and Chatter, and drafts a call plan;
- the record owner or an admin approves each plan;
- an admin presses **Call all approved**.

outreach-api then asks `@cti/api` (this service) to place each call, paced and with every safety gate below applied at the moment of the call. The CTI softphone no longer has an AI call button or an AI calls tab. Test calls are in outreach-web (Settings → Connections → **Test call to my phone**). The code accepts Contacts, but the consent field is deployed only on Lead and Opportunity, so a Contact is refused with `consent_field_missing`. An AI voice agent phones the person over Twilio, talks to them through OpenAI's Realtime API, and:

- **Opens by saying it is an AI assistant** calling for the company, on a recorded line (the text transcript is kept). If anyone asks, it says it is an AI. It never claims to be human.
- **Qualifies** the seller: motivation, timeline, condition, price expectations, decision makers, occupancy. It **never makes an offer or names a price.**
- **Transfers to a person** if the seller wants one or is qualified: the call rings the record owner's softphone (or the person who approved the plan if the owner is not mapped).
- **Honours "stop calling me"** immediately: it writes the number to the shared opt-out list, says goodbye, and hangs up. The CTI dialer respects the same list. On a **test or practice call** (your own phone, §5 and §16) it says goodbye, hangs up and records `do_not_call`, but never opts your test number out.
- **Books an appointment** (plan 1D) when the trigger offers times: a phone call or a walkthrough with the appointment owner (§15).
- **Leaves a voicemail** if a machine answers, and promises a callback if no person picks up the transfer within 25 seconds.
- Stores the text transcript, a summary, the qualification answers and the outcome. **No call audio is stored.**

**Who can do what.** Admins create campaigns, press **Call all approved** and run test calls. The record owner or an admin approves a plan. Reps do not start AI calls; they receive the transfers.

**Hard rules the code enforces on every call:**

- No AI call without the **AI Call Consent** checkbox ticked on the Salesforce record. The one exception is an admin calling a number listed in `AI_VOICE_TEST_NUMBERS` (your own phones).
- Every call, test or not, also passes: `AI_VOICE=on`, `OUTREACH_KILL_SWITCH` not `on`, not opted out, not blocked, not on the federal DNC list, the FL/OK/WA/MD daily cap, the per-customer call ceiling, and the recipient's local calling hours 08:00 to 21:00. Test numbers skip the calling-hours check only.

## 2. Prerequisites

1. **OpenAI API key with Realtime access.** Realtime is a standard API feature, no waitlist.
   - Go to platform.openai.com, sign in, **Settings → Billing**: add a payment method and a small credit balance (start with $20).
   - Go to platform.openai.com → **API keys → Create new secret key**. Name it `cti-ai-voice`. Copy it once; OpenAI never shows it again.
   - **Never paste the key in chat, a commit, or a log line.**
2. **Anthropic API key (optional).** Only used for the post-call summary. Without it the summary is the agent's own closing note, or else a plain line such as "AI call — No answer". Create one at console.anthropic.com → API keys if you want better summaries.
3. **The consent fields and the rep permission set deployed to Salesforce** (§4). Without them every non-test AI call is refused with `consent_field_missing`.
4. **`API_PUBLIC_URL` on `@cti/api` is already set** to its public `https://` URL (the dialer uses it). The AI call's audio stream connects back to it over `wss://`, so it must be correct.
5. **Your own mobile number in E.164 form**, for example `+15125550100`, for the smoke test.

## 3. Railway variables

Set on service `@cti/api`, except `OUTREACH_INTERNAL_SECRET`, which `outreach-api` also holds (below), and the outreach-api variables in `outreach-sf-campaigns.md`. Link the CLI first if you have not:

```bash
railway link
```

Pick project `endearing-comfort`. Setting a variable on a linked service redeploys it; if no deploy starts, use dashboard **@cti/api → Deployments → ⋯ on the latest deployment → Redeploy**. Migration `0050_ai_calls.sql` runs in the pre-deploy step; expect the deploy log to show it applied.

| Variable | Value to set | Unset means |
|---|---|---|
| `OPENAI_API_KEY` | the key from §2.1 (secret) | **AI voice is switched off** (`available: false`, no AI call is placed or answered) |
| `AI_VOICE` | `on` or `off` | `on`. `off` is the kill switch (§9). Only `on` / `off` are accepted; `true`, `1`, `false` stop the service booting |
| `AI_VOICE_TEST_NUMBERS` | your mobile(s), E.164, comma-separated: `+15125550100,+15125550101` | no test numbers; the **Test call to my phone** card in outreach-web says "No test numbers are set" |
| `AI_VOICE_VOICE` | `marin` | `marin` |
| `AI_VOICE_MODEL` | `gpt-realtime-2.1` | `gpt-realtime-2.1` |
| `AI_VOICE_REASONING` | `minimal`, `low`, `medium` or `high` | `low`. Only sent for `gpt-realtime-2*` models |
| `AI_VOICE_VAD_EAGERNESS` | `low`, `medium`, `high` or `auto` | `auto` |
| `AI_VOICE_AGENT_NAME` | the first name the agent gives, for example `Alex` | `Alex` |
| `AI_VOICE_MAX_CALL_SECONDS` | hard cap on one call, in seconds | `600` (10 minutes) |
| `ANTHROPIC_API_KEY` | optional key from §2.2 (secret) | summaries use the plain fallback |
| `AI_SUMMARY_MODEL` | model for summaries | `claude-haiku-4-5-20251001` |
| `OUTREACH_KILL_SWITCH` | leave unset (or `off`) | `off`. `on` stops all outreach including AI calls |
| `OUTREACH_INTERNAL_SECRET` | the same 32+ character secret as on outreach-api (secret) | the internal AI call routes do not exist as far as outreach-api can tell (404 in production, 503 `internal_disabled` elsewhere) and no campaign call or test call can be placed |

`@cti/api` now listens on `::` (IPv4 and IPv6) so outreach-api reaches it over Railway private networking at `http://ctiapi.railway.internal:<API_PORT>` (`http://ctiapi.railway.internal:4000` here). Set that URL as `CTI_INTERNAL_URL` on outreach-api; it must be an origin only (no path).

Set the required two now (replace the placeholders; do not echo the real key anywhere), then the shared secret below:

```bash
railway variables --set "OPENAI_API_KEY=sk-..." --service @cti/api
```

```bash
railway variables --set "AI_VOICE_TEST_NUMBERS=+15125550100" --service @cti/api
```

Generate the shared secret once and set it on both services without printing it (`railway variables --set` redeploys each service):

```bash
SECRET=$(openssl rand -hex 32)
railway variables --set "OUTREACH_INTERNAL_SECRET=$SECRET" --service @cti/api
railway variables --set "OUTREACH_INTERNAL_SECRET=$SECRET" --service outreach-api
railway variables --set "CTI_INTERNAL_URL=http://ctiapi.railway.internal:4000" --service outreach-api
unset SECRET
```

Confirm the names landed (this prints names and values, so do not share the output):

```bash
railway variables --service @cti/api --kv | grep -E '^(AI_VOICE|OPENAI_API_KEY)' | cut -d= -f1
```

Expected: `OPENAI_API_KEY`, `AI_VOICE_TEST_NUMBERS` (plus any other `AI_VOICE*` you set). `OUTREACH_INTERNAL_SECRET` is not matched by that pattern; check it with `grep -E '^OUTREACH_INTERNAL_SECRET' | cut -d= -f1` on each service.

**Talk in browser (§18) uses the softphone's Twilio variables.** `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` on `@cti/api` already exist for the cti-web softphone; the browser test mints its own Voice token from the same API key. No TwiML App is used (the token can only receive calls) and no new variable is added. Confirm the three names (this prints names only):

```bash
railway variables --service @cti/api --kv | grep -E '^TWILIO_(ACCOUNT_SID|API_KEY_SID|API_KEY_SECRET)=' | cut -d= -f1
```

Expected: all three names. With one missing, availability reports `browserCalls: false` and the page hides **Talk in browser**; **Ring my phone** still works.

Then confirm the deploy is healthy: Railway dashboard → `@cti/api` → **Deployments** → the latest deployment shows **Success**. Open its **Deploy Logs** and search for `Invalid environment configuration`.

Expected: no such line. If you see one, a value is outside the accepted set in the table; fix it and the service redeploys.

## 4. Salesforce: consent fields and rep access

The org is alias `_t2` (`gghsd.my.salesforce.com`). **It is PRODUCTION.** Read `salesforce/README.md` first: never deploy with `-d force-app` or `-d force-app/main/default`, because that pushes stale `layouts/` snapshots over the live page layouts. Name the exact files, as below. Run from the repo root.

> If you already ran `docs/runbooks/outreach-sf-campaigns.md` §0, the six field files are already in the org and show `Unchanged` below. **Step 2 is still required:** it creates the `AI_Call_Consent_Access` permission set. Never skip it.

1. **Validate first** (check-only, changes nothing). Expect `Status: Succeeded`:

   ```bash
   cd salesforce && sf project deploy validate -o _t2 --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml --source-dir force-app/main/default/permissionsets/AI_Call_Consent_Access.permissionset-meta.xml
   ```

2. **Deploy the same seven files.** Expect `Status: Succeeded` and seven `Created` rows (`Unchanged` on a rerun):

   ```bash
   cd salesforce && sf project deploy start -o _t2 --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml --source-dir force-app/main/default/permissionsets/AI_Call_Consent_Access.permissionset-meta.xml
   ```

3. **Assign `AI_Call_Consent_Access` to reps who need to see or tick the consent box.** Campaign calls read `AI_Call_Consent__c` with the tenant's **Integration user** (the `AI_Outreach` permission set, `outreach-sf-campaigns.md` §0), not with a rep's login, so this set is no longer needed to start a call. One command per rep; replace the placeholder with the rep's Salesforce username:

   ```bash
   sf org assign permset -n AI_Call_Consent_Access -o _t2 -b rep@example.com
   ```

   You can repeat `-b <username>` in one command to cover several reps. Alternative in the browser: Setup → Permission Sets → **AI Call Consent Access** → **Manage Assignments** → **Add Assignments**.

4. **Check.** On any Lead, Setup → Object Manager → Lead → Fields shows `AI Call Consent`, `AI Call Consent Date` and `AI Call Consent Source`.

5. **Optional, in Setup only:** show the three fields on the Lead and Opportunity page layouts so reps can see and tick them. **Do not deploy layouts from the repo** (`salesforce/README.md`).

The consent source picklist (`Text Reply`, `Email Reply`, `Web Form`, `Inbound Call`, `Rep`) is written by code. Do not rename its values. A rep who ticks the box themselves should set the source to `Rep`.

## 5. Morning smoke test (about 15 minutes)

Do this on your own mobile before any real prospect. A test call needs no Salesforce record and no consent tick. Only an admin can place one, from outreach-web, and only to a number in `AI_VOICE_TEST_NUMBERS`.

**Test calls count like real dials.** A placed test call counts toward the per-customer ceiling (when the number belongs to a campaign) and, for a Florida, Oklahoma, Washington or Maryland area code, the 3-calls-per-24-hours state cap. Repeating the smoke test to one number on the same day can therefore be refused with `customer_ceiling` or `daily_cap`. Use a second test number (add it to `AI_VOICE_TEST_NUMBERS`) or wait a day.

**Pre-flight: the AI's caller ID (5 minutes, before step 1).** Every AI call, test or real, dials out from one of the AI's **own** numbers: `outbound_numbers.kind = 'ai_pool'`, shown as **AI calls** on the Numbers screen. The AI never uses a rep's number, the power dialer's pool, or `TWILIO_DEFAULT_CALLER_ID`, and reps' click-to-dial and the power dialer never use an AI number. With no active, healthy AI number under its daily warmup limit, the call is refused `no_caller_id` ("No AI caller-ID number is set up. Add a number to the AI pool (runbook §5)."). A brand-new number may place 20 calls a day in its first week (40 in week 2, 70 in week 3, 80 after), so test calls are fine; for volume, add more AI numbers the same way.

**Adding an AI number:**

1. **Twilio Console → Phone Numbers → Manage → Buy a number.** Pick a local number. In its configuration set **Friendly Name** to something containing `(ai_pool)` (any case), for example `AI calls (ai_pool)`. Set **Voice → A call comes in → Webhook, HTTP POST** to the same URL as the other CTI numbers: `<API_PUBLIC_URL>/telephony/twilio/inbound` (copy it from any existing CTI number's configuration page; `API_PUBLIC_URL` is the `@cti/api` variable). Set **Messaging → A message comes in** to `<API_PUBLIC_URL>/telephony/twilio/sms`. Save. (The import in step 2 also re-points both webhooks, so a missed webhook is repaired there.)
2. **Wait until the deploy with migration `0050_ai_calls.sql` is live** (first call checklist step 4). Then softphone as an **admin** → bottom bar **More** → **Numbers** → **Import from Twilio**. A number that is NEW to the CTI and whose Twilio Friendly Name contains `(ai_pool)` is filed as an AI number and shows in the **AI calls** group at the bottom of the list.
   - **Do not import it before that deploy.** The old code files every imported number as an ordinary rep number in the reserve, and a rep signing in can be handed reserve numbers in the 619 / 858 / 213 / 323 area codes automatically.
   - The import **never changes the kind of a number the CTI already has.** If the number was imported earlier, it stays a rep number: move it with the fallback below.
3. **Check** (get `$PUB` as in the first call checklist, then your org id: one line per org, pick yours):

   ```bash
   echo "SELECT id, name FROM organizations;" | psql "$PUB"
   ```

   ```bash
   echo "SELECT e164, kind, assigned_user_id, active, health FROM outbound_numbers WHERE org_id = :'org' AND kind = 'ai_pool';" | psql "$PUB" -v org='<org uuid>'
   ```

   Expected: one row per AI number, `kind` `ai_pool`, `assigned_user_id` empty, `active` `t`, `health` not `degraded` / `spam_likely`. Zero rows means no AI call can be placed.

**Fallback if the number is in the CTI but not under AI calls** (imported before the deploy, or the Twilio name lacks `(ai_pool)`):

- **In the softphone:** More → **Numbers** → find the number's row → in its dropdown pick **AI calls**. That files it as `ai_pool` and removes any rep assignment. (Or **Add** → type the number → pick **AI calls (the AI's own caller ID)** → **Add number**, for a number the CTI does not have yet.)
- **Or SQL** (replace the org id and number; it only moves that one number, and only after migration 0050 is applied):

  ```bash
  echo "UPDATE outbound_numbers SET kind = 'ai_pool', assigned_user_id = NULL WHERE org_id = :'org' AND e164 = :'num' RETURNING e164, kind, assigned_user_id;" | psql "$PUB" -v org='<org uuid>' -v num='+16197244374'
  ```

  Expected: exactly one row, `ai_pool`, empty `assigned_user_id`. Zero rows means the number is not in the CTI yet: import or add it first.

If an AI number had been assigned to a rep before you moved it, that rep's click-to-dial stops using it at once (reps never dial from `ai_pool`).

1. Confirm §3 is done and the deploy is healthy. `AI_VOICE_TEST_NUMBERS` must contain your mobile, and `OUTREACH_INTERNAL_SECRET` and `CTI_INTERNAL_URL` must be set on outreach-api.
2. Open the CTI softphone and sign in as the **same user** as outreach-web (both sign in with Salesforce). Keep it open and allow the microphone: the transfer rings the person who started the test call, which is you.
3. Open outreach-web as an **admin** → **Settings → Connections**. The **Test call to my phone** card has a **Test number** list (one entry per number in `AI_VOICE_TEST_NUMBERS`, shown as E.164, for example `+15125550100`) and a **Test call to my phone** button.
   - No card at all: you are not an admin, or AI calling is off (recheck `OPENAI_API_KEY`, `AI_VOICE=on` and that `OUTREACH_KILL_SWITCH` is not `on`), or outreach-api has no `CTI_INTERNAL_URL` / `OUTREACH_INTERNAL_SECRET`. The card also stays hidden while it loads.
   - A red line "The AI calling service did not answer. Try again in a minute.": outreach-api cannot reach `@cti/api` (§11).
   - "No test numbers are set. Add yours to AI_VOICE_TEST_NUMBERS on the CTI API service.": set `AI_VOICE_TEST_NUMBERS` (§3).
4. Pick your number and press **Test call to my phone**. Expect the line "Calling now. Pick up to hear the agent." No row appears anywhere in outreach-web (a test call has no campaign); read it in SQL in step 10. Your phone should ring within a few seconds; the caller ID is the AI's own number (an **AI calls** number, for example `+1 (619) 724-4374`), never a rep's. A refusal shows "Not called: " and the reason in plain words, for example "Not called: they opted out of calls".
5. **Answer and listen.** The first thing the agent says must be that it is an AI assistant calling for the company, on a recorded line. Fail the test if it does not say so.
6. **Talk to it** for a minute as a seller. Say you might sell, the house needs work, and you want about a certain amount. It should ask follow-up questions and must not name a price or make an offer.
7. **Test the transfer:** say "Can I talk to a real person?" Your phone should go quiet and the softphone you have open should ring as an incoming call; under the name and number the ring screen shows **"AI transfer — asked for a person"**. Answer it in the softphone and confirm audio both ways, then hang up. (The call goes to the person who started it, because a test call has no record owner.)
8. **Test the do-not-call goodbye:** start a second test call, answer, and say "Stop calling me." The agent should apologise, say a short goodbye and hang up within a few seconds. The call is recorded `do_not_call`, but **your test number is not opted out** (plan 1D: a test or practice call rings an admin's own phone, so it never suppresses it). Start a **third** test call from the card: it must be placed and ring as usual. The opt-out write itself is proved on a real call (§6 step 9) and by the automated tests; a real call's "stop calling me" always writes the opt-out.
9. **Only if your test number was opted out** (by a test call before plan 1D, by a real call to it, or by hand), delete that opt-out so it can be called again; otherwise skip this step. Get the public database URL first. `$PUB` is a live credential: never print or share it:

   ```bash
   PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
   ```

   Find your organization's id (one line per org; pick yours):

   ```bash
   echo "SELECT id, name FROM organizations;" | psql "$PUB"
   ```

   Then delete only the AI-call opt-out for your number in your org. Replace `<org uuid>` with that id and `+15125550100` with your mobile:

   ```bash
   echo "DELETE FROM opt_outs WHERE org_id = :'org' AND e164 = :'num' AND source = 'ai_call' RETURNING id, org_id, e164, source, created_at;" | psql "$PUB" -v org='<org uuid>' -v num='+15125550100'
   ```

   Expected: one row returned when it was opted out by an AI call; zero rows when it never was (nothing to clear), or when its opt-out came from another source, which this delete leaves alone. Never run the delete without the `org_id` and `source = 'ai_call'` guards, or you could remove a real opt-out.

10. Read the three calls in SQL (`$PUB` as above), because test calls have no campaign row in outreach-web:

    ```bash
    echo "SELECT status, outcome, summary FROM ai_calls WHERE is_test ORDER BY created_at DESC LIMIT 3;" | psql "$PUB"
    ```

    Newest first: the third call is placed (`completed` once you hang up) and the second is `do_not_call`. Smoke test passes when: disclosure heard, no price named, transfer rang the softphone, "stop calling me" ended the call as `do_not_call`, and the third call still rang your phone.

## 6. A real, consent-gated call (from a campaign)

1. In Salesforce, open a **Lead you own** whose phone number is one you are happy to call (a colleague or your own second number is best the first time). An Opportunity works the same way.
2. Tick **AI Call Consent** on it. Set **AI Call Consent Source** to `Rep`. Save.
3. Create an AI call campaign in outreach-web (runbook `outreach-sf-campaigns.md` §AI call campaigns), with a list view or query that includes that lead.
4. Tick that one lead.
5. Press **Start dry run**. A draft campaign is not refreshed, so nothing is researched until then. The lead is enrolled at the next refresh (every 5 minutes) and its plan is drafted within about a minute after that.
6. Approve the plan (the record owner or an admin).
7. **Activate** the campaign (the **Go live** button, then confirm).
8. Press **Call all approved**.
9. **Prove the opt-out on this real call** (only on the colleague's or your own second number from step 1, never a prospect). Answer the AI's call and say "Stop calling me." The agent should apologise, say a short goodbye and hang up. Then check the opt-out was written for that number (`$PUB` and your org id as in §5 step 9; replace `+15125550100` with the number the AI called):

   ```bash
   echo "SELECT id, e164, source, created_at FROM opt_outs WHERE org_id = :'org' AND e164 = :'num' AND source = 'ai_call';" | psql "$PUB" -v org='<org uuid>' -v num='+15125550100'
   ```

   Expected: exactly one row, `source` `ai_call`, created a moment ago. Zero rows means the opt-out was not written: stop and do not call prospects until it is fixed. If that number should stay callable (it is your own or a colleague's), clear the row with the delete in §5 step 9, using the same org id and number; the call itself stays recorded as `do_not_call`.

If a call is refused, the reason shows on the campaign's results table as "Not called: …", in plain words. Some refusals are retried automatically (`calling_hours`, `daily_cap`, `customer_ceiling`, `no_caller_id`, `ai_voice_unavailable`, `call_in_progress`); the rest are final for that lead (`outreach-sf-campaigns.md` §AI call campaigns). The reason codes:

| Reason code | What it means and what to do |
|---|---|
| `no_consent` | **AI Call Consent** is unticked on that record. Tick it only if the person really agreed |
| `consent_field_missing` | The consent fields are not deployed in Salesforce, or the Integration user cannot read them: deploy them (§4) and assign `AI_Outreach` to the Integration user (`outreach-sf-campaigns.md` §0) |
| `ai_voice_unavailable` | Kill switch is on or `OPENAI_API_KEY` is unset (§3, §9) |
| `no_phone` / `invalid_number` | The record has no usable phone number |
| `opted_out` / `blocked` / `dnc` | The number is on the opt-out, blocked, or federal do-not-call list. Do not override |
| `daily_cap` / `customer_ceiling` | A daily state cap or the per-customer call limit is reached. Test calls count too (§5) |
| `calling_hours` | Outside 08:00 to 21:00 in the person's local time |
| `no_caller_id` | No AI number (`ai_pool`, the **AI calls** group on Numbers) is active, healthy and under today's limit. Add one or check it (§5 pre-flight). There is no fallback number |
| `not_admin_for_test` | Only admins can place test calls |
| `call_in_progress` | That number is already on a live AI call |

Errors between outreach-api and cti-api (signature, private network, secret unset) appear in outreach-api's logs as `ai_call.place` transport errors and the call is retried; see §11.

## 7. Where callers end up

- **Approver:** for a campaign call, the person who "started" the call is the user who **approved the plan**.
- **Transfer:** the call rings the **Salesforce record owner's** softphone if that owner has connected Salesforce in the CTI (so is mapped to a CTI user). Otherwise it rings the person who started the AI call. It rings through the normal incoming path: the caller ID is the prospect's number, the record screen-pops on Answer, and the ring screen shows **"AI transfer — "** followed by the reason, one of: interested, wants an offer, asked for a person, legal or complex question, has a question.
- **If nobody answers the transfer within 25 seconds,** the caller hears "Sorry, our specialist just stepped away — they'll call you right back. Thanks!" and the call ends. The outcome reads **Transfer missed — callback promised**, and the summary carries the line "Transfer to a specialist did not connect — call them back."
- **Callback Task (Salesforce):** a promised call back — a missed transfer, or a callback the person asked for (**Callback requested**) — gets an **Open** Task on the record for the hand-off person (the record owner), created with their own Salesforce login. If their Salesforce connection is gone, the starter creates it and assigns it to them (`OwnerId`); if neither works, it is the starter's own Task. Subject `AI call: callback requested` (missed transfer: dated today, and the description adds "The caller was promised a call back.") or `AI call: callback <when>` (asked-for callback: `<when>` is what the person said, or "Wed, Oct 7, 5:00 PM" in their time zone for an exact time; dated that day). If the org refuses the Open status, the Task is made Completed instead. Not for test calls, and only on records the Task's author may write to (§8).
- **The callback number** the agent gives the caller is the number it called from (the AI's own `ai_pool` number Twilio dialled out on). It is not given on emergencies, threats or abuse, do-not-call goodbyes, or after they hang up.
- **When they call that number back,** the CTI rings the softphone of the hand-off person of the newest AI call to them in the last 14 days (the record owner if mapped, else the admin who started it), preferring an AI call made from the very number they dialled. The ring screen shows their number as the caller. Unanswered, it rolls to that person's no-answer forward number if set, else voicemail. With no AI call to them in 14 days it goes to voicemail, like a callback to a power-dialer pool number. A text to an AI number reaches the same person.

## 8. Reading the results

- **outreach-web → the campaign → AI call results:** one row per call, with status, outcome, summary and qualification, and **Transcript** for the record owner or an admin. (The card is titled **AI calls** and sits under the call plans.) It refreshes every 15 seconds while a call is waiting, being placed or live.
- **Transcript:** **AI:** and **Caller:** lines in the database (outreach-web labels them **AI** and **Them**). Anything the agent was cut off from saying (for example by voicemail or a transfer) is shown in grey as `[not played] …`.
- **Status chips:** **Calling…**, **In progress**, **Transferring** are live; **Transferred**, **Completed**, **Failed**, **Blocked** are final. A finished call can still move from Completed to Transferred once, a few seconds later, when the transfer result arrives.
- **Outcome words:** Transferred to rep, Callback requested, Not interested, Do not call, Left voicemail, No answer, Busy, Failed, Wrong number, Hung up, Transfer missed — callback promised, Blocked, Other.
- **Summary:** a few seconds after the call ends, the agent's notes are replaced by 2–4 sentences (Claude when `ANTHROPIC_API_KEY` is set and the caller spoke), then any "Callback requested: …" / "Transfer to a specialist did not connect …" lines, a blank line, a **Qualification:** block (`- Motivation: …`, only what was captured), `Outcome: <words>` and `AI call id: <id>`.
- **Salesforce call Task:** after a real (non-test) call that was placed, ONE completed Call Task on the record, created as the plan's approver (with their CTI Salesforce connection; no connection = no call Task). Only when they may write on the record (the power dialer's rule: they own it, are the Opportunity's lead manager, or it is queue-owned). Subject `AI call: <outcome words>` (for example `AI call: Callback requested`), Call Result the matching disposition (Connected, Left voicemail, No answer, Busy, Wrong number, Do not call, Failed), description = the summary plus `Transcript in CTI: AI call <id>`. No call duration: AI talk time is not rep talk time. Test calls log no Task. A promised call back also gets the callback Task (§7).
- **Call history:** placed AI calls also appear in the starter's (for a campaign call, the approver's) own call history with the disposition already filled in (no wrap-up prompt) and 0 talk seconds. They count toward the daily state cap and the per-customer ceiling like any dial.
- **Qualification answers** are on the call row and in the summary: motivation, timeline, condition, occupancy, price expectation, decision makers, mortgage, other.

## 9. Kill switch

To stop all AI calls (new calls are refused as soon as the redeploy lands; a call already in progress ends when the service restarts):

```bash
railway variables --set "AI_VOICE=off" --service @cti/api
```

To bring them back:

```bash
railway variables --set "AI_VOICE=on" --service @cti/api
```

`AI_VOICE=off` only affects AI calls. `OUTREACH_KILL_SWITCH=on` is the global switch that also stops campaign outreach; it stops AI calls too. If a call is misbehaving right now, use the kill switch first and investigate after.

AI call campaigns are paused by either switch, without using up any lead's attempts. Once a minute outreach-api's pacer asks cti-api whether AI calling is on. While it is off, or cti-api does not answer, the pacer claims nothing and logs `ai_call.place: cti-api says AI calling is off, or did not answer; nothing is placed this tick`. A trigger that still gets `ai_voice_unavailable` (the switch flipped mid-tick) gives its attempt back. When the switch is back on, the waiting calls go out in their next calling window. To stop one campaign, pause it in outreach-web: that is the normal stop. The kill switch is for stopping every AI call at once.

## 10. Tuning

Set any of these with `railway variables --set "NAME=value" --service @cti/api`. Each change redeploys and applies to **new calls**.

- **Voice, `AI_VOICE_VOICE`:** `marin` (default) or `cedar` are OpenAI's highest-quality voices. Other OpenAI realtime voices (for example `alloy`, `ash`, `coral`, `sage`, `verse`) also work. Try two on your own phone with **Test call to my phone** and pick one.
- **Model, `AI_VOICE_MODEL`:** default `gpt-realtime-2.1`. A cheaper "mini" realtime model costs roughly a third as much with some loss in quality. If the model name is wrong, calls fail on connect and show `failed`.
- **Reasoning, `AI_VOICE_REASONING`:** `low` default. `minimal` answers fastest; `medium` / `high` think longer and add delay. Only applies to `gpt-realtime-2*` models.
- **Interruptions, `AI_VOICE_VAD_EAGERNESS`:** how quickly the agent decides you have finished talking. `low` waits longer (use if it cuts people off), `high` replies sooner (use if it feels slow), `auto` default.
- **Agent name, `AI_VOICE_AGENT_NAME`:** the first name it gives (default `Alex`).
- **Call length, `AI_VOICE_MAX_CALL_SECONDS`:** default `600`. After a transfer the call is not cut at this limit.

## 11. Troubleshooting

**Answered → silence → it hangs up.** The audio stream never connected.

- Deploy logs (`@cti/api` → the latest deployment → **Deploy Logs**): search for `ai-voice: stream upgrade with a bad signature`. If present, Twilio signed the stream URL for a different host: `API_PUBLIC_URL` on `@cti/api` must be its public `https://` URL, exactly as Twilio reaches it.
- Twilio Console → **Monitor → Errors**: errors in the 31920 series are the Media Streams WebSocket handshake failing (wrong host, TLS, or the service not reachable).
- `API_PUBLIC_URL` on `@cti/api` is the public `https://` URL (not `http://`, not an internal Railway hostname).
- `OPENAI_API_KEY` is set (§3 name check). Without it AI voice is off and the call is refused rather than placed, so this is the first thing to recheck if anything changed.

**Campaign and test calls are not placed.** outreach-api's logs (`railway logs --service outreach-api`) show `ai_call.place: trigger answered` with `result: retry:transport` (the call is retried; the results table says "last try: the AI calling service did not answer", and the test call card says "The AI calling service did not answer. Try again in a minute."). The same line's `transport` field says what went wrong:

| `transport` | Meaning |
|---|---|
| `HTTP 401 bad_signature` | signature refused: the `OUTREACH_INTERNAL_SECRET` values differ, or the clocks are more than 5 minutes apart |
| `HTTP 404` | `CTI_INTERNAL_URL` is not the `.railway.internal` host, or the secret is unset on `@cti/api` (production) |
| `HTTP 503 internal_disabled` | the secret is unset on `@cti/api` (outside production) |
| `HTTP 403 forbidden` | the request carried an `Origin` header |
| `HTTP 429` / `HTTP 400 invalid_body` | cti-api's internal rate limit / the services are on different versions |
| `HTTP 500 internal_error` | cti-api failed on the request (`ai-voice internal: request failed` in its logs) |
| `timeout` / `network` | no answer within 20 seconds, or unreachable: private networking |
| `bad_response` | a 200 whose body outreach-api cannot read: the services are on different versions |

A transport failure never uses up the lead's attempts: the pacer retries with the same key until cti-api answers. A 409 `idempotency_conflict` is not a transport failure: the same key arrived with a different body. The pacer first reads what cti-api stored under that key in `ai_call_requests` (shared database, read-only): a placed call is linked to the touch, a request still in flight keeps the key (`retry:in_flight`), and only when no call was placed under it does the log show `result: retry:idempotency_conflict` and the pacer retry once with a new key, no sooner than 10 minutes later.

To confirm by hand, probe the link from outreach-api's shell (`railway ssh --service outreach-api`):

```bash
curl -s -o /dev/null -w '%{http_code}' "$CTI_INTERNAL_URL/internal/ai-calls/availability"
```

| Answer | What it means and what to do |
|---|---|
| `401` | The link works (reachable, unsigned). If real calls still fail, the signed requests are refused: the two `OUTREACH_INTERNAL_SECRET` values differ, or the clocks are more than 5 minutes apart. `@cti/api`'s logs say `ai-voice internal: signature refused` with the reason. |
| `404` | Either `CTI_INTERNAL_URL` is a public URL (it must be the `.railway.internal` host) or `OUTREACH_INTERNAL_SECRET` is unset on `@cti/api` (production hides the routes behind the same 404). Check both. |
| `503` | `internal_disabled`: `OUTREACH_INTERNAL_SECRET` is unset on `@cti/api` (outside production only). |
| connection error or timeout | Private networking: check that both services are in the same project and environment, and that `@cti/api` listens on `::`. |

Two more cases:

- `result: retry:salesforce_error` repeatedly: the integration connection's token expired and outreach-api could not refresh it. Reconnect Salesforce in outreach-web Settings → Connections.
- Results show "could not check Salesforce for new activity": the integration user cannot read Task or Event (see `outreach-sf-campaigns.md` §AI call campaigns). Nobody is called until it can.

**The agent never offers appointment times** (plan 1D). The trigger carried no slots. outreach-api logs one line per call that was offered none, with the reason in its `slots` field (never record content):

- `ai_call.place: no appointment times offered` for a campaign call, `ai_call.practice: no appointment times offered` for a practice call.

| `slots` | Meaning and fix |
|---|---|
| `no_owner` | Nobody on the appointment owner list is an active Salesforce user. Settings → Connections → AI calls → "Appointments go to" (or `AI_CALL_DEFAULT_SPECIALISTS` on outreach-api when the tenant saved no list) |
| `no_free_time` | The owner's calendar has no free time in the hours and days set on the card (or every time is taken by Events and other AI bookings) |
| `salesforce_error` | Reading the owner's User or Events failed. The connected user must see the owner's calendar (`outreach-sf-campaigns.md` §Appointments and Salesforce write-back, step 5) |
| `invalid_slots` | A bug: the computed times failed the contract. Report it |

Booking switched off on the card logs nothing. Two more cases: a trigger re-sent with the same key after a lost answer goes out **without** slots by design (CF-13), so that one call offers none; and an old `@cti/api` refuses a trigger with slots (`HTTP 400 invalid_body` in the `ai_call.place` line) until it is deployed (§15).

**The AI says nothing (or gibberish), then hangs up.** OpenAI never confirmed the voice session, so the call ends within about 5 seconds of connecting. Deploy logs show `ai-voice bridge: session not configured, ending the call` (field `why`: OpenAI's error message, or `timeout`), then `ai-voice: conversation ended` with reason `error` and detail `session not configured: …`. Usually a bad model or reasoning setting:

- Check `AI_VOICE_MODEL` and `AI_VOICE_REASONING`. Try `AI_VOICE_MODEL=gpt-realtime` with `AI_VOICE_REASONING` unset, then place a test call. Reasoning is only sent for `gpt-realtime-2*` models, so it cannot break `gpt-realtime`.
- An OpenAI account without Realtime access or credit produces the same line with OpenAI's error text.

## 12. Known limits

- **cti-api must run exactly one replica.** Live calls are tracked in memory in one process. A call answered by a different replica, or after a restart, has no state: it is hung up and shown as `failed`. `.railway/railway.ts` already pins one replica; do not scale `@cti/api` up. Avoid redeploying during a live call.
- **A lost Twilio status callback is repaired by a sweeper.** Every 2 minutes it finalizes, from Twilio's own call record, any placed call still open after 3 minutes (a row that never placed a call is marked failed after 10 minutes). The sweeper only runs while AI voice is available; rows left open while `AI_VOICE` is off wait until it is back on.
- **Transfers ring the record owner if mapped, else the rep who started the call.** If that person's softphone is not open and registered, nobody answers and the 25-second callback path runs.
- **AI numbers are separate from reps' numbers.** The AI dials only from `ai_pool` numbers, with the dialer's safety rules: the same number to the same person when it can (the number its last AI call to them came from), each number's warmup daily limit and the 10-per-minute limit, and health (a `degraded` / `spam_likely` number is skipped). Reps' click-to-dial, the firewall check and the power dialer never pick an `ai_pool` number. One new AI number carries only its warmup limit per day, so add more AI numbers before calling at volume.
- **No call audio is stored,** only text transcripts and summaries. If you need recordings for compliance, that is a separate build.
- **Same-number duplicate check is not atomic.** Two simultaneous starts to one number could both go through. The pacer runs at most `aiCallConcurrency` calls per tenant and the idempotency key stops a retried trigger from dialing twice.
- **Campaign calls read the record with the tenant's integration connection,** so the AI sees what the integration user sees, not what the approver sees.
- **Transfer time limit.** On transfer the call's time limit is lifted to 4 hours. If Twilio refuses that, the rep's conversation is cut at `AI_VOICE_MAX_CALL_SECONDS` + 60 seconds from the start of the call (11 minutes by default).
- **Transfer caller ID.** The rep's softphone should show the prospect's number as the caller. Verify this in the smoke test (§5 step 7).
- **Untested against a live carrier until your smoke test:** the transfer caller ID, call time limit extension, and the voicemail voice are only exercised for real in §5. Run the smoke test after every deploy that touches `services/cti-api/src/ai-voice/`.

## 13. Costs

Per minute of conversation:

| Part | Cost |
|---|---|
| OpenAI realtime (`gpt-realtime-2.1`) | about $0.10 per minute |
| Twilio outbound call (US) | about $0.014 per minute |
| Twilio Media Streams | about $0.0044 per minute |
| Twilio answering-machine detection | $0.0075 per **call** |

So about **$0.12 per minute plus $0.0075 per call** ($0.10 + $0.014 + $0.0044 = $0.1184). The 10-minute cap makes the worst case about **$1.20** per call (10 × $0.1184 + $0.0075 ≈ $1.19), and a typical qualifying call of 3 minutes is about $0.36. A call that rings out costs about $0.01. Summaries with a Haiku-class model are a fraction of a cent. Check real spend on platform.openai.com → **Usage** after your first day, and set a monthly spend limit under **Settings → Limits**.

**Test a record (§18).** A preview is one plan-model call (Claude), roughly 15–25k input and 1.5k output tokens: about **4–7¢**, counted against the tenant's daily AI budget. A test call costs what any AI call costs (above); **Talk in browser** bills its leg as Twilio Client minutes (cents) instead of a PSTN minute, and has no answering-machine detection charge. **What would be written** is one answer-mapping call, about 1–3¢, paid once per call (the answer is stored).

## 14. Legal notes

- **AI calls only to people with the consent checkbox ticked.** The checkbox is the record that the person agreed to calls from an AI assistant. Tick it only when they actually did (a reply, a web form, an inbound call, or a rep confirming on the phone) and record the source.
- **Disclosure at the start of every call.** The agent says it is an AI assistant calling for the company on a recorded line. Do not change the prompt to remove it.
- **Do-not-call is honoured everywhere.** An opt-out, blocked number, or federal DNC listing stops the AI call, and "stop calling me" on a real AI call adds the number to the shared opt-out list the dialer also uses (a test or practice call to an admin's own phone records it without opting that phone out).
- **Consult counsel on state-specific rules.** Federal and state laws on AI and artificial-voice calls, call recording and two-party consent, and telemarketing hours differ by state and are changing. Have your attorney confirm the disclosure wording, the consent capture wording and which states you may AI-call before you scale up. This runbook is operations guidance, not legal advice.

## 15. Appointments and `book_appointment` (plan 1D)

- **When it is offered.** Only when the trigger carries appointment times (`target.slots`), which outreach-api computes at the moment of the call from the appointment owner's Salesforce calendar (the first active user on the AI calls card's "Appointments go to" list; production: Grant Golden). With no times, the agent has no `book_appointment` tool, no booking section and no `appointment_set` outcome: it behaves exactly as before 1D. Times are never part of the plan text; cti-api renders them in their own section, after the plan.
- **What it offers.** Up to two times at a time from at most six per kind (two a day): a **phone call** (15 minutes, Mon–Fri, starts every 30 minutes 10:00–17:30 PT, at least 2 hours ahead, 2 business days) and an **in-person walkthrough** (60 minutes, starts on the hour 9:00–16:00 PT, at least 20 hours ahead, 5 business days, 30 minutes' travel buffer). The card's settings change these. Times are said in the seller's zone (the number dialed; on a practice call, the record's phone), with the specialist's own time added only when it differs.
- **Holidays are not modelled.** Only an **all-day Event** on the owner's calendar blocks a day. Put company holidays on the owner's calendar as all-day Events. **Only Events the owner owns are busy:** a meeting where the owner is only an invitee does not block a time; put such meetings on the owner's own calendar.
- **Walkthrough address rule.** Before booking a walkthrough the agent confirms the property address with the seller (`address_confirmed: true`). If it is a different property it does not book a walkthrough: it offers the phone call instead (or a callback when only walkthroughs are on offer).
- **Booking.** `book_appointment` takes an offered `slot_id` (p1–p9, w1–w9). It is refused, and the agent offers the other time, when another AI call already holds that owner's time (overlap, a walkthrough's buffer included; test and practice bookings never block a real one). It stores `ai_calls.appointment` and sets the outcome **`appointment_set`** ("Appointment set") at once.
- **What keeps it.** A booked call keeps `appointment_set` if the caller hangs up, the line goes quiet, or the call hits its time limit. A transfer after booking keeps the booking (`qualified_transferred` / `transfer_failed`; the rep can cancel). "Stop calling me", wrong number, or an `end_call` with another decision (not interested, a callback instead) replaces it and frees the time. `end_call(appointment_set)` with nothing stored is recorded as a callback with the line "The agent ended as booked, but no appointment was saved — call them back."
- **Salesforce.** cti-api never writes the appointment to Salesforce. outreach-api's write-back creates the Event (and converts a Lead) after the call: `outreach-sf-campaigns.md` §Appointments and Salesforce write-back.
- **Deploy order.** Migration `0055_ai_call_booking.sql` must be applied before the new `@cti/api` runs: every `ai_calls` insert writes `offered_slots` and `practice`. Deploy `@cti/api` before or together with outreach-api (one commit): its trigger contract is strict, and an old `@cti/api` answers `HTTP 400 invalid_body` to a trigger carrying `context` or slots with `blockStart`/`blockEnd`. That trigger is retried with the same key, so the window is safe.
- **Off until turned on.** Booking, Lead conversion and Salesforce write-back start off for every tenant; an admin ticks them on the AI calls card after the readiness check, a practice call and a one-Lead live check. Booking can only be on while write-back is on (the card, the settings route and the pacer all enforce it), so the order is write-back, then booking, then conversion when ready. The full order (pause campaigns, Salesforce from a local merge, deploy, readiness, practice, one Lead, turn on) is `outreach-sf-campaigns.md` [Deploy order](outreach-sf-campaigns.md#deploy-order).
- **Rollback.** Stop first: pause the campaigns, untick write-back (the card unticks booking in the same save) and conversion on the card, and as a last resort `AI_VOICE=off` (§9). Booked calls still reach Salesforce when write-back is off (a seller who was told their time is set always reaches Grant); the hard stop is pausing the campaigns plus `AI_VOICE=off`. Before redeploying the previous version, wait until the results show no live or uncounted calls (the pre-1D build retries an `appointment_set` call). Then redeploy the previous outreach-api first or together with the previous `@cti/api`, never `@cti/api` alone; leave migrations 0055–0057 (additive). Converted Leads and the AI's holds and Tasks are fixed by hand: `outreach-sf-campaigns.md` [Rollback](outreach-sf-campaigns.md#rollback).

## 16. Practice calls (plan 1D)

An admin can ring their own test number **as if it were a real seller**: outreach-web → the campaign → a card on the **Call plans** board (proposed or approved plan) → pick a **Test number** → **Practice call to my phone**. "You'll hear exactly what the seller would hear. Nothing is written to Salesforce."

Times are offered whenever an appointment owner is set (the configured default or the AI calls card's list), whatever the switches say, so practice works with everything off (`outreach-sf-campaigns.md` [Deploy order](outreach-sf-campaigns.md#deploy-order) step 6). One practice call per admin at a time: a second click while one is ringing or live is refused with "Your practice call is already ringing or in progress." The answer under the button follows the call ("Ringing your phone…", "On the call…", then "Practice call ended: <outcome>.").

How it differs from a test call (§5):

| | Test call | Practice call |
|---|---|---|
| Record | none | the real Salesforce record (name, address, notes), read by `@cti/api` with the integration connection |
| Plan | none | the card's plan, rendered and checked exactly as for the real call (a plan the voice agent cannot be given is refused, in words) |
| "This is a test call" line | spoken | **not** spoken: you hear the seller's version |
| Appointment times | none | the owner's real free times, offered as on a real call |
| "Their local time right now" | your number's zone | the record's phone's zone |
| Transfer | rings you | rings **you** (the admin who started it), never the record owner |
| Consent | not needed | not needed (it never rings the seller) |
| Salesforce Task, results, write-back | none | none |

A practice call **never books in Salesforce, never converts a Lead and never writes anything**: it claims no touch (so the results never count it and no write-back is queued), and the write-back refuses any `is_test` call before a single Salesforce request. A time it books lands only on `ai_calls.appointment` ("Would have booked …" in the campaign's **Practice calls** list). A practice call is refused a time a real call holds, and never blocks one. The only Salesforce traffic is read-only: the record load in `@cti/api`, and the owner's User and Event reads for the times. "Stop calling me" on a practice call ends it as `do_not_call` without opting your number out (§5).

The campaign page lists the latest 20 practice calls above the results (admins only): time, lead, outcome, "Would have booked: Phone call Wed Oct 7, 11:00 AM" and the transcript. Refusals show in words ("Not placed: …"); cti-api is gated on its test branch (an admin, a number on `AI_VOICE_TEST_NUMBERS`).

## 17. New `ai_calls` columns (plan 1D, migration 0055)

| Column | What it holds |
|---|---|
| `offered_slots` | The times the trigger offered (jsonb array, `[]` when none) |
| `appointment` | The booking the agent stored (slot id, kind, start/end, owner, address confirmed, note, booked at, and the block with a walkthrough's buffer), or null |
| `practice` | True for a practice call (always together with `is_test`) |

```bash
echo "SELECT created_at, outcome, practice, jsonb_array_length(offered_slots) AS offered, appointment->>'start' AS booked FROM ai_calls WHERE org_id = :'org' ORDER BY created_at DESC LIMIT 10;" | psql "$PUB" -v org='<org uuid>'
```

## 18. Test a record (plan 1E)

**Where:** outreach-web → **Test a record** (in the top bar, admins only). Paste a Salesforce Lead or Opportunity Id (`00Q…` or `006…`, 15 or 18 characters) or its link (Lightning, a related list or Classic). The box says "Lead 00Q…" or "Opportunity 006…" as you type, or why it can't use what you pasted. **Preview the call** starts the preview; the page then opens it at `/test-record?id=<test id>`. **Recent tests** below lists the team's latest 20 (time, name, Lead or Opportunity, status, who ran it); click one to open it.

No campaign is needed, nothing is enrolled, and nothing is written to Salesforce.

### The preview: "How I'll approach this call"

It takes about a minute ("Reading Salesforce and writing the plan…"). The page reads it again every 2 seconds until it is ready. It is the same research, plan writer and appointment offer a campaign call gets:

| Section | What it means |
|---|---|
| Name, Lead/Opportunity | The record, with a link that opens it in Salesforce |
| AI consent | "AI consent: yes / no / could not be read / field missing". Anything but yes adds, in red: "A campaign would not call this person. A test only rings you." It never blocks a test |
| Do-not-contact flag | In red, when the plan model found one (the category and the quote): "A campaign would hold this lead in Needs Review." It never blocks a test |
| Last real contact | "Last time we spoke: back in February — the roof" and "The agent will treat them as someone we know", or "No earlier conversation found: the agent will introduce us." |
| Still to learn | The topics the records don't answer yet (price, what they owe, …) |
| Opener | What the agent says after the AI disclosure |
| Situation, Selling signals, Goals | The plan's summary, each signal with its quote, source and strength, and how each of the four goals will be approached |
| The plan text the agent gets | The exact text the voice agent is given, in a box. If the plan text check refuses it, this is a red line instead: "The voice agent can't be given this plan: … Regenerate it." **That blocks running the call** |
| Appointment times | The times it would offer now, in Pacific time (and your own zone when it differs), or why there are none ("Nobody is on the appointment list", "Nobody active is on the appointment list", "No free time in the next 15 days", "Couldn't read the calendar"). Like a 1D practice call, a test offers times whenever someone is on the appointment list, even with Book appointments or write-back off; a real call offers them only with both on. A test call reads the calendar again when it starts |
| What it read | The research sources, as on the plan board (counts, "the integration user cannot read it", …) |
| Cost | "This preview cost about $0.05." |

**Regenerate** starts a new preview of the same record (a new test, counted against the limits). A failed preview says why ("That record isn't in your Salesforce.", "The AI couldn't write a usable plan. Try again.", …) and offers **Try again**.

**Limits** (counted in Postgres, so two quick clicks can't both pass):

| Limit | Value | What you see |
|---|---|---|
| Previews per admin | 10 an hour | "You've run 10 previews in the last hour. Try again at 3:42 PM." (the page shows your own time zone; the API's words use the tenant's) |
| Previews per tenant | 40 a UTC day | "Your team has run 40 previews today. Try again at …" |
| Previews running per admin | 1 | "Your last preview is still running. Wait for it to finish." |
| Daily AI budget | the tenant's daily AI budget (the same one call plans use) | "Today's AI budget is spent. …" |
| Test calls per admin | 6 an hour, 1 live at a time | "You've run 6 test calls in the last hour. …" / "Your last test call is still going. Wait for it to end." |

### Running the call: Ring my phone or Talk in browser

Under a ready preview (only when the plan text passed): "Exactly the call the seller would get, with the real record, plan and times. Nothing is written to Salesforce; a booking is only shown here." Both buttons are off while one of your test calls is live.

- **Ring my phone.** Pick a **Test number** (the shared `AI_VOICE_TEST_NUMBERS` list, §3) and press it. The AI rings that phone as if it were the seller: a 1D practice call (§16).
- **Talk in browser.** Shown only when the calling service reports browser calls available and the browser can run Twilio's Voice SDK.
  1. **Use headphones**, so the AI doesn't hear itself. You are the seller.
  2. Press **Talk in browser**. The browser asks for the **microphone**: allow it.
  3. The page connects this tab ("Connecting this browser…"), asks the AI to call ("Asking the AI to call…"), and **answers on its own** when it rings ("The AI is calling this browser…").
  4. Live: "Connected · 1:23", **Mute** / **Unmute**, **Hang up**. Closing the tab also ends the call.
  5. While the browser call is up, **Regenerate**, **Preview the call** and the **Recent tests** rows are off ("Hang up the browser call first: leaving this test would drop it."). If the page can't reach outreach-api for a moment it says "Couldn't refresh this test: … Still trying." and the call carries on.

While a call is live its card shows the status and how long it has run ("In progress · 2:10"); "Ringing your phone…" clears once the call is answered or ends. After the call, the card (newest first) shows the outcome and length, the summary, **What it learned** (label: value), "Asked for a call back: …", **"Would have booked: Phone call with Grant, Wed Oct 7, 11:00 AM PT"** (the name is the booked time's specialist) and **Transcript**. The page reads it again every 2 seconds while a call is live, and stops 30 minutes after the call started (well past the longest call, `AI_VOICE_MAX_CALL_SECONDS`, 10 minutes by default): a status still live then reads "Status unknown — check the transcript later".

**What would be written to Salesforce** (a button on a finished call's card): the write-back a real call that ended this way would make, worked out from reads only. It shows "Nothing was sent to Salesforce.", what it would create (the Event, or a Lead's calendar hold and Task, and the Chatter post), the conversion line for a Lead that booked ("Would convert this Lead (owner …, Lead Manager …) … The field list below is the Lead-side approximation."), the field changes grouped as on the results (changed, kept the rep's value, not written), and the **AI Last Call Changes** and **Chatter post** texts as they would read. A call that ended as voicemail, no answer, busy, failed or blocked says "A real call that ended this way writes nothing to Salesforce." It follows the AI calls card as it is when you press: with Lead conversion off (the 1D default) a Lead that booked shows the hold on the owner's calendar and the Task instead of the conversion line, and with write-back off (also the default) it adds "Write-back was off, so a real call would have written none of this to Salesforce (and offered no times)…", because a real call is offered times only while write-back is on. The first press costs one answer-mapping call (about 1–3¢); the answer is stored, so later presses are free. One press works a call out at a time: a second press meanwhile says "This is already being worked out. Wait a few seconds and press again." (409 `DRY_RUN_RUNNING`). The mapping answer is kept as soon as it is paid for, so if Salesforce then fails ("Salesforce didn't answer…", 502) pressing again costs nothing more. Anything else that breaks reads "Something went wrong while working this out. Nothing was sent to Salesforce. Try again." (500 `DRY_RUN_FAILED`).

### How it differs from the §16 practice call

| | Practice call (§16) | Test a record, Ring my phone | Test a record, Talk in browser |
|---|---|---|---|
| Needs a campaign and an enrolled lead | yes | **no** (any Lead or Opportunity Id) | **no** |
| Plan | the card's plan | a fresh preview's plan | same |
| Where it rings | a test number | a test number | **this browser tab** (`client:aitest_<your user id>_<nonce>`) |
| Answering-machine detection | on | on | **off** (a browser is never a machine) |
| `calls` row (caps, ceiling, contact history) | written, linked to no record | same | **none**: no phone number was dialed |
| Caller ID | a claimed `ai_pool` number | same | the org's first usable `ai_pool` number, read only (nothing is claimed) |
| Transfer | rings your own softphone if it is open | same | same: your CTI softphone if it is open, else the AI says the specialist stepped away |
| Salesforce writes, booking, conversion, opt-out, touch, write-back | none | none | none |

### The guarantees

A preview only reads Salesforce (GET and SOQL through the tenant's integration connection) and creates no enrollment, touch, call plan, CRM record or hold (G-1). A test call is `is_test = practice = true` in both modes, so every 1D practice guard applies: no Salesforce write, booking, conversion, opt-out, touch or write-back (G-2). It only ever dials a number on `AI_VOICE_TEST_NUMBERS`, or the requesting admin's own `aitest_` identity; outreach-api checks both, and cti-api's gate decides (G-3). The browser token can only receive calls (no outgoing grant), its identity embeds the admin's user id, and it is never logged, cached or stored (G-4); the page builds the Voice SDK's Device at log level `error`, because at `debug` the SDK prints every message it sends, the token included. The agent gets plan text only after the plan text check passes, at preview, at run (outreach-api) and at trigger (cti-api) (G-5). A test booking never blocks a real slot (G-6). "What would be written" sends no POST, PATCH or SOAP request (G-7). Everything is admin-only and tenant-scoped: another tenant's test or call is "not found" (G-8).

### Troubleshooting

- **"Talk in browser" is missing.** The calling service reports `browserCalls: false`: one of `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` is not set on `@cti/api` (the §3 name check), AI voice is off (`OPENAI_API_KEY` unset or `AI_VOICE=off`), or `@cti/api` is older than outreach-api. Or the browser cannot run Twilio's Voice SDK (an old browser, or not HTTPS). **Ring my phone** still works.
- **"This browser couldn't connect to the calling service. Try again or use Ring my phone."** The tab never registered with Twilio: registration failed or took over 15 seconds (a corporate firewall or VPN blocking Twilio's WebSockets, `*.twilio.com`), Twilio refused the Device, or the Device could not be built from the token. Try another network, or use Ring my phone.
- **"The AI didn't ring through. Try again or use Ring my phone."** The tab registered and the AI call was placed, but nothing rang the tab within 45 seconds: media blocked by a firewall or VPN (UDP to `*.twilio.com`), or the leg failed on Twilio's side (check `@cti/api`'s logs for the call). Try another network, or use Ring my phone.
- **"Talk in browser is not set up on the calling service. Use Ring my phone."** The token route answered 503 `BROWSER_CALLS_UNAVAILABLE`: see "Talk in browser is missing" above (the page caught it before ringing).
- **"Talk in browser only works in your own tenant…"** A super admin acting on another tenant: cti-api does not know you as a user there. Use Ring my phone, or sign in to that tenant.
- **The microphone.** Each failure has its own words. "The microphone is blocked for this site…": allow it in the site settings (the padlock in the address bar) and press **Talk in browser** again. "No microphone was found…": connect one (headphones with a mic work). "The microphone only works on a secure (https) page…": the app was opened over plain http. "The microphone couldn't be opened (another app may be using it)…": close the other app and try again.
- **"Can't run this test: the voice agent can't be given this plan's text …"** (`PLAN_TEXT_REJECTED`). Press **Regenerate**.
- **"The preview stopped part way (the server restarted). Try again."** (`interrupted`). outreach-api restarted while the preview ran; a preview left running for 6 minutes reads this way, and a run that finishes later is not written over it. Run it again.
- **"Something went wrong on our side while writing the preview. Try again."** (`internal_error`). Not Salesforce and not the model: outreach-api's logs show `record-test: preview crashed` with the error's name. A Salesforce fault while connecting (a token refresh that fails on the network) reads "Salesforce didn't answer…" (`salesforce_error`); only a missing or revoked connection reads "Salesforce is not connected" (`not_connected`).
- **"The AI calling service did not answer."** A `@cti/api` older than outreach-api answers a browser test with 400: deploy both from the same merge (below).

### Data

Migration `0058_ai_record_tests.sql`: `ai_record_tests` (one row per preview: the record, status and error, the research, plan and plan text, the offered times, the model's tokens and cost) and `ai_record_test_calls` (one row per test call: phone or browser, the `rtest:` key, the `ai_calls` id, cti-api's answer and the stored "what would be written"). The latest tests with their calls' outcomes (read-only; `$PUB` as in the first-call checklist):

```bash
echo "SELECT t.created_at, t.sf_object, t.sf_record_id, t.status, t.error, c.mode, a.status AS call_status, a.outcome, a.appointment->>'start' AS would_have_booked FROM ai_record_tests t LEFT JOIN ai_record_test_calls c ON c.record_test_id = t.id LEFT JOIN ai_calls a ON a.id = c.ai_call_id WHERE t.org_id = :'org' ORDER BY t.created_at DESC, c.created_at DESC LIMIT 20;" | psql "$PUB" -v org='<org uuid>'
```

### Deploy (plan 1E)

1. **Twilio: nothing to create.** Confirm the three `TWILIO_*` names on `@cti/api` (§3). No TwiML App, number or webhook is added: the browser token has no outgoing grant, and the AI leg uses the existing AI voice callbacks. Browser legs bill as Twilio Client minutes.
2. **No new variables.** `AI_VOICE_TEST_NUMBERS` must list each admin's phone for **Ring my phone**.
3. **Migrations:** 1D's `0055`–`0057`, then `0058_ai_record_tests.sql`, in the pre-deploy migrate step of whichever service deploys first.
4. **Deploy `@cti/api` and outreach-api from the same merge.** In the window, an old `@cti/api` answers a browser test with 400 (shown as "The AI calling service did not answer") and has no token route (the page hides **Talk in browser**). Phone tests work throughout.
5. **Headers.** outreach-api sends no Content-Security-Policy or Permissions-Policy today, so the microphone and Twilio's WebSocket and media work as they do in cti-web. If one is ever added it must allow `microphone=(self)`, `connect-src` to `wss://*.twilio.com https://*.twilio.com`, and `media-src`/WebRTC as cti-web needs.
6. **Request logging.** The browser token travels in a response body only. Both services' Fastify request loggers must keep request/response serializers that log no bodies (cti-api uses Fastify's defaults; outreach-api's `serializeRequest` logs method, URL, host and address only). Don't add body logging to either.
7. **Smoke test** (about 10 minutes):
   - preview a real Opportunity and a real Lead: check the opener, still to learn, the plan text and the times;
   - **Ring my phone** on one;
   - **Talk in browser** on the other, with headphones: allow the microphone, the call answers on its own, ask for a phone appointment, hang up. This is the first live check of a `client:` leg with answering-machine detection off: confirm the AI speaks within a couple of seconds of the tab answering (no AMD wait) and that `@cti/api`'s logs show `ai-voice: browser test leg; no calls row` at the end;
   - the card shows "Would have booked …", the outcome, the summary and the transcript;
   - press **What would be written to Salesforce** once;
   - in Salesforce, confirm no Event, Task, field change, conversion or Chatter post appeared on either record.
