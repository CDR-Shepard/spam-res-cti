# AI voice calls — operator runbook

Everything here is a human step. The design is `docs/superpowers/plans/2026-10-05-ai-voice-calls.md`; the code is `services/cti-api/src/ai-voice/`.

**Push:** see the session summary.

## 1. What it does

A rep (or admin) presses **AI call** on a Lead or Opportunity in the softphone. An AI voice agent phones the person over Twilio, talks to them through OpenAI's Realtime API, and:

- **Opens by saying it is an AI assistant** calling for the company, and that the call is recorded and transcribed. If anyone asks, it says it is an AI. It never claims to be human.
- **Qualifies** the seller: motivation, timeline, condition, price expectations, decision makers, occupancy. It **never makes an offer or names a price.**
- **Transfers to a person** if the seller wants one or is qualified: the call rings the record owner's softphone (or the rep who started the call if the owner is not mapped).
- **Honours "stop calling me"** immediately: it writes the number to the shared opt-out list, says goodbye, and hangs up. The CTI dialer respects the same list.
- **Leaves a voicemail** if a machine answers, and promises a callback if no person picks up the transfer within 25 seconds.
- Stores the text transcript, a summary, the qualification answers and the outcome. **No call audio is stored.**

**Hard rules the code enforces on every call:**

- No AI call without the **AI Call Consent** checkbox ticked on the Salesforce record. The one exception is an admin calling a number listed in `AI_VOICE_TEST_NUMBERS` (your own phones).
- Every call, test or not, also passes: `AI_VOICE=on`, `OUTREACH_KILL_SWITCH` not `on`, not opted out, not blocked, not on the federal DNC list, the FL/OK/WA/MD daily cap, the per-customer call ceiling, and the recipient's local calling hours 08:00 to 21:00. Test numbers skip the calling-hours check only.

## 2. Prerequisites

1. **OpenAI API key with Realtime access.** Realtime is a standard API feature, no waitlist.
   - Go to platform.openai.com, sign in, **Settings → Billing**: add a payment method and a small credit balance (start with $20).
   - Go to platform.openai.com → **API keys → Create new secret key**. Name it `cti-ai-voice`. Copy it once; OpenAI never shows it again.
   - **Never paste the key in chat, a commit, or a log line.**
2. **Anthropic API key (optional).** Only used for the post-call summary. Without it the summary is a plain line such as "AI call: no answer". Create one at console.anthropic.com → API keys if you want better summaries.
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

Then confirm the deploy is healthy:

```bash
railway logs --service @cti/api | tail -30
```

Expected: no "Invalid environment configuration" line. If you see one, a value is outside the accepted set in the table; fix it and the service redeploys.

## 4. Salesforce: consent fields and rep access

The org is alias `_t2` (`gghsd.my.salesforce.com`). **It is PRODUCTION.** Read `salesforce/README.md` first: never deploy with `-d force-app` or `-d force-app/main/default`, because that pushes stale `layouts/` snapshots over the live page layouts. Name the exact files, as below. Run from the repo root.

> If you already ran `docs/runbooks/outreach-sf-campaigns.md` §0, the six field files are already in the org (the deploy below shows `Unchanged`), and you only need steps 3 and 4.

1. **Validate first** (check-only, changes nothing). Expect `Status: Succeeded`:

   ```bash
   cd salesforce && sf project deploy validate -o _t2 --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml --source-dir force-app/main/default/permissionsets/AI_Call_Consent_Access.permissionset-meta.xml
   ```

2. **Deploy the same seven files.** Expect `Status: Succeeded` and seven `Created` rows (`Unchanged` on a rerun):

   ```bash
   cd salesforce && sf project deploy start -o _t2 --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml --source-dir force-app/main/default/permissionsets/AI_Call_Consent_Access.permissionset-meta.xml
   ```

3. **Assign `AI_Call_Consent_Access` to every rep** (every person who will press AI call, including you). The AI call reads `AI_Call_Consent__c` with the **rep's own** Salesforce login, so a rep without this permission set cannot start a consented AI call (they see "consent field missing"). One command per rep; replace the placeholder with the rep's Salesforce username:

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
3. Open the **AI calls** tab. The **Test AI call** box shows your number (prefilled from `AI_VOICE_TEST_NUMBERS`). If the tab or box is missing, AI voice is unavailable: recheck `OPENAI_API_KEY`, `AI_VOICE=on` and that `OUTREACH_KILL_SWITCH` is not `on`.
4. Press **Test AI call**. The row should go `ringing` within a few seconds and your phone should ring. The caller ID is one of your company's numbers.
5. **Answer and listen.** The first thing the agent says must be that it is an AI assistant calling for the company and that the call is recorded and transcribed. Fail the test if it does not say so.
6. **Talk to it** for a minute as a seller. Say you might sell, the house needs work, and you want about a certain amount. It should ask follow-up questions and must not name a price or make an offer.
7. **Test the transfer:** say "Can I talk to a real person?" Your phone should go quiet and the softphone you have open should ring as an incoming call showing an AI transfer. Answer it in the softphone and confirm audio both ways, then hang up. (The call goes to the rep who started it, because a test call has no record owner.)
8. **Test the opt-out:** start a second test call, answer, and say "Stop calling me." The agent should say a short goodbye and hang up within a few seconds. In the AI calls tab the outcome should read do not call. Start a **third** test call: it must be refused with a plain-words message about opt-out (`opted_out`). That proves the opt-out is live.
9. **Delete the test opt-out row** so your own number can be called again. Get the public database URL first. `$PUB` is a live credential: never print or share it:

   ```bash
   PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
   ```

   Then delete only the AI-call opt-out for your number. Replace `+15125550100` with your mobile:

   ```bash
   echo "DELETE FROM opt_outs WHERE e164 = :'num' AND source = 'ai_call' RETURNING id, e164, source, created_at;" | psql "$PUB" -v num='+15125550100'
   ```

   Expected: exactly one row returned. Zero rows means the opt-out was not written: stop and investigate (the AI "stop calling me" path is broken). Never run the delete without the `source = 'ai_call'` guard, or you could remove a real opt-out.

10. Open the first call in the AI calls tab and check the transcript and summary (§8). Smoke test passes when: disclosure heard, no price named, transfer rang the softphone, opt-out written and honoured, and the row was deleted.

## 6. A real, consent-gated call

1. In Salesforce, open a **Lead you own** whose phone number is one you are happy to call (a colleague or your own second number is best the first time).
2. Tick **AI Call Consent** on it. Set **AI Call Consent Source** to `Rep`. Save.
3. In the softphone, click-to-dial from that Lead so the softphone has the record, then press **AI call** beside the normal call button.
4. The row appears in the AI calls tab. If it is refused, the message says why in plain words:

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

   Other errors: `record_not_found` (bad record), `salesforce_error` (your Salesforce login could not read the record), `twilio_error` (Twilio refused to place it), `gate_error` (a safety check failed to run, so the call was refused).

## 7. Where callers end up

- **Transfer:** the call rings the **Salesforce record owner's** softphone if that owner is mapped to a CTI user. Otherwise it rings the rep who started the AI call. The transferring rep sees the prospect's number and name and an "AI transfer" reason.
- **If nobody answers the transfer within 25 seconds,** the caller hears that a specialist will call them right back, and the call ends with outcome `transfer_failed`; the call row says to call them back. A callback Task in Salesforce is created for the rep.
- **The callback number** the agent gives the caller is the number it called from (the caller-ID number Twilio dialled out on), so a caller who phones back reaches the normal inbound path.

## 8. Reading the results

- **AI calls panel (softphone → AI calls):** the 20 most recent calls (admins see everyone's, reps see their own) with status, outcome, duration, summary and an expandable **transcript**. It refreshes every few seconds while a call is live.
- **Transcript:** lines from the agent and the caller. Anything the agent was cut off from saying (for example by voicemail or a transfer) is shown as `[not played]`.
- **Statuses:** `queued`, `ringing`, `in_progress`, `transferring` are live; `transferred`, `completed`, `failed`, `blocked` are final.
- **Outcomes:** qualified and transferred, qualified with callback, do not call, wrong number, voicemail, no answer, busy, hung up, failed, blocked.
- **Salesforce Task:** after a real (non-test) call on a Lead or Opportunity you own, a Task titled `AI call: <outcome>` is logged on the record with the summary, the qualification answers, and the CTI call id. Test calls log no Task.
- **Qualification answers** are on the call row and in the Task description: motivation, timeline, condition, price expectations, decision makers, occupancy.

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
- **A lost Twilio status callback leaves a call row non-final** (no end time, status stuck on `in_progress` or `ringing`). Twilio does not retry. If you see a row that never finishes, check the Twilio console for the call, and leave the row; it does not block anything except that the same number cannot be called again for up to an hour (`call_in_progress`).
- **Transfers ring the record owner if mapped, else the rep who started the call.** If that person's softphone is not open and registered, nobody answers and the 25-second callback path runs.
- **No call audio is stored,** only text transcripts and summaries. If you need recordings for compliance, that is a separate build.
- **Same-number duplicate check is not atomic.** Two simultaneous starts to one number could both go through. The UI and the rate limit (10 AI call starts per minute per rep) make this very unlikely.
- **Untested against a live carrier until your smoke test:** the transfer caller ID, call time limit extension, and the voicemail voice are only exercised for real in §5. Run the smoke test after every deploy that touches `services/cti-api/src/ai-voice/`.

## 12. Costs

Per minute of conversation:

| Part | Cost |
|---|---|
| OpenAI realtime (`gpt-realtime-2.1`) | about $0.10 per minute |
| Twilio outbound call (US) | about $0.014 per minute |
| Twilio Media Streams | about $0.0044 per minute |
| Twilio answering-machine detection | $0.0075 per **call** |

So about **$0.12 per minute plus $0.0075 per call**. The 10-minute cap makes the worst case about $1.30 per call, and a typical qualifying call of 3 minutes is about $0.40. A call that rings out costs about $0.01. Summaries with a Haiku-class model are a fraction of a cent. Check real spend on platform.openai.com → **Usage** after your first day, and set a monthly spend limit under **Settings → Limits**.

## 13. Legal notes

- **AI calls only to people with the consent checkbox ticked.** The checkbox is the record that the person agreed to calls from an AI assistant. Tick it only when they actually did (a reply, a web form, an inbound call, or a rep confirming on the phone) and record the source.
- **Disclosure at the start of every call.** The agent says it is an AI assistant and that the call is recorded and transcribed. Do not change the prompt to remove it.
- **Do-not-call is honoured everywhere.** An opt-out, blocked number, or federal DNC listing stops the AI call, and "stop calling me" on an AI call adds the number to the shared opt-out list the dialer also uses.
- **Consult counsel on state-specific rules.** Federal and state laws on AI and artificial-voice calls, call recording and two-party consent, and telemarketing hours differ by state and are changing. Have your attorney confirm the disclosure wording, the consent capture wording and which states you may AI-call before you scale up. This runbook is operations guidance, not legal advice.
