# Foundation plan 1 — follow-ups carried to plan 2

Non-blocking gaps and deferred work identified while landing the package
extraction + tenancy branch (`feat/outreach-foundation`) and its post-hoc fix
wave. None of these blocked the rollout; all are candidates for plan 2.

- **Migrate-runner test for two newly-applied files in one run.**
  `packages/db/src/migrate-runner.test.ts` — add a case that seeds two pending
  `*.sql` files and asserts both apply, in lexical order, within a single
  `runMigrations` call (today's tests cover zero-pending and one-pending).

- **Per-DID gate fixture for `evaluate.test.ts`.**
  `packages/firewall/src/evaluate.test.ts` — add a fixture with a real
  `outboundNumbers` pool row so `outboundNumberRow` resolves non-null and the
  per-DID reputation gates actually run: warmup, velocity, neighbor_spoof,
  attestation, answer_rate, engagement. Also add a test that fails if gate 7d's
  blanket `catch` (`packages/firewall/src/evaluate.ts`, the state-calling-rules
  block) silently swallows a real port/DB error instead of surfacing it.

- **`resetDncLoadedCacheForTests()`.**
  `packages/firewall/src/evaluate.ts` — export a reset for the module-level
  `dncLoadedCache` so tests that care about the loaded/not-loaded transition
  aren't at the mercy of the 60s TTL or test execution order.

- **Package tsconfigs should exclude test files from `dist/`.**
  Add `"exclude": ["src/**/*.test.ts"]` to the tsconfig of each of
  `packages/db`, `packages/auth`, `packages/firewall` (and `packages/phone` if
  applicable) so compiled `*.test.js` stops shipping into `dist/`. Note the
  coupling: `npm ci --omit=dev` in a production image still needs the runtime
  deps that test files might otherwise pull in only via `devDependencies` —
  verify the build still passes with `--omit=dev` after adding the exclude.

- **Table-qualify `pg_constraint` guards in future migrations.**
  The `conrelid` checks used for idempotent constraint guards (as in
  `packages/db/migrations/0036_tenancy.sql`) should be qualified by table name
  going forward — an unqualified `conname` match can silently no-op against a
  same-named constraint on a different table.

- **`createTenant` slug collision handling.**
  `packages/auth/src/tenancy.ts` — the current check-then-insert
  (`tx.query.organizations.findFirst` by slug, then insert with a random
  suffix if taken) has a TOCTOU race under concurrent signups. Switch to
  `onConflictDoUpdate`/`onConflictDoNothing` + retry on the slug unique
  constraint, and re-check that a retried, suffixed slug isn't itself taken.

- **Mirror the four SQL-only objects in the Drizzle schema, or document the gap.**
  `organizations_workos_org_id_unique`, `organizations_status_check`,
  `users_kind_check`, and `users_external_auth_id_unique` (all added in
  `0036_tenancy.sql`) have no Drizzle-schema representation in
  `packages/db/src/schema.ts`. Either add them so `drizzle-kit generate` stays
  a no-op against the live schema, or add a comment in `schema.ts` documenting
  that `drizzle-kit generate` would currently propose dropping them — so
  nobody runs it unreviewed.

- **`tenancy.test.ts`'s fake `db.insert` should throw, once, to prove the
  transaction actually rolls back.**
  `packages/auth/src/tenancy.test.ts` — add a case where the fake `db.insert`
  throws partway through `createTenant`'s transaction (e.g. on the
  `campaignConfigs` insert, after `organizations` and `users` have already
  been inserted in the fake) and assert nothing escapes as committed state.
  Today's fake transaction wrapper doesn't model rollback at all.

- **Real-Postgres integration lane, priority order:**
  (a) two seeded tenants, asserting `/admin/team`, `/admin/reps`, and the
  inbound fallback never return the other org's users OR either org's service
  user; (b) `issueSession`/`resolveSession` against real service-user and
  suspended-org rows (the fakes in `packages/auth/src/session.test.ts` cover
  the logic but never touch real Postgres `users`/`organizations` rows); (c)
  `0036_tenancy.sql` applied to a production snapshot, asserting the slug
  backfill produced valid, unique slugs and exactly one `kind='service'` user
  per pre-existing org.

- **Direct test of the login-status handler's service-user branch.**
  `services/cti-api/src/routes/auth.ts`'s `/auth/salesforce/status` handler —
  add a route-level test that hits the branch where the matched user is
  `kind='service'`, asserting it's treated as "no human user yet" rather than
  handed a session.

- **`pg_try_advisory_lock` with bounded retry in the migration runner.**
  `packages/db/src/migrate-runner.ts` currently calls the blocking
  `pg_advisory_lock`, so a wedged deploy holding the lock stalls every
  subsequent deploy indefinitely instead of failing loudly. Switch to
  `pg_try_advisory_lock` in a bounded retry loop with a clear timeout error.

- **`packages/db/src/schema.ts` is 874 lines.**
  Split it when the lead-store tables land (per the coding-style file-size
  guideline) — by domain (tenancy, telephony, firewall/compliance, dialer) is
  the natural cut.

- **`packages/db`'s `drizzle-kit` setup vs. hand-written migrations.**
  The package carries both a hand-written SQL migration runner
  (`migrate.ts`/`migrate-runner.ts`) and a `drizzle-kit` config
  (`drizzle.config.ts`) that isn't part of the actual deploy path. Decide
  whether `drizzle-kit generate`/`studio` stays a dev-only convenience or
  whether the migration story should consolidate onto one tool, and document
  whichever way it goes so the two don't drift further (see the schema-mirror
  follow-up above, which is a symptom of exactly this drift).

- `services/cti-api/src/routes/auth.ts` login-status handler: the suspended-tenant refusal (`issueSession` → `SuspendedTenantError`) currently fires after the single-use `sessionRetrievedAt` claim, so a suspended tenant's rep gets a generic 500 and the handshake is burned. Hoist an org-status check next to the existing `user.kind === 'service'` guard so it returns the handler's `{ status: 'failed' }` shape before the claim. (Final-review nit, 2026-09-04.)

- Operator scripts enumerate `users` without `kind = 'human'`: `services/cti-api/scripts/{redistribute-pool.mjs,assign-reserve-fair.mjs,swap-call-center.mjs,fleet-report.ts,buy-agent-numbers.ts,buy-pool-numbers.mjs}`. The Callsign session fixed them with `email not like 'ai-agent@%'` (95deaa7 on `callsign-reviewed`; a no-op before 0036). Once 0036 is live, tighten to `kind = 'human'`. That predicate depends on the service-user email staying `ai-agent@<slug>.internal` (see `aiAgentEmail` in `packages/auth/src/tenancy.ts`) — tell the Callsign owner before changing the format. Flagged by their production pre-flight, 2026-09-04.

## Plan 2 outcomes and new follow-ups

Recorded while landing the product skeleton (`feat/outreach-product-skeleton`,
plan `2026-09-04-outreach-foundation-2-product-skeleton.md`).

### Closed by plan 2

- **`packages/contracts` created.** `@cti/contracts` holds the zod DTOs
  (`SessionUser`, `Tenant`, team and invite shapes, `RoleSlug`, the error
  envelope, and the shared `isSafeReturnTo` rule) consumed by both
  `outreach-api` and `outreach-web`.
- **Human-user predicates moved to `@cti/auth`.**
  `packages/auth/src/user-queries.ts` (`humanUsersInOrg`, `humanUserByEmail`,
  `humanUserById`) replaces `services/cti-api/src/tenancy/user-queries.ts`;
  `outreach-api` uses the same predicates at its tenant boundary.

### New follow-ups

- **Retire root `railway.json` before 2026-12-01**
  (`docs/runbooks/outreach-api-deploy.md` §5). It is still the only place that
  configures `@cti/api`'s Docker build, pre-deploy migration, health check, and
  restart policy. The translation of those settings into the `_ctiapi` block of
  `.railway/railway.ts` (runbook §5.1) is the operator's step and must land —
  and be `railway config apply`'d — *before* the file is deleted.
- **Neither API service sets Railway watch paths**, so `@cti/api` and
  `outreach-api` rebuild on every push to `main`. Acceptable for now. (The plan
  text said watch paths were not expressible in the IaC DSL; they are —
  `build.watchPatterns`, as the pulled `@cti/web` and `@cti/desktop` blocks
  show — they just are not set on the two API blocks. Add them when the
  `@cti/api` block is translated.)
- **`outreach-web` keeps the bearer in memory only** (spec §4.3), so a page
  reload re-runs the AuthKit redirect. Revisit if it annoys admins — a
  `sessionStorage` copy behind `apiSession` in `apps/outreach-web/src/lib/api.ts`
  is the smallest change.
- **Two `vitest` majors.** `apps/cti-web` and `apps/outreach-web` pin
  `vitest ^4`; every Node workspace (`services/*`, `packages/*`) pins `^2`.
  Align when the next Vite upgrade happens.
- **The fake-DB harness cannot express `where` semantics.**
  `services/outreach-api/src/test/harness.ts` records predicates but returns
  fixture rows regardless of them. The real-Postgres lane (plan 3) should cover
  `requireContext` tenant isolation and `completeSignIn` against real rows.
- **No UI for tenant provisioning.** `POST /api/admin/tenants` and
  `POST /api/admin/tenants/:id/link-workos` are reachable only through the CLI
  scripts in `services/outreach-api/scripts/`; `GET /api/admin/tenants` only
  feeds the tenant switcher.
- **`@cti/web`'s Railway start command is `npm run dev`** (pre-existing,
  surfaced by the IaC pull into `.railway/railway.ts`). Give it a real static
  build/serve, or fold it into `@cti/api`'s static serving, which already hosts
  the softphone at `/cti/*`.
- **No audit trail for super-admin actions taken under `X-Org-Id`** (invites,
  admin-flag changes, provisioning). Add an `admin_audit` table with plan 3's
  schema work.
- **WorkOS 400/401/404 are treated alike as a bad sign-in code.**
  `WorkosIdentityProvider.exchangeCode` (`auth/workos-provider.ts`) maps all
  three to `IdentityExchangeError`, which the callback surfaces as
  `invalid_code`. A 401 means *our* API key is wrong and should alert
  (`ALERT_WEBHOOK_URL`), not read as a user sign-in failure. (The plan text
  attributed the mapping to `completeSignIn`; it lives in the provider.)
