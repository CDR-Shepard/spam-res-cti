# AI voice calls — operator runbook

**First call checklist** (the minimum to hear the AI on your own phone):

1. On Railway service `@cti/api`, set `OPENAI_API_KEY` and `AI_VOICE_TEST_NUMBERS=<your mobile, E.164>` (§3).
2. Push the branch to `main` (the default branch `@cti/api` deploys from).
3. Wait for the `@cti/api` deploy to show **Success** (dashboard → `@cti/api` → Deployments). It also serves the softphone.
4. Open the softphone as an **admin** → **AI calls** on the bottom bar → **Test AI call** box → pick your number → **Start test call**.
5. Answer. The first sentence must say it is an AI assistant on a recorded line. No Salesforce step is needed for a test call.

Everything here is a human step. The design is `docs/superpowers/plans/2026-10-05-ai-voice-calls.md`; the code is `services/cti-api/src/ai-voice/`.

## 1. What it does

An admin presses **AI call** on a Lead or Opportunity in the softphone (or starts a test call to their own phone). The code also accepts Contacts, but the consent field is deployed only on Lead and Opportunity, so a Contact is refused with `consent_field_missing`. An AI voice agent phones the person over Twilio, talks to them through OpenAI's Realtime API, and:

- **Opens by saying it is an AI assistant** calling for the company, on a recorded line (the text transcript is kept). If anyone asks, it says it is an AI. It never claims to be human.
- **Qualifies** the seller: motivation, timeline, condition, price expectations, decision makers, occupancy. It **never makes an offer or names a price.**
- **Transfers to a person** if the seller wants one or is qualified: the call rings the record owner's softphone (or the rep who started the call if the owner is not mapped).
- **Honours "stop calling me"** immediately: it writes the number to the shared opt-out list, says goodbye, and hangs up. The CTI dialer respects the same list.
- **Leaves a voicemail** if a machine answers, and promises a callback if no person picks up the transfer within 25 seconds.
- Stores the text transcript, a summary, the qualification answers and the outcome. **No call audio is stored.**

**v1: AI calls are admin-initiated.** A rep's click-to-dial places the human call as soon as the firewall check clears, so the rep never gets the screen the **AI call** button sits on. Admins get that screen (and the **Test AI call** box). Reps see an **AI calls** tab with their own AI calls while AI calling is on.

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

Set on service `@cti/api` (never on outreach-api). Link the CLI first if you have not:

```bash
railway link
```

Pick project `endearing-comfort`. Setting a variable on a linked service redeploys it; if no deploy starts, use dashboard **@cti/api → Deployments → ⋯ on the latest deployment → Redeploy**. Migration `0050_ai_calls.sql` runs in the pre-deploy step; expect the deploy log to show it applied.

| Variable | Value to set | Unset means |
|---|---|---|
| `OPENAI_API_KEY` | the key from §2.1 (secret) | **AI voice is switched off** (`available: false`, no AI call is placed or answered) |
| `AI_VOICE` | `on` or `off` | `on`. `off` is the kill switch (§9). Only `on` / `off` are accepted; `true`, `1`, `false` stop the service booting |
| `AI_VOICE_TEST_NUMBERS` | your mobile(s), E.164, comma-separated: `+15125550100,+15125550101` | no test numbers; "Test AI call" cannot be used |
| `AI_VOICE_VOICE` | `marin` | `marin` |
| `AI_VOICE_MODEL` | `gpt-realtime-2.1` | `gpt-realtime-2.1` |
| `AI_VOICE_REASONING` | `minimal`, `low`, `medium` or `high` | `low`. Only sent for `gpt-realtime-2*` models |
| `AI_VOICE_VAD_EAGERNESS` | `low`, `medium`, `high` or `auto` | `auto` |
| `AI_VOICE_AGENT_NAME` | the first name the agent gives, for example `Alex` | `Alex` |
| `AI_VOICE_MAX_CALL_SECONDS` | hard cap on one call, in seconds | `600` (10 minutes) |
| `ANTHROPIC_API_KEY` | optional key from §2.2 (secret) | summaries use the plain fallback |
| `AI_SUMMARY_MODEL` | model for summaries | `claude-haiku-4-5-20251001` |
| `OUTREACH_KILL_SWITCH` | leave unset (or `off`) | `off`. `on` stops all outreach including AI calls |

Set the required two now (replace the placeholders; do not echo the real key anywhere):

```bash
railway variables --set "OPENAI_API_KEY=sk-..." --service @cti/api
```

```bash
railway variables --set "AI_VOICE_TEST_NUMBERS=+15125550100" --service @cti/api
```

Confirm the names landed (this prints names and values, so do not share the output):

```bash
railway variables --service @cti/api --kv | grep -E '^(AI_VOICE|OPENAI_API_KEY)' | cut -d= -f1
```

Expected: `OPENAI_API_KEY`, `AI_VOICE_TEST_NUMBERS` (plus any other `AI_VOICE*` you set).

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

3. **Assign `AI_Call_Consent_Access` to every rep** (every person who will press AI call — in v1 the admins, including you). The AI call reads `AI_Call_Consent__c` with the **rep's own** Salesforce login, so a rep without this permission set cannot start a consented AI call (they see "consent field missing"). One command per rep; replace the placeholder with the rep's Salesforce username:

   ```bash
   sf org assign permset -n AI_Call_Consent_Access -o _t2 -b rep@example.com
   ```

   You can repeat `-b <username>` in one command to cover several reps. Alternative in the browser: Setup → Permission Sets → **AI Call Consent Access** → **Manage Assignments** → **Add Assignments**.

4. **Check.** On any Lead, Setup → Object Manager → Lead → Fields shows `AI Call Consent`, `AI Call Consent Date` and `AI Call Consent Source`.

5. **Optional, in Setup only:** show the three fields on the Lead and Opportunity page layouts so reps can see and tick them. **Do not deploy layouts from the repo** (`salesforce/README.md`).

The consent source picklist (`Text Reply`, `Email Reply`, `Web Form`, `Inbound Call`, `Rep`) is written by code. Do not rename its values. A rep who ticks the box themselves should set the source to `Rep`.

## 5. Morning smoke test (about 15 minutes)

Do this on your own mobile before any real prospect. A test call needs no Salesforce record and no consent tick. Only an admin can place one, and only to a number in `AI_VOICE_TEST_NUMBERS`.

1. Confirm §3 is done and the deploy is healthy. `AI_VOICE_TEST_NUMBERS` must contain your mobile.
2. Open the CTI softphone and sign in as an **admin**. Keep it open and allow the microphone; the transfer test rings it.
3. Tap **AI calls** on the bottom bar (sparkle icon, after Recent). The top box, **Test AI call**, has one quick button per number in `AI_VOICE_TEST_NUMBERS` (shown like `+1 (512) 555-0100`), a number field prefilled with the first one, and a **Start test call** button.
   - No **AI calls** tab at all: the running `@cti/api` deploy does not have the AI routes yet. Check that the deploy finished.
   - A red line "AI calling is turned off — new AI calls will be refused.": recheck `OPENAI_API_KEY`, `AI_VOICE=on` and that `OUTREACH_KILL_SWITCH` is not `on`.
   - "No test numbers are set (AI_VOICE_TEST_NUMBERS), so a test call will be refused.": set `AI_VOICE_TEST_NUMBERS` (§3).
4. Tap your number's quick button (or type it), then **Start test call**. Expect the green line "Calling +1 (512) 555-0100 — answer your phone." A new row appears at the top with the chip **Calling…**, then **In progress** once you answer. Your phone should ring within a few seconds; the caller ID is one of your company's numbers. A refusal shows the reason in red, in plain words.
5. **Answer and listen.** The first thing the agent says must be that it is an AI assistant calling for the company, on a recorded line. Fail the test if it does not say so.
6. **Talk to it** for a minute as a seller. Say you might sell, the house needs work, and you want about a certain amount. It should ask follow-up questions and must not name a price or make an offer.
7. **Test the transfer:** say "Can I talk to a real person?" Your phone should go quiet and the softphone you have open should ring as an incoming call; under the name and number the ring screen shows **"AI transfer — asked for a person"**. Answer it in the softphone and confirm audio both ways, then hang up. The row goes **Transferring**, then **Transferred**. (The call goes to the person who started it, because a test call has no record owner.)
8. **Test the opt-out:** start a second test call, answer, and say "Stop calling me." The agent should say a short goodbye and hang up within a few seconds. In the AI calls tab the row's outcome should read **Do not call**. Start a **third** test call: it must be refused with "This number asked not to be called (it is on the opt-out list)." That proves the opt-out is live.
9. **Delete the test opt-out row** so your own number can be called again. Get the public database URL first. `$PUB` is a live credential: never print or share it:

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

   Expected: exactly one row returned. Zero rows means either the opt-out was not written (the AI "stop calling me" path is broken: stop and investigate), or your number already had an opt-out from another source, which the AI call does not overwrite. Never run the delete without the `org_id` and `source = 'ai_call'` guards, or you could remove a real opt-out.

10. Tap the first call's row in the AI calls tab to expand its transcript, and read its summary (§8). Smoke test passes when: disclosure heard, no price named, transfer rang the softphone, opt-out written and honoured, and the row was deleted.

## 6. A real, consent-gated call

Admins only in v1 (§1).

1. In Salesforce, open a **Lead you own** whose phone number is one you are happy to call (a colleague or your own second number is best the first time). An Opportunity works the same way.
2. Tick **AI Call Consent** on it. Set **AI Call Consent Source** to `Rep`. Save.
3. Click the phone number on that Lead (click-to-dial). While AI calling is on, the dial screen shows a box under the verdict panel's Cancel / **Call now** row: "Let the AI assistant call" plus the record's name, with an **AI call** button. It is disabled while the firewall check or a human call is in flight. Do not press Call now.
4. Press **AI call**. On success the dial screen clears, the softphone switches to the **AI calls** tab with a green "AI call started — follow it here.", and the row appears at the top. If it is refused, the reason shows in red under the button, in plain words:

   | Reason code | What it means and what to do |
   |---|---|
   | `no_consent` | **AI Call Consent** is unticked on that record. Tick it only if the person really agreed |
   | `consent_field_missing` | You do not have the consent fields: assign `AI_Call_Consent_Access` (§4 step 3), or the fields are not deployed |
   | `ai_voice_unavailable` | Kill switch is on or `OPENAI_API_KEY` is unset (§3, §9) |
   | `no_phone` / `invalid_number` | The record has no usable phone number |
   | `opted_out` / `blocked` / `dnc` | The number is on the opt-out, blocked, or federal do-not-call list. Do not override |
   | `daily_cap` / `customer_ceiling` | A daily state cap or the per-customer call limit is reached |
   | `calling_hours` | Outside 08:00 to 21:00 in the person's local time |
   | `no_caller_id` | No outbound number available for this call |
   | `not_admin_for_test` | Only admins can place test calls |
   | `call_in_progress` | That number is already on a live AI call |

   Other errors:

   | HTTP | Code | Meaning |
   |---|---|---|
   | 400 | `invalid_body` | The request was malformed (not a Lead / Opportunity / Contact id, or a bad test number) |
   | 404 | `record_not_found` | Salesforce could not find the record, or you cannot see it |
   | 429 | (rate limited) | More than 10 AI call starts in one minute by the same person. Wait a minute |
   | 502 | `salesforce_error` | Your Salesforce login could not read the record |
   | 502 | `twilio_error` | Twilio refused to place the call (the row is marked failed) |
   | 503 | `gate_error` | A safety check failed to run, so the call was refused |

## 7. Where callers end up

- **Transfer:** the call rings the **Salesforce record owner's** softphone if that owner has connected Salesforce in the CTI (so is mapped to a CTI user). Otherwise it rings the person who started the AI call. It rings through the normal incoming path: the caller ID is the prospect's number, the record screen-pops on Answer, and the ring screen shows **"AI transfer — "** followed by the reason, one of: interested, wants an offer, asked for a person, legal or complex question, has a question.
- **If nobody answers the transfer within 25 seconds,** the caller hears "Sorry, our specialist just stepped away — they'll call you right back. Thanks!" and the call ends. The outcome reads **Transfer missed — callback promised**, and the summary carries the line "Transfer to a specialist did not connect — call them back."
- **Callback Task (Salesforce):** a promised call back — a missed transfer, or a callback the person asked for (**Callback requested**) — gets an **Open** Task on the record for the hand-off person (the record owner), created with their own Salesforce login. If their Salesforce connection is gone, the starter creates it and assigns it to them (`OwnerId`); if neither works, it is the starter's own Task. Subject `AI call: callback requested` (missed transfer: dated today, and the description adds "The caller was promised a call back.") or `AI call: callback <when>` (asked-for callback: `<when>` is what the person said, or "Wed, Oct 7, 5:00 PM" in their time zone for an exact time; dated that day). If the org refuses the Open status, the Task is made Completed instead. Not for test calls, and only on records the Task's author may write to (§8).
- **The callback number** the agent gives the caller is the number it called from (the caller-ID number Twilio dialled out on), so a caller who phones back reaches the normal inbound path. It is not given on emergencies, threats or abuse, do-not-call goodbyes, or after they hang up.

## 8. Reading the results

- **AI calls panel (softphone → AI calls):** the 20 most recent calls (admins see everyone's, reps see their own). Each row: status chip, the number, a grey **Test** chip for test calls, the start time, and the duration once ended; below it the outcome in words (for a blocked row, the block reason), and the summary. Tap a row to expand its **transcript**. **Refresh** is top right. It refreshes every 4 s while a call is live (or ended less than 20 s ago), otherwise every 30 s, and not while the page is hidden.
- **Transcript:** **AI:** and **Caller:** lines. Anything the agent was cut off from saying (for example by voicemail or a transfer) is shown in grey as `[not played] …`.
- **Status chips:** **Calling…**, **In progress**, **Transferring** are live; **Transferred**, **Completed**, **Failed**, **Blocked** are final. A finished call can still move from Completed to Transferred once, a few seconds later, when the transfer result arrives.
- **Outcome words:** Transferred to rep, Callback requested, Not interested, Do not call, Left voicemail, No answer, Busy, Failed, Wrong number, Hung up, Transfer missed — callback promised, Blocked, Other.
- **Summary:** a few seconds after the call ends, the agent's notes are replaced by 2–4 sentences (Claude when `ANTHROPIC_API_KEY` is set and the caller spoke), then any "Callback requested: …" / "Transfer to a specialist did not connect …" lines, a blank line, a **Qualification:** block (`- Motivation: …`, only what was captured), `Outcome: <words>` and `AI call id: <id>`.
- **Salesforce call Task:** after a real (non-test) call that was placed, ONE completed Call Task on the record, created as the person who started the call. Only when they have connected Salesforce in the CTI and may write on the record (the power dialer's rule: they own it, are the Opportunity's lead manager, or it is queue-owned). Subject `AI call: <outcome words>` (for example `AI call: Callback requested`), Call Result the matching disposition (Connected, Left voicemail, No answer, Busy, Wrong number, Do not call, Failed), description = the summary plus `Transcript in CTI: AI call <id>`. No call duration: AI talk time is not rep talk time. Test calls log no Task. A promised call back also gets the callback Task (§7).
- **Call history:** placed AI calls also appear in the starter's own call history with the disposition already filled in (no wrap-up prompt) and 0 talk seconds. They count toward the daily state cap and the per-customer ceiling like any dial.
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

## 10. Tuning

Set any of these with `railway variables --set "NAME=value" --service @cti/api`. Each change redeploys and applies to **new calls**.

- **Voice, `AI_VOICE_VOICE`:** `marin` (default) or `cedar` are OpenAI's highest-quality voices. Other OpenAI realtime voices (for example `alloy`, `ash`, `coral`, `sage`, `verse`) also work. Try two on your own phone with Test AI call and pick one.
- **Model, `AI_VOICE_MODEL`:** default `gpt-realtime-2.1`. A cheaper "mini" realtime model costs roughly a third as much with some loss in quality. If the model name is wrong, calls fail on connect and show `failed`.
- **Reasoning, `AI_VOICE_REASONING`:** `low` default. `minimal` answers fastest; `medium` / `high` think longer and add delay. Only applies to `gpt-realtime-2*` models.
- **Interruptions, `AI_VOICE_VAD_EAGERNESS`:** how quickly the agent decides you have finished talking. `low` waits longer (use if it cuts people off), `high` replies sooner (use if it feels slow), `auto` default.
- **Agent name, `AI_VOICE_AGENT_NAME`:** the first name it gives (default `Alex`).
- **Call length, `AI_VOICE_MAX_CALL_SECONDS`:** default `600`. After a transfer the call is not cut at this limit.

## 11. Known limits

- **cti-api must run exactly one replica.** Live calls are tracked in memory in one process. A call answered by a different replica, or after a restart, has no state: it is hung up and shown as `failed`. `.railway/railway.ts` already pins one replica; do not scale `@cti/api` up. Avoid redeploying during a live call.
- **A lost Twilio status callback is repaired by a sweeper.** Every 2 minutes it finalizes, from Twilio's own call record, any placed call still open after 3 minutes (a row that never placed a call is marked failed after 10 minutes). The sweeper only runs while AI voice is available; rows left open while `AI_VOICE` is off wait until it is back on.
- **Transfers ring the record owner if mapped, else the rep who started the call.** If that person's softphone is not open and registered, nobody answers and the 25-second callback path runs.
- **No call audio is stored,** only text transcripts and summaries. If you need recordings for compliance, that is a separate build.
- **Same-number duplicate check is not atomic.** Two simultaneous starts to one number could both go through. The UI and the rate limit (10 AI call starts per minute per person) make this very unlikely.
- **Untested against a live carrier until your smoke test:** the transfer caller ID, call time limit extension, and the voicemail voice are only exercised for real in §5. Run the smoke test after every deploy that touches `services/cti-api/src/ai-voice/`.

## 12. Costs

Per minute of conversation:

| Part | Cost |
|---|---|
| OpenAI realtime (`gpt-realtime-2.1`) | about $0.10 per minute |
| Twilio outbound call (US) | about $0.014 per minute |
| Twilio Media Streams | about $0.0044 per minute |
| Twilio answering-machine detection | $0.0075 per **call** |

So about **$0.12 per minute plus $0.0075 per call** ($0.10 + $0.014 + $0.0044 = $0.1184). The 10-minute cap makes the worst case about **$1.20** per call (10 × $0.1184 + $0.0075 ≈ $1.19), and a typical qualifying call of 3 minutes is about $0.36. A call that rings out costs about $0.01. Summaries with a Haiku-class model are a fraction of a cent. Check real spend on platform.openai.com → **Usage** after your first day, and set a monthly spend limit under **Settings → Limits**.

## 13. Legal notes

- **AI calls only to people with the consent checkbox ticked.** The checkbox is the record that the person agreed to calls from an AI assistant. Tick it only when they actually did (a reply, a web form, an inbound call, or a rep confirming on the phone) and record the source.
- **Disclosure at the start of every call.** The agent says it is an AI assistant calling for the company on a recorded line. Do not change the prompt to remove it.
- **Do-not-call is honoured everywhere.** An opt-out, blocked number, or federal DNC listing stops the AI call, and "stop calling me" on an AI call adds the number to the shared opt-out list the dialer also uses.
- **Consult counsel on state-specific rules.** Federal and state laws on AI and artificial-voice calls, call recording and two-party consent, and telemarketing hours differ by state and are changing. Have your attorney confirm the disclosure wording, the consent capture wording and which states you may AI-call before you scale up. This runbook is operations guidance, not legal advice.
