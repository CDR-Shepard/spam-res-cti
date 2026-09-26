# Dialer cadence: the rules, the skips, the SQL

Spec: `docs/superpowers/specs/2026-09-23-dialer-cadence-and-controls-design.md`.
The rules are org-wide and have no kill switch. Change a constant and redeploy.

## The rules

| Rule | Where | Value |
|---|---|---|
| Courtesy spacing: a person is not power-dialed again within 3 h of any dial, by anyone. The same run's own redials are exempt. | `dialer/contact-history.ts` `COOLDOWN_MS` | 3 h |
| State law: no 4th call to a number in a rolling 24 h. Every dial by anyone counts, click-to-dial included, and so does a Skip (the phone rang). | `packages/firewall/src/state-calling-rules.ts` `DAILY_DIAL_CAP_STATES`, `DAILY_DIAL_CAP` | FL, OK, WA, MD; 3 per 24 h |
| Follow-up rollover: the task owner's 2nd dial of the org day that doesn't connect rolls the follow-up to the next business day. It counts power dial and click-to-dial, but only the owner's own dials. A Skip does not count. | `dialer/contact-history.ts` `rolloverDue`; `salesforce/sync.ts` hook | 2 per LA day |
| One number per pass: attempt 1 dials the lead number and the other is tried once, at the end-of-run retry. A number the person once answered on leads, and the other is never dialed. | `dialer/create-session.ts` | — |
| Two reps, one list: a new run from a list view starts after the furthest record dialed on that list in 12 h. | `dialer/list-position.ts` `LIST_SHARE_WINDOW_MS` | 12 h |
| A hang-up never auto-redials. The rep chooses Redial or Resume, and a missed Redial is not retried. End call hangs up and pauses. | `dialer/engine.ts` `redialCurrent` / `endCurrent` | — |
| A run whose prospect hung up more than 10 min ago, with no panel poll, is reaped. | `salesforce/followup-worker.ts` `HUNG_UP_PRESENCE_MS` | 10 min |

Adding a capped state: add its code to `DAILY_DIAL_CAP_STATES`, which is used by both the dialer gate and the click-to-dial firewall. Then redeploy. Get counsel's sign-off first.

## Two cap checks, two scopes

Same law, same state list, two different enforcement points — and they don't count or resolve "capped" the same way:

| | Dialer gate (`dialer/live-deps.ts` `isDailyCapped`) | Click-to-dial firewall (`firewall/evaluate.ts`) |
|---|---|---|
| Counts per | **PERSON** — both of the record's numbers plus dials logged against the record itself | **NUMBER** — the exact number dialed (`daily-cap.ts` `dailyDialCount`) |
| "Capped" decided by | the **dialed number's area code** | the **Salesforce State**, falling back to the area code when there is none |

Two consequences:
- A FL person capped by the dialer on their Mobile can still be reached a 4th time by click-to-dial to their OTHER number — the firewall counts that number alone, and it hasn't hit 3 yet.
- A FL resident's out-of-state cell (e.g. a NY area code) is blocked by the click-to-dial firewall (SF State = FL) but NOT by the dialer gate (the area code resolves to NY, which isn't capped).

Counsel to confirm whether FL §501.059's limit is per person; if so, the firewall needs the person's other number.

## Skip outcomes (`dialer_queue_items.outcome`, status `skipped`)

| Outcome | Panel label | Meaning |
|---|---|---|
| `already_worked` | called in the last 3 h | Queue-build estimate of the courtesy rule; folded into the same count as `cooldown` |
| `cooldown` | called in the last 3 h | Dial-time courtesy gate |
| `daily_cap` | daily limit (state law) | 3 dials in 24 h in a capped state |
| `daily_cap_unverified` | daily limit (state law) | The history read failed in a capped state, so it fails closed |
| `in_progress_elsewhere` | in progress in another run | Another active or paused run is dialing or talking to this person |
| `canceled` | not counted — the person is counted once, on the requeued copy | The rep took a callback (Pause & answer) while this record was ringing. The call was hung up and the person requeued at the same ordinal with a 5-min floor. Not a dial for the follow-up rollover. The phone rang, so it still counts for the per-customer ceiling, the 3 h courtesy, and the state-law cap. |

## Callbacks during a run

Spec: `docs/superpowers/specs/2026-09-26-callback-waiting-design.md`. Until this change, a rep's softphone dropped every callback while they power dialed (Twilio child leg `busy`, 0 s). The Voice SDK now takes the call (`allowIncomingWhileBusy`), and the softphone decides what happens:

| The rep is… | What happens |
|---|---|
| talking to a prospect (current record connected, prospect still on the line) | Rejected at once, so it forwards or goes to voicemail as before. Toast: "Missed callback from … — you were on a call. It went to your cell / voicemail." |
| in a run but not talking (a dial ringing, between dials, paused, or the prospect hung up) | A green banner above the current record, "Callback: <name or number> · <type>", with **Pause & answer** and **Ignore**, plus a two-beep chime on the speaker chosen in Settings. The 25 s ring window applies. |
| not in a run | Today's ring screen, unchanged. |

**Pause & answer, in order:**
1. `POST /dialer/sessions/:id/take-callback`. This pauses the run first. A dial still ringing is settled `skipped`/`canceled` and its person requeued; the call is hung up after the commit.
2. The softphone leaves the run's room.
3. The callback is answered as a normal inbound call: screen-pop, recording, caller ID.

A `409 { reason: 'connected' }` means a prospect answered in the race: the callback is rejected with the toast, and the rep stays in the room.

**Afterwards** the run is paused. **Resume** first re-joins the room and waits for Twilio to answer the leg, then POSTs `resume`. While the rep is on the callback, the softphone GETs the run every 60 s so the 10-min reaper leaves it alone. If the leg drops on its own while a callback is on the banner, the softphone doesn't reconnect: it pauses the run the same way and lets the callback ring normally.

**Server guards added with it:**
- The `/voice` conference join answers `<Reject/>` when the run it names isn't live or another of the rep's runs is `active` (`dialer/join-guard.ts`).
- The `pending → dialing` claim re-checks that the run is `active`.
- A connect is a compare-and-swap on `dialing`: a person answering a call whose row was already settled is hung up, never bridged.

**Known limitation:** reps paired with the Callsign iPhone app share the rep's Twilio identity, so a callback during a run may also ring the iPhone. If the rep answers it there, the web banner disappears but the run keeps dialing — they should Pause first. The iPhone app isn't rolled out to reps yet.

**"A callback never rang me."** Look up the child leg: `Calls.json?ParentCallSid=<calls.provider_call_id>`.
- `busy`, 0 s: the softphone rejected it. Any of:
  - the rep was talking to a prospect (toast "… you were on a call");
  - the rep pressed Ignore;
  - the rep was on a manual call, placing one, or in wrap-up (no toast; today's busy rule);
  - a second callback arrived while one was already waiting on the banner (no toast; one at a time);
  - the leg dropped with the callback on the banner and take-callback failed (toast "… Power Dial couldn't pause your run").
- `no-answer`, ~25 s: the banner was up and nobody chose.
- `completed`: answered.

A run's callback cancels and their requeued copies:
```sql
SELECT i.ordinal, i.record_id, i.status, i.outcome, i.retry_not_before, i.updated_at
  FROM dialer_queue_items i
 WHERE i.session_id = '<uuid>'
   AND i.ordinal IN (SELECT ordinal FROM dialer_queue_items
                      WHERE session_id = '<uuid>' AND status = 'skipped' AND outcome = 'canceled')
 ORDER BY i.ordinal, i.updated_at;
```

## SQL (read-only; use the `$PUB` pattern from the number-fleet runbook)

A person's contact history, both logs, by number:
```sql
SELECT 'dialer' src, a.dialed_at at, a.user_id, a.to_number, a.connected_at, i.status, i.outcome
  FROM dialer_dial_attempts a LEFT JOIN dialer_queue_items i ON i.id = a.item_id
 WHERE a.to_number = '+1XXXXXXXXXX' AND a.dialed_at > now() - interval '7 days'
UNION ALL
SELECT 'manual', c.created_at, c.user_id, c.normalized_to_number, NULL, c.status::text, c.disposition
  FROM calls c
 WHERE c.direction = 'outbound' AND c.normalized_to_number = '+1XXXXXXXXXX' AND c.created_at > now() - interval '7 days'
 ORDER BY 2 DESC;
```

A run's skips by outcome:
```sql
SELECT outcome, count(*) FROM dialer_queue_items WHERE session_id = '<uuid>' AND status = 'skipped' GROUP BY 1 ORDER BY 2 DESC;
```

A list's shared position, which a new run starts after:
```sql
SELECT s.list_view_id, u.display_name, max(i.list_position) furthest
  FROM dialer_dial_attempts a JOIN dialer_queue_items i ON i.id = a.item_id
  JOIN dialer_sessions s ON s.id = a.session_id JOIN users u ON u.id = s.user_id
 WHERE s.list_view_id = '<00B…>' AND a.dialed_at > now() - interval '12 hours'
 GROUP BY 1, 2;
```
