# Outreach Foundation — Plan 2: Product Skeleton (outreach-api, outreach-web, WorkOS sign-in, team, tenant provisioning) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the product's two new deployables — `services/outreach-api` (Fastify, pg-boss, WorkOS sign-in issuing the existing session token, tenant provisioning, team management) and `apps/outreach-web` (React SPA served by the API) — as rollout step 3 of the Foundation spec, deployable to Railway as a second service on the same Postgres, with no change to the reps' softphone.

**Architecture:** `outreach-api` is a sibling of `cti-api` with the same conventions (zod-validated env, pino, rate limit, CORS, fake-DB tests via `vi.mock('@cti/db')`), consuming `@cti/db` and `@cti/auth`. All product routes live under `/api/*`; `/healthz` and `/readyz` are unprefixed; every other path serves the SPA. Sign-in is WorkOS AuthKit behind an `IdentityProvider` port (real WorkOS implementation + in-memory fake); the callback issues the same opaque bearer session the CTI uses and hands it to the SPA through a 60-second cookie. Tenant identity comes from the WorkOS organization membership → `organizations.workos_org_id`. Jobs run on pg-boss in-process (queue registry only; the import pipeline in plan 3 adds queues). Deployment uses Railway Infrastructure-as-Code (`.railway/railway.ts`) because Railway has deprecated `railway.json` for new services.

**Tech Stack:** TypeScript 5.6 strict, Node ≥ 22.12 (pg-boss 12 requirement; Docker image `node:22-slim`, dev machine 22.22), npm workspaces, Fastify 4 (+ cors 9, rate-limit 9, static 7, cookie 9), zod 3, Drizzle 0.36.4 (pinned), pg-boss 12, `@workos-inc/node` 10, vitest 2 (API) / vitest 4 + jsdom (web, mirroring `apps/cti-web`), React 18, Vite 5, TanStack Router 1.170 (file-based, `@tanstack/router-plugin`) + Query 5, Tailwind 4 (`@tailwindcss/vite`), shadcn/ui, Railway CLI 4.59 + `railway` SDK 3.11.

**Spec:** `docs/superpowers/specs/2026-09-03-outreach-foundation-design.md` §3.2–§3.5, §4, §10 (sign-in, team, tenant switcher), §11, §12, §13 step 3. Program context: `docs/superpowers/specs/2026-09-03-ai-outreach-program-design.md`. Follow-ups from plan 1: `docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md`.

**Baseline (verified 2026-09-04 on origin/main = e8e9286):** root `npm test` green — phone 6, db 6, auth 25, firewall 161, cti-api 618, cti-web 124; root `npm run typecheck` clean; production deployed at this commit (migrations through 0036).

## Global Constraints

- Repo `/Users/cdrshepard/spam-res-cti`. Branch `feat/outreach-product-skeleton` (created off `e8e9286`). Commit after every task. Do NOT push. A peer Claude session (Callsign iOS) shares this repo from `.claude/worktrees/*`: never run `git checkout`/`switch`/`reset`/`stash` in the shared checkout, never touch `.superpowers/sdd/progress.md`, never stage `.claude/launch.json` (pre-existing unstaged deletion).
- Every task ends with: `npm run build:packages` OK, `npm run typecheck` (root) clean, and every affected workspace's tests green with the counts stated. `cti-api` behavior must not change except where a task says so (Task 2 moves a module it imports).
- TypeScript strict, `noUncheckedIndexedAccess: true`, `moduleResolution: "Bundler"`, ESM (`"type": "module"`), **`.js` extensions on relative import specifiers** in Node packages/services (the web app uses extensionless imports like `apps/cti-web`).
- Dependency versions (copy exactly): `fastify ^4.28.1`, `@fastify/cors ^9.0.1`, `@fastify/rate-limit ^9.1.0`, `@fastify/static ^7.0.4`, `@fastify/cookie ^9.4.0`, `zod ^3.23.8`, `drizzle-orm 0.36.4` (exact, no caret), `pg ^8.13.1`, `pg-boss ^12.30.0`, `@workos-inc/node ^10.13.0`, `dotenv ^16.4.5`, `vitest ^2.1.5` (Node services/packages), `typescript ^5.6.3`, `tsx ^4.19.2`, `@types/node ^20.17.0`, `@types/pg ^8.11.10`. Web (mirror `apps/cti-web/package.json`): `react ^18.3.1`, `react-dom ^18.3.1`, `vite ^5.4.11`, `@vitejs/plugin-react ^4.3.4`, `@types/react ^18.3.12`, `@types/react-dom ^18.3.1`, `vitest ^4.1.8`, `jsdom ^30.0.1`, `@testing-library/react ^16.3.2`; plus `@tanstack/react-router ^1.170.32`, `@tanstack/router-plugin ^1.168.35`, `@tanstack/react-query ^5.102.8`, `tailwindcss ^4.3.3`, `@tailwindcss/vite ^4.3.3`, `@testing-library/jest-dom ^6.6.3`, `@testing-library/user-event ^14.5.2`. Root devDependency: `railway ^3.11.0`.
- Workspace dependency declarations use `"*"`. Packages are consumed from `dist`; run `npm run build:packages` before typechecking or testing a consumer.
- Ports: `outreach-api` listens on `4100` (`PORT`/`API_PORT`), Vite dev server for `outreach-web` on `5175` proxying `/api` and `/healthz` to `http://localhost:4100`.
- Route namespace: all product routes under `/api/...`; `/healthz` and `/readyz` at root; the SPA fallback serves `apps/outreach-web/dist/index.html` for any GET not starting with `/api/` or `/healthz`/`/readyz`.
- Sessions: reuse `@cti/auth` `issueSession`/`resolveSession` unchanged. Handoff cookie name `outreach_session_handoff`, `httpOnly`, `sameSite: 'lax'`, `secure` when `NODE_ENV=production`, `path: '/api/auth/session'`, `maxAge: 60`.
- OAuth `state` is stateless and signed: `base64url(JSON{nonce,iat,returnTo?})` + `.` + `base64url(HMAC-SHA256(SESSION_SECRET))`, valid for 600 seconds.
- Tenant resolution: a request's effective `orgId` is the session's `orgId`, unless the session user `isSuperAdmin` and sends `X-Org-Id: <uuid>` naming an existing `active` organization. Everything else is a 403.
- WorkOS: role slugs `admin` and `member`; a membership with role `admin` grants `is_admin` (never demotes an existing admin). Users with no membership matching a known tenant get a 403 page, never an auto-created tenant.
- Fail closed: any auth/tenant check that errors denies. No secrets in logs (redact `authorization`, `cookie`, `set-cookie`, WorkOS codes). Files ≤ 800 lines, new functions < 50 lines.
- Commit format `<type>(<scope>): <description>`, no `Co-Authored-By` trailer.
- A whole-module `vi.mock` of a `@cti/*` package must spread `importOriginal` and override only what it needs.

---

## File Structure (end state of this plan)

```
packages/
  contracts/            package.json, tsconfig.json, src/index.ts, src/session.ts, src/team.ts, src/tenant.ts,
                        src/error.ts, src/*.test.ts            (zod schemas + inferred types shared by api and web)
  auth/src/
    user-queries.ts (+test)                                    (moved from services/cti-api/src/tenancy/)
    index.ts                                                   (adds export)
services/outreach-api/
  package.json, tsconfig.json, Dockerfile, .env.example
  src/config.ts, src/server.ts, src/app.ts (buildApp for tests), src/alerts.ts
  src/routes/health.ts, src/routes/spa.ts, src/routes/auth.ts, src/routes/team.ts, src/routes/admin-tenants.ts
  src/auth/state.ts, src/auth/identity-provider.ts, src/auth/workos-provider.ts, src/auth/fake-provider.ts, src/auth/sign-in.ts
  src/tenancy/scope.ts, src/tenancy/provision.ts
  src/jobs/boss.ts, src/jobs/queues.ts
  src/test/harness.ts                                          (fake db + fake IdP builders for route tests)
  scripts/provision-tenant.ts, scripts/link-tenant-workos.ts, scripts/grant-super-admin.ts
apps/outreach-web/
  package.json, tsconfig.json, vite.config.ts, vitest.config.ts, components.json, index.html
  src/main.tsx, src/index.css, src/routeTree.gen.ts (generated), src/routes/__root.tsx, src/routes/sign-in.tsx,
  src/routes/auth.callback.tsx, src/routes/_authenticated.tsx, src/routes/_authenticated/index.tsx,
  src/routes/_authenticated/team.tsx, src/lib/api.ts, src/lib/auth.ts, src/lib/utils.ts, src/components/ui/*,
  src/components/app-shell.tsx, src/components/tenant-switcher.tsx, src/test/setup.ts, src/test/render.tsx
.railway/railway.ts                                            (Infrastructure as Code: existing services + outreach-api)
docs/runbooks/outreach-api-deploy.md
services/cti-api/src/tenancy/                                  (removed; imports switch to @cti/auth)
```

---

### Task 1: `packages/contracts` — shared zod schemas for the product API

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`, `packages/contracts/src/error.ts`, `packages/contracts/src/session.ts`, `packages/contracts/src/team.ts`, `packages/contracts/src/tenant.ts`, `packages/contracts/src/contracts.test.ts`
- Modify: root `package.json` (`build:packages` order), `Dockerfile` (COPY line so the cti-api image install layer stays cacheable)

**Interfaces:**
- Produces `@cti/contracts` exporting zod schemas and inferred types: `ApiError`, `SessionUser`, `SessionResponse`, `TeamMember`, `TeamResponse`, `InviteRequest`, `Invite`, `InvitesResponse`, `UpdateTeamMemberRequest`, `Tenant`, `TenantsResponse`, `ProvisionTenantRequest`, `LinkTenantWorkosRequest`, plus `ROLE_SLUGS = ['admin','member'] as const`.

- [ ] **Step 1: Package manifest and tsconfig**

`packages/contracts/package.json`:
```json
{
  "name": "@cti/contracts",
  "version": "0.1.0",
  "private": true,
  "description": "Request/response schemas shared by outreach-api and outreach-web",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```
`packages/contracts/tsconfig.json`: copy `packages/phone/tsconfig.json` verbatim.

- [ ] **Step 2: Write the failing tests**

`packages/contracts/src/contracts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  InviteRequest,
  ProvisionTenantRequest,
  ROLE_SLUGS,
  SessionResponse,
  TeamResponse,
  UpdateTeamMemberRequest,
} from './index.js';

describe('contracts', () => {
  it('exposes the two WorkOS role slugs', () => {
    expect(ROLE_SLUGS).toEqual(['admin', 'member']);
  });

  it('parses a session response and rejects a service user', () => {
    const ok = SessionResponse.safeParse({
      token: 't',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', isAdmin: false, isSuperAdmin: false, kind: 'human', displayName: null },
      tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
    });
    expect(ok.success).toBe(true);
    const bad = SessionResponse.safeParse({ token: 't', expiresAt: 'x', user: { kind: 'service' }, tenant: {} });
    expect(bad.success).toBe(false);
  });

  it('validates invite requests: lowercases email, defaults role to member', () => {
    expect(InviteRequest.parse({ email: 'Rep@Example.com' })).toEqual({ email: 'rep@example.com', role: 'member' });
    expect(InviteRequest.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(InviteRequest.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false);
  });

  it('validates team member updates and provisioning requests', () => {
    expect(UpdateTeamMemberRequest.parse({ isAdmin: true })).toEqual({ isAdmin: true });
    expect(UpdateTeamMemberRequest.safeParse({}).success).toBe(false);
    const p = ProvisionTenantRequest.parse({ name: 'Acme Buyers', adminEmail: 'OWNER@acme.com' });
    expect(p).toEqual({ name: 'Acme Buyers', adminEmail: 'owner@acme.com', timezone: 'America/Los_Angeles' });
    expect(ProvisionTenantRequest.safeParse({ name: '', adminEmail: 'x@y.z' }).success).toBe(false);
    expect(ProvisionTenantRequest.safeParse({ name: 'A', slug: 'Bad Slug', adminEmail: 'x@y.z' }).success).toBe(false);
  });

  it('parses the error envelope and a team response', () => {
    expect(ApiError.parse({ error: 'Forbidden', code: 'FORBIDDEN', requestId: 'req-1' }).code).toBe('FORBIDDEN');
    const team = TeamResponse.parse({
      members: [{ id: 'U1', email: 'a@b.co', displayName: 'A', isAdmin: true, powerDialerEnabled: false, signedIn: true }],
    });
    expect(team.members).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && mkdir -p packages/contracts/src && npm install 2>&1 | tail -1 && npm -w packages/contracts run test 2>&1 | tail -5
```
Expected: FAIL — cannot resolve `./index.js` (no source yet). (Run `npm install` after creating `package.json` so the workspace is linked.)

- [ ] **Step 4: Implement the schemas**

`packages/contracts/src/error.ts`:
```ts
import { z } from 'zod';

/** Every non-2xx body from outreach-api. `code` is stable for clients; `error` is for humans. */
export const ApiError = z.object({
  error: z.string(),
  code: z.string(),
  requestId: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
```

`packages/contracts/src/tenant.ts`:
```ts
import { z } from 'zod';

export const TenantStatus = z.enum(['active', 'suspended']);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const Tenant = z.object({
  /** Opaque id as the API renders it (a uuid in production; short ids in fixtures). */
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  status: TenantStatus,
  workosLinked: z.boolean().optional(),
});
export type Tenant = z.infer<typeof Tenant>;

export const TenantsResponse = z.object({ tenants: z.array(Tenant) });
export type TenantsResponse = z.infer<typeof TenantsResponse>;

/** lowercase letters, digits, single dashes; no leading/trailing dash. */
export const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase letters, digits, and dashes');

export const ProvisionTenantRequest = z.object({
  name: z.string().trim().min(1).max(120),
  slug: SlugSchema.optional(),
  timezone: z.string().min(1).default('America/Los_Angeles'),
  adminEmail: z.string().trim().toLowerCase().email(),
});
export type ProvisionTenantRequest = z.infer<typeof ProvisionTenantRequest>;

export const LinkTenantWorkosRequest = z.object({
  adminEmail: z.string().trim().toLowerCase().email(),
});
export type LinkTenantWorkosRequest = z.infer<typeof LinkTenantWorkosRequest>;
```

`packages/contracts/src/session.ts`:
```ts
import { z } from 'zod';
import { Tenant } from './tenant.js';

/** The session bearer's identity as the product sees it. Service users never appear here. */
export const SessionUser = z.object({
  userId: z.string(),
  orgId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  isAdmin: z.boolean(),
  isSuperAdmin: z.boolean(),
  kind: z.literal('human'),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const SessionResponse = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
  user: SessionUser,
  tenant: Tenant,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const MeResponse = z.object({ user: SessionUser, tenant: Tenant });
export type MeResponse = z.infer<typeof MeResponse>;
```

`packages/contracts/src/team.ts`:
```ts
import { z } from 'zod';

export const ROLE_SLUGS = ['admin', 'member'] as const;
export const RoleSlug = z.enum(ROLE_SLUGS);
export type RoleSlug = z.infer<typeof RoleSlug>;

export const TeamMember = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  isAdmin: z.boolean(),
  powerDialerEnabled: z.boolean(),
  /** True once the user has signed in to the product (WorkOS id linked). */
  signedIn: z.boolean(),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamResponse = z.object({ members: z.array(TeamMember) });
export type TeamResponse = z.infer<typeof TeamResponse>;

export const InviteRequest = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: RoleSlug.default('member'),
});
export type InviteRequest = z.infer<typeof InviteRequest>;

export const Invite = z.object({
  id: z.string(),
  email: z.string(),
  role: RoleSlug.nullable(),
  state: z.enum(['pending', 'accepted', 'expired', 'revoked']),
  expiresAt: z.string(),
});
export type Invite = z.infer<typeof Invite>;

export const InvitesResponse = z.object({ invites: z.array(Invite) });
export type InvitesResponse = z.infer<typeof InvitesResponse>;

export const UpdateTeamMemberRequest = z.object({ isAdmin: z.boolean() });
export type UpdateTeamMemberRequest = z.infer<typeof UpdateTeamMemberRequest>;
```

`packages/contracts/src/index.ts`:
```ts
export * from './error.js';
export * from './session.js';
export * from './team.js';
export * from './tenant.js';
```

- [ ] **Step 5: Wire the workspace**

Root `package.json`: `"build:packages": "npm -w packages/phone run build && npm -w packages/db run build && npm -w packages/auth run build && npm -w packages/firewall run build && npm -w packages/contracts run build"`.
`Dockerfile` (root, cti-api image): add `COPY packages/contracts/package.json packages/contracts/package.json` after the firewall line (npm ci needs every workspace manifest present).

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm install 2>&1 | tail -1 && npm run build:packages >/dev/null && npm -w packages/contracts run test 2>&1 | tail -4 && npm run typecheck >/dev/null && echo TYPECHECK_OK
git add package.json package-lock.json Dockerfile packages/contracts
git commit -m "feat(contracts): @cti/contracts — zod schemas shared by outreach-api and outreach-web"
```
Expected: contracts 1 file / 5 tests; root typecheck clean.

---

### Task 2: Move the human-user predicates into `@cti/auth`

**Files:**
- Move: `services/cti-api/src/tenancy/user-queries.ts` → `packages/auth/src/user-queries.ts`; `services/cti-api/src/tenancy/user-queries.test.ts` → `packages/auth/src/user-queries.test.ts`
- Modify: `packages/auth/src/index.ts`, `packages/auth/package.json` (devDependency for the test's `PgDialect` import is `drizzle-orm`, already a dependency), `services/cti-api/src/routes/auth.ts`, `services/cti-api/src/routes/admin.ts`, `services/cti-api/src/routes/inbound.ts`

**Interfaces:**
- Produces from `@cti/auth`: `humanUsersInOrg(orgId): SQL`, `humanUserByEmail(orgId, email): SQL`, `humanUserById(orgId, userId): SQL` — unchanged signatures.

- [ ] **Step 1: Move**

```bash
cd /Users/cdrshepard/spam-res-cti
git mv services/cti-api/src/tenancy/user-queries.ts packages/auth/src/user-queries.ts
git mv services/cti-api/src/tenancy/user-queries.test.ts packages/auth/src/user-queries.test.ts
rmdir services/cti-api/src/tenancy
echo "export * from './user-queries.js';" >> packages/auth/src/index.ts
perl -pi -e "s#'\.\./tenancy/user-queries\.js'#'\@cti/auth'#g" services/cti-api/src/routes/auth.ts services/cti-api/src/routes/admin.ts services/cti-api/src/routes/inbound.ts
grep -rn "tenancy/user-queries" services/cti-api/src || echo "OK: no relative imports remain"
```
In `services/cti-api/src/routes/auth.ts`, `admin.ts`, and `inbound.ts` there are now two `import … from '@cti/auth'` lines each; merge each pair into one import statement.

- [ ] **Step 2: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm run build:packages >/dev/null && npm -w packages/auth run test 2>&1 | tail -4 && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -4
git add packages/auth services/cti-api
git commit -m "refactor(auth): move human-user predicates into @cti/auth for both services"
```
Expected: auth 4 files / 28 tests; cti-api typecheck clean; cti-api 48 files / 615 tests (the 3 predicate tests moved out).

---

### Task 3: `services/outreach-api` skeleton — config, app builder, health, SPA fallback, Dockerfile

**Files:**
- Create: `services/outreach-api/package.json`, `services/outreach-api/tsconfig.json`, `services/outreach-api/.env.example`, `services/outreach-api/Dockerfile`, `services/outreach-api/src/config.ts`, `services/outreach-api/src/app.ts`, `services/outreach-api/src/server.ts`, `services/outreach-api/src/alerts.ts`, `services/outreach-api/src/routes/health.ts`, `services/outreach-api/src/routes/spa.ts`, `services/outreach-api/src/config.test.ts`, `services/outreach-api/src/routes/health.test.ts`, `services/outreach-api/src/routes/spa.test.ts`
- Modify: root `package.json` (scripts `dev:outreach`, `build:outreach`)

**Interfaces:**
- Produces `loadConfig(): AppConfig` (see schema below), `buildApp(deps: AppDeps): Promise<FastifyInstance>` where `AppDeps = { cfg: AppConfig; readiness: () => Promise<Readiness>; spaDist?: string }` and `Readiness = { dbOk: boolean; jobsOk: boolean }`; `dispatchAlert(logger, event)` (same shape as cti-api's `alerts.ts` with kinds `'provisioning_failed' | 'job_dead_lettered' | 'auth_failure_spike'`).
- Later tasks register route plugins inside `buildApp` under the `/api` prefix.

- [ ] **Step 1: Manifests**

`services/outreach-api/package.json`:
```json
{
  "name": "@cti/outreach-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@cti/auth": "*",
    "@cti/contracts": "*",
    "@cti/db": "*",
    "@fastify/cookie": "^9.4.0",
    "@fastify/cors": "^9.0.1",
    "@fastify/rate-limit": "^9.1.0",
    "@fastify/static": "^7.0.4",
    "@workos-inc/node": "^10.13.0",
    "dotenv": "^16.4.5",
    "drizzle-orm": "0.36.4",
    "fastify": "^4.28.1",
    "pg": "^8.13.1",
    "pg-boss": "^12.30.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```
`services/outreach-api/tsconfig.json`: copy `services/cti-api/tsconfig.json` verbatim.

`services/outreach-api/.env.example`:
```
NODE_ENV=development
API_PORT=4100
API_PUBLIC_URL=http://localhost:4100
# Where the SPA lives for redirects after sign-in (Vite dev server in dev; the API's own origin in prod).
APP_PUBLIC_URL=http://localhost:5175
# Same values as services/cti-api so sessions and encrypted tokens interoperate.
TOKEN_ENCRYPTION_KEY=replace_me_with_64_hex_chars
SESSION_SECRET=replace_me_with_long_random_string
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cti_dev
# WorkOS AuthKit (dashboard -> API Keys / Configuration). Leave unset to disable sign-in routes (503).
WORKOS_API_KEY=
WORKOS_CLIENT_ID=
WORKOS_REDIRECT_URI=http://localhost:4100/api/auth/workos/callback
# pg-boss schema in the shared Postgres.
PGBOSS_SCHEMA=pgboss
ALERT_WEBHOOK_URL=
CORS_ALLOWED_ORIGINS=
```

- [ ] **Step 2: Failing tests for config**

`services/outreach-api/src/config.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from './config.js';

const base = {
  TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
  SESSION_SECRET: 's'.repeat(32),
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
};

afterEach(() => vi.unstubAllEnvs());

describe('parseConfig', () => {
  it('applies defaults and honors PORT as the listen port', () => {
    const cfg = parseConfig({ ...base, PORT: '8080' });
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.APP_PUBLIC_URL).toBe('http://localhost:5175');
    expect(cfg.PGBOSS_SCHEMA).toBe('pgboss');
    expect(cfg.workosEnabled).toBe(false);
  });
  it('treats empty strings as unset', () => {
    const cfg = parseConfig({ ...base, ALERT_WEBHOOK_URL: '', WORKOS_API_KEY: '' });
    expect(cfg.ALERT_WEBHOOK_URL).toBeUndefined();
  });
  it('enables WorkOS only when all three variables are present', () => {
    const cfg = parseConfig({ ...base, WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_1', WORKOS_REDIRECT_URI: 'http://localhost:4100/api/auth/workos/callback' });
    expect(cfg.workosEnabled).toBe(true);
    expect(() => parseConfig({ ...base, WORKOS_API_KEY: 'sk_test' })).toThrow(/WORKOS_CLIENT_ID/);
  });
  it('rejects a bad encryption key with a clear message', () => {
    expect(() => parseConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm install 2>&1 | tail -1 && npm -w services/outreach-api run test 2>&1 | tail -4
```
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 4: Implement config, alerts, app, health, SPA, server**

`services/outreach-api/src/config.ts`:
```ts
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4100),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4100'),
  /** Origin the browser app lives on; sign-in redirects land at `${APP_PUBLIC_URL}/auth/callback`. */
  APP_PUBLIC_URL: z.string().url().default('http://localhost:5175'),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
  DATABASE_URL: z.string().url(),
  WORKOS_API_KEY: z.string().min(1).optional(),
  WORKOS_CLIENT_ID: z.string().min(1).optional(),
  WORKOS_REDIRECT_URI: z.string().url().optional(),
  PGBOSS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('pgboss'),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema> & { workosEnabled: boolean };

/** Pure: parses a raw env map. Empty strings count as unset (deploy UIs write them). */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const source: Record<string, string | undefined> = { ...env, API_PORT: env.API_PORT ?? env.PORT };
  for (const key of Object.keys(source)) if (source[key] === '') delete source[key];
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  const workosVars = [c.WORKOS_API_KEY, c.WORKOS_CLIENT_ID, c.WORKOS_REDIRECT_URI];
  const set = workosVars.filter(Boolean).length;
  if (set !== 0 && set !== 3) {
    const missing = ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_REDIRECT_URI'].filter((k) => !(c as Record<string, unknown>)[k]);
    throw new Error(`Invalid environment configuration:\n  - WorkOS: set all three or none; missing ${missing.join(', ')}`);
  }
  return { ...c, workosEnabled: set === 3 };
}

let cached: AppConfig | undefined;
export function loadConfig(): AppConfig {
  if (!cached) cached = parseConfig(process.env);
  return cached;
}
```

`services/outreach-api/src/alerts.ts` — copy `services/cti-api/src/alerts.ts` verbatim, then change the `kind` union to `'provisioning_failed' | 'job_dead_lettered' | 'auth_failure_spike'` and the import to `./config.js`.

`services/outreach-api/src/routes/health.ts`:
```ts
import type { FastifyInstance } from 'fastify';

export interface Readiness {
  dbOk: boolean;
  jobsOk: boolean;
}

export async function registerHealthRoutes(app: FastifyInstance, readiness: () => Promise<Readiness>): Promise<void> {
  // Liveness never touches the DB, so a transient DB blip cannot get the container killed.
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));
  // Readiness reports the DB and the job runner; 503 when either is down.
  app.get('/readyz', async (_req, reply) => {
    const r = await readiness();
    const ok = r.dbOk && r.jobsOk;
    return reply.code(ok ? 200 : 503).send({ ok, ...r });
  });
}
```

`services/outreach-api/src/routes/spa.ts`:
```ts
/**
 * Serves the built outreach-web bundle at / with a history-API fallback: any GET
 * that is not an API or health path returns index.html. index.html is never
 * cached; hashed assets are immutable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import staticPlugin from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0';

/** `/api` and `/api/...` by prefix; the two health paths exactly (so `/healthzone` is an app route). */
export function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (path === '/api' || path.startsWith('/api/')) return true;
  return path === '/healthz' || path === '/readyz';
}

export async function registerSpa(app: FastifyInstance, dist: string): Promise<void> {
  if (!existsSync(join(dist, 'index.html'))) {
    app.log.warn({ dist }, 'outreach-web bundle not built — / will 503 until `npm run build:outreach`');
    app.get('/*', async (req, reply) => {
      if (isApiPath(req.url)) return reply.callNotFound();
      return reply.code(503).send({ error: 'outreach-web not built', code: 'SPA_NOT_BUILT' });
    });
    return;
  }
  await app.register(staticPlugin, {
    root: dist,
    prefix: '/',
    wildcard: false,
    decorateReply: false,
    setHeaders(reply, path: string) {
      if (path.endsWith('.html')) reply.setHeader('Cache-Control', NO_STORE);
      else if (/\.(?:js|css|woff2?|ttf|otf|png|jpg|svg|ico)$/.test(path)) reply.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });
  const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' || isApiPath(req.url)) {
      return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND', requestId: req.id });
    }
    return reply.header('Cache-Control', NO_STORE).type('text/html').send(indexHtml);
  });
}
```

`services/outreach-api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config.js';
import { registerHealthRoutes, type Readiness } from './routes/health.js';
import { registerSpa } from './routes/spa.js';

export interface AppDeps {
  cfg: AppConfig;
  readiness: () => Promise<Readiness>;
  /** Absolute path of the built SPA; omit in tests. */
  spaDist?: string;
  /** Route plugins registered under /api (added by later tasks). */
  apiRoutes?: Array<(app: FastifyInstance) => Promise<void>>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { cfg } = deps;
  const app = Fastify({
    logger: {
      level: cfg.NODE_ENV === 'production' ? 'info' : cfg.NODE_ENV === 'test' ? 'silent' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: 1,
    bodyLimit: 1024 * 1024,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => cfg.NODE_ENV !== 'production' && (req.ip === '127.0.0.1' || req.ip === '::1'),
  });
  const allow = (cfg.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || cfg.NODE_ENV !== 'production') return cb(null, true);
      return cb(null, allow.includes(origin) || origin === cfg.APP_PUBLIC_URL || origin === cfg.API_PUBLIC_URL);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Org-Id'],
  });
  await app.register(cookie);
  await registerHealthRoutes(app, deps.readiness);
  for (const plugin of deps.apiRoutes ?? []) {
    await app.register(async (scope) => plugin(scope), { prefix: '/api' });
  }
  if (deps.spaDist) await registerSpa(app, deps.spaDist);
  return app;
}
```

`services/outreach-api/src/server.ts`:
```ts
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getPool } from '@cti/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Where vite drops the built outreach-web bundle (src/ and dist/ sit at the same depth). */
const SPA_DIST = resolve(__dirname, '../../../apps/outreach-web/dist');

async function dbOk(): Promise<boolean> {
  try {
    await getPool().query('select 1');
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await buildApp({
    cfg,
    spaDist: SPA_DIST,
    readiness: async () => ({ dbOk: await dbOk(), jobsOk: true }),
  });
  const close = async () => { await app.close(); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
  app.log.info({ url: cfg.API_PUBLIC_URL }, 'outreach-api listening');
}

process.on('unhandledRejection', (reason) => console.error('[fatal-guard] unhandledRejection (kept alive):', reason));
process.on('uncaughtException', (err) => console.error('[fatal-guard] uncaughtException (kept alive):', err));

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
```
(Task 4 replaces `jobsOk: true` with the real pg-boss status.)

- [ ] **Step 5: Route tests**

`services/outreach-api/src/routes/health.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';

const cfg = parseConfig({ NODE_ENV: 'test', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgres://u:p@h/db' });
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('health', () => {
  it('healthz is always 200', async () => {
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: false, jobsOk: false }) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
  it('readyz is 503 when the DB or jobs are down and 200 when both are up', async () => {
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: false }) });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await app.close();
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }) });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, dbOk: true, jobsOk: true });
  });
});
```

`services/outreach-api/src/routes/spa.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { isApiPath } from './spa.js';

const cfg = parseConfig({ NODE_ENV: 'test', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgres://u:p@h/db' });
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('isApiPath', () => {
  it('recognizes api and health paths and nothing else', () => {
    expect(isApiPath('/api/team')).toBe(true);
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/healthz')).toBe(true);
    expect(isApiPath('/readyz?x=1')).toBe(true);
    expect(isApiPath('/team')).toBe(false);
    expect(isApiPath('/')).toBe(false);
  });
});

describe('spa fallback', () => {
  it('serves index.html for app routes, 404 JSON for unknown api routes, and never caches index', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'outreach-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Outreach</title>');
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), spaDist: dist });
    const page = await app.inject({ method: 'GET', url: '/team' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, max-age=0');
    expect(page.body).toContain('Outreach');
    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
  it('returns 503 SPA_NOT_BUILT when the bundle is absent', async () => {
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), spaDist: '/nonexistent/dist' });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(503);
  });
});
```

- [ ] **Step 6: Dockerfile and root scripts**

`services/outreach-api/Dockerfile` (build context = repo root; Railway selects it via `RAILWAY_DOCKERFILE_PATH`):
```dockerfile
# syntax=docker/dockerfile:1
# outreach-api: serves the outreach-web bundle at / and the product API at /api.
FROM node:22-slim
ENV NODE_ENV=production
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/phone/package.json packages/phone/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/firewall/package.json packages/firewall/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/cti-api/package.json services/cti-api/package.json
COPY services/outreach-api/package.json services/outreach-api/package.json
COPY apps/cti-web/package.json apps/cti-web/package.json
COPY apps/cti-desktop/package.json apps/cti-desktop/package.json
COPY apps/outreach-web/package.json apps/outreach-web/package.json
RUN npm ci --include=dev
COPY . .
RUN npm run build:outreach
EXPOSE 4100
CMD ["node", "services/outreach-api/dist/server.js"]
```
Root `package.json` scripts — add:
```json
    "dev:outreach": "npm run build:packages && npm --workspace services/outreach-api run dev",
    "build:outreach": "npm run build:packages && npm --workspace apps/outreach-web run build --if-present && npm --workspace services/outreach-api run build",
```
(`--if-present` lets this task's Docker build succeed before Task 9 creates the web app. The root Dockerfile for cti-api must ALSO copy `services/outreach-api/package.json` and `apps/outreach-web/package.json` once they exist — add those two COPY lines to the root `Dockerfile` in this task for the API manifest and in Task 9 for the web manifest, since `npm ci` refuses to run with a workspace manifest missing.)

- [ ] **Step 7: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm install 2>&1 | tail -1 && npm run build:packages >/dev/null && npm -w services/outreach-api run test 2>&1 | tail -4 && npm run typecheck >/dev/null && echo TYPECHECK_OK
git add package.json package-lock.json Dockerfile services/outreach-api
git commit -m "feat(outreach-api): service skeleton — config, app builder, health, SPA fallback, Dockerfile"
```
Expected: outreach-api 3 files / 9 tests; root typecheck clean.

---

### Task 4: pg-boss job runner (queue registry, startup, readiness) (TDD)

**Files:**
- Create: `services/outreach-api/src/jobs/queues.ts`, `services/outreach-api/src/jobs/boss.ts`, `services/outreach-api/src/jobs/boss.test.ts`
- Modify: `services/outreach-api/src/server.ts`

**Interfaces:**
- Produces `QUEUES: readonly QueueDefinition[]` (empty in this plan; plan 3 adds `import.*` and `delivery.send`), `QueueDefinition = { name: string; options: { retryLimit: number; retryDelay: number; retryBackoff: boolean; expireInSeconds: number; deadLetter?: string } }`.
- Produces `BossLike` (the subset of pg-boss the runner uses), `createBoss(cfg: AppConfig): PgBoss`, `class JobRunner { constructor(deps: { boss: BossLike; queues: readonly QueueDefinition[]; log: RunnerLogger }); start(): Promise<void>; stop(): Promise<void>; isHealthy(): boolean }`.
- pg-boss 12 facts this relies on (verified from `pg-boss/dist/types.d.ts`): `new PgBoss({ connectionString, schema, application_name })`; `start(): Promise<this>`; `createQueue(name, options)`; `getQueue(name): Promise<QueueResult | null>`; `stop({ graceful, timeout })`; `PgBoss extends EventEmitter` and emits `'error'`. pg-boss creates its own schema and tables on `start()` (the connecting role needs `CREATE` on the database — the Railway Postgres owner role has it).

- [ ] **Step 1: Failing tests**

`services/outreach-api/src/jobs/boss.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { JobRunner, type BossLike } from './boss.js';
import type { QueueDefinition } from './queues.js';

function fakeBoss(existing: string[] = []) {
  const calls: string[] = [];
  const handlers: Record<string, (e: Error) => void> = {};
  const boss: BossLike = {
    on: vi.fn((event: 'error', h: (e: Error) => void) => { handlers[event] = h; return boss; }),
    start: vi.fn(async () => { calls.push('start'); return boss; }),
    stop: vi.fn(async () => { calls.push('stop'); }),
    getQueue: vi.fn(async (name: string) => (existing.includes(name) ? { name } : null)),
    createQueue: vi.fn(async (name: string) => { calls.push(`create:${name}`); }),
  };
  return { boss, calls, handlers };
}
const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
const queues: QueueDefinition[] = [
  { name: 'a', options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 } },
  { name: 'b', options: { retryLimit: 1, retryDelay: 5, retryBackoff: false, expireInSeconds: 60, deadLetter: 'b.dead' } },
];

describe('JobRunner', () => {
  it('starts the boss, creates only missing queues (dead-letter queues first), and becomes healthy', async () => {
    const { boss, calls } = fakeBoss(['a']);
    const runner = new JobRunner({ boss, queues, log });
    expect(runner.isHealthy()).toBe(false);
    await runner.start();
    expect(calls).toEqual(['start', 'create:b.dead', 'create:b']);
    expect(boss.createQueue).toHaveBeenCalledWith('b', queues[1]!.options);
    expect(runner.isHealthy()).toBe(true);
  });
  it('logs boss errors and marks itself unhealthy while stopped', async () => {
    const { boss, handlers } = fakeBoss();
    const runner = new JobRunner({ boss, queues: [], log });
    await runner.start();
    handlers['error']!(new Error('pool gone'));
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: 'pool gone' }), 'pg-boss error');
    await runner.stop();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 30_000 });
    expect(runner.isHealthy()).toBe(false);
  });
  it('stop is a no-op before start', async () => {
    const { boss } = fakeBoss();
    await new JobRunner({ boss, queues: [], log }).stop();
    expect(boss.stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test -- src/jobs 2>&1 | tail -4
```
Expected: FAIL — cannot resolve `./boss.js`.

- [ ] **Step 3: Implement**

`services/outreach-api/src/jobs/queues.ts`:
```ts
/** Every pg-boss queue this service owns. Queues are created idempotently on boot. */
export interface QueueOptions {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  deadLetter?: string;
}
export interface QueueDefinition {
  name: string;
  options: QueueOptions;
}
/** Plan 3 (lead store + import pipeline) adds `import.*` and `delivery.send` here. */
export const QUEUES: readonly QueueDefinition[] = [];
```

`services/outreach-api/src/jobs/boss.ts`:
```ts
import { PgBoss } from 'pg-boss';
import type { AppConfig } from '../config.js';
import type { QueueDefinition } from './queues.js';

/** The slice of pg-boss the runner depends on, so tests can inject a fake. */
export interface BossLike {
  on(event: 'error', handler: (err: Error) => void): unknown;
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  getQueue(name: string): Promise<unknown | null>;
  createQueue(name: string, options?: object): Promise<void>;
}

export interface RunnerLogger {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export function createBoss(cfg: AppConfig): PgBoss {
  return new PgBoss({ connectionString: cfg.DATABASE_URL, schema: cfg.PGBOSS_SCHEMA, application_name: 'outreach-api' });
}

const STOP_TIMEOUT_MS = 30_000;

export class JobRunner {
  private started = false;
  constructor(private readonly deps: { boss: BossLike; queues: readonly QueueDefinition[]; log: RunnerLogger }) {}

  async start(): Promise<void> {
    const { boss, log } = this.deps;
    boss.on('error', (err) => log.error({ err: err.message }, 'pg-boss error'));
    await boss.start();
    for (const q of this.deps.queues) {
      if (q.options.deadLetter) await this.ensureQueue(q.options.deadLetter, {});
      await this.ensureQueue(q.name, q.options);
    }
    this.started = true;
    log.info({ queues: this.deps.queues.map((q) => q.name) }, 'job runner started');
  }

  private async ensureQueue(name: string, options: object): Promise<void> {
    if (await this.deps.boss.getQueue(name)) return;
    await this.deps.boss.createQueue(name, options);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.deps.boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  }

  isHealthy(): boolean {
    return this.started;
  }
}
```

`services/outreach-api/src/server.ts` — wire it in: import `{ createBoss, JobRunner }` and `{ QUEUES }`; in `main()` after `loadConfig()`:
```ts
  const runner = new JobRunner({ boss: createBoss(cfg), queues: QUEUES, log: console });
  await runner.start();
```
pass `readiness: async () => ({ dbOk: await dbOk(), jobsOk: runner.isHealthy() })`, and make `close` call `await runner.stop()` before `app.close()`. (`console` satisfies `RunnerLogger`; swap to `app.log` after `buildApp` if you prefer, by constructing the runner after the app.)

- [ ] **Step 4: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test 2>&1 | tail -4 && npm -w services/outreach-api run typecheck && echo OK
git add services/outreach-api
git commit -m "feat(outreach-api): pg-boss job runner with idempotent queue registry and readiness"
```
Expected: outreach-api 4 files / 12 tests.

---

### Task 5: Sign-in core — signed state, identity-provider port, WorkOS adapter, in-memory fake, sign-in resolution (TDD)

**Files:**
- Create: `services/outreach-api/src/auth/state.ts`, `state.test.ts`, `services/outreach-api/src/auth/identity-provider.ts`, `services/outreach-api/src/auth/workos-provider.ts`, `services/outreach-api/src/auth/fake-provider.ts`, `services/outreach-api/src/auth/sign-in.ts`, `sign-in.test.ts`, `services/outreach-api/src/test/harness.ts`

**Interfaces:**
- `signState(secret, { returnTo? }, now?) → string`; `verifyState(secret, state, now?) → StatePayload | null`; `STATE_TTL_SECONDS = 600`.
- `IdentityProvider` port (below) + `IdentityExchangeError`.
- `WorkosIdentityProvider` (real), `FakeIdentityProvider` (tests and local dev without WorkOS).
- `completeSignIn(deps: { db: Db; idp: IdentityProvider }, code: string) → Promise<SignInOutcome>` where `SignInOutcome = { ok: true; userId: string; orgId: string } | { ok: false; reason: 'no_tenant' | 'tenant_suspended' }`.
- `services/outreach-api/src/test/harness.ts` exports `fakeDb(fixtures)` (the repo's fake-DB convention: `where` clauses are not introspected; each fake returns its fixture) and `testConfig()`.

WorkOS SDK 10.13 facts this relies on (verified from the installed `.d.mts`): `new WorkOS({ apiKey, clientId })`; `userManagement.getAuthorizationUrl({ provider: 'authkit', clientId, redirectUri, state, organizationId? }): string`; `userManagement.authenticateWithCode({ clientId, code }) → { user: { id, email, firstName, lastName }, organizationId?: string }`; `userManagement.listOrganizationMemberships({ userId, statuses: ['active'], limit }) → { data: OrganizationMembership[] }` with `organizationId`, `status`, `role.slug`; `userManagement.sendInvitation({ email, organizationId, roleSlug, inviterUserId?, expiresInDays? }) → Invitation { id, email, state, expiresAt, roleSlug }`; `userManagement.listInvitations({ organizationId, limit }) → { data }`; `organizations.createOrganization({ name, externalId }) → { id }`. SDK errors carry a numeric `status` (`BadRequestException` 400, `GenericServerException.status`).

- [ ] **Step 1: Failing tests**

`services/outreach-api/src/auth/state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { signState, STATE_TTL_SECONDS, verifyState } from './state.js';

const secret = 's'.repeat(32);
const now = Date.parse('2026-09-04T12:00:00Z');

describe('oauth state', () => {
  it('round-trips a return path and rejects tampering', () => {
    const s = signState(secret, { returnTo: '/team' }, now);
    expect(verifyState(secret, s, now)).toMatchObject({ returnTo: '/team' });
    const [enc, sig] = s.split('.') as [string, string];
    expect(verifyState(secret, `${enc}x.${sig}`, now)).toBeNull();
    expect(verifyState('other-secret-that-is-long-enough', s, now)).toBeNull();
    expect(verifyState(secret, 'garbage', now)).toBeNull();
  });
  it('expires after the TTL and rejects future-dated state', () => {
    const s = signState(secret, {}, now);
    expect(verifyState(secret, s, now + STATE_TTL_SECONDS * 1000)).not.toBeNull();
    expect(verifyState(secret, s, now + (STATE_TTL_SECONDS + 1) * 1000)).toBeNull();
    expect(verifyState(secret, s, now - 5_000)).toBeNull();
  });
  it('only accepts same-origin relative return paths', () => {
    const evil = signState(secret, { returnTo: 'https://evil.example/x' }, now);
    expect(verifyState(secret, evil, now)).toBeNull();
    const proto = signState(secret, { returnTo: '//evil.example' }, now);
    expect(verifyState(secret, proto, now)).toBeNull();
  });
});
```

`services/outreach-api/src/test/harness.ts`:
```ts
import type { Db } from '@cti/db';
import { parseConfig, type AppConfig } from '../config.js';

export function testConfig(over: Record<string, string> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    SESSION_SECRET: 's'.repeat(32),
    DATABASE_URL: 'postgres://u:p@h/db',
    APP_PUBLIC_URL: 'http://app.test',
    API_PUBLIC_URL: 'http://api.test',
    ...over,
  });
}

export interface Fixtures {
  organizations?: Array<Record<string, unknown>>;
  users?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
}

/**
 * Fake Drizzle handle in this repo's convention: `where` is not introspected;
 * `findFirst` returns the first fixture, `findMany` all of them; writes are
 * recorded. Tests that need "which row matched" put exactly one row in the
 * fixture or filter in the code under test (as completeSignIn does).
 */
export function fakeDb(fx: Fixtures = {}) {
  const writes: Array<{ op: 'insert' | 'update'; table: unknown; values: Record<string, unknown> }> = [];
  const table = (rows: Array<Record<string, unknown>> = []) => ({
    findFirst: async () => rows[0],
    findMany: async () => rows,
  });
  const db = {
    query: {
      organizations: table(fx.organizations),
      users: table(fx.users),
      sessions: table(fx.sessions),
    },
    insert: (t: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ op: 'insert', table: t, values });
        const row = { id: `new-${writes.length}`, ...values };
        return { returning: async () => [row], onConflictDoNothing: async () => undefined };
      },
    }),
    update: (t: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { writes.push({ op: 'update', table: t, values }); return { rowCount: 1 }; },
      }),
    }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return { db: db as unknown as Db, writes };
}
```

`services/outreach-api/src/auth/sign-in.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { schema } from '@cti/db';
import { FakeIdentityProvider } from './fake-provider.js';
import { completeSignIn } from './sign-in.js';
import { fakeDb } from '../test/harness.js';

const tenant = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', workosOrgId: 'org_gg' };
const other = { id: 'O2', name: 'Other', slug: 'other', status: 'active', workosOrgId: 'org_other' };

function idpWith(email: string, orgs: Array<{ organizationId: string; role: string }>, organizationId: string | null = null) {
  const idp = new FakeIdentityProvider();
  idp.addUser({ externalId: 'wos_u1', email, firstName: 'Ann', lastName: 'Rep' }, orgs);
  idp.setNextCode('code-1', 'wos_u1', organizationId);
  return idp;
}

describe('completeSignIn', () => {
  it('creates a human user in the tenant matching the WorkOS org and links the external id', async () => {
    const { db, writes } = fakeDb({ organizations: [tenant], users: [] });
    const idp = idpWith('ann@gg.co', [{ organizationId: 'org_gg', role: 'member' }]);
    const out = await completeSignIn({ db, idp }, 'code-1');
    expect(out).toEqual({ ok: true, userId: 'new-1', orgId: 'O1' });
    expect(writes[0]).toMatchObject({ op: 'insert', table: schema.users, values: { orgId: 'O1', email: 'ann@gg.co', kind: 'human', externalAuthId: 'wos_u1', isAdmin: false, displayName: 'Ann Rep' } });
  });
  it('links an existing human user, promotes on admin role, never demotes', async () => {
    const existing = { id: 'U1', orgId: 'O1', email: 'ann@gg.co', kind: 'human', isAdmin: true, externalAuthId: null, displayName: 'Ann' };
    const { db, writes } = fakeDb({ organizations: [tenant], users: [existing] });
    const out = await completeSignIn({ db, idp: idpWith('ann@gg.co', [{ organizationId: 'org_gg', role: 'member' }]) }, 'code-1');
    expect(out).toEqual({ ok: true, userId: 'U1', orgId: 'O1' });
    expect(writes[0]).toMatchObject({ op: 'update', table: schema.users, values: { externalAuthId: 'wos_u1', isAdmin: true } });
  });
  it('prefers the organization WorkOS selected, then the first active membership we know', async () => {
    const { db } = fakeDb({ organizations: [other, tenant], users: [] });
    const idp = idpWith('ann@gg.co', [{ organizationId: 'org_other', role: 'member' }, { organizationId: 'org_gg', role: 'admin' }], 'org_gg');
    const out = await completeSignIn({ db, idp }, 'code-1');
    expect(out).toMatchObject({ ok: true, orgId: 'O1' });
  });
  it('refuses a user whose memberships match no tenant', async () => {
    const { db, writes } = fakeDb({ organizations: [], users: [] });
    const out = await completeSignIn({ db, idp: idpWith('x@y.co', [{ organizationId: 'org_unknown', role: 'member' }]) }, 'code-1');
    expect(out).toEqual({ ok: false, reason: 'no_tenant' });
    expect(writes).toHaveLength(0);
  });
  it('refuses a suspended tenant', async () => {
    const { db } = fakeDb({ organizations: [{ ...tenant, status: 'suspended' }], users: [] });
    const out = await completeSignIn({ db, idp: idpWith('ann@gg.co', [{ organizationId: 'org_gg', role: 'member' }]) }, 'code-1');
    expect(out).toEqual({ ok: false, reason: 'tenant_suspended' });
  });
  it('propagates an invalid code as IdentityExchangeError', async () => {
    const { db } = fakeDb({ organizations: [tenant] });
    await expect(completeSignIn({ db, idp: new FakeIdentityProvider() }, 'bad')).rejects.toMatchObject({ name: 'IdentityExchangeError' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test -- src/auth 2>&1 | tail -4
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`services/outreach-api/src/auth/state.ts`:
```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface StatePayload {
  nonce: string;
  iat: number;
  returnTo?: string;
}
export const STATE_TTL_SECONDS = 600;
const b64u = (buf: Buffer): string => buf.toString('base64url');
const hmac = (secret: string, data: string): string => b64u(createHmac('sha256', secret).update(data).digest());
/** Same-origin relative path only: starts with one slash, never two. */
const SAFE_RETURN_TO = /^\/(?!\/)/;

/** Stateless CSRF token for the OAuth round trip: signed JSON with a 10-minute life. */
export function signState(secret: string, input: { returnTo?: string }, now: number = Date.now()): string {
  const body: StatePayload = { nonce: b64u(randomBytes(16)), iat: Math.floor(now / 1000) };
  if (input.returnTo) body.returnTo = input.returnTo;
  const enc = b64u(Buffer.from(JSON.stringify(body), 'utf8'));
  return `${enc}.${hmac(secret, enc)}`;
}

export function verifyState(secret: string, state: string, now: number = Date.now()): StatePayload | null {
  const [enc, sig] = state.split('.');
  if (!enc || !sig) return null;
  const expected = Buffer.from(hmac(secret, enc));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: Partial<StatePayload>;
  try {
    body = JSON.parse(Buffer.from(enc, 'base64url').toString('utf8')) as Partial<StatePayload>;
  } catch {
    return null;
  }
  if (typeof body.nonce !== 'string' || typeof body.iat !== 'number') return null;
  const age = Math.floor(now / 1000) - body.iat;
  if (age < 0 || age > STATE_TTL_SECONDS) return null;
  if (body.returnTo !== undefined && !SAFE_RETURN_TO.test(body.returnTo)) return null;
  return body as StatePayload;
}
```

`services/outreach-api/src/auth/identity-provider.ts`:
```ts
import type { RoleSlug } from '@cti/contracts';

export interface IdentityUser {
  externalId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}
export interface IdentityMembership {
  organizationId: string;
  role: string;
  status: 'active' | 'inactive' | 'pending';
}
export interface IdentityInvite {
  id: string;
  email: string;
  role: string | null;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
}
export interface ExchangeResult {
  user: IdentityUser;
  /** The organization the provider scoped this sign-in to, when it did. */
  organizationId: string | null;
}

/** Everything the product needs from the hosted identity provider. Implemented by WorkOS and by a fake. */
export interface IdentityProvider {
  authorizationUrl(input: { state: string; organizationId?: string }): string;
  exchangeCode(code: string): Promise<ExchangeResult>;
  listMemberships(externalUserId: string): Promise<IdentityMembership[]>;
  createOrganization(input: { name: string; externalId: string }): Promise<{ id: string }>;
  invite(input: { email: string; organizationId: string; role: RoleSlug; inviterExternalId?: string }): Promise<IdentityInvite>;
  listInvites(organizationId: string): Promise<IdentityInvite[]>;
}

/** The authorization code was invalid, expired, or already used. Never a server fault. */
export class IdentityExchangeError extends Error {
  constructor(message = 'Sign-in code was rejected by the identity provider') {
    super(message);
    this.name = 'IdentityExchangeError';
  }
}
```

`services/outreach-api/src/auth/workos-provider.ts`:
```ts
import { WorkOS } from '@workos-inc/node';
import type { RoleSlug } from '@cti/contracts';
import { IdentityExchangeError, type ExchangeResult, type IdentityInvite, type IdentityMembership, type IdentityProvider } from './identity-provider.js';

export interface WorkosSettings {
  apiKey: string;
  clientId: string;
  redirectUri: string;
}

interface WorkosInvitation {
  id: string;
  email: string;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
  roleSlug: string | null;
}

function toInvite(i: WorkosInvitation): IdentityInvite {
  return { id: i.id, email: i.email.toLowerCase(), role: i.roleSlug, state: i.state, expiresAt: i.expiresAt };
}

function isClientError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export class WorkosIdentityProvider implements IdentityProvider {
  private readonly workos: WorkOS;
  constructor(private readonly settings: WorkosSettings) {
    this.workos = new WorkOS({ apiKey: settings.apiKey, clientId: settings.clientId });
  }

  authorizationUrl(input: { state: string; organizationId?: string }): string {
    return this.workos.userManagement.getAuthorizationUrl({
      provider: 'authkit',
      clientId: this.settings.clientId,
      redirectUri: this.settings.redirectUri,
      state: input.state,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    });
  }

  async exchangeCode(code: string): Promise<ExchangeResult> {
    try {
      const r = await this.workos.userManagement.authenticateWithCode({ clientId: this.settings.clientId, code });
      return {
        user: { externalId: r.user.id, email: r.user.email.toLowerCase(), firstName: r.user.firstName, lastName: r.user.lastName },
        organizationId: r.organizationId ?? null,
      };
    } catch (err) {
      if (isClientError(err)) throw new IdentityExchangeError();
      throw err;
    }
  }

  async listMemberships(externalUserId: string): Promise<IdentityMembership[]> {
    const page = await this.workos.userManagement.listOrganizationMemberships({ userId: externalUserId, statuses: ['active'], limit: 100 });
    return page.data.map((m) => ({ organizationId: m.organizationId, role: m.role.slug, status: m.status }));
  }

  async createOrganization(input: { name: string; externalId: string }): Promise<{ id: string }> {
    const org = await this.workos.organizations.createOrganization({ name: input.name, externalId: input.externalId });
    return { id: org.id };
  }

  async invite(input: { email: string; organizationId: string; role: RoleSlug; inviterExternalId?: string }): Promise<IdentityInvite> {
    const inv = await this.workos.userManagement.sendInvitation({
      email: input.email,
      organizationId: input.organizationId,
      roleSlug: input.role,
      expiresInDays: 7,
      ...(input.inviterExternalId ? { inviterUserId: input.inviterExternalId } : {}),
    });
    return toInvite(inv);
  }

  async listInvites(organizationId: string): Promise<IdentityInvite[]> {
    const page = await this.workos.userManagement.listInvitations({ organizationId, limit: 100 });
    return page.data.map(toInvite);
  }
}
```
If `tsc` reports that a field name differs in the installed SDK version (e.g. `roleSlug` on `Invitation`), read `node_modules/@workos-inc/node/lib/*.d.mts` for the exact name and adapt `toInvite` only.

`services/outreach-api/src/auth/fake-provider.ts`:
```ts
import type { RoleSlug } from '@cti/contracts';
import { IdentityExchangeError, type ExchangeResult, type IdentityInvite, type IdentityMembership, type IdentityProvider, type IdentityUser } from './identity-provider.js';

/** In-memory identity provider for tests and for local dev without WorkOS credentials. */
export class FakeIdentityProvider implements IdentityProvider {
  private users = new Map<string, { user: IdentityUser; memberships: IdentityMembership[] }>();
  private codes = new Map<string, { externalId: string; organizationId: string | null }>();
  private orgs = new Map<string, { id: string; name: string; externalId: string }>();
  private invites: IdentityInvite[] = [];
  private seq = 0;

  addUser(user: IdentityUser, orgs: Array<{ organizationId: string; role: string }>): void {
    this.users.set(user.externalId, { user, memberships: orgs.map((o) => ({ ...o, status: 'active' })) });
  }
  setNextCode(code: string, externalId: string, organizationId: string | null = null): void {
    this.codes.set(code, { externalId, organizationId });
  }

  authorizationUrl(input: { state: string; organizationId?: string }): string {
    const u = new URL('http://fake-idp.test/authorize');
    u.searchParams.set('state', input.state);
    if (input.organizationId) u.searchParams.set('organization_id', input.organizationId);
    return u.toString();
  }
  async exchangeCode(code: string): Promise<ExchangeResult> {
    const c = this.codes.get(code);
    const u = c && this.users.get(c.externalId);
    if (!c || !u) throw new IdentityExchangeError();
    this.codes.delete(code);
    return { user: u.user, organizationId: c.organizationId };
  }
  async listMemberships(externalUserId: string): Promise<IdentityMembership[]> {
    return this.users.get(externalUserId)?.memberships ?? [];
  }
  async createOrganization(input: { name: string; externalId: string }): Promise<{ id: string }> {
    const id = `org_fake_${++this.seq}`;
    this.orgs.set(id, { id, ...input });
    return { id };
  }
  async invite(input: { email: string; organizationId: string; role: RoleSlug }): Promise<IdentityInvite> {
    const inv: IdentityInvite = { id: `inv_${++this.seq}`, email: input.email, role: input.role, state: 'pending', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
    this.invites.push({ ...inv, ...({ organizationId: input.organizationId } as object) });
    return inv;
  }
  async listInvites(organizationId: string): Promise<IdentityInvite[]> {
    return this.invites.filter((i) => (i as unknown as { organizationId: string }).organizationId === organizationId);
  }
}
```

`services/outreach-api/src/auth/sign-in.ts`:
```ts
import { and, eq, inArray } from 'drizzle-orm';
import { humanUserByEmail } from '@cti/auth';
import { schema, type Db, type Organization } from '@cti/db';
import type { IdentityProvider, IdentityUser } from './identity-provider.js';

export type SignInOutcome =
  | { ok: true; userId: string; orgId: string }
  | { ok: false; reason: 'no_tenant' | 'tenant_suspended' };

export interface SignInDeps {
  db: Db;
  idp: IdentityProvider;
}

/** Candidate WorkOS org ids in preference order: the one WorkOS scoped the sign-in to, then active memberships. */
function candidateOrgIds(selected: string | null, memberships: Array<{ organizationId: string; status: string }>): string[] {
  const ids = memberships.filter((m) => m.status === 'active').map((m) => m.organizationId);
  // The provider-selected org counts only when the user holds an ACTIVE membership in it.
  return [...new Set([...(selected && ids.includes(selected) ? [selected] : []), ...ids])];
}

async function pickTenant(db: Db, candidates: string[]): Promise<Organization | null> {
  if (candidates.length === 0) return null;
  const orgs = await db.query.organizations.findMany({ where: inArray(schema.organizations.workosOrgId, candidates) });
  for (const id of candidates) {
    const hit = orgs.find((o) => o.workosOrgId === id);
    if (hit) return hit;
  }
  return null;
}

function displayName(u: IdentityUser): string | null {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name || null;
}

async function linkOrCreateUser(db: Db, org: Organization, u: IdentityUser, isAdminRole: boolean): Promise<string> {
  const existing = await db.query.users.findFirst({ where: humanUserByEmail(org.id, u.email) });
  if (existing) {
    await db
      .update(schema.users)
      .set({ externalAuthId: u.externalId, isAdmin: existing.isAdmin || isAdminRole, displayName: existing.displayName ?? displayName(u) })
      .where(and(eq(schema.users.id, existing.id), eq(schema.users.orgId, org.id)));
    return existing.id;
  }
  const [created] = await db
    .insert(schema.users)
    .values({ orgId: org.id, email: u.email, displayName: displayName(u), kind: 'human', externalAuthId: u.externalId, isAdmin: isAdminRole, timezone: org.timezone })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Exchange the code, map the WorkOS organization to a tenant, and link or create the human user. */
export async function completeSignIn(deps: SignInDeps, code: string): Promise<SignInOutcome> {
  const { user, organizationId } = await deps.idp.exchangeCode(code);
  const memberships = await deps.idp.listMemberships(user.externalId);
  const org = await pickTenant(deps.db, candidateOrgIds(organizationId, memberships));
  if (!org) return { ok: false, reason: 'no_tenant' };
  if (org.status !== 'active') return { ok: false, reason: 'tenant_suspended' };
  const role = memberships.find((m) => m.status === 'active' && m.organizationId === org.workosOrgId)?.role;
  const userId = await linkOrCreateUser(deps.db, org, user, role === 'admin');
  return { ok: true, userId, orgId: org.id };
}
```

**Amendments from the Task 5 review (applied in a fix wave):** `IdentityUser.email` is documented as always lowercase/trimmed and normalized in the fake and in `linkOrCreateUser`; `FakeIdentityProvider.addUser` accepts an optional per-org `status`; `isClientError` is exported and maps only 400/401/404 to `IdentityExchangeError`; `verifyState` requires exactly two dot-separated parts, guards a non-object JSON payload, and tolerates 2 seconds of negative clock skew; the test harness records each fake table's `where` argument on `db.captured.where` so `sign-in.test.ts` can render and assert the `workos_org_id in (…)` predicate with `PgDialect`. Tests added: selected-org-without-membership, pending-admin-grants-nothing, mixed-case email links the existing row, `isClientError` matrix, state malleability/null-payload.

- [ ] **Step 4: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test 2>&1 | tail -4 && npm -w services/outreach-api run typecheck && echo OK
git add services/outreach-api
git commit -m "feat(outreach-api): sign-in core — signed OAuth state, identity-provider port, WorkOS adapter, fake, tenant resolution"
```
Expected: outreach-api 6 files / 21 tests.

---

### Task 6: Auth routes and request context (session handoff, me, logout, tenant scoping) (TDD)

**Files:**
- Create: `services/outreach-api/src/tenancy/scope.ts`, `scope.test.ts`, `services/outreach-api/src/routes/auth.ts`, `auth.test.ts`, `services/outreach-api/src/http/errors.ts`
- Modify: `services/outreach-api/src/server.ts` (register routes, construct the provider), `services/outreach-api/src/test/harness.ts` (add `buildTestApp`)

**Interfaces:**
- `http/errors.ts`: `sendError(reply, status, code, error, details?)` → `{ error, code, requestId }` (the `ApiError` contract).
- `tenancy/scope.ts`: `type RequestContext = { session: SessionUser; orgId: string; tenant: Organization }`; `requireContext(db, req, reply): Promise<RequestContext | null>` (sends 401 `UNAUTHENTICATED`, 403 `TENANT_FORBIDDEN`/`TENANT_SUSPENDED`; honors `X-Org-Id` for super admins); `requireAdmin(ctx, reply): boolean` (403 `ADMIN_ONLY`); `toTenantDto(org): Tenant`.
- `routes/auth.ts`: `registerAuthRoutes(app, deps: { cfg; db; idp: IdentityProvider | null })` mounting `GET /auth/workos/start`, `GET /auth/workos/callback`, `GET /auth/session`, `GET /auth/me`, `POST /auth/logout` (all under the `/api` prefix applied by `buildApp`).
- Handoff cookie value: `base64url(JSON{ token, expiresAt })`.

- [ ] **Step 1: Failing tests**

`services/outreach-api/src/tenancy/scope.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fakeDb } from '../test/harness.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
import { requireAdmin, requireContext } from './scope.js';

const human = { userId: 'U1', orgId: 'O1', email: 'a@b.co', isAdmin: false, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const org1 = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles' };
const org2 = { id: '11111111-1111-4111-8111-111111111111', name: 'Other', slug: 'other', status: 'active', timezone: 'UTC' };

async function run(db: unknown, headers: Record<string, string> = {}) {
  const app = Fastify();
  app.get('/x', async (req, reply) => {
    const ctx = await requireContext(db as never, req, reply);
    if (!ctx) return;
    return { orgId: ctx.orgId, admin: requireAdmin(ctx, reply) };
  });
  const res = await app.inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer t', ...headers } });
  await app.close();
  return res;
}

beforeEach(() => { state.session = human; });

describe('requireContext', () => {
  it('401 without a valid session', async () => {
    state.session = null;
    const res = await run(fakeDb({ organizations: [org1] }).db);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it("resolves the session's own tenant and ignores X-Org-Id for non-super-admins", async () => {
    state.session = { ...human, isAdmin: true }; // the /x handler also calls requireAdmin
    const res = await run(fakeDb({ organizations: [org1] }).db, { 'x-org-id': org2.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orgId: 'O1' });
  });
  it('lets a super admin switch to another active tenant, and rejects a bad or unknown id', async () => {
    state.session = { ...human, isSuperAdmin: true };
    const ok = await run(fakeDb({ organizations: [org2] }).db, { 'x-org-id': org2.id });
    expect(ok.json()).toMatchObject({ orgId: org2.id });
    const bad = await run(fakeDb({ organizations: [org2] }).db, { 'x-org-id': 'not-a-uuid' });
    expect(bad.statusCode).toBe(403);
    const unknown = await run(fakeDb({ organizations: [] }).db, { 'x-org-id': org2.id });
    expect(unknown.statusCode).toBe(403);
  });
  it('403 TENANT_SUSPENDED when the tenant is not active', async () => {
    const res = await run(fakeDb({ organizations: [{ ...org1, status: 'suspended' }] }).db);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TENANT_SUSPENDED' });
  });
  it('requireAdmin sends 403 ADMIN_ONLY for non-admins', async () => {
    const res = await run(fakeDb({ organizations: [org1] }).db);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ADMIN_ONLY' });
  });
});
```

`services/outreach-api/src/routes/auth.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { signState } from '../auth/state.js';
import { buildTestApp, fakeDb, testConfig } from '../test/harness.js';

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  issued: [] as string[],
  revoked: [] as string[],
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  issueSession: async (userId: string) => { state.issued.push(userId); return { token: `tok-${userId}`, expiresAt: new Date('2026-10-04T00:00:00Z') }; },
  resolveSession: async () => state.session,
  revokeSession: async (bearer: string) => { state.revoked.push(bearer); },
}));

const cfg = testConfig();
const tenant = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
let app: FastifyInstance;
let idp: FakeIdentityProvider;

beforeEach(async () => {
  state.session = null; state.issued = []; state.revoked = [];
  idp = new FakeIdentityProvider();
  idp.addUser({ externalId: 'wos_u1', email: 'ann@gg.co', firstName: 'Ann', lastName: 'Rep' }, [{ organizationId: 'org_gg', role: 'admin' }]);
  idp.setNextCode('code-1', 'wos_u1', 'org_gg');
  app = await buildTestApp({ cfg, db: fakeDb({ organizations: [tenant], users: [] }).db, idp });
});
afterEach(async () => { await app.close(); });

describe('sign-in routes', () => {
  it('start redirects to the provider with a signed state carrying returnTo', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/workos/start?returnTo=/team' });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.host).toBe('fake-idp.test');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
  it('start is 503 when WorkOS is not configured', async () => {
    await app.close();
    app = await buildTestApp({ cfg, db: fakeDb({ organizations: [tenant] }).db, idp: null });
    const res = await app.inject({ method: 'GET', url: '/api/auth/workos/start' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'SIGN_IN_DISABLED' });
  });
  it('callback rejects a bad state before touching the provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/workos/callback?code=code-1&state=nope' });
    expect(res.statusCode).toBe(400);
    expect(state.issued).toEqual([]);
  });
  it('callback issues a session, hands it over in a scoped cookie, and redirects to the app', async () => {
    const st = signState(cfg.SESSION_SECRET, { returnTo: '/team' });
    const res = await app.inject({ method: 'GET', url: `/api/auth/workos/callback?code=code-1&state=${st}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://app.test/auth/callback?returnTo=%2Fteam');
    const cookie = res.cookies.find((c) => c.name === 'outreach_session_handoff');
    expect(cookie).toMatchObject({ httpOnly: true, path: '/api/auth/session', maxAge: 60 });
    expect(state.issued).toEqual(['new-1']);
  });
  it('callback sends provider errors and unknown tenants back to sign-in with a reason', async () => {
    const st = signState(cfg.SESSION_SECRET, {});
    const denied = await app.inject({ method: 'GET', url: `/api/auth/workos/callback?error=access_denied&state=${st}` });
    expect(denied.headers.location).toBe('http://app.test/sign-in?error=access_denied');
    idp.addUser({ externalId: 'wos_u2', email: 'x@y.co', firstName: null, lastName: null }, [{ organizationId: 'org_unknown', role: 'member' }]);
    idp.setNextCode('code-2', 'wos_u2');
    const noTenant = await app.inject({ method: 'GET', url: `/api/auth/workos/callback?code=code-2&state=${st}` });
    expect(noTenant.headers.location).toBe('http://app.test/sign-in?error=no_tenant');
  });
  it('session exchanges the handoff cookie once and returns the user and tenant', async () => {
    state.session = { userId: 'U1', orgId: 'O1', email: 'ann@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
    const value = Buffer.from(JSON.stringify({ token: 'tok-U1', expiresAt: '2026-10-04T00:00:00.000Z' })).toString('base64url');
    const res = await app.inject({ method: 'GET', url: '/api/auth/session', cookies: { outreach_session_handoff: value } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: 'tok-U1', user: { userId: 'U1', kind: 'human' }, tenant: { slug: 'gg-homes' } });
    expect(res.cookies.find((c) => c.name === 'outreach_session_handoff')).toMatchObject({ value: '' });
    const none = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(none.statusCode).toBe(401);
  });
  it('me requires a bearer and logout revokes it', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    state.session = { userId: 'U1', orgId: 'O1', email: 'ann@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer tok-U1' } });
    expect(me.json()).toMatchObject({ user: { email: 'ann@gg.co' }, tenant: { name: 'GG Homes' } });
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: 'Bearer tok-U1' } });
    expect(out.statusCode).toBe(204);
    expect(state.revoked).toEqual(['Bearer tok-U1']);
  });
});
```

Add to `services/outreach-api/src/test/harness.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { registerAuthRoutes } from '../routes/auth.js';

export async function buildTestApp(deps: { cfg: AppConfig; db: Db; idp: IdentityProvider | null }): Promise<FastifyInstance> {
  return buildApp({
    cfg: deps.cfg,
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [(app) => registerAuthRoutes(app, deps)],
  });
}
```
(Tasks 7 and 8 append their route plugins to this list.)

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test -- src/tenancy src/routes/auth 2>&1 | tail -4
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`services/outreach-api/src/http/errors.ts`:
```ts
import type { FastifyReply } from 'fastify';

/** The one error envelope every route sends (see @cti/contracts ApiError). */
export function sendError(reply: FastifyReply, status: number, code: string, error: string, details?: unknown): FastifyReply {
  const body: Record<string, unknown> = { error, code, requestId: reply.request.id };
  if (details !== undefined) body.details = details;
  return reply.code(status).send(body);
}
```

`services/outreach-api/src/tenancy/scope.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveSession, type SessionUser } from '@cti/auth';
import type { Tenant } from '@cti/contracts';
import { schema, type Db, type Organization } from '@cti/db';
import { sendError } from '../http/errors.js';

export interface RequestContext {
  session: SessionUser;
  /** The tenant this request acts on: the session's own, or a super admin's X-Org-Id choice. */
  orgId: string;
  tenant: Organization;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function toTenantDto(org: Organization): Tenant {
  return { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone, status: org.status as Tenant['status'], workosLinked: Boolean(org.workosOrgId) };
}

function requestedOrgId(session: SessionUser, req: FastifyRequest): string | null {
  const header = req.headers['x-org-id'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!session.isSuperAdmin || !value) return session.orgId;
  return UUID.test(value) ? value : null;
}

/** Resolve session + tenant or send the matching error. Fail closed on every branch. */
export async function requireContext(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<RequestContext | null> {
  const session = await resolveSession(req.headers.authorization);
  if (!session) {
    sendError(reply, 401, 'UNAUTHENTICATED', 'Sign in required');
    return null;
  }
  const orgId = requestedOrgId(session, req);
  if (!orgId) {
    sendError(reply, 403, 'TENANT_FORBIDDEN', 'Invalid tenant selection');
    return null;
  }
  const tenant = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
  if (!tenant || tenant.id !== orgId) {
    sendError(reply, 403, 'TENANT_FORBIDDEN', 'Unknown tenant');
    return null;
  }
  if (tenant.status !== 'active') {
    sendError(reply, 403, 'TENANT_SUSPENDED', 'This tenant is suspended');
    return null;
  }
  return { session, orgId, tenant };
}

export function requireAdmin(ctx: RequestContext, reply: FastifyReply): boolean {
  if (ctx.session.isAdmin || ctx.session.isSuperAdmin) return true;
  sendError(reply, 403, 'ADMIN_ONLY', 'Admin access required');
  return false;
}
```
Note for the fake-DB tests: `findFirst` returns the fixture's first row regardless of `where`, so the `tenant.id !== orgId` guard is what makes the "unknown id" test pass when the fixture holds a different org — and it is also correct defensively in production.

`services/outreach-api/src/routes/auth.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { issueSession, resolveSession, revokeSession, ServiceUserSessionError, SuspendedTenantError } from '@cti/auth';
import type { SessionUser as SessionUserDto } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { SessionUser } from '@cti/auth';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { IdentityExchangeError } from '../auth/identity-provider.js';
import { completeSignIn } from '../auth/sign-in.js';
import { signState, verifyState } from '../auth/state.js';
import type { AppConfig } from '../config.js';
import { sendError } from '../http/errors.js';
import { toTenantDto } from '../tenancy/scope.js';

export const HANDOFF_COOKIE = 'outreach_session_handoff';
const HANDOFF_PATH = '/api/auth/session';

export interface AuthRouteDeps {
  cfg: AppConfig;
  db: Db;
  /** null when WorkOS is not configured: sign-in routes answer 503. */
  idp: IdentityProvider | null;
}

const StartQuery = z.object({ returnTo: z.string().regex(/^\/(?!\/)/).optional() });
const CallbackQuery = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional(), error_description: z.string().optional() });

function toSessionUserDto(s: SessionUser, displayName: string | null): SessionUserDto {
  return { userId: s.userId, orgId: s.orgId, email: s.email, displayName, isAdmin: s.isAdmin, isSuperAdmin: s.isSuperAdmin, kind: 'human' };
}

function signInRedirect(cfg: AppConfig, reply: FastifyReply, error: string): FastifyReply {
  return reply.redirect(`${cfg.APP_PUBLIC_URL}/sign-in?error=${encodeURIComponent(error)}`);
}

async function userAndTenant(db: Db, session: SessionUser) {
  const [user, tenant] = await Promise.all([
    db.query.users.findFirst({ where: eq(schema.users.id, session.userId), columns: { displayName: true } }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, session.orgId) }),
  ]);
  return { user: toSessionUserDto(session, user?.displayName ?? null), tenant: tenant ? toTenantDto(tenant) : null };
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { cfg, db, idp } = deps;

  app.get('/auth/workos/start', async (req, reply) => {
    if (!idp) return sendError(reply, 503, 'SIGN_IN_DISABLED', 'Sign-in is not configured on this server');
    const q = StartQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid returnTo');
    const state = signState(cfg.SESSION_SECRET, { returnTo: q.data.returnTo });
    return reply.redirect(idp.authorizationUrl({ state }));
  });

  app.get('/auth/workos/callback', async (req, reply) => {
    if (!idp) return sendError(reply, 503, 'SIGN_IN_DISABLED', 'Sign-in is not configured on this server');
    const q = CallbackQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'BAD_REQUEST', 'Missing state');
    const state = verifyState(cfg.SESSION_SECRET, q.data.state);
    if (!state) return sendError(reply, 400, 'BAD_STATE', 'Sign-in state is invalid or expired; start again');
    if (q.data.error || !q.data.code) return signInRedirect(cfg, reply, q.data.error ?? 'missing_code');
    try {
      const outcome = await completeSignIn({ db, idp }, q.data.code);
      if (!outcome.ok) return signInRedirect(cfg, reply, outcome.reason);
      const session = await issueSession(outcome.userId);
      const value = Buffer.from(JSON.stringify({ token: session.token, expiresAt: session.expiresAt.toISOString() }), 'utf8').toString('base64url');
      reply.setCookie(HANDOFF_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: cfg.NODE_ENV === 'production', path: HANDOFF_PATH, maxAge: 60 });
      const target = new URL('/auth/callback', cfg.APP_PUBLIC_URL);
      if (state.returnTo) target.searchParams.set('returnTo', state.returnTo);
      return reply.redirect(target.toString());
    } catch (err) {
      if (err instanceof IdentityExchangeError) return signInRedirect(cfg, reply, 'invalid_code');
      if (err instanceof SuspendedTenantError) return signInRedirect(cfg, reply, 'tenant_suspended');
      if (err instanceof ServiceUserSessionError) return signInRedirect(cfg, reply, 'forbidden');
      req.log.error({ err: (err as Error).message }, 'sign-in callback failed');
      return signInRedirect(cfg, reply, 'server_error');
    }
  });

  app.get('/auth/session', async (req, reply) => {
    const raw = req.cookies[HANDOFF_COOKIE];
    if (!raw) return sendError(reply, 401, 'NO_HANDOFF', 'No pending sign-in');
    reply.clearCookie(HANDOFF_COOKIE, { path: HANDOFF_PATH });
    let parsed: { token: string; expiresAt: string };
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { token: string; expiresAt: string };
    } catch {
      return sendError(reply, 401, 'NO_HANDOFF', 'Malformed sign-in handoff');
    }
    const session = await resolveSession(`Bearer ${parsed.token}`);
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Session is not valid');
    const { user, tenant } = await userAndTenant(db, session);
    if (!tenant) return sendError(reply, 403, 'TENANT_FORBIDDEN', 'Unknown tenant');
    return { token: parsed.token, expiresAt: parsed.expiresAt, user, tenant };
  });

  app.get('/auth/me', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Sign in required');
    const { user, tenant } = await userAndTenant(db, session);
    if (!tenant) return sendError(reply, 403, 'TENANT_FORBIDDEN', 'Unknown tenant');
    return { user, tenant };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.headers.authorization) await revokeSession(req.headers.authorization);
    return reply.code(204).send();
  });
}
```
(Two `import … from '@cti/auth'` lines above are shown for clarity; merge them into one statement.)

`services/outreach-api/src/server.ts` — construct the provider and register the routes:
```ts
import { getDb } from '@cti/db';
import { WorkosIdentityProvider } from './auth/workos-provider.js';
import { registerAuthRoutes } from './routes/auth.js';
// inside main(), before buildApp:
  const db = getDb();
  const idp = cfg.workosEnabled
    ? new WorkosIdentityProvider({ apiKey: cfg.WORKOS_API_KEY!, clientId: cfg.WORKOS_CLIENT_ID!, redirectUri: cfg.WORKOS_REDIRECT_URI! })
    : null;
// and pass to buildApp:
    apiRoutes: [(app) => registerAuthRoutes(app, { cfg, db, idp })],
```

- [ ] **Step 4: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test 2>&1 | tail -4 && npm -w services/outreach-api run typecheck && echo OK
git add services/outreach-api
git commit -m "feat(outreach-api): WorkOS sign-in routes with cookie handoff, /auth/me, logout, and tenant-scoped request context"
```
Expected: outreach-api 9 files / 46 tests (34 after Task 5's fix wave + 5 scope + 7 auth).

---

### Task 7: Tenant provisioning and super-admin tenant routes + CLI scripts (TDD)

**Files:**
- Create: `services/outreach-api/src/tenancy/provision.ts`, `provision.test.ts`, `services/outreach-api/src/routes/admin-tenants.ts`, `admin-tenants.test.ts`, `services/outreach-api/scripts/provision-tenant.ts`, `services/outreach-api/scripts/link-tenant-workos.ts`, `services/outreach-api/scripts/grant-super-admin.ts`, `services/outreach-api/scripts/_cli.ts`
- Modify: `services/outreach-api/src/server.ts`, `services/outreach-api/src/test/harness.ts` (register the plugin)

**Interfaces:**
- `provisionTenant(deps: { db; idp; log }, input: ProvisionTenantRequest) → Promise<{ tenant: Organization; inviteId: string }>`: `createTenant` → `idp.createOrganization({ name, externalId: org.id })` → `update organizations set workos_org_id` → `idp.invite({ email: adminEmail, organizationId, role: 'admin' })`. If anything after `createTenant` fails, alert `provisioning_failed` and rethrow (the tenant exists unlinked; `linkTenantToWorkos` repairs it).
- `linkTenantToWorkos(deps, orgId: string, adminEmail: string) → Promise<{ tenant: Organization; inviteId: string }>`: reuses an existing `workosOrgId` or creates one, then invites the admin. Idempotent.
- Routes (super admin only): `GET /admin/tenants` → `TenantsResponse`; `POST /admin/tenants` (ProvisionTenantRequest) → 201 `{ tenant, inviteId }`; `POST /admin/tenants/:id/link-workos` (LinkTenantWorkosRequest) → 200 `{ tenant, inviteId }`. Non-super-admins get 403 `SUPER_ADMIN_ONLY`.
- Scripts run with `npx tsx services/outreach-api/scripts/<name>.ts --flag value` and need the same env as the service (use `railway run -s outreach-api -- npx tsx …` in production).

- [ ] **Step 1: Failing tests**

`services/outreach-api/src/tenancy/provision.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { fakeDb } from '../test/harness.js';
import { linkTenantToWorkos, provisionTenant } from './provision.js';

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

describe('provisionTenant', () => {
  it('creates the tenant, a WorkOS organization tagged with our org id, links it, and invites the admin', async () => {
    const { db, writes } = fakeDb({ organizations: [] });
    const idp = new FakeIdentityProvider();
    const out = await provisionTenant({ db, idp, log }, { name: 'Acme Buyers', timezone: 'America/Chicago', adminEmail: 'owner@acme.com' });
    expect(writes.map((w) => w.op)).toEqual(['insert', 'insert', 'insert', 'update']);
    expect(writes[0]).toMatchObject({ table: schema.organizations, values: { name: 'Acme Buyers', slug: 'acme-buyers', timezone: 'America/Chicago' } });
    expect(writes[3]).toMatchObject({ table: schema.organizations, values: { workosOrgId: 'org_fake_1' } });
    expect(out.tenant.workosOrgId).toBe('org_fake_1');
    const invites = await idp.listInvites('org_fake_1');
    expect(invites).toEqual([expect.objectContaining({ email: 'owner@acme.com', role: 'admin', state: 'pending' })]);
    expect(out.inviteId).toBe(invites[0]!.id);
  });
  it('alerts and rethrows when the provider fails after the tenant row exists', async () => {
    const { db } = fakeDb({ organizations: [] });
    const idp = new FakeIdentityProvider();
    idp.createOrganization = async () => { throw new Error('workos down'); };
    await expect(provisionTenant({ db, idp, log }, { name: 'Acme', timezone: 'UTC', adminEmail: 'o@a.com' })).rejects.toThrow('workos down');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ alert: 'provisioning_failed' }), expect.any(String));
  });
});

describe('linkTenantToWorkos', () => {
  const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
  it('creates and stores a WorkOS organization for an unlinked tenant, then invites the admin', async () => {
    const { db, writes } = fakeDb({ organizations: [org] });
    const idp = new FakeIdentityProvider();
    const out = await linkTenantToWorkos({ db, idp, log }, 'O1', 'you@gghomes.com');
    expect(writes).toEqual([expect.objectContaining({ op: 'update', values: { workosOrgId: 'org_fake_1' } })]);
    expect(out.tenant.workosOrgId).toBe('org_fake_1');
    expect((await idp.listInvites('org_fake_1'))[0]).toMatchObject({ email: 'you@gghomes.com', role: 'admin' });
  });
  it('reuses an existing link and only sends the invite', async () => {
    const { db, writes } = fakeDb({ organizations: [{ ...org, workosOrgId: 'org_existing' }] });
    const idp = new FakeIdentityProvider();
    await linkTenantToWorkos({ db, idp, log }, 'O1', 'you@gghomes.com');
    expect(writes).toEqual([]);
    expect(await idp.listInvites('org_existing')).toHaveLength(1);
  });
  it('throws for an unknown tenant', async () => {
    const { db } = fakeDb({ organizations: [] });
    await expect(linkTenantToWorkos({ db, idp: new FakeIdentityProvider(), log }, 'nope', 'a@b.co')).rejects.toThrow('Unknown tenant');
  });
});
```

`services/outreach-api/src/routes/admin-tenants.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { buildTestApp, fakeDb, testConfig } from '../test/harness.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const cfg = testConfig();
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const superAdmin = { userId: 'U1', orgId: 'O1', email: 'me@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: true };
let app: FastifyInstance;
afterEach(async () => { await app.close(); });
beforeEach(async () => {
  state.session = superAdmin;
  app = await buildTestApp({ cfg, db: fakeDb({ organizations: [org] }).db, idp: new FakeIdentityProvider() });
});
const auth = { authorization: 'Bearer t' };

describe('admin tenant routes', () => {
  it('lists tenants for a super admin and refuses everyone else', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/admin/tenants', headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tenants: [expect.objectContaining({ id: 'O1', slug: 'gg-homes', workosLinked: false })] });
    state.session = { ...superAdmin, isSuperAdmin: false };
    const no = await app.inject({ method: 'GET', url: '/api/admin/tenants', headers: auth });
    expect(no.statusCode).toBe(403);
    expect(no.json()).toMatchObject({ code: 'SUPER_ADMIN_ONLY' });
  });
  it('provisions a tenant (201) and validates the body', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/admin/tenants', headers: auth, payload: { name: 'Acme Buyers', adminEmail: 'Owner@Acme.com' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ tenant: { name: 'Acme Buyers', slug: 'acme-buyers', workosLinked: true }, inviteId: expect.any(String) });
    const bad = await app.inject({ method: 'POST', url: '/api/admin/tenants', headers: auth, payload: { name: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'VALIDATION' });
  });
  it('links an existing tenant to WorkOS and invites the admin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/tenants/O1/link-workos', headers: auth, payload: { adminEmail: 'you@gg.co' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tenant: { id: 'O1', workosLinked: true }, inviteId: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test -- src/tenancy/provision src/routes/admin-tenants 2>&1 | tail -4
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`services/outreach-api/src/tenancy/provision.ts`:
```ts
import { eq } from 'drizzle-orm';
import { createTenant } from '@cti/auth';
import type { ProvisionTenantRequest } from '@cti/contracts';
import { schema, type Db, type Organization } from '@cti/db';
import { dispatchAlert } from '../alerts.js';
import type { IdentityProvider } from '../auth/identity-provider.js';

export interface ProvisionDeps {
  db: Db;
  idp: IdentityProvider;
  log: { error: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
}
export interface ProvisionResult {
  tenant: Organization;
  inviteId: string;
}

async function ensureWorkosOrg(deps: ProvisionDeps, tenant: Organization): Promise<Organization> {
  if (tenant.workosOrgId) return tenant;
  const created = await deps.idp.createOrganization({ name: tenant.name, externalId: tenant.id });
  await deps.db.update(schema.organizations).set({ workosOrgId: created.id }).where(eq(schema.organizations.id, tenant.id));
  return { ...tenant, workosOrgId: created.id };
}

async function inviteAdmin(deps: ProvisionDeps, tenant: Organization, adminEmail: string): Promise<string> {
  const invite = await deps.idp.invite({ email: adminEmail, organizationId: tenant.workosOrgId!, role: 'admin' });
  deps.log.info({ orgId: tenant.id, inviteId: invite.id }, 'tenant admin invited');
  return invite.id;
}

/** New tenant: our org + AI Agent + default campaign (createTenant), then the WorkOS org and the admin invite. */
export async function provisionTenant(deps: ProvisionDeps, input: ProvisionTenantRequest): Promise<ProvisionResult> {
  const { org } = await createTenant(deps.db, { name: input.name, slug: input.slug, timezone: input.timezone });
  try {
    const tenant = await ensureWorkosOrg(deps, org);
    const inviteId = await inviteAdmin(deps, tenant, input.adminEmail);
    return { tenant, inviteId };
  } catch (err) {
    await dispatchAlert(deps.log, {
      kind: 'provisioning_failed',
      severity: 'warning',
      orgId: org.id,
      message: `Tenant ${org.slug} created but WorkOS link/invite failed: ${(err as Error).message}. Repair with link-tenant-workos.`,
      context: { adminEmail: input.adminEmail },
    });
    throw err;
  }
}

/** Existing tenant (e.g. one created by Salesforce login): create/reuse the WorkOS org and invite an admin. */
export async function linkTenantToWorkos(deps: ProvisionDeps, orgId: string, adminEmail: string): Promise<ProvisionResult> {
  const found = await deps.db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
  if (!found || found.id !== orgId) throw new Error(`Unknown tenant ${orgId}`);
  const tenant = await ensureWorkosOrg(deps, found);
  const inviteId = await inviteAdmin(deps, tenant, adminEmail);
  return { tenant, inviteId };
}
```

`services/outreach-api/src/routes/admin-tenants.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LinkTenantWorkosRequest, ProvisionTenantRequest } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { sendError } from '../http/errors.js';
import { linkTenantToWorkos, provisionTenant } from '../tenancy/provision.js';
import { requireContext, toTenantDto } from '../tenancy/scope.js';

export interface AdminTenantDeps {
  db: Db;
  idp: IdentityProvider | null;
}

export async function registerAdminTenantRoutes(app: FastifyInstance, deps: AdminTenantDeps): Promise<void> {
  const { db } = deps;
  const superAdminOnly = async (req: Parameters<typeof requireContext>[1], reply: Parameters<typeof requireContext>[2]) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return null;
    if (!ctx.session.isSuperAdmin) {
      sendError(reply, 403, 'SUPER_ADMIN_ONLY', 'Platform staff only');
      return null;
    }
    return ctx;
  };
  const idpOr503 = (reply: Parameters<typeof requireContext>[2]) => {
    if (!deps.idp) sendError(reply, 503, 'SIGN_IN_DISABLED', 'WorkOS is not configured on this server');
    return deps.idp;
  };

  app.get('/admin/tenants', async (req, reply) => {
    if (!(await superAdminOnly(req, reply))) return;
    const rows = await db.query.organizations.findMany({});
    return { tenants: rows.map(toTenantDto) };
  });

  app.post('/admin/tenants', async (req, reply) => {
    if (!(await superAdminOnly(req, reply))) return;
    const idp = idpOr503(reply);
    if (!idp) return;
    const body = ProvisionTenantRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid tenant request', body.error.flatten());
    const out = await provisionTenant({ db, idp, log: req.log }, body.data);
    return reply.code(201).send({ tenant: toTenantDto(out.tenant), inviteId: out.inviteId });
  });

  app.post('/admin/tenants/:id/link-workos', async (req, reply) => {
    if (!(await superAdminOnly(req, reply))) return;
    const idp = idpOr503(reply);
    if (!idp) return;
    const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const body = LinkTenantWorkosRequest.safeParse(req.body);
    if (!params.success || !body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid link request');
    try {
      const out = await linkTenantToWorkos({ db, idp, log: req.log }, params.data.id, body.data.adminEmail);
      return { tenant: toTenantDto(out.tenant), inviteId: out.inviteId };
    } catch (err) {
      if ((err as Error).message.startsWith('Unknown tenant')) return sendError(reply, 404, 'NOT_FOUND', 'Unknown tenant');
      throw err;
    }
  });
}
```
Register it in `buildTestApp` (`(app) => registerAdminTenantRoutes(app, { db: deps.db, idp: deps.idp })`) and in `server.ts`'s `apiRoutes`.

Scripts — `services/outreach-api/scripts/_cli.ts`:
```ts
import 'dotenv/config';
import { getDb } from '@cti/db';
import { WorkosIdentityProvider } from '../src/auth/workos-provider.js';
import { loadConfig } from '../src/config.js';

/** `--name value` pairs → object; exits with usage when a required flag is missing. */
export function flags(required: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    const v = argv[i + 1];
    if (k && v !== undefined) out[k] = v;
  }
  const missing = required.filter((r) => !out[r]);
  if (missing.length) {
    console.error(`missing flags: ${missing.map((m) => `--${m}`).join(' ')}`);
    process.exit(2);
  }
  return out;
}

export function deps() {
  const cfg = loadConfig();
  if (!cfg.workosEnabled) throw new Error('WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI must be set');
  const idp = new WorkosIdentityProvider({ apiKey: cfg.WORKOS_API_KEY!, clientId: cfg.WORKOS_CLIENT_ID!, redirectUri: cfg.WORKOS_REDIRECT_URI! });
  return { db: getDb(), idp, log: console };
}
```
`scripts/provision-tenant.ts`:
```ts
import { provisionTenant } from '../src/tenancy/provision.js';
import { deps, flags } from './_cli.js';
const f = flags(['name', 'admin-email']);
const out = await provisionTenant(deps(), { name: f.name!, slug: f.slug, timezone: f.timezone ?? 'America/Los_Angeles', adminEmail: f['admin-email']!.toLowerCase() });
console.log(JSON.stringify({ tenantId: out.tenant.id, slug: out.tenant.slug, workosOrgId: out.tenant.workosOrgId, inviteId: out.inviteId }, null, 2));
process.exit(0);
```
`scripts/link-tenant-workos.ts`:
```ts
import { eq } from 'drizzle-orm';
import { schema } from '@cti/db';
import { linkTenantToWorkos } from '../src/tenancy/provision.js';
import { deps, flags } from './_cli.js';
const f = flags(['org-slug', 'admin-email']);
const d = deps();
const org = await d.db.query.organizations.findFirst({ where: eq(schema.organizations.slug, f['org-slug']!) });
if (!org) { console.error(`no tenant with slug ${f['org-slug']}`); process.exit(1); }
const out = await linkTenantToWorkos(d, org.id, f['admin-email']!.toLowerCase());
console.log(JSON.stringify({ tenantId: out.tenant.id, workosOrgId: out.tenant.workosOrgId, inviteId: out.inviteId }, null, 2));
process.exit(0);
```
`scripts/grant-super-admin.ts`:
```ts
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { flags } from './_cli.js';
const f = flags(['email', 'org-slug']);
const db = getDb();
const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.slug, f['org-slug']!) });
if (!org) { console.error('no such tenant'); process.exit(1); }
const rows = await db.update(schema.users).set({ isSuperAdmin: true, isAdmin: true })
  .where(and(eq(schema.users.orgId, org.id), eq(schema.users.email, f.email!.toLowerCase()), eq(schema.users.kind, 'human')))
  .returning({ id: schema.users.id });
console.log(rows.length ? `granted super admin to ${f.email} (${rows[0]!.id})` : `no human user ${f.email} in ${f['org-slug']}`);
process.exit(rows.length ? 0 : 1);
```
Scripts are outside `src/` (not compiled by `tsc`); add `"include": ["src/**/*", "scripts/**/*"]` to `services/outreach-api/tsconfig.json` ONLY if you also set `"rootDir": "."` — do not; instead typecheck scripts with `npx tsc --noEmit -p services/outreach-api/tsconfig.scripts.json` where `tsconfig.scripts.json` is `{ "extends": "./tsconfig.json", "compilerOptions": { "rootDir": ".", "noEmit": true }, "include": ["src/**/*", "scripts/**/*"] }`, and add `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.scripts.json"` to the service's scripts.

- [ ] **Step 4: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test 2>&1 | tail -4 && npm -w services/outreach-api run typecheck && echo OK
git add services/outreach-api
git commit -m "feat(outreach-api): tenant provisioning and WorkOS linking — super-admin routes and CLI scripts"
```
Expected: outreach-api 10 files / 41 tests.

---

### Task 8: Team routes — roster, invites, admin flag (TDD)

**Files:**
- Create: `services/outreach-api/src/routes/team.ts`, `services/outreach-api/src/routes/team.test.ts`
- Modify: `services/outreach-api/src/server.ts`, `services/outreach-api/src/test/harness.ts` (register the plugin; extend `fakeDb` with a `select` chain that returns `fx.users`)

**Interfaces:**
- `GET /api/team` → `TeamResponse` (humans in the effective tenant; `signedIn = externalAuthId != null`). Any signed-in user.
- `GET /api/team/invites` → `InvitesResponse` (admin; 409 `WORKOS_NOT_LINKED` when the tenant has no `workosOrgId`; 503 `SIGN_IN_DISABLED` when no provider).
- `POST /api/team/invites` (`InviteRequest`) → 201 `Invite` (admin; same 409/503 rules; `inviterExternalId` = the caller's `externalAuthId` when known).
- `PATCH /api/team/:userId` (`UpdateTeamMemberRequest`) → `TeamMember` (admin; 400 `CANNOT_CHANGE_SELF` when targeting yourself; 404 `NOT_FOUND` when the id is not a human in this tenant).

- [ ] **Step 1: Failing tests**

`services/outreach-api/src/routes/team.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { buildTestApp, fakeDb, testConfig } from '../test/harness.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const cfg = testConfig();
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
const admin = { userId: 'U1', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const users = [
  { id: 'U1', orgId: 'O1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, externalAuthId: 'wos_1', kind: 'human' },
  { id: 'U2', orgId: 'O1', email: 'rep@gg.co', displayName: 'Rep', isAdmin: false, powerDialerEnabled: true, externalAuthId: null, kind: 'human' },
];
let app: FastifyInstance;
let idp: FakeIdentityProvider;
const auth = { authorization: 'Bearer t' };

beforeEach(async () => {
  state.session = admin;
  idp = new FakeIdentityProvider();
  app = await buildTestApp({ cfg, db: fakeDb({ organizations: [org], users }).db, idp });
});
afterEach(async () => { await app.close(); });

describe('team routes', () => {
  it('lists human members with a signedIn flag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/team', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ members: [
      { id: 'U1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, signedIn: true },
      { id: 'U2', email: 'rep@gg.co', displayName: 'Rep', isAdmin: false, powerDialerEnabled: true, signedIn: false },
    ] });
  });
  it('invites are admin-only, validated, and go through the provider with the tenant org', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'New@GG.co', role: 'admin' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ email: 'new@gg.co', role: 'admin', state: 'pending' });
    const list = await app.inject({ method: 'GET', url: '/api/team/invites', headers: auth });
    expect(list.json().invites).toHaveLength(1);
    const bad = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'nope' } });
    expect(bad.statusCode).toBe(400);
    state.session = { ...admin, isAdmin: false };
    const denied = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'a@b.co' } });
    expect(denied.statusCode).toBe(403);
  });
  it('409 when the tenant is not linked to WorkOS', async () => {
    await app.close();
    app = await buildTestApp({ cfg, db: fakeDb({ organizations: [{ ...org, workosOrgId: null }], users }).db, idp });
    const res = await app.inject({ method: 'GET', url: '/api/team/invites', headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'WORKOS_NOT_LINKED' });
  });
  it('toggles the admin flag on another human, never on yourself', async () => {
    const ok = await app.inject({ method: 'PATCH', url: '/api/team/U2', headers: auth, payload: { isAdmin: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: 'U2', isAdmin: true });
    const self = await app.inject({ method: 'PATCH', url: '/api/team/U1', headers: auth, payload: { isAdmin: false } });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toMatchObject({ code: 'CANNOT_CHANGE_SELF' });
  });
});
```

Extend `fakeDb` in `services/outreach-api/src/test/harness.ts`: make `select()` return a chain whose `from()`/`where()`/`orderBy()` return the chain and which resolves to `fx.users ?? []` (`then(resolve) { resolve(rows) }`), and make `update(...).set(v).where()` return `{ rowCount: 1, rows: [{ ...fx.users?.[1], ...v }] }` via a `.returning()` method: `where: () => ({ returning: async () => [{ ...(fx.users?.find(...) ?? {}), ...values }] })` — implement `returning()` to return the first fixture user whose id is not the session's (U2) merged with `values`; also keep the awaitable form used by earlier tasks by making the returned object thenable. Keep the harness under 120 lines.

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test -- src/routes/team 2>&1 | tail -4
```
Expected: FAIL — cannot resolve `./team.js`.

- [ ] **Step 3: Implement**

`services/outreach-api/src/routes/team.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { humanUserById, humanUsersInOrg } from '@cti/auth';
import { InviteRequest, UpdateTeamMemberRequest, type TeamMember } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext, type RequestContext } from '../tenancy/scope.js';

export interface TeamRouteDeps {
  db: Db;
  idp: IdentityProvider | null;
}

type UserRow = { id: string; email: string; displayName: string | null; isAdmin: boolean; powerDialerEnabled: boolean; externalAuthId: string | null };

function toMember(u: UserRow): TeamMember {
  return { id: u.id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin, powerDialerEnabled: u.powerDialerEnabled, signedIn: u.externalAuthId != null };
}

function linkedOrgId(ctx: RequestContext, deps: TeamRouteDeps, reply: FastifyReply): { idp: IdentityProvider; workosOrgId: string } | null {
  if (!deps.idp) {
    sendError(reply, 503, 'SIGN_IN_DISABLED', 'WorkOS is not configured on this server');
    return null;
  }
  if (!ctx.tenant.workosOrgId) {
    sendError(reply, 409, 'WORKOS_NOT_LINKED', 'This tenant is not linked to WorkOS yet');
    return null;
  }
  return { idp: deps.idp, workosOrgId: ctx.tenant.workosOrgId };
}

export async function registerTeamRoutes(app: FastifyInstance, deps: TeamRouteDeps): Promise<void> {
  const { db } = deps;

  app.get('/team', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, isAdmin: schema.users.isAdmin, powerDialerEnabled: schema.users.powerDialerEnabled, externalAuthId: schema.users.externalAuthId })
      .from(schema.users)
      .where(humanUsersInOrg(ctx.orgId))
      .orderBy(schema.users.email);
    return { members: rows.map(toMember) };
  });

  app.get('/team/invites', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const linked = linkedOrgId(ctx, deps, reply);
    if (!linked) return;
    return { invites: await linked.idp.listInvites(linked.workosOrgId) };
  });

  app.post('/team/invites', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const linked = linkedOrgId(ctx, deps, reply);
    if (!linked) return;
    const body = InviteRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid invite', body.error.flatten());
    const inviter = await db.query.users.findFirst({ where: eq(schema.users.id, ctx.session.userId), columns: { externalAuthId: true } });
    const invite = await linked.idp.invite({
      email: body.data.email,
      organizationId: linked.workosOrgId,
      role: body.data.role,
      ...(inviter?.externalAuthId ? { inviterExternalId: inviter.externalAuthId } : {}),
    });
    return reply.code(201).send(invite);
  });

  app.patch('/team/:userId', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const params = z.object({ userId: z.string().min(1) }).safeParse(req.params);
    const body = UpdateTeamMemberRequest.safeParse(req.body);
    if (!params.success || !body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid update');
    if (params.data.userId === ctx.session.userId) return sendError(reply, 400, 'CANNOT_CHANGE_SELF', 'You cannot change your own admin flag');
    const [updated] = await db
      .update(schema.users)
      .set({ isAdmin: body.data.isAdmin })
      .where(humanUserById(ctx.orgId, params.data.userId))
      .returning({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, isAdmin: schema.users.isAdmin, powerDialerEnabled: schema.users.powerDialerEnabled, externalAuthId: schema.users.externalAuthId });
    if (!updated) return sendError(reply, 404, 'NOT_FOUND', 'No such team member');
    return toMember(updated);
  });
}
```
Register in `buildTestApp` and `server.ts` (`(app) => registerTeamRoutes(app, { db, idp })`).

- [ ] **Step 4: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/outreach-api run test 2>&1 | tail -4 && npm -w services/outreach-api run typecheck && echo OK
git add services/outreach-api
git commit -m "feat(outreach-api): team roster, WorkOS invites, and admin-flag routes"
```
Expected: outreach-api 11 files / 45 tests.

---

### Task 9: `apps/outreach-web` — Vite + React + TanStack Router/Query + Tailwind + shadcn skeleton with sign-in, guard, dashboard, team, tenant switcher

**Files:**
- Create: `apps/outreach-web/package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `components.json` (written by shadcn init), `src/index.css`, `src/main.tsx`, `src/lib/api.ts`, `src/lib/api.test.ts`, `src/lib/auth.tsx`, `src/lib/guard.ts`, `src/lib/guard.test.ts`, `src/lib/utils.ts` (shadcn), `src/components/ui/*` (shadcn), `src/components/app-shell.tsx`, `src/components/tenant-switcher.tsx`, `src/components/team-page.tsx`, `src/components/team-page.test.tsx`, `src/components/sign-in-page.tsx`, `src/routes/__root.tsx`, `src/routes/sign-in.tsx`, `src/routes/auth.callback.tsx`, `src/routes/_authenticated.tsx`, `src/routes/_authenticated/index.tsx`, `src/routes/_authenticated/team.tsx`, `src/test/setup.ts`, `src/test/render.tsx`
- Modify: root `Dockerfile` (COPY `apps/outreach-web/package.json`), root `package.json` (`dev:web:outreach` script)

**Interfaces:**
- `api(path, schema, init?)` / `apiEmpty(path, init?)` with the bearer and `X-Org-Id` from `apiSession`; `ApiRequestError { status, code }`.
- `AuthProvider` / `useAuth()` exposing `{ user, tenant, activeTenant, isAuthenticated, startSignIn(returnTo?), completeHandoff(), signOut(), switchTenant(tenant) }`.
- `authGuard(isAuthenticated, href)` → `null` or a redirect target `{ to: '/sign-in', search: { returnTo } }` (pure; used by the `_authenticated` layout's `beforeLoad`).
- Pages consume `@cti/contracts` schemas for every response.

- [ ] **Step 1: Scaffold the workspace**

`apps/outreach-web/package.json`:
```json
{
  "name": "@cti/outreach-web",
  "version": "0.1.0",
  "private": true,
  "description": "Outreach product web app (served by outreach-api)",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@cti/contracts": "*",
    "@tanstack/react-query": "^5.102.8",
    "@tanstack/react-router": "^1.170.32",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@tanstack/router-plugin": "^1.168.35",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.5.2",
    "@types/node": "^20.17.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^30.0.1",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^4.1.8"
  }
}
```
`apps/outreach-web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src/**/*", "vite.config.ts", "vitest.config.ts"]
}
```
`apps/outreach-web/vite.config.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

const API = 'http://localhost:4100';

export default defineConfig({
  // Router plugin must run before the React plugin.
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: { port: 5175, strictPort: true, proxy: { '/api': API, '/healthz': API, '/readyz': API } },
});
```
`apps/outreach-web/vitest.config.ts`:
```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], css: false },
}));
```
`apps/outreach-web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Outreach</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
`apps/outreach-web/src/index.css`: `@import "tailwindcss";` (shadcn init appends its theme variables below this line).
`apps/outreach-web/src/test/setup.ts`: `import '@testing-library/jest-dom/vitest';`

```bash
cd /Users/cdrshepard/spam-res-cti && npm install 2>&1 | tail -1
cd apps/outreach-web && npx shadcn@latest init -y -d --base-color neutral 2>&1 | tail -5 && npx shadcn@latest add -y button card input label table badge select separator dropdown-menu 2>&1 | tail -3 && ls src/components/ui && cat components.json
```
Expected: `components.json` exists with `"tailwind": { "css": "src/index.css", … }` and `"aliases": { "components": "@/components", "utils": "@/lib/utils", … }`; `src/lib/utils.ts` exports `cn`; the nine components exist. shadcn adds `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and Radix packages to `package.json` — keep whatever versions it installs. If init asks about the framework, answer Vite; if it rewrites `vite.config.ts`/`tsconfig.json` aliases, keep the files above and re-apply only the alias if it removed it.

Root `Dockerfile` (cti-api image): add `COPY apps/outreach-web/package.json apps/outreach-web/package.json`. Root `package.json`: add `"dev:web:outreach": "npm --workspace apps/outreach-web run dev"`.

- [ ] **Step 2: Failing tests**

`apps/outreach-web/src/lib/api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, apiEmpty, ApiRequestError, apiSession } from './api';

afterEach(() => { vi.unstubAllGlobals(); apiSession.set(null); });

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api', () => {
  it('sends the bearer and X-Org-Id and parses the response', async () => {
    apiSession.set({ token: 'tok', orgId: 'O2' });
    const f = stubFetch(200, { ok: true });
    await expect(api('/api/x', z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
    const headers = new Headers((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('x-org-id')).toBe('O2');
  });
  it('turns an error envelope into ApiRequestError with the code', async () => {
    stubFetch(403, { error: 'Admin access required', code: 'ADMIN_ONLY', requestId: 'r1' });
    await expect(api('/api/x', z.any())).rejects.toMatchObject({ name: 'ApiRequestError', status: 403, code: 'ADMIN_ONLY' });
  });
  it('apiEmpty accepts 204', async () => {
    stubFetch(204, undefined);
    await expect(apiEmpty('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});
```
`apps/outreach-web/src/lib/guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { authGuard } from './guard';

describe('authGuard', () => {
  it('lets authenticated users through', () => {
    expect(authGuard(true, '/team')).toBeNull();
  });
  it('redirects anonymous users to sign-in with the return path', () => {
    expect(authGuard(false, '/team?x=1')).toEqual({ to: '/sign-in', search: { returnTo: '/team?x=1' } });
  });
});
```
`apps/outreach-web/src/components/team-page.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { TeamPage } from './team-page';

afterEach(() => vi.unstubAllGlobals());

function stubApi(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url}`;
    const body = routes[key];
    if (body === undefined) return new Response(JSON.stringify({ error: 'nf', code: 'NOT_FOUND' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

describe('TeamPage', () => {
  it('renders members with admin badges and pending invites', async () => {
    stubApi({
      'GET /api/team': { members: [{ id: 'U1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, signedIn: true }, { id: 'U2', email: 'rep@gg.co', displayName: null, isAdmin: false, powerDialerEnabled: true, signedIn: false }] },
      'GET /api/team/invites': { invites: [{ id: 'i1', email: 'new@gg.co', role: 'member', state: 'pending', expiresAt: '2026-09-11T00:00:00Z' }] },
    });
    renderWithProviders(<TeamPage />, { isAdmin: true });
    expect(await screen.findByText('admin@gg.co')).toBeInTheDocument();
    expect(screen.getByText('rep@gg.co')).toBeInTheDocument();
    expect(screen.getAllByText('Admin')).not.toHaveLength(0);
    expect(await screen.findByText('new@gg.co')).toBeInTheDocument();
  });
  it('submits an invite and refreshes the list', async () => {
    const calls = stubApi({
      'GET /api/team': { members: [] },
      'GET /api/team/invites': { invites: [] },
      'POST /api/team/invites': { id: 'i2', email: 'x@gg.co', role: 'member', state: 'pending', expiresAt: '2026-09-11T00:00:00Z' },
    });
    renderWithProviders(<TeamPage />, { isAdmin: true });
    await screen.findByText(/no pending invites/i);
    await userEvent.type(screen.getByLabelText(/email/i), 'x@gg.co');
    await userEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/team/invites')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'x@gg.co', role: 'member' });
  });
});
```
`apps/outreach-web/src/test/render.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AuthContext, type AuthContextValue } from '../lib/auth';

export function renderWithProviders(ui: ReactElement, opts: { isAdmin?: boolean; isSuperAdmin?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tenant = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' as const };
  const auth: AuthContextValue = {
    user: { userId: 'U1', orgId: 'O1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: opts.isAdmin ?? false, isSuperAdmin: opts.isSuperAdmin ?? false, kind: 'human' },
    tenant,
    activeTenant: tenant,
    isAuthenticated: true,
    startSignIn: () => {},
    completeHandoff: async () => true,
    signOut: async () => {},
    switchTenant: () => {},
  };
  return render(<QueryClientProvider client={qc}><AuthContext.Provider value={auth}>{ui}</AuthContext.Provider></QueryClientProvider>);
}
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w apps/outreach-web run test 2>&1 | tail -5
```
Expected: FAIL — `./api`, `./guard`, `./team-page`, `../lib/auth` not found.

- [ ] **Step 4: Implement the library**

`apps/outreach-web/src/lib/api.ts`:
```ts
import { ApiError } from '@cti/contracts';
import type { z } from 'zod';

export class ApiRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ApiSession { token: string; orgId?: string }
let current: ApiSession | null = null;
/** In-memory bearer + the super admin's selected tenant. Cleared on reload by design (see spec §4.3). */
export const apiSession = {
  get: (): ApiSession | null => current,
  set: (s: ApiSession | null): void => { current = s; },
};

async function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (current?.token) headers.set('Authorization', `Bearer ${current.token}`);
  if (current?.orgId) headers.set('X-Org-Id', current.orgId);
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const parsed = ApiError.safeParse(body);
    throw new ApiRequestError(res.status, parsed.success ? parsed.data.code : 'UNKNOWN', parsed.success ? parsed.data.error : `HTTP ${res.status}`);
  }
  return res;
}

export async function api<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init);
  return schema.parse(await res.json());
}

export async function apiEmpty(path: string, init: RequestInit = {}): Promise<void> {
  await request(path, init);
}

export const json = (body: unknown): string => JSON.stringify(body);
```
`apps/outreach-web/src/lib/guard.ts`:
```ts
/** Pure guard used by the _authenticated layout's beforeLoad; returns a redirect target or null. */
export function authGuard(isAuthenticated: boolean, href: string): { to: '/sign-in'; search: { returnTo: string } } | null {
  return isAuthenticated ? null : { to: '/sign-in', search: { returnTo: href } };
}
```
`apps/outreach-web/src/lib/auth.tsx`:
```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { SessionResponse, type SessionUser, type Tenant } from '@cti/contracts';
import { api, apiEmpty, apiSession } from './api';

export interface AuthContextValue {
  user: SessionUser | null;
  /** The tenant the session belongs to. */
  tenant: Tenant | null;
  /** The tenant requests act on (differs from `tenant` only for super admins who switched). */
  activeTenant: Tenant | null;
  isAuthenticated: boolean;
  startSignIn: (returnTo?: string) => void;
  completeHandoff: () => Promise<boolean>;
  signOut: () => Promise<void>;
  switchTenant: (tenant: Tenant) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [activeTenant, setActiveTenant] = useState<Tenant | null>(null);

  const startSignIn = useCallback((returnTo?: string) => {
    const q = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
    window.location.assign(`/api/auth/workos/start${q}`);
  }, []);

  const completeHandoff = useCallback(async () => {
    try {
      const s = await api('/api/auth/session', SessionResponse);
      apiSession.set({ token: s.token });
      setUser(s.user);
      setTenant(s.tenant);
      setActiveTenant(s.tenant);
      return true;
    } catch {
      return false;
    }
  }, []);

  const signOut = useCallback(async () => {
    try { await apiEmpty('/api/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
    apiSession.set(null);
    setUser(null); setTenant(null); setActiveTenant(null);
  }, []);

  const switchTenant = useCallback((t: Tenant) => {
    const s = apiSession.get();
    if (s) apiSession.set({ token: s.token, orgId: t.id === tenant?.id ? undefined : t.id });
    setActiveTenant(t);
  }, [tenant]);

  const value = useMemo<AuthContextValue>(() => ({ user, tenant, activeTenant, isAuthenticated: user != null, startSignIn, completeHandoff, signOut, switchTenant }), [user, tenant, activeTenant, startSignIn, completeHandoff, signOut, switchTenant]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
```

- [ ] **Step 5: Components and routes**

`apps/outreach-web/src/components/sign-in-page.tsx`:
```tsx
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

const MESSAGES: Record<string, string> = {
  no_tenant: 'Your account is not a member of a workspace yet. Ask your admin for an invite.',
  tenant_suspended: 'This workspace is suspended. Contact support.',
  invalid_code: 'That sign-in link expired. Try again.',
  access_denied: 'Sign-in was cancelled.',
  handoff_failed: 'We could not finish signing you in. Try again.',
  forbidden: 'This account cannot sign in.',
  server_error: 'Something went wrong on our side. Try again in a minute.',
};

export function SignInPage({ error, returnTo }: { error?: string; returnTo?: string }) {
  const auth = useAuth();
  return (
    <main className="min-h-screen grid place-items-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Outreach</CardTitle>
          <CardDescription>Sign in with your work email.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p role="alert" className="text-sm text-destructive">{MESSAGES[error] ?? 'Sign-in failed. Try again.'}</p>}
          <Button className="w-full" onClick={() => auth.startSignIn(returnTo)}>Continue</Button>
        </CardContent>
      </Card>
    </main>
  );
}
```
`apps/outreach-web/src/components/tenant-switcher.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { TenantsResponse } from '@cti/contracts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Super admins only: choose which tenant the app acts on (sent as X-Org-Id). */
export function TenantSwitcher() {
  const auth = useAuth();
  const tenants = useQuery({ queryKey: ['admin', 'tenants'], queryFn: () => api('/api/admin/tenants', TenantsResponse), enabled: auth.user?.isSuperAdmin === true });
  if (!auth.user?.isSuperAdmin) return <span className="text-sm text-muted-foreground">{auth.activeTenant?.name}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="sm">{auth.activeTenant?.name ?? 'Choose tenant'}</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(tenants.data?.tenants ?? []).map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => auth.switchTenant(t)}>{t.name} <span className="ml-2 text-xs text-muted-foreground">{t.slug}</span></DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```
`apps/outreach-web/src/components/app-shell.tsx`:
```tsx
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/lib/auth';
import { TenantSwitcher } from './tenant-switcher';

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-4 px-6 py-3">
        <Link to="/" className="font-semibold">Outreach</Link>
        <nav className="flex gap-3 text-sm">
          <Link to="/" activeProps={{ className: 'font-medium' }}>Dashboard</Link>
          <Link to="/team" activeProps={{ className: 'font-medium' }}>Team</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <TenantSwitcher />
          <span className="text-sm text-muted-foreground">{auth.user?.email}</span>
          <Button variant="ghost" size="sm" onClick={() => void auth.signOut().then(() => window.location.assign('/sign-in'))}>Sign out</Button>
        </div>
      </header>
      <Separator />
      <main className="mx-auto max-w-5xl p-6">{children}</main>
    </div>
  );
}
```
`apps/outreach-web/src/components/team-page.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Invite, InvitesResponse, TeamMember, TeamResponse, type RoleSlug } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiRequestError, json } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export function TeamPage() {
  const auth = useAuth();
  const qc = useQueryClient();
  const isAdmin = auth.user?.isAdmin || auth.user?.isSuperAdmin;
  const team = useQuery({ queryKey: ['team'], queryFn: () => api('/api/team', TeamResponse) });
  const invites = useQuery({ queryKey: ['team', 'invites'], queryFn: () => api('/api/team/invites', InvitesResponse), enabled: Boolean(isAdmin) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleSlug>('member');
  const invite = useMutation({
    mutationFn: () => api('/api/team/invites', Invite, { method: 'POST', body: json({ email, role }) }),
    onSuccess: () => { setEmail(''); void qc.invalidateQueries({ queryKey: ['team', 'invites'] }); },
  });
  const toggleAdmin = useMutation({
    mutationFn: (m: TeamMember) => api(`/api/team/${m.id}`, TeamMember, { method: 'PATCH', body: json({ isAdmin: !m.isAdmin }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
  });
  const errorText = (e: unknown) => (e instanceof ApiRequestError ? (e.code === 'WORKOS_NOT_LINKED' ? 'This workspace is not linked to WorkOS yet.' : e.message) : e ? 'Something went wrong.' : null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent>
          {team.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {team.error && <p role="alert" className="text-sm text-destructive">{errorText(team.error)}</p>}
          {team.data && (
            <Table>
              <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Product</TableHead>{isAdmin && <TableHead />}</TableRow></TableHeader>
              <TableBody>
                {team.data.members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>{m.displayName ?? '—'}</TableCell>
                    <TableCell>{m.isAdmin ? <Badge>Admin</Badge> : <Badge variant="secondary">Member</Badge>}</TableCell>
                    <TableCell>{m.signedIn ? 'Signed in' : 'Not yet'}</TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" disabled={m.id === auth.user?.userId || toggleAdmin.isPending} onClick={() => toggleAdmin.mutate(m)}>
                          {m.isAdmin ? 'Remove admin' : 'Make admin'}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {isAdmin && (
        <Card>
          <CardHeader><CardTitle>Invites</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
              <div className="grid gap-1">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rep@company.com" />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="invite-role">Role</Label>
                <select id="invite-role" className="h-9 rounded-md border bg-background px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as RoleSlug)}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <Button type="submit" disabled={invite.isPending}>Send invite</Button>
            </form>
            {invite.error && <p role="alert" className="text-sm text-destructive">{errorText(invite.error)}</p>}
            {invites.error && <p role="alert" className="text-sm text-destructive">{errorText(invites.error)}</p>}
            {invites.data && invites.data.invites.filter((i) => i.state === 'pending').length === 0 && <p className="text-sm text-muted-foreground">No pending invites.</p>}
            {invites.data && invites.data.invites.filter((i) => i.state === 'pending').map((i) => (
              <div key={i.id} className="flex items-center justify-between text-sm">
                <span>{i.email}</span>
                <span className="text-muted-foreground">{i.role ?? 'member'} · expires {new Date(i.expiresAt).toLocaleDateString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```
Routes — `apps/outreach-web/src/routes/__root.tsx`:
```tsx
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { AuthContextValue } from '@/lib/auth';

export interface RouterContext { auth: AuthContextValue; queryClient: QueryClient }

export const Route = createRootRouteWithContext<RouterContext>()({ component: () => <Outlet /> });
```
`apps/outreach-web/src/routes/sign-in.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SignInPage } from '@/components/sign-in-page';

export const Route = createFileRoute('/sign-in')({
  validateSearch: z.object({ error: z.string().optional(), returnTo: z.string().regex(/^\/(?!\/)/).optional() }),
  component: () => { const { error, returnTo } = Route.useSearch(); return <SignInPage error={error} returnTo={returnTo} />; },
});
```
`apps/outreach-web/src/routes/auth.callback.tsx`:
```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';
import { useAuth } from '@/lib/auth';

export const Route = createFileRoute('/auth/callback')({
  validateSearch: z.object({ returnTo: z.string().regex(/^\/(?!\/)/).optional() }),
  component: Callback,
});

function Callback() {
  const { returnTo } = Route.useSearch();
  const auth = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    void auth.completeHandoff().then((ok) => {
      if (ok) window.location.replace(returnTo ?? '/');
      else void navigate({ to: '/sign-in', search: { error: 'handoff_failed', returnTo } });
    });
  }, [auth, navigate, returnTo]);
  return <p className="p-6 text-sm text-muted-foreground">Signing you in…</p>;
}
```
(`window.location.replace` is deliberate: `returnTo` is an arbitrary same-origin path validated by the schema, and a full navigation avoids typing it as a route.)
`apps/outreach-web/src/routes/_authenticated.tsx`:
```tsx
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/app-shell';
import { authGuard } from '@/lib/guard';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context, location }) => {
    const target = authGuard(context.auth.isAuthenticated, location.href);
    if (target) throw redirect(target);
  },
  component: () => <AppShell><Outlet /></AppShell>,
});
```
`apps/outreach-web/src/routes/_authenticated/index.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

export const Route = createFileRoute('/_authenticated/')({ component: Dashboard });

function Dashboard() {
  const auth = useAuth();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{auth.activeTenant?.name}</CardTitle>
        <CardDescription>Signed in as {auth.user?.email}{auth.user?.isAdmin ? ' (admin)' : ''}.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">Lists, contacts, suppression, and CRM connections arrive in the next release. Use Team to invite your people.</CardContent>
    </Card>
  );
}
```
`apps/outreach-web/src/routes/_authenticated/team.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { TeamPage } from '@/components/team-page';

export const Route = createFileRoute('/_authenticated/team')({ component: TeamPage });
```
`apps/outreach-web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { AuthProvider, useAuth } from './lib/auth';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });
const router = createRouter({ routeTree, context: { auth: undefined!, queryClient }, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

function App() {
  const auth = useAuth();
  return <RouterProvider router={router} context={{ auth }} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider><App /></AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w apps/outreach-web run build 2>&1 | tail -3 && ls apps/outreach-web/dist/index.html && npm -w apps/outreach-web run test 2>&1 | tail -4 && npm run typecheck >/dev/null && echo ROOT_TYPECHECK_OK
git add package.json package-lock.json Dockerfile apps/outreach-web
git commit -m "feat(outreach-web): React app skeleton — WorkOS sign-in, auth guard, dashboard, team page, tenant switcher"
```
Expected: `dist/index.html` exists; web 3 files / 7 tests; root typecheck clean (the route tree file `src/routeTree.gen.ts` is generated by the build — commit it, as TanStack recommends, so typecheck works without a prior build).

---

### Task 10: Railway Infrastructure-as-Code for both services + deploy runbook

**Files:**
- Create: `.railway/railway.ts`, `docs/runbooks/outreach-api-deploy.md`
- Modify: root `package.json` (devDependency `railway`), `.gitignore` (nothing new — `.railway/` must be committed)

**Why IaC:** Railway has deprecated `railway.json`/`railway.toml` ("Config as Code"): new services cannot opt in, and existing files stop working on **2026-12-01**. The replacement is one `.railway/railway.ts` per project (TypeScript is GA), applied with `railway config apply`. This task generates the file from the live project (`railway config pull`, read-only), adds the `outreach-api` service, and verifies with `railway config plan` (read-only). `apply` changes production and is the user's step in the runbook.

**Facts (verified against docs.railway.com and the installed CLI 4.59):** `railway config pull|plan|apply|migrate|init`; the SDK is the npm package `railway` (`import { defineRailway, project, service, postgres, github, preserve } from 'railway/iac'`); `service(name, { source: github('owner/repo', { branch }), build, start, preDeploy, healthcheck, healthcheckTimeout, env, replicas, domains })`; `postgres('Postgres').env.DATABASE_URL` references the database service; `preserve()` keeps a variable value already set in Railway; services match live ones **by name**; the Dockerfile is selected with the `RAILWAY_DOCKERFILE_PATH` variable (path from the repo root); Root Directory stays `/` so the whole monorepo is the build context.

- [ ] **Step 1: Install the SDK and import the live project**

```bash
cd /Users/cdrshepard/spam-res-cti && npm install -D railway@^3.11.0 2>&1 | tail -1 && railway status | head -4 && railway config pull 2>&1 | tail -5 && ls -la .railway && sed -n '1,80p' .railway/railway.ts
```
Expected: `railway status` shows project `endearing-comfort`; `.railway/railway.ts` is written and contains the existing services (the API service — named as Railway shows it, currently `@cti/api` — and `Postgres`), with secret variables rendered as `preserve()`. Read the whole file before editing. Do not edit the existing services' definitions except as Step 2 says.

- [ ] **Step 2: Add the outreach-api service**

In `.railway/railway.ts`, keep the imported definitions and add, next to the existing API service (adapt the variable names to what `pull` generated — e.g. `const db = postgres("Postgres")` may already exist):
```ts
  const outreachApi = service("outreach-api", {
    source: github("CDR-Shepard/spam-res-cti", { branch: "main" }),
    preDeploy: "npm --workspace packages/db run migrate",
    start: "node services/outreach-api/dist/server.js",
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    env: {
      NODE_ENV: "production",
      RAILWAY_DOCKERFILE_PATH: "services/outreach-api/Dockerfile",
      DATABASE_URL: db.env.DATABASE_URL,
      // Same values as the CTI API so sessions and encrypted tokens interoperate.
      TOKEN_ENCRYPTION_KEY: preserve(),
      SESSION_SECRET: preserve(),
      // Filled in the dashboard after the first apply (see the runbook).
      API_PUBLIC_URL: preserve(),
      APP_PUBLIC_URL: preserve(),
      WORKOS_API_KEY: preserve(),
      WORKOS_CLIENT_ID: preserve(),
      WORKOS_REDIRECT_URI: preserve(),
      PGBOSS_SCHEMA: "pgboss",
    },
  });
```
and include `outreachApi` in the `project(...).resources` array. If the existing API service's definition rendered its `preDeploy`/`start`/`healthcheck` from the live settings, leave them exactly as pulled (they must match `railway.json` until the user clears that setting per the runbook).

- [ ] **Step 3: Plan (read-only) and record the result**

```bash
cd /Users/cdrshepard/spam-res-cti && railway config plan 2>&1 | tail -15
```
Expected: `Plan: 1 to add, 0 to change, 0 to destroy` with `+ Create service outreach-api` and no changes to the existing services. If the plan shows changes to `@cti/api` or `Postgres`, stop: the pulled file drifted from live state — re-run `railway config pull --force` and re-apply Step 2 rather than hand-editing the existing services. Paste the plan output into your report. Do NOT run `railway config apply`.

- [ ] **Step 4: Runbook**

`docs/runbooks/outreach-api-deploy.md`:
```markdown
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
```

- [ ] **Step 5: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti && git add package.json package-lock.json .railway/railway.ts docs/runbooks/outreach-api-deploy.md && git commit -m "feat(deploy): Railway Infrastructure-as-Code for both services; outreach-api deploy runbook"
```

---

### Task 11: Docs, spec touch-ups, follow-ups, and the plan-1 follow-ups that this plan closes

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-09-03-outreach-foundation-design.md`, `docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md`, root `.env.example`

- [ ] **Step 1: README**

Add an "Outreach product (outreach-api + outreach-web)" section after the CTI architecture block: what it is (multi-tenant product API and web app, sharing the Postgres and packages), local dev (`cp services/outreach-api/.env.example services/outreach-api/.env`, `npm run dev:outreach` and `npm run dev:web:outreach`, open http://localhost:5175; without WorkOS credentials the sign-in routes answer 503 — set the three `WORKOS_*` variables to sign in locally), tests (`npm -w services/outreach-api run test`, `npm -w apps/outreach-web run test`), deploy pointer to `docs/runbooks/outreach-api-deploy.md`, and the IaC note (`.railway/railway.ts` is the source of truth for both services; `railway.json` is deprecated by Railway and retired per the runbook). Update the project-layout tree with `packages/contracts/`, `services/outreach-api/`, `apps/outreach-web/`, `.railway/`.

- [ ] **Step 2: Spec touch-ups** (`docs/superpowers/specs/2026-09-03-outreach-foundation-design.md`)

- §3.2 deployables: add after the bullet list — "Railway configuration for both services lives in `.railway/railway.ts` (Infrastructure as Code); Railway has deprecated per-service `railway.json` with a 2026-12-01 cutoff."
- §4.3 sign-in flow, step 2: append "The OAuth `state` is a signed, stateless token (HMAC-SHA256 with `SESSION_SECRET`, 10-minute life) so the start request sets no cookie."
- §4.3 step 6: append "The handoff cookie carries the token and its expiry; `GET /api/auth/session` clears it on first read."
- §4.4 roles: append "Product invites carry a WorkOS role slug (`admin` or `member`); an `admin` membership grants `is_admin` on sign-in and never demotes an existing admin."

- [ ] **Step 3: Follow-ups file** (`docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md`)

Add a section "Plan 2 outcomes and new follow-ups":
- Closed by plan 2: `packages/contracts` created; human-user predicates moved to `@cti/auth`.
- New: retire `railway.json` before 2026-12-01 (runbook §5); Railway "watch paths" are not expressible in the IaC DSL yet — both services rebuild on every push to `main`, acceptable for now; `outreach-web` keeps the bearer in memory only (spec §4.3), so a page reload re-runs the AuthKit redirect — revisit if it annoys admins (a `sessionStorage` copy is the smallest change); `apps/cti-web` and `apps/outreach-web` pin different `vitest` majors (4 vs 2 in the Node services) — align when the next Vite upgrade happens; the fake-DB harness in `outreach-api` cannot express `where` semantics — the real-Postgres lane (plan 3) should cover `requireContext` tenant isolation and `completeSignIn` against real rows; `GET /admin/tenants` has no UI for provisioning yet (CLI only).

- [ ] **Step 4: `.env.example`** (root): add a short "outreach-api" block pointing at `services/outreach-api/.env.example` and listing the `WORKOS_*`, `APP_PUBLIC_URL`, and `PGBOSS_SCHEMA` names.

- [ ] **Step 5: Verify and commit**

```bash
cd /Users/cdrshepard/spam-res-cti && npm run typecheck >/dev/null && echo TYPECHECK_OK && npm test 2>&1 | grep -E "^\s+(Test Files|Tests) " | tr -s ' ' | paste - - | head -8
git add README.md .env.example docs/superpowers/specs/2026-09-03-outreach-foundation-design.md docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md
git commit -m "docs(outreach): product skeleton — README, spec touch-ups, follow-ups"
```
Expected totals: phone 6, db 6, auth 28, firewall 161, contracts 5, cti-api 615, outreach-api 45, cti-web 124, outreach-web 7.

---

## Self-review against the spec

- **§3.2 deployables**: `outreach-api` (T3–T8) with the same Fastify conventions; serves `outreach-web` (T3 SPA fallback, T9 build); shared env values (T3 `.env.example`, T10 runbook). `ai-worker` is plan 3+ per spec.
- **§3.3 jobs**: pg-boss started in-process with a queue registry and readiness (T4); queues themselves arrive with the import pipeline (plan 3) — the registry is intentionally empty.
- **§3.4 web**: React 18 + Vite + TanStack Router/Query + Tailwind + shadcn, API client from `@cti/contracts`, bearer in memory, cookie handoff on load (T9).
- **§3.5 tenant scoping**: `requireContext` puts `orgId` on every request (T6); the CI grep for unscoped product-table queries is deferred to plan 3, when product tables exist.
- **§4.1–4.2**: unchanged (plan 1). **§4.3 sign-in**: T5–T6 implement steps 1–6 with two documented refinements (signed state, cookie contents) recorded in T11. **§4.4 roles**: `is_admin`/`is_super_admin`, `X-Org-Id` (T6). **§4.5 provisioning**: `provisionTenant` = `createTenant` + WorkOS org + invite; `POST /admin/tenants` + CLI (T7); the WorkOS link for the existing GG Homes tenant is `link-tenant-workos` (T7, runbook §3).
- **§10 web scope for this step**: sign-in, callback, team (invite, admin toggle), tenant switcher; dashboard is a placeholder until lists exist (T9).
- **§11 error handling**: one envelope (`sendError`, T6), fail-closed context resolution, redaction of cookies/authorization (T3), alerts on provisioning failure (T7).
- **§12 testing**: fake-DB unit tests for every route and service; contract tests in `@cti/contracts` (T1); web component tests (T9). The real-Postgres lane is plan 3 (recorded in T11).
- **§13 step 3**: health, WorkOS sign-in, team page, tenant switcher, new Railway service with its own domain (T10 runbook), invite our team (runbook §3).
- **Type consistency**: `SessionUser` (contracts) vs `SessionUser` (`@cti/auth`) are distinct and mapped once in `routes/auth.ts` (`toSessionUserDto`); `Tenant` DTO built only by `toTenantDto` (T6) and used by T7/T8/T9; `IdentityProvider` methods used in T5–T8 match the port in T5; `RoleSlug` from contracts used by the port, routes, and web; `buildTestApp` gains one plugin per task (T6 auth, T7 admin-tenants, T8 team).
