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
- **Books a consultation** (plan 1D) when the trigger offers times: in person at the house first, else by phone, with a rep of the property's region, picked by drive time. A seller who needs to sell fast, or faces a foreclosure or auction, is booked with the high-priority rep instead (§15).
- **Leaves a voicemail** if a machine answers, and promises a callback if no person picks up the transfer within 25 seconds.
- Stores the text transcript, a summary, the qualification answers and the outcome. **No call audio is stored.**

**Who can do what.** Admins create campaigns, press **Call all approved** and run test calls. The record owner or an admin approves a plan. Reps do not start AI calls; they receive the transfers.

**Hard rules the code enforces on every call:**

- No AI call without the **AI Call Consent** checkbox ticked on the Salesforce record. The one exception is an admin calling a phone on the **Test phones** list (§21) or listed in `AI_VOICE_TEST_NUMBERS` (your own phones).
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

Set on service `@cti/api`, except `OUTREACH_INTERNAL_SECRET`, which `outreach-api` also holds (below), `GOOGLE_MAPS_API_KEY`, which only outreach-api holds, and the outreach-api variables in `outreach-sf-campaigns.md`. Link the CLI first if you have not:

```bash
railway link
```

Pick project `endearing-comfort`. Setting a variable on a linked service redeploys it; if no deploy starts, use dashboard **@cti/api → Deployments → ⋯ on the latest deployment → Redeploy**. Migration `0050_ai_calls.sql` runs in the pre-deploy step; expect the deploy log to show it applied.

| Variable | Value to set | Unset means |
|---|---|---|
| `OPENAI_API_KEY` | the key from §2.1 (secret) | **AI voice is switched off** (`available: false`, no AI call is placed or answered) |
| `AI_VOICE` | `on` or `off` | `on`. `off` is the kill switch (§9). Only `on` / `off` are accepted; `true`, `1`, `false` stop the service booting |
| `AI_VOICE_TEST_NUMBERS` | your mobile(s), E.164, comma-separated: `+15125550100,+15125550101` | no test numbers; the **Test call to my phone** card in outreach-web says "No test phones are set"; phones added under **Testing → Test phones** (§21) work too |
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
| `GOOGLE_MAPS_API_KEY` (**outreach-api** only, optional) | a Google Cloud API key whose project has the **Routes API** and the **Geocoding API** enabled (secret) | **no appointment times are offered**, and no high-priority offer either: every call notes `maps_unavailable` (§11) and the AI calls card says "Google Maps key missing: no appointment times are offered until GOOGLE_MAPS_API_KEY is set on outreach-api." The calls still go |

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

For appointment times, create the Google key (Google Cloud console → **APIs & Services → Credentials → Create credentials → API key**; enable **Routes API** and **Geocoding API** under **APIs & Services → Library**) and set it on outreach-api only:

```bash
railway variables --set "GOOGLE_MAPS_API_KEY=AIza..." --service outreach-api
```

Never paste the key in chat or a log: Geocoding takes it in the request URL, which is why outreach-api never logs a request URL.

Confirm the names landed (this prints names and values, so do not share the output):

```bash
railway variables --service @cti/api --kv | grep -E '^(AI_VOICE|OPENAI_API_KEY)' | cut -d= -f1
```

Expected: `OPENAI_API_KEY`, `AI_VOICE_TEST_NUMBERS` (plus any other `AI_VOICE*` you set). `OUTREACH_INTERNAL_SECRET` is not matched by that pattern; check it with `grep -E '^OUTREACH_INTERNAL_SECRET' | cut -d= -f1` on each service, and `GOOGLE_MAPS_API_KEY` with `grep -E '^GOOGLE_MAPS_API_KEY=' | cut -d= -f1` on outreach-api.

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

Do this on your own mobile before any real prospect. A test call needs no Salesforce record and no consent tick. Only an admin can place one, from outreach-web, and only to a phone on the Test phones list (§21) or a number in `AI_VOICE_TEST_NUMBERS`.

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
   - "No test phones are set. Add yours to Test phones on the Testing page.": add your phone under **Testing → Test phones** (§21), or set `AI_VOICE_TEST_NUMBERS` (§3).
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
- **Interruptions, `AI_VOICE_VAD_EAGERNESS`:** how quickly the agent decides you have finished talking. `low` waits longer (use if it cuts people off), `high` replies sooner (use if it feels slow), `auto` default. Applies to `semantic_vad` only; with `server_vad` (the gate default) the wait is `AI_VOICE_SILENCE_MS` (§19).
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

**The agent never offers appointment times** (plan 1D, routed by region). The trigger carried no slots. Times are routed: the property's county picks the region, and that region's active reps take the times. A trigger can carry no slots and still carry the high-priority offer with Grant (`priority`). outreach-api logs one line per call whose offer has a note, by its code only (never record content):

- `ai_call.place: appointment offer note` for a campaign call, `ai_call.practice: appointment offer note` for a practice call (`record-test.preview` / `record-test.call` for Test a record). Fields: `note` (below), `slots` (how many times went out), `priority` (whether the high-priority offer went), plus `orgId` and, on a campaign call, `touchId`.
- Beside it, a warning names a read that failed, by its error name or Google's `code` only: `appointments: could not look the property up`, `could not read the property address`, `could not read the seller's consultations`, `could not read the reps' calendars`, `the offer failed`. A property placed in a region with an active rep also logs `appointments: routed offer` (`region`, `slots`, `priority`, `routeElements`).

The regions and their reps are fixed in this step: `DEFAULT_BOOKING_ROUTING` in `services/outreach-api/src/settings.ts` (LA: Los Angeles, Orange, Riverside and San Bernardino counties; SD: San Diego), each with its reps' Salesforce user ids and start times. The high-priority rep is the first active user on the tenant's specialists list (`AI_CALL_DEFAULT_SPECIALISTS` when the tenant saved none): Grant Golden. Test a record shows the same codes as the preview's note.

| `note` | Meaning and fix |
|---|---|
| `booking_off` | Never logged. Booking is off on the card (or write-back is off), or no region has a rep. A practice call or Test a record ignores the switches, so there it means no region has a rep |
| `no_reps` | Every rep of the property's region is inactive in Salesforce (or no rep is active anywhere and there is no high-priority rep). No regular times; Grant's high-priority offer can still go with this note (`priority: true`). Reactivate the user, or change the region's reps in the code default |
| `no_address` | The record has no property address: a Lead's Street, City, State and PostalCode, or an Opportunity's `Street__c` / `City__c` / `State__c` / `Zipcode__c`. A converted Lead reads as none. Fill it in Salesforce |
| `maps_unavailable` | Google could not place the property. With no `GOOGLE_MAPS_API_KEY` on outreach-api there is no warning, only this note. Otherwise the warning's `code` says why: `REQUEST_DENIED` (the key is refused, or the Geocoding API is not enabled for it), `OVER_QUERY_LIMIT`, `http_5xx` or `timeout` (Google down). Set the key with the Geocoding and Routes APIs enabled. When only Routes fails, times are still offered on straight-line estimates (`Google Routes unavailable: using straight-line drive times`) |
| `not_found` | Google found no place for the address. Sam offers a call back. Correct the address in Salesforce |
| `outside_regions` | The property's county is in no region, so there is no high-priority offer either. By design: Sam offers a call back |
| `already_booked` | The seller already has an upcoming consultation (a consultation Event on the record or on a record its research found). By design: no new times; the trigger carries it in `context.consultations` |
| `no_free_time` | The region's active reps have no free start in the horizon that they can reach in time (Events, other AI bookings, drive times), and there is no high-priority offer (Grant inactive, or the record has a city but no street) |
| `salesforce_error` | A Salesforce read failed: the reps' User or Event read, the property address, or the seller's consultations. A failed consultations read drops every time and the high-priority offer on purpose: a booked consultation cannot be ruled out. The warning says which read (`the offer failed`: outreach-api's own read of other AI calls' bookings, or a bug). The connected user must see the reps' calendars (`outreach-sf-campaigns.md` §Appointments and Salesforce write-back, step 5) |
| `invalid_slots` | A bug: the computed times failed the contract. Report it. The high-priority offer still goes |

Booking switched off on the card (or write-back off) logs nothing, and nor does a practice call when no region has a rep. Two more cases: a trigger re-sent with the same key after a lost answer goes out **without** slots, the high-priority offer or the consultations by design (CF-13), so that one call offers none; and an old `@cti/api` refuses a trigger that carries `priority`, `context.consultations` or slots with a `region` (`HTTP 400 invalid_body` in the `ai_call.place` line) until it is deployed, so deploy cti-api first or together (§15).

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

- **When it is offered.** Only when the trigger carries appointment times (`target.slots`) or the high-priority offer (`priority`), which outreach-api works out at the moment of the call (§11, "The agent never offers appointment times", lists each reason for none). With neither, the agent has no booking tools, no booking section and no `appointment_set` outcome: it behaves exactly as before 1D. Times are never part of the plan text; cti-api renders them in their own section, after the plan.
- **Regions and reps.** The property's county (from Google Geocoding) picks the region, and the region's active reps take its times. The table is read-only in this step, defined in code (`DEFAULT_BOOKING_ROUTING` in `services/outreach-api/src/settings.ts`; changing it is a code change and a deploy), and the AI calls card shows it with each rep's name, "(inactive)" when Salesforce says so:

  | Region | Counties | Reps | Starts (Pacific) |
  |---|---|---|---|
  | LA | Los Angeles, Orange, Riverside, San Bernardino | Chance Lanier, Blake Kossuth | 9 AM, 11 AM, 1 PM, 3 PM, 5 PM, 7 PM |
  | SD | San Diego | Seth Boisvert, Thomas Wilkinson | every hour, 9 AM to 4 PM |

  A property in no region gets no times and no high-priority offer (`outside_regions`).
- **Which rep takes a time.** Every consultation lasts 60 minutes and starts at one of its region's start times, Pacific on both sides of daylight saving. In person, every rep drives from the office (`18872 MacArthur Blvd #220, Irvine, CA 92612`) or, when the rep has an earlier Event that day, from that Event's Location: a rep fits when the drive in arrives by the start and the drive out reaches the rep's next Event by its start. Google's Routes API times the drives (straight-line estimates when Routes fails). The shortest drive in wins, then the rep with fewer consultations that week, then table order. A Location that is not a street address (empty, Zoom, a link, a phone number) counts as the office. By phone there is no drive: fewer consultations that day, then table order.
- **What it offers.** For each kind, per day, the first morning start (before noon) and the first afternoon start a rep can take, up to six per kind. The card's "earliest (hours ahead)" and "latest (business days ahead)" set the window per kind; by default in person from 20 hours ahead over 5 business days, by phone from 2 hours ahead over 2, Monday to Friday. Sam offers an **in-person consultation first**, two times at a time with who it is with ("Thursday at eleven with Blake"), and a phone consultation only if the seller does not want anyone at the house. Times are said in the seller's zone (the number dialed; on a practice call, the record's phone).
- **High priority.** A seller who needs to sell fast, or faces a foreclosure or auction, is booked in person with the first active person on the card's "High-priority appointments go to" list (`AI_CALL_DEFAULT_SPECIALISTS` when the tenant saved none; production: Grant Golden), at the time they ask for, whatever that person's calendar says: any day in the next two weeks, starting on a quarter hour between 8 AM and 7 PM Pacific, at least two hours ahead (`book_priority_appointment`, slot `h1`). With no time named, Sam offers the next booking day at 9 AM Pacific. The property must be in a region, with a street address the seller confirms. Nobody active on the list: no high-priority offer, and the regions' reps still take every other booking.
- **Holidays are not modelled.** Only an **all-day Event** on a rep's calendar blocks that rep's day. Put company holidays on every rep's calendar as all-day Events. **Only Events the rep owns are busy:** a meeting where the rep is only an invitee does not block a time; put such meetings on the rep's own calendar. A high-priority booking ignores the calendar.
- **In-person address rule.** Before booking an in-person time the agent confirms the property address with the seller (`address_confirmed: true`). If it is a different property it does not book in person: it offers a phone consultation instead (or a callback when only in-person times are on offer).
- **Booking.** `book_appointment` takes an offered `slot_id` (p1–p9, w1–w9). It is refused, and the agent offers another time, when another AI call already holds that rep's time (test and practice bookings never block a real one). `book_priority_appointment` takes a start in Pacific time and refuses one outside the high-priority rules, saying what to offer instead. Either stores `ai_calls.appointment` and sets the outcome **`appointment_set`** ("Appointment set") at once.
- **What keeps it.** A booked call keeps `appointment_set` if the caller hangs up, the line goes quiet, or the call hits its time limit. A transfer after booking keeps the booking (`qualified_transferred` / `transfer_failed`; the rep can cancel). "Stop calling me", wrong number, or an `end_call` with another decision (not interested, a callback instead) replaces it and frees the time. `end_call(appointment_set)` with nothing stored is recorded as a callback with the line "The agent ended as booked, but no appointment was saved — call them back."
- **Salesforce.** cti-api never writes the appointment to Salesforce. outreach-api's write-back creates the Event on the booked rep's calendar (and converts a Lead) after the call: `outreach-sf-campaigns.md` §Appointments and Salesforce write-back.
- **Deploy order.** Migration `0055_ai_call_booking.sql` must be applied before the new `@cti/api` runs: every `ai_calls` insert writes `offered_slots` and `practice`. Deploy `@cti/api` before or together with outreach-api (one commit): its trigger contract is strict, and an old `@cti/api` answers `HTTP 400 invalid_body` to a trigger carrying `context` or slots with `blockStart`/`blockEnd`. That trigger is retried with the same key, so the window is safe. Set `GOOGLE_MAPS_API_KEY` on outreach-api (§3) before turning booking on: without it no times are offered.
- **Off until turned on.** Booking, Lead conversion and Salesforce write-back start off for every tenant; an admin ticks them on the AI calls card after the readiness check, a practice call and a one-Lead live check. Booking can only be on while write-back is on (the card, the settings route and the pacer all enforce it), so the order is write-back, then booking, then conversion when ready. The full order (pause campaigns, Salesforce from a local merge, deploy, readiness, practice, one Lead, turn on) is `outreach-sf-campaigns.md` [Deploy order](outreach-sf-campaigns.md#deploy-order).
- **Rollback.** Stop first: pause the campaigns, untick write-back (the card unticks booking in the same save) and conversion on the card, and as a last resort `AI_VOICE=off` (§9). Booked calls still reach Salesforce when write-back is off (a seller who was told their time is set always reaches the booked rep); the hard stop is pausing the campaigns plus `AI_VOICE=off`. Before redeploying the previous version, wait until the results show no live or uncounted calls (the pre-1D build retries an `appointment_set` call). Then redeploy the previous outreach-api first or together with the previous `@cti/api`, never `@cti/api` alone; leave migrations 0055–0057 (additive). Converted Leads and the AI's holds and Tasks are fixed by hand: `outreach-sf-campaigns.md` [Rollback](outreach-sf-campaigns.md#rollback).

## 16. Practice calls (plan 1D)

An admin can ring their own test number **as if it were a real seller**: outreach-web → the campaign → a card on the **Call plans** board (proposed or approved plan) → pick a **Test number** → **Practice call to my phone**. "You'll hear exactly what the seller would hear. Nothing is written to Salesforce."

Times are offered whenever some region has a rep (the code default always does) and `GOOGLE_MAPS_API_KEY` is set (§3), whatever the switches say, so practice works with everything off (`outreach-sf-campaigns.md` [Deploy order](outreach-sf-campaigns.md#deploy-order) step 6). One practice call per admin at a time: a second click while one is ringing or live is refused with "Your practice call is already ringing or in progress." The answer under the button follows the call ("Ringing your phone…", "On the call…", then "Practice call ended: <outcome>.").

How it differs from a test call (§5):

| | Test call | Practice call |
|---|---|---|
| Record | none | the real Salesforce record (name, address, notes), read by `@cti/api` with the integration connection |
| Plan | none | the card's plan, rendered and checked exactly as for the real call (a plan the voice agent cannot be given is refused, in words) |
| "This is a test call" line | spoken | **not** spoken: you hear the seller's version |
| Appointment times | none | the region reps' real free times by drive time, and the high-priority offer, as on a real call |
| "Their local time right now" | your number's zone | the record's phone's zone |
| Transfer | rings you | rings **you** (the admin who started it), never the record owner |
| Consent | not needed | not needed (it never rings the seller) |
| Salesforce Task, results, write-back | none | none |

**Unattended test runs: `AI_VOICE_TEST_TRANSFER=off`** (@cti/api; default `ring`). A test or practice call's transfer then rings no one: the caller hears "Test call: the transfer would ring a rep here. Goodbye." and the call hangs up, still recorded `qualified_transferred`. Real calls always ring the rep. Only `ring` or `off` is accepted: any other value (`OFF`, `false`, `no`) stops `@cti/api` booting, which also takes down the reps' softphones. Set it while a script or a harness drives test calls (so nobody's softphone rings at night), and delete it afterwards.

A practice call **never books in Salesforce, never converts a Lead and never writes anything**: it claims no touch (so the results never count it and no write-back is queued), and the write-back refuses any `is_test` call before a single Salesforce request. A time it books lands only on `ai_calls.appointment` ("Would have booked …" in the campaign's **Practice calls** list). A practice call is refused a time a real call holds, and never blocks one. The only Salesforce traffic is read-only: the record load in `@cti/api`, and the reps' User and Event reads for the times (plus Google's lookups of the property and the drives). "Stop calling me" on a practice call ends it as `do_not_call` without opting your number out (§5).

The campaign page lists the latest 20 practice calls above the results (admins only): time, lead, outcome, "Would have booked: Phone consultation Wed Oct 7, 11:00 AM" (or "In-person consultation …", "High-priority consultation …") and the transcript. Refusals show in words ("Not placed: …"); cti-api is gated on its test branch (an admin, a number on `AI_VOICE_TEST_NUMBERS`).

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
  4. Live: "Connected · 1:23", **Mute** (a toggle: it stays pressed while you are muted, and the line reads "Connected · muted"), **Hang up**. A screen reader hears "Connected" and "muted", not the clock.
  5. **Don't use the top bar, Back, a reload or close the tab during the call: leaving the page hangs up.** The page asks first ("A test call is live — leave and hang up?"; for a reload or closing the tab the browser asks in its own words); OK leaves and ends the call.
  6. While the browser call is up, **Regenerate**, **Preview the call** and the **Recent tests** rows are off ("Hang up the browser call first: leaving this test would drop it."). If the page can't reach outreach-api for a moment it says "Couldn't refresh this test: … Still trying." and the call carries on. If the AI's call has already rung the tab when the run request fails (the answer was lost on the way back), the call is kept, and the card follows it.

While a call is live its card shows the status and how long it has run ("In progress · 2:10"); "Ringing your phone…" clears once the call is answered or ends. After the call, the card (newest first) shows the outcome and length, the summary, **What it learned** (label: value), "Asked for a call back: …", **"Would have booked: Phone consultation with Seth, Wed Oct 7, 11:00 AM PT"** (the name is the booked time's rep) and **Transcript**. The page reads it again every 2 seconds while a call is live, and stops 30 minutes after the call started (well past the longest call, `AI_VOICE_MAX_CALL_SECONDS`, 10 minutes by default): a status still live then reads "Status unknown — check the transcript later".

**What would be written to Salesforce** (a button on a finished call's card): the write-back a real call that ended this way would make, worked out from reads only. It shows "Nothing was sent to Salesforce.", what it would create (the Event, or a Lead's calendar hold and Task, and the Chatter post), the conversion line for a Lead that booked ("Would convert this Lead (owner …, Lead Manager …) … The field list below is the Lead-side approximation."), the field changes grouped as on the results (changed, kept the rep's value, not written), and the **AI Last Call Changes** and **Chatter post** texts as they would read. A call that ended as voicemail, no answer, busy, failed or blocked says "A real call that ended this way writes nothing to Salesforce." It follows the AI calls card as it is when you press: with Lead conversion off (the 1D default) a Lead that booked shows the hold on the booked rep's calendar and the Task instead of the conversion line, and with write-back off (also the default) it adds "Write-back was off, so a real call would have written none of this to Salesforce (and offered no times)…", because a real call is offered times only while write-back is on. The first press costs one answer-mapping call (about 1–3¢); the answer is stored, so later presses are free. One press works a call out at a time: a second press meanwhile says "This is already being worked out. Wait a few seconds and press again." (409 `DRY_RUN_RUNNING`). The mapping answer is kept as soon as it is paid for, so if Salesforce then fails ("Salesforce didn't answer…", 502) pressing again costs nothing more. Anything else that breaks reads "Something went wrong while working this out. Nothing was sent to Salesforce. Try again." (500 `DRY_RUN_FAILED`).

### How it differs from the §16 practice call

| | Practice call (§16) | Test a record, Ring my phone | Test a record, Talk in browser |
|---|---|---|---|
| Needs a campaign and an enrolled lead | yes | **no** (any Lead or Opportunity Id) | **no** |
| Plan | the card's plan | a fresh preview's plan | same |
| Where it rings | a test number | a test number | **this browser tab** (`client:aitest_<your user id>_<nonce>`) |
| Answering-machine detection | on | on | **off** (a browser is never a machine) |
| `calls` row (caps, ceiling, contact history) | written, linked to no record | same | **none**: no phone number was dialed |
| Caller ID | a claimed `ai_pool` number | same | the org's first usable `ai_pool` number, read only (nothing is claimed) |
| Transfer | rings your own softphone if it is open (no one with `AI_VOICE_TEST_TRANSFER=off`, §16) | same | same: your CTI softphone if it is open, else the AI says the specialist stepped away |
| Salesforce writes, booking, conversion, opt-out, touch, write-back | none | none | none |

### The guarantees

A preview only reads Salesforce (GET and SOQL through the tenant's integration connection) and creates no enrollment, touch, call plan, CRM record or hold (G-1). A test call is `is_test = practice = true` in both modes, so every 1D practice guard applies: no Salesforce write, booking, conversion, opt-out, touch or write-back (G-2). It only ever dials a number on `AI_VOICE_TEST_NUMBERS`, or the requesting admin's own `aitest_` identity; outreach-api checks both, and cti-api's gate decides (G-3). The browser token can only receive calls (no outgoing grant), its identity embeds the admin's user id, and it is never logged, cached or stored (G-4); the page builds the Voice SDK's Device at log level `error`, because at `debug` the SDK prints every message it sends, the token included. The agent gets plan text only after the plan text check passes, at preview, at run (outreach-api) and at trigger (cti-api) (G-5). A test booking never blocks a real slot (G-6). "What would be written" sends no POST, PATCH or SOAP request (G-7). Everything is admin-only and tenant-scoped: another tenant's test or call is "not found" (G-8).

### Troubleshooting

- **"AI calling is off, so test calls can't run right now." and no buttons at all.** The calling service reports AI calling unavailable: `AI_VOICE=off` or `OPENAI_API_KEY` unset on `@cti/api`, or `OUTREACH_KILL_SWITCH=on` (§9). Neither Ring my phone nor Talk in browser is shown until it is back on.
- **"Talk in browser" is missing, but Ring my phone is there.** The calling service reports `browserCalls: false`: one of `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` is not set on `@cti/api` (the §3 name check), or `@cti/api` is older than outreach-api. Or the browser cannot run Twilio's Voice SDK (an old browser). A page opened over plain http usually still shows the button; pressing it ends with the microphone's https words (below). **Ring my phone** still works.
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

**1E deploys only after 1D is live.** `feat/ai-call-1e` contains all of plan 1D. Before anything below:

- **If 1D is already merged and deployed** (its [Deploy order](outreach-sf-campaigns.md#deploy-order) steps 1–6 done: campaigns paused while checking, Salesforce deployed from a local merge, booking, conversion and write-back off), 1E adds only the steps below. Pause every active AI call campaign before the 1E push too: it restarts `@cti/api`, and a live call drops with it. Resume after step 7.
- **If 1E ships in the same push as 1D,** follow `outreach-sf-campaigns.md` [Deploy order](outreach-sf-campaigns.md#deploy-order) from step 1: pause every AI call campaign, deploy Salesforce from the **local** merge before pushing (Railway deploys on push), and leave every switch off. Do the steps below at its step 4, and run the 1E smoke test (step 7 below) at its step 6, with the practice calls.

1. **Twilio: nothing to create.** Confirm the three `TWILIO_*` names on `@cti/api` (§3). No TwiML App, number or webhook is added: the browser token has no outgoing grant, and the AI leg uses the existing AI voice callbacks. Browser legs bill as Twilio Client minutes.
2. **No new variables.** `AI_VOICE_TEST_NUMBERS` must list each admin's phone for **Ring my phone**.
3. **Migrations:** 1D's `0055`–`0057` first, then `0058_ai_record_tests.sql` (after `0057`), in the pre-deploy migrate step of whichever service deploys first.
4. **Deploy `@cti/api` and outreach-api from the same merge, `@cti/api` first or together.** In the window, an old `@cti/api` answers a browser test with 400 (shown as "The AI calling service did not answer") and has no token route (the page hides **Talk in browser**). Phone tests work throughout.
5. **Headers.** outreach-api sends no Content-Security-Policy or Permissions-Policy today, so the microphone and Twilio's WebSocket and media work as they do in cti-web. If one is ever added it must allow `microphone=(self)`, `connect-src` to `wss://*.twilio.com https://*.twilio.com`, and `media-src`/WebRTC as cti-web needs.
6. **Request logging.** The browser token travels in a response body only. Both services' Fastify request loggers must keep request/response serializers that log no bodies (cti-api uses Fastify's defaults; outreach-api's `serializeRequest` logs method, URL, host and address only). Don't add body logging to either.
7. **Smoke test** (about 10 minutes):
   - preview a real Opportunity and a real Lead: check the opener, still to learn, the plan text and the times;
   - **Ring my phone** on one;
   - **Talk in browser** on the other, with headphones: allow the microphone, the call answers on its own, ask for a phone appointment, hang up. This is the first live check of a `client:` leg with answering-machine detection off. Phone legs use async AMD too, so how fast the AI speaks proves nothing; check Twilio's own record of the leg instead. Its `answered_by` is set only when the call was placed with AMD, so the browser leg must read `null` (the phone leg from the line above reads `human` or `machine_…`). Find the leg and its `call_sid`, then ask Twilio (read-only; `$PUB` as in the first-call checklist, and the account SID and auth token from `@cti/api`'s variables — don't print them):

     ```bash
     eval "$(railway variables -s @cti/api --kv | grep -E '^TWILIO_(ACCOUNT_SID|AUTH_TOKEN)=' | sed 's/^/export /')"
     echo "SELECT to_e164 LIKE 'client:%' AS browser, call_sid, answered_by, outcome FROM ai_calls WHERE org_id = :'org' AND is_test ORDER BY created_at DESC LIMIT 2;" | psql "$PUB" -v org='<org uuid>'
     curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Calls/<browser call_sid>.json" | jq '{to, answered_by, status}'
     unset TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN
     ```

     The browser row reads `browser = t`, `answered_by` empty and an outcome other than `voicemail`; Twilio's answer reads `"to": "client:aitest_…"` and `"answered_by": null`. `@cti/api`'s logs show `ai-voice: browser test leg; no calls row` at the end (`railway logs -s @cti/api --since 30m | grep 'browser test leg'`; without `--since` or `--lines` it streams and never ends);
   - the card shows "Would have booked …", the outcome, the summary and the transcript;
   - press **What would be written to Salesforce** once;
   - in Salesforce, confirm no Event, Task, field change, conversion or Chatter post appeared on either record.

### Rollback (plan 1E)

Test a record is admin-only and additive: it adds a page, six admin routes, cti-api's `practice_browser` target and token route, and two new tables. Nothing a campaign or a real call uses depends on it.

- **Stop it now:** `AI_VOICE=off` on `@cti/api` (§9). The page then shows "AI calling is off, so test calls can't run right now." and no test call can be placed; previews still read Salesforce only.
- **Remove it:** redeploy the previous outreach-api (it serves outreach-web) first, or together with the previous `@cti/api`; never `@cti/api` alone while the new outreach-api runs (a browser test would get a 400). The page and its routes are gone; 1D is unaffected.
- **Leave `0058_ai_record_tests.sql` in place.** Its two tables are only read by 1E's code; the previous build ignores them.

## 19. Natural turn-taking (2026-10-09)

Spec: `docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md`.

- **What changed.** The agent keeps talking through "mm-hmm", "yeah", "okay", coughs and noise, and stops for a real interruption ("wait", "hold on", "no", or two real words) about a second in. It never cuts its own opener (the AI disclosure). A "yeah" or "sure" from a caller who starts in the last ~1.5 s of its question, or is still talking when the agent finishes, is taken as the answer. After 8 s of silence it checks in once ("are you still there?"); after another 8 s with no answer it says goodbye and ends the call. It stays quiet for a TV or side conversation (`wait_for_user`). When someone asks it to hold on, it says "Sure, take your time" and waits 30 s before checking in (and 30 s more before saying goodbye). If someone new comes on the line, it tells them it's an AI assistant on a recorded line before going on. To a call-screening assistant it says who's calling once, then waits quietly (`wait_for_user`: 30 s before it checks in).
- **Settings (@cti/api).** `AI_VOICE_BARGE_IN` = `gate` (default) or `instant` (the old behaviour: stop on any sound, no silence check-ins). `AI_VOICE_TRANSCRIBE_MODEL` unset (default) follows the mode: `gpt-live-transcribe` with `gate` (streams words while the caller talks — the gate needs that), `gpt-4o-mini-transcribe` with `instant` (the old one); a value set here wins in either mode. `AI_VOICE_TURN_DETECTION` (2026-10-12) sets what decides the caller has finished: unset follows the mode, `server_vad` with `gate` (the turn ends after `AI_VOICE_SILENCE_MS` of silence: about 0.9 s in all six live turns we measured) and `semantic_vad` with `instant` (OpenAI waits for a "complete thought": measured up to about 4.8 s on short replies like "Yeah, this is Jane."); a value set here wins in either mode. `AI_VOICE_SILENCE_MS` (`500`, whole milliseconds from 200 to 2000, `server_vad` only): lower = faster, but the agent more often starts answering into a pause. That is invisible when the caller keeps talking before the agent's first audio (about 0.9 s later), because the gate drops that answer unheard and answers both parts once. `AI_VOICE_VAD_EAGERNESS` (`auto`) applies to `semantic_vad` only.
- **Smart stop (v2, 2026-10-13; spec §4.5).** In gate mode the agent now stops when the caller *keeps talking*, measured from their audio, instead of waiting for transcribed words: about 0.6 s of continuous talk over it stops it at once, while "mm-hmm", "yeah", "okay" (about 0.2–0.56 s) do not. Speech that starts in the last ~1.5 s of its audio — any sound, a cough included — stops it at once and is answered as soon as the caller's turn ends; a caller still talking when its audio finishes (over the opener too) is simply answered at the end of their turn — neither waits for the transcript any more. That late stop never cancels a reply that has fully arrived, so a goodbye's `end_call` or a transfer still goes through. A sound or word stop cannot reliably save a goodbye either: once the reply's tool calls have arrived and run, the bridge is closing and no longer judges what the caller says, so "wait, one more thing" over a goodbye cancels its `end_call` only if the interruption lands before the reply's tool calls arrive. That is rare, because a reply finishes arriving long before its audio finishes playing (the same as before v2). Words still stop it too ("wait", "no", two real words, 3 s with no words), so a short "wait" still works, about a second later. The opener (the disclosure) is still never cut. Trade-off: about 1 in 20 listening sounds may stop it (a long "yeah, yeah").
- **Smart stop settings (@cti/api).** `AI_VOICE_OVERLAP_JUDGE` = `sound` (default, v2) or `words` (the 2026-10-09 word judge exactly); gate mode only. `AI_VOICE_STOP_MS` (`600`, whole milliseconds from 300 to 2000, sound judge only): lower = stops sooner, but more "mm-hmm"s stop it; higher = fewer false stops, but slower stops. **Turn v2 on in prod:** set `AI_VOICE_BARGE_IN=gate` (or delete the variable — `gate` is the default) and redeploy; the transcriber and turn detector follow the mode unless set explicitly, and `AI_VOICE_OVERLAP_JUDGE` unset means `sound`. **Roll back:** `AI_VOICE_OVERLAP_JUDGE=words` (keeps the gate, old word judge) or `AI_VOICE_BARGE_IN=instant` (no gate at all). **Tuning from logs** (@cti/api, numbers only): `ai-voice bridge: caller interrupted the agent` `{ why, runMs }` — `why` is `sound` (kept talking past `AI_VOICE_STOP_MS`), `late` (spoke over its last ~1.5 s), `words` or `no words`; `runMs` is how long the caller's sound had run. `ai-voice bridge: caller listening sound` `{ maxRunMs }` — a "mm-hmm" it talked through, and its longest sound. Many listening sounds close to the stop length → raise it; many real replies stopped only by `words` → lower it. **With the sound judge keep `AI_VOICE_SILENCE_MS` at 300 or more:** at 200, two "mm-hmm"s about 240 ms apart merge into one sound and stop the agent. **Noisy or steady lines:** the meter counts sound from before the VAD's turn begins, on the raw line audio. On a noisy or echoey line the sound judge degrades toward instant-like stopping: the log shows `why: sound` with `runMs` far above `AI_VOICE_STOP_MS`. On a line with a steady hum, normal speech may not register as sound at all, and the call falls back to the word rules (`why: words`, `runMs` 0).
- **A note save after a question no longer triggers a second agent turn (2026-10-13).** When the agent asks a question and saves a note in the same reply (e.g. "Is it vacant right now?" + `save_qualification`), the bridge no longer asks it to speak again: the caller answers, in both barge-in modes. A statement ("Got it."), a reply with no audio, or any other tool still gets the follow-up. The prompt also tells the agent never to narrate tools ("let me note that", "let me think about the times") and to offer the listed appointment times straight away. Spec §4.4 addendum.
- **Rollback.** Deploying this branch is not a no-op for `instant` mode. The sound judge is dormant there (no meter, the gate never opens), but three changes apply in both modes: no follow-up agent turn after a question plus a `save_qualification` (Task 3), the new prompt lines (never narrate tools; offer the booking times straight away), and `save_qualification`'s new tool output. Rolling those back means redeploying the previous `@cti/api` build (main `8be4e2f`). The variables below roll back only the turn-taking. Set `AI_VOICE_BARGE_IN=instant` on @cti/api (Railway variables) and redeploy. That alone is the turn-taking rollback (`AI_VOICE_OVERLAP_JUDGE=words` keeps the gate and goes back to the word judge): it also restores the old transcriber unless `AI_VOICE_TRANSCRIBE_MODEL` is set explicitly (then clear it too), and the old turn detector unless `AI_VOICE_TURN_DETECTION` is set explicitly (then clear that too). To roll back just the silence-based turn detection and keep the gate: `AI_VOICE_TURN_DETECTION=semantic_vad`.
- **Symptom.** Calls end right after pickup with `session not configured` in the @cti/api logs → the transcriber was rejected: set `AI_VOICE_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe` (or switch to instant).
- **Deploy.** Migration 0059 (`ai_calls.turn_stats jsonb`, nullable) runs as the pre-deploy step on both @cti/api and outreach-api; older calls show no response-time line.
- **Numbers.** Every call saves `ai_calls.turn_stats` and logs `ai-voice: turn stats`; outreach-web shows one line above each transcript ("Response time: usually 1.9 s (slowest 3.1 s) · kept talking through 4 "mm-hmm"s · stopped for 1 interruption"). Response time = end-of-turn detection (how long after the caller actually stopped talking until the turn was declared over; with `server_vad` this now includes the silence wait, which OpenAI's `audio_end_ms` already contains, so a healthy call now reads roughly the silence setting plus transport instead of the ~0.1 s it showed before; with `semantic_vad` the true wait is not in the event, so the figure still understates what the caller waited) + answer time (until our server sent the first agent audio); waiting for the agent's own audio to finish is not counted, and Twilio playout (~0.1–0.2 s) is extra. Instant mode records the same numbers. Under the sound judge, late answers (rule B: speech over the agent's last ~1.5 s) count as interruptions (`stats.interruption` and the "[stopped — they interrupted]" transcript note), so outreach-web's interruption count reads higher than under the words judge for the same call.
- **Owner check after deploy.** Test a record → Talk in browser: (1) say "mm-hmm" while it talks — it keeps going; (2) say "wait, hold on" — it stops and answers you; (3) say "hello" over its first line — it finishes the disclosure; (4) go quiet — after ~8 s it checks in once, then says goodbye; (5) say "hang on a sec" — "Sure, take your time", then quiet for 30 s before it checks in; (6) say "yeah" about 2 s before the end of one of its questions — it takes that as your answer and carries on, with no 8 s pause. **Smart stop v2 (gate mode, sound judge):** (7) talk over the agent mid-sentence for about 1 s — it stops at once; (8) say "mm-hmm" or "yeah" mid-sentence — it keeps going; (9) answer over its last second — it stops and answers right away; (10) say "bye" over its goodbye — the call still ends; (11) it no longer says "let me note that", and doesn't speak twice after asking a question. Read the response-time line above the transcript. **Before relying on v2:** the calibration used clean TTS clips, and "Talk in browser" runs WebRTC echo cancellation and noise suppression, so do at least one real-phone test call (Ring my phone) before trusting it. Before switching prod to `gate`, check that `AI_VOICE_TRANSCRIBE_MODEL` is not pinned to a non-streaming model: the word fallback needs streaming words.
- **Which version is live (2026-10-13).** The bottom of the outreach-web sidebar shows `App <commit> · Calls <commit>` and `deployed <date, time>`. App is the commit outreach-web and outreach-api were built from (one build); Calls is the commit `@cti/api`, the AI voice server, is running (`Calls unknown` when outreach-api cannot reach it, or while an `@cti/api` older than this change is still live). After a push, wait until both show the pushed commit (its first 7 characters) before testing. **New version — refresh** appears only when this open tab is older than the live app: reload the tab. Both come from the `RAILWAY_GIT_COMMIT_SHA` Railway sets on every GitHub deploy, never by hand; `dev` means a local run or a build without it.

## 20. Editing the agent prompt (2026-10-16)

Plan: `docs/superpowers/plans/2026-10-16-editable-agent-prompts.md`. An admin edits what the AI phone agent is told on every call (its **instructions**) and the **voicemail** it leaves, in outreach-web, with no deploy.

- **Where.** outreach-web (Lead Specialist) → sidebar **Agent prompt** (admins only; `/settings/agent-prompt`). Two tabs: **Call instructions** and **Voicemail message**. The status line under the tabs says **Using the default** or **Edited <date, time> by <email>**. The editor starts with the saved text, or the built-in default when nothing is saved.
- **Saves apply on the next call.** Each call reads the newest saved version when it is placed. A call already placed or in progress keeps the text it started with. Nothing needs a restart.
- **What the text is.** A template, not plain text. `{{name}}` is replaced by a value from the call (the agent's name, the company, the lead's first name, the property, the callback number, the approved plan, the appointment times, and so on). A **section** `{{#name}} … {{/name}}` shows its content only when it applies (`{{^name}} … {{/name}}` shows its opposite); `call_plan`, `is_test`, `returning`, `can_book`, `offers_phone_call`, `offers_walkthrough` and `appointment_times` (once per time) are sections. The page's collapsible **Placeholders you can use** lists every name for the tab you are on, with its kind (text or section) and what it stands for; that list comes from `@cti/api`, so it is always the current one. Limits: 60,000 characters for the instructions and 1,500 for the voicemail (the page shows the count and turns Save off when over). Values are inserted literally, so a `{{` in a lead's notes is never read as a placeholder.
- **Checks.** **Preview** renders the draft against a sample lead (Jane at 1234 Oak St in Tampa, spoken with before, with a plan, two appointment times with Grant and a callback number) and shows the text, or the reasons it was refused. **Save** runs the same check and refuses with the reasons: an unknown or misspelled placeholder (`Unknown placeholder: frist_name`), a section that is never closed (with its line number), an empty prompt, one too long, one whose sample render comes out empty (a block that only shows when data a sample call lacks is there, such as `{{^appointment_times}}…{{/appointment_times}}`) or longer than twice the limit, `appointment_times` opened inside itself (it multiplies the text, 2^depth, and could stall every live call), or sections nested more than 8 levels deep. The check covers syntax and placeholder names only, **not what the prompt says**. The built-in default carries the disclosure ("an AI assistant calling for <company> on a recorded line") and says the callback number before every non-transfer goodbye (TCPA); keep those lines when editing, and listen to a **Test a record** call (§18) after any change.
- **A saved version replaces the built-in prompt.** The saved text is used as written, so later improvements to the built-in prompt (and to the tools it goes with) do not reach that org's calls until someone resets to the default or copies the new wording into the saved text. The page says so under the status line while a version is saved, and by **Save**. After a release that changes the built-in instructions or voicemail, tell whoever edits the prompt: reset to the new default (their saved versions stay in **Previous versions**) and re-apply their changes on top of it, or copy the new wording into their text.
- **Every failure falls back to the built-in default.** The call is still placed and answered; it just uses the default text instead of the saved one:
  - no saved version, or the newest one is a reset;
  - `@cti/api` cannot read the saved prompts at placement: one warning `ai-voice: agent prompts unavailable, using defaults` with `reason: 'db_error'`;
  - a saved template is not used at call time: one warning `ai-voice: custom prompt failed, using default` with the `kind` and a `reason`: `render_error` (it failed to render), `empty_render` (it came out empty for this call, e.g. `{{#call_plan}}…{{/call_plan}}` on a call with no plan, or a voicemail made only of `{{#callback_number}}…{{/callback_number}}` on a call with no callback number; an empty text would leave the call with no script, or a silent voicemail), or `too_long` (it rendered past twice its limit for this call). The text itself is never logged.
- **When the check cannot run.** If outreach-api cannot reach `@cti/api` (the same `CTI_INTERNAL_URL` and `OUTREACH_INTERNAL_SECRET` as §3), **Save** and **Preview** say "Can't check the prompt right now — try again in a minute" and nothing is saved.
- **Versions.** Every save is a new row in `ai_agent_prompts` (migration `0060_ai_agent_prompts.sql`), per organization and kind (`instructions` or `voicemail`). Rows are only ever added, never edited or deleted, so the history is the audit trail: the newest row per org and kind is the active one, a `NULL` body means the built-in default, and `created_by` is the admin who saved it. The page lists the 20 newest under **Previous versions** (time, who, a "default" badge for a reset); **Load** puts one in the editor, unsaved, and Save makes it the newest. To look without printing any text (`$PUB` is a live credential, see the checklist step 4):

  ```bash
  echo "SELECT org_id, kind, created_at, body IS NULL AS is_default, length(body) AS chars FROM ai_agent_prompts ORDER BY created_at DESC LIMIT 10;" | psql "$PUB"
  ```
- **Reset.** On the page, with a saved version active, **Reset to default** asks "Go back to the built-in prompt? Your saved versions stay in Previous versions; unsaved edits will be lost." and then saves a `NULL`-body version, so the very next call uses the built-in default again and nothing saved is lost. When the default is already in use, Reset only puts the default back in the editor (it discards an unsaved draft and saves nothing, so no new row). Saving a reset runs through `@cti/api` like any save, so it **also needs the calls service reachable**: the page answers "Can't check the prompt right now" (HTTP 503 from outreach-api) otherwise. If outreach-web or `@cti/api` is down and a bad prompt must go now, add the same `NULL` row by hand (use the `org_id` from the query above, and never `DELETE` or `UPDATE` rows):

  ```bash
  echo "INSERT INTO ai_agent_prompts (org_id, kind, body) VALUES ('<org_id>', 'instructions', NULL);" | psql "$PUB"
  ```

  Use `'voicemail'` for the voicemail.

## 21. Inbound testing and test phones (2026-10-16)

Plan: `docs/superpowers/plans/2026-10-16-inbound-agent-testing.md`. An admin keeps a list of **test phones** in outreach-web. A phone on the list can get test calls from the agent, and when it calls one of the agent's numbers, the agent answers (with its own **inbound** prompt) instead of a rep.

- **What the list does.** Two things, for the phones on it and nobody else. (1) **Outbound test calls:** the agent may call a listed phone from **Call this phone** on the Testing page, and from the other test-call buttons (**Test call to my phone**, **Practice call**, **Test a record → Ring my phone**); the list is added to `AI_VOICE_TEST_NUMBERS` (§3), which keeps working, so a phone is allowed if it is in either. (2) **Inbound:** a listed phone that calls one of the agent's numbers gets the agent.
- **Where.** outreach-web (Lead Specialist) → sidebar **Testing** (admins only; `/testing`). **Test phones** lists each phone (number, label, who added it) with **Call this phone** and **Remove** (it asks first). **Inbound calls** says which number to dial and lists the newest 20 inbound test calls, refreshed every 10 seconds while the page is open.
- **Adding a phone.** Type the number the way you write it, "(619) 555-0123", and an optional label (whose phone it is, up to 60 characters), then **Add phone**. The server turns it into E.164 (US numbers need no `+1`). It answers "That doesn't look like a phone number", "That phone is already on the list" (the same phone typed another way counts), or "The list is full (25 phones) — remove one first". Each organization has its own list, at most 25 phones. **Only add phones whose owners agreed to get test calls from the agent.**
- **How to call in.** From a listed phone, call one of the agent's numbers: the **Inbound calls** section names them ("Call (619) 555-0900 from a phone on the list and the agent answers with the inbound prompt."). Those are the organization's `ai_pool` numbers that have inbound turned on (the AI number set up in the first-call checklist, step 5; it is imported with inbound on). With none, the section says "No agent number takes calls yet." The agent answers with its greeting a moment after pickup.
- **Everyone else is unchanged.** A caller who is not on the list, an anonymous caller or one whose number cannot be read gets exactly what they got before: a rep rings (or the voicemail records, with a `calls` row and the Salesforce sync). Only a listed phone calling an AI number takes the new path. If anything in the new path fails (switch off, AI voice unavailable, a database error, any error), the call falls back to the old routing. @cti/api logs a warning `ai-voice: inbound test call not started` with a `reason` only when it is news: a phone on the list did not get the agent (`ai_unavailable`, `bad_call_sid`, `start_failed`), or the list could not be read (`lookup_failed`). Real callers, anonymous callers and every call while `AI_VOICE_INBOUND` is `off` log nothing (with the switch off the list is not even read). If Twilio asks for the same call twice (a fallback URL after a slow first answer), the second answer streams to the same inbound call; it never falls back to a rep.
- **Switch.** `AI_VOICE_INBOUND` on `@cti/api` (`on` by default). `off` sends every phone, listed or not, to the old routing, and test calls out are unaffected:

  ```bash
  railway variables --set "AI_VOICE_INBOUND=off" --service @cti/api
  ```

  `AI_VOICE=off` (§9) also stops it, because AI voice is then unavailable. Both take effect on the next call after the redeploy; a call in progress keeps going until it ends or the service restarts.
- **The inbound prompt.** **Agent prompt** (§20) has a third tab, **Inbound calls**, for what the agent follows when a listed phone calls it (the page's **Edit the inbound prompt** link on Testing opens it). It works like the other two: **Preview**, **Save**, **Reset to default**, **Previous versions**, saves apply from the next call, and a saved version replaces the built-in one. The built-in inbound prompt is the owner's own wording. Its placeholders are listed under **Placeholders you can use** on that tab (the agent's name, the company, the caller's number, and the caller's local time). Fixed rules are always added after the prompt, a saved one included: everything is spoken aloud (never say JSON, field names or tags), there is nothing to write down during the call, so the agent never mentions notes or saving and never says a line about what it is about to do, it speaks English only, when the caller says goodbye or has to go it says a short goodbye out loud before it ends the call (it never hangs up silently on someone still there; as a backstop, if it calls end_call without a word right after the caller spoke, the bridge sends that back once and asks for a goodbye-only reply — a turn in which it can speak but cannot call tools — logged as `ai-voice bridge: end_call with no goodbye after the caller spoke — asked for one`; once that goodbye has been said the bridge ends the call itself with the original end_call, logged as `ai-voice bridge: goodbye said after a sent-back end_call — ending the call`, unless the caller spoke again first, in which case they are answered as usual), and (when caller ID shows it) the number the caller is calling from, written like 619-555-0100. Any instruction in the prompt to print JSON or a summary at the end is ignored. The tab says so in one line; the preview shows only the prompt itself. An inbound prompt that is empty when rendered, or cannot be read, falls back to the built-in one, the same as §20.
- **What gets saved.** The agent saves nothing during the call. After the call ends, Claude (`AI_SUMMARY_MODEL`, the same model and key as the call summaries in §8) reads the transcript and fills in the details and the status from what the caller said, leaving blanks for what it didn't hear. It keeps only these fields, each as short text: name, best number, email, property address, location, walkthrough (the day and window the caller picked; the team confirms the exact time by text), timeline, price expectation, condition, who lives there, owed on it, decision maker, why they're selling, urgency, urgency level (**high**, **medium**, **low** or **unknown**; anything else is dropped), how they came across, best callback time, next step and notes, plus the status: **qualified**, **callback**, **disqualified** or **incomplete** (anything else is dropped). They appear on each inbound call in the **Inbound calls** list (empty ones are hidden), under the badge showing the status. `ai_calls.qualification` holds them and `ai_calls.outcome` holds the status (or `incomplete`).
- **When it is filled in.** Right after the call ends, before the call is closed, so the list shows **In progress** until Claude has answered (a few seconds; it gives up after 25 seconds). Without `ANTHROPIC_API_KEY`, inbound calls read **Incomplete** with no details. A call where the caller never spoke, or where Claude fails, times out or gives no valid status, also reads **Incomplete**, with whatever details were valid. Nothing is logged from the call: a failure is one warning, `ai-voice: inbound call details not filled in`, with the call's id and the kind of failure. The fixed rules also tell the agent to speak English only, the whole call.
- **Not recorded, and nothing written elsewhere.** As for every AI call, no audio is stored: you get the **Transcript** button on each call (admins only). An inbound call is a test call: it never writes Salesforce, never creates a `calls` row or a Salesforce Task, never records an opt-out, and does not count toward any number's warm-up or velocity caps, callback routing or sticky caller-ID (those look only at outbound calls).
- **Removing a phone.** **Remove** takes effect for the next call: a call that phone already has going carries on, and its next call to an AI number is routed as for anyone else. Its earlier calls stay in the list, by number instead of by label. Removing the phone does not touch `AI_VOICE_TEST_NUMBERS`.
- **Troubleshooting.**
  - *A listed phone rang a rep or went to voicemail.* Check, in order: the phone is on the list with the number it calls from (a different mobile, or a call with caller ID hidden, is not that phone); the number it dialed is one of those named under **Inbound calls**; `AI_VOICE_INBOUND` is not `off` and `AI_VOICE` is on (§9); the @cti/api logs around the call for `ai-voice: inbound test call not started` and its `reason`.
  - *The Testing page shows no agent number.* No `ai_pool` number has inbound turned on for this organization. A number imported from Twilio has it on (§5), so an AI number that was never imported, or one whose inbound was turned off, is the cause: import it, or turn it on with the admin route `PATCH /admin/outbound-numbers/<id>` on `@cti/api` (body `{"inboundEnabled": true}`).
  - *Call this phone says "Not called: …".* The same reasons as any test call (calling hours, a call already in progress, AI voice off, and so on).
- **Data and deploy.** Migration `0061_inbound_agent_testing.sql` runs as the pre-deploy step on both `@cti/api` and outreach-api: it adds `ai_calls.direction` (`outbound` for every existing row, `inbound` for these calls), allows the `inbound` prompt kind in `ai_agent_prompts`, and creates `ai_test_phones` (per organization, strict E.164, unique). It changes `ai_calls` last, but that still locks the table for a moment: deploy when no AI call is live. No new variables are needed; `AI_VOICE_INBOUND` is optional. To look at the list without printing anything else (`$PUB` is a live credential, see the checklist step 4):

  ```bash
  echo "SELECT org_id, e164, label, created_at FROM ai_test_phones ORDER BY created_at;" | psql "$PUB"
  ```

  **Roll back:** set `AI_VOICE_INBOUND=off` (the list and the Testing page stay; only the inbound answering stops). The migration is additive: leave it in place, the previous build ignores the new column and table.
- **Owner check after deploy.** (1) Testing → add your own mobile with a label. (2) From that phone, call the AI number the page names: the agent answers with its inbound greeting. (3) Tell it a property address and a timeline, then hang up before it says goodbye: the call shows **In progress** for a few seconds, then appears under **Inbound calls** with those details and a status Claude chose from the transcript, and its **Transcript** opens. (4) Call again and let it finish: the badge reads its status. (5) From a phone that is **not** on the list, call the same number: it rings a rep as before. (6) Remove your phone, call again: it rings a rep as before.
