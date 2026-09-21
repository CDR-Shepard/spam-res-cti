# "No answer" Chatter posts at the end of a power-dial run

When a dialer run ends (`done` or `stopped`, incl. the abandoned-run reaper), a background worker posts one Chatter FeedItem **as the rep** (through the rep's own Salesforce token) on every record that was dialed and never connected — **only on records the rep owns** (the follow-up rollover's rule: Owner, queue-owned, or Opportunity `LeadManager__c`; on Task runs the Task's assignee too).

```
No answer (Power Dialer) — 2 attempts: no answer, voicemail
```

Counts as an attempt: `no_connect` with outcome `no_answer | voicemail | busy | fax | hangup | failed`. Never counts: `canceled` (the rep's own Stop/Skip), `skipped`, `unreachable`, `pending`. A record the rep reached on any attempt (`connected` / `done`) gets no post.

Code: `services/cti-api/src/salesforce/no-answer-chatter.ts` (pure rules), `no-answer-chatter-worker.ts` (scan → claim → ownership → post, every 15s), `ownership.ts` `fetchOwnershipBatch`, `client.ts` `createFeedItems` (sObject Collections, 200/request). Migration `0040_no_answer_chatter.sql`.

## Columns

| Column | Meaning |
|---|---|
| `dialer_sessions.no_answer_chatter_at` | sweep finished, or given up on. `NULL` on an ended run = still owed |
| `…no_answer_chatter_claimed_at` / `_attempts` / `_next_at` | claim (reaped after 10 min), attempts used (max 8), backoff floor (30s doubling) |
| `dialer_queue_items.no_answer_feed_item_id` | FeedItem id, on every counted attempt of the record |
| `dialer_queue_items.no_answer_skip_reason` | terminal skip: `not-owner`, `not-found`, or a Salesforce `statusCode` |

**No historical backfill:** 0040 marks every already-ended session swept, and the worker never touches a run that ended >24h ago (`updated_at`, which the worker never writes). Delivery is **at-least-once**: a crash mid-run can duplicate at most one 200-record chunk; it never loses one.

## Kill switch

`NO_ANSWER_CHATTER=off` on the cti-api service → the loop is not started (default `on`; any other value fails the boot). Turning it back `on` sweeps only runs that ended in the last 24h.

## Checking it (read-only SQL)

```sql
-- Runs still owed a sweep, or retrying (expect 0 rows a minute after a run ends)
SELECT id, user_id, status, updated_at, no_answer_chatter_attempts, no_answer_chatter_next_at
FROM dialer_sessions
WHERE status IN ('done','stopped') AND no_answer_chatter_at IS NULL AND updated_at > now() - interval '24 hours';

-- What one run produced
SELECT record_id, attempt, outcome, no_answer_feed_item_id, no_answer_skip_reason
FROM dialer_queue_items WHERE session_id = '<session-id>' AND status = 'no_connect' ORDER BY ordinal;
```

Logs: `[no-answer-chatter] post rejected` (one record, terminal), `sweep failed; will retry`, `giving up` (names the session and `recordsLeft`). `reason: 'reconnect Salesforce'` = the rep's token is dead; it keeps retrying for ~63 min in case they sign back in.
