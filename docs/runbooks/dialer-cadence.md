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

## Skip outcomes (`dialer_queue_items.outcome`, status `skipped`)

| Outcome | Panel label | Meaning |
|---|---|---|
| `already_worked` | called in the last 3 h | Queue-build estimate of the courtesy rule; folded into the same count as `cooldown` |
| `cooldown` | called in the last 3 h | Dial-time courtesy gate |
| `daily_cap` | daily limit (state law) | 3 dials in 24 h in a capped state |
| `daily_cap_unverified` | daily limit (state law) | The history read failed in a capped state, so it fails closed |
| `in_progress_elsewhere` | in progress in another run | Another active or paused run is dialing or talking to this person |

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
