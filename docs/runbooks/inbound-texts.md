# Inbound texts → Salesforce Task + email alert

Design: `docs/superpowers/specs/2026-09-25-inbound-texts-design.md`. Code:
`routes/inbound-sms.ts` + `sms/inbound-text.ts` (pure rules) +
`sms/inbound-text-worker.ts` (Task/email/digest). Migration `0044`.

## What happens to a text

Twilio POSTs to `/telephony/twilio/sms`, signature-checked like
`/telephony/twilio/inbound`. The row is stored (`inbound_messages`, idempotent
on `MessageSid`) and Twilio gets an empty `<Response/>` at once — never an
auto-reply. The worker (5s tick) matches the sender (`findByPhone`, the rep's
own Salesforce connection), creates a Task once (Subject `Text from <name>`,
**no `Status`** — org default applies), and emails the rep once. An unmatched
sender still gets an unlinked Task; a Task that permanently fails still gets
the alert, marked "could not be logged".

**Routing:** agent DID → its assigned rep. `dialer_pool` DID → the callback
rules (sticky rep who last talked to this number, else who last dialed it).
No match → `status='skipped'`, no Task, no email — the text is still stored.

## The email

Sent via Salesforce `emailSimple`, **as the rep**, to the rep's own
`User.Email`: sender, which of the rep's numbers it came to, the time
(Pacific), the message quoted `> like this`, and a Salesforce link.
**Flood guard:** at most one email per rep per sender number per hour — a
later text in that hour still gets its Task, just no alert
(`email_skip_reason` says why). **Exception:** a text that could not be
logged (no Task) always alerts, even inside the guard hour — that email is
its only trace of the text.

## Opt-outs

`STOP`/`STOPALL`/`UNSUBSCRIBE`/`CANCEL`/`END`/`QUIT` (whole message, any case)
appends `— asked to STOP` to the Task and email subjects. **No automatic
Do-Not-Call write** — that's a policy decision for the business owner.

## Kill switch

`INBOUND_TEXTS=off` on `@cti/api`: the webhook still answers Twilio (never an
error a texter sees) but **stores nothing**, and the worker loop never starts.
Twilio keeps the text regardless — recover anything missed while off with
`backfill-texts.mjs` once it's back `on`.

## Running the scripts

Both dry-run by default; read the plan before `--apply`.
```bash
cd services/cti-api
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
# Point every active number's Twilio SmsUrl at our webhook (one-time + after buying numbers)
DATABASE_PUBLIC_URL=$PUB railway run -s @cti/api node scripts/set-sms-webhooks.mjs
DATABASE_PUBLIC_URL=$PUB railway run -s @cti/api node scripts/set-sms-webhooks.mjs --apply
# Recover texts from before the webhook was set, or from an INBOUND_TEXTS=off window
DATABASE_PUBLIC_URL=$PUB railway run -s @cti/api node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01
DATABASE_PUBLIC_URL=$PUB railway run -s @cti/api node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01 --apply
```

## Inspecting `inbound_messages` (never select `body` casually — it's the private message)

```sql
SELECT status, count(*) FROM inbound_messages GROUP BY status ORDER BY status;
-- what's stuck
SELECT id, status, attempts, last_error, updated_at FROM inbound_messages
WHERE status IN ('pending','in_flight','failed') ORDER BY updated_at DESC LIMIT 50;
-- one backfill batch: all terminal + no row in inbound_text_digests = digest due next tick
SELECT status, count(*) FROM inbound_messages WHERE backfill_batch = '<batch-id>' GROUP BY status;
SELECT * FROM inbound_text_digests WHERE batch_id = '<batch-id>';
```
