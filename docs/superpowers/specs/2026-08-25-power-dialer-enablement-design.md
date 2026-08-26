# Power Dialer Enablement + Full CTI Swap — Design

**Date:** 2026-08-25
**Goal:** Before moving all 14 reps fully onto the new CTI, make power dialing an
explicitly granted per-user capability. Everyone starts WITHOUT it; admins grant
it per user from the softphone. Then swap every rep's Salesforce Call Center to
Caller Reputation CTI.

## Decisions

| Question | Decision |
| --- | --- |
| Where is the flag controlled? | Softphone admin UI (new **Team** panel), backed by admin API |
| What does "disabled" block? | ALL power-dial entry points, server-enforced; regular click-to-dial, manual calls, inbound untouched |
| Initial enabled set | **Nobody** — default off for everyone, admins flip users on individually |
| Relation to admin | Independent — admins are not implicitly enabled |
| In-flight sessions on disable | Unaffected; only NEW starts are blocked |
| The "swap" | Runbook + idempotent script: all 14 reps' `User.CallCenterId` → Caller Reputation CTI |

## 1. Data

Migration `0029` (additive, `IF NOT EXISTS`, mirroring `0028`'s style):

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS power_dialer_enabled boolean NOT NULL DEFAULT false;
```

Drizzle schema: `powerDialerEnabled: boolean('power_dialer_enabled').default(false).notNull()`
next to `inboundEnabled` in `services/cti-api/src/db/schema.ts`.

No seed. Default false is the launch state for all existing and future users.

## 2. Server enforcement

A shared guard in `services/cti-api/src/routes/dialer.ts`:

```ts
/** 403 unless the session's user has power_dialer_enabled. */
function requirePowerDialer(user: SessionUser, reply: FastifyReply): boolean
```

Applied to every power-dial ENTRY point:

- `GET  /dialer/salesforce/listviews`
- `POST /dialer/sessions`
- `POST /dialer/sessions/from-listview`
- `POST /dialer/handoffs` (the Salesforce LWC relay — blocks SF-initiated runs too)
- `GET  /dialer/handoffs/pending`

Refusal shape: `403 { error: 'power_dialer_disabled' }`.

Explicitly NOT gated:

- Session management (`pause` / `resume` / `skip` / `stop` / `next`) — disabling a
  user mid-run must not strand an in-flight session. A disabled user cannot have
  started one anyway.
- Twilio webhooks (`/telephony/twilio/dialer-*`) — machine-to-machine.
- Everything outside the power dialer: click-to-dial, manual dial, inbound,
  recordings, follow-ups.

## 3. Admin API

In `services/cti-api/src/routes/admin.ts`, using its existing admin-only
session check:

- `GET /admin/team` → `{ users: [{ id, email, displayName, isAdmin, inboundEnabled, powerDialerEnabled }] }`
  for the caller's org, sorted by displayName.
- `PATCH /admin/team/:userId` body `{ powerDialerEnabled: boolean }` → updates
  the flag for a user IN THE CALLER'S ORG (org-scoped in the WHERE clause, same
  IDOR-proof shape as the mobile device routes), 404 otherwise. Logs
  `power_dialer_enabled changed` with actor id, target id, and new value.

`GET /auth/me` adds `powerDialerEnabled` to its `user` object.

## 4. Softphone (apps/cti-web)

- `nav.ts`: `navTabsFor(user)` takes `{ isAdmin, powerDialerEnabled }`; the
  **Power Dial** tab is included only when `powerDialerEnabled`. Admins without
  the flag do not see it either.
- New **Team** panel (admin-only, in the "More" overflow beside Reputation):
  lists `GET /admin/team` users — name, email, badges for Admin/Inbound — with
  one toggle per row for **Power Dialer**. Toggle PATCHes, optimistic update,
  toast on failure. Effect: server gate is instant; the rep's own tab bar
  updates on their next `/auth/me` refresh (reload/login).
- If a stale client still fires a gated request, surface the 403 as
  "Power dialing isn't enabled for your account." — no crash.
- `cti-desktop` note: its views have diverged. If it renders a Power Dial tab it
  gets the same `navTabsFor` change; if not, the server gate still protects.
  Verify during implementation; do not restyle anything else.

## 5. Salesforce parity note (no build)

**Corrected during implementation (2026-08-26):** the original assumption that a
permission set controls the list-view dial button was FALSE. The deployed path
is WebLink → Visualforce → `PowerDialListController` → `PowerDialRelay`, and
`PowerDialRelay.isSystemAdministrator()` hard-gates it to the System
Administrator profile in Apex — no permission set is involved. So today the SF
button works for admins only; extending it to non-admin enabled reps requires
changing that Apex gate (a future SF deploy). The CTI server 403 remains the
authoritative gate either way. See `docs/runbooks/cti-swap.md` §4 for the
operational truth. No automated sync — YAGNI.

## 6. The swap (runbook + script)

`docs/runbooks/cti-swap.md` + `services/cti-api/scripts/swap-call-center.mjs`:

1. Query the org's CallCenter Id for `CallerReputationCTI` (via sf CLI).
2. For each of the 14 reps (roster by email, from the onboarding roster):
   `sf data update record -s User` set `CallCenterId` to that Id. Idempotent —
   re-runs are no-ops. Prints before/after per user.
3. Verify: SOQL all 14 users' `CallCenterId` matches; print a table.
4. Rollback: the script records each user's previous CallCenterId to a local
   JSON before writing; a `--rollback <file>` mode restores it.
5. Ordering: run AFTER the flag deploys, so the full team lands with power
   dialing dark until individually enabled in the Team panel.

## 7. Testing

- Route tests (vitest, existing fake-db + `renderPredicate` idioms):
  - Each gated endpoint: 403 `power_dialer_disabled` when flag false; normal
    behavior when true. The PATCH route's org-scoping predicate is pinned with
    `renderPredicate` (the IDOR lesson from the mobile routes).
  - `/admin/team`: non-admin → 403; admin sees only own-org users.
  - Session-management endpoints remain accessible with the flag off.
- Web tests: `navTabsFor` excludes Power Dial when disabled (including for
  admins); Team panel renders users and PATCHes on toggle.
- Migration additive; api `tsc` + full suite; web typecheck + build.

## Out of scope

- Automated SF permset sync for the LWC (manual parity per runbook).
- Killing in-flight sessions on disable.
- Any change to click-to-dial, inbound, follow-ups, recordings.
- Generalized per-user feature-flag framework — one boolean, like `inbound_enabled`.
