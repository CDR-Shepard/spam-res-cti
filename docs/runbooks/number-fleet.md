# Number fleet purchase (192 numbers)

Buys the inbound-team fleet: tops up 4 reps to 6 LA + 6 SD each, builds a 120-number
hire reserve (60 LA / 60 SD), and grows the dialer pool from 10 to 50. One-time cost
~$220, recurring ~$250/mo (see [Cost](#6-cost)).

All commands are copy-pasteable. `plan`/`buy-*`/`register` come from
`scripts/buy-agent-numbers.ts`, which was built for exactly this run — see
`services/cti-api/src/fleet/plan.ts` for the area-code policy (LA = 213/323, SD =
619/858) and per-rep target (6 LA + 6 SD).

## 0. Preconditions

```bash
git branch --show-current
```

Must print `feat/number-fleet` (running before the merge) or `main` (running after
Tasks 1–6 have been merged). If it prints anything else, stop — you're not on code
that has this script.

```bash
railway status
```

Must show project **`endearing-comfort`** (the production project — the Salesforce
org attached to it is cosmetically labelled "Dev Org", so trust the project name,
not the labels). Every command below inherits its Twilio credentials and its
database from whatever this prints, so a checkout linked to a different project
silently buys against a different account. If it shows anything else, run
`railway link` and pick `endearing-comfort` before continuing.

Immediately before the first `CONFIRM_BUY=1` command, re-run `plan` (§2) one more
time and confirm the `TOTAL` line still reads `192`. If someone else bought or
registered numbers between planning and now, the total will have moved — stop and
re-plan the batches below instead of buying against stale numbers.

## 1. Env pattern

Run everything from `services/cti-api`:

```bash
cd services/cti-api
```

Pull the Postgres public URL into a shell variable. **Never `echo $PUB` or paste it
anywhere** — it's a live DB credential.

```bash
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
```

`buy-agent-numbers.ts` uses a **two-phase env pattern**, split by what each
subcommand actually touches (the script's own header comment: "`buy-*` needs
Twilio creds (railway run -s @cti/api), `register`/`assign` need the DB
(DATABASE_URL, else DATABASE_PUBLIC_URL)"):

- **`buy-rep`, `buy-reserve`, `buy-pool`** call Twilio (even on a dry run — they
  search for available numbers), so Twilio credentials come from
  `railway run -s @cti/api` (the linked service); the DB is overridden to the
  public URL since `railway run` executes locally, and `POOL_API_BASE` is the
  voice-webhook base the newly bought numbers get registered against:

  ```bash
  railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts <cmd>
  ```

  A **dry run** is exactly that command. A **real buy** prefixes `CONFIRM_BUY=1`:

  ```bash
  CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts <cmd>
  ```

- **`plan` and `register`** never call Twilio — `plan` only reads Postgres and
  `register` only writes the already-bought hand-off into it — so both run
  directly against the DB, with no `railway run` wrapper:

  ```bash
  env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts plan
  env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts register
  ```

`DATABASE_URL` always wins over any `DATABASE_PUBLIC_URL` the service happens to
export, so the `env DATABASE_URL="$PUB"` prefix above is authoritative in every
command — including the `railway run` ones.

## 2. Dry-run everything first

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts plan
```

Expect:

```
evren@gghomessd.com: holds ... usable → buy 6 LA + 1 SD
matt@sjoinvestments.com: holds ... usable → buy 4 LA + 3 SD
tyler@sjoinvestments.com: holds ... usable → buy 3 LA + 3 SD
jona@gghomessd.com: holds ... usable → buy 6 LA + 6 SD
pool: 10 active → buy 40
reserve suggestion: 10 hires × (6 LA + 6 SD) = 60 LA + 60 SD
TOTAL (with reserve 120): 192
```

A line reading `hand-off: <n> purchased awaiting register (excluded from buy
targets above)` means a previous batch bought numbers that were never
`register`ed. Those are NOT in any count above: run `register` (§3) first, then
re-run `plan` — the totals will move.

Then dry-run every `buy-*` below (same commands as §3, without `CONFIRM_BUY=1`).
Each prints `[dry-run] would buy <number> (<area code>) → <label>` once per number
it would purchase — the line count must match the batch's expected count. No
purchase happens on a dry run; `register` has nothing to consume yet.

## 3. Buy + register, batch by batch

Buy **one batch**, `register` it, confirm the count, then move to the next. Do not
queue multiple `CONFIRM_BUY=1` batches back to back — `register` after each one is
what turns a Twilio purchase into a usable, protected number.

**After EVERY `register` in this section, run the Trust Hub assignment:**

```bash
railway run -s @cti/api -- node scripts/trusthub-assign.mjs
```

It is idempotent and cheap (it skips everything already assigned), and it is the
only thing standing between a freshly registered number and outbound calls that
carry no attestation. Numbers must never sit in rotation unattested, so do not
save it for the end — §5 re-runs it once more as a whole-fleet sweep. After
Batch 1 (7 numbers on top of today's 29) expect:

```
business profile: assigned 7, already 29, failed 0 → now 36/36
SHAKEN/STIR: assigned 7, already 29, failed 0 → now 36/36
```

Every later batch reads the same shape with `assigned` = that batch's size,
`already` = everything before it, and `failed 0`. A non-zero `failed`, or a
non-zero exit code, stops the run — read the `FAIL` lines above the summary.

### Batch 1 — Evren (7: 6 LA + 1 SD)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email evren@gghomessd.com
```

Expect 7 `BOUGHT` lines (6 tagged `Agent evren LA`, 1 tagged `Agent evren SD`).

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts register
```

Expect a table with 7 rows, each `registered: agent→evren@gghomessd.com`. A row
reading `updated (existing)` means that number already had a row on this org, so
`register` refreshed its Twilio SID and filled in only the columns still empty
instead of dropping a number you paid for — expect none on a clean first batch.

**First-register proof** (only needed once, right here): confirm the hand-off
drained —

```bash
cat fleet-buy.json
```

must print `[]`. Then run `register` again —

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts register
```

must die with

```
ERROR: Hand-off <repo>/services/cti-api/fleet-buy.json empty. If you HAVE bought numbers and lost the hand-off, do NOT re-buy — run fleet-report to reconcile (orphans are listed) and admin import-twilio to recover them.
```

and exit non-zero. That proves `register` genuinely consumes the hand-off instead
of silently re-inserting — trust the rest of the batches below without repeating
this check. Note the path: the hand-off lives next to the script
(`services/cti-api/fleet-buy.json`) no matter which directory you run from, so a
`cd` can never start an empty one behind your back. **If that error ever appears
when you believe numbers were bought, follow it literally — do not re-buy.**

### Batch 2 — Matt (7: 4 LA + 3 SD)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email matt@sjoinvestments.com
```

Expect 7 `BOUGHT` lines (4 `Agent matt LA`, 3 `Agent matt SD`).

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts register
```

Expect 7 rows, each `registered: agent→matt@sjoinvestments.com`.

### Batch 3 — Tyler (6: 3 LA + 3 SD)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email tyler@sjoinvestments.com
```

Expect 6 `BOUGHT` lines (3 `Agent tyler LA`, 3 `Agent tyler SD`).

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts register
```

Expect 6 rows, each `registered: agent→tyler@sjoinvestments.com`.

### Batch 4 — Jona (12: 6 LA + 6 SD)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email jona@gghomessd.com
```

Expect 12 `BOUGHT` lines (6 `Agent jona LA`, 6 `Agent jona SD`).

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts register
```

Expect 12 rows, each `registered: agent→jona@gghomessd.com`.

### Batch 5 — Hire reserve (120: 60 LA + 60 SD, unassigned)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-reserve --la 60 --sd 60
```

Expect 120 `BOUGHT` lines (60 `Agent Reserve LA`, 60 `Agent Reserve SD`).

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts register
```

Expect 120 rows, each `registered: agent (reserve)`.

### Batch 6 — Dialer pool (40, 619/951 mix)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-pool --count 40
```

Expect a split line and 40 `BOUGHT` lines tagged `Dialer Pool` — 20 in each area
code, not 40 in whichever one Twilio happens to have most of:

```
pool: 10 active, target 50, hand-off 0 → buying 40
pool split: 20 from 619 + 20 from 951
```

If one area code runs dry mid-half, that half falls through to the other and prints
`WARN: area code <code> ran dry for "Dialer Pool" — falling through to <code> for
the last <n>.`

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts register
```

Expect 40 rows, each `registered: dialer_pool (reserve)`.

That's all 192 (7 + 7 + 6 + 12 + 120 + 40 = 192).

## 4. Notes

- **Buy commands are targets, not increments.** Every `buy-*` re-reads the live DB
  plus whatever is already sitting in the hand-off unregistered, then buys only the
  shortfall against the number in this runbook. Re-running a batch you already ran
  (accidentally, or after an interruption) is safe — it buys nothing further.
- **One exception, and it is by design: `buy-reserve` counts only FREE reserve.**
  Its `--la`/`--sd` are the size the *unassigned* reserve should reach, so once
  `assign` (§7) has handed reserve numbers to a rep, they stop counting and a
  re-run of `buy-reserve --la 60 --sd 60` buys replacements up to 60 free again —
  which is the point of a hire reserve, not a bug. If you do not want replacements,
  dry-run it first (same command without `CONFIRM_BUY=1`) and read its own count
  line — `reserve LA: <n> free, target <n>, hand-off <n> → buying <n>` — before
  committing.
- **Area-code scarcity.** If Twilio runs short of numbers in an area code mid-batch,
  the command prints `WARN: <n> of <count> unfilled for "<label>" — area codes
  exhausted (or widen codes); re-run the same command later — it only buys the
  shortfall.` Register what did get bought, then re-run the exact same `buy-*`
  command later (unchanged args) once inventory frees up — it will buy only the
  remainder.

## 5. After all batches: protect + verify

**Trust Hub sweep** — you already ran this after every `register` in §3; run it
once more over the whole fleet so nothing bought in a partially-completed batch is
left unattested:

```bash
railway run -s @cti/api -- node scripts/trusthub-assign.mjs
```

Because §3 kept up, expect `assigned 0` and everything already there:

```
business profile: assigned 0, already 221, failed 0 → now 221/221
SHAKEN/STIR: assigned 0, already 221, failed 0 → now 221/221
```

Exit 0. A non-zero `assigned` here means a §3 run was skipped (harmless — it just
did the work now); a non-zero `failed` or exit code means read the `FAIL` lines
above the summary before moving on.

**NumberVerifier enrollment manifest** — DB-only, no Twilio creds needed, so run it
directly (no `railway run` wrapper):

```bash
env DATABASE_URL="$PUB" npx tsx scripts/nv-enrollment-manifest.ts > /tmp/nv-enrollment-manifest.csv
```

The stderr summary line prints to the terminal: expect roughly `# 221 numbers, 221
not yet reported on by NumberVerifier` (every number, old and new, is
`enrolled=no` — see `docs/runbooks/numberverifier-enrollment.md` §Why). Hand
`/tmp/nv-enrollment-manifest.csv` to the admin along with
[`docs/runbooks/numberverifier-enrollment.md`](./numberverifier-enrollment.md) — the
manual per-number dashboard enrollment is theirs to run, not part of this runbook.

**Acceptance gate** — must exit 0 before calling the fleet done:

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" npx tsx scripts/fleet-report.ts
```

It prints one line per active number, then reconciles Twilio back against the DB,
then the tallies. Expect:

- Every per-number line reads
  `<e164> | <kind> | <rep> | <area> | db✓ | twilio✓ | webhook✓ | trusthub✓ | shaken✓ | inbound✓ | nv:…`.
  Any `✗` among those six counts toward `not fully provisioned`. `inbound✗` means
  the row's `inbound_enabled` is false: Twilio still points the number at our
  webhook, so it *answers*, but with the generic
  "this line cannot accept inbound calls" decline instead of the greeting/voicemail
  flow — which is what a carrier reverse-probe hears. Fix with
  `PATCH /admin/outbound-numbers/:id`, then re-run.
- `REP evren@gghomessd.com: 6/6 LA, 6/6 SD ✓` — and the same for matt, tyler, jona.
  There is one `REP` line per non-dev user in the `users` table, whether or not
  they hold any numbers, so a rep with nothing prints
  `REP <email>: 0/6 LA, 0/6 SD ✗ SHORT` instead of vanishing from the report.
- Matt's benched `+12137742225` prints its row with a trailing
  `benched:degraded (uncounted)` and does **not** count toward his six LA — his
  line reads `6/6`, never `7/6`.
- Reserve and pool rows print with rep column `-` (unassigned) — they never appear
  in the `REP ...` lines.
- `POOL: 50/50 ✓`
- **No `ORPHAN` lines.** `ORPHAN <e164> (<sid>) — purchased but never registered`
  means a number is charged to the Twilio account and carries our inbound webhook
  but has no `outbound_numbers` row: it is billing monthly and the app cannot see
  it. Recover it with the admin panel's **Import from Twilio** (never by re-buying).
  An `UNTRACKED <e164> (<sid>) — Twilio-owned, not on our inbound webhook` line is
  informational only: a number owned for some other purpose.
- `ALL PROVISIONED`
- Exit code `0`

Anything else exits `1` with a line reading
`FAIL: <n> number(s) not fully provisioned, <n> orphan(s), <n> target shortfall(s)`.
If any rep line reads `SHORT`, or `POOL` is under 50, or an `ORPHAN` is listed, do
not consider the fleet delivered — check which `buy-*`/`register` batch above was
skipped or under-filled by a `WARN` and rerun it.

## 6. Cost

~$220 one-time (192 numbers × Twilio's per-DID purchase price), ~$250/mo recurring
(192 numbers × Twilio's per-DID monthly fee) added to the existing fleet's bill.

## 7. Future hires

Once the reserve exists, a new rep is one command — no purchase, no Twilio
credentials, no waiting. The normal case below needs only the DB; the
short-reserve fallback after it spends money, so it needs the Twilio phase from §1.

**Normal case — take 6 LA + 6 SD from the reserve:**

```bash
env DATABASE_URL="$PUB" npx tsx scripts/buy-agent-numbers.ts assign --email newhire@gghomessd.com
```

Expect 12 lines, then nothing else:

```
ASSIGNED +12135550101 → newhire@gghomessd.com
... (12 in total: 6 LA, 6 SD)
```

`assign` moves only what the rep still needs, so re-running it for a rep already at
6/6 prints nothing. Confirm with the acceptance gate (§5): their `REP` line must
read `6/6 LA, 6/6 SD ✓`.

**Short-reserve case — buy for that rep directly.** If the reserve has run down,
`assign` prints e.g. `WARN: reserve has 2/6 free LA numbers — buy more reserve.`
and assigns only what it found. Top the rep up from Twilio (this one spends money,
so it needs the Twilio phase and `CONFIRM_BUY=1`):

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email newhire@gghomessd.com
```

Expect one `BOUGHT` line per number still missing (4 here), then `register`, then
the Trust Hub assignment — exactly the §3 loop:

```
BOUGHT +12135550199 (PN…) → Agent newhire LA
```

Then rebuild the reserve for the next hire with `buy-reserve --la <n> --sd <n>`
(§3 Batch 5), remembering the free-reserve semantics in §4.

Also assign the Salesforce permission set (field access for the Skip on Dialer checkbox — without it the dialer cannot read the flag for that rep and silently treats records as unflagged):

```bash
cd salesforce && sf org assign permset -n Skip_On_Dialer -o _t2 -b <newhire-sf-username>
```

Note: the SF *username* may differ from the email (e.g. evren@gghomessd.com is the email; the username is evren2@gghomessd.com). Resolve it with `sf data query -q "SELECT Username FROM User WHERE Email = '<email>'" -o _t2` first.
