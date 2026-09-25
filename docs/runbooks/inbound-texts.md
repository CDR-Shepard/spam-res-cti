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
`backfill-texts.mjs` once it's back `on`, **for a rep's `agent` numbers only**
(see below — a `dialer_pool` text cannot be recovered this way).

## The backfill digest (one email per batch)

A `backfill-texts.mjs` run's rows never get an individual alert — once every
row in that run's batch reaches a terminal status, the worker sends ONE
digest email instead, tracked through `inbound_text_digests`:
`pending → sending → sent | failed | unknown`.

**Recovering a stuck digest:**
- **`failed`** (gave up after 3 tries, or a Salesforce auth error): fix the
  underlying problem (usually the rep needs to reconnect Salesforce), then
  requeue it — `UPDATE inbound_text_digests SET status='pending', attempts=0,
  next_attempt_at=now() WHERE batch_id='<id>'`. The next tick retries it.
- **`unknown`** (a timeout, network error, or 5xx from Salesforce while
  sending — deliberately never auto-retried, because the email may have gone
  out): **check the rep's inbox first.** Only requeue it (same UPDATE as
  above) once you've confirmed they did NOT already get it — a requeue after
  it actually sent duplicates the alert.

## Running the scripts

Both dry-run by default; read the plan before `--apply`. **Run
`set-sms-webhooks.mjs` only after the deploy AND migration `0044` are live**
— it points Twilio at the new webhook, so running it early sends texts to a
route that doesn't exist yet.
```bash
cd services/cti-api
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)

# Point every active number's Twilio SmsUrl at our webhook (one-time + after buying numbers)
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/set-sms-webhooks.mjs
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/set-sms-webhooks.mjs --apply

# Recover texts from before the webhook was set — REP'S OWN AGENT NUMBERS ONLY,
# never dialer_pool (a pool text's rep depends on the callback rules at the
# time, which can't be reconstructed after the fact). Pick --since AFTER the
# number's last reassignment to a different rep, or texts that arrived under
# the previous owner get credited to whoever holds the number today.
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01 --apply
```

**If `set-sms-webhooks.mjs --apply` needs undoing:** it writes a rollback
file before its first Twilio write — `./sms-webhooks-rollback-<ISO
timestamp>.json` by default, `--rollback-file <path>` to name it yourself.
Put every number back with:
```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/set-sms-webhooks.mjs --restore ./sms-webhooks-rollback-<...>.json           # dry run
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/set-sms-webhooks.mjs --restore ./sms-webhooks-rollback-<...>.json --apply    # writes
```
`--restore` never touches the database — only the file and Twilio — so it
still works if Postgres is unreachable. The dry run (both commands, and the
main run without `--apply`) also reports two safety checks before any write:
numbers whose Twilio `sms_application_sid` is set (Twilio ignores `SmsUrl`
there — "not covered", skipped) and numbers whose Twilio `phone_number`
doesn't match our own e164 for that row (a stale `twilio_sid` — "mismatched",
skipped).

## Inspecting the database (never select `body` casually — it's the private message)

```sql
SELECT status, count(*) FROM inbound_messages GROUP BY status ORDER BY status;
-- what's stuck
SELECT id, status, attempts, last_error, updated_at FROM inbound_messages
WHERE status IN ('pending','in_flight','failed') ORDER BY updated_at DESC LIMIT 50;

-- digests by status (see "Recovering a stuck digest" above for failed/unknown)
SELECT status, count(*) FROM inbound_text_digests GROUP BY status ORDER BY status;
-- one backfill batch: all rows terminal + no row yet in inbound_text_digests = digest due next tick
SELECT status, count(*) FROM inbound_messages WHERE backfill_batch = '<batch-id>' GROUP BY status;
SELECT status, attempts, last_error, sent_at FROM inbound_text_digests WHERE batch_id = '<batch-id>';
```
