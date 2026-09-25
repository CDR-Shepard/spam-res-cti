# Inbound texts → Salesforce task + email alert: Design

**Date:** 2026-09-25 · **Ruling:** option A (user, 2026-09-25).

## Why

Reps' CTI numbers receive texts, and nothing handles them: Twilio accepts them (no `SmsUrl`) and they are
never seen. Garrett alone got 19 in 7 days. The old 360 SMS app used to email reps on an incoming text.

## What changes

Every text to one of our numbers creates a Salesforce **Task** on the matched record, assigned to the rep,
and sends that rep an **email alert** through Salesforce's own `emailSimple` action (no new email vendor;
org limit 5,000 a day). Pool numbers route like callbacks (sticky → last dialer). Nothing auto-replies.

## Decisions

1. **Webhook** `POST /telephony/twilio/sms`: Twilio signature validated exactly like `/telephony/twilio/inbound`,
   and it answers `<Response/>` at once (no auto-reply, never an error a texter would see). Only numbers in
   `outbound_numbers` are accepted; unknown `To` → 200 `<Response/>` and a log line.
2. **Idempotent storage**: migration **0044** `inbound_messages` (id, org_id, message_sid UNIQUE, from_e164,
   to_e164, body text, num_media int, user_id NULL, status `pending|done|skipped|failed`, attempts,
   next_attempt_at, last_error, sf_task_id, emailed_at, backfill bool, received_at, created_at, updated_at).
   A retried webhook with the same `MessageSid` is a no-op.
3. **Routing** (who gets it): agent DID → `assigned_user_id`; `dialer_pool` DID → `stickyAgentForCaller` then
   `lastDialerForCaller` (the callback rules); none → `status='skipped'`, no task, no email.
4. **Worker** (single-flight tick, 5 s, like the follow-up worker): claims `pending` rows whose
   `next_attempt_at <= now()`; 3 attempts with backoff; each step recorded so a retry never duplicates:
   - Match the sender with `findByPhone(repUserId, from)` (the rep's own SF connection); an error or no match
     is fine — the task is created unlinked.
   - Create the Task **once** (skip when `sf_task_id` is set): Subject `Text from <name>` (or the formatted number),
     Description = the message (+ "(N attachment(s) — open Twilio to view)" when `num_media > 0`),
     ActivityDate = the day received (org time zone), OwnerId = the rep's SF user id, WhoId/WhatId from the
     match (never an Account id as WhoId), **no `Status`** (org default Open — the 2026-09-23 lesson), Priority Normal.
   - Email **once** (skip when `emailed_at` is set): `POST /actions/standard/emailSimple` as the rep, to the
     rep's own `User.Email`; subject `New text from <name or number>`; plain-text body = sender, the rep's number
     it came to, the time (Pacific), the message, and a link to the record/task in Salesforce. Backfilled rows
     never email individually (see 6).
   - A Salesforce auth failure is terminal for the row (`failed`, `reconnect Salesforce`), never an endless retry.
5. **Opt-out words** (`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, case-insensitive, whole message):
   the task subject and email say `Text from <name> — asked to STOP`. No automatic Do-Not-Call write (a policy
   decision for the user; flagged in the runbook).
6. **Backfill**: a script pulls a rep's inbound texts from Twilio since a date into `inbound_messages` with
   `backfill=true` (idempotent by `MessageSid`); the worker creates their tasks, then sends **one** digest email
   per rep listing them.
7. **Wiring Twilio**: a script sets `SmsUrl` (POST) on every active agent and pool number; the admin
   "import from Twilio" and "fix webhook" routes set `SmsUrl` alongside `VoiceUrl` so new numbers are covered.
8. **Privacy**: message bodies are never logged; logs carry the MessageSid only.

## Tasks

1. API: migration 0044 + schema, pure helpers (routing choice, subject/body/email formatting, opt-out detection),
   the webhook, the worker, Salesforce task + emailSimple calls; tests (signature, idempotency, routing, each
   worker step's once-only guard, auth failure terminal, opt-out wording, no Status on the task).
2. Ops: `set-sms-webhooks` script (dry-run default, `--apply`), admin routes set `SmsUrl`, the backfill script with
   the digest email, runbook `docs/runbooks/inbound-texts.md`.
3. Deploy off-hours; run the webhook script; backfill Garrett's 19; live check with a text from our test number.
