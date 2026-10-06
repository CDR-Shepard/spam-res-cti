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

## 14. Legal notes

- **AI calls only to people with the consent checkbox ticked.** The checkbox is the record that the person agreed to calls from an AI assistant. Tick it only when they actually did (a reply, a web form, an inbound call, or a rep confirming on the phone) and record the source.
- **Disclosure at the start of every call.** The agent says it is an AI assistant calling for the company on a recorded line. Do not change the prompt to remove it.
- **Do-not-call is honoured everywhere.** An opt-out, blocked number, or federal DNC listing stops the AI call, and "stop calling me" on a real AI call adds the number to the shared opt-out list the dialer also uses (a test or practice call to an admin's own phone records it without opting that phone out).
- **Consult counsel on state-specific rules.** Federal and state laws on AI and artificial-voice calls, call recording and two-party consent, and telemarketing hours differ by state and are changing. Have your attorney confirm the disclosure wording, the consent capture wording and which states you may AI-call before you scale up. This runbook is operations guidance, not legal advice.

## 15. Appointments and `book_appointment` (plan 1D)

- **When it is offered.** Only when the trigger carries appointment times (`target.slots`), which outreach-api computes at the moment of the call from the appointment owner's Salesforce calendar (the first active user on the AI calls card's "Appointments go to" list; production: Grant Golden). With no times, the agent has no `book_appointment` tool, no booking section and no `appointment_set` outcome: it behaves exactly as before 1D. Times are never part of the plan text; cti-api renders them in their own section, after the plan.
- **What it offers.** Up to two times at a time from at most six per kind (two a day): a **phone call** (15 minutes, Mon–Fri, starts every 30 minutes 10:00–17:30 PT, at least 2 hours ahead, 2 business days) and an **in-person walkthrough** (60 minutes, starts on the hour 9:00–16:00 PT, at least 20 hours ahead, 5 business days, 30 minutes' travel buffer). The card's settings change these. Times are said in the seller's zone (the number dialed; on a practice call, the record's phone), with the specialist's own time added only when it differs.
- **Holidays are not modelled.** Only an **all-day Event** on the owner's calendar blocks a day. Put company holidays on the owner's calendar as all-day Events.
- **Walkthrough address rule.** Before booking a walkthrough the agent confirms the property address with the seller (`address_confirmed: true`). If it is a different property it does not book a walkthrough: it offers the phone call instead (or a callback when only walkthroughs are on offer).
- **Booking.** `book_appointment` takes an offered `slot_id` (p1–p9, w1–w9). It is refused, and the agent offers the other time, when another AI call already holds that owner's time (overlap, a walkthrough's buffer included; test and practice bookings never block a real one). It stores `ai_calls.appointment` and sets the outcome **`appointment_set`** ("Appointment set") at once.
- **What keeps it.** A booked call keeps `appointment_set` if the caller hangs up, the line goes quiet, or the call hits its time limit. A transfer after booking keeps the booking (`qualified_transferred` / `transfer_failed`; the rep can cancel). "Stop calling me", wrong number, or an `end_call` with another decision (not interested, a callback instead) replaces it and frees the time. `end_call(appointment_set)` with nothing stored is recorded as a callback with the line "The agent ended as booked, but no appointment was saved — call them back."
- **Salesforce.** cti-api never writes the appointment to Salesforce. outreach-api's write-back creates the Event (and converts a Lead) after the call: `outreach-sf-campaigns.md` §Appointments and Salesforce write-back.
- **Deploy order.** Migration `0055_ai_call_booking.sql` must be applied before the new `@cti/api` runs: every `ai_calls` insert writes `offered_slots` and `practice`. Deploy `@cti/api` before or together with outreach-api (one commit): its trigger contract is strict, and an old `@cti/api` answers `HTTP 400 invalid_body` to a trigger carrying `context` or slots with `blockStart`/`blockEnd`. That trigger is retried with the same key, so the window is safe.

## 16. Practice calls (plan 1D)

An admin can ring their own test number **as if it were a real seller**: outreach-web → the campaign → a card on the **Call plans** board (proposed or approved plan) → pick a **Test number** → **Practice call to my phone**. "You'll hear exactly what the seller would hear. Nothing is written to Salesforce."

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

