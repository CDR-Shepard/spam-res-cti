# Task Dialing from the Rep's Own Numbers + Ownership Gate — Design Spec

**Date:** 2026-08-22
**Status:** Approved (Approach 1 — Task as a third dialer object type)
**Scope:** `services/cti-api` + `apps/cti-web`. Sub-projects **A** (items 1, 3) and **D** (item 5) of the
power-dialer request. Builds on the follow-up rollover shipped in
`2026-08-22-followup-rollover-design.md`.

## Problem

1. The power dialer only runs Lead and Opportunity list views. Reps work from **Task** lists
   ("My follow-ups due today") and cannot power-dial them.
2. Every dialer run uses the shared `dialer_pool` DIDs. Task runs are warm follow-ups and should
   come from the rep's **own** numbers — spread across them so no single number burns — while
   Lead/Opp cold runs keep using the pool.
3. The CTI writes Salesforce Tasks (after-call logs and rollover copies) on whatever record a
   number matched, even when the rep has no claim to that record. Tasks must only be created on
   records the caller owns or manages.

## Goal

**A rep can power-dial a Task list view; each call goes out from one of their own numbers chosen to
protect reputation; the dialed follow-up task rolls over under the existing two-attempt/daily-cap
rules; and the CTI never creates a Salesforce Task on a record the caller doesn't own or manage.**

## Decisions (locked, with the user)

| Question | Decision |
| --- | --- |
| Which task rolls over on a Task run? | **The dialed task itself**, only if its Subject matches the follow-up rule. Non-matching tasks are still dialed (two attempts, human-only pop) but never rolled. |
| Follow-up subject rule | Whole-word, case-insensitive: `follow-up`, `follow up`, `followup`, `FU`, `F/U`, `F-U`. A bare substring `FU` is excluded (would match "refund"). One shared constant, used by the worker, the cap count, and Task-run eligibility. |
| Ownership gate scope | **Both** rollover copies and after-call log tasks. |
| `LeadManager__c` | Custom lookup(User) on **Opportunity only**. Leads: Owner only. |
| Contacts (a Task's Who) | Treated like Leads: caller must be the Contact's `OwnerId`. |
| Connect on a Task run | **Does not** auto-complete the task. The rep's existing Next/wrap-up flow is unchanged. |
| Per-customer ceiling | Applied to **all** runs (pool and agent) as a harassment backstop — the dialer previously enforced none. Per-number rotation is agent-only. |

## Section 1 — Task resolution and data model

**Third run type.** `'Lead' | 'Opportunity'` → `'Lead' | 'Opportunity' | 'Task'` at every seam that
branches on it: `create-session.ts`, `routes/dialer.ts` (`from-listview` zod enum, list-view
fetch), `dialer/handoff-store.ts`, `salesforce/record-phone.ts`, `apps/cti-web/src/dialer-api.ts`
(`DialerObjectType`), the picker. `dialer_sessions.object_type = 'Task'` marks a Task run; no new
flag column.

**Resolving a Task to a person** (`salesforce/task-targets.ts`, new): one batched SOQL
`SELECT Id, Subject, OwnerId, WhoId, WhatId, Who.Type, What.Type FROM Task WHERE Id IN (…)`
(chunked ≤ 200 ids), then per task, in precedence:
1. `WhoId` is a **Lead** → `Lead.MobilePhone` then `Phone` (existing `choosePhones`).
2. `WhoId` is a **Contact** → `Contact.MobilePhone` then `Phone` — **new object**.
3. No `WhoId`, `WhatId` is an **Opportunity** → primary `OpportunityContactRole` contact's
   Mobile/Phone (existing).
4. Otherwise → `unreachable` (visible in the run as skipped).
`resolveDialNumber` gains `'Contact'`; a pure `resolveTaskTarget(task)` returns
`{ recordId, objectType: 'Lead'|'Contact'|'Opportunity', followupEligible } | null`.

**Migration `0027_task_dialing.sql`** (additive):
- `dialer_queue_items.task_id text` — the Task the item came from (null on Lead/Opp runs).
- `dialer_queue_items.followup_eligible boolean NOT NULL DEFAULT true` — decided once at creation
  from the subject rule (Lead/Opp items default true so their behavior is unchanged).
- `followup_rollover_jobs.source_task_id text` — the exact task to roll (null → search by record,
  today's behavior).
- `dialer_queue_items.record_id` stays the **person/record** id; `object_type` on the **item** is
  that record's type (`Lead`/`Contact`/`Opportunity`) so screen-pop and the panel work unmodified.

## Section 2 — Number selection for Task runs

`EngineDeps.pickDid` gains the run kind:
`pickDid(args: { orgId; userId; toE164; runKind: 'pool' | 'agent' }) → { e164 } | { skip: 'customer_ceiling' } | null`.
`buildEngineDeps` routes `runKind = session.objectType === 'Task' ? 'agent' : 'pool'`.
`pickPoolDid` is unchanged except for the shared ceiling check below.

**`pickAgentDid`** (`dialer/pick-agent-did.ts`, new):
1. **Per-customer attempt state** — the firewall's query: this rep's calls to `toE164` grouped by
   `from_number` within `campaign_configs.attempt_window_days`; total vs
   `per_customer_max_attempts` → at/over → `{ skip: 'customer_ceiling' }` (item marked
   `skipped`, `outcome: 'customer_ceiling'`; the run continues).
2. **Rotation** — `pickRotationNumber(db, orgId, userId, toE164, { attemptsByNumber, maxAttemptsPerNumber })`
   (existing: sticky-if-eligible → local-presence tier → most warmup room → LRU; exhausted-for-this-
   customer ranked last; unhealthy excluded). Gains an optional `exclude?: ReadonlySet<string>`.
3. **Atomic claim** — `attemptIncrement` becomes kind-parameterized (`'agent' | 'dialer_pool'`);
   same conditional UPDATE (daily warmup cap + 10/min velocity re-checked in the write). On a lost
   race, rotation is retried once with that number excluded, then gives up.
4. **Fail closed** — `null` → `paused_no_numbers` (existing).

Sticky-on-connect (`recordConnectSticky`) is unchanged and already shared with click-to-dial.
Calling hours, `DIALER_CALLING_HOURS_EXEMPT`, and AMD are unchanged.

## Section 3 — Rollover rules on a Task run

- Eligibility (`followup_eligible`) is decided at creation from the subject rule.
- Second miss of an eligible item → job with `source_task_id = item.task_id`. Non-eligible items
  never enqueue; the task stays open.
- Worker: if `source_task_id` is set → `SELECT … FROM Task WHERE Id = :id AND IsClosed = false AND OwnerId = :rep`;
  missing/closed/reassigned → `succeeded` `'no-task'`. Otherwise the existing path (pick day under
  cap → create copy → complete the cleared tasks). `source_task_id` null → today's
  search-by-record (with the widened subject rule).
- **Cap count reshaped:** `SELECT Id, Subject FROM Task WHERE OwnerId = :rep AND IsClosed = false AND ActivityDate = :day LIMIT 500`
  → pure `countFollowUps(tasks)` applies the subject rule in code. `soqlCount`/`followUpCountSoql`
  are replaced by `followUpTasksSoql(owner, day)` + `countFollowUps`.
- **One rollover per person per day** (user ruling). The job key stays rep + record + day, so two
  follow-ups for the same person in one run collapse into ONE job — the first miss's
  `source_task_id` wins and names the template. On that job the worker completes the **clear set**
  — the template plus every other open follow-up on that person dated the missed day — and creates
  **exactly one** copy. Future-dated and overdue follow-ups, and non-follow-up tasks, are never
  touched. `completed_task_ids` records the whole set (the retry path completes it; a 404 on a
  sibling that was deleted meanwhile is logged and skipped). A connected call never enqueues at
  all, so nothing rolls on a connect.

## Section 4 — Ownership gate (`salesforce/ownership.ts`, new)

Pure `callerMayCreateTaskOn(snapshot, callerSfUserId): boolean` over
`snapshot = { type: 'Lead'|'Contact'|'Opportunity'|'Task'; ownerId; leadManagerId? }`:
- Lead → `ownerId === caller`; Contact → `ownerId === caller`;
- Opportunity → `ownerId === caller || leadManagerId === caller`;
- Task → `ownerId === caller` (assignee).
`fetchOwnership(userId, recordId)` issues one SOQL by id prefix (`00Q` Lead, `003` Contact, `006`
Opportunity, `00T` Task); Opportunity selects `OwnerId, LeadManager__c`. An `INVALID_FIELD` on
`LeadManager__c` → retry without it + `console.warn` once per process (owner-only). In-process
cache keyed by record id, 5-minute TTL.

Applied in:
1. **Rollover worker**, before the create → denied → `succeeded` with `lastError: 'not-owner'`,
   nothing created, source left open. (Passes by construction today via the assignee clause.)
2. **Sync worker** (`salesforce/sync.ts`), before `createCallTask` → denied → no Salesforce
   Task; the job completes `succeeded` with `lastError: 'not-owner'` and `salesforce_task_id`
   null; the call stays fully logged in the CTI. An ownership lookup failure is transient (backoff);
   auth → `failed 'reconnect Salesforce'`.
3. **Client wrap-up**: the disposition response gains `taskAllowed: boolean`; the softphone skips
   its Open CTI `saveCallLog` when false (server computes it with the same function).

Never gated: placing the call.

## Section 5 — Failures, visibility, tests

**Failures:** task resolution errors → 502 at creation (as Lead/Opp). Person without a phone →
`unreachable`. No eligible number → `paused_no_numbers`. Ceiling → item skipped. Ownership
unknown → fail closed + retry.

**Reps see:** a third picker toggle **Tasks** (`/sobjects/Task/listviews`); the Current-record
card shows the record type and **the from-number** (`from_number` already on the item); Recents
labels a gated call **Not synced · not owner** (the `/calls` list exposes the sync job's
`lastError`); ceiling skips count as skipped.

**Tests (pure first):** subject rule (all spellings; `refund`/`FUEL` excluded); `resolveTaskTarget`
precedence incl. Contact and unreachable; ownership matrix; `countFollowUps`; `pickAgentDid`
(ceiling → skip, rotation + claim, retry-with-exclude, fail-closed) with fakes; engine routes
`runKind` (mutation-checked); worker `source_task_id` path + closed-task no-op; sync gate → no
`createCallTask` + `not-owner`; client SSR: Tasks toggle, from-number, Recents label.

**Live (user-run):** follow-up tasks owned by Evren on the three **CTI DIAL TEST** opps plus one
titled "Check in"; dial that Task list. Expect calls from Evren's **own** numbers rotating (not the
pool), the three follow-ups rolled after the second miss, "Check in" dialed but untouched, and a dial
to another rep's lead logged in Recents with no Salesforce Task.

## Out of scope

- Auto-completing a task on connect (explicit later decision).
- Contacts inheriting ownership from Account/Opportunity.
- Item #8 (assign all 29 DIDs to the approved SHAKEN/business profile) — separate ops task.
- Number-level changes to the pool path beyond the shared per-customer ceiling.
