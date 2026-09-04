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

The first deploy will fail at boot with "Invalid environment configuration" until step 2 is done — that is expected.

## 2. Variables and domain

1. In the Railway dashboard open **outreach-api → Settings → Networking → Generate Domain**; copy `https://<name>.up.railway.app`.
2. **outreach-api → Variables** — set:
   - `API_PUBLIC_URL` = `https://<name>.up.railway.app`
   - `APP_PUBLIC_URL` = the same value (the API serves the web app on its own origin)
   - `TOKEN_ENCRYPTION_KEY` and `SESSION_SECRET` = **exactly** the values on the CTI API service (copy them from `@cti/api → Variables`; sessions are shared)
   - `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` from WorkOS; `WORKOS_REDIRECT_URI` = `https://<name>.up.railway.app/api/auth/workos/callback`
3. Back in WorkOS, add that redirect URI (step 0.5). Redeploy outreach-api. Expect the pre-deploy migrate to print `0 new of 36 total` and `/healthz` → 200, `/readyz` → `{ ok: true, dbOk: true, jobsOk: true }`.

## 3. Link GG Homes to WorkOS and invite yourself

The GG Homes tenant already exists (created by Salesforce login). Link it and send the first admin invite:

```bash
railway run -s outreach-api -- npx tsx services/outreach-api/scripts/link-tenant-workos.ts --org-slug gg-homes --admin-email <your email>
```

Accept the invite from the email WorkOS sends, then open `https://<name>.up.railway.app` and sign in. Your user is matched by email to your existing GG Homes user and marked admin.

Optional, for platform staff who need the tenant switcher:

```bash
railway run -s outreach-api -- npx tsx services/outreach-api/scripts/grant-super-admin.ts --org-slug gg-homes --email <your email>
```

## 4. New tenants

```bash
railway run -s outreach-api -- npx tsx services/outreach-api/scripts/provision-tenant.ts --name "Acme Buyers" --admin-email owner@acme.com --timezone America/Chicago
```
(or `POST /api/admin/tenants` as a super admin from the app once that UI exists.)

## 5. Follow-up before 2026-12-01: retire cti-api's railway.json

Railway removes Config-as-Code support on 2026-12-01. `.railway/railway.ts` now describes the CTI API too. After the outreach-api deploy is stable: in **@cti/api → Settings**, clear the config file path field, run `railway config plan` (expect no changes), then delete `railway.json` in a small PR.

## Rollback

`outreach-api` is additive: nothing in cti-api depends on it. To roll back, remove the service in the dashboard (or delete it from `.railway/railway.ts` and `railway config apply`); the shared database is untouched except for the `pgboss` schema, which is inert.
