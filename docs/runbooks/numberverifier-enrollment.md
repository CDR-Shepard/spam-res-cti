# NumberVerifier enrollment

## Why

The webhook (`POST /integrations/numberverifier/webhook`, `services/cti-api/src/routes/integrations.ts`) has been live in prod since June 2026 and the server correctly validates it — `NUMBERVERIFIER_VERIFY_KEY` is set, requests are checked against the `x-verifykey` header. But **zero rows in `outbound_numbers` have ever had `health_source = 'numberverifier'`**. All 28 active, non-degraded numbers sit at `health = 'unknown'`.

The integration is webhook-only: nothing in this codebase calls NumberVerifier's API (`NUMBERVERIFIER_API_KEY` is not set, and no code references it outbound). NumberVerifier only POSTs to us for numbers it has been told, in its own dashboard, to monitor. The webhook has never fired because no one has ever enrolled a number. This runbook is that missing manual step.

## Generate the list

Run this from `services/cti-api` against prod, read-only:

```bash
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
env DATABASE_URL="$PUB" npx tsx scripts/nv-enrollment-manifest.ts
```

`PUB` holds a live DB credential — never print it or paste it anywhere. If you need to eyeball the output instead of redirecting it to a file, strip connection strings on the way out:

```bash
env DATABASE_URL="$PUB" npx tsx scripts/nv-enrollment-manifest.ts | grep -vE 'postgres://|postgresql://'
```

The script prints one CSV row per active number — `e164,kind,label,enrolled` — plus a one-line stderr summary. Every `enrolled=no` row is a dashboard to-do: NumberVerifier has never reported on that number.

## Enroll

For each `enrolled=no` row:

1. Log into `app.numberverifier.com`.
2. Open the **GG Homes** campaign.
3. Add the number (by its `e164` from the manifest).
4. On the campaign's Webhooks page, set the webhook URL to:
   ```
   https://ctiapi-production.up.railway.app/integrations/numberverifier/webhook
   ```
   and set the webhook secret to the account's verify key — this must match `NUMBERVERIFIER_VERIFY_KEY` as configured on `@cti/api` in Railway, since the server checks that value against the `x-verifykey` header on every incoming POST.

Repeat for every number on the list. Adding a number to the campaign does not itself flip `enrolled`; that only happens once NumberVerifier actually reports a check result via the webhook.

## Prove it

Use **Send Test Webhook** on the dashboard's Webhooks page with one enrolled
number. The success response body comes from OUR server
(`services/cti-api/src/routes/integrations.ts`) and is the proof:

```json
{"ok":true,"phone":"+1…","flagged":false,"health":"healthy","matched":1,"changed":0}
```

`matched: 1` means the verify key was accepted, the payload parsed, and the
number was found in `outbound_numbers` — the pipe is live end to end.

`changed: 0` on a clean result is CORRECT, not a failure: the handler is
deliberately conservative and never writes a clean carrier check over a
number it didn't park itself (`health_source` stays untouched), so the
manifest's `enrolled` column only flips once NumberVerifier actually FLAGS
a number (or clears one it previously flagged). Do not "force checks" hoping
to flip `enrolled` on healthy numbers — it cannot happen by design.

Gate **NV-1** = the `matched: 1` test response above, verified 2026-08-25
(all 221 fleet numbers enrolled in the Res-CTI campaign; a real flag now
pulls the number from rotation and posts to Slack via ALERT_WEBHOOK_URL).

## If we get an API key

If NumberVerifier ever issues an API key for programmatic enrollment, set `NUMBERVERIFIER_API_KEY` on `@cti/api` and file an issue to automate this runbook (bulk-enroll on number purchase, dedupe already-enrolled numbers, etc.). Do not build that automation speculatively — until the key exists, enrollment stays a manual dashboard step and this runbook is the process.
