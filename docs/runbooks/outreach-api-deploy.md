# Deploy outreach-api (product skeleton) — first time

Everything here is a human step; the code is already on `main` once plan 2 merges.

> **Current state (2026-10-05).** The `outreach-api` service already exists in project `endearing-comfort`. It was created with the Railway CLI, not with `railway config apply`; never run `apply`. People sign in to outreach-web with **Salesforce** (`outreach-sf-campaigns.md` "Signing in to Outreach"), so WorkOS (§0 and §3) is optional and only needed for the email sign-in button. §1 below describes how the service is deployed; the rest of this page is kept for reference and for new environments.

## 0. WorkOS (optional)

1. Create a WorkOS account/environment at dashboard.workos.com. Use the **Production** environment for the real deploy (staging can wait).
2. **User Management → AuthKit**: enable AuthKit (hosted sign-in). Enable **Email + Password** and **Magic Auth**; add **Google OAuth** if the team uses Google Workspace.
3. **Organizations**: enabled by default in User Management; make sure it is on.
4. **Roles**: create two roles with slugs exactly `admin` and `member`; set `member` as the **default** role.
5. **Redirects**: add `https://<outreach-api domain>/api/auth/workos/callback` to the redirect allow-list (you get the domain in step 2 below; come back for this).
6. **API Keys**: create a key (`sk_…`) and note the **Client ID** (`client_…`).

## 1. Railway — how the service is deployed

Railway applies the repo's root `railway.json` (and so the root `Dockerfile`) to every service built from this repo, and refuses per-service config files. So:

- `outreach-api` builds the **root `Dockerfile`**, which also builds `apps/outreach-web` and `services/outreach-api` (there is no `services/outreach-api/railway.json`).
- Its `RAILWAY_DOCKERFILE_PATH` variable (`services/outreach-api/Dockerfile`) is overridden by the root `railway.json` today and only takes effect once that file is retired (§5, before 2026-12-01), so `services/outreach-api/Dockerfile` must still build before then.
- Its **start command is overridden in the dashboard** (service Settings → Deploy): `node services/outreach-api/dist/server.js`, with `PORT` = `4100`.
- Its **pre-deploy step** is the root `railway.json`'s `npm --workspace packages/db run migrate`, which needs `DATABASE_URL` (set).
- Create or change the service with the dashboard or the CLI (`railway add`, `railway variables --set ... --service outreach-api`). **Never run `railway config apply`**: the `outreachApi` block in `.railway/railway.ts` records the service and its variable names, it does not create it.

The first deploy fails at boot with "Invalid environment configuration" until the variables in §2 are set.

## 2. Variables and domain

1. In the Railway dashboard open **outreach-api → Settings → Networking → Generate Domain**; copy `https://<name>.up.railway.app`.
2. **outreach-api → Variables** — set:
   - `API_PUBLIC_URL` = `https://<name>.up.railway.app`
   - `APP_PUBLIC_URL` = the same value (the API serves the web app on its own origin)
   - `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET` = **exactly** the values on the CTI API service (copy them from `@cti/api → Variables`; sessions are shared)
   - Sign-in with Salesforce and the other variables (`SALESFORCE_*`, `ANTHROPIC_API_KEY`, `CTI_INTERNAL_URL`, `OUTREACH_INTERNAL_SECRET`): see `outreach-sf-campaigns.md` (Signing in to Outreach; AI call campaigns)
   - Optional, only for the email sign-in button: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` from WorkOS; `WORKOS_REDIRECT_URI` = `https://<name>.up.railway.app/api/auth/workos/callback`
3. If you use WorkOS, add that redirect URI there (step 0.5). Redeploy outreach-api — dashboard: **outreach-api → Deployments tab → ⋯ on the latest deployment → Redeploy** (this always rebuilds, so the new variables take effect). Expect the pre-deploy migrate to print `3 new of 53 total` from whichever service's pre-deploy runs first (`@cti/api` or outreach-api), and `0 new of 53 total` from the other; then `/healthz` → 200, `/readyz` → `{ ok: true, dbOk: true, jobsOk: true }`.
   - Migration `0052` adds foreign keys that briefly lock `ai_calls`, `users` and `organizations` (at most 5 seconds, its `lock_timeout`). Deploy outside reps' peak hours. If the lock is not granted in time the migration fails and the deploy fails safely, with nothing applied: redeploy.
   - Watch `@cti/api`'s `/healthz` too after this deploy: it now listens on `::`, so a 200 there confirms it came back up.

## 3. Link GG Homes to WorkOS and invite yourself (optional)

**Local prerequisites** (all of §3 and §4 run these scripts through the CLI, which executes locally, not inside the Railway container): repo checked out on `main`, `npm ci`, `npm run build:packages`.

**Public DB URL.** `railway run -s outreach-api -- ...` injects outreach-api's own variables, including `DATABASE_URL` — but that resolves to Postgres's private `*.railway.internal` host, which only resolves inside a Railway-managed container, not from a laptop. Fetch the public connection string and override `DATABASE_URL` with it for the duration of the command instead (this is the same pattern used in `docs/runbooks/numberverifier-enrollment.md` and `docs/runbooks/cti-swap.md`). `$PUB` holds a live DB credential — never print it or paste it anywhere:

```bash
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
```

The GG Homes tenant already exists (created by Salesforce login). Link it and send the first admin invite:

```bash
railway run -s outreach-api -- env DATABASE_URL="$PUB" npx tsx services/outreach-api/scripts/link-tenant-workos.ts --org-slug gg-homes --admin-email <your email>
```

Accept the invite from the email WorkOS sends, then open `https://<name>.up.railway.app` and sign in. Your user is matched by email to your existing GG Homes user and marked admin.

Optional, for platform staff who need the tenant switcher:

```bash
railway run -s outreach-api -- env DATABASE_URL="$PUB" npx tsx services/outreach-api/scripts/grant-super-admin.ts --org-slug gg-homes --email <your email>
```

## 4. New tenants

Same local prerequisites and `$PUB` as §3:

```bash
railway run -s outreach-api -- env DATABASE_URL="$PUB" npx tsx services/outreach-api/scripts/provision-tenant.ts --name "Acme Buyers" --admin-email owner@acme.com --timezone America/Chicago
```
(or `POST /api/admin/tenants` as a super admin from the app once that UI exists.)

## 5. Follow-up before 2026-12-01: retire cti-api's railway.json

> **outreach-api depends on the same file.** Its pre-deploy step and its Docker build come from the root `railway.json` and `Dockerfile` too, so translate those settings for **both** services before deleting `railway.json`, and keep the start-command overrides in the dashboard. `railway config apply` reconciles every service in `.railway/railway.ts`, outreach-api included, so read `railway config plan` and stop if it proposes any change to `outreach-api`.

Railway removes Config-as-Code support on 2026-12-01. Root `railway.json` is still the **only** place that configures `@cti/api`'s Docker build, migration, health check, and restart policy — `.railway/railway.ts`'s `_ctiapi` block does not have them yet. `railway config pull` shows this directly: the pulled block is just `build: "npm run build --workspace=@cti/api"` (a Railpack build command) with no `preDeploy`, no `healthcheck`, and no restart policy at all. **Deleting `railway.json` before translating those settings into `.railway/railway.ts` would make `@cti/api` fall back to that pulled Railpack config** — it would build without the Dockerfile (losing the `packages/*` bundling and softphone/audio bundle the Docker image provides), skip the pre-deploy migration, and lose its health check and restart policy. Do these in order — translate and apply *before* deleting the file, not after:

### 5.1. Translate railway.json into `.railway/railway.ts`

Extend the `_ctiapi` block with the same settings `railway.json` supplies today:

```ts
const _ctiapi = service("@cti/api", {
  source: spamResCti,
  build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
  preDeploy: "npm --workspace packages/db run migrate",
  start: "node services/cti-api/dist/server.js",
  healthcheck: "/healthz",
  healthcheckTimeout: 120,
  deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
  replicas: { "us-west2": 1 },
  networking: { privateNetworkEndpoint: "ctiapi" },
  env: { /* unchanged — leave every preserve() exactly as pulled */ },
});
```

Field names, quoted from the installed SDK's own types (`node_modules/railway/dist/index-C3uk0ruc.d.ts`):
- `BuildConfig.builder?: "NIXPACKS" | "DOCKERFILE" | "RAILPACK" | "HEROKU" | "PAKETO" | null` and `BuildConfig.dockerfilePath?: string | null` — the SDK's `build` field does accept this object form, not just a build-command string, so there is no need for a `RAILWAY_DOCKERFILE_PATH` env var here (unlike outreach-api, which uses the env var because Root Directory stays `/` for the whole monorepo and this is the more direct equivalent of what `railway.json` already declares).
- `DeployConfig.restartPolicyType?: "ON_FAILURE" | "ALWAYS" | "NEVER" | null` and `DeployConfig.restartPolicyMaxRetries?: number | null` — there is no top-level shorthand for restart policy on `IntentServiceConfig`, so it goes under `deploy: {...}`, alongside (not instead of) the `preDeploy`/`start`/`healthcheck`/`healthcheckTimeout` shorthands.

**Prefer the manual edit above.** `railway config migrate` also lists `--force  Overwrite an existing '.railway/railway.ts'`. Our file already exists and already contains the hand-authored `outreach-api` block, which no `railway.json` describes — so `migrate` refuses without `--force`, and with `--force` it *regenerates the whole file from railway.json alone and discards that block*. If you use it anyway: commit the working tree first, run `railway config migrate --apply --force`, then `git diff` the regenerated `.railway/railway.ts` and manually restore the `outreachApi` block (and its `resources` entry) before moving on to §5.2 — do not skip this check. Per `railway config migrate --help`, `--apply` "writes files and clears Railway Config File settings", i.e. it also clears `@cti/api`'s Config-as-Code file-path setting as part of the same operation. Treat `--delete-files` (which additionally deletes `railway.json`) as something to avoid entirely here: it collapses steps 5.1–5.4 into one command with no chance to verify the plan in between, which is exactly the check §5.2 exists for.

### 5.2. Plan, and confirm the translation actually changed something

```bash
railway config plan
```

**Expect changes to `@cti/api`** — its build, start, and healthcheck moving from railway.json-only into the graph. Also confirm the plan shows `preDeploy` and the restart policy, not just build/start/healthcheck (`railway config plan --json` shows the compiled `deploy` node — check it includes `preDeployCommand` and `restartPolicyType`/`restartPolicyMaxRetries`). **If this reports `0 to change`, or the `--json` deploy node is missing any of those fields, stop** — that means the translation didn't take, or took only partially (or `@cti/api`'s live settings have diverged from `railway.json` some other way) — do not proceed to delete `railway.json` in that state; re-check the `_ctiapi` block against §5.1 instead.

### 5.3. Apply

```bash
railway config apply
```

### 5.4. Only now, delete railway.json

Confirm in the dashboard that **@cti/api → Settings** no longer shows a config file path set (`railway config migrate --apply` clears it automatically; otherwise clear it by hand). Then delete `railway.json` from the repo in a small PR.

### 5.5. Plan once more

```bash
railway config plan   # expect 0 to change, 0 to destroy — .railway/railway.ts is now the only source of truth for @cti/api
```

## Rollback

`outreach-api` is additive: nothing in cti-api depends on it for the softphone (AI calls started from outreach-web are the only link, over the private network). To take it down:

1. In the Railway dashboard, **outreach-api → Settings → Danger → Delete service**. Do not use `railway config apply` for this.
2. In `.railway/railway.ts`, delete the `outreachApi` block and its entry in the `project(...).resources` array so the file matches.
3. Confirm in the Railway dashboard that the `outreach-api` service is gone.

The shared database is untouched except for the `pgboss` schema, which is inert.
