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
`services/cti-api/scripts/swap-call-center.mjs`: the roster is **derived
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
issues `sf data query` only, never `sf data update record`):

```bash
cd services/cti-api
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
env DATABASE_URL="$PUB" node scripts/swap-call-center.mjs
```

Expected output: one line per rep —

- `ok     <Name> <<email>>` — already on `CallerReputationCTI`, nothing to do.
- `swap   <Name> <<email>>` — currently on some other Call Center (or none),
  will be repointed on `--apply`.
- `no active SF user for: <email>` — a CTI `users` row has no matching
  **active** Salesforce User by email. This is expected for any purely
  internal/test CTI account that was never given a Salesforce login;
  confirm it isn't a rep who's supposed to be live before proceeding.

then a summary line: `DRY RUN — N to change. Re-run with --apply.` and
exit `0`. If the dry run errors instead (missing `CallerReputationCTI` Call
Center, `sf` not authenticated, DB unreachable), fix that before going
further — do not try to route around it with `--apply`.

Once the dry run's plan looks right, apply it:

```bash
env DATABASE_URL="$PUB" node scripts/swap-call-center.mjs --apply
```

This:

1. Re-resolves the same plan (so it reflects whatever is true in Salesforce
   *right now*, not a stale dry run from earlier).
2. **Writes `swap-rollback-<timestamp>.json` in the current directory
   before making any change in Salesforce.** Each row is
   `{ sfId, email, name, previousCallCenterId, alreadyDone }` — this file
   is the only record of what every rep's Call Center was before the swap.
3. Calls `sf data update record` only for the reps still marked `swap`
   (the `ok` ones are left untouched — that's the idempotency).
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

## 4. Salesforce parity (list-view dial button visibility)

Salesforce also has its own client-side gate: the Lead/Opportunity
list-view "Power Dial" button (the `powerDial` LWC, launched via a List
Button + Screen Flow — see `salesforce/force-app/main/default/lwc/powerDial/README.md`)
is visibility-scoped to a permission set, separately from the server-side
`power_dialer_enabled` flag. **The server 403 (§3.4) is the authoritative
gate — this permission set only controls whether the button/flow shows up
in the Salesforce UI.** A rep with the permset but `power_dialer_enabled =
false` still gets a 403 if they click through; a rep without the permset
just never sees the button, even if an admin already flipped their DB flag
on.

Because the exact permission set name isn't pinned by this runbook (it may
be renamed or reorganized after this was written), look it up fresh at
execution time:

```bash
sf org list metadata -m PermissionSet -o _t2 --json \
  | grep -vE 'postgres://|postgresql://|TOKEN|SECRET' \
  | sed -n '/^{/,$p' \
  | node -e "
let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
  const names = JSON.parse(d).result.map(r => r.fullName);
  console.log(names.filter(n => /dial|power/i.test(n)).join('\n'));
});
"
```

Pick the one whose name and (in Setup → Permission Sets → that set →
description) description clearly describe the list-view Power Dial button
— **as of this writing no such permission set exists yet in `_t2`**, in
which case create it first (Setup → Permission Sets → New; grant it "Read"
on the `powerDial` Lightning component / the List Button; do not grant
anything beyond visibility of that button) before assigning it below.

For each rep enabled in §3, assign the permset by username (not email —
`-b` takes the Salesforce **username**, which is why the roster match in
the swap script itself uses email instead):

```bash
sf org assign permset -n <PermSetName> -o _t2 -b <rep-sf-username>
```

To remove it from a rep who's being taken off Power Dialer, the modern
`sf` CLI has no direct "unassign" verb — delete the
`PermissionSetAssignment` record:

```bash
sf data query -o _t2 --json -q \
  "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = '<PermSetName>' AND Assignee.Username = '<rep-sf-username>'" \
  | grep -vE 'postgres://|postgresql://|TOKEN|SECRET'
# then, with the Id from the query above:
sf data delete record -o _t2 -s PermissionSetAssignment -i <assignmentId>
```

Keep this list in sync with the Team panel roster from §3 by hand — there
is no automated sync between the DB flag and the SF permset (a deliberate,
documented gap; see
`docs/superpowers/specs/2026-08-25-power-dialer-enablement-design.md` §"Non-goals").

## 5. Rollback

If the swap needs to be undone for some or all reps — wrong roster, a
regression found in the new CTI, whatever the reason — restore every
user's previous `CallCenterId` from the rollback JSON `--apply` wrote in
§2:

```bash
cd services/cti-api
env SF_ORG=_t2 node scripts/swap-call-center.mjs --rollback swap-rollback-<timestamp>.json
```

This re-reads each row's `previousCallCenterId` and writes it straight
back via `sf data update record`, printing
`rolled back <email> -> <previousCallCenterId or (none)>` per user — `
(none)` means that rep had no `CallCenterId` set at all before the swap
(new hire, or was never on any CTI), and rollback correctly clears it
rather than leaving `CallerReputationCTI` in place. Rollback does not
touch Power Dialer's `power_dialer_enabled` flag or the SF permset from §4
— those are reversed separately (uncheck in the Team panel; remove the
permset per §4) if the whole rollout is being unwound, not just the Call
Center.

There is no dry-run mode for `--rollback` — it always writes. Only run it
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
