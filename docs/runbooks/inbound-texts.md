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
**no `Status`**), and emails the rep once via `emailSimple` **as the rep**:
sender, the time (Pacific), the message quoted `> like this`, a Salesforce
link. An unmatched sender still gets an unlinked Task; a Task that
permanently fails still gets the alert, marked "could not be logged".

**Routing:** agent DID → its assigned rep. `dialer_pool` DID → the callback
rules (sticky rep who last talked to this number, else who last dialed it).
No match → `status='skipped'`, no Task, no email — the text is still stored.

**Flood guard:** at most one email per rep per sender number per hour — a
later text in that hour still gets its Task, just no alert
(`email_skip_reason` says why). A text that could not be logged (no Task)
always alerts, even inside the guard hour — that email is its only trace.

**Opt-outs:** `STOP`/`STOPALL`/`UNSUBSCRIBE`/`CANCEL`/`END`/`QUIT` (whole
message, any case) appends `— asked to STOP` to the Task/email subjects.
**No automatic Do-Not-Call write** — a policy decision for the business owner.

**Kill switch:** `INBOUND_TEXTS=off` on `@cti/api` — the webhook still
answers Twilio (never an error a texter sees) but **stores nothing**, and
the worker loop never starts. Recover anything missed with
`backfill-texts.mjs` once it's back `on`, **agent numbers only** (never
`dialer_pool` — see below).

## The backfill digest, and recovering a stuck one

A `backfill-texts.mjs` run's rows never get an individual alert — once every
row in the batch reaches a terminal status, the worker sends ONE digest
instead, tracked through `inbound_text_digests`:
`pending → sending → sent | failed | unknown`.

- **`failed`** (gave up after 3 tries, or a Salesforce auth error): fix the
  underlying problem (usually the rep needs to reconnect Salesforce), then
  requeue — `UPDATE inbound_text_digests SET status='pending', attempts=0,
  next_attempt_at=now() WHERE batch_id='<id>'`. The next tick retries it.
- **`unknown`** (a timeout, network error, or 5xx while sending — never
  auto-retried, since the email may have gone out): **check the rep's inbox
  first.** Only requeue (same UPDATE) once you've confirmed they did NOT
  already get it — requeuing after it actually sent duplicates the alert.

## Running the scripts

Both dry-run by default; read the plan before `--apply`. **Run
`set-sms-webhooks.mjs` only after the deploy AND migration `0044` are live**
— running it early points Twilio at a route that doesn't exist yet.
```bash
cd services/cti-api
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
# Point every active number's Twilio SmsUrl at our webhook (one-time + after buying numbers)
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/set-sms-webhooks.mjs
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/set-sms-webhooks.mjs --apply
# Recover texts from before the webhook was set — the rep's OWN agent numbers
# only. Pick --since AFTER the number's last reassignment, or texts from a
# previous owner get credited to whoever holds it today.
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01 --apply
```

**Undoing a `set-sms-webhooks.mjs --apply`:** it writes a rollback file before
its first Twilio write — `./sms-webhooks-rollback-<ISO timestamp>.json` by
default, `--rollback-file <path>` to name it yourself; never committed (see
`.gitignore`). Put every number back with:
```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/set-sms-webhooks.mjs --restore ./sms-webhooks-rollback-<...>.json           # dry run
railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/set-sms-webhooks.mjs --restore ./sms-webhooks-rollback-<...>.json --apply    # writes
```
`--restore` never touches the database or reads Twilio — only the rollback
file and (with `--apply`) the write itself — so it works even if Postgres is
unreachable, and it refuses the whole file unless every record is well-formed.

The **forward run's** dry run (not `--restore`) reports two safety checks
before any write: `sms_application_sid` set (Twilio ignores `SmsUrl` there —
"not covered", skipped) and a Twilio `phone_number` that doesn't match our
e164, or is missing (a stale `twilio_sid` — "mismatched", skipped).

## Inspecting the database (never select `body` casually — it's the private message)

```sql
SELECT status, count(*) FROM inbound_messages GROUP BY status ORDER BY status;
-- what's stuck
SELECT id, status, attempts, last_error, updated_at FROM inbound_messages
WHERE status IN ('pending','in_flight','failed') ORDER BY updated_at DESC LIMIT 50;
-- digests by status (see "recovering a stuck one" above for failed/unknown)
SELECT status, count(*) FROM inbound_text_digests GROUP BY status ORDER BY status;
-- one backfill batch: all rows terminal + no row yet in inbound_text_digests = digest due next tick
SELECT status, count(*) FROM inbound_messages WHERE backfill_batch = '<batch-id>' GROUP BY status;
SELECT status, attempts, last_error, sent_at FROM inbound_text_digests WHERE batch_id = '<batch-id>';
```
