# Deploy outreach-api (product skeleton) — first time

Everything here is a human step; the code is already on `main` once plan 2 merges.

## 0. WorkOS (one time, ~15 minutes)

1. Create a WorkOS account/environment at dashboard.workos.com. Use the **Production** environment for the real deploy (staging can wait).
2. **User Management → AuthKit**: enable AuthKit (hosted sign-in). Enable **Email + Password** and **Magic Auth**; add **Google OAuth** if the team uses Google Workspace.
3. **Organizations**: enabled by default in User Management; make sure it is on.
4. **Roles**: create two roles with slugs exactly `admin` and `member`; set `member` as the **default** role.
5. **Redirects**: add `https://<outreach-api domain>/api/auth/workos/callback` to the redirect allow-list (you get the domain in step 2 below; come back for this).
6. **API Keys**: create a key (`sk_…`) and note the **Client ID** (`client_…`).

## 1. Railway — create the service with Infrastructure as Code

From the repo root on `main`, with the CLI linked to project `endearing-comfort`:

```bash
railway config plan      # expect: 1 to add (outreach-api), 0 to change, 0 to destroy
railway config apply     # confirms interactively; creates the service with its build/deploy settings
```

If `apply` refuses because a service is still Config-as-Code-managed, that service is `@cti/api` — translation alone (§5.1) does not lift the refusal, so follow §5 (5.1 through 5.4) now, out of order, then come back and retry `apply` here.

The first deploy will fail at boot with "Invalid environment configuration" until step 2 is done — that is expected.

## 2. Variables and domain

1. In the Railway dashboard open **outreach-api → Settings → Networking → Generate Domain**; copy `https://<name>.up.railway.app`.
2. **outreach-api → Variables** — set:
   - `API_PUBLIC_URL` = `https://<name>.up.railway.app`
   - `APP_PUBLIC_URL` = the same value (the API serves the web app on its own origin)
   - `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET` = **exactly** the values on the CTI API service (copy them from `@cti/api → Variables`; sessions are shared)
   - `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` from WorkOS; `WORKOS_REDIRECT_URI` = `https://<name>.up.railway.app/api/auth/workos/callback`
3. Back in WorkOS, add that redirect URI (step 0.5). Redeploy outreach-api — dashboard: **outreach-api → Deployments tab → ⋯ on the latest deployment → Redeploy** (this always rebuilds, so the new variables take effect). Expect the pre-deploy migrate to print `0 new of 36 total` and `/healthz` → 200, `/readyz` → `{ ok: true, dbOk: true, jobsOk: true }`.

## 3. Link GG Homes to WorkOS and invite yourself

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

`outreach-api` is additive: nothing in cti-api depends on it. Roll back the file first, then confirm live:

1. In `.railway/railway.ts`, delete the `outreachApi` block and its entry in the `project(...).resources` array.
2. `railway config apply` — removing a service is a destructive change, so it prompts for confirmation interactively; in a non-interactive session use `railway config apply --yes --confirm-destructive`.
3. Confirm in the Railway dashboard that the `outreach-api` service is gone.

The shared database is untouched except for the `pgboss` schema, which is inert.
