# Number fleet purchase (192 numbers)

Buys the inbound-team fleet: tops up 4 reps to 6 LA + 6 SD each, builds a 120-number
hire reserve (60 LA / 60 SD), and grows the dialer pool from 10 to 50. One-time cost
~$220, recurring ~$250/mo (see [Cost](#cost)).

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

Every `buy-agent-numbers.ts` invocation (`plan`, `buy-rep`, `buy-reserve`,
`buy-pool`, `register`) uses the same two-phase shape: Twilio credentials come from
`railway run -s @cti/api` (the linked service), the DB is overridden to the public
URL since `railway run` executes locally, and `POOL_API_BASE` is the voice-webhook
base the newly bought numbers get registered against:

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts <cmd>
```

A **dry run** is exactly that command. A **real buy** prefixes `CONFIRM_BUY=1`:

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts <cmd>
```

## 2. Dry-run everything first

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts plan
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

Then dry-run every `buy-*` below (same commands as §3, without `CONFIRM_BUY=1`).
Each prints `[dry-run] would buy <number> (<area code>) → <label>` once per number
it would purchase — the line count must match the batch's expected count. No
purchase happens on a dry run; `register` has nothing to consume yet.

## 3. Buy + register, batch by batch

Buy **one batch**, `register` it, confirm the count, then move to the next. Do not
queue multiple `CONFIRM_BUY=1` batches back to back — `register` after each one is
what turns a Twilio purchase into a usable, protected number.

### Batch 1 — Evren (7: 6 LA + 1 SD)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email evren@gghomessd.com
```

Expect 7 `BOUGHT` lines (6 tagged `Agent evren LA`, 1 tagged `Agent evren SD`).

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts register
```

Expect a table with 7 rows, each `registered: agent→evren@gghomessd.com`.

**First-register proof** (only needed once, right here): confirm the hand-off
drained —

```bash
cat fleet-buy.json
```

must print `[]`. Then run `register` again —

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts register
```

must die with `ERROR: Hand-off ./fleet-buy.json empty — run a buy with
CONFIRM_BUY=1 first.` and exit non-zero. That proves `register` genuinely consumes
the hand-off instead of silently re-inserting — trust the rest of the batches below
without repeating this check.

### Batch 2 — Matt (7: 4 LA + 3 SD)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email matt@sjoinvestments.com
```

Expect 7 `BOUGHT` lines (4 `Agent matt LA`, 3 `Agent matt SD`).

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts register
```

Expect 7 rows, each `registered: agent→matt@sjoinvestments.com`.

### Batch 3 — Tyler (6: 3 LA + 3 SD)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email tyler@sjoinvestments.com
```

Expect 6 `BOUGHT` lines (3 `Agent tyler LA`, 3 `Agent tyler SD`).

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts register
```

Expect 6 rows, each `registered: agent→tyler@sjoinvestments.com`.

### Batch 4 — Jona (12: 6 LA + 6 SD)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-rep --email jona@gghomessd.com
```

Expect 12 `BOUGHT` lines (6 `Agent jona LA`, 6 `Agent jona SD`).

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts register
```

Expect 12 rows, each `registered: agent→jona@gghomessd.com`.

### Batch 5 — Hire reserve (120: 60 LA + 60 SD, unassigned)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-reserve --la 60 --sd 60
```

Expect 120 `BOUGHT` lines (60 `Agent Reserve LA`, 60 `Agent Reserve SD`).

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts register
```

Expect 120 rows, each `registered: agent (reserve)`.

### Batch 6 — Dialer pool (40, 619/951 mix)

```bash
CONFIRM_BUY=1 railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts buy-pool --count 40
```

Expect 40 `BOUGHT` lines tagged `Dialer Pool`.

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" POOL_API_BASE=https://ctiapi-production.up.railway.app npx tsx scripts/buy-agent-numbers.ts register
```

Expect 40 rows, each `registered: dialer_pool (reserve)`.

That's all 192 (7 + 7 + 6 + 12 + 120 + 40 = 192).

## 4. Notes

- **Buy commands are targets, not increments.** Every `buy-*` re-reads the live DB
  plus whatever is already sitting in the hand-off unregistered, then buys only the
  shortfall against the number in this runbook. Re-running a batch you already ran
  (accidentally, or after an interruption) is safe — it buys nothing further.
- **Area-code scarcity.** If Twilio runs short of numbers in an area code mid-batch,
  the command prints `WARN: <n> of <count> unfilled for "<label>" — area codes
  exhausted (or widen codes); re-run the same command later — it only buys the
  shortfall.` Register what did get bought, then re-run the exact same `buy-*`
  command later (unchanged args) once inventory frees up — it will buy only the
  remainder.

## 5. After all batches: protect + verify

**Trust Hub assignment** — puts every number (new and existing) on the approved
business profile and SHAKEN/STIR trust product:

```bash
railway run -s @cti/api -- node scripts/trusthub-assign.mjs
```

Expect two summary lines, each roughly `assigned 192, already 29 → now 221/221`
(one for the business profile, one for SHAKEN/STIR). Exit 0. If it exits non-zero,
read the `FAIL` lines above the summary before moving on.

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

Expect:

- `REP evren@gghomessd.com: 6/6 LA, 6/6 SD ✓` (and the same for matt, tyler, jona)
- Reserve and pool rows print with rep column `-` (unassigned) — they never appear
  in the `REP ...` lines.
- `POOL: 50/50 ✓`
- `ALL PROVISIONED`
- Exit code `0`

If any rep line reads `SHORT`, or `POOL` is under 50, or the exit code is non-zero,
do not consider the fleet delivered — check which `buy-*`/`register` batch above
was skipped or under-filled by a `WARN` and rerun it.

## Cost

~$220 one-time (192 numbers × Twilio's per-DID purchase price), ~$250/mo recurring
(192 numbers × Twilio's per-DID monthly fee) added to the existing fleet's bill.
