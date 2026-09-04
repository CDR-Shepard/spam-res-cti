# Rollout: package extraction + tenancy (Foundation plan 1)

Two deploys, in this order, each followed by observation. Everything is on
`feat/outreach-foundation`; merge to `main` deploys via Railway (`endearing-comfort`).

## Deploy 1 — extraction only (commits through "docs(packages): …")

1. Merge/deploy. Railway runs `npm --workspace packages/db run migrate` (expect `0 new of 35 total`) then boots.
2. Smoke: sign into the softphone, run a pre-call check, place one call, disposition it, confirm the
   Salesforce Task. Power-dial three records. Inbound callback rings the rep.
3. Observe one business day. No code change is expected to be visible.

## Deploy 2 — tenancy (remaining commits)

1. Merge/deploy. Migrate applies `0036_tenancy.sql` (`1 new of 36 total`).
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
   Leave the seeded "Dev Org" (`…d0c1`) as `dev-org`.
4. Smoke: softphone sign-in still works (Salesforce login path now calls createTenant only for brand-new orgs);
   Team panel lists reps only (no "AI Agent").

## Rollback notes

- Deploy 1: revert the merge; nothing in the database changed.
- Deploy 2: columns are additive and harmless to leave. The one non-additive change is the dropped
  global `users_email_unique` index. Recreating it (`create unique index users_email_unique on users(email)`)
  fails if the same email exists in two orgs — check with
  `select email, count(*) from users group by email having count(*) > 1` first. The prior code never
  reads `kind`, so leaving the service users in place is safe for a rolled-back build.
