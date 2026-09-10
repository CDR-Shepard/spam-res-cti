# Power Dialer — Ship It: Design

**Date:** 2026-09-10
**Goal:** Get the power dialer into reps' hands this week. Fix why it fails on
real lists, make its outcomes honest, let the rep confirm a list before the
first ring, and pilot it with three reps before enabling everyone.
**Not a redesign.** The dialing screen keeps its shape; a rethought experience
is a separate project once reps have used this one.

## Why (what the data says)

- The dialer is **enabled for 0 of 17 reps**. The 2026-08-25 enablement design
  defaulted everyone off; nobody was switched on. Every session on record is
  the admin testing it (12) plus one from Matt Cook.
- The one real-size test (2026-08-12, a 200-record Opportunity list view)
  marked **23 of the first 24 records `unreachable` at creation** — never dialed,
  no number — dialed one, connected it, and was stopped with 176 left.
- **Root cause:** `resolveDialNumber` (`services/cti-api/src/salesforce/record-phone.ts`)
  finds an Opportunity's phone only through `OpportunityContactRole → Contact.MobilePhone/Phone`.
  This org stores phones **on the Opportunity**: of 76,574 open Opportunities,
  70,564 (92%) have `Mobile_Phone__c`, `Phone__c` or `Other_Phone__c`; only
  32,080 (42%) have any Contact Role at all. The engine works; the lookup is
  wrong for this org.
- Misses are unreadable: `dialer/amd.ts` maps every machine/fax to `no_connect`,
  and `routes/dialer.ts:114-116` maps busy/failed/canceled to `no_connect` too.
  A rep cannot tell a list full of voicemails from a list full of dead numbers.
- The panel starts dialing the instant a list is picked (`createAndStartSession`,
  `dialer/create-session.ts:251-259`), so a bad list is discovered by watching
  it fail.

## Decisions

| Question | Decision |
| --- | --- |
| Scope | Fix + enable, days. No redesign. |
| Opportunity phone order | Opportunity's own fields first: `Mobile_Phone__c`, `Phone__c`, `Other_Phone__c`; Contact Role phone only as a fallback when the Opportunity has none |
| Miss outcomes | Split into `voicemail`, `fax`, `busy`, `failed`, `canceled`, `hangup`, `no_answer`; engine decision logic unchanged |
| Retry policy per miss type | Unchanged (auto through misses, attempt 2 after the 5-min floor). Revisit once reps can see the data |
| Flow | Create the session **without dialing**; the panel shows the breakdown; the rep taps **Start dialing** (or backs out) |
| Rollout | Pilot: Garrett Martorello, Norah Nazzaro, Edward Jerome Maglalang. Then everyone |
| Start latency | Unchanged in this change (per-record lookups run one at a time). Follow-up |

## 1. Phone resolution (`salesforce/record-phone.ts`)

The Opportunity branch becomes two queries, in order:

1. `SELECT Mobile_Phone__c, Phone__c, Other_Phone__c, <SKIP_FIELD> FROM Opportunity WHERE Id = :id LIMIT 1`
   — keeping the existing two-variant pattern (with and without `SKIP_FIELD`)
   and its 400-retry, exactly as the Lead branch does today. `primary` = the
   first non-empty of the three in that order; `fallback` = the next non-empty.
   `skipOnDialer` is read from this query now, not from the Contact Role query.
2. Only when all three are empty: the existing `OpportunityContactRole` query,
   unchanged (`primary` = `Contact.MobilePhone`, `fallback` = `Contact.Phone`).

Lead and Contact branches are untouched. Tasks resolve through their linked
record and inherit the fix. Phone values pass through the existing
normalization; nothing new is invented here.

## 2. Honest outcomes

**Type.** `handleDialOutcome`'s outcome widens from
`'connected' | 'no_answer' | 'no_connect'` to
`type DialOutcome = 'connected' | 'no_answer' | 'voicemail' | 'fax' | 'busy' | 'failed' | 'canceled' | 'hangup'`.
One helper, `isNoConnect(o: DialOutcome): boolean` (`o !== 'connected' && o !== 'no_answer'`),
replaces every `=== 'no_connect'` comparison in `dialer/engine.ts`. The engine's
three-way decision — bridge on connect, try the fallback number on a true
no-answer, otherwise no-connect — does not change. The item's `status` column
still becomes `no_connect`; only the existing text `outcome` column now carries
the reason (it already carries `no_answer`/`no_connect` today).

**Sources.**
- `dialer/amd.ts` `mapAnsweredBy` returns `'connected' | 'voicemail' | 'fax'`
  (`machine_*` → `voicemail`, `fax` → `fax`; the human bias is kept).
- The status callback (`routes/dialer.ts` dialer-status handler) maps Twilio
  `no-answer` → `no_answer`, `busy` → `busy`, `failed` → `failed`,
  `canceled` → `canceled`; a `completed` leg that never bridged → `hangup`.
  It remains the idempotent backstop it is today and **must not overwrite** a
  reason the AMD callback already stamped.

**Surface.** `dialer/session-store.ts` gains `missBreakdown(items)` — a tally
of `outcome` over `no_connect` rows, the same shape as `skipBreakdown`.
`GET /dialer/sessions/:id` returns it as `missBreakdown`. The panel's
`queueLine` adds a miss line ("12 voicemail · 4 no answer · 2 bad number") next
to the skip line it already renders, and the current-record card shows a label
— `Voicemail`, `No answer`, `Busy`, `Bad number` (failed), `No number`
(unreachable) — instead of a bare red dot.

## 3. Confirm before dialing

**State.** `dialer_session_status` gains `ready`, ahead of `active`.
Migration `packages/db/migrations/0037_dialer_session_ready.sql`:
`ALTER TYPE dialer_session_status ADD VALUE IF NOT EXISTS 'ready';` (additive;
a file of its own so the enum change commits before any row uses it).
`createDialerSession` inserts sessions as `ready`. The engine already returns
`idle` for anything not `active` (`engine.ts:104`), so a `ready` session
cannot dial by construction.

**API.** `createAndStartSession` is removed; every entry point —
`POST /dialer/sessions`, `POST /dialer/sessions/from-listview`, and the
Salesforce handoff intake — creates a `ready` session and returns it (with the
counts) without advancing. A new control action `start` joins
`pause | resume | skip | stop | next`: `ready → active` by compare-and-swap on
status, then `advanceSession`; a second `start` is a no-op. `stop` on a
`ready` session → `stopped` immediately, with no dial, no follow-up rollover,
and no Task written — nothing happened.

**Panel.** While the create request is in flight the picker shows
"Checking records…" (the count is not known until Salesforce answers). When
the session arrives in `ready`, the panel replaces the picker with a confirm
block:

- the breakdown, using the line the run summary already knows how to build:
  "187 will be dialed · 9 already worked · 4 no number · 2 blocked";
- **Start dialing** (primary, full width);
- **Choose a different list** (secondary) → `stop`, back to the picker.

Everything after Start is the existing run screen. `DialerSession.status` and
`DialerSessionView` in `apps/cti-web/src/dialer-api.ts` gain `ready` and
`missBreakdown`.

## 4. Pilot, then everyone

Enable Garrett Martorello, Norah Nazzaro and Edward Jerome Maglalang via the
existing admin Team panel (`PATCH /admin/team/:userId { powerDialerEnabled: true }`).
They are the three highest-volume CTI callers of the last two weeks with the
best connect rates, and Garrett is already engaged from this week's
converted-lead incident. Gate to full rollout after one to two days of real
sessions: connect rate above the ~4% the August test showed, a miss mix that
reads as voicemails and no-answers rather than `failed`, and zero engine
errors in the logs. Then enable the remaining fourteen.

## Testing

- **record-phone:** Opportunity with `Mobile_Phone__c` only → primary is it,
  no Contact Role query issued (assert the call count); `Phone__c` and
  `Other_Phone__c` in order; all three empty → falls back to the Contact Role
  query; the `SKIP_FIELD` 400-retry still works.
- **amd / status handlers:** each Twilio `AnsweredBy` and `CallStatus` stamps
  its reason; the engine's status transition is unchanged for every one
  (mutation: replace any reason with `no_connect` and the transition tests
  still pass — proving the decision does not depend on the reason); the
  backstop never overwrites an AMD-stamped reason.
- **engine:** `isNoConnect` covers every non-connect, non-no_answer value; the
  fallback-number path fires only on `no_answer`.
- **routes:** create returns `ready` and does not advance (assert the fake
  engine's `advance` was never called); `start` advances exactly once and is
  idempotent; `stop` from `ready` writes nothing.
- **panel:** `ready` renders the confirm block with the right line; Start
  calls `start`; the alternative calls `stop`; the miss line and labels render
  from `missBreakdown`/`outcome`.
- **Live:** the admin re-runs the 2026-08-12 Opportunity list view: the
  confirm block reports the large majority dialable, and the run dials through.

## Out of scope (tracked in `docs/superpowers/plans/2026-09-04-callsign-followups.md` §2)

- Batched phone resolution so a 200-record list starts in seconds.
- A per-record outcome list during and after a run.
- Retry policy by miss type (skip the 5-minute retry after a voicemail).
- Any change to the ownership gate, the number pool, AMD parameters, or the
  follow-up rollover.
