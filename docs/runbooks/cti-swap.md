# CTI swap: cut every rep over to Caller Reputation CTI

## What this is

Every CTI rep's Salesforce user record has a `CallCenterId` pointing at
whichever Salesforce Call Center they currently place/receive calls
through. This runbook is the one-time cutover that repoints every rep's
`CallCenterId` at the org's `CallerReputationCTI` Call Center — the one
backed by our own softphone (`apps/cti-web`, served by `services/cti-api`
at `/cti/` and loaded as a Lightning utility item) — so Salesforce's native
click-to-dial and the softphone's screen-pop start working for the whole
team instead of whatever CTI adapter they were on before.

The mechanics are handled by
`services/cti-api/scripts/swap-call-center.mjs`: scope is pinned to the 12-rep
cutover roster (`scripts/cti-swap-roster.txt` — user ruling 2026-08-26: admins
and test fixtures are NOT swapped; a roster email with no CTI user row is a
hard error). Within that scope the roster is **derived
from the CTI `users` table** (never hardcoded — several reps' Salesforce
**usernames** carry a `.2`/`.3` suffix from an earlier dedup, so the script
matches on the `Email` **field**, not `Username`), it is **idempotent**
(re-running it after some reps are already swapped only touches the ones
still on the old center), and every `--apply` run records a rollback JSON
before writing anything.

This is purely the Salesforce-user-record swap. It does **not** touch
Power Dialer enablement — that is a separate, per-user, admin-controlled
flag (`users.power_dialer_enabled`, migration `0029_power_dialer_enabled.sql`)
with its own toggle in the softphone's Team panel. See §3 below for how the
two relate.

## 1. Preconditions

1. **The Power Dialer enablement feature is deployed to prod.** Confirm
   migration `0029_power_dialer_enabled.sql` has actually run, using the
   same `$PUB` env pattern as `docs/runbooks/caller-id-app.md` §2a
   (`DATABASE_PUBLIC_URL` pulled from Railway's `Postgres` service, since
   this command runs locally rather than inside the Railway network):

   ```bash
   cd services/cti-api
   railway status   # must show project `endearing-comfort` — if not, `railway link` and pick it
   PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
   DATABASE_URL="$PUB" node -e "
   const { Client } = require('pg');
   (async () => {
     const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
     await c.connect();
     const r = await c.query(\"select filename, applied_at from cti_schema_migrations where filename = '0029_power_dialer_enabled.sql'\");
     console.log(r.rows);
     await c.end();
   })();
   "
   ```

   One row back means the migration ran. An empty array means the deploy
   hasn't migrated yet — stop here and don't proceed until it has (re-run
   `env DATABASE_URL="$PUB" npm run migrate`, or however this repo's deploy
   pipeline applies migrations, and re-check).

2. **Nobody expects Power Dialer to light up as a side effect of this
   swap.** Migration `0029` adds `power_dialer_enabled boolean NOT NULL
   DEFAULT false` — every existing and future user starts with it off, and
   it is flipped per user by an admin from the softphone's Team panel
   (§3). This swap only changes *which Call Center* a rep's Salesforce user
   is wired to; it grants nobody a new capability by itself.

3. Confirm `sf` is authenticated against the org alias the script defaults
   to, `_t2` (**production**, `gghsd.my.salesforce.com` — the sandbox alias
   is `gghsd-maindev` and must never be the target of this swap):

   ```bash
   sf org list --json | grep -vE 'postgres://|postgresql://|TOKEN|SECRET' | grep -A2 '"alias": "_t2"'
   ```

   `connectedStatus` should read `Connected`. `sf org list` output includes
   live access tokens — never paste raw output into chat, a ticket, or a
   commit; redact through `grep -vE 'postgres://|postgresql://|TOKEN|SECRET'`
   (or just don't print it) whenever you capture command output for a
   record of this runbook's execution.

## 2. The swap

Everything below runs from `services/cti-api`. **Dry run first, always** —
it is the default (no flag needed) and is read-only against Salesforce (it
issues `sf data query` only, never a write via `sf api request rest`):

```bash
cd services/cti-api
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
env DATABASE_URL="$PUB" node scripts/swap-call-center.mjs --roster scripts/cti-swap-roster.txt
```

Expected output: one line per rep —

- `ok     <Name> <<email>>` — already on `CallerReputationCTI`, nothing to do.
- `swap   <Name> <<email>>` — currently on some other Call Center (or none),
  will be repointed on `--apply`.
- `no active SF user for: <email>` — a CTI `users` row has no matching
  **active** Salesforce User by email. This is expected for any purely
  internal/test CTI account that was never given a Salesforce login;
  confirm it isn't a rep who's supposed to be live before proceeding.
- `DUPLICATE EMAIL: <email> matched N users (<names>)` — more than one
  active Salesforce User shares that email (seen live in `_t2`: a real rep
  and a shared "Integration User" account both use the same address). Every
  matched user gets planned and would get repointed on `--apply` — resolve
  which one(s) should actually move before running `--apply` for that email;
  do not assume the extra match is harmless just because it printed.

then a summary line: `DRY RUN — N to change. Re-run with --apply.` and
exit `0`. If the dry run errors instead (missing `CallerReputationCTI` Call
Center, `sf` not authenticated, DB unreachable), fix that before going
further — do not try to route around it with `--apply`.

Once the dry run's plan looks right, apply it:

```bash
env DATABASE_URL="$PUB" node scripts/swap-call-center.mjs --roster scripts/cti-swap-roster.txt --apply
```

This:

1. Re-resolves the same plan (so it reflects whatever is true in Salesforce
   *right now*, not a stale dry run from earlier).
2. **Writes `swap-rollback-<timestamp>.json` in the current directory
   before making any change in Salesforce.** Each row is
   `{ sfId, email, name, previousCallCenterId, alreadyDone }` — this file
   is the only record of what every rep's Call Center was before the swap.
3. Calls `sf api request rest` (a `PATCH` on
   `/services/data/v61.0/sobjects/User/<id>` with a JSON body) only for the
   reps still marked `swap` (the `ok` ones are left untouched — that's the
   idempotency). A JSON body is used rather than `sf data update record`
   because the latter's `-v "Field=''"` syntax cannot express `null` for a
   lookup field, which matters for rollback (§5) whenever a rep's prior
   `CallCenterId` was null.
4. Re-queries every affected user's `CallCenterId` and prints either
   `VERIFIED: all N users on CallerReputationCTI` or
   `VERIFY FAILED for: <emails>` if any didn't stick.

**Keep the rollback JSON.** It is the only way back (§5) and it is not
committed to git and not reproducible after the fact — move it somewhere
durable (the runbook-execution ticket, a shared ops drive, wherever this
team keeps operational artifacts) as soon as the apply finishes. It
contains Salesforce record ids and emails, not secrets, but treat it as
sensitive operational data — don't paste it into a public channel.

## 3. Enablement (Power Dialer, per user)

The Call Center swap in §2 does not turn Power Dialer on for anyone — it
only makes the new CTI the system of record for calling. Power Dialer
itself is a separate, per-user grant:

1. An admin opens the softphone → **More** (the overflow tab that holds
   admin-only tools) → **Team**.
2. For each rep who should get Power Dialer, click the
   **Power Dialer: Off** pill next to their name to flip it to
   **Power Dialer: On** (`PATCH /admin/team/:userId`,
   `apps/cti-web/src/components/TeamPanel.tsx`).
3. **The rep does not see the Power Dial tab until their next reload or
   login** — the Team panel's toggle updates the `users` row immediately,
   but the softphone's own nav only reflects `power_dialer_enabled` off the
   `/auth/me` payload it fetched at load time. Tell the rep to refresh (or
   just let their next normal login pick it up) rather than expecting the
   tab to appear live in an already-open tab.
4. **The server-side gate is instant, independent of the UI.** Every
   dialer-starting endpoint (`routes/dialer.ts`'s `requirePowerDialer`)
   checks the live `power_dialer_enabled` value on every request — so
   flipping it off immediately blocks further calls with a 403 even if a
   stale open tab is still showing the tab, and flipping it on immediately
   unblocks the API even before the rep reloads to see the tab appear.

## 4. Salesforce parity (list-view "Power Dial" button)

The live Lead/Opportunity list-view **Power Dial** button is a
`massActionButton` WebLink (`objects/Lead/webLinks/Power_Dial.webLink`,
`objects/Opportunity/webLinks/Power_Dial.webLink`) that opens a Visualforce
page (`pages/PowerDialListLead.page` / `pages/PowerDialListOpp.page`)
backed by `PowerDialListController.cls`, which reads the checked rows
(via the standard set controller's server-side `getSelected()`) and calls
`PowerDialRelay.sendToCti()`. That is the only path wired into the deployed
org. (`salesforce/force-app/main/default/lwc/powerDial/` and
`flows/PowerDial_List.flow-meta.xml` are an earlier LWC + Screen Flow
design for the same button — nothing in the deployed metadata (no list
button, page layout, or Lightning page) references either of them, so
don't take their README as a description of what's actually live.)

**As of 2026-08-26, this button works only for System Administrator
profile users, and there is no permission set involved in that gate.**
`PowerDialRelay.cls`'s private `isSystemAdministrator()` (around lines
150–153) does a hard `Profile.Name == 'System Administrator'` check, and
it is called from both `sendToCti()` (the rollout-gate check and comment
around lines 34–39 — this is what actually throws for a non-admin who gets
this far) and the cacheable `canUsePowerDial()` (around lines 145–148,
intended for a caller to hide the button for non-admins). There is no
permission set, custom setting, or other metadata switch anywhere in this
gate today — a rep's profile is the only input. Assigning any permission
set to a non-admin rep changes nothing here: `sendToCti()` still throws an
`AuraHandledException`/error page via `isSystemAdministrator()` regardless
of what permission sets that rep holds.

Given that:

- **The CTI server gate and Team panel from §3 are the operative,
  real per-rep controls** (`power_dialer_enabled` + `requirePowerDialer`).
  Nothing in this runbook grants or revokes SF-button access per rep,
  because nothing per-rep currently exists on the SF side to grant.
- **The Salesforce list-view button is not a per-user control today.** It
  is either available (System Administrator profile) or not, independent
  of `power_dialer_enabled`, independent of this swap, and independent of
  anything toggled in the Team panel. An admin whose `power_dialer_enabled`
  is off still sees the button but gets rejected server-side by the CTI API
  when they try to actually dial; a non-admin never sees a working button
  regardless of their `power_dialer_enabled` value.
- **Extending the SF button to non-admin enabled reps requires changing the
  gate in `PowerDialRelay.cls`** — replacing or supplementing
  `isSystemAdministrator()` in both `sendToCti()` and `canUsePowerDial()`
  with a check tied to real per-rep enablement (for example, having Apex
  call back to the CTI API for the live `power_dialer_enabled` value, or
  introducing an actual permission set and checking `FeatureManagement` /
  `hasPermissionSet` against it) — and deploying that Apex change to `_t2`.
  That is a separate, future Salesforce deploy, out of scope for this
  runbook. **Do not try to work around it by creating or assigning a
  permission set** — none exists in the gate as written, and one would not
  change `isSystemAdministrator()`'s behavior.

This SF-button-admin-only vs. CTI-server-per-rep-enablement gap is a known,
deliberate limitation of this rollout — see
`docs/superpowers/specs/2026-08-25-power-dialer-enablement-design.md`
§"Out of scope" ("Automated SF permset sync for the LWC (manual parity per
runbook)" — that line predates the discovery that the gate is a hard-coded
profile check rather than a permset, but the conclusion still holds:
Salesforce-side parity for this button is a manual, out-of-band concern
this runbook does not automate).

## 5. Rollback

If the swap needs to be undone for some or all reps — wrong roster, a
regression found in the new CTI, whatever the reason — restore every
user's previous `CallCenterId` from the rollback JSON `--apply` wrote in
§2:

```bash
cd services/cti-api
env SF_ORG=_t2 node scripts/swap-call-center.mjs --roster scripts/cti-swap-roster.txt --rollback swap-rollback-<timestamp>.json
```

This re-reads each row's `previousCallCenterId` and writes it straight
back via `sf api request rest` (the same `PATCH`-with-JSON-body call used
by `--apply`, which correctly expresses `null` for a rep whose prior
`CallCenterId` was empty — `sf data update record`'s `-v` syntax cannot),
printing `rolled back <email> -> <previousCallCenterId or (none)>` per
user — `(none)` means that rep had no `CallCenterId` set at all before the
swap (new hire, or was never on any CTI), and rollback correctly clears it
rather than leaving `CallerReputationCTI` in place.

**A single row's failure does not abort the rollback.** If one user's
PATCH fails (permissions, a stale/deleted Id, a transient API error), that
row is logged as `FAILED to roll back <email> (<sfId>): <error>` and the
loop continues to the remaining rows — a rollback must never die mid-loop
and leave the rest of the roster un-rolled-back. At the end, if any row
failed, the script prints a `ROLLBACK INCOMPLETE — N of M row(s) failed:`
summary listing every failed row and exits non-zero; re-run the same
`--rollback` command (it's safe to retry — `ok` rows just get re-PATCHed to
the same value) or fix the underlying issue for the specific failed row(s)
by hand in Setup.

Rollback does not touch Power Dialer's `power_dialer_enabled` flag. (There
is currently no SF-side permission set to also reverse — see §4: SF-button
access is gated purely by the System Administrator profile check in
`PowerDialRelay.cls`, not by any assignable permission set.) If the whole
rollout is being unwound, not just the Call Center, also uncheck Power
Dialer for the affected reps in the Team panel (§3).

There is no dry-run mode for `--rollback` — it always writes (per-row
failures noted above are logged and skipped, not previewed). Only run it
against a rollback file you trust (ideally the one this exact swap
produced) and on the same org (`_t2`) it was generated against.

## 6. Verify

1. **The script's own verification.** A clean `--apply` run ends with
   `VERIFIED: all N users on CallerReputationCTI` — that's a SOQL re-query
   of every affected user's live `CallCenterId`, not just an assumption
   that the update calls succeeded. If it instead prints
   `VERIFY FAILED for: <emails>`, treat the swap as incomplete for those
   reps and re-run the dry run to see their current state before deciding
   whether to retry or investigate in Setup directly.
2. **One rep, one real call.** The SOQL check only proves the Salesforce
   user record points at the right Call Center — it doesn't prove the
   softphone actually pops. Pick one rep who was just swapped and confirm:
   - They're logged into Salesforce with the CTI softphone utility item
     open (`apps/cti-web`, served at `/cti/`).
   - An inbound call to one of their assigned DIDs
     (`outbound_numbers.assigned_user_id`) makes the softphone ring and
     screen-pop the matching Lead/Opportunity/Deal — the same
     click-to-call and inbound-pop behavior documented as this CTI's core
     loop — rather than nothing happening or the old vendor's widget
     appearing.
   - Outbound: clicking a phone number on a Lead/Opportunity record in
     Salesforce places the call through the new softphone, not the old
     CTI adapter.

   If either direction misbehaves for that rep, don't proceed with the
   rest of the roster until it's understood — a Call Center mis-swap is
   easy to reproduce (rollback per §5) but should not roll forward at
   scale on a rep whose adapter needed troubleshooting.
