# Rollout: package extraction + tenancy (Foundation plan 1)

Two deploys, in this order, each followed by observation. Everything is on
`feat/outreach-foundation`; merge to `main` deploys via Railway (`endearing-comfort`).

## Deploy 1 — extraction only (commits through "docs(packages): …")

1. Deploy 1 is exactly commit `909c7d1` (`docs(packages): …`) — the extraction-only
   boundary, before any tenancy commit. Produce it from a checkout of `main`:
   `git merge --no-ff 909c7d1`, then push/deploy that merge. Deploy 2 (below) is
   the branch tip, merged into `main` the same way (`git merge --no-ff <tip>`).
   Alternatively, the operator may ship both deploys in one merge of the branch
   tip and skip the one-business-day observation window between them — that is
   a real trade-off (deploy 1 is a no-visible-change extraction, so skipping its
   observation mainly forfeits an early, low-noise signal if the extraction
   itself broke something), not a shortcut without cost.
   Railway runs `npm --workspace packages/db run migrate` (expect `0 new of 35 total`) then boots.
2. Smoke: sign into the softphone, run a pre-call check, place one call, disposition it, confirm the
   Salesforce Task. Power-dial three records. Inbound callback rings the rep.
3. Observe one business day. No code change is expected to be visible.

## Deploy 2 — tenancy (remaining commits)

1. Merge/deploy. Migrate applies `0036_tenancy.sql` (`1 new of 36 total`).
   Railway runs the migration in **pre-deploy**, while the OLD build is still
   serving traffic. For that window — and again on any rollback — the old code
   has no `kind` filter at all: "AI Agent" is visible in the Team panel and is a
   candidate for the unassigned-reserve-DID inbound fallback. Run deploy 2
   outside calling hours to keep that window from coinciding with live traffic.
2. Verify (Railway → Postgres → Query, or `railway connect Postgres`):
   ```sql
   select id, name, slug, timezone, status from organizations;
   select org_id, email, kind, display_name from users where kind = 'service';
   select indexname from pg_indexes where tablename = 'users';   -- users_org_email_unique present, users_email_unique gone
   ```
3. Rename our tenant (the migration derives slugs from names). Replace the org id from step 2:
   ```sql
   begin;
   update organizations set name = 'GG Homes', slug = 'gg-homes' where id = '<gg-homes-org-id>';
   update users set email = 'ai-agent@gg-homes.internal' where org_id = '<gg-homes-org-id>' and kind = 'service';
   commit;
   ```
   Leave the seeded "Dev Org" (`…d0c1`) as `dev-org`. The migration guarantees
   exactly one `kind = 'service'` user per org, so the unconditional `... and
   kind = 'service'` update above is safe without further scoping. `slug` has
   no auto-update trigger — it is derived from `name` only at migration time —
   which is why the rename must set `slug` explicitly rather than relying on
   it to follow the new `name`.
4. Smoke: softphone sign-in still works (Salesforce login path now calls createTenant only for brand-new orgs);
   Team panel lists reps only (no "AI Agent").

## After deploy 2 — operator scripts

The fleet and roster scripts under `services/cti-api/scripts/` enumerate `users` without a `kind`
filter (`redistribute-pool.mjs`, `assign-reserve-fair.mjs`, `swap-call-center.mjs`, `fleet-report.ts`,
`buy-agent-numbers.ts`, `buy-pool-numbers.mjs`). After 0036 they will see the "AI Agent" service user
and could assign it DIDs or count it as a rep — two of them hand the next number to the rep with the
fewest, so a zero-number service user would absorb the whole reserve. The Callsign branch fixes all six
with the column-free predicate `email not like 'ai-agent@%'` (commit 95deaa7 on `callsign-reviewed`),
which is a no-op before 0036 and correct after. Before the next fleet run, verify that fix is on `main`;
once 0036 is live, tighten it to `kind = 'human'` (a follow-up in
`docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md`).

## Rollback notes

- Deploy 1: revert the merge; nothing in the database changed.
- Deploy 2: columns are additive and harmless to leave. The one non-additive change is the dropped
  global `users_email_unique` index. Recreating it (`create unique index users_email_unique on users(email)`)
  fails if the same email exists in two orgs — check with
  `select email, count(*) from users group by email having count(*) > 1` first. Because the prior
  code never reads `kind`, it does NOT exclude the service users — after a rollback, expect "AI Agent"
  to reappear in the Team panel and to be eligible for the inbound fallback, exactly as during the
  pre-deploy migration window above. Either delete the service users
  (`delete from users where kind = 'service'`) before relying on the rolled-back build, or keep the
  rollback window short.
